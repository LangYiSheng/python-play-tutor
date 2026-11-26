"""Course package v3 export/preview/import round-trip for Lectio exams, knowledge meta, and AI questions."""

from __future__ import annotations

import json
import shutil
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.content_relations import set_material_chapters, set_question_chapters, set_question_knowledge_points
from app.course_packages.apply import import_bundle
from app.course_packages.impact import preview_impact
from app.course_packages.manifest import PackageError
from app.course_packages.reader import load_bundle
from app.course_packages.writer import write_package
from app.lectio.models import LectioExam
from app.materials.storage import get_storage
from app.models import Chapter, Classroom, KnowledgePoint, Material, Question, QuestionSecret
from fixture_instances import clone_current_course

RESERVED_KEYS = {
    "chapter_id", "prerequisite_chapter_id", "material_id", "document_id",
    "activity_id", "pending_activity_id", "question_id", "knowledge_point_id",
    "quest_id", "story_id", "npc_key", "speaker_npc_id", "activity_completed",
    "chapter_ids", "question_ids", "knowledge_point_ids",
}


@pytest.fixture
def lectio_exchange(db, classroom, teacher, monkeypatch, tmp_path):
    monkeypatch.setenv("REBORN_STORAGE_ROOT", str(tmp_path / "storage"))
    monkeypatch.setenv("REBORN_COURSE_EXCHANGE_ROOT", str(tmp_path / "exchange"))
    original = db.get(Classroom, classroom["id"])
    source = clone_current_course(db, original)
    chapter = db.scalar(select(Chapter).where(Chapter.course_instance_id == source.id).order_by(Chapter.order_index))

    pdf = tmp_path / "notes.pdf"
    pdf.write_bytes(b"%PDF-1.7\nlectio package fixture")
    get_storage().put("lectio/notes.pdf", pdf)
    material = Material(
        course_instance_id=source.id,
        stable_id="lectio-pkg-mat",
        owner_id=teacher["id"],
        title="课程包讲义",
        kind="pdf",
        status="ready",
        storage_key="lectio/notes.pdf",
        content={"library_available": True, "pages": [{"id": 1, "page_no": 1, "title": "页1", "text": "变量赋值详解"}]},
    )
    db.add(material)
    db.flush()
    set_material_chapters(db, material.id, [chapter.id])

    kp = KnowledgePoint(
        course_instance_id=source.id,
        stable_id="lectio-kp-1",
        owner_id=teacher["id"],
        chapter_id=chapter.id,
        title="动态赋值语义",
        content={
            "lectio": {
                "section": "1.1",
                "brief": "理解对象绑定",
                "sources": [{"material_stable_id": "lectio-pkg-mat", "pages": [1]}],
            }
        },
    )
    db.add(kp)
    db.flush()

    qid = f"c{source.id}-ai-q1"
    q = Question(
        id=qid,
        stable_id="ai-q1",
        course_instance_id=source.id,
        owner_id=teacher["id"],
        source_type="ai_generated",
        status="draft",
        title="变量绑定用 ____ 运算符",
        kind="fill",
        prompt="变量绑定用 ____ 运算符",
        options=[],
        samples=[],
        hints=[],
        starter_code="",
        interactive=None,
        source={"material_id": material.id, "page_no": 1, "explanation": "使用 = 进行赋值。"},
    )
    db.add(q)
    db.flush()
    db.add(QuestionSecret(question_id=qid, answer=["="], hidden_cases=[]))
    set_question_chapters(db, qid, [chapter.id])
    set_question_knowledge_points(db, qid, [kp.id])

    exam = LectioExam(
        course_instance_id=source.id,
        stable_id="lectio-exam-1",
        title="期中组卷快照",
        mode="ab",
        blueprint={"subtitle": "A/B 卷", "totalScore": 100, "abMode": True, "chapters": [chapter.title]},
        variants={
            "A": {"label": "A卷", "totalScore": 100, "questions": [{"uid": "u1", "sourceId": "ai-q1", "type": "fill_blank", "question": "变量绑定用 ____ 运算符", "answer": ["="], "score": 100}]},
            "B": {"label": "B卷", "totalScore": 100, "questions": [{"uid": "u2", "sourceId": "ai-q1", "type": "fill_blank", "question": "变量绑定用 ____ 运算符", "answer": ["="], "score": 100}]},
        },
        stats={"overlapCount": 1, "overlapRate": 1.0},
        created_by=teacher["id"],
    )
    db.add(exam)
    db.commit()

    target = Classroom(name="目标导入班", teacher_id=teacher["id"], join_code=uuid4().hex[:24])
    db.add(target)
    db.commit()
    return source, target, exam


