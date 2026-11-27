"""Course-aligned LLM coding-question generator with sandbox execution & blind-solve verification."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .sandbox import CodeRunner, LocalPythonRunner, sync_expected_outputs, verify_problem
from .schema import CODING_TYPE_LABELS, CODING_TYPES, DIFFICULTIES

_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)\s*```", re.IGNORECASE)


@dataclass(frozen=True)
class ChapterContext:
    chapter_id: int
    order_index: int
    title: str
    material_id: int | None
    knowledge_points: list[dict[str, str]]
    slides_excerpt: str


def load_chapter_context_from_db(
    db_path: str | Path,
    chapter_order: int,
    *,
    course_id: int | None = None,
    max_chars: int = 12_000,
) -> ChapterContext:
    """Load chapter metadata, knowledge points, and curated slide texts from a Pythontopia SQLite DB."""
    path = Path(db_path)
    if not path.is_file():
        raise FileNotFoundError(f"找不到课程数据库：{path}")
    con = sqlite3.connect(str(path))
    try:
        cur = con.cursor()
        if course_id is not None:
            row = cur.execute(
                "SELECT id, order_index, title FROM chapters WHERE course_instance_id = ? AND order_index = ? AND deleted_at IS NULL ORDER BY id LIMIT 1",
                (course_id, chapter_order),
            ).fetchone()
        else:
            row = cur.execute(
                "SELECT id, order_index, title FROM chapters WHERE order_index = ? AND deleted_at IS NULL ORDER BY id LIMIT 1",
                (chapter_order,),
            ).fetchone()
        if not row:
            raise ValueError(f"数据库中找不到第 {chapter_order} 章")
        chapter_id, order_index, ch_title = int(row[0]), int(row[1]), str(row[2])

        kps: list[dict[str, str]] = []
        for kp_row in cur.execute(
            "SELECT title, content FROM knowledge_points WHERE chapter_id = ? AND deleted_at IS NULL ORDER BY id",
            (chapter_id,),
        ):
            meta = json.loads(kp_row[1]) if kp_row[1] else {}
            cs = meta.get("course_studio") if isinstance(meta, dict) else {}
            cs = cs if isinstance(cs, dict) else {}
            kps.append(
                {
                    "title": str(kp_row[0]),
                    "section": str(cs.get("section") or ""),
                    "brief": str(cs.get("brief") or ""),
                }
            )

        mat_row = cur.execute(
            """
            SELECT m.id FROM materials m
            JOIN material_chapters mc ON mc.material_id = m.id
            WHERE mc.chapter_id = ? AND m.deleted_at IS NULL
            ORDER BY m.id LIMIT 1
            """,
            (chapter_id,),
        ).fetchone()
        material_id = int(mat_row[0]) if mat_row else None

        parts: list[str] = []
        used = 0
        if material_id is not None:
            for pno, ptitle, text in cur.execute(
                "SELECT page_no, title, text FROM page_contents WHERE material_id = ? ORDER BY page_no",
                (material_id,),
            ):
                snippet = f"[p{pno} {ptitle or ''}]\n{str(text or '').strip()}"
                if not str(text or "").strip():
                    continue
                if used + len(snippet) > max_chars:
                    break
                parts.append(snippet)
                used += len(snippet) + 2

        return ChapterContext(
            chapter_id=chapter_id,
            order_index=order_index,
            title=ch_title,
            material_id=material_id,
            knowledge_points=kps,
            slides_excerpt="\n\n".join(parts),
        )
    finally:
        con.close()


def extract_json_object(raw: str) -> dict[str, Any]:
    """Extract a JSON object from raw LLM output (supports markdown fenced JSON)."""
    text = raw.strip()
    m = _JSON_FENCE_RE.search(text)
    if m:
        text = m.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("模型响应中未找到有效 JSON 对象")
    data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("模型响应顶层必须为 JSON 对象")
    return data


class OpenAICompatClient:
    """Minimal stdlib OpenAI-compatible chat completion client (zero extra dependencies)."""

    def __init__(self, base_url: str, api_key: str, model: str, *, timeout_s: int = 120):
        if not base_url or not api_key or not model:
            raise ValueError("请配置 CODING_LLM_BASE_URL、CODING_LLM_API_KEY 和 CODING_LLM_MODEL（或 OPENAI_*）")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout_s = timeout_s

    @classmethod
    def from_env(cls) -> OpenAICompatClient:
        base_url = os.getenv("CODING_LLM_BASE_URL") or os.getenv("OPENAI_BASE_URL") or ""
        api_key = os.getenv("CODING_LLM_API_KEY") or os.getenv("OPENAI_API_KEY") or ""
        model = os.getenv("CODING_LLM_MODEL") or os.getenv("OPENAI_MODEL") or ""
        return cls(base_url, api_key, model)

    def chat_json(self, messages: list[dict[str, str]], *, temperature: float = 0.4) -> dict[str, Any]:
        url = f"{self.base_url}/chat/completions"
        body = json.dumps(
            {
                "model": self.model,
                "messages": messages,
                "temperature": temperature,
                "response_format": {"type": "json_object"},
            },
            ensure_ascii=False,
        ).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
            raise RuntimeError(f"LLM 请求失败 HTTP {exc.code}：{detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"LLM 网络请求失败：{exc.reason}") from exc

        choices = payload.get("choices") or []
        content = choices[0]["message"]["content"] if choices else ""
        return extract_json_object(str(content or ""))


_SYSTEM_PROMPT = """你是高校 Python 程序设计课程的资深命题专家，正在为 Pythontopia 教学系统编写高质量编程题。

