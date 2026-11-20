"""Read-only, classroom-scoped navigation. Page evidence is resolved only on selection."""

from collections import defaultdict
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import JSON, String, case, cast, func, literal, select, type_coerce
from sqlalchemy.orm import Session, load_only

from app.auth import require_teacher
from app.course_content.catalog import visible_points
from app.db import get_db
from app.materials.access import teacher_material
from app.models import Chapter, CourseInstance, KnowledgePoint, Material, MaterialChapter, Question, QuestionKnowledgePoint, User
from app.narration import repository
from app.narration.jobs import state as job_state
from app.narration.management import run_state, snapshot
from app.narration.models import NarrationJob, NarrationRun, PageContent, PageNarration
from app.teacher_scope import teacher_instance_id

router = APIRouter(prefix="/course-graph")
Db = Annotated[Session, Depends(get_db)]
Teacher = Annotated[User, Depends(require_teacher)]


def visible(model, instance, user):
    stmt = select(model).where(model.course_instance_id == instance, model.deleted_at.is_(None))
    if user.role != "admin":
        stmt = stmt.where(model.owner_id.is_(None) | (model.owner_id == user.id))
    return stmt


@router.get("")
def overview(classroom_id: int, db: Db, user: Teacher):
    instance = teacher_instance_id(db, user, classroom_id)
    chapters = visible(Chapter, instance, user).with_only_columns(Chapter.id, Chapter.title).order_by(Chapter.order_index)
    materials = visible(Material, instance, user).with_only_columns(Material.id, Material.title, Material.kind, Material.status)
    links = defaultdict(list)
    for material_id, chapter_id in db.execute(select(MaterialChapter.material_id, MaterialChapter.chapter_id).where(
            MaterialChapter.material_id.in_(materials.with_only_columns(Material.id)),
            MaterialChapter.chapter_id.in_(chapters.with_only_columns(Chapter.id)))):
        links[material_id].append(chapter_id)
    return {"title": db.get(CourseInstance, instance).name,
            "chapters": [dict(row) for row in db.execute(chapters).mappings()],
            "materials": [dict(row, chapter_ids=links[row.id]) for row in db.execute(materials.order_by(Material.id)).mappings()]}


@router.get("/tasks")
def active_tasks(classroom_id: int, db: Db, user: Teacher):
    materials = visible(Material, teacher_instance_id(db, user, classroom_id), user).with_only_columns(Material.id)
    query = (select(NarrationJob, Material, NarrationRun.id, NarrationRun.cancel_requested_at)
             .join(Material, Material.id == NarrationJob.material_id)
             .outerjoin(NarrationRun, (NarrationRun.material_id == Material.id) & (NarrationRun.started_at == NarrationJob.started_at))
             .options(load_only(Material.id, Material.title, Material.kind)).where(Material.id.in_(materials)))
    status = run_state(NarrationJob)
    active = query.where(status == "running").order_by(NarrationJob.started_at, NarrationJob.id)
    recent = query.where(status.in_(("failed", "interrupted", "cancelled"))).order_by(
        NarrationJob.started_at.desc(), NarrationJob.id.desc()).limit(30)
    items = []
    for job, material, run_id, requested in [*db.execute(active), *db.execute(recent)]:
        item = {**job_state(material.id, job), **snapshot(material, job, cancel_requested=requested is not None)}
        item["run_id"] = run_id
        item["cancellable"] = bool(run_id and item["cancellable"])
        item["percent"] = (min(100, max(0, round(100 * item["done"] / item["total"]))) if item["total"] else
                           0 if item["queued"] else None)
        if item["status"] == "cancelling":
            item["message"] = "已请求取消，等待当前步骤结束"
        items.append(item)
    return items


def array_rows(db, column, *, text=False):
    """Missing or non-array optional metadata in imported definitions contributes no rows."""
    if db.get_bind().dialect.name == "postgresql":
        expand = func.json_array_elements_text if text else func.json_array_elements
        valid = func.json_typeof(column) == "array"
    else:
        expand = func.json_each
        valid = func.json_type(column) == "array"
    return expand(case((valid, column), else_=literal([], JSON))).table_valued("value", joins_implicitly=True)


