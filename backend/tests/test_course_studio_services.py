"""Backend Phase 2 tests for narration upgrade, exports, knowledge, AI exercises, and exams."""

from __future__ import annotations

import io
import json
import zipfile
from typing import Any

from sqlalchemy import select

from app.auth import hash_password, issue
from app.content_relations import set_material_chapters
from app.course_content.presentation import public_question
from app.course_studio import jobs as course_studio_jobs
from app.course_studio.engine import llm as studio_llm
from app.course_studio.models import CourseStudioExam
from app.models import Activity, Chapter, KnowledgePoint, Material, Question, QuestionSecret, User, now
from app.narration import client as model_client
from app.narration import config as narration_config
from app.narration import repository as narration_repo
from app.narration import service as narration_service
from app.narration.models import PageContent
from app.practice_rules import candidate_pool

RESERVED_KEYS = {
    "chapter_id", "prerequisite_chapter_id", "material_id", "document_id",
    "activity_id", "pending_activity_id", "question_id", "knowledge_point_id",
    "quest_id", "story_id", "npc_key", "speaker_npc_id", "activity_completed",
    "chapter_ids", "question_ids", "knowledge_point_ids",
}


def _zip_names(payload: bytes) -> set[str]:
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        return set(zf.namelist())


def _sample_material(db: Any, instance_id: int, chapter_id: int, teacher_id: int) -> Material:
    mat = Material(
        course_instance_id=instance_id,
        stable_id="studio-mat-1",
        owner_id=teacher_id,
        title="第一章 变量与循环",
        kind="presentation",
        status="ready",
        content={
            "library_available": True,
            "pages": [
                {"id": 1, "page_no": 1, "title": "封面", "text": "第一章 Python 入门\n授课教师：张老师"},
                {"id": 2, "page_no": 2, "title": "变量", "text": "1.1 变量与赋值\nPython 使用 = 为变量绑定对象，支持整数和字符串。"},
                {"id": 3, "page_no": 3, "title": "循环", "text": "1.2 for 循环\nfor 循环可以遍历列表与 range 生成的整数序列。"},
            ],
        },
    )
    db.add(mat)
    db.flush()
    set_material_chapters(db, mat.id, [chapter_id])
    db.add(PageContent(material_id=mat.id, page_no=2, title="1.1 变量绑定", text="变量通过赋值号绑定对象，无需提前声明类型。"))
    db.commit()
    return mat


