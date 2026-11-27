"""Course participation totals and class-specific activity and assessment reports."""
from collections import Counter
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy import func, select, union
from sqlalchemy.orm import Session

from app.auth import as_utc, require_teacher
from app.chapter_tasks.rules import reading_task
from app.chapter_tasks.service import activity_task
from app.classrooms.access import own_classroom
from app.course_content.insights_analytics import build_course_insights_extras
from app.course_content.presentation import progress_payload
from app.course_scope import course_class_ids
from app.db import get_db
from app.integration_models import AssistantSession
from app.models import (
    Activity,
    ActivityProgress,
    ActivityQuestion,
    AssessmentAttempt,
    Chapter,
    ChapterRelease,
    Classroom,
    KnowledgePoint,
    LearningRecord,
    Material,
    MaterialChapter,
    MaterialParticipation,
    Membership,
    PracticeSession,
    Question,
    Submission,
    TownPreviewStudent,
    User,
    now,
)
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


def _initial_practice_total(activity: Activity, fixed_count: int) -> int:
    rules = activity.content.get("practice_rules")
    if rules:
        return sum(max(goal["total"], sum(goal.get("by_kind", {}).values())) for goal in rules.get("goals", []))
    return fixed_count


@router.get("/teacher/courses/{course_id}/insights")
def insights(course_id: int, db: Db, user: Teacher) -> dict[str, Any]:
    course = own_course(db, user, course_id)
    classes = course_class_ids(course_id)
    active = classes.where(Classroom.status == "active")
    totals: dict[str, int] = {
        "classrooms": db.scalar(select(func.count()).select_from(active.subquery())) or 0,
        "students": db.scalar(
            select(func.count(func.distinct(Membership.user_id))).where(
                Membership.classroom_id.in_(active), Membership.user_id.in_(formal_students())
            )
        ) or 0,
    }
    for key, model in (("chapters", Chapter), ("materials", Material), ("points", KnowledgePoint), ("questions", Question)):
        totals[key] = db.scalar(
            select(func.count(model.id)).where(model.course_instance_id == course_id, model.deleted_at.is_(None))
        ) or 0
    evidence = participation(classes)
    usage: Counter[str] = Counter()
    for kind, count in db.execute(
        select(Activity.kind, func.count())
        .select_from(evidence)
        .join(Activity, Activity.id == evidence.c.activity_id)
        .where(Activity.course_instance_id == course_id)
        .group_by(Activity.kind)
        .execution_options(include_deleted=True)
    ):
        usage[kind if kind in {"practice", "assessment"} else "learning"] += count
    usage["learning"] += db.scalar(
        select(func.count()).select_from(MaterialParticipation).where(
            MaterialParticipation.classroom_id.in_(classes), MaterialParticipation.user_id.in_(formal_students())
        )
    ) or 0
    assistant = {key: {"sessions": 0, "messages": 0} for key in ("learning", "practice")}
    query = (
        select(Activity.kind, AssistantSession.messages)
        .select_from(AssistantSession)
        .outerjoin(Activity, Activity.id == AssistantSession.activity_id)
        .where(AssistantSession.classroom_id.in_(classes), AssistantSession.user_id.in_(formal_students()))
        .execution_options(include_deleted=True)
    )
    for kind, messages in db.execute(query):
        if any(m.get("role") == "user" for m in messages):
            bucket = assistant["practice" if kind == "practice" else "learning"]
            bucket["sessions"] += 1
            bucket["messages"] += sum(m.get("role") in {"user", "assistant"} for m in messages)
    extras = build_course_insights_extras(db, course)
    teacher = db.get(User, course.teacher_id)
    return {
        "name": course.name,
        "teacher": teacher.name if teacher else "",
        "totals": totals,
        "usage": usage,
        "assistant": assistant,
        **extras,
    }


