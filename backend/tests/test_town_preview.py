from course_fixtures import create_test_class
from uuid import uuid4

from fastapi.testclient import TestClient

from app.auth import issue
from app.db import get_db
from app.main import create_app
from app.models import User
from conftest import copy_fixture_course, move_player


def launch(client, classroom_id, teacher_headers):
    response = client.post(f"/api/teacher/classrooms/{classroom_id}/town-session", headers=teacher_headers)
    assert response.status_code == 200, response.text
    result = response.json()
    return result["user"], {"Authorization": f"Bearer {result['access_token']}"}


def finish_practice(client, classroom_id, headers):
    move_player(client, headers, classroom_id, "town_hub", 22, 34)
    result = client.post("/api/submissions", headers=headers, json={
        "classroom_id": classroom_id, "activity_id": "ch1-practice", "question_id": "ch1-computation",
        "answer": True, "idempotency_key": str(uuid4())})
    assert result.status_code == 201 and result.json()["status"] == "accepted", result.text


def test_town_preview_persists_real_progress_without_adding_a_roster_member(db, classroom, teacher, student, monkeypatch):
    monkeypatch.setenv("REBORN_ENV", "production")
    monkeypatch.setenv("REBORN_DEV_TOOLS", "1")
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)
    cid = classroom["id"]
    teacher_headers = teacher["headers"]
    user, preview_headers = launch(client, cid, teacher_headers)
    assert user["role"] == "student" and user["dev_tools_enabled"] and user["town_preview"]
    assert user["name"] == "教师体验学生"
    assert client.get("/api/auth/me", headers=preview_headers).json() == user
    assert client.get("/api/auth/me", headers=teacher_headers).json()["role"] == "teacher"
    assert client.get("/api/auth/me", headers=student["headers"]).json()["dev_tools_enabled"] is False

    finish_practice(client, cid, preview_headers)
    finish_practice(client, cid, student["headers"])
    client.post("/api/auth/logout", headers=preview_headers)
    assert client.get("/api/auth/me", headers=preview_headers).status_code == 401
    reopened_user, reopened_headers = launch(client, cid, teacher_headers)
    assert reopened_user == user

    def world(headers):
        response = client.get(f"/api/world?classroom_id={cid}", headers=headers)
        assert response.status_code == 200, response.text
        return response.json()

    saved = world(reopened_headers)
    assert saved["player"]["tile_x"] == 22 and "library" in saved["building_unlock"]
    def practice_progress(auth):
        response = client.get(f"/api/chapter-tasks?classroom_id={cid}", headers=auth)
        return next(t for c in response.json()["chapters"] for t in c["tasks"] if t["id"] == "ch1-practice")["current"]
    assert practice_progress(reopened_headers) == 1
    roster = client.get(f"/api/teacher/classrooms/{cid}/students", headers=teacher_headers).json()
    assert [row["id"] for row in roster] == [student["id"]]
    report = client.get(f"/api/teacher/classrooms/{cid}/progress", headers=teacher_headers).json()
    assert {s["user_id"] for s in report["submissions"]} == {student["id"]}

    body = {"classroom_id": cid, "confirmed": True}
    assert client.post("/api/dev/progress/reset", json=body, headers=reopened_headers).status_code == 404
    reset_url = "/api/teacher-town/progress/reset"
    for headers in (teacher_headers, student["headers"]):
        assert client.post(reset_url, json=body, headers=headers).status_code == 403
    assert client.post(reset_url, json={**body, "confirmed": False}, headers=reopened_headers).status_code == 422
    assert client.post(reset_url, json=body, headers=reopened_headers).status_code == 200
    assert practice_progress(reopened_headers) == 0
    assert practice_progress(student["headers"]) == 1

    changed = client.post("/api/auth/password", headers=teacher_headers,
                          json={"current_password": "teacher-password-123", "new_password": "new-teacher-password-123"})
    assert changed.status_code == 200, changed.text
    assert client.get(f"/api/world?classroom_id={cid}", headers=reopened_headers).status_code == 401
    assert client.get("/api/assistant/status", headers=reopened_headers).status_code == 401
    renewed_teacher_headers = {"Authorization": "Bearer " + changed.json()["access_token"]}
    assert launch(client, cid, renewed_teacher_headers)[0] == user
    client.close()


def test_town_preview_student_cannot_change_class_or_access_teacher_controls(client, db, classroom, teacher, student):
    cid = classroom["id"]
    launch_path = f"/api/teacher/classrooms/{cid}/town-session"
    assert client.post(launch_path, headers=student["headers"]).status_code == 403
    other_teacher = User(student_id="88351322776230", name="Other teacher", role="teacher", password_hash="not-used")
    db.add(other_teacher)
    db.flush()
    other_headers = {"Authorization": "Bearer " + issue(db, other_teacher)["access_token"]}
    assert client.post(launch_path, headers=other_headers).status_code == 403

    teacher_headers = teacher["headers"]
    second = create_test_class(client, json={"name": "Second classroom"}, headers=teacher_headers).json()
    assert client.post(f"/api/teacher/classrooms/{second['id']}/town-session", headers=teacher_headers).status_code == 200
    copy_fixture_course(db, cid, second["id"])
    user, headers = launch(client, cid, teacher_headers)
    second_user, _ = launch(client, second["id"], teacher_headers)
    assert user["id"] != second_user["id"]
    assert [(row["id"], row["course_name"]) for row in client.get("/api/classrooms", headers=headers).json()] == [(cid, "测试课程")]
    assert client.post("/api/classrooms/join", headers=headers, json={"join_code": second["join_code"]}).status_code == 403
    assert client.get(f"/api/world?classroom_id={second['id']}", headers=headers).status_code == 403
    assert client.post("/api/teacher-town/progress/reset", headers=headers,
                       json={"classroom_id": second["id"], "confirmed": True}).status_code == 403
    assert client.post(launch_path, headers=headers).status_code == 403
    assert client.post("/api/auth/password", headers=headers,
                       json={"current_password": "unused", "new_password": "unused-new"}).status_code == 403

    # Removing the originating teacher's authority blocks an already-issued learner token.
    db.get(User, teacher["id"]).role = "student"
    db.commit()
    assert client.get(f"/api/world?classroom_id={cid}", headers=headers).status_code == 403
