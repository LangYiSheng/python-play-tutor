"""Page-level digested text (`page_contents`) and the course tag dictionary.

Raw parsed text stays in `materials.content`; this table only holds the organised
copy plus its structured fields (title / topic / tags), so a re-upload can never
overwrite teacher-reviewed wording by accident.

Backfill copies every existing page verbatim with `source="parsed"` so old
materials still have rows; the digest pass later replaces them.

Revision ID: b3d8f1c47a26
Revises: e51b92fa60c3
"""
import hashlib
import json
from datetime import datetime, timezone

from alembic import op
import sqlalchemy as sa

revision = "b3d8f1c47a26"
down_revision = "e51b92fa60c3"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "page_contents",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("material_id", sa.Integer(), sa.ForeignKey("materials.id", ondelete="CASCADE"), nullable=False),
        sa.Column("page_no", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(120), nullable=False, server_default=""),
        sa.Column("topic", sa.String(240), nullable=False, server_default=""),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False, server_default=""),
        sa.Column("raw_text_hash", sa.String(64), nullable=False, server_default=""),
        sa.Column("source", sa.String(16), nullable=False, server_default="parsed"),
        sa.Column("status", sa.String(16), nullable=False, server_default="draft"),
        sa.Column("image_state", sa.String(16), nullable=False, server_default="policy"),
        sa.Column("model", sa.String(80), nullable=False, server_default=""),
        sa.Column("prompt_version", sa.String(24), nullable=False, server_default=""),
        sa.Column("input_hash", sa.String(64), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("material_id", "page_no", name="uq_page_contents_material_page"),
    )
    op.create_index("ix_page_contents_material_id", "page_contents", ["material_id"])

    op.create_table(
        "material_tag_dicts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("course_instance_id", sa.Integer(),
                  sa.ForeignKey("course_instances.id", ondelete="CASCADE"), nullable=False),
        sa.Column("alias", sa.String(80), nullable=False),
        sa.Column("canonical", sa.String(80), nullable=False),
        sa.Column("source_material_id", sa.Integer(),
                  sa.ForeignKey("materials.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("course_instance_id", "alias", name="uq_material_tag_dicts_course_alias"),
    )
    op.create_index("ix_material_tag_dicts_course_instance_id", "material_tag_dicts", ["course_instance_id"])

    _backfill()


def _backfill():
    """Copy existing page text as `parsed` rows; nothing is sent through a model."""
    connection = op.get_bind()
    rows = connection.execute(sa.text(
        "SELECT id, content FROM materials WHERE content IS NOT NULL")).all()
    stamp = datetime.now(timezone.utc)
    payload: list[dict] = []
    for material_id, content in rows:
        try:
            pages = json.loads(content) if isinstance(content, str) else (content or {})
        except (TypeError, ValueError):
            continue
        for page in (pages.get("pages") or []) if isinstance(pages, dict) else []:
            if not isinstance(page, dict):
                continue
            page_no = page.get("page_no") or page.get("id")
            if not isinstance(page_no, int):
                continue
            text = str(page.get("text") or "")
            payload.append({
                "material_id": material_id,
                "page_no": page_no,
                "title": str(page.get("title") or "")[:120],
                "topic": "",
                "tags": [],
                "text": text,
                "raw_text_hash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "source": "parsed",
                "status": "draft",
                "image_state": "policy",
                "model": "",
                "prompt_version": "",
                "input_hash": "",
                "created_at": stamp,
                "updated_at": stamp,
            })
    if not payload:
        return
    # 大资料一次插太宽；分批写，保持单条语句的参数数量可控。
    for start in range(0, len(payload), 500):
        op.bulk_insert(_page_contents_table(), payload[start:start + 500])


def _page_contents_table():
    return sa.table(
        "page_contents",
        sa.column("material_id", sa.Integer),
        sa.column("page_no", sa.Integer),
        sa.column("title", sa.String),
        sa.column("topic", sa.String),
        sa.column("tags", sa.JSON),
        sa.column("text", sa.Text),
        sa.column("raw_text_hash", sa.String),
        sa.column("source", sa.String),
        sa.column("status", sa.String),
        sa.column("image_state", sa.String),
        sa.column("model", sa.String),
        sa.column("prompt_version", sa.String),
        sa.column("input_hash", sa.String),
        sa.column("created_at", sa.DateTime),
        sa.column("updated_at", sa.DateTime),
    )


def downgrade():
    op.drop_index("ix_material_tag_dicts_course_instance_id", table_name="material_tag_dicts")
    op.drop_table("material_tag_dicts")
    op.drop_index("ix_page_contents_material_id", table_name="page_contents")
    op.drop_table("page_contents")
