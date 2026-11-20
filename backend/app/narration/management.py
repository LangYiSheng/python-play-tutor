"""Class-scoped active tasks and durable execution history."""
from datetime import timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import ColumnElement, case, func, select
from sqlalchemy.orm import Session, load_only

from ..auth import require_admin, require_teacher
from ..db import get_db
from ..materials.access import teacher_material as visible_material
from ..models import Classroom, CourseInstance, Material, User, now
from ..teacher_scope import teacher_instance_id
from . import repository
from .request_contracts import GenerateInput, PageGenerateInput, RangeInput
from .task_commands import (calibrate_deck, digest_deck, generate_narration, generate_range, pipeline_deck,
                            synthesize_audio, synthesize_audio_batch)
from .models import NarrationJob, NarrationRun

router = APIRouter(prefix="/teacher/classrooms/{classroom_id}/synthesis", tags=["narration"])
global_router = APIRouter(tags=["narration"], dependencies=[Depends(require_admin)])
OPERATIONS = {"generate_page", "generate_range", "audio_page", "audio_batch", "calibrate", "digest", "pipeline"}
WORKER_OPERATIONS = OPERATIONS - {"generate_page", "audio_page"}


def snapshot(material: Material, job: NarrationJob | NarrationRun | None, *, cancel_requested: bool = False) -> dict[str, Any]:
    progress = (job.progress or {}) if job else {}
    request = progress.get("request") or {}
    running = bool(job and repository.job_running(job))
    status = "interrupted" if job and job.status == "running" and not running else job.status if job else "idle"
    if running and (cancel_requested or isinstance(job, NarrationRun) and job.cancel_requested_at):
        status = "cancelling"
    can_resume = status == "cancelled" or (status == "interrupted" and progress.get("never_started"))
    retryable = bool(job and (status == "failed" or can_resume) and request.get("operation") in OPERATIONS
                     and progress.get("retry_fingerprint"))
    if status == "failed" and request.get("operation") in {"generate_range", "audio_batch"} and not progress.get("retry_pages"):
        retryable = False
    cancellable = bool(status == "running" and request.get("operation") in WORKER_OPERATIONS and job and job.started_at)
    note = ""
    if status == "interrupted" and not retryable:
        note = "任务结果待核查，请打开资料确认"
    elif status in {"failed", "cancelled"} and not retryable:
        note = "请打开资料审校后重新发起"
    elif status == "running" and not cancellable:
        note = "当前请求已执行，等待调用返回"
    return {"id": job.id if job else None, "material_id": material.id, "title": material.title, "material_kind": material.kind,
            "kind": job.kind if job else "", "status": status, "running": running,
            "done": progress.get("done", 0), "total": progress.get("total", 0),
            "message": job.message if job else "", "failed": progress.get("failed", []),
            "started_at": job.started_at.isoformat() if job and job.started_at else None,
            "finished_at": job.finished_at.isoformat() if job and job.finished_at else None,
            "cancellable": cancellable, "retryable": retryable, "retry_note": note}


def run_state(model=NarrationRun) -> ColumnElement[str]:
    cutoff = now() - timedelta(seconds=repository.JOB_STALE_SECONDS)
    moment = func.coalesce(model.heartbeat_at, model.started_at)
    unclaimed = func.coalesce(model.progress["queued"].as_boolean(), False)
    return case(((model.status == "running") & ~unclaimed & ((moment < cutoff) | moment.is_(None)), "interrupted"), else_=model.status)


@global_router.get("/admin/synthesis")
@router.get("")
def list_tasks(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)],
               classroom_id: int | None = None,
               query: str = "", status: Literal["all", "running", "done", "failed", "interrupted", "cancelled"] = "all",
               view: Literal["all", "running", "history"] = "all",
               page: Annotated[int, Query(ge=1)] = 1, size: Annotated[int, Query(ge=1, le=100)] = 20) -> dict[str, Any]:
    state = run_state()
    statement = (select(NarrationRun, Material, User.name, Classroom.id, Classroom.name)
        .join(Material, NarrationRun.material_id == Material.id)
        .join(CourseInstance, Material.course_instance_id == CourseInstance.id)
        .join(Classroom, CourseInstance.classroom_id == Classroom.id)
        .outerjoin(User, NarrationRun.requested_by == User.id)
        .options(load_only(Material.id, Material.title, Material.kind, Material.deleted_at))
        .execution_options(include_deleted=True))
    if classroom_id is not None:
        statement = statement.where(Material.course_instance_id == teacher_instance_id(db, user, classroom_id))
    if query.strip():
        statement = statement.where(Material.title.icontains(query.strip(), autoescape=True))
    counts: dict[str, int] = dict(db.execute(statement.with_only_columns(state, func.count()).group_by(state)).all())
    if view != "all":
        statement = statement.where(state == "running" if view == "running" else state != "running")
    if status != "all":
        statement = statement.where(state == status)
    total = db.scalar(select(func.count()).select_from(statement.subquery())) or 0
    items = []
    for record, material, name, class_id, class_name in db.execute(statement.order_by(NarrationRun.started_at.desc(), NarrationRun.id.desc()).offset((page - 1) * size).limit(size)):
        item = snapshot(material, record)
        latest = repository.job_of(db, material.id) if classroom_id is not None else None
        is_latest = bool(latest and latest.started_at == record.started_at)
        item.update(requested_by=name or "—", material_available=material.deleted_at is None,
                    classroom_id=class_id, classroom_name=class_name)
        if not is_latest or material.deleted_at is not None:
            item.update(retryable=False, cancellable=False, retry_note="")
        request = (record.progress or {}).get("request") or {}
        body = request.get("body") or {}
        item["scope"] = (f"第 {request['page_no']} 页" if request.get("page_no") else
                         f"第 {body.get('first_page') or 1}–{body['last_page']} 页" if body.get("last_page") else "整份资料")
        items.append(item)
    return {"items": items, "total": total,
            "counts": {key: counts.get(key, 0) for key in ("running", "done", "failed", "interrupted", "cancelled")}}


class RetryInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_started_at: str


@router.post("/{material_id}/cancel")
def cancel_task(classroom_id: int, material_id: int, body: RetryInput,
                db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]) -> dict[str, Any]:
    material = visible_material(db, user, material_id, instance_id=teacher_instance_id(db, user, classroom_id))
    job = repository.job_of(db, material_id)
    if not job or not repository.same_attempt(job.started_at, body.expected_started_at):
        raise HTTPException(409, "资料的当前任务已变化，请刷新队列")
    # Workers lock the job row while writing a window. Only take it without waiting
    # when we can remove an unclaimed request; an in-flight request uses the run row.
    pending = None
    if (job.progress or {}).get("queued"):
        pending = db.scalar(select(NarrationJob).where(NarrationJob.id == job.id,
            NarrationJob.started_at == job.started_at, NarrationJob.status == "running",
            NarrationJob.progress["queued"].as_boolean().is_(True)).with_for_update(skip_locked=True)
            .execution_options(populate_existing=True))
    record = db.scalar(select(NarrationRun).where(NarrationRun.material_id == material_id,
        NarrationRun.started_at == job.started_at).with_for_update().execution_options(populate_existing=True))
    if not record:
        raise HTTPException(409, "缺少该次执行记录，请刷新队列")
    current = snapshot(material, record)
    if current["status"] in {"cancelled", "cancelling"}:
        return current
    if not current["cancellable"]:
        raise HTTPException(409, "任务已结束或不支持取消，请刷新队列")
    record.cancel_requested_at = now()
    if pending:
        progress = pending.progress or {}
        pending.status, pending.finished_at, pending.message = "cancelled", now(), "任务已从等待队列移除"
        pending.progress = {**progress, "queued": False, "never_started": True,
                            "retry_fingerprint": progress.get("queued_fingerprint")}
        repository.sync_run(db, pending)
    db.commit()
    return snapshot(material, record)


@router.post("/{material_id}/retry")
def retry_task(classroom_id: int, material_id: int, body: RetryInput,
               db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]) -> dict[str, Any]:
    material = visible_material(db, user, material_id, instance_id=teacher_instance_id(db, user, classroom_id))
    job = repository.job_of(db, material_id)
    if (not job or not snapshot(material, job)["retryable"] or not job.started_at
            or not repository.same_attempt(job.started_at, body.expected_started_at)):
        raise HTTPException(409, "任务状态已变化或不支持直接重试，请刷新并打开资料核查")
    progress = job.progress or {}
    request = progress["request"]
    db.info["narration_retry_expected"] = body.expected_started_at
    db.info["narration_retry_pages"] = progress.get("retry_pages") or request.get("only_pages")
    operation = request["operation"]
    args: dict[str, Any] = {"classroom_id": classroom_id, "material_id": material_id, "db": db, "user": user}
    try:
        if operation == "generate_page":
            generate_narration(page_no=request["page_no"], body=PageGenerateInput(**request["body"]), **args)
        elif operation == "generate_range":
            generate_range(body=GenerateInput(**request["body"]), **args)
        elif operation == "audio_page":
            synthesize_audio(page_no=request["page_no"], **args)
        elif operation == "audio_batch":
            synthesize_audio_batch(body=RangeInput(**request["body"]), **args)
        elif operation == "pipeline":
            pipeline_deck(resume={"chain": progress.get("chain"), "body": request.get("body")}, **args)
        elif operation == "digest":
            digest_deck(**args)
        else:
            calibrate_deck(**args)
        return snapshot(material, repository.job_of(db, material_id))
    finally:
        db.info.pop("narration_retry_expected", None)
        db.info.pop("narration_retry_pages", None)
