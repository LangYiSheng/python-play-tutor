"""整册讲稿：4 页一窗，从整理稿生成；回看/前瞻预留位置。

窗口是实验 D3 的形态：本窗只带 4 页整理稿，不塞前文讲稿、不带后文。
- `LOOKBACK_PAGES` / `LOOKAHEAD_PAGES` 默认 0，改这两个数并在 `window_context()` 里拼内容即可启用；
- 提示词模板已留 `{context}` 段落，context 为空时不占位置；
- 窗口分组与幂等键都不依赖上下文，所以加回看/前瞻不会动数据模型。

只处理「缺讲稿、整理稿已变、或换了提示词/模型」的页；教师已接受的页不覆盖。
"""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..lectio.engine import pacing
from ..models import Material, now
from . import client as model_client
from . import config, defaults, prompts, repository
from .contracts import AuthoringSettings, ChatReply, GeneratedPage, Quota
from .models import PageNarration

log = logging.getLogger("narration")

WINDOW = 4
SCRIPT_WORKERS = defaults.worker_count("REBORN_NARRATION_WORKERS", 4)
# 预留：回看/前瞻的页数。启用时只改这里 + window_context()。
LOOKBACK_PAGES = 0
LOOKAHEAD_PAGES = 0
MAX_TEXT = 4000
MAX_ANCHORS = 6


class NarrationUnavailable(RuntimeError):
    """Authoring cannot run right now: no credentials, no quota, no digest."""


@dataclass(frozen=True)
class ScriptOptions:
    style_preset: str = pacing.SCRIPT_STYLE_DEFAULT_PRESET
    custom_style: str = ""
    section_minutes: float | None = None
    chapter_minutes: float | None = None
    use_pacing: bool = False


def _pacing_enabled(opts: ScriptOptions) -> bool:
    return opts.use_pacing or opts.section_minutes is not None or opts.chapter_minutes is not None


def _pacing_budgets(db: Session, material: Material, opts: ScriptOptions) -> dict[int, dict[str, Any]]:
    if not _pacing_enabled(opts):
        return {}
    raw_map = repository.page_map(material)
    contents = {row.page_no: row for row in repository.content_rows(db, material.id)}
    pages: list[dict[str, Any]] = []
    for no in sorted(raw_map):
        raw_text = str(raw_map[no].get("text") or "")
        row = contents.get(no)
        text = row.text if row is not None and row.text.strip() else raw_text
        pages.append({"page_no": no, "raw_text": raw_text, "text": text})
    if not pages:
        return {}
    sec_min = opts.section_minutes if opts.section_minutes is not None else pacing.SECTION_TARGET_MINUTES
    ch_min = opts.chapter_minutes if opts.chapter_minutes is not None else pacing.CHAPTER_TARGET_MINUTES
    return pacing.budget_for_pages(pages, section_minutes=sec_min, chapter_minutes=ch_min)


def _style_context(opts: ScriptOptions, budgets: dict[int, dict[str, Any]], page_nos: list[int]) -> str:
    blocks: list[str] = []
    style_hint = pacing.build_style_hint(opts.style_preset, opts.custom_style)
    if style_hint:
        blocks.append("授课风格要求：\n" + style_hint)
    if budgets:
        lines: list[str] = []
        for no in page_nos:
            info = budgets.get(no)
            if info is None:
                continue
            kind = str(info.get("kind") or "content")
            kind_label = pacing.PAGE_KIND_LABELS.get(kind, kind)
            sec = str(info.get("section") or pacing.UNLABELED_SECTION)
            budget = int(info.get("char_budget") or 0)
            lines.append(f"第 {no} 页（{sec}/{kind_label}）：约 {budget} 字")
        if lines:
            blocks.append("本窗每页节奏预算（请尽量贴合每页字数预算，不注水不超长）：\n" + "\n".join(lines))
    return "\n\n".join(blocks)


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


