"""Coordinate authorized export, staged previews and idempotent course imports."""

import os
import re
import shutil
import tempfile
import time
from datetime import timedelta
from pathlib import Path
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth import as_utc
from app.teacher_scope import own_course
from app.course_exchange_models import CourseExport, CourseImportPreview
from app.models import CourseInstance
from app.course_packages.apply import import_bundle
from app.course_packages.cleanup import exchange_guard
from app.course_packages.contracts import LIMITS, ApplyInput, AvailablePackageInput, CreateFromPackageInput
from app.course_packages.impact import preview_impact
from app.course_packages.manifest import PackageError
from app.course_packages.paths import exchange_path, exchange_root
from app.course_packages.reader import load_bundle
from app.course_packages.writer import write_package
from app.course_scope import course_class_ids, lock_course_content
from app.integration_models import AssistantCall
from app.models import User, now


def _replace_staged(source, destination):
    # Windows scanners can briefly hold freshly validated media directories open.
    # Preserve atomic publication; never remove a destination or copy over it.
    for attempt in range(5):
        try:
            os.replace(source, destination)
            return
        except PermissionError as exc:
            if getattr(exc, "winerror", None) not in (5, 32, 33) or attempt == 4:
                raise
            time.sleep(0.05 * (attempt + 1))


def export_course(course_id: int, db: Session, user: User):
    with exchange_guard(exchange_root()):
        # Exclusive gate ensures one consistent export while blocking both edits and learner writes.
        lock_course_content(db, course_id, exclusive=True)
        instance = own_course(db, user, course_id)
        temporary = Path(tempfile.mkdtemp(prefix="course-export-", dir=exchange_root()))
        root = temporary / "package"
        root.mkdir()
        try:
            write_package(db, instance, root)
            load_bundle(root)
            name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", instance.name).strip(" .")[:48] or "课程"
            timestamp = now().astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y%m%d-%H%M%S")
            destination = exchange_path(f"export-{course_id}-{name}-{timestamp}-{uuid4().hex[:8]}")
            # Persist ownership before publishing the directory to catalog readers.
            db.add(CourseExport(directory=destination.name, exporter_id=user.id))
            db.commit()
            _replace_staged(root, destination)
            shutil.rmtree(temporary)
        except (PackageError, OSError, ValueError, SQLAlchemyError) as exc:
            db.rollback()
            shutil.rmtree(temporary, ignore_errors=True)
            raise HTTPException(422, str(exc) if isinstance(exc, PackageError) else "课程导出失败") from exc
        return {"directory": destination.name, "path": f"data/course/{destination.name}"}


def _save_preview(db, user, course_id, bundle, directory, digest):
    instance = db.get(CourseInstance, course_id)
    impact = preview_impact(db, instance, bundle)
    preview = CourseImportPreview(
        id=str(uuid4()),
        teacher_id=user.id,
        course_id=course_id,
        expected_revision=instance.revision if instance else 0,
        archive_sha256=digest,
        storage_key=f"imports/{uuid4().hex}",
        summary={
            **impact,
            "package_id": bundle["manifest"]["package_id"],
            "package_version": bundle["manifest"]["package_version"],
            "name": bundle["manifest"]["name"],
        },
        expires_at=now() + timedelta(hours=24),
    )
    _replace_staged(directory, exchange_path(preview.storage_key))
    db.add(preview)
    db.commit()
    return {
        "id": preview.id,
        "expected_revision": preview.expected_revision,
        "expires_at": preview.expires_at,
        "can_apply": not impact["blockers"],
        **preview.summary,
    }


