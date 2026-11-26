"""Material source-digest / narration-script exports and pacing previews."""

from __future__ import annotations

import re
from typing import Any, Literal
from urllib.parse import quote

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Material, User
from ..narration.models import PageContent, PageNarration
from ..teacher_scope import teacher_instance_id
from . import adapter
from .engine import export as export_engine
from .engine import pacing

_UNSAFE_FILENAME = re.compile(r'[\\/:*?"<>|\r\n]+')


def download_headers(filename: str) -> dict[str, str]:
    """Build RFC 5987 Content-Disposition headers safe for non-ASCII filenames."""
    clean = _UNSAFE_FILENAME.sub("_", str(filename or "download")).strip(" .") or "download"
    stem, dot, ext = clean.rpartition(".")
    if not dot:
        stem, ext = clean, ""
    ascii_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._-")
    ascii_part = f"{ascii_stem or 'export'}{dot}{ext}" if dot else (ascii_stem or "download")
    return {
        "Content-Disposition": f'attachment; filename="{ascii_part}"; filename*=UTF-8\'\'{quote(clean)}',
        "Cache-Control": "private, no-store",
    }


def _visible_material(db: Session, user: User, course_id: int, material_id: int) -> tuple[int, Material]:
    instance_id = teacher_instance_id(db, user, course_id)
    material = db.get(Material, material_id)
    if material is None or material.deleted_at is not None or material.course_instance_id != instance_id:
        raise HTTPException(404, "资料不存在或不属于当前课程")
    if user.role != "admin" and material.owner_id not in {None, user.id}:
        raise HTTPException(403, "无权访问其他教师的私有资料")
    return instance_id, material


def export_material_text(
    db: Session,
    user: User,
    course_id: int,
    material_id: int,
    *,
    kind: Literal["source", "script"],
    fmt: Literal["docx", "md"],
) -> tuple[bytes, str, str]:
    """Export digested source pages or narration scripts as DOCX or Markdown."""
    _, material = _visible_material(db, user, course_id, material_id)
    pages_raw = adapter.material_pages(db, material)
    export_pages: list[export_engine.ExportPage] = []

    if kind == "source":
        for page in pages_raw:
            text = str(page.get("text") or "").strip()
            if text:
                export_pages.append(
                    export_engine.ExportPage(
                        index=int(page["page_no"]),
                        topic=str(page.get("title") or ""),
                        text=text,
                    )
                )
    else:
        contents = {
            row.page_no: row
            for row in db.scalars(select(PageContent).where(PageContent.material_id == material.id))
        }
        narrations = db.scalars(
            select(PageNarration)
            .where(PageNarration.material_id == material.id)
            .order_by(PageNarration.page_no)
        )
        for row in narrations:
            text = (row.text or "").strip()
            if not text:
                continue
            pc = contents.get(row.page_no)
            topic = pc.title.strip() if pc and pc.title.strip() else ""
            export_pages.append(
                export_engine.ExportPage(index=row.page_no, topic=topic, text=text)
            )

    if not export_pages:
        msg = "当前资料暂无可导出的整理稿" if kind == "source" else "当前资料暂无可导出的口播讲稿"
        raise HTTPException(409, msg)

    title = _UNSAFE_FILENAME.sub("_", material.title).strip(" .") or f"资料-{material.id}"
    label = export_engine.EXPORT_KINDS[kind]
    if fmt == "docx":
        data = export_engine.build_docx(material.title, export_pages, kind=kind)
        return data, export_engine.FORMATS["docx"], f"{title}-{label}.docx"

    markdown = export_engine.build_markdown(material.title, export_pages, kind=kind)
    return markdown.encode("utf-8"), "text/markdown; charset=utf-8", f"{title}-{label}.md"


def preview_material_pacing(
    db: Session,
    user: User,
    course_id: int,
    material_id: int,
    *,
    section_minutes: float = pacing.SECTION_TARGET_MINUTES,
    chapter_minutes: float = pacing.CHAPTER_TARGET_MINUTES,
) -> dict[str, Any]:
    """Compute section/page speech budgets and spoken duration metrics for one material."""
    _, material = _visible_material(db, user, course_id, material_id)
    pages_raw = adapter.material_pages(db, material)
    if not pages_raw:
        raise HTTPException(409, "当前资料暂无可测算节奏的页面")

    scripts = {
        row.page_no: row.text or ""
        for row in db.scalars(select(PageNarration).where(PageNarration.material_id == material.id))
    }
    pacing_pages = [
        pacing.PacingPage(
            index=int(p["page_no"]),
            raw_text=str(p.get("raw_text") or p.get("text") or ""),
            note=str(p.get("text") or ""),
            script=scripts.get(int(p["page_no"]), ""),
        )
        for p in pages_raw
    ]
    report = pacing.compute_section_budgets(
        pacing_pages,
        section_minutes=section_minutes,
        chapter_minutes=chapter_minutes,
    )
    slide_by_page = {int(p.index): p for p in pacing_pages}
    return {
        "material_id": material.id,
        "summary": pacing.summary_line(report),
        "total_chars": int(report.total_chars),
        "total_seconds": round(float(report.total_seconds), 1),
        "formatted_time": pacing.format_time(report.total_seconds),
        "section_minutes": float(section_minutes),
        "chapter_minutes": float(chapter_minutes),
        "sections": [
            {
                "section": sec.section,
                "target_minutes": float(sec.target_minutes),
                "pages": list(sec.pages),
                "chars": int(sec.chars),
                "budget": int(sec.budget),
                "seconds": round(float(sec.seconds), 1),
            }
            for sec in report.sections
        ],
        "pages": [
            {
                "page": row.page,
                "section": row.section,
                "kind": pacing.classify_slide(
                    row.page,
                    max((int(s.index) for s in pacing_pages), default=len(pacing_pages)),
                    slide_by_page[row.page].raw_text,
                    slide_by_page[row.page].note,
                )
                if row.page in slide_by_page
                else "content",
                "chars": int(row.chars),
                "budget": int(row.budget),
                "pauses": int(row.pauses),
                "seconds": round(float(row.seconds), 1),
                "over": bool(row.over),
                "severe": bool(row.severe),
                "under": bool(row.under),
            }
            for row in report.pages
        ],
    }
