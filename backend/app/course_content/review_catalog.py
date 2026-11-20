"""Read the scoped draft queue. A shared draft has one place in the review hierarchy."""
from typing import Literal

from fastapi import HTTPException
from sqlalchemy import BigInteger, String, and_, case, cast, func, literal, select, union_all
from sqlalchemy.orm import Session

from app.models import Chapter, Material, MaterialChapter, Question, QuestionChapter, User
from app.narration.models import PageNarration

Kind = Literal["question", "narration"]


def question_scope(instance: int, user: User):
    return (Question.course_instance_id == instance, Question.deleted_at.is_(None), Question.status == "draft",
            True if user.role == "admin" else Question.owner_id == user.id)


def visible(model, instance: int, user: User):
    return (model.course_instance_id == instance, model.deleted_at.is_(None),
            True if user.role == "admin" else model.owner_id.is_(None) | (model.owner_id == user.id))


def material_scope(instance: int, user: User):
    return (*visible(Material, instance, user), Material.kind.in_(("presentation", "pdf")))


def draft_count(db: Session, instance: int, user: User) -> int:
    questions = select(func.count(Question.id)).where(*question_scope(instance, user))
    narrations = (select(func.count(PageNarration.id)).join(Material, Material.id == PageNarration.material_id)
                  .where(*material_scope(instance, user), PageNarration.status == "draft"))
    return db.scalar(select(questions.scalar_subquery() + narrations.scalar_subquery())) or 0


def first_chapter(relation, parent_id, target, instance: int, user: User):
    chapter = (select(Chapter.id).join(relation, relation.chapter_id == Chapter.id)
               .where(parent_id == target, *visible(Chapter, instance, user))
               .order_by(Chapter.order_index, Chapter.id).limit(1).correlate_except(Chapter, relation))
    return func.coalesce(chapter.scalar_subquery(), 0).label("chapter_id")


def draft_rows(db: Session, instance: int, user: User, kind: Kind | None):
    # Some imported metadata is free-form. Only a genuine integer material ID can be a source.
    source_id = Question.source["material_id"]
    if db.get_bind().dialect.name == "postgresql":
        text_id = source_id.as_string()
        integer_id = case((and_(func.json_typeof(source_id) == "number", text_id.regexp_match(r"^[1-9][0-9]{0,9}$")),
                           cast(text_id, BigInteger)))
    else:
        integer_id = case((func.json_type(Question.source, "$.material_id") == "integer", source_id.as_integer()))
    question = (select(literal("question").label("kind"), Question.id.label("id"), Question.title,
        cast(Question.source["page_no"].as_string(), String).label("page_no"), Question.source_type.label("source"),
        Question.kind.label("question_kind"), first_chapter(QuestionChapter, QuestionChapter.question_id, Question.id, instance, user),
        func.coalesce(Material.id, 0).label("material_id"), literal(0).label("narration_page"))
        .select_from(Question).outerjoin(Material, and_(Material.id == integer_id, *visible(Material, instance, user)))
        .where(*question_scope(instance, user)))
    narration = (select(literal("narration").label("kind"), cast(PageNarration.id, String).label("id"), Material.title,
        cast(PageNarration.page_no, String).label("page_no"), PageNarration.source, literal("").label("question_kind"),
        first_chapter(MaterialChapter, MaterialChapter.material_id, Material.id, instance, user), Material.id.label("material_id"),
        PageNarration.page_no.label("narration_page"))
        .select_from(PageNarration).join(Material, Material.id == PageNarration.material_id)
        .where(*material_scope(instance, user), PageNarration.status == "draft"))
    return (question if kind == "question" else narration if kind == "narration" else union_all(question, narration)).subquery()


def scope_name(db: Session, model, instance: int, user: User, key: int) -> str:
    if key == 0:
        return "未归章" if model is Chapter else "无来源资料"
    name = db.scalar(select(model.title).where(model.id == key, *visible(model, instance, user)))
    if name is None:
        raise HTTPException(404, "该班级中找不到此审批范围")
    return name


def grouped_page(db: Session, instance: int, user: User, kind: Kind | None, chapter_id: int | None,
                 page: int, size: int):
    rows = draft_rows(db, instance, user, kind)
    chapters = chapter_id is None
    key = rows.c.chapter_id if chapters else rows.c.material_id
    model = Chapter if chapters else Material
    key_name = "chapter" if chapters else "material"
    counts = (select(key.label(key_name + "_id"), func.count().label("count"),
        func.count(case((rows.c.kind == "question", 1))).label("question_count"),
        func.count(case((rows.c.kind == "narration", 1))).label("narration_count"),
        func.count(case((rows.c.question_kind != "interactive", 1))).label("eligible_count")).group_by(key))
    extra = {}
    if chapter_id is not None:
        counts = counts.where(rows.c.chapter_id == chapter_id)
        extra["chapter_title"] = scope_name(db, Chapter, instance, user, chapter_id)
    grouped = counts.subquery()
    group_id = grouped.c[key_name + "_id"]
    name = func.coalesce(model.title, "未归章" if chapters else "无来源资料").label(key_name + "_title")
    query = (select(grouped, name).outerjoin(model, model.id == group_id)
             .order_by(case((group_id == 0, 1), else_=0), model.order_index if chapters else model.title, group_id))
    # Count groups and their members together; do not load drafts just to draw a badge.
    total, item_total = db.execute(select(func.count(), func.coalesce(func.sum(grouped.c.count), 0)).select_from(grouped)).one()
    current = min(page, max(1, (total + size - 1) // size))
    items = db.execute(query.limit(size).offset((current - 1) * size)).mappings().all()
    return {"page": current, "total": total, "item_total": item_total, "items": [dict(row) for row in items], **extra}
