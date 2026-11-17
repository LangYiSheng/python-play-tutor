"""Whole-deck calibration: a rolling summary walks the whole material, then flags pages.

A 560-page course cannot be reviewed in one prompt (hundreds of thousands of tokens), so
the pass is a sliding window that carries a rolling summary and term table forward. The
output is a report, not silent rewrites: flagged pages are re-generated only when a
teacher asks for it, and approved pages are never edited behind their back.

两次请求之间可以停：每个窗口结束都把「游标 + 合并结果」写进本次运行的报告行，下一次
请求从 next_index 继续；整册输入没变（deck_fingerprint 相同）时直接复用上一份完整报告，
一次模型调用都不发。
"""

import base64
import hashlib
import json
import time
from typing import Any, Callable, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Material, now
from . import client as model_client
from . import config, repository, render
from .input_policy import prefers_image, policy_fingerprint
from .contracts import AuthoringSettings, AppliedCalibration, CalibrationIssue
from .models import NarrationCalibration, PageNarration

WINDOW = 4
SUMMARY_LIMIT = 1800
TERM_LIMIT = 40
# 报告不能无限长：长资料能报出上千条 issue，只保留前 N 条并明确标出被截断。
ISSUE_LIMIT = 120
# 单窗文本预算（讲解+原文合计）与图片上限；超出时按页均分，不是静默降级，报告会记录。
WINDOW_TEXT_BUDGET = 9000
SHRUNK_TEXT_BUDGET = 4500
NARRATION_MAX, SOURCE_MAX = 4000, 2000
IMAGE_LIMIT = WINDOW
SHRUNK_IMAGE_LIMIT = 2
# 一次 HTTP 请求最多跑这么久；超时前至少跑完一个窗口，避免永远不前进。
SLICE_SECONDS = 45
# 提示词或前缀结构变了就必须重算：这个版本号进 deck 指纹。
CALIBRATE_VERSION = "cal-v2"

SYSTEM = (
    "你在校对一份课程讲解稿的整体质量。只依据给出的原文、页面图像与讲解判断，不要虚构页面内容。"
    "只指出确实存在的问题；没问题就不要凑数。"
)

TEMPLATE = """检查整份讲解的三件事：
1. 前后是否连贯（同一概念是否前后说法冲突、是否有明显跳跃或重复）。
2. 与幻灯片原文是否一致（讲解是否讲了页面上没有的内容）。
3. 术语是否统一（同一个东西是否被叫成不同名字）。

你会收到：之前窗口的滚动摘要、已用术语表、本窗口每页讲解及原文，必要时附页图。
原文标记截断时只判断已给内容；没有原文或页图时不得判断 mismatch，不把补充说明自动当成错误。
只输出 JSON：{"summary": "更新后的滚动摘要，不超过400字", "terms": ["术语"], "issues": [{"page_no": 3, "kind": "flow|mismatch|term", "detail": "一句话说明"}]}
issues 最多 8 条，没有就给空数组。kind：flow=连贯性，mismatch=与页面不符，term=术语不统一。
"""


