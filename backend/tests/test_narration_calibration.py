"""Whole-deck calibration: it runs in the background, walks windows, and reports.

A request only queues: nothing is called until the worker picks the job up, which is why
every test here drives `run_jobs()` before reading the report.
"""
import json

import pytest

from app.narration import calibrate, repository
from app.narration import client as model_client

from test_narration import url
from test_narration_generation import doc_material


@pytest.fixture(autouse=True)
def authoring_key(monkeypatch):
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    monkeypatch.setenv("REBORN_AUTHORING_AI_MODEL", "deepseek-flash")


def narrate(client, classroom, material, teacher, pages):
    for page_no in pages:
        result = client.post(url(classroom, material, f"/{page_no}/generate"), json=None, headers=teacher["headers"])
        assert result.status_code == 200, result.text


@pytest.fixture
def generated(client, db, classroom, teacher, monkeypatch):
    """Three narrated pages; the model itself is stubbed so only calibration logic runs."""
    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        return {"raw": {"text": "讲解。"}, "text": "讲解。", "bridge_in": "", "anchors": [],
                "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.service.model_client.chat", fake_chat)
    material = doc_material(db, classroom, "一" * 300, "二" * 300, "三" * 300)
    db.commit()
    narrate(client, classroom, material, teacher, [1, 2, 3])
    return material


def queue(client, classroom, material, teacher, path="/calibrate"):
    return client.post(url(classroom, material, path), headers=teacher["headers"])


def report(client, classroom, material, teacher, *, partial=False):
    suffix = "?partial=1" if partial else ""
    return client.get(url(classroom, material, f"/calibrate{suffix}"), headers=teacher["headers"])


def job(client, classroom, material, teacher):
    return client.get(url(classroom, material, "/job"), headers=teacher["headers"]).json()


