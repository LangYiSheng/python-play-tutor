import pytest
from sqlalchemy import select

from app.narration import digest, jobs, repository
from app.narration.models import NarrationRun
from test_narration import material_fixture


def enqueue(db, classroom):
    material = material_fixture(db, classroom, ["第一页", "第二页"])
    db.commit()
    job = repository.enqueue(db, material, "digest", request={"operation": "digest"})
    return material, {"expected_started_at": job.started_at.isoformat()}


def command(classroom, material, operation):
    return f"/api/teacher/classrooms/{classroom['id']}/synthesis/{material.id}/{operation}"


def test_cancel_waiting_is_durable_idempotent_and_retries_a_new_attempt(client, db, classroom, teacher, student, monkeypatch):
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    material, expected = enqueue(db, classroom)
    path = command(classroom, material, "cancel")
    headers = teacher["headers"]
    assert client.post(path, json=expected, headers=student["headers"]).status_code == 403
    assert client.post(path.replace(f"/{classroom['id']}/", "/999999/"), json=expected, headers=headers).status_code in (403, 404)
    for _ in range(2):
        response = client.post(path, json=expected, headers=headers)
        assert response.status_code == 200 and response.json()["status"] == "cancelled"
    assert jobs.drain(db) == 0
    job, = client.get("/api/teacher/course-graph/tasks", params={"classroom_id": classroom["id"]}, headers=headers).json()
    assert job["retryable"] and job["run_id"] and not job["cancellable"]
    assert client.post(command(classroom, material, "retry"), json=expected, headers=headers).status_code == 200
    assert client.post(path, json=expected, headers=headers).status_code == 409
    assert client.post(command(classroom, material, "retry"), json=expected, headers=headers).status_code == 409
    records = db.scalars(select(NarrationRun).where(NarrationRun.material_id == material.id).order_by(NarrationRun.id)).all()
    assert [r.status for r in records] == ["cancelled", "running"]


def test_cancelling_claimed_task_finishes_current_window_and_stops_before_next(client, db, classroom, teacher, monkeypatch):
    material, expected = enqueue(db, classroom)
    monkeypatch.setattr(digest, "pending_windows", lambda *args: [[1], [2]])
    called = []

    def window(session, item, group, settings, effort):
        called.append(group)
        result = client.post(command(classroom, material, "cancel"), json=expected, headers=teacher["headers"])
        assert result.status_code == 200 and result.json()["status"] == "cancelling"
        assert repository.job_of(session, item.id).status == "running"
        repository.upsert_content(session, item, 1, title="第一页", text="已完成", topic="", tags=[])
        session.commit()
        return group, {}

    monkeypatch.setattr(digest, "run_window", window)
    assert jobs.drain(db) == 1 and called == [[1]]
    assert [row.text for row in repository.content_rows(db, material.id)] == ["已完成"]
    job, = client.get("/api/teacher/course-graph/tasks", params={"classroom_id": classroom["id"]}, headers=teacher["headers"]).json()
    assert job["status"] == "cancelled" and job["percent"] == 50 and job["retryable"]


@pytest.mark.parametrize("edit_after_restart", [False, True])
def test_restart_allows_retry_of_provably_unclaimed_job(client, db, classroom, teacher, monkeypatch, edit_after_restart):
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")
    material, expected = enqueue(db, classroom)
    repository.interrupt_running(db)
    job = repository.job_of(db, material.id)
    assert job.status == "interrupted" and job.progress["never_started"]
    if edit_after_restart:
        repository.upsert_content(db, material, 1, title="教师修改", text="修改后", topic="", tags=[])
        db.commit()
    response = client.post(command(classroom, material, "retry"), json=expected, headers=teacher["headers"])
    assert response.status_code == (409 if edit_after_restart else 200), response.text
