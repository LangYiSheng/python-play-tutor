"""Pure in-memory cross-chapter exam blueprinting, A/B variant generation, and exports."""

from __future__ import annotations

import io
import math
import random
import re
import time
import uuid
import zipfile
from collections import defaultdict
from collections.abc import Sequence
from typing import Any

from . import exercises as exercises_mod
from .ooxml import W_NS, build_docx_zip, build_xlsx_sheets, docx_paragraph, docx_style, xml_escape

TYPE_ORDER = exercises_mod.TYPE_ORDER
CN_SECTION_NUMS = ("一", "二", "三", "四", "五", "六", "七", "八", "九", "十")
_SAFE_FILENAME = re.compile(r'[\\/:*?"<>|]+')

EXAM_STYLES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f"<w:styles {W_NS}>"
    + docx_style("Normal", "Normal", 21, after=80, line=360, east_asia_font="宋体")
    + docx_style("ExamTitle", "ExamTitle", 34, bold=True, after=120, extra='<w:jc w:val="center"/>', line=360, east_asia_font="宋体")
    + docx_style("ExamSub", "ExamSub", 22, after=100, extra='<w:jc w:val="center"/>', line=360, east_asia_font="宋体", color="444444")
    + docx_style("Candidate", "Candidate", 21, before=60, after=180, extra='<w:jc w:val="center"/>', line=360, east_asia_font="宋体")
    + docx_style("SectionHead", "SectionHead", 24, bold=True, before=240, after=100, extra='<w:keepNext/>', line=360, east_asia_font="宋体")
    + docx_style("Stem", "Stem", 21, before=100, after=40, extra='<w:keepNext/>', line=360, east_asia_font="宋体")
    + docx_style("Option", "Option", 21, before=0, after=30, extra='<w:ind w:left="420"/>', line=360, east_asia_font="宋体")
    + docx_style("AnswerLine", "AnswerLine", 21, bold=True, before=40, after=40, extra='<w:ind w:left="360"/>', line=360, east_asia_font="宋体", color="0B5D3B")
    + docx_style("ExplainLine", "ExplainLine", 20, before=0, after=80, extra='<w:ind w:left="360"/>', line=360, east_asia_font="宋体", color="4A5568")
    + docx_style("MetaHint", "MetaHint", 18, before=0, after=100, extra='<w:ind w:left="360"/>', line=360, east_asia_font="宋体", color="718096")
    + "</w:styles>"
)


def _round_score(val: float) -> int | float:
    return int(round(val)) if abs(val - round(val)) < 1e-6 else round(val, 1)


def _point_titles(q: dict[str, Any]) -> list[str]:
    if q.get("graph_points"):
        return [str(p["title"]) for p in q["graph_points"] if isinstance(p, dict) and p.get("title")]
    return [str(p).strip() for p in (q.get("knowledge_points") or []) if str(p).strip()]


def normalize_sections(raw_sections: Any) -> list[dict[str, Any]]:
    """Validate and normalize exam section blueprint entries."""
    by_type: dict[str, dict[str, Any]] = {}
    for item in raw_sections if isinstance(raw_sections, list) else []:
        if not isinstance(item, dict):
            continue
        qtype = exercises_mod.canonical_type(str(item.get("type") or ""))
        if qtype not in exercises_mod.TYPE_LABELS:
            continue
        try:
            count = int(item.get("count") or 0)
            score_each = float(item.get("scoreEach") or 0)
        except (TypeError, ValueError) as exc:
            raise ValueError("题量与单题分值必须是数字") from exc
        if count < 0 or count > 200:
            raise ValueError(f"{exercises_mod.TYPE_LABELS[qtype]}题量应在 0 到 200 之间")
        if count > 0 and (score_each <= 0 or score_each > 100):
            raise ValueError(f"{exercises_mod.TYPE_LABELS[qtype]}每题分值应大于 0 且不超过 100")
        score_clean = _round_score(score_each)
        by_type[qtype] = {"type": qtype, "count": count, "scoreEach": score_clean}
    return [by_type[k] for k in TYPE_ORDER if k in by_type and by_type[k]["count"] > 0]


def _required_pool_count(count: int, ab_mode: bool, max_overlap_rate: float) -> int:
    if not ab_mode:
        return count
    overlap_cap = min(count, int(math.floor(count * max(0.0, min(1.0, max_overlap_rate)) + 1e-9)))
    return count + max(0, count - overlap_cap)


