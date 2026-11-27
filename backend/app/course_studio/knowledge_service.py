"""Course-scoped AI knowledge extraction, merging, and multi-format export."""

from __future__ import annotations

import json
import logging
from collections import defaultdict
from collections.abc import Callable, Sequence
from typing import Any, Literal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..course_scope import lock_course_content
from ..models import (
    Chapter,
    CourseInstance,
    KnowledgePoint,
    Material,
    MaterialChapter,
    Question,
    QuestionKnowledgePoint,
    User,
    now,
)
from ..teacher_scope import new_stable_id, teacher_instance_id
from . import adapter, jobs
from .engine import knowledge as knowledge_engine
from .engine.text_utils import squeeze_text
from .models import CourseStudioJob

log = logging.getLogger("course_studio.knowledge")

MAX_STUDIO_META_BYTES = 4000
MAX_KP_CONTENT_BYTES = 30000


def _resolved_point_sources(
    db: Session,
    instance_id: int,
    user: User,
    point: KnowledgePoint,
    mat_by_stable: dict[str, Material],
    mat_by_id: dict[int, Material],
) -> list[dict[str, Any]]:
    evidence: dict[int, set[int]] = defaultdict(set)
    raw_refs = (point.content or {}).get("page_refs")
    if isinstance(raw_refs, list) and raw_refs:
        from ..course_content.knowledge_graph import page_refs, source_pages

        refs = page_refs(raw_refs)
        if refs:
            for mid, page_no in source_pages(db, instance_id, user, refs).values():
                if mid in mat_by_id:
                    evidence[mid].add(page_no)
    studio_meta = (point.content or {}).get("course_studio")
    if isinstance(studio_meta, dict) and isinstance(studio_meta.get("sources"), list):
        for src in studio_meta["sources"]:
            if not isinstance(src, dict):
                continue
            mat = mat_by_stable.get(str(src.get("material_stable_id") or ""))
            if mat is None:
                continue
            for page_no in src.get("pages") or []:
                if type(page_no) is int and page_no > 0:
                    evidence[mat.id].add(page_no)
    return [
        {
            "material_id": mid,
            "material_title": mat_by_id[mid].title,
            "pages": sorted(pages),
        }
        for mid, pages in sorted(evidence.items())
        if mid in mat_by_id
    ]


def list_knowledge(db: Session, user: User, course_id: int) -> dict[str, Any]:
    """Return course chapters with materials and normalized knowledge points."""
    instance_id = teacher_instance_id(db, user, course_id)
    chapters = list(db.scalars(adapter.visible_query(Chapter, instance_id, user).order_by(Chapter.order_index, Chapter.id)))
    materials = list(db.scalars(adapter.visible_query(Material, instance_id, user).order_by(Material.id)))
    mat_by_id = {m.id: m for m in materials}
    mat_by_stable = {m.stable_id: m for m in materials if m.stable_id}

    chapter_materials: dict[int, list[Material]] = defaultdict(list)
    if chapters and materials:
        links = db.execute(
            select(MaterialChapter.chapter_id, MaterialChapter.material_id).where(
                MaterialChapter.chapter_id.in_([c.id for c in chapters]),
                MaterialChapter.material_id.in_([m.id for m in materials]),
            )
        )
        for cid, mid in links:
            if mid in mat_by_id:
                chapter_materials[cid].append(mat_by_id[mid])

    points = list(
        db.scalars(
            adapter.visible_query(KnowledgePoint, instance_id, user).order_by(KnowledgePoint.chapter_id, KnowledgePoint.id)
        )
    )
    q_counts: dict[int, int] = {}
    if points:
        visible_q = adapter.visible_query(Question, instance_id, user).with_only_columns(Question.id)
        rows = db.execute(
            select(QuestionKnowledgePoint.knowledge_point_id, func.count(QuestionKnowledgePoint.question_id))
            .where(
                QuestionKnowledgePoint.knowledge_point_id.in_([p.id for p in points]),
                QuestionKnowledgePoint.question_id.in_(visible_q),
            )
            .group_by(QuestionKnowledgePoint.knowledge_point_id)
        )
        q_counts = {pid: int(cnt) for pid, cnt in rows}

    points_by_chapter: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for pt in points:
        studio_meta = (pt.content or {}).get("course_studio")
        sec = str(studio_meta.get("section") or "") if isinstance(studio_meta, dict) else ""
        brief = str(studio_meta.get("brief") or "") if isinstance(studio_meta, dict) else ""
        points_by_chapter[pt.chapter_id].append(
            {
                "id": pt.id,
                "stable_id": pt.stable_id,
                "chapter_id": pt.chapter_id,
                "title": pt.title,
                "section": sec,
                "brief": brief,
                "question_count": q_counts.get(pt.id, 0),
                "sources": _resolved_point_sources(db, instance_id, user, pt, mat_by_stable, mat_by_id),
            }
        )

    return {
        "chapters": [
            {
                "id": ch.id,
                "stable_id": ch.stable_id,
                "title": ch.title,
                "order_index": ch.order_index,
                "materials": [
                    {
                        "id": m.id,
                        "stable_id": m.stable_id,
                        "title": m.title,
                        "kind": m.kind,
                        "pages": len(adapter.material_pages(db, m)),
                    }
                    for m in chapter_materials[ch.id]
                ],
                "points": points_by_chapter[ch.id],
            }
            for ch in chapters
        ]
    }


