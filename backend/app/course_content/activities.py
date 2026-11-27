"""Manage ordered activities and their shared question associations."""

from typing import Annotated, Literal

from fastapi import HTTPException
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.content_relations import activity_questions, question_chapter_ids, set_activity_questions
from app.models import Activity, ActivityProgress, AssessmentAttempt, KnowledgePoint, Question, Submission, User
from app.practice_rules import PracticeRules, allocate_initial, candidate_pool
from app.teacher_scope import commit_content, require_scope, scoped_key, own_course, teacher_instance_id


def unique_questions(value: list[str]) -> list[str]:
    if any(not key or len(key) > 100 for key in value) or len(set(value)) != len(value):
        raise ValueError("题目ID必须有效且不能重复")
    return value


QuestionIds = Annotated[list[str], Field(max_length=5000), AfterValidator(unique_questions)]


class ActivityQuestionsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question_ids: QuestionIds


class ActivityInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=100)
    chapter_id: int
    title: str = Field(min_length=1, max_length=200)
    kind: Literal["practice", "assessment"]
    practice_kind: Literal["objective", "programming"] = "objective"
    required: bool = True
    order_index: int = Field(default=0, ge=0, le=100000)
    knowledge_point_ids: list[int] = Field(default_factory=list, max_length=65)
    question_ids: QuestionIds | None = None
    practice_rules: PracticeRules | None = None
    published: bool = True

    @field_validator("knowledge_point_ids", mode="before")
    @classmethod
    def valid_points(cls, value):
        from app.curriculum import validate_id_list

        return validate_id_list(value)


def create_activity(body: ActivityInput, db: Session, user: User, course_id: int | None = None):
    course = own_course(db, user, course_id, exclusive=True)
    instance_id = course.id

    runtime_id = scoped_key(instance_id, "activity", body.id)
    if db.get(Activity, runtime_id, execution_options={"include_deleted": True}):
        raise HTTPException(409, "活动ID已存在")
    from app.curriculum import validate_activity_points

    validate_activity_points(db, user, body.chapter_id, body.knowledge_point_ids, instance_id)
    content = {"published": body.published, "knowledge_point_ids": body.knowledge_point_ids,
               "required": body.required if body.kind == "practice" else True, "order_index": body.order_index}
    if body.kind == "practice":
        content["practice_kind"] = body.practice_kind
    item = Activity(
        chapter_id=body.chapter_id, title=body.title, kind=body.kind, assistant_allowed=body.kind == "practice",
        id=runtime_id,
        stable_id=body.id,
        course_instance_id=instance_id,
        owner_id=course.teacher_id,
        content=content,
    )
    if body.practice_rules is not None:
        configure_practice(db, item, user, body.practice_rules.model_dump(), body.published, body.knowledge_point_ids or None)
    elif body.published and not body.question_ids:
        raise HTTPException(422, "发布前请至少选择一道题")
    db.add(item)
    db.flush()
    if body.question_ids is not None:
        assign_activity_questions(db, item, body.question_ids, instance_id)
    commit_content(db, instance_id)
    return {"id": item.id}


class ActivityUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(default=None, min_length=1, max_length=200)
    practice_kind: Literal["objective", "programming"] | None = None
    required: bool | None = None
    order_index: int | None = Field(default=None, ge=0, le=100000)
    knowledge_point_ids: list[int] | None = Field(default=None, max_length=65)
    question_ids: QuestionIds | None = None
    practice_rules: PracticeRules | None = None
    published: bool | None = None

    @field_validator("knowledge_point_ids", mode="before")
    @classmethod
    def valid_points(cls, value):
        from app.curriculum import validate_id_list

        return validate_id_list(value)


def configure_practice(db, item, user, rules, published, requested_points=None):
    from app.curriculum import validate_activity_points

    if item.kind != "practice" or rules is None or type(published) is not bool:
        raise HTTPException(422, "知识点练习需要有效的目标与发布状态")
    point_ids = [goal["knowledge_point_id"] for goal in rules["goals"]]
    if requested_points is not None and set(requested_points) != set(point_ids):
        raise HTTPException(422, "练习知识点必须与目标一致")
    validate_activity_points(db, user, item.chapter_id, point_ids, item.course_instance_id)
    points = list(db.scalars(select(KnowledgePoint).where(KnowledgePoint.id.in_(point_ids))))
    if any(point.chapter_id != item.chapter_id for point in points):
        raise HTTPException(422, "练习目标必须来自活动所属章节")
    if published:
        try:
            allocate_initial(rules, candidate_pool(db, item, rules=rules), shuffle=False, point_titles={p.id: p.title for p in points})
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
    item.content = {**item.content, "knowledge_point_ids": point_ids, "practice_rules": rules, "published": published}


