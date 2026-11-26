"""Read-only, classroom-scoped navigation. Page evidence is resolved only on selection."""

from collections import defaultdict
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import JSON, Integer, String, case, cast, func, literal, select, type_coerce, union_all
from sqlalchemy.orm import Session, load_only

from app.auth import require_teacher
from app.course_content.catalog import page_window, visible_points
from app.db import get_db
from app.materials.access import teacher_material
from app.models import Chapter, CourseInstance, KnowledgePoint, Material, MaterialChapter, Question, QuestionChapter, QuestionKnowledgePoint, User
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
def overview(course_id: int, db: Db, user: Teacher):
    instance = teacher_instance_id(db, user, course_id)
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


@router.get("/search")
def search_content(course_id: int, db: Db, user: Teacher, search: Annotated[str, Query(max_length=240)],
                   kind: Literal["all", "chapter", "material", "point", "question"] = "all",
                   page: Annotated[int, Query(ge=1)] = 1, size: Annotated[int, Query(ge=1, le=50)] = 10):
    instance = teacher_instance_id(db, user, course_id)
    term = search.strip()
    if not term:
        return {"page": 1, "total": 0, "items": []}

    branches = []
    for label, model in (("chapter", Chapter), ("material", Material), ("point", KnowledgePoint), ("question", Question)):
        if kind not in ("all", label):
            continue
        title_match = model.title.icontains(term, autoescape=True)
        match = title_match
        chapter_id = literal(None, Integer)
        query = visible(model, instance, user)
        if model is KnowledgePoint:
            query = visible_points(instance, user).where(KnowledgePoint.deleted_at.is_(None), Chapter.deleted_at.is_(None))
            chapter_id = KnowledgePoint.chapter_id
        elif model is Question:
            match = title_match | Question.prompt.icontains(term, autoescape=True)
        priority = case((func.lower(model.title) == term.lower(), 0), (title_match, 1), else_=2)
        branches.append(query.where(match).with_only_columns(
            literal(label).label("kind"), cast(model.id, String).label("id"), model.title.label("title"),
            chapter_id.label("chapter_id"), priority.label("priority")))

    matches = union_all(*branches).subquery()
    rows = select(matches.c.kind, matches.c.id, matches.c.title, matches.c.chapter_id).order_by(
        matches.c.priority, matches.c.title, matches.c.kind, matches.c.id)
    meta, window = page_window(db, rows, page, size)
    return {**meta, "items": [dict(row, id=row.id if row.kind == "question" else int(row.id))
                              for row in db.execute(window).mappings()]}


@router.get("/questions/{question_id:path}")
def question_detail(question_id: str, course_id: int, db: Db, user: Teacher):
    instance = teacher_instance_id(db, user, course_id)
    question = db.execute(visible(Question, instance, user).where(Question.id == question_id).with_only_columns(
        Question.id, Question.title, Question.kind, Question.status, Question.source_type, Question.prompt,
        Question.source)).mappings().one_or_none()
    if question is None:
        raise HTTPException(404, "题目不存在")
    chapters = (visible(Chapter, instance, user).join(QuestionChapter, QuestionChapter.chapter_id == Chapter.id)
                .where(QuestionChapter.question_id == question_id).with_only_columns(Chapter.id)
                .order_by(Chapter.order_index, Chapter.id))
    points = (visible_points(instance, user).join(QuestionKnowledgePoint, QuestionKnowledgePoint.knowledge_point_id == KnowledgePoint.id)
              .where(QuestionKnowledgePoint.question_id == question_id, Chapter.deleted_at.is_(None), KnowledgePoint.deleted_at.is_(None))
              .with_only_columns(KnowledgePoint.id, KnowledgePoint.title, KnowledgePoint.chapter_id)
              .order_by(Chapter.order_index, KnowledgePoint.title, KnowledgePoint.id))

    evidence = defaultdict(set)
    source = question.source or {}
    material_id, page_no = source.get("material_id"), source.get("page_no")
    if type(material_id) is int:
        material = db.scalar(visible(Material, instance, user).where(Material.id == material_id)
                             .options(load_only(Material.id, Material.content)))
        if material is not None:
            pages = evidence[material_id]
            if type(page_no) is int and page_no in repository.page_map(material):
                pages.add(page_no)
    else:
        for mid, number in source_pages(db, instance, user, page_refs(source.get("page_ids"))).values():
            evidence[mid].add(number)
    result = {key: question[key] for key in ("id", "title", "kind", "status", "source_type", "prompt")}
    return {**result, "chapter_ids": list(db.scalars(chapters)), "points": list(db.execute(points).mappings()),
            "sources": [{"material_id": mid, "pages": sorted(pages)} for mid, pages in evidence.items()]}


