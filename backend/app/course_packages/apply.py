"""Apply validated content and media mappings inside the caller-owned transaction."""

import hashlib
from copy import deepcopy
from datetime import datetime
from uuid import uuid4

from sqlalchemy import delete, select

from app.course_packages.snapshot import FIELDS, content_rows, stable_id
from app.course_exchange_models import CoursePackageState
from app.course_instances import MODEL_NAMES, content_mapping, lock_content_tables, remap_references
from app.course_packages.contracts import PACKAGE_MODELS
from app.course_packages.manifest import PackageError
from app.materials.storage import get_storage
from app.models import (
    Activity,
    ActivityQuestion,
    ActivityMaterial,
    Chapter,
    ChapterRelease,
    CourseExample,
    KnowledgePoint,
    Material,
    MaterialChapter,
    Question,
    QuestionChapter,
    QuestionKnowledgePoint,
    QuestionSecret,
)


def _delete_content(db, instance, incoming):
    rows = content_rows(db, instance)
    removing = {model: [row.id for row in values if stable_id(row) not in incoming[MODEL_NAMES[model]]] for model, values in rows.items()}
    # All relation removals are explicit; never depend on database cascades for learner rows.
    for relation, field, model in (
        (ActivityQuestion, ActivityQuestion.activity_id, Activity),
        (ActivityMaterial, ActivityMaterial.activity_id, Activity),
        (ActivityMaterial, ActivityMaterial.material_id, Material),
        (ActivityQuestion, ActivityQuestion.question_id, Question),
        (QuestionSecret, QuestionSecret.question_id, Question),
        (QuestionKnowledgePoint, QuestionKnowledgePoint.question_id, Question),
        (QuestionKnowledgePoint, QuestionKnowledgePoint.knowledge_point_id, KnowledgePoint),
        (QuestionChapter, QuestionChapter.question_id, Question),
        (QuestionChapter, QuestionChapter.chapter_id, Chapter),
        (MaterialChapter, MaterialChapter.material_id, Material),
        (MaterialChapter, MaterialChapter.chapter_id, Chapter),
    ):
        if removing[model]:
            db.execute(delete(relation).where(field.in_(removing[model])))
    for model in (Activity, Question, KnowledgePoint, Material, CourseExample, Chapter):
        if removing[model]:
            db.execute(delete(model).where(model.id.in_(removing[model])))
    db.flush()


