"""Explicit narration generation commands shared by HTTP actions and task retry.

Own task leases, durable progress and per-page commits; page reads never call these.
"""

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Material, User
from ..teacher_scope import require_scope, teacher_instance_id
from . import audio, calibrate, config, digest, repository, service, tts
from . import client as model_client
from .access import require_narratable, teacher_material
from .contracts import AudioRecord, GeneratedPage
from .models import NarrationJob
from .request_contracts import GenerateInput, PageGenerateInput, RangeInput


def generate_narration(
    page_no: int, classroom_id: int, material_id: int, db: Session, user: User, body: PageGenerateInput | None = None
) -> GeneratedPage:
    """One explicit authoring request = at most one model call. Never runs on page turns."""
    instance_id = teacher_instance_id(db, user, classroom_id)
    material = require_scope(db.get(Material, material_id), instance_id)
    require_narratable(material)
    repository.sync_staleness(db, material)
    db.commit()
    with repository.task(
        db, material, "generate", user, request={"operation": "generate_page", "page_no": page_no, "body": body.model_dump() if body else {}}
    ):
        try:
            result = service.generate_page(db, material, page_no, instance_id=instance_id, target_seconds=body.target_seconds if body else None)
        except service.NarrationUnavailable as exc:
            raise HTTPException(409, str(exc)) from exc
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except model_client.ModelUnavailable as exc:
            raise HTTPException(409, str(exc)) from exc
        except model_client.ModelFailed as exc:
            repository.release(db, material.id, status="failed", message=str(exc))
            raise HTTPException(502, str(exc)) from exc
        except Exception:
            repository.release(db, material.id, status="failed", message="生成本页失败")
            raise
        db.commit()
        repository.release(db, material.id, message="本页已生成")
        return result


def generate_range(classroom_id: int, material_id: int, body: GenerateInput, db: Session, user: User) -> NarrationJob:
    """Queue the batch; the worker generates it page by page so the browser can walk away."""
    instance_id = teacher_instance_id(db, user, classroom_id)
    material = require_scope(db.get(Material, material_id), instance_id)
    require_narratable(material)
    repository.sync_staleness(db, material)
    db.commit()
    if body.first_page < 1 or body.last_page < body.first_page:
        raise HTTPException(422, "页码范围无效")
    reason = config.unavailable_reason(db)
    if reason:
        # 未配置就当场告知，不留一个必定失败的后台任务。
        raise HTTPException(409, reason)
    return repository.enqueue(db, material, "generate", user, request={
        "operation": "generate_range", "body": body.model_dump(), "only_pages": db.info.get("narration_retry_pages")})


def run_generate_range(db: Session, material: Material, request: dict[str, Any]) -> None:
    """Worker side: each page commits on its own, so a failure keeps earlier pages."""
    body = GenerateInput(**request["body"])
    instance_id = material.course_instance_id
    if instance_id is None:
        repository.release(db, material.id, status="failed", message="资料不属于当前班级，请刷新后重试")
        return
    try:
        results = service.generate_range(
            db,
            material,
            first=body.first_page,
            last=body.last_page,
            instance_id=instance_id,
            target_seconds=body.target_seconds,
            only_pages=request.get("only_pages"),
        )
    except (service.NarrationUnavailable, LookupError, ValueError) as exc:
        repository.release(db, material.id, status="failed", message=str(exc))
        return
    done = sum(1 for item in results if item.get("status") != "failed")
    failed = [item for item in results if item.get("status") == "failed"]
    repository.release(
        db,
        material.id,
        status="failed" if failed else "done",
        message=f"已生成 {done} 页，失败 {len(failed)} 页" if failed else f"已生成 {done} 页",
        extra={"done": len(results), "total": len(results), "failed": failed,
               "retry_pages": [item["page_no"] for item in failed]},
    )


