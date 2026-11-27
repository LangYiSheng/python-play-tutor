"""Compute replacement impact without changing course content or learner history."""
from collections import Counter
import hashlib

from app.course_scope import course_class_ids

from sqlalchemy import select

from app.course_packages.snapshot import stable_id
from app.course_packages.snapshot import package_snapshot
from app.course_instances import MODEL_NAMES, content_mapping
from app.course_packages.contracts import PACKAGE_MODELS
from app.integration_models import AssistantSession
from app.materials.storage import get_storage
from app.practice_rules import practice_question_available, without_legacy_retry_interval
from app.models import ActivityProgress, AssessmentAttempt, Classroom, LearningRecord, Material, MaterialParticipation, PracticeSession, Submission


def has_learning_history(db, course_id):
    from app.models import PlayerPosition

    return any(
        db.scalar(select(model).where(model.classroom_id.in_(course_class_ids(course_id))).limit(1)) is not None
        for model in (
            MaterialParticipation,
            ActivityProgress,
            LearningRecord,
            Submission,
            AssessmentAttempt,
            PracticeSession,
            AssistantSession,
            PlayerPosition,
        )
    )


def preview_impact(db, instance, bundle):
    from app.course_packages.exams import current_rows as current_exam_rows, preview_exams
    from app.course_packages.narrations import preview_narrations, revision

    narration_revision = revision(db, instance)
    snapshot = package_snapshot(db, instance) if instance else None
    previous = snapshot[0] if snapshot else {MODEL_NAMES[model]: [] for model in PACKAGE_MODELS}
    diff = {}

    def compare(kind, old, new):
        diff[kind] = {
            "added": sorted(new.keys() - old.keys()),
            "removed": sorted(old.keys() - new.keys()),
            "updated": sorted(key for key in old.keys() & new.keys() if old[key] != new[key]),
        }

    for kind, incoming in bundle["data"].items():
        compare(kind, {row["id"]: row for row in previous[kind]}, {row["id"]: row for row in incoming})
    diff["narrations"] = preview_narrations(db, instance, bundle)
    if current_exam_rows(db, instance) or bundle.get("exams_present") or bundle.get("exams"):
        diff["exams"] = preview_exams(db, instance, bundle)
    compare("answers", {row["id"]: row for row in snapshot[1]} if snapshot else {}, {row["id"]: row for row in bundle["secrets"]})
    old_config = snapshot[2] if snapshot else {}
    old_assets = {row["id"]: row["sha256"] for row in old_config.get("_assets", [])}
    if snapshot:
        material_assets = {row["id"]: row["asset_id"] for row in previous["material"]}
        adapter = get_storage()
        for material in snapshot[3][Material]:
            if material.storage_key:
                try:
                    digest = hashlib.sha256()
                    for chunk in adapter.chunks(material.storage_key, 0, adapter.size(material.storage_key) - 1):
                        digest.update(chunk)
                    old_assets[material_assets[stable_id(material)]] = digest.hexdigest()
                except Exception:
                    old_assets[material_assets[stable_id(material)]] = None
    compare("assets", old_assets, {row["id"]: row["sha256"] for row in bundle["assets"]})
    compare(
        "manifest",
        {"package_id": instance.package_id, "name": instance.name, "package_version": instance.package_version} if instance else {},
        {key: bundle["manifest"][key] for key in ("package_id", "name", "package_version")},
    )
    blockers, learning_impact = [], []
    if instance:
        from app.db import RetirableContent
        from app.course_studio.jobs import has_active_course_jobs

        if has_active_course_jobs(db, instance.id):
            blockers.append("课程备课任务仍在处理，请完成后重新预览")
        for model in PACKAGE_MODELS:
            if not issubclass(model, RetirableContent):
                continue
            incoming_ids = {row["id"] for row in bundle["data"][MODEL_NAMES[model]]}
            retired = db.scalars(
                select(model.stable_id)
                .where(model.course_instance_id == instance.id, model.deleted_at.is_not(None), model.stable_id.in_(incoming_ids))
                .execution_options(include_deleted=True)
            ).all()
            if retired:
                blockers.append(f"{MODEL_NAMES[model]} 包含已删除且保留历史的ID，请为新内容使用新ID：" + "、".join(retired[:10]))
    if instance and db.scalar(
        select(Material.id).where(Material.course_instance_id == instance.id, Material.status.in_(["queued", "processing"])).limit(1)
    ):
        blockers.append("课程资料仍在转换，请完成后重新预览")
    if instance and has_learning_history(db, instance.id):
        if instance.package_id != bundle["manifest"]["package_id"]:
            blockers.append("课程已有班级学习记录，请新建课程后导入其他课程包")
        elif any(diff[MODEL_NAMES[model]]["removed"] for model in PACKAGE_MODELS):
            blockers.append("课程已有班级学习记录，本次更新包含删除定义；请保留原ID并停用内容后重新预览")
    if instance:
        incoming = {kind: {row["id"]: row for row in values} for kind, values in bundle["data"].items()}
        current = {kind: {row["id"]: row for row in values} for kind, values in previous.items()}
        maps = content_mapping(db, instance)
        # Retired definitions still own historical foreign keys, even when no
        # learner has used them. Package replacement must not hard-delete their
        # current parents or fail later as an unexplained integrity error.
        from sqlalchemy import or_

        table_kinds = {model.__tablename__: MODEL_NAMES[model] for model in PACKAGE_MODELS}
        for model in PACKAGE_MODELS:
            if not issubclass(model, RetirableContent):
                continue
            references = []
            for foreign in model.__table__.foreign_keys:
                kind = table_kinds.get(foreign.column.table.name)
                if kind:
                    removed_keys = [maps[kind][key] for key in diff[kind]["removed"]]
                    if removed_keys:
                        references.append(foreign.parent.in_(removed_keys))
            if references and db.scalar(
                select(model)
                .where(model.course_instance_id == instance.id, model.deleted_at.is_not(None), or_(*references))
                .execution_options(include_deleted=True)
                .limit(1)
            ):
                blockers.append("待移除定义仍被历史保留内容引用，请先使用级联删除预览处理，再重新导入")
        attempts = list(db.scalars(select(AssessmentAttempt).where(AssessmentAttempt.classroom_id.in_(course_class_ids(instance.id)))))
        practices = list(db.scalars(select(PracticeSession).where(PracticeSession.classroom_id.in_(course_class_ids(instance.id)))))
        submissions = list(db.scalars(select(Submission).where(Submission.classroom_id.in_(course_class_ids(instance.id)))))
        room_names = dict(db.execute(select(Classroom.id, Classroom.name).where(Classroom.course_id == instance.id)).all())

        def protect(kind, stable_id, class_ids, reason):
            counts = Counter(class_ids)
            if not counts:
                return
            reason += "（" + "、".join(f"{room_names[cid]} {n} 条" for cid, n in sorted(counts.items())) + "）"
            learning_impact.append({"kind": kind, "stable_id": stable_id, "affected_records": sum(counts.values()), "reason": reason})
            blockers.append(reason)

        for stable in diff["question"]["updated"]:
            key = maps["question"][stable]
            if current["question"][stable]["kind"] != incoming["question"][stable]["kind"]:
                count = [r.classroom_id for r in submissions if r.question_id == key] + [r.classroom_id for r in attempts if key in r.question_ids]
                protect("question", stable, count, "已有正式题目证据，改变题型需要新的题目ID")
            new_question = incoming["question"][stable]
            available = practice_question_available(
                new_question["kind"],
                new_question["status"],
                bool(new_question["samples"]),
                (new_question.get("source") or {}).get("usage"),
            )
            available_points = {maps["knowledge_point"].get(point) for point in new_question["knowledge_point_ids"]}
            assigned = [session.classroom_id for session in practices if any(item["question_id"] == key and (
                    item["kind"] != new_question["kind"] or not available or item["knowledge_point_id"] not in available_points
                ) for item in session.items)]
            protect("question", stable, assigned, "题目已进入学生个人题单，须保留可用状态、已分配的知识点和题型；编程题须保留公开样例")
        for stable in diff["activity"]["updated"]:
            old, new = current["activity"][stable], incoming["activity"][stable]
            key = maps["activity"][stable]
            changed_rules = old["content"].get("practice_rules") != without_legacy_retry_interval(new["content"].get("practice_rules"))
            if changed_rules or old["content"].get("practice_kind") != new["content"].get("practice_kind") or old["kind"] != new["kind"] or (old["kind"] == "assessment" and old["question_ids"] != new["question_ids"]):
                class_ids = [row.classroom_id for rows in (attempts, submissions, practices) for row in rows if row.activity_id == key]
                for model in (ActivityProgress, LearningRecord):
                    class_ids.extend(db.scalars(select(model.classroom_id).where(
                        model.classroom_id.in_(course_class_ids(instance.id)), model.activity_id == key)))
                protect("activity", stable, class_ids, "活动已有学习或测验证据，改变活动类型、练习目标或测验题集需要新的活动ID")
    warnings = ["各班的开放时间和暂停状态单独维护。", "同 ID 更新保留学习证据与成绩。"]
    return {
        "narration_revision": narration_revision,
        "diff": diff,
        "blockers": list(dict.fromkeys(blockers)),
        "learning_impact": learning_impact,
        "warnings": warnings,
    }
