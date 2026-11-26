"""Stable identifiers and typed references for isolated classroom courses."""
from copy import deepcopy

from sqlalchemy import select, text

from .models import (
    Activity, Chapter, CourseExample, CourseInstance, KnowledgePoint, Material, Question,
)

CONTENT_MODELS = (Chapter, KnowledgePoint, Material, Question, Activity, CourseExample)
MODEL_NAMES = {Chapter: "chapter", KnowledgePoint: "knowledge_point", Material: "material", Question: "question",
               Activity: "activity", CourseExample: "example"}


def classroom_course(db, classroom_id):
    from .models import Classroom
    return db.scalar(select(CourseInstance).join(Classroom, Classroom.course_id == CourseInstance.id).where(Classroom.id == classroom_id))


def content_mapping(db, instance):
    """Stable source IDs to runtime PKs, independently for each content kind."""
    return {MODEL_NAMES[model]: {row.stable_id: row.id
            for row in db.scalars(select(model).where(model.course_instance_id == instance.id))} for model in CONTENT_MODELS}


def lock_content_tables(db):
    if db.get_bind().dialect.name != "postgresql":
        return
    # Import sources have explicit integer IDs; do not let an unadvanced sequence
    # collide with those retained sources. Table names are internal constants.
    for table in ("chapters", "knowledge_points", "materials", "course_examples"):
        db.execute(text(f"LOCK TABLE {table} IN SHARE ROW EXCLUSIVE MODE"))
        db.execute(text(f"""SELECT setval(pg_get_serial_sequence('{table}', 'id'),
            GREATEST(COALESCE((SELECT MAX(id) FROM {table}), 1),
                     nextval(pg_get_serial_sequence('{table}', 'id'))), true)"""))


def _lookup(maps, kind, value):
    if value is None:
        return None
    result = maps[kind].get(value)
    if result is None:
        raise ValueError(f"课程引用缺失或不属于当前教师：{kind}")
    return result


def remap_references(value, maps, context=None):
    """Rewrite only typed references; never replace text, answers, node or event IDs."""
    scalar = {"chapter_id": "chapter", "material_id": "material", "document_id": "material",
              "activity_id": "activity", "question_id": "question", "knowledge_point_id": "knowledge_point"}
    lists = {"chapter_ids": "chapter", "question_ids": "question", "knowledge_point_ids": "knowledge_point"}
    if isinstance(value, list):
        return [remap_references(item, maps, context) for item in value]
    if not isinstance(value, dict):
        return deepcopy(value)
    result = {}
    for key, item in value.items():
        if key in scalar:
            result[key] = _lookup(maps, scalar[key], item)
        elif key in lists and isinstance(item, list):
            result[key] = [_lookup(maps, lists[key], ref) for ref in item]
        elif key == "id" and context == "chapter":
            result[key] = _lookup(maps, context, item)
        else:
            result[key] = remap_references(item, maps, key)
    return result
