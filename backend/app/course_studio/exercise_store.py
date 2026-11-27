"""Persistence and conversion between Reborn Question rows and normalized Course Studio dicts."""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import timedelta
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..course_content.question_contracts import QuestionInput
from ..course_scope import lock_course_content
from ..models import (
    Chapter,
    CourseInstance,
    KnowledgePoint,
    Material,
    Question,
    QuestionChapter,
    QuestionKnowledgePoint,
    QuestionSecret,
    now,
)
from ..question_types import answer_value
from ..teacher_scope import scoped_key
from . import adapter
from .engine import exercises as exercises_engine
from .engine.text_utils import squeeze_text

STUDIO_TO_REBORN: dict[str, str] = {
    "single": "single_choice",
    "multiple": "multiple_choice",
    "true_false": "boolean",
    "fill_blank": "fill",
}
REBORN_TO_STUDIO: dict[str, str] = {v: k for k, v in STUDIO_TO_REBORN.items()}


def convert_generated_to_reborn(
    raw: dict[str, Any],
    *,
    stable_id: str,
    chapter_id: int,
    knowledge_point_ids: list[int],
    source: dict[str, Any],
) -> dict[str, Any] | None:
    """Convert one normalized Course Studio question dict into strict QuestionInput payload."""
    canon = exercises_engine.canonical_type(str(raw.get("type") or ""))
    reborn_kind = STUDIO_TO_REBORN.get(canon)
    if reborn_kind is None:
        return None
    stem = str(raw.get("question") or "").strip()
    if len(stem) < 4:
        return None
    title = (stem.splitlines()[0].strip()[:120]) or "AI 生成题目"
    opts_raw = raw.get("options") if isinstance(raw.get("options"), dict) else {}

    options: list[str] = []
    answer: Any = None
    if canon == "single":
        options = [str(opts_raw.get(k) or "").strip() for k in "abcd"]
        ans_key = str(raw.get("answer") or "").strip().lower()
        if len(options) != 4 or any(not o for o in options) or ans_key not in opts_raw:
            return None
        answer = str(opts_raw[ans_key]).strip()
    elif canon == "multiple":
        options = [str(opts_raw.get(k) or "").strip() for k in "abcd"]
        ans_keys = [str(k).strip().lower() for k in (raw.get("answer") or []) if str(k).strip().lower() in opts_raw]
        if len(options) != 4 or any(not o for o in options) or len(set(ans_keys)) < 2:
            return None
        answer = [str(opts_raw[k]).strip() for k in ans_keys]
    elif canon == "true_false":
        ans_key = str(raw.get("answer") or "").strip().lower()
        if ans_key not in {"a", "b"}:
            return None
        answer = ans_key == "a"
    elif canon == "fill_blank":
        ans_list = raw.get("answer") if isinstance(raw.get("answer"), list) else [raw.get("answer")]
        if not exercises_engine.is_single_blank_fill(stem, ans_list):
            return None
        answer = [str(ans_list[0]).strip()]

    return {
        "id": stable_id,
        "title": title,
        "kind": reborn_kind,
        "prompt": stem,
        "chapter_ids": [chapter_id],
        "knowledge_point_ids": knowledge_point_ids[:65],
        "source_type": "ai_generated",
        "status": "draft",
        "options": options,
        "samples": [],
        "hints": [],
        "starter_code": "",
        "interactive": None,
        "answer": answer,
        "hidden_cases": [],
        "source": source,
    }


