"""Authorize and persist chapter release schedules."""

from datetime import datetime, timezone
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import as_utc
from app.classrooms.access import own_classroom
from app.models import Chapter, ChapterRelease, User
from app.teacher_scope import require_scope


class ReleaseInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["published", "paused"] = "published"
    opens_at: datetime | None = None

    @field_validator("opens_at")
    @classmethod
    def timezone_required(cls, value):
        if value and value.tzinfo is None:
            raise ValueError("开放时间必须包含时区")
        return value.astimezone(timezone.utc) if value is not None else None


def release_chapter(classroom_id: int, chapter_id: int, body: ReleaseInput, db: Session, user: User):
    classroom = own_classroom(db, user, classroom_id, exclusive=True)
    instance_id = classroom.course_id
    chapter = db.get(Chapter, chapter_id)
    require_scope(chapter, instance_id)
    if not chapter:
        raise HTTPException(404, "章节不存在")
    if chapter.owner_id is not None and chapter.owner_id != classroom.teacher_id:
        raise HTTPException(403, "不能向本班发布其他教师的私有章节")
    release = db.get(ChapterRelease, (classroom_id, chapter_id))
    if not release:
        release = ChapterRelease(classroom_id=classroom_id, chapter_id=chapter_id)
        db.add(release)
    for key, value in body.model_dump().items():
        setattr(release, key, value)
    db.commit()
    return {
        "classroom_id": classroom_id,
        "chapter_id": chapter_id,
        **body.model_dump(),
        "opens_at": as_utc(release.opens_at).isoformat() if release.opens_at is not None else None,
        "pause_policy": "deny_all_new_requests_preserve_history",
    }


def list_releases(classroom_id: int, db: Session, user: User):
    own_classroom(db, user, classroom_id)
    return [
        {
            "classroom_id": r.classroom_id,
            "chapter_id": r.chapter_id,
            "status": r.status,
            "opens_at": as_utc(r.opens_at).isoformat() if r.opens_at is not None else None,
            "pause_policy": "deny_all_new_requests_preserve_history",
        }
        for r in db.scalars(select(ChapterRelease).where(ChapterRelease.classroom_id == classroom_id))
    ]
