import json
from datetime import timedelta

import pytest

from sqlalchemy import select

from app.course_studio.models import CourseStudioJob
from app.models import Chapter, Classroom, now
from app.narration import repository, service
from app.narration.models import NarrationRun
from app.narration.tts import endpoint
from test_narration import material_fixture, url


def overview(classroom):
    return f"/api/teacher/courses/{classroom['course_id']}/synthesis"


def test_overview_scope_types_and_interrupted_tasks(client, db, classroom, teacher, student):
    material = material_fixture(db, classroom, ["正文"])
    material.title = "正在处理"
    material_fixture(db, classroom, ["正文"], kind="video")
    db.add(NarrationRun(material_id=material.id, kind="audio", status="running", started_at=now() - timedelta(hours=1)))
    db.commit()
    response = client.get(overview(classroom) + "?query=正在", headers=teacher["headers"])
    assert response.status_code == 200, response.text
    item = response.json()["items"][0]
    assert item["status"] == "interrupted" and not item["retryable"] and not item["cancellable"]
    assert client.post(overview(classroom) + f"/runs/{item['id']}/cancel", headers=teacher["headers"]).status_code == 409
    assert db.get(NarrationRun, item["id"]).status == "running"
    assert client.get(overview(classroom), headers=student["headers"]).status_code == 403
    db.get(Classroom, classroom["id"]).course.teacher_id = student["id"]
    db.commit()
    assert client.get(overview(classroom), headers=teacher["headers"]).status_code == 403


def fail_page(client, db, classroom, teacher, monkeypatch):
    material = material_fixture(db, classroom, ["正文" * 150], kind="pdf")
    db.commit()

    def fail(*args, **kwargs):
        raise service.NarrationUnavailable("讲稿服务尚未配置")

    monkeypatch.setattr(service, "generate_page", fail)
    assert client.post(url(classroom, material, "/1/generate"), json={}, headers=teacher["headers"]).status_code == 409
    return material, repository.job_of(db, material.id).started_at.isoformat()


def test_explicit_retry_uses_saved_request_and_cannot_repeat(client, db, classroom, teacher, monkeypatch):
    material, started = fail_page(client, db, classroom, teacher, monkeypatch)
    calls = []

    def success(*args, **kwargs):
        calls.append(args[2])
        return {"page_no": 1, "status": "draft", "reused": False, "model": "test", "chars": 1, "image_used": False}

    monkeypatch.setattr(service, "generate_page", success)
    item = next(i for i in client.get(overview(classroom), headers=teacher["headers"]).json()["items"] if i["material_id"] == material.id)
    assert item["retryable"] and item["message"] == "讲稿服务尚未配置"
    assert not calls, "Opening management must never invoke a model"
    path = overview(classroom) + f"/{material.id}/retry"
    result = client.post(path, json={"expected_started_at": started}, headers=teacher["headers"])
    assert result.status_code == 200, result.text
    assert result.json()["status"] == "done" and calls == [1]
    assert client.post(path, json={"expected_started_at": started}, headers=teacher["headers"]).status_code == 409
    assert calls == [1]
    history = client.get(overview(classroom) + "?view=history", headers=teacher["headers"]).json()
    assert history["total"] == 2
    assert [row["status"] for row in history["items"]] == ["done", "failed"]
    assert history["items"][0]["id"] != history["items"][1]["id"]
    assert not history["items"][1]["retryable"]
    assert client.get(overview(classroom) + "?view=running", headers=teacher["headers"]).json()["total"] == 0


def test_live_progress_and_takeover_retain_previous_attempt(db, client, classroom, teacher):
    from app.models import User
    material = material_fixture(db, classroom, ["正文"])
    db.commit()
    user = db.get(User, teacher["id"])
    repository.acquire(db, material, "generate", user)
    repository.beat(db, material.id, done=2, total=4, message="正在生成第 3 页")
    db.commit()
    current = client.get(overview(classroom) + "?view=running", headers=teacher["headers"]).json()
    assert current["total"] == 1 and current["items"][0]["done"] == 2
    job = repository.job_of(db, material.id)
    job.heartbeat_at = now() - timedelta(hours=1)
    repository.sync_run(db, job)
    db.commit()
    stale = client.get(overview(classroom) + "?view=history", headers=teacher["headers"]).json()
    assert stale["items"][0]["status"] == "interrupted"
    repository.acquire(db, material, "audio", user)
    repository.release(db, material.id, message="完成配音")
    records = client.get(overview(classroom) + "?view=history", headers=teacher["headers"]).json()
    assert records["total"] == 2
    assert [row["status"] for row in records["items"]] == ["done", "interrupted"]


