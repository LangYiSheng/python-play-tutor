"""Knowledge-point practice quotas shared by authoring, package import and learner draws."""
from collections import deque
from random import SystemRandom
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select

from app.models import Question, QuestionChapter, QuestionKnowledgePoint
from app.question_types import QuestionKind

Count = Annotated[int, Field(strict=True, ge=0, le=500)]
KIND_LABELS = {"single_choice": "单选", "multiple_choice": "多选", "boolean": "判断", "fill": "填空", "python": "编程", "interactive": "交互练习"}


class PracticeGoal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    knowledge_point_id: int = Field(strict=True, gt=0)
    total: Count = 0
    by_kind: dict[QuestionKind, Count] = Field(default_factory=dict)

    @model_validator(mode="after")
    def positive_quota(self):
        if not self.total and not any(self.by_kind.values()):
            raise ValueError("知识点至少设置一项正数目标")
        return self


def without_legacy_retry_interval(rules):
    """Earlier course packages and saved activities may still carry this retired field."""
    if isinstance(rules, dict) and "retry_interval" in rules:
        return {key: value for key, value in rules.items() if key != "retry_interval"}
    return rules


class PracticeRules(BaseModel):
    model_config = ConfigDict(extra="forbid")
    goals: list[PracticeGoal] = Field(min_length=1, max_length=65)
    _read_legacy_rules = model_validator(mode="before")(without_legacy_retry_interval)

    @model_validator(mode="after")
    def unique_points(self):
        if len({goal.knowledge_point_id for goal in self.goals}) != len(self.goals):
            raise ValueError("练习知识点不能重复")
        return self


def practice_question_available(kind, status, has_public_samples):
    """Formal browser Python submissions require a nonempty public sample set."""
    return status == "ready" and (kind != "python" or has_public_samples)


def candidate_pool(db, activity, *, rules=None):
    """Return only approved, visible questions linked to both chapter and goal."""
    rules = rules if rules is not None else activity.content["practice_rules"]
    pool = {goal["knowledge_point_id"]: {} for goal in rules["goals"]}
    rows = db.execute(
        select(QuestionKnowledgePoint.knowledge_point_id, Question.id, Question.kind, Question.samples[0].as_string().is_not(None))
        .select_from(Question)
        .join(QuestionKnowledgePoint, QuestionKnowledgePoint.question_id == Question.id)
        .join(QuestionChapter, QuestionChapter.question_id == Question.id)
        .where(
            Question.course_instance_id == activity.course_instance_id,
            Question.owner_id.is_(None) | (Question.owner_id == activity.owner_id),
            Question.status == "ready",
            Question.deleted_at.is_(None),
            QuestionChapter.chapter_id == activity.chapter_id,
            QuestionKnowledgePoint.knowledge_point_id.in_(pool),
        )
        .order_by(Question.id)
    )
    for point_id, question_id, kind, has_samples in rows:
        if practice_question_available(kind, "ready", has_samples):
            pool[point_id][question_id] = kind
    return pool


def _augment(group, candidates, assigned):
    """Move existing assignments along an alternating path to free one question."""
    queue = deque([group])
    parents = {group: None}
    while queue:
        current = queue.popleft()
        for question in candidates[current]:
            owner = assigned.get(question)
            if owner is None:
                while current != group:
                    assigned[question] = current
                    current, question = parents[current]
                assigned[question] = group
                return True
            if owner not in parents:
                parents[owner] = (current, question)
                queue.append(owner)
    return False


def allocate_initial(rules, pool, *, shuffle=True, point_titles=None):
    """Simultaneously satisfy typed minima and remaining unrestricted slots with distinct questions."""
    quotas, candidates = {}, {}
    rng = SystemRandom()
    result = {}
    for goal in rules["goals"]:
        point = goal["knowledge_point_id"]
        result[point] = []
        minima = goal.get("by_kind", {})
        remaining = max(0, goal.get("total", 0) - sum(minima.values()))
        choices = pool.get(point, {})
        for kind, count in [*minima.items(), (None, remaining)]:
            if count:
                group = (point, kind)
                quotas[group] = count
                candidates[group] = [key for key, actual in choices.items() if kind is None or actual == kind]
                if shuffle:
                    rng.shuffle(candidates[group])

    assigned = {}
    for group in sorted(quotas, key=lambda g: len(candidates[g]) - quotas[g]):
        needed = quotas[group]
        for question in candidates[group]:
            if question not in assigned:
                assigned[question] = group
                needed -= 1
                if needed == 0:
                    break
        for remaining in range(needed, 0, -1):
            if not _augment(group, candidates, assigned):
                point, kind = group
                title = (point_titles or {}).get(point, str(point))
                label = KIND_LABELS.get(kind, "任意题型")
                raise ValueError(f"知识点「{title}」的{label}目标缺少 {remaining} 道可分配题目（已按各知识点去重）")
    for question, (point, _) in assigned.items():
        result[point].append(question)
    if shuffle:
        for questions in result.values():
            rng.shuffle(questions)
    return result
