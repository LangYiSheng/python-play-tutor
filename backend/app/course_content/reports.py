"""Course participation totals and class-specific activity and assessment reports."""
from collections import Counter
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import func, select, union
from sqlalchemy.orm import Session

from app.auth import as_utc, require_teacher
from app.classrooms.access import own_classroom
from app.course_content.presentation import progress_payload
from app.chapter_tasks.rules import reading_task
from app.chapter_tasks.service import activity_task
from app.course_scope import course_class_ids
from app.db import get_db
from app.integration_models import AssistantSession
from app.models import (Activity, ActivityProgress, AssessmentAttempt, Chapter, ChapterRelease, Classroom,
                        KnowledgePoint, LearningRecord, Material, MaterialChapter, MaterialParticipation, Membership, PracticeSession, Question,
                        Submission, TownPreviewStudent, User, now)
from app.teacher_scope import own_course

router = APIRouter(tags=["learning reports"])
Db = Annotated[Session, Depends(get_db)]
Teacher = Annotated[User, Depends(require_teacher)]


def formal_students():
    return select(User.id).where(User.role == "student", User.id.not_in(select(TownPreviewStudent.student_user_id)))


def participation(classes):
    queries = []
    for model in (ActivityProgress, LearningRecord, Submission, PracticeSession, AssessmentAttempt):
        query = select(model.classroom_id, model.user_id, model.activity_id).where(
            model.classroom_id.in_(classes), model.user_id.in_(formal_students()))
        if model is Submission:
            query = query.where(Submission.mode == "submit")
        queries.append(query)
    return union(*queries).subquery()


@router.get("/teacher/courses/{course_id}/insights")
def insights(course_id: int, db: Db, user: Teacher):
    course = own_course(db, user, course_id)
    classes = course_class_ids(course_id)
    active = classes.where(Classroom.status == "active")
    totals = {"classrooms": db.scalar(select(func.count()).select_from(active.subquery())),
              "students": db.scalar(select(func.count(func.distinct(Membership.user_id))).where(
                  Membership.classroom_id.in_(active), Membership.user_id.in_(formal_students())))}
    for key, model in (("materials", Material), ("points", KnowledgePoint), ("questions", Question)):
        totals[key] = db.scalar(select(func.count(model.id)).where(model.course_instance_id == course_id, model.deleted_at.is_(None)))
    evidence = participation(classes)
    usage = Counter()
    for kind, count in db.execute(select(Activity.kind, func.count()).select_from(evidence)
            .join(Activity, Activity.id == evidence.c.activity_id).where(Activity.course_instance_id == course_id)
            .group_by(Activity.kind).execution_options(include_deleted=True)):
        usage[kind if kind in {"practice", "assessment"} else "learning"] += count
    usage["learning"] += db.scalar(select(func.count()).select_from(MaterialParticipation).where(
        MaterialParticipation.classroom_id.in_(classes), MaterialParticipation.user_id.in_(formal_students())))
    assistant = {key: {"sessions": 0, "messages": 0} for key in ("learning", "practice")}
    query = select(Activity.kind, AssistantSession.messages).select_from(AssistantSession).outerjoin(
        Activity, Activity.id == AssistantSession.activity_id).where(AssistantSession.classroom_id.in_(classes),
        AssistantSession.user_id.in_(formal_students())).execution_options(include_deleted=True)
    for kind, messages in db.execute(query):
        if any(m.get("role") == "user" for m in messages):
            bucket = assistant["practice" if kind == "practice" else "learning"]
            bucket["sessions"] += 1
            bucket["messages"] += sum(m.get("role") in {"user", "assistant"} for m in messages)
    return {"name": course.name, "teacher": db.get(User, course.teacher_id).name,
            "totals": totals, "usage": usage, "assistant": assistant}