def persist_generated_questions(
    db: Session,
    *,
    instance_id: int,
    chapter_id: int,
    raw_questions: Sequence[dict[str, Any]],
    page_origin: dict[int, tuple[int, int]],
) -> tuple[list[str], int]:
    """Persist AI-generated objective questions as status='draft' under course lock."""
    lock_course_content(db, instance_id, exclusive=True)
    course = db.get(CourseInstance, instance_id, populate_existing=True)
    chapter = db.scalar(
        select(Chapter).where(Chapter.id == chapter_id, Chapter.course_instance_id == instance_id)
    )
    if course is None or chapter is None:
        raise ValueError("章节已删除，无法保存生成的题目")
    owner_id = course.teacher_id

    kp_stmt = select(KnowledgePoint).where(
        KnowledgePoint.course_instance_id == instance_id,
        KnowledgePoint.chapter_id == chapter_id,
    )
    kp_stmt = kp_stmt.where(KnowledgePoint.owner_id.is_(None) | (KnowledgePoint.owner_id == owner_id))
    kp_by_key = {squeeze_text(kp.title): kp.id for kp in db.scalars(kp_stmt) if squeeze_text(kp.title)}

    existing_pool: list[tuple[str, str]] = [
        (q.prompt or q.title, exercises_engine.canonical_type(q.kind))
        for q in db.scalars(
            select(Question)
            .join(QuestionChapter, QuestionChapter.question_id == Question.id)
            .where(Question.course_instance_id == instance_id, QuestionChapter.chapter_id == chapter_id)
        )
        if (q.prompt or q.title or "").strip()
    ]

    mat_ids = {mat_id for mat_id, _ in page_origin.values()}
    live_materials: dict[int, set[int]] = {}
    if mat_ids:
        for mat in db.scalars(select(Material).where(Material.course_instance_id == instance_id, Material.id.in_(mat_ids))):
            if mat.owner_id in {None, owner_id}:
                live_materials[mat.id] = {
                    int(p.get("page_no") or p.get("id"))
                    for p in ((mat.content or {}).get("pages") or [])
                    if isinstance(p, dict) and isinstance(p.get("page_no") or p.get("id"), int)
                }

    created_ids: list[str] = []
    skipped = 0
    batch_now = now()
    for idx, q in enumerate(raw_questions):
        stem_text = str(q.get("question") or "").strip()
        q_kind = exercises_engine.canonical_type(str(q.get("type") or ""))
        stem_k = exercises_engine.stem_key(stem_text)
        if not stem_k or any(
            exercises_engine.is_near_duplicate_stem(
                stem_text,
                ex_stem,
                same_kind=bool(q_kind and ex_kind and q_kind == ex_kind) or not ex_kind,
            )
            for ex_stem, ex_kind in existing_pool
        ):
            skipped += 1
            continue

        kp_ids: list[int] = []
        for title in q.get("knowledge_points") or []:
            kid = kp_by_key.get(squeeze_text(str(title)))
            if kid is not None and kid not in kp_ids:
                kp_ids.append(kid)

        source: dict[str, Any] = {
            "created_at": (batch_now + timedelta(microseconds=idx)).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        }
        try:
            eng_page = int(q.get("page") or 0)
        except (TypeError, ValueError):
            eng_page = 0
        if eng_page in page_origin:
            mid, real_no = page_origin[eng_page]
            if mid in live_materials and real_no in live_materials[mid]:
                source["material_id"] = mid
                source["page_no"] = real_no
        explanation = str(q.get("explanation") or "").strip()
        if explanation:
            source["explanation"] = explanation[:2000]
        difficulty = str(q.get("difficulty") or "").strip()
        if difficulty in {"易", "中", "难"}:
            source["difficulty"] = difficulty

        stable_id = f"ai-{uuid.uuid4().hex[:12]}"
        payload = convert_generated_to_reborn(
            q, stable_id=stable_id, chapter_id=chapter_id, knowledge_point_ids=kp_ids, source=source
        )
        if payload is None:
            skipped += 1
            continue

        try:
            # Verify readiness rules before inserting as teacher-reviewable draft.
            QuestionInput.model_validate({**payload, "status": "ready"}, strict=True)
            validated = QuestionInput.model_validate(payload, strict=True)
        except ValidationError:
            skipped += 1
            continue

        runtime_id = scoped_key(instance_id, "question", stable_id)
        db.add(
            Question(
                id=runtime_id,
                stable_id=stable_id,
                course_instance_id=instance_id,
                owner_id=owner_id,
                source_type="ai_generated",
                status="draft",
                title=validated.title,
                kind=validated.kind,
                prompt=validated.prompt,
                options=validated.options,
                samples=[],
                hints=[],
                starter_code="",
                interactive=None,
                source=validated.source,
            )
        )
        db.add(QuestionSecret(question_id=runtime_id, answer=validated.answer, hidden_cases=[]))
        db.add(QuestionChapter(question_id=runtime_id, chapter_id=chapter_id))
        for kid in validated.knowledge_point_ids:
            db.add(QuestionKnowledgePoint(question_id=runtime_id, knowledge_point_id=kid))
        existing_pool.append((stem_text, q_kind))
        created_ids.append(runtime_id)

    if created_ids:
        adapter.commit_course_content(db, instance_id)
    return created_ids, skipped