def compute_gaps(
    pool: Sequence[dict[str, Any]],
    sections: Sequence[dict[str, Any]],
    chapters: Sequence[str],
    *,
    ab_mode: bool = False,
    max_overlap_rate: float = 0.0,
    include_unreviewed: bool = False,
    multiplier: int = 1,
) -> dict[str, Any]:
    """Calculate per-question-type inventory and shortages for a blueprint."""
    ch_set = {str(c) for c in chapters}
    avail_by_type: dict[str, int] = {k: 0 for k in TYPE_ORDER}
    seen_stems: set[str] = set()
    for q in pool:
        if ch_set and str(q.get("chapter") or "") not in ch_set:
            continue
        if not include_unreviewed and not q.get("reviewed"):
            continue
        qtype = exercises_mod.canonical_type(str(q.get("type") or ""))
        if qtype not in avail_by_type:
            continue
        sk = exercises_mod.stem_key(str(q.get("question") or ""))
        if sk and sk in seen_stems:
            continue
        if sk:
            seen_stems.add(sk)
        avail_by_type[qtype] += 1

    mult = max(1, int(multiplier))
    rows: list[dict[str, Any]] = []
    for sec in sections:
        qtype = exercises_mod.canonical_type(str(sec["type"]))
        cnt = int(sec["count"])
        need = _required_pool_count(cnt, ab_mode, max_overlap_rate) * mult
        have = avail_by_type.get(qtype, 0)
        rows.append(
            {
                "type": qtype,
                "label": exercises_mod.TYPE_LABELS[qtype],
                "count": cnt,
                "needed": need,
                "available": have,
                "shortage": max(0, need - have),
            }
        )
    return {
        "ok": all(r["shortage"] == 0 for r in rows),
        "totalShortage": sum(r["shortage"] for r in rows),
        "byType": rows,
    }


blueprint_gaps = compute_gaps


def _allocate_quotas(total: int, chapters: Sequence[str], avail: dict[str, int], weights: dict[str, float]) -> dict[str, int]:
    alloc = {c: 0 for c in chapters}
    remaining = int(total)
    active = [c for c in chapters if avail.get(c, 0) > 0]
    while remaining > 0 and active:
        w_sum = sum(max(0.01, float(weights.get(c, 1.0))) for c in active)
        raw = {c: remaining * (max(0.01, float(weights.get(c, 1.0))) / w_sum) for c in active}
        progressed = False
        for c in active:
            add = min(avail[c] - alloc[c], int(math.floor(raw[c])))
            if add > 0:
                alloc[c] += add
                remaining -= add
                progressed = True
        if remaining > 0:
            order = sorted(active, key=lambda c: (-(raw[c] - math.floor(raw[c])), -avail[c], c))
            for c in order:
                if remaining <= 0:
                    break
                if alloc[c] < avail[c]:
                    alloc[c] += 1
                    remaining -= 1
                    progressed = True
        active = [c for c in active if alloc[c] < avail[c]]
        if not progressed:
            break
    return alloc


def _pick_spread_by_kp(candidates: Sequence[dict[str, Any]], count: int, rng: random.Random) -> list[dict[str, Any]]:
    if count <= 0 or not candidates:
        return []
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for q in candidates:
        pts = q.get("point_titles") or _point_titles(q)
        key = pts[0] if pts else f"__page_{q.get('page') or 0}"
        buckets[key].append(q)
    for items in buckets.values():
        rng.shuffle(items)
    keys = list(buckets.keys())
    rng.shuffle(keys)
    picked: list[dict[str, Any]] = []
    while len(picked) < count:
        added = False
        for k in keys:
            if len(picked) >= count:
                break
            if buckets[k]:
                picked.append(buckets[k].pop())
                added = True
        if not added:
            break
    return picked


def _snapshot_question(q: dict[str, Any], score: int | float) -> dict[str, Any]:
    return {
        "uid": uuid.uuid4().hex[:10],
        "sourceId": str(q.get("id") or ""),
        "chapter": str(q.get("chapter") or ""),
        "type": exercises_mod.canonical_type(str(q.get("type") or "single")),
        "score": score,
        "question": str(q.get("question") or ""),
        "options": dict(q.get("options") or {}),
        "answer": list(q["answer"]) if isinstance(q.get("answer"), list) else q.get("answer", ""),
        "explanation": str(q.get("explanation") or ""),
        "knowledge_points": list(q.get("point_titles") or _point_titles(q)),
        "page": int(q.get("page") or 0),
    }


