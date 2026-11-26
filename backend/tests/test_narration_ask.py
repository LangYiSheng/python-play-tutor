"""Narration uses the existing authorized learning assistant, never a second model path."""
from app import assistant
from app.assistant_context import MessageInput, build_tools
from app.integration_models import AssistantModelSettings
from app.models import User
from app.narration import repository
from test_narration_generation import doc_material


def test_removed_endpoint_cannot_bypass_disabled_assistant(client, db, classroom, student, monkeypatch):
    calls = []
    monkeypatch.setattr("app.narration.client.chat", lambda *a, **kw: calls.append(True))
    material = doc_material(db, classroom, "授权原文")
    db.add(AssistantModelSettings(id=1, configuration={"enabled": False}))
    db.commit()
    assert client.post("/api/assistant/sessions", json={"classroom_id": classroom["id"], "material_id": material.id}, headers=student["headers"]).status_code == 403
    assert client.post(f"/api/materials/{material.id}/narrations/1/ask?classroom_id={classroom['id']}", json={"question": "为什么"}, headers=student["headers"]).status_code == 404
    assert calls == []


def test_learning_tools_receive_only_current_approved_narration(client, db, classroom, student, teacher):
    material = doc_material(db, classroom, "本页原文", "下页原文")
    approved = repository.upsert(db, material, 1, text="教师解释" * 800)
    repository.decide(db, material, 1, "accepted", db.get(User, teacher["id"]))
    repository.upsert(db, material, 2, text="秘密草稿")
    db.commit()
    response = client.post("/api/assistant/sessions", json={"classroom_id": classroom["id"], "material_id": material.id}, headers=student["headers"])
    assert response.status_code == 201, response.text
    user = db.get(User, student["id"])
    session, activity = assistant.authorized_session(db, user, response.json()["id"])
    body = MessageInput(message="解释讲解", state={"page_no": 1})
    context = assistant.build_context(db, user, session, activity, body)
    assert "教师解释" in context["pages"][0]["excerpt"]
    assert "秘密草稿" not in str(context)
    tools = {t.name: t for t in build_tools(context, {})}
    assert set(tools) == {"list_material_pages", "search_material_pages", "read_material_page", "get_reading_progress"}
    tail = tools["read_material_page"].invoke({"page_no": 1, "offset": 2200, "limit": 800})
    assert "教师解释" in tail["text"]
    # A frozen running turn is unaffected by a later replacement; the next turn excludes stale narration.
    material.storage_key = "replacement.pdf"
    db.commit()
    newer = assistant.build_context(db, user, session, activity, body)
    assert "教师解释" not in str(newer)
    assert "教师解释" in context["pages"][0]["excerpt"]
    assert approved.status == "accepted"  # Read-only context filtering does not rewrite history.


def test_learning_context_prefers_the_digest_and_labels_raw_pages(client, db, classroom, student):
    material = doc_material(db, classroom, "原始第一页", "原始第二页")
    repository.upsert_content(db, material, 1, title="变量", topic="赋值", tags=["变量"], text="整理后的第一页")
    db.commit()
    response = client.post("/api/assistant/sessions", json={"classroom_id": classroom["id"], "material_id": material.id}, headers=student["headers"])
    assert response.status_code == 201, response.text
    user = db.get(User, student["id"])
    session, activity = assistant.authorized_session(db, user, response.json()["id"])

    first = assistant.build_context(db, user, session, activity, MessageInput(message="解释", state={"page_no": 1}))
    assert first["current_page"]["excerpt"] == "整理后的第一页"
    assert first["current_page"]["excerpt_source"] == "digest"

    second = assistant.build_context(db, user, session, activity, MessageInput(message="解释", state={"page_no": 2}))
    assert second["current_page"]["excerpt"].startswith("原始第二页")
    assert second["current_page"]["excerpt_source"] == "raw"
