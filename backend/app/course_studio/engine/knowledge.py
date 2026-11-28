"""Pure in-memory chapter outline detection, AI knowledge extraction, and graph exports."""

from __future__ import annotations

import io
import json
import re
import uuid
import zipfile
from collections.abc import Iterable, Sequence
from typing import Any

from . import llm as llm_mod
from . import pacing
from . import prompts
from .ooxml import build_docx_zip, build_xlsx, clean_xml_text, docx_paragraph, xml_escape
from .text_utils import extract_json_payload, format_page_ranges, squeeze_text

WHOLE_CHAPTER = "本章"

MAX_TITLE = 40
MAX_NUMBER = 12
MAX_BRIEF = 80
MAX_SECTIONS = 60
MAX_POINTS = 40
MAX_CONTEXT_CHARS = 36000

_HEADING_RE = re.compile(
    rf"{pacing.HEADING_LEAD_RE}(\d{{1,2}}(?:\.\d{{1,2}}){{1,3}}){pacing.HEADING_TAIL_RE}"
    rf"[ \t]*{pacing.HEADING_SEP_RE}[ \t]*(.*)$",
    re.MULTILINE,
)
_CHAPTER_LINE_RE = re.compile(r"^[ \t]*第[一二三四五六七八九十百\d]+[章讲]", re.MULTILINE)
_CHAPTER_NUM_RE = re.compile(r"^[ \t]*第[ \t]*([一二三四五六七八九十百\d]+)[ \t]*[章讲]", re.MULTILINE)
_POINT_PREFIX_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^\s*第\s*[一二三四五六七八九十百零〇两\d]+\s*[章节讲单元篇部分]\s*[、.．:：\-—–·•]?\s*"),
    re.compile(r"^\s*(?:chapter|section|unit|part|lesson)\s+\d+(?:\.\d+)*\s*[.:：\-—–·]?\s*", re.IGNORECASE),
    re.compile(r"^\s*\d+(?:\.\d+){1,3}\s*[、.．:：\-—–·•]?\s*"),
    re.compile(r"^\s*[一二三四五六七八九十百]+[、.．:：]\s*"),
    re.compile(r"^\s*[（(][一二三四五六七八九十百\d]+[）)]\s*[、.．:：]?\s*"),
    re.compile(r"^\s*\d+\s*(?:[、．:：]|\.(?!\d))\s*"),
)
_CHAPTER_PAGE_MAX_CHARS = 120
_TITLE_LINE_MAX = 24
_STACKED_TITLE_MAX = 32
_SENTENCE_PUNCT = re.compile(r"[，。；：！？,;:!?、（）()]")

EXPORT_COLUMNS = ("章节", "一级分类（节）", "知识点名称", "前置知识点", "关联知识点", "标签", "知识点简介", "对应PPT页码")
_XMIND_MANIFEST_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>'
    '<manifest xmlns="urn:xmind:xul:manifest:xmlns">'
    '<file-entry full-path="content.xml" media-type="text/xml"/>'
    '<file-entry full-path="META-INF/" media-type=""/>'
    "</manifest>"
)


def _clean_title(text: Any, limit: int = MAX_TITLE) -> str:
    cleaned = re.sub(r"\s+", " ", str(text or "")).strip().strip(" ·•▪-—–:：、．.")
    return cleaned[:limit]


def _clean_label(text: Any) -> str:
    return re.sub(r"\s+", " ", clean_xml_text(text)).strip()


def _stacked_title(lines: list[str], start: int) -> str:
    parts: list[str] = []
    total_len = 0
    for raw_line in lines[start : start + 3]:
        if pacing.BULLET_LEAD_RE.match(raw_line):
            break
        line = raw_line.strip()
        if not line or len(line) > _TITLE_LINE_MAX or _SENTENCE_PUNCT.search(line):
            break
        if _HEADING_RE.match(line) or _CHAPTER_LINE_RE.match(line):
            break
        need_space = bool(parts and re.search(r"[A-Za-z0-9]$", parts[-1]) and re.match(r"^[A-Za-z0-9]", line))
        added = (1 if need_space else 0) + len(line)
        if parts and total_len + added > _STACKED_TITLE_MAX:
            break
        if need_space:
            parts.append(" ")
        parts.append(line)
        total_len += added
        if total_len >= _STACKED_TITLE_MAX:
            break
    return _clean_title("".join(parts))