def persist_generated_coding_questions(
    db: Session,
    *,
    instance_id: int,
    chapter_id: int,
    raw_questions: Sequence[dict[str, Any]],
    page_origin: dict[int, tuple[int, int]],
    fallback_kp_ids: Sequence[int] = (),
) -> tuple[list[str], int]:
    """Persist sandbox-verified AI coding questions as status='draft' under course lock."""
    lock_course_content(db, instance_id, exclusive=True)
    course = db.get(CourseInstance, instance_id, populate_existing=True)
    chapter = db.scalar(
        select(Chapter).where(Chapter.id == chapter_id, Chapter.course_instance_id == instance_id)
    )
    if course is None or chapter is None:
        raise ValueError("章节已删除，无法保存生成的编程题")
    owner_id = course.teacher_id

    kp_stmt = select(KnowledgePoint).where(
        KnowledgePoint.course_instance_id == instance_id,
        KnowledgePoint.chapter_id == chapter_id,
    )
    kp_stmt = kp_stmt.where(KnowledgePoint.owner_id.is_(None) | (KnowledgePoint.owner_id == owner_id))
    chapter_kps = list(db.scalars(kp_stmt))
    kp_by_key = {squeeze_text(kp.title): kp.id for kp in chapter_kps if squeeze_text(kp.title)}
    valid_kp_ids = {kp.id for kp in chapter_kps}
    safe_fallback_kps = [kid for kid in fallback_kp_ids if kid in valid_kp_ids][:3]

    existing_pool: list[tuple[str, str]] = [
        ((q.title or "").strip(), (q.prompt or "").strip())
        for q in db.scalars(
            select(Question)
            .join(QuestionChapter, QuestionChapter.question_id == Question.id)
            .where(
                Question.course_instance_id == instance_id,
                QuestionChapter.chapter_id == chapter_id,
                Question.kind == "python",
            )
        )
        if (q.title or q.prompt or "").strip()
    ]

    mat_ids = {mat_id for mat_id, _ in page_origin.values()}
    live_materials: dict[int, set[int]] = {}
    if mat_ids:
        for mat in db.scalars(select(Material).where(Material.course_instance_id == instance_id, Material.id.in_(mat_ids))):
            if mat.owner_id in {None, owner_id}:
                live_materials[mat.id] = {
                    int(p.get("page_no") or p.get("id"))
                    for p in ((mat.content or {}).get("pages") or [])
                    if isinstance(p, dict) and isinstance(p.get("page_no") or p.get("id"), int)
                }

    created_ids: list[str] = []
    skipped = 0
    batch_now = now()
    for idx, q in enumerate(raw_questions):
        title = str(q.get("title") or "").strip()[:120]
        prompt = str(q.get("prompt") or "").strip()
        if not title or not prompt:
            skipped += 1
            continue
        if any(
            (ex_title and exercises_engine.is_near_duplicate_stem(title, ex_title, same_kind=True))
            or (ex_prompt and exercises_engine.is_near_duplicate_stem(prompt, ex_prompt, same_kind=True))
            for ex_title, ex_prompt in existing_pool
        ):
            skipped += 1
            continue

        kp_ids: list[int] = []
        for kp_title in q.get("knowledge_points") or []:
            kid = kp_by_key.get(squeeze_text(str(kp_title)))
            if kid is not None and kid not in kp_ids:
                kp_ids.append(kid)
        if not kp_ids and safe_fallback_kps:
            kp_ids = list(safe_fallback_kps)

        # Strictly whitelist public Question.source keys; secrets live only in QuestionSecret.
        source: dict[str, Any] = {
            "created_at": (batch_now + timedelta(microseconds=idx)).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        }
        coding_type = str(q.get("coding_type") or "").strip()
        if coding_type in {"fill_code", "debug", "design"}:
            source["coding_type"] = coding_type
        difficulty = str(q.get("difficulty") or "").strip()
        if difficulty in {"易", "中", "难"}:
            source["difficulty"] = difficulty
        usage = str(q.get("usage") or "both").strip()
        if usage in {"both", "practice", "assessment"}:
            source["usage"] = usage
        explanation = str(q.get("explanation") or "").strip()
        if explanation:
            source["explanation"] = explanation[:2000]
        tags = [str(t).strip()[:100] for t in (q.get("tags") or []) if str(t).strip()][:20]
        if tags:
            source["tags"] = tags
        try:
            eng_page = int(q.get("page_number") or 0)
        except (TypeError, ValueError):
            eng_page = 0
        if eng_page in page_origin:
            mid, real_no = page_origin[eng_page]
            if mid in live_materials and real_no in live_materials[mid]:
                source["material_id"] = mid
                source["page_no"] = real_no

        samples = [
            {
                "input": str(c.get("input", "")),
                "output": str(c.get("expected_output", c.get("output", ""))),
            }
            for c in (q.get("samples") or [])
            if isinstance(c, dict)
        ]
        hidden_cases = [
            {
                "input": str(c.get("input", "")),
                "expected_output": str(c.get("expected_output", c.get("output", ""))),
            }
            for c in (q.get("hidden_cases") or [])
            if isinstance(c, dict)
        ]
        hints = [str(h).strip()[:500] for h in (q.get("hints") or []) if str(h).strip()][:10]
        ref_solution = str(q.get("reference_solution") or "")
        starter_code = str(q.get("starter_code") or "")
        stable_id = f"ai-py-{uuid.uuid4().hex[:10]}"

        payload: dict[str, Any] = {
            "id": stable_id,
            "title": title,
            "kind": "python",
            "prompt": prompt,
            "chapter_ids": [chapter_id],
            "knowledge_point_ids": kp_ids[:65],
            "source_type": "ai_generated",
            "status": "draft",
            "options": [],
            "samples": samples,
            "hints": hints,
            "starter_code": starter_code,
            "interactive": None,
            "answer": {"reference_solution": ref_solution} if ref_solution.strip() else None,
            "hidden_cases": hidden_cases,
            "source": source,
        }

        try:
            QuestionInput.model_validate({**payload, "status": "ready"}, strict=True)
            validated = QuestionInput.model_validate(payload, strict=True)
        except ValidationError:
            skipped += 1
            continue

        runtime_id = scoped_key(instance_id, "question", stable_id)
        db.add(
            Question(
                id=runtime_id,
                stable_id=stable_id,
                course_instance_id=instance_id,
                owner_id=owner_id,
                source_type="ai_generated",
                status="draft",
                title=validated.title,
                kind="python",
                prompt=validated.prompt,
                options=[],
                samples=validated.samples,
                hints=validated.hints,
                starter_code=validated.starter_code,
                interactive=None,
                source=validated.source,
            )
        )
        db.add(
            QuestionSecret(
                question_id=runtime_id,
                answer=validated.answer,
                hidden_cases=validated.hidden_cases,
            )
        )
        db.add(QuestionChapter(question_id=runtime_id, chapter_id=chapter_id))
        for kid in validated.knowledge_point_ids:
            db.add(QuestionKnowledgePoint(question_id=runtime_id, knowledge_point_id=kid))
        existing_pool.append((title, prompt))
        created_ids.append(runtime_id)

    if created_ids:
        adapter.commit_course_content(db, instance_id)
    return created_ids, skipped


