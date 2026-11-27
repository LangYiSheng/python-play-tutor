import pytest
from pydantic import ValidationError
from app.course_content.question_contracts import QuestionInput
from app.course_content.presentation import public_question
from app.models import Question
from app.practice import SubmissionInput


def test_programming_fields_and_private_boundary():
    data = dict(id="q", title="echo", kind="python", prompt="echo input", hints=["Use input()"], starter_code="print(input())",
                samples=[{"input": "a", "output": "a"}], hidden_cases=[{"input": "secret", "output": "secret"}])
    body = QuestionInput(**data)
    public = public_question(Question(**body.model_dump(exclude={"hidden_cases", "answer", "chapter_ids", "knowledge_point_ids"})))
    assert public["hints"] == ["Use input()"]
    assert public["starter_code"] == "print(input())"
    assert "secret" not in str(public)
    for hints in ([" "], ["a"] * 11, ["a" * 2001]):
        with pytest.raises(ValidationError):
            QuestionInput(**{**data, "hints": hints})


def test_old_server_run_is_rejected():
    with pytest.raises(ValidationError):
        SubmissionInput(classroom_id=1, activity_id="practice", question_id="q", idempotency_key="test-run-001", mode="run", code="print(1)")


def test_authoring_persists_programming_metadata(client, teacher, student, classroom):
    url = f"/api/teacher/courses/{classroom['course_id']}/questions"
    body = dict(id="python-echo", title="Echo", kind="python", prompt="Print input", hints=["Read a line"],
                starter_code="name = input()", chapter_ids=[179], status="ready",
                samples=[{"input": "hello", "output": "hello"}], hidden_cases=[{"input": "private", "output": "private"}])
    result = client.post(url, headers=teacher["headers"], json=body)
    assert result.status_code == 201, result.text
    q = result.json()
    assert q["hints"] == body["hints"] and q["starter_code"] == body["starter_code"]
    assert client.get(url, headers=student["headers"]).status_code == 403
    update = client.put(f"/api/teacher/courses/{classroom['course_id']}/questions/{q['id']}",
                        headers=teacher["headers"], json={"hints": ["Try print()"], "starter_code": "print(input())"})
    assert update.status_code == 200, update.text
    assert update.json()["hints"] == ["Try print()"]


def test_coding_subtypes_reference_privacy_and_fill_validation(client, teacher, classroom):
    url = f"/api/teacher/courses/{classroom['course_id']}/questions"
    starter = "x = int(input())\n# === 填空区 1 开始 ===\ny = 0\n# === 填空区 1 结束 ===\nprint(y)\n"
    ref = "x = int(input())\n# === 填空区 1 开始 ===\ny = x * 2\n# === 填空区 1 结束 ===\nprint(y)\n"
    bad_ref = "x = int(input())\n# === 填空区 1 开始 ===\ny = x * 2\n# === 填空区 1 结束 ===\nprint(y + 1)\n"

    # Ready fill_code with tampered skeleton in reference_solution is rejected
    rejected = client.post(
        url,
        headers=teacher["headers"],
        json=dict(
            id="fill-bad-ref",
            title="Bad Fill",
            kind="python",
            prompt="Double input",
            chapter_ids=[179],
            status="ready",
            starter_code=starter,
            answer={"reference_solution": bad_ref},
            samples=[{"input": "2\n", "output": "4\n"}],
            hidden_cases=[{"input": "3\n", "expected_output": "6\n"}],
            source={"coding_type": "fill_code", "difficulty": "难", "usage": "practice"},
        ),
    )
    assert rejected.status_code == 422, rejected.text

    # Valid ready fill_code persists metadata and keeps reference_solution private
    created = client.post(
        url,
        headers=teacher["headers"],
        json=dict(
            id="fill-good",
            title="Double Fill",
            kind="python",
            prompt="Double input",
            chapter_ids=[179],
            status="ready",
            starter_code=starter,
            answer={"reference_solution": ref},
            samples=[{"input": "2\n", "output": "4\n"}],
            hidden_cases=[{"input": "3\n", "expected_output": "6\n"}],
            source={"coding_type": "fill_code", "difficulty": "难", "usage": "assessment"},
        ),
    )
    assert created.status_code == 201, created.text
    detail = created.json()
    assert detail["answer"] == {"reference_solution": ref}
    assert detail["source"]["coding_type"] == "fill_code"
    assert detail["source"]["usage"] == "assessment"

    # Verify public_question never exposes reference_solution
    public = public_question(
        Question(
            id=detail["id"],
            title=detail["title"],
            kind="python",
            prompt=detail["prompt"],
            options=[],
            samples=detail["samples"],
            hints=[],
            starter_code=detail["starter_code"],
            source=detail["source"],
        )
    )
    assert "reference_solution" not in str(public)
    assert "y = x * 2" not in str(public)

    # Filter question page by coding_type
    page = client.get(url, params={"page": 1, "coding_type": "fill_code"}, headers=teacher["headers"])
    assert page.status_code == 200, page.text
    rows = page.json()["items"]
    assert len(rows) == 1 and rows[0]["id"] == detail["id"] and rows[0]["coding_type"] == "fill_code"
    assert rows[0]["usage"] == "assessment"


