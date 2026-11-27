"""Manage independently owned courses and their teaching classes."""
from datetime import timedelta
from hashlib import sha256
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .account_deletion import delete_course_with_history
from .assistant_settings import configuration as assistant_configuration
from .auth import require_teacher
from .db import get_db
from .integration_models import AssistantCall
from .course_studio.jobs import has_active_course_jobs
from .course_studio.models import CourseStudioExam
from .models import (
    Activity, ActivityMaterial, ActivityQuestion, AssessmentAttempt, Chapter, Classroom, CourseInstance, KnowledgePoint, Material,
    MaterialChapter, MaterialParticipation, Membership, Question, QuestionChapter, QuestionKnowledgePoint, Submission,
    TownPreviewStudent, User, now,
)
from .narration.models import MaterialTagDict, NarrationJob
from .narration.repository import job_running
from .teacher_scope import own_course
from .classrooms.lifecycle import history_rows, management_list
from .course_instances import content_mapping

router = APIRouter(prefix="/teacher/courses", tags=["courses"])
Db = Annotated[Session, Depends(get_db)]
Teacher = Annotated[User, Depends(require_teacher)]
ACTIVE_SUBMISSION_STATUSES = ("dispatching", "queued", "running")


class Name(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=200)


class Rename(Name):
    expected_revision: int = Field(ge=1)


def instance_payload(course):
    return {key: getattr(course, key) for key in ("id", "teacher_id", "package_id", "name", "package_version", "revision")}


@router.get("")
def courses(db: Db, user: Teacher):
    query = select(CourseInstance, User.name).join(User, User.id == CourseInstance.teacher_id).order_by(CourseInstance.id)
    if user.role != "admin":
        query = query.where(CourseInstance.teacher_id == user.id)
    return [{**instance_payload(course), "teacher_name": teacher} for course, teacher in db.execute(query)]


@router.post("", status_code=201)
def create_course(body: Name, db: Db, user: Teacher):
    owner = db.scalar(select(User).where(User.id == user.id).with_for_update().execution_options(populate_existing=True))
    if not owner or owner.disabled:
        raise HTTPException(403, "账号已停用")
    course = CourseInstance(teacher_id=owner.id, name=body.name, package_id="course-" + uuid4().hex, package_version="1")
    db.add(course)
    db.commit()
    return instance_payload(course)


@router.get("/{course_id}")
def get_course(course_id: int, db: Db, user: Teacher):
    return instance_payload(own_course(db, user, course_id))


@router.patch("/{course_id}")
def rename_course(course_id: int, body: Rename, db: Db, user: Teacher):
    course = own_course(db, user, course_id, exclusive=True)
    if course.name == body.name:
        return instance_payload(course)
    if course.revision != body.expected_revision:
        raise HTTPException(409, "课程已更新，请刷新后重新修改名称")
    course.name = body.name
    course.revision += 1
    db.commit()
    return instance_payload(course)


def _course_rows(model, course_id):
    return select(model.id).where(model.course_instance_id == course_id).execution_options(include_deleted=True)


def _deletion_confirmation(course, user, classrooms, counts):
    # SQLite can reuse a deleted integer ID. Bind confirmation to this course's incarnation.
    values = (user.id, course.id, course.revision, course.created_at.isoformat(), course.package_id, classrooms, sorted(counts.items()))
    return sha256(repr(values).encode()).hexdigest()


def _course_classrooms(db, course_id, *, for_update=False):
    query = select(Classroom.id, Classroom.name, Classroom.status).where(Classroom.course_id == course_id).order_by(Classroom.id)
    if for_update:
        query = query.with_for_update()
    return [tuple(row) for row in db.execute(query)]


def _deletion_impact(db, course_id, classroom_ids):
    counts = {"classrooms": len(classroom_ids)}
    for key, model in {
        "chapters": Chapter, "materials": Material, "knowledge_points": KnowledgePoint, "questions": Question,
        "activities": Activity, "exam_drafts": CourseStudioExam,
    }.items():
        counts[key] = db.scalar(select(func.count()).select_from(_course_rows(model, course_id).subquery()).execution_options(include_deleted=True))
    for key, model in {
        "reading_records": MaterialParticipation, "submissions": Submission, "assessment_attempts": AssessmentAttempt,
    }.items():
        counts[key] = db.scalar(select(func.count()).select_from(model).where(model.classroom_id.in_(classroom_ids)))
    history = history_rows()
    learned = select(history.c.user_id).where(history.c.classroom_id.in_(classroom_ids))
    members = select(Membership.user_id).where(Membership.classroom_id.in_(classroom_ids))
    learners = members.union(learned).subquery()
    previews = select(TownPreviewStudent.student_user_id)
    counts["students"] = db.scalar(
        select(func.count()).select_from(learners).join(User, User.id == learners.c.user_id)
        .where(User.role == "student", User.id.not_in(previews))
    )
    return counts


def _active_learning_task(db, classroom_ids):
    if not classroom_ids:
        return False
    judging = select(Submission.id).where(
        Submission.classroom_id.in_(classroom_ids), Submission.status.in_(ACTIVE_SUBMISSION_STATUSES),
    )
    if db.scalar(select(judging.exists())):
        return True
    timeout = assistant_configuration(db, include_key=False)["timeout_seconds"]
    active_since = now() - timedelta(seconds=timeout + 30)
    asking = select(AssistantCall.id).where(
        AssistantCall.classroom_id.in_(classroom_ids), AssistantCall.status.in_(("running", "cancel_requested")),
        AssistantCall.created_at >= active_since,
    )
    return bool(db.scalar(select(asking.exists())))


