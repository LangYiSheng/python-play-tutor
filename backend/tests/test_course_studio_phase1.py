"""Phase 1 tests for Course Studio pure engine DAG, DB models, job queue, and API scoping."""

from __future__ import annotations

import io
import zipfile
from typing import Any

import pytest
from fastapi import HTTPException

from app import course_studio
from app.auth import hash_password, issue
from app.course_studio import adapter, jobs
from app.course_studio.engine import exams, exercises, export, knowledge, ooxml, pacing, text_utils
from app.course_studio.models import CourseStudioExam, CourseStudioJob
from app.models import Material, Question, User, now
from app.narration.models import PageContent


def _zip_names(payload: bytes) -> set[str]:
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        return set(zf.namelist())


def test_ooxml_text_utils_and_export() -> None:
    docx_bytes = ooxml.build_docx_zip([ooxml.docx_paragraph("Hello", "Title")])
    assert {"[Content_Types].xml", "word/document.xml", "word/styles.xml"} <= _zip_names(docx_bytes)

    xlsx_bytes = ooxml.build_xlsx([["列A", "列B"], ["值1", "值2"]], sheet_name="测试", header_fill="D9EAD3")
    assert {"[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"} <= _zip_names(xlsx_bytes)

    assert text_utils.format_page_ranges([1, 2, 3, 5]) == "1-3, 5"
    assert text_utils.clean_script("[Slide 2 - 标题]\n大家好，今天我们开始。\n这里[pause]讲循环。") == "这里[停顿]讲循环。"
    assert text_utils.extract_json_payload("```json\n{\"ok\": true}\n```") == {"ok": True}

    assert set(export.EXPORT_KINDS) == {"source", "script"}
    pages = [export.ExportPage(index=1, topic="变量", text="先定义变量。[停顿]再赋值。")]
    md = export.build_markdown("Python 基础", pages, kind="script")
    assert "[停顿]" not in md
    assert "先定义变量。再赋值。" in md
    doc = export.build_docx("Python 基础", pages, kind="source")
    assert "word/document.xml" in _zip_names(doc)


def test_pacing_calculations_and_styles() -> None:
    assert pacing.count_spoken_chars("Python 支持 RGB 和 1024。[停顿]") == 6
    assert pacing.classify_slide(1, 5, "第一章 Python 入门\n授课教师：张老师") == "cover"
    assert pacing.classify_slide(2, 5, "目录\n1.1 变量\n1.2 循环") == "toc"
    assert pacing.classify_slide(5, 5, "谢谢观看") == "ending"

    pages = [
        {"page_no": 1, "raw_text": "1.1 变量定义\n变量是存储数据的名字。" * 6},
        {"page_no": 2, "raw_text": "1.2 条件判断\nif 语句用于分支控制。" * 6},
    ]
    budgets = pacing.budget_for_pages(pages, section_minutes=10.0, chapter_minutes=90.0)
    assert budgets[1]["section"] == "1.1"
    assert budgets[2]["section"] == "1.2"
    assert budgets[1]["char_budget"] >= pacing.MIN_PAGE_BUDGET
    assert "节奏紧凑" in pacing.build_style_hint("concise", "")


def test_knowledge_extraction_and_exports() -> None:
    pages = [
        {"page_no": 1, "text": "第一章 导论", "raw_text": "第一章 导论"},
        {"page_no": 2, "text": "1.1 变量与类型\n变量用于绑定对象。", "raw_text": "1.1 变量与类型\n变量用于绑定对象。"},
        {"page_no": 3, "text": "1.1 变量与类型\n常见类型有 int、str。", "raw_text": "1.1 变量与类型\n常见类型有 int、str。"},
    ]
    sections = knowledge.sections_from_pages(pages)
    assert sections[0]["number"] == "1.1"

    class FakeLLM:
        model = "fake-model"

        def chat_json(self, messages: list[dict[str, Any]], **_: Any) -> tuple[dict[str, Any], dict[str, int]]:
            return (
                {
                    "sections": [
                        {
                            "section": "1.1",
                            "points": [{"name": "变量绑定与基本类型", "pages": [2, 3], "brief": "理解变量引用与基础类型"}],
                        }
                    ]
                },
                {"prompt_tokens": 10},
            )

    res = knowledge.extract_knowledge_points(pages, FakeLLM())  # type: ignore[arg-type]
    assert res["points"] == 1
    chapters_payload = [{"title": "第一章", "sections": res["sections"]}]
    assert {"content.xml", "content.json"} <= _zip_names(knowledge.export_knowledge_xmind("课程", chapters_payload))
    assert "xl/worksheets/sheet1.xml" in _zip_names(knowledge.export_knowledge_xlsx("课程", chapters_payload))
    assert "word/document.xml" in _zip_names(knowledge.export_knowledge_docx("课程", chapters_payload))


