"""Read-only preview of the chapters and material names for a teacher's upload."""
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from fastapi import HTTPException
from pydantic import BaseModel, Field, TypeAdapter, ValidationError
from sqlalchemy import select

from app.materials.batch_upload import (
    MAX_BATCH_MATERIALS, MAX_ZIP_TOTAL_BYTES, _clean_filename,
    _title_from_filename, courseware_zip_entries,
)
from app.materials.service import AUTO_CHAPTER_KINDS, parse_chapter_number, plan_material_chapter
from app.materials.uploads import KINDS, MAX_UPLOAD
from app.models import Chapter
from app.teacher_scope import own_course


class SelectedFile(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    size: int = Field(ge=0)


def upload_preview(db, user, course_id, manifest, archives, title):
    course = own_course(db, user, course_id)
    try:
        files = TypeAdapter(list[SelectedFile]).validate_json(manifest)
    except ValidationError as exc:
        raise HTTPException(422, "文件清单无效") from exc
    chapters = list(db.scalars(select(Chapter).where(Chapter.course_instance_id == course_id)
                               .order_by(Chapter.order_index, Chapter.id)))
    candidates, skipped = [], []

    def add(name, size):
        suffix = Path(name).suffix.lower()
        reason = ""
        if suffix not in KINDS:
            reason = "不支持此文件类型"
        elif not 0 < size <= MAX_UPLOAD:
            reason = "文件为空或超过大小限制"
        elif len(candidates) >= MAX_BATCH_MATERIALS:
            reason = "超过单次导入数量上限"
        if reason:
            skipped.append({"filename": name, "reason": reason})
        else:
            candidates.append((name, KINDS[suffix]))

    archive_iter = iter(archives)
    for file in files:
        name = _clean_filename(file.name)
        if not name.lower().endswith(".zip"):
            add(name, file.size)
            continue
        archive = next(archive_iter, None)
        if not archive or archive.filename != file.name:
            raise HTTPException(422, "压缩包与文件清单不符")
        if (archive.size or 0) > MAX_ZIP_TOTAL_BYTES:
            skipped.append({"filename": name, "reason": "压缩包超过大小限制"})
            continue
        try:
            with ZipFile(archive.file) as zipped:
                entries, reason, _ = courseware_zip_entries(zipped)
                if reason:
                    skipped.append({"filename": name, "reason": reason})
                    continue
                for entry, entry_name in entries:
                    if entry_name:
                        if entry.flag_bits & 1:
                            skipped.append({"filename": entry_name, "reason": "暂不支持加密压缩包"})
                        else:
                            add(entry_name, entry.file_size)
        except BadZipFile:
            skipped.append({"filename": name, "reason": "压缩包已损坏"})

    single = len(files) == 1 and not files[0].name.lower().endswith(".zip")
    candidates.sort(key=lambda item: parse_chapter_number(_title_from_filename(item[0])) or 1000)
    rows = []
    for name, kind in candidates:
        material_title = title.strip() if single and title is not None else _title_from_filename(name)
        target = None
        if material_title and kind in AUTO_CHAPTER_KINDS:
            clean, order, existing_id = plan_material_chapter(material_title, chapters, course.teacher_id)
            target = {"title": clean, "order_index": order, "new": existing_id is None or existing_id < 0}
            if existing_id is None:
                chapters.append(Chapter(id=-len(rows)-1, title=clean, order_index=order, owner_id=course.teacher_id))
        rows.append({"filename": name, "title": material_title, "chapter": target})
    return {"items": rows, "skipped": skipped}
