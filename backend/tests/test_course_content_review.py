from app.models import CourseInstance
from app.narration import repository
from conftest import make_material


def drafts(client, db, classroom, teacher):
    cid, headers = classroom["id"], teacher["headers"]
    material = make_material(db, title="来源课件", kind="presentation", owner_id=teacher["id"],
                             content={"pages": [{"page_no": 1, "text": "原始资料"}]}, chapter_ids=[179])
    narration = repository.upsert(db, material, 1, text="原始讲稿", target_seconds=100)
    db.commit()
    response = client.post(f"/api/teacher/questions?classroom_id={cid}", headers=headers, json={
        "id": "review-question", "title": "待审练习", "kind": "fill", "prompt": "草稿", "answer": "Python",
        "chapter_ids": [179], "source": {"material_id": material.id, "page_no": 1}})
    assert response.status_code == 201, response.text
    return f"/api/teacher/classrooms/{cid}/content-review", material, narration, response.json()["id"]


def test_review_filtered_queue_and_transactional_decision(client, db, classroom, teacher, student):
    base, material, narration, question_id = drafts(client, db, classroom, teacher)
    headers = teacher["headers"]
    rows = client.get(base, headers=headers).json()["items"]
    selected = [r for r in rows if (r["kind"], r["id"]) in {("narration", str(narration.id)), ("question", question_id)}]
    assert len(selected) == 2
    assert next(r for r in selected if r["kind"] == "question")["material_title"] == material.title
    assert all(row["kind"] == "question" for row in client.get(base + "?kind=question&size=1", headers=headers).json()["items"])
    assert client.get(base, headers=student["headers"]).status_code == 403
    # An item changed after selection. The rest of the selection must not be accepted.
    stale = [dict(r, revision="old") if r["kind"] == "question" else r for r in selected]
    assert client.post(base + "/decisions", json={"decision": "accept", "items": stale}, headers=headers).status_code == 409
    assert db.get(type(narration), narration.id).status == "draft"
    result = client.post(base + "/decisions", json={"decision": "accept", "items": selected}, headers=headers)
    assert result.status_code == 200, result.text
    assert result.json()["count"] == 2
    assert db.get(type(narration), narration.id).status == "accepted"
    assert client.post(base + "/decisions", json={"decision": "accept", "items": selected}, headers=headers).status_code == 409


def test_edit_and_accept_narration_reject_question_and_class_isolation(client, db, classroom, teacher):
    base, material, narration, question_id = drafts(client, db, classroom, teacher)
    headers = teacher["headers"]
    second = client.post("/api/classrooms", json={"name": "隔离班级"}, headers=headers).json()["id"]
    db.add(CourseInstance(classroom_id=second, package_id="empty-course", name="空课程", package_version="1"))
    db.commit()
    other = f"/api/teacher/classrooms/{second}/content-review"
    assert client.get(other, headers=headers).json()["total"] == 0
    rows = client.get(base, headers=headers).json()["items"]
    narr = next(r for r in rows if r["kind"] == "narration" and r["id"] == str(narration.id))
    assert client.post(other + "/decisions", json={"decision": "accept", "items": [narr]}, headers=headers).status_code == 409
    detail = client.get(base + "/narrations/" + narr["id"], headers=headers).json()
    assert detail["raw_text"] == "原始资料"
    assert client.post(base + "/decisions", json={"decision": "accept", "items": [narr], "text": "已核对的新讲稿"}, headers=headers).status_code == 200
    assert repository.row(db, material.id, 1).text == "已核对的新讲稿"
    question = next(r for r in client.get(base + "?kind=question", headers=headers).json()["items"] if r["id"] == question_id)
    assert client.post(base + "/decisions", json={"decision": "reject", "items": [question]}, headers=headers).status_code == 200
    saved = client.get(f"/api/teacher/questions/{question_id}?classroom_id={classroom['id']}", headers=headers).json()
    assert saved["status"] == "disabled"


def test_queue_refuses_unusable_questions_and_changed_sources(client, db, classroom, teacher):
    base, material, narration, question_id = drafts(client, db, classroom, teacher)
    headers = teacher["headers"]
    path = f"/api/teacher/questions/{question_id}?classroom_id={classroom['id']}"
    assert client.put(path, headers=headers, json={"chapter_ids": []}).status_code == 200
    rows = client.get(base, headers=headers).json()["items"]
    selected = [r for r in rows if (r["kind"], r["id"]) in {("narration", str(narration.id)), ("question", question_id)}]
    result = client.post(base + "/decisions", json={"decision": "accept", "items": selected}, headers=headers)
    assert result.status_code == 422
    assert narration.status == "draft" and client.get(path, headers=headers).json()["status"] == "draft"
    material.content = {"pages": [{"page_no": 1, "text": "新版本原文"}]}
    db.commit()
    row = next(r for r in selected if r["kind"] == "narration")
    assert client.get(base + "/narrations/" + row["id"], headers=headers).json()["source_changed"] is True
    assert client.post(base + "/decisions", json={"decision": "accept", "items": [row]}, headers=headers).status_code == 409
