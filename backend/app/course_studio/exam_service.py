"""Cross-chapter exam blueprinting, AI gap filling, A/B management, and exports."""

from __future__ import annotations

import logging
import math
from collections import Counter, defaultdict
from collections.abc import Sequence
from typing import Any, Literal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import as_utc
from ..models import Chapter, KnowledgePoint, Question, QuestionChapter, QuestionKnowledgePoint, QuestionSecret, User
from ..teacher_scope import new_stable_id
from ..teacher_scope import own_course, teacher_instance_id
from . import adapter, exercise_service, exercise_store, jobs
from .contracts import ExamFillGapsRequest, ExamGapsRequest, ExamGenerateRequest, ExamPatchRequest
from .engine import exams as exams_engine
from .engine import exercises as exercises_engine
from .models import CourseStudioExam, CourseStudioJob

log = logging.getLogger("course_studio.exams")


def _chapter_label_map(chapters: Sequence[Chapter]) -> dict[int, str]:
    counts = Counter(ch.title for ch in chapters)
    return {ch.id: ch.title if counts[ch.title] == 1 else f"{ch.order_index}. {ch.title}" for ch in chapters}


def _resolve_chapters(db: Session, user: User, instance_id: int, chapter_ids: Sequence[int]) -> list[Chapter]:
    rows = list(
        db.scalars(
            adapter.visible_query(Chapter, instance_id, user)
            .where(Chapter.id.in_(chapter_ids))
            .order_by(Chapter.order_index, Chapter.id)
        )
    )
    by_id = {ch.id: ch for ch in rows}
    if any(cid not in by_id for cid in chapter_ids):
        raise HTTPException(404, "所选章节不存在或无权限访问")
    return [by_id[cid] for cid in chapter_ids if cid in by_id]


def _objective_pool(
    db: Session,
    user: User | None,
    instance_id: int,
    chapters: Sequence[Chapter],
    *,
    owner_filter_id: int | None = None,
) -> tuple[list[dict[str, Any]], int, dict[int, str]]:
    """Build objective question pool compatible with engine.exams functions."""
    label_map = _chapter_label_map(chapters)
    ch_ids = [ch.id for ch in chapters]
    if not ch_ids:
        return [], 0, label_map

    q_stmt = select(Question).where(
        Question.course_instance_id == instance_id,
        Question.status != "disabled",
        Question.kind.in_(list(exercise_store.REBORN_TO_STUDIO)),
    )
    if user is not None and user.role != "admin":
        q_stmt = q_stmt.where(Question.owner_id.is_(None) | (Question.owner_id == user.id))
    elif owner_filter_id is not None:
        q_stmt = q_stmt.where(Question.owner_id.is_(None) | (Question.owner_id == owner_filter_id))

    questions = list(db.scalars(q_stmt.order_by(Question.id)))
    kp_rows = list(
        db.scalars(select(KnowledgePoint).where(KnowledgePoint.course_instance_id == instance_id, KnowledgePoint.chapter_id.in_(ch_ids)))
    )
    qids = [q.id for q in questions]
    if not qids:
        return [], len(kp_rows), label_map

    secrets = {s.question_id: s for s in db.scalars(select(QuestionSecret).where(QuestionSecret.question_id.in_(qids)))}
    q_ch_map: dict[str, list[int]] = defaultdict(list)
    for qid, cid in db.execute(
        select(QuestionChapter.question_id, QuestionChapter.chapter_id).where(
            QuestionChapter.question_id.in_(qids), QuestionChapter.chapter_id.in_(ch_ids)
        )
    ):
        q_ch_map[qid].append(cid)

    ch_order = {ch.id: idx for idx, ch in enumerate(chapters)}
    kp_by_id = {kp.id: kp for kp in kp_rows}
    q_pts: dict[str, list[str]] = defaultdict(list)
    for qid, kpid in db.execute(
        select(QuestionKnowledgePoint.question_id, QuestionKnowledgePoint.knowledge_point_id).where(
            QuestionKnowledgePoint.question_id.in_(qids)
        )
    ):
        if kpid in kp_by_id:
            q_pts[qid].append(kp_by_id[kpid].title)

    pool: list[dict[str, Any]] = []
    for q in questions:
        linked = q_ch_map.get(q.id)
        if not linked:
            continue
        primary_cid = min(linked, key=lambda cid: ch_order.get(cid, 9999))
        item = exercise_store.reborn_question_to_studio(
            q, secrets.get(q.id), chapter_label=label_map[primary_cid], point_titles=q_pts.get(q.id, [])
        )
        if item is not None:
            pool.append(item)
    return pool, len(kp_rows), label_map


