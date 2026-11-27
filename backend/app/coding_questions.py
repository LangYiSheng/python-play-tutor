"""Pure validation helpers for Python coding question subtypes and fill-code skeletons."""

from __future__ import annotations

import io
import re
import tokenize
from dataclasses import dataclass
from typing import Any

CODING_TYPES = ("fill_code", "debug", "design")
CODING_USAGES = ("both", "practice", "assessment")
FORBIDDEN_PUBLIC_SOURCE_KEYS = frozenset({"reference_solution", "alt_solution", "hidden_cases", "answer"})

FILL_START_RE = re.compile(r"^[ \t]*#[ \t]*===[ \t]*填空区(?:[ \t]*([0-9]+))?[ \t]*开始[ \t]*===[ \t]*$", re.ASCII)
FILL_END_RE = re.compile(r"^[ \t]*#[ \t]*===[ \t]*填空区(?:[ \t]*([0-9]+))?[ \t]*结束[ \t]*===[ \t]*$", re.ASCII)


@dataclass(frozen=True)
class FillTemplate:
    slot_ids: tuple[str, ...]
    skeleton_segments: tuple[tuple[str, ...], ...]
    slots: tuple[tuple[str, ...], ...]
    marker_lines: tuple[int, ...] = ()


def _norm_lines(code: str) -> list[str]:
    clean = code.lstrip("\ufeff")
    return clean.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def _trim_outer_blank_lines(lines: tuple[str, ...]) -> tuple[str, ...]:
    start = 0
    end = len(lines)
    while start < end and not lines[start].strip():
        start += 1
    while end > start and not lines[end - 1].strip():
        end -= 1
    return lines[start:end]


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
        elif current_slot is not None:
            current_slot.append(raw_line.rstrip())
        else:
            current_skeleton.append(raw_line.rstrip())

    if current_slot is not None:
        return None, f"填空区 {active_id} 缺少结束标记"
    if not slot_ids:
        return None, "程序填空题缺少 `# === 填空区 1 开始 ===` / `# === 填空区 1 结束 ===` 标记"
    skeleton_segments.append(tuple(current_skeleton))
    return FillTemplate(tuple(slot_ids), tuple(skeleton_segments), tuple(slots), tuple(marker_lines)), None


def _lexical_marker_state(code: str, marker_lines: tuple[int, ...]) -> tuple[set[int], dict[int, int], str | None]:
    """Tokenize Python code to verify markers remain real comments and delimiter depth matches across boundaries."""
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
    """Verify submitted code preserves every locked skeleton line and cannot bypass boundaries via strings/brackets."""
    tpl_starter, err = extract_fill_template(starter_code)
    if err or tpl_starter is None:
        return [f"初始模板无效：{err}"]
    tpl_sub, sub_err = extract_fill_template(submitted_code)
    if sub_err or tpl_sub is None:
        return [f"提交代码破坏了填空区标记：{sub_err}"]
    if tpl_sub.slot_ids != tpl_starter.slot_ids:
        return [f"填空区数量或编号被修改（期望 {list(tpl_starter.slot_ids)}，实际 {list(tpl_sub.slot_ids)}）"]

    errors: list[str] = []
    total = len(tpl_starter.skeleton_segments)
    for idx, (expected_seg, actual_seg) in enumerate(
        zip(tpl_starter.skeleton_segments, tpl_sub.skeleton_segments, strict=True)
    ):
        norm_exp = _trim_outer_blank_lines(expected_seg) if idx in (0, total - 1) else expected_seg
        norm_act = _trim_outer_blank_lines(actual_seg) if idx in (0, total - 1) else actual_seg
        if norm_exp != norm_act:
            errors.append(f"锁定框架第 {idx + 1} 段被修改，请仅在填空区标记内作答")
    if errors:
        return errors

    # Lexical boundary guard: prevents bypassing locked skeleton via unclosed triple-quoted strings or brackets.
    sub_comments, sub_depths, lex_err = _lexical_marker_state(submitted_code, tpl_sub.marker_lines)
    if lex_err:
        return [lex_err]
    missing_markers = [line for line in tpl_sub.marker_lines if line not in sub_comments]
    if missing_markers:
        return ["填空区标记被未闭合的字符串或续行吞并，请勿跨填空区包裹锁定框架"]
    _, starter_depths, starter_lex_err = _lexical_marker_state(starter_code, tpl_starter.marker_lines)
    if not starter_lex_err:
        for exp_line, act_line in zip(tpl_starter.marker_lines, tpl_sub.marker_lines, strict=True):
            if sub_depths.get(act_line, 0) != starter_depths.get(exp_line, 0):
                return ["填空区内存在未闭合的括号跨过锁定框架，请检查圆括号、方括号或花括号配对"]
    return []


