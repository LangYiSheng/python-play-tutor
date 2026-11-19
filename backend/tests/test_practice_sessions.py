"""A learner's assigned queue, cooldowns, and completion all use the same receipts."""
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.content_relations import set_question_knowledge_points
from app.course_content.evidence import validate_learning_evidence
from app.models import Activity, KnowledgePoint, PracticeSession, QuestionSecret, User
from app.practice_sessions import _remaining
from conftest import make_question


def create_practice(db, *, count=3, target=1, interval=1):
    point = KnowledgePoint(title="专用练习知识点", chapter_id=179, content={})
    db.add(point)
    db.flush()
    rules = {"retry_interval": interval, "goals": [{"knowledge_point_id": point.id, "by_kind": {"fill": target}, "total": target}]}
    activity = Activity(id="kc-practice", kind="practice", chapter_id=179, title="练习",
                        content={"practice_rules": rules, "knowledge_point_ids": [point.id], "published": True})
    db.add(activity)
    for index in range(count):
        qid = f"kc-fill-{index}"
        make_question(db, id=qid, title=qid, prompt="填空", kind="fill", chapter_ids=[179])
        set_question_knowledge_points(db, qid, [point.id])
        db.add(QuestionSecret(question_id=qid, answer="对", hidden_cases=[]))
    db.commit()
    return activity


def test_assigned_only_retry_once_and_complete_every_added_question(client, db, student, classroom, teacher):
    activity = create_practice(db)
    cid = classroom["id"]
    path = f"/api/activities/{activity.id}"
    params = {"classroom_id": cid}
    headers = student["headers"]

    def open_activity():
        response = client.get(path, params=params, headers=headers)
        assert response.status_code == 200, response.text
        return response.json()

    def submit(qid, answer, key):
        return client.post("/api/submissions", headers=headers, json={**params, "activity_id": activity.id,
                           "question_id": qid, "answer": answer, "idempotency_key": f"practice-{key}"})

    assert not client.get(path + "/progress", params=params, headers=headers).json()["practice"]["items"]
    assert client.get(path, params=params, headers=teacher["headers"]).json()["questions"] == []
    assert db.scalar(select(PracticeSession)) is None

    first = open_activity()
    assert len(first["questions"]) == 1
    a = first["questions"][0]["id"]
    other = next(f"kc-fill-{i}" for i in range(3) if f"kc-fill-{i}" != a)
    assert submit(other, "对", "foreign").status_code == 404
    assert submit(a, "  ", "empty").status_code == 422
    assert open_activity()["questions"] == first["questions"]

    receipt = submit(a, "错", "wrong-a")
    assert receipt.status_code == 201, receipt.text
    assert submit(a, "错", "wrong-a").json() == receipt.json()
    assert submit(a, "对", "wrong-a").status_code == 409
    assert submit(a, "对", "too-early").status_code == 409
    after_first = open_activity()
    a_item, b_item = after_first["progress"]["practice"]["items"]
    b = b_item["question_id"]
    assert (a_item["retry_remaining"], b_item["appended"]) == (1, True)
    assert submit(b, "错", "wrong-b").status_code == 201
    assert submit(a, "错", "repeat-a").status_code == 201
    after_repeat = open_activity()["progress"]
    assert len(after_repeat["practice"]["items"]) == 3
    c = after_repeat["practice"]["items"][2]["question_id"]
    assert submit(c, "对", "right-c").status_code == 201
    assert submit(c, "对", "repeat-c").status_code == 409

    partial = open_activity()["progress"]
    assert partial["practice"]["goals"][0]["accepted"] == 1 and not partial["completed"]
    user = db.get(User, student["id"])
    node = {"type": "COMPLETE_PRACTICE", "activity_id": activity.id}
    with pytest.raises(HTTPException):
        validate_learning_evidence(db, user, cid, node, {})
    assert submit(b, "对", "right-b").status_code == 201
    assert submit(a, "对", "right-a").status_code == 201
    final = open_activity()["progress"]
    assert final["completed"] and set(final["accepted_question_ids"]) == {a, b, c}
    validate_learning_evidence(db, user, cid, node, {})


def test_distinct_questions_and_deadlock_relief():
    items = [{"question_id": "A", "status": "wrong", "last_attempt": 1},
             {"question_id": "B", "status": "wrong", "last_attempt": 5},
             {"question_id": "C", "status": "unanswered", "last_attempt": 0}]
    assert _remaining(items, 2) == {"A": 1, "B": 2}
    items.pop()
    assert _remaining(items, 2) == {"A": 0, "B": 2}
    assert _remaining(items[:1], 2) == {"A": 0}

def test_practice_session_migration_round_trip(tmp_path):
    path = tmp_path / "isolated-practice.db"
    env = {**os.environ, "REBORN_ENV": "development", "REBORN_DATABASE_URL": "sqlite:///" + path.as_posix()}
    backend = Path(__file__).resolve().parents[1]
    for command, target, expected in [("upgrade", "head", True), ("downgrade", "e51b92fa60c3", False), ("upgrade", "head", True)]:
        result = subprocess.run([sys.executable, "-m", "alembic", command, target], env=env, cwd=backend,
                                capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stderr
        with sqlite3.connect(path) as db:
            exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='practice_sessions'").fetchone()
            assert bool(exists) == expected
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []

def test_concurrent_open_and_retried_submission_share_one_draw(db, student, classroom, tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from sqlalchemy import create_engine, func
    from sqlalchemy.orm import Session

    from app.courses import get_activity
    from app.models import Submission
    from app.practice import SubmissionInput, create_submission

    activity_id = create_practice(db).id
    cid, uid = classroom["id"], student["id"]
    engine = create_engine("sqlite:///" + (tmp_path / "concurrent.db").as_posix())
    source, copy = db.get_bind().raw_connection(), engine.raw_connection()
    try:
        source.driver_connection.backup(copy.driver_connection)
    finally:
        source.close()
        copy.close()
    gate = Barrier(2, timeout=10)

    def concurrently(action):
        with Session(engine) as session:
            user = session.get(User, uid)
            gate.wait()
            return action(session, user)

    def open_for_student(session, user):
        page = get_activity(activity_id, cid, session, user)
        return [q["id"] for q in page["questions"]]

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            queues = list(pool.map(concurrently, [open_for_student, open_for_student]))
            assert len(queues[0]) == 1 and queues[0] == queues[1]
            body = SubmissionInput(classroom_id=cid, activity_id=activity_id, question_id=queues[0][0],
                                   idempotency_key="concurrent-duplicate", answer="错")

            def submit_for_student(session, user):
                return create_submission(body, user, session)["id"]

            receipts = list(pool.map(concurrently, [submit_for_student, submit_for_student]))
            assert receipts[0] == receipts[1]
        with Session(engine) as session:
            assert session.scalar(select(func.count()).select_from(Submission)) == 1
            assert len(session.get(PracticeSession, (uid, cid, activity_id)).items) == 2
    finally:
        engine.dispose()