def import_bundle(db, instance, bundle, root):
    """Caller holds exclusive classroom gate; caller owns the single commit/rollback."""
    manifest, data = bundle["manifest"], bundle["data"]
    replace = instance.package_id != manifest["package_id"]
    incoming = {kind: {row["id"] for row in rows} if not replace else set() for kind, rows in data.items()}
    chapters = list(db.scalars(select(Chapter).where(Chapter.course_instance_id == instance.id)))
    removed_chapters = [row.id for row in chapters if stable_id(row) not in incoming["chapter"]]
    db.execute(delete(ChapterRelease).where(ChapterRelease.chapter_id.in_(removed_chapters)))
    db.flush()
    if replace:
        _delete_content(db, instance, incoming)
        instance.created_at = datetime.fromisoformat(manifest["created_at"])
    existing = {model: {stable_id(row): row for row in rows} for model, rows in content_rows(db, instance).items()}
    maps = content_mapping(db, instance)
    lock_content_tables(db)
    # Vacate order slots first, so swapping chapter positions is atomic and conflict-free.
    for index, row in enumerate(existing[Chapter].values()):
        row.order_index = -index - 1
    db.flush()
    pairs = {}
    for model in PACKAGE_MODELS:
        kind, pairs[model] = MODEL_NAMES[model], []
        for source in data[kind]:
            row = existing[model].get(source["id"])
            if row is None:
                values = {field: deepcopy(source[field]) for field in FIELDS[model] if field in source}
                for field, target in (("chapter_id", "chapter"), ("material_id", "material")):
                    if field in values and values[field] is not None:
                        values[field] = maps[target][values[field]]
                for field in ("content", "definition"):
                    if field in values:
                        values[field] = {}
                if hasattr(model, "owner_id"):
                    values["owner_id"] = instance.teacher_id
                if model in {Question, Activity}:
                    values["id"] = f"c{instance.id}-{uuid4().hex[:16]}"
                row = model(course_instance_id=instance.id, stable_id=source["id"], **values)
                db.add(row)
                db.flush()
            maps[kind][source["id"]] = row.id
            pairs[model].append((source, row))
    adapter, assets = get_storage(), {}
    for asset in bundle["assets"]:
        source = root / asset["path"]
        key = f"course-assets/{asset['sha256']}{source.suffix.lower()}"
        if asset["path"].startswith("narrations/"):
            key = f"course-narrations/{instance.id}/{asset['id']}-{asset['sha256']}{source.suffix.lower()}"
        try:
            size = adapter.size(key)
        except Exception as exc:
            code = getattr(exc, "response", {}).get("Error", {}).get("Code")
            if not isinstance(exc, (FileNotFoundError, KeyError)) and code not in {"404", "NoSuchKey", "NotFound"}:
                raise PackageError("私有资源存储暂不可用") from exc
            _store_file(adapter, key, source)
        else:
            digest = hashlib.sha256()
            for chunk in adapter.chunks(key, 0, size - 1):
                digest.update(chunk)
            if size != asset["size_bytes"] or digest.hexdigest() != asset["sha256"]:
                raise PackageError("私有资源存储校验失败，未覆盖已有资源")
        assets[asset["id"]] = {**asset, "storage_key": key}
    for model, values in pairs.items():
        for source, row in values:
            fields = {field: source[field] for field in FIELDS[model] if field in source}
            converted = remap_references(fields, maps)
            if model is Activity and "practice_rules" in converted["content"]:
                from app.practice_rules import PracticeRules
                converted["content"]["practice_rules"] = PracticeRules.model_validate(converted["content"]["practice_rules"]).model_dump()
            if model in {KnowledgePoint, CourseExample} and "id" in converted["content"]:
                converted["content"]["id"] = row.id
            for field, value in converted.items():
                setattr(row, field, value)
            if model is Material:
                row.storage_key = assets[source["asset_id"]]["storage_key"] if source["asset_id"] else None
                if source["preview_asset_id"]:
                    row.content = {**row.content, "preview_key": assets[source["preview_asset_id"]]["storage_key"]}
    db.flush()
    from app.course_packages.narrations import import_narrations

    import_narrations(db, bundle, maps, assets)
    relations = (
        (Question, QuestionChapter, "question_id", "chapter_ids", "chapter_id", "chapter"),
        (Question, QuestionKnowledgePoint, "question_id", "knowledge_point_ids", "knowledge_point_id", "knowledge_point"),
        (Activity, ActivityQuestion, "activity_id", "question_ids", "question_id", "question"),
    )
    for model, relation, field, source_field, target_field, kind in relations:
        for source, row in pairs[model]:
            db.execute(delete(relation).where(getattr(relation, field) == row.id))
            for index, key in enumerate(source[source_field]):
                values = {field: row.id, target_field: maps[kind][key]}
                if relation is ActivityQuestion:
                    values["order_index"] = index
                db.add(relation(**values))
    for source, material in pairs[Material]:
        points = {maps["chapter"][p["chapter_id"]]: p for p in source["task_points"]}
        links = {link.chapter_id: link for link in db.scalars(
            select(MaterialChapter).where(MaterialChapter.material_id == material.id))}
        for chapter_id, link in links.items():
            if chapter_id not in points:
                db.delete(link)
        for chapter_id, point in points.items():
            link = links.get(chapter_id)
            if link is None:
                link = MaterialChapter(material_id=material.id, chapter_id=chapter_id)
                db.add(link)
            link.required, link.rule, link.order_index = point["required"], deepcopy(point["rule"]), point["order_index"]
    for source in bundle["secrets"]:
        key = maps["question"][source["id"]]
        row = db.get(QuestionSecret, key)
        if row is None:
            row = QuestionSecret(question_id=key)
            db.add(row)
        row.answer, row.hidden_cases = deepcopy(source["answer"]), deepcopy(source["hidden_cases"])
    if not replace:
        db.flush()
        _delete_content(db, instance, incoming)
    state = db.get(CoursePackageState, instance.id)
    if state is None:
        state = CoursePackageState(course_instance_id=instance.id)
        db.add(state)
    state.configuration = {"_assets": list(assets.values())}
    instance.package_id, instance.name, instance.package_version = manifest["package_id"], manifest["name"], manifest["package_version"]
    instance.revision += 1
    db.flush()
    return instance


def _store_file(adapter, key, source):
    try:
        adapter.put(key, source)
    except Exception as exc:
        raise PackageError("私有资源写入失败，课程未发布") from exc