def page_limits(budget: int, count: int) -> tuple[int, int]:
    """Split one window's text budget across its pages instead of always sending the maximum."""
    per_page = max(600, budget // max(1, count))
    narration = min(NARRATION_MAX, int(per_page * 0.7))
    return narration, min(SOURCE_MAX, max(200, per_page - narration))


def image_input(material: Material, source_text: str) -> bool:
    """校准只看页图与文本的二选一，规则与生成共用 input_policy。"""
    return prefers_image(material, source_text, purpose="calibration")


def prefix_text(material: Material) -> str:
    """Only whole-deck constants go in the prefix, so the provider can cache it."""
    return "\n".join([TEMPLATE, f"材料：{material.title}", "输出字段：summary、terms、issues。"])


def prefix_fingerprint(material: Material) -> str:
    return hashlib.sha256((SYSTEM + "\n" + prefix_text(material)).encode("utf-8")).hexdigest()


def deck_fingerprint(material: Material, items: list[PageNarration], settings: AuthoringSettings) -> str:
    """Everything that changes the review: prompt prefix, model, windowing and page revisions."""
    parts = [CALIBRATE_VERSION, prefix_fingerprint(material), settings["vision_model"], "low",
             str(WINDOW), str(WINDOW_TEXT_BUDGET), policy_fingerprint()]
    parts += [f"{item.page_no}:{repository.revision(item)}" for item in items]
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def participating(db: Session, material: Material) -> list[PageNarration]:
    return [row for row in repository.rows(db, material.id)
            if row.text.strip() and row.status in {"draft", "accepted"}]


def windows(items: list[PageNarration]) -> list[list[PageNarration]]:
    ordered = sorted(items, key=lambda row: row.page_no)
    return [ordered[start:start + WINDOW] for start in range(0, len(ordered), WINDOW)]


def latest_any(db: Session, material_id: int) -> NarrationCalibration | None:
    return db.scalar(select(NarrationCalibration).where(NarrationCalibration.material_id == material_id)
                     .order_by(NarrationCalibration.id.desc()).limit(1))


def latest_complete(db: Session, material_id: int, limit: int = 50) -> NarrationCalibration | None:
    """Rows are per run and never overwritten, so a failed run cannot eat the last good report.

    `complete` lives in the report JSON (no schema change); rows written before this
    change have no marker and count as complete.
    """
    rows = db.scalars(select(NarrationCalibration).where(NarrationCalibration.material_id == material_id)
                      .order_by(NarrationCalibration.id.desc()).limit(limit))
    return next((row for row in rows if (row.report or {}).get("complete", True)), None)


def _empty_state(material: Material, items: list[PageNarration], fingerprint: str,
                 settings: AuthoringSettings) -> dict[str, Any]:
    return {
        "complete": False,
        "deck_fingerprint": fingerprint,
        "calibrate_version": CALIBRATE_VERSION,
        "prefix_hash": prefix_fingerprint(material),
        "model": settings["vision_model"],
        "effort": "low",
        "windows": len(windows(items)),
        "windows_done": 0,
        "next_index": 0,
        "pages": len(items),
        "pages_seen": 0,
        "summary": "",
        "terms": [],
        "issues": [],
        "issues_truncated": False,
        "render_errors": [],
        "shrunk_windows": [],
        "revisions": {str(item.page_no): repository.revision(item) for item in items},
        "window_budget": {"chars": WINDOW_TEXT_BUDGET, "images": IMAGE_LIMIT},
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "cache_hit_tokens": 0, "cache_miss_tokens": 0},
        "generated_at": None,
    }


def reserve(db: Session, material: Material, items: list[PageNarration]) -> tuple[NarrationCalibration, bool, bool]:
    """Return (row, reused, resuming): a finished identical run is free to replay."""
    settings = config.settings(db)
    fingerprint = deck_fingerprint(material, items, settings)
    finished = latest_complete(db, material.id)
    if finished is not None and (finished.report or {}).get("deck_fingerprint") == fingerprint:
        return finished, True, False
    current = latest_any(db, material.id)
    state = (current.report or {}) if current is not None else {}
    if current is not None and not state.get("complete", True) and state.get("deck_fingerprint") == fingerprint:
        return current, False, True
    row = NarrationCalibration(material_id=material.id, report=_empty_state(material, items, fingerprint, settings),
                               windows=len(windows(items)))
    db.add(row)
    db.flush()
    return row, False, False


