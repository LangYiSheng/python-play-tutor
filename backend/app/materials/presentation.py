"""Present material metadata and authenticated delivery links."""

from math import isfinite

from app.content_relations import material_chapter_ids


def embeddable_media(material):
    return bool(material.storage_key and material.status == "ready" and (
        material.kind != "presentation" or material.content.get("preview_key")
    ))


def authoring_page_text(page):
    text = str(page.get("text") or "")
    notes = page.get("speaker_notes")
    if notes:
        return "\n\n".join(filter(None, (text, f"[讲者备注]\n{notes}")))[:40000]
    return text


def material_payload(db, material, *, chapter_ids=None, include_notes=False):
    chapters = material_chapter_ids(db, material.id) if chapter_ids is None else chapter_ids
    duration = material.content.get("duration_seconds")
    if material.kind != "video" or type(duration) not in (int, float) or (type(duration) is float and not isfinite(duration)) or duration <= 0:
        duration = None
    pages = material.content.get("pages", [])
    if material.kind == "presentation":
        pages = [{**{key: value for key, value in page.items() if key != "speaker_notes"},
                  "text": authoring_page_text(page) if include_notes else page.get("text", "")} for page in pages]
    return {
        "id": material.id,
        "title": material.title,
        "kind": material.kind,
        "chapter_id": chapters[0] if chapters else None,
        "chapter_ids": chapters,
        "status": material.status,
        "pages": pages,
        "notice": material.content.get("notice"),
        "media_url": f"/api/materials/{material.id}/file" if embeddable_media(material) else None,
        "error": material.error,
        "duration_seconds": duration,
    }
