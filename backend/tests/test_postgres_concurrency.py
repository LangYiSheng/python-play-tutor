"""Opt-in PostgreSQL contention test. Creates only a temporary schema in Reborn DB."""

from course_fixtures import empty_course
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from datetime import timedelta
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from app.auth import issue
from app.db import Base, get_db
from app.main import app
from app.models import User, Classroom, Membership, Chapter, ChapterRelease, Material, MaterialChapter, MaterialParticipation, now


@pytest.mark.skipif(
    not os.getenv("REBORN_TEST_DATABASE_URL"), reason="Requires an explicit isolated Reborn PostgreSQL connection; SQLite does not verify row locking"
)
def test_postgres_duplicate_reading_heartbeats_under_contention(monkeypatch):
    url = make_url(os.environ["REBORN_TEST_DATABASE_URL"])
    assert url.get_backend_name() == "postgresql" and "reborn" in url.database.lower(), "Only explicit Reborn database may be tested"
    admin = create_engine(url)
    schema = "reborn_test_" + uuid4().hex
    assert schema.startswith("reborn_test_") and schema.replace("_", "").isalnum()
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"}, pool_size=4)
    factory = sessionmaker(engine, expire_on_commit=False)
    previous = dict(app.dependency_overrides)
    try:
        Base.metadata.create_all(engine)
        with factory() as db:
            teacher = User(student_id="193582816979202", name="teacher", role="teacher", password_hash="unused")
            student = User(student_id="870446112008", name="student", role="student", password_hash="unused")
            db.add_all([teacher, student])
            db.flush()
            classroom = Classroom(name="isolated contention", course=empty_course(teacher.id), join_code=uuid4().hex[:20])
            db.add(classroom)
            db.flush()
            chapter = Chapter(course_instance_id=classroom.course_id, title="第一章", order_index=1)
            material = Material(course_instance_id=classroom.course_id, kind="pdf", title="讲义", status="ready",
                                content={"pages": [{"id": 20, "page_no": 1}, {"id": 21, "page_no": 2}]})
            db.add_all([chapter, material])
            db.flush()
            db.add_all([Membership(user_id=student.id, classroom_id=classroom.id),
                        ChapterRelease(classroom_id=classroom.id, chapter_id=chapter.id, status="published"),
                        MaterialChapter(material_id=material.id, chapter_id=chapter.id, required=True, rule={})])
            db.commit()
            headers = {"Authorization": "Bearer " + issue(db, student)["access_token"]}
            url = f"/api/chapters/{chapter.id}/materials/{material.id}/participation?classroom_id={classroom.id}"

        def override_db():
            with factory() as db:
                yield db

        app.dependency_overrides[get_db] = override_db
        instant = now()
        monkeypatch.setattr("app.chapter_tasks.router.now", lambda: instant)
        def parallel(packet):
            barrier = Barrier(4)
            def send(_):
                client = TestClient(app)
                try:
                    barrier.wait(timeout=15)
                    response = client.post(url, headers=headers, json=packet)
                    assert response.status_code == 200, response.text
                    return response.json()
                finally:
                    client.close()
            with ThreadPoolExecutor(max_workers=4) as pool:
                return list(pool.map(send, range(4)))

        first = {"visible": True, "session_id": "concurrent", "sequence": 1, "page_id": 20}
        assert all(row["read_count"] == 0 for row in parallel(first))
        instant += timedelta(seconds=5)
        final = parallel({**first, "sequence": 2, "page_id": 21})
        assert all(row["read_count"] == 1 and row["seconds"] == 5 for row in final)
        instant += timedelta(seconds=5)
        assert all(row["completed"] for row in parallel({**first, "sequence": 3, "page_id": 21, "visible": False}))
        with factory() as db:
            row = db.scalars(select(MaterialParticipation)).one()
            assert row.evidence["seconds"] == 10 and row.evidence["pages"] == [20, 21]
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
