from course_fixtures import create_test_class
import pytest
from sqlalchemy import select, text

from app.models import Classroom, CourseInstance, Material, Membership, PlayerQuest, TownPreviewStudent, User, now
from app.narration.models import NarrationRun


def test_global_accounts_and_teacher_provisioning(client, db, admin_account, teacher, student, classroom):
    admin_headers = admin_account["headers"]
    body = {"name": "新教师", "student_id": "00145", "password": "temporary-password-123"}
    assert client.post("/api/admin/teachers", headers=teacher["headers"], json=body).status_code == 403
    bad = client.post("/api/admin/teachers", headers=admin_headers, json={**body, "password": "abc"})
    assert bad.status_code == 422 and "abc" not in bad.text
    created = client.post("/api/admin/teachers", headers=admin_headers, json=body)
    assert created.status_code == 201
    assert client.post("/api/admin/teachers", headers=admin_headers, json=body).status_code == 409
    listed = client.get("/api/admin/accounts?role=teacher&q=00145", headers=admin_headers).json()
    assert listed["total"] == 1 and listed["items"][0]["must_change_password"]
    account_path = f"/api/admin/accounts/{created.json()['id']}/reset-password"
    assert client.post(account_path, headers=admin_headers, json={}).status_code == 422
    assert client.post(account_path, headers=admin_headers, json={"password": "next-temporary-password"}).status_code == 200
    assert client.post("/api/auth/login", json={"student_id": body["student_id"], "password": body["password"]}).status_code == 401
    path = f"/api/admin/accounts/{student['id']}/reset-password"
    assert client.post(path, headers=teacher["headers"], json={}).status_code == 403
    assert client.post(path, headers=admin_headers, json={}).status_code == 200
    assert client.get("/api/auth/me", headers=student["headers"]).status_code == 401
    assert client.post("/api/auth/login", json={"student_id": student["student_id"], "password": student["student_id"]}).json()["user"]["must_change_password"]
    peek = client.post(f"/api/teacher/classrooms/{classroom['id']}/town-session", headers=teacher["headers"]).json()["user"]["id"]
    listed = client.get("/api/admin/accounts?role=student", headers=admin_headers).json()
    assert peek not in {u["id"] for u in listed["items"]}
    assert client.post(f"/api/admin/accounts/{peek}/reset-password", headers=admin_headers, json={}).status_code == 404
    other = create_test_class(client, headers=teacher["headers"], json={"name": "另一班"}).json()
    params = {"role": "student", "q": student["student_id"], "classroom_id": other["id"], "size": 1}
    assert client.get("/api/admin/accounts", params=params, headers=admin_headers).json() == {"items": [], "total": 0}
    target = db.get(Classroom, classroom["id"])
    target.status = "archived"
    db.commit()
    params["classroom_id"] = target.id
    listed = client.get("/api/admin/accounts", params=params, headers=admin_headers).json()
    assert listed["total"] == 1
    assert listed["items"][0]["classrooms"] == [{"id": target.id, "name": target.name, "status": "archived"}]


def test_teacher_default_password_and_shared_identifier_uniqueness(client, admin_account, teacher, student, classroom):
    headers = admin_account["headers"]
    body = {"name": "新教师", "student_id": "00000091"}
    assert client.post("/api/admin/teachers", headers=headers, json={**body, "student_id": "123"}).status_code == 422
    assert client.post("/api/admin/teachers", headers=headers, json={**body, "student_id": student["student_id"]}).status_code == 409
    assert client.post("/api/admin/teachers", headers=headers, json=body).status_code == 201
    roster = f"/api/teacher/classrooms/{classroom['id']}/students"
    assert client.post(roster, headers=teacher["headers"], json={"students": [body]}).status_code == 422
    login = client.post("/api/auth/login", json={"student_id": body["student_id"], "password": body["student_id"]})
    assert login.status_code == 200 and login.json()["user"]["must_change_password"]


