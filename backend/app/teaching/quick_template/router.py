from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import require_teacher
from app.db import get_db
from app.models import User
from app.teaching.quick_template import service
from app.teaching.quick_template.contracts import ApplyInput, PreviewInput


router = APIRouter(prefix="/teacher/classrooms/{classroom_id}/quick-orchestration", tags=["course-authoring"])
Database = Annotated[Session, Depends(get_db)]
Teacher = Annotated[User, Depends(require_teacher)]


@router.get("")
def get_editor(classroom_id: int, db: Database, user: Teacher):
    return service.get_editor(db, user, classroom_id)


@router.post("/preview")
def preview(classroom_id: int, body: PreviewInput, db: Database, user: Teacher):
    return service.preview(db, user, classroom_id, body)


@router.post("/apply")
def apply(classroom_id: int, body: ApplyInput, db: Database, user: Teacher):
    return service.apply(db, user, classroom_id, body)