def test_bullet_float_literal_and_stray_section_number_are_ignored() -> None:
    float_slide = (
        "数字类型\n"
        "• Python语言包括四种数字类型\n"
        "•整数 int\n"
        "• 1\n"
        "•浮点数（小数）float\n"
        "• 1.1\n"
        "•复数 complex\n"
        "• 1 + 2j\n"
        "•布尔值 bool\n"
        "• True, False"
    )
    assert knowledge.headings(float_slide) == []
    assert pacing.SECTION_RE.search(float_slide) is None

    # Genuine TOC bullets with titles and non-bullet stacked headings still work.
    assert knowledge.headings("• 3.1 认识“0”和“1”") == [("3.1", "认识“0”和“1”")]
    assert knowledge.headings("3.3\n数值信息表示及计算") == [("3.3", "数值信息表示及计算")]

    # Stray out-of-chapter decimal heading sandwiched inside Chapter 3 is filtered out.
    deck = [
        (2, "• 3.1 认识“0”和“1”\n• 3.3 数值信息表示及计算\n• 3.4 文字信息表示及计算"),
        (3, "3.1 认识“0”和“1”\n二进制基础"),
        (26, "3.3 数值信息表示及计算\n数字与运算"),
        (31, float_slide),
        (35, "1.1 杂项示例\n普通例子"),
        (47, "random库的使用\n引入第三方库"),
        (52, "3.4 文字信息表示及计算\n字符编码"),
    ]
    sections = knowledge.outline(deck)
    assert [(s["number"], s["title"]) for s in sections] == [
        ("3.1", "认识“0”和“1”"),
        ("3.3", "数值信息表示及计算"),
        ("3.4", "文字信息表示及计算"),
    ]
    sec33 = next(s for s in sections if s["number"] == "3.3")
    assert 31 in sec33["pages"] and 47 in sec33["pages"]


def test_chapter_toc_ignores_nested_subnumbering_and_strips_point_prefixes() -> None:
    from types import SimpleNamespace

    ch8_deck = [
        (1, "第八章图形化用户界面"),
        (2, "目录\n• 8.1、图形化用户界面介绍\n• 8.2、主窗体和控件设计"),
        (3, "8.1、图形化用户界面介绍\nGUI界面"),
        (7, "8.2、主窗体和控件设计\n根窗体"),
        (23, "1.1 标签（Label）\n标签用于呈现文本信息"),
        (27, "1.2 文本框\n多行文本"),
        (29, "1.3 输入框\n单行文本输入"),
        (30, "2 按钮\n按钮绑定命令"),
        (38, "3 单选按钮\n单选控件"),
    ]
    sections = knowledge.outline(ch8_deck)
    assert [(s["number"], s["title"]) for s in sections] == [
        ("8.1", "图形化用户界面介绍"),
        ("8.2", "主窗体和控件设计"),
    ]
    sec82 = next(s for s in sections if s["number"] == "8.2")
    assert {7, 23, 27, 29, 30, 38} <= set(sec82["pages"])

    slides = [SimpleNamespace(index=no, raw_text=text, section="") for no, text in ch8_deck]
    groups = pacing.assign_sections(slides, level=2)
    assert [sec for sec, _ in groups if sec != pacing.UNLABELED_SECTION] == ["8.1", "8.2"]

    parsed = knowledge.parse_points(
        {
            "sections": [
                {
                    "section": "8.2",
                    "points": [
                        {"name": "1.1 标签控件用法", "pages": [23], "brief": "标签呈现文本"},
                        {"name": "0和1的思维", "pages": [7], "brief": "保留非序号开头的正常数字"},
                    ],
                }
            ]
        },
        sections,
        {no for no, _ in ch8_deck},
    )
    sec82_pts = next(s["points"] for s in parsed if s["number"] == "8.2")
    assert [p["title"] for p in sec82_pts] == ["标签控件用法", "0和1的思维"]


