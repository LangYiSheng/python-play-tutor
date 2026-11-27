"""The same published content controls task lists, reading evidence and stale submissions."""
from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.chapter_tasks.router import Heartbeat, update_evidence
from app.chapter_tasks.rules import reading_task, validate_rule
from app.models import Chapter, ChapterRelease, Classroom, CourseInstance, Material, MaterialParticipation, Membership, Question, QuestionChapter, QuestionSecret, now


def test_page_and_time_evidence(monkeypatch):
    material = SimpleNamespace(id=1, title="课件", kind="pdf", status="ready", content={"pages": [
        {"id": 33, "page_no": 1}, {"id": 19, "page_no": 2}, {"id": 47, "page_no": 3}]})
    rule = {"scope": "count", "count": 2, "minimum_seconds": 10}
    link = SimpleNamespace(chapter_id=1, required=True, rule=rule)
    validate_rule(rule, material)
    start = now()
    state = {}
    for seq, (offset, page, visible) in enumerate([(0, 33, True), (5, 33, False), (105, 19, True), (110, 19, False)], 1):
        monkeypatch.setattr("app.chapter_tasks.router.now", lambda: start + timedelta(seconds=offset))
        beat = Heartbeat(sequence=seq, session_id="reader", page_id=page, visible=visible)
        state = update_evidence(state, beat, material)
        assert update_evidence(state, beat, material) == state
    task = reading_task(link, material, state)
    assert task["completed"] and task["read_count"] == 2 and task["seconds"] == 10
    with pytest.raises(ValueError):
        validate_rule({"scope": "count", "count": 4}, material)


