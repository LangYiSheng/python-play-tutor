"""Promote each existing classroom course without rekeying content or learner evidence."""
from uuid import uuid4
import hashlib
import json

import sqlalchemy as sa
from alembic import op

revision = "ab261124cf01"
down_revision = "8f5e126c09a4"
branch_labels = None
depends_on = None


def migrate_template_fingerprints(db):
    state = sa.table("course_package_state", sa.column("course_instance_id", sa.Integer), sa.column("configuration", sa.JSON))
    for key, config in db.execute(sa.select(state.c.course_instance_id, state.c.configuration)).all():
        saved = config.get("_quick_orchestration")
        if not saved:
            continue
        before = saved.pop("releases_before", {})
        saved["prerequisites_before"] = {k: {"chapter_id": k, "prerequisite_chapter_id": v["prerequisite_chapter_id"]}
                                         if v and v.get("prerequisite_chapter_id") else None for k, v in before.items()}
        owned = saved.get("owned", {})
        original = owned.pop("releases", {})
        parents = {}
        prior = None
        for item in saved.get("recipe", {}).get("chapters", []):
            stable = item["chapter_id"]
            if prior is not None and stable in original:
                row = {"chapter_id": stable, "prerequisite_chapter_id": prior}
                parents[stable] = hashlib.sha256(json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
            prior = stable
        owned["prerequisites"] = parents
        db.execute(state.update().where(state.c.course_instance_id == key).values(configuration=config))


def checkpoint_hash(db, course_id, classroom_id, revision_number, tables):
    # Mirror the fingerprints on each side of the schema change. Only valid
    # checkpoints get a new fingerprint, so obsolete saves cannot be revived.
    from app.world_config import load_world_config

    data = {"world": load_world_config(), "revision": revision_number}
    for name in ("chapters", "materials", "activities", "questions", "quest_definitions", "story_definitions", "npcs"):
        table = tables[name]
        query = sa.select(table).where(table.c.course_instance_id == course_id)
        if "deleted_at" in table.c:
            query = query.where(table.c.deleted_at.is_(None))
        rows = [dict(row) for row in db.execute(query).mappings()]
        if name == "questions":
            for row in rows:
                if row.get("interactive") is None:
                    row.pop("interactive", None)
        data[name] = sorted(rows, key=lambda row: str(row.get("id", row.get("key"))))
    releases = tables["chapter_releases"]
    data["releases"] = [dict(row) for row in db.execute(sa.select(releases).where(
        releases.c.classroom_id == classroom_id).order_by(releases.c.chapter_id)).mappings()]
    activities = tables["activities"]
    for name, keys in (("activity_questions", ("activity_id", "question_id", "order_index")),
                       ("activity_materials", ("activity_id", "material_id", "order_index", "required", "learning"))):
        table = tables[name]
        data[name] = [tuple(row) for row in db.execute(sa.select(*(table.c[k] for k in keys))
                      .join(activities, activities.c.id == table.c.activity_id).where(
                          activities.c.course_instance_id == course_id, activities.c.deleted_at.is_(None))
                      .order_by(table.c.activity_id, table.c.order_index))]
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()


def checkpoint_tables(db):
    metadata = sa.MetaData()
    metadata.reflect(db, only=("chapters", "materials", "activities", "questions", "quest_definitions",
                     "story_definitions", "npcs", "chapter_releases", "activity_questions", "activity_materials"))
    return metadata.tables


def convert(db):
    saved = db.execute(sa.text("""SELECT DISTINCT c.id, c.classroom_id, c.revision
        FROM course_instances c JOIN experience_checkpoints p ON p.classroom_id=c.classroom_id""")).all()
    old_tables = checkpoint_tables(db) if saved else {}
    fingerprints = {(cid, room, rev): checkpoint_hash(db, cid, room, rev, old_tables) for cid, room, rev in saved}
    for table, column in (("course_instances", "teacher_id"), ("classrooms", "course_id"),
                          ("course_import_previews", "course_id"), ("chapters", "prerequisite_chapter_id")):
        op.add_column(table, sa.Column(column, sa.Integer()))
    rooms = db.execute(sa.text("SELECT id, name, teacher_id FROM classrooms ORDER BY id")).mappings().all()
    for room in rooms:
        params = dict(room)
        course_id = db.scalar(sa.text("SELECT id FROM course_instances WHERE classroom_id=:id"), params)
        if course_id is None:
            params["package"] = "course-" + uuid4().hex
            course_id = db.scalar(sa.text("""
                INSERT INTO course_instances (classroom_id, teacher_id, package_id, name, package_version, revision, created_at)
                VALUES (:id, :teacher_id, :package, :name, '1', 1, CURRENT_TIMESTAMP) RETURNING id"""), params)
        params["course_id"] = course_id
        db.execute(sa.text("UPDATE classrooms SET course_id=:course_id WHERE id=:id"), params)
        db.execute(sa.text("UPDATE course_instances SET teacher_id=:teacher_id WHERE id=:course_id"), params)
    db.execute(sa.text("""UPDATE course_import_previews SET course_id=(
        SELECT c.course_id FROM classrooms c WHERE c.id=course_import_previews.classroom_id)"""))
    invalid = db.scalar(sa.text("""SELECT count(*) FROM chapter_releases r JOIN classrooms c ON c.id=r.classroom_id
        JOIN chapters h ON h.id=r.chapter_id LEFT JOIN chapters p ON p.id=r.prerequisite_chapter_id
        WHERE h.course_instance_id IS NOT NULL AND (h.course_instance_id<>c.course_id OR
        (p.id IS NOT NULL AND p.course_instance_id<>c.course_id))"""))
    if invalid:
        raise RuntimeError("章节开放记录引用了其他课程，请检查原数据库")
    db.execute(sa.text("""UPDATE chapters SET prerequisite_chapter_id=(SELECT r.prerequisite_chapter_id
        FROM chapter_releases r JOIN classrooms c ON c.id=r.classroom_id
        WHERE r.chapter_id=chapters.id AND c.course_id=chapters.course_instance_id)"""))
    for table in ("chapters", "knowledge_points", "activities", "materials", "questions", "quest_definitions"):
        db.execute(sa.text(f"""UPDATE {table} SET owner_id=(
            SELECT c.teacher_id FROM course_instances c WHERE c.id={table}.course_instance_id)
            WHERE course_instance_id IS NOT NULL AND owner_id IS NULL"""))
    migrate_template_fingerprints(db)
    with op.batch_alter_table("chapters") as b:
        b.create_foreign_key("fk_chapter_prerequisite", "chapters", ["prerequisite_chapter_id"], ["id"], ondelete="SET NULL")
    with op.batch_alter_table("chapter_releases") as b:
        b.drop_column("prerequisite_chapter_id")
    with op.batch_alter_table("content_deletion_previews") as b:
        b.drop_index("ix_content_deletion_previews_classroom_id")
        b.drop_column("classroom_id")
    with op.batch_alter_table("course_import_previews") as b:
        b.drop_constraint("uq_course_import_request", type_="unique")
        b.drop_index("ix_course_import_previews_classroom_id")
        b.drop_column("classroom_id")
        b.alter_column("course_id", existing_type=sa.Integer(), nullable=False)
        b.create_foreign_key("fk_import_course", "course_instances", ["course_id"], ["id"])
        b.create_unique_constraint("uq_course_import_request", ["course_id", "applied_request_id"])
        b.create_index("ix_course_import_previews_course_id", ["course_id"])
    with op.batch_alter_table("course_instances") as b:
        b.drop_column("classroom_id")
        b.alter_column("teacher_id", existing_type=sa.Integer(), nullable=False)
        b.create_foreign_key("fk_course_teacher", "users", ["teacher_id"], ["id"])
        b.create_index("ix_course_instances_teacher_id", ["teacher_id"])
    with op.batch_alter_table("classrooms") as b:
        for index in sa.inspect(db).get_indexes("classrooms"):
            if index["column_names"] == ["teacher_id"]:
                b.drop_index(index["name"])
        b.drop_column("teacher_id")
        b.alter_column("course_id", existing_type=sa.Integer(), nullable=False)
        b.create_foreign_key("fk_classroom_course", "course_instances", ["course_id"], ["id"])
        b.create_index("ix_classrooms_course_id", ["course_id"])

    if fingerprints:
        new_tables = checkpoint_tables(db)
        for (cid, room, rev), old_hash in fingerprints.items():
            new_hash = checkpoint_hash(db, cid, room, rev, new_tables)
            db.execute(sa.text("""UPDATE experience_checkpoints SET definition_hash=:new_hash
                WHERE classroom_id=:room AND definition_hash=:old_hash"""),
                {"room": room, "old_hash": old_hash, "new_hash": new_hash})


def upgrade():
    db = op.get_bind()
    if db.dialect.name != "sqlite":
        convert(db)
        return
    # SQLite batch DDL rebuilds referenced tables. Keep the rewrite atomic and
    # check every reference before making it visible to a subsequent startup.
    with op.get_context().autocommit_block():
        db.exec_driver_sql("PRAGMA foreign_keys=OFF")
        db.exec_driver_sql("BEGIN IMMEDIATE")
        try:
            convert(db)
            if db.exec_driver_sql("PRAGMA foreign_key_check").first():
                raise RuntimeError("课程迁移后的外键校验失败")
            db.exec_driver_sql("COMMIT")
        except BaseException:
            db.exec_driver_sql("ROLLBACK")
            raise
        finally:
            db.exec_driver_sql("PRAGMA foreign_keys=ON")


def downgrade():
    raise RuntimeError("旧格式无法表示共享课程，请从升级前的数据库备份恢复。")
