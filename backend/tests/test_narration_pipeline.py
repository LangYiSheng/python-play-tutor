"""一键链：梳理 → 校准 → 应用 → 讲解稿 → 抽取知识点；失败停在该段，重试从断点继续。"""
import pytest
from sqlalchemy import delete, select

from app.models import KnowledgePoint, MaterialChapter
from app.narration import client as model_client
from app.narration import repository

from test_narration import material_fixture, url


@pytest.fixture(autouse=True)
def authoring_key(monkeypatch):
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    monkeypatch.setenv("REBORN_AUTHORING_AI_MODEL", "deepseek-flash")
    monkeypatch.setenv("REBORN_AUTHORING_AI_EFFORT", "none")
    monkeypatch.setenv("REBORN_AUTHORING_AI_MAX_TOKENS", "8000")


def fake_chat(monkeypatch, failing: dict[str, bool]):
    calls = {"digest": 0, "calibrate": 0, "script": 0, "knowledge": 0}

    def chat(messages, *, settings, model, **kwargs):
        system = messages[0]["content"]
        if "整理一份课程幻灯片" in system:
            calls["digest"] += 1
            if failing.get("digest"):
                raise model_client.ModelFailed("整理失败")
            pages = [{"page_no": 1, "title": "变量", "topic": "这一页讲变量", "tags": ["变量"], "text": "整理后的第一页"},
                     {"page_no": 2, "title": "赋值", "topic": "这一页讲赋值", "tags": ["赋值"], "text": "整理后的第二页"}]
            return {"raw": {"pages": pages}, "text": "", "usage": {}, "model": model}
        if "校对一份课程幻灯片" in system:
            calls["calibrate"] += 1
            return {"raw": {"fixes": [{"page_no": 1, "text": "模型修正后的第一页", "reason": "错字"}],
                            "issues": [], "tag_map": {"变量": "赋值"}},
                    "text": "", "usage": {}, "model": model}
        if "合并一门课的知识标签" in system:
            return {"raw": {}, "text": "", "usage": {}, "model": model}
        if "课程知识图谱的编者" in system:
            calls["knowledge"] += 1
            if failing.get("knowledge"):
                raise model_client.ModelFailed("抽取知识点失败")
            return {
                "raw": {
                    "sections": [
                        {
                            "section": "本章",
                            "points": [
                                {"title": "变量定义", "pages": [1], "brief": "介绍变量概念"},
                                {"title": "变量赋值", "pages": [2], "brief": "介绍赋值语句"},
                            ],
                        }
                    ]
                },
                "text": "",
                "usage": {},
                "model": model,
            }
        calls["script"] += 1
        pages = [{"page_no": 1, "text": "这一页讲变量。", "anchors": ["变量"]},
                 {"page_no": 2, "text": "这一页讲赋值。", "anchors": ["赋值"]}]
        return {"raw": {"pages": pages}, "text": "", "usage": {}, "model": model}

    monkeypatch.setattr(model_client, "chat", chat)
    return calls


def test_pipeline_runs_every_stage_and_writes_digest_script_and_knowledge(client, db, classroom, teacher, run_jobs, monkeypatch):
    calls = fake_chat(monkeypatch, {})
    material = material_fixture(db, classroom, ["原始文本抬", "第二页原文"])
    db.commit()

    response = client.post(url(classroom, material, "/pipeline"), headers=teacher["headers"])
    assert response.status_code == 202, response.text
    assert response.json()["job"]["chain"] == ["digest", "calibrate", "apply", "script", "knowledge"]
    run_jobs()

    job = repository.job_of(db, material.id)
    assert job.status == "done", job.message
    assert job.progress["chain"] == []
    content = repository.content_row(db, material.id, 1)
    assert content.text == "模型修正后的第一页" and content.tags == ["变量"]
    assert "变量" in repository.tag_map(db, material.course_instance_id)
    row = repository.row(db, material.id, 1)
    assert row.status == "draft" and row.text == "这一页讲变量。"
    assert calls == {"digest": 1, "calibrate": 1, "script": 1, "knowledge": 1}

    kps = list(db.scalars(select(KnowledgePoint).where(KnowledgePoint.course_instance_id == material.course_instance_id)))
    titles = {kp.title for kp in kps}
    assert {"变量定义", "变量赋值"}.issubset(titles)
    by_title = {kp.title: kp for kp in kps}
    src = by_title["变量定义"].content["lectio"]["sources"][0]
    assert src == {"material_stable_id": material.stable_id, "pages": [1]}