def test_exercises_single_blank_and_xuexitong_exports() -> None:
    assert exercises.is_single_blank_fill("Python 中定义函数的关键字是 ____。", "def")
    assert not exercises.is_single_blank_fill("Python 中 ____ 和 ____ 是容器。", ["列表", "字典"])
    assert not exercises.is_single_blank_fill("Python 中定义函数的关键字是 ____。", "def；function")
    assert not exercises.is_single_blank_fill("Python 中定义函数的关键字是什么？", "def")

    raw_reply = {
        "questions": [
            {"type": "blank", "question": "使用 ____ 关键字定义函数。", "answer": "def", "page_number": 2, "explanation": "def 定义函数。"},
            {"type": "blank", "question": "____ 和 ____ 都是序列。", "answer": ["list", "tuple"], "page_number": 2, "explanation": "多空应过滤。"},
        ],
        "summary": "函数基础",
    }
    good, summary, rejected = exercises.parse_questions(raw_reply, "fill_blank", {2}, single_blank_only=True)
    assert summary == "函数基础"
    assert len(good) == 1
    assert good[0]["question"] == "使用 ____ 关键字定义函数。"
    assert good[0]["answer"] == ["def"]
    assert len(rejected) == 1

    sample_qs = [
        {
            "id": "q1",
            "type": "single",
            "question": "哪个关键字用于定义函数？",
            "options": {"a": "def", "b": "func", "c": "lambda", "d": "class"},
            "answer": "a",
            "explanation": "使用 def 定义命名函数。",
            "knowledge_points": ["函数定义"],
            "page": 2,
        },
        *good,
    ]
    check = exercises.validate_xuexitong_export(sample_qs)
    assert check["ok"], check
    assert "xl/worksheets/sheet1.xml" in _zip_names(exercises.export_xuexitong_xlsx(sample_qs, "第一章"))
    assert "xl/worksheets/sheet1.xml" in _zip_names(exercises.export_exercises_xlsx(sample_qs))
    txt = exercises.export_xuexitong_txt(sample_qs)
    assert "1.【单选题】" in txt and "2.【填空题】" in txt