def headings(raw_text: str) -> list[tuple[str, str]]:
    """Extract numbered section headings [(number, title), ...] from a page."""
    lines = (raw_text or "").splitlines()
    out: list[tuple[str, str]] = []
    for i, line in enumerate(lines):
        m = _HEADING_RE.match(line)
        if not m or not pacing.valid_section(m.group(1)):
            continue
        depth = len(m.group(1).split("."))
        number = ".".join(m.group(1).split(".")[:3])
        inline_title = _clean_title(m.group(2))
        if not inline_title:
            # A bulleted bare decimal like "• 1.1" is a list example (e.g. float literal), never a heading.
            if pacing.BULLET_LEAD_RE.match(line):
                continue
            stacked = _stacked_title(lines, i + 1) if depth <= 3 else ""
            if depth == 2 and not stacked:
                continue
            title = stacked
        else:
            title = inline_title if depth <= 3 else ""
        out.append((number, title))
    return out


def _cn_headings(raw_text: str) -> list[tuple[str, str]]:
    lines = (raw_text or "").splitlines()
    out: list[tuple[str, str]] = []
    for i, line in enumerate(lines):
        m = pacing.CN_SECTION_RE.match(line)
        if not m:
            continue
        if m.group(1):
            num = m.group(1)
            title = _clean_title(m.group(2))
        else:
            num = m.group(3)
            title = _clean_title(m.group(4)) or _stacked_title(lines, i + 1)
        if pacing.valid_cn_heading(num, title):
            out.append((num, title))
    return out


def _section_of(number: str) -> str:
    return ".".join(number.split(".")[:2])


def _number_key(number: str) -> tuple[int, ...]:
    try:
        return (0, *(int(p) for p in number.split(".")))
    except ValueError:
        cn = pacing.parse_cn_ordinal(number)
        return (1, cn) if cn is not None else (999,)


def _is_chapter_page(raw: str, found: list[tuple[str, str]]) -> bool:
    return (
        not found
        and bool(_CHAPTER_LINE_RE.search(raw or ""))
        and len(re.sub(r"\s", "", raw or "")) <= _CHAPTER_PAGE_MAX_CHARS
    )


def _outline_cn(pages: Sequence[tuple[int, str]]) -> list[dict[str, Any]]:
    sections: dict[str, dict[str, Any]] = {}
    current: str | None = None
    for index, raw in pages:
        found = _cn_headings(raw)
        if _is_chapter_page(raw, found):
            continue
        for num, title in found:
            sec = sections.setdefault(num, {"number": num, "title": "", "pages": [], "subs": []})
            if title and not sec["title"]:
                sec["title"] = title
        uniq = list(dict.fromkeys(num for num, _ in found))
        if len(uniq) >= 2:
            current = None
            continue
        if len(uniq) == 1:
            current = uniq[0]
        if current is None:
            continue
        sections[current]["pages"].append(index)

    ordered = sorted(sections.values(), key=lambda s: _number_key(s["number"]))
    if len(ordered) >= 2 or (len(ordered) == 1 and ordered[0]["number"].startswith("第")):
        return ordered
    return []


def _declared_chapter_major(
    per_page: list[tuple[int, str, list[tuple[str, str]]]],
    by_major: dict[str, set[str]],
) -> str | None:
    """Infer a single chapter major number from TOC pages or chapter title slides."""
    toc_majors: set[str] = set()
    for _, _, found in per_page:
        level2 = list(dict.fromkeys(n for n, _ in found if n.count(".") == 1))
        if len(level2) >= 2:
            for num in level2:
                toc_majors.add(num.split(".")[0])
    if len(toc_majors) == 1:
        major = next(iter(toc_majors))
        if major in by_major:
            return major
    elif len(toc_majors) > 1:
        return None

    cover_majors: set[str] = set()
    for _, raw, found in per_page:
        if not _is_chapter_page(raw, found):
            continue
        m = _CHAPTER_NUM_RE.search(raw or "")
        if not m:
            continue
        parsed = pacing.parse_cn_ordinal(m.group(1))
        if parsed is not None:
            cover_majors.add(str(parsed))
    if len(cover_majors) == 1:
        major = next(iter(cover_majors))
        if major in by_major:
            return major
    return None


