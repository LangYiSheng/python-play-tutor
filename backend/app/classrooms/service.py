"""Manage classrooms, memberships and isolated teacher preview identities."""

import secrets

from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import hash_password, issue, preview_classroom, token_hash
from app.classrooms.access import classroom_payload, own_classroom
from app.classrooms.contracts import ClassroomInput, JoinInput
from app.course_scope import lock_course
from app.models import Classroom, CourseInstance, Membership, TownPreviewStudent, User
from app.teacher_scope import own_course


def list_classrooms(db: Session, user: User):
    query = (
        select(Classroom, User.name, CourseInstance.name)
        .select_from(Classroom).join(CourseInstance, CourseInstance.id == Classroom.course_id)
        .join(User, User.id == CourseInstance.teacher_id)
        .where(Classroom.status == "active")
    )
    preview = db.get(TownPreviewStudent, user.id)
    if preview:
        classroom = preview_classroom(db, preview)
        query = query.where(Classroom.id == classroom.id)
    elif user.role == "teacher":
        query = query.where(CourseInstance.teacher_id == user.id)
    elif user.role != "admin":
        memberships = select(Membership.classroom_id).where(Membership.user_id == user.id)
        query = query.where(Classroom.id.in_(memberships))
    return [{**classroom_payload(item, user, name), "course_name": course_name} for item, name, course_name in db.execute(query)]


def create_classroom(course_id: int, body: ClassroomInput, db: Session, user: User):
    course = own_course(db, user, course_id, exclusive=True)
    user = db.scalar(select(User).where(User.id == user.id).with_for_update().execution_options(populate_existing=True))
    if not user or user.disabled:
        raise HTTPException(401, "账号不可用")
    item = Classroom(name=body.name.strip(), course_id=course.id, join_code=secrets.token_urlsafe(9))
    db.add(item)
    db.commit()
    return classroom_payload(item, user, db.get(User, course.teacher_id).name)


def open_town_session(classroom_id: int, db: Session, user: User, credentials: HTTPAuthorizationCredentials):
    own_classroom(db, user, classroom_id, exclusive=True)
    preview = db.scalar(
        select(TownPreviewStudent).where(
            TownPreviewStudent.teacher_id == user.id,
            TownPreviewStudent.classroom_id == classroom_id,
        )
    )
    if preview:
        student = db.get(User, preview.student_user_id)
        if not student or student.role != "student" or student.must_change_password:
            raise HTTPException(409, "本班的体验学生账号不可用")
    else:
        student = User(
            student_id=f"{secrets.randbelow(10**32):032d}",
            name="教师体验学生",
            role="student",
            password_hash=hash_password(secrets.token_urlsafe(32)),
        )
        db.add(student)
        db.flush()
        db.add(TownPreviewStudent(student_user_id=student.id, teacher_id=user.id, classroom_id=classroom_id))
    return issue(db, student, preview_teacher_token_hash=token_hash(credentials.credentials))


def join_classroom(body: JoinInput, db: Session, user: User):
    if user.role != "student" or db.get(TownPreviewStudent, user.id):
        raise HTTPException(403, "只有正式学生可以通过加入码加入班级")
    classroom = db.scalar(select(Classroom).where(Classroom.join_code == body.join_code.strip()))
    if not classroom:
        raise HTTPException(404, "加入码无效")
    classroom_id = classroom.id
    lock_course(db, classroom_id, exclusive=True)
    classroom = db.get(Classroom, classroom_id, populate_existing=True)
    if not classroom or classroom.status != "active":
        raise HTTPException(404, "加入码无效")
    if db.scalar(other_class_members(classroom).where(Membership.user_id == user.id).limit(1)):
        raise HTTPException(409, "已加入本课程的其他在教班级")
    if not db.get(Membership, (user.id, classroom.id)):
        db.add(Membership(user_id=user.id, classroom_id=classroom.id))
        db.commit()
    teacher = db.get(User, classroom.teacher_id)
    return classroom_payload(classroom, user, teacher.name if teacher else None)


def remove_member(classroom_id: int, student_id: int, db: Session, user: User):
    own_classroom(db, user, classroom_id)
    item = db.get(Membership, (student_id, classroom_id))
    if item:
        db.delete(item)
        db.commit()
    return {"ok": True}


def other_class_members(classroom):
    return select(Membership.user_id).join(Classroom, Classroom.id == Membership.classroom_id).where(
        Classroom.course_id == classroom.course_id, Classroom.id != classroom.id, Classroom.status == "active"
    )
