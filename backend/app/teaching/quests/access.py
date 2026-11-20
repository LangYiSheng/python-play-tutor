"""Authorize quest visibility within the selected course and classroom."""

from fastapi import HTTPException
from sqlalchemy import select

from app.course_content.access import authorize_classroom
from app.course_scope import belongs_to_course
from app.models import PlayerQuest, QuestDefinition


def quest_visible(definition, user, classroom, db, *, granted=None):
    if not belongs_to_course(db, definition, classroom.id) or user.role != "admin" and definition.owner_id not in {None, classroom.teacher_id}:
        return False
    if user.role == "student" and "when" in definition.definition:
        from app.teaching.conditions.runtime import condition_matches

        if definition.chapter_id is None:
            if granted is None:
                granted = db.scalar(select(PlayerQuest.id).where(PlayerQuest.user_id == user.id, PlayerQuest.classroom_id == classroom.id,
                                                                 PlayerQuest.quest_id == definition.id)) is not None
            if granted:
                return True
        return condition_matches(db, user, classroom.id, definition, definition.definition["when"])
    return True


def authorize_quest(db, user, classroom_id, quest_id):
    classroom = authorize_classroom(db, user, classroom_id)
    definition = db.get(QuestDefinition, quest_id)
    if not definition:
        raise HTTPException(404, "任务定义不存在")
    if not quest_visible(definition, user, classroom, db):
        raise HTTPException(403, "任务不属于当前班级教师")
    return definition
