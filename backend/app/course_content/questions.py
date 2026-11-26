"""Validate and manage reusable questions while preserving private answer data."""

from fastapi import HTTPException
from app.course_scope import course_class_ids
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.content_relations import question_chapter_ids, question_knowledge_point_ids, set_question_chapters, set_question_knowledge_points
from app.course_content.question_contracts import QuestionInput, QuestionUpdate
from app.course_content.review_catalog import question_scope
from app.models import (
    Activity,
    ActivityQuestion,
    AssessmentAttempt,
    Chapter,
    KnowledgePoint,
    Question,
    QuestionChapter,
    QuestionKnowledgePoint,
    QuestionSecret,
    Submission,
    User,
)
from app.teacher_scope import commit_content, require_scope, scoped_key, own_course, teacher_instance_id


def validate_question_links(db, user, body, instance_id=None):
    from app.curriculum import authoring_chapter
    from app.models import Material

    if "material_id" in body.source:
        material_id = body.source["material_id"]
        material = (
            db.scalar(select(Material).where(Material.id == material_id).with_for_update()) if type(material_id) is int and material_id > 0 else None
        )
        if not material:
            raise HTTPException(422, "题目来源资料不存在")
        require_scope(material, instance_id)
        if user.role != "admin" and material.owner_id not in {None, user.id}:
            raise HTTPException(403, "无权引用其他教师的私有资料")
        if "page_no" in body.source:
            page_no = body.source["page_no"]
            if type(page_no) is not int or not any(page.get("page_no") == page_no for page in material.content.get("pages", [])):
                raise HTTPException(422, "题目来源页必须属于所选资料")
    for chapter_id in body.chapter_ids:
        authoring_chapter(db, user, chapter_id, instance_id)
    for point_id in body.knowledge_point_ids:
        point = db.get(KnowledgePoint, point_id)
        if not point or point.course_instance_id != instance_id or point.chapter_id not in body.chapter_ids:
            raise HTTPException(422, "知识点必须存在且属于所选章节")
        if user.role != "admin" and point.owner_id not in {None, user.id}:
            raise HTTPException(403, "无权使用其他教师的私有知识点")


def teacher_question_payload(db, question, user):
    from app.course_content.presentation import public_question

    secret = db.get(QuestionSecret, question.id)
    activities_query = (
        select(Activity).join(ActivityQuestion, ActivityQuestion.activity_id == Activity.id).where(ActivityQuestion.question_id == question.id)
    )
    chapter_ids = question_chapter_ids(db, question.id)
    point_ids = question_knowledge_point_ids(db, question.id)
    if user.role != "admin":
        activities_query = activities_query.where(Activity.owner_id.is_(None) | (Activity.owner_id == user.id))
        chapter_ids = list(
            db.scalars(select(Chapter.id).where(Chapter.id.in_(chapter_ids), Chapter.owner_id.is_(None) | (Chapter.owner_id == user.id)))
        )
        point_ids = list(
            db.scalars(
                select(KnowledgePoint.id).where(
                    KnowledgePoint.id.in_(point_ids),
                    KnowledgePoint.chapter_id.in_(chapter_ids),
                    KnowledgePoint.owner_id.is_(None) | (KnowledgePoint.owner_id == user.id),
                )
            )
        )
    activities = db.scalars(activities_query).all()
    return {
        **public_question(question),
        "chapter_ids": chapter_ids,
        "knowledge_point_ids": point_ids,
        "source_type": question.source_type,
        "status": question.status,
        "source": question.source,
        "owner_id": question.owner_id,
        "activities": [{"id": a.id, "title": a.title, "chapter_id": a.chapter_id} for a in activities],
        "answer": secret.answer if secret else None,
        "hidden_cases": secret.hidden_cases if secret else [],
    }


