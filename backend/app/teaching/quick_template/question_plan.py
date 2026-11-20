"""Question counts for a fixed chapter activity, shared by preview and generation."""

from collections import Counter, deque
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

from app.practice_rules import KIND_LABELS, QuestionShortages, allocate_initial
from app.question_types import QuestionKind


Count = Annotated[int, Field(strict=True, ge=0, le=100)]
StableID = Annotated[str, Field(min_length=1, max_length=100)]


class QuestionQuota(BaseModel):
    model_config = ConfigDict(extra="forbid")
    count: Count
    by_kind: dict[QuestionKind, Count] = Field(default_factory=dict)

    @model_validator(mode="after")
    def check_kind_counts(self):
        fixed = sum(self.by_kind.values())
        if fixed > self.count:
            raise ValueError("指定题型的题数之和不能超过总题数")
        if len(self.by_kind) == len(KIND_LABELS) and fixed != self.count:
            raise ValueError("所有题型均已指定时，各题型题数之和必须等于总题数")
        return self


class ChapterTotal(QuestionQuota):
    mode: Literal["total"]
    count: int = Field(strict=True, ge=1, le=100)


class PointQuota(QuestionQuota):
    knowledge_point_id: StableID


class PointTotals(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["by_point"]
    points: list[PointQuota] = Field(min_length=1, max_length=65)

    @model_validator(mode="after")
    def check_point_counts(self):
        if len({row.knowledge_point_id for row in self.points}) != len(self.points):
            raise ValueError("同一环节不能重复配置知识点")
        if not 1 <= sum(row.count for row in self.points) <= 100:
            raise ValueError("各知识点题数合计须为 1 至 100 道")
        return self

    def check_selection(self, point_ids):
        if {row.knowledge_point_id for row in self.points} != set(point_ids):
            raise ValueError("请为本章每个已选知识点指定题数，暂不出题的知识点可设为 0")


StageRule = Annotated[ChapterTotal | PointTotals, Field(discriminator="mode")]
StageKey = Literal["practice", "assessment"]
STAGE_RULE = TypeAdapter(StageRule)


def _balanced_questions(pool, points, count, label, avoid, earlier_points):
    """Prefer underrepresented points, retaining the original chapter-wide draw."""
    if len(pool) < count:
        raise QuestionShortages([f"{label}需要 {count} 道题，所选知识点只有 {len(pool)} 道可用题，还缺 {count - len(pool)} 道。请减少题量或补充题库。"])
    candidates = {point: deque() for point in points}
    for key in sorted(pool, key=lambda key: (key in avoid, -len(pool[key]), key)):
        for point in pool[key]:
            candidates[point].append(key)
    selected, order = set(), []
    coverage = dict.fromkeys(points, 0)
    earlier = dict.fromkeys(points, 0)
    for point in earlier_points:
        earlier[point] += 1
    for _ in range(count):
        for queue in candidates.values():
            while queue and queue[0] in selected:
                queue.popleft()
        point = min((p for p in points if candidates[p]),
                    key=lambda p: (coverage[p], candidates[p][0] in avoid, earlier[p]))
        question = candidates[point].popleft()
        selected.add(question)
        order.append(question)
        for tag in pool[question]:
            coverage[tag] += 1
    return order


def _chapter_questions(pool, kinds, points, rule, label, avoid, earlier_points):
    selected = []
    shortages = []
    quotas = {kind: rule.by_kind[kind] for kind in KIND_LABELS if kind in rule.by_kind}
    quotas[None] = rule.count - sum(quotas.values())
    for kind, count in quotas.items():
        if not count:
            continue
        if kind is None:
            choices = {key: tags for key, tags in pool.items() if kinds[key] not in rule.by_kind}
        else:
            choices = {key: tags for key, tags in pool.items() if kinds[key] == kind}
        kind_label = KIND_LABELS.get(kind, "其余题型")
        try:
            batch = _balanced_questions(choices, points, count, f"{label}（{kind_label}）", avoid, earlier_points)
        except QuestionShortages as exc:
            shortages.extend(exc.messages)
            continue
        selected.extend(batch)
        earlier_points.extend(point for key in batch for point in pool[key])
    if shortages:
        raise QuestionShortages(shortages)
    return selected


def _point_questions(pool, kinds, point_titles, rule, label, avoid):
    points = list(point_titles)
    rule.check_selection(points)
    point_rules = {row.knowledge_point_id: row for row in rule.points}
    goals = []
    for point in points:
        row = point_rules[point]
        typed = {kind: row.by_kind[kind] for kind in KIND_LABELS if kind in row.by_kind}
        goals.append({"knowledge_point_id": point, "total": row.count, "by_kind": typed})

    candidates = {point: {} for point in points}
    for key in sorted(pool, key=lambda key: (key in avoid, key)):
        for point in pool[key]:
            candidates[point][key] = kinds[key]

    def draw(choices):
        allocated = allocate_initial({"goals": goals}, choices, shuffle=False, exact_kinds=True, point_titles=point_titles)
        return [key for point in points for key in allocated[point]]

    if avoid:
        fresh = {point: {key: kind for key, kind in choices.items() if key not in avoid} for point, choices in candidates.items()}
        try:
            return draw(fresh)
        except QuestionShortages:
            # A constrained quiz can reuse a practice question if its fresh pool is insufficient.
            pass
    try:
        return draw(candidates)
    except QuestionShortages as exc:
        raise QuestionShortages(f"{label}配题不足。{message}。请调整题量或补充题库。" for message in exc.messages) from exc


def select_questions(pool, kinds, point_titles, default_count, stage_rule, label, *, avoid=(), earlier_points=()):
    points = list(point_titles)
    avoid = set(avoid)
    if stage_rule is None:
        if not pool:
            raise QuestionShortages([f"{label}没有可用题。此环节至少需要 1 道题，请补充题库或调整所选知识点。"])
        return _balanced_questions(pool, points, min(default_count, len(pool)), label, avoid, earlier_points)
    rule = STAGE_RULE.validate_python(stage_rule)
    if isinstance(rule, ChapterTotal):
        if not rule.by_kind:
            return _balanced_questions(pool, points, rule.count, label, avoid, earlier_points)
        return _chapter_questions(pool, kinds, points, rule, label, avoid, list(earlier_points))

    return _point_questions(pool, kinds, point_titles, rule, label, avoid)


def practice_goals(selected, pool, kinds, point_titles, rule):
    """Turn a feasible assignment into native learner goals without storing question IDs."""
    assigned = {point: [] for point in point_titles}
    point_rules = {}
    if rule and rule["mode"] == "by_point":
        point_rules = {row["knowledge_point_id"]: row for row in rule["points"]}
        cursor = 0
        # _point_questions returns the matching grouped in selected knowledge-point order.
        for point in assigned:
            count = point_rules[point]["count"]
            assigned[point] = selected[cursor:cursor + count]
            cursor += count
    else:
        for question in selected:
            point = min((p for p in assigned if p in pool[question]), key=lambda p: len(assigned[p]))
            assigned[point].append(question)
    goals = []
    for point, questions in assigned.items():
        if questions:
            typed = point_rules.get(point, rule or {}).get("by_kind")
            quotas = dict(Counter(kinds[q] for q in questions)) if typed else {}
            goals.append({"knowledge_point_id": point, "total": len(questions), "by_kind": quotas})
    return goals