核心硬性约束（违反任意一条将被自动拒收）：
1. 严禁超纲：只允许使用当前章节课件中已讲解过的语法和标准库（若本章尚未讲授 if/for/while/def，则严禁在参考解和初始代码中使用它们）。
2. 标准输入输出：所有输入来自 stdin（使用 input()，绝对不能写 input("提示语") 等带提示参数的写法！），所有输出打到 stdout（print()）。
3. 沙箱可复现：严禁读写本地文件 open()、严禁第三方库（如 numpy/tkinter）、严禁使用当前时间；若使用 random 模块，必须在题干约定并由代码调用 random.seed(...) 固定种子。
4. 题干 100% 自包含：明确给出输入格式、处理规则、输出格式（包括小数位数、空格、大小写），绝不出现“见课件第 X 页 / 如图所示”。
5. 用例完整：给出 3–4 组公开样例 samples 和 5–8 组隐藏用例 hidden_cases（合计不超过 20 组），覆盖常规、零值、边界与特殊情况。
6. 必须仅输出一个合法 JSON 对象，不要附加任何解释文字。"""


def _type_specific_instruction(coding_type: str) -> str:
    if coding_type == "fill_code":
        return (
            "题型要求【程序填空 fill_code】：\n"
            "- 先编写完整、可运行、逻辑严谨的 reference_solution；\n"
            "- 将其中 1–2 段最核心的逻辑用如下成对注释标记括起来：\n"
            "  # === 填空区 1 开始 ===\n"
            "  ...\n"
            "  # === 填空区 1 结束 ===\n"
            "- reference_solution 中保留这些起止标记及正确的核心代码；\n"
            "- starter_code 与 reference_solution 在标记之外的每一行必须完全一致，仅将标记内的核心代码替换为 `pass  # 请在此补全代码` 或注释占位；\n"
            "- 注意：程序填空题同样可以考高难度核心逻辑（如复杂表达式、位权展开、模运算偏移等），不要把填空等同于简单题。"
        )
    if coding_type == "debug":
        return (
            "题型要求【程序改错 debug】：\n"
            "- 先编写完整可运行的 reference_solution；\n"
            "- 在其基础上定向注入 1–2 处本章节初学者最常犯的真实错误（如类型未转换、运算符优先级、边界差一、切片端点遗漏、ASCII 偏移错误、format 槽位错位等）生成 starter_code；\n"
            "- 必须确保 starter_code 在至少 1 个公开样例上运行失败或输出错误；\n"
            "- 题干清晰说明程序本应实现的功能，以及是否提示错误数量（易/中可说明有几处错误，难可不提示具体位置）。"
        )
    return (
        "题型要求【程序设计 design】：\n"
        "- 学生需要独立编写完整程序，starter_code 留空字符串 \"\" 或仅保留 1–2 行简洁注释；\n"
        "- 题干必须把输入行数、每行数据类型与输出格式写得毫无歧义。"
    )


def _build_generation_prompt(
    ctx: ChapterContext,
    *,
    problem_id: str,
    coding_type: str,
    difficulty: str,
    usage: str,
    avoid_titles: list[str],
    allowed_syntax_note: str = "",
) -> str:
    kp_lines = "\n".join(
        f"- {kp['title']}" + (f"（{kp['brief']}）" if kp["brief"] else "")
        for kp in ctx.knowledge_points
    )
    avoid_block = (
        "\n已有题目请勿重复（避免考同一场景）：\n" + "\n".join(f"- {t}" for t in avoid_titles)
        if avoid_titles
        else ""
    )
    syntax_block = f"\n本章节语法范围补充约束：{allowed_syntax_note}\n" if allowed_syntax_note else ""
    return f"""请为「第 {ctx.order_index} 章 · {ctx.title}」命制 1 道编程题：
- 题目 ID：{problem_id}
- 题型：{CODING_TYPE_LABELS[coding_type]}（coding_type = "{coding_type}"）
- 难度：{difficulty}（注意：难度独立于题型，请真正体现「{difficulty}」的思维复杂度）
- 用途：{usage}
{syntax_block}
{_type_specific_instruction(coding_type)}

本章可选知识点（knowledge_points 请从中选择 1–3 个原名）：
{kp_lines}
{avoid_block}

参考课件摘录（严格不超纲）：
{ctx.slides_excerpt[:8000]}