def _exam_to_engine_dict(row: CourseStudioExam) -> dict[str, Any]:
    bp = dict(row.blueprint or {})
    return {
        "id": row.id,
        "stable_id": row.stable_id,
        "title": row.title,
        "subtitle": str(bp.get("subtitle") or ""),
        "examMode": str(bp.get("examMode") or "闭卷"),
        "durationMinutes": int(bp.get("durationMinutes") or 90),
        "totalScore": bp.get("totalScore") or 100,
        "abMode": row.mode == "ab" or bool(bp.get("abMode")),
        "maxOverlapRate": float(bp.get("maxOverlapRate") or 0.0),
        "includeUnreviewed": bool(bp.get("includeUnreviewed")),
        "chapters": list(bp.get("chapters") or []),
        "chapterWeights": dict(bp.get("chapterWeights") or {}),
        "sections": list(bp.get("sections") or []),
        "variants": dict(row.variants or {}),
        "stats": dict(row.stats or {}),
        "createdAt": as_utc(row.created_at).isoformat(),
        "updatedAt": as_utc(row.updated_at).isoformat(),
    }


def _normalize_blueprint_sections(sections: Sequence[Any]) -> list[dict[str, Any]]:
    raw = [{"type": s.type, "count": s.count, "scoreEach": s.scoreEach} for s in sections]
    try:
        norm = exams_engine.normalize_sections(raw)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if not norm:
        raise HTTPException(422, "请至少配置一种有效客观题题型且题量大于 0")
    return norm


def check_exam_gaps(db: Session, user: User, course_id: int, body: ExamGapsRequest) -> dict[str, Any]:
    """Compute question pool inventory vs exam blueprint shortages."""
    instance_id = teacher_instance_id(db, user, course_id)
    chapters = _resolve_chapters(db, user, instance_id, body.chapter_ids)
    sections = _normalize_blueprint_sections(body.sections)
    pool, _, label_map = _objective_pool(db, user, instance_id, chapters)
    return exams_engine.compute_gaps(
        pool,
        sections,
        [label_map[c.id] for c in chapters],
        ab_mode=body.ab_mode,
        max_overlap_rate=body.max_overlap_rate,
        include_unreviewed=body.include_unreviewed,
    )