def test_exercise_self_contained_validation_and_auto_retry() -> None:
    # Missing instruction sequences, dangling references, and external figures are rejected
    assert exercises.check_stem_self_contained("执行以下指令序列后，最终寄存器值为多少？") is not None
    assert exercises.check_stem_self_contained("根据上述指令序列，输出结果是什么？") is not None
    assert exercises.check_stem_self_contained("如下图所示的流程图执行完毕后，结果是？") is not None
    assert exercises.check_stem_self_contained("根据下表数据，哪一项复杂度最低？") is not None

    # Complete stems with embedded code, inline instructions, or normal conceptual wording pass
    assert exercises.check_stem_self_contained("执行以下代码后，输出结果是？\nx = [1, 2]\nx.append(3)\nprint(len(x))") is None
    assert exercises.check_stem_self_contained("执行以下指令序列：1. 置x=0；2. x+=5；最终x的值为？") is None
    assert exercises.check_stem_self_contained("下列关于 Python 列表中切片操作的说法正确的是？") is None

    # Auto-retry feeds rejection reason back and fills remaining count
    calls: list[list[dict]] = []

    class StubLLM:
        def chat_json(self, messages, **kwargs):
            calls.append(messages)
            if len(calls) == 1:
                return {
                    "questions": [
                        {
                            "type": "single",
                            "question": "执行以下指令序列后，最终输出是什么？",
                            "options": {"a": "1", "b": "2", "c": "3", "d": "4"},
                            "answer": "a",
                            "difficulty": "中",
                            "explanation": "因为缺少指令序列，本题应该被残题自检自动拦截并触发重试。",
                            "page_number": 1,
                        },
                        {
                            "type": "single",
                            "question": "执行以下代码后输出是什么？\na = [1, 2]\nb = a\nb.append(3)\nprint(len(a))",
                            "options": {"a": "2", "b": "3", "c": "4", "d": "报错"},
                            "answer": "b",
                            "difficulty": "中",
                            "explanation": "b = a 是引用赋值，两者指向同一列表对象，b.append(3) 会修改原列表，因此 len(a) 为 3。",
                            "page_number": 1,
                        },
                    ],
                    "summary": "列表引用",
                }, {}
            return {
                "questions": [
                    {
                        "type": "single",
                        "question": "表达式 7 // 2 的计算结果是？",
                        "options": {"a": "3", "b": "3.5", "c": "4", "d": "1"},
                        "answer": "a",
                        "difficulty": "易",
                        "explanation": "// 是整除运算符，7 除以 2 向下取整为 3，3.5 是普通除法 / 的结果，1 是取余 % 的结果。",
                        "page_number": 1,
                    }
                ],
                "summary": "运算符",
            }, {}

    res = exercises.generate_exercises_from_pages(
        [{"page_no": 1, "text": "Python 列表引用赋值与整除运算 // 示例。"}],
        StubLLM(),  # type: ignore[arg-type]
        counts={"single": 2},
        difficulty="challenging",
    )
    assert len(calls) == 2
    assert "综合拔高" in calls[0][1]["content"]
    assert "指令序列" in calls[1][-1]["content"]
    assert len(res["questions"]) == 2
    assert res["questions"][0]["difficulty"] == "中"
    assert all("指令序列" not in q["question"] for q in res["questions"])

    # Pre-export validator flags legacy incomplete stems and overly short explanations
    check = exercises.validate_xuexitong_export(
        [
            {
                "type": "single",
                "question": "执行以下指令序列后，最终结果是？",
                "options": {"a": "1", "b": "2", "c": "3", "d": "4"},
                "answer": "a",
                "explanation": "选A",
            }
        ]
    )
    assert any("可能不完整" in w for w in check["warnings"])
    assert any("解析偏简略" in w for w in check["warnings"])


def test_exercise_near_duplicate_detection_and_avoid_prioritization() -> None:
    # Near-duplicate fill/boolean/single rewordings are caught
    assert exercises.is_near_duplicate_stem(
        "程序对输入数据进行计算产生输出结果的过程称为____。",
        "程序对输入数据进行计算并产生输出结果的过程称为____。",
        same_kind=True,
    )
    assert exercises.is_near_duplicate_stem(
        "在Python中，注释以“#”号开头，会被计算机执行。",
        "Python中的注释以“#”号开头，并且会被计算机执行。",
        same_kind=True,
    )
    # Blatant cross-kind sentence copy-paste is caught
    assert exercises.is_near_duplicate_stem(
        "在Python中，使用random.randint(0,20)获取数据属于____输入方式。",
        "在Python中，使用 random.randint(0,20) 获取数据属于哪种输入方式？（ ）",
        same_kind=False,
    )
    # Distinct code operators/numbers/identifiers are NOT falsely blocked
    assert not exercises.is_near_duplicate_stem(
        "在Python中，表达式 7 // 2 的值是？",
        "在Python中，表达式 7 % 2 的值是？",
        same_kind=True,
    )
    assert not exercises.is_near_duplicate_stem(
        "Python内置函数 len() 的主要作用是什么？",
        "Python内置函数 ord() 的主要作用是什么？",
        same_kind=True,
    )
    # Opposite polarity questions are NOT falsely blocked
    assert not exercises.is_near_duplicate_stem(
        "Python语言的特点包括（ ）。",
        "Python语言的特点不包括（ ）。",
        same_kind=True,
    )

    # Smart avoid list prioritizes current-batch KPs + same kind + newest stems even beyond 40 items
    entries = [
        {"stem": f"早期无关知识点题目 {i}", "kind": "fill_blank", "points": ["其他知识点"]}
        for i in range(55)
    ]
    entries.append({"stem": "目标知识点最新单选题", "kind": "single", "points": ["变量与命名"]})
    entries.append({"stem": "目标知识点最新判断题", "kind": "true_false", "points": ["变量与命名"]})
    picked = exercises._select_avoid_stems(entries, kind="single", batch_points=["变量与命名"], limit=10)
    assert picked[0] == "目标知识点最新单选题"
    assert picked[1] == "目标知识点最新判断题"
    assert len(picked) == 10


