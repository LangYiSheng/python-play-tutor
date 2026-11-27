"""Dataset schema, fill-code template validation, AST checks, and Reborn payload export.

Aligned with Pythontopia Reborn `QuestionInput` and course package format 4 constraints:
- Top-level question kind remains `"python"`
- Subtype `coding_type` (`fill_code` | `debug` | `design`), `difficulty` (`易` | `中` | `难`),
  and `usage` (`practice` | `assessment` | `both`) live in `Question.source`
- `reference_solution` is stored privately in `QuestionSecret.answer` (never exposed to learners)
"""

from __future__ import annotations

import ast
import io
import json
import re
import tokenize
from dataclasses import dataclass
from typing import Any

DATASET_SCHEMA_VERSION = 1

CODING_TYPES = ("fill_code", "debug", "design")
CODING_TYPE_LABELS: dict[str, str] = {
    "fill_code": "程序填空",
    "debug": "程序改错",
    "design": "程序设计",
}
DIFFICULTIES = ("易", "中", "难")
USAGES = ("practice", "assessment", "both")
PROVENANCES = ("ai_synthesized", "teacher_authored", "open_adapted")

MAX_CASES_TOTAL = 20
MAX_CASE_TEXT_LEN = 10_000
MAX_PROMPT_LEN = 30_000
MAX_CODE_LEN = 20_000
MAX_HINTS = 10
MAX_HINT_LEN = 2_000
MAX_EXPLANATION_LEN = 2_000

FILL_START_RE = re.compile(r"^[ \t]*#[ \t]*===[ \t]*填空区(?:[ \t]*([0-9]+))?[ \t]*开始[ \t]*===[ \t]*$", re.ASCII)
FILL_END_RE = re.compile(r"^[ \t]*#[ \t]*===[ \t]*填空区(?:[ \t]*([0-9]+))?[ \t]*结束[ \t]*===[ \t]*$", re.ASCII)

_NON_SELF_CONTAINED_RE = re.compile(
    r"第\s*[0-9一二三四五六七八九十百]+\s*页|如图所示|如下图所示|如上图所示|见下图|见上图|见下表|如表所示"
)

ALLOWED_STDLIB_MODULES = frozenset(
    {
        "array",
        "bisect",
        "calendar",
        "collections",
        "copy",
        "csv",
        "dataclasses",
        "datetime",
        "decimal",
        "enum",
        "fractions",
        "functools",
        "heapq",
        "io",
        "itertools",
        "json",
        "math",
        "operator",
        "random",
        "re",
        "statistics",
        "string",
        "sys",
        "textwrap",
        "typing",
        "unicodedata",
    }
)

_FORBIDDEN_TIME_ATTRS = frozenset({"now", "today", "utcnow", "time", "monotonic", "perf_counter"})


@dataclass(frozen=True)
class FillTemplate:
    """Parsed fill-in-the-blank code skeleton and editable slot contents."""

    slot_ids: tuple[str, ...]
    skeleton_segments: tuple[tuple[str, ...], ...]
    slots: tuple[tuple[str, ...], ...]
    marker_lines: tuple[int, ...] = ()


def _norm_lines(code: str) -> list[str]:
    return code.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").split("\n")


