# pytest discovers the imported fixture by its name.
# ruff: noqa: F811

from sqlalchemy import select

from app.models import (ActivityProgress, CourseInstance, ExperienceCheckpoint)
from test_dev_tools import dev_client  # noqa: F401

BASE = "/api/dev/experience"


def test_overview_is_read_only_and_scope_checked(dev_client, db, classroom, student, teacher):
    before = db.scalar(select(CourseInstance).where(CourseInstance.id == classroom["course_id"])).revision
    response = dev_client.get(BASE, params={"classroom_id": classroom["id"]}, headers=student["headers"])
    assert response.status_code == 200, response.text
    assert response.json()["chapters"]
    assert db.scalar(select(CourseInstance).where(CourseInstance.id == classroom["course_id"])).revision == before
    assert dev_client.get(BASE, params={"classroom_id": classroom["id"]}, headers=teacher["headers"]).status_code == 403
    assert dev_client.get(BASE, params={"classroom_id": 9999}, headers=student["headers"]).status_code == 403
    assert dev_client.get("/api/teacher-town/experience", params={"classroom_id": classroom["id"]}, headers=student["headers"]).status_code == 403


def test_content_jump_does_not_change_completion(dev_client, db, classroom, student):
    body = {"classroom_id": classroom["id"], "kind": "activity", "target": "ch1-practice", "question_no": 1}
    response = dev_client.post(BASE + "/open", json=body, headers=student["headers"])
    assert response.status_code == 200, response.text
    assert response.json()["workspace"]["question_no"] == 1
    assert not db.get(ActivityProgress, (student["id"], classroom["id"], "ch1-practice"))
    assert dev_client.post(BASE + "/open", json={**body, "question_no": 999}, headers=student["headers"]).status_code == 422


def test_goal_practice_locator_tracks_personal_queue_without_drawing(dev_client, db, classroom, student):
    from app.models import Activity, PracticeSession

    activity = db.get(Activity, "ch1-practice")
    activity.content = {**activity.content, "practice_rules": {"retry_interval": 1, "goals": [
        {"knowledge_point_id": 11, "total": 1, "by_kind": {"python": 2}},
        {"knowledge_point_id": 12, "total": 2, "by_kind": {}},
    ]}}
    db.commit()
    scope = {"classroom_id": classroom["id"]}
    request = {**scope, "kind": "activity", "target": activity.id}
    headers = student["headers"]
    assert dev_client.post(BASE + "/open", json={**request, "question_no": 4}, headers=headers).status_code == 200
    assert dev_client.post(BASE + "/open", json={**request, "question_no": 5}, headers=headers).status_code == 422
    assert db.get(PracticeSession, (student["id"], classroom["id"], activity.id)) is None

    db.add(PracticeSession(**scope, user_id=student["id"], activity_id=activity.id,
                           items=[{"question_id": str(i), "status": "unanswered", "kind": "boolean",
                                   "knowledge_point_id": 11, "appended": False} for i in range(5)]))
    db.commit()
    listed = dev_client.get(BASE, params=scope, headers=headers).json()["activities"]
    assert next(row["questions"] for row in listed if row["id"] == activity.id) == 5
    assert dev_client.post(BASE + "/open", json={**request, "question_no": 5}, headers=headers).status_code == 200


def test_definition_change_invalidates_checkpoint_even_without_revision(dev_client, db, classroom, student):
    saved = dev_client.post(BASE + "/checkpoints", json={"classroom_id": classroom["id"], "name": "修改前"}, headers=student["headers"])
    assert saved.status_code == 200
    from app.models import Chapter
    db.get(Chapter, 179).title = "修改后的章节"
    db.commit()
    result = dev_client.get(BASE, params={"classroom_id": classroom["id"]}, headers=student["headers"])
    assert result.json()["checkpoints"][0]["valid"] is False


