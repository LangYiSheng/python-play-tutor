"""Classroom review queue for reusable questions and page narrations."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import String, cast, literal, select, union_all
from sqlalchemy.orm import Session

from app.auth import require_teacher
from app.course_content.catalog import page_window
from app.course_content.question_contracts import QuestionUpdate
from app.course_content.questions import stage_question, updated_question_input
from app.db import get_db
from app.models import CourseInstance, Material, Question, User
from app.narration import repository
from app.narration.models import PageNarration
from app.teacher_scope import commit_content, teacher_instance_id

router = APIRouter(prefix="/teacher/classrooms/{classroom_id}/content-review", tags=["classrooms"])
Kind = Literal["question", "narration"]
Db = Annotated[Session, Depends(get_db)]
Teacher = Annotated[User, Depends(require_teacher)]


def question_scope(instance, user):
    return (Question.course_instance_id == instance, Question.deleted_at.is_(None), Question.status == "draft",
            True if user.role == "admin" else Question.owner_id == user.id)


def material_scope(instance, user):
    return (Material.course_instance_id == instance, Material.deleted_at.is_(None),
            Material.kind.in_(("presentation", "pdf")),
            True if user.role == "admin" else Material.owner_id.is_(None) | (Material.owner_id == user.id))


@router.get("")
def queue(classroom_id: int, db: Db, user: Teacher, kind: Kind | None = None,
          page: int = Query(1, ge=1), size: int = Query(10, ge=1, le=100)):
    instance = teacher_instance_id(db, user, classroom_id)
    questions = select(literal("question").label("kind"), Question.id.label("id"), Question.title.label("title"),
                       literal(0).label("page_no"), Question.source_type.label("source"),
                       Question.kind.label("question_kind")).where(*question_scope(instance, user))
    narrations = select(literal("narration").label("kind"), cast(PageNarration.id, String).label("id"), Material.title.label("title"),
                        PageNarration.page_no, PageNarration.source, literal("").label("question_kind")
                        ).join(Material, Material.id == PageNarration.material_id).where(*material_scope(instance, user),
                                                                                       PageNarration.status == "draft")
    queries = {"question": questions, "narration": narrations}
    rows = (queries[kind] if kind else union_all(questions, narrations)).subquery()
    meta, window = page_window(db, select(rows).order_by(rows.c.kind, rows.c.title, rows.c.page_no, rows.c.id), page, size)
    revision = str(db.get(CourseInstance, instance).revision)
    items = [dict(row, revision=revision) for row in db.execute(window).mappings()]
    question_ids = [item["id"] for item in items if item["kind"] == "question"]
    if question_ids:
        sources = dict(db.execute(select(Question.id, Question.source).where(Question.id.in_(question_ids))).all())
        material_ids = {source["material_id"] for source in sources.values() if type(source.get("material_id")) is int}
        labels = dict(db.execute(select(Material.id, Material.title).where(
            Material.id.in_(material_ids), Material.course_instance_id == instance,
            True if user.role == "admin" else Material.owner_id.is_(None) | (Material.owner_id == user.id))).all())
        for item in items:
            if item["kind"] == "question":
                source = sources.get(item["id"], {})
                mid = source.get("material_id")
                if type(mid) is int and mid in labels:
                    item.update(material_title=labels[mid], page_no=source.get("page_no") or 0)
    ids = [int(row["id"]) for row in items if row["kind"] == "narration"]
    if ids:
        records = select(PageNarration).where(PageNarration.id.in_(ids)).execution_options(populate_existing=True)
        revisions = {str(row.id): repository.revision(row) for row in db.scalars(records)}
        for item in items:
            if item["kind"] == "narration":
                item["revision"] = revisions.get(item["id"], "missing")
    return {**meta, "items": items}


def narration_row(db, instance, user, row_id, *, lock=False):
    if not row_id.isascii() or not row_id.isdecimal() or len(row_id) > 18:
        raise HTTPException(404, "讲解草稿不存在")
    query = select(PageNarration, Material).join(Material, Material.id == PageNarration.material_id).where(
        *material_scope(instance, user), PageNarration.id == int(row_id), PageNarration.status == "draft")
    query = query.execution_options(populate_existing=True)
    row = db.execute(query.with_for_update() if lock else query).one_or_none()
    if row is None:
        raise HTTPException(409, "讲解草稿已移出待审批，请刷新")
    return row


@router.get("/narrations/{row_id}")
def narration_detail(classroom_id: int, row_id: str, db: Db, user: Teacher):
    row, material = narration_row(db, teacher_instance_id(db, user, classroom_id), user, row_id)
    page = repository.page_map(material).get(row.page_no)
    digest = repository.content_row(db, material.id, row.page_no)
    return {**repository.snapshot(material, row, page, digest), "revision": repository.revision(row),
            "material_id": material.id, "source_changed": page is None or row.page_hash != repository.narration_hash(db, material, row.page_no)}


class ReviewItem(BaseModel):
    kind: Kind
    id: str = Field(min_length=1, max_length=100)
    revision: str = Field(min_length=1, max_length=100)


class Decision(BaseModel):
    items: list[ReviewItem] = Field(min_length=1, max_length=100)
    decision: Literal["accept", "reject"]
    text: str | None = Field(default=None, min_length=1, max_length=repository.MAX_TEXT)


@router.post("/decisions")
def decide(classroom_id: int, body: Decision, db: Db, user: Teacher):
    if len({(item.kind, item.id) for item in body.items}) != len(body.items):
        raise HTTPException(422, "审批范围包含重复项")
    if body.text is not None and (len(body.items) != 1 or body.items[0].kind != "narration" or body.decision != "accept"):
        raise HTTPException(422, "仅支持修改并接受一页讲解稿")
    instance = teacher_instance_id(db, user, classroom_id, exclusive=True)
    course_revision = str(db.get(CourseInstance, instance).revision)
    accepting = body.decision == "accept"
    try:
        for item in sorted(body.items, key=lambda i: (i.kind, i.id)):
            if item.kind == "question":
                question = db.scalar(select(Question).where(*question_scope(instance, user), Question.id == item.id).with_for_update())
                if question is None or item.revision != course_revision:
                    raise HTTPException(409, "课程或题目已变更，请刷新后重新确认")
                if accepting and question.kind == "interactive":
                    raise HTTPException(422, "交互练习题须在题目编辑器完成试答校验后设为可用")
                update = QuestionUpdate(status="ready" if accepting else "disabled")
                try:
                    stage_question(db, user, question, updated_question_input(db, question, user, update))
                except HTTPException as exc:
                    raise HTTPException(exc.status_code, f"「{question.title}」：{exc.detail}") from exc
            else:
                row, material = narration_row(db, instance, user, item.id, lock=True)
                if repository.revision(row) != item.revision:
                    raise HTTPException(409, "讲解稿已改变，请刷新后重新审阅")
                if row.page_no not in repository.page_map(material) or row.page_hash != repository.narration_hash(db, material, row.page_no):
                    raise HTTPException(409, "讲解来源页已变化，请在课件的讲解稿中重新审校")
                if body.text is not None:
                    repository.upsert(db, material, row.page_no, text=body.text, target_seconds=row.target_seconds)
                repository.decide(db, material, row.page_no, "accepted" if accepting else "rejected", user)
        commit_content(db, instance)
    except (ValueError, HTTPException) as exc:
        db.rollback()
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(422, str(exc)) from exc
    return {"count": len(body.items)}