def test_changed_source_blocks_retry_before_external_request(client, db, classroom, teacher, monkeypatch):
    material, started = fail_page(client, db, classroom, teacher, monkeypatch)
    material.content = {**material.content, "sha256": "new-upload"}
    db.commit()

    def unexpected(*args, **kwargs):
        pytest.fail("Changed material must not reach generation")

    monkeypatch.setattr(service, "generate_page", unexpected)
    response = client.post(overview(classroom) + f"/{material.id}/retry", json={"expected_started_at": started}, headers=teacher["headers"])
    assert response.status_code == 409, response.text
    assert repository.job_of(db, material.id).status == "failed"


def test_batch_retry_repeats_the_failed_window(client, db, classroom, teacher, run_jobs, monkeypatch):
    """窗口失败按窗重试：第一次两页一窗失败，重试再跑同一窗。"""
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    material = material_fixture(db, classroom, ["正文" * 150, "正文" * 150], kind="pdf")
    db.commit()
    attempts: list[list[int]] = []

    def chat(messages, *, settings, model, **kwargs):
        user = messages[1]["content"]
        body = json.loads(user.split("本窗每页的整理稿：\n", 1)[1])
        pages = [page["page_no"] for page in body["pages"]]
        attempts.append(pages)
        if 2 in pages and len(attempts) == 1:
            raise service.model_client.ModelFailed("模型返回空内容，请重试")
        return {"raw": {"pages": [{"page_no": no, "text": "讲稿正文。", "anchors": []} for no in pages]},
                "usage": {}, "model": model}

    monkeypatch.setattr(service.model_client, "chat", chat)
    response = client.post(url(classroom, material, "/generate"),
                           json={"first_page": 1, "last_page": 2}, headers=teacher["headers"])
    assert response.status_code == 202
    run_jobs()
    job = repository.job_of(db, material.id)
    assert job.status == "failed" and job.progress["retry_pages"] == [1, 2]
    started = job.started_at.isoformat()
    response = client.post(overview(classroom) + f"/{material.id}/retry",
                           json={"expected_started_at": started}, headers=teacher["headers"])
    assert response.status_code == 200, response.text
    assert repository.job_of(db, material.id).progress.get("queued") is True, "重试也要排队，由后台执行"
    run_jobs()
    assert attempts == [[1, 2], [1, 2]]


def test_legacy_failure_has_no_blind_retry(client, db, classroom, teacher):
    material = material_fixture(db, classroom, ["正文"])
    db.add(NarrationRun(material_id=material.id, kind="generate", status="failed", started_at=now()))
    db.commit()
    items = client.get(overview(classroom), headers=teacher["headers"]).json()["items"]
    assert not next(i for i in items if i["material_id"] == material.id)["retryable"]


@pytest.mark.parametrize("root", ["https://api.deepseek.com", "https://api.deepseek.com/v1", "https://api.deepseek.com/v1/tools/tts/"])
def test_speech_endpoint_accepts_root_or_complete_url(root):
    assert endpoint(root, "/v1/tools/tts") == "https://api.deepseek.com/v1/tools/tts"


def test_combined_feed_filters_and_persists_dismissed_attempts(client, db, classroom, teacher, student):
    course_id, headers = classroom["course_id"], teacher["headers"]
    material = material_fixture(db, classroom, ["正文"])
    old_run = NarrationRun(material_id=material.id, kind="generate", status="failed", started_at=now() - timedelta(hours=2), message="文本生成超时")
    job = CourseStudioJob(course_instance_id=course_id, kind="exercises_generate", status="failed",
                          scope_key="test", progress={"done": 0}, error="生成失败")
    db.add_all([old_run, job])
    db.commit()
    base = overview(classroom)
    studio = f"/api/teacher/courses/{course_id}/course-studio/jobs"
    page = client.get(base + "?view=history&status=failed&size=1", headers=headers).json()
    assert page["total"] == page["counts"]["failed"] == 2
    assert page["items"][0]["job"]["id"] == job.id
    assert client.get(base + "?query=智能出题", headers=headers).json()["total"] == 1
    assert client.get(base + "?size=1&page=2", headers=headers).json()["items"][0]["id"] == old_run.id
    assert client.post(f"{studio}/{job.id}/dismiss", headers=student["headers"]).status_code == 403
    other_id = client.post("/api/teacher/courses", json={"name": "另一课程"}, headers=headers).json()["id"]
    assert client.get(f"/api/teacher/courses/{other_id}/synthesis", headers=headers).json()["total"] == 0
    assert client.post(f"/api/teacher/courses/{other_id}/course-studio/jobs/{job.id}/dismiss", headers=headers).status_code == 404
    for resource in (f"{studio}/{job.id}", f"{base}/runs/{old_run.id}"):
        for action in ("cancel", "dismiss", "cancel"):
            assert client.post(f"{resource}/{action}", headers=headers).json()["status"] == "cancelled"
    cancelled = client.get(base + "?view=history&status=cancelled", headers=headers).json()
    assert cancelled["total"] == cancelled["counts"]["cancelled"] == 2
    assert cancelled["counts"]["failed"] == 0
    assert client.get(studio + "?workspace=true", headers=headers).json()["jobs"] == []
    studio_detail = client.get(f"{studio}/{job.id}", headers=headers).json()
    assert studio_detail["status"] == "cancelled" and studio_detail["error"] == "生成失败"
    run_detail = client.get(f"{base}/runs/{old_run.id}", headers=headers).json()
    assert run_detail["status"] == "cancelled" and run_detail["diagnostic"] == "文本生成超时"


