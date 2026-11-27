"""Course setup onboarding status summary for teachers."""

from typing import Annotated, TypedDict

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .auth import as_utc, require_teacher
from .db import get_db
from .models import (
    Activity,
    Chapter,
    ChapterRelease,
    Classroom,
    KnowledgePoint,
    Material,
    MaterialChapter,
    Membership,
    Question,
    TownPreviewStudent,
    User,
    now,
)
from .narration import repository
from .narration.models import PageContent, PageNarration
from .teacher_scope import own_course

router = APIRouter(prefix="/teacher/courses/{course_id}", tags=["courses"])
Db = Annotated[Session, Depends(get_db)]
Teacher = Annotated[User, Depends(require_teacher)]


class OnboardingClassroom(TypedDict):
    id: int
    name: str
    join_code: str
    student_count: int


class OnboardingSummary(TypedDict):
    classrooms: list[OnboardingClassroom]
    student_count: int
    chapter_count: int
    material_count: int
    ready_material_count: int
    narratable_material_count: int
    narration_accepted_pages: int
    narration_draft_pages: int
    audio_ready_pages: int
    knowledge_point_count: int
    ready_question_count: int
    draft_question_count: int
    published_practice_count: int
    published_assessment_count: int
    required_reading_count: int
    open_chapter_count: int
    scheduled_chapter_count: int


def _formal_students_query():
    return select(User.id).where(
        User.role == "student",
        User.id.not_in(select(TownPreviewStudent.student_user_id)),
    )


@router.get("/onboarding")
def course_onboarding(course_id: int, db: Db, user: Teacher) -> OnboardingSummary:
    own_course(db, user, course_id)
    formal_students = _formal_students_query()

    active_rooms = list(
        db.scalars(
            select(Classroom)
            .where(Classroom.course_id == course_id, Classroom.status == "active")
            .order_by(Classroom.id)
        )
    )
    active_room_ids = [room.id for room in active_rooms]

    per_room_counts: dict[int, int] = {}
    student_count = 0
    if active_room_ids:
        for room_id, count in db.execute(
            select(Membership.classroom_id, func.count(Membership.user_id))
            .where(
                Membership.classroom_id.in_(active_room_ids),
                Membership.user_id.in_(formal_students),
            )
            .group_by(Membership.classroom_id)
        ):
            per_room_counts[int(room_id)] = int(count)
        student_count = int(
            db.scalar(
                select(func.count(func.distinct(Membership.user_id))).where(
                    Membership.classroom_id.in_(active_room_ids),
                    Membership.user_id.in_(formal_students),
                )
            )
            or 0
        )

    classrooms: list[OnboardingClassroom] = [
        {
            "id": room.id,
            "name": room.name,
            "join_code": room.join_code,
            "student_count": per_room_counts.get(room.id, 0),
        }
        for room in active_rooms
    ]

    chapter_ids = list(
        db.scalars(
            select(Chapter.id).where(
                Chapter.course_instance_id == course_id,
                Chapter.deleted_at.is_(None),
            )
        )
    )
    chapter_count = len(chapter_ids)

    materials = list(
        db.scalars(
            select(Material).where(
                Material.course_instance_id == course_id,
                Material.deleted_at.is_(None),
            )
        )
    )
    material_count = len(materials)
    ready_materials = [mat for mat in materials if mat.status == "ready"]
    ready_material_count = len(ready_materials)
    narratable = {
        mat.id: mat
        for mat in ready_materials
        if mat.kind in {"pdf", "presentation"}
    }
    narratable_material_count = len(narratable)

    narration_accepted_pages = 0
    narration_draft_pages = 0
    audio_ready_pages = 0
    if narratable:
        pages_by_material = {
            mid: repository.page_map(mat) for mid, mat in narratable.items()
        }
        records = db.execute(
            select(PageNarration, PageContent)
            .outerjoin(
                PageContent,
                (PageNarration.material_id == PageContent.material_id)
                & (PageNarration.page_no == PageContent.page_no),
            )
            .where(PageNarration.material_id.in_(list(narratable.keys())))
        )
        for item, digest in records:
            mat = narratable[item.material_id]
            pages = pages_by_material[item.material_id]
            if item.page_no not in pages or not item.text.strip():
                continue
            fingerprint = repository.narration_page_hash(
                mat, item.page_no, pages[item.page_no].get("text"), digest
            )
            if item.page_hash != fingerprint:
                continue
            if item.status == "draft":
                narration_draft_pages += 1
            elif item.status == "accepted":
                narration_accepted_pages += 1
                if item.audio_key and item.audio_text_hash == repository.text_hash(item.text):
                    audio_ready_pages += 1

    knowledge_point_count = int(
        db.scalar(
            select(func.count(KnowledgePoint.id)).where(
                KnowledgePoint.course_instance_id == course_id,
                KnowledgePoint.deleted_at.is_(None),
            )
        )
        or 0
    )

    question_counts: dict[str, int] = {
        str(status): int(count)
        for status, count in db.execute(
            select(Question.status, func.count(Question.id))
            .where(
                Question.course_instance_id == course_id,
                Question.deleted_at.is_(None),
            )
            .group_by(Question.status)
        )
    }
    ready_question_count = question_counts.get("ready", 0)
    draft_question_count = question_counts.get("draft", 0)

    published_practice_count = 0
    published_assessment_count = 0
    required_reading_count = 0
    if chapter_ids:
        for kind, content in db.execute(
            select(Activity.kind, Activity.content).where(
                Activity.course_instance_id == course_id,
                Activity.chapter_id.in_(chapter_ids),
                Activity.deleted_at.is_(None),
            )
        ):
            published = (content or {}).get("published", True) is not False
            if not published:
                continue
            if kind == "practice":
                published_practice_count += 1
            elif kind == "assessment":
                published_assessment_count += 1

        if materials:
            required_reading_count = int(
                db.scalar(
                    select(func.count()).select_from(MaterialChapter).where(
                        MaterialChapter.chapter_id.in_(chapter_ids),
                        MaterialChapter.material_id.in_([mat.id for mat in materials]),
                        MaterialChapter.required.is_(True),
                    )
                )
                or 0
            )

    open_chapters: set[int] = set()
    scheduled_chapters: set[int] = set()
    if active_room_ids and chapter_ids:
        current = now()
        for ch_id, opens_at in db.execute(
            select(ChapterRelease.chapter_id, ChapterRelease.opens_at).where(
                ChapterRelease.classroom_id.in_(active_room_ids),
                ChapterRelease.chapter_id.in_(chapter_ids),
                ChapterRelease.status == "published",
            )
        ):
            if opens_at is None or as_utc(opens_at) <= current:
                open_chapters.add(int(ch_id))
            else:
                scheduled_chapters.add(int(ch_id))

    scheduled_only = scheduled_chapters - open_chapters
    return {
        "classrooms": classrooms,
        "student_count": student_count,
        "chapter_count": chapter_count,
        "material_count": material_count,
        "ready_material_count": ready_material_count,
        "narratable_material_count": narratable_material_count,
        "narration_accepted_pages": narration_accepted_pages,
        "narration_draft_pages": narration_draft_pages,
        "audio_ready_pages": audio_ready_pages,
        "knowledge_point_count": knowledge_point_count,
        "ready_question_count": ready_question_count,
        "draft_question_count": draft_question_count,
        "published_practice_count": published_practice_count,
        "published_assessment_count": published_assessment_count,
        "required_reading_count": required_reading_count,
        "open_chapter_count": len(open_chapters),
        "scheduled_chapter_count": len(scheduled_only),
    }