请严格输出如下 JSON 结构：
{{
  "id": "{problem_id}",
  "title": "简短明确的题目标题",
  "coding_type": "{coding_type}",
  "difficulty": "{difficulty}",
  "usage": "{usage}",
  "chapter_order": {ctx.order_index},
  "chapter_title": "{ctx.title}",
  "knowledge_points": ["知识点原名1"],
  "tags": ["考点标签1", "考点标签2"],
  "source_page": 1,
  "provenance": "ai_synthesized",
  "prompt": "完整自包含题干，含【题目描述】【输入格式】【输出格式】",
  "starter_code": "...",
  "reference_solution": "...",
  "hints": ["提示1（方向引导）", "提示2（关键思路，不直接给完整答案）"],
  "explanation": "清晰解析解题思路与易错点",
  "samples": [{{"input": "...", "expected_output": "..."}}],
  "hidden_cases": [{{"input": "...", "expected_output": "..."}}]
}}"""


def blind_solve(client: OpenAICompatClient, item: dict[str, Any]) -> str:
    """Ask the LLM to solve the problem seeing ONLY prompt + public samples (+ fill skeleton) to catch ambiguity."""
    samples_text = "\n".join(
        f"样例 {i}:\n输入:\n{c.get('input', '')}\n输出:\n{c.get('expected_output', c.get('output', ''))}"
        for i, c in enumerate(item.get("samples") or [], start=1)
    )
    extra = ""
    if item.get("coding_type") == "fill_code":
        extra = f"\n请严格在以下初始代码的填空区标记内补全，不要修改标记外任何代码：\n```python\n{item.get('starter_code', '')}\n```"
    elif item.get("coding_type") == "debug":
        extra = f"\n以下是待修正的初始代码：\n```python\n{item.get('starter_code', '')}\n```"
    messages = [
        {
            "role": "system",
            "content": "你是 Python 答题验证器。请仅依据题干和公开样例编写正确 Python 代码，严禁在 input() 中传入提示语。仅输出 JSON：{\"code\": \"...\"}。",
        },
        {
            "role": "user",
            "content": f"题目：{item.get('title', '')}\n\n{item.get('prompt', '')}\n\n{samples_text}{extra}",
        },
    ]
    data = client.chat_json(messages, temperature=0.2)
    return str(data.get("code") or "")


def generate_verified_problem(
    client: OpenAICompatClient,
    ctx: ChapterContext,
    *,
    problem_id: str,
    coding_type: str,
    difficulty: str,
    usage: str = "both",
    avoid_titles: list[str] | None = None,
    allowed_syntax_note: str = "",
    runner: CodeRunner | None = None,
    enable_blind_solve: bool = True,
    max_attempts: int = 2,
) -> tuple[dict[str, Any] | None, list[str]]:
    """Generate one coding problem and pass it through sandbox output sync + blind-solve + verification gates."""
    if coding_type not in CODING_TYPES or difficulty not in DIFFICULTIES:
        raise ValueError(f"无效题型或难度：{coding_type} / {difficulty}")
    runner = runner or LocalPythonRunner()
    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {
            "role": "user",
            "content": _build_generation_prompt(
                ctx,
                problem_id=problem_id,
                coding_type=coding_type,
                difficulty=difficulty,
                usage=usage,
                avoid_titles=list(avoid_titles or []),
                allowed_syntax_note=allowed_syntax_note,
            ),
        },
    ]

    last_errors: list[str] = []
    for attempt in range(max_attempts):
        try:
            item = client.chat_json(messages)
        except Exception as exc:
            last_errors = [f"第 {attempt + 1} 轮模型输出解析失败：{exc}"]
            continue

        item["id"] = problem_id
        item["coding_type"] = coding_type
        item["difficulty"] = difficulty
        item["usage"] = usage
        item["chapter_order"] = ctx.order_index
        item["chapter_title"] = ctx.title
        item["provenance"] = "ai_synthesized"

        # Gate 1: Run reference_solution in sandbox to compute authoritative expected_output
        sync_errs = sync_expected_outputs(item, runner=runner)
        if sync_errs:
            last_errors = sync_errs
        else:
            # Gate 2: Optional independent blind solve to catch prompt ambiguity
            blind_failed = False
            if enable_blind_solve:
                try:
                    alt = blind_solve(client, item)
                    if not alt.strip():
                        raise ValueError("盲解返回空代码")
                    item["alt_solution"] = alt
                except Exception as exc:
                    item.pop("alt_solution", None)
                    last_errors = [f"盲解校验调用失败：{exc}"]
                    blind_failed = True

            # Gate 3: Full static + dynamic verification
            if not blind_failed:
                report = verify_problem(item, runner=runner)
                if report.ok:
                    return item, report.warnings
                last_errors = report.schema_errors + report.verification_errors

        if attempt + 1 < max_attempts:
            feedback = "\n".join(f"- {e}" for e in last_errors[:10])
            messages = messages[:2] + [
                {"role": "assistant", "content": json.dumps(item, ensure_ascii=False)[:6000]},
                {
                    "role": "user",
                    "content": f"上一轮生成的题目未通过自动验题，问题如下：\n{feedback}\n\n请修复全部问题后重新输出完整 JSON。",
                },
            ]

    return None, last_errors
