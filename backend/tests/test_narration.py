"""Page narration: teacher review state, staleness after a re-upload, and student visibility."""
from course_fixtures import create_test_class
from conftest import make_material


def pages(*texts):
    """Library-published material, so a student may read it without an activity."""
    return {"library_available": True,
            "pages": [{"id": n, "page_no": n, "title": f"第{n}页", "text": text} for n, text in enumerate(texts, 1)]}


def material_fixture(db, classroom, texts, **fields):
    """Library-published material of the test course; students may read it without an activity."""
    fields.setdefault("kind", "presentation")
    return make_material(db, chapter_ids=[179, 180], course_instance_id=db.info["fixture_course_instance_id"],
                         title="讲义", status="ready", content=pages(*texts), **fields)


def url(classroom, material, suffix=""):
    return f"/api/teacher/courses/{classroom['course_id']}/materials/{material.id}/narrations{suffix}"


def test_teacher_authors_reviews_and_student_sees_only_approved(client, db, classroom, teacher, student):
    material = material_fixture(db, classroom, ["第一页正文", "第二页正文"])
    db.commit()

    listed = client.get(url(classroom, material), headers=teacher["headers"])
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert body["coverage"] == {"pages": 2, "covered": 0, "missing": 2,
                                "draft": 0, "accepted": 0, "rejected": 0, "unavailable": 0, "stale": 0}
    assert [page["page_no"] for page in body["pages"]] == [1, 2]
    assert body["pages"][0]["has_text"] is True and body["pages"][0]["narration"] is None

    written = client.put(url(classroom, material, "/1"), json={"text": "这一页讲变量。", "target_seconds": 60},
                         headers=teacher["headers"])
    assert written.status_code == 200, written.text
    assert written.json()["status"] == "draft"

    # A draft is invisible to students until a teacher accepts it.
    hidden = client.get(f"/api/materials/{material.id}/narrations?classroom_id={classroom['id']}", headers=student["headers"])
    assert hidden.status_code == 200, hidden.text
    assert hidden.json()["pages"] == []

    accepted = client.post(url(classroom, material, "/1/accept"), headers=teacher["headers"])
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "accepted"

    shown = client.get(f"/api/materials/{material.id}/narrations?classroom_id={classroom['id']}", headers=student["headers"])
    assert shown.status_code == 200, shown.text
    assert shown.json()["pages"] == [{"page_no": 1, "text": "这一页讲变量。", "target_seconds": 60,
                                       "audio": False, "audio_seconds": None}]

    # Rejecting the approval hides it again.
    assert client.post(url(classroom, material, "/1/reject"), headers=teacher["headers"]).status_code == 200
    assert client.get(f"/api/materials/{material.id}/narrations?classroom_id={classroom['id']}",
                      headers=student["headers"]).json()["pages"] == []


def test_editing_one_page_twice_keeps_a_single_row(client, db, classroom, teacher):
    material = material_fixture(db, classroom, ["第一页正文"])
    db.commit()
    for text in ("初稿", "改过一版"):
        assert client.put(url(classroom, material, "/1"), json={"text": text}, headers=teacher["headers"]).status_code == 200
    body = client.get(url(classroom, material), headers=teacher["headers"]).json()
    assert body["pages"][0]["narration"]["text"] == "改过一版"
    assert body["pages"][0]["narration"]["edited_by_teacher"] is True
    assert body["coverage"]["covered"] == 1


def test_reupload_voids_an_approved_narration(client, db, classroom, teacher, student):
    material = material_fixture(db, classroom, ["第一页正文"])
    db.commit()
    client.put(url(classroom, material, "/1"), json={"text": "这一页讲变量。"}, headers=teacher["headers"])
    client.post(url(classroom, material, "/1/accept"), headers=teacher["headers"])

    material.content = pages("第一页正文（改过了）")
    db.commit()

    body = client.get(url(classroom, material), headers=teacher["headers"]).json()
    assert body["pages"][0]["narration"]["status"] == "stale"
    assert "原文已变化" in body["pages"][0]["narration"]["stale_reason"]
    # A stale approval must not keep leaking the old wording to students.
    assert client.get(f"/api/materials/{material.id}/narrations?classroom_id={classroom['id']}",
                      headers=student["headers"]).json()["pages"] == []
    # Re-review is refused until the wording is regenerated or edited again.
    assert client.post(url(classroom, material, "/1/accept"), headers=teacher["headers"]).status_code == 409
    assert client.put(url(classroom, material, "/1"), json={"text": "按新原文重写。"}, headers=teacher["headers"]).json()["status"] == "draft"


