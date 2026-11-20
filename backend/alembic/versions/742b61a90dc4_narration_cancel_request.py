"""Persist cancellation on the specific narration attempt being stopped."""
from alembic import op
import sqlalchemy as sa

revision = "742b61a90dc4"
down_revision = "70df3948b2ac"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("narration_runs", sa.Column("cancel_requested_at", sa.DateTime(timezone=True), nullable=True))


def downgrade():
    op.drop_column("narration_runs", "cancel_requested_at")
