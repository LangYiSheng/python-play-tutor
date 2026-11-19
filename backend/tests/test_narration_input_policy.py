"""页文本长度如何决定「发文本还是发页图」：可执行矩阵。

规则只有一个来源 `narration/input_policy.py`，生成与校准都调它。当前表格：

| 资料类型 | 生成 | 校准 | 整理原文 |
| --- | --- | --- | --- |
| 演示文稿 `presentation` | 文本层 < 60 字发图 | 文本层 < 60 字发图 | 文本层 < 600 字发图 |
| PDF / 其他 | 文本层 < 200 字发图 | 文本层 < 60 字发图 | 文本层 < 600 字发图 |

整理原文是后续校准、讲解稿与 RAG 的唯一来源，中段页（60–199 字）漏图会永久缺块，所以阈值最宽。

校准两侧一致：碎片页不发图会让讲对了的页被判 mismatch（第 1 讲第 4 页），发图后 3/3 条
mismatch 经页图核实成立（第 27/33/47 页）。生成侧演示文稿不再无条件发图：≥60 字只发文本
时与发图实质等价（第 6/22/37 页）。PDF 生成保留 200，等 60–199 档的阈值实验。

改阈值、改条件或统一两边规则时，先改 `IMAGE_POLICY`，再跑这张矩阵；指纹测试会指出旧报告
不会被复用。
"""

import pytest
from types import SimpleNamespace

from app.narration import calibrate, repository, service
from app.narration.input_policy import (DIGEST_TEXT_ONLY_THRESHOLD, IMAGE_POLICY, PDF_TEXT_ONLY_THRESHOLD,
                                        TEXT_AS_IMAGE_BELOW, prefers_image)
from test_narration import material_fixture

PRESENTATION = "presentation"
PDF = "pdf"


def material_of(kind: str):
    """策略函数只读 material.kind。"""
    return SimpleNamespace(kind=kind)


def policy_table():
    return {kind: dict(entries) for kind, entries in IMAGE_POLICY.items()}


# 生成：演示文稿按 60 字；PDF 仍是 200 字。
GENERATION_POLICY = {PRESENTATION: TEXT_AS_IMAGE_BELOW, PDF: PDF_TEXT_ONLY_THRESHOLD}
# 校准：两种资料都按 60 字。
CALIBRATION_POLICY = {PRESENTATION: TEXT_AS_IMAGE_BELOW, PDF: TEXT_AS_IMAGE_BELOW}
# 整理原文：两种资料都按 600 字，宁多发图也不让整理稿缺块。
DIGEST_POLICY = {PRESENTATION: DIGEST_TEXT_ONLY_THRESHOLD, PDF: DIGEST_TEXT_ONLY_THRESHOLD}

LENGTHS = sorted({0, 1, 59, 60, 61, PDF_TEXT_ONLY_THRESHOLD - 1, PDF_TEXT_ONLY_THRESHOLD,
                  PDF_TEXT_ONLY_THRESHOLD + 1})


def test_policy_table_is_the_single_source_of_truth():
    assert policy_table() == {
        PRESENTATION: {"generation": TEXT_AS_IMAGE_BELOW, "calibration": TEXT_AS_IMAGE_BELOW,
                       "digest": DIGEST_TEXT_ONLY_THRESHOLD},
        PDF: {"generation": PDF_TEXT_ONLY_THRESHOLD, "calibration": TEXT_AS_IMAGE_BELOW,
              "digest": DIGEST_TEXT_ONLY_THRESHOLD},
    }
    assert TEXT_AS_IMAGE_BELOW == 60 and PDF_TEXT_ONLY_THRESHOLD == 200 and DIGEST_TEXT_ONLY_THRESHOLD == 600


@pytest.mark.parametrize("kind", [PRESENTATION, PDF])
@pytest.mark.parametrize("chars", LENGTHS)
def test_generation_image_policy(kind, chars):
    assert service.with_image(material_of(kind), "字" * chars) is (chars < GENERATION_POLICY[kind])


@pytest.mark.parametrize("kind", [PRESENTATION, PDF])
@pytest.mark.parametrize("chars", LENGTHS)
def test_calibration_image_policy(kind, chars):
    assert calibrate.image_input(material_of(kind), "字" * chars) is (chars < CALIBRATION_POLICY[kind])


@pytest.mark.parametrize("kind", [PRESENTATION, PDF])
@pytest.mark.parametrize("chars", [0, 59, 60, 199, 200, 599, 600, 900])
def test_digest_image_policy(kind, chars):
    """整理原文宁多发图：600 字以下都带页图，避免整理稿永久缺块。"""
    assert prefers_image(material_of(kind), "字" * chars, purpose="digest") is (chars < DIGEST_POLICY[kind])


