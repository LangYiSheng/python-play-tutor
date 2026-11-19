"""Classroom and member HTTP routes and authenticated dependencies."""

from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.orm import Session

from app.auth import bearer, current_user, require_teacher
from app.classrooms import lifecycle
from app.classrooms.contracts import ClassroomInput, JoinInput, TransferInput
from app.classrooms.service import create_classroom as _create_classroom
from app.classrooms.service import join_classroom as _join_classroom
from app.classrooms.service import list_classrooms as _list_classrooms
from app.classrooms.service import open_town_session as _open_town_session
from app.classrooms.service import remove_member as _remove_member
from app.db import get_db
from app.models import User

router = APIRouter(tags=["classrooms"])
Database = Annotated[Session, Depends(get_db)]
Teacher = Annotated[User, Depends(require_teacher)]


@router.get("/teacher/classrooms/management")
def manage_classrooms(db: Database, user: Teacher, deleted: bool = False):
    return lifecycle.management_list(db, user, deleted)


@router.patch("/teacher/classrooms/{classroom_id}")
def rename_classroom(classroom_id: int, body: ClassroomInput, db: Database, user: Teacher):
    return lifecycle.rename(db, user, classroom_id, body.name)


@router.post("/teacher/classrooms/{classroom_id}/archive")
def archive_classroom(classroom_id: int, db: Database, user: Teacher):
    return lifecycle.archive(db, user, classroom_id)


@router.delete("/teacher/classrooms/{classroom_id}")
def delete_classroom(classroom_id: int, db: Database, user: Teacher):
    return lifecycle.delete_classroom(db, user, classroom_id)


@router.post("/teacher/classrooms/{classroom_id}/transfer")
def transfer_classroom(classroom_id: int, body: TransferInput, db: Database, user: Teacher):
    return lifecycle.transfer(db, user, classroom_id, body.teacher_id)


@router.get("/teacher/classrooms/{classroom_id}/history")
def classroom_history(classroom_id: int, db: Database, user: Teacher):
    return lifecycle.history_summary(db, user, classroom_id)


@router.get("/teacher/classrooms/{classroom_id}/history/{student_id}")
def classroom_student_history(classroom_id: int, student_id: int, db: Database, user: Teacher):
    return lifecycle.history_detail(db, user, classroom_id, student_id)


@router.get("/classrooms")
def list_classrooms(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(current_user)]):
    return _list_classrooms(db=db, user=user)


@router.post("/classrooms", status_code=201)
def create_classroom(body: ClassroomInput, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]):
    return _create_classroom(body=body, db=db, user=user)


@router.post("/teacher/classrooms/{classroom_id}/town-session")
def open_town_session(
    classroom_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_teacher)],
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
):
    # Serialize initial creation against another launch of this classroom.
    return _open_town_session(classroom_id=classroom_id, db=db, user=user, credentials=credentials)


@router.post("/classrooms/join")
def join_classroom(body: JoinInput, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(current_user)]):
    return _join_classroom(body=body, db=db, user=user)


@router.delete("/teacher/classrooms/{classroom_id}/members/{student_id}")
def remove_member(classroom_id: int, student_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]):
    return _remove_member(classroom_id=classroom_id, student_id=student_id, db=db, user=user)
