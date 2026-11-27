"""Class management and immutable access to retained learner history."""

from fastapi import HTTPException
from sqlalchemy import delete, func, select, union_all, update

from app.course_instances import CONTENT_MODELS
from app.integration_models import AssistantSession
from app.models import (
    ActivityProgress, AssessmentAttempt, Classroom, CourseInstance, LearningRecord,
    MaterialParticipation, Membership, PlayerPosition, PracticeSession, Submission, TownPreviewStudent, User,
)
from app.classrooms.access import classroom_payload, own_classroom

# A removed membership does not remove the learner's evidence. Teacher experience saves
# remain intact, but never count as evidence of a formal student's participation.
HISTORY_MODELS = (
    MaterialParticipation, ActivityProgress, LearningRecord, Submission,
    PracticeSession, AssessmentAttempt, AssistantSession, PlayerPosition,
)


def history_rows(classroom_id=None):
    queries = []
    previews = select(TownPreviewStudent.student_user_id)
    for model in HISTORY_MODELS:
        query = select(model.classroom_id, model.user_id).where(model.user_id.not_in(previews))
        if classroom_id is not None:
            query = query.where(model.classroom_id == classroom_id)
        queries.append(query)
    return union_all(*queries).subquery()


def managed_class(db, user, classroom_id, *, exclusive=False, include_deleted=False):
    statuses = ("active", "archived", "deleted") if include_deleted else ("active", "archived")
    return own_classroom(db, user, classroom_id, exclusive=exclusive, statuses=statuses)


def management_list(db, user, deleted, course_id=None):
    query = (
        select(Classroom, User.name, CourseInstance.name)
        .select_from(Classroom)
        .join(CourseInstance)
        .join(User, User.id == CourseInstance.teacher_id)
    )
    if course_id is not None:
        query = query.where(Classroom.course_id == course_id)
    query = query.where(Classroom.status == "deleted" if deleted else Classroom.status != "deleted")
    if user.role != "admin":
        query = query.where(CourseInstance.teacher_id == user.id)
    counts = (select(func.count()).select_from(Membership).join(User, User.id == Membership.user_id)
              .where(Membership.classroom_id == Classroom.id, User.role == "student")
              .correlate(Classroom).scalar_subquery())
    history = history_rows()
    has_records = select(history.c.classroom_id).where(history.c.classroom_id == Classroom.id).exists()
    return [
        {
            **classroom_payload(item, user, name),
            "course_name": course_name,
            "status": item.status,
            "student_count": count,
            "has_learning_records": has_history,
        }
        for item, name, course_name, count, has_history in db.execute(query.add_columns(counts, has_records).order_by(Classroom.id))
    ]


def rename(db, user, classroom_id, name):
    item = managed_class(db, user, classroom_id, exclusive=True)
    if item.status != "active":
        raise HTTPException(409, "只有使用中的班级可以改名")
    item.name = name
    db.commit()
    return {"ok": True}


def transfer(db, user, course_id, teacher_id):
    if user.role != "admin":
        raise HTTPException(403, "只有管理员可以转交课程")
    from app.teacher_scope import own_course
    item = own_course(db, user, course_id, exclusive=True)
    target = db.scalar(select(User).where(User.id == teacher_id).with_for_update().execution_options(populate_existing=True))
    if not target or target.disabled or target.role not in {"admin", "teacher"}:
        raise HTTPException(422, "请选择有效的任课教师")
    if item.teacher_id != target.id:
        for model in CONTENT_MODELS:
            if hasattr(model, "owner_id"):
                db.execute(update(model).where(model.course_instance_id == item.id, model.owner_id.is_not(None)).values(owner_id=target.id))
        item.revision += 1
        item.teacher_id = target.id
    db.commit()
    return {"ok": True}


def archive(db, user, classroom_id):
    item = managed_class(db, user, classroom_id, exclusive=True)
    item.status = "archived"
    db.commit()
    return {"ok": True}


def delete_classroom(db, user, classroom_id):
    item = managed_class(db, user, classroom_id, exclusive=True, include_deleted=True)
    if item.status != "deleted":
        if user.role != "admin" and db.scalar(select(select(history_rows(classroom_id).c.user_id).exists())):
            raise HTTPException(403, "有学习记录的班级只能归档，正式删除需要管理员权限")
        item.status = "deleted"
        db.execute(delete(Membership).where(Membership.classroom_id == classroom_id))
    db.commit()
    return {"ok": True}


def history_summary(db, user, classroom_id):
    managed_class(db, user, classroom_id, include_deleted=True)
    history = history_rows(classroom_id)
    query = select(User.id, User.student_id, User.name, func.count().label("records")).join(
        history, history.c.user_id == User.id
    ).group_by(User.id, User.student_id, User.name).order_by(User.student_id)
    return {"students": [dict(row) for row in db.execute(query).mappings()]}


def history_detail(db, user, classroom_id, student_id):
    from app.course_content.progress import record_payload

    managed_class(db, user, classroom_id, include_deleted=True)
    history = history_rows(classroom_id)
    if not db.scalar(select(select(history.c.user_id).where(history.c.user_id == student_id).exists())):
        raise HTTPException(404, "此学生在该班级没有历史记录")
    return record_payload(classroom_id, student_id, db)