def test_narration_style_pacing_and_export(client, db, teacher, classroom, run_jobs, monkeypatch) -> None:
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    monkeypatch.setenv("REBORN_AUTHORING_AI_MODEL", "deepseek-chat")
    instance_id = db.info["fixture_course_instance_id"]
    chapter = db.scalar(select(Chapter).where(Chapter.course_instance_id == instance_id))
    mat = _sample_material(db, instance_id, chapter.id, teacher["id"])

    settings = narration_config.settings(db)
    h_default = narration_service.input_hash(db, mat, 2, settings, 60)
    h_concise = narration_service.input_hash(db, mat, 2, settings, 60, style_preset="concise", char_budget=180)
    assert h_default != h_concise

    seen_prompts: list[str] = []

    def fake_chat(messages, *, settings, model, **kwargs):
        system = messages[0]["content"]
        seen_prompts.append(str(messages[1]["content"]))
        if "整理一份课程幻灯片" in system:
            return {
                "raw": {
                    "pages": [
                        {"page_no": p, "title": f"页{p}", "topic": f"主题{p}", "tags": ["变量"], "text": f"整理页{p}正文内容"}
                        for p in (1, 2, 3)
                    ]
                },
                "text": "",
                "usage": {},
                "model": model,
            }
        if "校对一份课程幻灯片" in system:
            return {"raw": {"fixes": [], "issues": [], "tag_map": {}}, "text": "", "usage": {}, "model": model}
        if "课程知识图谱的编者" in system:
            return {
                "raw": {"sections": [{"section": "1.1", "points": [{"title": "变量赋值", "pages": [2, 3], "brief": "变量与赋值"}]}]},
                "text": "",
                "usage": {},
                "model": model,
            }
        return {
            "raw": {
                "pages": [
                    {"page_no": p, "text": f"第{p}页讲解。[停顿]重点是变量赋值。", "anchors": ["变量"] if p == 2 else []}
                    for p in (1, 2, 3)
                ]
            },
            "text": "",
            "usage": {},
            "model": model,
        }

    monkeypatch.setattr(model_client, "chat", fake_chat)

    res = client.post(
        f"/api/teacher/courses/{instance_id}/materials/{mat.id}/narrations/pipeline",
        json={"style_preset": "concise", "custom_style": "多结合代码示例", "section_minutes": 10.0, "use_pacing": True},
        headers=teacher["headers"],
    )
    assert res.status_code == 202, res.text
    run_jobs()
    assert narration_repo.job_of(db, mat.id).status == "done"
    assert any("授课风格要求" in p and "节奏紧凑干练" in p and "多结合代码示例" in p and "节奏预算" in p for p in seen_prompts)

    pacing_res = client.get(
        f"/api/teacher/courses/{instance_id}/course-studio/materials/{mat.id}/pacing?section_minutes=8&chapter_minutes=45",
        headers=teacher["headers"],
    )
    assert pacing_res.status_code == 200, pacing_res.text
    assert len(pacing_res.json()["pages"]) == 3

    for kind in ("source", "script"):
        md_res = client.get(
            f"/api/teacher/courses/{instance_id}/course-studio/materials/{mat.id}/export?kind={kind}&fmt=md",
            headers=teacher["headers"],
        )
        assert md_res.status_code == 200
        if kind == "script":
            assert "[停顿]" not in md_res.text
            assert "重点是变量赋值" in md_res.text
        docx_res = client.get(
            f"/api/teacher/courses/{instance_id}/course-studio/materials/{mat.id}/export?kind={kind}&fmt=docx",
            headers=teacher["headers"],
        )
        assert docx_res.status_code == 200
        assert "word/document.xml" in _zip_names(docx_res.content)