@pytest.mark.parametrize("kind", [PRESENTATION, PDF])
@pytest.mark.parametrize("chars", [0, 30, 60, 150, 250])
def test_both_paths_delegate_to_the_same_policy(kind, chars):
    """两条链路必须给出相同判断，不能再各自维护一套阈值。"""
    for purpose in ("generation", "calibration"):
        assert prefers_image(material_of(kind), "字" * chars, purpose=purpose) == (
            chars < IMAGE_POLICY[kind][purpose])


@pytest.mark.parametrize("kind", [PRESENTATION, PDF])
def test_whitespace_only_text_counts_as_empty(kind):
    assert calibrate.image_input(material_of(kind), " \n\t ") is True
    assert service.with_image(material_of(kind), " \n\t ") is True


def _narrated(db, classroom, texts, kind):
    material = material_fixture(db, classroom, texts, kind=kind)
    db.commit()
    for page_no in range(1, len(texts) + 1):
        repository.upsert(db, material, page_no, text="讲解" * 20)
    db.commit()
    return material


def _window(material, db, *, budget=calibrate.WINDOW_TEXT_BUDGET, image_limit=calibrate.IMAGE_LIMIT):
    items = calibrate.participating(db, material)
    payload, images, evidence, _ = calibrate._window_payload(
        material, items, {"summary": "", "terms": []}, budget=budget, image_limit=image_limit)
    return payload, images, evidence


def test_calibration_drops_the_text_it_replaces_with_an_image(db, classroom, monkeypatch):
    """发图时不再附那段碎文本，但这一页仍算有依据（可以判 mismatch）。"""
    monkeypatch.setattr(calibrate.render, "render_page", lambda material, page_no: b"\xff\xd8jpeg")
    material = _narrated(db, classroom, ["短" * 30], kind=PRESENTATION)
    payload, images, evidence = _window(material, db)
    page = payload["pages"][0]
    assert page["source_text"] == "" and page["source_truncated"] is False
    assert len([item for item in images if item.get("type") == "image_url"]) == 1
    assert evidence == {1}


def test_calibration_keeps_the_text_when_it_is_long_enough(db, classroom):
    material = _narrated(db, classroom, ["长" * 300], kind=PRESENTATION)
    payload, images, evidence = _window(material, db)
    page = payload["pages"][0]
    assert images == [] and page["source_text"] == "长" * 300 and page["source_truncated"] is False
    assert evidence == {1}


def test_calibration_pdf_with_fragmented_text_uses_the_image(db, classroom, monkeypatch):
    """校准的 PDF 也按 60 字发图：碎片文本不足以核对讲解。"""
    monkeypatch.setattr(calibrate.render, "render_page", lambda material, page_no: b"\xff\xd8jpeg")
    material = _narrated(db, classroom, ["碎" * 6, "文" * 300], kind=PDF)
    payload, images, _ = _window(material, db)
    assert [page["source_text"] for page in payload["pages"]] == ["", "文" * 300]
    assert len([item for item in images if item.get("type") == "image_url"]) == 1


def test_calibration_truncates_text_to_the_window_budget(db, classroom):
    """不发图的页按单窗预算截断；截断标记进入请求，模型据此不判未给出的内容。"""
    material = _narrated(db, classroom, ["文" * 3000], kind=PDF)
    payload, images, _ = _window(material, db, budget=1200)
    page = payload["pages"][0]
    assert images == [] and page["source_truncated"] is True
    assert len(page["source_text"]) == calibrate.page_limits(1200, 1)[1]


def test_calibration_stops_attaching_images_at_the_window_image_limit(db, classroom, monkeypatch):
    """图片上限按窗口计：超出预算的页退回文本，而不是超量发送。"""
    monkeypatch.setattr(calibrate.render, "render_page", lambda material, page_no: b"\xff\xd8jpeg")
    material = _narrated(db, classroom, ["短" * 10] * 4, kind=PRESENTATION)
    payload, images, _ = _window(material, db, image_limit=2)
    attached = len([item for item in images if item.get("type") == "image_url"])
    assert attached == 2
    # 未获得图片额度的页保留文本，避免既没图也没字。
    assert [bool(page["source_text"]) for page in payload["pages"]] == [False, False, True, True]


def test_image_policy_changes_the_deck_fingerprint(db, classroom, monkeypatch):
    """改了发图策略，整册指纹必须变化，否则会复用旧报告、跨策略续跑。"""
    from app.narration import config

    material = _narrated(db, classroom, ["短" * 30, "长" * 300], kind=PDF)
    items = calibrate.participating(db, material)
    settings = config.settings(db)
    before = calibrate.deck_fingerprint(material, items, settings)
    monkeypatch.setitem(IMAGE_POLICY[PDF], "calibration", PDF_TEXT_ONLY_THRESHOLD)
    after = calibrate.deck_fingerprint(material, items, settings)
    assert after != before