def extract_fill_template(code: str) -> tuple[FillTemplate | None, str | None]:
    """Parse `# === 填空区 N 开始/结束 ===` blocks from Python source."""
    lines = _norm_lines(code)
    skeleton_segments: list[tuple[str, ...]] = []
    slots: list[tuple[str, ...]] = []
    slot_ids: list[str] = []
    seen_ids: set[str] = set()
    marker_lines: list[int] = []

    current_skeleton: list[str] = []
    current_slot: list[str] | None = None
    active_id: str | None = None

    for line_no, raw_line in enumerate(lines, start=1):
        m_start = FILL_START_RE.match(raw_line)
        m_end = FILL_END_RE.match(raw_line)
        if m_start:
            if current_slot is not None:
                return None, f"第 {line_no} 行出现嵌套的填空区开始标记"
            slot_id = m_start.group(1) or str(len(slot_ids) + 1)
            if slot_id in seen_ids:
                return None, f"第 {line_no} 行出现重复的填空区编号：{slot_id}"
            seen_ids.add(slot_id)
            marker_lines.append(line_no)
            current_skeleton.append(raw_line.rstrip())
            skeleton_segments.append(tuple(current_skeleton))
            current_skeleton = []
            current_slot = []
            active_id = slot_id
        elif m_end:
            if current_slot is None:
                return None, f"第 {line_no} 行出现未配对的填空区结束标记"
            end_id = m_end.group(1) or active_id
            if end_id != active_id:
                return None, f"第 {line_no} 行填空区编号不匹配（开始为 {active_id}，结束为 {end_id}）"
            marker_lines.append(line_no)
            slots.append(tuple(current_slot))
            slot_ids.append(active_id or str(len(slot_ids) + 1))
            current_slot = None
            active_id = None
            current_skeleton = [raw_line.rstrip()]
        else:
            if current_slot is not None:
                current_slot.append(raw_line.rstrip())
            else:
                current_skeleton.append(raw_line.rstrip())

    if current_slot is not None:
        return None, f"填空区 {active_id} 缺少结束标记"
    if not slot_ids:
        return None, "程序填空题缺少 `# === 填空区 1 开始 ===` / `# === 填空区 1 结束 ===` 标记"
    skeleton_segments.append(tuple(current_skeleton))
    return FillTemplate(tuple(slot_ids), tuple(skeleton_segments), tuple(slots), tuple(marker_lines)), None


def _trim_outer_blank_lines(lines: tuple[str, ...]) -> tuple[str, ...]:
    start = 0
    end = len(lines)
    while start < end and not lines[start].strip():
        start += 1
    while end > start and not lines[end - 1].strip():
        end -= 1
    return lines[start:end]


def _lexical_marker_state(code: str, marker_lines: tuple[int, ...]) -> tuple[set[int], dict[int, int], str | None]:
    clean = code.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    marker_set = set(marker_lines)
    comment_lines: set[int] = set()
    depth_at_marker: dict[int, int] = {}
    depth = 0
    try:
        for tok in tokenize.generate_tokens(io.StringIO(clean).readline):
            if tok.type == tokenize.OP:
                if tok.string in "([{":
                    depth += 1
                elif tok.string in ")]}":
                    depth = max(0, depth - 1)
            elif tok.type == tokenize.COMMENT and tok.start[0] in marker_set:
                comment_lines.add(tok.start[0])
                depth_at_marker[tok.start[0]] = depth
    except (tokenize.TokenError, IndentationError) as exc:
        return comment_lines, depth_at_marker, f"代码存在未闭合的字符串、括号或缩进错误（{exc}）"
    return comment_lines, depth_at_marker, None


def validate_fill_submission(starter_code: str, submitted_code: str) -> list[str]:
    """Verify submitted code keeps all locked skeleton lines outside fill slots intact."""
    tpl_starter, err = extract_fill_template(starter_code)
    if err or tpl_starter is None:
        return [f"初始模板无效：{err}"]
    tpl_sub, sub_err = extract_fill_template(submitted_code)
    if sub_err or tpl_sub is None:
        return [f"提交代码破坏了填空区标记：{sub_err}"]
    if tpl_sub.slot_ids != tpl_starter.slot_ids:
        return [f"填空区数量或编号被修改（期望 {list(tpl_starter.slot_ids)}，实际 {list(tpl_sub.slot_ids)}）"]

    errors: list[str] = []
    for idx, (expected_seg, actual_seg) in enumerate(
        zip(tpl_starter.skeleton_segments, tpl_sub.skeleton_segments, strict=True)
    ):
        # Allow minor trailing blank lines at very start/end of file, keep inner framework strict.
        if idx in (0, len(tpl_starter.skeleton_segments) - 1):
            norm_exp = _trim_outer_blank_lines(expected_seg)
            norm_act = _trim_outer_blank_lines(actual_seg)
        else:
            norm_exp = expected_seg
            norm_act = actual_seg
        if norm_exp != norm_act:
            errors.append(f"锁定框架第 {idx + 1} 段被修改，请仅在填空区标记内作答")
    if errors:
        return errors

    sub_comments, sub_depths, lex_err = _lexical_marker_state(submitted_code, tpl_sub.marker_lines)
    if lex_err:
        return [lex_err]
    if any(line not in sub_comments for line in tpl_sub.marker_lines):
        return ["填空区标记被未闭合的字符串或续行吞并，请勿跨填空区包裹锁定框架"]
    _, starter_depths, starter_lex_err = _lexical_marker_state(starter_code, tpl_starter.marker_lines)
    if not starter_lex_err:
        for exp_line, act_line in zip(tpl_starter.marker_lines, tpl_sub.marker_lines, strict=True):
            if sub_depths.get(act_line, 0) != starter_depths.get(exp_line, 0):
                return ["填空区内存在未闭合的括号跨过锁定框架，请检查圆括号、方括号或花括号配对"]
    return []


