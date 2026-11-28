"""Course-aligned AI Python coding-question generation and multi-gate sandbox verification."""

from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from typing import Any, Protocol

import httpx

from ...coding_questions import (
    CODING_TYPES,
    CODING_USAGES,
    extract_fill_template,
    validate_fill_submission,
)
from . import exercises as exercises_engine
from . import llm as llm_mod
from . import prompts

CODING_TYPE_LABELS: dict[str, str] = {
    "fill_code": "程序填空",
    "debug": "程序改错",
    "design": "程序设计",
}
DIFFICULTIES: tuple[str, ...] = ("易", "中", "难")
BALANCED_DIFFICULTY_CYCLE: tuple[str, ...] = ("中", "易", "难", "中", "难", "易")

MAX_PER_CODING_TYPE = 10
MAX_TOTAL_CODING_PER_JOB = 12
MAX_STDOUT_CHARS = 16_384
MAX_STDERR_CHARS = 8_192
DEFAULT_TIMEOUT_SECONDS = 2.5
SLOW_CASE_WARNING_MS = 1_000
MAX_CODING_CONTEXT_CHARS = 16_000
DEFAULT_MAX_ATTEMPTS = 4

_FORBIDDEN_IMPORTS = frozenset(
    {
        "os",
        "subprocess",
        "socket",
        "urllib",
        "http",
        "requests",
        "httpx",
        "pathlib",
        "shutil",
        "ctypes",
        "multiprocessing",
        "threading",
        "tempfile",
        "glob",
        "pickle",
        "importlib",
        "builtins",
        "signal",
        "pty",
        "fcntl",
        "resource",
        "webbrowser",
    }
)
_FORBIDDEN_CALLS = frozenset({"open", "eval", "exec", "compile", "__import__", "breakpoint"})


