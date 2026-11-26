"""Teacher records follow the same published chapter tasks that students see."""
from datetime import timedelta

from app.auth import issue
from app.models import Material, User, now


def test_reading_evidence_and_tasks_match_student_view(client, db, teacher, student, classroom, monkeypatch):
    cid = classroom["id"]
    headers = student["headers"]
    manage = teacher["headers"]
    material = db.get(Material, 186)
    page = material.content["pages"][0]
    requirement = f"/api/teacher/courses/{classroom['course_id']}/chapters/179/material-tasks/186"
    assert client.put(requirement, headers=manage, json={"required": True, "rule": {"scope": "count", "count": 1}}).status_code == 200
    beat = {"page_id": page["id"], "sequence": 1, "session_id": "student-reading", "visible": True}
    path = f"/api/chapters/179/materials/186/participation?classroom_id={cid}"
    start = now()
    monkeypatch.setattr("app.chapter_tasks.router.now", lambda: start)
    assert client.post(path, headers=headers, json=beat).status_code == 200
    monkeypatch.setattr("app.chapter_tasks.router.now", lambda: start + timedelta(seconds=5))
    end = client.post(path, headers=headers, json={**beat, "visible": False, "sequence": 2})
    assert end.json()["completed"]
    detail = f"/api/teacher/classrooms/{cid}/students/{student['id']}"
    individual = client.get(detail, headers=manage).json()
    assert individual["chapters"] == client.get(f"/api/chapter-tasks?classroom_id={cid}", headers=headers).json()["chapters"]
    first = next(c for c in individual["chapters"] if c["id"] == 179)
    assert next(t for t in first["tasks"] if t.get("material_id") == 186)["completed"]
    reading, = individual["participation"]
    assert (reading["title"], reading["chapter"], reading["read_pages"], reading["read_seconds"]) == (material.title, first["title"], 1, 5)
    overview = client.get(f"/api/teacher/classrooms/{cid}/progress", headers=manage).json()["members"]
    assert overview[0]["completed_tasks"] == sum(t["completed"] for c in individual["chapters"] for t in c["tasks"])
    release = f"/api/teacher/classrooms/{cid}/releases/179"
    assert client.put(release, headers=manage, json={"status": "paused"}).status_code == 200
    paused = client.get(detail, headers=manage).json()
    assert all(c["id"] != 179 for c in paused["chapters"])
    assert paused["participation"] == [reading]


def test_student_details_are_scoped_to_class_and_teacher(client, db, teacher, student, classroom):
    outsider = User(student_id="8000000100009", name="其他教师", role="teacher", password_hash="unused")
    db.add(outsider)
    db.commit()
    foreign = {"Authorization": "Bearer " + issue(db, outsider)["access_token"]}
    for headers in (student["headers"], foreign):
        for endpoint in ("progress", f"students/{student['id']}"):
            assert client.get(f"/api/teacher/classrooms/{classroom['id']}/{endpoint}", headers=headers).status_code == 403
    assert client.get(f"/api/teacher/classrooms/{classroom['id']}/students/{outsider.id}", headers=teacher["headers"]).status_code == 404