def test_knowledge_extract_merge_isolation_and_exports(client, db, teacher, classroom, monkeypatch) -> None:
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    monkeypatch.setenv("REBORN_AUTHORING_AI_MODEL", "deepseek-chat")
    instance_id = db.info["fixture_course_instance_id"]
    chapter = db.scalar(select(Chapter).where(Chapter.course_instance_id == instance_id).order_by(Chapter.id))
    mat = _sample_material(db, instance_id, chapter.id, teacher["id"])

    existing_titles = {
        kp.title: kp
        for kp in db.scalars(select(KnowledgePoint).where(KnowledgePoint.course_instance_id == instance_id, KnowledgePoint.chapter_id == chapter.id))
    }
    first_existing_title = next(iter(existing_titles))

    def fake_chat_json(self, messages, **kwargs):
        return (
            {
                "sections": [
                    {
                        "section": "1.1",
                        "points": [
                            {"name": first_existing_title, "pages": [2], "brief": "合并已有知识点来源"},
                            {"name": "for 循环迭代机制", "pages": [3], "brief": "理解 range 与列表遍历"},
                        ],
                    }
                ]
            },
            {"prompt_tokens": 100},
        )

    monkeypatch.setattr(studio_llm.LLMClient, "chat_json", fake_chat_json)

    queued = client.post(
        f"/api/teacher/courses/{instance_id}/course-studio/chapters/{chapter.id}/knowledge/extract",
        json={"material_ids": [mat.id]},
        headers=teacher["headers"],
    )
    assert queued.status_code == 202, queued.text
    job_id = queued.json()["id"]
    assert course_studio_jobs.run_next(db) is True

    job = client.get(f"/api/teacher/courses/{instance_id}/course-studio/jobs/{job_id}", headers=teacher["headers"]).json()
    assert job["status"] == "done"
    assert job["result"]["created"] == 1
    assert job["result"]["updated"] == 1

    new_kp = db.scalar(
        select(KnowledgePoint).where(KnowledgePoint.course_instance_id == instance_id, KnowledgePoint.title == "for 循环迭代机制")
    )
    assert new_kp is not None
    studio_meta = new_kp.content["course_studio"]
    assert len(json.dumps(studio_meta, ensure_ascii=False)) <= 4000
    assert not (set(studio_meta) & RESERVED_KEYS)
    assert not (set(studio_meta["sources"][0]) & RESERVED_KEYS)

    # Knowledge graph detail endpoint resolves uploaded material source pages via stable_id.
    detail = client.get(f"/api/teacher/courses/{instance_id}/course-graph/points/{new_kp.id}", headers=teacher["headers"])
    assert detail.status_code == 200
    assert detail.json()["sources"] == [{"material_id": mat.id, "pages": [3]}]

    overview = client.get(f"/api/teacher/courses/{instance_id}/course-studio/knowledge", headers=teacher["headers"])
    assert overview.status_code == 200
    assert any(p["title"] == "for 循环迭代机制" for ch in overview.json()["chapters"] for p in ch["points"])

    for fmt in ("xmind", "xlsx", "docx"):
        exp = client.get(f"/api/teacher/courses/{instance_id}/course-studio/knowledge/export?fmt={fmt}", headers=teacher["headers"])
        assert exp.status_code == 200
        assert len(exp.content) > 200

    # Other teacher cannot access this course's knowledge endpoints.
    other = User(student_id="18888888888", name="外班老师", role="teacher", password_hash=hash_password("pass-12345"))
    db.add(other)
    db.commit()
    other_headers = {"Authorization": "Bearer " + issue(db, other)["access_token"]}
    assert client.get(f"/api/teacher/courses/{instance_id}/course-studio/knowledge", headers=other_headers).status_code == 403


