"""Prompt template loader, placeholder validator, and prompt assembly helpers."""

from __future__ import annotations

import hashlib
import string
from pathlib import Path

from .pacing import count_spoken_chars
from .text_utils import PAUSE_MARK

PROMPT_DIR = Path(__file__).resolve().parent / "prompt_files"


class PromptError(RuntimeError):
    """Prompt file is missing or its placeholders deviate from specification."""


_SPECS: dict[str, tuple[str, frozenset[str]]] = {
    "PROMPT_TOPIC": ("topic", frozenset({"text"})),
    "PROMPT_COHERENCE": ("coherence", frozenset({"prev_topic", "current_note", "next_topic"})),
    "PROMPT_NOTE_TO_SCRIPT": (
        "script",
        frozenset(
            {
                "section",
                "page",
                "page_in_section",
                "section_pages",
                "prev_tail",
                "note",
                "raw_text",
                "char_budget",
                "pause_mark",
                "max_pauses",
            }
        ),
    ),
    "PROMPT_SCRIPT_COMPRESS": ("script_compress", frozenset({"script", "char_budget", "pause_mark"})),
    "PROMPT_SCRIPT_EXPAND": (
        "script_expand",
        frozenset({"script", "note", "raw_text", "char_budget", "current_chars", "pause_mark"}),
    ),
    "PROMPT_EXERCISE_SYSTEM": ("exercise_system", frozenset()),
    "PROMPT_EXERCISE_USER": ("exercise_user", frozenset({"blocks", "knowledge", "notes"})),
    "EXERCISE_KNOWLEDGE_BLOCK": ("exercise_knowledge", frozenset({"points"})),
    "PROMPT_EXERCISE_EXPLANATION_SYSTEM": ("exercise_explanation_system", frozenset()),
    "PROMPT_EXERCISE_EXPLANATION_USER": ("exercise_explanation_user", frozenset({"questions", "notes"})),
    "PROMPT_EXERCISE_LINK_SYSTEM": ("exercise_link_system", frozenset()),
    "PROMPT_EXERCISE_LINK_USER": ("exercise_link_user", frozenset({"points", "questions"})),
    "PROMPT_CODING_EXERCISE_SYSTEM": ("coding_exercise_system", frozenset()),
    "PROMPT_CODING_EXERCISE_USER": (
        "coding_exercise_user",
        frozenset(
            {
                "chapter_label",
                "coding_type",
                "coding_type_label",
                "difficulty",
                "usage",
                "type_rules",
                "syntax_constraint",
                "knowledge",
                "avoid",
                "notes",
            }
        ),
    ),
    "PROMPT_CODING_BLIND_SOLVE_SYSTEM": ("coding_blind_solve_system", frozenset()),
    "PROMPT_CODING_BLIND_SOLVE_USER": (
        "coding_blind_solve_user",
        frozenset({"title", "prompt", "samples", "extra"}),
    ),
    "PROMPT_KNOWLEDGE_SYSTEM": ("knowledge_system", frozenset()),
    "PROMPT_KNOWLEDGE_USER": ("knowledge_user", frozenset({"outline", "notes"})),
}


def placeholders(template: str) -> set[str]:
    """Return placeholder field names referenced in a Python format template."""
    return {name.split(".")[0].split("[")[0] for _, name, _, _ in string.Formatter().parse(template) if name}


def load_prompt(name: str, required: frozenset[str] | set[str]) -> str:
    """Load one markdown prompt file and verify its placeholders."""
    path = PROMPT_DIR / f"{name}.md"
    try:
        text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    except OSError as exc:
        raise PromptError(f"读不到提示词 {path}：{exc}") from exc
    try:
        found = placeholders(text)
    except ValueError as exc:
        raise PromptError(f"提示词 {path.name} 的花括号不配对：{exc}") from exc
    missing, extra = set(required) - found, found - set(required)
    if missing or extra:
        detail = "；".join(
            filter(None, [f"缺少 {sorted(missing)}" if missing else "", f"多出 {sorted(extra)}" if extra else ""])
        )
        raise PromptError(f"提示词 {path.name} 的占位符与约定不符：{detail}")
    return text