def test_exams_ab_generation_patching_and_zip_export() -> None:
    pool = [
        {
            "id": f"q{i}",
            "chapter": "第1章" if i <= 4 else "第2章",
            "type": "single" if i <= 6 else "true_false",
            "question": f"测试题目 {i}：关于 Python 语法的描述正确的是？",
            "options": {"a": "选项A", "b": "选项B", "c": "选项C", "d": "选项D"} if i <= 6 else {"a": "正确", "b": "错误"},
            "answer": "a",
            "explanation": "解析内容。",
            "knowledge_points": [f"知识点{(i % 3) + 1}"],
            "page": i,
            "reviewed": True,
        }
        for i in range(1, 11)
    ]
    blueprint_sections = [{"type": "single", "count": 2, "scoreEach": 25}, {"type": "true_false", "count": 2, "scoreEach": 25}]
    gaps = exams.compute_gaps(pool, blueprint_sections, ["第1章", "第2章"], ab_mode=True, max_overlap_rate=0.0)
    assert gaps["ok"] is True

    exam = exams.generate_exam_variants(
        pool,
        title="期中测试",
        chapters=["第1章", "第2章"],
        sections=blueprint_sections,
        ab_mode=True,
        max_overlap_rate=0.0,
        seed=42,
    )
    assert exam["stats"]["overlapCount"] == 0
    assert exam["totalScore"] == 100

    first_uid = exam["variants"]["A"]["questions"][0]["uid"]
    cands = exams.find_candidates(exam, "A", first_uid, pool)
    assert cands
    patched = exams.apply_exam_patch(
        exam,
        {"action": "replace", "variant": "A", "uid": first_uid, "candidateId": cands[0]["id"]},
        pool,
    )
    assert patched["variants"]["A"]["questions"][0]["sourceId"] == cands[0]["id"]

    archive_names = _zip_names(exams.export_exam_zip(exam))
    assert "期中测试-A卷-学生卷.docx" in archive_names
    assert "期中测试-B卷-答案解析卷.docx" in archive_names
    assert "期中测试-命题双向细目表.xlsx" in archive_names


def test_job_detail_resolves_only_visible_outputs_in_generation_order(client, db, teacher, student, classroom, admin_account) -> None:
    course_id = classroom["course_id"]
    other_id = client.post("/api/teacher/courses", headers=teacher["headers"], json={"name": "其他课程"}).json()["id"]
    other_teacher = User(student_id="56637818393", name="其他教师", role="teacher", password_hash=hash_password("fixture-password"))
    db.add(other_teacher)
    db.flush()
    for key, instance, owner in [("z", course_id, teacher["id"]), ("a", course_id, None), ("deleted", course_id, teacher["id"]),
                                 ("other", other_id, teacher["id"]), ("private", course_id, other_teacher.id)]:
        db.add(Question(id=key, course_instance_id=instance, owner_id=owner, title=f"{key} 题", kind="boolean", prompt="合成题",
                        deleted_at=now() if key == "deleted" else None))
    result = {"question_ids": ["z", "missing", "other", "deleted", "a", "private"]}
    job = CourseStudioJob(course_instance_id=course_id, kind="exercises_generate", status="failed",
                          scope_key="test-question-detail", progress={"done": 1, "total": 2}, result=result)
    db.add(job)
    db.commit()
    base = f"/api/teacher/courses/{course_id}/course-studio/jobs"
    url = f"{base}/{job.id}"
    snapshot = client.get(base, headers=teacher["headers"]).json()["jobs"][0]
    assert "output_questions" not in snapshot
    outputs = [{"id":"z", "title":"z 题"}, {"id":"a", "title":"a 题"}]
    assert client.get(url, headers=teacher["headers"]).json() == {**snapshot, "output_questions": outputs}
    assert client.get(url, headers=admin_account["headers"]).json()["output_questions"] == [*outputs, {"id":"private", "title":"private 题"}]
    assert client.get(f"/api/teacher/courses/{other_id}/course-studio/jobs/{job.id}", headers=admin_account["headers"]).status_code == 404
    assert client.get(url, headers=student["headers"]).status_code == 403
    other_headers = {"Authorization": "Bearer " + issue(db, other_teacher)["access_token"]}
    assert client.get(url, headers=other_headers).status_code == 403


