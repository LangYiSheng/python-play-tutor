"""Locate chapters, materials and activities without granting completion."""

from fastapi import HTTPException, Request
from sqlalchemy import delete, select

from app.content_relations import activity_questions
from app.course_content.access import authorize_activity, authorize_material, chapter_available
from app.course_scope import course_clause
from app.experience.access import guard
from app.experience.contracts import Actor, ChapterInput, Db, OpenInput, Scope
from app.experience.state import definition_hash
from app.models import (
    Activity,
    Chapter,
    ChapterRelease,
    ExperienceCheckpoint,
    Material,
    MaterialChapter,
    PlayerPosition,
    PracticeSession,
)
from app.world_config import load_world_config, validate_point


def _question_count(db, user, classroom_id, activity):
    rules = activity.content.get("practice_rules")
    if not rules:
        return len(activity_questions(db, activity))
    session = db.get(PracticeSession, (user.id, classroom_id, activity.id))
    if session:
        return len(session.items)
    return sum(max(goal["total"], sum(goal["by_kind"].values())) for goal in rules["goals"])


def switch_chapter(body: ChapterInput, request: Request, db: Db, user: Actor):
    guard(db, user, body.classroom_id, request, mutate=True)
    chapter = db.scalar(select(Chapter).where(Chapter.id == body.chapter_id, course_clause(db, Chapter, body.classroom_id)))
    release = db.get(ChapterRelease, (body.classroom_id, body.chapter_id))
    from app.auth import as_utc
    from app.models import now

    if not chapter or not release or release.status != "published" or (release.opens_at and as_utc(release.opens_at) > now()):
        raise HTTPException(403, "章节尚未发布或未到开放时间，不能定位")
    return {"ok": True}


def overview(classroom_id: int, request: Request, db: Db, user: Actor):
    guard(db, user, classroom_id, request)
    chapters = []
    for chapter in db.scalars(select(Chapter).where(course_clause(db, Chapter, classroom_id)).order_by(Chapter.order_index)):
        release = db.get(ChapterRelease, (classroom_id, chapter.id))
        chapters.append(
            {
                "id": chapter.id,
                "title": chapter.title,
                "available": chapter_available(db, user, classroom_id, chapter.id),
                "status": release.status if release else "unpublished",
            }
        )
    materials = [
        {
            "id": row.id,
            "title": row.title,
            "kind": row.kind,
            "status": row.status,
            "pages": max(1, len((row.content or {}).get("pages", []))),
            "chapters": list(db.scalars(select(MaterialChapter.chapter_id).where(MaterialChapter.material_id == row.id))),
        }
        for row in db.scalars(select(Material).where(course_clause(db, Material, classroom_id)))
    ]
    activities = [
        {
            "id": row.id,
            "chapter_id": row.chapter_id,
            "title": row.title,
            "kind": row.kind,
            "published": row.content.get("published") is not False,
            "questions": _question_count(db, user, classroom_id, row),
        }
        for row in db.scalars(select(Activity).where(course_clause(db, Activity, classroom_id)))
    ]
    current_hash = definition_hash(db, classroom_id)
    checkpoints = [
        {"id": row.id, "name": row.name, "created_at": row.created_at.isoformat(), "valid": row.definition_hash == current_hash}
        for row in db.scalars(
            select(ExperienceCheckpoint)
            .where(ExperienceCheckpoint.user_id == user.id, ExperienceCheckpoint.classroom_id == classroom_id)
            .order_by(ExperienceCheckpoint.created_at.desc())
        )
    ]
    return {"chapters": chapters, "materials": materials, "activities": activities, "checkpoints": checkpoints}


def open_content(body: OpenInput, request: Request, db: Db, user: Actor):
    guard(db, user, body.classroom_id, request)
    if body.kind == "material":
        if not body.target.isdigit():
            raise HTTPException(422, "资料编号无效")
        material = authorize_material(db, user, body.classroom_id, int(body.target))
        if material.status != "ready":
            raise HTTPException(409, "资料尚未就绪")
        if body.page_no > max(1, len(material.content.get("pages", []))):
            raise HTTPException(422, "页码超出资料范围")
        return {"workspace": {"kind": "material", "material_id": material.id, "page_no": body.page_no, "video_time": body.video_time}}
    activity = authorize_activity(db, user, body.classroom_id, body.target)
    kind = "lesson" if activity.kind in {"lesson", "reading"} else "practice"
    if kind == "practice" and body.question_no > _question_count(db, user, body.classroom_id, activity):
        raise HTTPException(422, "题号超出活动范围")
    return {
        "workspace": {
            "kind": kind,
            "activity_id": activity.id,
            "page_no": body.page_no,
            "question_no": body.question_no,
            "video_time": body.video_time,
        }
    }


def return_to_spawn(body: Scope, request: Request, db: Db, user: Actor):
    guard(db, user, body.classroom_id, request, mutate=True)
    spawn = load_world_config()["default_spawn"]
    validate_point(spawn["map_key"], spawn["tile_x"], spawn["tile_y"])
    db.execute(delete(PlayerPosition).where(PlayerPosition.user_id == user.id, PlayerPosition.classroom_id == body.classroom_id))
    db.add(PlayerPosition(user_id=user.id, classroom_id=body.classroom_id, **spawn))
    db.commit()
    return {"ok": True, "user_id": user.id, "classroom_id": body.classroom_id}
