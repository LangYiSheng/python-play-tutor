"""整册讲稿：4 页一窗，从整理稿生成；回看/前瞻预留位置。

窗口是实验 D3 的形态：本窗只带 4 页整理稿，不塞前文讲稿、不带后文。
- `LOOKBACK_PAGES` / `LOOKAHEAD_PAGES` 默认 0，改这两个数并在 `window_context()` 里拼内容即可启用；
- 提示词模板已留 `{context}` 段落，context 为空时不占位置；
- 窗口分组与幂等键都不依赖上下文，所以加回看/前瞻不会动数据模型。

只处理「缺讲稿、整理稿已变、或换了提示词/模型」的页；教师已接受的页不覆盖。
"""

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Material, now
from . import client as model_client
from . import config, prompts, repository
from .contracts import AuthoringSettings, ChatReply, GeneratedPage, Quota
from .models import PageNarration

log = logging.getLogger("narration")

WINDOW = 4
# 预留：回看/前瞻的页数。启用时只改这里 + window_context()。
LOOKBACK_PAGES = 0
LOOKAHEAD_PAGES = 0
MAX_TEXT = 4000
MAX_ANCHORS = 6


class NarrationUnavailable(RuntimeError):
    """Authoring cannot run right now: no credentials, no quota, no digest."""


def page_source(db: Session, material: Material, page_no: int) -> str | None:
    """讲稿页内容：优先整理稿；还没梳理的资料退回解析原文。"""
    raw = repository.page_text(material, page_no)
    if raw is None:
        return None
    row = repository.content_row(db, material.id, page_no)
    return row.text if row is not None and row.text.strip() else raw


def page_hash(db: Session, material: Material, page_no: int) -> str:
    """整理稿（或原文）变了，这一页就该重写。"""
    return repository.narration_hash(db, material, page_no)


def input_hash(db: Session, material: Material, page_no: int, settings: AuthoringSettings,
               seconds: int) -> str:
    parts = "\n".join([page_hash(db, material, page_no), prompts.window_fingerprint(),
                       prompts.WINDOW_VERSION, settings["model"], settings["effort"] or "none", str(seconds)])
    return hashlib.sha256(parts.encode("utf-8")).hexdigest()


def window_context(db: Session, material: Material, page_nos: list[int]) -> str:
    """回看/前瞻的唯一拼装入口，当前默认关闭，返回空串。

    以后启用时在这里拼：前 `LOOKBACK_PAGES` 页的讲稿全文、后 `LOOKAHEAD_PAGES` 页整理稿的标题与开头。
    """
    if not LOOKBACK_PAGES and not LOOKAHEAD_PAGES:
        return ""
    blocks: list[str] = []
    if LOOKBACK_PAGES:
        earlier = [no for no in range(max(1, page_nos[0] - LOOKBACK_PAGES), page_nos[0])]
        earlier_rows = [repository.row(db, material.id, no) for no in earlier]
        text = "\n".join(f"第 {row.page_no} 页：{row.text}" for row in earlier_rows if row and row.text.strip())
        if text:
            blocks.append("前面已经这样讲过（接着这个讲法，不要重复）：\n" + text[-2400:])
    if LOOKAHEAD_PAGES:
        later = [no for no in range(page_nos[-1] + 1, page_nos[-1] + 1 + LOOKAHEAD_PAGES)]
        later_rows = [repository.content_row(db, material.id, no) for no in later]
        text = "；".join(f"第 {row.page_no} 页：{row.text[:80]}" for row in later_rows if row and row.text.strip())
        if text:
            blocks.append("后文（只用来避免撞车与衔接，不要写它们）：" + text)
    return ("\n".join(blocks) + "\n\n") if blocks else ""


def payload(db: Session, material: Material, page_nos: list[int], seconds: int) -> tuple[str, str]:
    """返回 (上下文, 本窗页面 JSON)。上下文默认空，是回看/前瞻的预留位置。"""
    rows = {row.page_no: row for row in repository.content_rows(db, material.id) if row.page_no in page_nos}
    pages = []
    for no in page_nos:
        text = page_source(db, material, no)
        if text is None:
            continue
        row = rows.get(no)
        pages.append({"page_no": no, "title": row.title if row else "", "topic": row.topic if row else "",
                      "tags": row.tags if row else [], "text": text, "target_seconds": seconds})
    return window_context(db, material, page_nos), json.dumps({"pages": pages}, ensure_ascii=False, sort_keys=True)