def test_calibration_is_queued_and_runs_only_when_the_worker_picks_it_up(
        client, db, classroom, teacher, generated, run_jobs, monkeypatch):
    """请求只入队：老师可以立刻切走，模型调用由后台发起。"""
    calls = []

    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        calls.append(1)
        return {"raw": {"summary": "摘要", "terms": [], "issues": []}, "text": "", "bridge_in": "",
                "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    started = queue(client, classroom, generated, teacher)
    assert started.status_code == 202, started.text
    assert started.json()["job"]["queued"] is True and started.json()["job"]["status"] == "running"
    assert calls == [] and report(client, classroom, generated, teacher).status_code == 404

    run_jobs()
    stored = report(client, classroom, generated, teacher)
    assert stored.status_code == 200 and stored.json()["complete"] is True
    finished = job(client, classroom, generated, teacher)
    assert finished["status"] == "done" and finished["done"] == finished["total"] == 1
    assert len(calls) == 1


def test_one_request_cannot_start_twice(client, db, classroom, teacher, generated, monkeypatch):
    monkeypatch.setattr("app.narration.calibrate.model_client.chat",
                        lambda messages, **kwargs: {"raw": {"summary": "摘要", "terms": [], "issues": []},
                                                    "text": "", "bridge_in": "", "anchors": [], "usage": {},
                                                    "model": kwargs.get("model")})
    assert queue(client, classroom, generated, teacher).status_code == 202
    again = queue(client, classroom, generated, teacher)
    assert again.status_code == 409 and "正在处理中" in again.json()["detail"]


def test_calibration_walks_the_deck_with_one_call_per_window(client, db, classroom, teacher, generated, run_jobs, monkeypatch):
    seen = []

    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        payload = json.loads(messages[1]["content"].rsplit("\n\n", 1)[1])
        seen.append({"pages": [page["page_no"] for page in payload["pages"]], "summary": payload["summary"],
                     "effort": effort, "require_text": require_text})
        return {"raw": {"summary": f"已看过 {payload['pages'][-1]['page_no']} 页", "terms": ["变量"],
                        "issues": [{"page_no": 2, "kind": "flow", "detail": "第二页开头与上一页重复"}]},
                "text": "", "bridge_in": "", "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    monkeypatch.setattr(calibrate, "WINDOW", 2)
    assert queue(client, classroom, generated, teacher).status_code == 202
    run_jobs()
    body = report(client, classroom, generated, teacher).json()
    assert body["windows"] == 2
    assert body["pages"] == 3
    # The rolling summary must be carried into the next window, not restarted.
    assert seen[0]["summary"] == "" and seen[1]["summary"] == "已看过 2 页"
    assert seen[0]["effort"] == "low", "校准要开思考，与生成不同"
    # 校准回复里没有 text 字段，不能在客户端被当成“空讲解”拦下来。
    assert all(item["require_text"] is False for item in seen)
    assert [issue["page_no"] for issue in body["issues"]] == [2]
    assert body["issues"][0]["status"] == "draft"


def test_calibration_report_is_persisted_and_reused(client, db, classroom, teacher, generated, run_jobs, monkeypatch):
    calls = []

    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        calls.append(1)
        return {"raw": {"summary": "摘要", "terms": [], "issues": []}, "text": "", "bridge_in": "",
                "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    assert queue(client, classroom, generated, teacher).status_code == 202
    run_jobs()
    stored = report(client, classroom, generated, teacher)
    assert stored.status_code == 200
    assert stored.json()["summary"] == "摘要" and stored.json()["applied_at"] is None
    assert len(calls) == 1


def test_apply_regenerates_flagged_drafts_only(client, db, classroom, teacher, generated, run_jobs, monkeypatch):
    monkeypatch.setattr(calibrate, "WINDOW", 10)

    def calibration(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        return {"raw": {"summary": "摘要", "terms": [], "issues": [
            {"page_no": 2, "kind": "mismatch", "detail": "讲了页面没有的内容"},
            {"page_no": 3, "kind": "flow", "detail": "衔接生硬"}]}, "text": "", "bridge_in": "",
            "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", calibration)
    assert queue(client, classroom, generated, teacher).status_code == 202
    run_jobs()
    # Page 3 is approved, so it must be reported but never rewritten.
    assert client.post(url(classroom, generated, "/3/accept"), headers=teacher["headers"]).status_code == 200
    assert queue(client, classroom, generated, teacher).status_code == 202
    run_jobs()

    regenerated = []

    def fake_generate(db, material, page_no, *, instance_id, target_seconds=None):
        regenerated.append(page_no)
        return {"page_no": page_no, "status": "draft", "reused": False, "model": "deepseek-flash"}

    monkeypatch.setattr("app.narration.service.generate_page", fake_generate)
    applied = client.post(url(classroom, generated, "/calibrate/apply"), headers=teacher["headers"])
    assert applied.status_code == 200, applied.text
    assert applied.json()["regenerated"] == [2]
    assert applied.json()["awaiting_teacher"] == [3]
    assert regenerated == [2]


def test_calibration_reports_failure_when_nothing_was_generated(client, db, classroom, teacher):
    material = doc_material(db, classroom, "一" * 300)
    db.commit()
    refused = queue(client, classroom, material, teacher)
    assert refused.status_code == 404
    assert "没有可校准的讲解" in refused.json()["detail"]


def test_model_errors_finish_the_job_with_a_readable_reason(client, db, classroom, teacher, generated, run_jobs, monkeypatch):
    def broken(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        raise model_client.ModelFailed("模型返回空内容，请重试")

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", broken)
    assert queue(client, classroom, generated, teacher).status_code == 202
    run_jobs()
    finished = job(client, classroom, generated, teacher)
    assert finished["status"] == "failed" and "模型" in finished["message"]
    # 失败的报告不出现在正常读取里，也不允许 apply。
    assert report(client, classroom, generated, teacher).status_code == 404


def test_a_failed_run_resumes_from_the_cursor(client, db, classroom, teacher, generated, run_jobs, monkeypatch):
    """后台任务失败后重发，只补剩余窗口；已完成的窗口绝不重算。"""
    monkeypatch.setattr(calibrate, "WINDOW", 1)
    seen = []
    fail = {"left": True}

    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        payload = json.loads(messages[1]["content"].rsplit("\n\n", 1)[1])
        page_no = payload["pages"][-1]["page_no"]
        seen.append((page_no, payload["summary"]))
        if page_no == 2 and fail["left"]:
            fail["left"] = False
            raise model_client.ModelFailed("作者期模型返回 500：upstream exploded")
        return {"raw": {"summary": f"看过{page_no}页", "terms": [], "issues": []},
                "text": "", "bridge_in": "", "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    assert queue(client, classroom, generated, teacher).status_code == 202
    run_jobs()
    assert job(client, classroom, generated, teacher)["status"] == "failed"
    assert report(client, classroom, generated, teacher, partial=True).json()["windows_done"] == 1

    assert queue(client, classroom, generated, teacher).status_code == 202
    run_jobs()
    assert report(client, classroom, generated, teacher).json()["complete"] is True
    # 第一轮跑第 1 窗，第二轮从第 2 窗接着跑到第 3 窗，没有回头重算。
    assert [item[0] for item in seen] == [1, 2, 2, 3]
    assert [item[1] for item in seen][2:] == ["看过1页", "看过2页"]


def test_generated_pages_are_not_merged_into_this_fixture(client, db, classroom, teacher, generated):
    """Coverage guard: the fixture really narrates three pages, so the tests above mean something."""
    assert len(repository.rows(db, generated.id)) == 3


def test_identical_deck_reuses_the_finished_report(client, db, classroom, teacher, generated, run_jobs, monkeypatch):
    calls = []

    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        calls.append(1)
        return {"raw": {"summary": "摘要", "terms": ["变量"], "issues": [
            {"page_no": 2, "kind": "flow", "detail": "衔接重复"}]}, "text": "", "bridge_in": "",
            "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    assert queue(client, classroom, generated, teacher).status_code == 202
    run_jobs()
    first = report(client, classroom, generated, teacher).json()
    assert first["complete"] is True
    assert len(calls) == 1

    assert queue(client, classroom, generated, teacher).status_code == 202
    run_jobs()
    again = report(client, classroom, generated, teacher).json()
    assert again["complete"] is True and again["id"] == first["id"]
    assert again["reused"] is True and first["reused"] is False
    assert again["summary"] == "摘要"
    assert len(calls) == 1, "整册输入未变时不该再花一次调用"


def test_changed_page_content_starts_a_new_run(client, db, classroom, teacher, generated, run_jobs, monkeypatch):
    calls = []

    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        calls.append(1)
        return {"raw": {"summary": "摘要", "terms": [], "issues": []}, "text": "", "bridge_in": "",
                "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    assert queue(client, classroom, generated, teacher).status_code == 202
    run_jobs()
    first = report(client, classroom, generated, teacher).json()
    assert first["complete"] is True
    repository.upsert(db, generated, 2, text="改写过的第二页讲解")
    db.commit()
    assert queue(client, classroom, generated, teacher).status_code == 202
    run_jobs()
    second = report(client, classroom, generated, teacher).json()
    assert second["id"] != first["id"]
    assert len(calls) == 2


def test_partial_report_is_readable_but_never_applied(client, db, classroom, teacher, generated, monkeypatch):
    """跑到一半的（进程被杀）报告可以看进度，但不能拿去 apply。"""
    monkeypatch.setattr(calibrate, "WINDOW", 1)
    monkeypatch.setattr(calibrate, "SLICE_SECONDS", 0)
    monkeypatch.setattr("app.narration.calibrate.model_client.chat",
                        lambda messages, **kwargs: {"raw": {"summary": "半份", "terms": [], "issues": [
                            {"page_no": 1, "kind": "flow", "detail": "x"}]}, "text": "", "bridge_in": "",
                            "anchors": [], "usage": {}, "model": kwargs.get("model")})
    repository.acquire(db, generated, "calibrate", None)
    calibrate.run_slice(db, generated)
    # 没有完整报告
    assert report(client, classroom, generated, teacher).status_code == 404
    partial = report(client, classroom, generated, teacher, partial=True)
    assert partial.status_code == 200, partial.text
    assert partial.json()["complete"] is False and partial.json()["windows_done"] == 1
    refused = client.post(url(classroom, generated, "/calibrate/apply"), headers=teacher["headers"])
    assert refused.status_code == 409 and "尚未完成" in refused.json()["detail"]


def test_model_prefix_is_identical_across_windows(client, db, classroom, teacher, generated, run_jobs, monkeypatch):
    """供应商只认前缀逐字相同；这条测试锁住“别往前缀里塞可变内容”。"""
    monkeypatch.setattr(calibrate, "WINDOW", 1)
    seen = []

    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        seen.append((messages[0]["content"], messages[1]["content"].rsplit("\n\n", 1)[0]))
        return {"raw": {"summary": "摘要", "terms": [], "issues": []}, "text": "", "bridge_in": "",
                "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    assert queue(client, classroom, generated, teacher).status_code == 202
    run_jobs()
    assert len(seen) == 3
    assert len({item[0] for item in seen}) == 1, "system 提示必须整册相同"
    assert len({item[1] for item in seen}) == 1, "用户消息的前缀必须整册相同"


def test_cache_usage_is_summed_into_the_report(client, db, classroom, teacher, generated, run_jobs, monkeypatch):
    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        return {"raw": {"summary": "摘要", "terms": [], "issues": []}, "text": "", "bridge_in": "",
                "anchors": [], "usage": {"prompt_tokens": 100, "completion_tokens": 20,
                                         "cache_hit_tokens": 80, "cache_miss_tokens": 20}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    assert queue(client, classroom, generated, teacher).status_code == 202
    run_jobs()
    body = report(client, classroom, generated, teacher).json()
    assert body["usage"] == {"prompt_tokens": 100, "completion_tokens": 20,
                             "cache_hit_tokens": 80, "cache_miss_tokens": 20}


def test_length_error_retries_the_window_with_a_reduced_budget(client, db, classroom, teacher, run_jobs, monkeypatch):
    material = doc_material(db, classroom, "一" * 300)
    repository.upsert(db, material, 1, text="讲" * 3900)
    db.commit()
    budgets = []

    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        payload = json.loads(messages[1]["content"].rsplit("\n\n", 1)[1])
        budgets.append(len(payload["pages"][0]["narration"]))
        if len(budgets) == 1:
            raise model_client.ModelFailed("作者期模型返回 400：maximum context length exceeded", hint="length")
        return {"raw": {"summary": "摘要", "terms": [], "issues": []}, "text": "", "bridge_in": "",
                "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    assert queue(client, classroom, material, teacher).status_code == 202
    run_jobs()
    body = report(client, classroom, material, teacher).json()
    assert budgets == [3900, 3150], "第二次必须用减半的预算"
    assert body["shrunk_windows"] == [1]


def test_other_model_failures_are_not_retried(client, db, classroom, teacher, generated, run_jobs, monkeypatch):
    calls = []

    def broken(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        calls.append(1)
        raise model_client.ModelFailed("作者期模型返回 400：invalid model")

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", broken)
    assert queue(client, classroom, generated, teacher).status_code == 202
    run_jobs()
    assert job(client, classroom, generated, teacher)["status"] == "failed"
    assert len(calls) == 1, "非长度错误不该重试"


def test_restart_marks_running_jobs_interrupted(db, classroom):
    material = doc_material(db, classroom, "一" * 300)
    db.commit()
    repository.acquire(db, material, "calibrate", None)
    assert repository.interrupt_running(db) == 1
    running = repository.job_of(db, material.id)
    assert running.status == "interrupted" and not repository.job_running(running)


def test_partial_progress_survives_a_fresh_read(client, db, classroom, teacher, generated, run_jobs, monkeypatch):
    """每窗提交必须真的进库：下一片可能由另一个线程执行，不能只靠内存里的对象。"""
    monkeypatch.setattr(calibrate, "WINDOW", 1)
    monkeypatch.setattr("app.narration.calibrate.model_client.chat",
                        lambda messages, **kwargs: {"raw": {"summary": "摘要", "terms": [], "issues": []},
                                                    "text": "", "bridge_in": "", "anchors": [], "usage": {},
                                                    "model": kwargs.get("model")})
    assert queue(client, classroom, generated, teacher).status_code == 202
    run_jobs()
    # 丢掉会话里的对象后，库里的游标应当停在最后一窗。
    db.expire_all()
    stored = report(client, classroom, generated, teacher, partial=True)
    assert stored.status_code == 200, stored.text
    assert stored.json()["windows_done"] == 3 and stored.json()["complete"] is True
