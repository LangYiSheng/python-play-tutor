"""Coordinate authorized material uploads, replacement and processing status."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import tempfile
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.content_relations import set_material_chapters
from app.materials.access import teacher_material, teacher_material_chapters, teacher_material_payload, validate_material_links
from app.materials.contracts import MaterialUpdate
from app.materials.presentation import embeddable_media, material_payload
from app.materials.storage import get_storage, storage_root
from app.materials.uploads import KINDS, MAX_UPLOAD, UploadValidationError, validate_upload
from app.models import Chapter, Material, MaterialChapter, User
from app.teacher_scope import commit_content, new_stable_id, own_course, require_scope, teacher_instance_id

AUTO_CHAPTER_KINDS = {"presentation", "pdf"}
_CN_DIGITS = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
_CN_CHAPTER_RE = re.compile(r"第\s*([零〇一二两三四五六七八九十百\d]+)\s*章")
_EN_CHAPTER_RE = re.compile(r"(?i)(?:^|[^a-z0-9])(?:chapter|chap|ch)\s*[-_.\s]*0*(\d{1,3})(?=\s|[-_.:：·、]|$)")
_LEADING_CN_CHAPTER_RE = re.compile(r"^\s*第\s*([零〇一二两三四五六七八九十百\d]+)\s*章[\s:：·\-—._、]*")
_LEADING_EN_CHAPTER_RE = re.compile(r"(?i)^\s*(?:chapter|chap|ch)\s*[-_.\s]*0*(\d{1,3})(?=\s|[-_.:：·、]|$)[\s:：·\-—._、]*")


def _parse_cn_or_arabic_int(raw: str) -> int | None:
    token = raw.strip()
    if not token:
        return None
    if token.isdigit():
        val = int(token)
        return val if 1 <= val <= 999 else None
    total, current = 0, 0
    for ch in token:
        if ch in _CN_DIGITS:
            current = _CN_DIGITS[ch]
        elif ch == "十":
            total += (current or 1) * 10
            current = 0
        elif ch == "百":
            total += (current or 1) * 100
            current = 0
        else:
            return None
    val = total + current
    return val if 1 <= val <= 999 else None


def parse_chapter_number(title: str) -> int | None:
    """Extract chapter number (1..999) from titles like '第六章数据存取与分析' or 'Chapter 3'."""
    match = _CN_CHAPTER_RE.search(title)
    if match:
        return _parse_cn_or_arabic_int(match.group(1))
    en_match = _EN_CHAPTER_RE.search(title)
    if en_match:
        val = int(en_match.group(1))
        return val if 1 <= val <= 999 else None
    return None


def extract_chapter_meta(title: str) -> tuple[int | None, str]:
    """Parse chapter number and strip leading '第X章' / 'Chapter X' prefix for the folder name.

    Falls back to the original title if stripping leaves an empty string.
    """
    raw = title.strip()[:200]
    m_cn = _LEADING_CN_CHAPTER_RE.match(raw)
    if m_cn:
        num = _parse_cn_or_arabic_int(m_cn.group(1))
        rest = raw[m_cn.end():].strip()
        return num, (rest or raw)[:200]
    m_en = _LEADING_EN_CHAPTER_RE.match(raw)
    if m_en:
        val = int(m_en.group(1))
        num = val if 1 <= val <= 999 else None
        rest = raw[m_en.end():].strip()
        return num, (rest or raw)[:200]
    return parse_chapter_number(raw), raw


def ensure_chapter_for_material(
    db: Session,
    *,
    title: str,
    owner_id: int | None,
    instance_id: int,
) -> tuple[Chapter, bool]:
    """Reuse an accessible chapter with the same clean title, or create a new chapter.

    When the title contains a chapter number (e.g. '第六章数据存取与分析' or 'Chapter 2 Intro'),
    sets order_index to that number (if unused) and strips the leading chapter-number prefix
    from the chapter title so the folder displays cleanly as '6. 数据存取与分析'.
    """
    raw_clean = title.strip()[:200]
    parsed_order, clean = extract_chapter_meta(raw_clean)
    candidate_titles = {clean, raw_clean}
    existing_query = select(Chapter).where(
        Chapter.course_instance_id == instance_id,
        Chapter.title.in_(candidate_titles),
    )
    if owner_id is not None:
        existing_query = existing_query.where(Chapter.owner_id.is_(None) | (Chapter.owner_id == owner_id))
    existing = db.scalar(existing_query.order_by(Chapter.order_index, Chapter.id))
    if existing is not None:
        return existing, False
    used_orders = set(db.scalars(select(Chapter.order_index).where(Chapter.course_instance_id == instance_id)))
    if parsed_order is not None and parsed_order not in used_orders:
        next_order = parsed_order
    else:
        next_order = (max(used_orders) if used_orders else 0) + 1
    chapter = Chapter(
        title=clean,
        order_index=next_order,
        owner_id=owner_id,
        course_instance_id=instance_id,
        stable_id=new_stable_id(),
    )
    db.add(chapter)
    db.flush()
    return chapter, True


async def upload_material(
    user: User,
    db: Session,
    course_id: int,
    title: str,
    file: UploadFile,
    material_id: int | None = None,
    chapter_ids: str | None = None,
    auto_create_chapter: bool | None = None,
):
    course = own_course(db, user, course_id, exclusive=True)
    instance_id = course.id
    name = file.filename or ""
    if not name or "/" in name or "\\" in name or ":" in name or len(name) > 200 or not title.strip() or len(title) > 200:
        raise HTTPException(422, "文件名或标题无效")
    suffix = Path(name).suffix.lower()
    if suffix not in KINDS:
        raise HTTPException(415, "不支持此文件类型")
    from app.curriculum import authoring_chapter

    selected_chapters = None
    if chapter_ids is not None:
        from app.curriculum import validate_id_list

        try:
            selected_chapters = validate_id_list(json.loads(chapter_ids))
        except (ValueError, TypeError):
            raise HTTPException(422, "chapter_ids 必须是有效的章节ID JSON数组")
        for chapter_id in selected_chapters:
            authoring_chapter(db, user, chapter_id, instance_id)
    material = db.scalar(select(Material).where(Material.id == material_id).with_for_update()) if material_id else None
    if material_id and (not material or (material.owner_id != user.id and user.role != "admin")):
        raise HTTPException(403, "只能更新自己上传的资料")
    if material:
        require_scope(material, instance_id)
    if material and material.kind != KINDS[suffix]:
        raise HTTPException(422, "替换文件必须保留材料类型")
    if material and selected_chapters is not None:
        validate_material_links(db, material.id, selected_chapters)
    with tempfile.TemporaryDirectory(prefix="upload-", dir=storage_root()) as tmp:
        path = Path(tmp) / ("source" + suffix)
        size, digest = 0, hashlib.sha256()
        with path.open("wb") as output:
            while chunk := await file.read(65536):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise HTTPException(413, "文件超过上传大小限制")
                digest.update(chunk)
                output.write(chunk)
        if size == 0:
            raise HTTPException(422, "文件为空")
        try:
            await asyncio.to_thread(validate_upload, path, suffix)
        except UploadValidationError as exc:
            raise HTTPException(415, str(exc)) from exc
        key = f"materials/{uuid4().hex}{suffix}"
        await asyncio.to_thread(get_storage().put, key, path)
    created_chapter: dict | None = None
    is_new_material = material is None
    if not material:
        material = Material(title=title.strip(), kind=KINDS[suffix], owner_id=course.teacher_id, course_instance_id=instance_id, stable_id=new_stable_id())
        db.add(material)
        db.flush()
    should_auto_chapter = (
        is_new_material
        and not selected_chapters
        and (auto_create_chapter is True or (auto_create_chapter is None and material.kind in AUTO_CHAPTER_KINDS))
    )
    if should_auto_chapter:
        chapter, was_created = ensure_chapter_for_material(
            db,
            title=title.strip(),
            owner_id=course.teacher_id,
            instance_id=instance_id,
        )
        selected_chapters = [chapter.id]
        if was_created:
            created_chapter = {"id": chapter.id, "title": chapter.title, "order_index": chapter.order_index}
    if selected_chapters is not None:
        set_material_chapters(db, material.id, selected_chapters)
    material.title = title.strip()
    material.status = "queued"
    material.error = None
    material.storage_key = key
    material.content = {"filename": name, "size": size, "sha256": digest.hexdigest(), "pages": []}
    try:
        commit_content(db, instance_id)
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "资料同时更新，请刷新后重试")
    result = {"id": material.id, "status": material.status, "title": material.title}
    if selected_chapters is not None:
        result["chapter_ids"] = selected_chapters
    if created_chapter is not None:
        result["created_chapter"] = created_chapter
    return result


def visible_materials(instance_id, user):
    query = select(Material).where(Material.course_instance_id == instance_id)
    if user.role != "admin":
        query = query.where(Material.owner_id.is_(None) | (Material.owner_id == user.id))
    return query


def teacher_materials(user: User, db: Session, course_id: int | None = None):
    query = visible_materials(teacher_instance_id(db, user, course_id), user)
    return [teacher_material_payload(db, material, user) for material in db.scalars(query.order_by(Material.id))]


def material_page(db, user, course_id, page, size, search, kind, status):
    from app.course_content.catalog import page_window

    instance_id = teacher_instance_id(db, user, course_id)
    query = visible_materials(instance_id, user).with_only_columns(
        Material.id, Material.title, Material.kind, Material.status, Material.error, Material.owner_id)
    links = select(MaterialChapter.material_id, Chapter.id).join(Chapter, Chapter.id == MaterialChapter.chapter_id).where(
        Chapter.course_instance_id == instance_id)
    if user.role != "admin":
        links = links.where(Chapter.owner_id.is_(None) | (Chapter.owner_id == user.id))
    if search.strip():
        query = query.where(Material.title.icontains(search.strip(), autoescape=True))
    if kind == "unassigned":
        query = query.where(~links.where(MaterialChapter.material_id == Material.id).exists())
    elif kind:
        query = query.where(Material.kind == kind)
    if status:
        query = query.where(Material.status.in_(("queued", "processing")) if status == "converting" else Material.status == status)
    meta, window = page_window(db, query.order_by(Material.id), page, size)
    rows = {row.id: dict(row, chapter_ids=[]) for row in db.execute(window).mappings()}
    if rows:
        for material_id, chapter_id in db.execute(links.where(MaterialChapter.material_id.in_(rows)).order_by(Chapter.id)):
            rows[material_id]["chapter_ids"].append(chapter_id)
    return {**meta, "items": list(rows.values())}


def teacher_material_preview(material_id: int, user: User, db: Session, course_id: int | None = None):
    instance_id = teacher_instance_id(db, user, course_id)
    material = teacher_material(db, user, material_id, instance_id=instance_id)
    result = material_payload(db, material, chapter_ids=teacher_material_chapters(db, material, user), include_notes=True)
    result["owner_id"] = material.owner_id
    result["media_url"] = (
        f"/api/teacher/courses/{instance_id}/materials/{material.id}/file" if embeddable_media(material) else None
    )
    return result


def retry_material(material_id: int, user: User, db: Session, course_id: int):
    instance_id = teacher_instance_id(db, user, course_id, exclusive=True)
    material = teacher_material(db, user, material_id, edit=True, instance_id=instance_id)
    if not material.storage_key:
        raise HTTPException(409, "原始课件文件缺失，请重新上传")
    if material.status not in {"failed", "ready"}:
        raise HTTPException(409, "资料正在处理中，请稍候")
    material.status = "queued"
    material.error = None
    commit_content(db, instance_id)
    return teacher_material_payload(db, material, user)


def update_material(material_id: int, body: MaterialUpdate, user: User, db: Session, course_id: int | None = None):
    instance_id = teacher_instance_id(db, user, course_id, exclusive=True)
    from app.curriculum import authoring_chapter

    material = teacher_material(db, user, material_id, edit=True, instance_id=instance_id)
    if "chapter_ids" in body.model_fields_set:
        for chapter_id in body.chapter_ids:
            authoring_chapter(db, user, chapter_id, instance_id)
        validate_material_links(db, material.id, body.chapter_ids)
        set_material_chapters(db, material.id, body.chapter_ids)
    if "title" in body.model_fields_set:
        material.title = body.title
    commit_content(db, instance_id)
    return teacher_material_payload(db, material, user)


def delete_material(material_id: int, user: User, db: Session, course_id: int | None = None):
    instance_id = teacher_instance_id(db, user, course_id, exclusive=True)
    teacher_material(db, user, material_id, edit=True, instance_id=instance_id)
    raise HTTPException(409, "请先预览删除影响并完成二次确认")
