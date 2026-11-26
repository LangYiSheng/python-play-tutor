"""Adapters bridging pure Lectio engine logic with Reborn settings, scoping, and storage."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import service_settings
from ..models import Chapter, Classroom, Material, User
from ..narration.models import PageContent
from ..teacher_scope import commit_content, require_scope, teacher_course_scope
from .engine.llm import LLMClient


def visible_query(model: Any, instance_id: int, user: User) -> Any:
    """Build classroom-scoped SELECT filtering private rows for non-admin teachers."""
    stmt = select(model).where(model.course_instance_id == instance_id)
    if user.role != "admin" and hasattr(model, "owner_id"):
        stmt = stmt.where(model.owner_id.is_(None) | (model.owner_id == user.id))
    return stmt


def authoring_chapter(db: Session, user: User, chapter_id: int, instance_id: int) -> Chapter:
    """Resolve one chapter inside instance_id and enforce teacher authoring access."""
    chapter = require_scope(db.get(Chapter, chapter_id), instance_id)
    if user.role != "admin" and chapter.owner_id not in {None, user.id}:
        raise HTTPException(403, "无权使用其他教师的私有章节")
    return chapter


def authoring_settings(db: Session | None = None) -> dict[str, Any]:
    """Read encrypted authoring AI settings from Reborn service_settings."""
    return dict(service_settings.configuration("authoring", db))


def authoring_unavailable_reason(db: Session | None = None) -> str | None:
    """Return a teacher-facing reason when authoring LLM credentials are incomplete."""
    cfg = authoring_settings(db)
    if not str(cfg.get("base_url") or "").strip():
        return "未配置作者期模型地址，AI 创作不可用"
    if not str(cfg.get("api_key") or "").strip():
        return "未配置作者期模型凭据，AI 创作不可用"
    if not str(cfg.get("model") or "").strip():
        return "未配置作者期模型名称，AI 创作不可用"
    return None


def build_llm_client(
    db: Session | None = None,
    *,
    check_cancel: Callable[[], None] | None = None,
) -> LLMClient:
    """Instantiate an authoring LLMClient or raise HTTP 409 when unconfigured."""
    reason = authoring_unavailable_reason(db)
    if reason:
        raise HTTPException(409, reason)
    return LLMClient(authoring_settings(db), check_cancel=check_cancel)


def course_scope(
    db: Session,
    user: User,
    classroom_id: int,
    *,
    exclusive: bool = False,
) -> tuple[Classroom, int]:
    """Enforce classroom ownership and return (Classroom, course_instance_id)."""
    return teacher_course_scope(db, user, classroom_id, exclusive=exclusive)


def commit_course_content(db: Session, instance_id: int) -> None:
    """Increment CourseInstance revision and commit transaction."""
    commit_content(db, instance_id)


def material_pages(db: Session, material: Material) -> list[dict[str, Any]]:
    """Build ordered page dicts preferring digested PageContent over raw parsed pages."""
    digested = {
        row.page_no: row
        for row in db.scalars(select(PageContent).where(PageContent.material_id == material.id))
    }
    raw_pages = (material.content or {}).get("pages") or []
    by_no: dict[int, dict[str, Any]] = {}
    for item in raw_pages:
        if not isinstance(item, dict):
            continue
        page_no = item.get("page_no") or item.get("id")
        if not isinstance(page_no, int) or page_no <= 0:
            continue
        raw_text = str(item.get("text") or "")
        pc = digested.get(page_no)
        text = pc.text.strip() if pc is not None and pc.text.strip() else raw_text
        title = pc.title.strip() if pc is not None and pc.title.strip() else str(item.get("title") or "")
        by_no[page_no] = {
            "page_no": page_no,
            "title": title,
            "text": text,
            "raw_text": raw_text,
        }
    for page_no, pc in digested.items():
        if page_no not in by_no and page_no > 0:
            by_no[page_no] = {
                "page_no": page_no,
                "title": pc.title.strip(),
                "text": pc.text.strip(),
                "raw_text": pc.text.strip(),
            }
    return [by_no[no] for no in sorted(by_no)]
