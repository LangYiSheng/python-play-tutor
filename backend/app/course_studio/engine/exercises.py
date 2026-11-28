"""Pure in-memory exercise generation, single-blank enforcement, and Xuexitong export."""

from __future__ import annotations

import ast
import concurrent.futures as futures
from difflib import SequenceMatcher
import math
import os
import re
import subprocess
import sys
import time
import uuid
from collections.abc import Sequence
from typing import Any

from . import knowledge as knowledge_mod
from . import llm as llm_mod
from . import pacing
from . import prompts
from .ooxml import build_xlsx
from .text_utils import extract_json_payload, format_page_ranges, squeeze_text

TYPE_ORDER = ("single", "multiple", "true_false", "fill_blank", "short_answer")
OBJECTIVE_TYPES = ("single", "multiple", "true_false", "fill_blank")
TYPE_LABELS: dict[str, str] = {
    "single": "单选题",
    "multiple": "多选题",
    "true_false": "判断题",
    "fill_blank": "填空题",
    "short_answer": "简答题",
}
_TYPE_ALIASES: dict[str, str] = {
    "single": "single",
    "single_choice": "single",
    "multiple": "multiple",
    "multiple_choice": "multiple",
    "true_false": "true_false",
    "judge": "true_false",
    "boolean": "true_false",
    "fill_blank": "fill_blank",
    "blank": "fill_blank",
    "fill": "fill_blank",
    "short_answer": "short_answer",
    "short": "short_answer",
}

_BLANK_MARKER_RE = re.compile(r"_{2,}|[（(]\s*[)）]|【\s*】")
MAX_PER_TYPE = 30
MAX_PER_POINT_TYPE = 20
QUOTA_BATCH_MAX_POINTS = 6
QUOTA_BATCH_MAX_QUESTIONS = 18
QUOTA_MAX_WORKERS = 4
MAX_CONTEXT_CHARS = 24000
MAX_LINKED_POINTS = 3
AVOID_PROMPT_LIMIT = 60
SAME_KIND_DUP_RATIO = 0.84
CROSS_KIND_DUP_RATIO = 0.90
_DEDUP_MIN_LEN = 10
_CROSS_KIND_MIN_LEN = 14
_CODE_TOKEN_RE = re.compile(
    r"//|\*\*|==|!=|<=|>=|\+=|-=|\*=|/=|\d+(?:\.\d+)?|[+\-*/%<>=#]|[a-zA-Z_][a-zA-Z0-9_]*"
)
_GENERIC_EN_TOKENS = frozenset({"python", "true", "false", "a", "b", "c", "d"})
_NEGATION_RE = re.compile(r"不包括|不属于|不正确|错误的是|不是|不能|不可以|不会|无需|不符合|不合法|不具有")

_PAGE_WORDS = re.compile(
    r"第\s*[0-9一二三四五六七八九十百]+\s*页|(?:讲义|课件|幻灯片)\s*[0-9一二三四五六七八九十百]+|本页|上一页|下一页|该页"
)
_VISUAL_REF_RE = re.compile(
    r"如图所示|如下图所示|如上图所示|见下图|见上图|见图|下图|上图|图中所示|根据图示|看图|此图|该图"
    r"|如表所示|见下表|见上表|见表|下表|上表|如下表|以下表格|上述表格|右侧图|左侧图"
)
_SNIPPET_REF_RE = re.compile(
    r"(?:执行|运行|阅读|分析|观察|根据|按照|给定|已知|对于)\s*(?:如下|以下|下面|上述|上面|这段|该段|某段)?(?:的)?(?:Python\s*)?(?:代码|程序|语句|指令序列|指令|代码段|代码片段|函数代码|算法步骤|伪代码)"
    r"|(?:如下|以下|下面|上述|上面)(?:的)?(?:Python\s*)?(?:代码段|代码片段|指令序列|程序片段|伪代码)"
)
_CONCRETE_SNIPPET_RE = re.compile(
    r"`[^`]{2,}`"
    r"|==|!=|<=|>=|\+=|-=|\*=|/=|->|→"
    r"|[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S"
    r"|[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)"
    r"|\[[^\]\n]{1,}\]"
    r"|\{[^\}\n]{1,}\}"
    r"|\b(?:def|for|while|if|elif|else|return|import|class|try|except|lambda|print|input|range|len|MOV|ADD|SUB|LOAD|STORE|PUSH|POP|JMP|CMP)\b"
    r"|①.*②"
)
_TRIVIAL_EXPLANATION_RE = re.compile(r"^(?:选?\s*[A-Da-d]+|正确|错误|对|错|略|无|如题(?:所述)?)[。.!！]?$")
_MONOLOGUE_EXPLANATION_RE = re.compile(
    r"我(?:选择|改|设置|仔细看|决定|重新|可以自由|来重新|将(?:题目|选项|答案))"
    r"|让我(?:重新|仔细|再)"
    r"|等等[，,：:。？?!！]"
    r"|重新计算|重新设计|算了[，,。！!]"
    r"|题目(?:有误|设计有误|无效)|需要(?:修正|修改)|说明题目"
    r"|选项中(?:没有|未提供)|选项未提供"
    r"|为了(?:有错误题|符合已写|符合选项|生成有效)"
    r"|改题目为|修改选项|保留原题|所以最终题目"
    r"|设置\s*answer|答案应为|实际上[，,]?正确答案应为"
    r"|改为\s*[a-dA-D](?:[^a-zA-Z0-9_]|$)"
    r"|答案\s*[a-dA-D]\s*[。，,；;]?\s*解析[：:]"
    r"|(?:但|而)材料(?:写|中|给)|材料中(?:例子|写)"
    r"|为什么[？?]\s*因为|但实际输出是[^。！？?\n]{0,20}[？?]"
)
_EXPLANATION_MD_BOLD_RE = re.compile(r"(?<![A-Za-z0-9_])\*\*(?!\s)([^*\n]{1,60}?)(?<!\s)\*\*(?![A-Za-z0-9_])")
_EXPLANATION_MD_HEADING_RE = re.compile(r"(?m)^[ \t]*#{1,4}[ \t]+")
_EXPLANATION_MD_FENCE_RE = re.compile(r"(?m)^[ \t]*`{3,}[A-Za-z0-9_-]*[ \t]*\n?")
_EXPLANATION_INLINE_CODE_RE = re.compile(r"`([^`\n]{1,80})`")
_CONCLUDE_TRUE_RE = re.compile(
    r"(?:因此|所以|故|综上)\s*(?:该说法|原说法|原题|本题|说法|表述|判断|结论|输出[^\s，。]{0,12})?(?<!不)(?<!非)(?<!未)正确$"
)
_CONCLUDE_FALSE_RE = re.compile(
    r"(?:因此|所以|故|综上)\s*(?:该说法|原说法|原题|本题|说法|表述|判断|结论|题目)?(?:是|为)?(?<!无)(?<!不)(?<!没有)(?<!非)错误$"
)
_FORBIDDEN_EVAL_CALLS = frozenset(
    {
        "input", "open", "eval", "exec", "compile", "__import__", "breakpoint",
        "help", "dir", "globals", "locals", "vars", "getattr", "setattr", "delattr",
        "id", "hash", "memoryview",
    }
)
_ERROR_QUESTION_RE = re.compile(r"报错|异常|错误类型|语法错误|无法运行|出错|抛出|Error|Exception")
_OUTPUT_QUESTION_RE = re.compile(r"输出结果|运行结果|打印结果|显示结果|输出(?:为|是)|的值(?:为|是|等于)|计算结果(?:为|是|等于)")
_TRUE_FALSE_CLAIM_RE = re.compile(
    r"(?:输出结果|运行结果|打印结果|显示结果|的值|的结果)\s*(?<!不)(?:是|为|等于)\s*([^\s，,。？?\n]+(?:\s+[^\s，,。？?\n]+){0,3}?)\s*[。？?]?$"
)
_EXPR_STATEMENT_RE = re.compile(
    r"表达式\s*`?([A-Za-z0-9_+\-*/%()\[\]{}'\".,:<>=!~&|^\s]{2,80}?)`?\s*的(?:计算结果|结果|值|返回值|输出)"
)
_INLINE_ASSIGN_RE = re.compile(
    r"(?:已知|设|若|当)?(?:整数|浮点数|字符串|列表|变量|元组|字典|集合)?\s*([A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:'[^']*'|\"[^\"]*\"|\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|-?\d+(?:\.\d+)?|True|False|None))"
)
_PROSE_OPTION_RE = re.compile(r"[\u4e00-\u9fff]{5,}")
_MAX_SNIPPET_VERIFY_SECONDS = 0.8
_TEMPLATE_LITERAL_RE = re.compile(
    r"`[^`]*`|'[^']*'|\"[^\"]*\"|<[^>]+>|\b-?\d+(?:\.\d+)?\b|[A-Za-z_][A-Za-z0-9_]*\([^)]*\)"
)
_GENERIC_TITLE_RE = re.compile(
    r"^(?:在\s*Python\s*中[，,]?\s*)?(?:执行|运行|阅读|分析)(?:以下|下面|如下)(?:的)?(?:Python\s*)?(?:代码|程序|语句)"
)
DIFFICULTY_PROFILES: dict[str, str] = {
    "balanced": (
        "难度定位：均衡进阶。以中等难度为主（约 20% 易、55% 中、25% 难）；避免只出照抄定义原文的送分题，"
        "同时避免扎堆出同一种‘执行以下代码后输出是…’的模板题，应在概念辨析、报错诊断、写法对比、场景应用、边界条件与代码追踪间均匀分布。"
    ),
    "foundational": (
        "难度定位：基础巩固。以易/中为主（约 50% 易、40% 中、10% 难），在核心概念、语法规则、场景用法、常见报错与简单短代码间均衡命题，确保题意清晰多样。"
    ),
    "challenging": (
        "难度定位：综合拔高。以中/难为主（约 10% 易、45% 中、45% 难），在边界陷阱、可变对象/作用域辨析、异常原因定位、等价写法对比与多步代码追踪间多样化命题。"
    ),
}
_EXPLANATION_META_RE = re.compile(
    r"(?:根据|按照|依据|结合|如|由)?"
    r"(?:【?\s*(?:讲义|课件|幻灯片|教材)\s*第?\s*\d+\s*[页】]?\s*(?:内容)?(?:指出|提到|所述|可知|说明|显示|介绍|记载|写到|中指出|中提到)"
    r"|(?:讲义|课件|幻灯片)\s*(?:内容)?(?:指出|提到|所述|可知|说明|显示|中指出|中提到)"
    r"|(?:根据|如)(?:讲义|课件|幻灯片)(?:第?\s*\d+\s*页?)?(?:内容)?"
    r"|第\s*[0-9一二三四五六七八九十百]+\s*页(?:讲义|课件|幻灯片)?(?:内容)?(?:指出|提到|所述|可知|说明|显示))[，,：:\s]*"
)
_JUDGE_OPTIONS = {"a": "正确", "b": "错误"}
_TRUE_WORDS = {"正确", "对", "true", "t", "√", "是"}
_FALSE_WORDS = {"错误", "错", "false", "f", "×", "否"}