def fingerprint(*texts: str) -> str:
    """Stable 12-hex content hash for prompt caching."""
    digest = hashlib.sha256()
    for text in texts:
        digest.update(text.encode("utf-8"))
        digest.update(b"\x00")
    return digest.hexdigest()[:12]


_TEXTS: dict[str, str] = {}
for _name, _fields in _SPECS.values():
    _TEXTS[_name] = load_prompt(_name, _fields)

VERSIONS: dict[str, str] = {name: fingerprint(text) for name, text in _TEXTS.items()}

PROMPT_TOPIC: str = _TEXTS["topic"]
PROMPT_COHERENCE: str = _TEXTS["coherence"]
PROMPT_NOTE_TO_SCRIPT: str = _TEXTS["script"]
PROMPT_SCRIPT_COMPRESS: str = _TEXTS["script_compress"]
PROMPT_SCRIPT_EXPAND: str = _TEXTS["script_expand"]
PROMPT_EXERCISE_SYSTEM: str = _TEXTS["exercise_system"]
PROMPT_EXERCISE_USER: str = _TEXTS["exercise_user"]
EXERCISE_KNOWLEDGE_BLOCK: str = _TEXTS["exercise_knowledge"]
PROMPT_EXERCISE_EXPLANATION_SYSTEM: str = _TEXTS["exercise_explanation_system"]
PROMPT_EXERCISE_EXPLANATION_USER: str = _TEXTS["exercise_explanation_user"]
PROMPT_EXERCISE_LINK_SYSTEM: str = _TEXTS["exercise_link_system"]
PROMPT_EXERCISE_LINK_USER: str = _TEXTS["exercise_link_user"]
PROMPT_CODING_EXERCISE_SYSTEM: str = _TEXTS["coding_exercise_system"]
PROMPT_CODING_EXERCISE_USER: str = _TEXTS["coding_exercise_user"]
PROMPT_CODING_BLIND_SOLVE_SYSTEM: str = _TEXTS["coding_blind_solve_system"]
PROMPT_CODING_BLIND_SOLVE_USER: str = _TEXTS["coding_blind_solve_user"]
PROMPT_KNOWLEDGE_SYSTEM: str = _TEXTS["knowledge_system"]
PROMPT_KNOWLEDGE_USER: str = _TEXTS["knowledge_user"]


def build_script_prompt(
    note: str,
    raw_text: str,
    section: str = "",
    page: int = 0,
    page_in_section: int = 1,
    section_pages: int = 1,
    prev_tail: str = "",
    char_budget: int = 0,
    max_pauses: int = 2,
    style_hint: str = "",
) -> str:
    """Build the paced oral-narration prompt."""
    raw = (raw_text or "").strip() or "（本页没有可用的文字层，请完全依据整理稿来写，不要补充之外的内容）"
    tail = (prev_tail or "").strip() or "（本页是这一节的第一页，没有上一页）"
    rendered = PROMPT_NOTE_TO_SCRIPT.format(
        section=section or "未编号",
        page=page,
        page_in_section=page_in_section,
        section_pages=section_pages,
        prev_tail=tail,
        note=(note or "").strip(),
        raw_text=raw,
        char_budget=char_budget,
        pause_mark=PAUSE_MARK,
        max_pauses=max_pauses,
    )
    hint = (style_hint or "").strip()
    if hint:
        block = f"【教师统一授课风格要求（在不违背忠于课件事实的前提下优先遵循）】\n{hint}\n\n"
        anchor = "只输出讲稿正文"
        if anchor in rendered:
            rendered = rendered.replace(anchor, block + anchor, 1)
        else:
            rendered = block + rendered
    return rendered


def build_expand_prompt(script: str, note: str, raw_text: str, char_budget: int) -> str:
    """Build script expansion prompt."""
    return PROMPT_SCRIPT_EXPAND.format(
        script=(script or "").strip(),
        note=(note or "").strip(),
        raw_text=(raw_text or "").strip() or "（本页没有可用的文字层）",
        char_budget=char_budget,
        current_chars=count_spoken_chars(script),
        pause_mark=PAUSE_MARK,
    )


def build_compress_prompt(script: str, char_budget: int) -> str:
    """Build script compression prompt."""
    return PROMPT_SCRIPT_COMPRESS.format(
        script=(script or "").strip(),
        char_budget=char_budget,
        pause_mark=PAUSE_MARK,
    )
