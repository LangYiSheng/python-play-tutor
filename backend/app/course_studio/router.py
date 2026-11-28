"""HTTP routes for Course Studio teacher authoring workspace."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import ValidationError
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
    CodingExerciseGenerateRequest,
    ExamFillGapsRequest,
    ExamGapsRequest,
    ExamGenerateRequest,
    ExamPatchRequest,
    ExerciseGenerateRequest,
    ExerciseValidateResponse,
    JobDetail,
    JobListResponse,
    JobSnapshot,
    KnowledgeExtractRequest,
    KnowledgeOverviewResponse,
    PacingPreviewResponse,
)

router = APIRouter(prefix="/teacher/courses/{course_id}/course-studio", tags=["course_studio"])
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
        difficulty=body.difficulty,
    )
    return jobs.serialize_job(job)


@router.post("/chapters/{chapter_id}/coding-exercises/generate", status_code=202, response_model=JobSnapshot)
def generate_chapter_coding_exercises(
    course_id: int,
    chapter_id: int,
    body: CodingExerciseGenerateRequest,
    db: Db,
    user: Teacher,
) -> dict[str, Any]:
    job = exercise_service.enqueue_generate_coding_exercises(
        db,
        user,
        course_id,
        chapter_id,
        material_id=body.material_id,
        counts=body.counts,
        difficulty=body.difficulty,
        usage=body.usage,
        knowledge_point_ids=body.knowledge_point_ids,
        allowed_syntax_note=body.allowed_syntax_note,
        enable_blind_solve=body.enable_blind_solve,
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
def list_course_studio_jobs(
    course_id: int,
    db: Db,
    user: Teacher,
    limit: int = Query(30, ge=1, le=100),
    workspace: bool = False,
) -> dict[str, Any]:
    instance_id = teacher_instance_id(db, user, course_id)
    rows = jobs.list_jobs(db, instance_id, limit=limit, workspace=workspace)
    return {"jobs": [jobs.serialize_job(row) for row in rows]}


@router.get("/jobs/{job_id}", response_model=JobDetail)
def get_studio_job(course_id: int, job_id: str, db: Db, user: Teacher) -> dict[str, Any]:
    instance_id = teacher_instance_id(db, user, course_id)
    job = jobs.get_job(db, instance_id, job_id)
    return {**jobs.serialize_job(job), "output_questions": jobs.output_questions(db, job, user)}


@router.post("/jobs/{job_id}/cancel", response_model=JobSnapshot)
def cancel_studio_job(course_id: int, job_id: str, db: Db, user: Teacher) -> dict[str, Any]:
    instance_id = teacher_instance_id(db, user, course_id)
    job = jobs.request_cancel(db, instance_id, job_id)
    return jobs.serialize_job(job)


@router.post("/jobs/{job_id}/dismiss")
def dismiss_studio_job(course_id: int, job_id: str, db: Db, user: Teacher):
    instance_id = teacher_instance_id(db, user, course_id, exclusive=True)
    job = jobs.get_job(db, instance_id, job_id)
    if job.status not in {"failed", "interrupted"}:
        raise HTTPException(409, "只能忽略失败或中断的任务")
    job.progress = {**(job.progress or {}), "queue_dismissed": True}
    db.commit()
    return {"queue_dismissed": True}


@router.post("/jobs/{job_id}/retry", status_code=202, response_model=JobSnapshot)
def retry_studio_job(course_id: int, job_id: str, db: Db, user: Teacher):
    instance_id = teacher_instance_id(db, user, course_id, exclusive=True)
    job = jobs.get_job(db, instance_id, job_id)
    if job.status not in {"failed", "interrupted"} or (job.progress or {}).get("queue_dismissed"):
        raise HTTPException(409, "该任务已处理，请刷新列表")
    payload = dict(job.payload or {})
    chapter_id = payload.pop("chapter_id", None)
    payload.pop("owner_filter_id", None)
    payload.pop("owner_id", None)
    if job.kind != "exam_fill_gaps" and not isinstance(chapter_id, int):
        raise HTTPException(409, "缺少原章节信息，请重新配置任务")
    # Enqueue commits this acknowledgment along with the new job after rechecking current inputs.
    job.progress = {**(job.progress or {}), "queue_dismissed": True}
    try:
        if job.kind == "knowledge_extract":
            body = KnowledgeExtractRequest.model_validate(payload)
            new_job = knowledge_service.enqueue_extract_knowledge(db, user, course_id, chapter_id, material_ids=body.material_ids)
        elif job.kind == "exercises_generate":
            config = ExerciseGenerateRequest.model_validate(payload)
            new_job = exercise_service.enqueue_generate_exercises(db, user, course_id, chapter_id, **config.model_dump())
        elif job.kind == "coding_exercises_generate":
            coding = CodingExerciseGenerateRequest.model_validate(payload)
            new_job = exercise_service.enqueue_generate_coding_exercises(db, user, course_id, chapter_id, **coding.model_dump())
        elif job.kind == "exam_fill_gaps":
            new_job = exam_service.enqueue_fill_gaps(db, user, course_id, ExamFillGapsRequest.model_validate(payload))
        else:
            raise HTTPException(409, "此任务类型不支持重试")
    except ValidationError as exc:
        raise HTTPException(409, "原配置已失效，请重新配置任务") from exc
    return jobs.serialize_job(new_job)
