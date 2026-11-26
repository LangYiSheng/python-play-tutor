"""Tests for batch and ZIP courseware upload endpoint."""

from __future__ import annotations

import io
import json
import zipfile

from sqlalchemy import select

from app.models import Chapter, Material

VALID_PDF = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"


class _GbkZipInfo(zipfile.ZipInfo):
    def __init__(self, real_name: str) -> None:
        self._raw_gbk = real_name.encode("gb18030")
        super().__init__(self._raw_gbk.decode("cp437"))
        self.flag_bits &= ~0x800

    def _encodeFilenameFlags(self) -> tuple[bytes, int]:
        return self._raw_gbk, self.flag_bits & ~0x800


def _make_zip(entries: list[tuple[str, bytes, bool]]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data, use_gbk in entries:
            if use_gbk:
                zf.writestr(_GbkZipInfo(name), data)
            else:
                zf.writestr(name, data)
    return buf.getvalue()


def test_batch_upload_files_and_zip_archive(client, db, teacher, student, classroom) -> None:
    cid = classroom["id"]
    chapter = db.scalar(select(Chapter).where(Chapter.course_instance_id == db.info["fixture_course_instance_id"]))
    assert chapter is not None

    # Student is forbidden
    denied = client.post(
        f"/api/teacher/materials/upload-batch?classroom_id={cid}",
        files=[("files", ("note.md", b"# Hello", "text/markdown"))],
        headers=student["headers"],
    )
    assert denied.status_code == 403

    # Direct multi-file upload
    res = client.post(
        f"/api/teacher/materials/upload-batch?classroom_id={cid}",
        files=[
            ("files", ("ch1-slides.pdf", VALID_PDF, "application/pdf")),
            ("files", ("ch1-notes.md", "# 第一章笔记\n变量赋值".encode("utf-8"), "text/markdown")),
            ("files", ("unsupported.exe", b"MZ", "application/octet-stream")),
        ],
        data={"chapter_ids": json.dumps([chapter.id])},
        headers=teacher["headers"],
    )
    assert res.status_code == 201, res.text
    payload = res.json()
    assert len(payload["created"]) == 2
    assert {item["title"] for item in payload["created"]} == {"ch1-slides", "ch1-notes"}
    assert len(payload["skipped"]) == 1
    assert payload["skipped"][0]["filename"] == "unsupported.exe"

    # ZIP archive with UTF-8 PDF, GBK Chinese markdown, ignored __MACOSX, and unsupported jpg
    archive = _make_zip(
        [
            ("slides/01_intro.pdf", VALID_PDF, False),
            ("讲义/第一章变量.md", "# 变量与命名".encode("utf-8"), True),
            ("__MACOSX/slides/._01_intro.pdf", VALID_PDF, False),
            ("slides/cover.jpg", b"\xff\xd8\xff", False),
        ]
    )
    zip_res = client.post(
        f"/api/teacher/materials/upload-batch?classroom_id={cid}",
        files=[("files", ("定稿版.zip", archive, "application/zip"))],
        data={"chapter_ids": json.dumps([chapter.id])},
        headers=teacher["headers"],
    )
    assert zip_res.status_code == 201, zip_res.text
    zip_data = zip_res.json()
    assert {item["title"] for item in zip_data["created"]} == {"01_intro", "第一章变量"}
    assert [item["filename"] for item in zip_data["skipped"]] == ["cover.jpg"]

    stored = list(db.scalars(select(Material).where(Material.course_instance_id == db.info["fixture_course_instance_id"])))
    assert len(stored) >= 4


def test_batch_upload_detects_v3_course_package_zip(client, teacher, classroom) -> None:
    cid = classroom["id"]
    pkg_zip = _make_zip([("manifest.yaml", b"package_version: 3\n", False)])
    res = client.post(
        f"/api/teacher/materials/upload-batch?classroom_id={cid}",
        files=[("files", ("course-pack.zip", pkg_zip, "application/zip"))],
        headers=teacher["headers"],
    )
    assert res.status_code == 422
    assert "manifest.yaml" in res.json()["detail"]


def _make_sample_pptx() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
        )
        zf.writestr(
            "ppt/presentation.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>'
            "</p:presentation>",
        )
        zf.writestr(
            "ppt/_rels/presentation.xml.rels",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>'
            "</Relationships>",
        )
        zf.writestr(
            "ppt/slides/slide1.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
            'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            "<p:cSld><p:spTree><p:sp><p:txBody>"
            "<a:p><a:r><a:t>第五章 数据结构</a:t></a:r></a:p>"
            "<a:p><a:r><a:t>列表、元组与字典基础</a:t></a:r></a:p>"
            "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>",
        )
        zf.writestr(
            "ppt/slides/_rels/slide1.xml.rels",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>'
            "</Relationships>",
        )
        zf.writestr(
            "ppt/notesSlides/notesSlide1.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
            'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            "<p:cSld><p:spTree><p:sp><p:txBody>"
            "<a:p><a:r><a:t>提醒学生区分可变与不可变序列</a:t></a:r></a:p>"
            "</p:txBody></p:sp></p:spTree></p:cSld></p:notes>",
        )
        zf.writestr(
            "ppt/slides/slide2.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
            'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            "<p:cSld><p:spTree><p:sp><p:txBody>"
            "<a:p><a:r><a:t>5.1 列表切片</a:t></a:r></a:p>"
            "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>",
        )
    return buf.getvalue()


