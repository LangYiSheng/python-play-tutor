"""Batch and ZIP-archive courseware upload into an authorized course."""

from __future__ import annotations

import asyncio
import hashlib
import json
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, UploadFile
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.content_relations import set_material_chapters
from app.materials.service import AUTO_CHAPTER_KINDS, ensure_chapter_for_material, parse_chapter_number
from app.materials.storage import get_storage, storage_root
from app.materials.uploads import KINDS, MAX_UPLOAD, UploadValidationError, validate_upload
from app.models import Material, User
from app.teacher_scope import commit_content, new_stable_id, own_course

MAX_BATCH_MATERIALS = 50
MAX_ZIP_ENTRIES = 200
MAX_ZIP_TOTAL_BYTES = 512 * 1024 * 1024


def _decode_zip_name(info: zipfile.ZipInfo) -> str:
    raw = info.filename
    if info.flag_bits & 0x800:
        return raw
    try:
        raw_bytes = raw.encode("cp437")
    except UnicodeEncodeError:
        return raw
    for encoding in ("utf-8", "gb18030"):
        try:
            return raw_bytes.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw


def _clean_filename(raw: str) -> str:
    normalized = raw.replace("\\", "/").strip()
    parts = [p for p in PurePosixPath(normalized).parts if p not in ("", "/", ".")]
    if not parts or any(p == ".." for p in parts):
        return ""
    if "__MACOSX" in parts:
        return ""
    name = parts[-1].strip()
    if not name or name.startswith(".") or name.startswith("~$") or "/" in name or "\\" in name or ":" in name:
        return ""
    return name[:200]


def _title_from_filename(name: str) -> str:
    stem = Path(name).stem.strip()
    return (stem or name)[:200]


def _store_validated_file(
    db: Session,
    *,
    path: Path,
    filename: str,
    suffix: str,
    size: int,
    sha256_hex: str,
    owner_id: int | None,
    instance_id: int,
    selected_chapters: list[int] | None,
    auto_create_chapter: bool | None = None,
) -> tuple[Material, dict[str, Any] | None]:
    validate_upload(path, suffix)
    key = f"materials/{uuid4().hex}{suffix}"
    get_storage().put(key, path)
    title = _title_from_filename(filename)
    kind = KINDS[suffix]
    material = Material(
        title=title,
        kind=kind,
        owner_id=owner_id,
        course_instance_id=instance_id,
        stable_id=new_stable_id(),
        status="queued",
        error=None,
        storage_key=key,
        content={"filename": filename, "size": size, "sha256": sha256_hex, "pages": []},
    )
    db.add(material)
    db.flush()
    created_chapter: dict[str, Any] | None = None
    target_chapters = selected_chapters
    should_auto_chapter = not target_chapters and (
        auto_create_chapter is True or (auto_create_chapter is None and kind in AUTO_CHAPTER_KINDS)
    )
    if should_auto_chapter:
        chapter, was_created = ensure_chapter_for_material(
            db,
            title=title,
            owner_id=owner_id,
            instance_id=instance_id,
        )
        target_chapters = [chapter.id]
        if was_created:
            created_chapter = {"id": chapter.id, "title": chapter.title, "order_index": chapter.order_index}
    if target_chapters is not None:
        set_material_chapters(db, material.id, target_chapters)
    return material, created_chapter