def enqueue_extract_knowledge(
    db: Session,
    user: User,
    course_id: int,
    chapter_id: int,
    *,
    material_ids: list[int] | None = None,
) -> CourseStudioJob:
    """Validate chapter/materials and enqueue async knowledge extraction job."""
    instance_id = teacher_instance_id(db, user, course_id, exclusive=True)
    adapter.authoring_chapter(db, user, chapter_id, instance_id)
    reason = adapter.authoring_unavailable_reason(db)
    if reason:
        raise HTTPException(409, reason)

    mat_stmt = (
        adapter.visible_query(Material, instance_id, user)
        .join(MaterialChapter, MaterialChapter.material_id == Material.id)
        .where(MaterialChapter.chapter_id == chapter_id)
        .order_by(Material.id)
    )
    chapter_mats = list(db.scalars(mat_stmt))
    by_id = {m.id: m for m in chapter_mats}
    if material_ids is not None:
        if any(mid not in by_id for mid in material_ids):
            raise HTTPException(422, "所选资料不存在或不属于当前章节")
        candidates = [by_id[mid] for mid in material_ids]
    else:
        candidates = chapter_mats

    usable = [m.id for m in candidates if adapter.material_pages(db, m)]
    if not usable:
        raise HTTPException(409, "当前章节下还没有可用于抽取知识点的资料页面")

    return jobs.enqueue_job(
        db,
        course_instance_id=instance_id,
        kind="knowledge_extract",
        scope_key=f"chapter:{chapter_id}:knowledge",
        user=user,
        payload={
            "chapter_id": chapter_id,
            "material_ids": usable,
        },
        total=len(usable),
        message="已加入知识点抽取队列",
    )


def _bigrams(text: str) -> set[str]:
    if len(text) < 2:
        return {text} if text else set()
    return {text[i : i + 2] for i in range(len(text) - 1)}


def _title_similarity(a: str, b: str) -> float:
    sa, sb = squeeze_text(a), squeeze_text(b)
    if not sa or not sb:
        return 0.0
    if sa == sb:
        return 1.0
    ga, gb = _bigrams(sa), _bigrams(sb)
    union = len(ga | gb)
    return len(ga & gb) / union if union else 0.0


def _kp_pages_for_material(kp: KnowledgePoint, mat_stable_id: str) -> set[int]:
    studio_meta = (kp.content or {}).get("course_studio")
    if not isinstance(studio_meta, dict):
        return set()
    for src in studio_meta.get("sources") if isinstance(studio_meta.get("sources"), list) else []:
        if isinstance(src, dict) and str(src.get("material_stable_id") or "") == mat_stable_id:
            return {p for p in (src.get("pages") or []) if type(p) is int and p > 0}
    return set()


