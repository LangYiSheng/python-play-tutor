"""Course package HTTP routes and authenticated dependencies."""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import require_teacher
from app.course_packages.contracts import ApplyInput, AvailablePackageInput, CreateFromPackageInput
from app.course_packages.service import create_from_package
from app.course_packages.service import apply_course as _apply_course
from app.course_packages.service import available_packages as _available_packages
from app.course_packages.service import export_course as _export_course
from app.course_packages.service import preview_available_course as _preview_available_course
from app.db import get_db
from app.models import User

router = APIRouter(prefix="/teacher/courses/{course_id}", tags=["course-packages"])
shared_router = APIRouter(prefix="/teacher/course/packages", tags=["course-packages"])


@shared_router.get("")
def shared_packages(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]):
    return _available_packages(course_id=None, db=db, user=user)


@shared_router.post("/create-course", status_code=201)
def create_course_from_package(body: CreateFromPackageInput, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]):
    return create_from_package(body, db, user)


@shared_router.delete("/{package_key}")
def delete_shared_package(package_key: str, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]):
    from app.course_packages.exports import delete_export

    return delete_export(None, package_key, db, user)


@router.get("/export")
def export_course(course_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]):
    return _export_course(course_id=course_id, db=db, user=user)


@router.get("/packages")
def available_packages(course_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]):
    return _available_packages(course_id=course_id, db=db, user=user)


@router.post("/imports/available/preview")
def preview_available_course(
    course_id: int, body: AvailablePackageInput, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]
):
    return _preview_available_course(course_id=course_id, body=body, db=db, user=user)


@router.post("/imports/{preview_id}/apply")
def apply_course(
    course_id: int, preview_id: str, body: ApplyInput, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]
):
    return _apply_course(course_id=course_id, preview_id=preview_id, body=body, db=db, user=user)


@router.delete("/packages/{package_key}")
def delete_exported_package(
    course_id: int, package_key: str, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]
):
    from app.course_packages.exports import delete_export

    return delete_export(course_id, package_key, db, user)