def call(material: Material, context: str, body: str, settings: AuthoringSettings) -> ChatReply:
    template = prompts.WINDOW_TEMPLATE.replace("{context}", (context + "\n") if context else "")
    messages = [{"role": "system", "content": prompts.WINDOW_SYSTEM},
                {"role": "user", "content": template + "\n本窗每页的整理稿：\n" + body}]
    return model_client.chat(messages, settings=settings, model=settings["model"],
                             effort=settings["effort"] or "none",
                             max_tokens=settings["max_tokens"], require_text=False)


def parse(reply: ChatReply, expected: list[int]) -> list[dict[str, Any]]:
    """页号必须与输入完全一致；单页重写时也接受顶层的 text/anchors。"""
    raw = reply.get("raw") or {}
    items = raw.get("pages")
    if items is None:
        # 单页重写也接受顶层 text/anchors（老客户端与测试桩都这么返回）。
        single = str(raw.get("text") or reply.get("text") or "").strip()
        if len(expected) == 1 and single:
            anchors = raw.get("anchors") or reply.get("anchors") or []
            items = [{"page_no": expected[0], "text": single, "anchors": anchors}]
        else:
            raise ValueError("讲稿结果格式不正确：缺少 pages 数组")
    if not isinstance(items, list):
        raise ValueError("讲稿结果格式不正确：pages 不是数组")
    found: dict[int, dict[str, Any]] = {}
    for item in items:
        if isinstance(item, dict) and isinstance(item.get("page_no"), int):
            found[item["page_no"]] = item
    missing = sorted(set(expected) - set(found))
    extra = sorted(set(found) - set(expected))
    if missing or extra:
        detail = "，".join(filter(None, [f"缺少第 {missing} 页" if missing else "",
                                        f"多出第 {extra} 页" if extra else ""]))
        raise ValueError(f"讲稿页码与输入不一致：{detail}")
    out: list[dict[str, Any]] = []
    for page_no in expected:
        text = str(found[page_no].get("text") or "").strip()
        if not text:
            raise ValueError(f"第 {page_no} 页讲稿为空")
        anchors = [str(a).strip()[:200] for a in (found[page_no].get("anchors") or []) if str(a).strip()]
        out.append({"page_no": page_no, "text": text[:MAX_TEXT], "anchors": anchors[:MAX_ANCHORS]})
    return out


def run_window(db: Session, material: Material, page_nos: list[int], settings: AuthoringSettings,
               seconds: int) -> tuple[list[int], dict[str, int]]:
    """写一窗讲稿；整窗失败不写半截。返回页号与用量。"""
    repository.ensure_lease(db, material.id)
    before = {no: page_hash(db, material, no) for no in page_nos}
    before_revision = {no: repository.revision(repository.row(db, material.id, no)) for no in page_nos}
    context, body = payload(db, material, page_nos, seconds)
    reply = call(material, context, body, settings)
    pages = parse(reply, page_nos)
    # 模型调用期间别的会话可能改过整理稿或讲解：丢掉缓存再校验，避免覆盖别人的修改。
    db.expire_all()
    if any(page_hash(db, material, no) != before[no] for no in page_nos):
        raise ValueError("整理稿已修改，本次生成未覆盖新内容，请重试")
    if any(repository.revision(repository.row(db, material.id, no)) != before_revision[no] for no in page_nos):
        raise ValueError("讲解已被修改，本次生成未覆盖新内容，请重试")
    for page in pages:
        reference = page_source(db, material, page["page_no"]) or ""
        anchors, dropped = repository.grounded_anchors(reference, page["anchors"])
        if dropped:
            log.info("narration page %s: dropped anchors not found on page: %s", page["page_no"], dropped)
        item = repository.row(db, material.id, page["page_no"]) or PageNarration(
            material_id=material.id, page_no=page["page_no"])
        item.text = page["text"]
        item.bridge_in = ""
        item.target_seconds = seconds
        item.status = "draft"
        item.source = "ai_generated"
        item.page_hash = page_hash(db, material, page["page_no"])
        item.input_hash = input_hash(db, material, page["page_no"], settings, seconds)
        item.prompt_version = prompts.WINDOW_VERSION
        item.model = str(reply.get("model") or settings["model"])
        item.image_used = False
        item.anchors = anchors
        item.edited_by_teacher = False
        item.reviewed_by = None
        item.reviewed_at = None
        item.updated_at = now()
        db.add(item)
    usage = reply.get("usage") or {}
    db.commit()
    return [page["page_no"] for page in pages], {
        key: int(usage.get(key) or 0)
        for key in ("prompt_tokens", "completion_tokens", "cache_hit_tokens", "cache_miss_tokens")}