def input_hash(
    db: Session,
    material: Material,
    page_no: int,
    settings: AuthoringSettings,
    seconds: int,
    *,
    style_preset: str = pacing.SCRIPT_STYLE_DEFAULT_PRESET,
    custom_style: str = "",
    char_budget: int | None = None,
) -> str:
    parts = [
        page_hash(db, material, page_no),
        prompts.window_fingerprint(),
        prompts.WINDOW_VERSION,
        settings["model"],
        settings["effort"] or "none",
        str(seconds),
    ]
    clean_custom = custom_style.strip()
    if style_preset != pacing.SCRIPT_STYLE_DEFAULT_PRESET or clean_custom or char_budget is not None:
        parts.append(f"style:{style_preset}")
        if clean_custom:
            parts.append(f"custom:{clean_custom}")
        if char_budget is not None:
            parts.append(f"budget:{char_budget}")
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


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


def payload(
    db: Session,
    material: Material,
    page_nos: list[int],
    seconds: int,
    *,
    options: ScriptOptions | None = None,
    budgets: dict[int, dict[str, Any]] | None = None,
) -> tuple[str, str]:
    """返回 (上下文, 本窗页面 JSON)。上下文含可选风格与节奏预算提示。"""
    rows = {row.page_no: row for row in repository.content_rows(db, material.id) if row.page_no in page_nos}
    budget_map = budgets or {}
    pages: list[dict[str, Any]] = []
    for no in page_nos:
        text = page_source(db, material, no)
        if text is None:
            continue
        row = rows.get(no)
        item: dict[str, Any] = {
            "page_no": no,
            "title": row.title if row else "",
            "topic": row.topic if row else "",
            "tags": row.tags if row else [],
            "text": text,
            "target_seconds": seconds,
        }
        info = budget_map.get(no)
        if info is not None:
            item["char_budget"] = int(info["char_budget"])
            item["section"] = str(info["section"])
        pages.append(item)
    base_ctx = window_context(db, material, page_nos).strip()
    extra_ctx = _style_context(options or ScriptOptions(), budget_map, page_nos).strip()
    combined = "\n\n".join(part for part in (base_ctx, extra_ctx) if part)
    context = (combined + "\n\n") if combined else ""
    return context, json.dumps({"pages": pages}, ensure_ascii=False, sort_keys=True)


def call(material: Material | str, context: str, body: str, settings: AuthoringSettings) -> ChatReply:
    del material
    template = prompts.WINDOW_TEMPLATE.replace("{context}", (context + "\n") if context else "")
    messages = [{"role": "system", "content": prompts.WINDOW_SYSTEM},
                {"role": "user", "content": template + "\n本窗每页的整理稿：\n" + body}]
    return model_client.chat(messages, settings=settings, model=settings["model"],
                             effort=settings["effort"] or "none",
                             max_tokens=settings["max_tokens"], require_text=False)


def _coerce_page_no(raw_no: Any) -> int | None:
    if isinstance(raw_no, bool):
        return None
    if isinstance(raw_no, int):
        return raw_no
    if isinstance(raw_no, str) and raw_no.strip().isdigit():
        return int(raw_no.strip())
    return None


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
        if not isinstance(item, dict):
            continue
        pno = _coerce_page_no(item.get("page_no"))
        if pno is not None:
            found[pno] = {**item, "page_no": pno}
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