def test_narration_rejects_unknown_pages_and_empty_accepts(client, db, classroom, teacher):
    material = material_fixture(db, classroom, ["第一页正文"])
    db.commit()
    assert client.put(url(classroom, material, "/9"), json={"text": "越界"}, headers=teacher["headers"]).status_code == 404
    assert client.put(url(classroom, material, "/1"), json={"text": "   "}, headers=teacher["headers"]).status_code == 422
    assert client.put(url(classroom, material, "/1"), json={"text": "讲解", "target_seconds": 5},
                      headers=teacher["headers"]).status_code == 422
    assert client.post(url(classroom, material, "/1/accept"), headers=teacher["headers"]).status_code == 404


def test_narration_is_scoped_to_the_owning_classroom(client, db, classroom, teacher, student):
    material = material_fixture(db, classroom, ["第一页正文"])
    db.commit()
    other = create_test_class(client, json={"name": "别人的班级"}, headers=teacher["headers"])
    assert other.status_code == 201, other.text
    moved = url(other.json(), material)
    assert client.get(moved, headers=teacher["headers"]).status_code == 404
    assert client.get(f"/api/materials/{material.id}/narrations", headers=student["headers"]).status_code == 422


def test_deleting_a_draft_removes_it_from_the_list(client, db, classroom, teacher):
    material = material_fixture(db, classroom, ["第一页正文"])
    db.commit()
    client.put(url(classroom, material, "/1"), json={"text": "讲解"}, headers=teacher["headers"])
    assert client.delete(url(classroom, material, "/1"), headers=teacher["headers"]).status_code == 200
    body = client.get(url(classroom, material), headers=teacher["headers"]).json()
    assert body["pages"][0]["narration"] is None
    assert client.delete(url(classroom, material, "/1"), headers=teacher["headers"]).status_code == 404


def test_job_state_exposes_percent_position_and_progress_unit(client, db, classroom, teacher):
    from datetime import datetime, timezone
    from app.narration.models import NarrationJob

    material = material_fixture(db, classroom, ["第一页", "第二页", "第三页", "第四页", "第五页"])
    now = datetime.now(timezone.utc)
    db.add(
        NarrationJob(
            material_id=material.id,
            kind="pipeline",
            status="running",
            message="正在整理第 2 组",
            started_at=now,
            heartbeat_at=now,
            progress={
                "stage": "digest",
                "chain": ["digest", "calibrate", "apply", "script"],
                "done": 1,
                "total": 4,
                "queued": False,
                "checkpoint": {"group": 2, "pages": [5, 6, 7, 8]},
            },
        )
    )
    db.commit()

    res = client.get(url(classroom, material, "/job"), headers=teacher["headers"])
    assert res.status_code == 200, res.text
    snap = res.json()
    assert snap["running"] is True
    assert snap["done"] == 1
    assert snap["total"] == 4
    assert snap["percent"] == 25
    assert snap["progress_unit"] == "groups"
    assert snap["position"] == "第 2 组 · 第 5–8 页"


def test_teacher_can_create_and_edit_page_digest_text(client, db, classroom, teacher):
    material = material_fixture(db, classroom, ["原始解析文本"])
    db.commit()

    created = client.put(
        url(classroom, material, "/1/content"),
        json={"title": "计算工具演变", "topic": "从手动到自动", "tags": ["计算工具", "计算思维"], "text": "老师整理后的正文内容。"},
        headers=teacher["headers"],
    )
    assert created.status_code == 200, created.text
    assert created.json()["text"] == "老师整理后的正文内容。"
    assert created.json()["source"] == "teacher"

    updated = client.put(
        url(classroom, material, "/1/content"),
        json={"text": "再次修订后的整理稿正文。"},
        headers=teacher["headers"],
    )
    assert updated.status_code == 200, updated.text
    listed = client.get(url(classroom, material), headers=teacher["headers"]).json()
    assert listed["pages"][0]["digest"]["text"] == "再次修订后的整理稿正文。"
    assert listed["pages"][0]["digest"]["title"] == "计算工具演变"
