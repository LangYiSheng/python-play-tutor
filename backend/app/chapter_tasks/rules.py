"""Validate portable reading requirements and evaluate the actual material evidence."""
from math import ceil

from app.learning_rules import validate_learning, video_duration


def validate_rule(rule, material, required=True):
    if not isinstance(rule, dict) or set(rule) - {"scope", "start_page", "end_page", "count", "minimum_seconds", "segments"}:
        raise ValueError("资料任务点条件无效")
    for key in ("minimum_seconds", "start_page", "end_page", "count"):
        if key in rule and (type(rule[key]) is not int or not 1 <= rule[key] <= 86400):
            raise ValueError("页数与时长须为正整数")
    if material.kind == "video":
        if set(rule) - {"minimum_seconds", "segments"}:
            raise ValueError("视频仅支持观看时长和片段")
        duration = video_duration(material)
        if required or rule:
            if not duration or rule.get("minimum_seconds", 0) > ceil(duration):
                raise ValueError("请确认视频时长和观看要求")
            if rule:
                validate_learning({"learning": {"video": rule}}, "reading", material, resolve=True)
        return
    if "segments" in rule:
        raise ValueError("阅读资料不能配置视频片段")
    pages = {p["page_no"] for p in material.content.get("pages", [])}
    if required and not pages:
        raise ValueError("必读资料需要可阅读的页面")
    scope = rule.get("scope")
    extras = set(rule) - {"scope", "minimum_seconds"}
    if scope == "range":
        if extras != {"start_page", "end_page"} or rule["end_page"] < rule["start_page"] or not {rule["start_page"], rule["end_page"]} <= pages:
            raise ValueError("阅读页范围无效")
    elif scope == "count":
        if extras != {"count"} or rule["count"] > len(pages):
            raise ValueError("要求的页数超出实际页数")
    elif scope not in (None, "all") or extras:
        raise ValueError("阅读条件与范围不匹配")


def reading_task(link, material, evidence):
    rule = link.rule or {}
    seconds = rule.get("minimum_seconds", 0)
    page_total = page_count = 0
    if material.kind == "video":
        seconds = seconds or (0 if rule.get("segments") else int(video_duration(material) or 0))
        state = evidence.get("video", {})
        elapsed = state.get("watched_seconds", 0)
        segments = rule.get("segments", [])
        reached = sum(any(a <= s["start_seconds"] + .25 and b >= s["end_seconds"] - .25
                          for a, b in state.get("covered", [])) for s in segments)
        current, total, unit = min(int(elapsed), seconds), seconds, "秒"
        if segments and (not total or current >= total):
            current, total, unit = reached, len(segments), "段"
        complete = bool(seconds or segments) and elapsed + .25 >= seconds and reached == len(segments)
    else:
        pages = material.content.get("pages", [])
        scope = rule.get("scope", None if seconds else "all")
        valid = {p["id"] for p in pages if scope != "range" or rule["start_page"] <= p["page_no"] <= rule["end_page"]}
        page_total = (rule.get("count") if scope == "count" else len(valid)) if scope else 0
        page_count = min(page_total, len(valid.intersection(evidence.get("pages", []))))
        elapsed = evidence.get("seconds", 0)
        current, total, unit = page_count, page_total, "页"
        if seconds and page_count >= page_total:
            current, total, unit = min(int(elapsed), seconds), seconds, "秒"
        complete = bool(seconds or page_total) and page_count >= page_total and elapsed >= seconds
    return {"id": f"reading:{link.chapter_id}:{material.id}", "material_id": material.id, "kind": "reading",
            "title": material.title, "rule": rule, "required": link.required, "completed": complete and material.status == "ready",
            "locked": False, "lock_reason": None, "current": current, "total": total, "unit": unit,
            "read_count": page_count, "read_total": page_total, "seconds": int(elapsed), "required_seconds": seconds,
            "page_id": evidence.get("page_id")}
