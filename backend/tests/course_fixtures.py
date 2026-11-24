"""Construct independent teaching courses for isolated test classrooms."""
from uuid import uuid4

from app.models import CourseInstance


def empty_course(teacher_id, name="测试课程"):
    return CourseInstance(teacher_id=teacher_id, name=name, package_id=uuid4().hex, package_version="1")


def create_test_class(client, *, json, headers):
    result = client.post("/api/teacher/courses", json={"name": json["name"]}, headers=headers)
    assert result.status_code == 201, result.text
    course_id = result.json()["id"]
    return client.post(f"/api/teacher/courses/{course_id}/classrooms", json=json, headers=headers)
