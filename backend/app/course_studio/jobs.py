"""Persistent database-backed async job queue and worker for Course Studio tasks."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..auth import as_utc
from ..course_content.review_catalog import visible
from ..db import SessionLocal
from ..models import Question, User, now
from .models import CourseStudioJob

log = logging.getLogger("course_studio.jobs")

POLL_SECONDS = 2
CONCURRENCY = 2
ACTIVE_STATUSES = ("queued", "running")


def has_active_course_jobs(db: Session, course_id: int) -> bool:
    jobs = select(CourseStudioJob.id).where(CourseStudioJob.course_instance_id == course_id, CourseStudioJob.status.in_(ACTIVE_STATUSES))
    return bool(db.scalar(select(jobs.exists())))


class JobCancelled(RuntimeError):
    """Raised inside a job handler when cancellation is requested."""


JobHandler = Callable[[Session, CourseStudioJob], dict[str, Any] | None]
_HANDLERS: dict[str, JobHandler] = {}


def register_handler(kind: str, handler: JobHandler) -> None:
    """Register an execution handler for a Course Studio job kind."""
    _HANDLERS[kind] = handler


def serialize_job(job: CourseStudioJob) -> dict[str, Any]:
    """Serialize CourseStudioJob into API-safe JobSnapshot dict."""
    prog = job.progress if isinstance(job.progress, dict) else {}
    return {
        "id": job.id,
        "course_instance_id": job.course_instance_id,
        "kind": job.kind,
        "scope_key": job.scope_key,
        "status": job.status,
        "progress": {
            "done": int(prog.get("done") or 0),
            "total": int(prog.get("total") or 0),
            "message": str(prog.get("message") or ""),
        },
        "result": job.result,
        "error": job.error or "",
        "cancel_requested": job.cancel_requested_at is not None,
        "started_at": as_utc(job.started_at).isoformat() if job.started_at else None,
        "finished_at": as_utc(job.finished_at).isoformat() if job.finished_at else None,
        "created_at": as_utc(job.created_at).isoformat(),
        "updated_at": as_utc(job.updated_at).isoformat(),
    }


def output_questions(db: Session, job: CourseStudioJob, user: User) -> list[dict[str, str]]:
    ids = job.result.get("question_ids") if isinstance(job.result, dict) else None
    if not isinstance(ids, list):
        return []
    question_ids = [qid for qid in ids if isinstance(qid, str)]
    if not question_ids:
        return []
    query = select(Question.id, Question.title).where(
        *visible(Question, job.course_instance_id, user), Question.id.in_(question_ids))
    titles = {qid: title for qid, title in db.execute(query)}
    return [{"id": qid, "title": titles[qid]} for qid in question_ids if qid in titles]


def enqueue_job(
    db: Session,
    *,
    course_instance_id: int,
    kind: str,
    scope_key: str,
    user: User | None = None,
    payload: dict[str, Any] | None = None,
    total: int = 0,
    message: str = "已加入任务队列",
) -> CourseStudioJob:
    """Enqueue a new CourseStudioJob or raise 409 if an active job shares the same scope_key."""
    existing = db.scalar(
        select(CourseStudioJob)
        .where(
            CourseStudioJob.course_instance_id == course_instance_id,
            CourseStudioJob.scope_key == scope_key,
            CourseStudioJob.status.in_(ACTIVE_STATUSES),
        )
        .limit(1)
    )
    if existing is not None:
        raise HTTPException(409, "同类任务正在运行，请等待完成或取消后重试")

    job = CourseStudioJob(
        course_instance_id=course_instance_id,
        kind=kind,
        scope_key=scope_key,
        status="queued",
        requested_by=user.id if user else None,
        payload=dict(payload or {}),
        progress={"done": 0, "total": max(0, int(total)), "message": message},
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def list_jobs(db: Session, course_instance_id: int, *, limit: int = 30, workspace: bool = False) -> list[CourseStudioJob]:
    """List recent jobs and optionally all outstanding work for the course."""
    limit = max(1, min(100, int(limit)))
    base = select(CourseStudioJob).where(CourseStudioJob.course_instance_id == course_instance_id)
    latest = base.order_by(CourseStudioJob.created_at.desc(), CourseStudioJob.id.desc())
    if workspace:
        visible = ~func.coalesce(CourseStudioJob.progress["queue_dismissed"].as_boolean(), False)
        # Outstanding work remains visible even beyond the recent completion window.
        recent = latest.with_only_columns(CourseStudioJob.id).limit(limit)
        return list(db.scalars(latest.where(visible, CourseStudioJob.status.in_(("queued", "running", "failed", "interrupted"))
                                           | CourseStudioJob.id.in_(recent))))
    return list(db.scalars(latest.limit(limit)))


def get_job(db: Session, course_instance_id: int, job_id: str) -> CourseStudioJob:
    """Load one job scoped to course_instance_id or raise HTTP 404."""
    job = db.scalar(
        select(CourseStudioJob).where(CourseStudioJob.id == job_id, CourseStudioJob.course_instance_id == course_instance_id)
    )
    if job is None:
        raise HTTPException(404, "任务不存在或不属于当前课程")
    return job


def request_cancel(db: Session, course_instance_id: int, job_id: str) -> CourseStudioJob:
    """Request cancellation for a queued or running job."""
    job = get_job(db, course_instance_id, job_id)
    if job.status in {"done", "failed", "cancelled", "interrupted"}:
        return job
    timestamp = now()
    job.cancel_requested_at = timestamp
    if job.status == "queued":
        job.status = "cancelled"
        job.finished_at = timestamp
        job.progress = {**(job.progress or {}), "message": "任务已取消"}
    else:
        job.progress = {**(job.progress or {}), "message": "正在取消任务..."}
    db.commit()
    db.refresh(job)
    return job


def check_cancel(db: Session, job_id: str) -> None:
    """Poll database to check if cancellation was requested for job_id."""
    job = db.scalar(
        select(CourseStudioJob).where(CourseStudioJob.id == job_id).execution_options(populate_existing=True)
    )
    if job is None or job.cancel_requested_at is not None or job.status == "cancelled":
        raise JobCancelled("任务已取消")


def update_progress(
    db: Session,
    job_id: str,
    *,
    done: int | None = None,
    total: int | None = None,
    message: str | None = None,
    result: dict[str, Any] | None = None,
) -> None:
    """Update heartbeat, progress fields, and optional partial result for a running job."""
    job = db.scalar(
        select(CourseStudioJob).where(CourseStudioJob.id == job_id).execution_options(populate_existing=True)
    )
    if job is None or job.status != "running":
        return
    job.heartbeat_at = now()
    prog = dict(job.progress or {})
    if done is not None:
        prog["done"] = int(done)
    if total is not None:
        prog["total"] = int(total)
    if message is not None:
        prog["message"] = str(message)[:200]
    job.progress = prog
    if result is not None:
        job.result = dict(result)
    db.commit()


def _partial_termination_message(job: CourseStudioJob, verb: str, fallback: str) -> str:
    if job.kind in {"exercises_generate", "coding_exercises_generate", "exam_fill_gaps"} and isinstance(job.result, dict) and "created" in job.result:
        created = int(job.result.get("created") or 0)
        skipped = int(job.result.get("skipped") or 0)
        if created > 0:
            extra = f"（跳过重复或无效 {skipped} 道）" if skipped > 0 else ""
            return f"{verb}前已生成并入库 {created} 道待审题目{extra}"
        return f"{verb}前未入库新题目"
    return fallback


def interrupt_running(db: Session | None = None) -> int:
    """Mark leftover queued/running jobs interrupted or cancelled on server startup."""
    session = db or SessionLocal()
    try:
        jobs = list(session.scalars(select(CourseStudioJob).where(CourseStudioJob.status.in_(ACTIVE_STATUSES))))
        finished = now()
        for job in jobs:
            prog = dict(job.progress or {})
            if job.cancel_requested_at is not None:
                job.status = "cancelled"
                job.error = "服务重启，取消请求已生效"
                prog["message"] = _partial_termination_message(job, "取消", "任务已取消")
            else:
                job.status = "interrupted"
                job.error = "服务重启，任务已中断"
                if isinstance(job.result, dict) and "created" in job.result:
                    prog["message"] = _partial_termination_message(job, "中断", str(prog.get("message") or ""))
            job.progress = prog
            job.finished_at = finished
        if jobs:
            session.commit()
        return len(jobs)
    finally:
        if db is None:
            session.close()


def _completion_message(kind: str, output: dict[str, Any] | None) -> str:
    """Build a concise teacher-facing summary when a Course Studio job finishes."""
    data = output if isinstance(output, dict) else {}
    if kind == "exercises_generate":
        created = int(data.get("created") or 0)
        skipped = int(data.get("skipped") or 0)
        if created > 0:
            extra = f"（跳过重复或无效 {skipped} 道）" if skipped > 0 else ""
            return f"已完成：新增 {created} 道待审题目{extra}"
        return "已完成：未新增题目（均已存在或被跳过）"
    if kind == "coding_exercises_generate":
        created = int(data.get("created") or 0)
        skipped = int(data.get("skipped") or 0)
        failed = int(data.get("failed") or 0)
        details: list[str] = []
        if failed > 0:
            details.append(f"{failed} 道未通过自动验题")
        if skipped > 0:
            details.append(f"跳过重复 {skipped} 道")
        suffix = f"（{'，'.join(details)}）" if details else ""
        if created > 0:
            return f"已完成：新增 {created} 道已验编程题草稿{suffix}"
        return f"已完成：未新增编程题{suffix or '（均已存在或未通过自动验题）'}"
    if kind == "exam_fill_gaps":
        created = int(data.get("created") or 0)
        if created > 0:
            return f"已完成：补充 {created} 道待审题目"
        notes = data.get("notes")
        if isinstance(notes, list) and notes:
            return f"已完成：{notes[0]}"
        return "已完成：题库已满足需求"
    if kind == "knowledge_extract":
        created = int(data.get("created") or 0)
        updated = int(data.get("updated") or 0)
        parts: list[str] = []
        if created > 0:
            parts.append(f"新增 {created} 个知识点")
        if updated > 0:
            parts.append(f"更新 {updated} 个")
        return f"已完成：{'，'.join(parts)}" if parts else "已完成：知识点已同步"
    return "任务已完成"


def run_next(db: Session | None = None) -> bool:
    """Claim and run the oldest queued CourseStudioJob synchronously."""
    session = db or SessionLocal()
    try:
        job = session.scalar(
            select(CourseStudioJob)
            .where(CourseStudioJob.status == "queued")
            .order_by(CourseStudioJob.created_at.asc(), CourseStudioJob.id.asc())
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if job is None:
            return False
        if job.cancel_requested_at is not None:
            job.status = "cancelled"
            job.finished_at = now()
            session.commit()
            return True

        started = now()
        job.status = "running"
        job.started_at = started
        job.heartbeat_at = started
        session.commit()

        handler = _HANDLERS.get(job.kind)
        if handler is None:
            job.status = "failed"
            job.error = f"未注册的任务类型：{job.kind}"
            job.finished_at = now()
            session.commit()
            return True

        try:
            check_cancel(session, job.id)
            output = handler(session, job)
            check_cancel(session, job.id)
            refreshed = session.get(CourseStudioJob, job.id)
            if refreshed is not None:
                refreshed.status = "done"
                refreshed.result = output
                refreshed.finished_at = now()
                prog = dict(refreshed.progress or {})
                prog["message"] = _completion_message(refreshed.kind, output)
                if prog.get("total"):
                    prog["done"] = prog["total"]
                refreshed.progress = prog
            session.commit()
        except JobCancelled:
            session.rollback()
            refreshed = session.get(CourseStudioJob, job.id)
            if refreshed is not None:
                refreshed.status = "cancelled"
                refreshed.finished_at = now()
                refreshed.progress = {
                    **(refreshed.progress or {}),
                    "message": _partial_termination_message(refreshed, "取消", "任务已取消"),
                }
                session.commit()
        except HTTPException as exc:
            session.rollback()
            refreshed = session.get(CourseStudioJob, job.id)
            if refreshed is not None:
                refreshed.status = "failed"
                refreshed.error = str(exc.detail)[:500]
                refreshed.finished_at = now()
                refreshed.progress = {
                    **(refreshed.progress or {}),
                    "message": _partial_termination_message(refreshed, "失败", "任务执行失败"),
                }
                session.commit()
        except Exception as exc:  # noqa: BLE001 -- background task failures are recorded cleanly
            session.rollback()
            log.warning("course_studio job %s (%s) failed: %s", job.id, job.kind, exc)
            refreshed = session.get(CourseStudioJob, job.id)
            if refreshed is not None:
                refreshed.status = "failed"
                refreshed.error = (str(exc) or "任务执行失败")[:500]
                refreshed.finished_at = now()
                refreshed.progress = {
                    **(refreshed.progress or {}),
                    "message": _partial_termination_message(refreshed, "失败", "任务执行失败"),
                }
                session.commit()
        return True
    finally:
        if db is None:
            session.close()


def _has_queued_job() -> bool:
    with SessionLocal() as session:
        return (
            session.scalar(select(CourseStudioJob.id).where(CourseStudioJob.status == "queued").limit(1))
            is not None
        )


def _run_one_in_thread() -> bool:
    return run_next()


async def worker() -> None:
    """Background polling loop executing Course Studio jobs in bounded worker threads."""
    running: set[asyncio.Task[bool]] = set()
    while True:
        running = {task for task in running if not task.done()}
        try:
            while len(running) < CONCURRENCY and await asyncio.to_thread(_has_queued_job):
                task = asyncio.create_task(asyncio.to_thread(_run_one_in_thread))
                running.add(task)
                if len(running) >= CONCURRENCY:
                    break
        except SQLAlchemyError:
            log.warning("course_studio worker cannot reach the database; retrying in %ss", POLL_SECONDS)
        await asyncio.sleep(POLL_SECONDS)
