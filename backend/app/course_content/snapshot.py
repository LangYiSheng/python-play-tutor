"""Capture a consistent portable content snapshot for editing and package exchange."""

import hashlib
from collections import defaultdict
from copy import deepcopy

from sqlalchemy import select

from app.course_content.resources import resource_payload
from app.practice_rules import without_legacy_retry_interval
from app.auth import as_utc
from app.course_exchange_models import CoursePackageState
from app.course_instances import CONTENT_MODELS, MODEL_NAMES, remap_references
from app.models import (
    Activity,
    ActivityQuestion,
    Chapter,
    ChapterRelease,
    CourseExample,
    KnowledgePoint,
    Material,
    MaterialChapter,
    Npc,
    QuestDefinition,
    Question,
    QuestionChapter,
    QuestionKnowledgePoint,
    QuestionSecret,
    StoryDefinition,
)

FIELDS = {
    Chapter: ("title", "order_index"),
    KnowledgePoint: ("chapter_id", "title", "content"),
    Material: ("title", "kind", "content", "status", "error"),
    Question: ("title", "kind", "prompt", "options", "samples", "hints", "starter_code", "source", "source_type", "status", "interactive"),
    Npc: ("name", "portrait", "sprite", "persona", "placement", "appearance_condition"),
    Activity: ("chapter_id", "title", "kind", "npc_key", "assistant_allowed", "content"),
    QuestDefinition: ("chapter_id", "title", "definition"),
    StoryDefinition: ("chapter_id", "quest_id", "content"),
    CourseExample: ("content",),
}


def content_rows(db, instance):
    return {model: list(db.scalars(select(model).where(model.course_instance_id == instance.id))) for model in CONTENT_MODELS}


def row_key(row):
    return row.key if isinstance(row, Npc) else row.id


def stable_id(row):
    return row.stable_id or str(row_key(row))


def _grouped_ids(db, instance, parent, source, target, *, order=None):
    query = (select(source, target).join(parent, parent.id == source)
             .where(parent.course_instance_id == instance.id).order_by(source, target if order is None else order))
    groups = defaultdict(list)
    for key, value in db.execute(query):
        groups[key].append(value)
    return groups


def snapshot_content(db, instance, *, include_secrets=True):
    rows = content_rows(db, instance)
    material_chapters = _grouped_ids(db, instance, Material, MaterialChapter.material_id, MaterialChapter.chapter_id)
    question_chapters = _grouped_ids(db, instance, Question, QuestionChapter.question_id, QuestionChapter.chapter_id)
    question_points = _grouped_ids(db, instance, Question, QuestionKnowledgePoint.question_id, QuestionKnowledgePoint.knowledge_point_id)
    activity_questions = _grouped_ids(db, instance, Activity, ActivityQuestion.activity_id, ActivityQuestion.question_id, order=ActivityQuestion.order_index)
    secret_rows = {}
    if include_secrets:
        secret_rows = {row.question_id: row for row in db.scalars(
            select(QuestionSecret).join(Question, Question.id == QuestionSecret.question_id).where(Question.course_instance_id == instance.id))}
    state = db.get(CoursePackageState, instance.id)
    configuration = deepcopy(state.configuration) if state else {}
    stored_assets = {asset["storage_key"]: asset for asset in configuration.get("_assets", [])}
    inverse = {MODEL_NAMES[model]: {row_key(row): stable_id(row) for row in items} for model, items in rows.items()}
    data = {kind: [] for kind in MODEL_NAMES.values()}
    secrets = []
    for model, items in rows.items():
        for row in items:
            values = {field: deepcopy(getattr(row, field)) for field in FIELDS[model]}
            if model is Material:
                asset_id = stored_assets.get(row.storage_key, {}).get("id", "material-" + hashlib.sha256(stable_id(row).encode()).hexdigest()[:32])
                preview_key = values["content"].pop("preview_key", None)
                preview_id = stored_assets.get(preview_key, {}).get("id", "preview-" + hashlib.sha256(stable_id(row).encode()).hexdigest()[:32])
                values.update(
                    chapter_ids=material_chapters[row.id],
                    asset_id=asset_id if row.storage_key else None,
                    preview_asset_id=preview_id if preview_key else None,
                )
            elif model is Question:
                values.update(
                    chapter_ids=question_chapters[row.id],
                    knowledge_point_ids=question_points[row.id],
                )
                if include_secrets:
                    secret = secret_rows.get(row.id)
                    secrets.append(
                        {
                            "id": stable_id(row),
                            "answer": deepcopy(secret.answer) if secret else None,
                            "hidden_cases": deepcopy(secret.hidden_cases) if secret else [],
                        }
                    )
            elif model is Activity:
                if "practice_rules" in values["content"]:
                    values["content"]["practice_rules"] = without_legacy_retry_interval(values["content"]["practice_rules"])
                values["question_ids"] = activity_questions[row.id]
                values["resources"] = [resource_payload(item) for item in row.resources]
            converted = values if model is Npc else remap_references(values, inverse)
            if model is QuestDefinition:
                converted["definition"]["id"] = stable_id(row)
            if model in {KnowledgePoint, CourseExample} and "id" in converted["content"]:
                converted["content"]["id"] = stable_id(row)
            data[MODEL_NAMES[model]].append({"id": stable_id(row), **converted})
    releases = []
    for row in db.scalars(select(ChapterRelease).where(ChapterRelease.classroom_id == instance.classroom_id)):
        if row.chapter_id not in inverse["chapter"]:
            continue
        releases.append(
            {
                "chapter_id": inverse["chapter"][row.chapter_id],
                "status": row.status,
                "opens_at": as_utc(row.opens_at).isoformat() if row.opens_at else None,
                "prerequisite_chapter_id": inverse["chapter"].get(row.prerequisite_chapter_id),
            }
        )
    return data, secrets, releases, configuration, rows
