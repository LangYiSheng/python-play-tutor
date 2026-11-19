"""整册讲解的生成、校准与音频合成放在后台跑。

一个请求只做三件事：校验、拿资料锁（`repository.enqueue`）、返回任务快照。真正的模型调用由
生命周期 worker 在**线程**里执行，因为 `httpx.Client` 是同步的，放事件循环里会卡住所有接口；
线程适合这种纯等待 I/O 的活。老师关掉页面、切去别的资料都不影响。

任务行本身就是队列：`status="running"` 且 `progress["queued"]` 为真表示「已入队、待执行」。
worker 认领时清掉 `queued`、把租约注册到自己的 session 上，之后逐页/逐窗提交心跳。

并发上限 `CONCURRENCY`：不同资料可以并行（各自持锁），同一份资料永远只有一个执行者。
"""

import asyncio
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import Material
from . import repository, task_commands
from .models import NarrationJob

log = logging.getLogger(__name__)

CONCURRENCY = 3
POLL_SECONDS = 2


def state(material_id: int, job: NarrationJob | None) -> dict[str, Any]:
    """前端轮询用的任务快照；入队与 `GET /job` 共用这一份形状。"""
    progress = (job.progress or {}) if job else {}
    return {
        "id": job.id if job else None,
        "material_id": material_id,
        "kind": job.kind if job else "",
        "status": "interrupted" if job and job.status == "running" and not repository.job_running(job)
        else job.status if job else "idle",
        "running": bool(job and repository.job_running(job)),
        "queued": bool(job and (job.progress or {}).get("queued")),
        "done": progress.get("done", 0),
        "total": progress.get("total", 0),
        "message": job.message if job else "",
        "failed": progress.get("failed", []),
        "started_at": job.started_at.isoformat() if job and job.started_at else None,
    }


def claim(db: Session, material_id: int) -> NarrationJob | None:
    """认领一个排队中的任务；返回 None 说明已被别的执行者拿走或不该跑。"""
    job = db.scalar(select(NarrationJob).where(NarrationJob.material_id == material_id)
                    .with_for_update().execution_options(populate_existing=True))
    if job is None or job.status != "running" or job.started_at is None:
        return None
    if not (job.progress or {}).get("queued"):
        return None
    job.progress = {**(job.progress or {}), "queued": False}
    # 租约属于这个 session：之后所有 beat/release 都要用它确认自己仍是执行者。
    db.info.setdefault("narration_leases", {})[material_id] = job.started_at
    db.commit()
    return job


def run(db: Session, material_id: int) -> bool:
    """把一个任务跑到结束；返回是否认领到了活。"""
    job = claim(db, material_id)
    if job is None:
        return False
    request = (job.progress or {}).get("request") or {}
    operation = request.get("operation")
    material = db.get(Material, material_id)
    try:
        if material is None:
            raise LookupError("资料已删除")
        if operation == "calibrate":
            task_commands.run_calibration(db, material)
        elif operation == "digest":
            task_commands.run_digest(db, material, request)
        elif operation == "generate_range":
            task_commands.run_generate_range(db, material, request)
        elif operation == "audio_batch":
            task_commands.run_audio_batch(db, material, request)
        else:
            raise ValueError("未知的后台任务类型")
    except BaseException as exc:  # noqa: BLE001 -- 一个任务失败不能拖垮 worker
        db.rollback()
        message = str(exc) if isinstance(exc, (LookupError, ValueError, RuntimeError)) else "任务未完成，请查看错误后重试"
        repository.release(db, material_id, status="failed", message=message or "任务未完成")
        log.warning("narration job %s failed: %s", material_id, exc)
        if not isinstance(exc, Exception):
            raise
    return True


def queued(db: Session) -> list[int]:
    rows = db.execute(select(NarrationJob.material_id, NarrationJob.progress)
                      .where(NarrationJob.status == "running").order_by(NarrationJob.id))
    return [material_id for material_id, progress in rows if (progress or {}).get("queued")]


def drain(db: Session) -> int:
    """把当前排队中的任务各跑一遍；测试与 worker 的一轮都用它。"""
    return sum(1 for material_id in queued(db) if run(db, material_id))


def _queued_ids() -> list[int]:
    with SessionLocal() as session:
        return queued(session)


def _run_in_session(material_id: int) -> None:
    with SessionLocal() as session:
        try:
            run(session, material_id)
        except Exception:  # noqa: BLE001 -- 线程里的异常必须自己消化，否则静默消失
            log.exception("narration job %s crashed", material_id)


async def worker() -> None:
    """每 2 秒扫一次队列，用线程执行，最多 CONCURRENCY 个并行。"""
    running: dict[int, asyncio.Task[None]] = {}
    while True:
        running = {key: task for key, task in running.items() if not task.done()}
        try:
            for material_id in await asyncio.to_thread(_queued_ids):
                if material_id in running or len(running) >= CONCURRENCY:
                    continue
                running[material_id] = asyncio.create_task(asyncio.to_thread(_run_in_session, material_id))
        except SQLAlchemyError:
            log.warning("narration worker cannot reach the database; retrying in %ss", POLL_SECONDS)
        await asyncio.sleep(POLL_SECONDS)
