"""Site-wide staff and student accounts and read-only teaching oversight."""
from collections import defaultdict
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import hash_password, require_admin
from .account_deletion import delete_account_data, owned_classroom_ids
from .course_scope import lock_course_content
from .db import get_db
from .judge_management import python_submission
from .models import (AuthSession, Classroom, CourseInstance, Material, Membership, Question,
                     Submission, TownPreviewStudent, User)
from .narration.management import run_state
from .narration.models import NarrationRun
from .password_policy import MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH
from .student_accounts import AccountNameInput, StudentInput, new_student_account, reset_account_password

router = APIRouter(prefix="/admin", tags=["site-management"], dependencies=[Depends(require_admin)])
Database = Annotated[Session, Depends(get_db)]


class ResetInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: SecretStr | None = Field(default=None, min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH)


class TeacherInput(StudentInput, ResetInput):
    pass


class AccountStatusInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    disabled: bool


@router.get("/accounts")
def list_accounts(role: Literal["teacher", "student"], db: Database, q: str = Query(default="", max_length=100),
                  classroom_id: int | None = Query(default=None, ge=1), page: int = Query(default=1, ge=1), size: int = Query(default=25, ge=1, le=100)):
    staff = role == "teacher"
    query = select(User).where(User.role.in_(("admin", "teacher")) if staff else
        (User.role == "student") & User.id.not_in(select(TownPreviewStudent.student_user_id)))
    if classroom_id is not None:
        visible_class = select(Classroom.id).where(Classroom.id == classroom_id, Classroom.status != "deleted")
        if staff:
            query = query.where(User.id.in_(select(CourseInstance.teacher_id).join(Classroom).where(Classroom.id.in_(visible_class))))
        else:
            query = query.where(User.id.in_(select(Membership.user_id).where(Membership.classroom_id.in_(visible_class))))
    if q.strip():
        query = query.where(or_(User.student_id.contains(q.strip(), autoescape=True),
                                User.name.contains(q.strip(), autoescape=True)))
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    accounts = db.scalars(query.order_by(User.student_id, User.id).limit(size).offset((page - 1) * size)).all()
    ids = [user.id for user in accounts]
    if staff:
        classes = select(CourseInstance.teacher_id, Classroom.id, Classroom.name, Classroom.status).join(Classroom).where(CourseInstance.teacher_id.in_(ids))
    else:
        classes = (select(Membership.user_id, Classroom.id, Classroom.name, Classroom.status)
                   .join(Classroom, Membership.classroom_id == Classroom.id).where(Membership.user_id.in_(ids)))
    by_user = defaultdict(list)
    for user_id, key, name, status in db.execute(classes.where(Classroom.status != "deleted").order_by(Classroom.name, Classroom.id)):
        by_user[user_id].append({"id": key, "name": name, "status": status})
    return {"total": total, "items": [
        {"id": user.id, "role": user.role, "student_id": user.student_id, "name": user.name,
         "must_change_password": user.must_change_password, "disabled": user.disabled,
         "classrooms": by_user[user.id]} for user in accounts]}


@router.post("/teachers", status_code=201)
def create_teacher(body: TeacherInput, db: Database):
    password = body.password.get_secret_value() if body.password else body.student_id
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(422, f"工号不足{MIN_PASSWORD_LENGTH}位，请设置初始密码")
    user = User(student_id=body.student_id, name=body.name, role="teacher", must_change_password=True,
                password_hash=hash_password(password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "该工号已被使用") from exc
    return {"id": user.id, "name": user.name, "student_id": user.student_id}


@router.post("/students", status_code=201)
def create_student(body: StudentInput, db: Database):
    if len(body.student_id) < MIN_PASSWORD_LENGTH:
        raise HTTPException(422, f"新生学号至少须有{MIN_PASSWORD_LENGTH}位，用于设置初始密码")
    user = new_student_account(body.student_id, body.name)
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "该学号已被使用") from exc
    return {"id": user.id, "name": user.name, "student_id": user.student_id}


def managed_account(db, user_id, *, lock=True):
    query = select(User).where(User.id == user_id).execution_options(populate_existing=True)
    account = db.scalar(query.with_for_update() if lock else query)
    if not account or db.get(TownPreviewStudent, user_id):
        raise HTTPException(404, "账号不可用")
    if account.role not in {"student", "teacher"}:
        raise HTTPException(403, "只能管理教师和学生账号")
    return account


