"""Classroom review queue for reusable questions and page narrations."""

import hashlib
import json
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, load_only

from app.auth import require_teacher
from app.course_content.catalog import page_window
from app.course_content.question_contracts import QuestionUpdate
from app.course_content.questions import stage_question, updated_question_input
from app.course_content.review_catalog import (Kind, draft_rows, draft_summary, grouped_page, material_draft_page,
                                              material_scope, question_scope, scope_name, visible)
from app.course_content.review_narrations import apply_narrations
from app.db import get_db
from app.models import Chapter, CourseInstance, Material, Question, User
from app.narration import repository
from app.narration.models import PageNarration
from app.teacher_scope import commit_content, teacher_instance_id

router = APIRouter(prefix="/teacher/classrooms/{classroom_id}/content-review", tags=["classrooms"])
Db = Annotated[Session, Depends(get_db)]
Teacher = Annotated[User, Depends(require_teacher)]


@router.get("/summary")
def summary(classroom_id: int, db: Db, user: Teacher):
    return draft_summary(db, teacher_instance_id(db, user, classroom_id), user)


@router.get("/materials")
def materials(classroom_id: int, db: Db, user: Teacher, page: int = Query(1, ge=1), size: int = Query(10, ge=1, le=100)):
    return material_draft_page(db, teacher_instance_id(db, user, classroom_id), user, page, size)


@router.get("/groups")
def chapter_groups(classroom_id: int, db: Db, user: Teacher, kind: Kind | None = None,
                   page: int = Query(1, ge=1), size: int = Query(10, ge=1, le=100)):
    return grouped_page(db, teacher_instance_id(db, user, classroom_id), user, kind, None, page, size)


@router.get("/groups/{chapter_id}/materials")
def material_groups(classroom_id: int, chapter_id: int, db: Db, user: Teacher, kind: Kind | None = None,
                    page: int = Query(1, ge=1), size: int = Query(10, ge=1, le=100)):
    return grouped_page(db, teacher_instance_id(db, user, classroom_id), user, kind, chapter_id, page, size)


def narration_revisions(db: Session, ids: list[int]) -> dict[str, str]:
    # Use bounded IN clauses even for a whole chapter of page drafts.
    revisions = {}
    for offset in range(0, len(ids), 500):
        records = select(PageNarration).where(PageNarration.id.in_(ids[offset:offset + 500])).options(
            load_only(PageNarration.id, PageNarration.text, PageNarration.status, PageNarration.page_hash, PageNarration.updated_at)
        ).execution_options(populate_existing=True)
        revisions.update((str(row.id), repository.revision(row)) for row in db.scalars(records))
    return revisions


@router.get("")
def queue(classroom_id: int, db: Db, user: Teacher, kind: Kind | None = None,
          chapter_id: int | None = Query(None, ge=0), material_id: int | None = Query(None, ge=0),
          page: int = Query(1, ge=1), size: int = Query(10, ge=1, le=100)):
    instance = teacher_instance_id(db, user, classroom_id)
    rows = draft_rows(db, instance, user, kind)
    query = select(rows)
    extra = {}
    if chapter_id is not None:
        extra["chapter_title"] = scope_name(db, Chapter, instance, user, chapter_id)
        query = query.where(rows.c.chapter_id == chapter_id)
    if material_id is not None:
        extra["material_title"] = scope_name(db, Material, instance, user, material_id)
        query = query.where(rows.c.material_id == material_id)
    meta, window = page_window(db, query.order_by(rows.c.kind, rows.c.title, rows.c.narration_page, rows.c.id), page, size)
    revision = str(db.scalar(select(CourseInstance.revision).where(CourseInstance.id == instance)))
    items = [dict(row, revision=revision) for row in db.execute(window).mappings()]
    labels = dict(db.execute(select(Material.id, Material.title).where(*visible(Material, instance, user),
                            Material.id.in_({i["material_id"] for i in items if i["material_id"]}))).all()) if items else {}
    revisions = narration_revisions(db, [int(row["id"]) for row in items if row["kind"] == "narration"])
    for item in items:
        item.pop("narration_page")
        page_text = item["page_no"] or ""
        item["page_no"] = int(page_text) if item["material_id"] and len(page_text) <= 9 and page_text.isdecimal() else 0
        if item["material_id"] in labels:
            item["material_title"] = labels[item["material_id"]]
        if item["kind"] == "narration":
            item["revision"] = revisions.get(item["id"], "missing")
    return {**meta, "items": items, **extra}


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