def compute_exam_stats(exam: dict[str, Any], total_course_kps: int = 0) -> dict[str, Any]:
    """Compute per-variant score, type/chapter breakdowns, coverage, and A/B overlap."""
    variants = exam.get("variants") or {}
    va_qs = (variants.get("A") or {}).get("questions") or []
    vb_qs = (variants.get("B") or {}).get("questions") or []

    def _variant_summary(qs: Sequence[dict[str, Any]]) -> dict[str, Any]:
        by_type: dict[str, dict[str, Any]] = {}
        by_chapter: dict[str, dict[str, Any]] = {}
        kps: set[str] = set()
        score_sum = 0.0
        for q in qs:
            qtype = exercises_mod.canonical_type(str(q.get("type") or ""))
            ch = str(q.get("chapter") or "未归类")
            sc = float(q.get("score") or 0)
            score_sum += sc
            t_rec = by_type.setdefault(qtype, {"count": 0, "score": 0.0})
            t_rec["count"] += 1
            t_rec["score"] = _round_score(float(t_rec["score"]) + sc)
            c_rec = by_chapter.setdefault(ch, {"count": 0, "score": 0.0})
            c_rec["count"] += 1
            c_rec["score"] = _round_score(float(c_rec["score"]) + sc)
            for kp in q.get("knowledge_points") or []:
                if str(kp).strip():
                    kps.add(f"{ch}::{str(kp).strip()}")
        return {
            "count": len(qs),
            "totalScore": _round_score(score_sum),
            "byType": by_type,
            "byChapter": by_chapter,
            "coveredPoints": len(kps),
        }

    sum_a = _variant_summary(va_qs)
    if "A" in variants:
        variants["A"]["totalScore"] = sum_a["totalScore"]
    overlap_count, overlap_rate, sum_b = 0, 0.0, None
    if "B" in variants:
        sum_b = _variant_summary(vb_qs)
        variants["B"]["totalScore"] = sum_b["totalScore"]
        keys_a = {q.get("sourceId") or exercises_mod.stem_key(q.get("question", "")) for q in va_qs} - {""}
        keys_b = {q.get("sourceId") or exercises_mod.stem_key(q.get("question", "")) for q in vb_qs} - {""}
        overlap_count = len(keys_a & keys_b)
        overlap_rate = round(overlap_count / max(len(va_qs), len(vb_qs), 1), 4)

    all_kps = {
        f"{str(q.get('chapter') or '')}::{str(kp).strip()}"
        for qs in (va_qs, vb_qs)
        for q in qs
        for kp in (q.get("knowledge_points") or [])
        if str(kp).strip()
    }
    return {
        "overlapCount": overlap_count,
        "overlapRate": overlap_rate,
        "variantA": sum_a,
        "variantB": sum_b,
        "knowledgeCoverage": {"covered": len(all_kps), "total": max(int(total_course_kps), len(all_kps))},
    }


