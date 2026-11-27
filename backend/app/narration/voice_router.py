"""Teacher-facing API for personal cloned/custom TTS voices."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from ..auth import require_teacher
from ..db import get_db
from ..models import User
from . import tts, voices

router = APIRouter(prefix="/teacher/voices", tags=["narration-voices"])


class BindVoiceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    provider_voice_id: str = Field(min_length=1, max_length=200)
    target_model: str = Field(default="", max_length=120)
    is_default: bool = True


class UpdateVoiceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=80)
    is_default: bool | None = None


class PreviewVoiceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str | None = Field(default=None, max_length=120)
    instruction: str | None = Field(default=None, max_length=200)
    speed: float | None = Field(default=None, ge=0.5, le=2.0)


@router.get("")
def list_my_voices(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_teacher)],
) -> dict[str, Any]:
    return {
        "capabilities": voices.speech_capabilities(db),
        "voices": voices.list_voices(db, user.id),
    }


@router.post("/enroll", status_code=201)
async def enroll_my_voice(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_teacher)],
    name: Annotated[str, Form()],
    file: Annotated[UploadFile, File()],
    target_model: Annotated[str | None, Form()] = None,
    is_default: Annotated[bool, Form()] = True,
    sample_seconds: Annotated[int | None, Form()] = None,
    consent: Annotated[bool, Form()] = False,
) -> dict[str, Any]:
    if not consent:
        raise HTTPException(422, "请先确认音频为本人真实声音或已获本人授权")
    chunks: list[bytes] = []
    size = 0
    while chunk := await file.read(65536):
        size += len(chunk)
        if size > voices.MAX_SAMPLE_BYTES:
            raise HTTPException(413, "音频文件不能超过 10 MB")
        chunks.append(chunk)
    raw_bytes = b"".join(chunks)
    try:
        voice = voices.enroll_voice(
            db,
            user,
            name=name,
            filename=file.filename or "sample.wav",
            raw_bytes=raw_bytes,
            target_model=target_model,
            is_default=is_default,
            sample_seconds=sample_seconds,
        )
    except tts.SpeechUnavailable as exc:
        raise HTTPException(409, str(exc)) from exc
    except tts.SpeechFailed as exc:
        raise HTTPException(502, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    db.commit()
    return voices.serialize_voice(voice)


@router.post("/bind", status_code=201)
def bind_my_voice(
    body: BindVoiceInput,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_teacher)],
) -> dict[str, Any]:
    try:
        voice = voices.bind_voice(
            db,
            user,
            name=body.name,
            provider_voice_id=body.provider_voice_id,
            target_model=body.target_model,
            is_default=body.is_default,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    db.commit()
    return voices.serialize_voice(voice)


@router.post("/{voice_id}/refresh")
def refresh_my_voice(
    voice_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_teacher)],
) -> dict[str, Any]:
    try:
        voice = voices.refresh_voice(db, user, voice_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except tts.SpeechFailed as exc:
        raise HTTPException(502, str(exc)) from exc
    db.commit()
    return voices.serialize_voice(voice)


@router.patch("/{voice_id}")
def patch_my_voice(
    voice_id: int,
    body: UpdateVoiceInput,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_teacher)],
) -> dict[str, Any]:
    try:
        voice = voices.update_voice(db, user, voice_id, name=body.name, is_default=body.is_default)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    db.commit()
    return voices.serialize_voice(voice)


@router.delete("/{voice_id}", status_code=204)
def remove_my_voice(
    voice_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_teacher)],
) -> Response:
    try:
        voices.delete_voice(db, user, voice_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    db.commit()
    return Response(status_code=204)


@router.post("/{voice_id}/preview")
def preview_my_voice(
    voice_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_teacher)],
    body: PreviewVoiceInput | None = None,
) -> Response:
    try:
        payload, mime = voices.preview_voice(
            db,
            user,
            voice_id,
            text=body.text if body else None,
            instruction=body.instruction if body else None,
            speed=body.speed if body else None,
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except tts.SpeechUnavailable as exc:
        raise HTTPException(409, str(exc)) from exc
    except tts.SpeechFailed as exc:
        raise HTTPException(502, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return Response(content=payload, media_type=mime, headers={"Cache-Control": "private, no-store"})