def _find_matching_point(
    title: str,
    pages: Sequence[int],
    mat_stable_id: str,
    by_key: dict[str, KnowledgePoint],
) -> KnowledgePoint | None:
    key = squeeze_text(title)
    if not key:
        return None
    direct = by_key.get(key)
    if direct is not None:
        return direct
    new_pages = {int(p) for p in pages if int(p) > 0}
    best: KnowledgePoint | None = None
    best_score = 0.0
    for kp in by_key.values():
        existing_key = squeeze_text(kp.title)
        if not existing_key:
            continue
        sim = _title_similarity(key, existing_key)
        kp_pages = _kp_pages_for_material(kp, mat_stable_id)
        overlap = bool(new_pages and kp_pages and (new_pages & kp_pages))
        contained = len(min(key, existing_key, key=len)) >= 3 and (key in existing_key or existing_key in key)
        if sim >= 0.62 or (overlap and (sim >= 0.42 or contained)):
            score = sim + (0.2 if overlap else 0.0)
            if score > best_score:
                best_score = score
                best = kp
    return best


def _merge_studio_meta(
    existing_meta: Any,
    section: str,
    brief: str,
    stable_id: str,
    pages: Sequence[int],
    *,
    replace_material: bool = False,
    live_mat_stables: set[str] | None = None,
) -> dict[str, Any]:
    meta = dict(existing_meta) if isinstance(existing_meta, dict) else {}
    cur_section = str(meta.get("section") or "").strip()
    cur_brief = str(meta.get("brief") or "").strip()
    # Keep only safe keys inside content['course_studio']; never use remap_references reserved keys.
    sources_map: dict[str, set[int]] = defaultdict(set)
    for src in meta.get("sources") if isinstance(meta.get("sources"), list) else []:
        if isinstance(src, dict) and isinstance(src.get("material_stable_id"), str) and src["material_stable_id"]:
            mid = src["material_stable_id"]
            if live_mat_stables is not None and mid not in live_mat_stables:
                continue
            if replace_material and mid == stable_id:
                continue
            for p in src.get("pages") or []:
                if type(p) is int and p > 0:
                    sources_map[mid].add(p)
    for p in pages:
        if type(p) is int and p > 0:
            sources_map[stable_id].add(p)
    merged = {
        "section": (section or cur_section)[:80],
        "brief": (brief or cur_brief)[:120],
        "sources": [
            {"material_stable_id": mid, "pages": sorted(pgs)}
            for mid, pgs in sorted(sources_map.items())
        ],
    }
    if len(json.dumps(merged, ensure_ascii=False)) > MAX_STUDIO_META_BYTES:
        merged["brief"] = merged["brief"][:40]
        merged["sources"] = merged["sources"][:20]
    return merged


def _kp_source_stables(kp: KnowledgePoint) -> set[str]:
    studio_meta = (kp.content or {}).get("course_studio")
    if not isinstance(studio_meta, dict):
        return set()
    raw_sources = studio_meta.get("sources")
    if not isinstance(raw_sources, list):
        return set()
    return {
        str(s.get("material_stable_id") or "")
        for s in raw_sources
        if isinstance(s, dict) and s.get("material_stable_id")
    }


def _is_sole_source_auto_kp(
    kp: KnowledgePoint,
    reextract_stables: set[str],
    linked_q_kps: set[int],
) -> bool:
    if kp.id in linked_q_kps:
        return False
    if str((kp.content or {}).get("summary_markdown") or "").strip():
        return False
    src_ids = _kp_source_stables(kp)
    return bool(src_ids) and src_ids <= reextract_stables


def _stable_existing_titles(
    db: Session,
    course_instance_id: int,
    chapter_id: int,
    reextract_stables: set[str],
) -> list[str]:
    existing = list(
        db.scalars(
            select(KnowledgePoint).where(
                KnowledgePoint.course_instance_id == course_instance_id,
                KnowledgePoint.chapter_id == chapter_id,
            )
        )
    )
    if not existing:
        return []
    linked_q_kps = set(
        db.scalars(
            select(QuestionKnowledgePoint.knowledge_point_id).where(
                QuestionKnowledgePoint.knowledge_point_id.in_([kp.id for kp in existing])
            )
        )
    )
    return [
        kp.title
        for kp in existing
        if not _is_sole_source_auto_kp(kp, reextract_stables, linked_q_kps)
    ]


