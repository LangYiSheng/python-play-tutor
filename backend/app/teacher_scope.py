"""Explicit classroom ownership for teacher content operations."""

from uuid import uuid4, uuid5, NAMESPACE_URL

from fastapi import HTTPException
from sqlalchemy import select, update

from .models import CourseInstance
from .classrooms.access import own_classroom


def teacher_course_scope(db, user, classroom_id, *, exclusive=False):
    if classroom_id is None:
        raise HTTPException(422, "请明确选择班级课程")
    classroom = own_classroom(db, user, classroom_id, exclusive=exclusive)
    instance = db.scalar(select(CourseInstance).where(CourseInstance.classroom_id == classroom_id))
    if instance is None:
        raise HTTPException(409, "本班尚未导入课程")
    return classroom, instance.id


def teacher_instance_id(db, user, classroom_id, *, exclusive=False):
    return teacher_course_scope(db, user, classroom_id, exclusive=exclusive)[1]


def require_scope(item, instance_id):
    if item is None or getattr(item, "deleted_at", None) is not None or item.course_instance_id != instance_id:
        raise HTTPException(404, "内容不属于当前班级课程")
    return item


def scoped_key(instance_id, kind, stable_id):
    if instance_id is None:
        return stable_id
    return f"c{instance_id}-{kind}-{uuid5(NAMESPACE_URL, str(stable_id)).hex}"


def new_stable_id():
    return uuid4().hex


def commit_content(db, instance_id):
    if instance_id is not None:
        db.execute(update(CourseInstance).where(CourseInstance.id == instance_id).values(revision=CourseInstance.revision + 1))
    db.commit()