def digest_deck(classroom_id: int, material_id: int, db: Session, user: User) -> NarrationJob:
    """Queue the whole-deck digest; the worker rewrites page_contents window by window."""
    instance_id = teacher_instance_id(db, user, classroom_id)
    material = require_scope(db.get(Material, material_id), instance_id)
    require_narratable(material)
    repository.sync_staleness(db, material)
    repository.sync_content_staleness(db, material)
    db.commit()
    if not repository.page_map(material):
        raise HTTPException(409, "资料还没有可整理的页面")
    reason = config.unavailable_reason(db)
    if reason:
        # 未配置就当场告知，不留一个必定失败的后台任务。
        raise HTTPException(409, reason)
    return repository.enqueue(db, material, "digest", user, request={"operation": "digest"})


def run_digest(db: Session, material: Material, request: dict[str, Any]) -> None:
    """Worker side: 整理还没整理或原文已变的页；每窗落库，失败保留已完成部分。"""
    settings = config.settings(db)
    effort = settings["effort"] or "none"
    groups = digest.pending_windows(db, material, settings, effort)
    total = len(groups)
    if total == 0:
        repository.release(db, material.id, message="原文已是整理稿，无需重跑", extra={"done": 0, "total": 0})
        return
    repository.beat(db, material.id, done=0, total=total)
    db.commit()
    written: list[int] = []
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "cache_hit_tokens": 0, "cache_miss_tokens": 0}
    for index, group in enumerate(groups, start=1):
        repository.ensure_lease(db, material.id)
        try:
            pages, spent = digest.run_window(db, material, group, settings, effort)
            written.extend(pages)
            for key in usage:
                usage[key] += spent.get(key, 0)
        except (model_client.ModelFailed, ValueError) as exc:
            repository.release(db, material.id, status="failed", message=str(exc), extra={
                "done": index - 1, "total": total,
                "failed": [{"page_no": page_no, "error": str(exc)[:200]} for page_no in group]})
            return
        repository.beat(db, material.id, done=index, total=total, message=f"第 {group[0]} 页")
        db.commit()
    repository.release(db, material.id, message=f"已整理 {len(written)} 页",
                       extra={"done": total, "total": total, "usage": usage})


def calibrate_deck(classroom_id: int, material_id: int, db: Session, user: User) -> NarrationJob:
    """Queue the whole-deck walk; the report row is the cursor, so a restart resumes."""
    instance_id = teacher_instance_id(db, user, classroom_id)
    material = require_scope(db.get(Material, material_id), instance_id)
    require_narratable(material)
    repository.sync_staleness(db, material)
    db.commit()
    # 没有草稿就没必要排队：老师在点击时直接看到原因，而不是一个必定失败的后台任务。
    if not calibrate.participating(db, material):
        raise HTTPException(404, "没有可校准的整理稿，请先梳理文本")
    return repository.enqueue(db, material, "calibrate", user, request={"operation": "calibrate"})


def run_calibration(db: Session, material: Material) -> None:
    """Worker side: walk slice by slice until the report is complete."""
    report: dict[str, Any] = {}
    before = -1
    while True:
        try:
            row, reused, _ = calibrate.run_slice(db, material)
        except model_client.ModelUnavailable as exc:
            repository.release(db, material.id, status="failed", message=str(exc))
            return
        except (model_client.ModelFailed, RuntimeError, LookupError, ValueError) as exc:
            repository.release(db, material.id, status="failed", message=str(exc))
            return
        report = dict(row.report or {})
        repository.beat(db, material.id, done=report.get("windows_done", 0), total=report.get("windows", 0),
                        message=f"第 {report.get('windows_done', 0)}/{report.get('windows', 0)} 个窗口")
        db.commit()
        if reused or report.get("complete"):
            if reused:
                # 整册输入未变：报告直接复用，前端要能看出这一轮没花钱。
                report = {**report, "reused": True}
                row.report = report
                db.commit()
            break
        if report.get("windows_done", 0) <= before:
            repository.release(db, material.id, status="failed", message="校准没有前进，请刷新后重试")
            return
        before = report.get("windows_done", 0)
    repository.release(db, material.id, message="校准完成",
                       extra={"done": report.get("windows_done", 0), "total": report.get("windows", 0)})