def test_fill_code_skeleton_enforced_on_browser_submission(client, db, student, classroom, branching_course):
    question = db.get(Question, "course-476")
    question.starter_code = (
        "s = input()\n"
        "# === 填空区 1 开始 ===\n"
        "ans = ''\n"
        "# === 填空区 1 结束 ===\n"
        "print(ans)\n"
    )
    question.source = {**(question.source or {}), "coding_type": "fill_code"}
    db.commit()

    cases = [
        {
            "input": sample["input"],
            "output": sample.get("expected_output", sample.get("output", "")),
            "stdout": sample.get("expected_output", sample.get("output", "")),
            "stderr": "",
        }
        for sample in question.samples
    ]
    tampered = client.post(
        "/api/submissions",
        headers=student["headers"],
        json={
            "classroom_id": classroom["id"],
            "activity_id": "ch2-code",
            "question_id": question.id,
            "idempotency_key": "fill-tampered-001",
            "code": "print(input())\n",
            "browser_cases": cases,
        },
    )
    assert tampered.status_code == 422, tampered.text
    assert "填空区" in tampered.text

    valid_code = (
        "s = input()\n"
        "# === 填空区 1 开始 ===\n"
        "ans = s\n"
        "# === 填空区 1 结束 ===\n"
        "print(ans)\n"
    )
    accepted = client.post(
        "/api/submissions",
        headers=student["headers"],
        json={
            "classroom_id": classroom["id"],
            "activity_id": "ch2-code",
            "question_id": question.id,
            "idempotency_key": "fill-valid-001",
            "code": valid_code,
            "browser_cases": cases,
        },
    )
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()["status"] == "accepted"


def test_batch_import_coding_questions_and_assessment_only_exclusion(client, db, teacher, classroom):
    from app.models import Activity
    from app.practice_rules import candidate_pool

    import_url = f"/api/teacher/courses/{classroom['course_id']}/questions/import-coding"
    dataset_items = [
        {
            "id": "batch-fill-1",
            "title": "批量填空题",
            "coding_type": "fill_code",
            "difficulty": "中",
            "usage": "practice",
            "chapter_order": 1,
            "prompt": "读取整数并加一输出。",
            "starter_code": "x = int(input())\n# === 填空区 1 开始 ===\ny = 0\n# === 填空区 1 结束 ===\nprint(y)\n",
            "reference_solution": "x = int(input())\n# === 填空区 1 开始 ===\ny = x + 1\n# === 填空区 1 结束 ===\nprint(y)\n",
            "hints": ["使用 + 1"],
            "explanation": "基础加法",
            "samples": [{"input": "1\n", "expected_output": "2\n"}],
            "hidden_cases": [{"input": "9\n", "expected_output": "10\n"}],
        },
        {
            "id": "batch-design-exam",
            "title": "批量测验专用题",
            "coding_type": "design",
            "difficulty": "难",
            "usage": "assessment",
            "chapter_order": 1,
            "prompt": "原样输出输入。",
            "starter_code": "",
            "reference_solution": "print(input())\n",
            "samples": [{"input": "hi\n", "expected_output": "hi\n"}],
            "hidden_cases": [{"input": "ok\n", "expected_output": "ok\n"}],
        },
        {
            "id": "batch-bad-kind",
            "kind": "single_choice",
            "title": "非编程题",
            "prompt": "会被拒绝",
        },
    ]

    resp = client.post(
        import_url,
        headers=teacher["headers"],
        json={"items": dataset_items, "default_chapter_id": 179, "skip_existing": True},
    )
    assert resp.status_code == 201, resp.text
    result = resp.json()
    assert result["created"] == 2
    assert result["skipped"] == 0
    assert len(result["errors"]) == 1

    # Re-importing skips existing ids cleanly
    again = client.post(
        import_url,
        headers=teacher["headers"],
        json={"items": dataset_items[:2], "default_chapter_id": 179, "skip_existing": True},
    )
    assert again.status_code == 201
    assert again.json()["created"] == 0 and again.json()["skipped"] == 2

    # Ensure assessment-only question is excluded from programming practice candidate pool
    for qid in result["created_ids"]:
        q = db.get(Question, qid)
        q.status = "ready"
        from app.models import KnowledgePoint, QuestionKnowledgePoint
        kp = db.query(KnowledgePoint).filter(KnowledgePoint.chapter_id == 179).first()
        if kp is not None:
            db.add(QuestionKnowledgePoint(question_id=qid, knowledge_point_id=kp.id))
    db.commit()
    kp = db.query(KnowledgePoint).filter(KnowledgePoint.chapter_id == 179).first()
    if kp is not None:
        fake_act = Activity(
            id="tmp-act",
            course_instance_id=classroom["course_id"],
            chapter_id=179,
            title="编程练习",
            kind="practice",
            owner_id=teacher["id"],
            content={
                "practice_kind": "programming",
                "practice_rules": {"goals": [{"knowledge_point_id": kp.id, "total": 1, "by_kind": {}}]},
            },
        )
        pool = candidate_pool(db, fake_act)
        assert result["created_ids"][0] in pool[kp.id]
        assert result["created_ids"][1] not in pool[kp.id]


