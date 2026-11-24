"""Upgrade removes the old stored key once, without touching other course data."""
from sqlalchemy.orm import Session

from app.course_exchange_models import CoursePackageState
from sqlalchemy import text
from test_curriculum_migration import migrate, sqlite_engine


def test_persisted_default_is_renamed_once(tmp_path):
    path = tmp_path / "settings.sqlite"
    url = "sqlite:///" + path.as_posix()
    migrate(url, "upgrade", "ea30c9b172f4")
    engine = sqlite_engine(path)
    with Session(engine) as db:
        db.execute(text("INSERT INTO users(id,student_id,name,role,password_hash) VALUES(1,'871955','教师','teacher','unused')"))
        db.execute(text("INSERT INTO classrooms(id,name,teacher_id,join_code) VALUES(1,'保留班级',:teacher,'settings-migration')"), {"teacher": 1})
        db.execute(text("INSERT INTO course_instances(id,classroom_id,name,package_id,package_version,revision,created_at) VALUES(1,1,'课程','test','2',1,CURRENT_TIMESTAMP)"))
        instance_id = 1
        db.add(CoursePackageState(course_instance_id=instance_id, configuration={
            "assistant": {"library_npc_id": "guide", "enabled": False, "limits": {"model_calls": 1}}, "_assets": []}))
        db.commit()
    engine.dispose()
    migrate(url, "upgrade", "head")
    migrate(url, "upgrade", "head")
    with Session(sqlite_engine(path)) as db:
        config = db.get(CoursePackageState, instance_id).configuration
        assert config == {"assistant": {"default_npc_id": "guide", "enabled": False, "limits": {"model_calls": 1}}, "_assets": []}
