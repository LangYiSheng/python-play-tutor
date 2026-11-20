"""Add public authored content to interactive practice questions."""
from alembic import op
import sqlalchemy as sa

revision = "b4f62cd09513"
down_revision = "9cb36afc267e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("questions", sa.Column("interactive", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("questions", "interactive")
