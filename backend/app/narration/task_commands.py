"""Explicit narration generation commands shared by HTTP actions and task retry.

Own task leases, durable progress and per-page commits; page reads never call these.
"""

from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
import os
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Material, User
from ..teacher_scope import require_scope, teacher_instance_id
from . import audio, calibrate, config, defaults, digest, repository, service, tts, voices
from . import client as model_client
from .access import require_narratable, teacher_material
from .contracts import AudioRecord, GeneratedPage, SpeechSettings
from .models import NarrationJob
from .request_contracts import AudioBatchInput, GenerateInput, PageGenerateInput, PipelineInput, RangeInput


PIPELINE = ("digest", "calibrate", "apply", "script", "knowledge")
STAGE_LABELS = {
    "digest": "梳理文本",
    "calibrate": "整册校准",
    "apply": "应用修正",
    "script": "生成讲解稿",
    "knowledge": "抽取知识点",
}
_DEFAULT_AUDIO_WORKERS = 4
AUDIO_WORKERS = defaults.worker_count("REBORN_TTS_WORKERS", _DEFAULT_AUDIO_WORKERS)


def _effective_audio_workers(protocol: str) -> int:
    """Pick protocol-appropriate TTS concurrency while honoring env overrides and test monkeypatches."""
    if (os.getenv("REBORN_TTS_WORKERS") or "").strip():
        return defaults.worker_count("REBORN_TTS_WORKERS", AUDIO_WORKERS)
    if AUDIO_WORKERS != _DEFAULT_AUDIO_WORKERS:
        return max(1, AUDIO_WORKERS)
    if protocol == "dashscope":
        return 6
    if protocol == "deepseek":
        return 2
    return _DEFAULT_AUDIO_WORKERS


def generate_narration(
    page_no: int, course_id: int, material_id: int, db: Session, user: User, body: PageGenerateInput | None = None
) -> GeneratedPage:
    """One explicit authoring request = at most one model call. Never runs on page turns."""
    instance_id = teacher_instance_id(db, user, course_id)
    material = require_scope(db.get(Material, material_id), instance_id)
    require_narratable(material)
    repository.sync_staleness(db, material)
    db.commit()
    with repository.task(
        db, material, "generate", user, request={"operation": "generate_page", "page_no": page_no, "body": body.model_dump() if body else {}}
    ):
        try:
            result = service.generate_page(
                db,
                material,
                page_no,
                instance_id=instance_id,
                target_seconds=body.target_seconds if body else None,
                style_preset=body.style_preset if body else "natural",
                custom_style=body.custom_style if body else "",
                section_minutes=body.section_minutes if body else None,
                chapter_minutes=body.chapter_minutes if body else None,
                use_pacing=body.use_pacing if body else False,
            )
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


def generate_range(course_id: int, material_id: int, body: GenerateInput, db: Session, user: User) -> NarrationJob:
    """Queue the batch; the worker generates it page by page so the browser can walk away."""
    instance_id = teacher_instance_id(db, user, course_id)
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


def run_generate_range(db: Session, material: Material, request: dict[str, Any], *,
                       chained: bool = False, extra: dict[str, Any] | None = None) -> bool:
    """Worker side: each page commits on its own, so a failure keeps earlier pages."""
    body = GenerateInput(**request["body"])
    instance_id = material.course_instance_id
    if instance_id is None:
        repository.release(db, material.id, status="failed", message="资料未关联课程，请刷新后重试", extra=extra)
        return False
    try:
        results = service.generate_range(
            db,
            material,
            first=body.first_page,
            last=body.last_page,
            instance_id=instance_id,
            target_seconds=body.target_seconds,
            only_pages=request.get("only_pages"),
            style_preset=body.style_preset,
            custom_style=body.custom_style,
            section_minutes=body.section_minutes,
            chapter_minutes=body.chapter_minutes,
            use_pacing=body.use_pacing,
        )
    except (service.NarrationUnavailable, LookupError, ValueError) as exc:
        repository.release(db, material.id, status="failed", message=str(exc), extra=extra)
        return False
    done = sum(1 for item in results if item.get("status") != "failed")
    failed = [item for item in results if item.get("status") == "failed"]
    if failed:
        repository.release(
            db,
            material.id,
            status="failed",
            message=f"已生成 {done} 页，失败 {len(failed)} 页",
            extra={"done": len(results), "total": len(results), "failed": failed,
                   "retry_pages": [item["page_no"] for item in failed], **(extra or {})},
        )
        return False
    if chained:
        repository.beat(db, material.id, done=len(results), total=len(results), message=f"已生成 {done} 页")
        db.commit()
        return True
    repository.release(
        db,
        material.id,
        message=f"已生成 {done} 页",
        extra={"done": len(results), "total": len(results), "failed": []},
    )
    return True


