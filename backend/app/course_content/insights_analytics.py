"""Batch course-level analytics for the teacher insights dashboard without N+1 queries."""
from collections import Counter, defaultdict
from typing import Any, TypedDict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.assessment_grades import ACCEPTED, GRADED, grade_status
from app.auth import as_utc
from app.chapter_tasks.rules import reading_task
from app.integration_models import AssistantSession
from app.models import (
    Activity,
    ActivityProgress,
    ActivityQuestion,
    AssessmentAttempt,
    Chapter,
    ChapterRelease,
    Classroom,
    CourseInstance,
    LearningRecord,
    Material,
    MaterialChapter,
    MaterialParticipation,
    Membership,
    PracticeSession,
    Question,
    QuestionChapter,
    Submission,
    TownPreviewStudent,
    now,
)

STAGES: tuple[str, ...] = ("reading", "objective", "programming", "assessment")


class StageCounts(TypedDict):
    completed: int
    total: int


class ChapterStageCounts(TypedDict):
    task_count: int
    completed: int
    total: int


class ChapterFunnelItem(TypedDict):
    id: int
    title: str
    order_index: int
    open_classrooms: int
    target_students: int
    stages: dict[str, ChapterStageCounts]


class ClassroomInsightItem(TypedDict):
    id: int
    name: str
    student_count: int
    active_students: int
    open_chapters: int
    total_chapters: int
    required_completed: int
    required_total: int
    assessment_submitted: int
    assessment_expected: int
    average_score: float | None
    assistant_messages: int


class DifficultQuestionItem(TypedDict):
    question_id: str
    title: str
    kind: str
    chapter_title: str | None
    attempts: int
    learners: int
    failed_attempts: int
    accepted_learners: int
    appended_count: int


class AssistantHotspotItem(TypedDict):
    key: str
    kind: str
    title: str
    chapter_title: str | None
    learners: int
    sessions: int
    messages: int


class AssessmentSummary(TypedDict):
    expected: int
    submitted: int
    graded: int
    grading: int
    attention: int
    average_score: float | None
    pass_count: int


class CompletionSummary(TypedDict):
    required_completed: int
    required_total: int
    open_classroom_count: int
    by_stage: dict[str, StageCounts]


class CourseInsightsExtras(TypedDict):
    active_students: int
    assistant_students: int
    completion: CompletionSummary
    assessment_summary: AssessmentSummary
    chapters: list[ChapterFunnelItem]
    classrooms: list[ClassroomInsightItem]
    difficult_questions: list[DifficultQuestionItem]
    assistant_hotspots: list[AssistantHotspotItem]


def _practice_completed(activity: Activity, session: PracticeSession | None, accepted_qids: set[str], fixed_qids: list[str]) -> bool:
    rules = activity.content.get("practice_rules")
    if rules:
        items = session.items if session else []
        if not items:
            return False
        passed = [item for item in items if item.get("status") == "accepted"]
        if len(passed) != len(items):
            return False
        counts = Counter((item.get("knowledge_point_id"), item.get("kind")) for item in passed)
        for goal in rules.get("goals", []):
            point = goal["knowledge_point_id"]
            by_kind = {kind: count for (pid, kind), count in counts.items() if pid == point}
            if sum(by_kind.values()) < goal["total"]:
                return False
            if any(by_kind.get(kind, 0) < minimum for kind, minimum in goal.get("by_kind", {}).items()):
                return False
        return True
    return bool(fixed_qids) and all(qid in accepted_qids for qid in fixed_qids)


