"""Resolve the same chapter state for access control, reports and learner navigation."""
from sqlalchemy import select

from app.assessment_grades import grade_status
from app.chapter_tasks.rules import reading_task
from app.practice_sessions import practice_progress
from app.models import Activity, ActivityQuestion, AssessmentAttempt, Chapter, ChapterRelease, Material, MaterialChapter, MaterialParticipation, Submission, now


def chapter_materials(chapter, teacher_id):
    return (select(MaterialChapter, Material).join(Material, Material.id == MaterialChapter.material_id)
                      .where(MaterialChapter.chapter_id == chapter.id, Material.course_instance_id == chapter.course_instance_id,
                             Material.owner_id.is_(None) | (Material.owner_id == teacher_id))
                      .order_by(MaterialChapter.order_index, Material.id))


def open_chapters(db, room):
    return db.scalars(select(Chapter).join(ChapterRelease, ChapterRelease.chapter_id == Chapter.id)
                      .where(Chapter.course_instance_id == room.course_id, ChapterRelease.classroom_id == room.id,
                             (Chapter.owner_id.is_(None) | (Chapter.owner_id == room.teacher_id)),
                             ChapterRelease.status == "published", ChapterRelease.opens_at.is_(None) | (ChapterRelease.opens_at <= now()))
                      .order_by(Chapter.order_index)).all()


def activity_task(db, user, room, activity):
    kind = activity.content.get("practice_kind", "objective") if activity.kind == "practice" else "assessment"
    complete = handed_in = False
    if activity.content.get("practice_rules") and kind != "assessment":
        detail = practice_progress(db, user, room.id, activity)
        goals = detail["practice"]["goals"]
        total = len(detail["practice"]["items"]) or sum(max(g["total"], sum(g["by_kind"].values())) for g in goals)
        current = len(detail["accepted_question_ids"])
        complete = detail["completed"]
    else:
        ids = set(db.scalars(select(ActivityQuestion.question_id).where(ActivityQuestion.activity_id == activity.id)))
        total = len(ids)
        if kind == "assessment":
            attempt = db.scalar(select(AssessmentAttempt).where(AssessmentAttempt.activity_id == activity.id,
                                AssessmentAttempt.user_id == user.id, AssessmentAttempt.classroom_id == room.id))
            current = len(ids.intersection(attempt.answers)) if attempt else 0
            if attempt and attempt.state == "submitted":
                total = len(attempt.question_ids)
                current = len(attempt.answers)
                statuses = db.scalars(select(Submission.status).where(
                    Submission.id.in_(list(attempt.submission_ids.values())),
                    Submission.user_id == user.id, Submission.classroom_id == room.id,
                    Submission.activity_id == activity.id)).all()
                complete = grade_status(statuses, total) == "graded"
                handed_in = True
        else:
            passed = db.scalars(select(Submission.question_id).where(Submission.activity_id == activity.id,
                                Submission.user_id == user.id, Submission.classroom_id == room.id, Submission.mode == "submit",
                                Submission.status.in_(("accepted", "AC", "ac"))))
            current = len(ids.intersection(passed))
            complete = bool(total) and current == total
    return {"id": activity.id, "activity_id": activity.id, "title": activity.title, "kind": kind,
            "required": kind == "assessment" or activity.content.get("required", True), "completed": complete,
            "locked": False, "handed_in": handed_in, "lock_reason": None,
            "current": current, "total": total, "unit": "题"}


def chapter_state(db, user, room, chapter):
    evidence = {p.material_id: p.evidence for p in db.scalars(select(MaterialParticipation).where(
        MaterialParticipation.user_id == user.id, MaterialParticipation.classroom_id == room.id,
        MaterialParticipation.chapter_id == chapter.id))}
    tasks = [reading_task(link, material, evidence.get(material.id, {})) for link, material in db.execute(chapter_materials(chapter, room.teacher_id))]
    readings_pending = any(t["required"] and not t["completed"] for t in tasks)
    activities = db.scalars(select(Activity).where(Activity.chapter_id == chapter.id, Activity.course_instance_id == room.course_id,
                                                   (Activity.owner_id.is_(None) | (Activity.owner_id == room.teacher_id)),
                                                   Activity.kind.in_(("practice", "assessment"))))
    ordered = sorted((a for a in activities if a.content.get("published", True)),
                     key=lambda a: (a.kind == "assessment", a.content.get("order_index", 0), a.id))
    practice_pending = False
    for activity in ordered:
        task = activity_task(db, user, room, activity)
        if not task["completed"] and not task["handed_in"]:
            reason = "请先完成本章必读资料" if readings_pending else None
            if not reason and practice_pending and task["kind"] == "assessment":
                reason = "请先完成本章必做练习"
            task.update(locked=bool(reason), lock_reason=reason)
        if task["kind"] != "assessment" and task["required"] and not task["completed"]:
            practice_pending = True
        tasks.append(task)
    return {"id": chapter.id, "title": chapter.title, "order_index": chapter.order_index, "tasks": tasks,
            "completed": bool(tasks) and all(t["completed"] for t in tasks if t["required"])}
