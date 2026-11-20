"""整理稿（page_contents）与课程级 tag 字典：单行写入、原文失效、别名链式解析。"""
import pytest
from sqlalchemy import select

from app.narration import repository
from app.narration.models import MaterialTagDict, PageContent

from test_narration import material_fixture


def test_upsert_keeps_one_row_per_page(db, classroom):
    material = material_fixture(db, classroom, ["第一页原文", "第二页原文"])
    db.commit()

    row = repository.upsert_content(db, material, 1, title="变量", topic="赋值就是贴标签",
                                   tags=["变量", "变量", " "], text="整理后的第一页")
    db.commit()
    assert row.tags == ["变量"], "标签去重去空"
    assert (row.source, row.status) == ("ai", "draft")

    repository.upsert_content(db, material, 1, title="变量与赋值", topic="",
                                      tags=["变量"], text="再整理一次")
    db.commit()
    rows = db.scalars(select(PageContent).where(PageContent.material_id == material.id)).all()
    assert len(rows) == 1 and rows[0].id == row.id and rows[0].title == "变量与赋值"


def test_teacher_edit_keeps_review_status(db, classroom):
    material = material_fixture(db, classroom, ["第一页原文"])
    db.commit()
    repository.upsert_content(db, material, 1, title="变量", topic="", tags=[],
                              text="模型整理", status="accepted", source="ai")
    db.commit()
    teacher = repository.upsert_content(db, material, 1, title="变量", topic="", tags=[],
                                       text="老师改过的整理稿", status="accepted", source="teacher")
    db.commit()
    assert teacher.status == "accepted", "教师手改不降级为草稿"


def test_changed_raw_text_voids_the_digest(db, classroom):
    material = material_fixture(db, classroom, ["第一页原文"])
    db.commit()
    repository.upsert_content(db, material, 1, title="变量", topic="", tags=[], text="整理稿")
    db.commit()

    assert repository.sync_content_staleness(db, material) is False, "原文没变不应作废"

    material.content = {**material.content, "pages": [
        {"id": 1, "page_no": 1, "title": "第1页", "text": "换了正文"}]}
    db.flush()
    assert repository.sync_content_staleness(db, material) is True
    db.commit()
    assert repository.content_row(db, material.id, 1).status == "stale"


def test_tag_dictionary_resolves_chains(db, classroom):
    instance_id = db.info["fixture_course_instance_id"]
    assert repository.record_tag_map(db, instance_id, {"c": "a", "a": "a"}) == 2
    db.commit()
    assert repository.tag_map(db, instance_id) == {"a": "a", "c": "a"}

    repository.record_tag_map(db, instance_id, {"a": "b"})
    db.commit()
    assert repository.tag_map(db, instance_id) == {"a": "b", "c": "b"}, "链式归并要跟到最终标准名"

    repository.record_tag_map(db, instance_id, {"c": "a"})
    db.commit()
    assert db.scalars(select(MaterialTagDict).where(MaterialTagDict.alias == "c")).all()[0].canonical == "a"
    assert len(db.scalars(select(MaterialTagDict)).all()) == 2, "同一别名只保留一行（a、c）"


def test_upsert_rejects_bad_input(db, classroom):
    material = material_fixture(db, classroom, ["第一页原文"])
    db.commit()
    with pytest.raises(LookupError):
        repository.upsert_content(db, material, 9, title="", topic="", tags=[], text="越界")
    with pytest.raises(ValueError):
        repository.upsert_content(db, material, 1, title="", topic="", tags=[], text="   ")
    with pytest.raises(ValueError):
        repository.upsert_content(db, material, 1, title="", topic="", tags=[], text="正文", image_state="unknown")
