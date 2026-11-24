"""Course participation totals and class-specific activity and assessment reports."""
from collections import Counter
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import func, select, union
from sqlalchemy.orm import Session

from app.auth import as_utc, require_teacher
from app.classrooms.access import own_classroom
from app.course_content.presentation import progress_payload
from app.course_content.resources import learning_materials, reading_progress
from app.course_scope import course_class_ids
from app.db import get_db
from app.integration_models import AssistantSession
from app.models import (Activity, ActivityProgress, AssessmentAttempt, Chapter, ChapterRelease, Classroom,
                        KnowledgePoint, LearningRecord, Material, Membership, PracticeSession, Question,
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
        Activity.course_instance_id == room.course_id).order_by(Chapter.order_index, Activity.title, Activity.id)
    if grades:
        activities = activities.where(Activity.kind == "assessment", (Activity.deleted_at.is_(None) & Chapter.deleted_at.is_(None))
            | Activity.id.in_(select(evidence.c.activity_id))).execution_options(include_deleted=True)
    started = set(db.execute(select(evidence.c.user_id, evidence.c.activity_id)))
    releases = {r.chapter_id: r for r in db.scalars(select(ChapterRelease).where(ChapterRelease.classroom_id == room.id))}
    reading_records = {}
    if not grades:
        reading_records = {(row.user_id, row.activity_id): row for row in db.scalars(
            select(ActivityProgress).where(ActivityProgress.classroom_id == room.id, ActivityProgress.user_id.in_(roster)))}
    columns = []
    for activity, chapter in db.execute(activities):
        release = releases.get(activity.chapter_id)
        opened = bool(release and release.status == "published" and (not release.opens_at or as_utc(release.opens_at) <= now())
                      and activity.content.get("published") is not False)
        results = {}
        materials = None
        for student in students:
            if (student.id, activity.id) not in started:
                continue
            if activity.kind not in {"practice", "assessment"}:
                if materials is None:
                    materials = learning_materials(db, activity)
                state = reading_progress(activity, reading_records.get((student.id, activity.id)), materials)
            else:
                state = progress_payload(db, student, room.id, activity)
            results[student.id] = {k: state[k] for k in ("completed", "fraction", "score", "assessment_status") if k in state}
            if "resources" in state:
                results[student.id]["resources"] = [{key: resource[key] for key in
                    ("material_id", "read_count", "read_total", "watched_seconds", "required_seconds")}
                    for resource in state["resources"]]
            if "accepted_question_ids" in state:
                results[student.id]["accepted"] = len(state["accepted_question_ids"])
                if "practice" in state:
                    results[student.id]["assigned"] = len(state["practice"]["items"])
        material_ids = [r.material_id for r in activity.resources] if not grades else []
        titles = dict(db.execute(select(Material.id, Material.title).where(Material.id.in_(material_ids))).all()) if material_ids else {}
        columns.append({"material_titles": titles, "id": activity.id, "title": activity.title, "chapter": chapter, "opened": opened, "results": results,
                        "completed": sum(row["completed"] for row in results.values())})
    return {"activities": columns, "students": [{"id": s.id, "name": s.name, "student_id": s.student_id, "enrolled": s.id in roster} for s in students]}
