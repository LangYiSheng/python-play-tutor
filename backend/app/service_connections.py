"""Read persisted authoring and speech connections for runtime and administration."""
from typing import Literal

from cryptography.fernet import InvalidToken
from fastapi import HTTPException
from sqlalchemy.orm import Session

from .assistant_settings import cipher
from .integration_models import AssistantModelSettings

Service = Literal["authoring", "speech"]
IDS = {"authoring": 2, "speech": 3}


def environment(service: Service):
    from .narration.defaults import authoring_environment, speech_environment
    return authoring_environment() if service == "authoring" else speech_environment()


def configuration(service: Service, db: Session | None = None, *, include_key=True):
    row = db.get(AssistantModelSettings, IDS[service]) if db is not None else None
    if row is None:
        value = dict(environment(service))
        if not include_key:
            value["api_key"] = ""
        return value
    try:
        key = cipher().decrypt(row.encrypted_key.encode()).decode() if include_key and row.encrypted_key else ""
    except InvalidToken:
        raise HTTPException(503, "服务密钥无法解密，请恢复对应主密钥文件") from None
    return {**row.configuration, "api_key": key}