def test_cancel_historical_interrupted_run_without_timestamp_targets_only_its_id(client, db, classroom, teacher):
    material = material_fixture(db, classroom, ["正文"])
    sibling, target = [NarrationRun(material_id=material.id, kind="generate", status="interrupted", message=reason)
                       for reason in ("第一批中断", "第二批中断")]
    db.add_all([sibling, target])
    db.commit()
    root = overview(classroom) + "/runs/"
    detail = client.get(root + str(target.id), headers=teacher["headers"]).json()
    assert detail["cancellable"] and not detail["started_at"]
    assert client.post(root + str(target.id) + "/cancel", headers=teacher["headers"]).json()["status"] == "cancelled"
    assert db.get(NarrationRun, sibling.id).status == "interrupted"
    assert client.get(root + str(target.id), headers=teacher["headers"]).json()["diagnostic"] == "第二批中断"


def test_legacy_dismissed_jobs_appear_in_cancelled_history(client, db, classroom, teacher):
    from app.narration.models import NarrationJob

    headers = teacher["headers"]
    material = material_fixture(db, classroom, ["正文"])
    material_job = NarrationJob(material_id=material.id, kind="digest", status="failed", started_at=now(),
                                progress={"queue_dismissed": True, "retry_fingerprint": "legacy",
                                          "request": {"operation": "digest"}}, message="旧课件失败")
    studio_job = CourseStudioJob(course_instance_id=classroom["course_id"], kind="exercises_generate", scope_key="test",
                                 status="interrupted", progress={"queue_dismissed": True}, error="旧出题中断")
    db.add_all([material_job, studio_job])
    repository.sync_run(db, material_job)
    db.commit()
    base = overview(classroom)
    history = client.get(base + "?view=history&status=cancelled", headers=headers).json()
    assert history["counts"]["failed"] == history["counts"]["interrupted"] == 0
    assert history["total"] == history["counts"]["cancelled"] == 2
    run = next(row for row in history["items"] if row.get("source") != "studio")
    assert run["status"] == "cancelled" and run["diagnostic"] == "旧课件失败" and not run["retryable"]
    studio = next(row["job"] for row in history["items"] if row.get("source") == "studio")
    assert studio["status"] == "cancelled" and studio["error"] == "旧出题中断"
    state = client.get(url(classroom, material, "/job"), headers=headers).json()
    assert state["status"] == "cancelled" and not state["retryable"]
    assert client.post(f"{base}/{material.id}/retry", headers=headers,
                       json={"expected_started_at": run["started_at"]}).status_code == 409


def test_studio_retry_validates_current_scope_and_is_single_use(client, db, classroom, teacher, monkeypatch):
    from test_course_studio_services import _sample_material

    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    course_id, headers = classroom["course_id"], teacher["headers"]
    chapter = db.scalar(select(Chapter).where(Chapter.course_instance_id == course_id))
    _sample_material(db, course_id, chapter.id, teacher["id"])
    job = CourseStudioJob(course_instance_id=course_id, kind="exercises_generate", status="failed",
                          scope_key=f"chapter:{chapter.id}:exercises", payload={"chapter_id": chapter.id, "counts": {"single": 1}})
    db.add(job)
    db.commit()
    url = f"/api/teacher/courses/{course_id}/course-studio/jobs/{job.id}/retry"
    retry = client.post(url, headers=headers)
    assert retry.status_code == 202, retry.text
    assert retry.json()["status"] == "queued" and retry.json()["id"] != job.id
    assert client.post(url, headers=headers).status_code == 409
    feed = client.get(overview(classroom), headers=headers).json()
    assert feed["counts"]["running"] == feed["counts"]["failed"] == 1
    listed = client.get(overview(classroom).replace("/synthesis", "/course-studio/jobs?workspace=true"), headers=headers)
    assert [j["id"] for j in listed.json()["jobs"]] == [retry.json()["id"]]
    failed = next(row["job"] for row in feed["items"] if row["job"]["id"] == job.id)
    assert failed["status"] == "failed" and failed["retried"]
    assert client.post(url.replace("/retry", "/cancel"), headers=headers).json()["status"] == "cancelled"
    assert client.get(url.replace(job.id + "/retry", retry.json()["id"]), headers=headers).json()["status"] == "queued"