def _dotted_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _dotted_name(node.value)
        return f"{parent}.{node.attr}" if parent else None
    return None


def check_code_ast(code: str, *, label: str = "reference_solution") -> tuple[list[str], list[str]]:
    """Static AST checks for syntax, sandbox-safe stdlib imports, determinism, and clean I/O."""
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(code, str) or not code.strip():
        return [f"{label} 不能为空"], warnings
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return [f"{label} 存在语法错误（第 {exc.lineno} 行）：{exc.msg}"], warnings

    imported_random = False
    has_random_seed = False
    random_aliases: set[str] = {"random"}
    seed_aliases: set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if top not in ALLOWED_STDLIB_MODULES:
                    errors.append(f"{label} 导入了沙箱外或禁用模块：{alias.name}")
                if top == "random":
                    imported_random = True
                    if alias.asname:
                        random_aliases.add(alias.asname)
        elif isinstance(node, ast.ImportFrom):
            mod = (node.module or "").split(".")[0]
            if not mod or mod not in ALLOWED_STDLIB_MODULES:
                errors.append(f"{label} 导入了沙箱外或禁用模块：{node.module or '.'}")
            if mod == "random":
                imported_random = True
                for alias in node.names:
                    if alias.name == "seed":
                        seed_aliases.add(alias.asname or "seed")
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                fname = node.func.id
                if fname == "open":
                    errors.append(f"{label} 调用了 open() 读写本地文件，沙箱不支持外部文件")
                elif fname == "__import__":
                    errors.append(f"{label} 禁止使用动态 __import__()")
                elif fname == "input" and node.args:
                    errors.append(f"{label} 第 {node.lineno} 行 input() 带有提示参数，会污染标准输出导致判题失败")
                elif fname in seed_aliases:
                    has_random_seed = True
            elif isinstance(node.func, ast.Attribute):
                dotted = _dotted_name(node.func)
                if dotted:
                    parts = dotted.split(".")
                    if parts[0] in random_aliases and parts[-1] == "seed":
                        has_random_seed = True
                    if parts[-1] in _FORBIDDEN_TIME_ATTRS and parts[0] in {"datetime", "date", "time"}:
                        errors.append(f"{label} 调用了非确定性时间函数：{dotted}")

    if imported_random and not has_random_seed:
        errors.append(f"{label} 使用了 random 模块但未调用 random.seed(...) 固定随机种子，判题不可复现")

    return errors, warnings


def _validate_case_list(cases: Any, name: str) -> list[str]:
    errors: list[str] = []
    if not isinstance(cases, list) or not cases:
        return [f"{name} 必须为非空列表"]
    for idx, case in enumerate(cases, start=1):
        if not isinstance(case, dict):
            errors.append(f"{name}[{idx}] 必须为对象")
            continue
        keys = set(case.keys())
        if keys not in ({"input", "output"}, {"input", "expected_output"}):
            errors.append(f"{name}[{idx}] 必须仅包含 input 与 expected_output（或 output）字段")
            continue
        inp = case.get("input")
        out = case.get("expected_output", case.get("output"))
        if not isinstance(inp, str) or len(inp) > MAX_CASE_TEXT_LEN:
            errors.append(f"{name}[{idx}].input 必须为不超过 {MAX_CASE_TEXT_LEN} 字符的字符串")
        if not isinstance(out, str) or len(out) > MAX_CASE_TEXT_LEN:
            errors.append(f"{name}[{idx}].expected_output 必须为不超过 {MAX_CASE_TEXT_LEN} 字符的字符串")
    return errors


