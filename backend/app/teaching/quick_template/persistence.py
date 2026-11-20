"""Write only the native definitions changed by the template in the caller's transaction."""

from datetime import datetime

from sqlalchemy import select

from app.content_relations import set_activity_questions
from app.course_content.resources import set_resources
from app.course_content.snapshot import FIELDS
from app.course_instances import content_mapping, remap_references
from app.db import RetirableContent
from app.integration_models import AssistantSession
from app.models import (
    Activity, ActivityProgress, AssessmentAttempt, ChapterRelease, LearningRecord, Npc,
    PracticeSession, QuestDefinition, StoryDefinition, StorySession, Submission,
)
from app.teacher_scope import scoped_key


MODELS = {"npc": Npc, "activity": Activity, "quest": QuestDefinition, "story": StoryDefinition}


def runtime_ids(db, instance, plan):
    maps = content_mapping(db, instance)
    for kind, model in MODELS.items():
        additions = [key for key, (before, after) in plan.edits[kind].items() if before is None and after is not None]
        if additions and issubclass(model, RetirableContent):
            archived = db.scalars(select(model.stable_id).where(
                model.course_instance_id == instance.id, model.stable_id.in_(additions), model.deleted_at.is_not(None)
            ).execution_options(include_deleted=True)).all()
            if archived:
                plan.blockers.append("生成的内容已通过删除预览归档，保留历史记录期间无法重新使用其标识。")
        maps[kind].update({key: scoped_key(instance.id, kind, key) for key in additions})
    return maps


def protect_learning(db, classroom_id, plan, maps):
    changed_objectives = set()
    for stable_id, (before, after) in plan.edits["activity"].items():
        if not before:
            continue
        changed = after is None or any(before[key] != after[key] for key in ("resources", "question_ids", "kind"))
        rules_changed = after is not None and before["content"].get("practice_rules") != after["content"].get("practice_rules")
        if not changed and not rules_changed:
            continue
        key = maps["activity"][stable_id]
        changed_objectives.add(key)
        if db.scalar(select(StorySession.id).where(StorySession.classroom_id == classroom_id,
                StorySession.pending_activity_id == key, StorySession.status == "waiting").limit(1)):
            plan.blockers.append(f"有学生正在「{before['title']}」学习，请等他们结束本次互动后再调整。")
        if after is None:
            evidence = (ActivityProgress, LearningRecord, PracticeSession, AssessmentAttempt, Submission, AssistantSession)
        elif rules_changed:
            evidence = (PracticeSession, Submission, ActivityProgress, LearningRecord)
        elif before["kind"] == "assessment" and before["question_ids"] != after["question_ids"]:
            # Older graded papers may still exist only as formal submissions.
            evidence = (AssessmentAttempt, Submission)
        else:
            # Reading progress is per material and fixed practice submissions are
            # per question. The normal activity editor can change these associations.
            continue
        if any(db.scalar(select(model.activity_id).where(model.classroom_id == classroom_id, model.activity_id == key).limit(1)) for model in evidence):
            detail = "请保留已有练习目标和个人题单。" if rules_changed else "请保留这项活动及已有试卷的题单。"
            plan.blockers.append(f"「{before['title']}」已有学习记录，{detail}")
    return changed_objectives


def write_plan(db, classroom, instance, plan, maps):
    plan.reset.apply(db, classroom.id)
    for kind, model in MODELS.items():
        for stable, (before, after) in plan.edits[kind].items():
            if after is None:
                continue
            key = maps[kind][stable]
            row = db.get(model, key) if before is not None else None
            if row is None:
                row = model(course_instance_id=instance.id, stable_id=stable, **{"key" if model is Npc else "id": key})
                if hasattr(model, "owner_id"):
                    row.owner_id = classroom.teacher_id
                db.add(row)
            fields = after if model is Npc else remap_references(after, maps)
            if model is QuestDefinition:
                fields["definition"]["id"] = key
            for field in FIELDS[model]:
                setattr(row, field, fields[field])
            if model is Activity:
                set_resources(db, row, fields["resources"])
                set_activity_questions(db, row, fields["question_ids"])
        db.flush()
    for kind, model in reversed(MODELS.items()):
        for stable, (_, after) in plan.edits[kind].items():
            if after is None:
                row = db.get(model, maps[kind][stable])
                if model is Activity:
                    set_activity_questions(db, row, [])
                db.delete(row)
        db.flush()
    for stable, (_, after) in plan.edits["releases"].items():
        key = maps["chapter"][stable]
        release = db.get(ChapterRelease, (classroom.id, key))
        if after is None:
            db.delete(release)
            continue
        if release is None:
            release = ChapterRelease(classroom_id=classroom.id, chapter_id=key)
            db.add(release)
        release.status = after["status"]
        release.opens_at = datetime.fromisoformat(after["opens_at"]) if after["opens_at"] else None
        release.prerequisite_chapter_id = maps["chapter"].get(after["prerequisite_chapter_id"])
