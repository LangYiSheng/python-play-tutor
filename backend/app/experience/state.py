"""Capture and replace scoped learner experience state."""

import hashlib
import json

from sqlalchemy import select

from app.course_scope import course_clause, instance_id
from app.models import (
    Activity,
    ActivityQuestion,
    Chapter,
    ChapterRelease,
    CourseInstance,
    Material,
    PlayerPosition,
    Question,
)
from app.world_config import load_world_config


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


def definition_hash(db, classroom_id):
    # Include current definitions, not only authoring revision: imports and media replacements also invalidate saves.
    result = {"world": load_world_config()}
    for model in (Chapter, Material, Activity, Question):
        result[model.__tablename__] = sorted(
            [
                {c.name: getattr(row, c.name) for c in model.__table__.columns
                 if not (model is Question and c.name == "interactive" and row.interactive is None)}
                for row in db.scalars(select(model).where(course_clause(db, model, classroom_id)))
            ],
            key=lambda row: str(row.get("id", row.get("key"))),
        )
    result["releases"] = [
        dict((c.name, getattr(row, c.name)) for c in ChapterRelease.__table__.columns)
        for row in db.scalars(select(ChapterRelease).where(ChapterRelease.classroom_id == classroom_id).order_by(ChapterRelease.chapter_id))
    ]
    result["revision"] = db.get(CourseInstance, instance_id(db, classroom_id)).revision
    result["activity_questions"] = [
        (row.activity_id, row.question_id, row.order_index)
        for row in db.scalars(
            select(ActivityQuestion)
            .join(Activity)
            .where(course_clause(db, Activity, classroom_id))
            .order_by(ActivityQuestion.activity_id, ActivityQuestion.order_index)
        )
    ]
    return digest(result)


POSITION_FIELDS = ("map_key", "tile_x", "tile_y", "direction")


def own_rows(db, model, user, classroom_id):
    return list(db.scalars(select(model).where(model.user_id == user.id, model.classroom_id == classroom_id)))


def snapshot(db, user, classroom_id):
    return {"player_positions": [{key: getattr(row, key) for key in POSITION_FIELDS}
                                 for row in own_rows(db, PlayerPosition, user, classroom_id)]}


def state_token(db, user, classroom_id):
    return digest([definition_hash(db, classroom_id), snapshot(db, user, classroom_id)])
