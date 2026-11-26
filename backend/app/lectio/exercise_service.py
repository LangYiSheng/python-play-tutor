"""AI objective question generation job orchestration and Xuexitong validation/export."""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Literal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    Chapter,
    KnowledgePoint,
    Material,
    MaterialChapter,
    Question,
    QuestionChapter,
    QuestionKnowledgePoint,
    QuestionSecret,
    User,
)
from . import adapter, exercise_store, jobs
from .engine import exercises as exercises_engine
from .engine import knowledge as knowledge_engine
from .models import LectioJob


def collect_chapter_pages(
    db: Session,
    instance_id: int,
    chapter_id: int,
    *,
    material_id: int | None = None,
    owner_filter_id: int | None = None,
) -> tuple[list[dict[str, Any]], dict[int, tuple[int, int]]]:
    """Collect ordered pages for a chapter or material with non-colliding page numbers."""
    mat_stmt = (
        select(Material)
        .join(MaterialChapter, MaterialChapter.material_id == Material.id)
        .join(Chapter, Chapter.id == MaterialChapter.chapter_id)
        .where(
            Material.course_instance_id == instance_id,
            Chapter.course_instance_id == instance_id,
            MaterialChapter.chapter_id == chapter_id,
        )
        .order_by(Material.id)
    )
    if owner_filter_id is not None:
        mat_stmt = mat_stmt.where(Material.owner_id.is_(None) | (Material.owner_id == owner_filter_id))
    if material_id is not None:
        mat_stmt = mat_stmt.where(Material.id == material_id)
    materials = list(db.scalars(mat_stmt))

    per_material: list[tuple[Material, list[dict[str, Any]]]] = []
    for mat in materials:
        pages = [p for p in adapter.material_pages(db, mat) if str(p.get("text") or "").strip()]
        if pages:
            per_material.append((mat, pages))
    if not per_material:
        return [], {}

    combined: list[dict[str, Any]] = []
    origin: dict[int, tuple[int, int]] = {}
    if len(per_material) == 1:
        mat, pages = per_material[0]
        for page in pages:
            pno = int(page["page_no"])
            combined.append({**page, "page_no": pno})
            origin[pno] = (mat.id, pno)
        return combined, origin

    seq = 1
    for mat, pages in per_material:
        for page in pages:
            real_no = int(page["page_no"])
            combined.append({**page, "page_no": seq})
            origin[seq] = (mat.id, real_no)
            seq += 1
    return combined, origin


def chapter_knowledge_catalog(
    db: Session,
    instance_id: int,
    chapter_id: int,
    origin: dict[int, tuple[int, int]],
    *,
    owner_filter_id: int | None = None,
) -> tuple[dict[str, Any] | None, dict[int, list[int]]]:
    """Build knowledge section catalog and map material real pages to engine page indices."""
    stmt = select(KnowledgePoint).where(KnowledgePoint.course_instance_id == instance_id, KnowledgePoint.chapter_id == chapter_id)
    if owner_filter_id is not None:
        stmt = stmt.where(KnowledgePoint.owner_id.is_(None) | (KnowledgePoint.owner_id == owner_filter_id))
    points = list(db.scalars(stmt.order_by(KnowledgePoint.id)))
    if not points:
        return None, {}

    materials = {m.stable_id: m.id for m in db.scalars(select(Material).where(Material.course_instance_id == instance_id)) if m.stable_id}
    reverse_origin = {val: key for key, val in origin.items()}
    sec_buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    kp_engine_pages: dict[int, list[int]] = {}

    for pt in points:
        lectio = (pt.content or {}).get("lectio")
        sec_label = knowledge_engine.WHOLE_CHAPTER
        brief = ""
        pgs: list[int] = []
        if isinstance(lectio, dict):
            sec_label = str(lectio.get("section") or "").strip() or knowledge_engine.WHOLE_CHAPTER
            brief = str(lectio.get("brief") or "").strip()
            for src in lectio.get("sources") if isinstance(lectio.get("sources"), list) else []:
                if not isinstance(src, dict):
                    continue
                mid = materials.get(str(src.get("material_stable_id") or ""))
                if mid is None:
                    continue
                for real_p in src.get("pages") or []:
                    eng_p = reverse_origin.get((mid, real_p))
                    if eng_p is not None:
                        pgs.append(eng_p)
        kp_engine_pages[pt.id] = sorted(set(pgs))
        sec_buckets[sec_label].append({"title": pt.title, "brief": brief, "pages": kp_engine_pages[pt.id]})

    return {"sections": [{"number": "", "title": t, "points": pts} for t, pts in sec_buckets.items()]}, kp_engine_pages