def test_exercises_generate_draft_isolation_quotas_and_exports(client, db, teacher, classroom, monkeypatch) -> None:
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    monkeypatch.setenv("REBORN_AUTHORING_AI_MODEL", "deepseek-chat")
    instance_id = db.info["fixture_course_instance_id"]
    chapter = db.scalar(select(Chapter).where(Chapter.course_instance_id == instance_id).order_by(Chapter.id))
    mat = _sample_material(db, instance_id, chapter.id, teacher["id"])
    kp = db.scalar(select(KnowledgePoint).where(KnowledgePoint.course_instance_id == instance_id, KnowledgePoint.chapter_id == chapter.id))

    # Reject short_answer explicitly.
    bad = client.post(
        f"/api/teacher/courses/{instance_id}/course-studio/chapters/{chapter.id}/exercises/generate",
        json={"counts": {"short_answer": 2}},
        headers=teacher["headers"],
    )
    assert bad.status_code == 422

    def fake_chat_json(self, messages, **kwargs):
        user_msg = str(messages[1]["content"])
        if 'type 填 "single"' in user_msg:
            return (
                {"questions": [{"type": "single", "question": "Python 中单等号属于哪一类运算符？", "options": {"a": "赋值运算符", "b": "比较运算符", "c": "逻辑运算符", "d": "成员运算符"}, "answer": "a", "explanation": "单等号是赋值运算符。", "knowledge_points": [kp.title], "page_number": 2}]},
                {},
            )
        if 'type 填 "multiple"' in user_msg:
            return (
                {"questions": [{"type": "multiple", "question": "Python 中属于内置序列类型的是？", "options": {"a": "list", "b": "tuple", "c": "int", "d": "float"}, "answer": ["a", "b"], "explanation": "list 和 tuple 是序列类型。", "knowledge_points": [kp.title], "page_number": 3}]},
                {},
            )
        if 'type 填 "judge"' in user_msg:
            return (
                {"questions": [{"type": "judge", "question": "Python 变量使用前必须先声明类型。", "options": {"a": "正确", "b": "错误"}, "answer": "b", "explanation": "Python 是动态类型语言。", "knowledge_points": [kp.title], "page_number": 2}]},
                {},
            )
        return (
            {
                "questions": [
                    {"type": "blank", "question": "Python 中 ____ 关键字用于遍历序列。", "answer": "for", "explanation": "for 循环用于遍历。", "knowledge_points": [kp.title], "page_number": 3},
                    {"type": "blank", "question": "____ 和 ____ 都是分支关键字。", "answer": ["if", "else"], "explanation": "多空必须被拦截。", "knowledge_points": [kp.title], "page_number": 3},
                ]
            },
            {},
        )

    monkeypatch.setattr(studio_llm.LLMClient, "chat_json", fake_chat_json)

    res = client.post(
        f"/api/teacher/courses/{instance_id}/course-studio/chapters/{chapter.id}/exercises/generate",
        json={"material_id": mat.id, "counts": {"single": 1, "multiple": 1, "true_false": 1, "fill_blank": 2}},
        headers=teacher["headers"],
    )
    assert res.status_code == 202, res.text
    assert course_studio_jobs.run_next(db) is True
    job = client.get(f"/api/teacher/courses/{instance_id}/course-studio/jobs/{res.json()['id']}", headers=teacher["headers"]).json()
    assert job["status"] == "done"
    created_ids = job["result"]["question_ids"]
    assert len(created_ids) == 4, f"result={job['result']}, kinds={[db.get(Question, qid).kind for qid in created_ids]}"  # multi-blank fill filtered out

    for qid in created_ids:
        q = db.get(Question, qid)
        secret = db.get(QuestionSecret, qid)
        assert q is not None and secret is not None
        assert q.source_type == "ai_generated"
        assert q.status == "draft"
        assert q.owner_id == teacher["id"]
        assert "explanation" in q.source
        assert "explanation" not in public_question(q)["source"]

    # Draft AI questions must NOT appear in student practice pools until status='ready'.
    from types import SimpleNamespace

    pseudo_activity = SimpleNamespace(
        course_instance_id=instance_id, chapter_id=chapter.id, owner_id=teacher["id"],
        content={"practice_kind": "objective"},
    )
    rules = {"goals": [{"knowledge_point_id": kp.id, "total": 1}]}
    pool_before = candidate_pool(db, pseudo_activity, rules=rules)
    assert all(qid not in pool_before.get(kp.id, {}) for qid in created_ids)
    first_ai = db.get(Question, created_ids[0])
    upd = client.put(
        f"/api/teacher/courses/{instance_id}/questions/{first_ai.id}",
        json={"status": "ready"},
        headers=teacher["headers"],
    )
    assert upd.status_code == 200, upd.text
    pool_after = candidate_pool(db, pseudo_activity, rules=rules)
    assert created_ids[0] in pool_after.get(kp.id, {})

    val = client.get(
        f"/api/teacher/courses/{instance_id}/course-studio/exercises/validate?chapter_id={chapter.id}&status=draft",
        headers=teacher["headers"],
    )
    assert val.status_code == 200
    assert val.json()["ok"] is True

    for fmt in ("xuexitong_xlsx", "xuexitong_txt", "xlsx"):
        exp = client.get(
            f"/api/teacher/courses/{instance_id}/course-studio/exercises/export?fmt={fmt}&chapter_id={chapter.id}&status=draft",
            headers=teacher["headers"],
        )
        assert exp.status_code == 200

    # Quota mode smoke check
    q_res = client.post(
        f"/api/teacher/courses/{instance_id}/course-studio/chapters/{chapter.id}/exercises/generate",
        json={"point_quotas": [{"knowledge_point_id": kp.id, "single": 1}]},
        headers=teacher["headers"],
    )
    assert q_res.status_code == 202


