"""Create lectio_exams and lectio_jobs tables."""

import sqlalchemy as sa
from alembic import op

revision = "a1c7e4b29f10"
down_revision = "8f5e126c09a4"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "lectio_exams",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "course_instance_id",
            sa.Integer(),
            sa.ForeignKey("course_instances.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("stable_id", sa.String(length=100), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("mode", sa.String(length=16), nullable=False),
        sa.Column("blueprint", sa.JSON(), nullable=False),
        sa.Column("variants", sa.JSON(), nullable=False),
        sa.Column("stats", sa.JSON(), nullable=False),
        sa.Column(
            "created_by",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("course_instance_id", "stable_id", name="uq_lectio_exams_instance_stable"),
    )
    op.create_index("ix_lectio_exams_course_instance_id", "lectio_exams", ["course_instance_id"])

    op.create_table(
        "lectio_jobs",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "course_instance_id",
            sa.Integer(),
            sa.ForeignKey("course_instances.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("scope_key", sa.String(length=120), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column(
            "requested_by",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("progress", sa.JSON(), nullable=False),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("error", sa.Text(), nullable=False),
        sa.Column("cancel_requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_lectio_jobs_course_instance_id", "lectio_jobs", ["course_instance_id"])
    op.create_index("ix_lectio_jobs_kind", "lectio_jobs", ["kind"])
    op.create_index("ix_lectio_jobs_scope_key", "lectio_jobs", ["scope_key"])
    op.create_index("ix_lectio_jobs_status", "lectio_jobs", ["status"])


def downgrade():
    op.drop_index("ix_lectio_jobs_status", table_name="lectio_jobs")
    op.drop_index("ix_lectio_jobs_scope_key", table_name="lectio_jobs")
    op.drop_index("ix_lectio_jobs_kind", table_name="lectio_jobs")
    op.drop_index("ix_lectio_jobs_course_instance_id", table_name="lectio_jobs")
    op.drop_table("lectio_jobs")

    op.drop_index("ix_lectio_exams_course_instance_id", table_name="lectio_exams")
    op.drop_table("lectio_exams")