def _stray_major_sections(per_page: list[tuple[int, str, list[tuple[str, str]]]]) -> set[str]:
    """Identify out-of-chapter numeric headings (nested 1.1/1.2 inside Ch.8 or stray floats)."""
    by_major: dict[str, set[str]] = {}
    major_pages: dict[str, list[int]] = {}
    for page_no, _, found in per_page:
        for num, _ in found:
            sec = _section_of(num)
            major = sec.split(".")[0]
            by_major.setdefault(major, set()).add(sec)
            major_pages.setdefault(major, []).append(page_no)

    declared = _declared_chapter_major(per_page, by_major)
    if declared is not None:
        stray: set[str] = set()
        for major, secs in by_major.items():
            if major != declared:
                stray.update(secs)
        return stray

    dominant = [
        (major, min(pgs), max(pgs))
        for major, secs in by_major.items()
        if len(secs) >= 2 and (pgs := major_pages.get(major))
    ]
    if len(dominant) != 1:
        return set()
    dom_major, dom_min, dom_max = dominant[0]
    stray = set()
    for major, secs in by_major.items():
        if major == dom_major or len(secs) != 1:
            continue
        pgs = major_pages.get(major) or []
        if pgs and all(dom_min < p < dom_max for p in pgs):
            stray.update(secs)
    return stray


def outline(pages: Sequence[tuple[int, str]]) -> list[dict[str, Any]]:
    """Build chapter section hierarchy from [(page_no, raw_text), ...]."""
    per_page: list[tuple[int, str, list[tuple[str, str]]]] = [
        (index, raw, headings(raw)) for index, raw in pages
    ]
    stray_secs = _stray_major_sections(per_page)

    sections: dict[str, dict[str, Any]] = {}
    subs: dict[str, dict[str, Any]] = {}

    def get_sec(number: str, title: str = "") -> dict[str, Any]:
        sec = sections.setdefault(number, {"number": number, "title": "", "pages": [], "subs": []})
        if title and not sec["title"]:
            sec["title"] = title
        return sec

    def get_sub(number: str, title: str = "") -> dict[str, Any]:
        sub = subs.get(number)
        if sub is None:
            sub = subs[number] = {"number": number, "title": "", "pages": []}
            get_sec(_section_of(number))["subs"].append(sub)
        if title and not sub["title"]:
            sub["title"] = title
        return sub

    current: tuple[str, str] | None = None
    for index, raw, raw_found in per_page:
        found = [(num, title) for num, title in raw_found if _section_of(num) not in stray_secs]
        if _is_chapter_page(raw, found):
            continue
        level3 = list(dict.fromkeys(n for n, _ in found if n.count(".") == 2))
        level2 = list(dict.fromkeys(n for n, _ in found if n.count(".") == 1))
        for number, title in found:
            if number.count(".") == 1:
                get_sec(number, title)
            else:
                get_sub(number, title)
        if len(level3) >= 2:
            current = (_section_of(level3[0]), "")
        elif len(level3) == 1:
            current = (_section_of(level3[0]), level3[0])
        elif len(level2) >= 2:
            current = None
            continue
        elif len(level2) == 1:
            current = (level2[0], "")
        if current is None:
            continue
        s_num, sub_num = current
        sections[s_num]["pages"].append(index)
        if sub_num:
            subs[sub_num]["pages"].append(index)

    ordered = sorted(sections.values(), key=lambda s: _number_key(s["number"]))
    for s in ordered:
        s["subs"].sort(key=lambda p: _number_key(p["number"]))
    return ordered or _outline_cn(pages)