def visible_packages(db, user):
    from app.course_packages.catalog import mounted_catalog

    mounted, unavailable = mounted_catalog(exchange_root(), LIMITS)
    owner_rows = db.execute(
        select(CourseExport.directory, CourseExport.exporter_id, User.name)
        .outerjoin(User, User.id == CourseExport.exporter_id)
        .where(CourseExport.directory.in_([item["directory"] for item in mounted]))
    ).all()
    owners = {directory: (exporter_id, exporter_name) for directory, exporter_id, exporter_name in owner_rows}
    visible = []
    for item in mounted:
        owner = owners.get(item["directory"])
        shared = owner is None
        mine = owner is not None and owner[0] == user.id
        if shared or mine or user.role == "admin":
            visible.append({
                **item,
                "mine": mine,
                "shared": shared,
                "exporter_name": owner[1] if owner else None,
                "protected": not item["can_delete"],
                "can_delete": item["can_delete"] and (mine or user.role == "admin"),
            })
    return visible, unavailable


def selected_package(db, user, key):
    items, _ = visible_packages(db, user)
    item = next((item for item in items if item["key"] == key), None)
    if item is None:
        raise HTTPException(404, "课程包已变化或不存在，请刷新列表")
    return item


def available_packages(course_id: int | None, db: Session, user: User):
    if course_id is not None:
        own_course(db, user, course_id)
    try:
        mounted, unavailable = visible_packages(db, user)
        items = [
            {
                **{key: item[key] for key in ("key", "name", "package_id", "package_version", "source", "directory", "created_at", "chapter_count", "question_count")},
                "can_delete": item["can_delete"], "protected": item["protected"],
                "mine": item["mine"], "shared": item["shared"],
            }
            for item in mounted
        ]
        return JSONResponse({"items": items, "unavailable": unavailable}, headers={"Cache-Control": "private, no-store"})
    except (PackageError, OSError) as exc:
        raise HTTPException(422, str(exc) if isinstance(exc, PackageError) else "无法读取可选课程包，请稍后刷新") from exc


def preview_available_course(course_id: int, body: AvailablePackageInput, db: Session, user: User):
    with exchange_guard(exchange_root()):
        from app.course_packages.catalog import copy_directory

        lock_course_content(db, course_id, exclusive=True)
        own_course(db, user, course_id)
        exchange = exchange_root()
        try:
            with tempfile.TemporaryDirectory(prefix="course-catalog-", dir=exchange) as temporary:
                root = Path(temporary) / "package"
                selected = selected_package(db, user, body.package_key)
                digest = copy_directory(selected["path"], root, exchange, LIMITS)
                bundle = load_bundle(root)
                return _save_preview(db, user, course_id, bundle, root, digest)
        except HTTPException:
            db.rollback()
            raise
        except (PackageError, OSError) as exc:
            db.rollback()
            if isinstance(exc, OSError):
                import logging

                logging.getLogger(__name__).exception("Course directory preview failed")
            raise HTTPException(422, str(exc) if isinstance(exc, PackageError) else "课程包读取失败，请刷新列表并重新预览") from exc


