"""Manage independently owned courses and their teaching classes."""
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth import require_teacher
from .db import get_db
from .models import CourseInstance, User
from .teacher_scope import own_course
from .classrooms.lifecycle import management_list
from .course_instances import content_mapping

router = APIRouter(prefix="/teacher/courses", tags=["courses"])
Db = Annotated[Session, Depends(get_db)]
Teacher = Annotated[User, Depends(require_teacher)]


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


@router.get("/{course_id}/classrooms")
def classrooms(course_id: int, db: Db, user: Teacher, deleted: bool = False):
    own_course(db, user, course_id)
    return management_list(db, user, deleted, course_id)


@router.get("/{course_id}/ids")
def course_ids(course_id: int, db: Db, user: Teacher):
    return content_mapping(db, own_course(db, user, course_id))
