from datetime import datetime, timedelta, timezone
from uuid import uuid4
from app.course_content import access
from app.auth import as_utc
from app.course_content.releases import ReleaseInput
from app.models import ChapterRelease, Material, MaterialParticipation, Submission


def test_shanghai_and_utc_release_inputs_store_the_same_instant_and_preserve_boundary(client, db, teacher, student, classroom, monkeypatch, branching_course):
    instant = datetime(2026, 11, 3, 12, 0, 0, tzinfo=timezone.utc)

    class ControlledClock(datetime):
        current = instant - timedelta(seconds=1)

        @classmethod
        def now(cls, tz=None):
            return cls.current.astimezone(tz) if tz is not None else cls.current.replace(tzinfo=None)

    monkeypatch.setattr(access, "datetime", ControlledClock)
    path = f"/api/teacher/classrooms/{classroom['id']}/releases/180"
    for representation in ("2026-11-03T20:00:00+08:00", "2026-11-03T12:00:00Z"):
        model = ReleaseInput(opens_at=representation)
        assert model.opens_at == instant and model.opens_at.utcoffset() == timedelta(0)
        written = client.put(path, json={"status": "published", "opens_at": representation}, headers=teacher["headers"])
        assert written.status_code == 200, written.text
        assert written.json()["opens_at"] == "2026-11-03T12:00:00+00:00"
        db.expire_all()
        stored = db.get(ChapterRelease, (classroom["id"], 180))
        assert stored.opens_at.tzinfo is None  # SQLite strips timezone but must retain the UTC wall clock.
        assert stored.opens_at == datetime(2026, 11, 3, 12, 0, 0)
        listing = client.get(f"/api/teacher/classrooms/{classroom['id']}/releases", headers=teacher["headers"]).json()
        item = next(row for row in listing if row["chapter_id"] == 180)
        assert item["opens_at"] == "2026-11-03T12:00:00+00:00"
        ControlledClock.current = instant - timedelta(seconds=1)
        assert client.get(f"/api/activities/ch2-lesson?classroom_id={classroom['id']}", headers=student["headers"]).status_code == 403
        ControlledClock.current = instant
        assert client.get(f"/api/activities/ch2-lesson?classroom_id={classroom['id']}", headers=student["headers"]).status_code == 200
        ControlledClock.current = instant + timedelta(seconds=1)
        assert client.get(f"/api/activities/ch2-lesson?classroom_id={classroom['id']}", headers=student["headers"]).status_code == 200
    assert client.put(path, json={"status": "published", "opens_at": "2026-11-03T20:00:00"}, headers=teacher["headers"]).status_code == 422
    cleared = client.put(path, json={"status": "published", "opens_at": None}, headers=teacher["headers"])
    assert cleared.status_code == 200 and cleared.json()["opens_at"] is None
    db.expire_all()
    listing = client.get(f"/api/teacher/classrooms/{classroom['id']}/releases", headers=teacher["headers"]).json()
    assert next(row for row in listing if row["chapter_id"] == 180)["opens_at"] is None


def test_all_learning_timestamps_remain_explicit_utc_after_sqlite_requery(client, db, teacher, student, classroom):
    cid = classroom["id"]
    headers = student["headers"]
    material = db.get(Material, 186)
    beat = {"session_id": "timed-reading", "sequence": 1, "visible": True, "page_id": material.content["pages"][0]["id"]}
    reading = client.post(f"/api/chapters/179/materials/186/participation?classroom_id={cid}", json=beat, headers=headers)
    assert reading.status_code == 200, reading.text
    submission = client.post(
        "/api/submissions",
        json={
            "classroom_id": cid,
            "activity_id": "ch1-practice",
            "question_id": "ch1-computation",
            "idempotency_key": str(uuid4()),
            "mode": "submit",
            "answer": True},
        headers=headers,
    )
    assert submission.status_code == 201, submission.text
    submission_id = submission.json()["id"]
    db.expire_all()
    evidence = db.get(MaterialParticipation, (student["id"], cid, 179, 186)).evidence
    submission_row = db.get(Submission, submission_id)
    assert submission_row.created_at.tzinfo is None
    progress = client.get(f"/api/teacher/classrooms/{cid}/progress", headers=teacher["headers"]).json()
    detail = client.get(f"/api/teacher/classrooms/{cid}/students/{student['id']}", headers=teacher["headers"]).json()
    reread = client.get(f"/api/submissions/{submission_id}?classroom_id={cid}", headers=headers)
    assert reread.status_code == 200, reread.text
    expected = [
        (progress["submissions"][0]["created_at"], submission_row.created_at),
        (next(row for row in detail["participation"] if row["kind"] == "reading")["created_at"], datetime.fromisoformat(evidence["received_at"])),
        (detail["submissions"][0]["created_at"], submission_row.created_at),
        (reread.json()["created_at"], submission_row.created_at),
        (submission.json()["created_at"], submission_row.created_at),
    ]
    for encoded, stored in expected:
        assert isinstance(encoded, str) and encoded.endswith("+00:00")
        parsed = datetime.fromisoformat(encoded)
        assert parsed.utcoffset() == timedelta(0) and parsed == as_utc(stored)
