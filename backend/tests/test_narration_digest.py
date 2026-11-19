"""整理原文（digest）：多页一窗写 page_contents、幂等复用、缺页失败、发图策略。"""
import json

import pytest

from app.narration import digest, repository

from test_narration import url
from test_narration_generation import doc_material, slide_material


@pytest.fixture(autouse=True)
def probe(monkeypatch, tmp_path):
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    monkeypatch.setenv("REBORN_STORAGE_ROOT", str(tmp_path / "storage"))
    state: dict = {"calls": [], "drop": None}

    def fake_chat(messages, *, settings, model, **kwargs):
        user = messages[1]["content"]
        text = user if isinstance(user, str) else user[0]["text"]
        payload = json.loads(text[text.index("\n\n{"):])
        wanted = [page["page_no"] for page in payload["pages"]]
        if state["drop"] is not None:
            wanted = [page for page in wanted if page != state["drop"]]
        pages = [{"page_no": page, "title": f"主题{page}", "topic": "一句话主题",
                  "tags": ["标签A", "标签A", "标签B"], "text": f"整理后的第{page}页"} for page in wanted]
        state["calls"].append({"pages": wanted, "model": model,
                               "images": 0 if isinstance(user, str) else sum(1 for part in user if part.get("type") == "image_url")})
        return {"raw": {"pages": pages}, "text": "", "bridge_in": "", "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.digest.model_client.chat", fake_chat)
    return state


def start(client, classroom, teacher, material):
    return client.post(url(classroom, material, "/digest"), headers=teacher["headers"])


def test_digest_writes_structured_pages(client, db, classroom, teacher, run_jobs, probe):
    material = doc_material(db, classroom, "一" * 300, "二" * 300, "三" * 300)
    db.commit()

    queued = start(client, classroom, teacher, material)
    assert queued.status_code == 202, queued.text
    assert queued.json()["job"]["queued"] is True

    run_jobs()
    rows = repository.content_rows(db, material.id)
    assert [row.page_no for row in rows] == [1, 2, 3]
    assert all(row.title == f"主题{row.page_no}" for row in rows)
    assert rows[0].tags == ["标签A", "标签B"], "重复标签只留一次"
    assert (rows[0].source, rows[0].status, rows[0].image_state) == ("ai", "draft", "policy")
    assert rows[0].prompt_version == digest.DIGEST_VERSION
    assert material.content["pages"][0]["text"] == "一" * 300, "整理稿不覆盖 raw"

    job = client.get(url(classroom, material, "/job"), headers=teacher["headers"]).json()
    assert job["status"] == "done" and (job["done"], job["total"]) == (1, 1)


def test_second_run_reuses_digest_without_calling_the_model(client, db, classroom, teacher, run_jobs, probe):
    material = doc_material(db, classroom, "一" * 300, "二" * 300)
    db.commit()
    start(client, classroom, teacher, material)
    run_jobs()
    first = len(probe["calls"])

    start(client, classroom, teacher, material)
    run_jobs()
    assert len(probe["calls"]) == first, "整理稿没变时不应再花钱"
    assert client.get(url(classroom, material, "/job"), headers=teacher["headers"]).json()["status"] == "done"


def test_changed_raw_page_is_the_only_one_redigested(client, db, classroom, teacher, run_jobs, probe):
    material = doc_material(db, classroom, "一" * 300, "二" * 300, "三" * 300)
    db.commit()
    start(client, classroom, teacher, material)
    run_jobs()

    pages = list(material.content["pages"])
    pages[1] = {**pages[1], "text": "改过的" * 80}
    material.content = {**material.content, "pages": pages}
    db.flush()

    before = len(probe["calls"])
    start(client, classroom, teacher, material)
    run_jobs()
    assert [call["pages"] for call in probe["calls"][before:]] == [[2]], "只整理原文变了的那一页"


def test_missing_page_in_reply_fails_the_window_without_writing(client, db, classroom, teacher, run_jobs, probe):
    material = doc_material(db, classroom, *(("页" * 300) for _ in range(5)))
    db.commit()
    probe["drop"] = 5  # 第二窗（第 5 页）缺页

    start(client, classroom, teacher, material)
    run_jobs()

    rows = repository.content_rows(db, material.id)
    assert [row.page_no for row in rows] == [1, 2, 3, 4], "失败窗口不写半截，已完成窗口保留"
    job = client.get(url(classroom, material, "/job"), headers=teacher["headers"]).json()
    assert job["status"] == "failed"
    assert [item["page_no"] for item in job["failed"]] == [5]
    assert "页码与输入不一致" in job["message"]


def test_digest_sends_images_for_mid_length_pages(monkeypatch, client, db, classroom, teacher, run_jobs, probe):
    material = slide_material(db, classroom, "短" * 100, "长" * 700)
    db.commit()
    monkeypatch.setattr("app.narration.digest.render.source_key", lambda material: "previews/deck.pdf")
    monkeypatch.setattr("app.narration.digest.render.render_page", lambda material, page_no: b"\xff\xd8" + bytes(64))

    start(client, classroom, teacher, material)
    run_jobs()

    rows = {row.page_no: row for row in repository.content_rows(db, material.id)}
    assert rows[1].image_state == "sent", "100 字在整理阶段仍要发图"
    assert rows[2].image_state == "policy", "700 字只发文本"
    assert probe["calls"][-1]["images"] == 1


def test_render_failure_fails_the_page(monkeypatch, client, db, classroom, teacher, run_jobs):
    material = slide_material(db, classroom, "")
    db.commit()

    def boom(material, page_no):
        raise ValueError("缺少 PDF 渲染工具")

    monkeypatch.setattr("app.narration.digest.render.source_key", lambda material: "previews/deck.pdf")
    monkeypatch.setattr("app.narration.digest.render.render_page", boom)

    start(client, classroom, teacher, material)
    run_jobs()

    assert repository.content_rows(db, material.id) == [], "渲染失败不能退化成纯文本整理"
    job = client.get(url(classroom, material, "/job"), headers=teacher["headers"]).json()
    assert job["status"] == "failed" and "页图渲染失败" in job["message"]


def test_digest_requires_authoring_credentials(monkeypatch, client, db, classroom, teacher):
    material = doc_material(db, classroom, "一" * 300)
    db.commit()
    monkeypatch.delenv("REBORN_AUTHORING_AI_API_KEY")
    response = start(client, classroom, teacher, material)
    assert response.status_code == 409
