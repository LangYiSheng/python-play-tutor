"""Persist each learner's assigned knowledge-point practice questions."""
from alembic import op
import sqlalchemy as sa

revision = "f6512e40a77d"
down_revision = "e51b92fa60c3"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "practice_sessions",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("classroom_id", sa.Integer(), sa.ForeignKey("classrooms.id"), primary_key=True),
        sa.Column("activity_id", sa.String(100), sa.ForeignKey("activities.id"), primary_key=True),
        sa.Column("items", sa.JSON(), nullable=False),
    )
    op.create_index("ix_practice_sessions_activity_id", "practice_sessions", ["activity_id"])


def downgrade():
    op.drop_table("practice_sessions")