def test_course_package_roundtrip_preserves_exams_kps_and_ai_questions(db, lectio_exchange, tmp_path) -> None:
    source, target, orig_exam = lectio_exchange
    pkg_dir = tmp_path / "pkg-v3"
    pkg_dir.mkdir()
    write_package(db, source, pkg_dir)

    exams_file = pkg_dir / "content/exams.jsonl"
    assert exams_file.is_file()
    bundle = load_bundle(pkg_dir)
    assert bundle["exams_present"] is True
    assert len(bundle["exams"]) == 1

    impact = preview_impact(db, None, bundle)
    assert impact["diff"]["exams"] == {"added": ["lectio-exam-1"], "removed": [], "updated": []}
    assert not impact["blockers"]

    imported_instance = import_bundle(db, target, None, bundle, pkg_dir)
    db.commit()

    copied_kp = db.scalar(
        select(KnowledgePoint).where(KnowledgePoint.course_instance_id == imported_instance.id, KnowledgePoint.stable_id == "lectio-kp-1")
    )
    assert copied_kp is not None
    assert copied_kp.content["lectio"]["sources"] == [{"material_stable_id": "lectio-pkg-mat", "pages": [1]}]
    assert not (set(copied_kp.content["lectio"]) & RESERVED_KEYS)

    copied_q = db.scalar(
        select(Question).where(Question.course_instance_id == imported_instance.id, Question.stable_id == "ai-q1")
    )
    assert copied_q is not None
    assert copied_q.source_type == "ai_generated" and copied_q.status == "draft"
    assert copied_q.source["explanation"] == "使用 = 进行赋值。"
    copied_mat = db.scalar(
        select(Material).where(Material.course_instance_id == imported_instance.id, Material.stable_id == "lectio-pkg-mat")
    )
    assert copied_q.source["material_id"] == copied_mat.id
    assert db.get(QuestionSecret, copied_q.id).answer == ["="]

    copied_exam = db.scalar(
        select(LectioExam).where(LectioExam.course_instance_id == imported_instance.id, LectioExam.stable_id == orig_exam.stable_id)
    )
    assert copied_exam is not None
    assert copied_exam.title == "期中组卷快照"
    assert copied_exam.mode == "ab"
    assert copied_exam.variants["B"]["questions"][0]["sourceId"] == "ai-q1"

    # Backward compatibility: legacy v3 package without content/exams.jsonl preserves target exams on update.
    legacy_dir = tmp_path / "pkg-legacy"
    shutil.copytree(pkg_dir, legacy_dir)
    (legacy_dir / "content/exams.jsonl").unlink()
    legacy_bundle = load_bundle(legacy_dir)
    assert legacy_bundle["exams_present"] is False and legacy_bundle["exams"] == []
    legacy_impact = preview_impact(db, imported_instance, legacy_bundle)
    assert legacy_impact["diff"]["exams"]["removed"] == []
    import_bundle(db, target, imported_instance, legacy_bundle, legacy_dir)
    db.commit()
    assert db.scalar(select(LectioExam).where(LectioExam.course_instance_id == imported_instance.id)) is not None

    # Replace with different package_id clears old exams cleanly.
    other_pkg = tmp_path / "pkg-other"
    shutil.copytree(legacy_dir, other_pkg)
    manifest_path = other_pkg / "manifest.yaml"
    manifest_path.write_text(manifest_path.read_text(encoding="utf-8").replace(imported_instance.package_id, "other-course-pkg"), encoding="utf-8")
    other_bundle = load_bundle(other_pkg)
    import_bundle(db, target, imported_instance, other_bundle, other_pkg)
    db.commit()
    assert db.scalar(select(LectioExam).where(LectioExam.course_instance_id == imported_instance.id)) is None


@pytest.mark.parametrize("mutator", [
    lambda row: row.update(mode="bad"),
    lambda row: row["variants"].pop("B"),
    lambda row: row.update(extra="boom"),
])
def test_invalid_exams_jsonl_rejected(db, lectio_exchange, tmp_path, mutator) -> None:
    source, _, _ = lectio_exchange
    pkg_dir = tmp_path / "pkg-bad"
    pkg_dir.mkdir()
    write_package(db, source, pkg_dir)
    exams_path = pkg_dir / "content/exams.jsonl"
    row = json.loads(exams_path.read_text(encoding="utf-8").splitlines()[0])
    mutator(row)
    exams_path.write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")
    with pytest.raises(PackageError):
        load_bundle(pkg_dir)
