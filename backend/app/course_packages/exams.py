"""Snapshot, export, validate, preview, and restore Lectio exams in v3 course packages."""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.course_packages.manifest import PackageError
from app.lectio.models import LectioExam

EXAMS_FILE = "content/exams.jsonl"
EXPORT_FIELDS = ("id", "title", "mode", "blueprint", "variants", "stats")
MAX_EXAMS = 500


def current_rows(db: Session, instance: Any) -> list[LectioExam]:
    """Return ordered LectioExam rows for one course instance."""
    if instance is None:
        return []
    return list(
        db.scalars(
            select(LectioExam)
            .where(LectioExam.course_instance_id == instance.id)
            .order_by(LectioExam.stable_id, LectioExam.id)
        )
    )


def serialize_exam(row: LectioExam) -> dict[str, Any]:
    """Serialize one LectioExam row into its portable package payload."""
    return {
        "id": row.stable_id,
        "title": row.title,
        "mode": row.mode,
        "blueprint": deepcopy(row.blueprint or {}),
        "variants": deepcopy(row.variants or {}),
        "stats": deepcopy(row.stats or {}),
    }


def export_exams(db: Session, instance: Any, root: Path) -> None:
    """Write content/exams.jsonl when the course has at least one exam."""
    rows = current_rows(db, instance)
    if not rows:
        return
    path = root / EXAMS_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(serialize_exam(r), ensure_ascii=False, allow_nan=False) + "\n" for r in rows),
        encoding="utf-8",
    )


def validate_exams(bundle: dict[str, Any]) -> None:
    """Validate optional bundle['exams'] entries before any database write."""
    rows = bundle.get("exams", [])
    if not isinstance(rows, list) or len(rows) > MAX_EXAMS:
        raise PackageError("试卷清单格式无效或数量超限")
    seen_ids: set[str] = set()
    expected_keys = set(EXPORT_FIELDS)
    for row in rows:
        if not isinstance(row, dict) or set(row) != expected_keys:
            raise PackageError("试卷对象字段缺失或包含未知字段")
        stable_id = row["id"]
        if not isinstance(stable_id, str) or not stable_id.strip() or len(stable_id) > 100 or stable_id in seen_ids:
            raise PackageError("试卷稳定ID无效或重复")
        seen_ids.add(stable_id)
        title = row["title"]
        if not isinstance(title, str) or not title.strip() or len(title) > 200:
            raise PackageError("试卷标题无效")
        if row["mode"] not in {"single", "ab"}:
            raise PackageError("试卷模式仅支持 single 或 ab")
        for field in ("blueprint", "variants", "stats"):
            if not isinstance(row[field], dict):
                raise PackageError(f"试卷 {field} 必须为对象")
        variants = row["variants"]
        va = variants.get("A")
        if not isinstance(va, dict) or not isinstance(va.get("questions"), list):
            raise PackageError("试卷必须包含有效的 A 卷题目列表")
        if row["mode"] == "ab":
            vb = variants.get("B")
            if not isinstance(vb, dict) or not isinstance(vb.get("questions"), list):
                raise PackageError("A/B 卷模式必须包含有效的 B 卷题目列表")


def preview_exams(db: Session, instance: Any, bundle: dict[str, Any]) -> dict[str, list[str]]:
    """Compute added/removed/updated diff for exams during package preview."""
    previous = {row.stable_id: serialize_exam(row) for row in current_rows(db, instance)}
    incoming = {row["id"]: row for row in bundle.get("exams", [])}
    replace = instance is not None and instance.package_id != bundle["manifest"]["package_id"]
    if bundle.get("exams_present") or replace:
        removed = sorted(previous.keys() - incoming.keys())
    else:
        removed = []
    return {
        "added": sorted(incoming.keys() - previous.keys()),
        "removed": removed,
        "updated": sorted(k for k in incoming.keys() & previous.keys() if incoming[k] != previous[k]),
    }


def import_exams(db: Session, instance: Any, bundle: dict[str, Any], *, replace: bool) -> None:
    """Restore or upsert portable LectioExam rows inside the caller transaction."""
    if replace:
        db.execute(delete(LectioExam).where(LectioExam.course_instance_id == instance.id))
    exams_present = bool(bundle.get("exams_present"))
    rows = bundle.get("exams", [])
    if not exams_present and not rows:
        db.flush()
        return

    existing = {row.stable_id: row for row in current_rows(db, instance)}
    incoming_ids = {row["id"] for row in rows}
    for source in rows:
        row = existing.get(source["id"])
        if row is None:
            row = LectioExam(course_instance_id=instance.id, stable_id=source["id"], created_by=None)
            db.add(row)
        row.title = source["title"]
        row.mode = source["mode"]
        row.blueprint = deepcopy(source["blueprint"])
        row.variants = deepcopy(source["variants"])
        row.stats = deepcopy(source["stats"])

    if exams_present and not replace:
        stale_ids = [row.id for stable, row in existing.items() if stable not in incoming_ids]
        if stale_ids:
            db.execute(delete(LectioExam).where(LectioExam.id.in_(stale_ids)))
    db.flush()