def digest_deck(course_id: int, material_id: int, db: Session, user: User) -> NarrationJob:
    """Queue the whole-deck digest; the worker rewrites page_contents window by window."""
    instance_id = teacher_instance_id(db, user, course_id)
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


def run_digest(db: Session, material: Material, request: dict[str, Any], *,
               chained: bool = False, extra: dict[str, Any] | None = None) -> bool:
    """Worker side: 整理还没整理或原文已变的页；每窗落库，失败保留已完成部分。"""
    settings = config.settings(db)
    effort = settings["effort"] or "none"
    groups = digest.pending_windows(db, material, settings, effort)
    total = len(groups)
    if total == 0:
        if chained:
            repository.beat(db, material.id, done=0, total=0, message="原文已整理")
            db.commit()
            return True
        repository.release(db, material.id, message="原文已是整理稿，无需重跑", extra={"done": 0, "total": 0})
        return True
    repository.beat(db, material.id, done=0, total=total)
    db.commit()
    written: list[int] = []
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "cache_hit_tokens": 0, "cache_miss_tokens": 0}
    use_parallel = digest.run_window is digest._DEFAULT_RUN_WINDOW and digest.WINDOW_WORKERS > 1 and total > 1
    if not use_parallel:
        for index, group in enumerate(groups, start=1):
            repository.check_cancel(db, material.id)
            repository.beat(db, material.id, done=index - 1, total=total,
                            checkpoint={"group": index, "pages": group})
            db.commit()
            repository.ensure_lease(db, material.id)
            try:
                pages, spent = digest.run_window(db, material, group, settings, effort)
                written.extend(pages)
                for key in usage:
                    usage[key] += spent.get(key, 0)
            except (model_client.ModelFailed, ValueError) as exc:
                repository.release(db, material.id, status="failed", message=str(exc), extra={
                    "done": index - 1, "total": total,
                    "failed": [{"page_no": page_no, "error": str(exc)[:200]} for page_no in group],
                    **(extra or {})})
                return False
            repository.beat(db, material.id, done=index, total=total, message=f"第 {group[0]} 页", checkpoint={})
            db.commit()
    else:
        workers = digest.WINDOW_WORKERS
        completed = 0
        for start in range(0, total, workers):
            batch = groups[start:start + workers]
            repository.check_cancel(db, material.id)
            repository.ensure_lease(db, material.id)
            batch_pages = [no for grp in batch for no in grp]
            repository.beat(db, material.id, done=completed, total=total,
                            checkpoint={"group": start + 1, "pages": batch_pages[:digest.WINDOW * 2]})
            db.commit()

            prepared = []
            try:
                for group in batch:
                    content, states, images, per_page = digest.prepare_window(db, material, group)
                    prepared.append((group, content, states, images, per_page))
            except ValueError as exc:
                failed_group = batch[len(prepared)]
                repository.release(db, material.id, status="failed", message=str(exc), extra={
                    "done": completed, "total": total,
                    "failed": [{"page_no": page_no, "error": str(exc)[:200]} for page_no in failed_group],
                    **(extra or {})})
                return False

            material_title = material.title
            outcomes: list[tuple[list[dict[str, Any]] | None, dict[str, int], str, BaseException | None]] = []
            with ThreadPoolExecutor(max_workers=len(prepared)) as pool:
                futs = [
                    pool.submit(digest.call_window, material_title, group, content, images, settings, effort, per_page=per_page)
                    for group, content, _, images, per_page in prepared
                ]
                for fut in futs:
                    try:
                        pages_res, spent, model_name = fut.result()
                        outcomes.append((pages_res, spent, model_name, None))
                    except BaseException as exc:  # noqa: BLE001
                        outcomes.append((None, {}, "", exc))

            for (group, _, states, _, _), (pages_out, spent, model_name, err) in zip(prepared, outcomes):
                if err is not None:
                    if isinstance(err, (model_client.ModelFailed, ValueError)):
                        repository.release(db, material.id, status="failed", message=str(err), extra={
                            "done": completed, "total": total,
                            "failed": [{"page_no": page_no, "error": str(err)[:200]} for page_no in group],
                            **(extra or {})})
                        return False
                    raise err
                assert pages_out is not None
                repository.ensure_lease(db, material.id)
                pages = digest.commit_window(db, material, pages_out, states, model_name, settings, effort)
                written.extend(pages)
                for key in usage:
                    usage[key] += spent.get(key, 0)
                completed += 1
                repository.beat(db, material.id, done=completed, total=total, message=f"第 {group[0]} 页", checkpoint={})
                db.commit()
    if chained:
        repository.beat(db, material.id, done=total, total=total, message=f"已整理 {len(written)} 页")
        db.commit()
        return True
    repository.release(db, material.id, message=f"已整理 {len(written)} 页",
                       extra={"done": total, "total": total, "usage": usage})
    return True


