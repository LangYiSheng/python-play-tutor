from app.course_content.presentation import progress_payload
from app.materials.presentation import material_payload
from app.course_content.presentation import public_question
from app.course_content.resources import learning_materials, resource_payload
from app.course_content.learning import learning_questions
from app.course_content.access import authorize_material
from app.course_content.access import authorized_material_chapters
from app.course_content.access import authorize_activity
from app.course_content.access import authorize_classroom
from .course_assistant import activity_npc, policy
from .characters import presentation
from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from .auth import current_user
from .db import get_db
from .course_scope import course_clause
from .models import (
    Chapter,
    Classroom,
    KnowledgePoint,
    Material,
    Question,
    User,
)

router = APIRouter(tags=["courses"])


@router.get("/activities/{activity_id}")
def get_activity(
    activity_id: str, classroom_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(current_user)]
):
    activity = authorize_activity(db, user, classroom_id, activity_id)
    materials = learning_materials(db, activity)
    for material in materials.values():
        authorize_material(db, user, classroom_id, material.id)
    classroom = db.get(Classroom, classroom_id)
    points = []
    for point_id in activity.content.get("knowledge_point_ids", []):
        point = db.get(KnowledgePoint, point_id)
        if not point or point.course_instance_id != activity.course_instance_id:
            raise HTTPException(409, "活动知识点关联无效")
        point_chapter = db.get(Chapter, point.chapter_id)
        if not point_chapter or point_chapter.course_instance_id != activity.course_instance_id:
            raise HTTPException(409, "活动知识点章节关联无效")
        if point_chapter.owner_id not in {None, classroom.teacher_id} and user.role != "admin":
            raise HTTPException(403, "知识点章节不属于当前班级发布范围")
        if point.owner_id not in {None, classroom.teacher_id} and user.role != "admin":
            raise HTTPException(403, "知识点不属于当前班级发布范围")
        points.append(
            {
                "id": point.id,
                "title": point.title,
                "chapter_id": point.chapter_id,
                "source": {"kc_code": point.content.get("kc_code"), "page_ids": point.content.get("page_refs", [])},
            }
        )
    from .practice_sessions import assigned_questions, open_session

    personal = activity.kind == "practice" and activity.content.get("practice_rules") and user.role == "student"
    if personal:
        open_session(db, user, classroom_id, activity)
        questions = assigned_questions(db, user, classroom_id, activity)
    else:
        questions = learning_questions(db, activity, classroom.teacher_id)
    if activity.kind == "assessment" and user.role == "student":
        from .models import AssessmentAttempt
        attempt = db.scalar(select(AssessmentAttempt).where(AssessmentAttempt.user_id == user.id,
            AssessmentAttempt.classroom_id == classroom_id, AssessmentAttempt.activity_id == activity.id))
        if attempt and attempt.state in {"submitted", "legacy"}:
            historical = {q.id: q for q in db.scalars(select(Question).where(Question.id.in_(attempt.question_ids),
                Question.course_instance_id == activity.course_instance_id).execution_options(include_deleted=True))}
            questions = [historical[key] for key in attempt.question_ids if key in historical and historical[key].kind != "interactive"]
    payload = {
        "id": activity.id,
        "chapter_id": activity.chapter_id,
        "title": activity.title,
        "kind": activity.kind,
        "npc_key": activity.npc_key,
        "role": presentation(db, classroom_id, activity_npc(db, classroom_id, activity)),
        "assistant_allowed": activity.kind != "assessment" and policy(db, classroom_id)["enabled"],
        "progress": progress_payload(db, user, classroom_id, activity),
        "knowledge_point_ids": activity.content.get("knowledge_point_ids", []),
        "knowledge_points": points,
        "resources": [{**resource_payload(row), "material": material_payload(db, materials[row.material_id],
            chapter_ids=authorized_material_chapters(db, user, classroom_id, materials[row.material_id]))} for row in activity.resources],
        "questions": [
            public_question(q)
            for q in questions
        ],
    }
    if personal:
        db.commit()
    return payload


@router.get("/activities/{activity_id}/progress")
def get_progress(
    activity_id: str, classroom_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(current_user)]
):
    activity = authorize_activity(db, user, classroom_id, activity_id)
    return {**progress_payload(db, user, classroom_id, activity), "participation_only": activity.kind in {"lesson", "reading"}}


@router.get("/materials/{material_id}")
def get_material(
    material_id: int, classroom_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(current_user)]
):
    material = authorize_material(db, user, classroom_id, material_id)
    return material_payload(db, material, chapter_ids=authorized_material_chapters(db, user, classroom_id, material))


@router.get("/library")
def library(classroom_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(current_user)]):
    authorize_classroom(db, user, classroom_id)
    results = []
    for material in db.scalars(select(Material).where(course_clause(db, Material, classroom_id)).order_by(Material.id)):
        try:
            authorize_material(db, user, classroom_id, material.id)
        except HTTPException:
            continue
        payload = material_payload(db, material, chapter_ids=authorized_material_chapters(db, user, classroom_id, material))
        results.append({key: payload[key] for key in ("id", "title", "chapter_id", "chapter_ids", "kind", "status", "duration_seconds")})
    return results