def _evaluate_paper(
    attempt: AssessmentAttempt | None,
    fixed_qids: list[str],
    submissions_by_id: dict[str, Submission],
    legacy_rows: dict[str, Submission],
) -> tuple[str, int | None]:
    if attempt and attempt.state in {"submitted", "legacy"}:
        qids = list(attempt.question_ids)
        rows = {qid: submissions_by_id.get(sid) for qid, sid in attempt.submission_ids.items()}
        locked = True
    else:
        qids = fixed_qids
        rows = {qid: legacy_rows[qid] for qid in qids if qid in legacy_rows}
        pending = any(row.status not in GRADED for row in rows.values())
        locked = bool(rows) and (pending or len(rows) == len(qids))
    if not locked:
        return "draft", None
    statuses = [row.status for row in rows.values() if row is not None]
    status = grade_status(statuses, len(qids))
    if status != "graded":
        return status, None
    correct = sum(1 for row in rows.values() if row is not None and row.status in ACCEPTED)
    return "graded", (correct * 100 // len(qids) if qids else 0)


def build_course_insights_extras(db: Session, course: CourseInstance) -> CourseInsightsExtras:
    course_id = course.id
    teacher_id = course.teacher_id
    preview_users = select(TownPreviewStudent.student_user_id)
    all_rooms = list(db.scalars(select(Classroom).where(Classroom.course_id == course_id).order_by(Classroom.id)))
    all_room_ids = [room.id for room in all_rooms]
    active_rooms = [room for room in all_rooms if room.status == "active"]
    active_room_ids = [room.id for room in active_rooms]

    roster_by_room: dict[int, set[int]] = defaultdict(set)
    if active_room_ids:
        member_rows = db.execute(
            select(Membership.classroom_id, Membership.user_id).where(
                Membership.classroom_id.in_(active_room_ids),
                Membership.user_id.not_in(preview_users),
            )
        )
        for room_id, uid in member_rows:
            roster_by_room[room_id].add(uid)

    chapters = list(
        db.scalars(
            select(Chapter)
            .where(
                Chapter.course_instance_id == course_id,
                Chapter.owner_id.is_(None) | (Chapter.owner_id == teacher_id),
            )
            .order_by(Chapter.order_index, Chapter.id)
        )
    )
    chapter_titles = {c.id: c.title for c in chapters}
    current_time = now()

    open_chapter_ids_by_room: dict[int, set[int]] = defaultdict(set)
    if active_room_ids and chapters:
        valid_chapter_ids = {c.id for c in chapters}
        for release in db.scalars(select(ChapterRelease).where(ChapterRelease.classroom_id.in_(active_room_ids))):
            if (
                release.chapter_id in valid_chapter_ids
                and release.status == "published"
                and (release.opens_at is None or as_utc(release.opens_at) <= current_time)
            ):
                open_chapter_ids_by_room[release.classroom_id].add(release.chapter_id)

    chapter_materials: dict[int, list[tuple[MaterialChapter, Material]]] = defaultdict(list)
    if chapters:
        mat_rows = db.execute(
            select(MaterialChapter, Material)
            .join(Material, Material.id == MaterialChapter.material_id)
            .where(
                MaterialChapter.chapter_id.in_([c.id for c in chapters]),
                Material.course_instance_id == course_id,
                Material.owner_id.is_(None) | (Material.owner_id == teacher_id),
            )
            .order_by(MaterialChapter.order_index, Material.id)
        )
        for link, material in mat_rows:
            chapter_materials[link.chapter_id].append((link, material))

    activities = list(
        db.scalars(
            select(Activity).where(
                Activity.course_instance_id == course_id,
                Activity.owner_id.is_(None) | (Activity.owner_id == teacher_id),
                Activity.kind.in_(("practice", "assessment")),
            )
        )
    )
    published_by_chapter: dict[int, list[Activity]] = defaultdict(list)
    for act in activities:
        if act.content.get("published", True):
            published_by_chapter[act.chapter_id].append(act)

    ready_qids_by_activity: dict[str, list[str]] = defaultdict(list)
    if activities:
        aq_rows = db.execute(
            select(ActivityQuestion.activity_id, ActivityQuestion.question_id)
            .join(Question, Question.id == ActivityQuestion.question_id)
            .where(
                ActivityQuestion.activity_id.in_([a.id for a in activities]),
                Question.course_instance_id == course_id,
                Question.status == "ready",
                Question.owner_id.is_(None) | (Question.owner_id == teacher_id),
            )
            .order_by(ActivityQuestion.order_index)
        )
        for aid, qid in aq_rows:
            ready_qids_by_activity[aid].append(qid)

    active_learners_by_room: dict[int, set[int]] = defaultdict(set)
    reading_evidence: dict[tuple[int, int, int, int], dict[str, Any]] = {}
    if active_room_ids:
        for mp in db.scalars(
            select(MaterialParticipation).where(
                MaterialParticipation.classroom_id.in_(active_room_ids),
                MaterialParticipation.user_id.not_in(preview_users),
            )
        ):
            reading_evidence[(mp.classroom_id, mp.chapter_id, mp.material_id, mp.user_id)] = mp.evidence
            if mp.user_id in roster_by_room[mp.classroom_id]:
                active_learners_by_room[mp.classroom_id].add(mp.user_id)
        for model in (ActivityProgress, LearningRecord, PracticeSession, AssessmentAttempt):
            for room_id, uid in db.execute(
                select(model.classroom_id, model.user_id).where(
                    model.classroom_id.in_(active_room_ids),
                    model.user_id.not_in(preview_users),
                )
            ):
                if uid in roster_by_room[room_id]:
                    active_learners_by_room[room_id].add(uid)

    practice_sessions: dict[tuple[int, str, int], PracticeSession] = {}
    appended_by_qid: Counter[str] = Counter()
    if all_room_ids:
        for ps in db.scalars(
            select(PracticeSession).where(
                PracticeSession.classroom_id.in_(all_room_ids),
                PracticeSession.user_id.not_in(preview_users),
            )
        ):
            if ps.classroom_id in roster_by_room:
                practice_sessions[(ps.classroom_id, ps.activity_id, ps.user_id)] = ps
            for item in ps.items:
                if item.get("appended"):
                    appended_by_qid[str(item.get("question_id", ""))] += 1

    attempts_by_key: dict[tuple[int, str, int], AssessmentAttempt] = {}
    if active_room_ids:
        for att in db.scalars(
            select(AssessmentAttempt).where(
                AssessmentAttempt.classroom_id.in_(active_room_ids),
                AssessmentAttempt.user_id.not_in(preview_users),
            )
        ):
            attempts_by_key[(att.classroom_id, att.activity_id, att.user_id)] = att

    submissions_by_id: dict[str, Submission] = {}
    accepted_qids_by_key: dict[tuple[int, str, int], set[str]] = defaultdict(set)
    legacy_paper_rows: dict[tuple[int, str, int], dict[str, Submission]] = defaultdict(dict)
    question_attempts: Counter[str] = Counter()
    question_failed: Counter[str] = Counter()
    question_learners: dict[str, set[int]] = defaultdict(set)
    question_accepted_learners: dict[str, set[int]] = defaultdict(set)

    if all_room_ids:
        sub_rows = list(
            db.scalars(
                select(Submission)
                .where(
                    Submission.classroom_id.in_(all_room_ids),
                    Submission.user_id.not_in(preview_users),
                )
                .order_by(Submission.created_at.desc(), Submission.id.desc())
            )
        )
        for sub in sub_rows:
            submissions_by_id[sub.id] = sub
            if sub.mode != "submit":
                continue
            if sub.classroom_id in roster_by_room and sub.user_id in roster_by_room[sub.classroom_id]:
                active_learners_by_room[sub.classroom_id].add(sub.user_id)
            key = (sub.classroom_id, sub.activity_id, sub.user_id)
            if sub.status in ACCEPTED:
                accepted_qids_by_key[key].add(sub.question_id)
                question_accepted_learners[sub.question_id].add(sub.user_id)
            else:
                question_failed[sub.question_id] += 1
            question_attempts[sub.question_id] += 1
            question_learners[sub.question_id].add(sub.user_id)
            if (sub.feedback or {}).get("source") != "browser_practice":
                legacy_paper_rows[key].setdefault(sub.question_id, sub)

    stage_totals: dict[str, StageCounts] = {stage: {"completed": 0, "total": 0} for stage in STAGES}
    chapter_items: list[ChapterFunnelItem] = []
    room_req_completed: Counter[int] = Counter()
    room_req_total: Counter[int] = Counter()
    room_exam_submitted: Counter[int] = Counter()
    room_exam_expected: Counter[int] = Counter()
    room_scores: dict[int, list[int]] = defaultdict(list)

    exam_expected = 0
    exam_submitted = 0
    exam_graded = 0
    exam_grading = 0
    exam_attention = 0
    exam_pass = 0
    all_scores: list[int] = []

    for chapter in chapters:
        cid = chapter.id
        open_rooms = [room for room in active_rooms if cid in open_chapter_ids_by_room[room.id]]
        target_students = sum(len(roster_by_room[room.id]) for room in open_rooms)

        req_readings = [(link, mat) for link, mat in chapter_materials[cid] if link.required]
        req_objective = [
            act for act in published_by_chapter[cid]
            if act.kind == "practice" and act.content.get("practice_kind", "objective") != "programming" and act.content.get("required", True)
        ]
        req_programming = [
            act for act in published_by_chapter[cid]
            if act.kind == "practice" and act.content.get("practice_kind") == "programming" and act.content.get("required", True)
        ]
        assessments = [act for act in published_by_chapter[cid] if act.kind == "assessment"]

        ch_stages: dict[str, ChapterStageCounts] = {
            "reading": {"task_count": len(req_readings), "completed": 0, "total": len(req_readings) * target_students},
            "objective": {"task_count": len(req_objective), "completed": 0, "total": len(req_objective) * target_students},
            "programming": {"task_count": len(req_programming), "completed": 0, "total": len(req_programming) * target_students},
            "assessment": {"task_count": len(assessments), "completed": 0, "total": len(assessments) * target_students},
        }

        for room in open_rooms:
            roster = roster_by_room[room.id]
            n_students = len(roster)
            room_req_total[room.id] += (len(req_readings) + len(req_objective) + len(req_programming) + len(assessments)) * n_students
            room_exam_expected[room.id] += len(assessments) * n_students
            exam_expected += len(assessments) * n_students

            for link, mat in req_readings:
                done = 0
                for uid in roster:
                    ev = reading_evidence.get((room.id, cid, mat.id, uid))
                    if ev is not None and reading_task(link, mat, ev)["completed"]:
                        done += 1
                ch_stages["reading"]["completed"] += done
                room_req_completed[room.id] += done

            for stage_key, group in (("objective", req_objective), ("programming", req_programming)):
                for act in group:
                    fixed = ready_qids_by_activity[act.id]
                    done = 0
                    for uid in roster:
                        key = (room.id, act.id, uid)
                        if _practice_completed(act, practice_sessions.get(key), accepted_qids_by_key[key], fixed):
                            done += 1
                    ch_stages[stage_key]["completed"] += done
                    room_req_completed[room.id] += done

            for act in assessments:
                fixed = ready_qids_by_activity[act.id]
                done = 0
                for uid in roster:
                    key = (room.id, act.id, uid)
                    status, score = _evaluate_paper(attempts_by_key.get(key), fixed, submissions_by_id, legacy_paper_rows[key])
                    if status != "draft":
                        exam_submitted += 1
                        room_exam_submitted[room.id] += 1
                    if status == "graded" and score is not None:
                        done += 1
                        exam_graded += 1
                        all_scores.append(score)
                        room_scores[room.id].append(score)
                        if score >= 60:
                            exam_pass += 1
                    elif status == "grading":
                        exam_grading += 1
                    elif status == "attention":
                        exam_attention += 1
                ch_stages["assessment"]["completed"] += done
                room_req_completed[room.id] += done

        for stage in STAGES:
            stage_totals[stage]["completed"] += ch_stages[stage]["completed"]
            stage_totals[stage]["total"] += ch_stages[stage]["total"]

        chapter_items.append(
            {
                "id": cid,
                "title": chapter.title,
                "order_index": chapter.order_index,
                "open_classrooms": len(open_rooms),
                "target_students": target_students,
                "stages": ch_stages,
            }
        )

    assistant_learners: set[int] = set()
    room_assistant_msgs: Counter[int] = Counter()
    hotspot_sessions: Counter[str] = Counter()
    hotspot_messages: Counter[str] = Counter()
    hotspot_learners: dict[str, set[int]] = defaultdict(set)
    hotspot_meta: dict[str, tuple[str, str, str | None]] = {}

    if all_room_ids:
        activity_lookup = {
            a.id: a
            for a in db.scalars(
                select(Activity)
                .where(Activity.course_instance_id == course_id)
                .execution_options(include_deleted=True)
            )
        }
        material_lookup = {
            m.id: m
            for m in db.scalars(
                select(Material)
                .where(Material.course_instance_id == course_id)
                .execution_options(include_deleted=True)
            )
        }
        mat_chapter_map: dict[int, str] = {}
        for mc_mid, mc_cid in db.execute(
            select(MaterialChapter.material_id, MaterialChapter.chapter_id).where(
                MaterialChapter.chapter_id.in_(list(chapter_titles.keys()) or [-1])
            )
        ):
            mat_chapter_map.setdefault(mc_mid, chapter_titles.get(mc_cid, ""))

        sess_rows = db.scalars(
            select(AssistantSession)
            .where(
                AssistantSession.classroom_id.in_(all_room_ids),
                AssistantSession.user_id.not_in(preview_users),
            )
            .execution_options(include_deleted=True)
        )
        for sess in sess_rows:
            if not any(m.get("role") == "user" for m in sess.messages):
                continue
            msg_count = sum(1 for m in sess.messages if m.get("role") in {"user", "assistant"})
            assistant_learners.add(sess.user_id)
            room_assistant_msgs[sess.classroom_id] += msg_count
            if sess.material_id and sess.material_id in material_lookup:
                mat = material_lookup[sess.material_id]
                hkey = f"material:{mat.id}"
                hotspot_meta[hkey] = ("material", mat.title, mat_chapter_map.get(mat.id) or None)
            elif sess.activity_id and sess.activity_id in activity_lookup:
                act = activity_lookup[sess.activity_id]
                kind = "practice" if act.kind == "practice" else "learning"
                hkey = f"activity:{act.id}"
                hotspot_meta[hkey] = (kind, act.title, chapter_titles.get(act.chapter_id))
            else:
                continue
            hotspot_sessions[hkey] += 1
            hotspot_messages[hkey] += msg_count
            hotspot_learners[hkey].add(sess.user_id)

    difficult_questions: list[DifficultQuestionItem] = []
    candidate_qids = [qid for qid, fails in question_failed.items() if fails > 0 or appended_by_qid[qid] > 0]
    if candidate_qids:
        q_lookup = {
            q.id: q
            for q in db.scalars(
                select(Question)
                .where(Question.id.in_(candidate_qids), Question.course_instance_id == course_id)
                .execution_options(include_deleted=True)
            )
        }
        q_chapter_map: dict[str, str] = {}
        for qid, ch_id in db.execute(
            select(QuestionChapter.question_id, QuestionChapter.chapter_id).where(
                QuestionChapter.question_id.in_(candidate_qids)
            )
        ):
            if ch_id in chapter_titles and qid not in q_chapter_map:
                q_chapter_map[qid] = chapter_titles[ch_id]
        ranked_qids = sorted(
            (qid for qid in candidate_qids if qid in q_lookup),
            key=lambda qid: (
                question_failed[qid],
                appended_by_qid[qid],
                len(question_learners[qid]) - len(question_accepted_learners[qid]),
                question_attempts[qid],
            ),
            reverse=True,
        )[:8]
        for qid in ranked_qids:
            q = q_lookup[qid]
            difficult_questions.append(
                {
                    "question_id": qid,
                    "title": q.title,
                    "kind": q.kind,
                    "chapter_title": q_chapter_map.get(qid),
                    "attempts": question_attempts[qid],
                    "learners": len(question_learners[qid]),
                    "failed_attempts": question_failed[qid],
                    "accepted_learners": len(question_accepted_learners[qid]),
                    "appended_count": appended_by_qid[qid],
                }
            )

    ranked_hotspots = sorted(
        hotspot_meta.keys(),
        key=lambda k: (hotspot_messages[k], hotspot_sessions[k], len(hotspot_learners[k])),
        reverse=True,
    )[:8]
    assistant_hotspots: list[AssistantHotspotItem] = [
        {
            "key": k,
            "kind": hotspot_meta[k][0],
            "title": hotspot_meta[k][1],
            "chapter_title": hotspot_meta[k][2],
            "learners": len(hotspot_learners[k]),
            "sessions": hotspot_sessions[k],
            "messages": hotspot_messages[k],
        }
        for k in ranked_hotspots
    ]

    classroom_items: list[ClassroomInsightItem] = []
    all_active_learners: set[int] = set()
    for room in active_rooms:
        all_active_learners.update(active_learners_by_room[room.id])
        scores = room_scores[room.id]
        classroom_items.append(
            {
                "id": room.id,
                "name": room.name,
                "student_count": len(roster_by_room[room.id]),
                "active_students": len(active_learners_by_room[room.id]),
                "open_chapters": len(open_chapter_ids_by_room[room.id]),
                "total_chapters": len(chapters),
                "required_completed": room_req_completed[room.id],
                "required_total": room_req_total[room.id],
                "assessment_submitted": room_exam_submitted[room.id],
                "assessment_expected": room_exam_expected[room.id],
                "average_score": round(sum(scores) / len(scores), 1) if scores else None,
                "assistant_messages": room_assistant_msgs[room.id],
            }
        )

    req_completed_sum = sum(stage_totals[s]["completed"] for s in STAGES)
    req_total_sum = sum(stage_totals[s]["total"] for s in STAGES)

    return {
        "active_students": len(all_active_learners),
        "assistant_students": len(assistant_learners),
        "completion": {
            "required_completed": req_completed_sum,
            "required_total": req_total_sum,
            "open_classroom_count": sum(1 for room in active_rooms if open_chapter_ids_by_room[room.id]),
            "by_stage": stage_totals,
        },
        "assessment_summary": {
            "expected": exam_expected,
            "submitted": exam_submitted,
            "graded": exam_graded,
            "grading": exam_grading,
            "attention": exam_attention,
            "average_score": round(sum(all_scores) / len(all_scores), 1) if all_scores else None,
            "pass_count": exam_pass,
        },
        "chapters": chapter_items,
        "classrooms": classroom_items,
        "difficult_questions": difficult_questions,
        "assistant_hotspots": assistant_hotspots,
    }