def reborn_question_to_studio(
    question: Question,
    secret: QuestionSecret | None,
    *,
    chapter_label: str,
    point_titles: list[str],
) -> dict[str, Any] | None:
    """Convert one objective Reborn Question + secret into normalized Course Studio dict."""
    ltype = REBORN_TO_STUDIO.get(question.kind)
    if ltype is None:
        return None
    raw_ans = answer_value(secret.answer) if secret else None
    opts_list = [str(o).strip() for o in (question.options or []) if str(o).strip()]
    options: dict[str, str] = {}
    answer: Any = ""

    if ltype == "single":
        options = {chr(97 + idx): val for idx, val in enumerate(opts_list[:8])}
        ans_str = str(raw_ans or "").strip()
        matched = next((k for k, v in options.items() if v == ans_str), "")
        if not matched and len(ans_str) == 1 and ans_str.lower() in options:
            matched = ans_str.lower()
        answer = matched
    elif ltype == "multiple":
        options = {chr(97 + idx): val for idx, val in enumerate(opts_list[:8])}
        selected: list[str] = []
        for item in raw_ans if isinstance(raw_ans, list) else []:
            s = str(item).strip()
            k = next((key for key, val in options.items() if val == s), "")
            if not k and len(s) == 1 and s.lower() in options:
                k = s.lower()
            if k and k not in selected:
                selected.append(k)
        answer = sorted(selected)
    elif ltype == "true_false":
        options = {"a": "正确", "b": "错误"}
        answer = "a" if raw_ans is True else "b" if raw_ans is False else ""
    elif ltype == "fill_blank":
        # Reborn fill questions store accepted synonyms for a single blank as list[str].
        # Keep a single blank entry (joining synonyms with "/") so exporters never split synonyms into multiple blanks.
        if isinstance(raw_ans, list):
            cleaned = [str(x).strip() for x in raw_ans if str(x).strip()]
            answer = [" / ".join(cleaned)] if cleaned else []
        elif isinstance(raw_ans, str) and raw_ans.strip():
            answer = [raw_ans.strip()]
        else:
            answer = []

    source = question.source if isinstance(question.source, dict) else {}
    return {
        "id": question.stable_id,
        "runtime_id": question.id,
        "chapter": chapter_label,
        "type": ltype,
        "question": question.prompt or question.title,
        "options": options,
        "answer": answer,
        "explanation": str(source.get("explanation") or "").strip(),
        "difficulty": str(source.get("difficulty") or "").strip(),
        "knowledge_points": list(point_titles),
        "page": int(source.get("page_no") or 0) if isinstance(source.get("page_no"), int) else 0,
        "reviewed": question.status == "ready",
    }
