from copy import deepcopy

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from app.content_relations import set_activity_questions
from app.course_content.presentation import public_question
from app.course_content.question_contracts import QuestionInput
from app.course_packages.apply import import_bundle
from app.course_packages.manifest import PackageError
from app.course_packages.reader import load_bundle
from app.course_packages.validation import validate_bundle
from app.course_packages.writer import write_package
from app.interactive_practice import validate_json_value
from app.models import Activity, Classroom, CourseInstance, Question, QuestionSecret


CONTENT = {"html": "<button>入栈</button>", "css": "button{color:green}", "js": "practice.onCheck(() => practice.correct('完成'))"}
TARGET = {"value": ["herb", "private-gem"], "level": 1}
DEFINITION = {"id": "interactive-stack", "title": "整理背包", "kind": "interactive", "prompt": "把物品放好",
              "chapter_ids": [179], "status": "ready", "interactive": CONTENT, "answer": TARGET}


@pytest.mark.parametrize("invalid", [{"answer": None}, {"interactive": None}, {"interactive": {**CONTENT, "js": " "}},
                                      {"interactive": {**CONTENT, "css": "x" * 16001}}, {"answer": "界" * 5500},
                                      {"answer": 2**53}, {"kind": "fill"}])
def test_interactive_definition_rejects_invalid_content(invalid):
    with pytest.raises(ValidationError):
        QuestionInput.model_validate({**DEFINITION, **invalid})


def test_interactive_json_depth_and_finite_number():
    value = []
    for _ in range(17):
        value = [value]
    for bad in [value, float("inf"), float("nan")]:
        with pytest.raises(ValueError):
            validate_json_value(bad)
    assert type(QuestionInput.model_validate({**DEFINITION, "answer": 1}).answer) is int
    assert type(QuestionInput.model_validate({**DEFINITION, "answer": False}).answer) is bool


def test_author_and_submit_interactive_with_private_verification(client, db, teacher, student, classroom):
    scope = {"classroom_id": classroom["id"]}
    teacher_api = "/api/teacher"
    opts = {"params": scope, "headers": teacher["headers"]}
    learner = {"params": scope, "headers": student["headers"]}
    assert client.post(teacher_api + "/questions", **learner, json=DEFINITION).status_code == 403
    created = client.post(teacher_api + "/questions", **opts, json=DEFINITION)
    assert created.status_code == 201, created.text
    question = created.json()
    assert question["interactive"] == CONTENT and question["answer"] == TARGET
    activity = client.post(teacher_api + "/activities", **opts, json={
        "id": "stack-practice", "chapter_id": 179, "title": "背包练习", "kind": "practice", "question_ids": [question["id"]]})
    assert activity.status_code == 201, activity.text
    activity_id = activity.json()["id"]
    practice = f"/api/activities/{activity_id}"
    response = client.get(practice, **learner)
    assert response.json()["questions"][0]["interactive"] == CONTENT and "private-gem" not in response.text
    assert "interactive" not in public_question(db.get(Question, question["id"]), include_interactive=False)

    def submit(key, answer):
        return client.post("/api/submissions", headers=student["headers"], json={**scope, "activity_id": activity_id,
                           "question_id": question["id"], "idempotency_key": key, "answer": answer})

    receipt = {"value": TARGET, "correct": True, "message": "完成了"}
    invalid = submit("wrong-shape", {**receipt, "correct": 1})
    assert invalid.status_code == 422, invalid.text
    forged = submit("forged-answer", {**receipt, "value": {**TARGET, "level": True}})
    assert forged.status_code == 201 and forged.json()["status"] == "wrong_answer"
    assert forged.json()["feedback"]["detail"] != receipt["message"]
    assert not client.get(practice, **learner).json()["progress"]["completed"]
    local_wrong = submit("local-wrong", {**receipt, "correct": False, "message": "顺序不对"})
    assert local_wrong.json()["feedback"]["detail"] == "顺序不对" and local_wrong.json()["status"] == "wrong_answer"
    first = submit("valid-answer", receipt)
    assert first.status_code == 201 and first.json()["status"] == "accepted", first.text
    assert submit("valid-answer", receipt).json()["id"] == first.json()["id"]
    assert submit("valid-answer", {**receipt, "value": {**TARGET, "level": True}}).status_code == 409
    assert client.get(practice, **learner).json()["progress"]["completed"]


