"""Explicit course ownership for teacher content operations."""

from uuid import uuid4, uuid5, NAMESPACE_URL

from fastapi import HTTPException
from sqlalchemy import update

from .models import CourseInstance
from .course_scope import lock_course_content


def own_course(db, user, course_id, *, exclusive=False):
    lock_course_content(db, course_id, exclusive=exclusive)
    course = db.get(CourseInstance, course_id, populate_existing=True)
    if course is None:
        raise HTTPException(404, "课程不存在")
    if user.role != "admin" and course.teacher_id != user.id:
        raise HTTPException(403, "只能管理自己的课程")
    return course


def teacher_instance_id(db, user, course_id, *, exclusive=False):
    return own_course(db, user, course_id, exclusive=exclusive).id


def require_scope(item, instance_id):
    if item is None or getattr(item, "deleted_at", None) is not None or item.course_instance_id != instance_id:
        raise HTTPException(404, "内容不属于当前课程")
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