def sections_from_pages(pages: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Detect sections from page dicts or fall back to WHOLE_CHAPTER."""
    texts = [
        (int(p.get("page_no") or p.get("index") or idx), str(p.get("raw_text") or p.get("text") or ""))
        for idx, p in enumerate(pages, 1)
    ]
    found = outline(texts)
    if not found:
        found = outline([(int(p.get("page_no") or p.get("index") or idx), str(p.get("text") or "")) for idx, p in enumerate(pages, 1)])
    if not found and texts:
        return [{"number": "", "title": WHOLE_CHAPTER, "pages": sorted(n for n, _ in texts), "subs": []}]
    return found


def _clean_pages(values: Any, valid_pages: set[int]) -> list[int]:
    out: set[int] = set()
    for v in values if isinstance(values, (list, tuple)) else []:
        try:
            n = int(v)
        except (TypeError, ValueError):
            continue
        if n in valid_pages:
            out.add(n)
    return sorted(out)


def _strip_point_prefix(title: str) -> str:
    current = title.strip()
    if not current:
        return ""
    for _ in range(2):
        changed = False
        for pat in _POINT_PREFIX_PATTERNS:
            nxt = pat.sub("", current, count=1).strip()
            if nxt and nxt != current:
                current = nxt
                changed = True
        if not changed:
            break
    return current or title


def _clean_point(p: Any, valid_pages: set[int]) -> dict[str, Any] | None:
    if not isinstance(p, dict):
        return None
    title = _strip_point_prefix(_clean_title(p.get("title") or p.get("name") or ""))
    number = str(p.get("number") or "").strip()[:MAX_NUMBER]
    if not title and not number:
        return None
    return {
        "number": number,
        "title": title,
        "pages": _clean_pages(p.get("pages"), valid_pages),
        "brief": _clean_title(p.get("brief") or "", MAX_BRIEF),
    }


def _loose_pages(sections: Iterable[dict[str, Any]], numbers: Sequence[int]) -> list[int]:
    used: set[int] = set()
    for s in sections:
        used.update(s.get("pages") or [])
        for p in s.get("points") or []:
            used.update(p.get("pages") or [])
    return [n for n in numbers if n not in used]


def _section_key(section: dict[str, Any]) -> str:
    return str(section.get("number") or section.get("title") or WHOLE_CHAPTER)


def _section_label(section: dict[str, Any]) -> str:
    number = _clean_label(section.get("number"))
    title = _clean_label(section.get("title"))
    return f"{number} {title}".strip() if number else (title or WHOLE_CHAPTER)


def build_outline(sections: Sequence[dict[str, Any]], loose: Sequence[int]) -> str:
    """Format chapter section outline for the knowledge extraction prompt."""
    lines: list[str] = []
    for s in sections:
        head = " ".join(x for x in (s["number"], s["title"]) if x) or WHOLE_CHAPTER
        pages_str = format_page_ranges(s["pages"], sep="、", dash="–")
        lines.append(f"- 节 {_section_key(s)}：{head}（第 {pages_str} 页）" if pages_str else f"- 节 {_section_key(s)}：{head}（没有自己的页）")
        subs = [
            f"{p['number']} {p['title']}".strip()
            + (f"（第 {format_page_ranges(p['pages'], sep='、', dash='–')} 页）" if p.get("pages") else "")
            for p in s.get("subs") or []
        ]
        if subs:
            lines.append("  小节标题：" + "；".join(subs))
    if loose:
        lines.append(f"- 不属于任何节的页：第 {format_page_ranges(loose, sep='、', dash='–')} 页（封面、目录、小结等）")
    return "\n".join(lines)


def build_notes(pages: Sequence[dict[str, Any]], max_chars: int = MAX_CONTEXT_CHARS) -> str:
    """Concatenate per-page text blocks bounded to max_chars."""
    texts = [
        (int(p.get("page_no") or p.get("index") or 0), str(p.get("text") or "").strip())
        for p in pages
        if str(p.get("text") or "").strip() and int(p.get("page_no") or p.get("index") or 0) > 0
    ]
    total = sum(len(t) for _, t in texts)
    ratio = 1.0 if total <= max_chars else max_chars / total
    parts: list[str] = []
    for index, text in texts:
        if ratio < 1.0:
            text = text[: max(80, int(len(text) * ratio))]
        parts.append(f"【第 {index} 页】\n{text}")
    return "\n\n".join(parts)


def parse_points(text: str | Any, sections: Sequence[dict[str, Any]], valid_pages: set[int]) -> list[dict[str, Any]]:
    """Parse model JSON reply into normalized section -> points structure."""
    data = extract_json_payload(text) if isinstance(text, str) else text
    if isinstance(data, dict):
        data = data.get("sections")
    if not isinstance(data, list):
        raise ValueError("没有 sections 数组")
    by_key: dict[str, dict[str, Any]] = {}
    for s in sections:
        by_key[_section_key(s)] = s
        num = str(s.get("number") or "").strip()
        title = str(s.get("title") or "").strip()
        if num:
            by_key[f"{num}、"] = s
            if title:
                for sep in (" ", "、", "：", ":"):
                    by_key[f"{num}{sep}{title}"] = s
    by_title = {s["title"]: s for s in sections if s["title"]}
    found: dict[str, list[dict[str, Any]]] = {_section_key(s): [] for s in sections}
    global_seen: dict[str, dict[str, Any]] = {}
    for item in data:
        if not isinstance(item, dict):
            continue
        raw_key = str(item.get("section") or item.get("number") or "").strip()
        trimmed = raw_key.rstrip("、：:．. ")
        section = by_key.get(raw_key) or by_key.get(trimmed) or by_title.get(raw_key) or by_title.get(trimmed)
        if section is None and len(sections) == 1:
            section = sections[0]
        if section is None:
            continue
        bucket = found[_section_key(section)]
        for raw in (item.get("points") or [])[:MAX_POINTS]:
            point = _clean_point(raw, valid_pages)
            if not point or not point["title"]:
                continue
            key = squeeze_text(point["title"])
            if key in global_seen:
                old = global_seen[key]
                old["pages"] = sorted(set(old["pages"]) | set(point["pages"]))
                continue
            global_seen[key] = point
            point["number"] = ""
            bucket.append(point)
    return [
        {"number": s["number"], "title": s["title"], "pages": s["pages"], "points": found[_section_key(s)]}
        for s in sections
    ][:MAX_SECTIONS]


def extract_knowledge_points(
    pages: Sequence[dict[str, Any]],
    llm: llm_mod.LLMClient,
    *,
    model: str | None = None,
    existing_titles: Sequence[str] = (),
) -> dict[str, Any]:
    """Run in-memory AI knowledge-point extraction on a chapter's pages."""
    norm_pages = [
        {
            "page_no": int(p.get("page_no") or p.get("index") or idx),
            "text": str(p.get("text") or p.get("raw_text") or ""),
            "raw_text": str(p.get("raw_text") or p.get("text") or ""),
        }
        for idx, p in enumerate(pages, 1)
    ]
    valid_pages = {p["page_no"] for p in norm_pages if p["page_no"] > 0}
    numbers = sorted(valid_pages)
    if not numbers:
        raise ValueError("这一章没有可用的课件页面")

    sections = sections_from_pages(norm_pages)
    loose = _loose_pages(sections, numbers)
    total_pages = max(numbers)
    content_pages = [
        p
        for p in norm_pages
        if pacing.classify_slide(p["page_no"], total_pages, p["raw_text"], p["text"]) not in pacing.NON_CONTENT_KINDS
        and p["text"].strip()
    ]
    used_pages = content_pages if len(content_pages) >= 2 else [p for p in norm_pages if p["text"].strip()]
    notes_text = build_notes(used_pages)
    if not notes_text:
        raise ValueError("这一章还没有可用于抽取知识点的文字内容")

    user_prompt = prompts.PROMPT_KNOWLEDGE_USER.format(outline=build_outline(sections, loose), notes=notes_text)
    clean_existing = [str(t).strip() for t in existing_titles if str(t).strip()][:60]
    if clean_existing:
        user_prompt += (
            "\n\n本章已存在的知识点名称如下；若本次识别的知识点语义相同，请优先沿用完全一致的原名，不要换近义词重复命名：\n"
            + "\n".join(f"- {t}" for t in clean_existing)
        )
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": prompts.PROMPT_KNOWLEDGE_SYSTEM},
        {"role": "user", "content": user_prompt},
    ]
    parsed_sections: list[dict[str, Any]] | None = None
    usage: dict[str, Any] = {}
    problem = ""
    for _ in range(2):
        raw_data, usage = llm.chat_json(messages, model=model, temperature=0.2)
        try:
            parsed_sections = parse_points(raw_data, sections, valid_pages)
            break
        except ValueError as exc:
            problem = f"模型回复不是合法结构（{exc}）"
            messages = messages[:2] + [{"role": "user", "content": "上一次回复缺少 sections 数组。请仅输出合法 JSON 对象。"}]

    if parsed_sections is None:
        raise llm_mod.LLMFailed(problem or "模型没有返回知识点")
    count = sum(len(s["points"]) for s in parsed_sections)
    if not count:
        raise llm_mod.LLMFailed("模型没有抽出任何知识点")
    empty = [s for s in parsed_sections if not s["points"]]
    notes = [f"{len(empty)} 节没有抽出知识点：{'、'.join(_section_key(s) for s in empty)}"] if empty else []
    return {
        "sections": parsed_sections,
        "loose": _loose_pages(parsed_sections, numbers),
        "points": count,
        "notes": notes,
        "usage": usage,
        "model": model or llm.model,
    }


