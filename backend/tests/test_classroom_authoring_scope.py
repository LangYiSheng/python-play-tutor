"""Separate courses of the same teacher have independent editable definitions."""
from course_fixtures import create_test_class
import app.materials.jobs as materials_jobs

import pytest
from sqlalchemy import select

from app.content_relations import set_activity_questions
from app.models import Activity, CourseInstance, Material, Question, User
from app.auth import hash_password, issue


@pytest.fixture
def independent_classes(client, teacher, db):
    first = create_test_class(client, headers=teacher["headers"], json={"name": "第一个班"}).json()
    second = create_test_class(client, headers=teacher["headers"], json={"name": "另一个班"}).json()
    classes = [first["id"], second["id"]]
    for key in classes:
        from fixture_instances import clone_current_course
        clone_current_course(db, key)
        db.commit()
    return first["course_id"], second["course_id"]


def test_rename_course_scopes_edits_and_checks_revision(client, teacher, admin_account, independent_classes):
    first, second = (f"/api/teacher/courses/{key}" for key in independent_classes)
    headers = teacher["headers"]
    before = client.get(first, headers=headers).json()
    sibling = client.get(second, headers=headers).json()
    payload = {"name": "  新课程名  ", "expected_revision": before["revision"]}
    saved = client.patch(first, headers=headers, json=payload)
    assert saved.status_code == 200
    assert saved.json() == {**before, "name": "新课程名", "revision": before["revision"] + 1}
    assert client.patch(first, headers=headers, json=payload).json() == saved.json()
    assert client.patch(first, headers=headers, json={**payload, "name": "冲突"}).status_code == 409
    assert client.patch(first, headers=headers, json={**payload, "name": "  "}).status_code == 422
    assert client.get(second, headers=headers).json() == sibling
    admin_class = create_test_class(client, headers=admin_account["headers"], json={"name": "管理员班级"}).json()
    other = f"/api/teacher/courses/{admin_class['course_id']}"
    assert client.patch(other, headers=headers, json=payload).status_code == 403
    assert client.patch(other, headers=admin_account["headers"], json=payload).status_code == 200
    response = client.patch(first, headers=admin_account["headers"], json={"name": "管理员修改", "expected_revision": saved.json()["revision"]})
    assert response.status_code == 200 and response.json()["name"] == "管理员修改"


def test_same_teacher_classrooms_have_independent_editable_bank(client, teacher, independent_classes):
    first, second = independent_classes
    def bank(cid):
        response = client.get(f"/api/teacher/courses/{cid}/questions", headers=teacher["headers"])
        assert response.status_code == 200, response.text
        return response.json()
    a, b = bank(first), bank(second)
    assert a and b
    assert {q["id"] for q in a}.isdisjoint({q["id"] for q in b})
    target = a[0]
    response = client.put(f"/api/teacher/courses/{first}/questions/{target['id']}",
                          headers=teacher["headers"], json={"title": "甲班独立题目"})
    assert response.status_code == 200, response.text
    assert all(q["title"] != "甲班独立题目" for q in bank(second))
    response = client.put(f"/api/teacher/courses/{second}/questions/{target['id']}",
                          headers=teacher["headers"], json={"title": "越界修改"})
    assert response.status_code == 404


def test_cross_class_associations_and_private_files_are_rejected(client, db, teacher, independent_classes):
    first, second = independent_classes
    instances = [db.get(CourseInstance, cid) for cid in (first, second)]
    activity = db.scalar(select(Activity).where(Activity.course_instance_id == instances[0].id, Activity.kind == "practice"))
    question = db.scalar(select(Question).where(Question.course_instance_id == instances[1].id))
    material = db.scalar(select(Material).where(Material.course_instance_id == instances[0].id))
    response = client.put(f"/api/teacher/courses/{first}/activities/{activity.id}/questions",
                          headers=teacher["headers"], json={"question_ids": [question.id]})
    assert response.status_code == 404
    with pytest.raises(ValueError, match="同一班级"):
        set_activity_questions(db, activity, [question.id])
    for tail in ("", "/file"):
        response = client.get(f"/api/teacher/courses/{second}/materials/{material.id}{tail}", headers=teacher["headers"])
        assert response.status_code == 404