def apply_course(course_id: int, preview_id: str, body: ApplyInput, db: Session, user: User):
    with exchange_guard(exchange_root()):
        lock_course_content(db, course_id, exclusive=True)
        instance = own_course(db, user, course_id)
        preview = db.scalar(select(CourseImportPreview).where(CourseImportPreview.id == preview_id).with_for_update())
        if not preview or preview.course_id != course_id or preview.teacher_id != user.id:
            raise HTTPException(404, "导入预览不存在")
        if preview.applied_request_id:
            if preview.applied_request_id != str(body.request_id) or body.expected_revision != preview.expected_revision:
                raise HTTPException(409, "此预览已由另一次操作导入")
            return {**preview.result, "duplicate": True}
        receipt = db.scalar(
            select(CourseImportPreview).where(
                CourseImportPreview.course_id == course_id, CourseImportPreview.applied_request_id == str(body.request_id)
            )
        )
        if receipt:
            if receipt.archive_sha256 != preview.archive_sha256:
                raise HTTPException(409, "请求ID已经用于不同的课程包")
            return {**receipt.result, "duplicate": True}
        if as_utc(preview.expires_at) <= now():
            raise HTTPException(409, "导入预览已过期，请重新预览")
        revision = instance.revision
        if body.expected_revision != preview.expected_revision or revision != preview.expected_revision:
            raise HTTPException(409, "班级课程已修改，请重新预览差异")
        if db.scalar(
            select(AssistantCall.id)
            .where(AssistantCall.classroom_id.in_(course_class_ids(course_id)), AssistantCall.status.in_(["running", "cancel_requested"]))
            .limit(1)
        ):
            raise HTTPException(409, "班级助教会话仍在运行，请完成后重试导入")
        try:
            with tempfile.TemporaryDirectory(prefix="course-apply-", dir=exchange_root()) as temporary:
                from app.course_packages.catalog import copy_directory

                root = Path(temporary) / "package"
                staged = exchange_path(preview.storage_key)
                if not staged.is_dir():
                    raise PackageError("暂存课程目录不可用，请从目录重新预览")
                digest = copy_directory(staged, root, exchange_root(), LIMITS)
                if digest != preview.archive_sha256:
                    raise PackageError("暂存目录校验失败，请重新预览")
                bundle = load_bundle(root)
                impact = preview_impact(db, instance, bundle)
                if impact["narration_revision"] != preview.summary.get("narration_revision"):
                    raise HTTPException(409, "讲稿或配音已变化，请重新预览差异")
                if impact["blockers"]:
                    raise HTTPException(409, {"message": "课程更新影响已有学习记录", "blockers": impact["blockers"]})
                instance = import_bundle(db, instance, bundle, root)
                preview.applied_request_id = str(body.request_id)
                preview.result = {
                    "instance_id": instance.id,
                    "revision": instance.revision,
                    "package_id": instance.package_id,
                    "package_version": instance.package_version,
                    "duplicate": False,
                }
                db.commit()
                return preview.result
        except HTTPException:
            db.rollback()
            raise
        except (PackageError, ValueError, OSError, SQLAlchemyError) as exc:
            db.rollback()
            raise HTTPException(422, str(exc) if isinstance(exc, PackageError) else "课程包导入失败，未修改班级课程") from exc


def create_from_package(body: CreateFromPackageInput, db: Session, user: User):
    from app.course_packages.catalog import copy_directory

    exchange = exchange_root()
    request_id = str(body.request_id)
    signature = {"package_key": body.package_key, "name": body.name}
    with exchange_guard(exchange):
        receipt = db.scalar(select(CourseImportPreview).where(
            CourseImportPreview.teacher_id == user.id, CourseImportPreview.applied_request_id == request_id
        ))
        if receipt:
            if receipt.summary.get("create_course") != signature:
                raise HTTPException(409, "此请求已用于其他课程操作")
            return receipt.result
        try:
            selected = selected_package(db, user, body.package_key)
            with tempfile.TemporaryDirectory(prefix="course-apply-", dir=exchange) as temporary:
                root = Path(temporary) / "package"
                digest = copy_directory(selected["path"], root, exchange, LIMITS)
                bundle = load_bundle(root)
                course = CourseInstance(teacher_id=user.id, name=body.name, package_id="course-" + uuid4().hex, package_version="1")
                db.add(course)
                db.flush()
                import_bundle(db, course, bundle, root)
                course.name = body.name
                result = {"id": course.id, "name": course.name}
                db.add(CourseImportPreview(teacher_id=user.id, course_id=course.id, expected_revision=0,
                                          archive_sha256=digest, storage_key="", summary={"create_course": signature},
                                          applied_request_id=request_id, result=result, expires_at=now()))
                db.commit()
                return result
        except (PackageError, ValueError, OSError, SQLAlchemyError) as exc:
            db.rollback()
            raise HTTPException(422, str(exc) if isinstance(exc, PackageError) else "从课程包创建课程失败") from exc