def source_pages(db, instance, user, refs):
    """Imported page IDs are distinct from per-file page numbers. Never guess from a chapter."""
    if not refs:
        return {}
    pages = array_rows(db, Material.content["pages"])
    value = type_coerce(pages.c.value, JSON)
    page_id, page_no = cast(value["id"].as_string(), String), cast(value["page_no"].as_string(), String)
    document = Material.content["source"]["document_id"].as_string()
    lookup = (visible(Material, instance, user)
              .with_only_columns(Material.id, page_id.label("ref"), page_no.label("page"))
              .select_from(Material, pages)
              .where(page_id.in_([str(ref) for ref in refs]), (page_id != page_no) | document.is_not(None)))
    owners = defaultdict(list)
    for material_id, ref, page in db.execute(lookup):
        if page and page.isdecimal() and int(page) > 0:
            owners[int(ref)].append((material_id, int(page)))
    return {ref: records[0] for ref, records in owners.items() if len(records) == 1}


def page_refs(values):
    return {ref for ref in values if type(ref) is int and ref > 0} if isinstance(values, list) else set()


@router.get("/materials/{material_id}")
def material_detail(material_id: int, classroom_id: int, db: Db, user: Teacher):
    instance = teacher_instance_id(db, user, classroom_id)
    material = teacher_material(db, user, material_id, instance_id=instance)
    pages = repository.page_map(material)
    source = material.content.get("source")
    imported = isinstance(source, dict) and source.get("document_id") is not None
    refs = page_refs([page.get("id") for no, page in pages.items() if imported or page.get("id") != no])
    unique = {ref: page for ref, (mid, page) in source_pages(db, instance, user, refs).items() if mid == material_id}
    points = []
    if unique:
        references = array_rows(db, KnowledgePoint.content["page_refs"], text=True)
        ref = cast(references.c.value, String)
        stmt = (visible_points(instance, user).select_from(KnowledgePoint, references)
                .with_only_columns(KnowledgePoint.id, KnowledgePoint.title, KnowledgePoint.chapter_id, ref)
                .where(ref.in_([str(key) for key in unique])).order_by(KnowledgePoint.title, KnowledgePoint.id))
        matched = defaultdict(set)
        for pid, title, chapter_id, key in db.execute(stmt):
            matched[pid, title, chapter_id].add(unique[int(key)])
        points = [{"id": pid, "title": title, "chapter_id": cid, "pages": sorted(nos)}
                  for (pid, title, cid), nos in matched.items()]
    counts = {"narrations": 0, "drafts": 0, "audio": 0}
    records = db.execute(select(PageNarration, PageContent).outerjoin(PageContent,
              (PageNarration.material_id == PageContent.material_id) & (PageNarration.page_no == PageContent.page_no))
              .where(PageNarration.material_id == material_id))
    for item, digest in records:
        if item.page_no not in pages or not item.text.strip():
            continue
        counts["narrations"] += 1
        fingerprint = repository.narration_page_hash(material, item.page_no, pages[item.page_no].get("text"), digest)
        if item.status == "draft" and item.page_hash == fingerprint:
            counts["drafts"] += 1
        if (item.status == "accepted" and item.page_hash == fingerprint and item.audio_key and
                item.audio_text_hash == repository.text_hash(item.text)):
            counts["audio"] += 1
    return {"points": points, "pages": len(pages), **counts}


@router.get("/points/{point_id}")
def point_detail(point_id: int, classroom_id: int, db: Db, user: Teacher):
    instance = teacher_instance_id(db, user, classroom_id)
    point = db.scalar(visible_points(instance, user).where(KnowledgePoint.id == point_id))
    if not point:
        raise HTTPException(404, "知识点不存在")
    evidence = defaultdict(list)
    for mid, page_no in source_pages(db, instance, user, page_refs(point.content.get("page_refs"))).values():
        evidence[mid].append(page_no)
    questions = (visible(Question, instance, user).join(QuestionKnowledgePoint)
                 .where(QuestionKnowledgePoint.knowledge_point_id == point_id).with_only_columns(func.count(Question.id)))
    return {"id": point.id, "title": point.title, "chapter_id": point.chapter_id, "questions": db.scalar(questions),
            "sources": [{"material_id": mid, "pages": sorted(pages)} for mid, pages in evidence.items()]}