def normalize_case(case: dict[str, Any]) -> dict[str, str]:
    """Normalize a case dict to canonical `{input, expected_output}` keys."""
    return {
        "input": str(case.get("input", "")),
        "expected_output": str(case.get("expected_output", case.get("output", ""))),
    }


def validate_problem_schema(item: Any) -> tuple[list[str], list[str]]:
    """Validate one coding dataset problem against schema, teaching rules, and Pythontopia limits."""
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(item, dict):
        return ["题目条目必须为 JSON 对象"], warnings

    pid = item.get("id")
    if not isinstance(pid, str) or not pid.strip() or len(pid.strip()) > 100:
        errors.append("id 必须为 1–100 字符的非空字符串")

    title = item.get("title")
    if not isinstance(title, str) or not title.strip() or len(title.strip()) > 200:
        errors.append("title 必须为 1–200 字符的非空字符串")

    coding_type = item.get("coding_type")
    if coding_type not in CODING_TYPES:
        errors.append(f"coding_type 必须属于 {CODING_TYPES}")

    difficulty = item.get("difficulty")
    if difficulty not in DIFFICULTIES:
        errors.append(f"difficulty 必须属于 {DIFFICULTIES}")

    usage = item.get("usage", "both")
    if usage not in USAGES:
        errors.append(f"usage 必须属于 {USAGES}")

    prompt = item.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_LEN:
        errors.append(f"prompt 必须为 1–{MAX_PROMPT_LEN} 字符的非空字符串")
    elif _NON_SELF_CONTAINED_RE.search(prompt):
        errors.append("prompt 疑似引用外部页码或图表，题干必须 100% 自包含")

    kps = item.get("knowledge_points")
    if not isinstance(kps, list) or not kps or not all(isinstance(k, str) and k.strip() for k in kps):
        errors.append("knowledge_points 必须为非空字符串列表")

    starter_code = item.get("starter_code", "")
    if not isinstance(starter_code, str) or len(starter_code) > MAX_CODE_LEN:
        errors.append(f"starter_code 必须为不超过 {MAX_CODE_LEN} 字符的字符串")

    ref_code = item.get("reference_solution")
    if not isinstance(ref_code, str) or not ref_code.strip() or len(ref_code) > MAX_CODE_LEN:
        errors.append(f"reference_solution 必须为 1–{MAX_CODE_LEN} 字符的非空字符串")

    hints = item.get("hints", [])
    if not isinstance(hints, list) or len(hints) > MAX_HINTS:
        errors.append(f"hints 必须为最多 {MAX_HINTS} 条的列表")
    elif any(not isinstance(h, str) or not h.strip() or len(h) > MAX_HINT_LEN for h in hints):
        errors.append(f"每条 hint 必须为 1–{MAX_HINT_LEN} 字符的非空字符串")

    explanation = item.get("explanation", "")
    if not isinstance(explanation, str) or len(explanation) > MAX_EXPLANATION_LEN:
        errors.append(f"explanation 必须为不超过 {MAX_EXPLANATION_LEN} 字符的字符串")
    elif not explanation.strip():
        warnings.append("建议补充 explanation（解题思路与易错点）")

    samples = item.get("samples")
    hidden = item.get("hidden_cases")
    errors.extend(_validate_case_list(samples, "samples"))
    errors.extend(_validate_case_list(hidden, "hidden_cases"))
    if isinstance(samples, list) and isinstance(hidden, list):
        if len(samples) + len(hidden) > MAX_CASES_TOTAL:
            errors.append(f"公开样例与隐藏用例合计不能超过 {MAX_CASES_TOTAL} 个")
        if len(samples) < 2:
            warnings.append("公开样例少于 2 个，建议配置 3–4 个以覆盖常规与边界场景")
        if len(hidden) < 3:
            warnings.append("隐藏用例少于 3 个，建议配置 5–8 个防止测验硬编码")

    # Coding-type specific structural rules
    if coding_type == "fill_code" and isinstance(starter_code, str) and isinstance(ref_code, str):
        errors.extend(validate_fill_submission(starter_code, ref_code))
    elif coding_type == "debug":
        if not isinstance(starter_code, str) or not starter_code.strip():
            errors.append("程序改错题必须提供含 Bug 的 starter_code")
        elif isinstance(ref_code, str) and starter_code.strip() == ref_code.strip():
            errors.append("程序改错题的 starter_code 不能与 reference_solution 完全相同")

    # AST static checks for reference and optional alternative solution
    if isinstance(ref_code, str) and ref_code.strip():
        ast_errs, ast_warns = check_code_ast(ref_code, label="reference_solution")
        errors.extend(ast_errs)
        warnings.extend(ast_warns)

    alt_code = item.get("alt_solution")
    if alt_code is not None:
        if not isinstance(alt_code, str) or not alt_code.strip():
            errors.append("alt_solution 若提供则必须为非空字符串")
        else:
            alt_errs, alt_warns = check_code_ast(alt_code, label="alt_solution")
            errors.extend(alt_errs)
            warnings.extend(alt_warns)

    # Ensure source metadata fits Reborn's 30000-char JSON limit
    meta_preview = {
        "coding_type": coding_type,
        "difficulty": difficulty,
        "usage": usage,
        "explanation": explanation,
        "tags": item.get("tags", []),
        "provenance": item.get("provenance", "teacher_authored"),
    }
    if len(json.dumps(meta_preview, ensure_ascii=False)) > 30_000:
        errors.append("题目 source 元数据超过 30000 字符")

    return errors, warnings