def test_chapter_changes_gate_saved_pages_and_existing_attempts(client, db, teacher, student, monkeypatch):
    course = CourseInstance(teacher_id=teacher["id"], name="教学测试", package_id="points", package_version="1")
    db.add(course)
    db.flush()
    room = Classroom(course_id=course.id, name="任务点测试", join_code="private-test")
    db.add(room)
    db.flush()
    db.add(Membership(user_id=student["id"], classroom_id=room.id))
    chapters = [Chapter(title=f"第{i}章", order_index=i, course_instance_id=course.id) for i in range(1, 6)]
    db.add_all(chapters)
    db.flush()
    db.add_all(ChapterRelease(classroom_id=room.id, chapter_id=c.id, status="published") for c in chapters)
    chapter = chapters[0]
    pdf = Material(title="必读", kind="pdf", course_instance_id=course.id, content={"pages": [{"id": 999, "page_no": 1}]})
    question = Question(id="task-objective", title="判断", kind="boolean", status="ready", prompt="判断", course_instance_id=course.id)
    python = Question(id="task-code", title="输出", kind="python", status="ready", prompt="输出 1",
                      samples=[{"input": "", "output": "1"}], course_instance_id=course.id)
    db.add_all([pdf, question, python])
    db.flush()
    db.add_all([QuestionChapter(question_id=question.id, chapter_id=chapter.id), QuestionSecret(question_id=question.id, answer=True)])
    db.add(QuestionChapter(question_id=python.id, chapter_id=chapter.id))
    db.commit()
    student_h, teacher_h = student["headers"], teacher["headers"]
    query = f"?classroom_id={room.id}"
    course_path = f"/api/teacher/courses/{course.id}"
    material_path = f"{course_path}/chapters/{chapter.id}/material-tasks/{pdf.id}"

    def publish(key, kind, required=True, coding=False):
        result = client.post(f"{course_path}/activities", headers=teacher_h, json={
            "id": key, "title": key, "chapter_id": chapter.id, "kind": kind, "required": required,
            "practice_kind": "programming" if coding else "objective", "question_ids": [python.id if coding else question.id]})
        assert result.status_code == 201, result.text
        return result.json()["id"]

    def chapter_tasks():
        result = client.get("/api/chapter-tasks" + query, headers=student_h)
        assert result.status_code == 200, result.text
        assert len(result.json()["chapters"]) == 5
        return {t["id"]: t for t in result.json()["chapters"][0]["tasks"]}

    objective = publish("concepts", "practice")
    programming = publish("coding", "practice", coding=True)
    optional = publish("extra", "practice", False)
    exam = publish("paper", "assessment")
    exam2 = publish("second-paper", "assessment")
    exercise = {"classroom_id": room.id, "activity_id": objective, "question_id": question.id,
                "idempotency_key": "attempt-0001", "answer": True}
    assert not chapter_tasks()[objective]["locked"]
    assert client.put(material_path, headers=teacher_h, json={"required": True, "rule": {}}).status_code == 200
    assert client.post("/api/submissions", headers=student_h, json=exercise).status_code == 403
    assert client.get(f"/api/activities/{exam}/assessment" + query, headers=student_h).status_code == 403
    beat_url = f"/api/chapters/{chapter.id}/materials/{pdf.id}/participation" + query
    beat = {"page_id": 999, "session_id": "pdf", "visible": True, "sequence": 1}
    start = now()
    monkeypatch.setattr("app.chapter_tasks.router.now", lambda: start)
    assert client.post(beat_url, headers=student_h, json=beat).status_code == 200
    monkeypatch.setattr("app.chapter_tasks.router.now", lambda: start + timedelta(seconds=2))
    assert client.post(beat_url, headers=student_h, json={**beat, "visible": False, "sequence": 2}).json()["completed"]
    assert db.scalar(select(MaterialParticipation).where(MaterialParticipation.material_id == pdf.id))
    assert not chapter_tasks()[optional]["locked"]
    response = client.post("/api/submissions", headers=student_h, json=exercise)
    assert response.status_code == 201, response.text
    assert chapter_tasks()[exam]["locked"]
    coding = {"classroom_id": room.id, "activity_id": programming, "question_id": python.id, "code": "print(1)",
              "idempotency_key": "code-attempt-0001", "browser_cases": [{"input": "", "output": "1", "stdout": "1", "stderr": ""}]}
    result = client.post("/api/submissions", headers=student_h, json=coding)
    assert result.status_code == 201, result.text
    assert not chapter_tasks()[exam]["locked"] and not chapter_tasks()[exam2]["locked"]
    answers = [{"question_id": question.id, "answer": False}]
    draft = {"classroom_id": room.id, "revision": 0, "answers": answers}
    paper_url = f"/api/activities/{exam}/assessment"
    assert client.put(paper_url, headers=student_h, json=draft).status_code == 200
    paper = {"classroom_id": room.id, "answers": answers, "idempotency_key": "exam-attempt-0001"}
    result = client.post(paper_url + "/submit", headers=student_h, json=paper)
    assert result.status_code == 201, result.text
    assert result.json()["completed"] and result.json()["score"] == 0
    second_paper_url = f"/api/activities/{exam2}/assessment"
    saved = client.put(second_paper_url, headers=student_h, json=draft)
    assert saved.status_code == 200
    supplement = Material(title="补充讲义", kind="pdf", course_instance_id=course.id,
                          content={"pages": [{"id": 891, "page_no": 1}]})
    db.add(supplement)
    db.commit()
    addition = f"{course_path}/chapters/{chapter.id}/material-tasks/{supplement.id}"
    assert client.put(addition, headers=teacher_h, json={"required": True}).status_code == 200
    states = chapter_tasks()
    assert states[objective]["completed"] and states[exam]["completed"] and states[exam2]["locked"] and states[optional]["locked"]
    assert client.get(paper_url + query, headers=student_h).json()["score"] == 0
    assert client.put(second_paper_url, headers=student_h, json=draft).status_code == 403
    resubmission = {**paper, "idempotency_key": "second-exam-attempt"}
    assert client.post(second_paper_url + "/submit", headers=student_h, json=resubmission).status_code == 403
    extra_path = f"/api/chapters/{chapter.id}/materials/{supplement.id}/participation" + query
    assert client.post(extra_path, headers=student_h, json={**beat, "page_id": 891}).status_code == 200
    monkeypatch.setattr("app.chapter_tasks.router.now", lambda: start + timedelta(seconds=4))
    assert client.post(extra_path, headers=student_h, json={**beat, "page_id": 891, "sequence": 2, "visible": False}).json()["completed"]
    restored = client.get(second_paper_url + query, headers=student_h)
    assert restored.json()["revision"] == saved.json()["revision"]
    assert restored.json()["answers"] == saved.json()["answers"]
    assert client.post(second_paper_url + "/submit", headers=student_h, json=resubmission).json()["completed"]
    assert not chapter_tasks()[optional]["completed"]
    assert client.get("/api/chapter-tasks" + query, headers=student_h).json()["chapters"][0]["completed"]

    # A second chapter may use this same document with an independent rule and evidence.
    second = chapters[1]
    other_material_path = f"{course_path}/chapters/{second.id}/material-tasks/{pdf.id}"
    assert client.put(other_material_path, headers=teacher_h, json={"required": True}).status_code == 200
    second_state = client.get("/api/chapter-tasks" + query, headers=student_h).json()["chapters"][1]
    assert len(second_state["tasks"]) == 1 and not second_state["completed"]
    second_beat = f"/api/chapters/{second.id}/materials/{pdf.id}/participation" + query
    assert client.post(second_beat, headers=student_h, json=beat).status_code == 200
    monkeypatch.setattr("app.chapter_tasks.router.now", lambda: start + timedelta(seconds=6))
    assert client.post(second_beat, headers=student_h, json={**beat, "visible": False, "sequence": 2}).json()["completed"]
    assert client.get("/api/chapter-tasks" + query, headers=student_h).json()["chapters"][1]["completed"]
    sibling = Classroom(course_id=course.id, name="另一个班", join_code="test-sibling")
    db.add(sibling)
    db.commit()
    assert client.get(f"/api/chapter-tasks?classroom_id={sibling.id}", headers=student_h).status_code == 403
    assert client.post(f"/api/chapters/{second.id}/materials/{pdf.id}/participation?classroom_id={sibling.id}",
                       headers=student_h, json=beat).status_code == 403


