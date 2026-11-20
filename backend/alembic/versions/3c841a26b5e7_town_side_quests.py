"""Allow town-wide side quests alongside chapter quests."""

from alembic import op
import sqlalchemy as sa


revision = "3c841a26b5e7"
down_revision = "9cb36afc267e"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("quest_definitions") as batch:
        batch.alter_column("chapter_id", existing_type=sa.Integer(), nullable=True)


def downgrade():
    if op.get_bind().execute(sa.text("select 1 from quest_definitions where chapter_id is null limit 1")).first():
        raise RuntimeError("回退前请先为现有全镇支线指定章节。")
    with op.batch_alter_table("quest_definitions") as batch:
        batch.alter_column("chapter_id", existing_type=sa.Integer(), nullable=False)
