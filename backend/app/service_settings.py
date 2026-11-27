"""Admin-owned authoring and speech connections; encrypted, independently versioned.

The existing configuration store reserves id 1 for the student assistant, 2 for
authoring and 3 for speech. Environment values initialize an unsaved service only.
"""
import time
from typing import Annotated, Literal, cast
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from .assistant_settings import cipher
from .auth import require_admin
from .db import get_db
from .integration_models import AssistantModelSettings
from .models import User
from .narration import tts, tts_catalog
from .narration.contracts import SpeechSettings

from .service_connections import IDS, Service, configuration, environment

router = APIRouter(prefix="/teacher/services", tags=["service-settings"])


class ConnectionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=0)
    base_url: str = Field(max_length=500)
    api_key: str | None = Field(default=None, max_length=4096)
    clear_key: bool = False
    timeout: int = Field(default=120, ge=10, le=600)

    @model_validator(mode="after")
    def valid_connection(self):
        self.base_url = self.base_url.strip()
        if self.api_key is not None:
            self.api_key = self.api_key.strip()
        url = urlparse(self.base_url)
        if self.base_url and (url.scheme not in {"http", "https"} or not url.hostname
                              or url.username or url.password or url.query or url.fragment):
            raise ValueError("请输入不含凭据和查询参数的 HTTP(S) API 地址")
        if self.clear_key and self.api_key:
            raise ValueError("不能同时清除和替换密钥")
        self.base_url = self.base_url.rstrip("/")
        return self


class AuthoringInput(ConnectionInput):
    model: str = Field(min_length=1, max_length=200)
    vision_model: str = Field(min_length=1, max_length=200)
    effort: Literal["none", "minimal", "low", "medium", "high"] = "none"
    max_tokens: int = Field(default=8000, ge=128, le=65536)
    daily_pages: int = Field(default=300, ge=1, le=10000)

    @model_validator(mode="after")
    def strip_models(self):
        self.model = self.model.strip()
        self.vision_model = self.vision_model.strip()
        if not self.model or not self.vision_model:
            raise ValueError("模型名称不能为空")
        return self


class SpeechInput(ConnectionInput):
    protocol: Literal["openai", "deepseek", "dashscope"] = "openai"
    model: str = Field(max_length=200)
    voice: str = Field(min_length=1, max_length=200)
    format: Literal["mp3", "wav", "pcm", "opus", "flac", "aac"] = "mp3"
    speed: float = Field(default=1, ge=0.25, le=4)
    instruction: str = Field(default="", max_length=200)

    @model_validator(mode="after")
    def valid_speech(self):
        self.model = self.model.strip()
        self.voice = self.voice.strip()
        self.instruction = self.instruction.strip()
        if not self.voice:
            raise ValueError("请填写音色名称或 ID")
        if self.protocol == "deepseek" and (self.format not in {"wav", "pcm"} or self.speed != 1):
            raise ValueError("DeepSeek 语音使用 wav/pcm，合成语速固定为 1")
        if self.protocol == "openai" and not self.model:
            raise ValueError("请填写语音模型")
        if self.protocol == "dashscope":
            if "compatible-mode" in self.base_url:
                raise ValueError("阿里原生语音接口请填业务空间域名，不要带 /compatible-mode/v1")
            if not self.model:
                raise ValueError("请填写阿里语音模型")
            if self.format not in {"mp3", "wav", "pcm", "opus"}:
                raise ValueError("阿里语音使用 mp3/wav/pcm/opus")
            if not 0.5 <= self.speed <= 2:
                raise ValueError("阿里语音语速只支持 0.5–2")
        return self


@router.get("/{service}")
def read_service(service: Service, db: Annotated[Session, Depends(get_db)],
                 user: Annotated[User, Depends(require_admin)]):
    row = db.get(AssistantModelSettings, IDS[service])
    value = configuration(service, db, include_key=False)
    value.pop("api_key", None)
    configured = bool(row.encrypted_key) if row else bool(environment(service)["api_key"])
    return {**value, "revision": row.revision if row else 0, "key_configured": configured,
            "source": "database" if row else "environment"}


def save(service, body, db, user):
    db.scalar(select(User).where(User.role == "admin").order_by(User.id).limit(1).with_for_update())
    row = db.get(AssistantModelSettings, IDS[service], with_for_update=True)
    if body.expected_revision != (row.revision if row else 0):
        raise HTTPException(409, "服务设置已修改，请重新加载；未保存草稿已保留")
    key = "" if body.clear_key else (body.api_key or configuration(service, db)["api_key"])
    if row is None:
        row = AssistantModelSettings(id=IDS[service], revision=0)
        db.add(row)
    row.configuration = body.model_dump(exclude={"expected_revision", "api_key", "clear_key"})
    row.encrypted_key = cipher(create=True).encrypt(key.encode()).decode() if key else ""
    row.revision += 1
    db.commit()
    return read_service(service, db, user)


@router.put("/authoring")
def save_authoring(body: AuthoringInput, db: Annotated[Session, Depends(get_db)],
                   user: Annotated[User, Depends(require_admin)]):
    return save("authoring", body, db, user)


@router.put("/speech")
def save_speech(body: SpeechInput, db: Annotated[Session, Depends(get_db)],
                user: Annotated[User, Depends(require_admin)]):
    return save("speech", body, db, user)


@router.get("/speech/catalog")
def speech_catalog(db: Annotated[Session, Depends(get_db)],
                   user: Annotated[User, Depends(require_admin)]):
    value = cast(SpeechSettings, configuration("speech", db))
    models, source = tts_catalog.catalog_models(value)
    return {"models": models, "voices": tts_catalog.VOICE_CATALOG,
            "model_source": source, "voice_source": "builtin"}


@router.post("/speech/test")
def test_speech(db: Annotated[Session, Depends(get_db)],
                user: Annotated[User, Depends(require_admin)]):
    value = cast(SpeechSettings, configuration("speech", db))
    if not value["base_url"]:
        raise HTTPException(409, "请先保存语音合成配置")
    if not value["api_key"]:
        raise HTTPException(503, "请先保存语音接口密钥")
    db.rollback()
    started = time.monotonic()
    try:
        audio = tts.synthesize("你好，这是一次语音合成测试。", settings_override=value)
    except tts.SpeechUnavailable as exc:
        raise HTTPException(409, str(exc)) from exc
    except tts.SpeechFailed as exc:
        raise HTTPException(502, str(exc)) from exc
    return {"ok": True, "elapsed_ms": round((time.monotonic() - started) * 1000),
            "bytes": len(audio), "format": value["format"], "model": value["model"], "voice": value["voice"]}