def enqueue_generate_exercises(
    db: Session,
    user: User,
    classroom_id: int,
    chapter_id: int,
    *,
    material_id: int | None = None,
    counts: dict[str, int] | None = None,
    point_quotas: list[dict[str, Any]] | None = None,
) -> LectioJob:
    """Validate chapter inputs and enqueue async objective question generation."""
    classroom, instance_id = adapter.course_scope(db, user, classroom_id)
    adapter.authoring_chapter(db, user, chapter_id, instance_id)
    reason = adapter.authoring_unavailable_reason(db)
    if reason:
        raise HTTPException(409, reason)

    if material_id is not None:
        linked = db.scalar(
            adapter.visible_query(Material, instance_id, user)
            .join(MaterialChapter, MaterialChapter.material_id == Material.id)
            .where(Material.id == material_id, MaterialChapter.chapter_id == chapter_id)
        )
        if linked is None:
            raise HTTPException(422, "所选资料不存在或不属于当前章节")

    if point_quotas:
        kp_ids = [int(q["knowledge_point_id"]) for q in point_quotas]
        valid_kps = set(
            db.scalars(
                adapter.visible_query(KnowledgePoint, instance_id, user)
                .where(KnowledgePoint.chapter_id == chapter_id, KnowledgePoint.id.in_(kp_ids))
                .with_only_columns(KnowledgePoint.id)
            )
        )
        if set(kp_ids) - valid_kps:
            raise HTTPException(422, "配额中包含不存在或不属于当前章节的知识点")

    owner_filter = None if user.role == "admin" else classroom.teacher_id
    pages, _ = collect_chapter_pages(db, instance_id, chapter_id, material_id=material_id, owner_filter_id=owner_filter)
    if not pages:
        raise HTTPException(409, "当前章节下还没有可用于智能出题的资料页面")

    return jobs.enqueue_job(
        db,
        course_instance_id=instance_id,
        kind="exercises_generate",
        scope_key=f"chapter:{chapter_id}:exercises",
        user=user,
        payload={
            "classroom_id": classroom_id,
            "chapter_id": chapter_id,
            "material_id": material_id,
            "counts": counts,
            "point_quotas": point_quotas,
            "owner_id": classroom.teacher_id,
        },
        total=1,
        message="已加入智能出题队列",
    )


def chapter_existing_question_items(
    db: Session,
    course_instance_id: int,
    chapter_id: int,
) -> list[dict[str, Any]]:
    """Return existing chapter questions with canonical kind and linked KP titles for smart dedup."""
    rows = list(
        db.scalars(
            select(Question)
            .join(QuestionChapter, QuestionChapter.question_id == Question.id)
            .where(Question.course_instance_id == course_instance_id, QuestionChapter.chapter_id == chapter_id)
            .order_by(Question.id)
        )
    )
    if not rows:
        return []
    qids = [q.id for q in rows]
    pts_by_qid: dict[str, list[str]] = defaultdict(list)
    for qid, kp_title in db.execute(
        select(QuestionKnowledgePoint.question_id, KnowledgePoint.title)
        .join(KnowledgePoint, KnowledgePoint.id == QuestionKnowledgePoint.knowledge_point_id)
        .where(QuestionKnowledgePoint.question_id.in_(qids))
    ):
        if kp_title:
            pts_by_qid[qid].append(kp_title)
    return [
        {
            "stem": (q.prompt or q.title or "").strip(),
            "kind": exercises_engine.canonical_type(q.kind),
            "points": pts_by_qid.get(q.id, []),
        }
        for q in rows
        if (q.prompt or q.title or "").strip()
    ]


