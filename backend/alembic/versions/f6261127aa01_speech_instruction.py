"""Add per-material speech_instruction and speech_speed overrides."""

import sqlalchemy as sa
from alembic import op

revision = "f6261127aa01"
down_revision = "f5261126aa01"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("material_narration_settings", sa.Column("speech_instruction", sa.String(length=200), nullable=True))
    op.add_column("material_narration_settings", sa.Column("speech_speed", sa.Float(), nullable=True))


def downgrade():
    with op.batch_alter_table("material_narration_settings") as batch_op:
        batch_op.drop_column("speech_speed")
        batch_op.drop_column("speech_instruction")
