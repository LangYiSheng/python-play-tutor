"""HTTP routes for Lectio teacher authoring workspace."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from ..auth import require_teacher
from ..db import get_db
from ..models import User
from ..teacher_scope import teacher_instance_id
from . import (
    exam_service,
    exercise_service,
    jobs,
    knowledge_service,
    script_export_service,
)
from .contracts import (
    ExamFillGapsRequest,
    ExamGapsRequest,
    ExamGenerateRequest,
    ExamPatchRequest,
    ExerciseGenerateRequest,
    ExerciseValidateResponse,
    JobListResponse,
    JobSnapshot,
    KnowledgeExtractRequest,
    KnowledgeOverviewResponse,
    PacingPreviewResponse,
)

router = APIRouter(prefix="/teacher/courses/{course_id}/lectio", tags=["lectio"])
Db = Annotated[Session, Depends(get_db)]
Teacher = Annotated[User, Depends(require_teacher)]

knowledge_service.register()
exercise_service.register()
exam_service.register()


@router.get("/materials/{material_id}/pacing", response_model=PacingPreviewResponse)
def preview_material_pacing(
    course_id: int,
    material_id: int,
    db: Db,
    user: Teacher,
    section_minutes: float = Query(10.0, gt=0, le=120),
    chapter_minutes: float = Query(90.0, gt=0, le=600),
) -> dict[str, Any]:
    return script_export_service.preview_material_pacing(
        db,
        user,
        course_id,
        material_id,
        section_minutes=section_minutes,
        chapter_minutes=chapter_minutes,
    )


@router.get("/materials/{material_id}/export")
def export_material(
    course_id: int,
    material_id: int,
    db: Db,
    user: Teacher,
    kind: Literal["source", "script"] = Query("script"),
    fmt: Literal["docx", "md"] = Query("docx"),
) -> Response:
    data, media_type, filename = script_export_service.export_material_text(
        db, user, course_id, material_id, kind=kind, fmt=fmt
    )
    return Response(
        content=data,
        media_type=media_type,
        headers=script_export_service.download_headers(filename),
    )


@router.get("/knowledge", response_model=KnowledgeOverviewResponse)
def list_knowledge(course_id: int, db: Db, user: Teacher) -> dict[str, Any]:
    return knowledge_service.list_knowledge(db, user, course_id)


@router.post("/chapters/{chapter_id}/knowledge/extract", status_code=202, response_model=JobSnapshot)
def extract_chapter_knowledge(
    course_id: int,
    chapter_id: int,
    db: Db,
    user: Teacher,
    body: KnowledgeExtractRequest | None = None,
) -> dict[str, Any]:
    job = knowledge_service.enqueue_extract_knowledge(
        db, user, course_id, chapter_id, material_ids=body.material_ids if body else None
    )
    return jobs.serialize_job(job)


@router.get("/knowledge/export")
def export_knowledge(
    course_id: int,
    db: Db,
    user: Teacher,
    fmt: Literal["xmind", "xlsx", "docx"] = Query("xmind"),
    chapter_id: int | None = Query(None, ge=1),
) -> Response:
    data, media_type, filename = knowledge_service.export_knowledge(
        db, user, course_id, fmt=fmt, chapter_id=chapter_id
    )
    return Response(
        content=data,
        media_type=media_type,
        headers=script_export_service.download_headers(filename),
    )


@router.post("/chapters/{chapter_id}/exercises/generate", status_code=202, response_model=JobSnapshot)
def generate_chapter_exercises(
    course_id: int,
    chapter_id: int,
    body: ExerciseGenerateRequest,
    db: Db,
    user: Teacher,
) -> dict[str, Any]:
    quotas = [q.model_dump() for q in body.point_quotas] if body.point_quotas else None
    job = exercise_service.enqueue_generate_exercises(
        db,
        user,
        course_id,
        chapter_id,
        material_id=body.material_id,
        counts=body.counts,
        point_quotas=quotas,
    )
    return jobs.serialize_job(job)


@router.get("/exercises/validate", response_model=ExerciseValidateResponse)
def validate_exercises(
    course_id: int,
    db: Db,
    user: Teacher,
    chapter_id: int | None = Query(None, ge=1),
    status: Literal["all", "ready", "draft"] = Query("all"),
) -> dict[str, Any]:
    return exercise_service.validate_exercises_export(
        db, user, course_id, chapter_id=chapter_id, status=status
    )


@router.get("/exercises/export")
def export_exercises(
    course_id: int,
    db: Db,
    user: Teacher,
    fmt: Literal["xuexitong_xlsx", "xuexitong_txt", "xlsx"] = Query("xuexitong_xlsx"),
    chapter_id: int | None = Query(None, ge=1),
    status: Literal["all", "ready", "draft"] = Query("all"),
) -> Response:
    data, media_type, filename = exercise_service.export_exercises(
        db, user, course_id, fmt=fmt, chapter_id=chapter_id, status=status
    )
    return Response(
        content=data,
        media_type=media_type,
        headers=script_export_service.download_headers(filename),
    )


@router.get("/exams")
def list_exams(course_id: int, db: Db, user: Teacher) -> dict[str, Any]:
    return {"exams": exam_service.list_exams(db, user, course_id)}


@router.post("/exams/gaps")
def check_exam_gaps(course_id: int, body: ExamGapsRequest, db: Db, user: Teacher) -> dict[str, Any]:
    return exam_service.check_exam_gaps(db, user, course_id, body)


@router.post("/exams/generate", status_code=201)
def create_exam(course_id: int, body: ExamGenerateRequest, db: Db, user: Teacher) -> dict[str, Any]:
    return exam_service.create_exam(db, user, course_id, body)


@router.post("/exams/fill-gaps", status_code=202, response_model=JobSnapshot)
def fill_exam_gaps(course_id: int, body: ExamFillGapsRequest, db: Db, user: Teacher) -> dict[str, Any]:
    job = exam_service.enqueue_fill_gaps(db, user, course_id, body)
    return jobs.serialize_job(job)


@router.get("/exams/{exam_id}")
def get_exam(course_id: int, exam_id: str, db: Db, user: Teacher) -> dict[str, Any]:
    return exam_service.get_exam(db, user, course_id, exam_id)


@router.patch("/exams/{exam_id}")
def patch_exam(
    course_id: int, exam_id: str, body: ExamPatchRequest, db: Db, user: Teacher
) -> dict[str, Any]:
    return exam_service.patch_exam(db, user, course_id, exam_id, body)


@router.delete("/exams/{exam_id}")
def delete_exam(course_id: int, exam_id: str, db: Db, user: Teacher) -> dict[str, bool]:
    return exam_service.delete_exam(db, user, course_id, exam_id)


@router.get("/exams/{exam_id}/candidates")
def exam_candidates(
    course_id: int,
    exam_id: str,
    db: Db,
    user: Teacher,
    variant: Literal["A", "B"] = Query("A"),
    uid: str = Query(..., min_length=1),
) -> dict[str, Any]:
    return {"candidates": exam_service.list_exam_candidates(db, user, course_id, exam_id, variant=variant, uid=uid)}


@router.get("/exams/{exam_id}/export")
def export_exam(
    course_id: int,
    exam_id: str,
    db: Db,
    user: Teacher,
    kind: Literal["student_docx", "teacher_docx", "blueprint_xlsx", "xuexitong_xlsx", "xuexitong_txt", "zip"] = Query("zip"),
    variant: Literal["A", "B"] = Query("A"),
) -> Response:
    data, media_type, filename = exam_service.export_exam(
        db, user, course_id, exam_id, kind=kind, variant=variant
    )
    return Response(
        content=data,
        media_type=media_type,
        headers=script_export_service.download_headers(filename),
    )


@router.get("/jobs", response_model=JobListResponse)
def list_lectio_jobs(
    course_id: int,
    db: Db,
    user: Teacher,
    limit: int = Query(30, ge=1, le=100),
) -> dict[str, Any]:
    instance_id = teacher_instance_id(db, user, course_id)
    rows = jobs.list_jobs(db, instance_id, limit=limit)
    return {"jobs": [jobs.serialize_job(row) for row in rows]}


@router.get("/jobs/{job_id}", response_model=JobSnapshot)
def get_lectio_job(course_id: int, job_id: str, db: Db, user: Teacher) -> dict[str, Any]:
    instance_id = teacher_instance_id(db, user, course_id)
    job = jobs.get_job(db, instance_id, job_id)
    return jobs.serialize_job(job)


@router.post("/jobs/{job_id}/cancel", response_model=JobSnapshot)
def cancel_lectio_job(course_id: int, job_id: str, db: Db, user: Teacher) -> dict[str, Any]:
    instance_id = teacher_instance_id(db, user, course_id)
    job = jobs.request_cancel(db, instance_id, job_id)
    return jobs.serialize_job(job)
