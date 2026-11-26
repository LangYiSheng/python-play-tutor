"""Authorization and current quest-reference regression tests."""
from course_fixtures import create_test_class


from conftest import make_material, make_question

from uuid import uuid4
import pytest
from app.auth import hash_password, issue
from app.models import Activity, Question, User


def new_teacher(db):
    user = User(student_id="19434617522190", name="Teacher B", role="teacher", password_hash=hash_password("teacher-b-password"))
    db.add(user)
    db.commit()
    return {"id": user.id, "headers": {"Authorization": "Bearer " + issue(db, user)["access_token"]}}


def test_teacher_cannot_read_other_owner_draft_assessment_or_metadata(client, db, teacher, classroom):
    other = new_teacher(db)
    other_class = create_test_class(client, json={"name": "Teacher B private class"}, headers=other["headers"]).json()
    assert client.get(f"/api/teacher/courses/{other_class['course_id']}", headers=other["headers"]).status_code == 200
    assessment = Activity(id='teacher-a-unpublished-exam', chapter_id=179, title='PRIVATE_DRAFT_TITLE', kind='assessment', owner_id=teacher['id'], content={'published': False, 'question_ids': ['teacher-a-private-question']}, resources=[])
    db.add(assessment)
    db.flush()
    db.add(
        make_question(db,
            id="teacher-a-private-question",
            chapter_ids=[179],
            activity_id=assessment.id,
            title="PRIVATE_QUESTION",
            kind="boolean",
            prompt="PRIVATE_UNPUBLISHED_EXAM_TEXT",
            options=[],
            samples=[],
        )
    )
    db.commit()
    # Class B belongs to B, but that does not grant preview of A's draft.
    blocked = client.get(f"/api/activities/{assessment.id}?classroom_id={other_class['id']}", headers=other["headers"])
    assert blocked.status_code == 403
    assert "PRIVATE_UNPUBLISHED_EXAM_TEXT" not in blocked.text
    # Only enrolled students can join via a code. Other teachers cannot acquire draft access.
    assert client.post("/api/classrooms/join", json={"join_code": classroom["join_code"]}, headers=other["headers"]).status_code == 403
    assert client.get(f"/api/activities/{assessment.id}?classroom_id={classroom['id']}", headers=other["headers"]).status_code == 403
    own_preview = client.get(f"/api/activities/{assessment.id}?classroom_id={classroom['id']}", headers=teacher["headers"])
    assert own_preview.status_code == 200 and "PRIVATE_UNPUBLISHED_EXAM_TEXT" in own_preview.text
    listing = client.get(f"/api/teacher/courses/{classroom['course_id']}/catalog", headers=other["headers"])
    assert listing.status_code == 403 and "PRIVATE_DRAFT_TITLE" not in listing.text
    assert client.get(f"/api/activities/ch1-lesson?classroom_id={other_class['id']}", headers=other["headers"]).status_code == 403


def test_enrolled_student_reads_bound_current_material_only(client, db, teacher, classroom, student):
    assert client.post("/api/classrooms/join", json={"join_code": classroom["join_code"]}, headers=student["headers"]).status_code == 200
    material = make_material(db, id=9200, chapter_ids=[179], title="Current material", kind="text", owner_id=teacher["id"], status="ready",
                        content={"pages": [{"id": 9201, "page_no": 1, "title": "page", "text": "PUBLISHED_CURRENT_MATERIAL"}]})
    db.add(material)
    db.flush()
    db.commit()
    cid, headers = classroom["id"], student["headers"]
    published = client.get(f"/api/materials/{material.id}?classroom_id={cid}", headers=headers)
    assert published.status_code == 200 and "PUBLISHED_CURRENT_MATERIAL" in published.text
    material.content = {"pages": [{"id": 9201, "page_no": 1, "title": "page", "text": "UPDATED_CURRENT_MATERIAL"}]}
    db.commit()
    updated = client.get(f"/api/materials/{material.id}?classroom_id={cid}", headers=headers)
    assert updated.status_code == 200 and "UPDATED_CURRENT_MATERIAL" in updated.text
    assert client.put(f"/api/teacher/classrooms/{cid}/releases/179", json={"status": "paused"}, headers=teacher["headers"]).status_code == 200
    assert client.get(f"/api/materials/{material.id}?classroom_id={cid}", headers=headers).status_code == 403
    assert client.get(f"/api/materials/{material.id}?classroom_id={cid}", headers=teacher["headers"]).status_code == 200


