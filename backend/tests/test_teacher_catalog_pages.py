from datetime import datetime, timezone

from sqlalchemy import event, insert, select

from app.models import Chapter, KnowledgePoint, Question, QuestionChapter


def test_large_class_catalogues_page_before_loading_details(client, db, teacher, student, classroom):
    chapter = db.get(Chapter, 179)
    course_id = chapter.course_instance_id
    common = {"course_instance_id": course_id, "owner_id": teacher["id"]}
    questions = [{"id": f"bulk-{i:04}", "title": f"测试题{i}", "kind": "fill", "prompt": "100% Python"}
                 for i in range(1000)]
    db.execute(insert(Question), [{**common, **q} for q in questions])
    db.execute(insert(QuestionChapter), [{"chapter_id": chapter.id, "question_id": q["id"]} for q in questions])
    db.execute(insert(KnowledgePoint), [{**common, "chapter_id": chapter.id, "title": f"目录样例{i}"}
                                       for i in range(10000)])
    removed = datetime.now(timezone.utc)
    db.get(Question, "bulk-0000").deleted_at = removed
    db.scalar(select(KnowledgePoint).where(KnowledgePoint.title == "目录样例0")).deleted_at = removed
    db.commit()
    base = {"classroom_id": classroom["id"]}

    def get(path, **filters):
        response = client.get("/api/teacher/" + path, params={**base, **filters}, headers=teacher["headers"])
        assert response.status_code == 200, response.text
        return response.json()

    statements = []

    def capture(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(db.bind, "before_cursor_execute", capture)
    try:
        def question_page(size):
            statements.clear()
            data = get("questions", page=2, size=size, search="100%", kind="fill", source="imported", status="draft")
            return data, len(statements)

        small, small_count = question_page(10)
        large, large_count = question_page(100)
        assert small_count == large_count
        assert not any("question_secrets" in sql for sql in statements)
        assert small["total"] == large["total"] == 999
        assert len(small["items"]) == 10 and len(large["items"]) == 100
        row = small["items"][0]
        assert row["id"] == "bulk-0011" and row["chapter_ids"] == [chapter.id]
        assert set(row) == {"id", "title", "kind", "source_type", "status", "chapter_ids"}
        assert get(f"questions/{row['id']}")["prompt"] == "100% Python"
        last = get("knowledge-points", page=9999, size=10, chapter_id=chapter.id, search="目录样例")
        assert last["total"] == 9999 and last["page"] == 1000 and len(last["items"]) == 9
        assert set(get("courses", view="chapters")) == {"chapters"}
        assert row["id"] in {q["id"] for q in get(f"chapters/{chapter.id}/question-candidates")}
        labels = get("knowledge-point-labels", ids=[p["id"] for p in last["items"]])
        assert {p["id"] for p in labels} == {p["id"] for p in last["items"]}
    finally:
        event.remove(db.bind, "before_cursor_execute", capture)
    for path in ("questions/bulk-0011", "knowledge-points"):
        assert client.get("/api/teacher/" + path, params=base, headers=student["headers"]).status_code == 403
