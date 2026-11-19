from sqlalchemy import select

from app.models import Classroom, Material, PlayerQuest, TownPreviewStudent, User, now
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
    target = db.get(Classroom, classroom["id"])
    target.status = "archived"
    db.commit()
    listed = client.get("/api/admin/accounts?role=student&q=" + student["student_id"], headers=admin_headers).json()
    assert listed["items"][0]["classrooms"] == [{"id": target.id, "name": target.name, "status": "archived"}]


def test_scoped_global_monitoring(client, db, admin_account, teacher, student, classroom):
    cid = classroom["id"]
    preview_id = client.post(f"/api/teacher/classrooms/{cid}/town-session", headers=teacher["headers"]).json()["user"]["id"]
    assert db.get(TownPreviewStudent, preview_id)
    material = db.scalar(select(Material).where(Material.course_instance_id == db.info["fixture_course_instance_id"]))
    for uid in (preview_id, student["id"]):
        db.add(PlayerQuest(user_id=uid, classroom_id=cid, quest_id="test-global", status="complete"))
    db.add(NarrationRun(material_id=material.id, kind="generate", status="done", started_at=now()))
    db.commit()
    params = {"classroom_id": cid, "teacher_id": teacher["id"]}
    response = client.get("/api/admin/overview", params=params, headers=admin_account["headers"])
    assert response.status_code == 200, response.text
    row, = response.json()["items"]
    assert row["task_total"] == row["task_completed"] == row["student_count"] == 1
    assert row["synthesis_counts"] == {"done": 1}
    for path in ("/api/admin/overview", "/api/admin/synthesis", "/api/teacher/judge/service",
                 "/api/teacher/judge/submissions", "/api/admin/accounts?role=student"):
        assert client.get(path, headers=teacher["headers"]).status_code == 403
        assert client.get(path, headers=admin_account["headers"]).status_code == 200
    job, = client.get("/api/admin/synthesis", headers=admin_account["headers"]).json()["items"]
    assert job["classroom_id"] == cid and job["classroom_name"] == classroom["name"]
    assert db.get(User, teacher["id"]).role == "teacher"
    db.get(Classroom, cid).status = "archived"
    db.commit()
    assert not client.get("/api/admin/overview", params=params, headers=admin_account["headers"]).json()["items"]
