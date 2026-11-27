"""Isolated Python execution and verification engine for coding-question datasets.

Supports:
1. Local isolated CPython subprocess (`python -I -B`) with strict timeout and output caps.
2. Remote Pythontopia `go-judge` container (`/run`) for production parity.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from .schema import CODING_TYPE_LABELS, normalize_case, validate_problem_schema

MAX_STDOUT_CHARS = 16_384
MAX_STDERR_CHARS = 8_192
DEFAULT_TIMEOUT_SECONDS = 2.5
SLOW_CASE_WARNING_MS = 1_000


def same_output(actual: str, expected: str) -> bool:
    """Match Pythontopia go-judge & Pyodide output comparison semantics."""
    return actual.replace("\r\n", "\n").rstrip() == expected.replace("\r\n", "\n").rstrip()


@dataclass(frozen=True)
class CaseExecution:
    scope: str  # "sample" | "hidden"
    index: int
    status: str  # "accepted" | "wrong_answer" | "runtime_error" | "compile_error" | "time_limit" | "infrastructure_error"
    stdout: str
    expected: str
    stderr: str
    elapsed_ms: int


@dataclass
class ProblemVerification:
    problem_id: str
    title: str
    coding_type: str
    difficulty: str
    ok: bool
    schema_errors: list[str] = field(default_factory=list)
    verification_errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    ref_results: list[CaseExecution] = field(default_factory=list)
    starter_passed: int | None = None
    starter_total: int | None = None
    alt_passed: int | None = None
    alt_total: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.problem_id,
            "title": self.title,
            "coding_type": self.coding_type,
            "coding_type_label": CODING_TYPE_LABELS.get(self.coding_type, self.coding_type),
            "difficulty": self.difficulty,
            "ok": self.ok,
            "schema_errors": list(self.schema_errors),
            "verification_errors": list(self.verification_errors),
            "warnings": list(self.warnings),
            "ref_passed": sum(1 for r in self.ref_results if r.status == "accepted"),
            "ref_total": len(self.ref_results),
            "max_case_ms": max((r.elapsed_ms for r in self.ref_results), default=0),
            "starter_passed": self.starter_passed,
            "starter_total": self.starter_total,
            "alt_passed": self.alt_passed,
            "alt_total": self.alt_total,
        }


class CodeRunner(Protocol):
    def run(self, code: str, stdin_text: str, *, timeout_s: float = DEFAULT_TIMEOUT_SECONDS) -> tuple[str, str, str, int]:
        """Execute Python code and return `(status, stdout, stderr, elapsed_ms)`."""


def _classify_nonzero_stderr(stderr: str) -> str:
    lines = [line.strip() for line in stderr.replace("\r\n", "\n").split("\n") if line.strip()]
    last = lines[-1] if lines else ""
    if last.startswith(("SyntaxError:", "IndentationError:", "TabError:")):
        return "compile_error"
    if last.startswith("MemoryError"):
        return "memory_limit"
    return "runtime_error"


class LocalPythonRunner:
    """Isolated local CPython runner (`-I -B`) with UTF-8 stdio and wall-clock timeout."""

    def __init__(self, python_executable: str | None = None):
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


class GoJudgeRunner:
    """Remote Pythontopia go-judge runner (`/run`) for exact production verification."""

    def __init__(self, base_url: str, auth_token: str = ""):
        self.base_url = base_url.rstrip("/")
        self.auth_token = auth_token

    def run(
        self,
        code: str,
        stdin_text: str,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> tuple[str, str, str, int]:
        try:
            import httpx
        except ImportError as exc:
            raise RuntimeError("使用 go-judge 模式需要安装 httpx") from exc

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
        except Exception as exc:
            elapsed = round((time.monotonic() - start) * 1000)
            return "infrastructure_error", "", f"go-judge 调用失败：{exc}", elapsed

        elapsed = round((time.monotonic() - start) * 1000)
        if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
            return "infrastructure_error", "", "go-judge 响应格式异常", elapsed
        item = items[0]
        remote = str(item.get("status") or "")
        files = item.get("files") or {}
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


def _run_cases(
    runner: CodeRunner,
    code: str,
    cases: list[tuple[str, int, dict[str, str]]],
) -> list[CaseExecution]:
    results: list[CaseExecution] = []
    for scope, idx, case in cases:
        raw_status, stdout, stderr, elapsed_ms = runner.run(code, case["input"])
        if raw_status == "ok":
            status = "accepted" if same_output(stdout, case["expected_output"]) else "wrong_answer"
        else:
            status = raw_status
        results.append(
            CaseExecution(
                scope=scope,
                index=idx,
                status=status,
                stdout=stdout,
                expected=case["expected_output"],
                stderr=stderr,
                elapsed_ms=elapsed_ms,
            )
        )
    return results


def sync_expected_outputs(item: dict[str, Any], runner: CodeRunner | None = None) -> list[str]:
    """Run reference_solution to populate/refresh expected_output for every sample and hidden case."""
    runner = runner or LocalPythonRunner()
    ref_code = str(item.get("reference_solution") or "")
    errors: list[str] = []
    for group in ("samples", "hidden_cases"):
        rows = item.get(group)
        if not isinstance(rows, list):
            continue
        for idx, case in enumerate(rows, start=1):
            if not isinstance(case, dict):
                continue
            raw_status, stdout, stderr, _ = runner.run(ref_code, str(case.get("input", "")))
            if raw_status != "ok":
                errors.append(f"参考解在 {group}[{idx}] 运行失败（{raw_status}）：{stderr.strip()[:200]}")
            else:
                case["expected_output"] = stdout.replace("\r\n", "\n")
                case.pop("output", None)
    return errors


def verify_problem(item: dict[str, Any], runner: CodeRunner | None = None) -> ProblemVerification:
    """Run full static + dynamic verification gates on a single coding dataset item."""
    runner = runner or LocalPythonRunner()
    pid = str(item.get("id") or "<unknown>") if isinstance(item, dict) else "<invalid>"
    title = str(item.get("title") or "") if isinstance(item, dict) else ""
    coding_type = str(item.get("coding_type") or "") if isinstance(item, dict) else ""
    difficulty = str(item.get("difficulty") or "") if isinstance(item, dict) else ""

    schema_errors, warnings = validate_problem_schema(item)
    if schema_errors:
        return ProblemVerification(
            problem_id=pid,
            title=title,
            coding_type=coding_type,
            difficulty=difficulty,
            ok=False,
            schema_errors=schema_errors,
            warnings=warnings,
        )

    all_cases: list[tuple[str, int, dict[str, str]]] = [
        ("sample", i, normalize_case(c)) for i, c in enumerate(item["samples"], start=1)
    ] + [
        ("hidden", i, normalize_case(c)) for i, c in enumerate(item["hidden_cases"], start=1)
    ]

    v_errors: list[str] = []

    # 1. Reference solution must pass 100% of samples + hidden cases
    ref_results = _run_cases(runner, item["reference_solution"], all_cases)
    for r in ref_results:
        if r.status != "accepted":
            detail = r.stderr.strip()[:160] if r.stderr.strip() else f"期望={r.expected!r}，实际={r.stdout!r}"
            v_errors.append(f"参考解未通过 {r.scope}[{r.index}]（{r.status}）：{detail}")
        elif r.elapsed_ms > SLOW_CASE_WARNING_MS:
            warnings.append(f"参考解在 {r.scope}[{r.index}] 耗时 {r.elapsed_ms} ms，接近时限")

    # 2. Non-empty starter_code must NOT already pass all cases (critical for fill_code & debug)
    starter_code = str(item.get("starter_code") or "")
    starter_passed: int | None = None
    starter_total: int | None = None
    if starter_code.strip():
        starter_results = _run_cases(runner, starter_code, all_cases)
        starter_passed = sum(1 for r in starter_results if r.status == "accepted")
        starter_total = len(starter_results)
        if starter_passed == starter_total:
            v_errors.append(f"starter_code 未作修改即可通过全部 {starter_total} 个测试用例，题目无效")
        elif coding_type == "debug":
            pub_passed = sum(1 for r in starter_results if r.scope == "sample" and r.status == "accepted")
            if item["samples"] and pub_passed == len(item["samples"]):
                warnings.append("程序改错题的 starter_code 通过了全部公开样例（仅隐藏用例报错），建议至少让 1 个公开样例暴露该 Bug")

    # 3. Optional independent alternative solution must also pass 100% (ambiguity guard)
    alt_code = item.get("alt_solution")
    alt_passed: int | None = None
    alt_total: int | None = None
    if isinstance(alt_code, str) and alt_code.strip():
        alt_results = _run_cases(runner, alt_code, all_cases)
        alt_passed = sum(1 for r in alt_results if r.status == "accepted")
        alt_total = len(alt_results)
        for r in alt_results:
            if r.status != "accepted":
                detail = r.stderr.strip()[:160] if r.stderr.strip() else f"期望={r.expected!r}，实际={r.stdout!r}"
                v_errors.append(f"独立验证解 alt_solution 未通过 {r.scope}[{r.index}]（{r.status}）：{detail}")

    return ProblemVerification(
        problem_id=pid,
        title=title,
        coding_type=coding_type,
        difficulty=difficulty,
        ok=not v_errors,
        schema_errors=[],
        verification_errors=v_errors,
        warnings=warnings,
        ref_results=ref_results,
        starter_passed=starter_passed,
        starter_total=starter_total,
        alt_passed=alt_passed,
        alt_total=alt_total,
    )


def verify_dataset(
    problems: list[dict[str, Any]],
    runner: CodeRunner | None = None,
) -> tuple[list[ProblemVerification], list[str]]:
    """Verify every problem in a dataset plus dataset-level uniqueness checks."""
    runner = runner or LocalPythonRunner()
    dataset_errors: list[str] = []
    seen_ids: set[str] = set()
    reports: list[ProblemVerification] = []

    for idx, item in enumerate(problems, start=1):
        pid = str(item.get("id") or f"row-{idx}") if isinstance(item, dict) else f"row-{idx}"
        if pid in seen_ids:
            dataset_errors.append(f"数据集存在重复题目 ID：{pid}")
        seen_ids.add(pid)
        reports.append(verify_problem(item, runner=runner))

    return reports, dataset_errors