def test_exam_lifecycle_fill_gaps_patch_export_and_soft_delete(client, db, teacher, monkeypatch) -> None:
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    monkeypatch.setenv("REBORN_AUTHORING_AI_MODEL", "deepseek-chat")
    course = client.post("/api/teacher/courses", json={"name": "未开班的组卷测试课程"}, headers=teacher["headers"])
    assert course.status_code == 201, course.text
    instance_id = course.json()["id"]
    ch_res = client.post(f"/api/teacher/courses/{instance_id}/chapters", json={"title": "组卷测试新章"}, headers=teacher["headers"])
    assert ch_res.status_code == 201, ch_res.text
    fresh_ch_id = ch_res.json()["id"]
    _sample_material(db, instance_id, fresh_ch_id, teacher["id"])
    ch_ids = [fresh_ch_id]

    blueprint = {
        "chapter_ids": ch_ids,
        "sections": [
            {"type": "single", "count": 2, "scoreEach": 25},
            {"type": "true_false", "count": 2, "scoreEach": 25},
        ],
        "ab_mode": True,
        "max_overlap_rate": 0.0,
        "include_unreviewed": True,
    }
    gaps = client.post(f"/api/teacher/courses/{instance_id}/course-studio/exams/gaps", json=blueprint, headers=teacher["headers"])
    assert gaps.status_code == 200
    assert gaps.json()["ok"] is False

    counter = {"n": 0}

    def fake_chat_json(self, messages, **kwargs):
        user_msg = str(messages[1]["content"])
        counter["n"] += 1
        if 'type 填 "single"' in user_msg:
            return (
                {
                    "questions": [
                        {"type": "single", "question": f"单选题补题 {counter['n']}-{i}：正确选项是哪一个？", "options": {"a": f"对{i}", "b": "错1", "c": "错2", "d": "错3"}, "answer": "a", "explanation": "解析。", "page_number": 2}
                        for i in range(6)
                    ]
                },
                {},
            )
        return (
            {
                "questions": [
                    {"type": "judge", "question": f"判断题补题 {counter['n']}-{i}：描述成立。", "options": {"a": "正确", "b": "错误"}, "answer": "a" if i % 2 == 0 else "b", "explanation": "解析。", "page_number": 3}
                    for i in range(6)
                ]
            },
            {},
        )

    monkeypatch.setattr(studio_llm.LLMClient, "chat_json", fake_chat_json)

    fill = client.post(
        f"/api/teacher/courses/{instance_id}/course-studio/exams/fill-gaps",
        json={**blueprint, "multiplier": 2},
        headers=teacher["headers"],
    )
    assert fill.status_code == 202, fill.text
    assert course_studio_jobs.run_next(db) is True

    gaps_after = client.post(f"/api/teacher/courses/{instance_id}/course-studio/exams/gaps", json=blueprint, headers=teacher["headers"])
    assert gaps_after.json()["ok"] is True

    created = client.post(
        f"/api/teacher/courses/{instance_id}/course-studio/exams/generate",
        json={**blueprint, "title": "阶段测评卷", "subtitle": "A/B 闭卷", "total_score": 100},
        headers=teacher["headers"],
    )
    assert created.status_code == 201, created.text
    exam_id = created.json()["id"]
    first_uid = created.json()["variants"]["A"]["questions"][0]["uid"]

    cands = client.get(
        f"/api/teacher/courses/{instance_id}/course-studio/exams/{exam_id}/candidates?variant=A&uid={first_uid}",
        headers=teacher["headers"],
    )
    assert cands.status_code == 200
    assert cands.json()["candidates"]

    cand_id = cands.json()["candidates"][0]["id"]
    patched = client.patch(
        f"/api/teacher/courses/{instance_id}/course-studio/exams/{exam_id}",
        json={"action": "replace", "variant": "A", "uid": first_uid, "candidateId": cand_id, "title": "阶段测评重命名"},
        headers=teacher["headers"],
    )
    assert patched.status_code == 200
    assert patched.json()["title"] == "阶段测评重命名"

    for kind in ("student_docx", "teacher_docx", "blueprint_xlsx", "xuexitong_xlsx", "xuexitong_txt", "zip"):
        exp = client.get(
            f"/api/teacher/courses/{instance_id}/course-studio/exams/{exam_id}/export?kind={kind}&variant=A",
            headers=teacher["headers"],
        )
        assert exp.status_code == 200, kind
        assert len(exp.content) > 50

    # Soft-deleting a source question/chapter must NOT break reading/exporting an existing CourseStudioExam snapshot.
    first_src_stable = patched.json()["variants"]["A"]["questions"][0]["sourceId"]
    src_q = db.scalar(select(Question).where(Question.course_instance_id == instance_id, Question.stable_id == first_src_stable))
    if src_q is not None:
        src_q.deleted_at = now()
        db.commit()

    assert client.get(f"/api/teacher/courses/{instance_id}/course-studio/exams/{exam_id}", headers=teacher["headers"]).status_code == 200
    assert client.get(f"/api/teacher/courses/{instance_id}/course-studio/knowledge", headers=teacher["headers"]).status_code == 200
    assert client.delete(f"/api/teacher/courses/{instance_id}/course-studio/exams/{exam_id}", headers=teacher["headers"]).status_code == 200
    assert db.scalar(select(Activity.id).where(Activity.course_instance_id == instance_id)) is None
    assert db.get(CourseStudioExam, exam_id) is None


