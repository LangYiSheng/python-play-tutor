"""Validate and apply a batch of narration reviews against their current source pages."""
from itertools import batched

from fastapi import HTTPException
from sqlalchemy import select

from app.course_content.review_catalog import material_scope
from app.models import Material
from app.narration import repository
from app.narration.models import PageContent, PageNarration


def apply_narrations(db, instance, user, items, status, text=None):
    revisions = {}
    for item in items:
        if not item.id.isascii() or not item.id.isdecimal() or len(item.id) > 18:
            raise HTTPException(404, "讲解草稿不存在")
        revisions[int(item.id)] = item.revision
    if len(revisions) != len(items):
        raise HTTPException(422, "审批范围包含重复项")

    for ids in batched(sorted(revisions), 500):
        material_ids = select(PageNarration.material_id).where(PageNarration.id.in_(ids))
        material_query = (select(Material).where(*material_scope(instance, user), Material.id.in_(material_ids))
                          .order_by(Material.id).with_for_update().execution_options(populate_existing=True))
        materials = {material.id: material for material in db.scalars(material_query)}
        row_query = (select(PageNarration).where(PageNarration.id.in_(ids), PageNarration.material_id.in_(materials),
                                                 PageNarration.status == "draft")
                     .order_by(PageNarration.id).with_for_update().execution_options(populate_existing=True))
        rows = db.scalars(row_query).all()
        if len(rows) != len(ids):
            raise HTTPException(409, "讲解草稿已移出待审批，请刷新")
        digest_query = (select(PageContent).join(PageNarration, (PageContent.material_id == PageNarration.material_id)
                                                 & (PageContent.page_no == PageNarration.page_no))
                        .where(PageNarration.id.in_(ids)).order_by(PageContent.id)
                        .with_for_update(of=PageContent).execution_options(populate_existing=True))
        digests = {(digest.material_id, digest.page_no): digest for digest in db.scalars(digest_query)}
        source_pages = {mid: repository.page_map(m) for mid, m in materials.items()}
        for row in rows:
            if repository.revision(row) != revisions[row.id]:
                raise HTTPException(409, "讲解稿已改变，请刷新后重新审阅")
            material = materials[row.material_id]
            page = source_pages[material.id].get(row.page_no)
            if page is None or row.page_hash != repository.narration_page_hash(
                material, row.page_no, str(page.get("text") or ""), digests.get((material.id, row.page_no))
            ):
                raise HTTPException(409, f"「{material.title}」第 {row.page_no} 页来源已变化，请在课件中重新审校")
            if text is not None:
                repository.upsert(db, material, row.page_no, text=text, target_seconds=row.target_seconds)
            repository.review_narration(row, status, user)
        db.flush()