def test_interactive_excluded_from_assessment_and_course_exchange(client, db, teacher, student, classroom, tmp_path):
    opts = {"params": {"classroom_id": classroom["id"]}, "headers": teacher["headers"]}
    created = client.post("/api/teacher/questions", **opts, json=DEFINITION)
    assert created.status_code == 201, created.text
    question_id = created.json()["id"]
    exam_id = client.post("/api/teacher/activities", **opts,
                          json={"id": "stack-assessment", "chapter_id": 179, "title": "单元测验", "kind": "assessment"}).json()["id"]
    binding = f"/api/teacher/activities/{exam_id}/questions"
    assert client.put(binding, **opts, json={"question_ids": [question_id]}).status_code == 422
    existing = client.post("/api/teacher/questions", **opts, json={**DEFINITION, "id": "assessed", "kind": "fill",
                                                                    "interactive": None, "answer": "answer"}).json()["id"]
    activity_url = f"/api/teacher/activities/{exam_id}"
    assert client.put(activity_url, **opts, json={"title": "第一场测验", "question_ids": [existing]}).status_code == 200
    paper = client.put(f"/api/activities/{exam_id}/assessment", headers=student["headers"], json={
        "classroom_id": classroom["id"], "revision": 0, "answers": [{"question_id": existing, "answer": "草稿"}]})
    assert paper.status_code == 200, paper.text
    rejected = client.put(activity_url, **opts, json={"title": "另一个标题", "question_ids": []})
    assert rejected.status_code == 409, rejected.text
    # The fixture shares a session across requests. End it as the production dependency does.
    db.rollback()
    assert db.get(Activity, exam_id).title == "第一场测验"
    change = client.put("/api/teacher/questions/" + existing, **opts, json={"kind": "interactive", "interactive": CONTENT, "answer": TARGET})
    assert change.status_code == 409

    instance = db.scalar(select(CourseInstance).where(CourseInstance.classroom_id == classroom["id"]))
    write_package(db, instance, tmp_path)
    bundle = load_bundle(tmp_path)
    exported = next(q for q in bundle["data"]["question"] if q["id"] == DEFINITION["id"])
    assert exported["interactive"] == CONTENT and "answer" not in exported
    imported_class = client.post("/api/classrooms", headers=teacher["headers"], json={"name": "交互课"}).json()["id"]
    copied = import_bundle(db, db.get(Classroom, imported_class), None, bundle, tmp_path)
    imported = db.scalar(select(Question).where(Question.course_instance_id == copied.id, Question.stable_id == DEFINITION["id"]))
    assert imported.interactive == CONTENT and db.get(QuestionSecret, imported.id).answer == TARGET
    bad = deepcopy(bundle)
    next(a for a in bad["data"]["activity"] if a["id"] == "stack-assessment")["question_ids"] = [DEFINITION["id"]]
    with pytest.raises(PackageError, match="只能用于练习"):
        validate_bundle(bad, tmp_path)
    set_activity_questions(db, exam_id, [question_id])
    db.commit()
    for route in (f"/api/activities/{exam_id}", f"/api/activities/{exam_id}/assessment"):
        rejected = client.get(route, params=opts["params"], headers=student["headers"])
        assert rejected.status_code == 409 and CONTENT["js"] not in rejected.text


def test_interactive_knowledge_point_goal(client, teacher, student, classroom):
    scope = {"classroom_id": classroom["id"]}
    opts = {"params": scope, "headers": teacher["headers"]}
    point = client.post("/api/teacher/knowledge-points", **opts, json={"chapter_id": 179, "title": "栈"}).json()["id"]
    question = client.post("/api/teacher/questions", **opts, json={**DEFINITION, "knowledge_point_ids": [point]}).json()["id"]
    rules = {"goals": [{"knowledge_point_id": point, "by_kind": {"interactive": 1}}]}
    activity = client.post("/api/teacher/activities", **opts, json={"kind": "practice", "chapter_id": 179, "id": "stack-goal",
                           "title": "栈练习", "practice_rules": rules})
    assert activity.status_code == 201, activity.text
    activity_id = activity.json()["id"]
    page = f"/api/activities/{activity_id}"
    learner = {"params": scope, "headers": student["headers"]}
    assert [row["id"] for row in client.get(page, **learner).json()["questions"]] == [question]
    sent = client.post("/api/submissions", headers=student["headers"], json={**scope, "activity_id": activity_id,
                       "question_id": question, "answer": {"correct": True, "value": TARGET, "message": ""}, "code": "",
                       "idempotency_key": "stack-goal-once"})
    assert sent.status_code == 201 and sent.json()["status"] == "accepted", sent.text
    assert client.get(page, **learner).json()["progress"]["completed"]