@router.get("/tasks")
def active_tasks(course_id: int, db: Db, user: Teacher):
    materials = visible(Material, teacher_instance_id(db, user, course_id), user).with_only_columns(Material.id)
    query = (select(NarrationJob, Material, NarrationRun.id, NarrationRun.cancel_requested_at)
             .join(Material, Material.id == NarrationJob.material_id)
             .outerjoin(NarrationRun, (NarrationRun.material_id == Material.id) & (NarrationRun.started_at == NarrationJob.started_at))
             .options(load_only(Material.id, Material.title, Material.kind)).where(Material.id.in_(materials)))
    status = run_state(NarrationJob)
    active = query.where(status == "running").order_by(NarrationJob.started_at, NarrationJob.id)
    recent = query.where(status.in_(("failed", "interrupted", "cancelled")),
                         ~func.coalesce(NarrationJob.progress["queue_dismissed"].as_boolean(), False)).order_by(
        NarrationJob.started_at.desc(), NarrationJob.id.desc()).limit(30)
    items = []
    for job, material, run_id, requested in [*db.execute(active), *db.execute(recent)]:
        item = {**job_state(material.id, job), **snapshot(material, job, cancel_requested=requested is not None, latest_db=db)}
        item["run_id"] = run_id
        item["cancellable"] = bool((run_id or item["status"] == "failed") and item["cancellable"])
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
def material_detail(material_id: int, course_id: int, db: Db, user: Teacher):
    instance = teacher_instance_id(db, user, course_id)
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
def point_detail(point_id: int, course_id: int, db: Db, user: Teacher):
    instance = teacher_instance_id(db, user, course_id)
    point = db.scalar(visible_points(instance, user).where(KnowledgePoint.id == point_id))
    if not point:
        raise HTTPException(404, "知识点不存在")
    evidence = defaultdict(list)
    for mid, page_no in source_pages(db, instance, user, page_refs(point.content.get("page_refs"))).values():
        evidence[mid].append(page_no)
    lectio_meta = (point.content or {}).get("lectio")
    if isinstance(lectio_meta, dict) and isinstance(lectio_meta.get("sources"), list):
        stable_ids = [
            src.get("material_stable_id")
            for src in lectio_meta["sources"]
            if isinstance(src, dict) and isinstance(src.get("material_stable_id"), str) and src.get("material_stable_id")
        ]
        if stable_ids:
            mat_by_stable = {
                row.stable_id: row.id
                for row in db.scalars(
                    visible(Material, instance, user)
                    .where(Material.stable_id.in_(stable_ids))
                    .options(load_only(Material.id, Material.stable_id))
                )
            }
            for src in lectio_meta["sources"]:
                if not isinstance(src, dict):
                    continue
                mid = mat_by_stable.get(src.get("material_stable_id"))
                if mid is not None and isinstance(src.get("pages"), list):
                    evidence[mid].extend(p for p in src["pages"] if type(p) is int and p > 0)
    questions = (visible(Question, instance, user).join(QuestionKnowledgePoint)
                 .where(QuestionKnowledgePoint.knowledge_point_id == point_id).with_only_columns(func.count(Question.id)))
    return {"id": point.id, "title": point.title, "chapter_id": point.chapter_id, "questions": db.scalar(questions),
            "sources": [{"material_id": mid, "pages": sorted(set(pages))} for mid, pages in evidence.items()]}
