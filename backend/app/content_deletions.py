"""Two-stage, classroom-scoped retirement with impact review and retained evidence."""
from app.course_scope import course_class_ids
from datetime import timedelta
from hashlib import sha256
import json
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .auth import as_utc, require_teacher
from .db import Base, get_db
from .deletion_models import ContentDeletionPreview
from .models import (
    Activity, ActivityQuestion, Chapter, ChapterRelease, Classroom, CourseInstance, KnowledgePoint,
    Material, MaterialChapter, Question, QuestionChapter, QuestionKnowledgePoint,
    User, now,
)
from .teacher_scope import commit_content, require_scope, teacher_instance_id

router = APIRouter(prefix="/teacher/courses/{course_id}/content-deletions", tags=["content-deletions"])
MODELS = {"chapter": Chapter, "material": Material, "question": Question, "activity": Activity,
          "knowledge_point": KnowledgePoint}
LABELS = {"chapter": "章节", "material": "资料", "question": "题目", "activity": "活动",
          "knowledge_point": "知识点"}
Kind = Literal["chapter", "material", "question", "activity", "knowledge_point"]
Teacher = Annotated[User, Depends(require_teacher)]
Database = Annotated[Session, Depends(get_db)]


class Target(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Kind
    id: str = Field(min_length=1, max_length=100)


class PreviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    targets: list[Target] = Field(min_length=1, max_length=100)
    include_related_questions: bool = False


class ConfirmInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmation: str = Field(min_length=1, max_length=200)
    confirmed: Literal[True]


def title(row):
    return row.title


def studio_sources(point):
    metadata = (point.content or {}).get("course_studio")
    sources = metadata.get("sources") if isinstance(metadata, dict) else None
    return sources if isinstance(sources, list) else []


def material_source_id(source):
    return str(source.get("material_stable_id") or "") if isinstance(source, dict) else ""


def plan_deletion(db, user, instance, targets):
    rows = {kind: {str(row.id): row for row in db.scalars(select(model).where(model.course_instance_id == instance.id))}
            for kind, model in MODELS.items()}
    retiring = {kind: {} for kind in MODELS}
    blockers, detach, preserved = [], [], []

    def add(kind, key, reason):
        key = str(key)
        if key in rows[kind] and key not in retiring[kind]:
            row = rows[kind][key]
            if user.role != "admin" and hasattr(row, "owner_id") and row.owner_id != user.id:
                blockers.append({"message": f"无权删除{LABELS[kind]}“{title(row)}”，请联系管理员", "kind": kind, "id": key})
            retiring[kind][key] = reason
            return True
        return False

    for target in targets:
        row = rows[target["kind"]].get(target["id"])
        require_scope(row, instance.id)
        if user.role != "admin" and row.owner_id != user.id:
            raise HTTPException(403, "只能删除自己管理的内容，共享课程由管理员维护")
        add(target["kind"], target["id"], target.get("reason") or "本次选择")

    selections = list(db.scalars(select(ActivityQuestion).where(ActivityQuestion.activity_id.in_([r.id for r in rows["activity"].values()]))))
    questions_by_activity = {key: {str(link.question_id) for link in selections if str(link.activity_id) == key} for key in rows["activity"]}

    for kind in ("knowledge_point", "activity"):
        for key, row in rows[kind].items():
            if str(row.chapter_id) in retiring["chapter"]:
                add(kind, key, "所属章节将删除")
    for key, selected in questions_by_activity.items():
        if selected and selected <= set(retiring["question"]):
            add("activity", key, "删除所选题目后活动将为空")
    retired_material_ids = {str(rows["material"][key].stable_id) for key in retiring["material"] if rows["material"][key].stable_id}
    live_material_ids = {str(row.stable_id) for row in rows["material"].values() if row.stable_id} - retired_material_ids
    retained_sources = {}
    for key, row in rows["knowledge_point"].items():
        if key in retiring["knowledge_point"] or not retired_material_ids:
            continue
        sources = studio_sources(row)
        remaining = [source for source in sources if material_source_id(source) not in retired_material_ids]
        if len(remaining) == len(sources):
            continue
        has_summary = str((row.content or {}).get("summary_markdown") or "").strip()
        if not has_summary and not any(material_source_id(source) in live_material_ids for source in remaining):
            add("knowledge_point", key, "仅来源于本次删除的课件，将同步移除")
        else:
            retained_sources[key] = remaining

    if retiring["question"]:
        from .models import PracticeSession
        from .practice_rules import allocate_initial, candidate_pool

        sessions = db.scalars(select(PracticeSession).where(PracticeSession.classroom_id.in_(course_class_ids(instance.id))))
        for session in sessions:
            if session.activity_id not in retiring["activity"] and any(item["question_id"] in retiring["question"] for item in session.items):
                blockers.append({"message": "题目已进入保留练习的学生个人题单", "kind": "activity", "id": session.activity_id})
        for activity in rows["activity"].values():
            rules = activity.content.get("practice_rules")
            if not rules or activity.id in retiring["activity"] or activity.content.get("published") is False:
                continue
            pool = candidate_pool(db, activity)
            for choices in pool.values():
                for key in retiring["question"]:
                    choices.pop(key, None)
            try:
                allocate_initial(rules, pool, shuffle=False)
            except ValueError as exc:
                blockers.append({"message": f"删除会导致练习「{activity.title}」无法抽题：{exc}", "kind": "activity", "id": activity.id})
    for key in retiring["material"]:
        if rows["material"][key].status in {"queued", "processing"}:
            blockers.append({"message": f"资料“{title(rows['material'][key])}”仍在转换，请完成后重试", "kind": "material", "id": key})

    def unlink(kind, key, reason):
        row = rows[kind][str(key)]
        detach.append({"kind": kind, "id": str(key), "title": title(row), "reason": reason})

    for kind, model, source in (("material", MaterialChapter, "material_id"), ("question", QuestionChapter, "question_id")):
        for link in db.scalars(select(model).where(model.chapter_id.in_([int(key) for key in retiring["chapter"]]))):
            key = str(getattr(link, source))
            if key in rows[kind] and key not in retiring[kind]:
                unlink(kind, key, f"解除与章节“{title(rows['chapter'][str(link.chapter_id)])}”的关联；内容保留")
    for link in selections:
        if str(link.question_id) in retiring["question"] and str(link.activity_id) not in retiring["activity"]:
            unlink("activity", link.activity_id, f"移除题目“{title(rows['question'][str(link.question_id)])}”；已交试卷保持原题集和成绩")
    point_ids = {int(key) for key in retiring["knowledge_point"]}
    for key, row in rows["activity"].items():
        if key not in retiring["activity"] and point_ids & set(row.content.get("knowledge_point_ids", [])):
            if row.content.get("practice_rules"):
                blockers.append({"message": f"练习「{row.title}」仍使用待删除的知识点，请先调整练习目标", "kind": "activity", "id": key})
            else:
                unlink("activity", key, "解除已删除知识点的关联")
    for link in db.scalars(select(QuestionKnowledgePoint).where(QuestionKnowledgePoint.knowledge_point_id.in_(point_ids))):
        key = str(link.question_id)
        if key in rows["question"] and key not in retiring["question"]:
            unlink("question", key, "解除已删除知识点的关联")
    for key, row in rows["question"].items():
        if key not in retiring["question"] and str(row.source.get("material_id")) in retiring["material"]:
            unlink("question", key, "清除已删除资料的来源引用与页码；题目保留")
    for key in retained_sources:
        unlink("knowledge_point", key, "移除已删除课件的页码来源；知识点保留")
    # Retain full rows/files, including records referenced only through JSON snapshots.
    evidence, learners = {}, set()
    association_tables = {"activity_questions", "material_chapters", "question_chapters", "question_knowledge_points", "question_secrets", "chapter_releases"}
    model_tables = {model.__tablename__: kind for kind, model in MODELS.items()}
    for table in Base.metadata.sorted_tables:
        if table.name in association_tables or table.name in model_tables:
            continue
        conditions = []
        for foreign in table.foreign_keys:
            kind = model_tables.get(foreign.column.table.name)
            if kind and retiring[kind]:
                keys = [rows[kind][key].id for key in retiring[kind]]
                conditions.append(foreign.parent.in_(keys))
        if not conditions:
            continue
        from sqlalchemy import or_
        found = list(db.execute(select(table).where(or_(*conditions))).mappings())
        if found:
            evidence[table.name] = sorted([dict(row) for row in found], key=lambda r: json.dumps(r, sort_keys=True, default=str))
            learners.update(row["user_id"] for row in found if "user_id" in row)
            preserved.append({"kind": "history", "title": {"activity_progress": "活动进度", "learning_records": "学习记录",
                "submissions": "提交与评测记录", "assessment_attempts": "试卷与成绩", "assistant_sessions": "助教会话",
                "player_quests": "任务进度"}.get(table.name, "关联历史记录"), "count": len(found)})
    retiring_rows = [{"kind": kind, "id": key, "title": title(rows[kind][key]), "reason": reason}
                     for kind, items in retiring.items() for key, reason in sorted(items.items())]
    # Root chapter deletion never expands to independent material/question bank entries.
    for item in detach:
        if item["kind"] in {"material", "question"}:
            preserved.append({"kind": item["kind"], "id": item["id"], "title": item["title"], "count": 1})
    for key in retiring["activity"]:
        activity = rows["activity"][key]
        for kind, keys in (("material", {str(resource.material_id) for resource in activity.resources}), ("question", questions_by_activity[key])):
            for content_id in sorted(keys):
                if content_id in rows[kind] and content_id not in retiring[kind]:
                    preserved.append({"kind": kind, "id": content_id, "title": title(rows[kind][content_id]), "count": 1})
    learners_by_class = {}
    for records in evidence.values():
        for record in records:
            if record.get("classroom_id") is not None and record.get("user_id") is not None:
                learners_by_class.setdefault(record["classroom_id"], set()).add(record["user_id"])
    classrooms = [{"id": cid, "name": name, "students": len(learners_by_class[cid]),
                   "ending_sessions": 0}
                  for cid, name in db.execute(select(Classroom.id, Classroom.name)
                      .where(Classroom.id.in_(learners_by_class)).order_by(Classroom.id))]
    public = {"classrooms": classrooms, "remove": retiring_rows, "detach": detach, "preserve": list({json.dumps(x, sort_keys=True): x for x in preserved}.values()),
              "blockers": blockers, "affected_students": len(learners), "ending_sessions": 0,
              "history_policy": "学生提交、试卷、成绩、阅读及任务历史全部保留；删除内容退出当前教学，历史所需文件保留。"}
    # Hash actual evidence too: newly submitted work or session progress invalidates a stale preview.
    evidence = {key: sorted(value, key=lambda r: json.dumps(r, sort_keys=True, default=str)) for key, value in evidence.items()}
    fingerprint = sha256(json.dumps({"plan": public, "evidence": evidence}, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()
    return public, fingerprint, retiring, rows


def _find_related_questions(db: Session, user: User, retiring: dict[str, dict[str, str]], rows: dict[str, dict[str, object]]) -> dict[str, str]:
    """Identify editable questions exclusively tied to retiring KPs/chapters or sourced from retiring materials."""
    q_rows = rows["question"]
    if not q_rows:
        return {}
    editable_qids = {
        qid for qid, q in q_rows.items()
        if qid not in retiring["question"] and (user.role == "admin" or getattr(q, "owner_id", None) == user.id)
    }
    if not editable_qids:
        return {}

    related: dict[str, str] = {}
    if retiring["knowledge_point"]:
        live_kp_ids = {int(k) for k in rows["knowledge_point"]}
        retiring_kp_ids = {int(k) for k in retiring["knowledge_point"]}
        kp_by_q: dict[str, set[int]] = {}
        for qid, kpid in db.execute(
            select(QuestionKnowledgePoint.question_id, QuestionKnowledgePoint.knowledge_point_id).where(
                QuestionKnowledgePoint.question_id.in_(editable_qids)
            )
        ):
            if kpid in live_kp_ids:
                kp_by_q.setdefault(str(qid), set()).add(kpid)
        for qid, kp_set in kp_by_q.items():
            if (kp_set & retiring_kp_ids) and kp_set <= retiring_kp_ids:
                related[qid] = "仅关联本次删除的知识点，已勾选同步删除"

    if retiring["material"]:
        for qid in editable_qids:
            q = q_rows[qid]
            if str((getattr(q, "source", None) or {}).get("material_id")) in retiring["material"]:
                related.setdefault(qid, "来源于本次删除的课件，已勾选同步删除")

    if retiring["chapter"]:
        live_ch_ids = {int(k) for k in rows["chapter"]}
        retiring_ch_ids = {int(k) for k in retiring["chapter"]}
        ch_by_q: dict[str, set[int]] = {}
        for qid, cid in db.execute(
            select(QuestionChapter.question_id, QuestionChapter.chapter_id).where(
                QuestionChapter.question_id.in_(editable_qids)
            )
        ):
            if cid in live_ch_ids:
                ch_by_q.setdefault(str(qid), set()).add(cid)
        for qid, ch_set in ch_by_q.items():
            if (ch_set & retiring_ch_ids) and ch_set <= retiring_ch_ids:
                related.setdefault(qid, "仅属于本次删除的章节，已勾选同步删除")

    return related


@router.post("/preview")
def preview_deletion(course_id: int, body: PreviewInput, user: Teacher, db: Database):
    instance_id = teacher_instance_id(db, user, course_id, exclusive=True)
    instance = db.get(CourseInstance, instance_id)
    base_targets = list({(t.kind, t.id): t.model_dump() for t in body.targets}.values())
    plan, fingerprint, retiring, rows = plan_deletion(db, user, instance, base_targets)
    related = _find_related_questions(db, user, retiring, rows)
    related_count = len(related)
    targets = base_targets
    if body.include_related_questions and related:
        targets = [
            *base_targets,
            *({"kind": "question", "id": qid, "reason": reason} for qid, reason in sorted(related.items())),
        ]
        plan, fingerprint, *_ = plan_deletion(db, user, instance, targets)
    first = next(item for item in plan["remove"] if item["kind"] == base_targets[0]["kind"] and item["id"] == base_targets[0]["id"])
    confirmation = first["title"] if len(base_targets) == 1 else f"删除所选{len(base_targets)}项"
    preview = ContentDeletionPreview(teacher_id=user.id, course_instance_id=instance_id,
                                     revision=instance.revision, targets=targets, fingerprint=fingerprint, confirmation=confirmation)
    db.add(preview)
    db.commit()
    return {"id": preview.id, "revision": preview.revision, "confirmation": confirmation,
            "expires_at": as_utc(preview.created_at) + timedelta(minutes=15),
            "related_question_count": related_count, **plan}


@router.post("/{preview_id}/confirm")
def confirm_deletion(course_id: int, preview_id: str, body: ConfirmInput, user: Teacher, db: Database):
    instance_id = teacher_instance_id(db, user, course_id, exclusive=True)
    preview = db.scalar(select(ContentDeletionPreview).where(ContentDeletionPreview.id == preview_id).with_for_update())
    if not preview or preview.teacher_id != user.id or preview.course_instance_id != instance_id:
        raise HTTPException(404, "删除预览不存在")
    if body.confirmation != preview.confirmation:
        raise HTTPException(422, "确认文字不匹配")
    if preview.result is not None:
        return preview.result
    if now() - as_utc(preview.created_at) > timedelta(minutes=15):
        raise HTTPException(409, "删除预览已过期，请重新查看影响范围")
    instance = db.get(CourseInstance, instance_id)
    if instance.revision != preview.revision:
        raise HTTPException(409, "课程内容已变化，请重新查看影响范围")
    plan, fingerprint, retiring, rows = plan_deletion(db, user, instance, preview.targets)
    if fingerprint != preview.fingerprint:
        raise HTTPException(409, "学生记录或删除影响已变化，请重新查看影响范围")
    if plan["blockers"]:
        raise HTTPException(409, "存在尚未处理的引用，请先修正后重新预览")
    at = now()
    for kind, items in retiring.items():
        for key in items:
            rows[kind][key].deleted_at = at
    chapter_ids = [int(k) for k in retiring["chapter"]]
    point_ids = [int(k) for k in retiring["knowledge_point"]]
    for model, column, keys in (
        (MaterialChapter, MaterialChapter.chapter_id, chapter_ids), (QuestionChapter, QuestionChapter.chapter_id, chapter_ids),
        (QuestionKnowledgePoint, QuestionKnowledgePoint.knowledge_point_id, point_ids),
        (ActivityQuestion, ActivityQuestion.question_id, list(retiring["question"])),
        (ActivityQuestion, ActivityQuestion.activity_id, list(retiring["activity"])),
    ):
        db.execute(delete(model).where(column.in_(keys)))
    for key, row in rows["activity"].items():
        if key not in retiring["activity"] and set(row.content.get("knowledge_point_ids", [])) & set(point_ids):
            row.content = {**row.content, "knowledge_point_ids": [p for p in row.content["knowledge_point_ids"] if p not in point_ids]}
    for key, row in rows["question"].items():
        if key not in retiring["question"] and str(row.source.get("material_id")) in retiring["material"]:
            row.source = {k: v for k, v in row.source.items() if k not in {"material_id", "page_no"}}
    retired_material_ids = {str(rows["material"][key].stable_id) for key in retiring["material"] if rows["material"][key].stable_id}
    for key, row in rows["knowledge_point"].items():
        if key in retiring["knowledge_point"] or not retired_material_ids:
            continue
        sources = studio_sources(row)
        remaining = [source for source in sources if material_source_id(source) not in retired_material_ids]
        if len(remaining) != len(sources):
            row.content = {**row.content, "course_studio": {**row.content["course_studio"], "sources": remaining}}
    for release in db.scalars(select(ChapterRelease).where(ChapterRelease.classroom_id.in_(course_class_ids(course_id)))):
        if release.chapter_id in chapter_ids:
            release.status = "paused"
    preview.result = {"ok": True, "removed": len(plan["remove"]), "detached": len(plan["detach"]), "history_preserved": True}
    commit_content(db, instance_id)
    return preview.result
