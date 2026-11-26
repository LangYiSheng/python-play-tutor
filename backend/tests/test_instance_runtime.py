"""Classroom course namespaces are enforced even for the same teacher."""
from course_fixtures import empty_course


from uuid import uuid4

import pytest

from app.content_relations import set_activity_questions, set_material_chapters, set_question_chapters
from app.models import (
    Activity, ActivityQuestion, Chapter, ChapterRelease, Classroom, Material, Membership,
    Question,
)


@pytest.fixture
def spaces(db, teacher, student):
    rows = []
    for suffix in ("a", "b"):
        classroom = Classroom(name=f"课程{suffix}", course=empty_course(teacher["id"]), join_code=uuid4().hex[:24])
        db.add(classroom)
        db.flush()
        db.add(Membership(user_id=student["id"], classroom_id=classroom.id))
        instance = classroom.course
        instance.package_id = "same-package"
        instance.package_version = "1"
        instance.name = "课程"
        db.add(instance)
        db.flush()
        common = {"course_instance_id": instance.id, "owner_id": teacher["id"]}
        chapter = Chapter(stable_id="chapter-1", title=f"章节{suffix}", order_index=1, **common)
        db.add(chapter)
        db.flush()
        db.add(ChapterRelease(classroom_id=classroom.id, chapter_id=chapter.id, status="published"))
        material = Material(stable_id="material-1", title=f"资料{suffix}", kind="text", status="ready",
                            content={"library_available": True, "pages": [{"id": 1, "page_no": 1, "title": "页", "text": suffix}]}, **common)
        db.add(material)
        db.flush()
        set_material_chapters(db, material.id, [chapter.id])
        activity = Activity(id=f"activity-{suffix}", stable_id="practice", chapter_id=chapter.id, title=f"练习{suffix}",
                            kind="practice", content={"published": True, "practice_kind": "objective"}, **common)
        question = Question(id=f"question-{suffix}", stable_id="question", title="概念题", kind="single_choice",
                            prompt=suffix, options=[{"id": "a", "text": "A"}], status="ready", source_type="imported", **common)
        db.add_all([activity, question])
        db.flush()
        set_question_chapters(db, question.id, [chapter.id])
        set_activity_questions(db, activity.id, [])
        rows.append({"classroom": classroom, "instance": instance, "chapter": chapter, "material": material,
                     "activity": activity, "question": question})
    db.commit()
    return rows


def test_world_and_library_only_show_selected_instance(client, student, spaces):
    a, b = spaces
    response = client.get(f"/api/world?classroom_id={a['classroom'].id}", headers=student["headers"])
    assert response.status_code == 200, response.text
    world = response.json()
    assert {npc["key"] for npc in world["npcs"]} == {"librarian", "professor", "coach", "mayor"}
    assert [chapter["id"] for chapter in world["chapters"]] == [a["chapter"].id]
    assert world["quests"] == []
    response = client.get(f"/api/library?classroom_id={a['classroom'].id}", headers=student["headers"])
    assert [material["id"] for material in response.json()] == [a["material"].id]
    assert b["material"].id not in [material["id"] for material in response.json()]


@pytest.mark.parametrize("role", ["student", "teacher"])
def test_cross_instance_and_template_direct_access_rejected(client, student, teacher, spaces, role):
    a, b = spaces
    headers = student["headers"] if role == "student" else teacher["headers"]
    for path in (f"activities/{b['activity'].id}", f"materials/{b['material'].id}", "activities/ch1-lesson", "materials/186"):
        response = client.get(f"/api/{path}?classroom_id={a['classroom'].id}", headers=headers)
        assert response.status_code == 403, response.text
    assert client.get(f"/api/activities/{a['activity'].id}?classroom_id={a['classroom'].id}", headers=headers).status_code == 200


def test_cross_instance_question_binding_rejected(client, db, student, spaces):
    a, b = spaces
    a["activity"].kind = "practice"
    # Simulate corrupt legacy data bypassing the now-scoped authoring relation helper.
    db.add(ActivityQuestion(activity_id=a["activity"].id, question_id=b["question"].id, order_index=0))
    db.commit()
    response = client.get(f"/api/activities/{a['activity'].id}?classroom_id={a['classroom'].id}", headers=student["headers"])
    assert response.status_code == 403