def apply_decision(db: Session, instance: int, user: User, items: list[ReviewItem], decision: Literal["accept", "reject"],
                   text: str | None = None):
    course_revision = str(db.scalar(select(CourseInstance.revision).where(CourseInstance.id == instance)))
    accepting = decision == "accept"
    try:
        apply_narrations(db, instance, user, [i for i in items if i.kind == "narration"],
                         "accepted" if accepting else "rejected", text)
        for item in sorted((i for i in items if i.kind == "question"), key=lambda i: i.id):
            question = db.scalar(select(Question).where(*question_scope(instance, user), Question.id == item.id)
                                 .with_for_update().execution_options(populate_existing=True))
            if question is None or item.revision != course_revision:
                raise HTTPException(409, "课程或题目已变更，请刷新后重新确认")
            if accepting and question.kind == "interactive":
                raise HTTPException(422, "交互练习题须在题目编辑器完成试答校验后设为可用")
            update = QuestionUpdate(status="ready" if accepting else "disabled")
            try:
                stage_question(db, user, question, updated_question_input(db, question, user, update))
            except HTTPException as exc:
                raise HTTPException(exc.status_code, f"「{question.title}」：{exc.detail}") from exc
        commit_content(db, instance)
    except (ValueError, HTTPException) as exc:
        db.rollback()
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(422, str(exc)) from exc
    return {"count": len(items)}


@router.post("/decisions")
def decide(classroom_id: int, body: Decision, db: Db, user: Teacher):
    if len({(item.kind, item.id) for item in body.items}) != len(body.items):
        raise HTTPException(422, "审批范围包含重复项")
    if body.text is not None and (len(body.items) != 1 or body.items[0].kind != "narration" or body.decision != "accept"):
        raise HTTPException(422, "仅支持修改并接受一页讲解稿")
    instance = teacher_instance_id(db, user, classroom_id, exclusive=True)
    return apply_decision(db, instance, user, body.items, body.decision, body.text)


def chapter_selection(db: Session, instance: int, user: User, chapter_id: int, kind: Kind | None):
    """Capture every member across pages, including excluded interactive drafts in the confirmation token."""
    title = scope_name(db, Chapter, instance, user, chapter_id)
    rows = draft_rows(db, instance, user, kind)
    members = db.execute(select(rows.c.kind, rows.c.id, rows.c.question_kind).where(rows.c.chapter_id == chapter_id)
                         .order_by(rows.c.kind, rows.c.id)).all()
    course_revision = str(db.scalar(select(CourseInstance.revision).where(CourseInstance.id == instance)))
    revisions = narration_revisions(db, [int(row.id) for row in members if row.kind == "narration"])
    digest = hashlib.sha256()
    digest.update(json.dumps([instance, user.id, chapter_id, title, kind], ensure_ascii=False).encode())
    eligible = []
    for row in members:
        revision = revisions.get(row.id, "missing") if row.kind == "narration" else course_revision
        digest.update(json.dumps([row.kind, row.id, revision, row.question_kind]).encode())
        if row.question_kind != "interactive":
            eligible.append(ReviewItem(kind=row.kind, id=row.id, revision=revision))
    narration_count = sum(item.kind == "narration" for item in eligible)
    return {"chapter_id": chapter_id, "chapter_title": title, "kind": kind, "count": len(eligible),
            "question_count": len(eligible) - narration_count, "narration_count": narration_count,
            "excluded_count": len(members) - len(eligible), "token": digest.hexdigest()}, eligible


@router.get("/groups/{chapter_id}/preview")
def chapter_preview(classroom_id: int, chapter_id: int, db: Db, user: Teacher, kind: Kind | None = None):
    instance = teacher_instance_id(db, user, classroom_id)
    preview, _ = chapter_selection(db, instance, user, chapter_id, kind)
    return preview


class ChapterConfirmation(BaseModel):
    kind: Kind | None = None
    expected_count: int = Field(ge=1)
    token: str = Field(pattern=r"^[0-9a-f]{64}$")


@router.post("/groups/{chapter_id}/accept")
def accept_chapter(classroom_id: int, chapter_id: int, body: ChapterConfirmation, db: Db, user: Teacher):
    instance = teacher_instance_id(db, user, classroom_id, exclusive=True)
    preview, items = chapter_selection(db, instance, user, chapter_id, body.kind)
    if body.expected_count != preview["count"] or body.token != preview["token"]:
        raise HTTPException(409, "章节的待审范围或草稿内容已变化，请重新预览后确认")
    return apply_decision(db, instance, user, items, "accept")