def extract_reference_solution(answer: Any) -> str:
    """Read private reference_solution stored inside QuestionSecret.answer, if any."""
    if isinstance(answer, dict) and isinstance(answer.get("reference_solution"), str):
        return answer["reference_solution"]
    return ""


def question_coding_type(question: Any) -> str | None:
    source = getattr(question, "source", None)
    if not isinstance(source, dict):
        return None
    raw = source.get("coding_type")
    return raw if raw in CODING_TYPES else None


def check_fill_submission_for_question(question: Any, code: str | None) -> str | None:
    """Return an error message if a fill_code question's locked skeleton was altered."""
    if getattr(question, "kind", None) != "python":
        return None
    if question_coding_type(question) != "fill_code":
        return None
    starter_code = getattr(question, "starter_code", "") or ""
    if not starter_code.strip():
        return None
    tpl, _ = extract_fill_template(starter_code)
    if tpl is None:
        return None
    errors = validate_fill_submission(starter_code, code or "")
    return "；".join(errors) if errors else None


def validate_coding_metadata(
    kind: str,
    status: str,
    starter_code: str,
    answer: Any,
    source: dict[str, Any],
) -> None:
    """Validate optional coding_type/usage/reference_solution rules without breaking legacy python questions."""
    leaked = FORBIDDEN_PUBLIC_SOURCE_KEYS.intersection(source.keys())
    if leaked:
        raise ValueError(f"题目公开来源字段不得包含私有键值：{', '.join(sorted(leaked))}")

    difficulty = source.get("difficulty")
    if difficulty is not None and (not isinstance(difficulty, str) or difficulty not in {"易", "中", "难"}):
        raise ValueError("题目难度必须为 易、中 或 难")

    explanation = source.get("explanation")
    if explanation is not None and (not isinstance(explanation, str) or len(explanation) > 2000):
        raise ValueError("答案解析必须为不超过 2000 字符的字符串")

    tags = source.get("tags")
    if tags is not None and (
        not isinstance(tags, list)
        or len(tags) > 20
        or any(not isinstance(tag, str) or not tag.strip() or len(tag) > 100 for tag in tags)
    ):
        raise ValueError("题目标签必须为最多 20 项的非空字符串列表")

    coding_type = source.get("coding_type")
    usage = source.get("usage")
    if coding_type is not None:
        if kind != "python":
            raise ValueError("只有编程题可以设置编程形式（coding_type）")
        if coding_type not in CODING_TYPES:
            raise ValueError("编程形式必须为 fill_code、debug 或 design")
    if usage is not None:
        if usage not in CODING_USAGES:
            raise ValueError("教学用途必须为 both、practice 或 assessment")

    if kind != "python":
        return

    ref_code = extract_reference_solution(answer)
    if len(ref_code) > 20_000:
        raise ValueError("参考答案代码不能超过 20000 字符")

    if status != "ready":
        return

    if coding_type == "fill_code":
        _, err = extract_fill_template(starter_code)
        if err:
            raise ValueError(f"就绪程序填空题的初始代码无效：{err}")
        if ref_code.strip():
            skeleton_errors = validate_fill_submission(starter_code, ref_code)
            if skeleton_errors:
                raise ValueError("就绪程序填空题的参考答案与初始模板骨架不一致：" + "；".join(skeleton_errors))
    elif coding_type == "debug":
        if not starter_code.strip():
            raise ValueError("就绪程序改错题必须设置含错误的初始代码")
        if ref_code.strip() and starter_code.strip() == ref_code.strip():
            raise ValueError("就绪程序改错题的初始代码不能与参考答案完全相同")