def _call_window_with_repair(
    material: Material | str,
    page_nos: list[int],
    context: str,
    body: str,
    settings: AuthoringSettings,
) -> tuple[list[dict[str, Any]], dict[str, int], str]:
    """线程安全的纯模型调用与解析；多页窗偶发漏页时自动对缺失页补调一次。"""
    reply = call(material, context, body, settings)
    usage_raw = reply.get("usage") or {}
    usage = {
        key: int(usage_raw.get(key) or 0)
        for key in ("prompt_tokens", "completion_tokens", "cache_hit_tokens", "cache_miss_tokens")
    }
    model_name = str(reply.get("model") or settings["model"])
    try:
        return parse(reply, page_nos), usage, model_name
    except ValueError:
        if len(page_nos) <= 1:
            raise
        raw = reply.get("raw") or {}
        items = raw.get("pages")
        if not isinstance(items, list):
            raise
        found = {}
        for item in items:
            if isinstance(item, dict):
                pno = _coerce_page_no(item.get("page_no"))
                if pno is not None:
                    found[pno] = {**item, "page_no": pno}
        missing = sorted(set(page_nos) - set(found))
        extra = sorted(set(found) - set(page_nos))
        if not missing or extra or len(missing) >= len(page_nos):
            raise
        src_pages = json.loads(body).get("pages") or []
        by_no = {int(p["page_no"]): p for p in src_pages if isinstance(p, dict) and "page_no" in p}
        if not all(no in by_no for no in missing):
            raise
        repair_body = json.dumps({"pages": [by_no[no] for no in missing]}, ensure_ascii=False, sort_keys=True)
        repair_reply = call(material, context, repair_body, settings)
        r_usage = repair_reply.get("usage") or {}
        for key in usage:
            usage[key] += int(r_usage.get(key) or 0)
        repaired_list = parse(repair_reply, missing)
        for item in repaired_list:
            found[item["page_no"]] = item
        out: list[dict[str, Any]] = []
        for page_no in page_nos:
            text = str(found[page_no].get("text") or "").strip()
            if not text:
                raise ValueError(f"第 {page_no} 页讲稿为空")
            anchors = [str(a).strip()[:200] for a in (found[page_no].get("anchors") or []) if str(a).strip()]
            out.append({"page_no": page_no, "text": text[:MAX_TEXT], "anchors": anchors[:MAX_ANCHORS]})
        return out, usage, model_name


def _commit_window_pages(
    db: Session,
    material: Material,
    page_nos: list[int],
    pages: list[dict[str, Any]],
    model_name: str,
    before: dict[int, str],
    before_revision: dict[int, str],
    settings: AuthoringSettings,
    seconds: int,
    opts: ScriptOptions,
    budget_map: dict[int, dict[str, Any]],
) -> list[int]:
    """主线程校验并发修改并落库。"""
    db.expire_all()
    if any(page_hash(db, material, no) != before[no] for no in page_nos):
        raise ValueError("整理稿已修改，本次生成未覆盖新内容，请重试")
    if any(repository.revision(repository.row(db, material.id, no)) != before_revision[no] for no in page_nos):
        raise ValueError("讲解已被修改，本次生成未覆盖新内容，请重试")
    for page in pages:
        pno = int(page["page_no"])
        reference = page_source(db, material, pno) or ""
        anchors, dropped = repository.grounded_anchors(reference, page["anchors"])
        if dropped:
            log.info("narration page %s: dropped anchors not found on page: %s", pno, dropped)
        item = repository.row(db, material.id, pno) or PageNarration(material_id=material.id, page_no=pno)
        item.text = page["text"]
        item.bridge_in = ""
        item.target_seconds = seconds
        item.status = "draft"
        item.source = "ai_generated"
        item.page_hash = page_hash(db, material, pno)
        b_info = budget_map.get(pno)
        page_budget = int(b_info["char_budget"]) if b_info is not None else None
        item.input_hash = input_hash(
            db, material, pno, settings, seconds,
            style_preset=opts.style_preset, custom_style=opts.custom_style, char_budget=page_budget,
        )
        item.prompt_version = prompts.WINDOW_VERSION
        item.model = model_name
        item.image_used = False
        item.anchors = anchors
        item.edited_by_teacher = False
        item.reviewed_by = None
        item.reviewed_at = None
        item.updated_at = now()
        db.add(item)
    db.commit()
    return [page["page_no"] for page in pages]


