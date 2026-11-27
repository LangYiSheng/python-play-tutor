"""CLI entrypoints for verifying, previewing, generating, and exporting coding datasets."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from .generator import OpenAICompatClient, generate_verified_problem, load_chapter_context_from_db
from .sandbox import GoJudgeRunner, LocalPythonRunner, ProblemVerification, verify_dataset
from .schema import (
    CODING_TYPE_LABELS,
    CODING_TYPES,
    DATASET_SCHEMA_VERSION,
    DIFFICULTIES,
    to_reborn_question_payload,
)


def load_dataset(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Load dataset from `.json` (object with `problems` or raw list) or `.jsonl`."""
    raw = path.read_text(encoding="utf-8").strip()
    if path.suffix.lower() == ".jsonl":
        items = [json.loads(line) for line in raw.splitlines() if line.strip()]
        return {"schema_version": DATASET_SCHEMA_VERSION}, items
    data = json.loads(raw)
    if isinstance(data, list):
        return {"schema_version": DATASET_SCHEMA_VERSION}, data
    if isinstance(data, dict) and isinstance(data.get("problems"), list):
        meta = {k: v for k, v in data.items() if k != "problems"}
        return meta, data["problems"]
    raise ValueError("数据集文件必须为题目列表或包含 problems 数组的 JSON 对象")


