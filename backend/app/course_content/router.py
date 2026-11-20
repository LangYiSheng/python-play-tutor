"""Teacher course content HTTP routes and authenticated dependencies."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.auth import require_teacher
from app.course_content.activities import ActivityInput, ActivityQuestionsInput, ActivityUpdate
from app.course_content.activities import create_activity as _create_activity
from app.course_content.activities import delete_activity as _delete_activity
from app.course_content.activities import update_activity as _update_activity
from app.course_content.activities import update_activity_questions as _update_activity_questions
from app.course_content.catalog import teacher_courses as _teacher_courses
from app.course_content.catalog import point_detail, point_page, selected_point_labels
from app.course_content.progress import progress as _progress
from app.course_content.progress import student_record as _student_record
from app.course_content.question_contracts import QuestionInput, QuestionUpdate
from app.course_content.questions import create_question as _create_question
from app.course_content.questions import delete_question as _delete_question
from app.course_content.questions import list_questions as _list_questions
from app.course_content.questions import chapter_candidates, question_detail, question_page
from app.course_content.questions import update_question as _update_question
from app.course_content.releases import ReleaseInput
from app.course_content.releases import list_releases as _list_releases
from app.course_content.releases import release_chapter as _release_chapter
from app.db import get_db
from app.models import User

router = APIRouter(tags=["classrooms"])


@router.put("/teacher/classrooms/{classroom_id}/releases/{chapter_id}")
def release_chapter(
    classroom_id: int, chapter_id: int, body: ReleaseInput, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]
):
    return _release_chapter(classroom_id=classroom_id, chapter_id=chapter_id, body=body, db=db, user=user)


@router.get("/teacher/courses")
def teacher_courses(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)],
                    classroom_id: int | None = None, view: Literal["chapters", "full"] = "full"):
    return _teacher_courses(db=db, user=user, classroom_id=classroom_id, view=view)


@router.get("/teacher/knowledge-points")
def list_points(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)], classroom_id: int,
                page: int = Query(1, ge=1), size: int = Query(10, ge=1, le=100), search: str = "", chapter_id: int | None = None):
    return point_page(db, user, classroom_id, page, size, search, chapter_id)


@router.get("/teacher/knowledge-point-labels")
def point_labels(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)], classroom_id: int,
                 ids: Annotated[list[int], Query(max_length=65)]):
    return selected_point_labels(db, user, classroom_id, ids)


@router.get("/teacher/knowledge-points/{point_id}")
def get_point(point_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)], classroom_id: int):
    return point_detail(db, user, classroom_id, point_id)


@router.get("/teacher/classrooms/{classroom_id}/progress")
def progress(classroom_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]):
    return _progress(classroom_id=classroom_id, db=db, user=user)


@router.post("/teacher/activities", status_code=201)
def create_activity(
    body: ActivityInput, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)], classroom_id: int | None = None
):
    return _create_activity(body=body, db=db, user=user, classroom_id=classroom_id)


@router.put("/teacher/activities/{activity_id}")
def update_activity(
    activity_id: str,
    body: ActivityUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_teacher)],
    classroom_id: int | None = None,
):
    return _update_activity(activity_id=activity_id, body=body, db=db, user=user, classroom_id=classroom_id)


@router.delete("/teacher/activities/{activity_id}")
def delete_activity(
    activity_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)], classroom_id: int | None = None
):
    return _delete_activity(activity_id=activity_id, db=db, user=user, classroom_id=classroom_id)


@router.put("/teacher/activities/{activity_id}/questions")
def update_activity_questions(
    activity_id: str,
    body: ActivityQuestionsInput,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_teacher)],
    classroom_id: int | None = None,
):
    return _update_activity_questions(activity_id=activity_id, body=body, db=db, user=user, classroom_id=classroom_id)


@router.post("/teacher/questions", status_code=201)
def create_question(
    body: QuestionInput, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)], classroom_id: int | None = None
):
    return _create_question(body=body, db=db, user=user, classroom_id=classroom_id)


@router.get("/teacher/questions")
def list_questions(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)], classroom_id: int | None = None,
                   page: int | None = Query(None, ge=1), size: int = Query(10, ge=1, le=100), search: str = "",
                   kind: str | None = None, status: str | None = None, source: str | None = None, knowledge_point_id: int | None = None):
    if page is not None or knowledge_point_id is not None:
        return question_page(db, user, classroom_id, page or 1, size, search, kind, status, source, knowledge_point_id)
    return _list_questions(db=db, user=user, classroom_id=classroom_id)


@router.get("/teacher/questions/{question_id:path}")
def get_question(question_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)], classroom_id: int):
    return question_detail(db, user, classroom_id, question_id)


@router.get("/teacher/chapters/{chapter_id}/question-candidates")
def list_candidates(chapter_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)], classroom_id: int):
    return chapter_candidates(db, user, classroom_id, chapter_id)


@router.put("/teacher/questions/{question_id:path}")
def update_question(
    question_id: str,
    body: QuestionUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_teacher)],
    classroom_id: int | None = None,
):
    return _update_question(question_id=question_id, body=body, db=db, user=user, classroom_id=classroom_id)


@router.delete("/teacher/questions/{question_id:path}")
def delete_question(
    question_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)], classroom_id: int | None = None
):
    return _delete_question(question_id=question_id, db=db, user=user, classroom_id=classroom_id)


@router.get("/teacher/classrooms/{classroom_id}/releases")
def list_releases(classroom_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]):
    return _list_releases(classroom_id=classroom_id, db=db, user=user)


@router.get("/teacher/classrooms/{classroom_id}/students/{student_id}")
def student_record(classroom_id: int, student_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]):
    return _student_record(classroom_id=classroom_id, student_id=student_id, db=db, user=user)