def run_window(
    db: Session,
    material: Material,
    page_nos: list[int],
    settings: AuthoringSettings,
    seconds: int,
    *,
    options: ScriptOptions | None = None,
    budgets: dict[int, dict[str, Any]] | None = None,
) -> tuple[list[int], dict[str, int]]:
    """写一窗讲稿；整窗失败不写半截。返回页号与用量。"""
    opts = options or ScriptOptions()
    budget_map = budgets if budgets is not None else _pacing_budgets(db, material, opts)
    repository.ensure_lease(db, material.id)
    before = {no: page_hash(db, material, no) for no in page_nos}
    before_revision = {no: repository.revision(repository.row(db, material.id, no)) for no in page_nos}
    context, body = payload(db, material, page_nos, seconds, options=opts, budgets=budget_map)
    pages, usage, model_name = _call_window_with_repair(material, page_nos, context, body, settings)
    written = _commit_window_pages(
        db, material, page_nos, pages, model_name, before, before_revision, settings, seconds, opts, budget_map
    )
    return written, usage


def generate_page(
    db: Session,
    material: Material,
    page_no: int,
    *,
    instance_id: int,
    target_seconds: int | None = None,
    style_preset: str = pacing.SCRIPT_STYLE_DEFAULT_PRESET,
    custom_style: str = "",
    section_minutes: float | None = None,
    chapter_minutes: float | None = None,
    use_pacing: bool = False,
) -> GeneratedPage:
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
    opts = ScriptOptions(
        style_preset=style_preset,
        custom_style=custom_style,
        section_minutes=section_minutes,
        chapter_minutes=chapter_minutes,
        use_pacing=use_pacing,
    )
    budgets = _pacing_budgets(db, material, opts)
    b_info = budgets.get(page_no)
    char_budget = int(b_info["char_budget"]) if b_info is not None else None
    existing = repository.row(db, material.id, page_no)
    fingerprint = input_hash(
        db, material, page_no, settings, seconds,
        style_preset=opts.style_preset, custom_style=opts.custom_style, char_budget=char_budget,
    )
    if existing is not None and existing.input_hash == fingerprint and existing.status in {"draft", "accepted"}:
        return {"page_no": page_no, "status": existing.status, "reused": True, "model": existing.model}
    if used_today(db, instance_id) >= settings["daily_pages"]:
        raise NarrationUnavailable("本班今日讲解生成额度已用完，请明天再试")
    run_window(db, material, [page_no], settings, seconds, options=opts, budgets=budgets)
    row = repository.row(db, material.id, page_no)
    return {"page_no": page_no, "status": row.status if row else "draft", "reused": False,
            "model": row.model if row else "", "chars": len(row.text) if row else 0, "image_used": False}