@pytest.mark.parametrize(
    "samples,hidden_cases",
    [
        ([{"input": "x", "output": "x"}] * 19, [{"input": "x", "expected_output": "x"}] * 2),
        ([{"input": "x"}], [{"input": "x", "expected_output": "x"}]),
        ([{"input": 42, "output": "x"}], [{"input": "x", "expected_output": "x"}]),
        ([{"input": "x", "output": "x", "callback_url": "http://invalid.test"}], [{"input": "x", "expected_output": "x"}]),
        ([{"input": "x", "output": "x"}], [{"input": {"nested": "invalid"}, "expected_output": "x"}]),
        ([{"input": "x", "output": "x" * 10001}], [{"input": "x", "expected_output": "x"}]),
    ],
)
def test_teacher_cannot_publish_unjudgeable_cases(client, db, teacher, samples, hidden_cases, classroom):
    response = client.post(
        f"/api/teacher/courses/{classroom['course_id']}/questions",
        json={
            "id": "invalid-cases",
            "chapter_ids": [179], "status": "ready",
            "title": "Invalid cases",
            "kind": "python",
            "prompt": "Test fixture",
            "samples": samples,
            "hidden_cases": hidden_cases},
        headers=teacher["headers"])
    assert response.status_code == 422, response.text
    assert db.get(Question, "invalid-cases") is None


def test_twenty_bounded_cases_publish_and_formally_submit_without_runtime_config_error(client, db, teacher, student, classroom):
    activity_id = "twenty-cases-practice"
    response = client.post(
        f"/api/teacher/courses/{classroom['course_id']}/activities",
        json={"id": activity_id, "chapter_id": 179, "title": "Bounded cases", "kind": "assessment", "published": False},
        headers=teacher["headers"])
    assert response.status_code == 201, response.text
    activity_id = response.json()["id"]
    response = client.post(
        f"/api/teacher/courses/{classroom['course_id']}/questions",
        json={
            "id": "twenty-cases",
            "chapter_ids": [179], "status": "ready",
            "title": "Twenty cases",
            "kind": "python",
            "prompt": "Explicit test fixture, not course content",
            "samples": [{"input": "x", "output": "x"}] * 19,
            "hidden_cases": [{"input": "private", "expected_output": "private"}]},
        headers=teacher["headers"])
    assert response.status_code == 201, response.text
    question_id = response.json()["id"]
    assert "activity_version" not in response.json()
    assert client.put(f"/api/teacher/courses/{classroom['course_id']}/activities/{activity_id}", json={"question_ids": [question_id], "published": True}, headers=teacher["headers"]).status_code == 200
    response = client.put(
        f"/api/teacher/classrooms/{classroom['id']}/releases/179", json={"status": "published"}, headers=teacher["headers"]
    )
    assert response.status_code == 200
    response = client.post(
        f"/api/activities/{activity_id}/assessment/submit",
        json={"classroom_id": classroom["id"], "idempotency_key": str(uuid4()),
              "answers": [{"question_id": question_id, "code": "print(input())"}]},
        headers=student["headers"],
    )
    assert response.status_code == 201, response.text
    assert response.json()["status"] == "grading"
    from app.integration_models import SubmissionPayload

    payload = db.get(SubmissionPayload, response.json()["results"][0]["id"])
    assert len(payload.cases) == 20 and payload.public_count == 19
