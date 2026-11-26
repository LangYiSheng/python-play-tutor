"""Replace old course orchestration and learner saves with chapter task points."""
from alembic import op
import sqlalchemy as sa

revision = "d4261126aa01"
down_revision = "c4261124aa02"
branch_labels = None
depends_on = None


def upgrade():
    # Every table here contains old activity definitions, dependent evidence or a stale edit preview.
    # Delete in FK dependency order and retain identities, releases, curriculum, resources and media.
    for name in (
        "content_deletion_previews", "course_import_previews", "experience_checkpoints", "assistant_calls",
        "assistant_sessions", "narration_questions", "story_sessions", "learning_events", "node_states", "player_quests",
        "world_flags", "building_unlocks", "player_positions", "assessment_attempts", "practice_sessions",
        "activity_progress", "learning_records", "submission_diagnostics", "submission_payloads", "submissions",
        "activity_questions", "activity_materials", "story_definitions", "quest_definitions", "activities", "npcs",
    ):
        op.execute(sa.table(name).delete())
    op.execute("UPDATE chapters SET prerequisite_chapter_id = NULL")
    # Only the private media inventory is portable after the change.
    state = sa.table("course_package_state", sa.column("course_instance_id", sa.Integer), sa.column("configuration", sa.JSON))
    bind = op.get_bind()
    for course, old in list(bind.execute(sa.select(state.c.course_instance_id, state.c.configuration))):
        config = {key: val for key, val in (old or {}).items() if key == "_assets"}
        if "_assets" in config:
            config["_assets"] = [item for item in config["_assets"] if not item.get("character_kind")]
        bind.execute(state.update().where(state.c.course_instance_id == course).values(configuration=config))
    op.add_column("material_chapters", sa.Column("required", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("material_chapters", sa.Column("rule", sa.JSON(), nullable=False, server_default="{}"))
    op.add_column("material_chapters", sa.Column("order_index", sa.Integer(), nullable=False, server_default="0"))
    op.create_table("material_participation",
        *(sa.Column(name, sa.Integer(), sa.ForeignKey(f"{parent}.id", ondelete="CASCADE"), primary_key=True)
          for name, parent in (("user_id", "users"), ("classroom_id", "classrooms"),
                               ("chapter_id", "chapters"), ("material_id", "materials"))),
        sa.Column("evidence", sa.JSON(), nullable=False))
    from app.platform_roles import PlatformRole, PlatformRoleImage
    PlatformRole.__table__.create(bind, checkfirst=True)
    PlatformRoleImage.__table__.create(bind, checkfirst=True)


def downgrade():
    raise RuntimeError("旧版存档已清除，回退须从升级前备份恢复")
