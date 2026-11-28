"""Class-scoped active tasks and durable execution history."""
from datetime import timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import ColumnElement, Row, Select, String, case, cast, func, literal, select, union_all
from sqlalchemy.orm import Session, load_only

from ..auth import as_utc, require_admin, require_teacher
from ..db import get_db
from ..materials.access import teacher_material as visible_material
from ..course_studio.jobs import serialize_job
from ..course_studio.models import CourseStudioJob
from ..models import Chapter, CourseInstance, Material, User, now
from ..teacher_scope import teacher_instance_id
from . import repository, task_progress
from .request_contracts import GenerateInput, PageGenerateInput, RangeInput
from .task_commands import (calibrate_deck, digest_deck, generate_narration, generate_range, pipeline_deck,
                            synthesize_audio, synthesize_audio_batch)
from .models import NarrationJob, NarrationRun

router = APIRouter(prefix="/teacher/courses/{course_id}/synthesis", tags=["narration"])
global_router = APIRouter(tags=["narration"], dependencies=[Depends(require_admin)])
OPERATIONS = {"generate_page", "generate_range", "audio_page", "audio_batch", "calibrate", "digest", "pipeline"}
WORKER_OPERATIONS = OPERATIONS - {"generate_page", "audio_page"}
RunRow = tuple[NarrationRun, Material, str, int, str, int]


def snapshot(material: Material, job: NarrationJob | NarrationRun | None, *, cancel_requested: bool = False,
             latest_db: Session | None = None) -> dict[str, Any]:
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
    dismissed = bool(progress.get("queue_dismissed"))
    if status == "failed" and job and job.started_at:
        cancellable = not dismissed
    note = ""
    if status == "interrupted" and not retryable:
        note = "任务结果待核查，请打开资料确认"
    elif status in {"failed", "cancelled"} and not retryable:
        note = "请打开资料审校后重新发起"
    elif status == "running" and not cancellable:
        note = "当前请求已执行，等待调用返回"
    return {"id": job.id if job else None, "material_id": material.id, "title": material.title, "material_kind": material.kind,
            "kind": job.kind if job else "", "status": status, "running": running,
            **task_progress.describe(job, status, latest_db), "queue_dismissed": dismissed,
            "started_at": as_utc(job.started_at).isoformat() if job and job.started_at else None,
            "finished_at": as_utc(job.finished_at).isoformat() if job and job.finished_at else None,
            "cancellable": cancellable, "retryable": retryable, "retry_note": note}


def run_state(model: type[NarrationRun] | type[NarrationJob] = NarrationRun) -> ColumnElement[str]:
    cutoff = now() - timedelta(seconds=repository.JOB_STALE_SECONDS)
    moment = func.coalesce(model.heartbeat_at, model.started_at)
    unclaimed = func.coalesce(model.progress["queued"].as_boolean(), False)
    return case(((model.status == "running") & ~unclaimed & ((moment < cutoff) | moment.is_(None)), "interrupted"), else_=model.status)


def visible_runs(db: Session, user: User, course_id: int | None) -> Select[*RunRow]:
    statement = (select(NarrationRun, Material, User.name, CourseInstance.id, CourseInstance.name, NarrationJob.id)
        .join(Material, NarrationRun.material_id == Material.id)
        .join(CourseInstance, Material.course_instance_id == CourseInstance.id)
        .outerjoin(User, NarrationRun.requested_by == User.id)
        .outerjoin(NarrationJob, (NarrationJob.material_id == Material.id) & (NarrationJob.started_at == NarrationRun.started_at))
        .options(load_only(Material.id, Material.title, Material.kind, Material.deleted_at))
        .execution_options(include_deleted=True))
    if course_id is not None:
        statement = statement.where(Material.course_instance_id == teacher_instance_id(db, user, course_id))
    if user.role != "admin":
        statement = statement.where(Material.owner_id.is_(None) | (Material.owner_id == user.id))
    return statement


