"""Course authoring, parallel-class isolation and automatic upgrades."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import os
from threading import Barrier

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import Session

from app.auth import issue
from app.classrooms.contracts import JoinInput
from app.classrooms.service import join_classroom
from app.models import (Activity, MaterialParticipation, AssessmentAttempt, Classroom, CourseInstance, Membership,
                        Submission, User)
from test_curriculum_migration import migrate


def test_two_classes_share_content_and_keep_evidence(client, db, teacher, classroom, student, admin_account, monkeypatch):
    headers = teacher["headers"]
    base = f"/api/teacher/courses/{classroom['course_id']}"
    afternoon = classroom["id"]
    evening = client.post(base + "/classrooms", headers=headers, json={"name": "晚班"}).json()
    assert evening["id"] != evening["course_id"]
    add = [User(student_id=str(80000000 + i), name=f"学生{i}", role="student", password_hash="unused") for i in range(199)]
    db.add_all(add)
    db.flush()
    db.add_all([Membership(user_id=s.id, classroom_id=afternoon if i < 99 else evening["id"]) for i, s in enumerate(add)])
    db.commit()
    late = {"Authorization": "Bearer " + issue(db, add[-1])["access_token"]}
    assert client.post("/api/classrooms/join", headers=student["headers"], json={"join_code": evening["join_code"]}).status_code == 409
    assert client.post(f"/api/teacher/classrooms/{evening['id']}/students", headers=headers,
                       json={"students": [{"name": "学生", "student_id": student["student_id"]}]}).status_code == 422
    before = db.get(CourseInstance, evening["course_id"]).revision
    clock = datetime(2026, 11, 24, 14, tzinfo=timezone(timedelta(hours=8)))
    class TestClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock.astimezone(tz)
    monkeypatch.setattr("app.course_content.access.datetime", TestClock)
    for cid, date in ((afternoon, clock), (evening["id"], clock + timedelta(hours=5))):
        assert client.put(f"/api/teacher/classrooms/{cid}/releases/179", headers=headers,
                          json={"status": "published", "opens_at": date.isoformat()}).status_code == 200
    assert db.get(CourseInstance, evening["course_id"]).revision == before
    assert client.get(f"/api/materials/186?classroom_id={afternoon}", headers=student["headers"]).status_code == 200
    assert client.get(f"/api/materials/186?classroom_id={evening['id']}", headers=late).status_code == 403
    db.add(MaterialParticipation(user_id=student["id"], classroom_id=afternoon, chapter_id=179, material_id=186, evidence={"pages": [1]}))
    paper = Activity(id="shared-exam", stable_id="exam", course_instance_id=evening["course_id"], chapter_id=179,
                     kind="assessment", title="测验", content={})
    db.add(paper)
    db.flush()
    from app.models import Question
    from app.content_relations import activity_questions, set_activity_questions
    practice = db.get(Activity, "ch1-practice")
    question = activity_questions(db, practice)[0]
    question.owner_id = teacher["id"]
    set_activity_questions(db, paper.id, [question.id])
    sub = Submission(user_id=student["id"], classroom_id=afternoon, activity_id=paper.id, question_id=question.id,
                     mode="submit", status="wrong_answer", idempotency_key="grade", feedback={})
    db.add(sub)
    db.flush()
    db.add(AssessmentAttempt(user_id=student["id"], classroom_id=afternoon, activity_id=paper.id, state="submitted",
                             question_ids=[question.id], submission_ids={question.id: sub.id}, answers={}))
    from app.integration_models import AssistantSession
    db.add_all([
        AssistantSession(user_id=student["id"], classroom_id=afternoon, material_id=186,
                         messages=[{"role": "user", "content": "问题"}, {"role": "assistant", "content": "回答"}]),
        AssistantSession(user_id=add[-1].id, classroom_id=evening["id"], activity_id=practice.id,
                         messages=[{"role": "user", "content": "一道练习题"}]),
        AssistantSession(user_id=add[0].id, classroom_id=afternoon, messages=[]),
        Submission(user_id=student["id"], classroom_id=afternoon, activity_id=practice.id, question_id=question.id,
                   mode="submit", status="accepted", idempotency_key="practice", feedback={}),
    ])
    db.commit()
    clock += timedelta(hours=5)
    changed = client.put(base + "/questions/" + question.id, headers=headers, json={"title": "两个班共享的新题目"})
    assert changed.status_code == 200, changed.text
    for cid, auth in ((afternoon, student["headers"]), (evening["id"], late)):
        content = client.get(f"/api/activities/{paper.id}?classroom_id={cid}", headers=auth)
        assert content.status_code == 200 and "两个班共享的新题目" in content.text
    graph = client.get(base + "/insights", headers=headers).json()
    assert graph["totals"]["students"] == 200 and graph["totals"]["classrooms"] == 2
    assert graph["usage"]["learning"] == graph["usage"]["assessment"] == 1
    assert graph["totals"]["questions"] == db.scalar(sa.select(sa.func.count(Question.id)).where(Question.course_instance_id == evening["course_id"]))
    assert graph["usage"]["practice"] == 1
    assert graph["assistant"] == {"learning": {"sessions": 1, "messages": 2}, "practice": {"sessions": 1, "messages": 1}}
    for cid in (afternoon, evening["id"]):
        details = client.get(f"/api/teacher/classrooms/{cid}/activity-report", headers=headers).json()
        practice_results = next(a for a in details["activities"] if a["id"] == practice.id)["results"]
        assert (str(student["id"]) in practice_results) == (cid == afternoon)
        data = client.get(f"/api/teacher/classrooms/{cid}/activity-report?grades=true", headers=headers).json()
        assert len(data["students"]) == 100
        results = next(a["results"] for a in data["activities"] if a["id"] == paper.id)
        if cid == afternoon:
            assert results[str(student["id"])]["score"] == 0
        else:
            assert results == {}
    removal = client.delete(f"/api/teacher/classrooms/{afternoon}/members/{student['id']}", headers=headers)
    assert removal.status_code == 200
    assert client.post("/api/classrooms/join", headers=student["headers"], json={"join_code": evening["join_code"]}).status_code == 200
    history = client.get(f"/api/teacher/classrooms/{afternoon}/activity-report?grades=true", headers=headers).json()
    assert next(s for s in history["students"] if s["id"] == student["id"])["enrolled"] is False
    assert next(a for a in history["activities"] if a["id"] == paper.id)["results"][str(student["id"])]["score"] == 0
    # Preview identities and archives cannot inflate the formal roster.
    assert client.post(f"/api/teacher/classrooms/{evening['id']}/town-session", headers=headers).status_code == 200
    assert client.get(base + "/insights", headers=headers).json()["totals"]["students"] == 200
    assert client.post(f"/api/teacher/classrooms/{evening['id']}/archive", headers=headers).status_code == 200
    assert client.get(base + "/insights", headers=headers).json()["totals"]["students"] == 99
    assert client.post(base + "/transfer", headers=admin_account["headers"], json={"teacher_id": admin_account["id"]}).status_code == 200
    assert client.get(base + "/catalog", headers=headers).status_code == 403
    assert client.get(base + "/catalog", headers=student["headers"]).status_code == 403


@pytest.mark.parametrize("engine_kind", ["sqlite", "postgresql"])
def test_upgrade_and_competing_enrollment(tmp_path, engine_kind):
    if engine_kind == "postgresql":
        url = os.environ.get("REBORN_SHARED_COURSE_TEST_URL")
        if not url:
            pytest.skip("Requires a dedicated disposable PostgreSQL database")
    else:
        url = "sqlite:///" + (tmp_path / "old.sqlite").as_posix()
    migrate(url, "upgrade", "8f5e126c09a4")
    engine = sa.create_engine(url)
    with engine.begin() as db:
        db.execute(sa.text("INSERT INTO users (id,name,role,password_hash) VALUES (1,'t','teacher','x'),(2,'s','student','x')"))
        db.execute(sa.text("""INSERT INTO classrooms (id,name,teacher_id,join_code,status) VALUES
            (10,'甲',1,'aaa1','active'),(20,'乙',1,'aaa2','archived'),(30,'空',1,'aaa3','deleted')"""))
        db.execute(sa.text("""INSERT INTO course_instances (id,classroom_id,package_id,name,package_version,revision,created_at)
            VALUES (11,10,'same','同名','1',4,CURRENT_TIMESTAMP),(21,20,'same','同名','1',5,CURRENT_TIMESTAMP)"""))
        db.execute(sa.text("""INSERT INTO chapters (id,title,order_index,course_id,course_instance_id,stable_id)
            VALUES (71,'第一章',1,43,11,'one'),(72,'第二章',2,43,11,'two'),(73,'另一章',1,43,21,'one')"""))
        db.execute(sa.text("""INSERT INTO chapter_releases (classroom_id,chapter_id,status,opens_at,prerequisite_chapter_id)
            VALUES (10,71,'published',NULL,NULL),(10,72,'paused','2026-11-24 19:00:00',71)"""))
        db.execute(sa.text("""INSERT INTO materials (id,title,kind,content,status,storage_key,created_at,course_instance_id,stable_id)
            VALUES (14,'讲义','pdf','{}','ready','private/doc.pdf',CURRENT_TIMESTAMP,11,'doc')"""))
        db.execute(sa.text("INSERT INTO material_chapters (material_id,chapter_id) VALUES (14,71)"))
        db.execute(sa.text("INSERT INTO memberships (user_id,classroom_id) VALUES (2,10)"))
        from app.models import PlayerPosition, Question
        db.execute(Activity.__table__.insert(), {"id": "exam", "stable_id": "exam", "course_instance_id": 11,
                                                "chapter_id": 71, "kind": "assessment", "title": "历史试卷"})
        from app.models import ActivityMaterial
        db.execute(Activity.__table__.insert(), {"id": "lesson", "stable_id": "lesson", "course_instance_id": 11,
                                                "chapter_id": 71, "kind": "lesson", "title": "历史讲义"})
        db.execute(ActivityMaterial.__table__.insert(), {"activity_id": "lesson", "material_id": 14,
                                                       "order_index": 0, "required": True, "learning": {}})
        db.execute(Question.__table__.insert(), {"id": "q", "stable_id": "q", "course_instance_id": 11,
                                                "kind": "boolean", "title": "判断题", "prompt": "判断"})
        db.execute(Submission.__table__.insert(), {"id": "answer", "user_id": 2, "classroom_id": 10, "activity_id": "exam",
            "question_id": "q", "idempotency_key": "keep", "status": "accepted", "answer": True})
        db.execute(AssessmentAttempt.__table__.insert(), {"id": "paper", "user_id": 2, "classroom_id": 10,
            "activity_id": "exam", "state": "submitted", "question_ids": ["q"], "submission_ids": {"q": "answer"}})
        db.execute(PlayerPosition.__table__.insert(), {"user_id": 2, "classroom_id": 10, "tile_x": 13, "tile_y": 7})
    migrate(url, "upgrade", "head")
    migrate(url, "upgrade", "head")
    migrate(url, "check")
    with Session(engine) as db:
        assert db.get(Classroom, 10).course_id == 11 and db.get(Classroom, 20).course_id == 21
        assert db.get(Classroom, 30).course.name == "空" and db.get(Classroom, 30).status == "deleted"
        assert db.scalar(sa.text("SELECT prerequisite_chapter_id FROM chapters WHERE id=72")) is None
        assert db.scalar(sa.text("SELECT status FROM chapter_releases WHERE chapter_id=72")) == "paused"
        from app.course_content.access import authorize_material, chapter_available
        student = db.get(User, 2)
        assert authorize_material(db, student, 10, 14).storage_key == "private/doc.pdf"
        assert chapter_available(db, student, 10, 71)
        assert not chapter_available(db, student, 10, 72)
        assert db.get(Membership, (2,10))
        from app.models import PlayerPosition, MaterialChapter
        assert not db.get(Activity, "exam")
        assert not db.get(Submission, "answer")
        assert not db.get(AssessmentAttempt, "paper")
        assert not db.get(PlayerPosition, (2, 10))
        assert db.get(MaterialChapter, (14, 71)).required is False
        db.add_all([Classroom(name="晚班", course_id=11, join_code="aaa4"),
                    User(id=3, name="并发学生", role="student", password_hash="unused")])
        db.commit()
    barrier = Barrier(2)
    def join(code):
        from fastapi import HTTPException
        with Session(engine) as db:
            student = db.get(User, 3)
            barrier.wait(timeout=10)
            try:
                join_classroom(JoinInput(join_code=code), db, student)
                return 200
            except HTTPException as exc:
                return exc.status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(join, ["aaa1", "aaa4"])) == [200, 409]
    engine.dispose()