def calibrate_deck(course_id: int, material_id: int, db: Session, user: User) -> NarrationJob:
    """Queue the whole-deck walk; the report row is the cursor, so a restart resumes."""
    instance_id = teacher_instance_id(db, user, course_id)
    material = require_scope(db.get(Material, material_id), instance_id)
    require_narratable(material)
    repository.sync_staleness(db, material)
    db.commit()
    # 没有草稿就没必要排队：老师在点击时直接看到原因，而不是一个必定失败的后台任务。
    if not calibrate.participating(db, material):
        raise HTTPException(404, "没有可校准的整理稿，请先梳理文本")
    return repository.enqueue(db, material, "calibrate", user, request={"operation": "calibrate"})


def run_calibration(db: Session, material: Material, *,
                    chained: bool = False, extra: dict[str, Any] | None = None) -> bool:
    """Worker side: walk slice by slice until the report is complete."""
    report: dict[str, Any] = {}
    before = -1
    while True:
        try:
            row, reused, _ = calibrate.run_slice(db, material)
        except model_client.ModelUnavailable as exc:
            repository.release(db, material.id, status="failed", message=str(exc), extra=extra)
            return False
        except (model_client.ModelFailed, RuntimeError, LookupError, ValueError) as exc:
            repository.release(db, material.id, status="failed", message=str(exc), extra=extra)
            return False
        report = dict(row.report or {})
        repository.beat(db, material.id, done=report.get("windows_done", 0), total=report.get("windows", 0),
                        message=f"第 {report.get('windows_done', 0)}/{report.get('windows', 0)} 个窗口", checkpoint={})
        db.commit()
        if reused or report.get("complete"):
            if reused:
                # 整册输入未变：报告直接复用，前端要能看出这一轮没花钱。
                report = {**report, "reused": True}
                row.report = report
                db.commit()
            break
        if report.get("windows_done", 0) <= before:
            repository.release(db, material.id, status="failed", message="校准没有前进，请刷新后重试", extra=extra)
            return False
        before = report.get("windows_done", 0)
    if chained:
        repository.beat(db, material.id, done=report.get("windows_done", 0), total=report.get("windows", 0),
                        message="校准完成")
        db.commit()
        return True
    repository.release(db, material.id, message="校准完成",
                       extra={"done": report.get("windows_done", 0), "total": report.get("windows", 0)})
    return True