@router.get("/teacher/classrooms/{classroom_id}/activity-report")
def class_report(classroom_id: int, db: Db, user: Teacher, grades: bool = False):
    room = own_classroom(db, user, classroom_id)
    members = select(Membership.user_id).where(Membership.classroom_id == room.id)
    roster = set(db.scalars(members))
    evidence = participation([room.id])
    student_ids = union(members, select(evidence.c.user_id)) if grades else members
    students = list(db.scalars(select(User).where(User.id.in_(student_ids), User.role == "student",
        User.id.not_in(select(TownPreviewStudent.student_user_id))).order_by(User.student_id)))
    activities = select(Activity, Chapter.title).join(Chapter, Chapter.id == Activity.chapter_id).where(
        Activity.course_instance_id == room.course_id,
        Chapter.owner_id.is_(None) | (Chapter.owner_id == room.teacher_id),
        Activity.owner_id.is_(None) | (Activity.owner_id == room.teacher_id)).order_by(Chapter.order_index, Activity.title, Activity.id)
    if grades:
        activities = activities.where(Activity.kind == "assessment", (Activity.deleted_at.is_(None) & Chapter.deleted_at.is_(None))
            | Activity.id.in_(select(evidence.c.activity_id))).execution_options(include_deleted=True)
    started = set(db.execute(select(evidence.c.user_id, evidence.c.activity_id)))
    releases = {r.chapter_id: r for r in db.scalars(select(ChapterRelease).where(ChapterRelease.classroom_id == room.id))}
    columns = []
    chapter_order = dict(db.execute(select(Chapter.id, Chapter.order_index).where(Chapter.course_instance_id == room.course_id)).all())
    if not grades:
        records = {(r.chapter_id, r.material_id, r.user_id): r.evidence for r in db.scalars(
            select(MaterialParticipation).where(MaterialParticipation.classroom_id == room.id, MaterialParticipation.user_id.in_(roster)))}
        links = db.execute(select(MaterialChapter, Material, Chapter)
            .join(Material, Material.id == MaterialChapter.material_id).join(Chapter, Chapter.id == MaterialChapter.chapter_id)
            .where(Chapter.course_instance_id == room.course_id, Material.course_instance_id == room.course_id,
                   Chapter.owner_id.is_(None) | (Chapter.owner_id == room.teacher_id),
                   Material.owner_id.is_(None) | (Material.owner_id == room.teacher_id))
            .order_by(Chapter.order_index, MaterialChapter.order_index, Material.id))
        for link, material, chapter in links:
            release = releases.get(chapter.id)
            results = {}
            for student in students:
                evidence_key = (chapter.id, material.id, student.id)
                if evidence_key not in records:
                    continue
                state = reading_task(link, material, records[evidence_key])
                results[student.id] = {"completed": state["completed"], "current": state["current"], "total": state["total"],
                    "fraction": state["current"] / state["total"] if state["total"] else 0, "unit": state["unit"],
                    "resources": [{"material_id": material.id, "read_count": state["read_count"], "read_total": state["read_total"],
                                   "seconds": state["seconds"], "required_seconds": state["required_seconds"], "video": material.kind == "video"}]}
            columns.append({"id": f"reading:{chapter.id}:{material.id}", "title": material.title, "chapter": chapter.title,
                "chapter_id": chapter.id, "kind": "reading", "required": link.required, "material_titles": {material.id: material.title},
                "opened": bool(release and release.status == "published" and (not release.opens_at or as_utc(release.opens_at) <= now())),
                "results": results, "completed": sum(r["completed"] for r in results.values())})
    for activity, chapter in db.execute(activities):
        release = releases.get(activity.chapter_id)
        opened = bool(release and release.status == "published" and (not release.opens_at or as_utc(release.opens_at) <= now())
                      and activity.content.get("published") is not False)
        results = {}
        for student in students:
            if (student.id, activity.id) not in started:
                continue
            if activity.kind == "assessment":
                state = progress_payload(db, student, room.id, activity)
                results[student.id] = {k: state[k] for k in ("completed", "score", "assessment_status")}
            else:
                task = activity_task(db, student, room, activity)
                results[student.id] = {"completed": task["completed"], "accepted": task["current"], "assigned": task["total"]}
        columns.append({"chapter_id": activity.chapter_id, "kind": activity.content.get("practice_kind", activity.kind),
                        "required": activity.content.get("required", True), "material_titles": {}, "id": activity.id, "title": activity.title, "chapter": chapter, "opened": opened, "results": results,
                        "completed": sum(row["completed"] for row in results.values())})
    columns.sort(key=lambda row: chapter_order.get(row["chapter_id"], 0))
    return {"activities": columns, "students": [{"id": s.id, "name": s.name, "student_id": s.student_id, "enrolled": s.id in roster} for s in students]}