def synthesize_audio(page_no: int, classroom_id: int, material_id: int, db: Session, user: User) -> AudioRecord:
    """Speak one approved page. Draft wording is refused, not spoken."""
    instance_id = teacher_instance_id(db, user, classroom_id)
    material = require_scope(db.get(Material, material_id), instance_id)
    require_narratable(material)
    repository.sync_staleness(db, material)
    db.commit()
    with repository.task(db, material, "audio", user, request={"operation": "audio_page", "page_no": page_no}):
        try:
            result = audio.synthesize_page(db, material, page_no)
        except tts.SpeechUnavailable as exc:
            repository.release(db, material.id, status="failed", message=str(exc))
            raise HTTPException(409, str(exc)) from exc
        except tts.SpeechFailed as exc:
            repository.release(db, material.id, status="failed", message=str(exc))
            raise HTTPException(502, str(exc)) from exc
        except LookupError as exc:
            repository.release(db, material.id, status="failed", message=str(exc))
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            repository.release(db, material.id, status="failed", message=str(exc))
            raise HTTPException(409, str(exc)) from exc
        db.commit()
        repository.release(db, material.id, message="本页音频已生成")
        return result


def synthesize_audio_batch(classroom_id: int, material_id: int, db: Session, user: User,
                           body: RangeInput | None = None) -> NarrationJob:
    """Queue audio for every accepted page in the range; the worker speaks them."""
    material = teacher_material(db, user, classroom_id, material_id)
    repository.sync_staleness(db, material)
    db.commit()
    if tts.unavailable_reason(db):
        raise HTTPException(409, tts.unavailable_reason(db) or "语音合成不可用")
    return repository.enqueue(db, material, "audio", user, request={
        "operation": "audio_batch", "body": body.model_dump() if body else {},
        "only_pages": db.info.get("narration_retry_pages")})


def run_audio_batch(db: Session, material: Material, request: dict[str, Any]) -> None:
    """Worker side: one failure must not abort the rest."""
    body = request.get("body") or {}
    only_pages = request.get("only_pages")
    reason = tts.unavailable_reason(db)
    if reason:
        repository.release(db, material.id, status="failed", message=reason)
        return
    first = body.get("first_page") or 1
    last = body.get("last_page") or 10**9
    made: list[int] = []
    reused: list[int] = []
    failed: list[dict[str, Any]] = []
    wanted = [
        item
        for item in repository.rows(db, material.id)
        if first <= item.page_no <= last
        and item.status == "accepted"
        and item.text.strip()
        and (only_pages is None or item.page_no in only_pages)
    ]
    repository.beat(db, material.id, done=0, total=len(wanted))
    db.commit()
    for item in repository.rows(db, material.id):
        if (item.page_no < first or item.page_no > last
                or (only_pages is not None and item.page_no not in only_pages)):
            continue
        if item.status != "accepted" or not item.text.strip():
            continue
        try:
            result = audio.synthesize_page(db, material, item.page_no)
            (reused if result["reused"] else made).append(item.page_no)
            repository.beat(db, material.id, done=len(made) + len(reused) + len(failed), total=len(wanted),
                            message=f"音频第 {item.page_no} 页")
            db.commit()
        except (tts.SpeechFailed, ValueError, LookupError) as exc:
            db.rollback()
            failed.append({"page_no": item.page_no, "error": str(exc)[:160]})
            repository.beat(db, material.id, done=len(made) + len(reused) + len(failed), total=len(wanted))
            db.commit()
    repository.release(
        db,
        material.id,
        status="failed" if failed else "done",
        message=f"音频完成 {len(made) + len(reused)} 页，失败 {len(failed)} 页",
        extra={
            "done": len(made) + len(reused) + len(failed),
            "total": len(wanted),
            "failed": failed,
            "retry_pages": [item["page_no"] for item in failed],
        },
    )