def _extract_zip_candidates(
    zip_path: Path,
    tmp_dir: Path,
    *,
    filename: str,
    remaining_slots: int,
) -> tuple[list[tuple[Path, str, str, int, str]], list[dict[str, str]], bool]:
    extracted: list[tuple[Path, str, str, int, str]] = []
    skipped: list[dict[str, str]] = []
    total_bytes = 0

    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        skipped.append({"filename": filename, "reason": "压缩包已损坏或不是有效的 ZIP 文件"})
        return extracted, skipped, False

    with zf:
        infos = [info for info in zf.infolist() if not info.is_dir()]
        if len(infos) > MAX_ZIP_ENTRIES:
            skipped.append({"filename": filename, "reason": f"压缩包内文件过多（超过 {MAX_ZIP_ENTRIES} 个）"})
            return extracted, skipped, False
        entries = [(info, _clean_filename(_decode_zip_name(info))) for info in infos]
        if any(name.lower() == "manifest.yaml" for _, name in entries):
            return [], [{"filename": filename, "reason": "完整课程包请通过课程包页面导入"}], True
        for index, (info, clean_name) in enumerate(entries):
            if not clean_name:
                continue
            suffix = Path(clean_name).suffix.lower()
            if suffix not in KINDS:
                skipped.append({"filename": clean_name, "reason": "不支持此文件类型"})
                continue
            if len(extracted) >= remaining_slots:
                skipped.append({"filename": clean_name, "reason": f"超出单次批量导入上限（{MAX_BATCH_MATERIALS} 份）"})
                continue
            if info.file_size > MAX_UPLOAD:
                skipped.append({"filename": clean_name, "reason": "文件超过单文件大小限制"})
                continue
            out_path = tmp_dir / f"{zip_path.stem}-{index}{suffix}"
            size = 0
            digest = hashlib.sha256()
            try:
                with zf.open(info, "r") as src, out_path.open("wb") as dst:
                    while chunk := src.read(65536):
                        size += len(chunk)
                        total_bytes += len(chunk)
                        if size > MAX_UPLOAD or total_bytes > MAX_ZIP_TOTAL_BYTES:
                            raise ValueError("压缩包解压体积超过限制")
                        digest.update(chunk)
                        dst.write(chunk)
            except RuntimeError:
                out_path.unlink(missing_ok=True)
                skipped.append({"filename": clean_name, "reason": "暂不支持加密压缩包"})
                continue
            except zipfile.BadZipFile:
                out_path.unlink(missing_ok=True)
                skipped.append({"filename": clean_name, "reason": "压缩包内文件已损坏"})
                continue
            except ValueError as exc:
                out_path.unlink(missing_ok=True)
                skipped.append({"filename": clean_name, "reason": str(exc)})
                continue
            if size == 0:
                out_path.unlink(missing_ok=True)
                skipped.append({"filename": clean_name, "reason": "文件为空"})
                continue
            extracted.append((out_path, clean_name, suffix, size, digest.hexdigest()))

    return extracted, skipped, False