def update_activity(activity_id: str, body: ActivityUpdate, db: Session, user: User, course_id: int | None = None):
    instance_id = teacher_instance_id(db, user, course_id, exclusive=True)

    item = db.scalar(select(Activity).where(Activity.id == activity_id).with_for_update())
    if not item:
        raise HTTPException(404, "活动不存在")
    require_scope(item, instance_id)
    if item.owner_id != user.id and user.role != "admin":
        raise HTTPException(403, "共享种子不可覆盖，请创建教师自己的活动并绑定任务")
    changes = body.model_dump(exclude_unset=True)
    content = dict(item.content)
    if any(changes.get(k) is None for k in {"required", "order_index", "title", "published"} & changes.keys()):
        raise HTTPException(422, "必填字段不能为空")
    if "title" in changes:
        item.title = body.title
    for key in ("required", "published", "order_index"):
        if key in changes:
            content[key] = changes[key]
    if item.kind == "assessment":
        content["required"] = True
    elif body.practice_kind is not None and body.practice_kind != content.get("practice_kind", "objective"):
        raise HTTPException(422, "练习类别不能更换，请创建新的练习")
    old_rules = content.get("practice_rules")
    rules = changes.get("practice_rules", old_rules)
    if rules != old_rules:
        from app.models import PracticeSession
        if any(db.scalar(select(model.activity_id).where(model.activity_id == item.id).limit(1)) is not None
               for model in (PracticeSession, Submission, ActivityProgress)):
            raise HTTPException(409, "已有作答记录，请新建练习后修改出题方式")
    if rules is not None:
        item.content = content
        configure_practice(db, item, user, rules, content.get("published", True), body.knowledge_point_ids)
        if old_rules is None:
            set_activity_questions(db, item, [])
    else:
        from app.curriculum import validate_activity_points
        if body.knowledge_point_ids is not None:
            validate_activity_points(db, user, item.chapter_id, body.knowledge_point_ids, instance_id)
            content["knowledge_point_ids"] = body.knowledge_point_ids
        item.content = {k: v for k, v in content.items() if k != "practice_rules"}
    if body.question_ids is not None:
        assign_activity_questions(db, item, body.question_ids, instance_id)
    if not rules and content.get("published", True) and not activity_questions(db, item):
        raise HTTPException(422, "发布前请至少选择一道题")
    commit_content(db, instance_id)
    return {"id": item.id}


def delete_activity(activity_id: str, db: Session, user: User, course_id: int | None = None):
    from app.curriculum import editable

    instance_id = teacher_instance_id(db, user, course_id, exclusive=True)
    editable(db.scalar(select(Activity).where(Activity.id == activity_id).with_for_update()), user, instance_id)
    raise HTTPException(409, "请先预览删除影响并完成二次确认")


def update_activity_questions(activity_id: str, body: ActivityQuestionsInput, db: Session, user: User, course_id: int | None = None):
    instance_id = teacher_instance_id(db, user, course_id, exclusive=True)
    from app.curriculum import editable

    activity = editable(db.scalar(select(Activity).where(Activity.id == activity_id).with_for_update()), user, instance_id)
    try:
        assign_activity_questions(db, activity, body.question_ids, instance_id)
        commit_content(db, instance_id)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "内容同时更新，请刷新后重试") from exc
    return {"id": activity.id, "question_ids": [q.id for q in activity_questions(db, activity)]}


def assign_activity_questions(db, activity, question_ids, instance_id):
    if activity.content.get("practice_rules") is not None:
        raise HTTPException(422, "知识点练习按目标抽题，不能设置固定题单")
    if activity.kind not in {"practice", "assessment"}:
        raise HTTPException(422, "只有练习与测验活动可以选题")
    if activity.content.get("published", True) and not question_ids:
        raise HTTPException(422, "发布前请至少选择一道题")
    existing_ids = [q.id for q in activity_questions(db, activity)]
    if activity.kind == "practice" and question_ids != existing_ids and db.scalar(
        select(Submission.id).where(Submission.activity_id == activity.id).limit(1)
    ):
        raise HTTPException(409, "已有作答记录，请新建练习后修改题单")
    if activity.kind == "assessment" and len(question_ids) > 100:
        raise HTTPException(422, "章节测验最多选择100道题")
    if (
        activity.kind == "assessment"
        and question_ids != [q.id for q in activity_questions(db, activity)]
        and db.scalar(select(AssessmentAttempt.id).where(AssessmentAttempt.activity_id == activity.id).limit(1)) is not None
    ):
        raise HTTPException(409, "测验已有试卷记录，不能更换题集或顺序；请新建测验活动")
    for question_id in sorted(question_ids):
        question = db.scalar(select(Question).where(Question.id == question_id).with_for_update())
        if not question:
            raise HTTPException(422, "选中的题目不存在")
        require_scope(question, instance_id)
        if activity.kind == "practice":
            coding = activity.content.get("practice_kind", "objective") == "programming"
            if (question.kind == "python") != coding or (coding and not question.samples):
                raise HTTPException(422, "练习题型与类别不符，编程练习须配置公开样例")
            if (question.source or {}).get("usage") == "assessment":
                raise HTTPException(422, "测验专用题目不能选入练习活动")
        if question.kind == "interactive" and activity.kind != "practice":
            raise HTTPException(422, "交互练习题只能用于练习活动")
        if question.owner_id not in {None, activity.owner_id}:
            raise HTTPException(403, "题目必须属于活动教师或共享题库")
        if question.status != "ready":
            raise HTTPException(422, "只有已就绪题目可以用于活动")
        if activity.chapter_id not in question_chapter_ids(db, question.id):
            raise HTTPException(422, "题目必须关联活动所在章节")
    set_activity_questions(db, activity, question_ids)
