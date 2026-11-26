"""Material upload and delivery HTTP routes."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from sqlalchemy.orm import Session

from app.auth import current_user, require_teacher
from app.db import get_db
from app.materials.batch_upload import upload_materials_batch as _upload_materials_batch
from app.materials.contracts import MaterialUpdate
from app.materials.delivery import material_file as _material_file
from app.materials.delivery import teacher_material_file as _teacher_material_file
from app.materials.service import delete_material as _delete_material
from app.materials.service import retry_material as _retry_material
from app.materials.service import teacher_material_preview as _teacher_material_preview
from app.materials.service import teacher_materials as _teacher_materials
from app.materials.service import material_page
from app.materials.service import update_material as _update_material
from app.materials.service import upload_material as _upload_material
from app.models import User

router = APIRouter(tags=["materials"])


@router.post("/teacher/materials/upload", status_code=201)
async def upload_material(
    user: Annotated[User, Depends(require_teacher)],
    db: Annotated[Session, Depends(get_db)],
    title: Annotated[str, Form()],
    file: Annotated[UploadFile, File()],
    material_id: Annotated[int | None, Form()] = None,
    chapter_ids: Annotated[str | None, Form()] = None,
    auto_create_chapter: Annotated[bool | None, Form()] = None,
    classroom_id: int | None = None,
):
    return await _upload_material(
        user=user,
        db=db,
        title=title,
        file=file,
        material_id=material_id,
        chapter_ids=chapter_ids,
        auto_create_chapter=auto_create_chapter,
        classroom_id=classroom_id,
    )


@router.post("/teacher/materials/upload-batch", status_code=201)
async def upload_materials_batch(
    user: Annotated[User, Depends(require_teacher)],
    db: Annotated[Session, Depends(get_db)],
    files: Annotated[list[UploadFile], File()],
    chapter_ids: Annotated[str | None, Form()] = None,
    auto_create_chapter: Annotated[bool | None, Form()] = None,
    classroom_id: int | None = None,
):
    return await _upload_materials_batch(
        user=user,
        db=db,
        files=files,
        chapter_ids=chapter_ids,
        auto_create_chapter=auto_create_chapter,
        classroom_id=classroom_id,
    )


@router.get("/teacher/materials")
def teacher_materials(user: Annotated[User, Depends(require_teacher)], db: Annotated[Session, Depends(get_db)], classroom_id: int | None = None,
                      page: int | None = Query(None, ge=1), size: int = Query(10, ge=1, le=100), search: str = "",
                      kind: str | None = None, status: str | None = None):
    if page is not None:
        return material_page(db, user, classroom_id, page, size, search, kind, status)
    return _teacher_materials(user=user, db=db, classroom_id=classroom_id)


@router.get("/teacher/materials/{material_id}")
def teacher_material_preview(
    material_id: int, user: Annotated[User, Depends(require_teacher)], db: Annotated[Session, Depends(get_db)], classroom_id: int | None = None
):
    return _teacher_material_preview(material_id=material_id, user=user, db=db, classroom_id=classroom_id)


@router.put("/teacher/materials/{material_id}")
def update_material(
    material_id: int,
    body: MaterialUpdate,
    user: Annotated[User, Depends(require_teacher)],
    db: Annotated[Session, Depends(get_db)],
    classroom_id: int | None = None,
):
    return _update_material(material_id=material_id, body=body, user=user, db=db, classroom_id=classroom_id)


@router.delete("/teacher/materials/{material_id}")
def delete_material(
    material_id: int, user: Annotated[User, Depends(require_teacher)], db: Annotated[Session, Depends(get_db)], classroom_id: int | None = None
):
    return _delete_material(material_id=material_id, user=user, db=db, classroom_id=classroom_id)


@router.post("/teacher/materials/{material_id}/retry")
def retry_material(
    material_id: int, user: Annotated[User, Depends(require_teacher)], db: Annotated[Session, Depends(get_db)], classroom_id: int | None = None
):
    return _retry_material(material_id=material_id, user=user, db=db, classroom_id=classroom_id)


@router.get("/materials/{material_id}/file")
def material_file(
    material_id: int,
    classroom_id: int,
    request: Request,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    return _material_file(material_id=material_id, classroom_id=classroom_id, request=request, user=user, db=db)


@router.get("/teacher/materials/{material_id}/file")
def teacher_material_file(
    material_id: int,
    request: Request,
    user: Annotated[User, Depends(require_teacher)],
    db: Annotated[Session, Depends(get_db)],
    classroom_id: int | None = None,
):
    return _teacher_material_file(material_id=material_id, request=request, user=user, db=db, classroom_id=classroom_id)
