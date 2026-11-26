"""Platform-owned teaching roles. The four duties and placements are fixed."""
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import ForeignKey, Integer, JSON, LargeBinary, String, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from .auth import current_user, require_admin
from .characters import asset_descriptor, builtin_assets, validate_image
from .db import Base, get_db
from .models import User

router = APIRouter(tags=["platform-roles"])
DEFAULT_ROLES = {
    "librarian": ("图书管理员", "library", "librarian_doc", 6, "照看馆内资料，耐心地陪学生阅读。"),
    "professor": ("教授", "workshop", "professor", 24, "通过提问和例子，引导学生理解本章概念。"),
    "coach": ("练习场教练", "arena", "arena_guard", 4, "陪学生动手尝试，鼓励他们利用题目反馈继续练习。"),
    "mayor": ("镇长", "mayor_hall", "mayor_py", 2, "接待学生，主持测验，陪学生回顾所学。"),
}


class PlatformRole(Base):
    __tablename__ = "platform_roles"
    key: Mapped[str] = mapped_column(String(16), primary_key=True)
    configuration: Mapped[dict] = mapped_column(JSON)
    revision: Mapped[int] = mapped_column(Integer)


class PlatformRoleImage(Base):
    __tablename__ = "platform_role_images"
    role_key: Mapped[str] = mapped_column(ForeignKey("platform_roles.key", ondelete="CASCADE"), primary_key=True)
    kind: Mapped[str] = mapped_column(String(12), primary_key=True)
    media_type: Mapped[str] = mapped_column(String(30))
    data: Mapped[bytes] = mapped_column(LargeBinary)


@dataclass(frozen=True)
class Role:
    key: str
    name: str
    persona: str
    portrait: dict
    sprite: dict
    placement: dict
    revision: int

    @property
    def stable_id(self):
        return self.key

    def presentation(self):
        return {"key": self.key, "name": self.name, "portrait": self.portrait["url"], "sprite": self.sprite}


def role(db, key):
    if key not in DEFAULT_ROLES:
        raise HTTPException(404, "教学角色不存在")
    name, room, portrait, sprite, persona = DEFAULT_ROLES[key]
    row = db.get(PlatformRole, key)
    config = row.configuration if row else {}
    return Role(key, config.get("name", name), config.get("persona", persona),
                config.get("portrait") or asset_descriptor(f"builtin:portrait:{portrait}", "portrait"),
                config.get("sprite") or asset_descriptor(f"builtin:sprite:chara_{sprite}", "sprite"),
                {"map_key": room, "tile_x": 9, "tile_y": 5, "direction": "down"}, row.revision if row else 0)


def roles(db):
    return [role(db, key) for key in DEFAULT_ROLES]


DB = Annotated[Session, Depends(get_db)]
Admin = Annotated[User, Depends(require_admin)]


@router.get("/admin/teaching-roles")
def read_roles(db: DB, user: Admin):
    return {"roles": roles(db), "assets": builtin_assets()}


class RoleInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    expected_revision: int = Field(ge=0)
    name: str = Field(min_length=1, max_length=80)
    persona: str = Field(max_length=4000)
    portrait: str
    sprite: str
    frame_width: int = Field(default=16, ge=8, le=256)
    frame_height: int = Field(default=20, ge=8, le=256)


def read_image(upload, kind, draft):
    data = upload.file.read(10 * 1024 * 1024 + 1)
    if len(data) > 10 * 1024 * 1024:
        raise ValueError("角色图片不能超过 10 MB")
    with TemporaryDirectory() as directory:
        path = Path(directory) / kind
        path.write_bytes(data)
        info = validate_image(path, kind, draft.frame_width, draft.frame_height)
    return data, info


@router.post("/admin/teaching-roles/{key}")
def update_role(key: str, metadata: Annotated[str, Form()], db: DB, user: Admin,
                portrait: Annotated[UploadFile | None, File()] = None,
                sprite: Annotated[UploadFile | None, File()] = None):
    db.scalar(select(User.id).where(User.role == "admin").order_by(User.id).limit(1).with_for_update())
    current = role(db, key)
    try:
        draft = RoleInput.model_validate_json(metadata)
        if draft.expected_revision != current.revision:
            raise HTTPException(409, "角色已修改，请重新载入后再保存")
        revision = current.revision + 1
        config = {"name": draft.name, "persona": draft.persona}
        images = {}
        for kind, upload in (("portrait", portrait), ("sprite", sprite)):
            ref = getattr(draft, kind)
            if upload:
                data, info = read_image(upload, kind, draft)
                images[kind] = (data, info["media_type"])
                config[kind] = {"kind": kind, "id": "custom", "name": "自定义图片",
                                "url": f"/api/teaching-roles/{key}/image/{kind}?v={revision}",
                                **{field: info[field] for field in ("frame_width", "frame_height") if field in info}}
            elif ref == "custom" and getattr(current, kind)["id"] == ref:
                config[kind] = getattr(current, kind)
            else:
                config[kind] = asset_descriptor(ref, kind)
    except (ValidationError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc
    db.merge(PlatformRole(key=key, configuration=config, revision=revision))
    db.flush()
    for kind in ("portrait", "sprite"):
        if kind in images:
            data, media_type = images[kind]
            db.merge(PlatformRoleImage(role_key=key, kind=kind, media_type=media_type, data=data))
        elif config[kind]["id"] != "custom":
            old_image = db.get(PlatformRoleImage, (key, kind))
            if old_image:
                db.delete(old_image)
    db.commit()
    return role(db, key)


@router.get("/teaching-roles/{key}/image/{kind}")
def image(key: str, kind: str, db: DB, user: Annotated[User, Depends(current_user)]):
    row = db.get(PlatformRoleImage, (key, kind))
    if not row:
        raise HTTPException(404, "图片不存在")
    return Response(row.data, media_type=row.media_type, headers={"Cache-Control": "private, no-cache"})