def test_material_order_is_atomic_and_local_to_chapter(client, db, teacher):
    course = CourseInstance(teacher_id=teacher["id"], name="排序测试", package_id="sort", package_version="1")
    db.add(course)
    db.flush()
    chapters = [Chapter(title=str(i), order_index=i, course_instance_id=course.id) for i in (1, 2)]
    materials = [Material(title=str(i), kind="pdf", course_instance_id=course.id,
                          content={"pages": [{"id": i, "page_no": 1}]}) for i in (1, 2, 3)]
    db.add_all(chapters + materials)
    db.commit()
    headers = teacher["headers"]
    paths = [f"/api/teacher/courses/{course.id}/chapters/{ch.id}/material-tasks" for ch in chapters]
    ids = [m.id for m in materials]
    for path in paths:
        for mid in ids:
            assert client.put(f"{path}/{mid}", headers=headers, json={"required": True, "rule": {"scope": "all"}}).is_success

    def reorder(previous, ordered):
        return client.put(paths[0] + "/order", headers=headers, json={"previous": previous, "ordered": ordered})

    reverse = ids[::-1]
    assert reorder(ids, reverse).is_success
    assert reorder(ids, reverse).is_success
    assert reorder(ids, ids).status_code == 409
    assert reorder(reverse, [ids[0]] * 3).status_code == 409
    for path, expected in zip(paths, [reverse, ids]):
        rows = client.get(path, headers=headers).json()["items"]
        assert [r["material_id"] for r in rows] == expected
        assert all(r["required"] and r["rule"] == {"scope": "all"} for r in rows)
