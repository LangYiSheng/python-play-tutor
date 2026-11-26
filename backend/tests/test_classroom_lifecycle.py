import pytest
from sqlalchemy import inspect, select, text

from app.auth import issue
from app.models import (
    Activity, AssessmentAttempt, Chapter, Classroom, MaterialParticipation, Membership,
    PracticeSession, Question, Submission, User,
)
from test_curriculum_migration import migrate, sqlite_engine


def staff(db, number, role):
    user = User(student_id=number, name=role, role=role, password_hash="unused")
    db.add(user)
    db.flush()
    return user, {"Authorization": "Bearer " + issue(db, user)["access_token"]}


def test_archive_delete_retains_evidence_and_account(client, db, teacher, student, classroom):
    class_id = classroom["id"]
    path = f"/api/teacher/classrooms/{class_id}"
    _, admin_headers = staff(db, "88810", "admin")
    _, other_headers = staff(db, "88811", "teacher")
    activity = db.scalar(select(Activity).where(Activity.kind == "assessment").limit(1))
    question = db.scalar(select(Question).limit(1))
    submission = Submission(user_id=student["id"], classroom_id=class_id, activity_id=activity.id,
                            question_id=question.id, idempotency_key="record", status="accepted")
    db.add(submission)
    db.flush()
    attempt = AssessmentAttempt(user_id=student["id"], classroom_id=class_id, activity_id=activity.id,
                                state="submitted", question_ids=[question.id], submission_ids={question.id: submission.id})
    record_key = (student["id"], class_id, 179, 186)
    record = MaterialParticipation(user_id=student["id"], classroom_id=class_id, chapter_id=179, material_id=186,
                                   evidence={"pages": [10723], "seconds": 4})
    db.add_all([record, attempt])
    db.commit()
    assert client.get("/api/teacher/classrooms/management", headers=teacher["headers"]).json()[0]["has_learning_records"]
    assert client.get("/api/teacher/classrooms/management", headers=other_headers).json() == []
    assert client.patch(path, json={"name": "无权限"}, headers=other_headers).status_code == 403
    assert client.patch(path, json={"name": "重命名"}, headers=teacher["headers"]).is_success
    assert client.patch(path, json={"name": " "}, headers=teacher["headers"]).status_code == 422
    assert client.delete(path, headers=teacher["headers"]).status_code == 403
    assert client.post(path + "/archive", headers=teacher["headers"]).is_success
    assert db.get(Membership, (student["id"], class_id)) is not None
    assert client.get("/api/classrooms", headers=student["headers"]).json() == []
    assert client.get(path + "/students", headers=admin_headers).status_code == 404
    assert client.post("/api/classrooms/join", json={"join_code": classroom["join_code"]}, headers=student["headers"]).status_code == 404
    assert client.post(path + "/town-session", headers=teacher["headers"]).status_code == 404
    assert client.get(f"/api/world?classroom_id={class_id}", headers=student["headers"]).status_code == 404
    assert client.delete(path, headers=admin_headers).is_success
    assert client.delete(path, headers=admin_headers).is_success
    assert db.get(Membership, (student["id"], class_id)) is None
    assert db.get(User, student["id"]) and db.get(MaterialParticipation, record_key)
    assert db.get(Submission, submission.id) and db.get(AssessmentAttempt, attempt.id)
    assert client.get("/api/teacher/classrooms/management", headers=admin_headers).json() == []
    tombstone = client.get("/api/teacher/classrooms/management?deleted=true", headers=teacher["headers"]).json()[0]
    assert tombstone["status"] == "deleted" and tombstone["student_count"] == 0 and "join_code" not in tombstone
    assert client.get(path + "/history", headers=other_headers).status_code == 403
    learner = client.get(path + "/history", headers=teacher["headers"]).json()["students"][0]
    assert learner["id"] == student["id"] and learner["records"] == 3
    detail = client.get(path + f"/history/{learner['id']}", headers=admin_headers).json()
    reading = next(item for item in detail["participation"] if item["kind"] == "reading")
    assert (reading["id"], reading["read_pages"], reading["read_seconds"]) == ("reading:179:186", 1, 4)
    assert detail["assessments"][0]["score"] == 100