def validate_practice_question_edit(db, question, body):
    """Check assigned work and the prospective bank before mutating a question."""
    from app.models import PracticeSession
    from app.practice_rules import allocate_initial, candidate_pool, practice_question_available

    if question.kind is None:
        return
    old_points = set(question_knowledge_point_ids(db, question.id))
    available = practice_question_available(body.kind, body.status, bool(body.samples))
    if not old_points or (body.kind == question.kind and available and old_points.issubset(body.knowledge_point_ids)):
        return
    sessions = db.scalars(
        select(PracticeSession).join(Activity, Activity.id == PracticeSession.activity_id)
        .where(Activity.course_instance_id == question.course_instance_id)
    )
    for session in sessions:
        for item in session.items:
            if item["question_id"] == question.id and (
                item["kind"] != body.kind or not available or item["knowledge_point_id"] not in body.knowledge_point_ids
            ):
                raise HTTPException(409, "题目已进入学生个人题单，须保留可用状态、已分配的知识点和题型；编程题须保留公开样例")

    activities = db.scalars(select(Activity).where(Activity.course_instance_id == question.course_instance_id, Activity.kind == "practice"))
    for activity in activities:
        rules = activity.content.get("practice_rules")
        if not rules or activity.content.get("published") is False or not old_points.intersection(activity.content["knowledge_point_ids"]):
            continue
        pool = candidate_pool(db, activity)
        category_matches = (body.kind == "python") == (activity.content.get("practice_kind") == "programming")
        eligible = available and category_matches and activity.chapter_id in body.chapter_ids and question.owner_id in {None, activity.owner_id}
        for point, choices in pool.items():
            if eligible and point in body.knowledge_point_ids:
                choices[question.id] = body.kind
            else:
                choices.pop(question.id, None)
        try:
            allocate_initial(rules, pool, shuffle=False)
        except ValueError as exc:
            raise HTTPException(409, f"修改会导致已发布练习「{activity.title}」无法抽题：{exc}") from exc


def stage_question(db, user, question, body):
    validate_question_links(db, user, body, question.course_instance_id)
    if (
        question.kind is not None
        and question.kind != body.kind
        and (
            db.scalar(select(Submission.id).where(Submission.question_id == question.id).limit(1)) is not None
            or any(
                question.id in attempt.question_ids
                for attempt in db.scalars(
                    select(AssessmentAttempt).where(
                        AssessmentAttempt.classroom_id.in_(
                            course_class_ids(question.course_instance_id)
                        )
                    )
                )
            )
        )
    ):
        raise HTTPException(409, "题目已有作答或试卷记录，不能改变题型；请新建题目")
    bound = db.scalars(
        select(Activity).join(ActivityQuestion, ActivityQuestion.activity_id == Activity.id).where(ActivityQuestion.question_id == question.id)
    ).all()
    if bound and body.status != "ready":
        raise HTTPException(409, "题目仍被活动引用，请先从活动移除再改为草稿或停用")
    if body.kind == "interactive" and any(activity.kind != "practice" for activity in bound):
        raise HTTPException(409, "交互练习题只能用于练习活动，请先从其他活动移除此题")
    for activity in bound:
        if activity.kind == "practice":
            coding = activity.content.get("practice_kind") == "programming"
            if (body.kind == "python") != coding or (coding and not body.samples):
                raise HTTPException(409, "题目仍被练习引用，请保留对应题型及编程练习的公开样例")
    if any(activity.chapter_id not in body.chapter_ids for activity in bound):
        raise HTTPException(409, "题目仍被活动引用，不能移除所用章节")
    validate_practice_question_edit(db, question, body)
    for key, value in body.model_dump(exclude={"id", "answer", "hidden_cases", "chapter_ids", "knowledge_point_ids"}).items():
        setattr(question, key, value)
    db.add(question)
    db.flush()
    secret = db.get(QuestionSecret, question.id)
    if not secret:
        secret = QuestionSecret(question_id=question.id)
        db.add(secret)
    secret.answer, secret.hidden_cases = body.answer, body.hidden_cases
    set_question_chapters(db, question.id, body.chapter_ids)
    set_question_knowledge_points(db, question.id, body.knowledge_point_ids)


def save_question(db, user, question, body):
    try:
        stage_question(db, user, question, body)
        commit_content(db, question.course_instance_id)
        return teacher_question_payload(db, question, user)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "题目标识冲突或内容同时更新，请刷新后重试") from exc


def create_question(body: QuestionInput, db: Session, user: User, course_id: int | None = None):
    course = own_course(db, user, course_id, exclusive=True)
    instance_id = course.id
    runtime_id = scoped_key(instance_id, "question", body.id)
    if db.get(Question, runtime_id, execution_options={"include_deleted": True}):
        raise HTTPException(409, "题目ID已存在")
    return save_question(db, user, Question(id=runtime_id, stable_id=body.id, course_instance_id=instance_id, owner_id=course.teacher_id), body)


def visible_questions(db, user, course_id, *, reviewable=False):
    instance_id = teacher_instance_id(db, user, course_id)
    if reviewable:
        return select(Question).where(*question_scope(instance_id, user))
    query = select(Question).where(Question.course_instance_id == instance_id)
    if user.role != "admin":
        query = query.where(Question.owner_id.is_(None) | (Question.owner_id == user.id))
    return query


def list_questions(db: Session, user: User, course_id: int | None = None):
    query = visible_questions(db, user, course_id)
    return [teacher_question_payload(db, item, user) for item in db.scalars(query.order_by(Question.id))]