def test_course_studio_jobs_api_isolation_lifecycle_and_adapter(client, db, teacher, student, classroom) -> None:
    instance_id = db.info["fixture_course_instance_id"]

    # Auth & isolation checks
    assert client.get(f"/api/teacher/courses/{instance_id}/course-studio/jobs").status_code == 401
    assert client.get(f"/api/teacher/courses/{instance_id}/course-studio/jobs", headers=student["headers"]).status_code == 403

    other_teacher = User(
        student_id="1999999999999",
        name="其他教师",
        role="teacher",
        password_hash=hash_password("other-teacher-password"),
    )
    db.add(other_teacher)
    db.commit()
    other_headers = {"Authorization": "Bearer " + issue(db, other_teacher)["access_token"]}
    assert client.get(f"/api/teacher/courses/{instance_id}/course-studio/jobs", headers=other_headers).status_code == 403

    # Register test handlers
    def ok_handler(session, job):
        jobs.update_progress(session, job.id, done=1, total=1, message="完成")
        return {"created": 3}

    def cancel_handler(session, job):
        job.cancel_requested_at = job.created_at
        session.commit()
        jobs.check_cancel(session, job.id)
        return {"never": True}

    def fail_handler(session, job):
        raise RuntimeError("测试异常")

    jobs.register_handler("test_ok", ok_handler)
    jobs.register_handler("test_cancel", cancel_handler)
    jobs.register_handler("test_fail", fail_handler)

    job1 = jobs.enqueue_job(db, course_instance_id=instance_id, kind="test_ok", scope_key="chapter:1", user=other_teacher, total=1)
    with pytest.raises(HTTPException) as exc_info:
        jobs.enqueue_job(db, course_instance_id=instance_id, kind="test_ok", scope_key="chapter:1")
    assert exc_info.value.status_code == 409

    listing = client.get(f"/api/teacher/courses/{instance_id}/course-studio/jobs", headers=teacher["headers"])
    assert listing.status_code == 200
    assert listing.json()["jobs"][0]["id"] == job1.id

    assert jobs.run_next(db) is True
    detail = client.get(f"/api/teacher/courses/{instance_id}/course-studio/jobs/{job1.id}", headers=teacher["headers"])
    assert detail.status_code == 200
    assert detail.json()["status"] == "done"
    assert detail.json()["result"] == {"created": 3}
    assert detail.json()["output_questions"] == []

    # Cancel queued job via HTTP
    job2 = jobs.enqueue_job(db, course_instance_id=instance_id, kind="test_ok", scope_key="chapter:2")
    cancelled = client.post(f"/api/teacher/courses/{instance_id}/course-studio/jobs/{job2.id}/cancel", headers=teacher["headers"])
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert cancelled.json()["cancel_requested"] is True

    # Running job cancellation & failure handling
    job3 = jobs.enqueue_job(db, course_instance_id=instance_id, kind="test_cancel", scope_key="chapter:3")
    assert jobs.run_next(db) is True
    assert db.get(CourseStudioJob, job3.id).status == "cancelled"

    job4 = jobs.enqueue_job(db, course_instance_id=instance_id, kind="test_fail", scope_key="chapter:4")
    assert jobs.run_next(db) is True
    failed_row = db.get(CourseStudioJob, job4.id)
    assert failed_row.status == "failed"
    assert "测试异常" in failed_row.error

    # Restart recovery marks queued/running as interrupted
    job5 = jobs.enqueue_job(db, course_instance_id=instance_id, kind="test_ok", scope_key="chapter:5")
    assert course_studio.interrupt_running(db) >= 1
    assert db.get(CourseStudioJob, job5.id).status == "interrupted"

    # Exam model persists without FK to questions
    exam_row = CourseStudioExam(
        course_instance_id=instance_id,
        stable_id="exam-1",
        title="单元测试卷",
        mode="single",
        blueprint={},
        variants={"A": {"questions": []}},
        stats={},
    )
    db.add(exam_row)
    db.commit()
    assert db.get(CourseStudioExam, exam_row.id) is not None

    # Adapter material_pages prefers PageContent
    mat = Material(
        course_instance_id=instance_id,
        title="示例课件",
        kind="presentation",
        content={"pages": [{"page_no": 1, "title": "旧标题", "text": "原始解析文本"}]},
    )
    db.add(mat)
    db.flush()
    db.add(PageContent(material_id=mat.id, page_no=1, title="整理标题", text="整理后文本"))
    db.commit()
    merged = adapter.material_pages(db, mat)
    assert merged == [{"page_no": 1, "title": "整理标题", "text": "整理后文本", "raw_text": "原始解析文本"}]