def test_revision_and_scoped_chapter_order(client, teacher, independent_classes):
    first, second = independent_classes
    url = f"/api/teacher/courses/{first}"
    before = client.get(url, headers=teacher["headers"]).json()
    for cid in (first, second):
        response = client.post(f"/api/teacher/courses/{cid}/chapters", headers=teacher["headers"],
                               json={"title": "本班章节", "order_index": 99})
        assert response.status_code == 201, response.text
    after = client.get(url, headers=teacher["headers"]).json()
    assert after["revision"] == before["revision"] + 1
    assert client.get(url, headers=teacher["headers"]).json() == after


def test_initialization_is_explicit_and_authorized(client, db, teacher, student):
    other = User(student_id="9988776655", name="另一位教师", role="teacher", password_hash=hash_password("another-password"))
    db.add(other)
    db.commit()
    other_headers = {"Authorization": "Bearer " + issue(db, other)["access_token"]}
    created = create_test_class(client, headers=teacher["headers"], json={"name": "空班"}).json()
    url = f"/api/teacher/courses/{created['course_id']}"
    assert client.get(url, headers=teacher["headers"]).json()["id"] == created["course_id"]
    assert client.get(f"/api/teacher/courses/{created['course_id']}/catalog", headers=teacher["headers"]).json()["chapters"] == []
    assert client.get("/api/teacher/courses", headers=teacher["headers"]).status_code == 200
    assert client.post("/api/classrooms/join", json={"join_code": created["join_code"]}, headers=student["headers"]).status_code == 200
    assert client.get(f"/api/world?classroom_id={created['id']}", headers=student["headers"]).status_code == 200
    assert client.get(f"/api/activities/ch1-lesson?classroom_id={created['id']}", headers=student["headers"]).status_code == 403
    for headers in (other_headers, student["headers"]):
        assert client.post(url + "/classrooms", headers=headers, json={"name": "晚班"}).status_code == 403
    assert client.post(url + "/classrooms", headers=teacher["headers"], json={"name": ""}).status_code == 422


def test_material_processing_invalidates_course_preview_revision(client, db, teacher, independent_classes, tmp_path, monkeypatch):
    from sqlalchemy.orm import sessionmaker

    cid = independent_classes[0]
    monkeypatch.setenv("REBORN_STORAGE_ROOT", str(tmp_path))
    monkeypatch.setattr(materials_jobs, "SessionLocal", sessionmaker(db.bind, expire_on_commit=False))
    monkeypatch.setattr(materials_jobs, "parse_bounded", lambda *_: {"pages": [{"id": 1, "page_no": 1, "text": "converted", "title": "页"}]})
    response = client.post(f"/api/teacher/courses/{cid}/materials/upload", headers=teacher["headers"],
                           data={"title": "当前班资料"}, files={"file": ("course.txt", b"text", "text/plain")})
    assert response.status_code == 201, response.text
    instance = db.get(CourseInstance, cid)
    before = instance.revision
    materials_jobs.process_material(response.json()["id"])
    db.expire_all()
    assert instance.revision == before + 2  # Claim and final result each affect exchange consistency.
    assert db.get(Material, response.json()["id"]).status == "ready"


def test_empty_course_does_not_copy_demo_content_and_retry_keeps_edits(client, teacher):
    created = create_test_class(client, headers=teacher["headers"], json={"name": "空白课程班"}).json()
    url = f"/api/teacher/courses/{created['course_id']}"
    assert client.get(url + "/questions", headers=teacher["headers"]).json() == []
    assert client.get(url + "/catalog", headers=teacher["headers"]).json()["chapters"] == []
    chapter = client.post(url + "/chapters", headers=teacher["headers"], json={"title": "开班前的内容"}).json()
    second = client.post(url + "/classrooms", headers=teacher["headers"], json={"name": "晚班"}).json()
    assert second["course_id"] == created["course_id"]
    assert client.get(url + "/catalog", headers=teacher["headers"]).json()["chapters"][0]["id"] == chapter["id"]
