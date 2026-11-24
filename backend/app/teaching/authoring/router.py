"""Teaching editor HTTP routes and authenticated dependencies."""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import require_teacher
from app.db import get_db
from app.models import User
from app.teaching.authoring.contracts import AuthoringInput, PreviewInput, PublishInput
from app.teaching.authoring.service import get_authoring as _get_authoring
from app.teaching.authoring.service import preview_authoring as _preview_authoring
from app.teaching.authoring.service import save_authoring as _save_authoring
from app.teaching.authoring.service import validate_authoring as _validate_authoring

router = APIRouter(prefix="/teacher/courses/{course_id}/authoring", tags=["course-authoring"])


@router.get("")
def get_authoring(course_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]):
    return _get_authoring(course_id=course_id, db=db, user=user)


@router.post("/validate")
def validate_authoring(
    course_id: int, body: AuthoringInput, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]
):
    return _validate_authoring(course_id=course_id, body=body, db=db, user=user)


@router.put("")
def save_authoring(course_id: int, body: PublishInput, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]):
    return _save_authoring(course_id=course_id, body=body, db=db, user=user)


@router.post("/preview")
def preview_authoring(
    course_id: int, body: PreviewInput, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]
):
    return _preview_authoring(course_id=course_id, body=body, db=db, user=user)