def history_item(row: Row[*RunRow], db: Session, *, course_view: bool) -> dict[str, Any]:
    record, material, name, course_id, course_name, current_job_id = row
    item = snapshot(material, record, latest_db=db if current_job_id else None)
    item.update(requested_by=name or "—", material_available=material.deleted_at is None,
                course_id=course_id, course_name=course_name, run_id=record.id)
    if not (course_view and current_job_id) or material.deleted_at is not None:
        item.update(retryable=False, cancellable=False, retry_note="")
    request = (record.progress or {}).get("request") or {}
    body = request.get("body") or {}
    item["scope"] = (f"第 {request['page_no']} 页" if request.get("page_no") else
                     f"第 {body.get('first_page') or 1}–{body['last_page']} 页" if body.get("last_page") else "整份资料")
    return item


@global_router.get("/admin/synthesis/runs/{run_id}")
@router.get("/runs/{run_id}")
def get_task(run_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)],
             course_id: int | None = None) -> dict[str, Any]:
    row = db.execute(visible_runs(db, user, course_id).where(NarrationRun.id == run_id)).one_or_none()
    if row is None:
        raise HTTPException(404, "任务记录不存在")
    return history_item(row, db, course_view=course_id is not None)


@global_router.get("/admin/synthesis")
@router.get("")
def list_tasks(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)],
               course_id: int | None = None,
               query: str = "", status: Literal["all", "running", "done", "failed", "interrupted", "cancelled"] = "all",
               view: Literal["all", "running", "history"] = "all",
               page: Annotated[int, Query(ge=1)] = 1, size: Annotated[int, Query(ge=1, le=100)] = 20) -> dict[str, Any]:
    narration = visible_runs(db, user, course_id)
    narration = narration.where(~func.coalesce(NarrationRun.progress["queue_dismissed"].as_boolean(), False))
    studio = (select(CourseStudioJob, CourseInstance.name, Chapter.title, User.name)
              .join(CourseInstance, CourseInstance.id == CourseStudioJob.course_instance_id)
              .outerjoin(Chapter, (Chapter.id == CourseStudioJob.payload["chapter_id"].as_integer())
                         & (Chapter.course_instance_id == CourseInstance.id))
              .outerjoin(User, User.id == CourseStudioJob.requested_by)
              .where(~func.coalesce(CourseStudioJob.progress["queue_dismissed"].as_boolean(), False)))
    if course_id is not None:
        studio = studio.where(CourseInstance.id == course_id)
    studio_kinds = {"knowledge_extract": "AI 知识点抽取", "exercises_generate": "AI 智能出题",
                    "coding_exercises_generate": "AI 编程出题", "exam_fill_gaps": "AI 试卷补题"}
    if query.strip():
        term = query.strip()
        narration = narration.where(Material.title.icontains(term, autoescape=True))
        studio = studio.where(Chapter.title.icontains(term, autoescape=True) | CourseInstance.name.icontains(term, autoescape=True)
                              | CourseStudioJob.kind.in_([k for k, name in studio_kinds.items() if term.casefold() in name.casefold()]))
    # Apply counts, filtering and pagination to one ordered index before loading detailed progress.
    index = union_all(
        narration.with_only_columns(literal("narration").label("source"), cast(NarrationRun.id, String).label("key"),
                                    NarrationRun.started_at.label("moment"), run_state().label("state")),
        studio.with_only_columns(literal("studio"), CourseStudioJob.id, CourseStudioJob.created_at,
                                 case((CourseStudioJob.status == "queued", "running"), else_=CourseStudioJob.status)),
    ).subquery()
    counts: dict[str, int] = dict(db.execute(select(index.c.state, func.count()).group_by(index.c.state)
                             .execution_options(include_deleted=True)).all())
    refs = select(index.c.source, index.c.key)
    if view != "all":
        refs = refs.where(index.c.state == "running" if view == "running" else index.c.state != "running")
    if status != "all":
        refs = refs.where(index.c.state == status)
    total = db.scalar(select(func.count()).select_from(refs.subquery()).execution_options(include_deleted=True)) or 0
    keys = db.execute(refs.order_by(index.c.moment.desc(), index.c.source, index.c.key.desc())
                      .offset((page - 1) * size).limit(size).execution_options(include_deleted=True)).all()
    rows = {}
    narration_ids = [int(key) for source, key in keys if source == "narration"]
    if narration_ids:
        for row in db.execute(narration.where(NarrationRun.id.in_(narration_ids))):
            rows[("narration", str(row[0].id))] = history_item(row, db, course_view=course_id is not None)
    studio_ids = [key for source, key in keys if source == "studio"]
    if studio_ids:
        for job, course_name, chapter_title, requester in db.execute(studio.where(CourseStudioJob.id.in_(studio_ids))
                                                                     .execution_options(include_deleted=True)):
            rows[("studio", job.id)] = {"source": "studio", "job": serialize_job(job), "title": chapter_title or course_name,
                                        "course_name": course_name, "requested_by": requester or "—"}
    return {"items": [rows[key] for key in keys if key in rows], "total": total,
            "counts": {key: counts.get(key, 0) for key in ("running", "done", "failed", "interrupted", "cancelled")}}