def generate_page(db: Session, material: Material, page_no: int, *, instance_id: int,
                  target_seconds: int | None = None) -> GeneratedPage:
    """单页重写：用同一个窗口提示词，只放这一页。"""
    reason = config.unavailable_reason(db)
    if reason:
        raise NarrationUnavailable(reason)
    if repository.page_text(material, page_no) is None:
        raise LookupError("本页不存在或页码超出范围")
    if not (page_source(db, material, page_no) or "").strip():
        raise NarrationUnavailable("这一页没有可讲解的内容")
    settings = config.settings(db)
    seconds = repository.trim_seconds(target_seconds)
    existing = repository.row(db, material.id, page_no)
    fingerprint = input_hash(db, material, page_no, settings, seconds)
    if existing is not None and existing.input_hash == fingerprint and existing.status in {"draft", "accepted"}:
        return {"page_no": page_no, "status": existing.status, "reused": True, "model": existing.model}
    if used_today(db, instance_id) >= settings["daily_pages"]:
        raise NarrationUnavailable("本班今日讲解生成额度已用完，请明天再试")
    run_window(db, material, [page_no], settings, seconds)
    row = repository.row(db, material.id, page_no)
    return {"page_no": page_no, "status": row.status if row else "draft", "reused": False,
            "model": row.model if row else "", "chars": len(row.text) if row else 0, "image_used": False}


def generate_range(db: Session, material: Material, *, first: int, last: int, instance_id: int,
                   target_seconds: int | None = None, only_pages: list[int] | None = None) -> list[GeneratedPage]:
    """4 页一窗整批生成；一窗失败不影响已完成的窗。"""
    pages = repository.page_map(material)
    wanted = [page_no for page_no in range(first, last + 1)
              if page_no in pages and (only_pages is None or page_no in only_pages)]
    if not wanted:
        raise LookupError("指定范围内没有可生成的页面")
    settings = config.settings(db)
    seconds = repository.trim_seconds(target_seconds)
    results: list[GeneratedPage] = []
    todo: list[int] = []
    for page_no in wanted:
        existing = repository.row(db, material.id, page_no)
        if existing is not None and existing.input_hash == input_hash(db, material, page_no, settings, seconds) \
                and existing.status in {"draft", "accepted"}:
            results.append({"page_no": page_no, "status": existing.status, "reused": True, "model": existing.model})
        elif not (page_source(db, material, page_no) or "").strip():
            results.append({"page_no": page_no, "status": "failed", "error": "这一页没有可讲解的内容"})
        else:
            todo.append(page_no)
    groups = [todo[start:start + WINDOW] for start in range(0, len(todo), WINDOW)]
    repository.beat(db, material.id, done=0, total=len(groups))
    db.commit()
    for index, group in enumerate(groups, start=1):
        try:
            written, _usage = run_window(db, material, group, settings, seconds)
            results.extend({"page_no": no, "status": "draft", "reused": False, "model": settings["model"]}
                           for no in written)
            repository.beat(db, material.id, done=index, total=len(groups),
                            message=f"第 {group[0]}–{group[-1]} 页")
            db.commit()
        except (NarrationUnavailable, LookupError):
            db.rollback()
            raise
        except Exception as exc:  # noqa: BLE001 -- 一窗失败不拖垮整批
            db.rollback()
            log.warning("narration window %s failed: %s", group, exc)
            results.extend({"page_no": no, "status": "failed", "error": str(exc)[:200]} for no in group)
            repository.ensure_lease(db, material.id)
            repository.beat(db, material.id, done=index, total=len(groups))
            db.commit()
    return results


def used_today(db: Session, instance_id: int) -> int:
    start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    return db.scalar(
        select(func.count()).select_from(PageNarration).join(
            Material, Material.id == PageNarration.material_id).where(
            Material.course_instance_id == instance_id, PageNarration.source == "ai_generated",
            PageNarration.updated_at >= start)) or 0


def quota(db: Session, instance_id: int) -> Quota:
    settings = config.settings(db)
    return {"used_today": used_today(db, instance_id), "daily_limit": settings["daily_pages"],
            "available": config.unavailable_reason(db) is None}
