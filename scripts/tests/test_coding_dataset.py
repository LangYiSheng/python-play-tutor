"""Unit tests for scripts.coding_dataset schema, AST guards, fill skeleton, and sandbox verifier."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.coding_dataset.sandbox import LocalPythonRunner, verify_problem
from scripts.coding_dataset.schema import (
    check_code_ast,
    to_reborn_question_payload,
    validate_fill_submission,
    validate_problem_schema,
)


def _sample_fill_problem() -> dict:
    starter = (
        "a = int(input())\n"
        "b = int(input())\n"
        "# === 填空区 1 开始 ===\n"
        "ans = 0\n"
        "# === 填空区 1 结束 ===\n"
        "print(ans)\n"
    )
    ref = (
        "a = int(input())\n"
        "b = int(input())\n"
        "# === 填空区 1 开始 ===\n"
        "ans = a + b\n"
        "# === 填空区 1 结束 ===\n"
        "print(ans)\n"
    )
    return {
        "id": "py-test-fill-01",
        "title": "两数之和填空",
        "coding_type": "fill_code",
        "difficulty": "易",
        "usage": "practice",
        "chapter_order": 2,
        "chapter_title": "Python 语言基础",
        "knowledge_points": ["运算符"],
        "tags": ["加法"],
        "prompt": "读取两行整数，输出它们的和。",
        "starter_code": starter,
        "reference_solution": ref,
        "alt_solution": "print(int(input()) + int(input()))\n",
        "hints": ["使用 + 运算符将 a 和 b 相加"],
        "explanation": "读取两个整数后使用 + 求和。",
        "samples": [
            {"input": "1\n2\n", "expected_output": "3\n"},
            {"input": "10\n-4\n", "expected_output": "6\n"},
        ],
        "hidden_cases": [
            {"input": "0\n0\n", "expected_output": "0\n"},
            {"input": "-7\n-8\n", "expected_output": "-15\n"},
            {"input": "999\n1\n", "expected_output": "1000\n"},
        ],
    }


class CodingDatasetTests(unittest.TestCase):
    def test_fill_skeleton_validation_blocks_framework_tampering(self):
        prob = _sample_fill_problem()
        self.assertEqual(validate_fill_submission(prob["starter_code"], prob["reference_solution"]), [])

        tampered = prob["reference_solution"].replace("print(ans)", "print(ans + 0)")
        errs = validate_fill_submission(prob["starter_code"], tampered)
        self.assertTrue(errs)
        self.assertIn("锁定框架", errs[0])

        two_slot = (
            "x = int(input())\n"
            "# === 填空区 1 开始 ===\na = 0\n# === 填空区 1 结束 ===\n"
            "locked = a + 1\n"
            "# === 填空区 2 开始 ===\nb = 0\n# === 填空区 2 结束 ===\n"
            "print(locked, b)\n"
        )
        bypass = (
            "x = int(input())\n"
            "# === 填空区 1 开始 ===\na = 1\n\"\"\"\n# === 填空区 1 结束 ===\n"
            "locked = a + 1\n"
            "# === 填空区 2 开始 ===\n\"\"\"\nlocked = 99\nb = 2\n# === 填空区 2 结束 ===\n"
            "print(locked, b)\n"
        )
        self.assertTrue(validate_fill_submission(two_slot, bypass))

    def test_ast_checks_catch_input_prompt_unseeded_random_and_forbidden_imports(self):
        errs, _ = check_code_ast('x = int(input("请输入:"))\nprint(x)\n')
        self.assertTrue(any("提示参数" in e for e in errs))

        errs_rand, _ = check_code_ast("import random\nprint(random.randint(1, 10))\n")
        self.assertTrue(any("random.seed" in e for e in errs_rand))

        errs_seeded, _ = check_code_ast("import random\nrandom.seed(42)\nprint(random.randint(1, 10))\n")
        self.assertEqual(errs_seeded, [])

        errs_os, _ = check_code_ast("import os\nprint(os.getcwd())\n")
        self.assertTrue(any("禁用模块" in e for e in errs_os))

        errs_open, _ = check_code_ast('f = open("a.txt")\n')
        self.assertTrue(any("open()" in e for e in errs_open))

    def test_verify_problem_passes_valid_fill_and_fails_invalid_debug(self):
        runner = LocalPythonRunner()
        prob = _sample_fill_problem()
        report = verify_problem(prob, runner=runner)
        self.assertTrue(report.ok, report.schema_errors + report.verification_errors)
        self.assertEqual(report.alt_passed, 5)
        self.assertLess(report.starter_passed, report.starter_total)

        # A debug problem whose starter_code still passes all tests must be rejected
        bad_debug = {
            **prob,
            "id": "py-test-debug-bad",
            "coding_type": "debug",
            "starter_code": "a = int(input())\nb = int(input())\nprint(a + b)  # extra comment\n",
            "reference_solution": "a = int(input())\nb = int(input())\nprint(a + b)\n",
        }
        bad_report = verify_problem(bad_debug, runner=runner)
        self.assertFalse(bad_report.ok)
        self.assertTrue(any("starter_code" in e for e in bad_report.verification_errors))

    def test_schema_enforces_20_case_limit_and_reborn_export(self):
        prob = _sample_fill_problem()
        too_many = {**prob, "hidden_cases": [{"input": "1\n1\n", "expected_output": "2\n"}] * 19}
        errs, _ = validate_problem_schema(too_many)
        self.assertTrue(any("不能超过 20 个" in e for e in errs))

        payload = to_reborn_question_payload(prob, chapter_ids=[6], knowledge_point_ids=[62], material_id=9)
        self.assertEqual(payload["kind"], "python")
        self.assertEqual(payload["source"]["coding_type"], "fill_code")
        self.assertEqual(payload["source"]["difficulty"], "易")
        self.assertEqual(payload["answer"], {"reference_solution": prob["reference_solution"]})
        self.assertEqual(payload["samples"][0], {"input": "1\n2\n", "output": "3\n"})
        self.assertEqual(payload["hidden_cases"][0], {"input": "0\n0\n", "expected_output": "0\n"})


if __name__ == "__main__":
    unittest.main()