EXPORT_COLUMNS = ("题型", "题干", "选项A", "选项B", "选项C", "选项D", "正确答案", "答案解析", "知识点", "页码")
_EXPORT_WIDTHS = (10, 60, 24, 24, 24, 24, 10, 50, 24, 10)
XUEXITONG_COLUMNS = (
    "目录", "题目类型", "自定义题型", "大题题干", "小题题型", "小题题干",
    "正确答案", "答案解析", "难易度", "知识点", "标签", "选项数",
    "选项A", "选项B", "选项C", "选项D", "选项E", "选项F", "选项G", "选项H",
)
XUEXITONG_WIDTHS = (24, 10, 12, 56, 10, 14, 12, 48, 8, 24, 16, 8, 22, 22, 22, 22, 16, 16, 16, 16)
_DIFFICULTY_MAP = {"易": "易", "容易": "易", "简单": "易", "中": "中", "中等": "中", "一般": "中", "难": "难", "困难": "难", "较难": "难"}


def canonical_type(kind: str) -> str:
    """Map alias question types to canonical internal type keys."""
    return _TYPE_ALIASES.get(str(kind or "").strip().lower(), str(kind or "").strip().lower())


def stem_key(stem: str) -> str:
    """Normalized deduplication key for question stems."""
    return squeeze_text(stem)


def _code_signature(stem: str) -> frozenset[str]:
    stripped = _BLANK_MARKER_RE.sub(" ", stem or "")
    tokens = {
        tok.lower()
        for tok in _CODE_TOKEN_RE.findall(stripped)
        if tok.lower() not in _GENERIC_EN_TOKENS
    }
    return frozenset(tokens)


def _has_negation(stem: str) -> bool:
    return bool(_NEGATION_RE.search(stem or ""))


def _dedup_text(stem: str) -> str:
    return squeeze_text(_BLANK_MARKER_RE.sub("", stem or ""))


def is_near_duplicate_stem(
    candidate_stem: str,
    existing_stem: str,
    *,
    same_kind: bool = True,
) -> bool:
    """Detect exact or near-duplicate stems while protecting distinct code expressions and polarity."""
    k1 = stem_key(candidate_stem)
    k2 = stem_key(existing_stem)
    if not k1 or not k2:
        return False
    if k1 == k2:
        return True

    d1 = _dedup_text(candidate_stem)
    d2 = _dedup_text(existing_stem)
    if not d1 or not d2:
        return False
    if d1 == d2:
        return True

    min_len = _DEDUP_MIN_LEN if same_kind else _CROSS_KIND_MIN_LEN
    if min(len(d1), len(d2)) < min_len:
        return False

    # Never collapse opposite-polarity questions (e.g., "特点包括" vs "特点不包括").
    if _has_negation(candidate_stem) != _has_negation(existing_stem):
        return False

    # Never collapse questions that test different numbers, operators, or code identifiers (e.g. "7 // 2" vs "7 % 2").
    sig1, sig2 = _code_signature(candidate_stem), _code_signature(existing_stem)
    if (sig1 or sig2) and sig1 != sig2:
        return False

    threshold = SAME_KIND_DUP_RATIO if same_kind else CROSS_KIND_DUP_RATIO
    max_len = max(len(d1), len(d2))
    if min(len(d1), len(d2)) / max_len < threshold:
        return False
    return SequenceMatcher(None, d1, d2).ratio() >= threshold


def _is_duplicate_in_pool(
    stem: str,
    kind: str,
    pool: Sequence[tuple[str, str]],
) -> bool:
    canon = canonical_type(kind)
    for existing_stem, existing_kind in pool:
        same_kind = bool(canon and existing_kind and canon == canonical_type(existing_kind)) or not existing_kind
        if is_near_duplicate_stem(stem, existing_stem, same_kind=same_kind):
            return True
    return False


def _select_avoid_stems(
    entries: Sequence[dict[str, Any]],
    *,
    kind: str,
    batch_points: Sequence[str] = (),
    limit: int = AVOID_PROMPT_LIMIT,
) -> list[str]:
    """Prioritize current-batch KPs, same kind, and newest stems for the prompt avoid list."""
    canon = canonical_type(kind)
    target_keys = {stem_key(p) for p in batch_points if stem_key(p)}
    buckets: tuple[list[str], list[str], list[str], list[str]] = ([], [], [], [])
    for entry in reversed(entries):
        stem = str(entry.get("stem") or "").strip()
        if not stem:
            continue
        e_kind = canonical_type(str(entry.get("kind") or ""))
        e_points = {stem_key(str(p)) for p in (entry.get("points") or []) if stem_key(str(p))}
        hit_kp = bool(target_keys and (e_points & target_keys))
        hit_kind = bool(canon and e_kind == canon)
        if hit_kp and hit_kind:
            buckets[0].append(stem)
        elif hit_kp:
            buckets[1].append(stem)
        elif hit_kind:
            buckets[2].append(stem)
        else:
            buckets[3].append(stem)
    out: list[str] = []
    seen_keys: set[str] = set()
    for bucket in buckets:
        for stem in bucket:
            k = stem_key(stem)
            if not k or k in seen_keys:
                continue
            seen_keys.add(k)
            out.append(stem)
            if len(out) >= limit:
                return out
    return out