def _window_payload(material: Material, group: list[PageNarration], state: dict[str, Any], *,
                    budget: int, image_limit: int) -> tuple[dict[str, Any], list[dict[str, Any]], set[int], bool]:
    narration_limit, source_limit = page_limits(budget, len(group))
    pages: list[dict[str, Any]] = []
    images: list[dict[str, Any]] = []
    evidence: set[int] = set()
    # 只有真的用了降预算（重试路径）才标记，默认预算下的常规截断不算“缩减”。
    shrunk = budget < WINDOW_TEXT_BUDGET
    attached = 0
    for item in group:
        text = item.text.strip()
        source = repository.page_text(material, item.page_no) or ""
        page: dict[str, Any] = {"page_no": item.page_no, "status": item.status,
                                "narration": text[:narration_limit], "source_text": source[:source_limit],
                                "source_truncated": len(source) > source_limit}
        if image_input(material, source) and attached < image_limit:
            try:
                image = render.render_page(material, item.page_no)
            except ValueError:
                # 缺少渲染工具或单页渲染失败：如实记录，退回文本，不假装看过页面。
                state["render_errors"] = sorted({*(state.get("render_errors") or []), item.page_no})
                image = None
            if image is not None:
                attached += 1
                images.extend([{"type": "text", "text": f"第 {item.page_no} 页原图"},
                               {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(image).decode("ascii")}}])
                page["source_text"] = ""
                page["source_truncated"] = False
                evidence.add(item.page_no)
        if page["source_text"].strip():
            evidence.add(item.page_no)
        pages.append(page)
    return {"summary": state.get("summary") or "", "terms": state.get("terms") or [], "pages": pages}, images, evidence, shrunk


def _call(material: Material, payload: dict[str, Any], images: list[dict[str, Any]],
          settings: AuthoringSettings) -> dict[str, Any]:
    content = prefix_text(material) + "\n\n" + json.dumps(payload, ensure_ascii=False, sort_keys=True)
    user: Any = [{"type": "text", "text": content}, *images] if images else content
    messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]
    # 校准整轮固定视觉模型：同一模型的前缀缓存才可能连续命中。
    # 输出上限取作者期配置（默认8000）：开思考时推理 token 计入 max_tokens，
    # 硬编码小值会随机报 finish_reason=length。
    return cast(dict[str, Any], model_client.chat(messages, settings=settings, model=settings["vision_model"],
                                                 effort="low", max_tokens=settings["max_tokens"], require_text=False))


def _merge(state: dict[str, Any], reply: dict[str, Any], group: list[PageNarration],
           evidence: set[int], index: int) -> None:
    raw = reply.get("raw") or {}
    state["summary"] = str(raw.get("summary") or state.get("summary") or "")[:SUMMARY_LIMIT]
    terms = raw.get("terms") or state.get("terms") or []
    state["terms"] = [str(term)[:40] for term in terms][:TERM_LIMIT]
    status_by_page = {item.page_no: item.status for item in group}
    issues: list[CalibrationIssue] = list(state.get("issues") or [])
    seen = {(issue["page_no"], issue["kind"]) for issue in issues}
    for issue in (raw.get("issues") or [])[:8]:
        if not isinstance(issue, dict):
            continue
        page_no, kind = issue.get("page_no"), issue.get("kind")
        if page_no not in status_by_page or kind not in {"flow", "mismatch", "term"}:
            continue
        if kind == "mismatch" and page_no not in evidence:
            continue
        key = (page_no, kind)
        if key in seen:
            continue
        seen.add(key)
        issues.append(CalibrationIssue(page_no=page_no, kind=str(kind)[:16], detail=str(issue.get("detail") or "")[:200],
                                       status="accepted" if status_by_page[page_no] == "accepted" else "draft"))
    state["issues_truncated"] = len(issues) > ISSUE_LIMIT
    state["issues"] = issues[:ISSUE_LIMIT]
    state["windows_done"] = index + 1
    state["pages_seen"] = int(state.get("pages_seen") or 0) + len(group)
    usage = reply.get("usage") or {}
    totals = dict(state.get("usage") or {})
    for field in ("prompt_tokens", "completion_tokens", "cache_hit_tokens", "cache_miss_tokens"):
        totals[field] = int(totals.get(field) or 0) + int(usage.get(field) or 0)
    state["usage"] = totals


