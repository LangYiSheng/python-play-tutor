"""Retain classroom evidence after archival and formal deletion."""

import sqlalchemy as sa
from alembic import op

revision = "ab430d96c215"
down_revision = "e51b92fa60c3"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("classrooms", sa.Column("status", sa.String(16), nullable=False, server_default="active"))
    # Older content authored by administrators could have the administrator stored as
    # owner even though the course instance exclusively belongs to a teacher's class.
    for table in ("chapters", "knowledge_points", "materials", "activities", "questions", "quest_definitions"):
        op.execute(sa.text(f"""
            UPDATE {table} SET owner_id = (
                SELECT c.teacher_id FROM classrooms c JOIN course_instances i ON i.classroom_id = c.id
                WHERE i.id = {table}.course_instance_id
            ) WHERE owner_id IS NOT NULL AND course_instance_id IS NOT NULL AND owner_id IN (
                SELECT id FROM users WHERE role = 'admin'
            ) AND owner_id <> (
                SELECT c.teacher_id FROM classrooms c JOIN course_instances i ON i.classroom_id = c.id
                WHERE i.id = {table}.course_instance_id
            )
        """))


def downgrade():
    if op.get_bind().execute(sa.text("SELECT COUNT(*) FROM classrooms WHERE status <> 'active'")).scalar():
        raise RuntimeError("存在已归档或删除的班级，降级会重新开放历史班级")
    op.drop_column("classrooms", "status")
