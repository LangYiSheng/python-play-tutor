from copy import deepcopy

import pytest
from sqlalchemy import select

from app.course_content.snapshot import snapshot_content
from app.course_packages.apply import import_bundle
from app.course_packages.impact import preview_impact
from app.course_packages.reader import load_bundle
from app.course_packages.writer import write_package
from app.models import Activity, Classroom, CourseInstance, KnowledgePoint, PracticeSession
from app.practice_rules import allocate_initial


def test_matching_can_reassign_shared_questions_and_overlap_minima_with_total():
    rules = {"goals": [{"knowledge_point_id": i, "total": n, "by_kind": minima}
                       for i, n, minima in [(1, 2, {"python": 1}), (2, 1, {}), (3, 1, {})]]}
    pool = {1: {"a": "python", "b": "python", "c": "fill"}, 2: {"a": "python", "d": "fill"}, 3: {"b": "python", "d": "fill"}}
    for _ in range(20):
        result = allocate_initial(rules, pool)
        assert "a" in result[1] or "b" in result[1]
        assert [len(group) for group in result.values()] == [2, 1, 1]
        assert {q for group in result.values() for q in group} == {"a", "b", "c", "d"}
    pool[2].pop("d")
    pool[3].pop("d")
    with pytest.raises(ValueError, match="去重"):
        allocate_initial(rules, pool)


def test_rule_draft_publication_deletion_protection_and_package_roundtrip(client, classroom, teacher, student, db, tmp_path):
    scope = f"?classroom_id={classroom['id']}"
    headers = teacher["headers"]
    base = "/api/teacher/activities"
    point = client.post("/api/teacher/knowledge-points" + scope, headers=headers,
                        json={"chapter_id": 179, "title": "专用抽题目标"}).json()["id"]
    rules = {"goals": [{"knowledge_point_id": point, "by_kind": {"boolean": 1}}]}
    body = {"id": "adaptive", "chapter_id": 179, "title": "知识点练习", "kind": "practice", "practice_rules": rules}
    assert client.post(base + scope, headers=headers, json=body).status_code == 422
    assert client.post(base + scope, headers=headers, json={**body, "chapter_id": 180, "published": False}).status_code == 422
    draft = client.post(base + scope, headers=headers, json={**body, "published": False})
    assert draft.status_code == 201, draft.text
    activity_id = draft.json()["id"]
    assert client.get(f"/api/activities/{activity_id}" + scope, headers=student["headers"]).status_code == 403
    edit = base + "/" + activity_id
    assert client.put(edit + scope, headers=headers, json={"published": True}).status_code == 422
    assert client.put(edit + "/questions" + scope, headers=headers, json={"question_ids": []}).status_code == 422
    question = client.post("/api/teacher/questions" + scope, headers=headers, json={
        "id": "adaptive-only", "title": "判断", "prompt": "测试", "answer": True, "kind": "boolean",
        "chapter_ids": [179], "knowledge_point_ids": [point], "status": "ready"})
    assert question.status_code == 201, question.text
    question_id = question.json()["id"]
    assert client.put(edit + scope, headers=headers, json={"practice_rules": rules, "published": True}).status_code == 200
    assert client.put("/api/teacher/questions/" + question_id + scope, headers=headers, json={"status": "disabled"}).status_code == 409

    instance = db.scalar(select(CourseInstance).where(CourseInstance.classroom_id == classroom["id"]))
    data = snapshot_content(db, instance)[0]
    portable = next(row for row in data["activity"] if row["id"] == "adaptive")
    stable_point = db.get(KnowledgePoint, point).stable_id
    assert portable["content"]["practice_rules"]["goals"][0]["knowledge_point_id"] == stable_point
    write_package(db, instance, tmp_path)
    bundle = load_bundle(tmp_path)
    new_class = client.post("/api/classrooms", headers=headers, json={"name": "导入练习"}).json()
    copied = import_bundle(db, db.get(Classroom, new_class["id"]), None, bundle, tmp_path)
    imported = db.scalar(select(Activity).where(Activity.course_instance_id == copied.id, Activity.stable_id == "adaptive"))
    mapped = db.scalar(select(KnowledgePoint).where(KnowledgePoint.course_instance_id == copied.id, KnowledgePoint.stable_id == stable_point))
    assert imported.content["practice_rules"]["goals"][0]["knowledge_point_id"] == mapped.id != point
    db.commit()

    db.add(PracticeSession(user_id=student["id"], classroom_id=classroom["id"], activity_id=activity_id,
                           items=[{"question_id": question_id, "kind": "boolean", "knowledge_point_id": point}]))
    db.commit()
    assert client.put(edit + scope, headers=headers, json={"practice_rules": {**rules, "retry_interval": 2}}).status_code == 409
    changed = deepcopy(bundle)
    next(row for row in changed["data"]["activity"] if row["id"] == "adaptive")["content"]["practice_rules"]["retry_interval"] = 2
    assert any("练习目标" in message for message in preview_impact(db, instance, changed)["blockers"])