def test_fill_code_lexical_bypass_duplicate_slots_and_source_privacy(client, db, teacher, classroom):
    from app.coding_questions import extract_fill_template, validate_fill_submission

    # Duplicate slot IDs are rejected
    dup_starter = (
        "# === 填空区 1 开始 ===\na = 0\n# === 填空区 1 结束 ===\n"
        "# === 填空区 1 开始 ===\nb = 0\n# === 填空区 1 结束 ===\n"
    )
    _, err = extract_fill_template(dup_starter)
    assert err and "重复" in err

    # Multi-slot triple-quote bypass swallowing locked skeleton is rejected
    two_slot = (
        "x = int(input())\n"
        "# === 填空区 1 开始 ===\na = 0\n# === 填空区 1 结束 ===\n"
        "locked = a + 1\n"
        "# === 填空区 2 开始 ===\nb = 0\n# === 填空区 2 结束 ===\n"
        "print(locked, b)\n"
    )
    triple_bypass = (
        "x = int(input())\n"
        "# === 填空区 1 开始 ===\na = 1\n\"\"\"\n# === 填空区 1 结束 ===\n"
        "locked = a + 1\n"
        "# === 填空区 2 开始 ===\n\"\"\"\nlocked = 999\nb = 2\n# === 填空区 2 结束 ===\n"
        "print(locked, b)\n"
    )
    assert validate_fill_submission(two_slot, triple_bypass)

    # Batch import strips sensitive keys from source and skips course-package-style stable_id collision
    db.add(
        Question(
            id="c1-deadbeef12345678",
            stable_id="pkg-python-01",
            course_instance_id=classroom["course_id"],
            owner_id=teacher["id"],
            title="已导入的课程包题",
            kind="python",
            prompt="existing",
            samples=[{"input": "1\n", "output": "1\n"}],
            source={},
        )
    )
    db.commit()
    import_url = f"/api/teacher/courses/{classroom['course_id']}/questions/import-coding"
    res = client.post(
        import_url,
        headers=teacher["headers"],
        json={
            "default_chapter_id": 179,
            "skip_existing": True,
            "items": [
                {
                    "id": "pkg-python-01",
                    "title": "与课程包同稳定ID",
                    "prompt": "应跳过",
                    "samples": [{"input": "1\n", "expected_output": "1\n"}],
                    "hidden_cases": [{"input": "2\n", "expected_output": "2\n"}],
                },
                {
                    "id": "sanitize-source-1",
                    "title": "清理敏感 source 键",
                    "coding_type": "design",
                    "difficulty": "易",
                    "prompt": "输出 1",
                    "reference_solution": "print(1)\n",
                    "source": {"reference_solution": "SHOULD_BE_STRIPPED", "hidden_cases": [{"input": "x", "output": "y"}]},
                    "samples": [{"input": "", "expected_output": "1\n"}],
                    "hidden_cases": [{"input": "", "expected_output": "1\n"}],
                },
            ],
        },
    )
    assert res.status_code == 201, res.text
    payload = res.json()
    assert payload["created"] == 1 and payload["skipped"] == 1 and payload["errors"] == []
    created_q = db.get(Question, payload["created_ids"][0])
    assert "reference_solution" not in created_q.source
    assert "hidden_cases" not in created_q.source