def _point_notes(point: dict[str, Any]) -> str:
    parts: list[str] = []
    page_range = format_page_ranges(point.get("pages") or [], sep="、", dash="–")
    if page_range:
        parts.append(f"第 {page_range} 页")
    brief = clean_xml_text(point.get("brief")).strip()
    if brief:
        parts.append(brief)
    return "\n".join(parts)


def _make_topic(title: str, notes: str = "", children: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"id": uuid.uuid4().hex, "title": title, "notes": notes, "children": children or []}


def _section_topic(section: dict[str, Any]) -> dict[str, Any]:
    points: list[dict[str, Any]] = []
    for point in section.get("points") or []:
        if not isinstance(point, dict):
            continue
        title = _clean_label(point.get("title") or point.get("name"))
        if title:
            points.append(_make_topic(title, notes=_point_notes(point)))
    return _make_topic(_section_label(section), children=points)


def _build_xmind_tree(root_title: str, chapters: Sequence[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    has_sections = any(
        isinstance(sec, dict) for ch in chapters if isinstance(ch, dict) for sec in (ch.get("sections") or [])
    )
    if not chapters or not has_sections:
        raise ValueError("没有可导出的章节或知识点")
    clean_root = _clean_label(root_title)
    if len(chapters) == 1:
        ch = chapters[0] if isinstance(chapters[0], dict) else {}
        title = _clean_label(ch.get("title")) or clean_root or "知识图谱"
        children = [_section_topic(s) for s in (ch.get("sections") or []) if isinstance(s, dict)]
        return title, _make_topic(title, children=children)
    title = clean_root or "知识图谱"
    chapter_topics: list[dict[str, Any]] = []
    for idx, ch in enumerate(chapters, 1):
        if not isinstance(ch, dict):
            continue
        ch_title = _clean_label(ch.get("title")) or f"第 {idx} 章"
        sec_topics = [_section_topic(s) for s in (ch.get("sections") or []) if isinstance(s, dict)]
        chapter_topics.append(_make_topic(ch_title, children=sec_topics))
    return title, _make_topic(title, children=chapter_topics)


def _topic_to_xml(topic: dict[str, Any]) -> str:
    parts = [f'<topic id="{topic["id"]}">', f"<title>{xml_escape(topic['title'])}</title>"]
    if topic["notes"]:
        parts.append(f"<notes><plain>{xml_escape(topic['notes'])}</plain></notes>")
    if topic["children"]:
        attached = "".join(_topic_to_xml(child) for child in topic["children"])
        parts.append(f'<children><topics type="attached">{attached}</topics></children>')
    parts.append("</topic>")
    return "".join(parts)


def _topic_to_json(topic: dict[str, Any]) -> dict[str, Any]:
    node: dict[str, Any] = {"id": topic["id"], "class": "topic", "title": topic["title"]}
    if topic["notes"]:
        node["notes"] = {"plain": {"content": topic["notes"]}}
    if topic["children"]:
        node["children"] = {"attached": [_topic_to_json(child) for child in topic["children"]]}
    return node


def export_knowledge_xmind(title: str, chapters: Sequence[dict[str, Any]]) -> bytes:
    """Export dual-format .xmind archive (XML + Zen JSON)."""
    sheet_title, root_topic = _build_xmind_tree(title, chapters)
    sheet_id = uuid.uuid4().hex
    content_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>'
        '<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" version="2.0">'
        f'<sheet id="{sheet_id}" theme="default"><title>{xml_escape(sheet_title)}</title>'
        f"{_topic_to_xml(root_topic)}</sheet></xmap-content>"
    )
    content_json = json.dumps(
        [{"id": sheet_id, "class": "sheet", "title": sheet_title, "rootTopic": _topic_to_json(root_topic)}],
        ensure_ascii=False,
    )
    metadata_json = json.dumps({"creator": {"name": "Pythontopia Course Studio", "version": "0.1"}}, ensure_ascii=False)
    manifest_json = json.dumps({"file-entries": {"content.json": {}, "metadata.json": {}}}, ensure_ascii=False)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("content.xml", content_xml)
        archive.writestr("META-INF/manifest.xml", _XMIND_MANIFEST_XML)
        archive.writestr("content.json", content_json)
        archive.writestr("metadata.json", metadata_json)
        archive.writestr("manifest.json", manifest_json)
    return buf.getvalue()


def export_knowledge_xlsx(title: str, chapters: Sequence[dict[str, Any]]) -> bytes:
    """Export knowledge graph rows as a single-sheet .xlsx workbook."""
    del title
    rows: list[list[str]] = [list(EXPORT_COLUMNS)]
    for ch in chapters:
        if not isinstance(ch, dict):
            continue
        ch_title = _clean_label(ch.get("title"))
        for sec in ch.get("sections") or []:
            if not isinstance(sec, dict):
                continue
            sec_label = _section_label(sec)
            points = [p for p in (sec.get("points") or []) if isinstance(p, dict) and _clean_label(p.get("title") or p.get("name"))]
            if not points:
                rows.append([ch_title, sec_label, "", "", "", "", "", format_page_ranges(sec.get("pages") or [], sep="、", dash="–")])
                continue
            for pt in points:
                rows.append(
                    [
                        ch_title,
                        sec_label,
                        _clean_label(pt.get("title") or pt.get("name")),
                        "",
                        "",
                        "",
                        clean_xml_text(pt.get("brief")).strip(),
                        format_page_ranges(pt.get("pages") or [], sep="、", dash="–"),
                    ]
                )
    return build_xlsx(rows, sheet_name="知识图谱", widths=(24, 24, 28, 18, 18, 14, 42, 18), header_fill="D9EAD3")


def export_knowledge_docx(title: str, chapters: Sequence[dict[str, Any]]) -> bytes:
    """Export course knowledge graph summary as a .docx archive."""
    has_sections = any(
        isinstance(sec, dict) for ch in chapters if isinstance(ch, dict) for sec in (ch.get("sections") or [])
    )
    if not chapters or not has_sections:
        raise ValueError("没有可导出的章节或知识点")
    doc_title = _clean_label(title) or "知识图谱"
    paras: list[str] = [docx_paragraph(f"{doc_title} 知识图谱汇总", "Title")]
    for ch in chapters:
        if not isinstance(ch, dict):
            continue
        paras.append(docx_paragraph(_clean_label(ch.get("title")) or "未命名章节", "Heading1"))
        for sec in ch.get("sections") or []:
            if not isinstance(sec, dict):
                continue
            paras.append(docx_paragraph(_section_label(sec), "Heading2"))
            pts = [p for p in (sec.get("points") or []) if isinstance(p, dict) and _clean_label(p.get("title") or p.get("name"))]
            if not pts:
                paras.append(docx_paragraph("（本节暂无知识点）", "Normal"))
                continue
            for p in pts:
                pname = _clean_label(p.get("title") or p.get("name"))
                pg = format_page_ranges(p.get("pages") or [], sep="、", dash="–")
                head = f"• {pname}" + (f"（第 {pg} 页）" if pg else "")
                paras.append(docx_paragraph(head, "Bullet"))
                brief = clean_xml_text(p.get("brief")).strip()
                if brief:
                    paras.append(docx_paragraph(f"简介：{brief}", "Quote"))
    return build_docx_zip(paras)
