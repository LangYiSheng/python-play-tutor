from sqlalchemy import func, select

from app.integration_models import SubmissionPayload
from app.models import Activity, Question, QuestionSecret, Submission


def body(db, classroom):
    question = db.get(Question, "course-476")
    return {"classroom_id": classroom["id"], "activity_id": "ch2-code", "question_id": question.id,
            "idempotency_key": "browser-practice-001", "code": "print(input())",
            "browser_cases": [{"input": sample["input"], "output": sample.get("expected_output", sample.get("output", "")),
                               "stdout": sample.get("expected_output", sample.get("output", "")) + "\r\n", "stderr": ""} for sample in question.samples]}


def test_browser_practice_persists_progress_without_judge_and_retries_once(client, db, student, teacher, classroom, branching_course):
    payload = body(db, classroom)
    public = client.get(f"/api/activities/ch2-code?classroom_id={classroom['id']}", headers=student["headers"]).json()
    question = next(item for item in public["questions"] if item["id"] == "course-476")
    assert question["samples"] == [{"input": case["input"], "output": case["output"]} for case in payload["browser_cases"]]
    first = client.post("/api/submissions", json=payload, headers=student["headers"])
    assert first.status_code == 201, first.text
    receipt = first.json()
    assert receipt["status"] == "accepted"
    assert receipt["feedback"]["source"] == "browser_practice"
    assert receipt["feedback"]["passed_count"] == receipt["feedback"]["total_count"] == len(payload["browser_cases"])
    assert db.get(SubmissionPayload, receipt["id"]) is None
    assert client.post("/api/submissions", json=payload, headers=student["headers"]).json()["id"] == receipt["id"]
    assert db.scalar(select(func.count()).select_from(Submission)) == 1
    progress = client.get(f"/api/activities/ch2-code/progress?classroom_id={classroom['id']}", headers=student["headers"]).json()
    assert "course-476" in progress["accepted_question_ids"]
    assert client.get(f"/api/submissions/{receipt['id']}?classroom_id={classroom['id']}", headers=student["headers"]).json() == receipt
    assert client.get("/api/teacher/judge/submissions", params={"classroom_id": classroom["id"]}, headers=teacher["headers"]).json()["total"] == 0
    assert client.get(f"/api/teacher/judge/submissions/{receipt['id']}", params={"classroom_id": classroom["id"]}, headers=teacher["headers"]).status_code == 404
    counts = client.get("/api/teacher/judge/service", params={"classroom_id": classroom["id"]}, headers=teacher["headers"]).json()
    assert counts["counts"] == {}
    payload["browser_cases"][0]["stdout"] = "changed"
    assert client.post("/api/submissions", json=payload, headers=student["headers"]).status_code == 409


def test_browser_results_are_checked_and_do_not_require_private_cases(client, db, student, classroom, branching_course):
    payload = body(db, classroom)
    db.delete(db.get(QuestionSecret, payload["question_id"]))
    db.commit()
    payload["browser_cases"][0]["stdout"] = "incorrect output"
    result = client.post("/api/submissions", json=payload, headers=student["headers"]).json()
    assert result["status"] == "wrong_answer"
    assert result["feedback"]["passed_count"] == len(payload["browser_cases"]) - 1
    payload["idempotency_key"] += "-error"
    payload["browser_cases"][0]["stderr"] = "ValueError: test"
    assert client.post("/api/submissions", json=payload, headers=student["headers"]).json()["status"] == "runtime_error"
    progress = client.get(f"/api/activities/ch2-code/progress?classroom_id={classroom['id']}", headers=student["headers"]).json()
    assert "course-476" not in progress["accepted_question_ids"]


def test_browser_submission_rejects_missing_partial_stale_and_forged_counts(client, db, student, classroom, branching_course):
    payload = body(db, classroom)
    for patch in ({"browser_cases": None}, {"browser_cases": payload["browser_cases"][:-1]}, {"passed_count": 3},
                  {"browser_cases": [{**case, "output": "changed"} for case in payload["browser_cases"]]},
                  {"browser_cases": [{**case, "stdout": "x" * 16001} for case in payload["browser_cases"]]}):
        response = client.post("/api/submissions", json={**payload, **patch}, headers=student["headers"])
        assert response.status_code == 422, response.text
    assert db.scalar(select(func.count()).select_from(Submission)) == 0


def test_browser_receipt_cannot_be_used_for_assessment_or_other_actor(client, db, student, teacher, classroom, branching_course):
    payload = body(db, classroom)
    assert client.post("/api/submissions", json=payload, headers=teacher["headers"]).status_code == 403
    assert client.post("/api/submissions", json={**payload, "activity_id": "ch1-practice"}, headers=student["headers"]).status_code == 404
    assert client.post("/api/submissions", json={**payload, "classroom_id": classroom["id"] + 999}, headers=student["headers"]).status_code in {403, 404, 409}
    assert client.post("/api/submissions", json=payload, headers=student["headers"]).status_code == 201
    # A later activity-kind edit must not promote browser practice to exam evidence.
    db.get(Activity, "ch2-code").kind = "assessment"
    db.commit()
    assert client.post("/api/submissions", json={**payload, "idempotency_key": "cannot-submit-exam"}, headers=student["headers"]).status_code == 409
    paper = client.get(f"/api/activities/ch2-code/assessment?classroom_id={classroom['id']}", headers=student["headers"]).json()
    assert paper["status"] == "draft" and not paper["locked"] and not paper["results"]