def generate_exam_variants(
    pool: Sequence[dict[str, Any]],
    *,
    title: str,
    chapters: Sequence[str],
    sections: Sequence[dict[str, Any]],
    subtitle: str = "",
    exam_mode: str = "闭卷",
    duration_minutes: int = 90,
    total_score: int | float = 100,
    ab_mode: bool = False,
    max_overlap_rate: float = 0.0,
    include_unreviewed: bool = False,
    chapter_weights: dict[str, float] | None = None,
    total_course_kps: int = 0,
    seed: int | None = None,
) -> dict[str, Any]:
    """Sample balanced single or A/B exam variants from an in-memory question pool."""
    clean_title = re.sub(r"\s+", " ", str(title or "")).strip()[:80]
    if not clean_title:
        raise ValueError("试卷标题不能为空")
    norm_sections = normalize_sections(sections)
    if not norm_sections:
        raise ValueError("请至少配置一种题型且题量大于 0")
    selected_chapters = [str(c).strip() for c in chapters if str(c).strip()]
    if not selected_chapters:
        raise ValueError("请至少选择一个章节")

    max_ov = max(0.0, min(0.5, float(max_overlap_rate or 0.0)))
    computed_total = _round_score(sum(s["count"] * float(s["scoreEach"]) for s in norm_sections))
    target_total = _round_score(float(total_score or computed_total))
    if abs(float(computed_total) - float(target_total)) > 0.05:
        raise ValueError(f"各题型分值合计为 {computed_total} 分，与目标满分 {target_total} 分不一致")

    gaps = compute_gaps(
        pool,
        norm_sections,
        selected_chapters,
        ab_mode=ab_mode,
        max_overlap_rate=max_ov,
        include_unreviewed=include_unreviewed,
    )
    if not gaps["ok"]:
        short_desc = "、".join(
            f"{r['label']}缺 {r['shortage']} 道（需 {r['needed']} / 可用 {r['available']}）"
            for r in gaps["byType"]
            if r["shortage"] > 0
        )
        raise ValueError(f"题库数量不足：{short_desc}")

    rng = random.Random(seed)
    weights = {c: max(0.1, float((chapter_weights or {}).get(c, 1.0))) for c in selected_chapters}
    by_type_ch: dict[str, dict[str, list[dict[str, Any]]]] = {k: {c: [] for c in selected_chapters} for k in TYPE_ORDER}
    seen_stems: set[str] = set()
    ch_set = set(selected_chapters)
    for q in pool:
        ch = str(q.get("chapter") or "")
        if ch not in ch_set or (not include_unreviewed and not q.get("reviewed")):
            continue
        qtype = exercises_mod.canonical_type(str(q.get("type") or ""))
        if qtype not in by_type_ch:
            continue
        sk = exercises_mod.stem_key(str(q.get("question") or ""))
        if sk and sk in seen_stems:
            continue
        if sk:
            seen_stems.add(sk)
        by_type_ch[qtype][ch].append(q)

    list_a: list[dict[str, Any]] = []
    list_b: list[dict[str, Any]] = []
    for sec in norm_sections:
        qtype, cnt, sc = sec["type"], int(sec["count"]), sec["scoreEach"]
        ch_map = by_type_ch[qtype]
        avail_map = {c: len(ch_map[c]) for c in selected_chapters}
        if not ab_mode:
            quotas = _allocate_quotas(cnt, selected_chapters, avail_map, weights)
            for c in selected_chapters:
                list_a.extend(_snapshot_question(q, sc) for q in _pick_spread_by_kp(ch_map[c], quotas[c], rng))
        else:
            need_unique = _required_pool_count(cnt, True, max_ov)
            disjoint_total = min(2 * cnt, sum(avail_map.values()))
            quotas_pair = _allocate_quotas(disjoint_total, selected_chapters, avail_map, weights)
            a_raw: list[dict[str, Any]] = []
            b_raw: list[dict[str, Any]] = []
            flip = False
            for c in selected_chapters:
                for q in _pick_spread_by_kp(ch_map[c], quotas_pair[c], rng):
                    if len(a_raw) < cnt and (not flip or len(b_raw) >= cnt):
                        a_raw.append(q)
                    elif len(b_raw) < cnt:
                        b_raw.append(q)
                    flip = not flip
            if need_unique < 2 * cnt:
                if len(a_raw) < cnt:
                    deficit_a = cnt - len(a_raw)
                    a_ids = {q.get("id") for q in a_raw}
                    reusable_a = [q for q in b_raw if q.get("id") not in a_ids]
                    rng.shuffle(reusable_a)
                    a_raw.extend(reusable_a[:deficit_a])
                if len(b_raw) < cnt:
                    deficit_b = cnt - len(b_raw)
                    b_ids = {q.get("id") for q in b_raw}
                    reusable_b = [q for q in a_raw if q.get("id") not in b_ids]
                    rng.shuffle(reusable_b)
                    b_raw.extend(reusable_b[:deficit_b])
            list_a.extend(_snapshot_question(q, sc) for q in a_raw)
            list_b.extend(_snapshot_question(q, sc) for q in b_raw)

    now_str = time.strftime("%Y-%m-%d %H:%M:%S")
    variants: dict[str, Any] = {"A": {"label": "A卷" if ab_mode else "正式卷", "totalScore": computed_total, "questions": list_a}}
    if ab_mode:
        variants["B"] = {"label": "B卷", "totalScore": computed_total, "questions": list_b}

    exam: dict[str, Any] = {
        "id": uuid.uuid4().hex[:10],
        "title": clean_title,
        "subtitle": str(subtitle or "").strip()[:80],
        "examMode": str(exam_mode or "闭卷").strip()[:20] or "闭卷",
        "durationMinutes": max(15, min(300, int(duration_minutes or 90))),
        "totalScore": computed_total,
        "abMode": bool(ab_mode),
        "maxOverlapRate": max_ov,
        "includeUnreviewed": bool(include_unreviewed),
        "chapters": selected_chapters,
        "chapterWeights": weights,
        "sections": norm_sections,
        "variants": variants,
        "createdAt": now_str,
        "updatedAt": now_str,
    }
    exam["stats"] = compute_exam_stats(exam, total_course_kps=total_course_kps)
    return exam


generate_exam = generate_exam_variants