def test_pipeline_failure_stops_there_and_retry_resumes(client, db, classroom, teacher, run_jobs, monkeypatch):
    failing = {"digest": True}
    calls = fake_chat(monkeypatch, failing)
    material = material_fixture(db, classroom, ["原始文本抬", "第二页原文"])
    db.commit()

    response = client.post(url(classroom, material, "/pipeline"), headers=teacher["headers"])
    assert response.status_code == 202, response.text
    run_jobs()
    job = repository.job_of(db, material.id)
    assert job.status == "failed" and job.progress["failed_stage"] == "digest"
    assert job.progress["chain"] == ["digest", "calibrate", "apply", "script", "knowledge"]
    assert calls["calibrate"] == 0 and calls["script"] == 0 and calls["knowledge"] == 0

    failing["digest"] = False
    retry = client.post(f"/api/teacher/courses/{classroom['course_id']}/synthesis/{material.id}/retry",
                        json={"expected_started_at": job.started_at.isoformat()}, headers=teacher["headers"])
    assert retry.status_code == 200, retry.text
    assert repository.job_of(db, material.id).progress.get("queued") is True
    run_jobs()

    job = repository.job_of(db, material.id)
    assert job.status == "done", job.message
    assert calls == {"digest": 2, "calibrate": 1, "script": 1, "knowledge": 1}
    assert repository.content_row(db, material.id, 1).text == "模型修正后的第一页"
    assert repository.row(db, material.id, 1).status == "draft"


def test_pipeline_skips_knowledge_when_material_has_no_chapter(client, db, classroom, teacher, run_jobs, monkeypatch):
    calls = fake_chat(monkeypatch, {})
    material = material_fixture(db, classroom, ["原始文本抬", "第二页原文"])
    db.execute(delete(MaterialChapter).where(MaterialChapter.material_id == material.id))
    db.commit()

    response = client.post(url(classroom, material, "/pipeline"), headers=teacher["headers"])
    assert response.status_code == 202, response.text
    run_jobs()

    job = repository.job_of(db, material.id)
    assert job.status == "done", job.message
    assert calls == {"digest": 1, "calibrate": 1, "script": 1, "knowledge": 0}


def test_pipeline_knowledge_failure_retries_only_knowledge_stage(client, db, classroom, teacher, run_jobs, monkeypatch):
    failing = {"knowledge": True}
    calls = fake_chat(monkeypatch, failing)
    material = material_fixture(db, classroom, ["原始文本抬", "第二页原文"])
    db.commit()

    assert client.post(url(classroom, material, "/pipeline"), headers=teacher["headers"]).status_code == 202
    run_jobs()
    job = repository.job_of(db, material.id)
    assert job.status == "failed" and job.progress["failed_stage"] == "knowledge"
    assert job.progress["chain"] == ["knowledge"]

    failing["knowledge"] = False
    retry = client.post(f"/api/teacher/courses/{classroom['course_id']}/synthesis/{material.id}/retry",
                        json={"expected_started_at": job.started_at.isoformat()}, headers=teacher["headers"])
    assert retry.status_code == 200, retry.text
    run_jobs()

    job = repository.job_of(db, material.id)
    assert job.status == "done", job.message
    assert calls == {"digest": 1, "calibrate": 1, "script": 1, "knowledge": 2}
