"""Shared platform character art and image validation."""
from functools import lru_cache
import json
from pathlib import Path

from .config import ROOT

@lru_cache
def builtin_assets():
    return json.loads((ROOT / "shared/world/characters.json").read_text(encoding="utf-8"))


def asset_descriptor(reference, kind):
    builtin = next((item for item in builtin_assets() if item["id"] == reference and item["kind"] == kind), None)
    if builtin:
        return dict(builtin)
    raise ValueError("角色素材不存在或类型不匹配")


def presentation(db, classroom_id, npc):
    return npc.presentation() if npc else None


def world_character(db, classroom_id, npc):
    result = presentation(db, classroom_id, npc)
    result.update(stable_id=npc.stable_id, **npc.placement)
    return result


def validate_image(path: Path, kind, frame_width=16, frame_height=20):
    from PIL import Image, UnidentifiedImageError
    import warnings
    if kind not in {"portrait", "sprite"} or path.stat().st_size > 10 * 1024 * 1024:
        raise ValueError("角色图片类型无效或超过10MB")
    formats = ["PNG"] if kind == "sprite" else ["PNG", "JPEG", "WEBP"]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path, formats=formats) as picture:
                width, height = picture.size
                if width > 4096 or height > 4096 or width * height > 16_000_000 or getattr(picture, "n_frames", 1) != 1:
                    raise ValueError("角色图片须为静态图片，边长最多4096像素")
                media_type = Image.MIME[picture.format]
                picture.verify()
            with Image.open(path, formats=formats) as picture:
                picture.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError("图片无法完整解码或尺寸过大") from exc
    result = {"character_kind": kind, "width": width, "height": height, "media_type": media_type}
    if kind == "sprite":
        if any(type(value) is not int or not 8 <= value <= 256 for value in (frame_width, frame_height)):
            raise ValueError("像素角色帧宽高须为8至256像素")
        if (width, height) != (frame_width * 3, frame_height * 4):
            raise ValueError("像素角色须为三列四行，按下、左、右、上排列")
        result.update(frame_width=frame_width, frame_height=frame_height)
    return result