def generate_range(
    db: Session,
    material: Material,
    *,
    first: int,
    last: int,
    instance_id: int,
    target_seconds: int | None = None,
    only_pages: list[int] | None = None,
    style_preset: str = pacing.SCRIPT_STYLE_DEFAULT_PRESET,
    custom_style: str = "",
    section_minutes: float | None = None,
    chapter_minutes: float | None = None,
    use_pacing: bool = False,
) -> list[GeneratedPage]:
    """4 页一窗整批生成；一窗失败不影响已完成的窗。"""
    pages = repository.page_map(material)
    wanted = [page_no for page_no in range(first, last + 1)
              if page_no in pages and (only_pages is None or page_no in only_pages)]
    if not wanted:
        raise LookupError("指定范围内没有可生成的页面")
    settings = config.settings(db)
    seconds = repository.trim_seconds(target_seconds)
    opts = ScriptOptions(
        style_preset=style_preset,
        custom_style=custom_style,
        section_minutes=section_minutes,
        chapter_minutes=chapter_minutes,
        use_pacing=use_pacing,
    )
    budgets = _pacing_budgets(db, material, opts)
    results: list[GeneratedPage] = []
    todo: list[int] = []
    for page_no in wanted:
        existing = repository.row(db, material.id, page_no)
        b_info = budgets.get(page_no)
        char_budget = int(b_info["char_budget"]) if b_info is not None else None
        fp = input_hash(
            db, material, page_no, settings, seconds,
            style_preset=opts.style_preset, custom_style=opts.custom_style, char_budget=char_budget,
        )
        if existing is not None and existing.input_hash == fp and existing.status in {"draft", "accepted"}:
            results.append({"page_no": page_no, "status": existing.status, "reused": True, "model": existing.model})
        elif not (page_source(db, material, page_no) or "").strip():
            results.append({"page_no": page_no, "status": "failed", "error": "这一页没有可讲解的内容"})
        else:
            todo.append(page_no)
    groups = [todo[start:start + WINDOW] for start in range(0, len(todo), WINDOW)]
    repository.beat(db, material.id, done=0, total=len(groups))
    db.commit()
    workers = max(1, SCRIPT_WORKERS)
    if LOOKBACK_PAGES or LOOKAHEAD_PAGES:
        workers = 1
    completed = 0
    for start in range(0, len(groups), workers):
        batch = groups[start:start + workers]
        repository.check_cancel(db, material.id)
        repository.ensure_lease(db, material.id)
        batch_pages = [no for grp in batch for no in grp]
        repository.beat(db, material.id, checkpoint={"group": start + 1, "pages": batch_pages[:WINDOW * 2]})
        db.commit()

        prepared: list[tuple[list[int], dict[int, str], dict[int, str], str, str]] = []
        for group in batch:
            before = {no: page_hash(db, material, no) for no in group}
            before_revision = {no: repository.revision(repository.row(db, material.id, no)) for no in group}
            context, body = payload(db, material, group, seconds, options=opts, budgets=budgets)
            prepared.append((group, before, before_revision, context, body))

        material_title = material.title
        outcomes: list[tuple[list[dict[str, Any]] | None, str, BaseException | None]] = []
        if len(prepared) == 1:
            g, _, _, ctx, bdy = prepared[0]
            try:
                pages_res, _, model_name = _call_window_with_repair(material_title, g, ctx, bdy, settings)
                outcomes.append((pages_res, model_name, None))
            except BaseException as exc:  # noqa: BLE001
                outcomes.append((None, settings["model"], exc))
        else:
            with ThreadPoolExecutor(max_workers=len(prepared)) as pool:
                futs = [
                    pool.submit(_call_window_with_repair, material_title, g, ctx, bdy, settings)
                    for g, _, _, ctx, bdy in prepared
                ]
                for fut in futs:
                    try:
                        pages_res, _, model_name = fut.result()
                        outcomes.append((pages_res, model_name, None))
                    except BaseException as exc:  # noqa: BLE001
                        outcomes.append((None, settings["model"], exc))

        for (group, before, before_revision, _, _), (pages_out, model_name, err) in zip(prepared, outcomes):
            completed += 1
            try:
                if err is not None:
                    raise err
                assert pages_out is not None
                repository.ensure_lease(db, material.id)
                written = _commit_window_pages(
                    db, material, group, pages_out, model_name, before, before_revision, settings, seconds, opts, budgets
                )
                results.extend({"page_no": no, "status": "draft", "reused": False, "model": model_name} for no in written)
                repository.beat(
                    db,
                    material.id,
                    done=completed,
                    total=len(groups),
                    message=f"第 {group[0]}–{group[-1]} 页",
                    checkpoint={},
                )
                db.commit()
            except (NarrationUnavailable, LookupError, repository.CancellationRequested):
                db.rollback()
                raise
            except Exception as exc:  # noqa: BLE001 -- 一窗失败不拖垮整批
                db.rollback()
                log.warning("narration window %s failed: %s", group, exc)
                results.extend({"page_no": no, "status": "failed", "error": str(exc)[:200]} for no in group)
                repository.ensure_lease(db, material.id)
                repository.beat(db, material.id, done=completed, total=len(groups), checkpoint={})
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