class CodingRunner(Protocol):
    def run(
        self,
        code: str,
        stdin_text: str,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> tuple[str, str, str, int]:
        """Execute Python code and return `(status, stdout, stderr, elapsed_ms)`."""


def same_output(actual: str, expected: str) -> bool:
    """Match Pythontopia go-judge & Pyodide output comparison semantics."""
    return actual.replace("\r\n", "\n").rstrip() == expected.replace("\r\n", "\n").rstrip()


def _classify_nonzero_stderr(stderr: str) -> str:
    lines = [line.strip() for line in stderr.replace("\r\n", "\n").split("\n") if line.strip()]
    last = lines[-1] if lines else ""
    if last.startswith(("SyntaxError:", "IndentationError:", "TabError:")):
        return "compile_error"
    if last.startswith("MemoryError"):
        return "memory_limit"
    return "runtime_error"


class LocalSubprocessCodingRunner:
    """Isolated local CPython runner (`python -I -B`) for non-production authoring and tests."""

    def __init__(self, python_executable: str | None = None) -> None:
        self.python_executable = python_executable or sys.executable

    def run(
        self,
        code: str,
        stdin_text: str,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> tuple[str, str, str, int]:
        env = {
            "PATH": os.environ.get("PATH", ""),
            "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONNOUSERSITE": "1",
        }
        start = time.monotonic()
        try:
            proc = subprocess.run(
                [self.python_executable, "-I", "-B", "-c", code],
                input=stdin_text,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_s,
                env=env,
            )
        except subprocess.TimeoutExpired:
            elapsed = round((time.monotonic() - start) * 1000)
            return "time_limit", "", f"运行超过 {timeout_s:.1f} 秒超时", elapsed
        except OSError as exc:
            elapsed = round((time.monotonic() - start) * 1000)
            return "infrastructure_error", "", str(exc), elapsed

        elapsed = round((time.monotonic() - start) * 1000)
        stdout = (proc.stdout or "")[:MAX_STDOUT_CHARS]
        stderr = (proc.stderr or "")[:MAX_STDERR_CHARS]
        if proc.returncode == 0:
            return "ok", stdout, stderr, elapsed
        return _classify_nonzero_stderr(stderr), stdout, stderr, elapsed


class GoJudgeCodingRunner:
    """Synchronous remote go-judge runner (`/run`) matching production grading isolation."""

    def __init__(self, base_url: str, auth_token: str = "") -> None:
        self.base_url = base_url.rstrip("/")
        self.auth_token = auth_token

    def run(
        self,
        code: str,
        stdin_text: str,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> tuple[str, str, str, int]:
        payload = {
            "cmd": [
                {
                    "args": ["/usr/local/bin/python3", "-I", "-B", "/w/main.py"],
                    "env": ["PATH=/usr/local/bin:/usr/bin", "LANG=C.UTF-8"],
                    "files": [
                        {"content": stdin_text},
                        {"name": "stdout", "max": MAX_STDOUT_CHARS},
                        {"name": "stderr", "max": MAX_STDERR_CHARS},
                    ],
                    "cpuLimit": int(min(timeout_s, 2.0) * 1_000_000_000),
                    "clockLimit": int(max(timeout_s, 5.0) * 1_000_000_000),
                    "memoryLimit": 128 * 1024 * 1024,
                    "procLimit": 16,
                    "copyIn": {"main.py": {"content": code}},
                }
            ]
        }
        headers = {"Authorization": f"Bearer {self.auth_token}"} if self.auth_token else {}
        start = time.monotonic()
        try:
            with httpx.Client(base_url=self.base_url, headers=headers, timeout=15, trust_env=False) as client:
                resp = client.post("/run", json=payload)
                resp.raise_for_status()
                items = resp.json()
        except Exception as exc:  # noqa: BLE001 -- surfaced cleanly as verification failure
            elapsed = round((time.monotonic() - start) * 1000)
            return "infrastructure_error", "", f"go-judge 调用失败：{exc}", elapsed

        elapsed = round((time.monotonic() - start) * 1000)
        if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
            return "infrastructure_error", "", "go-judge 响应格式异常", elapsed
        item = items[0]
        remote = str(item.get("status") or "")
        files = item.get("files") if isinstance(item.get("files"), dict) else {}
        stdout = str(files.get("stdout", ""))[:MAX_STDOUT_CHARS]
        stderr = str(files.get("stderr", ""))[:MAX_STDERR_CHARS]
        if remote == "Accepted" and item.get("exitStatus") == 0:
            return "ok", stdout, stderr, elapsed
        status_map = {
            "Time Limit Exceeded": "time_limit",
            "Memory Limit Exceeded": "memory_limit",
            "Output Limit Exceeded": "runtime_error",
            "Nonzero Exit Status": _classify_nonzero_stderr(stderr),
            "Signalled": "runtime_error",
            "Dangerous Syscall": "runtime_error",
        }
        return status_map.get(remote, "infrastructure_error"), stdout, stderr, elapsed


def _type_specific_rules(coding_type: str) -> str:
    if coding_type == "fill_code":
        return (
            "题型要求【程序填空 fill_code】：\n"
            "- 先编写完整、可运行、逻辑严谨的 reference_solution；\n"
            "- 将其中 1–2 段最核心的逻辑用如下成对注释标记括起来：\n"
            "  # === 填空区 1 开始 ===\n"
            "  ...\n"
            "  # === 填空区 1 结束 ===\n"
            "- reference_solution 中保留这些起止标记及正确的核心代码；\n"
            "- starter_code 与 reference_solution 在标记之外的每一行必须逐字符完全一致，仅将标记内的核心代码替换为 `pass  # 请在此补全代码` 或简短占位；\n"
            "- 必须确保 starter_code 无法通过全部测试用例。"
        )
    if coding_type == "debug":
        return (
            "题型要求【程序改错 debug】：\n"
            "- 先编写完整可运行的 reference_solution；\n"
            "- 在其基础上定向注入 1–2 处本章学生最常犯的**实质性可复现错误**（如漏掉 int()/float() 类型转换、整除 // 与普通除法 / 混淆、运算符优先级漏括号、切片右边界差一、临界比较符 >= 与 > 写反、条件遗漏等）生成 starter_code，严禁只改注释、变量名或等价写法；\n"
            "- **必须确保至少 1 个公开样例和若干隐藏用例的输入能精准触发该 Bug**，使原始 starter_code 运行报错或输出与正确结果明显不同；\n"
            "- 题干清晰说明程序本应实现的功能（易/中可说明大致错误处数，难可不提示具体位置）。"
        )
    return (
        "题型要求【程序设计 design】：\n"
        "- 学生需独立编写完整程序，starter_code 留空字符串 \"\" 或仅保留 1–2 行简洁注释；\n"
        "- 题干必须把输入行数、每行数据类型、边界约定与输出格式写得毫无歧义。"
    )


def _check_python_code_safety(code: str, *, label: str, allow_syntax_error: bool = False) -> list[str]:
    """Static AST check rejecting unsafe imports/calls and `input(\"prompt\")` pitfalls."""
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        if allow_syntax_error:
            return []
        return [f"{label}存在 Python 语法错误（第 {exc.lineno or 1} 行：{exc.msg}）"]

    errors: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if top in _FORBIDDEN_IMPORTS:
                    errors.append(f"{label}禁止导入模块 {top}")
        elif isinstance(node, ast.ImportFrom):
            top = (node.module or "").split(".")[0]
            if top in _FORBIDDEN_IMPORTS:
                errors.append(f"{label}禁止从模块 {top} 导入")
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                fname = node.func.id
                if fname in _FORBIDDEN_CALLS:
                    errors.append(f"{label}禁止调用 {fname}()")
                elif fname == "input" and (node.args or node.keywords):
                    errors.append(f"{label}中的 input() 禁止传入提示语参数，必须写成无参 input()")
            elif isinstance(node.func, ast.Attribute) and node.func.attr == "__import__":
                errors.append(f"{label}禁止动态导入")
    return list(dict.fromkeys(errors))


def _normalize_case_list(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        inp = str(item.get("input", ""))
        exp = str(item.get("expected_output", item.get("output", "")))
        out.append({"input": inp.replace("\r\n", "\n"), "expected_output": exp.replace("\r\n", "\n")})
    return out


def normalize_coding_candidate(
    raw: Any,
    *,
    coding_type: str,
    difficulty: str,
    usage: str,
) -> dict[str, Any]:
    """Normalize raw LLM JSON dict into canonical coding-question structure."""
    data = raw if isinstance(raw, dict) else {}
    title = str(data.get("title") or "").strip()[:120]
    prompt = str(data.get("prompt") or data.get("question") or "").replace("\r\n", "\n").strip()
    starter_code = str(data.get("starter_code") or "").replace("\r\n", "\n")
    reference_solution = str(data.get("reference_solution") or "").replace("\r\n", "\n")
    explanation = exercises_engine.clean_explanation(data.get("explanation") or "")[:2000]

    raw_hints = data.get("hints")
    hints: list[str] = []
    if isinstance(raw_hints, list):
        for h in raw_hints:
            s = str(h or "").strip()
            if s and len(hints) < 10:
                hints.append(s[:500])

    raw_kps = data.get("knowledge_points")
    kps = [str(x).strip() for x in raw_kps if str(x).strip()] if isinstance(raw_kps, list) else []

    raw_tags = data.get("tags")
    tags = [str(x).strip()[:100] for x in raw_tags if str(x).strip()][:20] if isinstance(raw_tags, list) else []

    raw_page = data.get("page_number", data.get("source_page", data.get("page", 0)))
    try:
        page_number = int(raw_page or 0)
    except (TypeError, ValueError):
        page_number = 0

    return {
        "title": title,
        "coding_type": coding_type,
        "difficulty": difficulty,
        "usage": usage,
        "prompt": prompt,
        "starter_code": starter_code,
        "reference_solution": reference_solution,
        "hints": hints,
        "explanation": explanation,
        "knowledge_points": kps,
        "tags": tags,
        "page_number": page_number,
        "samples": _normalize_case_list(data.get("samples")),
        "hidden_cases": _normalize_case_list(data.get("hidden_cases")),
    }


def validate_coding_item_static(item: dict[str, Any]) -> tuple[list[str], list[str]]:
    """Run static schema, self-containment, safety, and fill-skeleton checks."""
    errors: list[str] = []
    warnings: list[str] = []

    title = str(item.get("title") or "").strip()
    prompt = str(item.get("prompt") or "").strip()
    coding_type = str(item.get("coding_type") or "")
    difficulty = str(item.get("difficulty") or "")
    usage = str(item.get("usage") or "both")
    starter = str(item.get("starter_code") or "")
    ref = str(item.get("reference_solution") or "")
    explanation = str(item.get("explanation") or "").strip()
    samples = item.get("samples") if isinstance(item.get("samples"), list) else []
    hidden = item.get("hidden_cases") if isinstance(item.get("hidden_cases"), list) else []

    if len(title) < 2:
        errors.append("题目标题过短或缺失")
    if len(prompt) < 20:
        errors.append("题干内容过短，须清晰说明题目描述、输入格式与输出格式")
    else:
        self_err = exercises_engine.check_stem_self_contained(prompt)
        if self_err:
            errors.append(self_err)

    if coding_type not in CODING_TYPES:
        errors.append(f"无效编程形式：{coding_type}")
    if difficulty not in DIFFICULTIES:
        errors.append(f"无效难度：{difficulty}")
    if usage not in CODING_USAGES:
        errors.append(f"无效教学用途：{usage}")

    if not ref.strip():
        errors.append("缺少参考答案代码 reference_solution")
    elif len(ref) > 20_000:
        errors.append("参考答案代码超过 20000 字符上限")
    else:
        errors.extend(_check_python_code_safety(ref, label="参考答案代码", allow_syntax_error=False))

    if len(starter) > 20_000:
        errors.append("初始代码超过 20000 字符上限")
    elif starter.strip():
        errors.extend(_check_python_code_safety(starter, label="初始代码", allow_syntax_error=(coding_type == "debug")))

    if coding_type == "fill_code":
        _, tpl_err = extract_fill_template(starter)
        if tpl_err:
            errors.append(f"程序填空题 starter_code 无效：{tpl_err}")
        elif ref.strip():
            sk_errs = validate_fill_submission(starter, ref)
            if sk_errs:
                errors.append("程序填空题参考答案与初始模板骨架不一致：" + "；".join(sk_errs))
    elif coding_type == "debug":
        if not starter.strip():
            errors.append("程序改错题必须提供含错误的 starter_code")
        elif ref.strip() and starter.strip() == ref.strip():
            errors.append("程序改错题的 starter_code 不能与 reference_solution 完全相同")

    if len(samples) < 2:
        errors.append("公开样例 samples 至少需要 2 组")
    if len(hidden) < 3:
        errors.append("隐藏用例 hidden_cases 至少需要 3 组")
    if len(samples) + len(hidden) > 20:
        errors.append("公开样例与隐藏用例合计不能超过 20 组")

    seen_inputs: set[str] = set()
    dup_inputs = 0
    for c in [*samples, *hidden]:
        key = str(c.get("input", "")).rstrip()
        if key in seen_inputs:
            dup_inputs += 1
        seen_inputs.add(key)
    if dup_inputs > 0:
        warnings.append(f"存在 {dup_inputs} 组重复测试输入")

    exp_issue = exercises_engine.check_explanation_clean(explanation)
    if exp_issue:
        errors.append(exp_issue)
    elif len(explanation) < 15:
        warnings.append("答案解析偏短，建议审校时补充思路说明")

    return errors, warnings


def sync_and_verify_coding_item(
    item: dict[str, Any],
    *,
    runner: CodingRunner,
    alt_code: str | None = None,
    check_cancel: Callable[[], None] | None = None,
) -> tuple[bool, list[str], list[str]]:
    """Run authoritative sandbox output sync, starter non-pass check, and optional blind-solve verification."""
    errors, warnings = validate_coding_item_static(item)
    if errors:
        return False, errors, warnings

    ref_code = str(item["reference_solution"])
    starter_code = str(item.get("starter_code") or "")
    coding_type = str(item["coding_type"])
    samples: list[dict[str, str]] = item["samples"]
    hidden: list[dict[str, str]] = item["hidden_cases"]

    # Gate 1: Run reference_solution on all cases and write authoritative expected_output.
    for group_name, rows in (("sample", samples), ("hidden", hidden)):
        for idx, case in enumerate(rows, start=1):
            if check_cancel is not None:
                check_cancel()
            status, stdout, stderr, elapsed_ms = runner.run(ref_code, case["input"])
            if status != "ok":
                detail = stderr.strip()[:160] or status
                errors.append(f"参考答案在 {group_name}[{idx}] 运行失败（{status}）：{detail}")
                return False, errors, warnings
            if elapsed_ms > SLOW_CASE_WARNING_MS:
                warnings.append(f"参考答案在 {group_name}[{idx}] 耗时 {elapsed_ms} ms，接近时限")
            case["expected_output"] = stdout.replace("\r\n", "\n")

    all_cases: list[tuple[str, int, dict[str, str]]] = [
        ("sample", idx, c) for idx, c in enumerate(samples, start=1)
    ] + [
        ("hidden", idx, c) for idx, c in enumerate(hidden, start=1)
    ]

    # Gate 2: Starter code (when non-empty) must NOT already pass all cases.
    if starter_code.strip():
        total_passed = 0
        sample_passed = 0
        for scope, _, case in all_cases:
            if check_cancel is not None:
                check_cancel()
            status, stdout, _, _ = runner.run(starter_code, case["input"])
            passed = status == "ok" and same_output(stdout, case["expected_output"])
            if passed:
                total_passed += 1
                if scope == "sample":
                    sample_passed += 1
        if total_passed == len(all_cases):
            errors.append(f"starter_code 未作修改即可通过全部 {len(all_cases)} 个测试用例，题目无效")
            return False, errors, warnings
        if coding_type == "debug" and samples and sample_passed == len(samples):
            errors.append("程序改错题的 starter_code 通过了全部公开样例，请确保至少 1 个公开样例暴露 Bug")
            return False, errors, warnings

    # Gate 3: Independent blind-solve verification against all cases.
    if alt_code is not None:
        ok_alt, alt_errors = verify_blind_solution(item, alt_code, runner=runner, check_cancel=check_cancel)
        if not ok_alt:
            errors.extend(alt_errors)
            return False, errors, warnings

    return True, [], warnings


def verify_blind_solution(
    item: dict[str, Any],
    alt_code: str,
    *,
    runner: CodingRunner,
    check_cancel: Callable[[], None] | None = None,
) -> tuple[bool, list[str]]:
    """Verify an independent blind solution against every synced sample and hidden case."""
    if not alt_code.strip():
        return False, ["独立盲解返回空代码"]
    alt_safety = _check_python_code_safety(alt_code, label="盲解验证代码", allow_syntax_error=False)
    if alt_safety:
        return False, alt_safety
    coding_type = str(item.get("coding_type") or "")
    starter_code = str(item.get("starter_code") or "")
    if coding_type == "fill_code":
        fill_errs = validate_fill_submission(starter_code, alt_code)
        if fill_errs:
            return False, ["独立盲解未遵守程序填空框架：" + "；".join(fill_errs)]
    all_cases: list[tuple[str, int, dict[str, str]]] = [
        ("sample", idx, c) for idx, c in enumerate(item.get("samples") or [], start=1)
    ] + [
        ("hidden", idx, c) for idx, c in enumerate(item.get("hidden_cases") or [], start=1)
    ]
    for scope, idx, case in all_cases:
        if check_cancel is not None:
            check_cancel()
        status, stdout, stderr, _ = runner.run(alt_code, case["input"])
        if status != "ok":
            detail = stderr.strip()[:160] or status
            return False, [f"独立盲解在 {scope}[{idx}] 运行失败（{status}），题干可能存在歧义：{detail}"]
        if not same_output(stdout, case["expected_output"]):
            return False, [
                f"独立盲解在 {scope}[{idx}] 输出与参考解不一致（可能存在题干格式歧义）："
                f"期望={case['expected_output']!r}，盲解={stdout!r}"
            ]
    return True, []


def expand_coding_plan(counts: dict[str, int], *, difficulty: str = "balanced") -> list[tuple[str, str]]:
    """Expand per-coding-type counts into ordered `(coding_type, target_difficulty)` slots."""
    ordered_types: list[str] = []
    for ctype in CODING_TYPES:
        n = int(counts.get(ctype) or 0)
        if n > 0:
            ordered_types.extend([ctype] * n)
    if difficulty in DIFFICULTIES:
        return [(ctype, difficulty) for ctype in ordered_types]
    return [
        (ctype, BALANCED_DIFFICULTY_CYCLE[idx % len(BALANCED_DIFFICULTY_CYCLE)])
        for idx, ctype in enumerate(ordered_types)
    ]


def _format_knowledge_block(
    catalog: dict[str, Any] | None,
    focus_points: Sequence[dict[str, Any]] | None,
) -> str:
    if focus_points:
        lines = ["本次命题重点考查以下知识点（knowledge_points 请优先从中选用原名）："]
        for pt in focus_points:
            title = str(pt.get("title") or "").strip()
            brief = str(pt.get("brief") or "").strip()
            pages = pt.get("pages") or []
            p_str = f"（页码：{'、'.join(str(p) for p in pages[:6])}）" if pages else ""
            lines.append(f"- {title}{p_str}" + (f"：{brief}" if brief else ""))
        return "\n".join(lines)
    if not catalog or not isinstance(catalog.get("sections"), list):
        return "（本章尚未抽取结构化知识点，knowledge_points 可留空数组 []）"
    lines = ["本章可选知识点（knowledge_points 请从中选择 1–3 个原名）："]
    count = 0
    for sec in catalog["sections"]:
        for pt in sec.get("points") or []:
            title = str(pt.get("title") or "").strip()
            brief = str(pt.get("brief") or "").strip()
            if title:
                lines.append(f"- {title}" + (f"：{brief}" if brief else ""))
                count += 1
                if count >= 40:
                    return "\n".join(lines)
    return "\n".join(lines) if count else "（本章暂无结构化知识点，knowledge_points 可留空数组 []）"


def _blind_solve(llm: llm_mod.LLMClient, item: dict[str, Any]) -> str:
    samples_text = "\n".join(
        f"样例 {idx}：\n输入：\n{c['input']}\n输出：\n{c['expected_output']}"
        for idx, c in enumerate(item["samples"], start=1)
    )
    extra = ""
    if item["coding_type"] == "fill_code":
        extra = (
            "\n请严格在以下初始代码的填空区标记内补全，不要修改标记外任何一行代码：\n"
            f"```python\n{item['starter_code']}\n```\n"
        )
    elif item["coding_type"] == "debug":
        extra = f"\n以下是待修复的初始代码：\n```python\n{item['starter_code']}\n```\n"

    user_prompt = prompts.PROMPT_CODING_BLIND_SOLVE_USER.format(
        title=item["title"],
        prompt=item["prompt"],
        samples=samples_text,
        extra=extra,
    )
    data, _ = llm.chat_json(
        [
            {"role": "system", "content": prompts.PROMPT_CODING_BLIND_SOLVE_SYSTEM},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.2,
    )
    if not isinstance(data, dict):
        return ""
    return str(data.get("code") or "")


def _is_duplicate_coding(
    candidate: dict[str, Any],
    existing_pool: Sequence[tuple[str, str]],
) -> bool:
    title = str(candidate.get("title") or "").strip()
    prompt = str(candidate.get("prompt") or "").strip()
    for ex_title, ex_prompt in existing_pool:
        if title and ex_title and exercises_engine.is_near_duplicate_stem(title, ex_title, same_kind=True):
            return True
        if prompt and ex_prompt and exercises_engine.is_near_duplicate_stem(prompt, ex_prompt, same_kind=True):
            return True
    return False


def _build_repair_guidance(errors: Sequence[str], coding_type: str) -> str:
    """Turn raw sandbox/static verification errors into concrete, actionable repair instructions."""
    joined = "\n".join(str(e) for e in errors)
    tips: list[str] = []
    if "禁止调用 eval()" in joined or "禁止调用 exec()" in joined:
        tips.append(
            "关于禁止 eval()/exec()：请彻底删除所有 eval()/exec()（特别是 eval(input())），"
            "改用显式解析，如 int(input())、float(input())、input().strip() 或 map(float, input().split())，"
            "并同步确保题干【输入格式】与样例输入格式完全匹配。"
        )
    if "禁止传入提示语参数" in joined:
        tips.append("关于 input()：将所有 input('...') 替换为无参 input()。")
    if "未作修改即可通过全部" in joined or "通过了全部公开样例" in joined:
        if coding_type == "debug":
            tips.append(
                "关于改错题 starter_code 全部通过：你注入的 Bug 在当前所有测试输入上都没有触发。"
                "请保持正确的 reference_solution 不变，在 starter_code 中注入会真实改变输出或触发报错的实质性错误"
                "（例如去掉 int()/float() 转换、把 // 误写成 /、把 >= 误写成 >、切片边界差一或优先级漏括号），"
                "同时确保至少 1 组公开样例和若干隐藏用例的输入精准踩中该错误，让未修改的 starter_code 必定失败。"
            )
        else:
            tips.append(
                "关于 starter_code 直接通过：请确保 starter_code 中填空区已替换为占位符（如 pass），"
                "未补全前绝对不能通过全部测试用例。"
            )
    if "骨架不一致" in joined or "填空区" in joined:
        tips.append(
            "关于程序填空骨架：starter_code 与 reference_solution 在 `# === 填空区 N 开始 ===` 与 "
            "`# === 填空区 N 结束 ===` 标记之外的每一行必须逐字符完全一致，只替换标记内部代码。"
        )
    if "独立盲解" in joined:
        tips.append(
            "关于独立盲解不一致：说明仅看题干与公开样例容易产生多种理解（如输出小数位数、空格/换行、"
            "边界条件或四舍五入约定不够明确）。请把题干【输入格式】【输出格式】与边界规则写得毫无歧义，"
            "使任何正确实现都会产生完全一致的 stdout。"
        )
    if "运行失败" in joined:
        tips.append(
            "关于参考答案运行失败：请核对 reference_solution 的语法、输入行数/类型解析与所有样例及隐藏用例的 input 是否一一对应。"
        )
    if not tips:
        return ""
    return "\n\n针对性修复指引：\n" + "\n".join(f"{idx}. {tip}" for idx, tip in enumerate(tips, start=1))


def generate_coding_exercises_from_pages(
    pages: Sequence[dict[str, Any]],
    llm: llm_mod.LLMClient,
    runner: CodingRunner,
    *,
    counts: dict[str, int],
    chapter_label: str,
    difficulty: str = "balanced",
    usage: str = "both",
    knowledge: dict[str, Any] | None = None,
    focus_points: Sequence[dict[str, Any]] | None = None,
    existing_items: Sequence[dict[str, Any]] = (),
    allowed_syntax_note: str = "",
    enable_blind_solve: bool = True,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    on_progress: Callable[[int, int, str], None] | None = None,
    on_item: Callable[[dict[str, Any]], None] | None = None,
    check_cancel: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Generate, sandbox-verify, and incrementally emit coding questions grounded in chapter slides."""
    plan = expand_coding_plan(counts, difficulty=difficulty)
    total = len(plan)
    if total == 0:
        return {"questions": [], "warnings": [], "failures": [], "notes": ["未指定任何编程题生成数量"]}

    # Prioritize pages linked to focused knowledge points while preserving chapter-wide context.
    focus_page_nums: set[int] = set()
    for pt in focus_points or []:
        for pno in pt.get("pages") or []:
            if isinstance(pno, int) and pno > 0:
                focus_page_nums.add(pno)
    if focus_page_nums:
        ordered_pages = sorted(
            pages,
            key=lambda p: (0 if int(p.get("page_no") or 0) in focus_page_nums else 1, int(p.get("page_no") or 0)),
        )
    else:
        ordered_pages = list(pages)

    context_text = exercises_engine.build_context(ordered_pages, max_chars=MAX_CODING_CONTEXT_CHARS)
    knowledge_block = _format_knowledge_block(knowledge, focus_points)
    syntax_block = (
        f"本章节语法范围补充约束（必须严格遵守）：\n{allowed_syntax_note.strip()}\n"
        if allowed_syntax_note.strip()
        else ""
    )

    existing_pool: list[tuple[str, str]] = [
        (str(it.get("title") or "").strip(), str(it.get("stem") or "").strip())
        for it in existing_items
        if str(it.get("title") or it.get("stem") or "").strip()
    ]
    avoid_titles: list[str] = [
        (t or s.splitlines()[0][:60])
        for t, s in existing_pool[-40:]
        if (t or s)
    ]

    verified_questions: list[dict[str, Any]] = []
    all_warnings: list[str] = []
    failures: list[str] = []

    for idx, (coding_type, target_diff) in enumerate(plan, start=1):
        if check_cancel is not None:
            check_cancel()
        type_label = CODING_TYPE_LABELS[coding_type]
        if on_progress is not None:
            on_progress(idx - 1, total, f"正在生成并沙箱验题第 {idx}/{total} 题（{type_label} · {target_diff}）…")

        avoid_block = (
            "已有题目请勿重复（避免考同一背景与考点组合）：\n" + "\n".join(f"- {t}" for t in avoid_titles[-40:])
            if avoid_titles
            else ""
        )
        user_prompt = prompts.PROMPT_CODING_EXERCISE_USER.format(
            chapter_label=chapter_label,
            coding_type=coding_type,
            coding_type_label=type_label,
            difficulty=target_diff,
            usage=usage,
            type_rules=_type_specific_rules(coding_type),
            syntax_constraint=syntax_block,
            knowledge=knowledge_block,
            avoid=avoid_block,
            notes=context_text,
        )
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": prompts.PROMPT_CODING_EXERCISE_SYSTEM},
            {"role": "user", "content": user_prompt},
        ]

        last_errors: list[str] = []
        accepted_item: dict[str, Any] | None = None
        accepted_warnings: list[str] = []
        total_attempts = max(1, int(max_attempts))

        for attempt in range(total_attempts):
            if check_cancel is not None:
                check_cancel()
            is_fresh_redesign = attempt >= 3 and attempt == total_attempts - 1
            if attempt > 0 and on_progress is not None:
                stage = "换题重出" if is_fresh_redesign else "自动修复"
                on_progress(
                    idx - 1,
                    total,
                    f"第 {idx}/{total} 题未通过验题，正在{stage}（第 {attempt}/{total_attempts - 1} 次重试）…",
                )
            temp = 0.55 if is_fresh_redesign else (0.25 if attempt > 0 else 0.4)
            try:
                raw, _ = llm.chat_json(messages, temperature=temp)
            except (llm_mod.LLMFailed, llm_mod.LLMUnavailable) as exc:
                last_errors = [f"第 {attempt + 1} 轮模型调用失败：{exc}"]
                if isinstance(exc, llm_mod.LLMUnavailable):
                    raise
                continue

            item = normalize_coding_candidate(
                raw,
                coding_type=coding_type,
                difficulty=target_diff,
                usage=usage,
            )

            if _is_duplicate_coding(item, existing_pool):
                last_errors = [f"题目「{item['title'] or '未命名'}」与本章已有题目高度重复，请更换全新场景与考点"]
            else:
                # Step A: Static + sandbox reference sync + starter anti-triviality check
                ok_sync, sync_errors, sync_warnings = sync_and_verify_coding_item(
                    item,
                    runner=runner,
                    alt_code=None,
                    check_cancel=check_cancel,
                )
                if not ok_sync:
                    last_errors = sync_errors
                elif enable_blind_solve:
                    # Step B: Independent blind-solve ambiguity guard
                    if on_progress is not None:
                        on_progress(
                            idx - 1,
                            total,
                            f"正在独立盲解复验第 {idx}/{total} 题（{item['title'][:16] or type_label}）…",
                        )
                    try:
                        alt_code = _blind_solve(llm, item)
                    except llm_mod.LLMUnavailable:
                        raise
                    except llm_mod.LLMFailed as exc:
                        last_errors = [f"盲解复验调用失败：{exc}"]
                        alt_code = ""
                    else:
                        ok_alt, alt_errors = verify_blind_solution(
                            item,
                            alt_code,
                            runner=runner,
                            check_cancel=check_cancel,
                        )
                        if ok_alt:
                            accepted_item = item
                            accepted_warnings = list(dict.fromkeys(sync_warnings))
                            break
                        last_errors = alt_errors
                else:
                    accepted_item = item
                    accepted_warnings = sync_warnings
                    break

            next_attempt = attempt + 1
            if next_attempt < total_attempts:
                feedback = "\n".join(f"- {err}" for err in last_errors[:8])
                guidance = _build_repair_guidance(last_errors, coding_type)
                next_is_redesign = next_attempt >= 3 and next_attempt == total_attempts - 1
                if next_is_redesign:
                    prev_title = item.get("title") or "上一草稿"
                    messages = [
                        messages[0],
                        {
                            "role": "user",
                            "content": (
                                f"{user_prompt}\n\n"
                                f"【换题重出说明】此前构思的题目「{prev_title}」经过多次修复仍未通过自动沙箱验题，主要失败原因：\n"
                                f"{feedback}{guidance}\n\n"
                                "请彻底放弃旧题面，换一个本章内全新的、逻辑更清晰且无歧义的场景重新命制 1 道完整编程题，严格规避上述问题。"
                            ),
                        },
                    ]
                else:
                    messages = messages[:2] + [
                        {"role": "assistant", "content": json.dumps(item, ensure_ascii=False)[:10_000]},
                        {
                            "role": "user",
                            "content": (
                                f"上一轮生成的编程题未通过自动沙箱验题，问题如下：\n{feedback}{guidance}\n\n"
                                "请逐项修复后重新输出完整 JSON 对象。"
                            ),
                        },
                    ]

        if accepted_item is not None:
            verified_questions.append(accepted_item)
            existing_pool.append((accepted_item["title"], accepted_item["prompt"]))
            avoid_titles.append(accepted_item["title"])
            all_warnings.extend(f"「{accepted_item['title']}」：{w}" for w in accepted_warnings)
            if on_item is not None:
                on_item(accepted_item)
        else:
            reason = last_errors[0] if last_errors else "未通过自动验题"
            failures.append(f"第 {idx} 题（{type_label} · {target_diff}）：{reason}")

        if on_progress is not None:
            on_progress(idx, total, f"已完成第 {idx}/{total} 题校验")

    return {
        "questions": verified_questions,
        "warnings": all_warnings,
        "failures": failures,
        "notes": failures[:5],
    }
