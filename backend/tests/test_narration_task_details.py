from datetime import timedelta

import httpx
import pytest
from sqlalchemy import select

from app.models import now
from app.narration import calibrate, client as model_client, jobs, repository, task_commands
from app.narration.models import NarrationCalibration, NarrationJob, NarrationRun
from test_narration import material_fixture
from test_synthesis_management import overview


def test_resumed_calibration_uses_matching_report_and_dismissal_preserves_history(client, db, classroom, teacher, student):
    material = material_fixture(db, classroom, ["正文"] * 50)
    start = now() - timedelta(hours=1)
    previous = NarrationRun(material_id=material.id, kind="pipeline", status="failed", started_at=start,
        finished_at=start + timedelta(minutes=10), progress={"stage": "calibrate", "done": 1, "total": 13})
    report = NarrationCalibration(material_id=material.id, created_at=start + timedelta(minutes=1), windows=13,
        report={"complete": False, "calibrate_version": "cal-v4", "next_index": 2, "windows_done": 2,
                "pages_seen": 8, "pages": 50, "windows": 13, "revisions": {str(i): "rev" for i in range(1, 51)}})
    job = NarrationJob(material_id=material.id, kind="pipeline", status="failed", started_at=start + timedelta(minutes=20),
        finished_at=start + timedelta(minutes=30), message="作者期模型请求失败，请稍后重试",
        progress={"request": {"operation": "pipeline", "chain": ["calibrate", "apply", "script"]},
                  "stage": "calibrate", "failed_stage": "calibrate", "done": 2, "total": 13})
    db.add_all([previous, report, job])
    repository.sync_run(db, job)
    db.commit()
    headers = teacher["headers"]
    graph = f"/api/teacher/courses/{classroom['course_id']}/course-graph/tasks"
    listed = client.get(graph, params={"classroom_id": classroom["id"]}, headers=headers)
    assert listed.status_code == 200, listed.text
    task, = listed.json()
    detail_path = overview(classroom) + f"/runs/{task['run_id']}"
    detail = client.get(detail_path, headers=headers).json()
    assert task["progress_unit"] == "groups" and task["percent"] == 15 and not task["queued"]
    assert task["stage_index"] == 1 and task["stage_total"] == 3 and task["stages"] == ["calibrate", "apply", "script"]
    assert detail["position"] == task["position"] and "第 3 组 · 第 9–12 页" in detail["position"]
    assert "旧记录未细分" in detail["diagnostic"] and "超时" not in detail["diagnostic"]
    assert client.get(detail_path, headers=student["headers"]).status_code == 403
    assert client.get(detail_path.replace(f"/{classroom['id']}/", "/999999/"), headers=headers).status_code in {403, 404}
    report.report = {**report.report, "pages_seen": 0}
    db.commit()
    assert client.get(detail_path, headers=headers).json()["position"] == "已完成 2 组，下一组为第 3 组"
    cancel = overview(classroom) + f"/{material.id}/cancel"
    stamp = {"expected_started_at": task["started_at"]}
    assert client.post(cancel, json={"expected_started_at": start.isoformat()}, headers=headers).status_code == 409
    for _ in range(2):
        result = client.post(cancel, json=stamp, headers=headers)
        assert result.status_code == 200 and result.json()["status"] == "cancelled" and result.json()["queue_dismissed"]
    assert client.get(graph, params={"classroom_id": classroom["id"]}, headers=headers).json() == []
    history = client.get(overview(classroom), params={"status": "failed"}, headers=headers).json()
    assert history["total"] == history["counts"]["failed"] == 1 and history["counts"]["cancelled"] == 1
    assert client.get(detail_path, headers=headers).json()["message"] == task["message"]
    db.info["narration_retry_expected"] = stamp["expected_started_at"]
    from fastapi import HTTPException
    with pytest.raises(HTTPException, match="任务或资料已变化"):
        repository.acquire(db, material, "digest", request={"operation": "digest"})
    repository.acquire(db, material, "digest", request={"operation": "digest"})
    assert client.post(cancel, json=stamp, headers=headers).status_code == 409