def create_exam(db: Session, user: User, course_id: int, body: ExamGenerateRequest) -> dict[str, Any]:
    """Sample a single or A/B exam from current objective pool and save snapshot."""
    instance_id = teacher_instance_id(db, user, course_id, exclusive=True)
    chapters = _resolve_chapters(db, user, instance_id, body.chapter_ids)
    sections = _normalize_blueprint_sections(body.sections)
    pool, total_kps, label_map = _objective_pool(db, user, instance_id, chapters)
    weights = {label_map[cid]: float(w) for cid, w in (body.chapter_weights or {}).items() if cid in label_map}
    try:
        generated = exams_engine.generate_exam_variants(
            pool,
            title=body.title,
            chapters=[label_map[c.id] for c in chapters],
            sections=sections,
            subtitle=body.subtitle,
            exam_mode=body.exam_mode,
            duration_minutes=body.duration_minutes,
            total_score=body.total_score,
            ab_mode=body.ab_mode,
            max_overlap_rate=body.max_overlap_rate,
            include_unreviewed=body.include_unreviewed,
            chapter_weights=weights,
            total_course_kps=total_kps,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    blueprint = {
        "subtitle": generated["subtitle"],
        "examMode": generated["examMode"],
        "durationMinutes": generated["durationMinutes"],
        "totalScore": generated["totalScore"],
        "abMode": generated["abMode"],
        "maxOverlapRate": generated["maxOverlapRate"],
        "includeUnreviewed": generated["includeUnreviewed"],
        "chapters": generated["chapters"],
        "chapterIds": [c.id for c in chapters],
        "chapterStableIds": [c.stable_id for c in chapters],
        "chapterWeights": generated["chapterWeights"],
        "sections": generated["sections"],
    }
    row = CourseStudioExam(
        course_instance_id=instance_id,
        stable_id=new_stable_id(),
        title=generated["title"],
        mode="ab" if generated["abMode"] else "single",
        blueprint=blueprint,
        variants=generated["variants"],
        stats=generated["stats"],
        created_by=user.id,
    )
    db.add(row)
    adapter.commit_course_content(db, instance_id)
    db.refresh(row)
    return _exam_to_engine_dict(row)


def enqueue_fill_gaps(db: Session, user: User, course_id: int, body: ExamFillGapsRequest) -> CourseStudioJob:
    """Validate blueprint shortages and enqueue multi-chapter AI question fill job."""
    course = own_course(db, user, course_id, exclusive=True)
    instance_id = course.id
    chapters = _resolve_chapters(db, user, instance_id, body.chapter_ids)
    sections = _normalize_blueprint_sections(body.sections)
    pool, _, label_map = _objective_pool(db, user, instance_id, chapters)
    gaps = exams_engine.compute_gaps(
        pool,
        sections,
        [label_map[c.id] for c in chapters],
        ab_mode=body.ab_mode,
        max_overlap_rate=body.max_overlap_rate,
        include_unreviewed=body.include_unreviewed,
        multiplier=body.multiplier,
    )
    if gaps["ok"]:
        raise HTTPException(409, "当前题库题量已满足组卷需求，无需补题")
    reason = adapter.authoring_unavailable_reason(db)
    if reason:
        raise HTTPException(409, reason)

    owner_filter = None if user.role == "admin" else course.teacher_id
    usable_chapters = [
        ch.id
        for ch in chapters
        if exercise_service.collect_chapter_pages(db, instance_id, ch.id, owner_filter_id=owner_filter)[0]
    ]
    if not usable_chapters:
        raise HTTPException(409, "所选章节下都没有可用于补题的资料页面")

    return jobs.enqueue_job(
        db,
        course_instance_id=instance_id,
        kind="exam_fill_gaps",
        scope_key=f"instance:{instance_id}:exam_fill_gaps",
        user=user,
        payload={
            "chapter_ids": usable_chapters,
            "sections": sections,
            "ab_mode": body.ab_mode,
            "max_overlap_rate": body.max_overlap_rate,
            "include_unreviewed": body.include_unreviewed,
            "multiplier": body.multiplier,
            "owner_filter_id": owner_filter,
        },
        total=len(usable_chapters),
        message="已加入试卷缺口补题队列",
    )


def _run_exam_fill_gaps(db: Session, job: CourseStudioJob) -> dict[str, Any]:
    payload = job.payload or {}
    chapter_ids = [int(x) for x in (payload.get("chapter_ids") or [])]
    sections = list(payload.get("sections") or [])
    owner_filter_id = payload.get("owner_filter_id", payload.get("owner_id"))

    chapters = list(
        db.scalars(
            select(Chapter)
            .where(Chapter.course_instance_id == job.course_instance_id, Chapter.id.in_(chapter_ids))
            .order_by(Chapter.order_index, Chapter.id)
        )
    )
    if not chapters:
        raise ValueError("所选章节均不存在或已删除")

    pool, _, label_map = _objective_pool(db, None, job.course_instance_id, chapters, owner_filter_id=owner_filter_id)
    gaps = exams_engine.compute_gaps(
        pool,
        sections,
        [label_map[c.id] for c in chapters],
        ab_mode=bool(payload.get("ab_mode")),
        max_overlap_rate=float(payload.get("max_overlap_rate") or 0.0),
        include_unreviewed=bool(payload.get("include_unreviewed")),
        multiplier=int(payload.get("multiplier") or 1),
    )
    shortages = {r["type"]: int(r["shortage"]) for r in gaps["byType"] if int(r["shortage"]) > 0}
    if not shortages:
        return {"created": 0, "skipped": 0, "notes": ["题库已满足需求"]}

    llm = adapter.build_llm_client(db, check_cancel=lambda: jobs.check_cancel(db, job.id))
    active_chapters = [
        (ch, *exercise_service.collect_chapter_pages(db, job.course_instance_id, ch.id, owner_filter_id=owner_filter_id))
        for ch in chapters
    ]
    active_chapters = [(ch, pgs, orig) for ch, pgs, orig in active_chapters if pgs]
    if not active_chapters:
        raise ValueError("所选章节下没有可用于出题的资料页面")

    per_chapter_counts: dict[int, dict[str, int]] = {ch.id: {} for ch, _, _ in active_chapters}
    for qtype, total_need in shortages.items():
        base, rem = divmod(total_need, len(active_chapters))
        for idx, (ch, _, _) in enumerate(active_chapters):
            n = base + (1 if idx < rem else 0)
            if n > 0:
                per_chapter_counts[ch.id][qtype] = min(exercises_engine.MAX_PER_TYPE, int(math.ceil(n)))

    total_created, total_skipped = 0, 0
    notes: list[str] = []
    jobs.update_progress(
        db,
        job.id,
        done=0,
        total=len(active_chapters),
        message="正在准备按缺口补充题目…",
        result={"created": 0, "skipped": 0, "notes": []},
    )
    for idx, (ch, pages, origin) in enumerate(active_chapters):
        counts = per_chapter_counts.get(ch.id) or {}
        if not counts:
            continue
        jobs.check_cancel(db, job.id)
        suffix = f"（已入库 {total_created} 道）" if total_created else ""
        jobs.update_progress(db, job.id, done=idx, total=len(active_chapters), message=f"正在为「{ch.title}」补充缺失题目…{suffix}")
        catalog, _ = exercise_service.chapter_knowledge_catalog(
            db, job.course_instance_id, ch.id, origin, owner_filter_id=owner_filter_id
        )
        existing_items = exercise_service.chapter_existing_question_items(db, job.course_instance_id, ch.id)
        existing_stems = [it["stem"] for it in existing_items]
        res = exercises_engine.generate_exercises_from_pages(
            pages, llm, counts=counts, existing_stems=existing_stems, existing_items=existing_items, knowledge=catalog,
            allow_short_answer=False, single_blank_only=True,
        )
        notes.extend(str(n) for n in (res.get("notes") or []))
        created_ids, skipped = exercise_store.persist_generated_questions(
            db, instance_id=job.course_instance_id, chapter_id=ch.id,
            raw_questions=res.get("questions") or [], page_origin=origin,
        )
        total_created += len(created_ids)
        total_skipped += skipped
        jobs.update_progress(
            db,
            job.id,
            done=idx + 1,
            total=len(active_chapters),
            message=f"已为「{ch.title}」补充 {len(created_ids)} 道（累计已入库 {total_created} 道）",
            result={"created": total_created, "skipped": total_skipped, "notes": notes[:10]},
        )

    return {"created": total_created, "skipped": total_skipped, "notes": notes[:10]}


def list_exams(db: Session, user: User, course_id: int) -> list[dict[str, Any]]:
    instance_id = teacher_instance_id(db, user, course_id)
    rows = db.scalars(
        select(CourseStudioExam).where(CourseStudioExam.course_instance_id == instance_id).order_by(CourseStudioExam.created_at.desc(), CourseStudioExam.id.desc())
    )
    return [_exam_to_engine_dict(r) for r in rows]


def _load_exam_row(db: Session, instance_id: int, exam_id: str) -> CourseStudioExam:
    row = db.scalar(select(CourseStudioExam).where(CourseStudioExam.id == exam_id, CourseStudioExam.course_instance_id == instance_id))
    if row is None:
        raise HTTPException(404, "试卷不存在或不属于当前课程")
    return row


def get_exam(db: Session, user: User, course_id: int, exam_id: str) -> dict[str, Any]:
    instance_id = teacher_instance_id(db, user, course_id)
    return _exam_to_engine_dict(_load_exam_row(db, instance_id, exam_id))


def _live_pool_for_exam(db: Session, user: User, instance_id: int, row: CourseStudioExam) -> tuple[list[dict[str, Any]], int]:
    bp = row.blueprint or {}
    cids = [int(x) for x in (bp.get("chapterIds") or []) if isinstance(x, int)]
    stored_names = [str(x) for x in (bp.get("chapters") or [])]
    stmt = adapter.visible_query(Chapter, instance_id, user)
    chapters = list(db.scalars(stmt.where(Chapter.id.in_(cids)) if cids else stmt))
    pool, total_kps, label_map = _objective_pool(db, user, instance_id, chapters)
    # If a chapter was renamed after exam creation, map its live label back to the blueprint label
    # so candidate matching & swap remain aligned with the exam's stored chapter tags.
    if cids and len(cids) == len(stored_names):
        rename_map = {
            label_map[cid]: stored_names[idx]
            for idx, cid in enumerate(cids)
            if cid in label_map and stored_names[idx] and label_map[cid] != stored_names[idx]
        }
        if rename_map:
            for item in pool:
                if item.get("chapter") in rename_map:
                    item["chapter"] = rename_map[item["chapter"]]
    return pool, total_kps


def patch_exam(db: Session, user: User, course_id: int, exam_id: str, body: ExamPatchRequest) -> dict[str, Any]:
    instance_id = teacher_instance_id(db, user, course_id, exclusive=True)
    row = _load_exam_row(db, instance_id, exam_id)
    pool, total_kps = _live_pool_for_exam(db, user, instance_id, row)
    try:
        updated = exams_engine.apply_exam_patch(_exam_to_engine_dict(row), body.model_dump(exclude_unset=True), pool, total_course_kps=total_kps)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    row.title = updated["title"]
    row.blueprint = {
        **(row.blueprint or {}),
        "subtitle": updated["subtitle"],
        "examMode": updated["examMode"],
        "durationMinutes": updated["durationMinutes"],
        "totalScore": updated["totalScore"],
    }
    row.variants, row.stats = updated["variants"], updated["stats"]
    adapter.commit_course_content(db, instance_id)
    db.refresh(row)
    return _exam_to_engine_dict(row)


def delete_exam(db: Session, user: User, course_id: int, exam_id: str) -> dict[str, bool]:
    instance_id = teacher_instance_id(db, user, course_id, exclusive=True)
    row = _load_exam_row(db, instance_id, exam_id)
    db.delete(row)
    adapter.commit_course_content(db, instance_id)
    return {"ok": True}


def list_exam_candidates(db: Session, user: User, course_id: int, exam_id: str, *, variant: str, uid: str) -> list[dict[str, Any]]:
    instance_id = teacher_instance_id(db, user, course_id)
    row = _load_exam_row(db, instance_id, exam_id)
    pool, _ = _live_pool_for_exam(db, user, instance_id, row)
    try:
        return exams_engine.find_candidates(_exam_to_engine_dict(row), variant, uid, pool)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def export_exam(
    db: Session,
    user: User,
    course_id: int,
    exam_id: str,
    *,
    kind: Literal["student_docx", "teacher_docx", "blueprint_xlsx", "xuexitong_xlsx", "xuexitong_txt", "zip"],
    variant: Literal["A", "B"] = "A",
) -> tuple[bytes, str, str]:
    instance_id = teacher_instance_id(db, user, course_id)
    exam_dict = _exam_to_engine_dict(_load_exam_row(db, instance_id, exam_id))
    base = exams_engine.safe_exam_filename(exam_dict["title"])
    v_tag = f"-{variant}卷" if exam_dict.get("abMode") else ""
    docx_mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    xlsx_mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    try:
        if kind == "student_docx":
            return exams_engine.export_student_docx(exam_dict, variant), docx_mime, f"{base}{v_tag}-学生卷.docx"
        if kind == "teacher_docx":
            return exams_engine.export_teacher_docx(exam_dict, variant), docx_mime, f"{base}{v_tag}-答案解析卷.docx"
        if kind == "blueprint_xlsx":
            return exams_engine.export_blueprint_xlsx(exam_dict), xlsx_mime, f"{base}-命题双向细目表.xlsx"
        if kind == "xuexitong_xlsx":
            return exams_engine.export_exam_xuexitong_xlsx(exam_dict, variant), xlsx_mime, f"{base}{v_tag}-学习通导入.xlsx"
        if kind == "xuexitong_txt":
            return exams_engine.export_exam_xuexitong_txt(exam_dict, variant).encode("utf-8"), "text/plain; charset=utf-8", f"{base}{v_tag}-学习通智能导入.txt"
        return exams_engine.export_exam_zip(exam_dict), "application/zip", f"{base}-试卷包.zip"
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


def register() -> None:
    """Register Course Studio exam gap-fill job handler."""
    jobs.register_handler("exam_fill_gaps", _run_exam_fill_gaps)
