"""Record the local owner of newly exported packages."""
from alembic import op
import sqlalchemy as sa

revision = "c4261124aa02"
down_revision = "ab261124cf01"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "course_exports",
        sa.Column("directory", sa.String(255), primary_key=True),
        sa.Column("exporter_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
    )


def downgrade():
    op.drop_table("course_exports")