def _run_exercises_generate(db: Session, job: LectioJob) -> dict[str, Any]:
    payload = job.payload or {}
    classroom_id, chapter_id = int(payload["classroom_id"]), int(payload["chapter_id"])
    material_id, owner_id = payload.get("material_id"), payload.get("owner_id")

    pages, origin = collect_chapter_pages(
        db,
        job.course_instance_id,
        chapter_id,
        material_id=int(material_id) if material_id is not None else None,
        owner_filter_id=owner_id,
    )
    if not pages:
        raise ValueError("章节下没有可用的资料页面")

    catalog, kp_pages = chapter_knowledge_catalog(db, job.course_instance_id, chapter_id, origin, owner_filter_id=owner_id)
    existing_items = chapter_existing_question_items(db, job.course_instance_id, chapter_id)
    existing_stems = [it["stem"] for it in existing_items]

    quotas_engine: list[dict[str, Any]] | None = None
    if payload.get("point_quotas"):
        raw_quotas = payload["point_quotas"]
        kps = {
            kp.id: kp
            for kp in db.scalars(
                select(KnowledgePoint).where(
                    KnowledgePoint.course_instance_id == job.course_instance_id,
                    KnowledgePoint.chapter_id == chapter_id,
                    KnowledgePoint.id.in_([int(q["knowledge_point_id"]) for q in raw_quotas]),
                )
            )
        }
        quotas_engine = []
        for item in raw_quotas:
            kp = kps.get(int(item["knowledge_point_id"]))
            if kp is None:
                continue
            lectio = (kp.content or {}).get("lectio")
            sec = str(lectio.get("section") or "") if isinstance(lectio, dict) else ""
            quotas_engine.append(
                {
                    "title": kp.title,
                    "section": sec,
                    "pages": kp_pages.get(kp.id, []),
                    "single": int(item.get("single") or 0),
                    "multiple": int(item.get("multiple") or 0),
                    "true_false": int(item.get("true_false") or 0),
                    "fill_blank": int(item.get("fill_blank") or 0),
                }
            )

    llm = adapter.build_llm_client(db, check_cancel=lambda: jobs.check_cancel(db, job.id))
    jobs.update_progress(
        db,
        job.id,
        done=0,
        total=1,
        message="正在根据课件内容生成客观题…",
        result={"chapter_id": chapter_id, "created": 0, "skipped": 0, "question_ids": []},
    )
    created_ids: list[str] = []
    skipped_total = 0
    batch_persisted = False
    progress_state = {"done": 0, "total": 1}

    def _on_progress(d: int, t: int, msg: str) -> None:
        progress_state["done"] = d
        progress_state["total"] = max(1, t)
        suffix = f"（已入库 {len(created_ids)} 道）" if created_ids else ""
        jobs.update_progress(db, job.id, done=d, total=progress_state["total"], message=f"{msg}{suffix}")

    def _on_batch(batch_questions: list[dict[str, Any]]) -> None:
        nonlocal skipped_total, batch_persisted
        if not batch_questions:
            return
        jobs.check_cancel(db, job.id)
        batch_ids, batch_skipped = exercise_store.persist_generated_questions(
            db,
            classroom_id=classroom_id,
            instance_id=job.course_instance_id,
            chapter_id=chapter_id,
            owner_id=owner_id,
            raw_questions=batch_questions,
            page_origin=origin,
        )
        batch_persisted = True
        created_ids.extend(batch_ids)
        skipped_total += batch_skipped
        jobs.update_progress(
            db,
            job.id,
            done=progress_state["done"],
            total=progress_state["total"],
            result={
                "chapter_id": chapter_id,
                "created": len(created_ids),
                "skipped": skipped_total,
                "question_ids": list(created_ids),
            },
        )

    result = exercises_engine.generate_exercises_from_pages(
        pages,
        llm,
        counts=payload.get("counts"),
        point_quotas=quotas_engine,
        existing_stems=existing_stems,
        existing_items=existing_items,
        knowledge=catalog,
        allow_short_answer=False,
        single_blank_only=True,
        on_progress=_on_progress,
        on_batch=_on_batch,
    )
    jobs.check_cancel(db, job.id)
    if not batch_persisted and (result.get("questions") or []):
        fallback_ids, fallback_skipped = exercise_store.persist_generated_questions(
            db,
            classroom_id=classroom_id,
            instance_id=job.course_instance_id,
            chapter_id=chapter_id,
            owner_id=owner_id,
            raw_questions=result.get("questions") or [],
            page_origin=origin,
        )
        created_ids.extend(fallback_ids)
        skipped_total += fallback_skipped
    return {
        "chapter_id": chapter_id,
        "created": len(created_ids),
        "skipped": skipped_total,
        "question_ids": created_ids,
        "notes": result.get("notes") or [],
    }