def test_hidden_only_python_reserved_for_assessments(client, classroom, teacher, student, db, tmp_path):
    from app.course_packages.manifest import PackageError
    from app.course_packages.validation import validate_bundle
    from app.practice_rules import candidate_pool

    scope = f"?classroom_id={classroom['id']}"
    headers = teacher["headers"]
    point = client.post("/api/teacher/knowledge-points" + scope, headers=headers,
                        json={"chapter_id": 179, "title": "编程目标题池"}).json()["id"]
    case = {"input": "1", "output": "1"}
    definition = {"id": "hidden-only", "title": "编程", "prompt": "回显", "kind": "python",
                  "chapter_ids": [179], "knowledge_point_ids": [point], "status": "ready", "hidden_cases": [case]}
    question = client.post("/api/teacher/questions" + scope, headers=headers, json=definition)
    assert question.status_code == 201, question.text
    question_id = question.json()["id"]
    edit_question = "/api/teacher/questions/" + question_id + scope
    activity_url = "/api/teacher/activities"
    assessment = client.post(activity_url + scope, headers=headers,
                             json={"id": "server-exam", "chapter_id": 179, "title": "测验", "kind": "assessment"}).json()["id"]
    assert client.put(f"{activity_url}/{assessment}/questions" + scope, headers=headers, json={"question_ids": [question_id]}).status_code == 200
    rules = {"goals": [{"knowledge_point_id": point, "by_kind": {"python": 1}}]}
    body = {"id": "browser-adaptive", "chapter_id": 179, "title": "浏览器练习", "kind": "practice", "practice_rules": rules}
    assert client.post(activity_url + scope, headers=headers, json=body).status_code == 422
    assert client.put(edit_question, headers=headers, json={"samples": [case]}).status_code == 200
    created = client.post(activity_url + scope, headers=headers, json=body)
    assert created.status_code == 201, created.text
    activity_id = created.json()["id"]
    assert client.put(edit_question, headers=headers, json={"samples": []}).status_code == 409

    instance = db.get(CourseInstance, db.get(Activity, activity_id).course_instance_id)
    write_package(db, instance, tmp_path)
    bundle = load_bundle(tmp_path)
    changed = deepcopy(bundle)
    next(row for row in changed["data"]["question"] if row["id"] == "hidden-only")["samples"] = []
    with pytest.raises(PackageError, match="编程"):
        validate_bundle(changed, tmp_path)

    second = client.post("/api/teacher/questions" + scope, headers=headers, json={**definition, "id": "second", "samples": [case]})
    assert second.status_code == 201, second.text
    db.add(PracticeSession(user_id=student["id"], classroom_id=classroom["id"], activity_id=activity_id,
                           items=[{"question_id": question_id, "kind": "python", "knowledge_point_id": point}]))
    db.commit()
    assert "公开样例" in client.put(edit_question, headers=headers, json={"samples": []}).json()["detail"]
    assert any("公开样例" in message for message in preview_impact(db, instance, changed)["blockers"])
    other = client.put("/api/teacher/questions/" + second.json()["id"] + scope, headers=headers, json={"samples": []})
    assert other.status_code == 200, other.text
    assert set(candidate_pool(db, db.get(Activity, activity_id))[point]) == {question_id}