def pipeline_deck(course_id: int, material_id: int, db: Session, user: User,
                  body: PipelineInput | None = None,
                  resume: dict[str, Any] | None = None) -> NarrationJob:
    """Queue 梳理 → 校准 → 应用 → 讲解稿 as one task; 老师只点一次。"""
    instance_id = teacher_instance_id(db, user, course_id)
    material = require_scope(db.get(Material, material_id), instance_id)
    require_narratable(material)
    repository.sync_staleness(db, material)
    repository.sync_content_staleness(db, material)
    db.commit()
    pages = repository.page_map(material)
    if not pages:
        raise HTTPException(409, "资料还没有可整理的页面")
    reason = config.unavailable_reason(db)
    if reason:
        # 未配置就当场告知，不留一个必定失败的后台任务。
        raise HTTPException(409, reason)
    resume = resume or {}
    chain = list(resume.get("chain") or PIPELINE)
    extra_opts: dict[str, Any] = body.model_dump(exclude_none=True) if body is not None else {}
    req_body: dict[str, Any] = dict(resume.get("body") or {"first_page": 1, "last_page": max(pages), **extra_opts})
    return repository.enqueue(db, material, "pipeline", user, request={
        "operation": "pipeline", "body": req_body, "chain": chain,
        "only_pages": db.info.get("narration_retry_pages") or resume.get("only_pages")})


def _apply_latest(db: Session, material: Material, extra: dict[str, Any] | None) -> bool:
    entry = calibrate.latest_any(db, material.id)
    if entry is None or not (entry.report or {}).get("complete", True):
        repository.release(db, material.id, status="failed", message="校准报告不完整，不能应用", extra=extra)
        return False
    try:
        applied = calibrate.apply_report(db, material, entry)
    except (LookupError, ValueError) as exc:
        repository.release(db, material.id, status="failed", message=str(exc), extra=extra)
        return False
    db.commit()
    repository.beat(db, material.id, done=1, total=1, message=f"已应用 {len(applied['applied_fixes'])} 处修正")
    db.commit()
    return True


class _AuthoringKnowledgeLLM:
    """Adapter letting Lectio knowledge extraction reuse narration.client retries and test stubs."""

    def __init__(self, settings: dict[str, Any], *, check_cancel: Any = None) -> None:
        self._settings = settings
        self.model = str(settings.get("model") or "")
        self._check_cancel = check_cancel

    def chat_json(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str | None = None,
        max_tokens: int | None = None,
        effort: str | None = None,
        temperature: float | None = None,
    ) -> tuple[Any, dict[str, Any]]:
        if self._check_cancel is not None:
            self._check_cancel()
        del temperature
        reply = model_client.chat(
            messages,
            settings=self._settings,  # type: ignore[arg-type]
            model=(model or self.model).strip(),
            max_tokens=max_tokens or self._settings["max_tokens"],
            effort=effort or self._settings["effort"] or "none",
            require_text=False,
        )
        return reply["raw"], dict(reply.get("usage") or {})


def _extract_knowledge(db: Session, material: Material, extra: dict[str, Any] | None) -> bool:
    from ..lectio import knowledge_service
    from ..lectio.engine.llm import LLMFailed, LLMUnavailable

    repository.ensure_lease(db, material.id)
    repository.beat(
        db,
        material.id,
        done=0,
        total=1,
        message="正在抽取知识点…",
        checkpoint={"action": "extract_knowledge"},
    )
    db.commit()
    llm = _AuthoringKnowledgeLLM(
        dict(config.settings(db)),
        check_cancel=lambda: repository.check_cancel(db, material.id),
    )
    try:
        result = knowledge_service.extract_material_knowledge(
            db,
            material,
            llm=llm,
            check_cancel=lambda: repository.check_cancel(db, material.id),
        )
    except repository.CancellationRequested:
        raise
    except (
        model_client.ModelUnavailable,
        model_client.ModelFailed,
        LLMUnavailable,
        LLMFailed,
        RuntimeError,
        LookupError,
        ValueError,
    ) as exc:
        db.rollback()
        repository.release(db, material.id, status="failed", message=str(exc), extra=extra)
        return False
    if result.get("skipped"):
        note = str(result.get("reason") or "已跳过知识点抽取")
    else:
        note = f"已抽取 {result['total_extracted']} 个知识点（新增 {result['created']}，更新 {result['updated']}）"
    repository.beat(db, material.id, done=1, total=1, message=note, checkpoint={})
    db.commit()
    return True