def test_knowledge_reextract_updates_sole_source_title_without_anchoring_old_name(client, db, teacher, classroom, monkeypatch) -> None:
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    monkeypatch.setenv("REBORN_AUTHORING_AI_MODEL", "deepseek-chat")
    instance_id = db.info["fixture_course_instance_id"]
    chapter = db.scalar(select(Chapter).where(Chapter.course_instance_id == instance_id).order_by(Chapter.id))
    mat = _sample_material(db, instance_id, chapter.id, teacher["id"])

    # Pre-existing sole-source auto KP with a noisy parenthetical title
    old_kp = KnowledgePoint(
        chapter_id=chapter.id,
        owner_id=teacher["id"],
        course_instance_id=instance_id,
        stable_id="kp-noisy-auto",
        title="列表切片操作（含步长与负索引示例）",
        content={
            "course_studio": {
                "section": "1.1 变量与赋值",
                "brief": "旧简介",
                "sources": [{"material_stable_id": mat.stable_id, "pages": [2, 3]}],
            }
        },
    )
    db.add(old_kp)
    db.commit()

    seen_user_prompts: list[str] = []

    def fake_chat_json(self, messages, **kwargs):
        seen_user_prompts.append(str(messages[1]["content"]))
        return (
            {
                "sections": [
                    {
                        "section": "1.1",
                        "points": [
                            {"name": "列表切片操作", "pages": [2, 3], "brief": "掌握正向反向索引与步长切片"},
                        ],
                    }
                ]
            },
            {"prompt_tokens": 80},
        )

    monkeypatch.setattr(studio_llm.LLMClient, "chat_json", fake_chat_json)

    queued = client.post(
        f"/api/teacher/courses/{instance_id}/course-studio/chapters/{chapter.id}/knowledge/extract",
        json={"material_ids": [mat.id]},
        headers=teacher["headers"],
    )
    assert queued.status_code == 202, queued.text
    assert course_studio_jobs.run_next(db) is True

    # Sole-source auto KP old noisy name must NOT be injected into existing_titles prompt hint
    assert seen_user_prompts
    assert "列表切片操作（含步长与负索引示例）" not in seen_user_prompts[0]

    db.expire_all()
    refreshed = db.get(KnowledgePoint, old_kp.id)
    assert refreshed is not None
    assert refreshed.deleted_at is None
    assert refreshed.title == "列表切片操作"


