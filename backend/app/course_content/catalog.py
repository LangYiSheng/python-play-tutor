"""Read teacher chapter and knowledge-point catalogues."""

from app.course_content.resources import resource_payload
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.practice_rules import without_legacy_retry_interval
from app.models import Activity, ActivityQuestion, Chapter, KnowledgePoint, Npc, Question, User
from app.teacher_scope import teacher_instance_id


def visible_points(instance_id, user):
    query = select(KnowledgePoint).join(Chapter, Chapter.id == KnowledgePoint.chapter_id).where(
        KnowledgePoint.course_instance_id == instance_id, Chapter.course_instance_id == instance_id)
    if user.role != "admin":
        query = query.where((KnowledgePoint.owner_id.is_(None) | (KnowledgePoint.owner_id == user.id))
                            & (Chapter.owner_id.is_(None) | (Chapter.owner_id == user.id)))
    return query


def point_payload(point):
    return {"id": point.id, "chapter_id": point.chapter_id, "title": point.title, "content": point.content, "owner_id": point.owner_id}


def point_detail(db, user, course_id, point_id):
    point = db.scalar(visible_points(teacher_instance_id(db, user, course_id), user).where(KnowledgePoint.id == point_id))
    if point is None:
        raise HTTPException(404, "知识点不存在")
    return point_payload(point)


def selected_point_labels(db, user, course_id, ids):
    query = visible_points(teacher_instance_id(db, user, course_id), user).where(KnowledgePoint.id.in_(ids)).with_only_columns(
        KnowledgePoint.id, KnowledgePoint.chapter_id, KnowledgePoint.title)
    return [dict(row) for row in db.execute(query).mappings()]


def page_window(db, query, page, size, *, total=None):
    if total is None:
        total = db.scalar(select(func.count()).select_from(query.order_by(None).subquery()))
    current = min(page, max(1, (total + size - 1) // size))
    return {"page": current, "total": total}, query.limit(size).offset((current - 1) * size)


def point_page(db, user, course_id, page, size, search, chapter_id):
    query = visible_points(teacher_instance_id(db, user, course_id), user)
    if search.strip():
        query = query.where(KnowledgePoint.title.icontains(search.strip(), autoescape=True))
    if chapter_id is not None:
        query = query.where(KnowledgePoint.chapter_id == chapter_id)
    meta, window = page_window(db, query.order_by(KnowledgePoint.id), page, size)
    return {**meta, "items": [point_payload(point) for point in db.scalars(window)]}


def teacher_courses(db: Session, user: User, course_id: int | None = None, view="full"):
    instance_id = teacher_instance_id(db, user, course_id)
    chapters = [
        {"id": c.id, "title": c.title, "order_index": c.order_index, "prerequisite_chapter_id": c.prerequisite_chapter_id, "owner_id": c.owner_id}
        for c in db.scalars(
            select(Chapter)
            .where(Chapter.course_instance_id == instance_id)
            .where(True if user.role == "admin" else (Chapter.owner_id.is_(None)) | (Chapter.owner_id == user.id))
            .order_by(Chapter.order_index)
        )
    ]
    if view == "chapters":
        return {"chapters": chapters}
    points = [point_payload(point) for point in db.scalars(visible_points(instance_id, user).order_by(KnowledgePoint.id))]
    activities = select(Activity).where(Activity.course_instance_id == instance_id)
    if user.role != "admin":
        activities = activities.where(Activity.owner_id.is_(None) | (Activity.owner_id == user.id))
    links = select(ActivityQuestion.activity_id, Question.id).join(Question, Question.id == ActivityQuestion.question_id).where(
        ActivityQuestion.activity_id.in_(activities.with_only_columns(Activity.id))).order_by(ActivityQuestion.activity_id, ActivityQuestion.order_index, Question.id)
    by_activity = {}
    for activity_id, question_id in db.execute(links):
        by_activity.setdefault(activity_id, []).append(question_id)
    return {
        "chapters": chapters,
        "knowledge_points": points,
        "activities": [
            {
                "id": a.id,
                "chapter_id": a.chapter_id,
                "title": a.title,
                "kind": a.kind,
                "npc_key": a.npc_key,
                "assistant_allowed": a.assistant_allowed,
                "resources": [resource_payload(row) for row in a.resources],
                "owner_id": a.owner_id,
                "knowledge_point_ids": a.content.get("knowledge_point_ids", []),
                "practice_rules": without_legacy_retry_interval(a.content.get("practice_rules")),
                "published": a.content.get("published", True),
                "question_ids": by_activity.get(a.id, []),
            }
            for a in db.scalars(activities)
        ],
        "npcs": [
            {"key": n.key, "name": n.name, "map_key": n.map_key, "tile_x": n.tile_x, "tile_y": n.tile_y}
            for n in db.scalars(select(Npc).where(Npc.course_instance_id == instance_id))
        ],
    }