def question_page(db, user, course_id, page, size, search, kind, status, source, knowledge_point_id=None, *, reviewable=False):
    from app.course_content.catalog import page_window, point_detail

    query = visible_questions(db, user, course_id, reviewable=reviewable).with_only_columns(
        Question.id, Question.title, Question.kind, Question.source_type, Question.status)
    if knowledge_point_id is not None:
        point_detail(db, user, course_id, knowledge_point_id)
        linked = select(QuestionKnowledgePoint.question_id).where(QuestionKnowledgePoint.knowledge_point_id == knowledge_point_id)
        query = query.where(Question.id.in_(linked))
    if search.strip():
        term = search.strip()
        query = query.where(Question.title.icontains(term, autoescape=True) | Question.prompt.icontains(term, autoescape=True))
    for column, value in ((Question.kind, kind), (Question.status, status), (Question.source_type, source)):
        if value is not None:
            query = query.where(column == value)
    meta, window = page_window(db, query.order_by(Question.id), page, size)
    items = [dict(row, chapter_ids=[]) for row in db.execute(window).mappings()]
    by_id = {item["id"]: item for item in items}
    if by_id:
        chapters = select(QuestionChapter.question_id, Chapter.id).join(Chapter, Chapter.id == QuestionChapter.chapter_id).where(
            QuestionChapter.question_id.in_(by_id))
        if user.role != "admin":
            chapters = chapters.where(Chapter.owner_id.is_(None) | (Chapter.owner_id == user.id))
        for question_id, chapter_id in db.execute(chapters.order_by(Chapter.id)):
            by_id[question_id]["chapter_ids"].append(chapter_id)
    return {**meta, "items": items}


def question_detail(db, user, course_id, question_id):
    question = db.scalar(visible_questions(db, user, course_id).where(Question.id == question_id))
    if question is None:
        raise HTTPException(404, "题目不存在")
    return teacher_question_payload(db, question, user)


def chapter_candidates(db, user, course_id, chapter_id):
    from app.course_content.catalog import visible_points

    instance_id = teacher_instance_id(db, user, course_id)
    query = select(Question).join(QuestionChapter, QuestionChapter.question_id == Question.id).join(
        Chapter, Chapter.id == QuestionChapter.chapter_id).where(
        Question.course_instance_id == instance_id, Chapter.course_instance_id == instance_id, Chapter.id == chapter_id)
    if user.role != "admin":
        query = query.where((Question.owner_id.is_(None) | (Question.owner_id == user.id))
                            & (Chapter.owner_id.is_(None) | (Chapter.owner_id == user.id)))
    query = query.with_only_columns(
            Question.id, Question.title, Question.kind, Question.status, Question.owner_id,
            (func.json_array_length(Question.samples) > 0).label("has_samples"))
    points = visible_points(instance_id, user).where(KnowledgePoint.chapter_id == chapter_id).with_only_columns(KnowledgePoint.id)
    links = query.outerjoin(QuestionKnowledgePoint, (QuestionKnowledgePoint.question_id == Question.id)
                            & QuestionKnowledgePoint.knowledge_point_id.in_(points.correlate(None))).add_columns(QuestionKnowledgePoint.knowledge_point_id)
    by_id = {}
    for row in db.execute(links.order_by(Question.id, QuestionKnowledgePoint.knowledge_point_id)).mappings():
        if row.id not in by_id:
            candidate = dict(row)
            del candidate["knowledge_point_id"]
            by_id[row.id] = dict(candidate, knowledge_point_ids=[])
        if row.knowledge_point_id is not None:
            by_id[row.id]["knowledge_point_ids"].append(row.knowledge_point_id)
    return list(by_id.values())


def updated_question_input(db, question, user, body):
    from pydantic import ValidationError
    fields = teacher_question_payload(db, question, user)
    for key in ("activities", "owner_id"):
        fields.pop(key, None)
    fields.update(body.model_dump(exclude_unset=True))
    try:
        return QuestionInput.model_validate(fields)
    except ValidationError as exc:
        raise HTTPException(422, "题目配置无效：" + "; ".join(error["msg"] for error in exc.errors())) from exc


def update_question(question_id: str, body: QuestionUpdate, db: Session, user: User, course_id: int | None = None):
    from app.curriculum import editable

    instance_id = teacher_instance_id(db, user, course_id, exclusive=True)
    question = editable(db.scalar(select(Question).where(Question.id == question_id).with_for_update()), user, instance_id)
    return save_question(db, user, question, updated_question_input(db, question, user, body))


def delete_question(question_id: str, db: Session, user: User, course_id: int | None = None):
    from app.curriculum import editable

    instance_id = teacher_instance_id(db, user, course_id, exclusive=True)
    editable(db.scalar(select(Question).where(Question.id == question_id).with_for_update()), user, instance_id)
    raise HTTPException(409, "请先预览删除影响并完成二次确认")