@router.post("/accounts/{user_id}/reset-password")
def reset_password(user_id: int, body: ResetInput, db: Database):
    account = managed_account(db, user_id)
    if not account.student_id:
        raise HTTPException(422, "请先分配登录账号")
    if account.role == "teacher" and body.password is None:
        raise HTTPException(422, "请设置教师的临时密码")
    reset_account_password(db, account, body.password.get_secret_value() if body.password else account.student_id)
    db.commit()
    return {"ok": True}


@router.put("/accounts/{user_id}/name")
def rename_account(user_id: int, body: AccountNameInput, db: Database):
    account = managed_account(db, user_id)
    account.name = body.name
    db.commit()
    return {"ok": True}


@router.put("/accounts/{user_id}/status")
def set_account_status(user_id: int, body: AccountStatusInput, db: Database):
    account = managed_account(db, user_id)
    account.disabled = body.disabled
    if body.disabled:
        db.execute(delete(AuthSession).where(AuthSession.user_id == account.id))
    db.commit()
    return {"ok": True}


@router.delete("/accounts/{user_id}", status_code=204)
def delete_account(user_id: int, db: Database):
    account = managed_account(db, user_id, lock=False)
    classrooms = owned_classroom_ids(db, user_id) if account.role == "teacher" else []
    owned = select(CourseInstance.id).where(CourseInstance.teacher_id == user_id).order_by(CourseInstance.id)
    course_ids = list(db.scalars(owned))
    for course_id in course_ids:
        lock_course_content(db, course_id, exclusive=True)
    account = managed_account(db, user_id)
    if account.role == "teacher" and (owned_classroom_ids(db, user_id) != classrooms or list(db.scalars(owned)) != course_ids):
        raise HTTPException(409, "负责班级已变化，请刷新后重新确认")
    try:
        delete_account_data(db, account, classrooms)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "账号仍被其他数据引用，未删除任何记录") from exc


@router.get("/overview")
def overview(db: Database, teacher_id: int | None = None, classroom_id: int | None = None):
    query = select(Classroom, User.name).select_from(Classroom).join(CourseInstance).join(User, CourseInstance.teacher_id == User.id).where(Classroom.status == "active")
    if teacher_id is not None:
        query = query.where(CourseInstance.teacher_id == teacher_id)
    if classroom_id is not None:
        query = query.where(Classroom.id == classroom_id)
    rows = {c.id: {"classroom_id": c.id, "classroom_name": c.name, "teacher_id": c.teacher_id,
                   "teacher_name": name, "student_count": 0, "task_total": 0, "task_completed": 0,
                   "synthesis_counts": {}, "judge_counts": {}}
            for c, name in db.execute(query.order_by(Classroom.id))}
    previews = select(TownPreviewStudent.student_user_id)
    from .chapter_tasks.service import chapter_state, open_chapters

    members = db.execute(select(Membership.classroom_id, User).join(User, Membership.user_id == User.id)
                         .where(Membership.classroom_id.in_(rows), User.role == "student", User.id.not_in(previews)))
    chapters_by_room = {key: open_chapters(db, db.get(Classroom, key)) for key in rows}
    for key, student in members:
        room = db.get(Classroom, key)
        rows[key]["student_count"] += 1
        for chapter in chapters_by_room[key]:
            tasks = chapter_state(db, student, room, chapter)["tasks"]
            rows[key]["task_total"] += sum(t["required"] for t in tasks)
            rows[key]["task_completed"] += sum(t["required"] and t["completed"] for t in tasks)
    state = run_state()
    synthesis = (select(Classroom.id, state, func.count()).select_from(NarrationRun)
                 .join(Material, Material.id == NarrationRun.material_id)
                 .join(CourseInstance, Material.course_instance_id == CourseInstance.id)
                 .join(Classroom, Classroom.course_id == CourseInstance.id)
                 .where(Classroom.id.in_(rows)).group_by(Classroom.id, state)
                 .execution_options(include_deleted=True))
    for key, status, count in db.execute(synthesis):
        rows[key]["synthesis_counts"][status] = count
    submissions = (select(Submission.classroom_id, Submission.status, func.count())
                   .join(Question, Question.id == Submission.question_id)
                   .where(Submission.classroom_id.in_(rows), Submission.user_id.not_in(previews), python_submission())
                   .group_by(Submission.classroom_id, Submission.status).execution_options(include_deleted=True))
    for key, status, count in db.execute(submissions):
        rows[key]["judge_counts"][status] = count
    return {"items": list(rows.values())}
