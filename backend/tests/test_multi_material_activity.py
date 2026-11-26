"""Chapter material tasks have separate requirements and foreground evidence."""
from datetime import datetime, timedelta, timezone

import pytest

from conftest import make_material


@pytest.fixture
def clock(monkeypatch):
    start = datetime(2026, 11, 15, tzinfo=timezone.utc)
    monkeypatch.setattr("app.chapter_tasks.router.now", lambda: start)
    monkeypatch.setattr("app.learning_rules.utcnow", lambda: start)

    def advance(seconds):
        nonlocal start
        start += timedelta(seconds=seconds)
    return advance


@pytest.fixture
def mixed(client, db, teacher, classroom):
    for key, kind in ((9910, "text"), (9911, "video"), (9912, "text"), (9913, "video")):
        make_material(db, id=key, title=str(key), kind=kind, chapter_ids=[179], owner_id=teacher["id"],
            storage_key="video.mp4" if kind == "video" else None, status="ready",
            content={"duration_seconds": 60, "pages": [] if kind == "video" else [
                {"id": n * 10, "page_no": n, "title": str(n)} for n in (1, 2)]})
    db.commit()
    base = f"/api/teacher/courses/{classroom['course_id']}/chapters/179/material-tasks"
    for key, rule in ((9910, {}), (9911, {"minimum_seconds": 10, "segments": [
            {"start_seconds": 20, "end_seconds": 25, "label": "关键概念"}]})):
        response = client.put(f"{base}/{key}", headers=teacher["headers"], json={"required": True, "rule": rule})
        assert response.status_code == 200, response.text
    return base


def heartbeat(client, student, room, material, sequence, **fields):
    result = client.post(f"/api/chapters/179/materials/{material}/participation?classroom_id={room['id']}", headers=student["headers"],
        json={"session_id": f"reader-{material}", "sequence": sequence, "visible": True, **fields})
    assert result.status_code == 200, result.text
    return result.json()


def test_mixed_video_required_segment_and_domain_isolation(client, db, teacher, student, classroom, mixed, clock):
    def beat(sequence, position, **extra):
        return heartbeat(client, student, classroom, 9911, sequence, position=position, playing=True, **extra)
    assert not beat(1, 0)["completed"]
    clock(10)
    assert beat(2, 10)["seconds"] == 10
    assert not beat(2, 10)["completed"]
    clock(1)
    assert not beat(3, 20)["completed"]
    clock(5)
    assert beat(4, 25, visible=False)["completed"]
    teacher_request = client.post(f"/api/chapters/179/materials/9911/participation?classroom_id={classroom['id']}",
        headers=teacher["headers"], json={"session_id": "invalid", "sequence": 1, "visible": True, "position": 0})
    assert teacher_request.status_code == 403
    record = client.get(f"/api/teacher/classrooms/{classroom['id']}/students/{student['id']}", headers=teacher["headers"]).json()
    assert record["participation"][0]["watched_seconds"] == 15
    chapter = next(c for c in record["chapters"] if c["id"] == 179)
    by_material = {t.get("material_id"): t for t in chapter["tasks"]}
    assert by_material[9911]["completed"] and not by_material[9910]["completed"]
    assert by_material[9912]["required"] is False


def test_requirement_rejects_out_of_range_and_unknown_material(client, db, teacher, classroom, mixed):
    for key, rule in ((9910, {"scope": "range", "start_page": 2, "end_page": 3}),
                      (9911, {"scope": "all"}), (9911, {"minimum_seconds": 61})):
        res = client.put(f"{mixed}/{key}", headers=teacher["headers"], json={"required": True, "rule": rule})
        assert res.status_code == 422
    assert client.put(f"{mixed}/987654", headers=teacher["headers"], json={"required": True}).status_code == 404


def test_same_ids_in_distinct_materials_keep_independent_reading_credit(client, db, teacher, student, classroom, mixed, clock):
    def beat(material, seq, page, **extra):
        return heartbeat(client, student, classroom, material, seq, page_id=page, **extra)
    beat(9910, 1, 10)
    clock(2)
    beat(9910, 2, 20)
    clock(2)
    assert beat(9910, 3, 20, visible=False)["completed"]
    assert not beat(9912, 1, 10)["completed"]
    clock(2)
    result = beat(9912, 2, 10, visible=False)
    assert result["read_count"] == 1 and not result["completed"]
    change = client.put(f"{mixed}/9912", headers=teacher["headers"], json={
        "required": True, "rule": {"scope": "range", "start_page": 1, "end_page": 1}})
    assert change.status_code == 200
    tasks = client.get(f"/api/chapter-tasks?classroom_id={classroom['id']}", headers=student["headers"]).json()["chapters"][0]["tasks"]
    assert next(t for t in tasks if t.get("material_id") == 9912)["completed"]


def test_two_videos_and_duplicate_heartbeats_do_not_record_overlapping_time(client, db, student, classroom, mixed, clock):
    def beat(material, seq, position):
        return heartbeat(client, student, classroom, material, seq, position=position, playing=True)
    beat(9911, 1, 0)
    beat(9913, 1, 0)
    beat(9911, 1, 0)
    clock(5)
    assert beat(9913, 2, 5)["seconds"] == 5
    assert beat(9911, 2, 5)["seconds"] == 0


def test_foreign_private_material_is_not_a_student_task(client, db, teacher, student, classroom, mixed):
    from app.models import Material, MaterialParticipation, User
    other = User(student_id="86000009001", name="其他教师", role="teacher", password_hash="unused")
    db.add(other)
    db.flush()
    db.get(Material, 9910).owner_id = other.id
    db.commit()
    cid = classroom["id"]
    response = client.get(f"/api/chapter-tasks?classroom_id={cid}", headers=student["headers"])
    assert not any(t.get("material_id") == 9910 for c in response.json()["chapters"] for t in c["tasks"])
    beat = {"session_id": "foreign", "sequence": 1, "visible": True, "page_id": 10}
    assert client.post(f"/api/chapters/179/materials/9910/participation?classroom_id={cid}", json=beat, headers=student["headers"]).status_code == 404
    assert not db.get(MaterialParticipation, (student["id"], cid, 179, 9910))
    assert client.put(mixed + "/9910", headers=teacher["headers"], json={"required": True}).status_code == 403