def run_pipeline(db: Session, material: Material, request: dict[str, Any]) -> None:
    """Worker side: 逐段执行链；失败停在原地，重试从这一段继续。"""
    chain = list(request.get("chain") or PIPELINE)
    pages = repository.page_map(material)
    if not pages:
        repository.release(db, material.id, status="failed", message="资料还没有可整理的页面")
        return
    while chain:
        repository.check_cancel(db, material.id)
        stage = chain[0]
        remaining = {"chain": chain, "stage": stage, "failed_stage": stage}
        repository.set_chain(db, material.id, chain, stage)
        repository.beat(db, material.id, message=f"{STAGE_LABELS.get(stage, stage)}…",
                        total=1 if stage in {"apply", "knowledge"} else 0)
        db.commit()
        if stage == "digest":
            ok = run_digest(db, material, request, chained=True, extra=remaining)
        elif stage == "calibrate":
            ok = run_calibration(db, material, chained=True, extra=remaining)
        elif stage == "apply":
            ok = _apply_latest(db, material, remaining)
        elif stage == "script":
            body = {**(request.get("body") or {}), "first_page": 1, "last_page": max(pages)}
            ok = run_generate_range(db, material, {"body": body, "only_pages": request.get("only_pages")},
                                    chained=True, extra=remaining)
        elif stage == "knowledge":
            ok = _extract_knowledge(db, material, remaining)
        else:
            repository.release(db, material.id, status="failed", message=f"未知阶段 {stage}", extra=remaining)
            return
        if not ok:
            return
        chain.pop(0)
        repository.set_chain(db, material.id, chain, chain[0] if chain else "done")
        db.commit()
    repository.release(db, material.id, message="梳理、校准、讲解稿与知识点已完成", extra={"done": 1, "total": 1})


def synthesize_audio(
    page_no: int,
    course_id: int,
    material_id: int,
    db: Session,
    user: User,
    *,
    force: bool = False,
) -> AudioRecord:
    """Speak one approved page. Draft wording is refused, not spoken."""
    instance_id = teacher_instance_id(db, user, course_id)
    material = require_scope(db.get(Material, material_id), instance_id)
    require_narratable(material)
    repository.sync_staleness(db, material)
    db.commit()
    engine, _ = voices.resolve_material_speech(db, material, user_id=user.id)
    with repository.task(db, material, "audio", user, request={"operation": "audio_page", "page_no": page_no}):
        try:
            result = audio.synthesize_page(
                db,
                material,
                page_no,
                engine_override=engine,
                regenerate_mismatch=True,
                force=force,
            )
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


def synthesize_audio_batch(course_id: int, material_id: int, db: Session, user: User,
                           body: AudioBatchInput | RangeInput | None = None) -> NarrationJob:
    """Queue audio for every accepted page in the range; the worker speaks them."""
    material = teacher_material(db, user, course_id, material_id)
    repository.sync_staleness(db, material)
    db.commit()
    if tts.unavailable_reason(db):
        raise HTTPException(409, tts.unavailable_reason(db) or "语音合成不可用")
    _, voice_meta = voices.resolve_material_speech(db, material, user_id=user.id)
    return repository.enqueue(db, material, "audio", user, request={
        "operation": "audio_batch",
        "body": body.model_dump() if body else {},
        "only_pages": db.info.get("narration_retry_pages"),
        "requested_by": user.id,
        "voice_mode": voice_meta["voice_mode"],
        "teacher_voice_id": voice_meta["selected_voice_id"],
    })