def clean_explanation(text: Any) -> str:
    """Remove internal slide/page references and stray Markdown syntax from student-facing explanations."""
    raw = str(text or "").replace("\r\n", "\n").strip()
    if not raw:
        return ""
    cleaned = _EXPLANATION_META_RE.sub("", raw)
    cleaned = _EXPLANATION_MD_FENCE_RE.sub("", cleaned)
    cleaned = _EXPLANATION_MD_HEADING_RE.sub("", cleaned)
    cleaned = _EXPLANATION_MD_BOLD_RE.sub(r"\1", cleaned)
    cleaned = _EXPLANATION_INLINE_CODE_RE.sub(r"\1", cleaned)
    cleaned = re.sub(r"^[，,。；;：:\s]+", "", cleaned)
    cleaned = re.sub(r"([，,；;。！？!?])[，,；;：:]+", r"\1", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _stem_has_concrete_snippet(stem: str) -> bool:
    """Return True if a stem that references code/instructions actually embeds them."""
    if _CONCRETE_SNIPPET_RE.search(stem):
        return True
    lines = [line.strip() for line in stem.splitlines() if line.strip()]
    if len(lines) >= 2:
        return True
    if re.search(r"(?:1|①)\s*[.、:：)].*(?:2|②)\s*[.、:：)]", stem):
        return True
    return False


def check_stem_self_contained(stem: str) -> str | None:
    """Detect stems that depend on missing diagrams, tables, code, or instruction sequences."""
    text = (stem or "").strip()
    if not text:
        return "题干为空"
    if _VISUAL_REF_RE.search(text):
        return "题干引用了未附带的图表"
    if _SNIPPET_REF_RE.search(text) and not _stem_has_concrete_snippet(text):
        return "题干引用了代码或指令序列但未给出完整内容"
    return None


def check_explanation_clean(
    explanation: str,
    *,
    canon_type: str = "",
    answer: Any = None,
) -> str | None:
    """Reject explanations that leak LLM scratchpad self-talk or contradict the marked answer."""
    text = (explanation or "").strip()
    if not text:
        return None
    if _TRIVIAL_EXPLANATION_RE.match(text):
        return "答案解析过于简略"
    if _MONOLOGUE_EXPLANATION_RE.search(text):
        return "答案解析包含模型草稿或改题自言自语"
    if len(re.findall(r"[？?]", text)) >= 3:
        return "答案解析包含过多反问自辩，不像面向学生的正式解析"
    if canon_type == "true_false" and answer in {"a", "b"}:
        main_body = re.split(r"\n+\s*(?:易错提醒|常见误区|注意(?:事项)?)[：:]", text, maxsplit=1)[0].strip() or text
        parts = [seg.strip() for seg in re.split(r"[。！？!?\n]+", main_body) if seg.strip()]
        tail = parts[-1] if parts else ""
        if answer == "b" and _CONCLUDE_TRUE_RE.search(tail):
            return "判断题答案与解析结论自相矛盾"
        if answer == "a" and _CONCLUDE_FALSE_RE.search(tail):
            return "判断题答案与解析结论自相矛盾"
    return None


def _is_safe_pure_python(code: str) -> tuple[bool, bool]:
    """Validate pure deterministic Python via AST. Returns (is_safe, has_print)."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return False, False
    if not tree.body:
        return False, False
    has_print = False
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            return False, False
        if isinstance(node, ast.Call):
            fn = node.func
            if isinstance(fn, ast.Name):
                if fn.id in _FORBIDDEN_EVAL_CALLS:
                    return False, False
                if fn.id == "print":
                    has_print = True
            elif isinstance(fn, ast.Attribute) and fn.attr.startswith("__"):
                return False, False
    return True, has_print


def _extract_verifiable_python(stem: str) -> str | None:
    """Extract a self-contained pure Python snippet or expression evaluation script from a stem."""
    if not stem or _ERROR_QUESTION_RE.search(stem) or "random" in stem.lower():
        return None
    if not _OUTPUT_QUESTION_RE.search(stem):
        return None

    # 1. Explicit fenced python block
    fenced = re.search(r"```(?:python|py)?\s*\n(.*?)```", stem, re.S | re.I)
    if fenced:
        candidate = fenced.group(1).strip()
        safe, has_print = _is_safe_pure_python(candidate)
        if safe and has_print:
            return candidate

    # 2. Multi-line stem containing embedded Python lines after the leading prompt sentence
    lines = [line.rstrip() for line in stem.splitlines()]
    if len(lines) >= 2:
        for start in range(1, len(lines)):
            tail = "\n".join(lines[start:]).strip()
            if not tail:
                continue
            safe, has_print = _is_safe_pure_python(tail)
            if safe and has_print:
                return tail
            # Also try stopping before a trailing Chinese question line
            for end in range(len(lines) - 1, start, -1):
                mid = "\n".join(lines[start:end]).strip()
                if not mid:
                    continue
                safe, has_print = _is_safe_pure_python(mid)
                if safe and has_print:
                    return mid

    # 3. Single-line expression evaluation like "已知整数 x = 2025，表达式 x // 100 % 10 的值为 0。"
    expr_m = _EXPR_STATEMENT_RE.search(stem)
    if expr_m:
        expr = expr_m.group(1).strip()
        if expr and not re.search(r"[\u4e00-\u9fff]", expr):
            prefix = stem[: expr_m.start()]
            assigns = [m.group(1).strip() for m in _INLINE_ASSIGN_RE.finditer(prefix)]
            script = "\n".join([*assigns, f"print({expr})"])
            safe, has_print = _is_safe_pure_python(script)
            if safe and has_print:
                return script
    return None


def _run_pure_python(code: str) -> tuple[bool, str]:
    """Run AST-verified pure Python in an isolated short-lived subprocess."""
    env = {
        "PATH": os.environ.get("PATH", ""),
        "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONNOUSERSITE": "1",
    }
    try:
        proc = subprocess.run(
            [sys.executable, "-I", "-B", "-c", code],
            input="",
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_MAX_SNIPPET_VERIFY_SECONDS,
            env=env,
        )
    except (subprocess.TimeoutExpired, OSError):
        return False, ""
    if proc.returncode != 0:
        return False, ""
    return True, proc.stdout.replace("\r\n", "\n").strip()


def _normalize_output_token(text: str) -> str:
    s = (text or "").strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in {"'", '"', "`"}:
        s = s[1:-1]
    return s.strip()


def _outputs_equivalent(actual: str, candidate: str) -> bool:
    a = _normalize_output_token(actual)
    b = _normalize_output_token(candidate)
    if a == b:
        return True
    try:
        if float(a) == float(b) and ("." in a) == ("." in b):
            return True
    except ValueError:
        pass
    return False


def is_generic_code_lead(line: str) -> bool:
    """Return True if a stem's first line is a generic code-output boilerplate lead-in."""
    return bool(_GENERIC_TITLE_RE.match((line or "").strip()))


def opening_template_key(stem: str) -> str:
    """Normalize line 1 into a structural opening skeleton to detect repetitive templates."""
    first = next((line.strip() for line in (stem or "").splitlines() if line.strip()), "")
    if not first:
        return ""
    skeleton = _TEMPLATE_LITERAL_RE.sub("", first)
    key = squeeze_text(skeleton)
    return key if len(key) >= 8 else ""


def prune_monotonous_questions(
    questions: Sequence[dict[str, Any]],
    *,
    target_count: int,
    template_counts: dict[str, int] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split batch into template-diverse questions and excess monotonous clones."""
    if target_count < 4:
        return list(questions), []
    cap = max(2, math.ceil(target_count / 3))
    counts = dict(template_counts or {})
    kept: list[dict[str, Any]] = []
    overflow: list[dict[str, Any]] = []
    for q in questions:
        tpl = opening_template_key(str(q.get("question") or ""))
        if tpl and counts.get(tpl, 0) >= cap:
            overflow.append(q)
            continue
        if tpl:
            counts[tpl] = counts.get(tpl, 0) + 1
        kept.append(q)
    return kept, overflow


def verify_python_objective_question(
    stem: str,
    canon_type: str,
    options: dict[str, str],
    answer: Any,
) -> str | None:
    """Verify pure Python code/expression objective questions by executing the snippet."""
    if canon_type not in {"single", "true_false", "fill_blank"}:
        return None
    code = _extract_verifiable_python(stem)
    if not code:
        return None
    ok, actual = _run_pure_python(code)
    if not ok or not actual or "\n" in actual:
        return None

    if canon_type == "single":
        marked = str(options.get(str(answer or "").strip().lower(), "")).strip()
        if not marked or _PROSE_OPTION_RE.search(marked):
            return None
        if _outputs_equivalent(actual, marked):
            return None
        # Only reject when options are concrete output values (not prose) and marked answer disagrees.
        if all(not _PROSE_OPTION_RE.search(v) for v in options.values()):
            return f"代码实际运行结果为 {actual!r}，与标注答案 {marked!r} 不一致"
        return None

    if canon_type == "true_false":
        lead = stem.splitlines()[0].strip()
        if re.search(r"不是|不为|不等于|不会输出|不能输出", lead):
            return None
        m = _TRUE_FALSE_CLAIM_RE.search(lead)
        if not m:
            return None
        claimed = m.group(1).strip()
        if not claimed or _PROSE_OPTION_RE.search(claimed):
            return None
        is_actually_true = _outputs_equivalent(actual, claimed)
        expected_letter = "a" if is_actually_true else "b"
        if str(answer) != expected_letter:
            return f"代码实际运行结果为 {actual!r}，与判断题标注答案不一致"
        return None

    if canon_type == "fill_blank":
        ans_items = answer if isinstance(answer, list) else [answer]
        if ans_items and all(not _PROSE_OPTION_RE.search(str(a)) for a in ans_items):
            if not any(_outputs_equivalent(actual, str(a)) for a in ans_items):
                return f"代码实际运行结果为 {actual!r}，与填空题标注答案不一致"
    return None


def is_single_blank_fill(stem: str, answer: Any, *, allow_synonym_list: bool = False) -> bool:
    """Verify a fill-in-the-blank question has exactly ONE blank and a valid single-blank answer."""
    markers = _BLANK_MARKER_RE.findall(stem or "")
    if len(markers) != 1:
        return False
    if isinstance(answer, (list, tuple)):
        items = [str(x).strip() for x in answer if str(x).strip()]
        if not items:
            return False
        if not allow_synonym_list and len(items) > 1:
            return False
        return all(len([s for s in re.split(r"[;；\n]+", item) if s.strip()]) == 1 for item in items)
    text = str(answer or "").strip()
    if not text:
        return False
    parts = [s.strip() for s in re.split(r"[;；\n]+", text) if s.strip()]
    return len(parts) == 1


def filter_content_pages(pages: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Skip obvious cover/toc/ending slides when sufficient content pages exist."""
    non_empty = [p for p in pages if str(p.get("text") or "").strip()]
    if len(non_empty) <= 2:
        return non_empty
    total_pages = max((int(p.get("page_no") or p.get("index") or 0) for p in non_empty), default=len(non_empty))
    filtered = [
        p
        for p in non_empty
        if pacing.classify_slide(
            int(p.get("page_no") or p.get("index") or 0),
            total_pages,
            str(p.get("raw_text") or p.get("text") or ""),
            str(p.get("text") or ""),
        )
        not in pacing.NON_CONTENT_KINDS
    ]
    return filtered if len(filtered) >= 2 else non_empty


def build_context(pages: Sequence[dict[str, Any]], max_chars: int = MAX_CONTEXT_CHARS, *, skip_filter: bool = False) -> str:
    """Format page list into bounded context blocks."""
    usable = [p for p in pages if str(p.get("text") or "").strip()] if skip_filter else filter_content_pages(pages)
    texts = [(int(p.get("page_no") or p.get("index") or 0), str(p.get("text") or "").strip()) for p in usable]
    texts = [(idx, t) for idx, t in texts if idx > 0 and t]
    total = sum(len(t) for _, t in texts)
    ratio = 1.0 if total <= max_chars else max_chars / total
    parts: list[str] = []
    for index, text in texts:
        if ratio < 1.0:
            text = text[: max(80, int(len(text) * ratio))]
        parts.append(f"【材料 {index}】（page_number = {index}）\n{text}")
    return "\n\n".join(parts)


def build_blocks(kind: str, count: int, avoid: Sequence[str] = (), *, difficulty: str = "balanced") -> str:
    """Build generation requirements block for a question type."""
    canon = canonical_type(kind)
    prompt_kind = {"true_false": "judge", "fill_blank": "blank", "short_answer": "short"}.get(canon, canon)
    lines = [
        f'题型：{TYPE_LABELS[canon]}（type 填 "{prompt_kind}"），共 {count} 道。',
        "题目要分散在不同的知识点上，不要集中在同一页。",
        "page_number 填题目依据的那一块材料的编号（只填数字）。",
        DIFFICULTY_PROFILES.get(difficulty, DIFFICULTY_PROFILES["balanced"]),
        "提问方式必须多样化：同一批题目应在概念辨析、报错诊断、写法对比、场景选型、边界特例与代码追踪间轮换，严禁多道题重复使用“在Python中，执行以下代码后，输出结果是……”同一模板（此类代码输出题最多占本批三分之一）。",
        "题干必须 100% 自包含：若考查代码执行、指令序列或计算过程，必须把完整代码/指令序列直接写进题干，严禁出现未附内容的“上述指令/以下代码/如图”等引用。",
    ]
    if canon == "multiple":
        lines.append("多选题的正确选项至少两个，answer 用数组。")
    elif canon == "true_false":
        lines.append('判断题的 options 固定为 {"a": "正确", "b": "错误"}，正确与错误的题各占一半左右。')
    elif canon == "fill_blank":
        lines.append("填空题每题只允许有且仅有 1 个空位（用 ____ 标出），严禁多空；options 填 {}，answer 填单个唯一标准答案字符串。")
    elif canon == "short_answer":
        lines.append("简答题的 options 填 {}，answer 写分点清晰的参考答案（含采分要点，不少于 25 字），explanation 写评分标准或考点提示。")
    if avoid:
        lines.append("下面这些题已经有了，不要出重复、只改措辞或换题型考同一句话的题：")
        lines.extend(f"- {q}" for q in avoid[:AVOID_PROMPT_LIMIT])
    return "\n".join(lines)


def build_quota_blocks(
    kind: str,
    batch_items: Sequence[tuple[dict[str, Any], int]],
    avoid: Sequence[str] = (),
    *,
    difficulty: str = "balanced",
) -> str:
    """Build knowledge-point quota generation block."""
    canon = canonical_type(kind)
    prompt_kind = {"true_false": "judge", "fill_blank": "blank", "short_answer": "short"}.get(canon, canon)
    batch_total = sum(int(n) for _, n in batch_items)
    label = TYPE_LABELS[canon]
    lines = [
        f'题型：{label}（type 填 "{prompt_kind}"），共 {batch_total} 道。',
        "page_number 填题目依据的那一块材料的编号（只填数字）。",
        DIFFICULTY_PROFILES.get(difficulty, DIFFICULTY_PROFILES["balanced"]),
        "提问方式必须多样化：同一批题目应在概念辨析、报错诊断、写法对比、场景选型、边界特例与代码追踪间轮换，严禁多道题重复使用“在Python中，执行以下代码后，输出结果是……”同一模板（此类代码输出题最多占本批三分之一）。",
        "题干必须 100% 自包含：若考查代码执行、指令序列或计算过程，必须把完整代码/指令序列直接写进题干，严禁出现未附内容的“上述指令/以下代码/如图”等引用。",
    ]
    if canon == "multiple":
        lines.append("多选题的正确选项至少两个，answer 用数组。")
    elif canon == "true_false":
        lines.append('判断题的 options 固定为 {"a": "正确", "b": "错误"}，正确与错误的题各占一半左右。')
    elif canon == "fill_blank":
        lines.append("填空题每题只允许有且仅有 1 个空位（用 ____ 标出），严禁多空；options 填 {}，answer 填单个唯一标准答案字符串。")
    elif canon == "short_answer":
        lines.append("简答题的 options 填 {}，answer 写分点清晰的参考答案（含采分要点，不少于 25 字）。")
    lines.append("请严格按照以下每个知识点的指定题量命题（knowledge_points 数组必须包含对应知识点原名，page_number 填对应编号）：")
    for kp, n in batch_items:
        pages_str = "、".join(str(p) for p in (kp.get("pages") or []))
        lines.append(f"- 知识点「{kp['title']}」（对应页码：{pages_str}）：必须出 {n} 道{label}")
    lines.append(f"本批合计共 {batch_total} 道{label}，各知识点题量必须严格对齐。")
    if avoid:
        lines.append("下面这些题已经有了，不要出重复、只改措辞或换题型考同一句话的题：")
        lines.extend(f"- {q}" for q in avoid[:AVOID_PROMPT_LIMIT])
    return "\n".join(lines)


def _letters(raw: Any) -> list[str]:
    items = [str(x) for x in raw] if isinstance(raw, (list, tuple)) else re.findall(r"[A-Ha-h]", str(raw or ""))
    out: list[str] = []
    for item in items:
        letter = item.strip().lower()[:1]
        if letter in "abcdefgh" and letter and letter not in out:
            out.append(letter)
    return sorted(out)


def normalize_question(
    raw: Any,
    kind: str,
    valid_pages: set[int],
    *,
    single_blank_only: bool = True,
) -> tuple[dict[str, Any] | None, str]:
    """Validate and normalize one model-generated question."""
    if not isinstance(raw, dict):
        return None, "不是对象"
    canon = canonical_type(kind)
    stem = str(raw.get("question") or "").strip()
    if len(stem) < 4:
        return None, "题干为空"
    if _PAGE_WORDS.search(stem):
        return None, "题干提到了页码"
    stem_issue = check_stem_self_contained(stem)
    if stem_issue:
        return None, stem_issue

    options_raw = raw.get("options") if isinstance(raw.get("options"), dict) else {}
    options = {str(k).strip().lower()[:1]: str(v).strip() for k, v in options_raw.items() if str(v).strip()}
    answer: Any

    if canon == "true_false":
        answer_raw = raw.get("answer")
        word = str(answer_raw[0] if isinstance(answer_raw, list) and answer_raw else answer_raw or "").strip().lower()
        if word in _TRUE_WORDS:
            answer = "a"
        elif word in _FALSE_WORDS:
            answer = "b"
        elif word[:1] in ("a", "b"):
            text = options.get(word[:1], _JUDGE_OPTIONS[word[:1]])
            answer = "b" if text in _FALSE_WORDS else "a"
        else:
            return None, "判断题答案看不懂"
        options = dict(_JUDGE_OPTIONS)
    elif canon == "fill_blank":
        if not _BLANK_MARKER_RE.search(stem):
            return None, "填空题题干缺少空位"
        answer_raw = raw.get("answer")
        if single_blank_only:
            if not is_single_blank_fill(stem, answer_raw):
                return None, "填空题必须仅含单个空位且为单个标准答案"
            if isinstance(answer_raw, (list, tuple)):
                answer = [str(answer_raw[0]).strip()]
            else:
                answer = [str(answer_raw).strip()]
        else:
            if isinstance(answer_raw, (list, tuple)):
                blanks = [str(x).strip() for x in answer_raw if str(x).strip()]
            else:
                blanks = [s.strip() for s in re.split(r"[;；\n]+", str(answer_raw or "")) if s.strip()]
            if not blanks:
                return None, "填空题答案为空"
            answer = blanks[:8]
        options = {}
    elif canon == "short_answer":
        answer_raw = raw.get("answer")
        ans_text = (
            "\n".join(str(x).strip() for x in answer_raw if str(x).strip())
            if isinstance(answer_raw, (list, tuple))
            else str(answer_raw or "").strip()
        )
        if len(ans_text) < 8:
            return None, "简答题参考答案过短"
        answer = ans_text
        options = {}
    else:
        options = {k: options[k] for k in "abcd" if k in options}
        if len(options) != 4:
            return None, "选项不是四个"
        if len({squeeze_text(v) for v in options.values()}) != 4:
            return None, "选项有重复"
        letters = _letters(raw.get("answer"))
        if canon == "single":
            if len(letters) != 1:
                return None, "单选题答案不是一个"
            answer = letters[0]
        else:
            if len(letters) < 2:
                return None, "多选题答案少于两个"
            answer = letters

    match = re.search(r"\d+", str(raw.get("page_number") or ""))
    page = int(match.group()) if match else 0
    if page not in valid_pages:
        page = 0

    points = raw.get("knowledge_points")
    if isinstance(points, str):
        points = re.split(r"[、,，;；]", points)
    norm_points = [str(p).strip() for p in (points or []) if str(p).strip()][:6]

    explanation = clean_explanation(raw.get("explanation"))
    exp_issue = check_explanation_clean(explanation, canon_type=canon, answer=answer)
    if exp_issue:
        return None, exp_issue
    py_issue = verify_python_objective_question(stem, canon, options, answer)
    if py_issue:
        return None, py_issue
    raw_diff = str(raw.get("difficulty") or "").strip()
    norm_diff = _DIFFICULTY_MAP.get(raw_diff, raw_diff if raw_diff in ("易", "中", "难") else "")
    raw_title = str(raw.get("title") or "").strip()
    clean_title = (
        raw_title[:80]
        if 4 <= len(raw_title) <= 80 and not _PAGE_WORDS.search(raw_title) and not is_generic_code_lead(raw_title)
        else ""
    )

    out_item: dict[str, Any] = {
        "type": canon,
        "question": stem,
        "options": options,
        "answer": answer,
        "explanation": explanation,
        "difficulty": norm_diff,
        "knowledge_points": norm_points,
        "page": page,
    }
    if clean_title:
        out_item["title"] = clean_title
    return out_item, ""


def parse_questions(
    text: str | Any,
    kind: str,
    valid_pages: set[int],
    *,
    single_blank_only: bool = True,
) -> tuple[list[dict[str, Any]], str, list[str]]:
    """Parse model JSON payload into validated question dicts."""
    data = extract_json_payload(text) if isinstance(text, str) else text
    if isinstance(data, list):
        data = {"questions": data}
    if not isinstance(data, dict) or not isinstance(data.get("questions"), list):
        raise ValueError("JSON 里没有 questions 列表")
    good: list[dict[str, Any]] = []
    rejected: list[str] = []
    for raw in data["questions"]:
        q, reason = normalize_question(raw, kind, valid_pages, single_blank_only=single_blank_only)
        if q:
            good.append(q)
        else:
            rejected.append(reason)
    return good, str(data.get("summary") or "").strip(), rejected


def point_catalog(knowledge: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Flatten sections/points structure into [{section, title, pages}, ...]."""
    if not knowledge or knowledge.get("source") == "auto":
        return []
    out: list[dict[str, Any]] = []
    for s in knowledge.get("sections") or []:
        head = " ".join(x for x in (s.get("number"), s.get("title")) if x) or knowledge_mod.WHOLE_CHAPTER
        for p in s.get("points") or []:
            title = str(p.get("title") or "").strip()
            if title:
                out.append({"section": head, "title": title, "pages": list(p.get("pages") or [])})
    return out


def build_point_list(catalog: Sequence[dict[str, Any]]) -> str:
    """Format point catalog lines for exercise prompts."""
    lines: list[str] = []
    current = None
    for p in catalog:
        if p["section"] != current:
            current = p["section"]
            lines.append(f"- {current}")
        pg = format_page_ranges(p.get("pages") or [], sep="、", dash="–")
        pages = f"（第 {pg} 页）" if pg else ""
        lines.append(f"  - {p['title']}{pages}")
    return "\n".join(lines)


def knowledge_block(catalog: Sequence[dict[str, Any]]) -> str:
    """Render knowledge-point restriction prompt block."""
    if not catalog:
        return ""
    return prompts.EXERCISE_KNOWLEDGE_BLOCK.format(points=build_point_list(catalog)).rstrip("\n") + "\n"


def pick_points(names: Any, catalog: Sequence[dict[str, Any]], limit: int = MAX_LINKED_POINTS) -> list[str]:
    """Keep only point names matching catalog titles."""
    if isinstance(names, str):
        names = re.split(r"[、,，;；]", names)
    by_key: dict[str, str] = {}
    for p in catalog:
        by_key.setdefault(stem_key(p["title"]), p["title"])
    out: list[str] = []
    for name in names if isinstance(names, (list, tuple)) else []:
        title = by_key.get(stem_key(str(name)))
        if title and title not in out:
            out.append(title)
    return out[:limit]


def link_by_pages(page: int, catalog: Sequence[dict[str, Any]], limit: int = MAX_LINKED_POINTS) -> list[str]:
    """Fallback point matching by source page number."""
    if not page:
        return []
    hits = sorted((len(p["pages"]), i) for i, p in enumerate(catalog) if page in p["pages"])
    seen: list[str] = []
    for _, i in hits:
        title = catalog[i]["title"]
        if title not in seen:
            seen.append(title)
        if len(seen) >= limit:
            break
    return seen


def resolve_points(names: Any, page: int, catalog: Sequence[dict[str, Any]], limit: int = MAX_LINKED_POINTS) -> list[dict[str, Any]]:
    """Resolve question point names against catalog points."""
    if isinstance(names, str):
        names = re.split(r"[、,，;；]", names)
    names_list = [str(n) for n in names] if isinstance(names, (list, tuple)) else []
    keyed = [(stem_key(p["title"]), p) for p in catalog]
    out: list[dict[str, Any]] = []
    for name in names_list:
        key = stem_key(name)
        if not key:
            continue
        hit = next((p for k, p in keyed if k == key), None)
        if hit is not None and all(hit is not p for p in out):
            out.append(hit)
    if not out:
        by_title = {p["title"]: p for p in catalog}
        out = [by_title[t] for t in link_by_pages(page, catalog, limit) if t in by_title]
    return [{"section": p["section"], "title": p["title"], "pages": list(p["pages"])} for p in out[:limit]]


def with_graph_points(questions: Sequence[dict[str, Any]], catalog: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Attach resolved graph_points to each question dict."""
    if not catalog:
        return list(questions)
    out: list[dict[str, Any]] = []
    for q in questions:
        try:
            page = int(q.get("page") or 0)
        except (TypeError, ValueError):
            page = 0
        out.append({**q, "graph_points": resolve_points(q.get("knowledge_points") or [], page, catalog)})
    return out


def _generate_kind(
    llm: llm_mod.LLMClient,
    model: str | None,
    context: str,
    kind: str,
    count: int,
    valid_pages: set[int],
    avoid: Sequence[str],
    knowledge_str: str,
    *,
    single_blank_only: bool,
    difficulty: str = "balanced",
) -> tuple[list[dict[str, Any]], str, str]:
    user = prompts.PROMPT_EXERCISE_USER.format(
        blocks=build_blocks(kind, count, avoid, difficulty=difficulty),
        knowledge=knowledge_str,
        notes=context,
    )
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": prompts.PROMPT_EXERCISE_SYSTEM},
        {"role": "user", "content": user},
    ]
    last = ""
    collected: list[dict[str, Any]] = []
    monotonous_overflow: list[dict[str, Any]] = []
    seen_stems: set[str] = set()
    template_counts: dict[str, int] = {}
    all_rejected: list[str] = []
    summary = ""
    for attempt in range(2):
        try:
            raw_data, _usage = llm.chat_json(messages, model=model, temperature=0.5)
            questions, kind_summary, rejected = parse_questions(raw_data, kind, valid_pages, single_blank_only=single_blank_only)
        except llm_mod.LLMUnavailable:
            raise
        except ValueError as exc:
            last = f"{TYPE_LABELS[kind]}：模型回复结构异常（{exc}）"
            messages = messages[:2] + [{"role": "user", "content": "上一次回复格式不正确。请仅输出包含 questions 数组的 JSON。"}]
            continue
        except Exception as exc:
            if collected:
                break
            return [], "", f"{TYPE_LABELS[kind]}：{exc}"
        summary = summary or kind_summary
        questions, overflow = prune_monotonous_questions(
            questions,
            target_count=count,
            template_counts=template_counts,
        )
        if overflow:
            monotonous_overflow.extend(overflow)
            rejected.extend(["题干句式雷同（同一提问模板过多）"] * len(overflow))
        all_rejected.extend(rejected)
        for q in questions:
            k_s = stem_key(q["question"])
            if k_s and k_s not in seen_stems:
                seen_stems.add(k_s)
                tpl = opening_template_key(q["question"])
                if tpl:
                    template_counts[tpl] = template_counts.get(tpl, 0) + 1
                collected.append(q)
        need = count - len(collected)
        if need <= 0 or (attempt == 0 and not rejected and collected):
            break
        if attempt == 0:
            reasons = "、".join(sorted(set(rejected))) if rejected else "题干不合规或数量不足"
            existing_hint = ""
            if collected:
                existing_hint = "\n以下题目已采用，请勿重复：\n" + "\n".join(f"- {q['question']}" for q in collected)
            messages = messages[:2] + [
                {
                    "role": "user",
                    "content": (
                        f"上一轮有题目未通过质检（原因：{reasons}）。"
                        f"请补充生成 {need} 道新的{TYPE_LABELS[kind]}，务必改用概念辨析、报错诊断、写法对比、场景应用或边界条件等不同角度，"
                        f"禁止再重复“在Python中，执行以下代码后，输出结果是……”句式，同时确保代码/指令完整、不引用图表页码，且先在 reasoning 验算无误后再输出正式解析。仅输出 JSON。{existing_hint}"
                    ),
                }
            ]
    if len(collected) < count and monotonous_overflow:
        for q in monotonous_overflow:
            if len(collected) >= count:
                break
            k_s = stem_key(q["question"])
            if k_s and k_s not in seen_stems:
                seen_stems.add(k_s)
                collected.append(q)
    if collected or not last:
        note = (
            f"{TYPE_LABELS[kind]}：有 {len(all_rejected)} 道不合格已丢弃（{'、'.join(sorted(set(all_rejected)))}）"
            if all_rejected
            else ""
        )
        return collected[:count], summary, note
    return [], "", last


def generate_exercises_from_pages(
    pages: Sequence[dict[str, Any]],
    llm: llm_mod.LLMClient,
    *,
    counts: dict[str, int] | None = None,
    point_quotas: Sequence[dict[str, Any]] | None = None,
    existing_stems: Sequence[str] = (),
    existing_items: Sequence[dict[str, Any]] = (),
    knowledge: dict[str, Any] | None = None,
    difficulty: str = "balanced",
    allow_short_answer: bool = False,
    single_blank_only: bool = True,
    model: str | None = None,
    on_progress: Any = None,
    on_batch: Any = None,
) -> dict[str, Any]:
    """Generate exercises purely in-memory either by chapter type counts or per-point quotas."""
    if point_quotas:
        return generate_by_point_quotas(
            pages,
            llm,
            point_quotas,
            existing_stems=existing_stems,
            existing_items=existing_items,
            knowledge=knowledge,
            difficulty=difficulty,
            allow_short_answer=allow_short_answer,
            single_blank_only=single_blank_only,
            model=model,
            on_progress=on_progress,
            on_batch=on_batch,
        )

    allowed = TYPE_ORDER if allow_short_answer else OBJECTIVE_TYPES
    raw_counts = counts or {}
    wanted: list[tuple[str, int]] = []
    for k, v in raw_counts.items():
        ck = canonical_type(k)
        if ck in allowed:
            n = max(0, min(MAX_PER_TYPE, int(v or 0)))
            if n > 0:
                wanted.append((ck, n))
    if not wanted:
        return {"questions": [], "summary": "", "notes": ["没有有效的题型题量"]}

    catalog = point_catalog(knowledge)
    k_block = knowledge_block(catalog)
    usable_pages = filter_content_pages(pages)
    context = build_context(usable_pages, skip_filter=True)
    valid_pages = {int(p.get("page_no") or p.get("index") or 0) for p in usable_pages if int(p.get("page_no") or p.get("index") or 0) > 0}
    if not context:
        return {"questions": [], "summary": "", "notes": ["没有可用的材料文本"]}

    avoid_entries: list[dict[str, Any]] = [
        {"stem": str(it.get("stem") or "").strip(), "kind": canonical_type(str(it.get("kind") or "")), "points": list(it.get("points") or [])}
        for it in existing_items
        if isinstance(it, dict) and str(it.get("stem") or "").strip()
    ]
    existing_entry_keys = {stem_key(e["stem"]) for e in avoid_entries if stem_key(e["stem"])}
    for s in existing_stems:
        text = str(s or "").strip()
        k_s = stem_key(text)
        if text and k_s and k_s not in existing_entry_keys:
            avoid_entries.append({"stem": text, "kind": "", "points": []})
            existing_entry_keys.add(k_s)

    seen_pool: list[tuple[str, str]] = [(e["stem"], e["kind"]) for e in avoid_entries]
    out: list[dict[str, Any]] = []
    notes: list[str] = []
    summary = ""
    now_str = time.strftime("%Y-%m-%d %H:%M:%S")
    completed_kinds = 0
    total_kinds = len(wanted)
    with futures.ThreadPoolExecutor(max_workers=len(wanted)) as pool:
        task_map = {
            pool.submit(
                _generate_kind,
                llm,
                model,
                context,
                k,
                n,
                valid_pages,
                _select_avoid_stems(avoid_entries, kind=k),
                k_block,
                single_blank_only=single_blank_only,
                difficulty=difficulty,
            ): k
            for k, n in wanted
        }
        for fut in futures.as_completed(task_map):
            k = task_map[fut]
            questions, kind_summary, note = fut.result()
            completed_kinds += 1
            summary = summary or kind_summary
            if note:
                notes.append(note)
            batch_out: list[dict[str, Any]] = []
            for q in questions:
                if _is_duplicate_in_pool(q["question"], k, seen_pool):
                    continue
                seen_pool.append((q["question"], k))
                if catalog:
                    kept = pick_points(q["knowledge_points"], catalog)
                    q["knowledge_points"] = kept or link_by_pages(q["page"], catalog)
                item = {"id": uuid.uuid4().hex[:10], **q, "reviewed": False, "created_at": now_str}
                out.append(item)
                batch_out.append(item)
            if batch_out and callable(on_batch):
                on_batch(batch_out)
            if callable(on_progress):
                on_progress(completed_kinds, total_kinds, f"正在生成{TYPE_LABELS[k]}（{completed_kinds}/{total_kinds} 题型）…")
    return {"questions": out, "summary": summary, "notes": notes}


def generate_by_point_quotas(
    pages: Sequence[dict[str, Any]],
    llm: llm_mod.LLMClient,
    quotas: Sequence[dict[str, Any]],
    *,
    existing_stems: Sequence[str] = (),
    existing_items: Sequence[dict[str, Any]] = (),
    knowledge: dict[str, Any] | None = None,
    difficulty: str = "balanced",
    allow_short_answer: bool = False,
    single_blank_only: bool = True,
    model: str | None = None,
    on_progress: Any = None,
    on_batch: Any = None,
) -> dict[str, Any]:
    """Generate exercises by per-knowledge-point quotas in resilient batches."""
    allowed = TYPE_ORDER if allow_short_answer else OBJECTIVE_TYPES
    catalog = point_catalog(knowledge)
    by_page = {
        int(p.get("page_no") or p.get("index") or idx): p
        for idx, p in enumerate(pages, 1)
        if str(p.get("text") or "").strip()
    }
    if not by_page:
        return {"questions": [], "summary": "", "notes": ["没有可用的材料文本"]}

    # Group non-zero quota items by question type, then pack into batches respecting limits.
    batches: list[tuple[str, list[tuple[dict[str, Any], int]]]] = []
    for k in allowed:
        pending: list[tuple[dict[str, Any], int]] = []
        for raw in quotas:
            if not isinstance(raw, dict):
                continue
            title = str(raw.get("title") or "").strip()
            cnt = max(0, min(MAX_PER_POINT_TYPE, int(raw.get(k) or 0)))
            if not title or cnt <= 0:
                continue
            kp_pages = [int(v) for v in (raw.get("pages") or []) if int(v) in by_page]
            pending.append(({"title": title, "section": str(raw.get("section") or ""), "pages": kp_pages}, cnt))
        cur_batch: list[tuple[dict[str, Any], int]] = []
        cur_total = 0
        for item in pending:
            _, cnt = item
            if cur_batch and (
                len(cur_batch) >= QUOTA_BATCH_MAX_POINTS or cur_total + cnt > QUOTA_BATCH_MAX_QUESTIONS
            ):
                batches.append((k, cur_batch))
                cur_batch, cur_total = [], 0
            cur_batch.append(item)
            cur_total += cnt
        if cur_batch:
            batches.append((k, cur_batch))

    avoid_entries: list[dict[str, Any]] = [
        {"stem": str(it.get("stem") or "").strip(), "kind": canonical_type(str(it.get("kind") or "")), "points": list(it.get("points") or [])}
        for it in existing_items
        if isinstance(it, dict) and str(it.get("stem") or "").strip()
    ]
    existing_entry_keys = {stem_key(e["stem"]) for e in avoid_entries if stem_key(e["stem"])}
    for s in existing_stems:
        text = str(s or "").strip()
        k_s = stem_key(text)
        if text and k_s and k_s not in existing_entry_keys:
            avoid_entries.append({"stem": text, "kind": "", "points": []})
            existing_entry_keys.add(k_s)
    seen_pool: list[tuple[str, str]] = [(e["stem"], e["kind"]) for e in avoid_entries]
    out: list[dict[str, Any]] = []
    notes: list[str] = []
    summary = ""
    now_str = time.strftime("%Y-%m-%d %H:%M:%S")
    total_batches = len(batches)

    for b_idx, (k, batch) in enumerate(batches):
        if callable(on_progress):
            on_progress(b_idx, total_batches, f"正在按知识点配额生成{TYPE_LABELS[k]}（{b_idx + 1}/{total_batches} 批）…")
        batch_page_nums = sorted({p for kp, _ in batch for p in (kp.get("pages") or []) if p in by_page})
        target_pages = [by_page[n] for n in batch_page_nums] if batch_page_nums else [by_page[n] for n in sorted(by_page)]
        context = build_context(target_pages, skip_filter=True)
        valid_pages = {int(p.get("page_no") or p.get("index") or 0) for p in target_pages}
        normalized_batch = [
            ({"title": kp["title"], "pages": kp["pages"] or sorted(valid_pages)}, cnt)
            for kp, cnt in batch
        ]
        k_block = knowledge_block(catalog or [kp for kp, _ in batch])
        batch_need = sum(cnt for _, cnt in batch)
        batch_avoid = _select_avoid_stems(
            avoid_entries,
            kind=k,
            batch_points=[kp["title"] for kp, _ in batch],
        )
        user = prompts.PROMPT_EXERCISE_USER.format(
            blocks=build_quota_blocks(k, normalized_batch, batch_avoid, difficulty=difficulty),
            knowledge=k_block,
            notes=context,
        )
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": prompts.PROMPT_EXERCISE_SYSTEM},
            {"role": "user", "content": user},
        ]
        qs: list[dict[str, Any]] = []
        batch_overflow: list[dict[str, Any]] = []
        seen_batch_stems: set[str] = set()
        batch_template_counts: dict[str, int] = {}
        all_rejected: list[str] = []
        last_err = ""
        for attempt in range(2):
            try:
                raw_data, _ = llm.chat_json(
                    messages,
                    model=model,
                    temperature=0.5,
                )
                batch_qs, batch_sum, rejected = parse_questions(raw_data, k, valid_pages, single_blank_only=single_blank_only)
                summary = summary or batch_sum
                last_err = ""
                batch_qs, overflow = prune_monotonous_questions(
                    batch_qs,
                    target_count=batch_need,
                    template_counts=batch_template_counts,
                )
                if overflow:
                    batch_overflow.extend(overflow)
                    rejected.extend(["题干句式雷同（同一提问模板过多）"] * len(overflow))
                all_rejected.extend(rejected)
                for q in batch_qs:
                    ks = stem_key(q["question"])
                    if ks and ks not in seen_batch_stems:
                        seen_batch_stems.add(ks)
                        tpl = opening_template_key(q["question"])
                        if tpl:
                            batch_template_counts[tpl] = batch_template_counts.get(tpl, 0) + 1
                        qs.append(q)
                if len(qs) >= batch_need or (attempt == 0 and not rejected and qs):
                    break
                if attempt == 0:
                    reasons = "、".join(sorted(set(rejected))) if rejected else "未返回合格题目"
                    remain = max(1, batch_need - len(qs))
                    messages = messages[:2] + [
                        {
                            "role": "user",
                            "content": (
                                f"上一轮有题目未通过质检（原因：{reasons}）。请再补充 {remain} 道合格的{TYPE_LABELS[k]}，"
                                "务必改用概念辨析、报错诊断、写法对比、场景应用或边界条件等不同角度，禁止再重复“在Python中，执行以下代码后，输出结果是……”句式，"
                                "同时先在 reasoning 字段验算无误后再输出正式题面与解析。仅输出 JSON。"
                            ),
                        }
                    ]
            except Exception as exc:  # noqa: BLE001 -- preserve earlier batches on transient LLM failure
                if type(exc).__name__ == "JobCancelled":
                    raise
                last_err = str(exc)
                if attempt == 0:
                    continue
        if len(qs) < batch_need and batch_overflow:
            for q in batch_overflow:
                if len(qs) >= batch_need:
                    break
                ks = stem_key(q["question"])
                if ks and ks not in seen_batch_stems:
                    seen_batch_stems.add(ks)
                    qs.append(q)
        if last_err and not qs:
            notes.append(f"{TYPE_LABELS[k]}第 {b_idx + 1} 批生成失败：{last_err}")
            continue
        if all_rejected:
            notes.append(f"{TYPE_LABELS[k]}第 {b_idx + 1} 批丢弃 {len(all_rejected)} 道不合格题目（{'、'.join(sorted(set(all_rejected)))}）")

        title_by_key = {squeeze_text(kp["title"]): kp["title"] for kp, _ in batch}
        rem_quota = {kp["title"]: cnt for kp, cnt in batch}
        batch_out: list[dict[str, Any]] = []
        for q in qs:
            if _is_duplicate_in_pool(q["question"], k, seen_pool):
                continue
            matched_title = next(
                (title_by_key[squeeze_text(pt)] for pt in q["knowledge_points"] if squeeze_text(pt) in title_by_key),
                None,
            )
            if matched_title is None:
                matched_title = next((t for t, rem in rem_quota.items() if rem > 0), batch[0][0]["title"])
            if rem_quota.get(matched_title, 0) <= 0:
                fallback = next((t for t, rem in rem_quota.items() if rem > 0), None)
                if fallback is None:
                    break
                matched_title = fallback
            seen_pool.append((q["question"], k))
            rem_quota[matched_title] -= 1
            q["knowledge_points"] = [matched_title, *[pt for pt in q["knowledge_points"] if pt != matched_title]][:MAX_LINKED_POINTS]
            avoid_entries.append({"stem": q["question"], "kind": k, "points": list(q["knowledge_points"])})
            item = {"id": uuid.uuid4().hex[:10], **q, "reviewed": False, "created_at": now_str}
            out.append(item)
            batch_out.append(item)
        if batch_out and callable(on_batch):
            on_batch(batch_out)
    return {"questions": out, "summary": summary, "notes": notes}


def _sorted_questions(questions: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    order = {k: i for i, k in enumerate(TYPE_ORDER)}
    return sorted(questions, key=lambda q: (order.get(canonical_type(str(q.get("type") or "")), 9), int(q.get("page") or 0)))


def _point_titles(question: dict[str, Any]) -> list[str]:
    if question.get("graph_points"):
        return [str(p["title"]) for p in question["graph_points"]]
    return [str(p) for p in (question.get("knowledge_points") or [])]


def _blank_answers(question: dict[str, Any]) -> list[str]:
    answer = question.get("answer")
    if isinstance(answer, (list, tuple)):
        return [str(x).strip() for x in answer if str(x).strip()][:8]
    raw = str(answer or "").strip()
    return [s.strip() for s in re.split(r"[；;\r\n]+", raw) if s.strip()][:8] if raw else []


def _short_answer(question: dict[str, Any]) -> str:
    answer = question.get("answer")
    if isinstance(answer, (list, tuple)):
        return "\n".join(str(x).strip() for x in answer if str(x).strip())
    return str(answer or "").strip()


def answer_text(question: dict[str, Any]) -> str:
    """Human-readable answer formatting."""
    qtype = canonical_type(str(question.get("type") or ""))
    answer = question.get("answer")
    if qtype == "true_false":
        val = str(answer[0] if isinstance(answer, (list, tuple)) and answer else answer or "").strip().lower()
        if val in ("a", "true") or val in _TRUE_WORDS or answer is True:
            return "正确"
        if val in ("b", "false") or val in _FALSE_WORDS or answer is False:
            return "错误"
        return ""
    if qtype == "fill_blank":
        return "；".join(_blank_answers(question))
    if qtype == "short_answer":
        return _short_answer(question)
    if isinstance(answer, list):
        return "".join(str(a).upper() for a in answer)
    return str(answer or "").upper()


def xuexitong_answer(question: dict[str, Any]) -> str:
    """Format answer cell for Xuexitong 20-column Excel import."""
    qtype = canonical_type(str(question.get("type") or ""))
    answer = question.get("answer")
    if qtype == "true_false":
        if answer is True:
            return "A"
        if answer is False:
            return "B"
        val = str(answer[0] if isinstance(answer, (list, tuple)) and answer else answer or "").strip().lower()
        if val == "a" or val in _TRUE_WORDS:
            return "A"
        if val == "b" or val in _FALSE_WORDS:
            return "B"
        return ""
    if qtype == "multiple":
        return "".join(a.upper() for a in _letters(answer))
    if qtype == "fill_blank":
        return ""
    if qtype == "short_answer":
        return "A" if _short_answer(question) else ""
    letters = _letters(answer)
    return letters[0].upper() if letters else ""


def export_xuexitong_rows(questions: Sequence[dict[str, Any]], catalog_name: str = "") -> list[list[str]]:
    """Convert questions into Xuexitong 20-column rows."""
    parts = [p.strip() for p in re.split(r"[/\\]+", str(catalog_name or "").strip()) if p.strip()]
    catalog = "/" + "/".join(parts) if parts else ""
    rows: list[list[str]] = [list(XUEXITONG_COLUMNS)]
    for q in _sorted_questions(questions):
        qtype = canonical_type(str(q.get("type") or ""))
        options = q.get("options") if isinstance(q.get("options"), dict) else {}
        opt_cells = [""] * 8
        if qtype == "fill_blank":
            blanks = _blank_answers(q)
            for idx, val in enumerate(blanks[:8]):
                opt_cells[idx] = val
            opt_count = str(len(blanks)) if blanks else ""
        elif qtype == "short_answer":
            ref = _short_answer(q)
            if ref:
                opt_cells[0] = ref
                opt_count = "1"
            else:
                opt_count = ""
        elif qtype == "true_false":
            opt_cells[0], opt_cells[1], opt_count = "正确", "错误", "2"
        else:
            for idx, k in enumerate("abcdefgh"):
                opt_cells[idx] = str(options.get(k) or "").strip()
            count = sum(1 for v in opt_cells if v)
            opt_count = str(count) if count else ""
        raw_tags = q.get("tags")
        tags_str = (
            "；".join(str(t).strip() for t in raw_tags if str(t).strip())
            if isinstance(raw_tags, (list, tuple))
            else str(raw_tags or "").strip()
        )
        diff = str(q.get("difficulty") or "").strip()
        rows.append(
            [
                catalog,
                TYPE_LABELS.get(qtype, ""),
                "",
                str(q.get("question") or ""),
                "",
                "",
                xuexitong_answer(q),
                str(q.get("explanation") or ""),
                _DIFFICULTY_MAP.get(diff, diff if diff in ("易", "中", "难") else ""),
                "；".join(_point_titles(q)),
                tags_str,
                opt_count,
                *opt_cells,
            ]
        )
    return rows


def export_xuexitong_xlsx(questions: Sequence[dict[str, Any]], catalog_name: str = "") -> bytes:
    """Export questions in Xuexitong 20-column .xlsx format."""
    return build_xlsx(
        export_xuexitong_rows(questions, catalog_name=catalog_name),
        sheet_name="题库",
        widths=XUEXITONG_WIDTHS,
        header_fill="D9EAD3",
    )


def export_exercises_xlsx(questions: Sequence[dict[str, Any]]) -> bytes:
    """Export questions in standard 10-column readable .xlsx format."""
    rows: list[list[str]] = [list(EXPORT_COLUMNS)]
    for q in _sorted_questions(questions):
        qtype = canonical_type(str(q.get("type") or ""))
        options = q.get("options") or {}
        judge = qtype == "true_false"
        no_opts = qtype in ("fill_blank", "short_answer")
        rows.append(
            [
                TYPE_LABELS.get(qtype, ""),
                str(q.get("question") or ""),
                *["" if no_opts or (judge and k in "cd") else str(options.get(k) or "") for k in "abcd"],
                answer_text(q),
                str(q.get("explanation") or ""),
                "；".join(_point_titles(q)),
                str(q.get("page") or ""),
            ]
        )
    return build_xlsx(rows, sheet_name="习题", widths=_EXPORT_WIDTHS, header_fill="D9EAD3")


def export_xuexitong_txt(questions: Sequence[dict[str, Any]], *, preserve_order: bool = False) -> str:
    """Export questions in Xuexitong smart-import TXT format."""
    ordered = list(questions) if preserve_order else _sorted_questions(questions)
    blocks: list[str] = []
    for idx, q in enumerate(ordered, 1):
        qtype = canonical_type(str(q.get("type") or ""))
        stem = str(q.get("question") or "").strip()
        exp = str(q.get("explanation") or "").strip()
        if qtype == "true_false":
            ans_word = "对" if xuexitong_answer(q) == "A" else "错"
            lines = [f"{idx}.【判断题】{stem}（{ans_word}）", f"答案：{ans_word}"]
        elif qtype == "fill_blank":
            lines = [f"{idx}.【填空题】{stem}", f"答案：{'；'.join(_blank_answers(q))}"]
        elif qtype == "short_answer":
            lines = [f"{idx}.【简答题】{stem}", f"答案：{_short_answer(q)}"]
        else:
            label = TYPE_LABELS.get(qtype, "单选题")
            options = q.get("options") if isinstance(q.get("options"), dict) else {}
            lines = [f"{idx}.【{label}】{stem}"]
            for k in "abcdefgh":
                val = str(options.get(k) or "").strip()
                if val:
                    lines.append(f"{k.upper()}. {val}")
            ans_letters = "".join(a.upper() for a in _letters(q.get("answer")))
            lines.append(f"答案：{ans_letters}")
        if exp:
            lines.append(f"解析：{exp}")
        blocks.append("\n".join(lines))
    return ("\n\n".join(blocks) + "\n") if blocks else ""


def validate_xuexitong_export(questions: Sequence[dict[str, Any]], *, preserve_order: bool = False) -> dict[str, Any]:
    """Deterministic pre-export check before downloading Xuexitong packages."""
    ordered = list(questions) if preserve_order else _sorted_questions(questions)
    errors: list[str] = []
    warnings: list[str] = []
    for idx, q in enumerate(ordered, 1):
        qtype = canonical_type(str(q.get("type") or ""))
        stem = str(q.get("question") or "").strip()
        if qtype not in TYPE_LABELS:
            errors.append(f"第 {idx} 题题型不支持（{qtype}）")
            continue
        if len(stem) < 4:
            errors.append(f"第 {idx} 题题干过短")
        else:
            stem_issue = check_stem_self_contained(stem)
            if stem_issue:
                warnings.append(f"第 {idx} 题可能不完整：{stem_issue}")
        if qtype in ("single", "multiple"):
            options = q.get("options") if isinstance(q.get("options"), dict) else {}
            present = [k for k in "abcdefgh" if str(options.get(k) or "").strip()]
            expected = list("abcdefgh"[: len(present)])
            if len(present) < 2 or present != expected:
                errors.append(f"第 {idx} 题缺少有效选项（仅有 {','.join(k.upper() for k in present) or '无'}）")
            letters = _letters(q.get("answer"))
            if qtype == "single" and len(letters) != 1:
                errors.append(f"第 {idx} 题单选题答案不合法")
            if qtype == "multiple" and len(letters) < 2:
                errors.append(f"第 {idx} 题多选题答案少于两个")
            if not set(letters) <= set(present):
                errors.append(f"第 {idx} 题答案超出已有选项范围")
        elif qtype == "true_false":
            if xuexitong_answer(q) not in ("A", "B"):
                errors.append(f"第 {idx} 题判断题答案必须为正确或错误")
        elif qtype == "fill_blank":
            if not _BLANK_MARKER_RE.search(stem):
                warnings.append(f"第 {idx} 题填空题题干建议包含下划线空位 ____")
            if not _blank_answers(q):
                errors.append(f"第 {idx} 题填空题答案为空")
        elif qtype == "short_answer":
            ans = _short_answer(q)
            if not ans:
                errors.append(f"第 {idx} 题简答题参考答案为空")
            elif len(ans) < 20:
                warnings.append(f"第 {idx} 题简答题参考答案偏短（{len(ans)} 字，建议至少 20 字）")
        if qtype != "short_answer":
            exp_text = str(q.get("explanation") or "").strip()
            if not exp_text:
                warnings.append(f"第 {idx} 题缺少答案解析")
            else:
                ans_norm = xuexitong_answer(q).lower() if qtype == "true_false" else q.get("answer")
                exp_issue = check_explanation_clean(exp_text, canon_type=qtype, answer=ans_norm)
                if exp_issue == "答案解析过于简略" or (exp_issue is None and len(exp_text) < 12):
                    warnings.append(f"第 {idx} 题答案解析偏简略（仅 {len(exp_text)} 字）")
                elif exp_issue:
                    warnings.append(f"第 {idx} 题解析异常：{exp_issue}")
            opts_dict = q.get("options") if isinstance(q.get("options"), dict) else {}
            ans_for_py = xuexitong_answer(q).lower() if qtype == "true_false" else q.get("answer")
            py_issue = verify_python_objective_question(stem, qtype, opts_dict, ans_for_py)
            if py_issue:
                warnings.append(f"第 {idx} 题答案疑有误：{py_issue}")

    txt = export_xuexitong_txt(ordered, preserve_order=True)
    blocks = [b.strip() for b in txt.split("\n\n") if b.strip()]
    nums: list[int] = []
    for b in blocks:
        m = re.match(r"^(\d+)\.【(单选题|多选题|判断题|填空题|简答题)】", b)
        if not m:
            errors.append(f"导出文本格式异常：{b[:40]}")
            continue
        nums.append(int(m.group(1)))
        if not re.search(r"^答案：.+$", b, re.M):
            errors.append(f"导出文本第 {m.group(1)} 题缺少「答案：」行")
    if nums != list(range(1, len(ordered) + 1)):
        errors.append("导出文本题号不连续")
    return {"ok": not errors, "total": len(ordered), "errors": errors, "warnings": warnings}


def _format_question_for_explanation(no: int, q: dict[str, Any]) -> str:
    """Format one verified question with locked stem/options/answer for dedicated explanation generation."""
    raw_kind = str(q.get("type") or q.get("kind") or "").strip().lower()
    canon = canonical_type(raw_kind)
    label = TYPE_LABELS.get(canon, "编程题" if raw_kind in {"python", "fill_code", "debug", "design"} else raw_kind or "试题")
    coding_sub = str(q.get("coding_type") or "").strip()
    if coding_sub:
        label = f"{label}（{coding_sub}）"
    lines = [f"【第 {no} 题 · {label}】"]
    title = str(q.get("title") or "").strip()
    if title:
        lines.append(f"标题：{title}")
    stem = str(q.get("question") or q.get("prompt") or "").strip()
    lines.append(f"题干：\n{stem}")
    options = q.get("options")
    if isinstance(options, dict) and options:
        opt_lines = [f"{k.upper()}. {options[k]}" for k in "abcdefgh" if str(options.get(k) or "").strip()]
        if opt_lines:
            lines.append("选项：\n" + "\n".join(opt_lines))
    elif isinstance(options, list) and options:
        opt_lines = [f"{chr(65 + i)}. {v}" for i, v in enumerate(options[:8]) if str(v or "").strip()]
        if opt_lines:
            lines.append("选项：\n" + "\n".join(opt_lines))
    locked_answer = answer_text({**q, "type": canon}) if canon in TYPE_LABELS else str(q.get("answer") or "").strip()
    if locked_answer:
        lines.append(f"已核验标准答案：{locked_answer}")
    starter = str(q.get("starter_code") or "").strip()
    if starter:
        lines.append(f"初始代码：\n{starter}")
    ref_code = str(q.get("reference_solution") or "").strip()
    if ref_code:
        lines.append(f"已通过沙箱的参考代码：\n{ref_code}")
    kps = [str(p).strip() for p in (q.get("knowledge_points") or []) if str(p).strip()]
    if kps:
        lines.append("关联知识点：" + "、".join(kps[:3]))
    return "\n".join(lines)


def generate_question_explanations(
    questions: Sequence[dict[str, Any]],
    llm: llm_mod.LLMClient,
    *,
    pages: Sequence[dict[str, Any]] = (),
    model: str | None = None,
) -> dict[str, Any]:
    """Generate or rewrite clean student-facing explanations for already-verified questions."""
    if not questions:
        return {"explanations": {}, "flags": {}, "rejected": []}
    formatted = "\n\n".join(
        _format_question_for_explanation(idx, q) for idx, q in enumerate(questions, start=1)
    )
    notes = build_context(pages, max_chars=8000) if pages else "（无附加参考材料，请仅依据题干与已核验标准答案编写）"
    user_prompt = prompts.PROMPT_EXERCISE_EXPLANATION_USER.format(questions=formatted, notes=notes)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": prompts.PROMPT_EXERCISE_EXPLANATION_SYSTEM},
        {"role": "user", "content": user_prompt},
    ]
    raw_data, _usage = llm.chat_json(
        messages,
        model=model,
        temperature=0.2,
    )
    data = extract_json_payload(raw_data) if isinstance(raw_data, str) else raw_data
    items = data.get("explanations") if isinstance(data, dict) else (data if isinstance(data, list) else None)
    if not isinstance(items, list):
        raise ValueError("解析生成结果缺少 explanations 数组")

    explanations: dict[int, str] = {}
    flags: dict[int, str] = {}
    rejected: list[str] = []
    for entry in items:
        if not isinstance(entry, dict):
            continue
        try:
            no = int(entry.get("no") or 0)
        except (TypeError, ValueError):
            continue
        if not 1 <= no <= len(questions):
            continue
        flag = str(entry.get("flag") or "ok").strip().lower()
        if flag == "mismatch":
            reason = str(entry.get("flag_reason") or "题干与标准答案存在矛盾").strip()[:200]
            flags[no] = reason
            continue
        q = questions[no - 1]
        canon = canonical_type(str(q.get("type") or q.get("kind") or ""))
        ans = q.get("answer")
        if canon == "true_false":
            x_ans = xuexitong_answer({**q, "type": canon}).lower()
            ans = x_ans if x_ans in {"a", "b"} else ans
        cleaned = clean_explanation(entry.get("explanation"))
        if not cleaned:
            rejected.append(f"第 {no} 题解析为空")
            continue
        issue = check_explanation_clean(cleaned, canon_type=canon, answer=ans)
        if issue:
            rejected.append(f"第 {no} 题：{issue}")
            continue
        explanations[no] = cleaned[:2000]
    return {"explanations": explanations, "flags": flags, "rejected": rejected}