def _deletion_blocker(db, course_id, classroom_ids):
    if has_active_course_jobs(db, course_id):
        return "课程还有备课任务在处理，请等待任务结束后重试。"
    if _active_learning_task(db, classroom_ids):
        return "本课程仍有评测或助教任务在处理，请等待任务结束后重试。"
    materials = _course_rows(Material, course_id)
    chapters = _course_rows(Chapter, course_id)
    questions = _course_rows(Question, course_id)
    points = _course_rows(KnowledgePoint, course_id)
    activities = _course_rows(Activity, course_id)
    converting = select(Material.id).where(Material.course_instance_id == course_id, Material.status.in_(("queued", "processing")))
    jobs = select(NarrationJob).where(NarrationJob.material_id.in_(materials), NarrationJob.status == "running")
    if (db.scalar(select(converting.exists()).execution_options(include_deleted=True))
            or any(job_running(job) for job in db.scalars(jobs.execution_options(include_deleted=True)))):
        return "课程资料仍在处理，请等待任务结束后重试。"
    # Cascading or SET NULL foreign keys can otherwise change surviving content
    # or historical evidence if a course has inconsistent legacy links.
    retained_links = (
        select(Chapter.id).where(Chapter.prerequisite_chapter_id.in_(chapters), Chapter.course_instance_id.is_distinct_from(course_id)),
        select(MaterialChapter.material_id).where(
            or_(MaterialChapter.chapter_id.in_(chapters) & MaterialChapter.material_id.not_in(materials),
                MaterialChapter.material_id.in_(materials) & MaterialChapter.chapter_id.not_in(chapters))),
        select(QuestionChapter.question_id).where(
            or_(QuestionChapter.chapter_id.in_(chapters) & QuestionChapter.question_id.not_in(questions),
                QuestionChapter.question_id.in_(questions) & QuestionChapter.chapter_id.not_in(chapters))),
        select(QuestionKnowledgePoint.question_id).where(
            or_(QuestionKnowledgePoint.knowledge_point_id.in_(points) & QuestionKnowledgePoint.question_id.not_in(questions),
                QuestionKnowledgePoint.question_id.in_(questions) & QuestionKnowledgePoint.knowledge_point_id.not_in(points))),
        select(ActivityMaterial.activity_id).where(
            or_(ActivityMaterial.activity_id.in_(activities) & ActivityMaterial.material_id.not_in(materials),
                ActivityMaterial.material_id.in_(materials) & ActivityMaterial.activity_id.not_in(activities))),
        select(ActivityQuestion.activity_id).where(
            or_(ActivityQuestion.activity_id.in_(activities) & ActivityQuestion.question_id.not_in(questions),
                ActivityQuestion.question_id.in_(questions) & ActivityQuestion.activity_id.not_in(activities))),
        select(MaterialTagDict.id).where(MaterialTagDict.source_material_id.in_(materials), MaterialTagDict.course_instance_id != course_id),
        select(MaterialParticipation.user_id).where(
            or_(MaterialParticipation.chapter_id.in_(chapters), MaterialParticipation.material_id.in_(materials)),
            MaterialParticipation.classroom_id.not_in(classroom_ids),
        ),
    )
    if any(db.scalar(select(statement.exists()).execution_options(include_deleted=True)) for statement in retained_links):
        return "课程仍被其他课程或学习记录引用，无法删除。"
    return None


@router.get("/{course_id}/deletion-preview")
def deletion_preview(course_id: int, db: Db, user: Teacher):
    course = own_course(db, user, course_id)
    classrooms = _course_classrooms(db, course_id)
    classroom_ids = [row[0] for row in classrooms]
    counts = _deletion_impact(db, course_id, classroom_ids)
    blocked_reason = _deletion_blocker(db, course_id, classroom_ids)
    return {"name": course.name, "revision": course.revision, "confirmation": _deletion_confirmation(course, user, classrooms, counts),
            "can_delete": blocked_reason is None,
            "blocked_reason": blocked_reason, "counts": counts}


@router.delete("/{course_id}", status_code=204)
def delete_course(course_id: int, db: Db, user: Teacher, expected_revision: Annotated[int, Query(ge=1)],
                  confirmation: Annotated[str, Query(pattern=r"^[0-9a-f]{64}$")]):
    course = own_course(db, user, course_id, exclusive=True)
    classrooms = _course_classrooms(db, course_id, for_update=True)
    classroom_ids = [row[0] for row in classrooms]
    counts = _deletion_impact(db, course_id, classroom_ids)
    if course.revision != expected_revision or confirmation != _deletion_confirmation(course, user, classrooms, counts):
        raise HTTPException(409, "课程已更新，请刷新删除预览后重试。")
    # Fence narration acquisition and a judge claiming a prepared submission while deleting.
    db.scalars(_course_rows(Material, course_id).order_by(Material.id).with_for_update()).all()
    db.scalars(select(Submission.id).where(
        Submission.classroom_id.in_(classroom_ids), Submission.status.in_(("prepared", *ACTIVE_SUBMISSION_STATUSES)),
    ).order_by(Submission.id).with_for_update()).all()
    blocked_reason = _deletion_blocker(db, course_id, classroom_ids)
    if blocked_reason:
        raise HTTPException(409, blocked_reason)
    try:
        delete_course_with_history(db, course_id, classroom_ids)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "课程仍被其他数据引用，未删除任何记录。") from exc


@router.get("/{course_id}/classrooms")
def classrooms(course_id: int, db: Db, user: Teacher, deleted: bool = False):
    own_course(db, user, course_id)
    return management_list(db, user, deleted, course_id)


@router.get("/{course_id}/ids")
def course_ids(course_id: int, db: Db, user: Teacher):
    return content_mapping(db, own_course(db, user, course_id))
