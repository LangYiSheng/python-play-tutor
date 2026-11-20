"""Merge a compiled template with live definitions using server-owned fingerprints."""

import hashlib
import json
from copy import deepcopy
from dataclasses import dataclass, field


MANAGED = ("activity", "quest", "story", "npc", "interactions", "releases", "buildings")
LABELS = {"activity": "活动", "quest": "任务", "story": "剧情", "npc": "角色", "interactions": "地点", "releases": "章节开放设置", "buildings": "建筑开放设置"}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def index_rows(kind, rows):
    if kind == "buildings":
        return dict(rows)
    key = "chapter_id" if kind == "releases" else "id"
    return {row[key]: row for row in rows}


@dataclass
class CoursePlan:
    data: dict
    configuration: dict
    releases: list
    metadata: dict
    edits: dict = field(default_factory=dict)
    blockers: list = field(default_factory=list)
    reset: object | None = None

    def counts(self):
        counts = {"added": 0, "updated": 0, "removed": 0}
        for changes in self.edits.values():
            for before, after in changes.values():
                counts["added" if before is None else "removed" if after is None else "updated"] += 1
        return counts


def merge_course(data, config, releases, compiled, recipe, saved):
    public_config = {key: deepcopy(config.get(key, {})) for key in ("world", "buildings", "assistant", "editor")}
    originals = deepcopy(saved.get("releases_before", {}))
    ownership = {}
    plan = CoursePlan(dict(data), public_config, releases, {"recipe": recipe, "releases_before": originals, "owned": ownership},
                      edits={kind: {} for kind in MANAGED})
    if set(saved.get("unverified_sample_stories", ())).intersection(row["id"] for row in data["story"]):
        plan.blockers.append("此课程包使用早期四角色样板。原流程可继续游玩，也可在教学流程中维护。要体验新版三角色模板，请在新课程中生成。")
        return plan
    current = {**data, "interactions": public_config["world"].get("interactions", []), "releases": releases, "buildings": public_config["buildings"]}
    chapters = {row["id"]: row["title"] for row in data["chapter"]}
    for kind in MANAGED:
        live = index_rows(kind, current[kind])
        new = index_rows(kind, compiled.get(kind, []))
        baseline = saved.get("owned", {}).get(kind, {})
        changes = plan.edits[kind]
        ownership[kind] = {key: digest(row) for key, row in new.items()}
        for key in sorted(set(new) | set(baseline)):
            before, after = live.get(key), new.get(key)
            previous = baseline.get(key)
            if kind == "buildings" and before and after:
                if before.get("enabled") and before.get("default_unlocked"):
                    # Reuse independently opened rooms; the template only owns doors it opened.
                    if not previous:
                        ownership[kind].pop(key)
                    continue
                plan.blockers.append(f"请先在建筑开放设置中开放「{key}」，学生需要进入此房间完成课程。")
                continue
            if kind == "releases":
                if key in new and key not in baseline:
                    originals[key] = before
                if key not in new:
                    after = originals.pop(key, None)
                    if key not in chapters:
                        # Course management has already retired this chapter.
                        after = None
            # A regular, unscheduled release is safe to order as explicitly requested.
            simple_release = kind == "releases" and before and before["status"] == "published" and not (
                before["opens_at"] or before["prerequisite_chapter_id"]
            )
            existing_collision = not previous and before is not None and not (kind == "releases" and (before == after or simple_release))
            manual_edit = previous and (before is None or digest(before) != previous)
            if manual_edit and kind != "releases" and before is not None and after is not None and digest(after) == previous:
                # No template change to this definition. Keep the advanced edit, but
                # retain the baseline so a future conflicting rewrite needs attention.
                continue
            if existing_collision or (manual_edit and before != after):
                row = before or after or {}
                title = row.get("title") or row.get("name") or row.get("label") or row.get("content", {}).get("title") or chapters.get(key, key)
                plan.blockers.append(f"{LABELS[kind]}「{title}」已有独立设置或已由其他编辑修改，请先在对应编辑器核对，生成会覆盖这些修改。")
            elif before != after:
                changes[key] = (before, after)
                if after is None:
                    live.pop(key, None)
                else:
                    live[key] = after
        if kind == "interactions":
            public_config["world"]["interactions"] = list(live.values())
        elif kind == "buildings":
            public_config["buildings"] = live
        elif kind == "releases":
            plan.releases = list(live.values())
        else:
            plan.data[kind] = list(live.values())
    return plan
