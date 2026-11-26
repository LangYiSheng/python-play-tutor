"""Bulk narration uses four-page source windows and per-page input fingerprints."""
# ruff: noqa: F811
import json

import pytest

from test_narration import url
from test_narration_generation import calls, doc_material  # noqa: F401


@pytest.fixture(autouse=True)
def authoring(monkeypatch):
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    monkeypatch.setenv("REBORN_AUTHORING_AI_MODEL", "test-model")
    monkeypatch.setenv("REBORN_AUTHORING_AI_DAILY_PAGES", "10")


@pytest.mark.parametrize("mode", ["serial", "independent"])
def test_bulk_generation_isolates_windows(client, db, classroom, teacher, run_jobs, calls, mode):
    material = doc_material(db, classroom, *(f"本页唯一内容{n}。" * 35 for n in range(1, 8)))
    db.commit()
    response = client.post(url(classroom, material, "/generate"),
                           json={"first_page": 1, "last_page": 7, "mode": mode},
                           headers=teacher["headers"])
    assert response.status_code == 202, response.text
    run_jobs()
    prompts = [call["messages"][1]["content"] for call in calls]
    windows = [json.loads(prompt.split("本窗每页的整理稿：\n", 1)[1])["pages"] for prompt in prompts]
    assert [[page["page_no"] for page in window] for window in windows] == [[1, 2, 3, 4], [5, 6, 7]]
    assert "本页唯一内容1。" not in prompts[1] and "这一页讲的是变量。" not in prompts[1]
    status = client.get(url(classroom, material, "/job"), headers=teacher["headers"]).json()
    assert status["status"] == "done" and status["done"] == 7


def test_unmodified_page_reuses_its_own_input_after_another_page_is_edited(client, db, classroom, teacher, run_jobs, calls):
    material = doc_material(db, classroom, "第一页正文" * 40, "第二页正文" * 40)
    db.commit()
    headers = teacher["headers"]
    response = client.post(url(classroom, material, "/generate"), json={"first_page": 1, "last_page": 2}, headers=headers)
    assert response.status_code == 202
    run_jobs()
    assert len(calls) == 1
    changed = client.put(url(classroom, material, "/1"), json={"text": "换成新的第一页讲法。"}, headers=headers)
    assert changed.status_code == 200
    reused = client.post(url(classroom, material, "/2/generate"), headers=headers)
    assert reused.status_code == 200 and reused.json()["reused"]
    assert len(calls) == 1