async def upload_materials_batch(
    user: User,
    db: Session,
    course_id: int,
    files: list[UploadFile],
    chapter_ids: str | None = None,
    auto_create_chapter: bool | None = None,
) -> dict[str, Any]:
    """Upload one or more courseware files (and auto-extract supported files from .zip archives)."""
    if not files:
        raise HTTPException(422, "请至少选择一个文件")
    course = own_course(db, user, course_id, exclusive=True)
    instance_id = course.id
    from app.curriculum import authoring_chapter, validate_id_list

    selected_chapters: list[int] | None = None
    if chapter_ids is not None:
        try:
            selected_chapters = validate_id_list(json.loads(chapter_ids))
        except (ValueError, TypeError) as exc:
            raise HTTPException(422, "chapter_ids 必须是有效的章节ID JSON数组") from exc
        for cid in selected_chapters:
            authoring_chapter(db, user, cid, instance_id)

    created: list[dict[str, Any]] = []
    created_chapters: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    course_pkg_detected = False

    with tempfile.TemporaryDirectory(prefix="upload-batch-", dir=storage_root()) as tmp_name:
        tmp_dir = Path(tmp_name)
        all_candidates: list[tuple[int, Path, str, str, int, str]] = []
        seq = 0
        for idx, upload in enumerate(files):
            raw_name = upload.filename or ""
            clean_name = _clean_filename(raw_name)
            if not clean_name:
                skipped.append({"filename": raw_name or f"文件{idx + 1}", "reason": "文件名无效"})
                continue
            suffix = Path(clean_name).suffix.lower()
            if suffix not in KINDS and suffix != ".zip":
                skipped.append({"filename": clean_name, "reason": "不支持此文件类型"})
                continue

            saved_path = tmp_dir / f"raw-{idx}{suffix}"
            size = 0
            digest = hashlib.sha256()
            oversize = False
            max_limit = MAX_ZIP_TOTAL_BYTES if suffix == ".zip" else MAX_UPLOAD
            with saved_path.open("wb") as out:
                while chunk := await upload.read(65536):
                    size += len(chunk)
                    if size > max_limit:
                        oversize = True
                        break
                    digest.update(chunk)
                    out.write(chunk)
            if oversize:
                skipped.append({"filename": clean_name, "reason": "文件超过上传大小限制"})
                continue
            if size == 0:
                skipped.append({"filename": clean_name, "reason": "文件为空"})
                continue

            candidates: list[tuple[Path, str, str, int, str]]
            if suffix == ".zip":
                remaining = max(0, MAX_BATCH_MATERIALS - len(all_candidates))
                candidates, zip_skipped, is_pkg = await asyncio.to_thread(
                    _extract_zip_candidates, saved_path, tmp_dir, filename=clean_name, remaining_slots=remaining
                )
                skipped.extend(zip_skipped)
                course_pkg_detected = course_pkg_detected or is_pkg
            else:
                if len(all_candidates) >= MAX_BATCH_MATERIALS:
                    skipped.append({"filename": clean_name, "reason": f"超出单次批量导入上限（{MAX_BATCH_MATERIALS} 份）"})
                    continue
                candidates = [(saved_path, clean_name, suffix, size, digest.hexdigest())]

            for cand in candidates:
                all_candidates.append((seq, *cand))
                seq += 1

        if not selected_chapters:
            # Allocate explicitly numbered chapters (e.g. 第一章 / 第六章) before unnumbered uploads
            # so an unnumbered PPT uploaded earlier in the same batch never steals chapter 1.
            def _candidate_order(item: tuple[int, Path, str, str, int, str]) -> tuple[int, int, int]:
                orig_seq, _, cand_name, _, _, _ = item
                num = parse_chapter_number(_title_from_filename(cand_name))
                return (0, num, orig_seq) if num is not None else (1, 0, orig_seq)

            all_candidates.sort(key=_candidate_order)

        for _, cand_path, cand_name, cand_suffix, cand_size, cand_hash in all_candidates:
            try:
                mat, ch_info = _store_validated_file(
                    db,
                    path=cand_path,
                    filename=cand_name,
                    suffix=cand_suffix,
                    size=cand_size,
                    sha256_hex=cand_hash,
                    owner_id=course.teacher_id,
                    instance_id=instance_id,
                    selected_chapters=selected_chapters,
                    auto_create_chapter=auto_create_chapter,
                )
                if ch_info is not None:
                    created_chapters.append(ch_info)
                created.append(
                    {
                        "id": mat.id,
                        "title": mat.title,
                        "kind": mat.kind,
                        "status": mat.status,
                        "filename": cand_name,
                    }
                )
            except UploadValidationError as exc:
                skipped.append({"filename": cand_name, "reason": str(exc)})

    if not created:
        db.rollback()
        if course_pkg_detected:
            raise HTTPException(
                422,
                "检测到压缩包内含 manifest.yaml（完整课程包），请解压放入课程交换目录并在「课程包」页面导入。",
            )
        detail = skipped[0]["reason"] if skipped else "未找到可导入的课件文件"
        raise HTTPException(422, f"未能导入任何资料：{detail}")

    try:
        commit_content(db, instance_id)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "资料同时更新，请刷新后重试") from exc

    return {"created": created, "skipped": skipped, "created_chapters": created_chapters}
