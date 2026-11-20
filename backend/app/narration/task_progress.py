"""Describe what this attempt actually recorded, including older group counters."""
import re
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import calibrate
from .models import NarrationCalibration, NarrationJob, NarrationRun

OPERATION_STAGE = {"generate_page": "script", "generate_range": "script", "audio_page": "audio",
                   "audio_batch": "audio", "calibrate": "calibrate", "digest": "digest"}


def safe_message(message: str) -> str:
    # Earlier versions copied arbitrary provider response text after the HTTP code.
    legacy = re.match(r"^作者期模型返回 (\d{3})(?:[：:]|$)", message)
    return f"作者期模型请求未成功（HTTP {legacy[1]}）" if legacy else message


def page_label(pages: list[int]) -> str:
    if not pages:
        return ""
    if len(pages) > 1 and all(right == left + 1 for left, right in zip(pages, pages[1:])):
        return f"第 {pages[0]}–{pages[-1]} 页"
    return "第 " + "、".join(map(str, pages)) + " 页"


def legacy_calibration_pages(db: Session, job: NarrationJob | NarrationRun, done: int, total: int) -> list[int]:
    """The worker resumes only the latest incomplete report; bind its cursor to the latest attempt."""
    if not job.started_at or not (end := job.finished_at or job.heartbeat_at):
        return []
    row = db.scalar(select(NarrationCalibration).where(NarrationCalibration.material_id == job.material_id)
                    .order_by(NarrationCalibration.id.desc()).limit(1))
    def utc(stamp: datetime) -> datetime:
        # SQLite reloads UTC without tzinfo; PostgreSQL returns aware timestamps.
        return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)

    if not row or utc(row.created_at) > utc(end):
        return []
    if utc(row.created_at) < utc(job.started_at):
        previous = db.scalar(select(NarrationRun).where(NarrationRun.material_id == job.material_id,
            NarrationRun.started_at < job.started_at).order_by(NarrationRun.started_at.desc()).limit(1))
        prior = (previous.progress or {}) if previous else {}
        if (not previous or not previous.started_at or not previous.finished_at or
                not (utc(previous.started_at) <= utc(row.created_at) <= utc(previous.finished_at) <= utc(job.started_at)) or
                (previous.kind != "calibrate" and prior.get("stage") != "calibrate") or prior.get("total") != total
                or not 0 <= prior.get("done", total) < done):
            return []
    report = row.report or {}
    if (report.get("complete") is not False or report.get("calibrate_version") != calibrate.CALIBRATE_VERSION
            or report.get("next_index") != done or report.get("windows_done") != done or report.get("windows") != total):
        return []
    revisions = report.get("revisions")
    if not isinstance(revisions, dict) or not all(str(key).isdecimal() for key in revisions):
        return []
    pages = sorted(int(key) for key in revisions)
    width = calibrate.WINDOW
    if (len(pages) != report.get("pages") or (len(pages) + width - 1) // width != total
            or report.get("pages_seen") != done * width):
        return []
    return pages[done * width:(done + 1) * width]


def describe(job: NarrationJob | NarrationRun | None, status: str, latest_db: Session | None) -> dict[str, Any]:
    progress = (job.progress or {}) if job else {}
    request = progress.get("request") or {}
    operation = request.get("operation") or ""
    kind = job.kind if job else ""
    stage = progress.get("failed_stage") or progress.get("stage") or OPERATION_STAGE.get(operation)
    if not stage and kind in {"calibrate", "digest", "audio"}:
        stage = kind
    chain = [step for step in request.get("chain") or [] if step in ("digest", "calibrate", "apply", "script")]
    done, total = progress.get("done", 0), progress.get("total", 0)
    failed = [{**item, "error": safe_message(str(item.get("error") or ""))}
              for item in progress.get("failed", []) if isinstance(item, dict)]
    unit = None
    if stage in {"digest", "calibrate"}:
        unit = "groups"
    elif stage == "script":
        unit = "pages" if operation == "generate_page" or status == "done" or "retry_pages" in progress else "groups"
    elif stage == "audio":
        unit = "pages"
    elif stage in {"apply", "done"}:
        unit = "steps"
    checkpoint = progress.get("checkpoint") or {}
    position = ""
    pages = [item["page_no"] for item in failed if isinstance(item.get("page_no"), int)]
    if pages:
        position = "失败页：" + page_label(pages[:12]) + (f"（共 {len(pages)} 页）" if len(pages) > 12 else "")
    elif checkpoint.get("action") == "merge_tags":
        position = "各组已校准，正在合并整册标签" if status in {"running", "cancelling"} else "合并整册标签"
    elif checkpoint.get("pages"):
        position = (f"第 {checkpoint['group']} 组 · " if checkpoint.get("group") else "") + page_label(checkpoint["pages"])
    elif request.get("page_no"):
        position = page_label([request["page_no"]])
    elif (stage in {"digest", "calibrate", "script"} and unit == "groups" and 0 <= done < total
          and status in {"failed", "interrupted"}):
        position = f"已完成 {done} 组，下一组为第 {done + 1} 组"
        if stage == "calibrate" and job and latest_db and "checkpoint" not in progress:
            label = page_label(legacy_calibration_pages(latest_db, job, done, total))
            if label:
                position += " · " + label
    queued = bool(status == "running" and progress.get("queued"))
    message = safe_message(job.message or "") if job else ""
    diagnostic = ""
    if status in {"failed", "interrupted"}:
        diagnostic = message
        if message == "作者期模型请求失败，请稍后重试":
            diagnostic = "未收到可用响应。旧记录未细分连接、代理或传输协议错误。"
        elif message == "语音合成请求失败，请稍后重试":
            diagnostic = "未收到可用响应。旧记录未区分网络连接、传输或超时原因。"
    return {"stage": stage or "", "stages": chain, "stage_index": chain.index(stage) + 1 if stage in chain else None,
            "stage_total": len(chain) or None, "progress_unit": unit, "position": position, "queued": queued,
            "percent": max(0, min(100, round(100 * done / total))) if total else 0 if queued else None,
            "diagnostic": diagnostic, "message": message, "failed": failed, "done": done, "total": total}
