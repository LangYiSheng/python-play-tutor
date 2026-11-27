"""Verify enriched course insights breakdown and student submission question metadata."""
from app.integration_models import AssistantSession
from app.models import (
    Activity,
    ActivityQuestion,
    AssessmentAttempt,
    Chapter,
    ChapterRelease,
    Material,
    MaterialChapter,
    MaterialParticipation,
    PracticeSession,
    Question,
    QuestionChapter,
    Submission,
)


def test_course_insights_breakdown_and_student_record_titles(client, db, teacher, student):
    headers = teacher["headers"]
    course = client.post("/api/teacher/courses", headers=headers, json={"name": "Python程序设计"}).json()
    cid = course["id"]
    room = client.post(f"/api/teacher/courses/{cid}/classrooms", headers=headers, json={"name": "软件一班"}).json()
    room_id = room["id"]

    assert client.post("/api/classrooms/join", headers=student["headers"], json={"join_code": room["join_code"]}).status_code == 200
    chapter = Chapter(course_instance_id=cid, stable_id="ch-1", title="第一章 变量与表达式", order_index=1)
    db.add(chapter)
    db.flush()
    db.add(ChapterRelease(classroom_id=room_id, chapter_id=chapter.id, status="published"))

    material = Material(
        course_instance_id=cid,
        stable_id="mat-1",
        title="变量入门讲义",
        kind="pdf",
        status="ready",
        content={"pages": [{"id": "p1", "page_no": 1}, {"id": "p2", "page_no": 2}]},
    )
    db.add(material)
    db.flush()
    db.add(MaterialChapter(material_id=material.id, chapter_id=chapter.id, required=True, rule={"scope": "all"}))

    q1 = Question(
        id="q- analytics-1",
        course_instance_id=cid,
        stable_id="q1",
        title="合法标识符判断",
        kind="single_choice",
        status="ready",
        prompt="下列哪个是合法变量名？",
        options=["a_1", "1_a"],
    )
    db.add(q1)
    db.flush()
    db.add(QuestionChapter(question_id=q1.id, chapter_id=chapter.id))

    practice = Activity(
        id="act-prac-1",
        course_instance_id=cid,
        stable_id="prac-1",
        chapter_id=chapter.id,
        title="标识符巩固练习",
        kind="practice",
        content={"practice_kind": "objective", "required": True, "published": True},
    )
    exam = Activity(
        id="act-exam-1",
        course_instance_id=cid,
        stable_id="exam-1",
        chapter_id=chapter.id,
        title="第一章测验",
        kind="assessment",
        content={"published": True},
    )
    db.add_all([practice, exam])
    db.flush()
    db.add_all([
        ActivityQuestion(activity_id=practice.id, question_id=q1.id, order_index=0),
        ActivityQuestion(activity_id=exam.id, question_id=q1.id, order_index=0),
    ])

    uid = student["id"]
    db.add(
        MaterialParticipation(
            user_id=uid,
            classroom_id=room_id,
            chapter_id=chapter.id,
            material_id=material.id,
            evidence={"pages": ["p1", "p2"], "seconds": 60},
        )
    )
    sub_wrong = Submission(
        id="sub-wrong",
        user_id=uid,
        classroom_id=room_id,
        activity_id=practice.id,
        question_id=q1.id,
        idempotency_key="k1",
        mode="submit",
        status="wrong_answer",
        answer="1_a",
        feedback={},
    )
    sub_exam = Submission(
        id="sub-exam",
        user_id=uid,
        classroom_id=room_id,
        activity_id=exam.id,
        question_id=q1.id,
        idempotency_key="k2",
        mode="submit",
        status="accepted",
        answer="a_1",
        feedback={},
    )
    db.add_all([
        sub_wrong,
        sub_exam,
        PracticeSession(
            user_id=uid,
            classroom_id=room_id,
            activity_id=practice.id,
            items=[{"knowledge_point_id": 1, "question_id": q1.id, "kind": "single_choice", "status": "wrong", "appended": True}],
        ),
        AssessmentAttempt(
            id="att-1",
            user_id=uid,
            classroom_id=room_id,
            activity_id=exam.id,
            state="submitted",
            question_ids=[q1.id],
            answers={q1.id: {"answer": "a_1"}},
            submission_ids={q1.id: sub_exam.id},
        ),
        AssistantSession(
            user_id=uid,
            classroom_id=room_id,
            material_id=material.id,
            messages=[{"role": "user", "content": "变量命名区分大小写吗？"}, {"role": "assistant", "content": "区分。"}],
        ),
    ])
    db.commit()

    insights = client.get(f"/api/teacher/courses/{cid}/insights", headers=headers)
    assert insights.status_code == 200, insights.text
    payload = insights.json()
    assert payload["active_students"] == 1
    assert payload["assistant_students"] == 1
    assert payload["totals"]["chapters"] == 1
    assert payload["assessment_summary"]["average_score"] == 100.0
    assert payload["chapters"][0]["stages"]["reading"]["completed"] == 1
    assert payload["chapters"][0]["stages"]["assessment"]["completed"] == 1
    assert payload["classrooms"][0]["name"] == "软件一班"
    assert payload["classrooms"][0]["average_score"] == 100.0
    assert payload["difficult_questions"][0]["title"] == "合法标识符判断"
    assert payload["difficult_questions"][0]["failed_attempts"] == 1
    assert payload["difficult_questions"][0]["appended_count"] == 1
    assert payload["assistant_hotspots"][0]["title"] == "变量入门讲义"
    assert payload["assistant_hotspots"][0]["messages"] == 2

    details = client.get(f"/api/teacher/classrooms/{room_id}/activity-report", headers=headers).json()
    assert details["open_chapters"] == 1 and details["total_chapters"] == 1
    prac_row = next(a for a in details["activities"] if a["id"] == practice.id)
    assert prac_row["in_progress"] == 1
    assert prac_row["results"][str(uid)]["appended"] == 1

    record = client.get(f"/api/teacher/classrooms/{room_id}/students/{uid}", headers=headers).json()
    assert record["submissions"][0]["question_title"] == "合法标识符判断"
    assert record["submissions"][0]["activity_title"] == "标识符巩固练习"