def find_candidates(exam: dict[str, Any], variant: str, uid: str, pool: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return replacement candidates ranked by variant exclusion, shared point, and chapter."""
    v_obj = (exam.get("variants") or {}).get(variant)
    if not v_obj:
        raise ValueError(f"没有 {variant} 卷")
    cur_list = v_obj.get("questions") or []
    target = next((q for q in cur_list if q.get("uid") == uid), None)
    if target is None:
        raise ValueError("未找到指定题目")

    used_here = {q.get("sourceId") or exercises_mod.stem_key(q.get("question", "")) for q in cur_list}
    other_var = "B" if variant == "A" else "A"
    other_qs = ((exam.get("variants") or {}).get(other_var) or {}).get("questions") or []
    used_other = {q.get("sourceId") or exercises_mod.stem_key(q.get("question", "")) for q in other_qs}
    include_unreviewed = bool(exam.get("includeUnreviewed"))
    ch_set = set(exam.get("chapters") or [])
    target_type = exercises_mod.canonical_type(str(target.get("type") or ""))
    target_ch = str(target.get("chapter") or "")
    target_kps = set(target.get("knowledge_points") or [])

    scored: list[tuple[int, int, int, dict[str, Any]]] = []
    seen_stems: set[str] = set()
    for q in pool:
        if exercises_mod.canonical_type(str(q.get("type") or "")) != target_type:
            continue
        if not include_unreviewed and not q.get("reviewed"):
            continue
        ch = str(q.get("chapter") or "")
        if ch_set and ch not in ch_set:
            continue
        qid = str(q.get("id") or "")
        sk = exercises_mod.stem_key(str(q.get("question") or ""))
        if qid in used_here or sk in used_here or (sk and sk in seen_stems):
            continue
        if sk:
            seen_stems.add(sk)
        pts = list(q.get("point_titles") or _point_titles(q))
        in_other = 1 if (qid in used_other or sk in used_other) else 0
        same_kp = 0 if (target_kps & set(pts)) else 1
        same_ch = 0 if ch == target_ch else 1
        scored.append(
            (
                in_other,
                same_kp,
                same_ch,
                {
                    "id": qid,
                    "chapter": ch,
                    "type": target_type,
                    "question": str(q.get("question") or ""),
                    "options": dict(q.get("options") or {}),
                    "answer": q.get("answer"),
                    "explanation": str(q.get("explanation") or ""),
                    "knowledge_points": pts,
                    "page": int(q.get("page") or 0),
                    "usedInOtherVariant": bool(in_other),
                },
            )
        )
    scored.sort(key=lambda r: (r[0], r[1], r[2], r[3]["chapter"], r[3]["page"]))
    return [row[3] for row in scored[:40]]


replacement_candidates = find_candidates


def apply_exam_patch(
    exam: dict[str, Any],
    patch: dict[str, Any],
    pool: Sequence[dict[str, Any]],
    total_course_kps: int = 0,
) -> dict[str, Any]:
    """Mutate exam title/metadata or replace/move/score/remove/add questions on a variant."""
    if "title" in patch:
        t = re.sub(r"\s+", " ", str(patch.get("title") or "")).strip()[:80]
        if not t:
            raise ValueError("试卷标题不能为空")
        exam["title"] = t
    if "subtitle" in patch:
        exam["subtitle"] = str(patch.get("subtitle") or "").strip()[:80]
    if "examMode" in patch:
        exam["examMode"] = str(patch.get("examMode") or "闭卷").strip()[:20] or "闭卷"
    if "durationMinutes" in patch:
        try:
            exam["durationMinutes"] = max(15, min(300, int(patch["durationMinutes"])))
        except (TypeError, ValueError) as exc:
            raise ValueError("考试时长要是整数") from exc

    action = str(patch.get("action") or "").strip()
    variant = str(patch.get("variant") or "A").strip().upper()
    v_obj = (exam.get("variants") or {}).get(variant)
    if action:
        if v_obj is None:
            raise ValueError(f"没有 {variant} 卷")
        qs: list[dict[str, Any]] = v_obj.get("questions") or []
        uid = str(patch.get("uid") or "").strip()
        if action == "replace":
            idx = next((i for i, q in enumerate(qs) if q.get("uid") == uid), -1)
            if idx < 0:
                raise ValueError("未找到要替换的题目")
            cand_id, cand_ch = str(patch.get("candidateId") or "").strip(), str(patch.get("candidateChapter") or "").strip()
            hit = next((q for q in pool if str(q.get("id") or "") == cand_id and (not cand_ch or q.get("chapter") == cand_ch)), None)
            if hit is None:
                raise ValueError("未找到所选候选题")
            if exercises_mod.canonical_type(str(hit.get("type") or "")) != exercises_mod.canonical_type(str(qs[idx].get("type") or "")):
                raise ValueError("只能替换为相同题型的题目")
            qs[idx] = _snapshot_question(hit, qs[idx].get("score", 2))
        elif action == "move":
            direction = str(patch.get("direction") or "").strip().lower()
            idx = next((i for i, q in enumerate(qs) if q.get("uid") == uid), -1)
            if idx < 0:
                raise ValueError("未找到要移动的题目")
            same = [i for i, q in enumerate(qs) if q.get("type") == qs[idx].get("type")]
            pos = same.index(idx)
            if direction == "up" and pos > 0:
                qs[idx], qs[same[pos - 1]] = qs[same[pos - 1]], qs[idx]
            elif direction == "down" and pos + 1 < len(same):
                qs[idx], qs[same[pos + 1]] = qs[same[pos + 1]], qs[idx]
        elif action == "score":
            idx = next((i for i, q in enumerate(qs) if q.get("uid") == uid), -1)
            if idx < 0:
                raise ValueError("未找到题目")
            try:
                sc = float(patch.get("score"))
            except (TypeError, ValueError) as exc:
                raise ValueError("分值必须是数字") from exc
            if sc <= 0 or sc > 100:
                raise ValueError("单题分值应大于 0 且不超过 100")
            qs[idx]["score"] = _round_score(sc)
        elif action == "remove":
            before = len(qs)
            qs[:] = [q for q in qs if q.get("uid") != uid]
            if len(qs) == before:
                raise ValueError("未找到要移除的题目")
        elif action == "add":
            cand_id, cand_ch = str(patch.get("candidateId") or "").strip(), str(patch.get("candidateChapter") or "").strip()
            hit = next((q for q in pool if str(q.get("id") or "") == cand_id and (not cand_ch or q.get("chapter") == cand_ch)), None)
            if hit is None:
                raise ValueError("未找到要加入的题目")
            try:
                sc = float(patch.get("score") or 2)
            except (TypeError, ValueError):
                sc = 2.0
            qs.append(_snapshot_question(hit, _round_score(max(0.5, min(100.0, sc)))))
        else:
            raise ValueError(f"不支持的操作：{action}")
        v_obj["questions"] = qs

    exam["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
    exam["stats"] = compute_exam_stats(exam, total_course_kps=total_course_kps)
    if "A" in (exam.get("variants") or {}):
        exam["totalScore"] = exam["variants"]["A"]["totalScore"]
    return exam


def _score_table_xml(groups: Sequence[tuple[str, Sequence[dict[str, Any]]]], total_score: int | float) -> str:
    headers = ["题号"] + [f"{CN_SECTION_NUMS[i] if i < len(CN_SECTION_NUMS) else i + 1}" for i in range(len(groups))] + ["总分"]
    fulls = ["满分"] + [str(_round_score(sum(float(q.get("score") or 0) for q in qs))) for _, qs in groups] + [str(_round_score(float(total_score)))]
    blanks = ["得分"] + ["" for _ in groups] + [""]

    def _row(cells: Sequence[str], bold: bool = False) -> str:
        tcs = []
        rpr = '<w:rPr><w:rFonts w:eastAsia="宋体"/><w:b/><w:sz w:val="20"/></w:rPr>' if bold else '<w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="20"/></w:rPr>'
        for cell in cells:
            tcs.append(
                '<w:tc><w:tcPr><w:vAlign w:val="center"/></w:tcPr>'
                '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="40" w:after="40"/></w:pPr>'
                f'<w:r>{rpr}<w:t xml:space="preserve">{xml_escape(cell)}</w:t></w:r></w:p></w:tc>'
            )
        return f'<w:tr>{"".join(tcs)}</w:tr>'

    borders = (
        '<w:tblBorders><w:top w:val="single" w:sz="6" w:space="0" w:color="333333"/>'
        '<w:bottom w:val="single" w:sz="6" w:space="0" w:color="333333"/>'
        '<w:left w:val="single" w:sz="6" w:space="0" w:color="333333"/>'
        '<w:right w:val="single" w:sz="6" w:space="0" w:color="333333"/>'
        '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="666666"/>'
        '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="666666"/></w:tblBorders>'
    )
    return f'<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:jc w:val="center"/>{borders}</w:tblPr>{_row(headers, bold=True)}{_row(fulls)}{_row(blanks)}</w:tbl>'


def _group_variant_questions(qs: Sequence[dict[str, Any]]) -> list[tuple[str, list[dict[str, Any]]]]:
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for q in qs:
        buckets[exercises_mod.canonical_type(str(q.get("type") or "single"))].append(q)
    return [(k, buckets[k]) for k in TYPE_ORDER if buckets.get(k)]


def _variant_or_raise(exam: dict[str, Any], variant: str) -> tuple[str, dict[str, Any]]:
    key = str(variant or "A").strip().upper()
    v_obj = (exam.get("variants") or {}).get(key)
    if not v_obj or not (v_obj.get("questions") or []):
        raise LookupError(f"没有可导出的 {key} 卷内容")
    return key, v_obj


def export_student_docx(exam: dict[str, Any], variant: str = "A") -> bytes:
    """Export blank student exam paper as .docx."""
    key, v_obj = _variant_or_raise(exam, variant)
    qs = v_obj["questions"]
    groups = _group_variant_questions(qs)
    suffix = f"（{v_obj.get('label') or f'{key}卷'}）" if exam.get("abMode") else ""
    total_score = v_obj.get("totalScore") or exam.get("totalScore") or 100
    body: list[str] = [docx_paragraph(f"{exam.get('title', '课程考试')}{suffix}", "ExamTitle")]
    if exam.get("subtitle"):
        body.append(docx_paragraph(str(exam["subtitle"]), "ExamSub"))
    body.append(
        docx_paragraph(
            f"考试形式：{exam.get('examMode') or '闭卷'}　　考试时长：{exam.get('durationMinutes') or 90} 分钟　　满分：{total_score} 分",
            "ExamSub",
        )
    )
    body.append(docx_paragraph("学院：____________　专业班级：____________　姓名：____________　学号：____________", "Candidate"))
    body.append(_score_table_xml(groups, total_score))

    for sec_idx, (qtype, items) in enumerate(groups):
        cn = CN_SECTION_NUMS[sec_idx] if sec_idx < len(CN_SECTION_NUMS) else str(sec_idx + 1)
        sec_sum = _round_score(sum(float(q.get("score") or 0) for q in items))
        scores = {q.get("score") for q in items}
        per_hint = f"，每小题 {next(iter(scores))} 分" if len(scores) == 1 else ""
        label = exercises_mod.TYPE_LABELS.get(qtype, qtype)
        body.append(docx_paragraph(f"{cn}、{label}（共 {len(items)} 小题{per_hint}，共 {sec_sum} 分）", "SectionHead"))
        for q_no, q in enumerate(items, 1):
            stem = str(q.get("question") or "").strip()
            sc_tag = f"（{q.get('score')} 分）" if len(scores) > 1 or qtype == "short_answer" else ""
            body.append(docx_paragraph(f"{q_no}. {'[    ] ' if qtype == 'true_false' else ''}{stem}{sc_tag}", "Stem"))
            if qtype in ("single", "multiple"):
                opts = q.get("options") or {}
                for k in "abcdefgh":
                    val = str(opts.get(k) or "").strip()
                    if val:
                        body.append(docx_paragraph(f"{k.upper()}. {val}", "Option"))
            elif qtype == "short_answer":
                for _ in range(5):
                    body.append(docx_paragraph("", "Normal"))
    return build_docx_zip(body, styles_xml=EXAM_STYLES, margin=1300)


export_docx_student = export_student_docx


def export_teacher_docx(exam: dict[str, Any], variant: str = "A") -> bytes:
    """Export teacher answer key and explanations as .docx."""
    key, v_obj = _variant_or_raise(exam, variant)
    qs = v_obj["questions"]
    groups = _group_variant_questions(qs)
    suffix = f"（{v_obj.get('label') or f'{key}卷'}）" if exam.get("abMode") else ""
    total_score = v_obj.get("totalScore") or exam.get("totalScore") or 100
    body: list[str] = [
        docx_paragraph(f"{exam.get('title', '课程考试')}{suffix} — 参考答案与解析", "ExamTitle"),
        docx_paragraph(f"满分：{total_score} 分　　共 {len(qs)} 题", "ExamSub"),
    ]
    for sec_idx, (qtype, items) in enumerate(groups):
        cn = CN_SECTION_NUMS[sec_idx] if sec_idx < len(CN_SECTION_NUMS) else str(sec_idx + 1)
        sec_sum = _round_score(sum(float(q.get("score") or 0) for q in items))
        label = exercises_mod.TYPE_LABELS.get(qtype, qtype)
        body.append(docx_paragraph(f"{cn}、{label}（共 {len(items)} 小题，共 {sec_sum} 分）", "SectionHead"))
        for q_no, q in enumerate(items, 1):
            stem = str(q.get("question") or "").strip()
            body.append(docx_paragraph(f"{q_no}. {stem}（{q.get('score')} 分）", "Stem"))
            if qtype in ("single", "multiple"):
                opts = q.get("options") or {}
                for k in "abcdefgh":
                    val = str(opts.get(k) or "").strip()
                    if val:
                        body.append(docx_paragraph(f"{k.upper()}. {val}", "Option"))
            body.append(docx_paragraph(f"参考答案：{exercises_mod.answer_text(q)}", "AnswerLine"))
            exp = str(q.get("explanation") or "").strip()
            if exp:
                body.append(docx_paragraph(f"解析 / 评分要点：{exp}", "ExplainLine"))
            meta_parts: list[str] = []
            if q.get("chapter"):
                meta_parts.append(str(q["chapter"]))
            if q.get("page"):
                meta_parts.append(f"第 {q['page']} 页")
            kps = [str(p) for p in (q.get("knowledge_points") or []) if str(p).strip()]
            if kps:
                meta_parts.append("知识点：" + "、".join(kps))
            if meta_parts:
                body.append(docx_paragraph(" · ".join(meta_parts), "MetaHint"))
    return build_docx_zip(body, styles_xml=EXAM_STYLES, margin=1300)


export_docx_teacher = export_teacher_docx


def _blueprint_matrix_rows(qs: Sequence[dict[str, Any]], total_score: int | float) -> list[list[str]]:
    header = ["章节", "知识点", "单选(题/分)", "多选(题/分)", "判断(题/分)", "填空(题/分)", "简答(题/分)", "小计题数", "小计分值", "分值占比"]
    rows: list[list[str]] = [header]
    grouped: dict[tuple[str, str], dict[str, list[float]]] = defaultdict(lambda: {k: [0, 0.0] for k in TYPE_ORDER})
    for q in qs:
        ch = str(q.get("chapter") or "未归类")
        pts = [str(p).strip() for p in (q.get("knowledge_points") or []) if str(p).strip()]
        kp = pts[0] if pts else "（未标知识点）"
        qtype = exercises_mod.canonical_type(str(q.get("type") or "single"))
        if qtype in grouped[(ch, kp)]:
            grouped[(ch, kp)][qtype][0] += 1
            grouped[(ch, kp)][qtype][1] += float(q.get("score") or 0)
    denom = max(float(total_score or 0), 0.001)
    totals = {k: [0, 0.0] for k in TYPE_ORDER}
    grand_cnt, grand_score = 0, 0.0
    for (ch, kp), stats in sorted(grouped.items(), key=lambda x: (x[0][0], x[0][1])):
        sub_cnt = sum(int(stats[k][0]) for k in TYPE_ORDER)
        sub_score = sum(float(stats[k][1]) for k in TYPE_ORDER)
        grand_cnt += sub_cnt
        grand_score += sub_score
        for k in TYPE_ORDER:
            totals[k][0] += int(stats[k][0])
            totals[k][1] += float(stats[k][1])
        cells = [f"{int(stats[k][0])} / {_round_score(stats[k][1])}" if stats[k][0] else "—" for k in TYPE_ORDER]
        rows.append([ch, kp, *cells, str(sub_cnt), str(_round_score(sub_score)), f"{sub_score / denom * 100:.1f}%"])
    rows.append(
        [
            "合计",
            f"共 {len(grouped)} 个知识点项",
            *[f"{int(totals[k][0])} / {_round_score(totals[k][1])}" if totals[k][0] else "—" for k in TYPE_ORDER],
            str(grand_cnt),
            str(_round_score(grand_score)),
            "100.0%",
        ]
    )
    return rows


def export_blueprint_xlsx(exam: dict[str, Any]) -> bytes:
    """Export exam specification blueprint matrix (.xlsx)."""
    stats = exam.get("stats") or compute_exam_stats(exam)
    overview = [
        ["项目", "内容"],
        ["试卷标题", str(exam.get("title") or "")],
        ["副标题", str(exam.get("subtitle") or "")],
        ["考试形式", str(exam.get("examMode") or "闭卷")],
        ["考试时长（分钟）", str(exam.get("durationMinutes") or 90)],
        ["试卷满分", str(exam.get("totalScore") or 100)],
        ["出卷模式", "A/B 卷" if exam.get("abMode") else "单卷"],
        ["覆盖章节", "、".join(exam.get("chapters") or [])],
    ]
    if exam.get("abMode"):
        overview.append(["A/B 卷重复题数", str(stats.get("overlapCount", 0))])
        overview.append(["A/B 卷重复率", f"{float(stats.get('overlapRate', 0)) * 100:.1f}%"])
    cov = stats.get("knowledgeCoverage") or {}
    overview.append(["覆盖知识点数", f"{cov.get('covered', 0)} / {cov.get('total', 0)}"])
    sheets: list[tuple[str, Sequence[Sequence[str]], Sequence[int] | None]] = [("试卷概览", overview, (22, 60))]
    matrix_widths = (24, 28, 13, 13, 13, 13, 13, 10, 10, 10)
    variants = exam.get("variants") or {}
    for key in ("A", "B"):
        if key in variants and variants[key].get("questions"):
            label = variants[key].get("label") or f"{key}卷"
            sheets.append(
                (
                    f"{label}双向细目表",
                    _blueprint_matrix_rows(variants[key]["questions"], variants[key].get("totalScore") or exam.get("totalScore") or 100),
                    matrix_widths,
                )
            )
    return build_xlsx_sheets(sheets, header_fill="D9EAD3")


def export_exam_xuexitong_xlsx(exam: dict[str, Any], variant: str = "A") -> bytes:
    """Export one exam variant to Xuexitong .xlsx."""
    key, v_obj = _variant_or_raise(exam, variant)
    suffix = f"-{v_obj.get('label') or f'{key}卷'}" if exam.get("abMode") else ""
    return exercises_mod.export_xuexitong_xlsx(v_obj["questions"], catalog_name=f"{exam.get('title', '试卷')}{suffix}")


export_xuexitong_paper_xlsx = export_exam_xuexitong_xlsx


def export_exam_xuexitong_txt(exam: dict[str, Any], variant: str = "A") -> str:
    """Export one exam variant to Xuexitong smart-import .txt."""
    _, v_obj = _variant_or_raise(exam, variant)
    return exercises_mod.export_xuexitong_txt(v_obj["questions"], preserve_order=True)


export_xuexitong_paper_txt = export_exam_xuexitong_txt


def safe_exam_filename(title: str) -> str:
    return _SAFE_FILENAME.sub("_", str(title or "")).strip(" .") or "试卷"


def export_exam_zip(exam: dict[str, Any]) -> bytes:
    """Bundle student/teacher DOCX, Xuexitong imports, and blueprint XLSX into one .zip."""
    base = safe_exam_filename(str(exam.get("title") or "试卷"))
    variants = exam.get("variants") or {}
    keys = [k for k in ("A", "B") if k in variants and variants[k].get("questions")]
    if not keys:
        raise LookupError("试卷中没有题目")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for key in keys:
            tag = f"-{variants[key].get('label') or f'{key}卷'}" if exam.get("abMode") else ""
            zf.writestr(f"{base}{tag}-学生卷.docx", export_student_docx(exam, key))
            zf.writestr(f"{base}{tag}-答案解析卷.docx", export_teacher_docx(exam, key))
            zf.writestr(f"{base}{tag}-学习通导入.xlsx", export_exam_xuexitong_xlsx(exam, key))
            zf.writestr(f"{base}{tag}-学习通智能导入.txt", export_exam_xuexitong_txt(exam, key).encode("utf-8"))
        zf.writestr(f"{base}-命题双向细目表.xlsx", export_blueprint_xlsx(exam))
    return buf.getvalue()


export_archive_zip = export_exam_zip
