"""Class management and immutable access to retained learner history."""

from fastapi import HTTPException
from sqlalchemy import delete, func, select, union_all, update

from app.course_instances import CONTENT_MODELS, classroom_course
from app.integration_models import AssistantSession
from app.models import (
    Activity, ActivityProgress, AssessmentAttempt, BuildingUnlock, Classroom, LearningEvent, LearningRecord,
    Membership, PlayerPosition, PlayerQuest, PracticeSession, StorySession, Submission, TownPreviewStudent, User, WorldFlag,
)
from app.classrooms.access import classroom_payload, own_classroom

# A removed membership does not remove the learner's evidence. Teacher experience saves
# remain intact, but never count as evidence of a formal student's participation.
HISTORY_MODELS = (
    PlayerQuest, StorySession, ActivityProgress, LearningEvent, LearningRecord, Submission,
    PracticeSession, AssessmentAttempt, AssistantSession, WorldFlag, PlayerPosition, BuildingUnlock,
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


def management_list(db, user, deleted):
    query = select(Classroom, User.name).join(User, User.id == Classroom.teacher_id)
    query = query.where(Classroom.status == "deleted" if deleted else Classroom.status != "deleted")
    if user.role != "admin":
        query = query.where(Classroom.teacher_id == user.id)
    counts = (select(func.count()).select_from(Membership).join(User, User.id == Membership.user_id)
              .where(Membership.classroom_id == Classroom.id, User.role == "student")
              .correlate(Classroom).scalar_subquery())
    history = history_rows()
    has_records = select(history.c.classroom_id).where(history.c.classroom_id == Classroom.id).exists()
    return [
        {**classroom_payload(item, user, name), "status": item.status, "student_count": count, "has_learning_records": has_history}
        for item, name, count, has_history in db.execute(query.add_columns(counts, has_records).order_by(Classroom.id))
    ]


def rename(db, user, classroom_id, name):
    item = managed_class(db, user, classroom_id, exclusive=True)
    if item.status != "active":
        raise HTTPException(409, "只有使用中的班级可以改名")
    item.name = name
    db.commit()
    return {"ok": True}


def transfer(db, user, classroom_id, teacher_id):
    if user.role != "admin":
        raise HTTPException(403, "只有管理员可以转交班级")
    item = managed_class(db, user, classroom_id, exclusive=True)
    target = db.scalar(select(User).where(User.id == teacher_id).with_for_update().execution_options(populate_existing=True))
    if not target or target.disabled or target.role not in {"admin", "teacher"}:
        raise HTTPException(422, "请选择有效的任课教师")
    if item.teacher_id != target.id:
        instance = classroom_course(db, classroom_id)
        if instance:
            for model in CONTENT_MODELS:
                if hasattr(model, "owner_id"):
                    db.execute(update(model).where(model.course_instance_id == instance.id, model.owner_id.is_not(None)).values(owner_id=target.id))
            instance.revision += 1
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
    from app.assessments import assessment_payload

    payload = record_payload(classroom_id, student_id, db)
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
    return {**payload, "assessments": assessments}