def render_review_markdown(
    problems: list[dict[str, Any]],
    reports: list[ProblemVerification],
    dataset_errors: list[str],
    *,
    dataset_name: str = "",
) -> str:
    """Render a teacher-friendly Markdown review & verification report."""
    passed = sum(1 for r in reports if r.ok)
    total = len(reports)
    matrix: Counter[tuple[str, str]] = Counter()
    chapter_counts: Counter[str] = Counter()
    kp_set: set[str] = set()
    for p in problems:
        matrix[(str(p.get("coding_type", "")), str(p.get("difficulty", "")))] += 1
        ch_label = f"第 {p.get('chapter_order', '?')} 章 · {p.get('chapter_title', '')}".strip()
        chapter_counts[ch_label] += 1
        for kp in p.get("knowledge_points") or []:
            kp_set.add(str(kp))

    lines: list[str] = [
        f"# 编程题数据集审阅与验题报告{f' — {dataset_name}' if dataset_name else ''}",
        "",
        "## 一、总体概览",
        "",
        f"- 题目总数：**{total}** 道，验题通过：**{passed} / {total}** 道",
        f"- 覆盖知识点：**{len(kp_set)}** 个",
        f"- 章节分布：{'；'.join(f'{k}（{v} 道）' for k, v in chapter_counts.items())}",
    ]
    if dataset_errors:
        lines.append("- **数据集级错误**：")
        lines.extend(f"  - {e}" for e in dataset_errors)

    lines.extend(
        [
            "",
            "## 二、题型 × 难度分布矩阵",
            "",
            "| 题型 | 易 | 中 | 难 | 合计 |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for ctype in CODING_TYPES:
        row_counts = [matrix[(ctype, d)] for d in DIFFICULTIES]
        lines.append(
            f"| {CODING_TYPE_LABELS[ctype]} (`{ctype}`) | {row_counts[0]} | {row_counts[1]} | {row_counts[2]} | **{sum(row_counts)}** |"
        )
    diff_totals = [sum(matrix[(c, d)] for c in CODING_TYPES) for d in DIFFICULTIES]
    lines.append(f"| **合计** | **{diff_totals[0]}** | **{diff_totals[1]}** | **{diff_totals[2]}** | **{sum(diff_totals)}** |")

    lines.extend(
        [
            "",
            "## 三、逐题验题汇总",
            "",
            "| ID | 章节 | 题型 | 难度 | 用途 | 标题 | 参考解 | 初始代码(必败) | 独立验证解 | 最大耗时 | 状态 |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- |",
        ]
    )
    for p, r in zip(problems, reports, strict=True):
        ch = f"第{p.get('chapter_order', '?')}章"
        ref_stat = f"{sum(1 for x in r.ref_results if x.status == 'accepted')}/{len(r.ref_results)}"
        st_stat = "-" if r.starter_total is None else f"{r.starter_passed}/{r.starter_total}"
        alt_stat = "-" if r.alt_total is None else f"{r.alt_passed}/{r.alt_total}"
        max_ms = max((x.elapsed_ms for x in r.ref_results), default=0)
        status_txt = "PASS" if r.ok else "FAIL"
        lines.append(
            f"| `{r.problem_id}` | {ch} | {CODING_TYPE_LABELS.get(r.coding_type, r.coding_type)} | {r.difficulty} | "
            f"`{p.get('usage', 'both')}` | {r.title} | {ref_stat} | {st_stat} | {alt_stat} | {max_ms} ms | **{status_txt}** |"
        )

    lines.extend(["", "## 四、逐题内容详情（供教学审校）", ""])
    for idx, (p, r) in enumerate(zip(problems, reports, strict=True), start=1):
        ctype_label = CODING_TYPE_LABELS.get(str(p.get("coding_type", "")), str(p.get("coding_type", "")))
        kps = "、".join(p.get("knowledge_points") or [])
        lines.extend(
            [
                f"### {idx}. [{ctype_label} · {p.get('difficulty', '')}] {p.get('title', '')} (`{p.get('id', '')}`)",
                "",
                f"- **章节**：第 {p.get('chapter_order', '?')} 章 · {p.get('chapter_title', '')}　|　**知识点**：{kps}　|　**用途**：`{p.get('usage', 'both')}`",
            ]
        )
        if r.schema_errors or r.verification_errors:
            lines.append("- **错误**：" + "；".join(r.schema_errors + r.verification_errors))
        if r.warnings:
            lines.append("- **提示**：" + "；".join(r.warnings))
        lines.extend(["", "**题干**", "", str(p.get("prompt", "")).strip(), ""])
        if str(p.get("starter_code", "")).strip():
            lines.extend(["**初始代码 (`starter_code`)**", "", "```python", str(p["starter_code"]).rstrip(), "```", ""])
        lines.extend(["**参考答案 (`reference_solution`)**", "", "```python", str(p.get("reference_solution", "")).rstrip(), "```", ""])
        if p.get("hints"):
            lines.append("**分步提示**")
            lines.extend(f"{i}. {h}" for i, h in enumerate(p["hints"], start=1))
            lines.append("")
        if p.get("explanation"):
            lines.extend([f"**解析**：{p['explanation']}", ""])
        lines.append(
            f"**测试用例**：公开样例 {len(p.get('samples') or [])} 组 + 隐藏用例 {len(p.get('hidden_cases') or [])} 组"
        )
        for i, s in enumerate(p.get("samples") or [], start=1):
            inp = str(s.get("input", "")).replace("\n", "\\n")
            out = str(s.get("expected_output", s.get("output", ""))).replace("\n", "\\n")
            lines.append(f"- 公开样例 {i}：`{inp}` → `{out}`")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def _build_runner(args: argparse.Namespace):
    if getattr(args, "go_judge_url", ""):
        return GoJudgeRunner(args.go_judge_url, getattr(args, "go_judge_token", ""))
    return LocalPythonRunner()


def cmd_verify(args: argparse.Namespace) -> int:
    path = Path(args.dataset)
    meta, problems = load_dataset(path)
    runner = _build_runner(args)
    reports, dataset_errors = verify_dataset(problems, runner=runner)

    ok_count = sum(1 for r in reports if r.ok)
    print(f"验题完成：{ok_count}/{len(reports)} 道通过（数据集错误：{len(dataset_errors)}）")
    for err in dataset_errors:
        print(f"  [DATASET ERROR] {err}")
    for r in reports:
        flag = "PASS" if r.ok else "FAIL"
        ctype = CODING_TYPE_LABELS.get(r.coding_type, r.coding_type)
        print(
            f"  [{flag}] {r.problem_id} | {ctype}·{r.difficulty} | {r.title} "
            f"(ref={sum(1 for x in r.ref_results if x.status == 'accepted')}/{len(r.ref_results)}, "
            f"starter={r.starter_passed}/{r.starter_total}, alt={r.alt_passed}/{r.alt_total})"
        )
        for err in r.schema_errors + r.verification_errors:
            print(f"         ERROR: {err}")
        for warn in r.warnings:
            print(f"         WARN : {warn}")

    if args.report:
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        md = render_review_markdown(problems, reports, dataset_errors, dataset_name=str(meta.get("name") or path.stem))
        report_path.write_text(md, encoding="utf-8")
        print(f"审阅报告已写入：{report_path}")

    if args.json_report:
        jpath = Path(args.json_report)
        jpath.parent.mkdir(parents=True, exist_ok=True)
        jpath.write_text(
            json.dumps(
                {
                    "ok": ok_count == len(reports) and not dataset_errors,
                    "passed": ok_count,
                    "total": len(reports),
                    "dataset_errors": dataset_errors,
                    "items": [r.to_dict() for r in reports],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"JSON 验题报告已写入：{jpath}")

    return 0 if (ok_count == len(reports) and not dataset_errors) else 1


def cmd_export_reborn(args: argparse.Namespace) -> int:
    path = Path(args.dataset)
    _, problems = load_dataset(path)
    runner = _build_runner(args)
    reports, dataset_errors = verify_dataset(problems, runner=runner)
    if dataset_errors or any(not r.ok for r in reports):
        print("数据集存在未通过验题的题目，拒绝导出 Reborn 导入包。", file=sys.stderr)
        return 1

    chapter_by_order: dict[int, int] = {}
    material_by_chapter: dict[int, int] = {}
    kp_by_chapter_title: dict[tuple[int, str], int] = {}
    if args.db:
        con = sqlite3.connect(str(args.db))
        try:
            cur = con.cursor()
            if args.course_id is not None:
                ch_rows = cur.execute(
                    "SELECT id, order_index FROM chapters WHERE course_instance_id = ? AND deleted_at IS NULL",
                    (args.course_id,),
                )
            else:
                ch_rows = cur.execute("SELECT id, order_index FROM chapters WHERE deleted_at IS NULL ORDER BY id")
            for cid, order_idx in ch_rows:
                chapter_by_order.setdefault(int(order_idx), int(cid))
            valid_cids = set(chapter_by_order.values())
            for mid, cid in cur.execute(
                "SELECT m.id, mc.chapter_id FROM materials m JOIN material_chapters mc ON mc.material_id=m.id WHERE m.deleted_at IS NULL ORDER BY m.id"
            ):
                if int(cid) in valid_cids:
                    material_by_chapter.setdefault(int(cid), int(mid))
            for kpid, cid, ktitle in cur.execute(
                "SELECT id, chapter_id, title FROM knowledge_points WHERE deleted_at IS NULL ORDER BY id"
            ):
                if int(cid) in valid_cids:
                    kp_by_chapter_title.setdefault((int(cid), str(ktitle).strip()), int(kpid))
        finally:
            con.close()

    exported: list[dict[str, Any]] = []
    for item in problems:
        order = int(item.get("chapter_order") or 0)
        cid = chapter_by_order.get(order)
        chapter_ids = [cid] if cid is not None else []
        kp_ids = (
            [kp_by_chapter_title[(cid, str(t).strip())] for t in item.get("knowledge_points") or [] if (cid, str(t).strip()) in kp_by_chapter_title]
            if cid is not None
            else []
        )
        mat_id = material_by_chapter.get(cid) if cid is not None else None
        exported.append(
            to_reborn_question_payload(
                item,
                chapter_ids=chapter_ids,
                knowledge_point_ids=kp_ids,
                material_id=mat_id,
                status=args.status,
            )
        )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(exported, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已导出 {len(exported)} 道 Reborn 兼容题目载荷至：{out_path}")
    return 0


def _parse_plan(spec: str) -> list[tuple[str, str]]:
    """Parse `--plan fill_code:易=1,debug:中=2,design:难=1` into ordered (coding_type, difficulty) pairs."""
    plan: list[tuple[str, str]] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        left, _, count_str = part.partition("=")
        ctype, _, diff = left.partition(":")
        ctype = ctype.strip()
        diff = diff.strip()
        count = int(count_str.strip() or "1")
        if ctype not in CODING_TYPES or diff not in DIFFICULTIES or count < 1:
            raise ValueError(f"无效配额项：{part}")
        plan.extend([(ctype, diff)] * count)
    return plan


def cmd_generate(args: argparse.Namespace) -> int:
    ctx = load_chapter_context_from_db(args.db, args.chapter, course_id=args.course_id)
    plan = _parse_plan(args.plan)
    client = OpenAICompatClient.from_env()
    runner = _build_runner(args)

    generated: list[dict[str, Any]] = []
    failures: list[str] = []
    avoid_titles: list[str] = []

    for idx, (ctype, diff) in enumerate(plan, start=1):
        pid = f"py-ch{ctx.order_index:02d}-gen-{idx:02d}"
        print(f"[{idx}/{len(plan)}] 正在生成并验题：{pid} ({CODING_TYPE_LABELS[ctype]}·{diff}) ...")
        item, notes = generate_verified_problem(
            client,
            ctx,
            problem_id=pid,
            coding_type=ctype,
            difficulty=diff,
            usage=args.usage,
            avoid_titles=avoid_titles,
            allowed_syntax_note=args.syntax_note,
            runner=runner,
            enable_blind_solve=not args.no_blind_solve,
        )
        if item is not None:
            generated.append(item)
            avoid_titles.append(item["title"])
            print(f"  -> 通过：{item['title']}")
        else:
            failures.append(f"{pid} ({ctype}·{diff}): {'; '.join(notes)}")
            print(f"  -> 丢弃：{'; '.join(notes)}")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": DATASET_SCHEMA_VERSION,
        "name": f"第{ctx.order_index}章 {ctx.title} AI 生成编程题集",
        "chapter_order": ctx.order_index,
        "chapter_title": ctx.title,
        "problems": generated,
        "failed_slots": failures,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"生成完成：成功 {len(generated)}/{len(plan)} 道，已写入 {out_path}")
    return 0 if generated else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m scripts.coding_dataset", description="Pythontopia 编程题数据集工具")
    sub = parser.add_subparsers(dest="command", required=True)

    p_verify = sub.add_parser("verify", help="静态 + 沙箱动态验题，并可选生成审阅报告")
    p_verify.add_argument("dataset", help="数据集 .json 或 .jsonl 路径")
    p_verify.add_argument("--report", help="输出 Markdown 审阅报告路径")
    p_verify.add_argument("--json-report", help="输出 JSON 验题结果路径")
    p_verify.add_argument("--go-judge-url", default="", help="可选：使用 Pythontopia go-judge 服务地址")
    p_verify.add_argument("--go-judge-token", default="", help="可选：go-judge Bearer 令牌")
    p_verify.set_defaults(func=cmd_verify)

    p_exp = sub.add_parser("export-reborn", help="验题并导出为 Pythontopia QuestionInput 兼容 JSON")
    p_exp.add_argument("dataset", help="数据集 .json 或 .jsonl 路径")
    p_exp.add_argument("--out", required=True, help="导出 JSON 文件路径")
    p_exp.add_argument("--db", default="", help="可选：本地 SQLite 课程库路径，用于自动映射章节与知识点 ID")
    p_exp.add_argument("--course-id", type=int, default=None, help="可选：多课程数据库时指定 course_instance_id")
    p_exp.add_argument("--status", default="draft", choices=("draft", "ready"), help="导出题目初始状态（默认 draft）")
    p_exp.add_argument("--go-judge-url", default="")
    p_exp.add_argument("--go-judge-token", default="")
    p_exp.set_defaults(func=cmd_export_reborn)

    p_gen = sub.add_parser("generate", help="基于课程库章节课件调用 LLM 批量生成并沙箱验题")
    p_gen.add_argument("--db", required=True, help="本地 SQLite 课程库路径")
    p_gen.add_argument("--course-id", type=int, default=None, help="可选：多课程数据库时指定 course_instance_id")
    p_gen.add_argument("--chapter", required=True, type=int, help="章节顺序号（order_index）")
    p_gen.add_argument(
        "--plan",
        default="fill_code:易=1,fill_code:中=1,fill_code:难=1,debug:易=1,debug:中=1,debug:难=1,design:易=1,design:中=1,design:难=1",
        help="生成配额，例如 fill_code:易=1,debug:中=1,design:难=1",
    )
    p_gen.add_argument("--usage", default="both", choices=("practice", "assessment", "both"))
    p_gen.add_argument("--syntax-note", default="", help="额外语法边界约束（例如：本章尚未讲授 if/for/while）")
    p_gen.add_argument("--no-blind-solve", action="store_true", help="跳过独立盲解交叉验证")
    p_gen.add_argument("--out", required=True, help="输出数据集 JSON 路径")
    p_gen.add_argument("--go-judge-url", default="")
    p_gen.add_argument("--go-judge-token", default="")
    p_gen.set_defaults(func=cmd_generate)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