def _collect_exportable_questions(
    db: Session,
    user: User,
    classroom_id: int,
    *,
    chapter_id: int | None = None,
    status: Literal["all", "ready", "draft"] = "all",
) -> tuple[list[dict[str, Any]], int, str]:
    _, instance_id = adapter.course_scope(db, user, classroom_id)
    q_stmt = adapter.visible_query(Question, instance_id, user).where(Question.status != "disabled")
    if status != "all":
        q_stmt = q_stmt.where(Question.status == status)
    if chapter_id is not None:
        adapter.authoring_chapter(db, user, chapter_id, instance_id)
        q_stmt = q_stmt.join(QuestionChapter, QuestionChapter.question_id == Question.id).where(
            QuestionChapter.chapter_id == chapter_id
        )

    questions = list(db.scalars(q_stmt.order_by(Question.id)))
    if not questions:
        return [], 0, "课程题库"

    qids = [q.id for q in questions]
    secrets = {s.question_id: s for s in db.scalars(select(QuestionSecret).where(QuestionSecret.question_id.in_(qids)))}
    chapters = {c.id: c for c in db.scalars(adapter.visible_query(Chapter, instance_id, user))}

    q_chapters: dict[str, list[int]] = defaultdict(list)
    for qid, cid in db.execute(select(QuestionChapter.question_id, QuestionChapter.chapter_id).where(QuestionChapter.question_id.in_(qids))):
        if cid in chapters:
            q_chapters[qid].append(cid)

    q_points: dict[str, list[str]] = defaultdict(list)
    for qid, title in db.execute(
        select(QuestionKnowledgePoint.question_id, KnowledgePoint.title)
        .join(KnowledgePoint, KnowledgePoint.id == QuestionKnowledgePoint.knowledge_point_id)
        .join(Chapter, Chapter.id == KnowledgePoint.chapter_id)
        .where(QuestionKnowledgePoint.question_id.in_(qids))
    ):
        q_points[qid].append(title)

    items: list[dict[str, Any]] = []
    skipped_non_objective = 0
    for q in questions:
        cids = q_chapters.get(q.id, [])
        ch_label = chapters[chapter_id].title if chapter_id in chapters else (chapters[cids[0]].title if cids else "")
        converted = exercise_store.reborn_question_to_lectio(
            q, secrets.get(q.id), chapter_label=ch_label, point_titles=q_points.get(q.id, [])
        )
        if converted is None:
            skipped_non_objective += 1
            continue
        items.append(converted)

    catalog_name = chapters[chapter_id].title if chapter_id is not None and chapter_id in chapters else "课程题库"
    return items, skipped_non_objective, catalog_name


def validate_exercises_export(
    db: Session,
    user: User,
    classroom_id: int,
    *,
    chapter_id: int | None = None,
    status: Literal["all", "ready", "draft"] = "all",
) -> dict[str, Any]:
    """Validate exportable objective questions for Xuexitong compatibility."""
    items, skipped, _ = _collect_exportable_questions(db, user, classroom_id, chapter_id=chapter_id, status=status)
    report = exercises_engine.validate_xuexitong_export(items)
    if skipped:
        report["warnings"] = [f"已跳过 {skipped} 道编程/交互类题目（仅导出客观题）", *report["warnings"]]
    return {**report, "skipped_non_objective": skipped}


def export_exercises(
    db: Session,
    user: User,
    classroom_id: int,
    *,
    fmt: Literal["xuexitong_xlsx", "xuexitong_txt", "xlsx"],
    chapter_id: int | None = None,
    status: Literal["all", "ready", "draft"] = "all",
) -> tuple[bytes, str, str]:
    """Export objective questions as Xuexitong XLSX/TXT or readable XLSX."""
    items, _, catalog_name = _collect_exportable_questions(db, user, classroom_id, chapter_id=chapter_id, status=status)
    if not items:
        raise HTTPException(409, "当前筛选条件下没有可导出的客观题")
    if fmt == "xuexitong_xlsx":
        return (
            exercises_engine.export_xuexitong_xlsx(items, catalog_name=catalog_name),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            f"{catalog_name}-学习通题库导入.xlsx",
        )
    if fmt == "xuexitong_txt":
        return (
            exercises_engine.export_xuexitong_txt(items).encode("utf-8"),
            "text/plain; charset=utf-8",
            f"{catalog_name}-学习通智能导入.txt",
        )
    return (
        exercises_engine.export_exercises_xlsx(items),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        f"{catalog_name}-客观题汇总.xlsx",
    )


def register() -> None:
    """Register Lectio exercise generation job handler."""
    jobs.register_handler("exercises_generate", _run_exercises_generate)