@router.get("/teacher/classrooms/{classroom_id}/activity-report")
def class_report(classroom_id: int, db: Db, user: Teacher, grades: bool = False) -> dict[str, Any]:
    room = own_classroom(db, user, classroom_id)
    members = select(Membership.user_id).where(Membership.classroom_id == room.id)
    roster = set(db.scalars(members))
    evidence = participation([room.id])
    student_ids = union(members, select(evidence.c.user_id)) if grades else members
    students = list(
        db.scalars(
            select(User)
            .where(
                User.id.in_(student_ids),
                User.role == "student",
                User.id.not_in(select(TownPreviewStudent.student_user_id)),
            )
            .order_by(User.student_id)
        )
    )
    activities_query = (
        select(Activity, Chapter.title)
        .join(Chapter, Chapter.id == Activity.chapter_id)
        .where(
            Activity.course_instance_id == room.course_id,
            Chapter.owner_id.is_(None) | (Chapter.owner_id == room.teacher_id),
            Activity.owner_id.is_(None) | (Activity.owner_id == room.teacher_id),
        )
        .order_by(Chapter.order_index, Activity.title, Activity.id)
    )
    if grades:
        activities_query = activities_query.where(
            Activity.kind == "assessment",
            (Activity.deleted_at.is_(None) & Chapter.deleted_at.is_(None))
            | Activity.id.in_(select(evidence.c.activity_id)),
        ).execution_options(include_deleted=True)
    started = set(db.execute(select(evidence.c.user_id, evidence.c.activity_id)))
    releases = {r.chapter_id: r for r in db.scalars(select(ChapterRelease).where(ChapterRelease.classroom_id == room.id))}
    chapter_rows = list(
        db.scalars(
            select(Chapter).where(
                Chapter.course_instance_id == room.course_id,
                Chapter.owner_id.is_(None) | (Chapter.owner_id == room.teacher_id),
            )
        )
    )
    chapter_order = {c.id: c.order_index for c in chapter_rows}
    current_time = now()
    open_chapter_count = sum(
        1
        for c in chapter_rows
        if (rel := releases.get(c.id)) is not None
        and rel.status == "published"
        and (not rel.opens_at or as_utc(rel.opens_at) <= current_time)
    )
    columns: list[dict[str, Any]] = []
    if not grades:
        records = {
            (r.chapter_id, r.material_id, r.user_id): r.evidence
            for r in db.scalars(
                select(MaterialParticipation).where(
                    MaterialParticipation.classroom_id == room.id,
                    MaterialParticipation.user_id.in_(roster),
                )
            )
        }
        links = db.execute(
            select(MaterialChapter, Material, Chapter)
            .join(Material, Material.id == MaterialChapter.material_id)
            .join(Chapter, Chapter.id == MaterialChapter.chapter_id)
            .where(
                Chapter.course_instance_id == room.course_id,
                Material.course_instance_id == room.course_id,
                Chapter.owner_id.is_(None) | (Chapter.owner_id == room.teacher_id),
                Material.owner_id.is_(None) | (Material.owner_id == room.teacher_id),
            )
            .order_by(Chapter.order_index, MaterialChapter.order_index, Material.id)
        )
        for link, material, chapter in links:
            release = releases.get(chapter.id)
            results: dict[int, dict[str, Any]] = {}
            for student in students:
                evidence_key = (chapter.id, material.id, student.id)
                if evidence_key not in records:
                    continue
                state = reading_task(link, material, records[evidence_key])
                results[student.id] = {
                    "completed": state["completed"],
                    "current": state["current"],
                    "total": state["total"],
                    "fraction": state["current"] / state["total"] if state["total"] else 0,
                    "unit": state["unit"],
                    "resources": [
                        {
                            "material_id": material.id,
                            "read_count": state["read_count"],
                            "read_total": state["read_total"],
                            "seconds": state["seconds"],
                            "required_seconds": state["required_seconds"],
                            "video": material.kind == "video",
                        }
                    ],
                }
            completed_count = sum(1 for r in results.values() if r["completed"])
            in_progress_count = sum(1 for r in results.values() if not r["completed"])
            columns.append(
                {
                    "id": f"reading:{chapter.id}:{material.id}",
                    "title": material.title,
                    "chapter": chapter.title,
                    "chapter_id": chapter.id,
                    "chapter_order": chapter.order_index,
                    "kind": "reading",
                    "material_kind": material.kind,
                    "required": link.required,
                    "material_titles": {material.id: material.title},
                    "opened": bool(
                        release and release.status == "published" and (not release.opens_at or as_utc(release.opens_at) <= current_time)
                    ),
                    "results": results,
                    "completed": completed_count,
                    "in_progress": in_progress_count,
                }
            )

    activity_rows = list(db.execute(activities_query))
    activity_ids = [act.id for act, _ in activity_rows]
    fixed_counts: dict[str, int] = dict(
        db.execute(
            select(ActivityQuestion.activity_id, func.count(ActivityQuestion.question_id))
            .where(ActivityQuestion.activity_id.in_(activity_ids or [""]))
            .group_by(ActivityQuestion.activity_id)
        ).all()
    )
    session_appended: dict[tuple[str, int], int] = {}
    if not grades and activity_ids:
        for ps in db.scalars(
            select(PracticeSession).where(
                PracticeSession.classroom_id == room.id,
                PracticeSession.activity_id.in_(activity_ids),
            )
        ):
            session_appended[(ps.activity_id, ps.user_id)] = sum(1 for item in ps.items if item.get("appended"))
    attempt_submitted_at: dict[tuple[str, int], str | None] = {}
    if activity_ids:
        for att in db.scalars(
            select(AssessmentAttempt).where(
                AssessmentAttempt.classroom_id == room.id,
                AssessmentAttempt.activity_id.in_(activity_ids),
            )
        ):
            attempt_submitted_at[(att.activity_id, att.user_id)] = (
                as_utc(att.submitted_at).isoformat() if att.submitted_at else None
            )

    for activity, chapter_title in activity_rows:
        release = releases.get(activity.chapter_id)
        opened = bool(
            release
            and release.status == "published"
            and (not release.opens_at or as_utc(release.opens_at) <= current_time)
            and activity.content.get("published") is not False
        )
        results = {}
        for student in students:
            if (student.id, activity.id) not in started:
                continue
            if activity.kind == "assessment":
                state = progress_payload(db, student, room.id, activity)
                results[student.id] = {
                    "completed": state["completed"],
                    "score": state["score"],
                    "assessment_status": state["assessment_status"],
                    "correct_count": state["correct_count"],
                    "total": state["total"],
                    "submitted_at": attempt_submitted_at.get((activity.id, student.id)),
                }
            else:
                task = activity_task(db, student, room, activity)
                results[student.id] = {
                    "completed": task["completed"],
                    "accepted": task["current"],
                    "assigned": task["total"],
                    "appended": session_appended.get((activity.id, student.id), 0),
                }
        completed_count = sum(1 for row in results.values() if row["completed"])
        in_progress_count = sum(1 for row in results.values() if not row["completed"])
        kind = activity.content.get("practice_kind", activity.kind)
        columns.append(
            {
                "chapter_id": activity.chapter_id,
                "chapter_order": chapter_order.get(activity.chapter_id, 0),
                "kind": kind,
                "required": True if activity.kind == "assessment" else activity.content.get("required", True),
                "material_titles": {},
                "id": activity.id,
                "title": activity.title,
                "chapter": chapter_title,
                "opened": opened,
                "initial_total": _initial_practice_total(activity, fixed_counts.get(activity.id, 0)),
                "results": results,
                "completed": completed_count,
                "in_progress": in_progress_count,
            }
        )
    columns.sort(key=lambda row: chapter_order.get(row["chapter_id"], 0))
    return {
        "total_chapters": len(chapter_rows),
        "open_chapters": open_chapter_count,
        "activities": columns,
        "students": [
            {"id": s.id, "name": s.name, "student_id": s.student_id, "enrolled": s.id in roster}
            for s in students
        ],
    }
