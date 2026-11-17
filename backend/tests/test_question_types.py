from typing import get_args

import pytest
from pydantic import ValidationError
from sqlalchemy import select, func

from app.assistant_context import TurnState
from app.content_relations import set_activity_questions
from app.course_content.question_contracts import QuestionInput
from app.models import Submission
from app.question_types import QUESTION_TYPES, QuestionKind, grade_answer, question_type


@pytest.mark.parametrize("kind,answer,expected,result", [
    ("single_choice", "A", "A", True), ("single_choice", "a", "A", False),
    ("boolean", False, False, True), ("boolean", "true", True, False),
    ("fill", " PYTHON ", ["python", "py"], True), ("fill", ["python"], ["python"], False),
    ("multiple_choice", ["B", "A"], ["A", "B"], True),
    ("multiple_choice", ["A"], ["A", "B"], False),
    ("multiple_choice", ["A", "B", "C"], ["A", "B"], False),
    ("multiple_choice", ["A", "A", "B"], ["A", "B"], False),
    ("multiple_choice", "A,B", ["A", "B"], False),
    ("multiple_choice", [], ["A", "B"], False),
    ("multiple_choice", [{"value": "A"}], ["A", "B"], False),
])
def test_answer_grading(kind, answer, expected, result):
    assert grade_answer(answer, {"value": expected}, kind) is result


def test_registry_is_exhaustive_and_rejects_unknown_execution():
    assert set(QUESTION_TYPES) == set(get_args(QuestionKind))
    with pytest.raises(ValueError, match="不支持"):
        question_type("future_kind")
    with pytest.raises(ValueError, match="评测"):
        grade_answer("print(1)", None, "python")
    assert TurnState(answer=["A", "B"]).answer == ["A", "B"]


def definition(**overrides):
    return dict(id="multi", title="选择类型", kind="multiple_choice", prompt="选出数字类型",
                chapter_ids=[179], status="ready", options=["int", "float", "str"], answer=["int", "float"], **overrides)


@pytest.mark.parametrize("change", [
    {"options": ["A", "A"]}, {"options": ["", "B"]}, {"options": [1, 2]},
    {"answer": ["int"]}, {"answer": ["int", "int"]}, {"answer": ["int", "unknown"]},
    {"answer": "int,float"}, {"answer": [True, False]},
])
def test_ready_definition_validation(change):
    with pytest.raises(ValidationError):
        QuestionInput(**{**definition(), **change})
    assert QuestionInput(**{**definition(), **change, "status": "draft"})


def create_multi(client, db, teacher, classroom):
    response = client.post(f"/api/teacher/questions?classroom_id={classroom['id']}",
                           headers=teacher["headers"], json=definition())
    assert response.status_code == 201, response.text
    question_id = response.json()["id"]
    for activity_id in ("ch1-practice", "ch1-assessment"):
        set_activity_questions(db, activity_id, [question_id])
    db.commit()
    return question_id


def test_multiple_choice_practice_private_idempotent_and_retryable(client, db, teacher, student, classroom):
    question_id = create_multi(client, db, teacher, classroom)
    public = client.get(f"/api/activities/ch1-practice?classroom_id={classroom['id']}", headers=student["headers"])
    assert public.status_code == 200, public.text
    question = public.json()["questions"][0]
    assert question["kind"] == "multiple_choice"
    assert "answer" not in question and "hidden_cases" not in question
    body = dict(classroom_id=classroom["id"], activity_id="ch1-practice", question_id=question_id,
                idempotency_key="multiple-wrong-0001", answer=["int"])
    assert client.post("/api/submissions", json=body, headers=student["headers"]).json()["status"] == "wrong_answer"
    body.update(answer=["float", "int"], idempotency_key="multiple-correct-0001")
    first = client.post("/api/submissions", json=body, headers=student["headers"])
    retry = client.post("/api/submissions", json=body, headers=student["headers"])
    assert first.status_code == retry.status_code == 201
    assert first.json()["status"] == "accepted" and first.json()["id"] == retry.json()["id"]
    assert db.scalar(select(func.count()).select_from(Submission)) == 2


def test_multiple_choice_assessment_restores_draft_and_locks(client, db, teacher, student, classroom):
    question_id = create_multi(client, db, teacher, classroom)
    url = "/api/activities/ch1-assessment/assessment"
    entries = [{"question_id": question_id, "answer": ["float", "int"]}]
    draft = client.put(url, headers=student["headers"], json={"classroom_id": classroom["id"], "revision": 0, "answers": entries})
    assert draft.status_code == 200, draft.text
    saved = client.get(url, params={"classroom_id": classroom["id"]}, headers=student["headers"]).json()
    assert saved["answers"][0]["answer"] == ["float", "int"]
    body = dict(classroom_id=classroom["id"], answers=entries, idempotency_key="multiple-paper-0001")
    for invalid in ([], ["int", "int"], ["int", "unknown"], "int,float"):
        rejected = client.post(url + "/submit", headers=student["headers"],
                               json={**body, "answers": [{"question_id": question_id, "answer": invalid}]})
        assert rejected.status_code == 422, rejected.text
    submitted = client.post(url + "/submit", headers=student["headers"], json=body)
    assert submitted.status_code == 201, submitted.text
    assert submitted.json()["locked"] and submitted.json()["score"] == 100
    changed = client.put(url, headers=student["headers"], json={"classroom_id": classroom["id"], "revision": saved["revision"], "answers": []})
    assert changed.status_code == 409
