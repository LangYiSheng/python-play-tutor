"""Story runtime HTTP routes and authenticated dependencies."""

from typing import Annotated

from fastapi import APIRouter, Depends, Header, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import current_user
from app.db import get_db
from app.models import CourseInstance, User
from app.teaching.story.commands import advance as _advance
from app.teaching.story.commands import current as _current
from app.teaching.story.commands import end_session as _end_session
from app.teaching.story.commands import interact as _interact
from app.teaching.story.commands import return_activity as _return_activity
from app.teaching.story.contracts import AdvanceInput, InteractionInput, ReturnInput
from app.teaching.story.dialogue import DIALOGUE_FIELD, render_dialogue

router = APIRouter(tags=["story"])
Database = Annotated[Session, Depends(get_db)]
Actor = Annotated[User, Depends(current_user)]
DialogueFormat = Annotated[str | None, Header(alias="X-Dialogue-Format")]


def _present(view, dialogue_format, db, user, classroom_id):
    if view is None or "chapter_id" not in view or dialogue_format == "template":
        return view
    # Older game clients expect ready-to-display text. Reuse this snapshot's
    # authorized chapter titles and read only the course name when requested.
    chapter_id = view.pop("chapter_id")
    node = view["node"]
    choices = node.get("choices", [])
    lines = [node["text"], *(choice["label"] for choice in choices)]
    fields = {match[1] for line in lines for match in DIALOGUE_FIELD.finditer(line)}
    if not fields:
        return view
    course_name = None
    if "course_name" in fields:
        course_name = db.scalar(select(CourseInstance.name).where(CourseInstance.classroom_id == classroom_id))
    chapter_name = next((row["title"] for row in view["world"]["chapters"] if row["id"] == chapter_id), None)
    values = {"name": user.name, "course_name": course_name, "chapter_name": chapter_name}
    node["text"] = render_dialogue(node["text"], **values)
    for choice in choices:
        choice["label"] = render_dialogue(choice["label"], **values)
    return view


@router.post("/story/interactions")
def interact(body: InteractionInput, db: Database, user: Actor, dialogue_format: DialogueFormat = None):
    view = _interact(body=body, db=db, user=user)
    return _present(view, dialogue_format, db, user, body.classroom_id)


@router.get("/story/current")
def current(classroom_id: int, response: Response, db: Database, user: Actor, dialogue_format: DialogueFormat = None):
    response.headers["Cache-Control"] = "private, no-store"
    view = _current(classroom_id=classroom_id, db=db, user=user)
    return _present(view, dialogue_format, db, user, classroom_id)


@router.post("/story/sessions/{session_id}/end")
def end_session(session_id: str, body: ReturnInput, db: Database, user: Actor):
    return _end_session(session_id=session_id, body=body, db=db, user=user)


@router.post("/story/sessions/{session_id}/advance")
def advance(session_id: str, body: AdvanceInput, db: Database, user: Actor, dialogue_format: DialogueFormat = None):
    view = _advance(session_id=session_id, body=body, db=db, user=user)
    return _present(view, dialogue_format, db, user, body.classroom_id)


@router.post("/story/sessions/{session_id}/return")
def return_activity(session_id: str, body: ReturnInput, db: Database, user: Actor, dialogue_format: DialogueFormat = None):
    view = _return_activity(session_id=session_id, body=body, db=db, user=user)
    return _present(view, dialogue_format, db, user, body.classroom_id)
