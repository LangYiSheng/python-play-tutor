"""Narration generation: idempotency, image routing, quota and per-page failure isolation.

The model and the renderer are seams: these tests never call a provider or poppler.
"""
import json

import pytest

from app.narration import client as model_client
from app.narration import render, service

from test_narration import material_fixture, pages, url


@pytest.fixture(autouse=True)
def authoring_key(monkeypatch):
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    monkeypatch.setenv("REBORN_AUTHORING_AI_MODEL", "deepseek-flash")
    monkeypatch.setenv("REBORN_AUTHORING_AI_EFFORT", "none")
    monkeypatch.delenv("REBORN_AUTHORING_AI_VISION_MODEL", raising=False)
    monkeypatch.setenv("REBORN_AUTHORING_AI_DAILY_PAGES", "10")


@pytest.fixture
def calls(monkeypatch):
    recorded = []

    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True, **kwargs):
        recorded.append({"messages": messages, "model": model, "settings": settings})
        user = messages[1]["content"]
        marker = "本窗每页的整理稿：\n"
        body = json.loads(user.split(marker, 1)[1]) if marker in user else {}
        pages_in = body.get("pages") or []
        if pages_in:
            return {"raw": {"pages": [{"page_no": page["page_no"], "text": "这一页讲的是变量。",
                                       "anchors": ["变量", "赋值"]} for page in pages_in]},
                    "text": "", "bridge_in": "", "anchors": [], "usage": {"prompt_tokens": 100, "completion_tokens": 50},
                    "model": model}
        return {"raw": {"text": "这一页讲的是变量。", "anchors": ["变量", "赋值"]}, "text": "这一页讲的是变量。",
                "bridge_in": "", "anchors": ["变量"], "usage": {"prompt_tokens": 100, "completion_tokens": 50},
                "model": model}

    monkeypatch.setattr(service.model_client, "chat", fake_chat)
    return recorded