def test_checkpoint_idempotency_busy_guard_and_preserved_receipts(dev_client, db, classroom, student):
    from uuid import uuid4
    from app.models import Submission, LearningEvent
    from app.integration_models import AssistantCall
    from test_dev_tools import add_progress
    submission_id = add_progress(db, student["id"], classroom["id"])
    body = {"classroom_id": classroom["id"], "name": "可恢复", "request_id": str(uuid4())}
    first = dev_client.post(BASE + "/checkpoints", json=body, headers=student["headers"])
    assert first.status_code == 200, first.text
    assert dev_client.post(BASE + "/checkpoints", json=body, headers=student["headers"]).json() == first.json()
    assert len(list(db.scalars(select(ExperienceCheckpoint)))) == 1
    submission = db.get(Submission, submission_id)
    submission.status = "submission_unknown"
    db.commit()
    assert dev_client.post(BASE + "/spawn", json={"classroom_id": classroom["id"]}, headers=student["headers"]).status_code == 409
    submission.status = "accepted"
    call = db.scalar(select(AssistantCall))
    call.status = "running"
    db.commit()
    assert dev_client.post(BASE + "/spawn", json={"classroom_id": classroom["id"]}, headers=student["headers"]).status_code == 409
    call.status = "complete"
    db.commit()
    path = BASE + f"/checkpoints/{first.json()['id']}"
    preview = dev_client.get(path + "/preview", params={"classroom_id": classroom["id"]}, headers=student["headers"])
    result = dev_client.post(path + "/restore", json={"classroom_id": classroom["id"], "expected": preview.json()["expected"]}, headers=student["headers"])
    assert result.status_code == 200, result.text
    assert db.get(Submission, submission_id).status == "accepted"
    assert db.scalar(select(LearningEvent)) and db.scalar(select(AssistantCall)).model_calls == 1


def test_production_preview_owned_checkpoint_and_revoked_owner(db, classroom, teacher, student, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import create_app
    from app.db import get_db
    from app.models import User
    from test_town_preview import launch
    monkeypatch.setenv("REBORN_ENV", "production")
    monkeypatch.setenv("REBORN_DEV_TOOLS", "1")
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)
    assert BASE not in client.get("/openapi.json").json()["paths"]
    _, headers = launch(client, classroom["id"], teacher["headers"])
    base = "/api/teacher-town/experience"
    result = client.post(base + "/checkpoints", json={"classroom_id": classroom["id"], "name": "教师体验"}, headers=headers)
    assert result.status_code == 200, result.text
    assert client.get(base, params={"classroom_id": classroom["id"]}, headers=student["headers"]).status_code == 403
    assert client.get(base, params={"classroom_id": classroom["id"] + 1}, headers=headers).status_code == 403
    db.get(User, teacher["id"]).role = "student"
    db.commit()
    assert client.get(base, params={"classroom_id": classroom["id"]}, headers=headers).status_code == 403

    client.close()


def test_checkpoint_scope_stale_preview_and_capacity(dev_client, db, classroom, student):
    from app.auth import issue
    from app.models import Membership, User
    body = {"classroom_id": classroom["id"], "name": "原账号"}
    saved = dev_client.post(BASE + "/checkpoints", json=body, headers=student["headers"]).json()
    path = BASE + f"/checkpoints/{saved['id']}"
    other = User(student_id="20261115007", name="另一位学生", role="student", password_hash="not-used")
    db.add(other)
    db.flush()
    db.add(Membership(user_id=other.id, classroom_id=classroom["id"]))
    db.commit()
    headers = {"Authorization": "Bearer " + issue(db, other)["access_token"]}
    assert dev_client.get(path + "/preview", params={"classroom_id": classroom["id"]}, headers=headers).status_code == 404
    assert dev_client.delete(path, params={"classroom_id": classroom["id"]}, headers=headers).status_code == 404
    preview = dev_client.get(path + "/preview", params={"classroom_id": classroom["id"]}, headers=student["headers"]).json()
    from app.models import PlayerPosition
    db.add(PlayerPosition(user_id=student["id"], classroom_id=classroom["id"], map_key="library", tile_x=9, tile_y=9, direction="down"))
    db.commit()
    assert dev_client.post(path + "/restore", json={"classroom_id": classroom["id"], "expected": preview["expected"]}, headers=student["headers"]).status_code == 409
    for index in range(19):
        db.add(ExperienceCheckpoint(user_id=student["id"], classroom_id=classroom["id"], name=str(index), definition_hash="old", snapshot={}))
    db.commit()
    assert dev_client.post(BASE + "/checkpoints", json=body, headers=student["headers"]).status_code == 409