def test_admin_creates_unassigned_student_that_teacher_can_add(client, admin_account, teacher, classroom):
    path = "/api/admin/students"
    headers = admin_account["headers"]
    body = {"name": "  新学生  ", "student_id": "00000092"}
    assert client.post(path, headers=teacher["headers"], json=body).status_code == 403
    assert client.post(path, headers=headers, json={**body, "student_id": "123"}).status_code == 422
    created = client.post(path, headers=headers, json=body)
    assert created.status_code == 201
    account = created.json()
    assert account == {"id": account["id"], "name": "新学生", "student_id": "00000092"}
    assert client.post(path, headers=headers, json={**body, "name": "别的姓名"}).status_code == 409

    listed = client.get("/api/admin/accounts?role=student&q=00000092", headers=headers).json()
    assert listed["total"] == 1
    assert listed["items"][0]["classrooms"] == []
    login = client.post("/api/auth/login", json={"student_id": "00000092", "password": "00000092"})
    assert login.status_code == 200 and login.json()["user"]["must_change_password"]

    roster = f"/api/teacher/classrooms/{classroom['id']}/students"
    bound = client.post(roster, headers=teacher["headers"], json={"students": [body]})
    assert bound.status_code == 201
    assert bound.json() == {"created": 0, "bound": 1, "existing": 0}
    rows = client.get(roster, headers=teacher["headers"]).json()
    assert any(row["id"] == account["id"] and row["name"] == "新学生" for row in rows)


@pytest.mark.parametrize("role", ["teacher", "student"])
def test_managed_account_rename_disable_and_enable(client, db, admin_account, teacher, student, classroom, role):
    actor = teacher if role == "teacher" else student
    admin = admin_account["headers"]
    path = f"/api/admin/accounts/{actor['id']}"
    credentials = {"student_id": actor["student_id"], "password": f"{role}-password-123"}
    assert client.put(path + "/name", headers=teacher["headers"], json={"name": "不会改名"}).status_code == 403
    assert client.put(path + "/name", headers=admin, json={"name": "  新姓名  "}).status_code == 200
    assert client.get("/api/auth/me", headers=actor["headers"]).json()["name"] == "新姓名"
    preview = (client.post(f"/api/teacher/classrooms/{classroom['id']}/town-session", headers=teacher["headers"]).json()
               if role == "teacher" else None)
    assert client.put(path + "/status", headers=admin, json={"disabled": True}).status_code == 200
    assert client.get("/api/auth/me", headers=actor["headers"]).status_code == 401
    assert client.post("/api/auth/login", json=credentials).status_code == 401
    if preview:
        assert client.get("/api/auth/me", headers={"Authorization": "Bearer " + preview["access_token"]}).status_code == 401
    assert client.get(f"/api/admin/accounts?role={role}&q=新姓名", headers=admin).json()["items"][0]["disabled"] is True
    assert client.put(path + "/status", headers=admin, json={"disabled": False}).status_code == 200
    assert client.get("/api/auth/me", headers=actor["headers"]).status_code == 401
    assert client.post("/api/auth/login", json=credentials).status_code == 200
    assert db.get(Classroom, classroom["id"])
    assert db.get(Membership, (student["id"], classroom["id"]))


def test_delete_student_removes_saves_without_removing_the_course(client, db, admin_account, student, classroom):
    db.commit()
    db.execute(text("PRAGMA foreign_keys=ON"))
    cid, uid = classroom["id"], student["id"]
    db.add(PlayerQuest(user_id=uid, classroom_id=cid, quest_id="delete-student", status="complete"))
    db.commit()
    path = f"/api/admin/accounts/{uid}"
    assert client.delete(path, headers=student["headers"]).status_code == 403
    assert client.delete(path, headers=admin_account["headers"]).status_code == 204
    assert client.delete(path, headers=admin_account["headers"]).status_code == 404
    assert client.get("/api/auth/me", headers=student["headers"]).status_code == 401
    assert db.get(User, uid) is None and db.get(Membership, (uid, cid)) is None
    assert db.scalar(select(PlayerQuest.id).where(PlayerQuest.user_id == uid)) is None
    assert db.get(Classroom, cid).course_id
    assert not db.execute(text("PRAGMA foreign_key_check")).all()


