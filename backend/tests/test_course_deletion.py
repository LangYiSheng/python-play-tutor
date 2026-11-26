from sqlalchemy import select, text

from app.lectio.models import LectioExam, LectioJob
from app.models import Activity, Chapter, CourseInstance, Material, MaterialChapter, Question, QuestionSecret, User
from test_curriculum import another_teacher


def create_course(client, headers):
    response = client.post("/api/teacher/courses", headers=headers, json={"name": "待删除测试课程"})
    assert response.status_code == 201, response.text
    return response.json()


def delete_params(preview):
    return {"expected_revision": preview["revision"], "confirmation": preview["confirmation"]}


def test_owner_can_delete_course_content_after_current_preview(client, db, teacher, student):
    db.commit()
    db.execute(text("PRAGMA foreign_keys=ON"))
    headers = teacher["headers"]
    course_id = create_course(client, headers)["id"]
    other = another_teacher(db)
    retained_id = create_course(client, other["headers"])["id"]
    path = f"/api/teacher/courses/{course_id}"
    assert client.get(path + "/deletion-preview", headers=other["headers"]).status_code == 403
    before = client.get(path + "/deletion-preview", headers=headers).json()
    assert client.delete(path, headers=student["headers"], params=delete_params(before)).status_code == 403
    assert client.delete(path, headers=headers, params={"expected_revision": before["revision"]}).status_code == 422
    chapter = client.post(path + "/chapters", headers=headers, json={"title": "未授课章节"})
    assert chapter.status_code == 201, chapter.text
    chapter_id = chapter.json()["id"]
    material = Material(course_instance_id=course_id, stable_id="draft-material", title="旧资料")
    db.add(material)
    db.flush()
    material_id = material.id
    db.add(MaterialChapter(material_id=material_id, chapter_id=chapter_id))
    db.commit()
    question = client.post(path + "/questions", headers=headers, json={
        "id": "draft-question", "kind": "boolean", "title": "草稿题", "prompt": "请判断", "status": "ready",
        "chapter_ids": [chapter_id], "answer": True,
    })
    assert question.status_code == 201, question.text
    question_id = question.json()["id"]
    activity = client.post(path + "/activities", headers=headers, json={
        "id": "draft-practice", "title": "未发布练习", "chapter_id": chapter_id, "kind": "practice",
        "question_ids": [question_id], "published": False,
    })
    assert activity.status_code == 201, activity.text
    activity_id = activity.json()["id"]
    exam = LectioExam(course_instance_id=course_id, stable_id="draft-exam", title="组卷草稿")
    db.add(exam)
    db.commit()
    exam_id = exam.id
    assert client.delete(path, headers=headers, params=delete_params(before)).status_code == 409
    preview = client.get(path + "/deletion-preview", headers=headers).json()
    assert preview["can_delete"] and preview["blocked_reason"] is None
    assert preview["counts"] == {
        "classrooms": 0, "chapters": 1, "materials": 1, "knowledge_points": 0,
        "questions": 1, "activities": 1, "exam_drafts": 1,
    }
    assert client.delete(path, headers=headers, params=delete_params(preview)).status_code == 204
    assert client.get(path, headers=headers).status_code == 404
    assert db.get(User, teacher["id"]) and db.get(CourseInstance, retained_id)
    assert all(db.get(model, key) is None for model, key in (
        (Chapter, chapter_id), (Material, material_id), (Question, question_id), (QuestionSecret, question_id), (Activity, activity_id),
    ))
    assert not db.execute(text("PRAGMA foreign_key_check")).all()
    db.expire_all()
    assert db.scalar(select(LectioExam.id).where(LectioExam.id == exam_id)) is None


def test_course_delete_rechecks_active_lectio_job(client, db, teacher):
    headers = teacher["headers"]
    course_id = create_course(client, headers)["id"]
    path = f"/api/teacher/courses/{course_id}"
    preview = client.get(path + "/deletion-preview", headers=headers).json()
    assert preview["can_delete"]
    db.add(LectioJob(course_instance_id=course_id, kind="exercise_generate", scope_key="course", status="queued"))
    db.commit()
    blocked = client.get(path + "/deletion-preview", headers=headers).json()
    assert not blocked["can_delete"] and "备课任务" in blocked["blocked_reason"]
    assert client.delete(path, headers=headers, params=delete_params(preview)).status_code == 409


def test_classroom_history_blocks_delete_even_after_the_class_is_deleted(client, db, teacher, classroom, admin_account):
    course_id = classroom["course_id"]
    path = f"/api/teacher/courses/{course_id}"
    headers = admin_account["headers"]
    for state in ("active", "archived", "deleted"):
        if state == "archived":
            assert client.post(f"/api/teacher/classrooms/{classroom['id']}/archive", headers=teacher["headers"]).status_code == 200
        if state == "deleted":
            assert client.delete(f"/api/teacher/classrooms/{classroom['id']}", headers=headers).status_code == 200
        preview = client.get(path + "/deletion-preview", headers=headers).json()
        assert not preview["can_delete"] and preview["counts"]["classrooms"] == 1
        assert client.delete(path, headers=headers, params=delete_params(preview)).status_code == 409
    assert db.get(CourseInstance, course_id)


def test_delete_rechecks_blockers_created_after_preview(client, db, teacher):
    headers = teacher["headers"]
    course_id = create_course(client, headers)["id"]
    path = f"/api/teacher/courses/{course_id}"
    preview = client.get(path + "/deletion-preview", headers=headers).json()
    assert preview["can_delete"]
    response = client.post(path + "/classrooms", headers=headers, json={"name": "刚开设的班级"})
    assert response.status_code == 201, response.text
    assert client.delete(path, headers=headers, params=delete_params(preview)).status_code == 409
    assert db.get(CourseInstance, course_id)


def test_delete_preserves_legacy_links_to_other_courses(client, db, teacher):
    headers = teacher["headers"]
    course_id = create_course(client, headers)["id"]
    path = f"/api/teacher/courses/{course_id}"
    chapter = client.post(path + "/chapters", headers=headers, json={"title": "被引用章节"}).json()
    retained_id = create_course(client, headers)["id"]
    db.add(Chapter(course_instance_id=retained_id, title="旧前置链接", order_index=1, prerequisite_chapter_id=chapter["id"]))
    db.commit()
    preview = client.get(path + "/deletion-preview", headers=headers).json()
    assert not preview["can_delete"] and "其他课程" in preview["blocked_reason"]
    assert client.delete(path, headers=headers, params=delete_params(preview)).status_code == 409
    retained = db.scalar(select(Chapter).where(Chapter.course_instance_id == retained_id))
    assert retained.prerequisite_chapter_id == chapter["id"]


def test_retry_cannot_delete_a_replacement_course_with_the_same_sqlite_id(client, teacher):
    headers = teacher["headers"]
    course_id = create_course(client, headers)["id"]
    path = f"/api/teacher/courses/{course_id}"
    preview = client.get(path + "/deletion-preview", headers=headers).json()
    assert client.delete(path, headers=headers, params=delete_params(preview)).status_code == 204
    replacement = create_course(client, headers)
    assert (replacement["id"], replacement["revision"]) == (course_id, preview["revision"])
    assert client.delete(path, headers=headers, params=delete_params(preview)).status_code == 409
    assert client.get(path, headers=headers).status_code == 200
