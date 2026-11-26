from course_fixtures import create_test_class
from conftest import make_material
from datetime import datetime, timedelta, timezone
from sqlalchemy import func, select
from app.models import Question
from fixture_seed import seed


def test_seed_idempotent(db):
    counts = seed(db)
    assert counts == {"documents": 7, "pages": 561, "chapters": 7, "knowledge_points": 65, "examples": 46, "problems": 39}
    assert db.scalar(select(func.count()).select_from(Question)) == 6


def test_answers_private(client, db, student, classroom):
    payload = client.get(f"/api/activities/ch1-practice?classroom_id={classroom['id']}", headers=student["headers"]).json()
    assert len(payload["questions"]) == 3
    assert all(not {"answer", "hidden_cases", "reference_solution_code"} & q.keys() for q in payload["questions"])
    assert client.get(f"/api/activities/archive-477?classroom_id={classroom['id']}", headers=student["headers"]).status_code == 404


def test_public_registration_is_closed_and_logout_revokes_session(client, student):
    data = {"student_id": "23258500098500", "name": "新同学", "password": "test-password-123"}
    assert client.post("/api/auth/register", json={**data, "role": "teacher"}).status_code == 404
    assert client.post("/api/auth/register", json=data).status_code == 404
    headers = student["headers"]
    assert client.get("/api/auth/me", headers=headers).status_code == 200
    assert client.post("/api/auth/logout", headers=headers).status_code == 200
    assert client.get("/api/auth/me", headers=headers).status_code == 401


def test_release_server_time_and_cross_classroom(client, db, student, teacher, classroom):
    cid = classroom["id"]
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    path = f"/api/teacher/classrooms/{cid}/releases/180"
    assert client.put(path, json={"status": "published", "opens_at": future}, headers=teacher["headers"]).status_code == 200
    assert client.get(f"/api/materials/187?classroom_id={cid}", headers=student["headers"]).status_code == 403
    assert client.get(f"/api/materials/187?classroom_id={cid}", headers=student["headers"]).status_code == 403
    other = create_test_class(client, json={"name": "另一个班"}, headers=teacher["headers"]).json()
    assert client.get(f"/api/world?classroom_id={other['id']}", headers=student["headers"]).status_code == 403
    assert (
        client.put(
            path,
            json={"status": "published", "opens_at": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()},
            headers=teacher["headers"],
        ).status_code
        == 200
    )
    assert client.get(f"/api/materials/187?classroom_id={cid}", headers=student["headers"]).status_code == 200
    assert client.put(path, json={"status": "paused"}, headers=teacher["headers"]).status_code == 200
    assert client.get(f"/api/materials/187?classroom_id={cid}", headers=student["headers"]).status_code == 403


def test_unbound_material_is_private(client, db, student, teacher, classroom):

    cid, headers = classroom["id"], student["headers"]
    db.add(make_material(db, id=9000, chapter_ids=[], title="Unbound material", kind="text", owner_id=teacher["id"],
                    status="ready", content={"pages": [{"id": 9000, "page_no": 1, "title": "private", "text": "unpublished"}]}))
    db.commit()
    assert client.get(f"/api/materials/9000?classroom_id={cid}", headers=headers).status_code == 403
    assert client.get(f"/api/materials/186?classroom_id={cid}", headers=headers).status_code == 200
    library = client.get(f"/api/library?classroom_id={cid}", headers=headers).json()
    assert all(item["id"] != 9000 for item in library)
    assert "version" not in next(item for item in library if item["id"] == 186)


def test_retired_dialogue_and_independent_creation_routes_are_removed(client, student, teacher, classroom):
    assert client.post("/api/dialogues/mayor_py/steps", json={"classroom_id": classroom["id"]}, headers=student["headers"]).status_code == 404
    assert client.post("/api/teacher/npcs", json={}, headers=teacher["headers"]).status_code == 404