def _persist_extracted_points(
    db: Session,
    *,
    course_instance_id: int,
    chapter_id: int,
    extracted: list[tuple[str, dict[str, Any], str]],
    succeeded_stables: set[str],
    notes: list[str],
    errors: list[str],
) -> dict[str, Any]:
    lock_course_content(db, course_instance_id, exclusive=True)
    course = db.get(CourseInstance, course_instance_id, populate_existing=True)
    live_chapter = db.scalar(
        select(Chapter).where(Chapter.id == chapter_id, Chapter.course_instance_id == course_instance_id)
    )
    if course is None or live_chapter is None:
        raise ValueError("章节已在抽取期间删除，未写入知识点")

    live_mat_stables = {
        m.stable_id
        for m in db.scalars(select(Material).where(Material.course_instance_id == course_instance_id))
        if m.stable_id
    }
    existing = list(
        db.scalars(
            select(KnowledgePoint).where(
                KnowledgePoint.course_instance_id == course_instance_id,
                KnowledgePoint.chapter_id == chapter_id,
            )
        )
    )
    linked_q_kps: set[int] = set()
    if existing:
        linked_q_kps = set(
            db.scalars(
                select(QuestionKnowledgePoint.knowledge_point_id).where(
                    QuestionKnowledgePoint.knowledge_point_id.in_([kp.id for kp in existing])
                )
            )
        )
    by_key = {squeeze_text(pt.title): pt for pt in existing}
    touched_mat_pairs: set[tuple[int, str]] = set()
    touched_kp_ids: set[int] = set()
    created = 0
    updated = 0

    for sec_label, pt, mat_stable_id in extracted:
        title = str(pt["title"]).strip()[:200]
        key = squeeze_text(title)
        if not key:
            continue
        brief = str(pt.get("brief") or "").strip()
        pgs = [int(p) for p in (pt.get("pages") or []) if int(p) > 0]
        hit = _find_matching_point(title, pgs, mat_stable_id, by_key)
        if hit is not None:
            content = dict(hit.content or {})
            first_touch = hit.id is not None and (hit.id, mat_stable_id) not in touched_mat_pairs
            if (
                first_touch
                and hit.title != title
                and _is_sole_source_auto_kp(hit, succeeded_stables, linked_q_kps)
                and (key not in by_key or by_key[key] is hit)
            ):
                old_key = squeeze_text(hit.title)
                if by_key.get(old_key) is hit:
                    by_key.pop(old_key, None)
                hit.title = title
                by_key[key] = hit
            content["course_studio"] = _merge_studio_meta(
                content.get("course_studio"),
                sec_label,
                brief,
                mat_stable_id,
                pgs,
                replace_material=first_touch,
                live_mat_stables=live_mat_stables,
            )
            if len(json.dumps(content, ensure_ascii=False)) <= MAX_KP_CONTENT_BYTES:
                hit.content = content
                updated += 1
            if hit.id is not None:
                touched_mat_pairs.add((hit.id, mat_stable_id))
                touched_kp_ids.add(hit.id)
        else:
            studio_meta = _merge_studio_meta(
                None,
                sec_label,
                brief,
                mat_stable_id,
                pgs,
                live_mat_stables=live_mat_stables,
            )
            kp = KnowledgePoint(
                chapter_id=chapter_id,
                owner_id=course.teacher_id,
                course_instance_id=course_instance_id,
                stable_id=new_stable_id(),
                title=title,
                content={"course_studio": studio_meta},
            )
            db.add(kp)
            by_key[key] = kp
            created += 1

    # On re-extraction, retire stale sole-source AI KPs of the re-extracted material(s) that were
    # not matched in this fresh run, while keeping manual KPs and question-linked KPs intact.
    retired = 0
    if succeeded_stables and existing:
        at = now()
        for kp in existing:
            if kp.id in touched_kp_ids or kp.id in linked_q_kps:
                continue
            studio_meta = (kp.content or {}).get("course_studio")
            if not isinstance(studio_meta, dict):
                continue
            raw_sources = studio_meta.get("sources")
            if not isinstance(raw_sources, list) or not raw_sources:
                continue
            src_ids = _kp_source_stables(kp)
            if not (src_ids & succeeded_stables):
                continue
            manual_summary = str((kp.content or {}).get("summary_markdown") or "").strip()
            remaining_other = (src_ids & live_mat_stables) - succeeded_stables
            if not remaining_other and not manual_summary:
                kp.deleted_at = at
                retired += 1
            elif remaining_other:
                kept = [
                    s for s in raw_sources
                    if isinstance(s, dict) and str(s.get("material_stable_id") or "") in remaining_other
                ]
                kp.content = {**kp.content, "course_studio": {**studio_meta, "sources": kept}}

    adapter.commit_course_content(db, course_instance_id)
    return {
        "skipped": False,
        "chapter_id": chapter_id,
        "created": created,
        "updated": updated,
        "retired": retired,
        "total_extracted": len(extracted),
        "notes": notes[:10],
        "errors": errors[:5],
    }


