"""Tests for course setup onboarding progress summary."""

from app.models import (
    Activity,
    Chapter,
    ChapterRelease,
    KnowledgePoint,
    Material,
    MaterialChapter,
    Question,
)
from app.narration import repository
from app.narration.models import PageNarration


def test_course_onboarding_tracks_seven_step_progress(client, db, teacher, student):
    created = client.post(
        "/api/teacher/courses",
        headers=teacher["headers"],
        json={"name": "引导测试课"},
    )
    assert created.status_code == 201
    course_id = created.json()["id"]

    assert (
        client.get(
            f"/api/teacher/courses/{course_id}/onboarding",
            headers=student["headers"],
        ).status_code
        == 403
    )

    empty = client.get(
        f"/api/teacher/courses/{course_id}/onboarding",
        headers=teacher["headers"],
    )
    assert empty.status_code == 200
    assert empty.json() == {
        "classrooms": [],
        "student_count": 0,
        "chapter_count": 0,
        "material_count": 0,
        "ready_material_count": 0,
        "narratable_material_count": 0,
        "narration_accepted_pages": 0,
        "narration_draft_pages": 0,
        "audio_ready_pages": 0,
        "knowledge_point_count": 0,
        "ready_question_count": 0,
        "draft_question_count": 0,
        "published_practice_count": 0,
        "published_assessment_count": 0,
        "required_reading_count": 0,
        "open_chapter_count": 0,
        "scheduled_chapter_count": 0,
    }

    room = client.post(
        f"/api/teacher/courses/{course_id}/classrooms",
        headers=teacher["headers"],
        json={"name": "一班"},
    ).json()
    client.post(
        f"/api/teacher/classrooms/{room['id']}/students",
        headers=teacher["headers"],
        json={"students": [{"student_id": "20268801", "name": "张同学"}]},
    )

    chapter = Chapter(
        course_instance_id=course_id,
        stable_id="ch-1",
        title="第一章",
        order_index=1,
    )
    db.add(chapter)
    db.flush()

    material = Material(
        course_instance_id=course_id,
        stable_id="mat-1",
        title="第一章讲义",
        kind="pdf",
        status="ready",
        storage_key="materials/demo.pdf",
        content={"pages": [{"id": 1, "page_no": 1, "text": "print('hello')"}]},
    )
    db.add(material)
    db.flush()
    db.add(MaterialChapter(material_id=material.id, chapter_id=chapter.id, required=True, order_index=1))

    script_text = "本页介绍 print 输出语句。"
    page_fp = repository.narration_page_hash(material, 1, "print('hello')", None)
    db.add(
        PageNarration(
            material_id=material.id,
            page_no=1,
            text=script_text,
            status="accepted",
            page_hash=page_fp,
            audio_key="narrations/demo-p1.mp3",
            audio_text_hash=repository.text_hash(script_text),
            audio_seconds=8,
        )
    )

    kp = KnowledgePoint(
        course_instance_id=course_id,
        stable_id="kp-1",
        chapter_id=chapter.id,
        title="print 函数",
        content={},
    )
    db.add(kp)
    db.add(
        Question(
            id=f"q-ready-{course_id}",
            course_instance_id=course_id,
            stable_id="q-1",
            title="选择题",
            kind="single_choice",
            prompt="1+1=?",
            options=["1", "2"],
            status="ready",
            source_type="imported",
        )
    )
    db.add(
        Activity(
            id=f"act-prac-{course_id}",
            course_instance_id=course_id,
            stable_id="act-p",
            chapter_id=chapter.id,
            title="客观练习",
            kind="practice",
            content={"practice_kind": "objective", "published": True},
        )
    )
    db.add(
        Activity(
            id=f"act-exam-{course_id}",
            course_instance_id=course_id,
            stable_id="act-e",
            chapter_id=chapter.id,
            title="第一章测验",
            kind="assessment",
            content={"published": True},
        )
    )
    db.add(ChapterRelease(classroom_id=room["id"], chapter_id=chapter.id, status="published", opens_at=None))
    db.commit()

    populated = client.get(
        f"/api/teacher/courses/{course_id}/onboarding",
        headers=teacher["headers"],
    ).json()
    assert len(populated["classrooms"]) == 1
    assert populated["classrooms"][0]["name"] == "一班"
    assert populated["classrooms"][0]["student_count"] == 1
    assert populated["student_count"] == 1
    assert populated["chapter_count"] == 1
    assert populated["ready_material_count"] == 1
    assert populated["narratable_material_count"] == 1
    assert populated["narration_accepted_pages"] == 1
    assert populated["audio_ready_pages"] == 1
    assert populated["knowledge_point_count"] == 1
    assert populated["ready_question_count"] == 1
    assert populated["required_reading_count"] == 1
    assert populated["published_practice_count"] == 1
    assert populated["published_assessment_count"] == 1
    assert populated["open_chapter_count"] == 1
