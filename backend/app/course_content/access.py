"""Authorize classroom course visibility, releases and learner content access."""

from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import as_utc, preview_classroom
from app.content_relations import material_chapter_ids
from app.course_scope import belongs_to_course, require_course_content
from app.models import (
    Activity,
    Chapter,
    ChapterRelease,
    Classroom,
    Material,
    Membership,
    TownPreviewStudent,
    User,
)


def authorize_classroom(db: Session, user: User, classroom_id: int):
    from app.course_scope import lock_course

    lock_course(db, classroom_id)
    classroom = db.get(Classroom, classroom_id, populate_existing=True)
    if not classroom or classroom.status != "active":
        raise HTTPException(404, "班级不存在")
    if user.role == "admin" or classroom.teacher_id == user.id or (user.role == "student" and db.get(Membership, (user.id, classroom_id))):
        return classroom
    preview = db.get(TownPreviewStudent, user.id)
    if preview and preview.classroom_id == classroom_id:
        return preview_classroom(db, preview)
    raise HTTPException(403, "无权访问此班级")


def chapter_available(db: Session, user: User, classroom_id: int, chapter_id: int, visiting=None) -> bool:
    chapter = db.get(Chapter, chapter_id)
    classroom = db.get(Classroom, classroom_id)
    if (
        not belongs_to_course(db, chapter, classroom_id)
        or not classroom
        or (chapter.owner_id is not None and chapter.owner_id != classroom.teacher_id and user.role != "admin")
    ):
        return False
    release = db.get(ChapterRelease, (classroom_id, chapter_id))
    if not release or release.status != "published" or (release.opens_at and as_utc(release.opens_at) > datetime.now(timezone.utc)):
        return False
    return True


def authorize_chapter(db: Session, user: User, classroom_id: int, chapter_id: int):
    classroom = authorize_classroom(db, user, classroom_id)
    chapter = db.get(Chapter, chapter_id)
    if not chapter:
        raise HTTPException(404, "章节不存在")
    require_course_content(db, chapter, classroom_id)
    if chapter.owner_id is not None and chapter.owner_id != classroom.teacher_id and user.role != "admin":
        raise HTTPException(403, "章节不属于当前班级教师")
    if user.role == "admin" or classroom.teacher_id == user.id:
        return classroom
    if not chapter_available(db, user, classroom_id, chapter_id):
        raise HTTPException(403, "章节尚未开放")
    return classroom


def authorize_activity(db: Session, user: User, classroom_id: int, activity_id: str) -> Activity:
    classroom = authorize_classroom(db, user, classroom_id)
    activity = db.get(Activity, activity_id, populate_existing=True)
    if not activity:
        raise HTTPException(404, "活动不存在")
    require_course_content(db, activity, classroom_id)
    authorize_chapter(db, user, classroom_id, activity.chapter_id)
    if user.role != "admin" and activity.owner_id is not None and activity.owner_id != classroom.teacher_id:
        raise HTTPException(403, "无权访问其他教师的活动")
    can_preview = user.role == "admin" or (user.role == "teacher" and classroom.teacher_id == user.id)
    if not can_preview:
        if activity.content.get("published") is False or (activity.owner_id and activity.owner_id != classroom.teacher_id):
            raise HTTPException(403, "此活动不在当前班级发布范围")
        if activity.kind in {"practice", "assessment"}:
            from app.chapter_tasks.service import chapter_state
            state = chapter_state(db, user, classroom, db.get(Chapter, activity.chapter_id))
            task = next((t for t in state["tasks"] if t.get("activity_id") == activity.id), None)
            if not task or task["locked"]:
                raise HTTPException(403, task["lock_reason"] if task else "此活动尚未发布")
    return activity


def authorized_material_chapters(db, user, classroom_id, material):
    """Return only usable associations; an unpublished sibling chapter stays private."""
    classroom = authorize_classroom(db, user, classroom_id)
    require_course_content(db, material, classroom_id)
    if material.owner_id not in {None, classroom.teacher_id} and user.role != "admin":
        raise HTTPException(403, "无权访问其他班级教师资料")
    chapters = []
    for chapter_id in material_chapter_ids(db, material.id):
        try:
            authorize_chapter(db, user, classroom_id, chapter_id)
        except HTTPException:
            continue
        chapters.append(chapter_id)
    if not chapters:
        raise HTTPException(403, "资料未关联当前班级可访问的已发布章节或活动")
    return chapters


def authorize_material(db: Session, user: User, classroom_id: int, material_id: int) -> Material:
    material = db.get(Material, material_id)
    if not material:
        raise HTTPException(404, "资料不存在")
    authorized_material_chapters(db, user, classroom_id, material)
    return material