def extract_material_knowledge(
    db: Session,
    material: Material,
    *,
    llm: Any | None = None,
    check_cancel: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Extract and merge knowledge points for a single material into its linked chapter."""
    instance_id = material.course_instance_id
    if instance_id is None:
        return {"skipped": True, "reason": "资料未归属课程，已跳过知识点抽取", "created": 0, "updated": 0, "retired": 0, "total_extracted": 0}
    chapter = db.scalar(
        select(Chapter)
        .join(MaterialChapter, MaterialChapter.chapter_id == Chapter.id)
        .where(
            MaterialChapter.material_id == material.id,
            Chapter.course_instance_id == instance_id,
        )
        .order_by(Chapter.order_index, Chapter.id)
        .limit(1)
    )
    if chapter is None:
        return {"skipped": True, "reason": "资料未关联章节，已跳过知识点抽取", "created": 0, "updated": 0, "retired": 0, "total_extracted": 0}

    pages = adapter.material_pages(db, material)
    if not pages:
        return {"skipped": True, "reason": "资料没有可抽取知识点的页面", "created": 0, "updated": 0, "retired": 0, "total_extracted": 0}

    existing_titles = _stable_existing_titles(db, instance_id, chapter.id, {material.stable_id})
    llm_client = llm if llm is not None else adapter.build_llm_client(db, check_cancel=check_cancel)
    if check_cancel is not None:
        check_cancel()
    res = knowledge_engine.extract_knowledge_points(pages, llm_client, existing_titles=existing_titles)
    extracted: list[tuple[str, dict[str, Any], str]] = []
    for sec in res.get("sections") or []:
        sec_title = " ".join(x for x in (sec.get("number"), sec.get("title")) if x).strip() or knowledge_engine.WHOLE_CHAPTER
        for pt in sec.get("points") or []:
            if isinstance(pt, dict) and str(pt.get("title") or "").strip():
                extracted.append((sec_title, pt, material.stable_id))
    if not extracted:
        raise RuntimeError("未能从资料中抽取出知识点")
    if check_cancel is not None:
        check_cancel()
    return _persist_extracted_points(
        db,
        course_instance_id=instance_id,
        chapter_id=chapter.id,
        extracted=extracted,
        succeeded_stables={material.stable_id},
        notes=[str(n) for n in (res.get("notes") or [])],
        errors=[],
    )


def _run_knowledge_extract(db: Session, job: CourseStudioJob) -> dict[str, Any]:
    payload = job.payload or {}
    chapter_id = int(payload["chapter_id"])
    material_ids = [int(x) for x in (payload.get("material_ids") or [])]

    chapter = db.scalar(
        select(Chapter).where(Chapter.id == chapter_id, Chapter.course_instance_id == job.course_instance_id)
    )
    if chapter is None:
        raise ValueError("章节不存在或已删除")

    snapshots: list[tuple[str, str, list[dict[str, Any]]]] = []
    for mid in material_ids:
        mat = db.scalar(
            select(Material).join(MaterialChapter, MaterialChapter.material_id == Material.id).where(
                Material.id == mid, Material.course_instance_id == job.course_instance_id, MaterialChapter.chapter_id == chapter_id
            )
        )
        if mat is None:
            continue
        pages = adapter.material_pages(db, mat)
        if pages:
            snapshots.append((mat.stable_id, mat.title, pages))
    if not snapshots:
        raise ValueError("章节下没有可用的资料页面")

    existing_titles = _stable_existing_titles(
        db,
        job.course_instance_id,
        chapter_id,
        {stable_id for stable_id, _, _ in snapshots},
    )

    llm = adapter.build_llm_client(db, check_cancel=lambda: jobs.check_cancel(db, job.id))
    extracted: list[tuple[str, dict[str, Any], str]] = []
    succeeded_stables: set[str] = set()
    notes: list[str] = []
    errors: list[str] = []

    for idx, (mat_stable_id, mat_title, pages) in enumerate(snapshots):
        jobs.check_cancel(db, job.id)
        jobs.update_progress(db, job.id, done=idx, total=len(snapshots), message=f"正在抽取「{mat_title}」知识点…")
        try:
            res = knowledge_engine.extract_knowledge_points(pages, llm, existing_titles=existing_titles)
            notes.extend(str(n) for n in (res.get("notes") or []))
            mat_count = 0
            for sec in res.get("sections") or []:
                sec_title = " ".join(x for x in (sec.get("number"), sec.get("title")) if x).strip() or knowledge_engine.WHOLE_CHAPTER
                for pt in sec.get("points") or []:
                    if isinstance(pt, dict) and str(pt.get("title") or "").strip():
                        extracted.append((sec_title, pt, mat_stable_id))
                        mat_count += 1
                        if pt["title"] not in existing_titles:
                            existing_titles.append(str(pt["title"]).strip())
            if mat_count > 0:
                succeeded_stables.add(mat_stable_id)
        except Exception as exc:  # noqa: BLE001 -- preserve partial material extraction results
            log.warning("knowledge extract failed on material %s: %s", mat_stable_id, exc)
            errors.append(f"{mat_title}: {exc}")

    if not extracted:
        raise RuntimeError("；".join(errors) or "未能从资料中抽取出知识点")

    jobs.check_cancel(db, job.id)
    result = _persist_extracted_points(
        db,
        course_instance_id=job.course_instance_id,
        chapter_id=chapter_id,
        extracted=extracted,
        succeeded_stables=succeeded_stables,
        notes=notes,
        errors=errors,
    )
    result.pop("skipped", None)
    return result


def export_knowledge(
    db: Session,
    user: User,
    course_id: int,
    *,
    fmt: Literal["xmind", "xlsx", "docx"],
    chapter_id: int | None = None,
) -> tuple[bytes, str, str]:
    """Export course or chapter knowledge points as .xmind, .xlsx, or .docx."""
    overview = list_knowledge(db, user, course_id)
    chapters = overview["chapters"]
    if chapter_id is not None:
        chapters = [ch for ch in chapters if ch["id"] == chapter_id]
        if not chapters:
            raise HTTPException(404, "章节不存在或不属于当前课程")

    export_chapters: list[dict[str, Any]] = []
    total_points = 0
    for ch in chapters:
        sec_buckets: dict[str, dict[str, Any]] = {}
        for pt in ch["points"]:
            sec_title = pt["section"] or knowledge_engine.WHOLE_CHAPTER
            sec = sec_buckets.setdefault(
                sec_title,
                {"number": "", "title": sec_title, "pages": [], "points": []},
            )
            merged_pages = sorted({p for src in pt["sources"] for p in src["pages"]})
            sec["points"].append({"title": pt["title"], "brief": pt["brief"], "pages": merged_pages})
            total_points += 1
        if sec_buckets:
            export_chapters.append({"title": ch["title"], "sections": list(sec_buckets.values())})

    if not total_points or not export_chapters:
        raise HTTPException(409, "当前课程暂无可导出的知识点")

    course_title = chapters[0]["title"] if len(chapters) == 1 else "课程知识图谱"
    if fmt == "xmind":
        data = knowledge_engine.export_knowledge_xmind(course_title, export_chapters)
        return data, "application/octet-stream", f"{course_title}-知识图谱.xmind"
    if fmt == "xlsx":
        data = knowledge_engine.export_knowledge_xlsx(course_title, export_chapters)
        return (
            data,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            f"{course_title}-知识图谱.xlsx",
        )
    data = knowledge_engine.export_knowledge_docx(course_title, export_chapters)
    return (
        data,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        f"{course_title}-知识图谱.docx",
    )


def register() -> None:
    """Register Course Studio knowledge extraction job handler."""
    jobs.register_handler("knowledge_extract", _run_knowledge_extract)
