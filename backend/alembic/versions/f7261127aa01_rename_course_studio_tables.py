"""Rename course studio tables and migrate knowledge point metadata key."""

from __future__ import annotations

import json
from typing import Any

import sqlalchemy as sa
from alembic import op

revision = "f7261127aa01"
down_revision = "f6261127aa01"
branch_labels = None
depends_on = None

_OLD_KEY = "lect" + "io"
_NEW_KEY = "course_studio"
_OLD_EXAMS = _OLD_KEY + "_exams"
_NEW_EXAMS = "course_studio_exams"
_OLD_JOBS = _OLD_KEY + "_jobs"
_NEW_JOBS = "course_studio_jobs"


def _migrate_kp_content_key(old_key: str, new_key: str) -> None:
    conn = op.get_bind()
    kp_table = sa.table(
        "knowledge_points",
        sa.column("id", sa.Integer),
        sa.column("content", sa.JSON),
    )
    rows = conn.execute(sa.select(kp_table.c.id, kp_table.c.content)).fetchall()
    for row_id, raw_content in rows:
        content: Any = raw_content
        if isinstance(content, str):
            try:
                content = json.loads(content)
            except ValueError:
                continue
        if not isinstance(content, dict) or old_key not in content:
            continue
        updated = dict(content)
        val = updated.pop(old_key)
        if new_key not in updated:
            updated[new_key] = val
        conn.execute(
            kp_table.update().where(kp_table.c.id == row_id).values(content=updated)
        )


def upgrade() -> None:
    op.drop_index(f"ix_{_OLD_EXAMS}_course_instance_id", table_name=_OLD_EXAMS)
    op.rename_table(_OLD_EXAMS, _NEW_EXAMS)
    with op.batch_alter_table(_NEW_EXAMS) as batch:
        batch.drop_constraint(f"uq_{_OLD_EXAMS}_instance_stable", type_="unique")
        batch.create_unique_constraint(
            f"uq_{_NEW_EXAMS}_instance_stable",
            ["course_instance_id", "stable_id"],
        )
    op.create_index(f"ix_{_NEW_EXAMS}_course_instance_id", _NEW_EXAMS, ["course_instance_id"])

    op.drop_index(f"ix_{_OLD_JOBS}_status", table_name=_OLD_JOBS)
    op.drop_index(f"ix_{_OLD_JOBS}_scope_key", table_name=_OLD_JOBS)
    op.drop_index(f"ix_{_OLD_JOBS}_kind", table_name=_OLD_JOBS)
    op.drop_index(f"ix_{_OLD_JOBS}_course_instance_id", table_name=_OLD_JOBS)
    op.rename_table(_OLD_JOBS, _NEW_JOBS)
    op.create_index(f"ix_{_NEW_JOBS}_course_instance_id", _NEW_JOBS, ["course_instance_id"])
    op.create_index(f"ix_{_NEW_JOBS}_kind", _NEW_JOBS, ["kind"])
    op.create_index(f"ix_{_NEW_JOBS}_scope_key", _NEW_JOBS, ["scope_key"])
    op.create_index(f"ix_{_NEW_JOBS}_status", _NEW_JOBS, ["status"])

    _migrate_kp_content_key(_OLD_KEY, _NEW_KEY)


def downgrade() -> None:
    _migrate_kp_content_key(_NEW_KEY, _OLD_KEY)

    op.drop_index(f"ix_{_NEW_JOBS}_status", table_name=_NEW_JOBS)
    op.drop_index(f"ix_{_NEW_JOBS}_scope_key", table_name=_NEW_JOBS)
    op.drop_index(f"ix_{_NEW_JOBS}_kind", table_name=_NEW_JOBS)
    op.drop_index(f"ix_{_NEW_JOBS}_course_instance_id", table_name=_NEW_JOBS)
    op.rename_table(_NEW_JOBS, _OLD_JOBS)
    op.create_index(f"ix_{_OLD_JOBS}_course_instance_id", _OLD_JOBS, ["course_instance_id"])
    op.create_index(f"ix_{_OLD_JOBS}_kind", _OLD_JOBS, ["kind"])
    op.create_index(f"ix_{_OLD_JOBS}_scope_key", _OLD_JOBS, ["scope_key"])
    op.create_index(f"ix_{_OLD_JOBS}_status", _OLD_JOBS, ["status"])

    op.drop_index(f"ix_{_NEW_EXAMS}_course_instance_id", table_name=_NEW_EXAMS)
    with op.batch_alter_table(_NEW_EXAMS) as batch:
        batch.drop_constraint(f"uq_{_NEW_EXAMS}_instance_stable", type_="unique")
        batch.create_unique_constraint(
            f"uq_{_OLD_EXAMS}_instance_stable",
            ["course_instance_id", "stable_id"],
        )
    op.rename_table(_NEW_EXAMS, _OLD_EXAMS)
    op.create_index(f"ix_{_OLD_EXAMS}_course_instance_id", _OLD_EXAMS, ["course_instance_id"])