def advance(db: Session, material: Material, row: NarrationCalibration, items: list[PageNarration]) -> NarrationCalibration:
    """Run windows until the slice budget is spent; every window persists on its own."""
    groups = windows(items)
    state = dict(row.report or {})
    settings = config.settings(db)
    deadline = time.monotonic() + SLICE_SECONDS
    index = int(state.get("next_index") or 0)
    if state.get("windows") != len(groups) or index > len(groups):
        index = 0
    ran = 0
    while index < len(groups) and (ran == 0 or time.monotonic() < deadline):
        repository.ensure_lease(db, material.id)
        repository.beat(db, material.id, done=index, total=len(groups))
        db.commit()
        group = groups[index]
        payload, images, evidence, shrunk = _window_payload(material, group, state, budget=WINDOW_TEXT_BUDGET,
                                                            image_limit=IMAGE_LIMIT)
        try:
            reply = _call(material, payload, images, settings)
        except model_client.ModelFailed as exc:
            if getattr(exc, "hint", None) != "length":
                raise
            # 供应商说输入太长：这一窗减半重试一次，并如实记下来。
            payload, images, evidence, shrunk = _window_payload(material, group, state, budget=SHRUNK_TEXT_BUDGET,
                                                                image_limit=SHRUNK_IMAGE_LIMIT)
            reply = _call(material, payload, images, settings)
            shrunk = True
        if shrunk:
            state["shrunk_windows"] = [*(state.get("shrunk_windows") or []), group[0].page_no]
        _merge(state, reply, group, evidence, index)
        index += 1
        ran += 1
        state["next_index"] = index
        if index >= len(groups):
            state["complete"] = True
            state["generated_at"] = now().isoformat()
        # 每次写入必须换一个新对象：重复赋同一个 dict，SQLAlchemy 认为没有变化，不会落库。
        row.report = dict(state)
        row.windows = len(groups)
        db.flush()
        repository.beat(db, material.id, done=index, total=len(groups))
        db.commit()
    state["next_index"] = index
    if index >= len(groups) and not state.get("complete"):
        state["complete"] = True
        state["generated_at"] = now().isoformat()
    row.report = dict(state)
    db.flush()
    return row


def run_slice(db: Session, material: Material) -> tuple[NarrationCalibration, bool, bool]:
    """One HTTP request's worth of calibration. Returns (row, reused, resuming)."""
    reason = config.unavailable_reason(db)
    if reason:
        raise RuntimeError(reason)
    items = participating(db, material)
    if not items:
        raise LookupError("没有可校准的讲解，请先生成")
    row, reused, resuming = reserve(db, material, items)
    if not reused:
        row = advance(db, material, row, items)
    return row, reused, resuming


def apply_report(db: Session, material: Material, entry: NarrationCalibration, *,
                 regenerate: Callable[[int], object]) -> AppliedCalibration:
    """Re-generate only flagged draft pages; approved pages stay untouched and listed."""
    report: dict[str, Any] = entry.report or {}
    if not report.get("complete", True):
        raise ValueError("校准报告尚未完成，不能应用")
    issues: list[CalibrationIssue] = report.get("issues") or []
    approved = [issue["page_no"] for issue in issues if issue["status"] == "accepted"]
    targets = sorted({issue["page_no"] for issue in issues if issue["status"] == "draft"})
    done: list[int] = []
    failed: list[dict[str, Any]] = []
    for page_no in targets:
        item = repository.row(db, material.id, page_no)
        if item is not None:
            db.refresh(item)
        if (item is None or item.status != "draft" or
                repository.revision(item) != (report.get("revisions") or {}).get(str(page_no)) or
                item.page_hash != repository.source_hash(material, page_no)):
            approved.append(page_no)
            continue
        try:
            db.info["narration_expected_revision"] = repository.revision(item)
            regenerate(page_no)
            done.append(page_no)
        except Exception as exc:  # noqa: BLE001 -- one page must not abort the fix pass
            db.rollback()
            failed.append({"page_no": page_no, "error": str(exc)[:160]})
        finally:
            db.info.pop("narration_expected_revision", None)
        repository.ensure_lease(db, material.id)
        repository.beat(db, material.id, done=len(done) + len(failed), total=len(targets))
        db.commit()
    entry.applied_at = now()
    entry.applied_pages = {"regenerated": done, "failed": failed, "awaiting_teacher": approved}
    db.flush()
    return cast(AppliedCalibration, entry.applied_pages)
