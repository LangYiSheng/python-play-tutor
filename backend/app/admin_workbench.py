"""Site-wide staff and student accounts and read-only teaching oversight."""
from collections import defaultdict
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import hash_password, require_admin
from .db import get_db
from .judge_management import python_submission
from .models import (Classroom, CourseInstance, Material, Membership, PlayerQuest, Question,
                     Submission, TownPreviewStudent, User)
from .narration.management import run_state
from .narration.models import NarrationRun
from .student_accounts import StudentInput, reset_account_password

router = APIRouter(prefix="/admin", tags=["site-management"], dependencies=[Depends(require_admin)])
Database = Annotated[Session, Depends(get_db)]


class TeacherInput(StudentInput):
    password: SecretStr = Field(min_length=12, max_length=200)


class ResetInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: SecretStr | None = Field(default=None, min_length=12, max_length=200)


@router.get("/accounts")
def list_accounts(role: Literal["teacher", "student"], db: Database, q: str = Query(default="", max_length=100),
                  page: int = Query(default=1, ge=1), size: int = Query(default=25, ge=1, le=100)):
    staff = role == "teacher"
    query = select(User).where(User.role.in_(("admin", "teacher")) if staff else
        (User.role == "student") & User.id.not_in(select(TownPreviewStudent.student_user_id)))
    if q.strip():
        query = query.where(or_(User.student_id.contains(q.strip(), autoescape=True),
                                User.name.contains(q.strip(), autoescape=True)))
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    accounts = db.scalars(query.order_by(User.student_id, User.id).limit(size).offset((page - 1) * size)).all()
    ids = [user.id for user in accounts]
    if staff:
        classes = select(Classroom.teacher_id, Classroom.id, Classroom.name, Classroom.status).where(Classroom.teacher_id.in_(ids))
    else:
        classes = (select(Membership.user_id, Classroom.id, Classroom.name, Classroom.status)
                   .join(Classroom, Membership.classroom_id == Classroom.id).where(Membership.user_id.in_(ids)))
    by_user = defaultdict(list)
    for user_id, key, name, status in db.execute(classes.where(Classroom.status != "deleted").order_by(Classroom.name, Classroom.id)):
        by_user[user_id].append({"id": key, "name": name, "status": status})
    return {"total": total, "items": [
        {"id": user.id, "role": user.role, "student_id": user.student_id, "name": user.name,
         "must_change_password": user.must_change_password, "classrooms": by_user[user.id]} for user in accounts]}


@router.post("/teachers", status_code=201)
def create_teacher(body: TeacherInput, db: Database):
    user = User(student_id=body.student_id, name=body.name, role="teacher", must_change_password=True,
                password_hash=hash_password(body.password.get_secret_value()))
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "该学号已被使用") from exc
    return {"id": user.id, "name": user.name, "student_id": user.student_id}


@router.post("/accounts/{user_id}/reset-password")
def reset_password(user_id: int, body: ResetInput, db: Database):
    account = db.scalar(select(User).where(User.id == user_id).with_for_update())
    if not account or not account.student_id or db.get(TownPreviewStudent, user_id):
        raise HTTPException(404, "账号不可用")
    if account.role not in {"student", "teacher"}:
        raise HTTPException(403, "只能重置教师和学生密码")
    if account.role == "teacher" and body.password is None:
        raise HTTPException(422, "请设置教师的临时密码")
    reset_account_password(db, account, body.password.get_secret_value() if body.password else account.student_id)
    db.commit()
    return {"ok": True}


@router.get("/overview")
def overview(db: Database, teacher_id: int | None = None, classroom_id: int | None = None):
    query = select(Classroom, User.name).join(User, Classroom.teacher_id == User.id).where(Classroom.status == "active")
    if teacher_id is not None:
        query = query.where(Classroom.teacher_id == teacher_id)
    if classroom_id is not None:
        query = query.where(Classroom.id == classroom_id)
    rows = {c.id: {"classroom_id": c.id, "classroom_name": c.name, "teacher_id": c.teacher_id,
                   "teacher_name": name, "student_count": 0, "task_total": 0, "task_completed": 0,
                   "synthesis_counts": {}, "judge_counts": {}}
            for c, name in db.execute(query.order_by(Classroom.id))}
    previews = select(TownPreviewStudent.student_user_id)
    students = (select(Membership.classroom_id, func.count()).join(User, Membership.user_id == User.id)
                .where(Membership.classroom_id.in_(rows), User.role == "student", User.id.not_in(previews))
                .group_by(Membership.classroom_id))
    for key, count in db.execute(students):
        rows[key]["student_count"] = count
    quests = (select(PlayerQuest.classroom_id, PlayerQuest.status, func.count())
              .where(PlayerQuest.classroom_id.in_(rows), PlayerQuest.user_id.not_in(previews))
              .group_by(PlayerQuest.classroom_id, PlayerQuest.status))
    for key, status, count in db.execute(quests):
        rows[key]["task_total"] += count
        if status == "complete":
            rows[key]["task_completed"] = count
    state = run_state()
    synthesis = (select(CourseInstance.classroom_id, state, func.count()).select_from(NarrationRun)
                 .join(Material, Material.id == NarrationRun.material_id)
                 .join(CourseInstance, Material.course_instance_id == CourseInstance.id)
                 .where(CourseInstance.classroom_id.in_(rows)).group_by(CourseInstance.classroom_id, state)
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