def test_studio_job_completion_overwrites_stale_in_progress_message(db, classroom) -> None:
    instance_id = db.info["fixture_course_instance_id"]
    orig_handler = jobs._HANDLERS.get("exercises_generate")

    def fake_ex_handler(session, job):
        jobs.update_progress(session, job.id, done=0, total=1, message="正在根据课件内容生成客观题…")
        return {"created": 3, "skipped": 1}

    jobs.register_handler("exercises_generate", fake_ex_handler)
    try:
        job = jobs.enqueue_job(
            db,
            course_instance_id=instance_id,
            kind="exercises_generate",
            scope_key="chapter:99:exercises",
            total=1,
            message="已加入智能出题队列",
        )
        assert jobs.run_next(db) is True
        snap = jobs.serialize_job(db.get(CourseStudioJob, job.id))
        assert snap["status"] == "done"
        assert snap["progress"]["done"] == 1
        assert snap["progress"]["message"] == "已完成：新增 3 道待审题目（跳过重复或无效 1 道）"
    finally:
        if orig_handler is not None:
            jobs.register_handler("exercises_generate", orig_handler)


def test_ab_exam_generation_fills_both_variants_under_tight_pool() -> None:
    pool = [
        {
            "id": f"q{i}",
            "chapter": "第一章",
            "type": "single",
            "question": f"关于 Python 的第 {i} 题？",
            "options": {"a": "A", "b": "B", "c": "C", "d": "D"},
            "answer": "a",
            "explanation": "解析",
            "knowledge_points": [f"知识点{i % 5}"],
            "page": i,
            "reviewed": True,
        }
        for i in range(1, 19)
    ]
    exam = exams.generate_exam(
        pool,
        title="紧缺题池AB卷",
        sections=[{"type": "single", "count": 10, "scoreEach": 10}],
        chapters=["第一章"],
        ab_mode=True,
        max_overlap_rate=0.2,
        include_unreviewed=False,
    )
    assert len(exam["variants"]["A"]["questions"]) == 10
    assert len(exam["variants"]["B"]["questions"]) == 10
    assert exam["stats"]["overlapCount"] <= 2


def test_download_headers_clean_ascii_fallback_for_chinese_filenames() -> None:
    from app.course_studio.script_export_service import download_headers

    headers = download_headers("第一章计算工具与计算思维-整理稿.docx")
    disp = headers["Content-Disposition"]
    assert 'filename="export.docx"' in disp
    assert "filename*=UTF-8''" in disp


def test_judge_service_timestamps_include_timezone(client, db, teacher) -> None:
    from app.integration_models import JudgeService
    from app.models import now

    db.get(User, teacher["id"]).role = "admin"
    row = db.get(JudgeService, 1)
    if row is None:
        row = JudgeService(id=1, paused=False, health={"status": "ok", "detail": "健康"}, events=[])
        db.add(row)
    row.checked_at = now()
    row.worker_seen_at = now()
    db.commit()
    res = client.get("/api/teacher/judge/service", headers=teacher["headers"])
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["checked_at"] and ("+" in body["checked_at"] or body["checked_at"].endswith("Z"))
    assert body["worker_seen_at"] and ("+" in body["worker_seen_at"] or body["worker_seen_at"].endswith("Z"))