def doc_material(db, classroom, *texts):
    """PDF with extracted text long enough to take the text-only model route."""
    padded = tuple(text * (1 + 240 // max(1, len(text))) for text in texts)
    return material_fixture(db, classroom, padded, kind="pdf")


def slide_material(db, classroom, *texts):
    material = material_fixture(db, classroom, texts, kind="presentation")
    material.content = {**pages(*texts), "preview_key": "previews/slides.pdf"}
    db.flush()
    return material


def generate(client, classroom, material, page_no, headers, **body):
    return client.post(url(classroom, material, f"/{page_no}/generate"), json=body or None, headers=headers)


def test_generate_writes_a_draft_and_reuses_identical_input(client, db, classroom, teacher, calls):
    # 锚点必须真的出现在本页文本里；这里让页面包含锚点用词，验证的是落地校验而不是过滤。
    material = doc_material(db, classroom, "变量与赋值。" * 40)
    db.commit()
    first = generate(client, classroom, material, 1, teacher["headers"])
    assert first.status_code == 200, first.text
    assert first.json() == {"page_no": 1, "status": "draft", "reused": False, "model": "deepseek-flash",
                            "chars": 9, "image_used": False}
    assert len(calls) == 1

    again = generate(client, classroom, material, 1, teacher["headers"])
    assert again.json()["reused"] is True
    assert len(calls) == 1, "同输入重跑不该再花一次调用"

    body = client.get(url(classroom, material), headers=teacher["headers"]).json()
    narration = body["pages"][0]["narration"]
    assert narration["status"] == "draft" and narration["source"] == "ai_generated"
    assert narration["anchors"] == ["变量", "赋值"]


def test_empty_page_text_without_digest_is_unavailable(client, db, classroom, teacher, calls):
    material = slide_material(db, classroom, "")
    db.commit()
    result = generate(client, classroom, material, 1, teacher["headers"])
    assert result.status_code == 409
    assert "没有可讲解的内容" in result.json()["detail"]
    assert calls == []


def test_regenerating_after_a_text_change_drops_the_old_approval(client, db, classroom, teacher, calls):
    material = doc_material(db, classroom, "第一页正文" * 30)
    db.commit()
    generate(client, classroom, material, 1, teacher["headers"])
    assert client.post(url(classroom, material, "/1/accept"), headers=teacher["headers"]).status_code == 200

    material.content = pages("第一页正文改过了" * 30)
    db.commit()
    again = generate(client, classroom, material, 1, teacher["headers"])
    assert again.status_code == 200, again.text
    assert again.json()["status"] == "draft"
    assert len(calls) == 2
    body = client.get(url(classroom, material), headers=teacher["headers"]).json()
    assert body["pages"][0]["narration"]["status"] == "draft"


def test_missing_credentials_make_generation_unavailable(client, db, classroom, teacher, monkeypatch):
    monkeypatch.delenv("REBORN_AUTHORING_AI_API_KEY", raising=False)
    material = doc_material(db, classroom, "第一页正文" * 30)
    db.commit()
    result = generate(client, classroom, material, 1, teacher["headers"])
    assert result.status_code == 409
    assert "未配置作者期模型凭据" in result.json()["detail"]
    quota = client.get(url(classroom, material, "/quota"), headers=teacher["headers"]).json()
    assert quota["available"] is False


def test_daily_quota_stops_further_calls(client, db, classroom, teacher, calls, monkeypatch):
    monkeypatch.setenv("REBORN_AUTHORING_AI_DAILY_PAGES", "1")
    material = doc_material(db, classroom, "第一页正文" * 30, "第二页正文" * 30)
    db.commit()
    assert generate(client, classroom, material, 1, teacher["headers"]).status_code == 200
    blocked = generate(client, classroom, material, 2, teacher["headers"])
    assert blocked.status_code == 409
    assert "额度已用完" in blocked.json()["detail"]
    assert len(calls) == 1


def test_window_failure_keeps_completed_windows(client, db, classroom, teacher, run_jobs, monkeypatch):
    """一窗失败只影响这一窗：前 4 页保留，后 4 页进失败列表。"""
    material = doc_material(db, classroom, *[f"第{i}页正文" * 40 for i in range(1, 9)])
    db.commit()

    def flaky(messages, *, settings, model, **kwargs):
        user = messages[1]["content"]
        marker = "本窗每页的整理稿：\n"
        body = json.loads(user.split(marker, 1)[1])
        pages = [page["page_no"] for page in body["pages"]]
        if any(no > 4 for no in pages):
            raise model_client.ModelFailed("模型返回空内容，请重试")
        return {"raw": {"pages": [{"page_no": no, "text": "讲稿正文。", "anchors": []} for no in pages]},
                "usage": {}, "model": model}

    monkeypatch.setattr(service.model_client, "chat", flaky)
    result = client.post(url(classroom, material, "/generate"),
                         json={"first_page": 1, "last_page": 8}, headers=teacher["headers"])
    assert result.status_code == 202, result.text
    run_jobs()
    body = client.get(url(classroom, material), headers=teacher["headers"]).json()
    assert body["coverage"]["covered"] == 4
    finished = client.get(url(classroom, material, "/job"), headers=teacher["headers"]).json()
    assert finished["status"] == "failed"
    assert [item["page_no"] for item in finished["failed"]] == [5, 6, 7, 8]


def test_students_cannot_generate(client, db, classroom, teacher, student, calls):
    material = doc_material(db, classroom, "第一页正文" * 30)
    db.commit()
    refused = client.post(url(classroom, material, "/1/generate"), headers=student["headers"])
    assert refused.status_code == 403
    assert calls == []


def test_render_refuses_a_material_without_pdf_source(db):
    class Fake:
        content = {}
        storage_key = "materials/x.mp4"

    assert render.render_page(Fake(), 1) is None
