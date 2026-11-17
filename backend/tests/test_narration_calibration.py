"""Whole-deck calibration: the rolling window, the report, and who may be rewritten."""
import pytest

from app.narration import calibrate
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


def test_calibration_walks_the_deck_with_one_call_per_window(client, db, classroom, teacher, generated, monkeypatch):
    seen = []

    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        payload_text = messages[1]["content"].rsplit("\n\n", 1)[1]
        import json

        payload = json.loads(payload_text)
        seen.append({"pages": [page["page_no"] for page in payload["pages"]], "summary": payload["summary"],
                     "effort": effort, "require_text": require_text})
        return {"raw": {"summary": f"已看过 {payload['pages'][-1]['page_no']} 页", "terms": ["变量"],
                        "issues": [{"page_no": 2, "kind": "flow", "detail": "第二页开头与上一页重复"}]},
                "text": "", "bridge_in": "", "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    monkeypatch.setattr(calibrate, "WINDOW", 2)
    result = client.post(url(classroom, generated, "/calibrate"), headers=teacher["headers"])
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["windows"] == 2
    assert body["pages"] == 3
    # The rolling summary must be carried into the next window, not restarted.
    assert seen[0]["summary"] == "" and seen[1]["summary"] == "已看过 2 页"
    assert seen[0]["effort"] == "low", "校准要开思考，与生成不同"
    # 校准回复里没有 text 字段，不能在客户端被当成“空讲解”拦下来。
    assert all(item["require_text"] is False for item in seen)
    assert [issue["page_no"] for issue in body["issues"]] == [2]
    assert body["issues"][0]["status"] == "draft"


def test_calibration_report_is_persisted_and_reused(client, db, classroom, teacher, generated, monkeypatch):
    calls = []

    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        calls.append(1)
        return {"raw": {"summary": "摘要", "terms": [], "issues": []}, "text": "", "bridge_in": "",
                "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    assert client.post(url(classroom, generated, "/calibrate"), headers=teacher["headers"]).status_code == 200
    stored = client.get(url(classroom, generated, "/calibrate"), headers=teacher["headers"])
    assert stored.status_code == 200
    assert stored.json()["summary"] == "摘要" and stored.json()["applied_at"] is None
    assert len(calls) == 1


def test_apply_regenerates_flagged_drafts_only(client, db, classroom, teacher, generated, monkeypatch):
    monkeypatch.setattr(calibrate, "WINDOW", 10)

    def calibration(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        return {"raw": {"summary": "摘要", "terms": [], "issues": [
            {"page_no": 2, "kind": "mismatch", "detail": "讲了页面没有的内容"},
            {"page_no": 3, "kind": "flow", "detail": "衔接生硬"}]}, "text": "", "bridge_in": "",
            "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", calibration)
    assert client.post(url(classroom, generated, "/calibrate"), headers=teacher["headers"]).status_code == 200
    # Page 3 is approved, so it must be reported but never rewritten.
    assert client.post(url(classroom, generated, "/3/accept"), headers=teacher["headers"]).status_code == 200
    assert client.post(url(classroom, generated, "/calibrate"), headers=teacher["headers"]).status_code == 200

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
    refused = client.post(url(classroom, material, "/calibrate"), headers=teacher["headers"])
    assert refused.status_code == 404
    assert "没有可校准的讲解" in refused.json()["detail"]


def test_calibration_surfaces_model_errors_as_bad_gateway(client, db, classroom, teacher, generated, monkeypatch):
    def broken(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        raise model_client.ModelFailed("模型返回空内容，请重试")

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", broken)
    result = client.post(url(classroom, generated, "/calibrate"), headers=teacher["headers"])
    assert result.status_code == 502
    assert "模型" in result.json()["detail"]

def test_long_deck_resumes_from_the_cursor(client, db, classroom, teacher, generated, monkeypatch):
    """一次请求跑不完时，下一次从 next_index 继续；已完成的窗口绝不重算。"""
    import json

    monkeypatch.setattr(calibrate, "WINDOW", 1)
    monkeypatch.setattr(calibrate, "SLICE_SECONDS", 0)
    seen = []

    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        payload = json.loads(messages[1]["content"].rsplit("\n\n", 1)[1])
        seen.append(([page["page_no"] for page in payload["pages"]], payload["summary"]))
        return {"raw": {"summary": f"看过{payload['pages'][-1]['page_no']}页", "terms": [], "issues": []},
                "text": "", "bridge_in": "", "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    first = client.post(url(classroom, generated, "/calibrate"), headers=teacher["headers"])
    assert first.status_code == 200, first.text
    assert first.json()["complete"] is False and first.json()["windows_done"] == 1
    assert first.json()["next_index"] == 1 and first.json()["windows"] == 3

    second = client.post(url(classroom, generated, "/calibrate"), headers=teacher["headers"])
    assert second.json()["windows_done"] == 2 and second.json()["complete"] is False
    third = client.post(url(classroom, generated, "/calibrate"), headers=teacher["headers"])
    assert third.json()["complete"] is True and third.json()["windows_done"] == 3
    # 每次只跑一个窗口，页码不重复，滚动摘要接续上一步
    assert [item[0] for item in seen] == [[1], [2], [3]]
    assert [item[1] for item in seen] == ["", "看过1页", "看过2页"]


def test_generated_pages_are_not_merged_into_this_fixture(client, db, classroom, teacher, generated):
    """Coverage guard: the fixture really narrates three pages, so the tests above mean something."""
    from app.narration import repository

    assert len(repository.rows(db, generated.id)) == 3


def test_identical_deck_reuses_the_finished_report(client, db, classroom, teacher, generated, monkeypatch):
    calls = []

    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        calls.append(1)
        return {"raw": {"summary": "摘要", "terms": ["变量"], "issues": [
            {"page_no": 2, "kind": "flow", "detail": "衔接重复"}]}, "text": "", "bridge_in": "",
            "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    first = client.post(url(classroom, generated, "/calibrate"), headers=teacher["headers"])
    assert first.status_code == 200, first.text
    assert first.json()["complete"] is True and first.json()["reused"] is False
    assert len(calls) == 1

    again = client.post(url(classroom, generated, "/calibrate"), headers=teacher["headers"])
    assert again.status_code == 200, again.text
    assert again.json()["reused"] is True and again.json()["complete"] is True
    assert again.json()["summary"] == "摘要"
    assert len(calls) == 1, "整册输入未变时不该再花一次调用"


def test_changed_page_content_starts_a_new_run(client, db, classroom, teacher, generated, monkeypatch):
    from app.narration import repository

    calls = []

    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        calls.append(1)
        return {"raw": {"summary": "摘要", "terms": [], "issues": []}, "text": "", "bridge_in": "",
                "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    first = client.post(url(classroom, generated, "/calibrate"), headers=teacher["headers"])
    assert first.json()["complete"] is True
    repository.upsert(db, generated, 2, text="改写过的第二页讲解")
    db.commit()
    second = client.post(url(classroom, generated, "/calibrate"), headers=teacher["headers"])
    assert second.status_code == 200, second.text
    assert second.json()["reused"] is False and second.json()["id"] != first.json()["id"]
    assert len(calls) == 2


def test_partial_report_is_readable_but_never_applied(client, db, classroom, teacher, generated, monkeypatch):
    monkeypatch.setattr(calibrate, "WINDOW", 1)
    monkeypatch.setattr(calibrate, "SLICE_SECONDS", 0)
    monkeypatch.setattr("app.narration.calibrate.model_client.chat",
                        lambda messages, **kwargs: {"raw": {"summary": "半份", "terms": [], "issues": [
                            {"page_no": 1, "kind": "flow", "detail": "x"}]}, "text": "", "bridge_in": "",
                            "anchors": [], "usage": {}, "model": kwargs.get("model")})
    client.post(url(classroom, generated, "/calibrate"), headers=teacher["headers"])
    # 没有完整报告
    assert client.get(url(classroom, generated, "/calibrate"), headers=teacher["headers"]).status_code == 404
    partial = client.get(url(classroom, generated, "/calibrate?partial=1"), headers=teacher["headers"])
    assert partial.status_code == 200, partial.text
    assert partial.json()["complete"] is False and partial.json()["windows_done"] == 1
    refused = client.post(url(classroom, generated, "/calibrate/apply"), headers=teacher["headers"])
    assert refused.status_code == 409 and "尚未完成" in refused.json()["detail"]


def test_model_prefix_is_identical_across_windows(client, db, classroom, teacher, generated, monkeypatch):
    """供应商只认前缀逐字相同；这条测试锁住“别往前缀里塞可变内容”。"""
    monkeypatch.setattr(calibrate, "WINDOW", 1)
    seen = []

    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        seen.append((messages[0]["content"], messages[1]["content"].rsplit("\n\n", 1)[0]))
        return {"raw": {"summary": "摘要", "terms": [], "issues": []}, "text": "", "bridge_in": "",
                "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    assert client.post(url(classroom, generated, "/calibrate"), headers=teacher["headers"]).status_code == 200
    assert len(seen) == 3
    assert len({item[0] for item in seen}) == 1, "system 提示必须整册相同"
    assert len({item[1] for item in seen}) == 1, "用户消息的前缀必须整册相同"


def test_cache_usage_is_summed_into_the_report(client, db, classroom, teacher, generated, monkeypatch):
    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        return {"raw": {"summary": "摘要", "terms": [], "issues": []}, "text": "", "bridge_in": "",
                "anchors": [], "usage": {"prompt_tokens": 100, "completion_tokens": 20,
                                         "cache_hit_tokens": 80, "cache_miss_tokens": 20}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    body = client.post(url(classroom, generated, "/calibrate"), headers=teacher["headers"]).json()
    assert body["usage"] == {"prompt_tokens": 100, "completion_tokens": 20,
                             "cache_hit_tokens": 80, "cache_miss_tokens": 20}


def test_length_error_retries_the_window_with_a_reduced_budget(client, db, classroom, teacher, monkeypatch):
    from app.narration import repository

    material = doc_material(db, classroom, "一" * 300)
    repository.upsert(db, material, 1, text="讲" * 3900)
    db.commit()
    import json

    budgets = []

    def fake_chat(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        payload = json.loads(messages[1]["content"].rsplit("\n\n", 1)[1])
        budgets.append(len(payload["pages"][0]["narration"]))
        if len(budgets) == 1:
            raise model_client.ModelFailed("作者期模型返回 400：maximum context length exceeded", hint="length")
        return {"raw": {"summary": "摘要", "terms": [], "issues": []}, "text": "", "bridge_in": "",
                "anchors": [], "usage": {}, "model": model}

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", fake_chat)
    body = client.post(url(classroom, material, "/calibrate"), headers=teacher["headers"])
    assert body.status_code == 200, body.text
    assert budgets == [3900, 3150], "第二次必须用减半的预算"
    assert body.json()["shrunk_windows"] == [1]


def test_other_model_failures_are_not_retried(client, db, classroom, teacher, generated, monkeypatch):
    calls = []

    def broken(messages, *, settings, model, max_tokens=None, effort=None, require_text=True):
        calls.append(1)
        raise model_client.ModelFailed("作者期模型返回 400：invalid model")

    monkeypatch.setattr("app.narration.calibrate.model_client.chat", broken)
    result = client.post(url(classroom, generated, "/calibrate"), headers=teacher["headers"])
    assert result.status_code == 502
    assert len(calls) == 1, "非长度错误不该重试"


def test_restart_marks_running_jobs_interrupted(db, classroom):
    from app.narration import repository

    material = doc_material(db, classroom, "一" * 300)
    db.commit()
    repository.acquire(db, material, "calibrate", None)
    assert repository.interrupt_running(db) == 1
    job = repository.job_of(db, material.id)
    assert job.status == "interrupted" and not repository.job_running(job)
