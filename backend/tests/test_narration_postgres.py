"""First-job creation is serialized even before a narration_jobs row exists."""
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session

from app.db import Base
from app.models import Classroom, CourseInstance, Material, User
from app.narration import jobs, repository
from app.narration.management import RetryInput, cancel_task
from fixture_seed import seed


@pytest.fixture
def pg_engine():
    if not os.getenv("REBORN_TEST_DATABASE_URL"):
        pytest.skip("Requires isolated PostgreSQL")
    url = os.environ["REBORN_TEST_DATABASE_URL"]
    admin = create_engine(url)
    schema = "narration_lock_" + uuid4().hex
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"})
    try:
        Base.metadata.create_all(engine)
        yield engine
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def test_first_acquisition_has_one_owner(pg_engine):
    with Session(pg_engine) as db:
        seed(db)
        mid = db.scalar(select(Material.id).limit(1))
    barrier = Barrier(2)
    def acquire():
        with Session(pg_engine) as db:
            material = db.get(Material, mid)
            barrier.wait(timeout=10)
            try:
                repository.acquire(db, material, "generate")
                return "owned"
            except repository.JobBusy:
                return "busy"
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: acquire(), range(2)))
    assert sorted(results) == ["busy", "owned"]


def test_cancellation_can_be_requested_while_worker_holds_job_row(pg_engine):
    with Session(pg_engine) as worker, Session(pg_engine) as teacher_session:
        teacher = User(name="测试教师", role="teacher", password_hash="fixture")
        worker.add(teacher)
        worker.flush()
        classroom = Classroom(name="隔离测试班", teacher_id=teacher.id, join_code=uuid4().hex[:12])
        worker.add(classroom)
        worker.flush()
        course = CourseInstance(name="测试课程", classroom_id=classroom.id, package_id="test", package_version="1")
        worker.add(course)
        worker.flush()
        material = Material(title="测试课件", course_instance_id=course.id, kind="pdf")
        worker.add(material)
        worker.flush()
        job = repository.enqueue(worker, material, "digest", request={"operation": "digest"})
        jobs.claim(worker, material.id)
        repository.ensure_lease(worker, material.id)
        # The second connection must complete before the first releases its FOR UPDATE lock.
        teacher_session.execute(text("SET LOCAL lock_timeout = '2s'"))
        result = cancel_task(classroom.id, material.id, RetryInput(expected_started_at=job.started_at.isoformat()),
                             teacher_session, teacher_session.get(User, teacher.id))
        assert result["status"] == "cancelling"
        with pytest.raises(repository.CancellationRequested):
            repository.check_cancel(worker, material.id)