def test_transfer_moves_content_and_revokes_old_preview(client, db, classroom, teacher, student):
    class_id = classroom["id"]
    path = f"/api/teacher/classrooms/{class_id}"
    _, admin_headers = staff(db, "88812", "admin")
    successor, new_headers = staff(db, "88813", "teacher")
    preview_token = client.post(path + "/town-session", headers=teacher["headers"]).json()["access_token"]
    course = db.get(Classroom, class_id).course
    chapter = db.scalar(select(Chapter).where(Chapter.course_instance_id == course.id).limit(1))
    chapter.owner_id = teacher["id"]
    db.commit()
    assert client.post(f"/api/teacher/courses/{course.id}/transfer", json={"teacher_id": successor.id}, headers=teacher["headers"]).status_code == 403
    assert client.post(f"/api/teacher/courses/{course.id}/transfer", json={"teacher_id": student["id"]}, headers=admin_headers).status_code == 422
    assert client.post(f"/api/teacher/courses/{course.id}/transfer", json={"teacher_id": successor.id}, headers=admin_headers).is_success
    assert chapter.owner_id == successor.id and db.get(Classroom, class_id).teacher_id == successor.id
    assert client.get(path + "/students", headers=teacher["headers"]).status_code == 403
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer " + preview_token}).status_code == 403
    assert client.get(path + "/students", headers=new_headers).is_success
    assert client.delete(path, headers=new_headers).is_success
    assert db.get(User, student["id"]) and db.get(Membership, (student["id"], class_id)) is None


def test_assigned_practice_without_submission_protects_class(client, db, classroom, teacher, student):
    class_id = classroom["id"]
    path = f"/api/teacher/classrooms/{class_id}"
    activity = db.scalar(select(Activity).where(Activity.kind == "practice").limit(1))
    db.add(PracticeSession(user_id=student["id"], classroom_id=class_id, activity_id=activity.id,
                           items=[{"question_id": "assigned", "status": "unanswered"}]))
    db.commit()
    headers = teacher["headers"]
    students = client.get(path + "/history", headers=headers).json()["students"]
    assert [(item["id"], item["records"]) for item in students] == [(student["id"], 1)]
    assert client.delete(path, headers=headers).status_code == 403


@pytest.mark.parametrize("previous_head", ["f6512e40a77d", "ab430d96c215"])
def test_previous_schema_upgrade_preserves_class(tmp_path, previous_head):
    path = tmp_path / "classroom.sqlite3"
    url = "sqlite:///" + path.as_posix()
    migrate(url, "upgrade", "e51b92fa60c3")
    engine = sqlite_engine(path)
    try:
        with engine.begin() as conn:
            conn.execute(text("INSERT INTO users (id, student_id, name, role, password_hash) VALUES (71,'0071','T','teacher','hash')"))
            conn.execute(text("INSERT INTO users (id, student_id, name, role, password_hash) VALUES (72,'0072','A','admin','hash')"))
            conn.execute(text("INSERT INTO classrooms (id, name, teacher_id, join_code) VALUES (42, 'test', 71, 'join')"))
            conn.execute(text("""INSERT INTO course_instances (id, classroom_id, package_id, name, package_version, created_at)
                                 VALUES (50,42,'sample','sample','1',CURRENT_TIMESTAMP)"""))
            conn.execute(text("""INSERT INTO chapters (id, title, order_index, course_id, owner_id, course_instance_id)
                                 VALUES (90,'class chapter',1,43,72,50), (91,'source',1,43,72,NULL)"""))
        migrate(url, "upgrade", previous_head)
        migrate(url, "upgrade", "head")
        with engine.connect() as conn:
            assert inspect(conn).has_table("practice_sessions")
            assert conn.execute(text("SELECT COUNT(*) FROM alembic_version")).scalar_one() == 1
            assert conn.execute(text("SELECT r.status, c.teacher_id FROM classrooms r JOIN course_instances c ON c.id=r.course_id WHERE r.id=42")).one() == ("active", 71)
            assert conn.execute(text("SELECT id,owner_id FROM chapters ORDER BY id")).all() == [(90, 71), (91, 72)]
    finally:
        engine.dispose()
