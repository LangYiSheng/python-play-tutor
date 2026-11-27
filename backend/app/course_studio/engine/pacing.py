"""Pure speech-rate pacing, section detection, slide classification, and style presets."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from .text_utils import PAUSE_MARK, strip_pause_marks

CHARS_PER_MIN = 244.0
TRANSITION_SECONDS = 3.0
PAUSE_SECONDS = 0.5
BUFFER_RATIO = 0.0
SECTION_TARGET_MINUTES = 10.0
DEFAULT_SECTION_LEVEL = 2
LEGACY_SECTION_LEVEL = 3
SECTION_LEVEL_KP = 4
CHAPTER_TARGET_MINUTES = 90.0
MIN_PAGE_BUDGET = 30
MAX_PAGE_BUDGET = 600
MIN_WEIGHT = 60
MAX_WEIGHT = 400
OVERRUN_TOLERANCE = 1.10
MIN_FILL_RATIO = 0.85
CONTENT_RATIO = 1.5
UNLABELED_SECTION = "未编号"
UNLABELED_MINUTES = 2.0

PAGE_KIND_LABELS: dict[str, str] = {
    "cover": "封面页",
    "toc": "目录/过渡页",
    "content": "正文页",
    "ending": "小结/致谢页",
}
NON_CONTENT_KINDS: frozenset[str] = frozenset({"cover", "toc", "ending"})
PAGE_KIND_MAX_CHARS: dict[str, int] = {
    "cover": 65,
    "toc": 80,
    "ending": 65,
}
FALLBACK_BLOCK_PAGES = 10
MAX_PAUSES_PER_PAGE = 2
THIN_PAGE_BUDGET = 60
SQUEEZE_RATIO = 0.6

SCRIPT_STYLE_DEFAULT_PRESET = "natural"
SCRIPT_STYLE_MAX_CHARS = 1500
SCRIPT_STYLE_PRESETS: dict[str, dict[str, str]] = {
    "natural": {
        "label": "自然授课",
        "instruction": "",
    },
    "concise": {
        "label": "精炼干货",
        "instruction": (
            "授课节奏紧凑干练，直击定义、关键参数、对比差异与结论，"
            "少用铺垫和寒暄，每句话都承载明确知识点。"
        ),
    },
    "conversational": {
        "label": "启发互动",
        "instruction": (
            "语气更亲切轻松，像面对面给学生讲课；可自然穿插「咱们」「大家想一想」"
            "「这里容易弄混的是」等课堂提醒与设问，但严禁编造课件外的例子或事实。"
        ),
    },
}

_PAUSE_RE = re.compile(r"\[\s*(?:停顿|pause)\s*\]", re.IGNORECASE)
_ANY_MARK_RE = re.compile(r"\[[^\[\]]{0,12}\]")
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_LATIN_RUN_RE = re.compile(r"[A-Za-z0-9]+")

_UNIT_EN_MULTI = (
    r"mb|kb|gb|tb|pb|hz|khz|mhz|ghz|mm|cm|dm|km|px|pt|fps|bps|kbps|mbps|gbps"
    r"|db|bit|bits|byte|bytes|ms|us|ns|mah|wh|kw|mw|kv|mv|kg|mg|ml"
)
_UNIT_EN_SINGLE = r"b(?!树|\+)|m(?!进制)|s(?!形)|v(?!模型)|w|g|k(?!均值)|l"
_UNIT_CN = (
    r"声道(?!数)|分钟|小时|毫秒|微秒|纳秒|分贝|赫兹|千赫|兆赫|吉赫|字节|千字节|兆字节|吉字节"
    r"|毫米|厘米|分米|千米|英寸|英尺"
    r"|倍|折(?![叠射线])|万(?![维物])|亿|元(?![件素宇数器宵旦])|秒"
    r"|分(?![辨类析割频布支层区步解享组子母])"
    r"|版(?:[ \t\r]*$|[，,。.；;：:、！!？?（）()/\-~～]|本(?![控管]))"
)

HEADING_LEAD_RE = r"^[ \t]*(?:[•·▪●◆■□▸▹►][ \t]*|[\-\*][ \t]+)?"
BULLET_LEAD_RE = re.compile(r"^[ \t]*(?:[•·▪●◆■□▸▹►]|[\-\*][ \t]+)")
HEADING_SEP_RE = r"(?:[、：:．\-—–]|\.(?=[ \t]))?"
HEADING_TAIL_TITLE_RE = (
    r"(?![0-9]|\.[0-9])"
    r"(?="
    rf"[ \t]*{HEADING_SEP_RE}[ \t]*(?!{_UNIT_CN})[\u3400-\u4dbf\u4e00-\u9fff]"
    rf"|[ \t]*{HEADING_SEP_RE}[ \t]*(?!(?i:(?:{_UNIT_EN_MULTI}))(?![A-Za-z]))"
    rf"(?!(?i:(?:{_UNIT_EN_SINGLE}))(?![A-Za-z]))"
    r"[A-Za-z][A-Za-z0-9 +.#/_&'-]*(?:[ \t\r]*$|[\u3400-\u4dbf\u4e00-\u9fff（）()：:、—\-]))"
)
HEADING_TAIL_RE = (
    r"(?![0-9]|\.[0-9])"
    r"(?=[ \t\r]*$"
    rf"|[ \t]*{HEADING_SEP_RE}[ \t]*(?!{_UNIT_CN})[\u3400-\u4dbf\u4e00-\u9fff]"
    rf"|[ \t]*{HEADING_SEP_RE}[ \t]*(?!(?i:(?:{_UNIT_EN_MULTI}))(?![A-Za-z]))"
    rf"(?!(?i:(?:{_UNIT_EN_SINGLE}))(?![A-Za-z]))"
    r"[A-Za-z][A-Za-z0-9 +.#/_&'-]*(?:[ \t\r]*$|[\u3400-\u4dbf\u4e00-\u9fff（）()：:、—\-]))"
)
# Bullet-prefixed bare decimals (e.g. "• 1.1" as a Python float example) are never section headings;
# standalone bare numbers at EOL are only allowed without a leading bullet (e.g. divider slide "3.1\nTitle").
SECTION_RE = re.compile(
    rf"(?:{HEADING_LEAD_RE}(\d{{1,2}}(?:\.\d{{1,2}}){{1,3}}){HEADING_TAIL_TITLE_RE}"
    rf"|^[ \t]*(\d{{1,2}}(?:\.\d{{1,2}}){{1,3}})(?![0-9]|\.[0-9])[ \t\r]*$)",
    re.MULTILINE,
)

_MAX_SECTION_PART = 20
_CN_DIGITS: dict[str, int] = {
    "一": 1,
    "二": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}
_CN_UNIT_SUFFIX_RE = r"(?:部分|模块|单元|[节篇])"
CN_SECTION_RE = re.compile(
    rf"{HEADING_LEAD_RE}(?:([一二三四五六七八九十]{{1,3}})[、．.][ \t]*([^\r\n]+)"
    rf"|(第[一二三四五六七八九十\d]{{1,3}}{_CN_UNIT_SUFFIX_RE})[ \t]*(?:[、：:．.\-—–][ \t]*)?([^\r\n]*))\r?$",
    re.MULTILINE,
)
_CN_SENTENCE_END = re.compile(r"[。！？!?]")

_CHAPTER_COVER_RE = re.compile(r"^[ \t]*第[一二三四五六七八九十百\d]+[章讲单元]", re.MULTILINE)
_SEC_PREFIX_RE = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){1,3})(?:\b|\s|[、：:．\-—–]|$)")
_TOC_HEADER_RE = re.compile(
    r"(?:^|\n)[ \t]*(?:本[章节课]|课程|章节)?目[ \t]*录[ \t]*(?:$|\n)"
    r"|(?:^|\n)[ \t]*CONTENTS[ \t]*(?:$|\n)",
    re.IGNORECASE,
)
_COVER_EXTRA_RE = re.compile(
    r"特色教材|参考教材|普通高等教育|高等学校.*教材|主讲人?|授课教师|出版社|学院|课程名称|教学课件"
)
_ENDING_RE = re.compile(
    r"谢谢观看|感谢聆听|谢谢大家|感谢观看|敬请指正|Thank\s*You|THE\s*END"
    r"|本章小结|本节小结|课程小结|课后作业|思考与练习|作业与思考|Q\s*&\s*A",
    re.IGNORECASE,
)
_ENDING_THANKS_RE = re.compile(r"谢谢观看|感谢聆听|谢谢大家|感谢观看|Thank\s*You|THE\s*END", re.IGNORECASE)
_CHAPTER_ENUM_COUNT_RE = re.compile(r"第[一二三四五六七八九十百\d]+[章讲]")


def build_style_hint(preset: str = SCRIPT_STYLE_DEFAULT_PRESET, custom_prompt: str = "") -> str:
    """Combine preset teaching style instruction and optional teacher prompt."""
    key = str(preset or SCRIPT_STYLE_DEFAULT_PRESET).strip().lower()
    if key not in SCRIPT_STYLE_PRESETS:
        key = SCRIPT_STYLE_DEFAULT_PRESET
    preset_text = SCRIPT_STYLE_PRESETS[key]["instruction"].strip()
    custom_text = str(custom_prompt or "").strip()[:SCRIPT_STYLE_MAX_CHARS]
    return "\n".join(part for part in (preset_text, custom_text) if part)


def parse_cn_ordinal(token: str) -> int | None:
    """Parse Chinese numeral or section ordinal token into 1..20."""
    s = str(token or "").strip()
    if s.startswith("第"):
        s = re.sub(rf"^第(.+?){_CN_UNIT_SUFFIX_RE}?$", r"\1", s)
    if not s:
        return None
    if s.isdigit():
        val = int(s)
        return val if 1 <= val <= _MAX_SECTION_PART else None
    if s == "十":
        return 10
    if len(s) == 1 and s in _CN_DIGITS:
        return _CN_DIGITS[s]
    if len(s) == 2 and s[0] == "十" and s[1] in _CN_DIGITS:
        val = 10 + _CN_DIGITS[s[1]]
        return val if val <= _MAX_SECTION_PART else None
    if len(s) == 2 and s[0] in _CN_DIGITS and s[1] == "十":
        val = _CN_DIGITS[s[0]] * 10
        return val if val <= _MAX_SECTION_PART else None
    if len(s) == 3 and s[0] in _CN_DIGITS and s[1] == "十" and s[2] in _CN_DIGITS:
        val = _CN_DIGITS[s[0]] * 10 + _CN_DIGITS[s[2]]
        return val if val <= _MAX_SECTION_PART else None
    return None


def _clean_cn_title(raw_title: str) -> str:
    return re.sub(r"\s+", " ", str(raw_title or "")).strip().strip(" ·•▪-—–:：、．.")


def valid_cn_heading(num: str, title: str) -> bool:
    """Validate whether a Chinese-numeral heading is a real section heading."""
    if parse_cn_ordinal(num) is None:
        return False
    if num.startswith("第"):
        return title == "" or (1 <= len(title) <= 32 and not _CN_SENTENCE_END.search(title))
    return 2 <= len(title) <= 32 and not _CN_SENTENCE_END.search(title)


def detect_cn_headings(raw_text: str) -> list[tuple[str, str]]:
    """Extract Chinese-numeral section headings from page text."""
    out: list[tuple[str, str]] = []
    for m in CN_SECTION_RE.finditer(raw_text or ""):
        if m.group(1):
            num = m.group(1)
            title = _clean_cn_title(m.group(2) or "")
        else:
            num = m.group(3)
            title = _clean_cn_title(m.group(4) or "")
        if valid_cn_heading(num, title):
            out.append((num, title))
    return out


def detect_cn_section(raw_text: str) -> str:
    """Return a single Chinese section number when the page belongs to one section."""
    found = detect_cn_headings(raw_text)
    uniq = list(dict.fromkeys(num for num, _ in found))
    return uniq[0] if len(uniq) == 1 else ""


def count_spoken_chars(text: str) -> int:
    """Count spoken characters (CJK = 1 each, contiguous alphanumeric run = 1)."""
    t = _PAUSE_RE.sub(" ", text or "")
    t = _ANY_MARK_RE.sub(" ", t)
    return len(_CJK_RE.findall(t)) + len(_LATIN_RUN_RE.findall(t))


def count_pauses(text: str) -> int:
    """Count pause markers in text."""
    return len(_PAUSE_RE.findall(text or ""))


def estimate_seconds(text: str, chars_per_min: float = CHARS_PER_MIN) -> float:
    """Estimate spoken duration in seconds."""
    if chars_per_min <= 0:
        return 0.0
    return count_spoken_chars(text) / chars_per_min * 60.0 + count_pauses(text) * PAUSE_SECONDS


def format_time(seconds: float) -> str:
    """Format seconds as M:SS."""
    total = max(0, int(round(seconds)))
    return f"{total // 60}:{total % 60:02d}"


def char_budget_for_section(
    n_pages: int,
    target_minutes: float = SECTION_TARGET_MINUTES,
    chars_per_min: float = CHARS_PER_MIN,
    buffer_ratio: float = BUFFER_RATIO,
) -> int:
    """Convert section target minutes into spoken-character budget."""
    n = max(0, int(n_pages))
    if n == 0:
        return 0
    gross = max(0.0, float(target_minutes)) * 60.0
    reserved = TRANSITION_SECONDS * n + buffer_ratio * gross
    usable = max(0.0, gross - reserved)
    return int(usable / 60.0 * max(0.0, chars_per_min))


def allocate_page_budgets(
    weights: Sequence[float],
    total_budget: int,
    min_page: int = MIN_PAGE_BUDGET,
    max_page: int = MAX_PAGE_BUDGET,
    caps: Sequence[int | None] | None = None,
) -> list[int]:
    """Distribute section budget across pages by content weight with per-page caps."""
    if not weights:
        return []
    n = len(weights)
    if total_budget <= 0:
        return [min_page] * n

    w = [min(float(MAX_WEIGHT), max(float(MIN_WEIGHT), float(x))) for x in weights]
    limit = [
        float(max_page)
        if caps is None or caps[i] is None
        else float(max(min_page, min(max_page, int(caps[i] or 0))))
        for i in range(n)
    ]
    share = [0.0] * n
    free = set(range(n))
    remaining = float(total_budget)
    while free and remaining > 1e-9:
        wsum = sum(w[i] for i in free)
        capped = [i for i in free if remaining * w[i] / wsum >= limit[i]]
        if not capped:
            for i in free:
                share[i] = remaining * w[i] / wsum
            break
        for i in capped:
            share[i] = limit[i]
            remaining -= limit[i]
            free.discard(i)
    out = [max(min_page, int(round(x))) for x in share]

    over = sum(out) - total_budget
    if over > 0:
        order = sorted(range(n), key=lambda i: out[i], reverse=True)
        guard = 0
        while over > 0 and guard < 10000:
            changed = False
            for i in order:
                if over <= 0:
                    break
                if out[i] > min_page:
                    out[i] -= 1
                    over -= 1
                    changed = True
            if not changed:
                break
            guard += 1
    return out


def valid_section(label: str) -> bool:
    """Validate dotted numeric section number such as 1.1 or 3.2.1."""
    parts = label.split(".")
    if not (2 <= len(parts) <= 4):
        return False
    try:
        return all(
            not (len(p) > 1 and p.startswith("0")) and 0 < int(p) <= _MAX_SECTION_PART
            for p in parts
        )
    except ValueError:
        return False


def detect_section(raw_text: str, level: int = 2) -> str:
    """Extract the most specific section label truncated to requested heading level."""
    labels = [
        num
        for m in SECTION_RE.finditer(raw_text or "")
        if (num := m.group(1) or m.group(2)) and valid_section(num)
    ]
    if not labels:
        return ""
    most = max(labels, key=lambda s: (len(s.split(".")), len(s)))
    parts = most.split(".")
    return ".".join(parts[: max(1, int(level))])


def _block_fallback(slides: Sequence[Any]) -> list[tuple[str, list[Any]]]:
    groups: list[tuple[str, list[Any]]] = []
    for start in range(0, len(slides), FALLBACK_BLOCK_PAGES):
        block = list(slides[start : start + FALLBACK_BLOCK_PAGES])
        key = f"第{block[0].index}–{block[-1].index}页"
        for s in block:
            s.section = key
        groups.append((key, block))
    return groups


_CHAPTER_MAJOR_RE = re.compile(r"^[ \t]*第[ \t]*([一二三四五六七八九十百\d]+)[ \t]*[章讲]", re.MULTILINE)


def _declared_major_for_slides(raw_texts: Sequence[str], labels: Sequence[str]) -> str | None:
    present_majors = {lbl.split(".")[0] for lbl in labels if lbl and "." in lbl}
    if len(present_majors) <= 1:
        return None
    toc_majors: set[str] = set()
    for raw in raw_texts:
        level2 = list(
            dict.fromkeys(
                num
                for m in SECTION_RE.finditer(raw)
                if (num := m.group(1) or m.group(2)) and valid_section(num) and num.count(".") == 1
            )
        )
        if len(level2) >= 2:
            for num in level2:
                toc_majors.add(num.split(".")[0])
    if len(toc_majors) == 1:
        major = next(iter(toc_majors))
        if major in present_majors:
            return major
    elif len(toc_majors) > 1:
        return None

    cover_majors: set[str] = set()
    for raw, lbl in zip(raw_texts, labels):
        if lbl or len(re.sub(r"\s", "", raw)) > 120:
            continue
        m = _CHAPTER_MAJOR_RE.search(raw)
        if not m:
            continue
        parsed = parse_cn_ordinal(m.group(1))
        if parsed is not None:
            cover_majors.add(str(parsed))
    if len(cover_majors) == 1:
        major = next(iter(cover_majors))
        if major in present_majors:
            return major
    return None


def assign_sections(slides: Sequence[Any], level: int = 2) -> list[tuple[str, list[Any]]]:
    """Group pages by section number and write section labels back onto each item."""
    raw_texts = [str(getattr(s, "raw_text", "") or "") for s in slides]
    labels = [detect_section(raw, level) for raw in raw_texts]
    declared_major = _declared_major_for_slides(raw_texts, labels)
    if declared_major is not None:
        labels = [lbl if (lbl and lbl.split(".")[0] == declared_major) else "" for lbl in labels]
    if labels and not any(labels):
        cn_labels = [detect_cn_section(raw) for raw in raw_texts]
        uniq_cn = [x for x in dict.fromkeys(cn_labels) if x]
        if len(uniq_cn) >= 2 or (len(uniq_cn) == 1 and uniq_cn[0].startswith("第")):
            labels = cn_labels
        else:
            return _block_fallback(slides)

    order: list[str] = []
    buckets: dict[str, list[Any]] = {}
    current = ""
    for s, label in zip(slides, labels):
        if label:
            current = label
        elif not current:
            current = UNLABELED_SECTION
        s.section = current
        if current not in buckets:
            buckets[current] = []
            order.append(current)
        buckets[current].append(s)
    return [(k, buckets[k]) for k in order]


def classify_slide(index: int, total_pages: int, raw_text: str, note_text: str = "") -> str:
    """Classify a slide into cover, toc, ending, or content."""
    raw = (raw_text or "").strip()
    compact = re.sub(r"\s+", "", raw)
    note_chars = count_spoken_chars(note_text) if note_text else 0
    if not compact:
        return "cover" if index == 1 and total_pages > 1 and note_chars < 180 else "content"

    if _ENDING_THANKS_RE.search(raw) and len(compact) <= 90:
        return "ending"
    if (
        total_pages >= 3
        and index >= total_pages - 1
        and _ENDING_RE.search(raw)
        and len(compact) <= 180
        and note_chars < 220
    ):
        return "ending"

    sec_matches = [
        num
        for m in SECTION_RE.finditer(raw)
        if (num := m.group(1) or m.group(2)) and valid_section(num)
    ]
    level2 = {".".join(num.split(".")[:2]) for num in sec_matches if num.count(".") == 1}
    level3 = {".".join(num.split(".")[:3]) for num in sec_matches if num.count(".") >= 2}
    if _TOC_HEADER_RE.search(raw):
        return "toc"
    if len(level2) >= 2:
        return "toc"
    if len(set(_CHAPTER_ENUM_COUNT_RE.findall(raw))) >= 3 and len(compact) <= 260:
        return "toc"
    if len(level3) >= 3 and len(compact) <= 220:
        return "toc"
    if len(level2) == 1 and not level3 and len(compact) <= 45 and note_chars < 180:
        lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
        non_head = [
            ln
            for ln in lines
            if not SECTION_RE.match(ln) and not _CHAPTER_COVER_RE.match(ln) and ln not in ("目录", "本章内容")
        ]
        if len("".join(non_head)) <= 16:
            return "toc"

    if index == 1:
        if (_CHAPTER_COVER_RE.search(raw) or _COVER_EXTRA_RE.search(raw)) and not sec_matches and len(compact) <= 150:
            return "cover"
        if not sec_matches and len(compact) <= 60 and note_chars < 180:
            return "cover"
    if not sec_matches and _CHAPTER_COVER_RE.search(raw) and len(compact) <= 120 and note_chars < 180:
        return "cover"

    return "content"


def summarize_kinds_label(kinds: Sequence[str]) -> str:
    """Summarize non-content slide classifications into a readable Chinese label."""
    uniq = set(kinds)
    has_cover = "cover" in uniq
    has_toc = "toc" in uniq
    has_end = "ending" in uniq
    if has_cover and has_toc and not has_end:
        return "封面与目录"
    if has_cover and not has_toc and not has_end:
        return "封面页"
    if has_toc and not has_cover and not has_end:
        return "目录/过渡页"
    if has_end and not has_cover and not has_toc:
        return "小结/致谢页"
    if has_cover or has_toc or has_end:
        parts: list[str] = []
        if has_cover:
            parts.append("封面")
        if has_toc:
            parts.append("目录/过渡")
        if has_end:
            parts.append("小结")
        return "与".join(parts) + "页"
    return "目录/过渡页"


@dataclass
class PacingPage:
    """Lightweight typed container for page-level pacing calculations."""

    index: int
    raw_text: str = ""
    note: str = ""
    note_final: str = ""
    script: str = ""
    section: str = ""
    char_budget: int = 0
    expanded: bool = False


@dataclass
class PageTiming:
    """Timing audit row for a single page."""

    page: int = 0
    section: str = ""
    chars: int = 0
    budget: int = 0
    pauses: int = 0
    seconds: float = 0.0
    over: bool = False
    severe: bool = False
    under: bool = False
    expanded: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "page": self.page,
            "section": self.section,
            "chars": self.chars,
            "budget": self.budget,
            "pauses": self.pauses,
            "seconds": round(self.seconds, 1),
            "time": format_time(self.seconds),
            "over": self.over,
            "severe": self.severe,
            "under": self.under,
            "expanded": self.expanded,
        }


@dataclass
class SectionTiming:
    """Timing audit row for one section."""

    section: str = ""
    pages: list[int] = field(default_factory=list)
    chars: int = 0
    budget: int = 0
    seconds: float = 0.0
    target_minutes: float = SECTION_TARGET_MINUTES
    note_chars: int = 0

    @property
    def over(self) -> bool:
        return self.seconds > self.target_minutes * 60.0

    @property
    def budget_ratio(self) -> float:
        return self.budget / self.note_chars if self.note_chars else 0.0

    @property
    def squeezed(self) -> bool:
        return self.note_chars > 0 and self.budget_ratio < SQUEEZE_RATIO

    @property
    def under(self) -> bool:
        return self.seconds < self.target_minutes * 60.0 * MIN_FILL_RATIO

    def to_dict(self) -> dict[str, Any]:
        return {
            "section": self.section,
            "pages": list(self.pages),
            "page_count": len(self.pages),
            "chars": self.chars,
            "budget": self.budget,
            "seconds": round(self.seconds, 1),
            "time": format_time(self.seconds),
            "target_minutes": self.target_minutes,
            "over": self.over,
            "under": self.under,
            "note_chars": self.note_chars,
            "budget_ratio": round(self.budget_ratio, 2),
            "squeezed": self.squeezed,
        }


@dataclass
class PacingReport:
    """Full pacing audit report for a deck."""

    target_minutes: float = SECTION_TARGET_MINUTES
    chars_per_min: float = CHARS_PER_MIN
    section_level: int = 2
    pages: list[PageTiming] = field(default_factory=list)
    sections: list[SectionTiming] = field(default_factory=list)
    chapter_minutes: float = CHAPTER_TARGET_MINUTES
    effective_section_minutes: float = SECTION_TARGET_MINUTES
    content_minutes: float = 0.0
    plan_minutes: float = 0.0
    chapter_limited: bool = True

    @property
    def total_chars(self) -> int:
        return sum(p.chars for p in self.pages)

    @property
    def total_seconds(self) -> float:
        return sum(p.seconds for p in self.pages)

    @property
    def chapter_over(self) -> bool:
        return self.chapter_limited and self.total_seconds > self.chapter_minutes * 60.0

    @property
    def content_limited(self) -> bool:
        return self.chapter_limited and 0 < self.content_minutes < self.chapter_minutes - 0.5

    @property
    def plan_seconds(self) -> float:
        if self.plan_minutes > 0:
            return self.plan_minutes * 60.0
        if not self.chapter_limited:
            return self.total_seconds
        return self.chapter_minutes * 60.0

    @property
    def chapter_short(self) -> bool:
        if self.content_minutes > 0:
            return False
        return self.total_seconds < self.plan_seconds * MIN_FILL_RATIO

    @property
    def shortfall_seconds(self) -> float:
        return max(0.0, self.plan_seconds - self.total_seconds)

    @property
    def under_pages(self) -> list[PageTiming]:
        return [p for p in self.pages if p.under]

    @property
    def under_sections(self) -> list[SectionTiming]:
        return [s for s in self.sections if s.under]

    @property
    def section_limit_is_binding(self) -> bool:
        return self.effective_section_minutes < self.target_minutes - 1e-9

    @property
    def over_pages(self) -> list[PageTiming]:
        return [p for p in self.pages if p.over]

    @property
    def severe_pages(self) -> list[PageTiming]:
        return [p for p in self.pages if p.severe]

    @property
    def over_sections(self) -> list[SectionTiming]:
        return [s for s in self.sections if s.over]

    @property
    def squeezed_sections(self) -> list[SectionTiming]:
        return [s for s in self.sections if s.squeezed and s.section != UNLABELED_SECTION]

    def to_dict(self) -> dict[str, Any]:
        return {
            "target_minutes_per_section": self.target_minutes,
            "chapter_minutes": self.chapter_minutes,
            "chapter_limited": self.chapter_limited,
            "effective_section_minutes": round(self.effective_section_minutes, 2),
            "section_limit_binding": self.section_limit_is_binding,
            "chars_per_min": self.chars_per_min,
            "section_level": self.section_level,
            "total_chars": self.total_chars,
            "total_seconds": round(self.total_seconds, 1),
            "total_time": format_time(self.total_seconds),
            "chapter_over": self.chapter_over,
            "chapter_short": self.chapter_short,
            "content_minutes": round(self.content_minutes, 1),
            "content_limited": self.content_limited,
            "plan_minutes": round(self.plan_minutes, 1),
            "squeezed_sections": [s.section for s in self.squeezed_sections],
            "shortfall_seconds": round(self.shortfall_seconds, 1),
            "shortfall_time": format_time(self.shortfall_seconds),
            "over_page_count": len(self.over_pages),
            "under_page_count": len(self.under_pages),
            "over_pages": [p.page for p in self.over_pages],
            "under_pages": [p.page for p in self.under_pages],
            "over_sections": [s.section for s in self.over_sections],
            "under_sections": [s.section for s in self.under_sections],
            "sections": [s.to_dict() for s in self.sections],
            "pages": [p.to_dict() for p in self.pages],
        }


def _slide_text(slide: Any) -> str:
    for attr in ("script", "script_clean", "note_final", "note", "raw_text"):
        v = getattr(slide, attr, "")
        if v:
            return str(v)
    return ""


def _slide_weight(slide: Any) -> float:
    text = str(getattr(slide, "note_final", "") or getattr(slide, "note", "") or getattr(slide, "raw_text", "") or "")
    return float(len(text))


def content_cap(slide: Any) -> int | None:
    """Upper bound on spoken characters derived from page source/content text."""
    note = str(getattr(slide, "note_final", "") or getattr(slide, "note", "") or "")
    if not note:
        return None
    return max(MIN_PAGE_BUDGET, int(count_spoken_chars(note) * CONTENT_RATIO))


def minutes_for_chars(
    chars: float,
    n_pages: int,
    chars_per_min: float = CHARS_PER_MIN,
    buffer_ratio: float = BUFFER_RATIO,
) -> float:
    """Convert spoken chars + transitions into minutes."""
    if chars_per_min <= 0:
        return 0.0
    seconds = chars / chars_per_min * 60.0 + TRANSITION_SECONDS * max(0, n_pages)
    return seconds / max(1e-9, 1.0 - buffer_ratio) / 60.0


def fill_minutes(needs: Sequence[float], available: float) -> tuple[list[float], float]:
    """Water-filling allocation of chapter minutes across sections."""
    if not needs:
        return [], float("inf")
    if sum(needs) <= available:
        return list(needs), float("inf")
    remaining = max(0.0, float(available))
    order = sorted(needs)
    level = remaining / len(order)
    for i, need in enumerate(order):
        level = remaining / (len(order) - i)
        if need >= level:
            break
        remaining -= need
    return [min(need, level) for need in needs], level


def audit(
    slides: Sequence[Any],
    section_minutes: float = SECTION_TARGET_MINUTES,
    chars_per_min: float = CHARS_PER_MIN,
    level: int = 2,
    chapter_minutes: float = CHAPTER_TARGET_MINUTES,
) -> PacingReport:
    """Compute per-page budgets and full section/page timing report."""
    groups = assign_sections(slides, level)
    total_pages = max((int(getattr(s, "index", 0) or 0) for s in slides), default=len(slides))
    slide_kinds = {
        id(s): classify_slide(
            int(getattr(s, "index", 0) or 0),
            total_pages,
            str(getattr(s, "raw_text", "") or ""),
            str(getattr(s, "note_final", "") or getattr(s, "note", "") or ""),
        )
        for s in slides
    }
    caps: dict[int, int | None] = {}
    for s in slides:
        base_cap = content_cap(s)
        kind_cap = PAGE_KIND_MAX_CHARS.get(slide_kinds[id(s)])
        if base_cap is not None and kind_cap is not None:
            caps[id(s)] = min(base_cap, kind_cap)
        else:
            caps[id(s)] = base_cap

    def need(members: Sequence[Any]) -> float:
        page_caps = [caps[id(s)] for s in members]
        if any(c is None for c in page_caps):
            return float("inf")
        total_cap = sum(c for c in page_caps if c is not None)
        return minutes_for_chars(total_cap, len(members), chars_per_min)

    needs = {key: need(members) for key, members in groups}
    unlabeled = min(UNLABELED_MINUTES, needs.get(UNLABELED_SECTION, UNLABELED_MINUTES))
    real = [key for key, _ in groups if key != UNLABELED_SECTION]
    available = max(0.0, float(chapter_minutes) - (unlabeled if UNLABELED_SECTION in needs else 0.0))
    chapter_limited = chapter_minutes > 0
    if chapter_limited:
        shares, fill_level = fill_minutes([min(float(section_minutes), needs[key]) for key in real], available)
    else:
        shares, fill_level = [min(float(section_minutes), needs[key]) for key in real], float("inf")
    targets = dict(zip(real, shares))
    effective = min(float(section_minutes), fill_level)

    content = plan = 0.0
    if all(v != float("inf") for v in needs.values()):
        extra = unlabeled if UNLABELED_SECTION in needs else 0.0
        content = sum(needs[key] for key in real) + extra
        plan = sum(shares) + extra

    report = PacingReport(
        target_minutes=section_minutes,
        chars_per_min=chars_per_min,
        section_level=int(level),
        chapter_minutes=chapter_minutes,
        effective_section_minutes=effective,
        content_minutes=content,
        plan_minutes=plan,
        chapter_limited=chapter_limited,
    )

    for key, members in groups:
        target = unlabeled if key == UNLABELED_SECTION else targets[key]
        total_budget = char_budget_for_section(len(members), target, chars_per_min)
        budgets = allocate_page_budgets(
            [_slide_weight(s) for s in members],
            total_budget,
            max_page=max(MAX_PAGE_BUDGET, total_budget),
            caps=[caps[id(s)] for s in members],
        )
        sec = SectionTiming(
            section=key,
            target_minutes=target,
            note_chars=sum(
                count_spoken_chars(str(getattr(s, "note_final", "") or getattr(s, "note", "") or ""))
                for s in members
            ),
        )
        for slide, budget in zip(members, budgets):
            slide.char_budget = budget
            text = _slide_text(slide)
            chars = count_spoken_chars(text)
            seconds = estimate_seconds(text, chars_per_min)
            row = PageTiming(
                page=int(getattr(slide, "index", 0) or 0),
                section=key,
                chars=chars,
                budget=budget,
                pauses=count_pauses(text),
                seconds=seconds,
                over=chars > budget,
                severe=chars > budget * OVERRUN_TOLERANCE,
                under=chars < budget * MIN_FILL_RATIO,
                expanded=bool(getattr(slide, "expanded", False)),
            )
            report.pages.append(row)
            sec.pages.append(row.page)
            sec.chars += chars
            sec.budget += budget
            sec.seconds += seconds
        report.sections.append(sec)

    return report


def compute_section_budgets(
    pages: Sequence[Any],
    *,
    section_minutes: float = SECTION_TARGET_MINUTES,
    chapter_minutes: float = CHAPTER_TARGET_MINUTES,
    chars_per_min: float = CHARS_PER_MIN,
    level: int = DEFAULT_SECTION_LEVEL,
) -> PacingReport:
    """Public entry point computing section & per-page budgets for a slide sequence."""
    return audit(
        pages,
        section_minutes=section_minutes,
        chars_per_min=chars_per_min,
        level=level,
        chapter_minutes=chapter_minutes,
    )


def budget_for_pages(
    pages: Sequence[dict[str, Any]],
    *,
    section_minutes: float = SECTION_TARGET_MINUTES,
    chapter_minutes: float = CHAPTER_TARGET_MINUTES,
    chars_per_min: float = CHARS_PER_MIN,
    level: int = DEFAULT_SECTION_LEVEL,
) -> dict[int, dict[str, Any]]:
    """Calculate per-page section, kind, and spoken char budget from plain page dicts."""
    items = [
        PacingPage(
            index=int(p.get("page_no") or p.get("index") or idx),
            raw_text=str(p.get("raw_text") or p.get("text") or ""),
            note=str(p.get("note") or p.get("text") or ""),
        )
        for idx, p in enumerate(pages, 1)
    ]
    total = max((item.index for item in items), default=len(items))
    compute_section_budgets(
        items,
        section_minutes=section_minutes,
        chapter_minutes=chapter_minutes,
        chars_per_min=chars_per_min,
        level=level,
    )
    return {
        item.index: {
            "section": item.section,
            "kind": classify_slide(item.index, total, item.raw_text, item.note),
            "char_budget": item.char_budget,
        }
        for item in items
    }


def format_pages(pages: Sequence[int], limit: int = 12) -> str:
    """Format page numbers concisely for summary reports."""
    if not pages:
        return ""
    ordered = sorted(pages)
    if len(ordered) == 1:
        return str(ordered[0])
    if ordered == list(range(ordered[0], ordered[-1] + 1)):
        return f"{ordered[0]}–{ordered[-1]}"
    shown = "、".join(str(p) for p in ordered[:limit])
    return shown + (f" 等 {len(ordered)} 页" if len(ordered) > limit else "")


def summary_line(report: PacingReport) -> str:
    """Produce a one-line Chinese summary of a pacing report."""
    parts = [
        f"预计口播 {format_time(report.total_seconds)}（{report.total_chars} 字，按 {report.chars_per_min:.0f} 字/分钟）"
    ]
    if report.content_limited:
        parts.append(f"本章内容约够 {report.content_minutes:.0f} 分钟（整章上限 {report.chapter_minutes:g} 分钟，不注水）")
    if report.chapter_over:
        parts.append(
            f"⚠️ 超过整章上限 {report.chapter_minutes:g} 分钟（超 {format_time(report.total_seconds - report.chapter_minutes * 60)}）"
        )
    elif report.chapter_short:
        parts.append(f"比计划短 {format_time(report.shortfall_seconds)}")
    elif not report.content_limited:
        parts.append(f"✅ 在整章上限 {report.chapter_minutes:g} 分钟以内")
    return "；".join(parts)


__all__ = [
    "BUFFER_RATIO",
    "CHAPTER_TARGET_MINUTES",
    "CHARS_PER_MIN",
    "CN_SECTION_RE",
    "CONTENT_RATIO",
    "DEFAULT_SECTION_LEVEL",
    "FALLBACK_BLOCK_PAGES",
    "HEADING_LEAD_RE",
    "HEADING_SEP_RE",
    "HEADING_TAIL_RE",
    "LEGACY_SECTION_LEVEL",
    "MAX_PAGE_BUDGET",
    "MAX_PAUSES_PER_PAGE",
    "MAX_WEIGHT",
    "MIN_FILL_RATIO",
    "MIN_PAGE_BUDGET",
    "MIN_WEIGHT",
    "NON_CONTENT_KINDS",
    "OVERRUN_TOLERANCE",
    "PAGE_KIND_LABELS",
    "PAGE_KIND_MAX_CHARS",
    "PAUSE_MARK",
    "PAUSE_SECONDS",
    "PacingPage",
    "PacingReport",
    "PageTiming",
    "SCRIPT_STYLE_DEFAULT_PRESET",
    "SCRIPT_STYLE_MAX_CHARS",
    "SCRIPT_STYLE_PRESETS",
    "SECTION_LEVEL_KP",
    "SECTION_RE",
    "SECTION_TARGET_MINUTES",
    "SQUEEZE_RATIO",
    "SectionTiming",
    "THIN_PAGE_BUDGET",
    "TRANSITION_SECONDS",
    "UNLABELED_MINUTES",
    "UNLABELED_SECTION",
    "allocate_page_budgets",
    "assign_sections",
    "audit",
    "budget_for_pages",
    "build_style_hint",
    "char_budget_for_section",
    "classify_slide",
    "compute_section_budgets",
    "content_cap",
    "count_pauses",
    "count_spoken_chars",
    "detect_cn_headings",
    "detect_cn_section",
    "detect_section",
    "estimate_seconds",
    "fill_minutes",
    "format_pages",
    "format_time",
    "minutes_for_chars",
    "parse_cn_ordinal",
    "strip_pause_marks",
    "summarize_kinds_label",
    "summary_line",
    "valid_cn_heading",
    "valid_section",
]
