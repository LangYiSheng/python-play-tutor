"""Delete shared exported packages without touching imported classroom content."""

from typing import TypedDict

from sqlalchemy.orm import Session

from app.course_packages.manifest import PackageError
from app.models import User


class DeleteResult(TypedDict):
    deleted: bool
    directory: str


def delete_export(course_id: int | None, package_key: str, db: Session, user: User) -> DeleteResult:
    from fastapi import HTTPException

    from app.course_packages.service import selected_package
    from app.course_exchange_models import CourseExport
    from app.course_packages.cleanup import exchange_guard, remove_scratch
    from app.course_packages.paths import exchange_root
    from app.teacher_scope import own_course

    if course_id is not None:
        own_course(db, user, course_id)
    root = exchange_root()
    with exchange_guard(root):
        try:
            item = selected_package(db, user, package_key)
            if not item["can_delete"]:
                raise HTTPException(403, "无权删除此课程包")
            # Reject every link/junction before removal; learner and import staging are separate.
            remove_scratch(root, item["path"])
            owner = db.get(CourseExport, item["directory"])
            if owner is not None:
                db.delete(owner)
                db.commit()
            return {"deleted": True, "directory": item["directory"]}
        except (OSError, PackageError) as exc:
            raise HTTPException(422, "课程包删除失败，请刷新列表后重试") from exc
