"""Read and review narration rows; staleness is derived from the material's current pages."""

import hashlib
import json
from contextlib import contextmanager
from collections.abc import Iterator
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from datetime import datetime, timedelta, timezone

from ..models import Material, User, now
from .models import (CONTENT_SOURCES, CONTENT_STATUSES, IMAGE_STATES, VISIBLE_STATUSES, MaterialTagDict,
                     NarrationJob, NarrationRun, PageContent, PageNarration)

MAX_TEXT = 4000
MIN_SECONDS, MAX_SECONDS = 30, 300


def text_hash(text: str) -> str:
    return hashlib.sha256((text or "").strip().encode("utf-8")).hexdigest()


def page_map(material: Material) -> dict[int, dict[str, Any]]:
    """Pages keyed by the page number the reading workspace actually shows."""
    pages = (material.content or {}).get("pages") or []
    result: dict[int, dict[str, Any]] = {}
    for item in pages:
        if not isinstance(item, dict):
            continue
        page_no = item.get("page_no") or item.get("id")
        if isinstance(page_no, int):
            result[page_no] = item
    return result


def page_text(material: Material, page_no: int) -> str | None:
    page = page_map(material).get(page_no)
    if page is None:
        return None
    return str(page.get("text") or "")


def source_hash(material: Material, page_no: int) -> str:
    """Include the uploaded asset, including image-only pages, in review validity."""
    content = material.content or {}
    payload = {"page": page_map(material).get(page_no), "file": material.storage_key,
               "sha256": content.get("sha256"), "preview": content.get("preview_key")}
    return text_hash(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def narration_hash(db: Session, material: Material, page_no: int) -> str:
    """讲稿依赖的页面身份：整理稿优先，没有整理稿时用解析原文。"""
    return narration_page_hash(material, page_no, page_text(material, page_no), content_row(db, material.id, page_no))


def narration_page_hash(material: Material, page_no: int, raw: str | None, row: PageContent | None) -> str:
    content = material.content or {}
    payload = {"page": page_no, "title": row.title if row else "", "tags": row.tags if row else [],
               "text": (row.text if row is not None and row.text.strip() else (raw or "")),
               "file": material.storage_key, "sha256": content.get("sha256"),
               "preview": content.get("preview_key")}
    return text_hash(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def revision(item: PageNarration | None) -> str:
    if item is None:
        return "missing"
    return text_hash(json.dumps([item.id, item.text, item.status, item.page_hash,
                                item.updated_at.isoformat() if item.updated_at else None]))


def rows(db: Session, material_id: int) -> list[PageNarration]:
    return list(db.scalars(select(PageNarration).where(PageNarration.material_id == material_id)
                           .order_by(PageNarration.page_no)))


def row(db: Session, material_id: int, page_no: int) -> PageNarration | None:
    return db.scalar(select(PageNarration).where(PageNarration.material_id == material_id,
                                                 PageNarration.page_no == page_no))


def sync_staleness(db: Session, material: Material) -> bool:
    """Void a review when the page it was written against changed or disappeared.

    A replacement upload rewrites `Material.content` wholesale; rows live in their own
    table, so they survive — but they must not stay approved against different text.
    """
    pages = page_map(material)
    changed = False
    for item in rows(db, material.id):
        current = pages.get(item.page_no)
        if current is None or narration_hash(db, material, item.page_no) != item.page_hash:
            if item.status in {"draft", "accepted", "rejected"}:
                item.status = "stale"
                changed = True
    if changed:
        db.flush()
    return changed


def snapshot(material: Material, item: PageNarration | None, page: dict[str, Any] | None,
             content: PageContent | None = None) -> dict[str, Any]:
    text = str((page or {}).get("text") or "")
    narration: dict[str, Any] | None = None
    if item is not None:
        narration = {
            "text": item.text,
            "bridge_in": item.bridge_in,
            "target_seconds": item.target_seconds,
            "status": item.status,
            "source": item.source,
            "model": item.model,
            "image_used": item.image_used,
            "anchors": item.anchors or [],
            "edited_by_teacher": item.edited_by_teacher,
            "reviewed_at": item.reviewed_at.isoformat() if item.reviewed_at else None,
            "stale_reason": "本页原文已变化，需要重新生成或重新审校" if item.status == "stale" else None,
        }
    return {
        "page_no": (page or {}).get("page_no") or (page or {}).get("id"),
        "title": (page or {}).get("title") or "",
        "has_text": bool(text.strip()),
        "source_chars": len(text),
        # Teacher review compares the wording against the page, so send a bounded copy.
        "source_text": text[:2000],
        "raw_text": text[:2000],
        "digest": None if content is None else {
            "title": content.title, "topic": content.topic, "tags": content.tags or [],
            "text": content.text, "status": content.status, "source": content.source,
            "image_state": content.image_state, "model": content.model,
        },
        "narration": narration,
    }


def coverage(pages: dict[int, dict[str, Any]], items: list[PageNarration]) -> dict[str, int]:
    by_page = {item.page_no: item for item in items}
    counts = {status: 0 for status in ("draft", "accepted", "rejected", "unavailable", "stale")}
    covered = 0
    for page_no in pages:
        item = by_page.get(page_no)
        if item is None:
            continue
        covered += 1
        counts[item.status] = counts.get(item.status, 0) + 1
    return {"pages": len(pages), "covered": covered, "missing": len(pages) - covered, **counts}


def trim_text(value: str) -> str:
    text = (value or "").strip()
    if not text:
        raise ValueError("讲解不能为空；要移除请删除本页讲解")
    if len(text) > MAX_TEXT:
        raise ValueError(f"讲解不能超过 {MAX_TEXT} 字")
    return text


def trim_seconds(value: int | None) -> int:
    if value is None:
        return 90
    if not isinstance(value, int) or not MIN_SECONDS <= value <= MAX_SECONDS:
        raise ValueError(f"目标时长必须在 {MIN_SECONDS} 到 {MAX_SECONDS} 秒之间")
    return value


def upsert(db: Session, material: Material, page_no: int, *, text: str, target_seconds: int | None = None,
           source: str = "teacher", keep_review: bool = False) -> PageNarration:
    """Teacher-authored wording. An approved page stays approved; a void or refused one returns to draft."""
    clean = trim_text(text)
    seconds = trim_seconds(target_seconds)
    item = row(db, material.id, page_no)
    if item is None:
        item = PageNarration(material_id=material.id, page_no=page_no)
        db.add(item)
    item.text = clean
    item.target_seconds = seconds
    item.source = source
    item.page_hash = narration_hash(db, material, page_no)
    item.input_hash = ""
    item.prompt_version = ""
    item.model = ""
    item.image_used = False
    item.anchors = []
    item.edited_by_teacher = True
    item.updated_at = now()
    if not keep_review and item.status in {"stale", "rejected", "unavailable"}:
        item.status = "draft"
        item.reviewed_by = None
        item.reviewed_at = None
    db.flush()
    return item


def decide(db: Session, material: Material, page_no: int, status: str, user: User) -> PageNarration:
    """Accept or reject one page. A stale row must be regenerated or edited first."""
    item = row(db, material.id, page_no)
    if item is None:
        raise LookupError("本页还没有讲解草稿")
    if item.status == "stale":
        raise ValueError("本页原文已变化，请先重新生成或编辑后再审校")
    if not (item.text or "").strip() and status == "accepted":
        raise ValueError("讲解为空，不能接受")
    item.status = status
    item.reviewed_by = user.id
    item.reviewed_at = now()
    item.updated_at = now()
    db.flush()
    return item


def remove(db: Session, material: Material, page_no: int) -> bool:
    item = row(db, material.id, page_no)
    if item is None:
        return False
    db.delete(item)
    db.flush()
    return True


def visible(db: Session, material: Material) -> list[PageNarration]:
    """Only teacher-approved wording reaches a student."""
    return [item for item in rows(db, material.id) if item.status in VISIBLE_STATUSES and item.text.strip()
            and item.page_hash == narration_hash(db, material, item.page_no)]


# 心跳超过这个时间就认为上一次任务已经死掉（进程被杀、容器重启），允许接管。
JOB_STALE_SECONDS = 300


class CancellationRequested(Exception):
    """The worker has reached the next safe stopping point."""


def check_cancel(db: Session, material_id: int) -> None:
    lease = db.info.get("narration_leases", {}).get(material_id)
    if lease is None:
        return
    requested = db.scalar(select(NarrationRun.cancel_requested_at).where(
        NarrationRun.material_id == material_id, NarrationRun.started_at == lease))
    if requested is not None:
        raise CancellationRequested


class JobBusy(RuntimeError):
    """Another narration task is already running for this material."""

    def __init__(self, kind: str, started_at: datetime | None) -> None:
        self.kind = kind
        self.started_at = started_at
        super().__init__("这份资料正在处理中，请等待当前任务结束")


@contextmanager
def task(db: Session, material: Material, kind: str, user: User,
         request: dict[str, Any] | None = None) -> Iterator[None]:
    from fastapi import HTTPException

    try:
        acquire(db, material, kind, user, request=request)
    except JobBusy as exc:
        raise HTTPException(409, str(exc)) from exc
    try:
        yield
        db.commit()
    except BaseException as exc:
        db.rollback()
        message = str(exc.detail) if isinstance(exc, HTTPException) else "任务未完成，请查看错误后重试"
        release(db, material.id, status="failed", message=message)
        raise
    else:
        release(db, material.id)


def enqueue(db: Session, material: Material, kind: str, user: User | None = None,
            *, request: dict[str, Any] | None = None) -> NarrationJob:
    """Take the lock and mark the work queued; the lifecycle worker makes the calls."""
    from fastapi import HTTPException

    try:
        return acquire(db, material, kind, user, request=request, queued=True)
    except JobBusy as exc:
        raise HTTPException(409, str(exc)) from exc


def interrupt_running(db: Session | None = None) -> int:
    """A restart cannot leave a live narration task: the deployment runs one API process."""
    from sqlalchemy import update

    from ..db import SessionLocal

    session = db or SessionLocal()
    try:
        jobs = list(session.scalars(select(NarrationJob).where(NarrationJob.status == "running")))
        for job in jobs:
            run = session.scalar(select(NarrationRun).where(NarrationRun.material_id == job.material_id,
                                                            NarrationRun.started_at == job.started_at))
            progress = job.progress or {}
            job.status = "cancelled" if run and run.cancel_requested_at else "interrupted"
            job.finished_at = now()
            job.message = "服务重启，取消请求已生效" if job.status == "cancelled" else "服务重启，任务已中断"
            if progress.get("queued") and progress.get("queued_fingerprint"):
                job.progress = {**progress, "queued": False, "retry_fingerprint": progress["queued_fingerprint"], "never_started": True}
            sync_run(session, job)
        session.execute(update(NarrationRun).where(NarrationRun.status == "running").values(status="interrupted"))
        session.commit()
    finally:
        if db is None:
            session.close()
    return len(jobs)


def job_running(job: NarrationJob | NarrationRun) -> bool:
    """活着的任务才算“正在运行”；心跳过期说明进程已经死了，可以接管。"""
    if job.status != "running":
        return False
    if (job.progress or {}).get("queued"):
        return True
    moment = job.heartbeat_at or job.started_at
    if moment is None:
        return False
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - moment < timedelta(seconds=JOB_STALE_SECONDS)


def job_of(db: Session, material_id: int) -> NarrationJob | None:
    return db.scalar(select(NarrationJob).where(NarrationJob.material_id == material_id))


def same_attempt(started: datetime | None, expected: str) -> bool:
    if started is None:
        return False
    try:
        supplied = datetime.fromisoformat(expected)
    except ValueError:
        return False
    def utc(value: datetime) -> datetime:
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    return utc(started) == utc(supplied)


def acquire(db: Session, material: Material, kind: str, user: User | None = None,
            *, request: dict[str, Any] | None = None, queued: bool = False) -> NarrationJob:
    """Take the material lock for one task. Raises JobBusy while another task is alive."""
    # A missing job row cannot be locked; serialize first acquisition on its parent.
    db.scalar(select(Material).where(Material.id == material.id).with_for_update())
    job = db.scalar(select(NarrationJob).where(NarrationJob.material_id == material.id)
                    .with_for_update().execution_options(populate_existing=True))
    expected = db.info.pop("narration_retry_expected", None)
    if expected:
        from fastapi import HTTPException
        if (job is None or job.status not in {"failed", "cancelled", "interrupted"} or not job.started_at
                or not same_attempt(job.started_at, expected)
                or not retry_matches(db, material, (job.progress or {}).get("retry_fingerprint"))):
            raise HTTPException(409, "任务或资料已变化，请刷新并重新审校")
    if job is None:
        job = NarrationJob(material_id=material.id)
        db.add(job)
    elif job_running(job):
        db.rollback()
        raise JobBusy(job.kind, job.started_at)
    elif job.status == "running":
        job.status = "interrupted"
        job.message = "任务心跳已中断，执行结果待核查"
        sync_run(db, job)
    job.kind = kind
    job.status = "running"
    job.requested_by = user.id if user else None
    job.started_at = now()
    job.heartbeat_at = job.started_at
    job.finished_at = None
    job.progress = {"request": request} if request else {}
    if queued:
        job.progress = {**job.progress, "queued": True, "done": 0, "total": 0,
                        "queued_fingerprint": retry_fingerprint(db, material)}
    job.message = ""
    sync_run(db, job)
    db.commit()
    db.info.setdefault("narration_leases", {})[material.id] = job.started_at
    return job


def owned_job(db: Session, material_id: int) -> NarrationJob | None:
    lease = db.info.get("narration_leases", {}).get(material_id)
    job = db.scalar(select(NarrationJob).where(NarrationJob.material_id == material_id)
                    .with_for_update().execution_options(populate_existing=True))
    if job is None or lease is None or job.started_at is None or job.status != "running":
        return None
    if job.started_at.replace(tzinfo=None) != lease.replace(tzinfo=None):
        return None
    return job


def ensure_lease(db: Session, material_id: int) -> None:
    if material_id in db.info.get("narration_leases", {}) and owned_job(db, material_id) is None:
        raise ValueError("任务已被接管，请刷新后查看最新结果")


def beat(db: Session, material_id: int, *, done: int | None = None, total: int | None = None,
         message: str | None = None) -> None:
    """Refresh the heartbeat together with the page commit, so a live task never looks stale."""
    job = owned_job(db, material_id)
    if job is None or job.status != "running":
        return
    job.heartbeat_at = now()
    if done is not None or total is not None:
        job.progress = {**(job.progress or {}),
                        **({"done": done} if done is not None else {}),
                        **({"total": total} if total is not None else {})}
    if message is not None:
        job.message = message[:200]
    sync_run(db, job)


def set_chain(db: Session, material_id: int, chain: list[str], stage: str) -> None:
    """记录链上还剩哪几段；重启或重试从这里继续。"""
    job = owned_job(db, material_id)
    if job is None or job.status != "running":
        return
    job.heartbeat_at = now()
    job.progress = {**(job.progress or {}), "chain": list(chain), "stage": stage, "done": 0, "total": 0}
    sync_run(db, job)


def release(db: Session, material_id: int, *, status: str = "done", message: str = "",
            extra: dict[str, Any] | None = None) -> None:
    if status in {"failed", "cancelled"}:
        db.rollback()
    job = owned_job(db, material_id)
    if job is None:
        return
    job.status = status
    job.finished_at = now()
    job.message = message[:200]
    if extra:
        job.progress = {**(job.progress or {}), **extra}
    if status in {"failed", "cancelled"}:
        material = db.get(Material, material_id)
        if material:
            job.progress = {**(job.progress or {}), "retry_fingerprint": retry_fingerprint(db, material)}
    sync_run(db, job)
    db.commit()
    db.info.get("narration_leases", {}).pop(material_id, None)


def sync_run(db: Session, job: NarrationJob) -> None:
    record = db.scalar(select(NarrationRun).where(NarrationRun.material_id == job.material_id,
                                                 NarrationRun.started_at == job.started_at))
    if record is None:
        record = NarrationRun(material_id=job.material_id, started_at=job.started_at)
        db.add(record)
    for field in ("kind", "status", "requested_by", "heartbeat_at", "finished_at", "message"):
        setattr(record, field, getattr(job, field))
    record.progress = dict(job.progress or {})


def retry_fingerprint(db: Session, material: Material, *, legacy: bool = False) -> str:
    """A retry must not overwrite a source or narration edited after the failure."""
    db.refresh(material)
    source = {"source": material.content, "file": material.storage_key,
              "narrations": [revision(item) for item in rows(db, material.id)]}
    if not legacy:
        source["page_contents"] = [(row.page_no, row.title, row.topic, row.tags, row.text, row.status)
                                   for row in content_rows(db, material.id)]
    return ("" if legacy else "v2:") + text_hash(json.dumps(source, ensure_ascii=False, sort_keys=True))


def retry_matches(db: Session, material: Material, signature: str | None) -> bool:
    return bool(signature and signature == retry_fingerprint(db, material, legacy=not signature.startswith("v2:")))

# ---------------------------------------------------------------------------
# 整理稿（page_contents）与课程级 tag 字典
# ---------------------------------------------------------------------------

MAX_CONTENT_TEXT = 20000
MAX_TITLE, MAX_TOPIC = 120, 240
MAX_TAGS = 8


def anchor_key(text: str) -> str:
    """比对锚点前的归一化：去空白、统一小写。"""
    return "".join(str(text or "").split()).lower()


def grounded_anchors(reference: str, anchors: list[Any]) -> tuple[list[str], list[str]]:
    """只保留真的出现在本页文本里的锚点；原文为空时无从判断，原样保留。"""
    key = anchor_key(reference)
    kept: list[str] = []
    dropped: list[str] = []
    for anchor in anchors:
        value = str(anchor).strip()[:200]
        if not value:
            continue
        if not key or anchor_key(value) in key:
            kept.append(value)
        else:
            dropped.append(value)
    return kept[:6], dropped


def raw_hash(text: str) -> str:
    """只对 raw 文本做指纹：同一份课件重传不会让整理稿失效。"""
    return text_hash(text)


def content_rows(db: Session, material_id: int) -> list[PageContent]:
    return list(db.scalars(select(PageContent).where(PageContent.material_id == material_id)
                           .order_by(PageContent.page_no)))


def content_map(db: Session, material_id: int) -> dict[int, PageContent]:
    return {row.page_no: row for row in content_rows(db, material_id)}


def content_row(db: Session, material_id: int, page_no: int) -> PageContent | None:
    return db.scalar(select(PageContent).where(PageContent.material_id == material_id,
                                               PageContent.page_no == page_no))


def clean_tags(values: list[Any]) -> list[str]:
    """标签去重、去空、限长；顺序保留第一次出现的位置。"""
    seen: list[str] = []
    for value in values:
        tag = str(value).strip()
        if tag and tag not in seen:
            seen.append(tag[:80])
    return seen[:MAX_TAGS]


def upsert_content(db: Session, material: Material, page_no: int, *, title: str, topic: str,
                   tags: list[Any], text: str, source: str = "ai", image_state: str = "policy",
                   status: str = "draft", model: str = "", prompt_version: str = "",
                   input_hash: str = "") -> PageContent:
    """Worker/teacher writes one page of digested text; raw stays in `Material.content`."""
    pages = page_map(material)
    if page_no not in pages:
        raise LookupError("本页不存在或页码超出范围")
    if source not in CONTENT_SOURCES:
        raise ValueError("未知的整理稿来源")
    if status not in CONTENT_STATUSES:
        raise ValueError("未知的整理稿状态")
    if image_state not in IMAGE_STATES:
        raise ValueError("未知的页图状态")
    body = (text or "").strip()
    if not body:
        raise ValueError("整理稿不能为空")
    if len(body) > MAX_CONTENT_TEXT:
        raise ValueError(f"整理稿不能超过 {MAX_CONTENT_TEXT} 字")
    row = content_row(db, material.id, page_no)
    if row is None:
        row = PageContent(material_id=material.id, page_no=page_no)
        db.add(row)
    row.title = (title or "").strip()[:MAX_TITLE]
    row.topic = (topic or "").strip()[:MAX_TOPIC]
    row.tags = clean_tags(tags)
    row.text = body
    row.raw_text_hash = raw_hash(pages[page_no].get("text") or "")
    row.source = source
    # 教师手改的稿子保持原来的审校结论；模型产出一律回到草稿。
    row.status = status if source == "teacher" else "draft"
    row.image_state = image_state
    row.model = model[:80]
    row.prompt_version = prompt_version[:24]
    row.input_hash = input_hash[:64]
    row.updated_at = now()
    db.flush()
    return row


def sync_content_staleness(db: Session, material: Material) -> bool:
    """原文变了就作废整理稿：它按旧原文组织，不能继续被当作教材。"""
    pages = page_map(material)
    changed = False
    for row in content_rows(db, material.id):
        page = pages.get(row.page_no)
        if page is None or raw_hash(str(page.get("text") or "")) != row.raw_text_hash:
            if row.status in {"draft", "accepted"}:
                row.status = "stale"
                changed = True
    if changed:
        db.flush()
    return changed


def tag_map(db: Session, instance_id: int) -> dict[str, str]:
    """解析成最终标准名：字典里可能先写 c→a、后又写 a→b，链式跟随到不动点。"""
    pairs = {row.alias: row.canonical for row in db.scalars(
        select(MaterialTagDict).where(MaterialTagDict.course_instance_id == instance_id))}
    resolved: dict[str, str] = {}
    for alias in pairs:
        current, hops = alias, 0
        while current in pairs and hops < 8:
            if pairs[current] == current:
                break
            current = pairs[current]
            hops += 1
        resolved[alias] = current
    return resolved


def record_tag_map(db: Session, instance_id: int, mapping: dict[str, Any], *,
                   material_id: int | None = None) -> int:
    """写入课程级字典；同一别名重复归并时以最新一次为准。"""
    existing = {row.alias: row for row in db.scalars(
        select(MaterialTagDict).where(MaterialTagDict.course_instance_id == instance_id))}
    written = 0
    for alias, canonical in mapping.items():
        alias, canonical = str(alias).strip()[:80], str(canonical).strip()[:80]
        if not alias or not canonical:
            continue
        row = existing.get(alias)
        if row is None:
            row = MaterialTagDict(course_instance_id=instance_id, alias=alias, canonical=canonical,
                                  source_material_id=material_id)
            db.add(row)
            existing[alias] = row
        else:
            row.canonical = canonical
            row.source_material_id = material_id or row.source_material_id
        written += 1
    db.flush()
    return written