def to_reborn_question_payload(
    item: dict[str, Any],
    *,
    chapter_ids: list[int],
    knowledge_point_ids: list[int] | None = None,
    material_id: int | None = None,
    status: str = "draft",
) -> dict[str, Any]:
    """Convert a verified dataset item to Pythontopia Reborn `QuestionInput` payload."""
    provenance = str(item.get("provenance") or "teacher_authored")
    source_type = "ai_generated" if provenance == "ai_synthesized" else "imported"
    source: dict[str, Any] = {
        "coding_type": item["coding_type"],
        "difficulty": item["difficulty"],
        "usage": item.get("usage", "both"),
    }
    explanation = str(item.get("explanation") or "").strip()
    if explanation:
        source["explanation"] = explanation[:MAX_EXPLANATION_LEN]
    tags = [str(t).strip() for t in (item.get("tags") or []) if str(t).strip()]
    if tags:
        source["tags"] = tags[:12]
    if provenance:
        source["provenance"] = provenance
    if material_id is not None:
        source["material_id"] = material_id
        page_no = item.get("source_page")
        if isinstance(page_no, int) and page_no > 0:
            source["page_no"] = page_no

    samples = [
        {"input": c["input"], "output": c["expected_output"]}
        for c in (normalize_case(raw) for raw in item["samples"])
    ]
    hidden_cases = [
        {"input": c["input"], "expected_output": c["expected_output"]}
        for c in (normalize_case(raw) for raw in item["hidden_cases"])
    ]
    return {
        "id": item["id"].strip(),
        "title": item["title"].strip(),
        "kind": "python",
        "prompt": item["prompt"].strip(),
        "chapter_ids": list(chapter_ids),
        "knowledge_point_ids": list(knowledge_point_ids or []),
        "source_type": source_type,
        "status": status,
        "options": [],
        "samples": samples,
        "hints": [str(h).strip() for h in (item.get("hints") or []) if str(h).strip()],
        "starter_code": item.get("starter_code", ""),
        "interactive": None,
        "answer": {"reference_solution": item["reference_solution"]},
        "hidden_cases": hidden_cases,
        "source": source,
    }
