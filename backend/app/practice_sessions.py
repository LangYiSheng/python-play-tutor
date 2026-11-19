"""Personal practice queues. All mutations share the formal submission transaction."""
from bisect import bisect_right
from collections import Counter
from random import SystemRandom

from fastapi import HTTPException
from sqlalchemy import select, update

from app.models import PracticeSession, Question, User
from app.practice_rules import allocate_initial, candidate_pool


def lock_learner(db, user_id):
    # SQLite ignores FOR UPDATE. Acquire its write lock before reading the queue.
    if db.get_bind().dialect.name == "sqlite":
        db.execute(update(User).where(User.id == user_id).values(id=User.id))
    else:
        db.execute(select(User.id).where(User.id == user_id).with_for_update())


def _item(point, question_id, kind, *, appended=False):
    return {"knowledge_point_id": point, "question_id": question_id, "kind": kind,
            "status": "unanswered", "last_attempt": 0, "appended": appended}


def open_session(db, user, classroom_id, activity):
    key = (user.id, classroom_id, activity.id)
    lock_learner(db, user.id)
    session = db.get(PracticeSession, key, populate_existing=True)
    if session is None:
        pool = candidate_pool(db, activity)
        try:
            assignment = allocate_initial(activity.content["practice_rules"], pool)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        items = [_item(point, qid, pool[point][qid]) for point, questions in assignment.items() for qid in questions]
        session = PracticeSession(user_id=user.id, classroom_id=classroom_id, activity_id=activity.id, items=items)
        db.add(session)
        db.flush()
    return session


def assigned_questions(db, user, classroom_id, activity):
    session = db.get(PracticeSession, (user.id, classroom_id, activity.id))
    if not session:
        return []
    ids = [item["question_id"] for item in session.items]
    questions = {q.id: q for q in db.scalars(select(Question).where(
        Question.id.in_(ids), Question.course_instance_id == activity.course_instance_id, Question.status == "ready"))}
    if len(questions) != len(ids):
        raise HTTPException(409, "个人题单中的题目已不可用，请联系教师")
    return [questions[qid] for qid in ids]


def _remaining(items, interval):
    # Each question's latest attempt is sufficient to count DISTINCT other questions
    # attempted after a failure. Never advance the sequence for already passed items.
    attempts = sorted(item["last_attempt"] for item in items)

    remaining = {
        item["question_id"]: max(0, interval - (len(attempts) - bisect_right(attempts, item["last_attempt"])))
        for item in items if item["status"] == "wrong"
    }
    if remaining and min(remaining.values()) > 0 and all(item["status"] != "unanswered" for item in items):
        oldest = min((item for item in items if item["status"] == "wrong"), key=lambda item: item["last_attempt"])
        remaining[oldest["question_id"]] = 0
    return remaining


def practice_progress(db, user, classroom_id, activity):
    session = db.get(PracticeSession, (user.id, classroom_id, activity.id))
    items = session.items if session else []
    rules = activity.content["practice_rules"]
    remaining = _remaining(items, rules["retry_interval"])
    passed = [item for item in items if item["status"] == "accepted"]
    counts = Counter((item["knowledge_point_id"], item["kind"]) for item in passed)
    goals = []
    for goal in rules["goals"]:
        kinds = {kind: count for (point, kind), count in counts.items() if point == goal["knowledge_point_id"]}
        goals.append({**goal, "accepted": sum(kinds.values()), "accepted_by_kind": dict(kinds)})
    complete = bool(items) and len(passed) == len(items) and all(
        goal["accepted"] >= goal["total"] and all(goal["accepted_by_kind"].get(k, 0) >= n for k, n in goal["by_kind"].items())
        for goal in goals)
    return {"page_no": None, "visited_pages": [], "completed": complete,
            "accepted_question_ids": [item["question_id"] for item in passed],
            "practice": {"retry_interval": rules["retry_interval"], "goals": goals,
                         "items": [{"question_id": item["question_id"], "knowledge_point_id": item["knowledge_point_id"],
                                    "status": item["status"], "appended": item["appended"],
                                    "retry_remaining": remaining.get(item["question_id"], 0)} for item in items]}}


def require_attempt(db, user, classroom_id, activity, question_id):
    session = db.get(PracticeSession, (user.id, classroom_id, activity.id), populate_existing=True)
    item = next((i for i in session.items if i["question_id"] == question_id), None) if session else None
    if item is None:
        raise HTTPException(404, "题目不属于本人的练习题单")
    if item["status"] == "accepted":
        raise HTTPException(409, "此题已通过")
    remaining = _remaining(session.items, activity.content["practice_rules"]["retry_interval"]).get(question_id, 0)
    if remaining:
        raise HTTPException(409, f"请先作答其他 {remaining} 道不同的题目，再来订正")
    question = db.get(Question, question_id)
    if not question or question.course_instance_id != activity.course_instance_id or question.status != "ready":
        raise HTTPException(409, "个人题单中的题目已不可用，请联系教师")
    return session, question


def record_attempt(db, session, activity, submission):
    items = [dict(item) for item in session.items]
    item = next(item for item in items if item["question_id"] == submission.question_id)
    first = item["status"] == "unanswered"
    item["last_attempt"] = 1 + max(i["last_attempt"] for i in items)
    item["status"] = "accepted" if submission.status == "accepted" else "wrong"
    if first and item["status"] == "wrong":
        point = item["knowledge_point_id"]
        pool = candidate_pool(db, activity).get(point, {})
        unused = set(pool).difference(i["question_id"] for i in items)
        if unused:
            goal = next(goal for goal in activity.content["practice_rules"]["goals"] if goal["knowledge_point_id"] == point)
            passed = Counter(i["kind"] for i in items if i["status"] == "accepted" and i["knowledge_point_id"] == point)
            preferred = [qid for qid in unused if passed[pool[qid]] < goal["by_kind"].get(pool[qid], 0)]
            qid = SystemRandom().choice(preferred or list(unused))
            items.append(_item(point, qid, pool[qid], appended=True))
    session.items = items