def test_delete_teacher_removes_owned_courses_and_preserves_other_classrooms(client, db, admin_account, student, classroom):
    db.commit()
    db.execute(text("PRAGMA foreign_keys=ON"))
    admin = admin_account["headers"]
    from test_curriculum import another_teacher
    from app.models import PlayerPosition
    teacher = another_teacher(db)
    target = create_test_class(client, headers=teacher["headers"], json={"name": "待删课程"}).json()
    cid, instance_id = target["id"], target["course_id"]
    preview_id = client.post(f"/api/teacher/classrooms/{cid}/town-session", headers=admin).json()["user"]["id"]
    retained = classroom
    db.add_all([
        Membership(classroom_id=cid, user_id=student["id"]),
        Material(course_instance_id=instance_id, owner_id=teacher["id"], stable_id="delete-test", title="临时课件"),
        PlayerPosition(classroom_id=cid, user_id=student["id"]),
        PlayerPosition(classroom_id=retained["id"], user_id=student["id"]),
    ])
    db.commit()
    assert client.delete(f"/api/admin/accounts/{admin_account['id']}", headers=admin).status_code == 403
    assert client.delete(f"/api/admin/accounts/{preview_id}", headers=admin).status_code == 404
    assert client.delete(f"/api/admin/accounts/{teacher['id']}", headers=admin).status_code == 204
    assert db.get(Classroom, cid) is None and db.get(CourseInstance, instance_id) is None
    assert db.get(User, preview_id) is None and db.get(User, teacher["id"]) is None
    assert db.scalar(select(Material.id).where(Material.course_instance_id == instance_id)) is None
    assert db.get(User, student["id"])
    assert db.get(Membership, (student["id"], retained["id"]))
    assert list(db.scalars(select(PlayerPosition.classroom_id))) == [retained["id"]]
    assert not db.execute(text("PRAGMA foreign_key_check")).all()


def test_scoped_global_monitoring(client, db, admin_account, teacher, student, classroom):
    cid = classroom["id"]
    preview_id = client.post(f"/api/teacher/classrooms/{cid}/town-session", headers=teacher["headers"]).json()["user"]["id"]
    assert db.get(TownPreviewStudent, preview_id)
    material = db.scalar(select(Material).where(Material.course_instance_id == db.info["fixture_course_instance_id"]))
    from app.models import MaterialChapter, MaterialParticipation
    link = db.scalar(select(MaterialChapter).where(MaterialChapter.material_id == material.id))
    link.required, link.rule = True, {"scope": "count", "count": 1}
    for uid in (preview_id, student["id"]):
        db.add(MaterialParticipation(user_id=uid, classroom_id=cid, chapter_id=link.chapter_id, material_id=material.id,
                                     evidence={"pages": [material.content["pages"][0]["id"]]}))
    db.add(NarrationRun(material_id=material.id, kind="generate", status="done", started_at=now()))
    db.commit()
    params = {"classroom_id": cid, "teacher_id": teacher["id"]}
    response = client.get("/api/admin/overview", params=params, headers=admin_account["headers"])
    assert response.status_code == 200, response.text
    row, = response.json()["items"]
    assert row["task_completed"] == row["student_count"] == 1
    assert row["task_total"] == 2  # Required document and the published chapter assessment.
    assert row["synthesis_counts"] == {"done": 1}
    for path in ("/api/admin/overview", "/api/admin/synthesis", "/api/teacher/judge/service",
                 "/api/teacher/judge/submissions", "/api/admin/accounts?role=student"):
        assert client.get(path, headers=teacher["headers"]).status_code == 403
        assert client.get(path, headers=admin_account["headers"]).status_code == 200
    job, = client.get("/api/admin/synthesis", headers=admin_account["headers"]).json()["items"]
    assert job["course_id"] == classroom["course_id"] and job["course_name"] == db.get(Classroom, cid).course.name
    assert db.get(User, teacher["id"]).role == "teacher"
    db.get(Classroom, cid).status = "archived"
    db.commit()
    assert not client.get("/api/admin/overview", params=params, headers=admin_account["headers"]).json()["items"]