def test_pptx_parses_directly_without_docker_converter_and_supports_retry(
    client, db, teacher, classroom, monkeypatch
) -> None:
    from sqlalchemy.orm import sessionmaker
    from app.materials import jobs as material_jobs

    monkeypatch.delenv("REBORN_CONVERTER_URL", raising=False)
    monkeypatch.delenv("REBORN_CONVERTER_IMAGE", raising=False)
    monkeypatch.setattr(material_jobs, "convert_presentation_local_windows", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        material_jobs,
        "SessionLocal",
        sessionmaker(db.get_bind(), expire_on_commit=False),
    )
    cid = classroom["id"]
    up = client.post(
        f"/api/teacher/materials/upload?classroom_id={cid}",
        data={"title": "第五章数据结构"},
        files={"file": ("ch5.pptx", _make_sample_pptx(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")},
        headers=teacher["headers"],
    )
    assert up.status_code == 201, up.text
    mid = up.json()["id"]

    material_jobs.process_material(mid)
    db.expire_all()
    mat = db.get(Material, mid)
    assert mat is not None
    assert mat.status == "ready"
    assert mat.error is None
    pages = mat.content["pages"]
    assert len(pages) == 2
    assert pages[0]["title"] == "第五章 数据结构"
    assert "提醒学生区分可变与不可变序列" in pages[0]["text"]
    assert pages[1]["title"] == "5.1 列表切片"

    preview = client.get(f"/api/teacher/materials/{mid}?classroom_id={cid}", headers=teacher["headers"])
    assert preview.status_code == 200
    assert preview.json()["media_url"] is None
    assert len(preview.json()["pages"]) == 2

    # Simulate failed status -> retry endpoint re-queues cleanly
    mat.status = "failed"
    mat.error = "PPT转换器未配置"
    db.commit()
    retry = client.post(f"/api/teacher/materials/{mid}/retry?classroom_id={cid}", headers=teacher["headers"])
    assert retry.status_code == 200, retry.text
    assert retry.json()["status"] == "queued"


def _make_two_page_pdf() -> bytes:
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=400, height=300)
    writer.add_blank_page(width=600, height=450)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def test_page_pdf_endpoint_slices_exact_single_page_for_pdf_and_converted_pptx(
    client, db, teacher, classroom, monkeypatch
) -> None:
    from pypdf import PdfReader
    from sqlalchemy.orm import sessionmaker
    from app.materials import jobs as material_jobs

    monkeypatch.delenv("REBORN_CONVERTER_URL", raising=False)
    monkeypatch.delenv("REBORN_CONVERTER_IMAGE", raising=False)
    monkeypatch.setattr(material_jobs, "ENVIRONMENT", "development")
    monkeypatch.setattr(
        material_jobs,
        "SessionLocal",
        sessionmaker(db.get_bind(), expire_on_commit=False),
    )

    cid = classroom["id"]
    pdf_bytes = _make_two_page_pdf()
    up_pdf = client.post(
        f"/api/teacher/materials/upload?classroom_id={cid}",
        data={"title": "双页测试PDF"},
        files={"file": ("two-pages.pdf", pdf_bytes, "application/pdf")},
        headers=teacher["headers"],
    )
    assert up_pdf.status_code == 201, up_pdf.text
    pdf_mid = up_pdf.json()["id"]
    material_jobs.process_material(pdf_mid)

    p1 = client.get(f"/api/teacher/classrooms/{cid}/materials/{pdf_mid}/narrations/1/page-pdf", headers=teacher["headers"])
    assert p1.status_code == 200
    assert p1.headers["content-type"].startswith("application/pdf")
    r1 = PdfReader(io.BytesIO(p1.content))
    assert len(r1.pages) == 1
    assert float(r1.pages[0].mediabox.width) == 400.0

    p2 = client.get(f"/api/teacher/classrooms/{cid}/materials/{pdf_mid}/narrations/2/page-pdf", headers=teacher["headers"])
    assert p2.status_code == 200
    r2 = PdfReader(io.BytesIO(p2.content))
    assert len(r2.pages) == 1
    assert float(r2.pages[0].mediabox.width) == 600.0

    assert client.get(f"/api/teacher/classrooms/{cid}/materials/{pdf_mid}/narrations/0/page-pdf", headers=teacher["headers"]).status_code == 404
    assert client.get(f"/api/teacher/classrooms/{cid}/materials/{pdf_mid}/narrations/3/page-pdf", headers=teacher["headers"]).status_code == 404

    # Local Windows PowerPoint COM fallback produces preview_key and enables exact /page-pdf for PPTX
    def fake_local_convert(_source, tmp):
        out = tmp / "converted.pdf"
        out.write_bytes(pdf_bytes)
        return out

    monkeypatch.setattr(material_jobs.os, "name", "nt")
    monkeypatch.setattr(material_jobs, "convert_presentation_local_windows", fake_local_convert)

    up_ppt = client.post(
        f"/api/teacher/materials/upload?classroom_id={cid}",
        data={"title": "本地转PDF测试PPT"},
        files={"file": ("deck.pptx", _make_sample_pptx(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")},
        headers=teacher["headers"],
    )
    assert up_ppt.status_code == 201, up_ppt.text
    ppt_mid = up_ppt.json()["id"]
    material_jobs.process_material(ppt_mid)
    db.expire_all()
    ppt_mat = db.get(Material, ppt_mid)
    assert ppt_mat is not None and ppt_mat.status == "ready"
    assert str(ppt_mat.content.get("preview_key", "")).endswith(".pdf")

    ppt_p2 = client.get(f"/api/teacher/classrooms/{cid}/materials/{ppt_mid}/narrations/2/page-pdf", headers=teacher["headers"])
    assert ppt_p2.status_code == 200
    r_ppt2 = PdfReader(io.BytesIO(ppt_p2.content))
    assert len(r_ppt2.pages) == 1
    assert float(r_ppt2.pages[0].mediabox.width) == 600.0


def test_ppt_upload_auto_creates_chapter_when_no_chapter_selected(client, db, teacher, classroom) -> None:
    cid = classroom["id"]
    instance_id = db.info["fixture_course_instance_id"]
    before_chapters = list(db.scalars(select(Chapter).where(Chapter.course_instance_id == instance_id)))
    existing_chapter = before_chapters[0]

    # 1) Single PPT upload with empty chapter_ids auto-creates a chapter with order_index=20
    #    and strips the leading '第二十章' prefix from the chapter folder name (while keeping PPT title intact)
    up1 = client.post(
        f"/api/teacher/materials/upload?classroom_id={cid}",
        data={"title": "第二十章 控制结构", "chapter_ids": "[]"},
        files={"file": ("ch20.pptx", _make_sample_pptx(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")},
        headers=teacher["headers"],
    )
    assert up1.status_code == 201, up1.text
    body1 = up1.json()
    assert body1["title"] == "第二十章 控制结构"
    assert body1["created_chapter"]["title"] == "控制结构"
    assert body1["created_chapter"]["order_index"] == 20
    assert body1["chapter_ids"] == [body1["created_chapter"]["id"]]

    # 2) Uploading another PPT with the same title without chapters reuses that chapter instead of duplicating
    up_same = client.post(
        f"/api/teacher/materials/upload?classroom_id={cid}",
        data={"title": "第二十章 控制结构", "chapter_ids": "[]"},
        files={"file": ("ch20-v2.pptx", _make_sample_pptx(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")},
        headers=teacher["headers"],
    )
    assert up_same.status_code == 201, up_same.text
    assert "created_chapter" not in up_same.json()
    assert up_same.json()["chapter_ids"] == [body1["created_chapter"]["id"]]

    # 3) Explicit chapter_ids keeps the PPT in the chosen chapter without auto-creating a new chapter
    up_explicit = client.post(
        f"/api/teacher/materials/upload?classroom_id={cid}",
        data={"title": "附属演示稿", "chapter_ids": json.dumps([existing_chapter.id])},
        files={"file": ("extra.pptx", _make_sample_pptx(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")},
        headers=teacher["headers"],
    )
    assert up_explicit.status_code == 201, up_explicit.text
    assert "created_chapter" not in up_explicit.json()
    assert up_explicit.json()["chapter_ids"] == [existing_chapter.id]

    # 4) Batch upload of out-of-order numbered + unnumbered PPTs assigns exact parsed chapter numbers,
    #    strips leading '第X章' / 'Chapter X' from folder titles, and appends unnumbered PPTs in upload order
    batch = client.post(
        f"/api/teacher/materials/upload-batch?classroom_id={cid}",
        files=[
            ("files", ("项目实战补充.pptx", _make_sample_pptx(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")),
            ("files", ("第十八章图形化用户界面.pptx", _make_sample_pptx(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")),
            ("files", ("第十六章数据存取与分析.pptx", _make_sample_pptx(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")),
            ("files", ("第12章 综合案例.pptx", _make_sample_pptx(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")),
            ("files", ("Chapter 15 Networking.pptx", _make_sample_pptx(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")),
            ("files", ("第十九章.pptx", _make_sample_pptx(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")),
            ("files", ("第十七章人工智能基础.pdf", VALID_PDF, "application/pdf")),
        ],
        headers=teacher["headers"],
    )
    assert batch.status_code == 201, batch.text
    batch_data = batch.json()
    created_by_title = {c["title"]: c["order_index"] for c in batch_data["created_chapters"]}
    assert created_by_title["综合案例"] == 12
    assert created_by_title["Networking"] == 15
    assert created_by_title["数据存取与分析"] == 16
    assert created_by_title["人工智能基础"] == 17
    assert created_by_title["图形化用户界面"] == 18
    # Bare '第十九章' with no trailing topic falls back to keeping '第十九章'
    assert created_by_title["第十九章"] == 19
    # Unnumbered PPT follows upload order after max existing order_index (20 -> 21)
    assert created_by_title["项目实战补充"] == 21

    # 5) Collision fallback: when parsed chapter number is already occupied (20), appends at max + 1 (22)
    up_collision = client.post(
        f"/api/teacher/materials/upload?classroom_id={cid}",
        data={"title": "第二十章 另一版本", "chapter_ids": "[]"},
        files={"file": ("ch20-alt.pptx", _make_sample_pptx(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")},
        headers=teacher["headers"],
    )
    assert up_collision.status_code == 201, up_collision.text
    assert up_collision.json()["created_chapter"]["title"] == "另一版本"
    assert up_collision.json()["created_chapter"]["order_index"] == 22