@router.post("/runs/{run_id}/dismiss")
def dismiss_run(course_id: int, run_id: int, db: Annotated[Session, Depends(get_db)],
                user: Annotated[User, Depends(require_teacher)]) -> dict[str, bool]:
    teacher_instance_id(db, user, course_id, exclusive=True)
    row = db.execute(visible_runs(db, user, course_id).where(NarrationRun.id == run_id)).one_or_none()
    if row is None:
        raise HTTPException(404, "任务记录不存在")
    record = row[0]
    if record.status != "failed":
        raise HTTPException(409, "只能忽略失败的课件任务")
    current = db.scalar(select(NarrationJob).where(NarrationJob.material_id == record.material_id,
                        NarrationJob.started_at == record.started_at, NarrationJob.status == "failed").with_for_update())
    record.progress = {**(record.progress or {}), "queue_dismissed": True}
    if current is not None:
        current.progress = {**(current.progress or {}), "queue_dismissed": True}
    db.commit()
    return {"queue_dismissed": True}


class RetryInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_started_at: str


@router.post("/{material_id}/cancel")
def cancel_task(course_id: int, material_id: int, body: RetryInput,
                db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]) -> dict[str, Any]:
    material = visible_material(db, user, material_id, instance_id=teacher_instance_id(db, user, course_id))
    job = repository.job_of(db, material_id)
    if not job or not repository.same_attempt(job.started_at, body.expected_started_at):
        raise HTTPException(409, "资料的当前任务已变化，请刷新队列")
    if job.status == "failed":
        failed = db.scalar(select(NarrationJob).where(NarrationJob.id == job.id,
            NarrationJob.started_at == job.started_at, NarrationJob.status == "failed")
            .with_for_update().execution_options(populate_existing=True))
        if not failed:
            raise HTTPException(409, "资料的当前任务已变化，请刷新队列")
        if not (failed.progress or {}).get("queue_dismissed"):
            failed.progress = {**(failed.progress or {}), "queue_dismissed": True}
            repository.sync_run(db, failed)
            db.commit()
        return snapshot(material, failed)
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
    if current["status"] != "running" or not current["cancellable"]:
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
def retry_task(course_id: int, material_id: int, body: RetryInput,
               db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]) -> dict[str, Any]:
    material = visible_material(db, user, material_id, instance_id=teacher_instance_id(db, user, course_id))
    job = repository.job_of(db, material_id)
    if (not job or not snapshot(material, job)["retryable"] or not job.started_at
            or not repository.same_attempt(job.started_at, body.expected_started_at)):
        raise HTTPException(409, "任务状态已变化或不支持直接重试，请刷新并打开资料核查")
    progress = job.progress or {}
    request = progress["request"]
    db.info["narration_retry_expected"] = body.expected_started_at
    db.info["narration_retry_pages"] = progress.get("retry_pages") or request.get("only_pages")
    operation = request["operation"]
    args: dict[str, Any] = {"course_id": course_id, "material_id": material_id, "db": db, "user": user}
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