def run_audio_batch(db: Session, material: Material, request: dict[str, Any]) -> None:
    """Worker side: sliding-window concurrent TTS pool so slow pages never stall faster slots."""
    body = request.get("body") or {}
    only_pages = request.get("only_pages")
    reason = tts.unavailable_reason(db)
    if reason:
        repository.release(db, material.id, status="failed", message=reason)
        return
    resolved_engine, _ = voices.resolve_material_speech(
        db,
        material,
        user_id=request.get("requested_by"),
        explicit_voice_id=request.get("teacher_voice_id"),
        explicit_mode=request.get("voice_mode"),
    )
    regenerate_mismatch = bool(body.get("regenerate_mismatch"))
    force_regen = bool(body.get("force"))
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
    total = len(wanted)
    repository.beat(db, material.id, done=0, total=total)
    db.commit()
    workers = _effective_audio_workers(resolved_engine["protocol"])
    pending_pages = [item.page_no for item in wanted]
    cursor = 0

    def _beat_progress(message: str, in_flight: list[int]) -> None:
        repository.beat(
            db,
            material.id,
            done=len(made) + len(reused) + len(failed),
            total=total,
            message=message,
            checkpoint={"pages": sorted(in_flight)} if in_flight else {},
        )
        db.commit()

    def _fill_slots(
        pool: ThreadPoolExecutor,
        in_flight: dict[Future[tuple[bytes, str, int]], tuple[int, str, SpeechSettings]],
    ) -> None:
        nonlocal cursor
        while cursor < len(pending_pages) and len(in_flight) < workers:
            repository.check_cancel(db, material.id)
            page_no = pending_pages[cursor]
            cursor += 1
            try:
                reused_rec, pending = audio.prepare_page_tts(
                    db,
                    material,
                    page_no,
                    engine_override=resolved_engine,
                    regenerate_mismatch=regenerate_mismatch,
                    force=force_regen,
                )
            except (tts.SpeechFailed, tts.SpeechUnavailable, ValueError, LookupError) as exc:
                db.rollback()
                failed.append({"page_no": page_no, "error": str(exc)[:160]})
                _beat_progress(f"音频第 {page_no} 页", [meta[0] for meta in in_flight.values()])
                continue
            if reused_rec is not None:
                reused.append(page_no)
                _beat_progress(f"音频第 {page_no} 页", [meta[0] for meta in in_flight.values()])
                continue
            assert pending is not None
            text, text_digest, engine = pending
            fut = pool.submit(audio.synthesize_audio_bytes, text, engine)
            in_flight[fut] = (page_no, text_digest, engine)
        if in_flight:
            repository.beat(db, material.id, checkpoint={"pages": sorted(meta[0] for meta in in_flight.values())})
            db.commit()

    pool = ThreadPoolExecutor(max_workers=max(1, min(workers, max(1, total))))
    in_flight: dict[Future[tuple[bytes, str, int]], tuple[int, str, SpeechSettings]] = {}
    try:
        _fill_slots(pool, in_flight)
        while in_flight:
            done_futs, _ = wait(in_flight.keys(), return_when=FIRST_COMPLETED)
            for fut in done_futs:
                page_no, text_digest, engine_used = in_flight.pop(fut)
                try:
                    payload, fmt, secs = fut.result()
                    audio.commit_synthesized_page(
                        db,
                        material,
                        page_no,
                        text_digest,
                        payload,
                        fmt,
                        secs,
                        voice=engine_used["voice"],
                        model=engine_used["model"],
                        force=force_regen,
                    )
                    made.append(page_no)
                except (tts.SpeechFailed, tts.SpeechUnavailable, ValueError, LookupError) as exc:
                    db.rollback()
                    failed.append({"page_no": page_no, "error": str(exc)[:160]})
                _beat_progress(f"音频第 {page_no} 页", [meta[0] for meta in in_flight.values()])
            repository.check_cancel(db, material.id)
            _fill_slots(pool, in_flight)
    except BaseException:
        pool.shutdown(wait=False, cancel_futures=True)
        raise
    else:
        pool.shutdown(wait=True)

    repository.release(
        db,
        material.id,
        status="failed" if failed else "done",
        message=f"音频完成 {len(made) + len(reused)} 页，失败 {len(failed)} 页",
        extra={
            "done": len(made) + len(reused) + len(failed),
            "total": total,
            "failed": failed,
            "retry_pages": [item["page_no"] for item in failed],
        },
    )
