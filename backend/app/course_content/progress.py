"""Aggregate authorized classroom learner progress and evidence."""

from fastapi import HTTPException
from collections import Counter

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import as_utc
from app.classrooms.access import own_classroom
from app.chapter_tasks.service import activity_task, chapter_state, open_chapters
from app.models import (Activity, AssessmentAttempt, Chapter, Classroom, Material, MaterialParticipation, Membership,
                        PracticeSession, Submission, TownPreviewStudent, User)


def progress(classroom_id: int, db: Session, user: User):
    room = own_classroom(db, user, classroom_id)

    chapters = open_chapters(db, room)
    members = db.scalars(select(User).join(Membership, Membership.user_id == User.id).where(Membership.classroom_id == classroom_id)).all()
    preview_ids = select(TownPreviewStudent.student_user_id).where(TownPreviewStudent.classroom_id == classroom_id)
    submissions = db.scalars(
        select(Submission).where(Submission.classroom_id == classroom_id, Submission.mode == "submit", Submission.user_id.not_in(preview_ids))
    ).all()
    chapter_progress = {m.id: [chapter_state(db, m, room, chapter) for chapter in chapters] for m in members}
    material_counts = Counter(db.scalars(select(MaterialParticipation.user_id).where(MaterialParticipation.classroom_id == classroom_id)))
    submission_counts = Counter(s.user_id for s in submissions)
    distribution = Counter(s.status for s in submissions)
    return {
        "members": [
            {
                "id": m.id,
                "name": m.name,
                "student_id": m.student_id,
                "completed_chapters": sum(c["completed"] for c in chapter_progress[m.id]),
                "completed_tasks": sum(t["completed"] for c in chapter_progress[m.id] for t in c["tasks"]),
                "submissions": submission_counts[m.id],
                "records": material_counts[m.id],
            }
            for m in members
        ],
        "submissions": [
            {"id": s.id, "user_id": s.user_id, "question_id": s.question_id, "status": s.status, "created_at": as_utc(s.created_at).isoformat()}
            for s in submissions
        ],
        "error_distribution": distribution,
    }


def student_record(classroom_id: int, student_id: int, db: Session, user: User):
    own_classroom(db, user, classroom_id)
    if not db.get(Membership, (student_id, classroom_id)):
        raise HTTPException(404, "学生不在当前班级")
    return record_payload(classroom_id, student_id, db)


def participation_rows(db, room, student):
    records = []
    readings = (select(MaterialParticipation, Chapter.title, Material)
        .join(Chapter, Chapter.id == MaterialParticipation.chapter_id)
        .join(Material, Material.id == MaterialParticipation.material_id)
        .where(MaterialParticipation.classroom_id == room.id, MaterialParticipation.user_id == student.id,
               Chapter.course_instance_id == room.course_id, Material.course_instance_id == room.course_id)
        .execution_options(include_deleted=True))
    for entry, chapter, material in db.execute(readings):
        state = entry.evidence
        evidence = ({"watched_seconds": int(state.get("video", {}).get("watched_seconds", 0))}
                    if material.kind == "video" else {"read_pages": len(set(state.get("pages", []))), "read_seconds": int(state.get("seconds", 0))})
        records.append({"id": f"reading:{entry.chapter_id}:{material.id}", "chapter": chapter, "title": material.title,
                        "kind": "reading", "created_at": state.get("received_at"), **evidence})
    last_action = {}
    for model, timestamp in ((Submission, Submission.created_at), (AssessmentAttempt, AssessmentAttempt.updated_at)):
        for key, date in db.execute(select(model.activity_id, timestamp).where(
                model.user_id == student.id, model.classroom_id == room.id)):
            last_action[key] = max(last_action.get(key, ""), as_utc(date).isoformat())
    for key in db.scalars(select(PracticeSession.activity_id).where(
            PracticeSession.user_id == student.id, PracticeSession.classroom_id == room.id)):
        last_action.setdefault(key, None)
    if last_action:
        activities = select(Activity, Chapter.title).join(Chapter, Chapter.id == Activity.chapter_id).where(
            Activity.id.in_(last_action), Activity.course_instance_id == room.course_id).execution_options(include_deleted=True)
        for activity, chapter in db.execute(activities):
            task = activity_task(db, student, room, activity)
            records.append({"id": activity.id, "chapter": chapter, "title": activity.title, "kind": task["kind"],
                            "current": task["current"], "total": task["total"], "created_at": last_action[activity.id]})
    return sorted(records, key=lambda r: r["created_at"] or "", reverse=True)


def record_payload(classroom_id, student_id, db):
    room = db.get(Classroom, classroom_id)
    student = db.get(User, student_id)
    return {
        "student": {"id": student.id, "name": student.name, "student_id": student.student_id},
        "chapters": [chapter_state(db, student, room, chapter) for chapter in open_chapters(db, room)],
        "assessments": student_assessments(db, classroom_id, student_id),
        "participation": participation_rows(db, room, student),
        "submissions": [
            {
                "id": s.id,
                "question_id": s.question_id,
                "mode": s.mode,
                "status": s.status,
                "answer": s.answer,
                "code": s.code,
                "feedback": s.feedback,
                "created_at": as_utc(s.created_at).isoformat(),
            }
            for s in db.scalars(
                select(Submission).where(Submission.classroom_id == classroom_id, Submission.user_id == student_id).order_by(Submission.created_at)
            )
        ],
    }


def student_assessments(db, classroom_id, student_id):
    from app.assessments import assessment_payload

    learner = db.get(User, student_id)
    query = (select(AssessmentAttempt, Activity)
             .join(Activity, Activity.id == AssessmentAttempt.activity_id)
             .where(AssessmentAttempt.classroom_id == classroom_id, AssessmentAttempt.user_id == student_id)
             .order_by(AssessmentAttempt.created_at)
             .execution_options(include_deleted=True))
    assessments = []
    for attempt, activity in db.execute(query):
        result = {"status": "draft", "score": None, "max_score": 100}
        if attempt.state in {"submitted", "legacy"}:
            # Locked papers use their persisted question/submission IDs, even after content changes.
            paper = assessment_payload(db, learner, classroom_id, activity)
            result = {key: paper[key] for key in ("status", "score", "max_score")}
        assessments.append({"id": attempt.id, "activity_id": activity.id, "activity_title": activity.title, **result})
    return assessments