def test_exercises_generate_persists_partial_count_on_cancel_and_interrupt(client, db, teacher, classroom, monkeypatch) -> None:
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    monkeypatch.setenv("REBORN_AUTHORING_AI_MODEL", "deepseek-chat")
    instance_id = db.info["fixture_course_instance_id"]
    chapter = db.scalar(select(Chapter).where(Chapter.course_instance_id == instance_id).order_by(Chapter.id))
    _sample_material(db, instance_id, chapter.id, teacher["id"])
    kp = db.scalar(select(KnowledgePoint).where(KnowledgePoint.course_instance_id == instance_id, KnowledgePoint.chapter_id == chapter.id))

    calls = {"n": 0}

    def fake_chat_json(self, messages, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return (
                {
                    "questions": [
                        {
                            "type": "single",
                            "question": "部分落库测试题一：Python 中用于给变量赋值的运算符是？",
                            "options": {"a": "赋值运算符 =", "b": "相等比较 ==", "c": "海象运算符 :=", "d": "不等于 !="},
                            "answer": "a",
                            "explanation": "单等号用于赋值。",
                            "knowledge_points": [kp.title],
                            "page_number": 2,
                        },
                        {
                            "type": "single",
                            "question": "部分落库测试题二：for 循环可遍历哪类对象？",
                            "options": {"a": "可迭代对象", "b": "仅整数", "c": "仅布尔", "d": "仅空值"},
                            "answer": "a",
                            "explanation": "for 遍历可迭代对象。",
                            "knowledge_points": [kp.title],
                            "page_number": 3,
                        },
                    ]
                },
                {},
            )
        raise course_studio_jobs.JobCancelled("任务已取消")

    monkeypatch.setattr(studio_llm.LLMClient, "chat_json", fake_chat_json)

    queued = client.post(
        f"/api/teacher/courses/{instance_id}/course-studio/chapters/{chapter.id}/exercises/generate",
        json={"point_quotas": [{"knowledge_point_id": kp.id, "single": 2, "multiple": 0, "true_false": 2, "fill_blank": 0}]},
        headers=teacher["headers"],
    )
    assert queued.status_code == 202, queued.text
    job_id = queued.json()["id"]
    assert course_studio_jobs.run_next(db) is True

    snap = client.get(f"/api/teacher/courses/{instance_id}/course-studio/jobs/{job_id}", headers=teacher["headers"]).json()
    assert snap["status"] == "cancelled"
    assert snap["result"]["created"] == 2
    assert "取消前已生成并入库 2 道待审题目" in snap["progress"]["message"]

    # Server restart interrupt_running preserves partial created count message too.
    interrupted_job = course_studio_jobs.enqueue_job(
        db,
        course_instance_id=instance_id,
        kind="exercises_generate",
        scope_key=f"chapter:{chapter.id}:exercises-restart",
        total=12,
        message="正在生成（4/12 批）…",
    )
    interrupted_job.status = "running"
    interrupted_job.result = {"chapter_id": chapter.id, "created": 5, "skipped": 1}
    db.commit()
    assert course_studio_jobs.interrupt_running(db) >= 1
    db.expire_all()
    after_restart = course_studio_jobs.get_job(db, instance_id, interrupted_job.id)
    assert after_restart.status == "interrupted"
    assert after_restart.result["created"] == 5
    assert after_restart.progress["message"] == "中断前已生成并入库 5 道待审题目（跳过重复或无效 1 道）"


def test_exercise_store_blocks_near_duplicate_rewording(db, teacher, classroom) -> None:
    from app.course_studio import exercise_store

    instance_id = db.info["fixture_course_instance_id"]
    chapter = db.scalar(select(Chapter).where(Chapter.course_instance_id == instance_id).order_by(Chapter.id))
    kp = db.scalar(select(KnowledgePoint).where(KnowledgePoint.course_instance_id == instance_id, KnowledgePoint.chapter_id == chapter.id))

    first_ids, first_skipped = exercise_store.persist_generated_questions(
        db,
        instance_id=instance_id,
        chapter_id=chapter.id,
        raw_questions=[
            {
                "type": "fill_blank",
                "question": "程序对输入数据进行计算并产生输出结果的过程称为____。",
                "options": {},
                "answer": ["处理"],
                "explanation": "输入处理输出模型。",
                "knowledge_points": [kp.title],
                "page": 1,
            }
        ],
        page_origin={},
    )
    assert len(first_ids) == 1 and first_skipped == 0

    second_ids, second_skipped = exercise_store.persist_generated_questions(
        db,
        instance_id=instance_id,
        chapter_id=chapter.id,
        raw_questions=[
            {
                "type": "fill_blank",
                "question": "程序对输入数据进行计算产生输出结果的过程称为____。",
                "options": {},
                "answer": ["处理"],
                "explanation": "只删了一个并字，应被拦截。",
                "knowledge_points": [kp.title],
                "page": 1,
            },
            {
                "type": "fill_blank",
                "question": "Python 中用于获取用户输入并返回字符串的内置函数是____。",
                "options": {},
                "answer": ["input"],
                "explanation": "全新题目应正常入库。",
                "knowledge_points": [kp.title],
                "page": 1,
            },
        ],
        page_origin={},
    )
    assert len(second_ids) == 1
    assert second_skipped == 1


def test_question_bank_page_returns_and_filters_difficulty(client, db, teacher, classroom) -> None:
    from app.course_studio import exercise_store

    instance_id = db.info["fixture_course_instance_id"]
    chapter = db.scalar(select(Chapter).where(Chapter.course_instance_id == instance_id).order_by(Chapter.id))
    kp = db.scalar(select(KnowledgePoint).where(KnowledgePoint.course_instance_id == instance_id, KnowledgePoint.chapter_id == chapter.id))

    created_ids, _ = exercise_store.persist_generated_questions(
        db,
        instance_id=instance_id,
        chapter_id=chapter.id,
        raw_questions=[
            {
                "type": "single",
                "question": "执行代码 a = [1, 2]; b = a; b.append(3) 后，len(a) 为？",
                "options": {"a": "2", "b": "3", "c": "4", "d": "报错"},
                "answer": "b",
                "difficulty": "难",
                "explanation": "列表赋值传递引用，修改 b 会同步影响 a，因此 len(a) 为 3。",
                "knowledge_points": [kp.title],
                "page": 1,
            },
            {
                "type": "fill_blank",
                "question": "Python 中求列表长度的内置函数是____。",
                "options": {},
                "answer": ["len"],
                "difficulty": "易",
                "explanation": "内置函数 len() 用于返回序列或集合的长度。",
                "knowledge_points": [kp.title],
                "page": 1,
            },
        ],
        page_origin={},
    )
    assert len(created_ids) == 2

    hard = client.get(
        f"/api/teacher/courses/{instance_id}/questions?page=1&size=20&difficulty=难",
        headers=teacher["headers"],
    )
    assert hard.status_code == 200, hard.text
    hard_items = hard.json()["items"]
    assert len(hard_items) == 1
    assert hard_items[0]["difficulty"] == "难"

    easy = client.get(
        f"/api/teacher/courses/{instance_id}/questions?page=1&size=20&difficulty=易",
        headers=teacher["headers"],
    )
    assert easy.status_code == 200
    assert [it["difficulty"] for it in easy.json()["items"]] == ["易"]

    unset = client.get(
        f"/api/teacher/courses/{instance_id}/questions?page=1&size=50&difficulty=unset",
        headers=teacher["headers"],
    )
    assert unset.status_code == 200
    assert all(not it["difficulty"] for it in unset.json()["items"])
