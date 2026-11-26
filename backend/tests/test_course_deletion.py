import pytest
from conftest import make_student_account
from sqlalchemy import select, text

from app.integration_models import AssistantCall, AssistantSession, SubmissionDiagnostic
from app.lectio.models import LectioExam, LectioJob
from app.models import (
    Activity, AssessmentAttempt, Chapter, Classroom, CourseInstance, ExperienceCheckpoint,
    Material, MaterialChapter, MaterialParticipation, Membership, PlayerPosition, Question,
    QuestionSecret, Submission, TownPreviewStudent, User,
)
from test_curriculum import another_teacher


def create_course(client, headers):
    response = client.post("/api/teacher/courses", headers=headers, json={"name": "待删除测试课程"})
    assert response.status_code == 201, response.text
    return response.json()


def delete_params(preview):
    return {"expected_revision": preview["revision"], "confirmation": preview["confirmation"]}


def add_classroom(client, headers, course_id, name):
    response = client.post(f"/api/teacher/courses/{course_id}/classrooms", headers=headers, json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["id"]


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
        "students": 0, "reading_records": 0, "submissions": 0, "assessment_attempts": 0,
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


def test_owner_can_delete_roster_and_dedicated_teacher_preview(client, db, teacher, student):
    db.commit()
    db.execute(text("PRAGMA foreign_keys=ON"))
    headers = teacher["headers"]
    course_id = create_course(client, headers)["id"]
    path = f"/api/teacher/courses/{course_id}"
    classroom_id = add_classroom(client, headers, course_id, "有名册、尚无学习记录")
    response = client.post(f"/api/teacher/classrooms/{classroom_id}/town-session", headers=headers)
    assert response.status_code == 200, response.text
    demo_id = response.json()["user"]["id"]
    demo_headers = {"Authorization": "Bearer " + response.json()["access_token"]}
    db.add_all([
        Membership(user_id=student["id"], classroom_id=classroom_id),
        PlayerPosition(user_id=demo_id, classroom_id=classroom_id),
    ])
    db.commit()
    preview = client.get(path + "/deletion-preview", headers=headers).json()
    assert preview["can_delete"] and preview["counts"]["classrooms"] == 1 and preview["counts"]["students"] == 1
    assert client.delete(path, headers=headers, params=delete_params(preview)).status_code == 204
    db.expire_all()
    assert db.get(User, teacher["id"]) and db.get(User, student["id"])
    assert client.get("/api/auth/me", headers=student["headers"]).status_code == 200
    assert db.get(User, demo_id) is None and db.get(TownPreviewStudent, demo_id) is None
    assert client.get("/api/auth/me", headers=demo_headers).status_code == 401
    assert db.get(Membership, (student["id"], classroom_id)) is None
    assert db.get(Classroom, classroom_id) is None
    assert not db.execute(text("PRAGMA foreign_key_check")).all()


@pytest.mark.parametrize("actor_role", ["owner", "admin"])
def test_cascade_active_archived_and_deleted_classes_without_touching_other_courses(
    client, db, teacher, student, classroom, admin_account, actor_role,
):
    db.commit()
    db.execute(text("PRAGMA foreign_keys=ON"))
    owner = teacher["headers"]
    admin = admin_account["headers"]
    actor = owner if actor_role == "owner" else admin
    user_id = student["id"]
    historical_student = make_student_account(db, "7654321", "历史班学生")
    historical_id = historical_student["id"]
    course_id = create_course(client, owner)["id"]
    path = f"/api/teacher/courses/{course_id}"
    active_id, archived_id, deleted_id = [add_classroom(client, owner, course_id, name) for name in ("在教班", "归档班", "历史班")]
    assert client.post(f"/api/teacher/classrooms/{archived_id}/archive", headers=owner).status_code == 200

    chapter = Chapter(course_instance_id=course_id, stable_id="cascade-chapter", title="待删除章节", order_index=1)
    material = Material(course_instance_id=course_id, stable_id="cascade-notes", title="待删除资料")
    db.add_all([chapter, material])
    db.flush()
    chapter_id, material_id = chapter.id, material.id
    activity_id, question_id = "cascade-assessment", "cascade-question"
    db.add_all([
        MaterialChapter(chapter_id=chapter_id, material_id=material_id),
        Activity(id=activity_id, course_instance_id=course_id, chapter_id=chapter_id, title="待删除测验", kind="assessment"),
        Question(id=question_id, course_instance_id=course_id, title="待删除题目", prompt="请判断", kind="boolean"),
        Membership(user_id=user_id, classroom_id=active_id),
    ])
    db.flush()
    assessment = AssessmentAttempt(user_id=historical_id, classroom_id=deleted_id, activity_id=activity_id, state="submitted")
    submission = Submission(user_id=historical_id, classroom_id=deleted_id, activity_id=activity_id, question_id=question_id,
                            idempotency_key="cascade-submission", status="accepted")
    assistant = AssistantSession(user_id=historical_id, classroom_id=deleted_id, material_id=material_id)
    checkpoint = ExperienceCheckpoint(user_id=historical_id, classroom_id=archived_id, name="待清理存档", definition_hash="0" * 64, snapshot={})
    db.add_all([
        assessment, submission, assistant, checkpoint,
        MaterialParticipation(user_id=historical_id, classroom_id=deleted_id, chapter_id=chapter_id, material_id=material_id),
        PlayerPosition(user_id=historical_id, classroom_id=deleted_id),
        PlayerPosition(user_id=user_id, classroom_id=classroom["id"], tile_x=7),
    ])
    db.flush()
    call = AssistantCall(user_id=historical_id, classroom_id=deleted_id, session_id=assistant.id, status="complete")
    db.add_all([call, SubmissionDiagnostic(submission_id=submission.id)])
    db.commit()
    assert client.delete(f"/api/teacher/classrooms/{deleted_id}", headers=owner).status_code == 403
    assert client.delete(f"/api/teacher/classrooms/{deleted_id}", headers=admin).status_code == 200
    removed_rows = [
        (AssessmentAttempt, assessment.id), (Submission, submission.id), (SubmissionDiagnostic, submission.id),
        (AssistantSession, assistant.id), (AssistantCall, call.id), (ExperienceCheckpoint, checkpoint.id),
        (MaterialParticipation, (historical_id, deleted_id, chapter_id, material_id)), (PlayerPosition, (historical_id, deleted_id)),
        (Membership, (user_id, active_id)), (Material, material_id), (Chapter, chapter_id),
        (Activity, activity_id), (Question, question_id),
        (Classroom, active_id), (Classroom, archived_id), (Classroom, deleted_id),
    ]

    preview = client.get(path + "/deletion-preview", headers=actor).json()
    assert preview["can_delete"]
    assert {key: preview["counts"][key] for key in (
        "classrooms", "students", "reading_records", "submissions", "assessment_attempts",
    )} == {"classrooms": 3, "students": 2, "reading_records": 1, "submissions": 1, "assessment_attempts": 1}
    non_owner = another_teacher(db)
    assert client.delete(path, headers=non_owner["headers"], params=delete_params(preview)).status_code == 403
    assert client.delete(path, headers=student["headers"], params=delete_params(preview)).status_code == 403
    assert client.delete(path, headers=actor, params=delete_params(preview)).status_code == 204
    db.expire_all()
    assert db.get(CourseInstance, course_id) is None
    for model, key in removed_rows:
        assert db.get(model, key) is None, model.__name__
    assert db.get(CourseInstance, classroom["course_id"])
    assert db.get(Membership, (user_id, classroom["id"]))
    assert db.get(PlayerPosition, (user_id, classroom["id"])).tile_x == 7
    assert client.get("/api/auth/me", headers=student["headers"]).status_code == 200
    assert client.get("/api/auth/me", headers=historical_student["headers"]).status_code == 200
    assert client.get("/api/auth/me", headers=owner).status_code == 200
    assert not db.execute(text("PRAGMA foreign_key_check")).all()


def test_delete_rechecks_classroom_impact_after_preview(client, db, teacher):
    headers = teacher["headers"]
    course_id = create_course(client, headers)["id"]
    path = f"/api/teacher/courses/{course_id}"
    preview = client.get(path + "/deletion-preview", headers=headers).json()
    assert preview["can_delete"]
    classroom_id = add_classroom(client, headers, course_id, "刚开设的班级")
    assert client.delete(path, headers=headers, params=delete_params(preview)).status_code == 409
    assert db.get(CourseInstance, course_id)
    fresh_preview = client.get(path + "/deletion-preview", headers=headers).json()
    assert fresh_preview["can_delete"] and fresh_preview["counts"]["classrooms"] == 1
    assert client.delete(path, headers=headers, params=delete_params(fresh_preview)).status_code == 204
    assert db.get(Classroom, classroom_id) is None


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
