"""Add teacher_voices, material_narration_settings, and page audio voice metadata."""

import sqlalchemy as sa
from alembic import op

revision = "f5261126aa01"
down_revision = "e4261126aa01"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("page_narrations", sa.Column("audio_voice", sa.String(length=200), nullable=True))
    op.add_column("page_narrations", sa.Column("audio_model", sa.String(length=120), nullable=True))

    op.create_table(
        "teacher_voices",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "owner_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("target_model", sa.String(length=120), nullable=False),
        sa.Column("provider_voice_id", sa.String(length=200), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("error", sa.Text(), nullable=False),
        sa.Column("sample_key", sa.Text(), nullable=True),
        sa.Column("sample_seconds", sa.Integer(), nullable=True),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_teacher_voices_owner_id", "teacher_voices", ["owner_id"])

    op.create_table(
        "material_narration_settings",
        sa.Column(
            "material_id",
            sa.Integer(),
            sa.ForeignKey("materials.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("voice_mode", sa.String(length=16), nullable=False),
        sa.Column(
            "teacher_voice_id",
            sa.Integer(),
            sa.ForeignKey("teacher_voices.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_material_narration_settings_teacher_voice_id",
        "material_narration_settings",
        ["teacher_voice_id"],
    )


def downgrade():
    op.drop_index("ix_material_narration_settings_teacher_voice_id", table_name="material_narration_settings")
    op.drop_table("material_narration_settings")

    op.drop_index("ix_teacher_voices_owner_id", table_name="teacher_voices")
    op.drop_table("teacher_voices")

    with op.batch_alter_table("page_narrations") as batch_op:
        batch_op.drop_column("audio_model")
        batch_op.drop_column("audio_voice")
