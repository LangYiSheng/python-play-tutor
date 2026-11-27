"""Backend tests for Phase 3 Course Studio AI coding-question generation and sandbox verification."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sqlalchemy import select

from app import config
from app.auth import hash_password, issue
from app.content_relations import set_material_chapters
from app.course_content.presentation import public_question
from app.course_studio import exercise_service
from app.course_studio import jobs as course_studio_jobs
from app.course_studio.engine import coding_exercises as coding_engine
from app.course_studio.engine import llm as studio_llm
from app.models import Chapter, KnowledgePoint, Material, Question, QuestionSecret, User
from app.narration.models import PageContent
from app.practice_rules import candidate_pool


def _coding_material(db: Any, instance_id: int, chapter_id: int, teacher_id: int) -> Material:
    mat = Material(
        course_instance_id=instance_id,
        stable_id="studio-coding-mat-1",
        owner_id=teacher_id,
        title="第二章 顺序结构与表达式",
        kind="presentation",
        status="ready",
        content={
            "library_available": True,
            "pages": [
                {"id": 1, "page_no": 1, "title": "封面", "text": "第二章 Python 语言基础"},
                {"id": 2, "page_no": 2, "title": "输入与算术", "text": "2.1 input()、int() 与 // % 整除取余运算"},
                {"id": 3, "page_no": 3, "title": "字符串切片", "text": "2.2 字符串切片、strip() 与格式化输出"},
            ],
        },
    )
    db.add(mat)
    db.flush()
    set_material_chapters(db, mat.id, [chapter_id])
    db.add(PageContent(material_id=mat.id, page_no=2, title="2.1 算术运算", text="使用 input() 读入数据，用 int() 转换并用 // 与 % 拆位。"))
    db.commit()
    return mat


def test_coding_generate_end_to_end_sandbox_sync_blind_solve_and_isolation(
    client, db, teacher, classroom, monkeypatch
) -> None:
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    monkeypatch.setenv("REBORN_AUTHORING_AI_MODEL", "deepseek-chat")
    monkeypatch.delenv("REBORN_GO_JUDGE_URL", raising=False)
    instance_id = db.info["fixture_course_instance_id"]
    chapter = db.scalar(select(Chapter).where(Chapter.course_instance_id == instance_id).order_by(Chapter.id))
    mat = _coding_material(db, instance_id, chapter.id, teacher["id"])
    kp = db.scalar(
        select(KnowledgePoint).where(
            KnowledgePoint.course_instance_id == instance_id,
            KnowledgePoint.chapter_id == chapter.id,
        )
    )

    fill_starter = (
        "n = int(input())\n"
        "# === 填空区 1 开始 ===\n"
        "s = 0\n"
        "# === 填空区 1 结束 ===\n"
        "print(s)\n"
    )
    fill_ref = (
        "n = int(input())\n"
        "# === 填空区 1 开始 ===\n"
        "s = n // 100 + (n // 10) % 10 + n % 10\n"
        "# === 填空区 1 结束 ===\n"
        "print(s)\n"
    )
    fill_alt = (
        "n = int(input())\n"
        "# === 填空区 1 开始 ===\n"
        "s = (n // 100) + (n % 100) // 10 + (n % 10)\n"
        "# === 填空区 1 结束 ===\n"
        "print(s)\n"
    )

    debug_starter = "a = input()\nb = input()\nprint(a + b)\n"
    debug_ref = "a = int(input())\nb = int(input())\nprint(a + b)\n"
    debug_alt = "x = int(input())\ny = int(input())\nprint(x + y)\n"

    design_ref = "s = input().strip()\nprint(s.upper(), len(s))\n"
    design_alt = "text = input().strip()\nprint(f'{text.upper()} {len(text)}')\n"

    seen_prompts: list[str] = []

    def fake_chat_json(self, messages, **kwargs):
        system = str(messages[0]["content"])
        user = str(messages[1]["content"])
        seen_prompts.append(user)
        if "独立答题验证器" in system:
            if "三位数数位求和" in user:
                return {"code": fill_alt}, {}
            if "整数求和改错" in user:
                return {"code": debug_alt}, {}
            return {"code": design_alt}, {}

        if 'coding_type = "fill_code"' in user:
            return (
                {
                    "title": "三位数数位求和",
                    "coding_type": "fill_code",
                    "difficulty": "难",
                    "usage": "assessment",
                    "knowledge_points": [kp.title],
                    "tags": ["整除", "取余"],
                    "page_number": 2,
                    "prompt": "【题目描述】输入一个三位正整数，计算百位、十位与个位之和并输出。\n【输入格式】一行一个三位正整数。\n【输出格式】一行一个整数表示各位之和。",
                    "starter_code": fill_starter,
                    "reference_solution": fill_ref,
                    "hints": ["百位可用 n // 100 提取", "十位可用 (n // 10) % 10 提取"],
                    "explanation": "利用整除 // 与取余 % 依次拆出百位、十位和个位再相加即可。",
                    # Intentionally wrong expected_output on sample 1 to prove sandbox overwrites it.
                    "samples": [
                        {"input": "123\n", "expected_output": "999\n"},
                        {"input": "508\n", "expected_output": "13\n"},
                    ],
                    "hidden_cases": [
                        {"input": "100\n", "expected_output": "0\n"},
                        {"input": "999\n", "expected_output": "27\n"},
                        {"input": "405\n", "expected_output": "9\n"},
                    ],
                },
                {},
            )
        if 'coding_type = "debug"' in user:
            return (
                {
                    "title": "整数求和改错",
                    "coding_type": "debug",
                    "difficulty": "难",
                    "usage": "assessment",
                    "knowledge_points": [kp.title],
                    "tags": ["类型转换"],
                    "page_number": 2,
                    "prompt": "【题目描述】下面程序本意是读入两个整数并输出它们的算术和，请修复其中的类型转换错误。\n【输入格式】两行，每行一个整数。\n【输出格式】一行一个整数表示两数之和。",
                    "starter_code": debug_starter,
                    "reference_solution": debug_ref,
                    "hints": ["input() 返回的是字符串类型"],
                    "explanation": "input() 默认返回 str，直接相加会做字符串拼接，需先用 int() 转换。",
                    "samples": [
                        {"input": "12\n34\n", "expected_output": "46\n"},
                        {"input": "-5\n8\n", "expected_output": "3\n"},
                    ],
                    "hidden_cases": [
                        {"input": "0\n0\n", "expected_output": "0\n"},
                        {"input": "100\n-100\n", "expected_output": "0\n"},
                        {"input": "7\n9\n", "expected_output": "16\n"},
                    ],
                },
                {},
            )
        return (
            {
                "title": "标签规范化与长度统计",
                "coding_type": "design",
                "difficulty": "难",
                "usage": "assessment",
                "knowledge_points": [kp.title],
                "tags": ["字符串方法"],
                "page_number": 3,
                "prompt": "【题目描述】读入一行字符串，去除首尾空白后转为全大写，并输出大写结果与去空白后的字符数（中间以单个空格分隔）。\n【输入格式】一行非空字符串。\n【输出格式】一行，大写字符串与整数长度，中间用一个空格分隔。",
                "starter_code": "",
                "reference_solution": design_ref,
                "hints": ["先用 strip() 去空白，再用 upper() 和 len()"],
                "explanation": "调用 strip() 清理两端空白后，用 upper() 统一大写并用 len() 统计长度。",
                "samples": [
                    {"input": "  py3  \n", "expected_output": "PY3 3\n"},
                    {"input": "hello\n", "expected_output": "HELLO 5\n"},
                ],
                "hidden_cases": [
                    {"input": " a \n", "expected_output": "A 1\n"},
                    {"input": "Python_101\n", "expected_output": "PYTHON_101 10\n"},
                    {"input": "\tabc\t\n", "expected_output": "ABC 3\n"},
                ],
            },
            {},
        )

    monkeypatch.setattr(studio_llm.LLMClient, "chat_json", fake_chat_json)

    res = client.post(
        f"/api/teacher/courses/{instance_id}/course-studio/chapters/{chapter.id}/coding-exercises/generate",
        json={
            "material_id": mat.id,
            "counts": {"fill_code": 1, "debug": 1, "design": 1},
            "difficulty": "难",
            "usage": "assessment",
            "knowledge_point_ids": [kp.id],
            "allowed_syntax_note": "仅限顺序结构，禁用 if/for/while/def",
            "enable_blind_solve": True,
        },
        headers=teacher["headers"],
    )
    assert res.status_code == 202, res.text
    job_id = res.json()["id"]
    assert res.json()["kind"] == "coding_exercises_generate"

    assert course_studio_jobs.run_next(db) is True
    job = client.get(
        f"/api/teacher/courses/{instance_id}/course-studio/jobs/{job_id}",
        headers=teacher["headers"],
    ).json()
    assert job["status"] == "done", job
    assert job["result"]["created"] == 3
    assert job["result"]["failed"] == 0
    assert "新增 3 道已验编程题草稿" in job["progress"]["message"]
    assert any("仅限顺序结构，禁用 if/for/while/def" in p for p in seen_prompts)

    created_ids = job["result"]["question_ids"]
    assert len(created_ids) == 3

    by_ctype: dict[str, tuple[Question, QuestionSecret]] = {}
    for qid in created_ids:
        q = db.get(Question, qid)
        secret = db.get(QuestionSecret, qid)
        assert q is not None and secret is not None
        assert q.kind == "python"
        assert q.source_type == "ai_generated"
        assert q.status == "draft"
        assert q.owner_id == teacher["id"]
        assert q.source["difficulty"] == "难"
        assert q.source["usage"] == "assessment"
        assert q.source["material_id"] == mat.id
        assert "reference_solution" not in q.source
        assert "hidden_cases" not in q.source
        assert "alt_solution" not in q.source
        assert isinstance(secret.answer, dict) and secret.answer.get("reference_solution")
        assert len(secret.hidden_cases) == 3
        pub = public_question(q)
        assert "explanation" not in pub["source"]
        assert "reference_solution" not in pub["source"]
        assert "created_at" not in pub["source"]
        assert isinstance(q.source.get("created_at"), str) and q.source["created_at"].endswith("Z")
        by_ctype[q.source["coding_type"]] = (q, secret)

    assert set(by_ctype) == {"fill_code", "debug", "design"}
    # Newly generated questions appear first in the teacher question bank, newest on top.
    page1 = client.get(
        f"/api/teacher/courses/{instance_id}/questions?page=1&size=10",
        headers=teacher["headers"],
    )
    assert page1.status_code == 200, page1.text
    top_items = page1.json()["items"][:3]
    assert [it["id"] for it in top_items] == list(reversed(created_ids))
    assert all(it["created_at"].endswith("Z") for it in top_items)
    # Authoritative sandbox sync fixed the LLM's deliberately wrong 999 / 0 outputs.
    fill_q, fill_secret = by_ctype["fill_code"]
    assert fill_q.samples[0]["output"] == "6\n"
    assert fill_secret.hidden_cases[0]["expected_output"] == "1\n"

    # Draft and assessment-only coding questions stay excluded from practice candidate pools.
    pseudo_practice = SimpleNamespace(
        course_instance_id=instance_id,
        chapter_id=chapter.id,
        owner_id=teacher["id"],
        content={"practice_kind": "programming"},
    )
    rules = {"goals": [{"knowledge_point_id": kp.id, "total": 1}]}
    assert all(qid not in candidate_pool(db, pseudo_practice, rules=rules).get(kp.id, {}) for qid in created_ids)
    # Approving to ready still keeps usage='assessment' excluded from practice draw.
    approve = client.put(
        f"/api/teacher/courses/{instance_id}/questions/{fill_q.id}",
        json={"status": "ready"},
        headers=teacher["headers"],
    )
    assert approve.status_code == 200, approve.text
    assert fill_q.id not in candidate_pool(db, pseudo_practice, rules=rules).get(kp.id, {})


def test_coding_generate_repair_loop_and_failure_reporting(client, db, teacher, classroom, monkeypatch) -> None:
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    monkeypatch.setenv("REBORN_AUTHORING_AI_MODEL", "deepseek-chat")
    monkeypatch.delenv("REBORN_GO_JUDGE_URL", raising=False)
    instance_id = db.info["fixture_course_instance_id"]
    chapter = db.scalar(select(Chapter).where(Chapter.course_instance_id == instance_id).order_by(Chapter.id))
    _coding_material(db, instance_id, chapter.id, teacher["id"])

    calls = {"fill": 0, "design": 0}

    def fake_chat_json(self, messages, **kwargs):
        system = str(messages[0]["content"])
        user = str(messages[1]["content"])
        if "独立答题验证器" in system:
            # Always mismatch for design to exercise blind-solve rejection; match for fill_code.
            if "倍数计算填空" in user:
                return {
                    "code": "x = int(input())\n# === 填空区 1 开始 ===\ny = x * 2\n# === 填空区 1 结束 ===\nprint(y)\n"
                }, {}
            return {"code": "print('wrong')\n"}, {}

        if 'coding_type = "fill_code"' in user:
            calls["fill"] += 1
            if calls["fill"] == 1:
                # Attempt 1 fails static check: input() contains prompt argument!
                return (
                    {
                        "title": "倍数计算填空",
                        "prompt": "【题目描述】输入整数 x，输出 2*x。\n【输入格式】一行一个整数。\n【输出格式】一行一个整数。",
                        "starter_code": "x = int(input('x='))\n# === 填空区 1 开始 ===\ny = 0\n# === 填空区 1 结束 ===\nprint(y)\n",
                        "reference_solution": "x = int(input('x='))\n# === 填空区 1 开始 ===\ny = x * 2\n# === 填空区 1 结束 ===\nprint(y)\n",
                        "hints": ["使用乘法运算符 *"],
                        "explanation": "将读入的整数乘以 2 后输出，注意 input() 不能带提示语。",
                        "samples": [{"input": "3\n", "expected_output": "6\n"}, {"input": "0\n", "expected_output": "0\n"}],
                        "hidden_cases": [
                            {"input": "-4\n", "expected_output": "-8\n"},
                            {"input": "10\n", "expected_output": "20\n"},
                            {"input": "7\n", "expected_output": "14\n"},
                        ],
                    },
                    {},
                )
            # Attempt 2 repairs the input() prompt violation after receiving exact feedback.
            assert any("禁止传入提示语参数" in str(m.get("content", "")) for m in messages)
            return (
                {
                    "title": "倍数计算填空",
                    "prompt": "【题目描述】输入整数 x，输出 2*x。\n【输入格式】一行一个整数。\n【输出格式】一行一个整数。",
                    "starter_code": "x = int(input())\n# === 填空区 1 开始 ===\ny = 0\n# === 填空区 1 结束 ===\nprint(y)\n",
                    "reference_solution": "x = int(input())\n# === 填空区 1 开始 ===\ny = x * 2\n# === 填空区 1 结束 ===\nprint(y)\n",
                    "hints": ["使用乘法运算符 *"],
                    "explanation": "将读入的整数乘以 2 后输出结果即可，注意负整数同样适用。",
                    "samples": [{"input": "3\n", "expected_output": "6\n"}, {"input": "0\n", "expected_output": "0\n"}],
                    "hidden_cases": [
                        {"input": "-4\n", "expected_output": "-8\n"},
                        {"input": "10\n", "expected_output": "20\n"},
                        {"input": "7\n", "expected_output": "14\n"},
                    ],
                },
                {},
            )

        calls["design"] += 1
        return (
            {
                "title": "歧义题示例",
                "prompt": "【题目描述】输入整数 n 并输出 n+1。\n【输入格式】一行一个整数。\n【输出格式】一行一个整数。",
                "starter_code": "",
                "reference_solution": "print(int(input()) + 1)\n",
                "hints": ["读入整数加一"],
                "explanation": "读入整数后加 1 并输出，测试盲解不一致时的拦截逻辑。",
                "samples": [{"input": "1\n", "expected_output": "2\n"}, {"input": "5\n", "expected_output": "6\n"}],
                "hidden_cases": [
                    {"input": "0\n", "expected_output": "1\n"},
                    {"input": "-1\n", "expected_output": "0\n"},
                    {"input": "9\n", "expected_output": "10\n"},
                ],
            },
            {},
        )

    monkeypatch.setattr(studio_llm.LLMClient, "chat_json", fake_chat_json)

    res = client.post(
        f"/api/teacher/courses/{instance_id}/course-studio/chapters/{chapter.id}/coding-exercises/generate",
        json={"counts": {"fill_code": 1, "design": 1}, "enable_blind_solve": True},
        headers=teacher["headers"],
    )
    assert res.status_code == 202, res.text
    assert course_studio_jobs.run_next(db) is True
    job = client.get(
        f"/api/teacher/courses/{instance_id}/course-studio/jobs/{res.json()['id']}",
        headers=teacher["headers"],
    ).json()
    assert job["status"] == "done"
    assert job["result"]["created"] == 1
    assert job["result"]["failed"] == 1
    assert calls["fill"] == 2
    assert calls["design"] == 2
    assert any("独立盲解" in msg for msg in job["result"]["failures"])


def test_coding_generate_validation_production_guard_and_scope(client, db, teacher, classroom, monkeypatch) -> None:
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    monkeypatch.setenv("REBORN_AUTHORING_AI_MODEL", "deepseek-chat")
    instance_id = db.info["fixture_course_instance_id"]
    chapter = db.scalar(select(Chapter).where(Chapter.course_instance_id == instance_id).order_by(Chapter.id))
    _coding_material(db, instance_id, chapter.id, teacher["id"])
    url = f"/api/teacher/courses/{instance_id}/course-studio/chapters/{chapter.id}/coding-exercises/generate"

    # Reject invalid coding_type key.
    assert client.post(url, json={"counts": {"single": 1}}, headers=teacher["headers"]).status_code == 422
    # Reject zero total or >12 total.
    assert client.post(url, json={"counts": {"fill_code": 0}}, headers=teacher["headers"]).status_code == 422
    assert client.post(url, json={"counts": {"fill_code": 6, "debug": 5, "design": 2}}, headers=teacher["headers"]).status_code == 422
    # Reject non-existent KP.
    assert client.post(
        url,
        json={"counts": {"design": 1}, "knowledge_point_ids": [999999]},
        headers=teacher["headers"],
    ).status_code == 422

    # Production without go-judge must refuse host subprocess execution.
    monkeypatch.delenv("REBORN_GO_JUDGE_URL", raising=False)
    monkeypatch.setattr(config, "ENVIRONMENT", "production")
    prod_res = client.post(url, json={"counts": {"design": 1}}, headers=teacher["headers"])
    assert prod_res.status_code == 409
    assert "go-judge" in prod_res.json()["detail"]

    # Configuring REBORN_GO_JUDGE_URL selects GoJudgeCodingRunner even in production.
    monkeypatch.setenv("REBORN_GO_JUDGE_URL", "http://go-judge:5050")
    assert exercise_service.coding_sandbox_unavailable_reason() is None
    assert isinstance(exercise_service.build_coding_runner(), coding_engine.GoJudgeCodingRunner)

    # Another teacher cannot enqueue coding generation on this course.
    other = User(student_id="18888889999", name="外班教师", role="teacher", password_hash=hash_password("pass-12345"))
    db.add(other)
    db.commit()
    other_headers = {"Authorization": "Bearer " + issue(db, other)["access_token"]}
    assert client.post(url, json={"counts": {"design": 1}}, headers=other_headers).status_code == 403
