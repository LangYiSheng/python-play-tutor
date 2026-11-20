"""整册校准：校对整理稿与原文、归并整册标签，并在应用时只改整理稿。

请求只入队，模型调用都由 worker 发起，所以每个用例都先跑 `run_jobs()` 再读报告。
"""
import json

import pytest

from app.narration import repository

from test_narration import url
from test_narration_generation import doc_material


def body(index: int) -> str:
    """贴近真实的整理稿长度（约 150 字），这样机械闸门既不会误放也不会误拒。"""
    return f"第{index}页整理稿。" + "这一页讲一个知识点。" * 12


@pytest.fixture(autouse=True)
def authoring(monkeypatch):
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    monkeypatch.setenv("REBORN_AUTHORING_AI_MODEL", "deepseek-flash")
    monkeypatch.setenv("REBORN_AUTHORING_AI_VISION_MODEL", "deepseek-flash")
    state: dict = {"calls": [], "fix": None, "issues": [], "tag_map": None}

    def fake_chat(messages, *, settings, model, **kwargs):
        user = messages[1]["content"]
        text = user if isinstance(user, str) else next(p["text"] for p in user if p.get("type") == "text")
        payload = json.loads(text[text.index("\n\n{"):])
        if "tags" in payload:
            state["calls"].append({"kind": "tags", "tags": payload["tags"]})
            mapping = state["tag_map"] or {tag: tag for tag in payload["tags"]}
            return {"raw": mapping, "text": "", "bridge_in": "", "anchors": [], "usage": {}, "model": model}
        state["calls"].append({"kind": "window", "pages": [page["page_no"] for page in payload["pages"]],
                               "images": 0 if isinstance(user, str) else
                               sum(1 for part in user if part.get("type") == "image_url")})
        return {"raw": {"fixes": state["fix"] or [], "issues": state["issues"]}, "text": "", "bridge_in": "",
                "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    return state


def digests(db, material, texts, *, tags=None, titles=None):
    for index, text in enumerate(texts, start=1):
        repository.upsert_content(db, material, index, title=(titles or {}).get(index, f"主题{index}"),
                                  topic="一句话主题", tags=(tags or {}).get(index, ["标签A"]), text=text)
    db.commit()


def queue(client, classroom, material, teacher):
    return client.post(url(classroom, material, "/calibrate"), headers=teacher["headers"])


def report(client, classroom, material, teacher, *, partial=False):
    suffix = "?partial=1" if partial else ""
    return client.get(url(classroom, material, f"/calibrate{suffix}"), headers=teacher["headers"])


def test_calibration_reports_fixes_and_tags_without_touching_narration(
        client, db, classroom, teacher, authoring, run_jobs):
    material = doc_material(db, classroom, "一" * 300, "二" * 300, "三" * 300)
    db.commit()
    digests(db, material, [body(1), body(2), body(3)])
    authoring["fix"] = [{"page_no": 2, "text": body(2) + "（已修正错字）", "reason": "错字"}]

    queued = queue(client, classroom, material, teacher)
    assert queued.status_code == 202 and queued.json()["job"]["queued"] is True
    run_jobs()

    entry = report(client, classroom, material, teacher).json()
    assert entry["complete"] is True and entry["reused"] is False
    assert entry["fixes"] == [{"page_no": 2, "before": body(2), "after": body(2) + "（已修正错字）",
                               "reason": "错字", "status": "pending"}]
    assert entry["tag_stats"]["before"] == 1
    assert repository.content_row(db, material.id, 2).text == body(2), "应用前不改整理稿"
    assert repository.rows(db, material.id) == [], "校准不再生成讲解稿"


def test_oversized_fix_is_downgraded_to_an_issue(client, db, classroom, teacher, authoring, run_jobs):
    material = doc_material(db, classroom, "一" * 300)
    db.commit()
    digests(db, material, [body(1)])
    authoring["fix"] = [{"page_no": 1, "text": "完全不同的重写内容" * 40, "reason": "想改写"}]

    queue(client, classroom, material, teacher)
    run_jobs()

    entry = report(client, classroom, material, teacher).json()
    assert entry["fixes"] == []
    assert entry["issues"][0]["kind"] == "ocr" and "改动过大" in entry["issues"][0]["detail"]


def test_missing_pages_in_reply_are_ignored_not_guessed(client, db, classroom, teacher, authoring, run_jobs):
    material = doc_material(db, classroom, "一" * 300, "二" * 300)
    db.commit()
    digests(db, material, [body(1), body(2)])
    authoring["fix"] = [{"page_no": 99, "text": body(99), "reason": "x"}]

    queue(client, classroom, material, teacher)
    run_jobs()
    entry = report(client, classroom, material, teacher).json()
    assert entry["fixes"] == [] and entry["issues"] == []


def test_tag_map_merges_aliases_and_closes(client, db, classroom, teacher, authoring, run_jobs):
    material = doc_material(db, classroom, "一" * 300, "二" * 300)
    db.commit()
    digests(db, material, [body(1), body(2)], tags={1: ["KNN", "K近邻"], 2: ["距离度量"]})
    authoring["tag_map"] = {"KNN": "KNN", "K近邻": "KNN", "距离度量": "距离度量"}

    queue(client, classroom, material, teacher)
    run_jobs()
    entry = report(client, classroom, material, teacher).json()
    assert entry["tag_map"] == {"KNN": "KNN", "K近邻": "KNN", "距离度量": "距离度量"}
    assert entry["tag_stats"] == {"before": 3, "after": 2, "merged": 1}


def test_apply_writes_digest_and_dictionary_keeps_draft(client, db, classroom, teacher, authoring, run_jobs):
    material = doc_material(db, classroom, "一" * 300, "二" * 300)
    db.commit()
    digests(db, material, [body(1), body(2)], tags={1: ["KNN"], 2: ["K近邻"]})
    authoring["fix"] = [{"page_no": 1, "text": body(1) + "（已修正）", "reason": "错字"}]
    authoring["tag_map"] = {"KNN": "KNN", "K近邻": "KNN"}

    queue(client, classroom, material, teacher)
    run_jobs()
    applied = client.post(url(classroom, material, "/calibrate/apply"), headers=teacher["headers"])
    assert applied.status_code == 200, applied.text
    assert applied.json() == {"applied_fixes": [1], "rejected_fixes": [], "tags": 2}

    row = repository.content_row(db, material.id, 1)
    assert (row.text, row.status) == (body(1) + "（已修正）", "draft"), "应用后仍是草稿，学生看不到"
    assert repository.tag_map(db, material.course_instance_id) == {"KNN": "KNN", "K近邻": "KNN"}
    assert repository.content_row(db, material.id, 2).text == body(2)


def test_apply_rejects_a_stale_fix(client, db, classroom, teacher, authoring, run_jobs):
    material = doc_material(db, classroom, "一" * 300)
    db.commit()
    digests(db, material, [body(1)])
    authoring["fix"] = [{"page_no": 1, "text": body(1) + "（已修正）", "reason": "错字"}]
    queue(client, classroom, material, teacher)
    run_jobs()

    # 报告之后老师又改了整理稿：旧修正不再适用。
    row = repository.content_row(db, material.id, 1)
    row.text = "老师改写过的完全不同的一段内容。" * 20
    db.commit()

    applied = client.post(url(classroom, material, "/calibrate/apply"), headers=teacher["headers"]).json()
    assert applied["applied_fixes"] == []
    assert applied["rejected_fixes"][0]["reason"].startswith("整理稿已变")
    assert repository.content_row(db, material.id, 1).text.startswith("老师改写过的")


def test_second_run_reuses_the_report(client, db, classroom, teacher, authoring, run_jobs):
    material = doc_material(db, classroom, "一" * 300, "二" * 300)
    db.commit()
    digests(db, material, [body(1), body(2)])
    queue(client, classroom, material, teacher)
    run_jobs()
    first = len(authoring["calls"])

    queue(client, classroom, material, teacher)
    run_jobs()
    assert len(authoring["calls"]) == first, "整册未变时零调用"
    assert report(client, classroom, material, teacher).json()["reused"] is True


def test_calibration_needs_digest_rows(client, db, classroom, teacher):
    material = doc_material(db, classroom, "一" * 300)
    db.commit()
    response = queue(client, classroom, material, teacher)
    assert response.status_code == 404
    assert "整理稿" in response.json()["detail"]


def test_window_sends_digest_raw_neighbors_and_images(client, db, classroom, teacher, authoring, run_jobs, monkeypatch):
    material = doc_material(db, classroom, *(("页" * 300) for _ in range(4)), *(("图" * 10) for _ in range(2)))
    db.commit()
    digests(db, material, [body(index) for index in range(1, 7)])
    monkeypatch.setattr("app.narration.calibrate.render.render_page", lambda material, page_no: b"\xff\xd8" + bytes(32))

    queue(client, classroom, material, teacher)
    run_jobs()

    calls = [call for call in authoring["calls"] if call["kind"] == "window"]
    assert [call["pages"] for call in calls] == [[1, 2, 3, 4], [5, 6]]
    assert calls[0]["images"] == 4, "300 字的页在 600 阈值下仍发图"
    assert calls[1]["images"] == 2, "两页都发图，不按上限静默截断"
