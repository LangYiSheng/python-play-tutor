"""Chapter catalogues, material authoring and foreground reading participation."""
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import current_user, require_teacher
from app.chapter_tasks.rules import reading_task, validate_rule
from app.chapter_tasks.service import chapter_materials, chapter_state, open_chapters
from app.course_content.access import authorize_chapter, authorize_classroom
from app.db import get_db
from app.learning_rules import record_video, video_duration
from app.models import Chapter, Material, MaterialChapter, MaterialParticipation, User, now
from app.teacher_scope import commit_content, own_course, require_scope

router = APIRouter(tags=["chapter tasks"])
Db = Annotated[Session, Depends(get_db)]
Viewer = Annotated[User, Depends(current_user)]
Teacher = Annotated[User, Depends(require_teacher)]
AUTHOR_PATH = "/teacher/courses/{course_id}/chapters/{chapter_id}/material-tasks"


@router.get("/chapter-tasks")
def tasks(classroom_id: int, db: Db, user: Viewer):
    room = authorize_classroom(db, user, classroom_id)
    return {"chapters": [chapter_state(db, user, room, chapter) for chapter in open_chapters(db, room)]}


def material_item(row, material):
    return {"material_id": material.id, "title": material.title, "kind": material.kind,
            "required": row.required, "rule": row.rule, "order_index": row.order_index}


@router.get(AUTHOR_PATH)
def material_tasks(course_id: int, chapter_id: int, db: Db, user: Teacher):
    course = own_course(db, user, course_id)
    chapter = require_scope(db.get(Chapter, chapter_id), course_id)
    if chapter.owner_id not in (None, course.teacher_id):
        raise HTTPException(403, "只能查看本课程教师的章节")
    return {"items": [material_item(link, material) for link, material in db.execute(chapter_materials(chapter, course.teacher_id))]}


class MaterialRequirement(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    required: bool
    rule: dict = Field(default_factory=dict)
    order_index: int | None = Field(default=None, ge=0, le=100000)


@router.put(AUTHOR_PATH + "/{material_id}")
def save_material_task(course_id: int, chapter_id: int, material_id: int, body: MaterialRequirement, db: Db, user: Teacher):
    course = own_course(db, user, course_id, exclusive=True)
    chapter = require_scope(db.get(Chapter, chapter_id), course_id)
    material = require_scope(db.get(Material, material_id), course_id)
    if any(item.owner_id not in (None, course.teacher_id) for item in (chapter, material)):
        raise HTTPException(403, "只能设置本课程教师的章节和资料")
    try:
        validate_rule(body.rule, material, body.required)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    row = db.get(MaterialChapter, (material_id, chapter_id))
    if row is None:
        row = MaterialChapter(material_id=material_id, chapter_id=chapter_id)
        db.add(row)
    row.required, row.rule = body.required, body.rule
    if body.order_index is not None:
        row.order_index = body.order_index
    commit_content(db, course_id)
    return material_item(row, material)


class Heartbeat(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)
    session_id: str = Field(min_length=1, max_length=100)
    sequence: int = Field(ge=1)
    visible: bool
    page_id: int | None = None
    position: float | None = Field(default=None, ge=0)
    playing: bool = False
    playback_rate: float = Field(default=1, gt=0, le=4)


def update_evidence(state, body, material):
    timestamp = now()
    signature = body.model_dump(exclude={"sequence", "session_id"})
    same = state.get("session_id") == body.session_id
    elapsed = (timestamp - datetime.fromisoformat(state["received_at"])).total_seconds() if state.get("received_at") else 0
    if same and body.sequence == state["sequence"] and state.get("signature") == signature:
        return state
    if body.sequence != (state["sequence"] + 1 if same else 1):
        raise ValueError("参与记录序号不连续")
    if not same and state.get("visible") and elapsed < 15:
        raise ValueError("此资料已有阅读窗口，请稍后继续")
    result = dict(state)
    if material.kind == "video":
        if body.position is None or video_duration(material) is None:
            raise ValueError("视频缺少播放位置或有效时长")
        result["video"], _ = record_video(state.get("video", {}), body.session_id, body.sequence, body.position,
                                          body.playing and body.visible, video_duration(material), body.playback_rate)
    else:
        valid = {p["id"] for p in material.content.get("pages", [])}
        if body.page_id not in valid:
            raise ValueError("此页不属于当前资料")
        if same and state.get("visible") and 0 < elapsed <= 20:
            result["seconds"] = round(state.get("seconds", 0) + elapsed, 3)
            if elapsed >= 1 and state.get("page_id") in valid:
                result["pages"] = sorted(set(state.get("pages", [])) | {state["page_id"]})
    result.update(session_id=body.session_id, sequence=body.sequence, signature=signature, visible=body.visible,
                  page_id=body.page_id, received_at=timestamp.isoformat())
    return result


@router.post("/chapters/{chapter_id}/materials/{material_id}/participation")
def participate(chapter_id: int, material_id: int, classroom_id: int, body: Heartbeat, db: Db, user: Viewer):
    if user.role != "student":
        raise HTTPException(403, "教师预览不可写入阅读进度")
    room = authorize_chapter(db, user, classroom_id, chapter_id)
    db.execute(select(User.id).where(User.id == user.id).with_for_update())
    chapter = db.get(Chapter, chapter_id)
    pair = db.execute(chapter_materials(chapter, room.teacher_id).where(Material.id == material_id)).first()
    if not pair:
        raise HTTPException(404, "资料不属于此章")
    link, material = pair
    if material.status != "ready":
        raise HTTPException(409, "资料尚不可读")
    row = db.get(MaterialParticipation, (user.id, classroom_id, chapter_id, material_id))
    if row is None:
        row = MaterialParticipation(user_id=user.id, classroom_id=classroom_id, chapter_id=chapter_id,
                                    material_id=material_id, evidence={})
        db.add(row)
    try:
        updated = update_evidence(row.evidence, body, material)
        if updated is row.evidence:
            return reading_task(link, material, updated)
        row.evidence = updated
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if body.visible:
        # A learner can accrue foreground time in only one chapter/material at a time.
        others = db.scalars(select(MaterialParticipation).where(
            MaterialParticipation.user_id == user.id, MaterialParticipation.classroom_id == classroom_id,
            (MaterialParticipation.chapter_id != chapter_id) | (MaterialParticipation.material_id != material_id),
            MaterialParticipation.evidence["visible"].as_boolean().is_(True)))
        for other in others:
            inactive = {**other.evidence, "visible": False}
            if "video" in inactive:
                inactive["video"] = {**inactive["video"], "playing": False}
            other.evidence = inactive
    db.commit()
    return reading_task(link, material, row.evidence)