@pytest.mark.parametrize("fail_tags", [False, True])
def test_new_calibration_identifies_actual_window_or_tag_merge(db, classroom, monkeypatch, fail_tags):
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    material = material_fixture(db, classroom, ["页面"] * 5)
    for i in [1, 2, 4, 5]:
        repository.upsert_content(db, material, i, title="标题", text="整理稿", tags=["词"], topic="")
    db.commit()
    monkeypatch.setattr(calibrate, "_window_payload", lambda *a, **k: ({}, [], False))
    def fail(*args, **kwargs):
        raise model_client.ModelFailed("作者期模型等待响应超时")
    monkeypatch.setattr(calibrate, "_call", (lambda *a, **k: {"raw": {}, "usage": {}}) if fail_tags else fail)
    monkeypatch.setattr(calibrate, "_tag_call", fail)
    repository.enqueue(db, material, "calibrate", request={"operation": "calibrate"})
    assert jobs.drain(db) == 1
    from app.narration.management import snapshot
    record = db.scalar(select(NarrationRun).where(NarrationRun.material_id == material.id))
    detail = snapshot(material, record)
    assert detail["status"] == "failed"
    assert detail["position"] == ("合并整册标签" if fail_tags else "第 1 组 · 第 1、2、4、5 页")
    assert detail["done"] == int(fail_tags) and detail["total"] == 1
    if fail_tags:
        monkeypatch.setattr(calibrate, "_call", lambda *a, **k: pytest.fail("已完成的校准组被重复执行"))
        monkeypatch.setattr(calibrate, "_tag_call", lambda *a, **k: ({}, {}))
        repository.acquire(db, material, "calibrate", request={"operation": "calibrate"})
        assert task_commands.run_calibration(db, material)


@pytest.mark.parametrize(("error", "expected"), [
    (httpx.ReadTimeout("sensitive"), "等待响应超时"), (httpx.ConnectError("sensitive"), "网络连接"),
    (httpx.RemoteProtocolError("sensitive"), "协议"), (401, "HTTP 401"), (429, "HTTP 429"), (503, "HTTP 503"),
    (200, "解析为 JSON")])
def test_model_diagnostic_never_persists_provider_text(monkeypatch, error, expected):
    def respond(request):
        if isinstance(error, Exception):
            raise error
        return (httpx.Response(error, text="sensitive") if error == 200 else
                httpx.Response(error, json={"error": {"message": "sensitive"}}))
    client = httpx.Client
    monkeypatch.setattr(model_client, "_sleep", lambda _s: None)
    monkeypatch.setattr(httpx, "Client", lambda **kw: client(transport=httpx.MockTransport(respond), **kw))
    with pytest.raises((model_client.ModelFailed, model_client.ModelUnavailable)) as result:
        model_client.chat([], model="test", settings={"api_key": "sensitive", "base_url": "https://model.invalid",
            "max_tokens": 32, "effort": "none", "timeout": 2})
    assert expected in str(result.value) and "sensitive" not in str(result.value)


def test_model_client_retries_empty_content_and_transient_errors(monkeypatch):
    import json
    sent_bodies: list[dict] = []
    responses = [
        httpx.Response(429, json={"error": {"message": "rate limit"}}),
        httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": "   "}}]}),
        httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": '{"fixes": [], "issues": []}'}}]}),
    ]

    def respond(request):
        sent_bodies.append(json.loads(request.content.decode("utf-8")))
        return responses.pop(0)

    client_cls = httpx.Client
    monkeypatch.setattr(model_client, "_sleep", lambda _s: None)
    monkeypatch.setattr(httpx, "Client", lambda **kw: client_cls(transport=httpx.MockTransport(respond), **kw))

    reply = model_client.chat(
        [{"role": "user", "content": "hi"}],
        model="deepseek-flash",
        effort="low",
        require_text=False,
        settings={"api_key": "k", "base_url": "https://model.invalid", "max_tokens": 4000, "effort": "low", "timeout": 5},
    )
    assert reply["raw"] == {"fixes": [], "issues": []}
    assert len(sent_bodies) == 3
    assert sent_bodies[0]["reasoning_effort"] == "low"
    assert sent_bodies[1]["reasoning_effort"] == "low"
    assert sent_bodies[2]["reasoning_effort"] == "none"
    assert sent_bodies[2]["max_tokens"] == 8000


def test_model_client_raises_empty_hint_after_retries_exhausted(monkeypatch):
    calls = 0

    def respond(request):
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": ""}}]})

    client_cls = httpx.Client
    monkeypatch.setattr(model_client, "_sleep", lambda _s: None)
    monkeypatch.setattr(httpx, "Client", lambda **kw: client_cls(transport=httpx.MockTransport(respond), **kw))

    with pytest.raises(model_client.ModelFailed) as exc:
        model_client.chat(
            [{"role": "user", "content": "hi"}],
            model="deepseek-flash",
            require_text=False,
            settings={"api_key": "k", "base_url": "https://model.invalid", "max_tokens": 4000, "effort": "none", "timeout": 5},
        )
    assert calls == 3
    assert exc.value.hint == "empty"
    assert "模型返回空内容" in str(exc.value)
