"""Teacher-owned voice cloning (enrollment), binding, preview and per-material resolution."""

from __future__ import annotations

import base64
import re
import tempfile
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.materials.storage import get_storage, storage_root

from ..auth import as_utc
from ..models import Material, User, now
from . import audio, tts
from .client import transport_reason
from .contracts import SpeechSettings
from .models import MATERIAL_VOICE_MODES, MaterialNarrationSetting, TeacherVoice

MAX_SAMPLE_BYTES = 10 * 1024 * 1024
MIN_SAMPLE_BYTES = 2048
MAX_PREVIEW_CHARS = 120
MAX_VOICES_PER_TEACHER = 20
DEFAULT_PREVIEW_TEXT = "大家好，今天我们一起来学习 Python 中的列表和字典，结合实例一步一步掌握它们的用法。"

SPEECH_INSTRUCTION_PRESETS: list[dict[str, str]] = [
    {
        "id": "natural",
        "label": "自然授课",
        "text": "请用自然连贯的普通话大学课堂授课语气朗读，语速平稳清晰，句中不要多余停顿。",
    },
    {
        "id": "fluent",
        "label": "流畅明快",
        "text": "请用亲切明快、流畅连贯的普通话讲课语气朗读，节奏紧凑自然，重点清晰。",
    },
    {
        "id": "calm",
        "label": "温和沉稳",
        "text": "请用温和沉稳、吐字清晰的普通话教学语气朗读，娓娓道来，连贯自然。",
    },
]

ALLOWED_SAMPLE_MIME: dict[str, str] = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
}


def speech_capabilities(db: Session) -> dict[str, Any]:
    """Describe what voice features are available under the current global speech settings."""
    config = tts.settings(db)
    base_url = (config["base_url"] or "").strip()
    protocol = (config["protocol"] or "openai").strip()
    api_key = (config["api_key"] or "").strip()
    configured = bool(base_url)
    clone_supported = configured and protocol == "dashscope" and bool(api_key)
    if not configured:
        hint = "管理员尚未配置全站语音合成服务，配置后即可使用声音复刻与试听。"
    elif protocol == "dashscope" and not api_key:
        hint = "管理员尚未保存阿里百炼 API Key，暂不可发起声音复刻。"
    elif protocol == "dashscope":
        hint = "支持上传或录制 10–20 秒清晰干声，直接通过阿里百炼复刻你的专属音色。"
    else:
        hint = "当前语音协议暂不支持在线一键复刻，你可以直接绑定已在平台创建的自定义音色 ID。"
    return {
        "speech_configured": configured,
        "protocol": protocol,
        "default_model": config["model"],
        "default_voice": config["voice"],
        "default_speed": config["speed"],
        "default_instruction": str(config.get("instruction") or ""),
        "instruction_supported": protocol == "dashscope" and tts.supports_dashscope_instruction(config["model"]),
        "instruction_presets": SPEECH_INSTRUCTION_PRESETS,
        "clone_supported": clone_supported,
        "clone_hint": hint,
    }


def serialize_voice(voice: TeacherVoice, *, material_count: int = 0) -> dict[str, Any]:
    return {
        "id": voice.id,
        "name": voice.name,
        "provider": voice.provider,
        "target_model": voice.target_model,
        "provider_voice_id": voice.provider_voice_id,
        "status": voice.status,
        "error": voice.error,
        "has_sample": bool(voice.sample_key),
        "sample_seconds": voice.sample_seconds,
        "is_default": voice.is_default,
        "material_count": material_count,
        "created_at": as_utc(voice.created_at).isoformat() if voice.created_at else None,
        "updated_at": as_utc(voice.updated_at).isoformat() if voice.updated_at else None,
    }


def list_voices(db: Session, user_id: int) -> list[dict[str, Any]]:
    rows = list(
        db.scalars(
            select(TeacherVoice)
            .where(TeacherVoice.owner_id == user_id)
            .order_by(TeacherVoice.is_default.desc(), TeacherVoice.id.desc())
        )
    )
    if not rows:
        return []
    counts = dict(
        db.execute(
            select(MaterialNarrationSetting.teacher_voice_id, func.count(MaterialNarrationSetting.material_id))
            .where(
                MaterialNarrationSetting.voice_mode == "custom",
                MaterialNarrationSetting.teacher_voice_id.in_([v.id for v in rows]),
            )
            .group_by(MaterialNarrationSetting.teacher_voice_id)
        ).all()
    )
    return [serialize_voice(v, material_count=int(counts.get(v.id, 0))) for v in rows]


def _get_owned_voice(db: Session, user_id: int, voice_id: int) -> TeacherVoice:
    voice = db.scalar(
        select(TeacherVoice).where(TeacherVoice.id == voice_id, TeacherVoice.owner_id == user_id)
    )
    if voice is None:
        raise LookupError("未找到该音色或无权操作")
    return voice


def _voice_compatible(voice: TeacherVoice, base: SpeechSettings) -> bool:
    if voice.status != "ready" or not voice.provider_voice_id:
        return False
    if voice.provider == "manual":
        return True
    return voice.provider == base["protocol"]


def _apply_voice_override(
    base: SpeechSettings,
    voice: TeacherVoice | None,
    *,
    instruction: str | None = None,
    speed: float | None = None,
) -> SpeechSettings:
    resolved_model = (
        voice.target_model
        if (voice is not None and voice.target_model and base["protocol"] != "deepseek")
        else base["model"]
    )
    resolved_voice = voice.provider_voice_id if voice is not None else base["voice"]
    resolved_speed = base["speed"]
    if speed is not None and base["protocol"] != "deepseek":
        resolved_speed = max(0.5, min(2.0, float(speed))) if base["protocol"] == "dashscope" else max(0.25, min(4.0, float(speed)))
    resolved_instruction = str(base.get("instruction") or "") if instruction is None else instruction.strip()[:200]
    overridden: SpeechSettings = {
        "protocol": base["protocol"],
        "base_url": base["base_url"],
        "api_key": base["api_key"],
        "model": resolved_model,
        "voice": resolved_voice,
        "format": base["format"],
        "speed": resolved_speed,
        "timeout": base["timeout"],
        "instruction": resolved_instruction,
    }
    return overridden


def resolve_material_speech(
    db: Session,
    material: Material,
    *,
    user_id: int | None = None,
    explicit_voice_id: int | None = None,
    explicit_mode: str | None = None,
) -> tuple[SpeechSettings, dict[str, Any]]:
    """Resolve effective TTS settings for a material: material setting -> teacher default -> site default."""
    base = tts.settings(db)
    setting = db.get(MaterialNarrationSetting, material.id)
    mode = explicit_mode if explicit_mode in MATERIAL_VOICE_MODES else (setting.voice_mode if setting else "auto")
    selected: TeacherVoice | None = None

    if mode == "custom":
        target_id = explicit_voice_id if explicit_voice_id is not None else (setting.teacher_voice_id if setting else None)
        if target_id is not None:
            cand = db.get(TeacherVoice, target_id)
            if cand is not None and _voice_compatible(cand, base):
                selected = cand
    elif mode == "auto":
        owner_candidates: list[int] = []
        if user_id is not None:
            owner_candidates.append(user_id)
        if material.owner_id is not None and material.owner_id not in owner_candidates:
            owner_candidates.append(material.owner_id)
        for owner_id in owner_candidates:
            cand = db.scalar(
                select(TeacherVoice)
                .where(
                    TeacherVoice.owner_id == owner_id,
                    TeacherVoice.is_default.is_(True),
                    TeacherVoice.status == "ready",
                )
                .order_by(TeacherVoice.id.desc())
                .limit(1)
            )
            if cand is not None and _voice_compatible(cand, base):
                selected = cand
                break

    mat_instruction = setting.speech_instruction if setting is not None else None
    mat_speed = setting.speech_speed if setting is not None else None
    effective = _apply_voice_override(base, selected, instruction=mat_instruction, speed=mat_speed)
    instruction_supported = (
        effective["protocol"] == "dashscope" and tts.supports_dashscope_instruction(effective["model"])
    )
    return effective, {
        "voice_name": selected.name if selected is not None else base["voice"],
        "voice_source": "custom" if selected is not None else "system",
        "voice_mode": mode,
        "selected_voice_id": selected.id if selected is not None else None,
        "system_voice": base["voice"],
        "system_model": base["model"],
        "speech_instruction": mat_instruction,
        "effective_instruction": str(effective.get("instruction") or ""),
        "speech_speed": mat_speed,
        "effective_speed": effective["speed"],
        "instruction_supported": instruction_supported,
        "instruction_presets": SPEECH_INSTRUCTION_PRESETS,
    }


def set_material_voice(
    db: Session,
    material: Material,
    user: User,
    *,
    mode: str,
    teacher_voice_id: int | None = None,
    update_instruction: bool = False,
    speech_instruction: str | None = None,
    update_speed: bool = False,
    speech_speed: float | None = None,
) -> MaterialNarrationSetting:
    if mode not in MATERIAL_VOICE_MODES:
        raise ValueError("不支持的音色模式")
    resolved_id: int | None = None
    if mode == "custom":
        if teacher_voice_id is None:
            raise ValueError("请选择一个自定义音色")
        voice = _get_owned_voice(db, user.id, teacher_voice_id)
        if voice.status != "ready":
            raise ValueError("该音色尚未就绪，请等待复刻完成后再选用")
        base = tts.settings(db)
        if not _voice_compatible(voice, base):
            raise ValueError("该音色与当前全站语音协议不兼容")
        resolved_id = voice.id

    cleaned_instruction = speech_instruction.strip()[:200] if speech_instruction is not None else None
    cleaned_speed = round(float(speech_speed), 2) if speech_speed is not None else None
    if cleaned_speed is not None and not 0.5 <= cleaned_speed <= 2.0:
        raise ValueError("语速需在 0.5 到 2.0 之间")

    row = db.get(MaterialNarrationSetting, material.id)
    if row is None:
        row = MaterialNarrationSetting(
            material_id=material.id,
            voice_mode=mode,
            teacher_voice_id=resolved_id,
            speech_instruction=cleaned_instruction if update_instruction else None,
            speech_speed=cleaned_speed if update_speed else None,
        )
        db.add(row)
    else:
        row.voice_mode = mode
        row.teacher_voice_id = resolved_id
        if update_instruction:
            row.speech_instruction = cleaned_instruction
        if update_speed:
            row.speech_speed = cleaned_speed
        row.updated_at = now()
    db.flush()
    return row


def _make_prefix(user_id: int) -> str:
    # DashScope prefix allows only alphanumeric chars and at most 10 chars.
    raw = f"t{user_id}v{uuid4().hex[:5]}"
    cleaned = re.sub(r"[^a-zA-Z0-9]", "", raw)
    return cleaned[:10] or "tvoice"


def _dashscope_customization_url(base_url: str) -> str:
    return tts.endpoint(base_url, "/api/v1/services/audio/tts/customization")


def _extract_dashscope_error(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return f"声音复刻服务返回 HTTP {response.status_code}"
    msg = str(payload.get("message") or payload.get("error") or "").strip()
    code = str(payload.get("code") or "").strip()
    if response.status_code == 403 and "api-key restrictions" in msg.lower():
        return (
            "当前阿里百炼 API Key 开启了模型访问限制（AccessDenied），"
            "请在百炼控制台放行声音复刻模型权限（或更换未受限的 API Key）"
        )
    if response.status_code in {401, 403}:
        detail = f"{code}：{msg}" if (code and msg) else (msg or code)
        return f"声音复刻服务鉴权失败（HTTP {response.status_code}，{detail}）" if detail else f"声音复刻服务鉴权失败（HTTP {response.status_code}）"
    if msg:
        return f"声音复刻失败（{code}）：{msg}" if code else f"声音复刻失败：{msg}"
    return f"声音复刻服务返回 HTTP {response.status_code}"


def _uses_qwen_vc_enrollment(model_name: str) -> bool:
    """Only qwen3-tts-vc / qwen-omni families use `qwen-voice-enrollment`.

    Per Bailian `voice-clone-design-http-api.md`, both `qwen-audio-3.*-tts-*` and
    `cosyvoice-*` use `model="voice-enrollment"` with `action="create_voice"`.
    """
    low = model_name.strip().lower()
    return low.startswith(("qwen3-tts-vc", "qwen3-omni", "qwen-omni"))


def _call_dashscope_create_voice(
    config: SpeechSettings,
    *,
    target_model: str,
    prefix: str,
    mime: str,
    audio_bytes: bytes,
) -> tuple[str, str]:
    """Enroll a cloned voice on DashScope. Returns (provider_voice_id, status)."""
    url = _dashscope_customization_url(config["base_url"])
    data_uri = f"data:{mime};base64,{base64.b64encode(audio_bytes).decode('ascii')}"
    use_qwen_vc = _uses_qwen_vc_enrollment(target_model)
    if use_qwen_vc:
        body: dict[str, Any] = {
            "model": "qwen-voice-enrollment",
            "input": {
                "action": "create",
                "target_model": target_model,
                "preferred_name": prefix,
                "audio": {"data": data_uri},
            },
        }
    else:
        body = {
            "model": "voice-enrollment",
            "input": {
                "action": "create_voice",
                "target_model": target_model,
                "prefix": prefix,
                "audio": data_uri,
                "language_hints": ["zh"],
            },
        }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config['api_key'].strip()}",
    }
    try:
        with httpx.Client(timeout=max(60, config["timeout"])) as client:
            response = client.post(url, headers=headers, json=body)
    except httpx.HTTPError as exc:
        raise tts.SpeechFailed(f"声音复刻{transport_reason(exc)}") from exc

    if response.status_code != 200:
        raise tts.SpeechFailed(_extract_dashscope_error(response))
    try:
        payload = response.json()
    except ValueError as exc:
        raise tts.SpeechFailed("声音复刻返回的不是有效 JSON") from exc

    if payload.get("code") and not payload.get("output"):
        raise tts.SpeechFailed(_extract_dashscope_error(response))
    output = payload.get("output") or {}
    voice_id = str(output.get("voice_id") or output.get("voice") or "").strip()
    if not voice_id:
        raise tts.SpeechFailed("声音复刻未返回有效音色 ID，请检查音频清晰度与模型配置")
    raw_status = str(output.get("status") or "").upper()
    if raw_status in {"DEPLOYING", "PROCESSING", "PENDING"}:
        status = "processing"
    elif raw_status in {"UNDEPLOYED", "FAILED", "ERROR"}:
        status = "failed"
    elif raw_status in {"OK", "READY", "SUCCESS"}:
        status = "ready"
    elif not use_qwen_vc:
        # Official `voice-enrollment` create_voice omits `status`; check once via query_voice.
        try:
            status, _ = _call_dashscope_query_voice(config, target_model=target_model, voice_id=voice_id)
        except tts.SpeechFailed:
            status = "processing"
    else:
        status = "ready"
    return voice_id, status


def _call_dashscope_query_voice(config: SpeechSettings, *, target_model: str, voice_id: str) -> tuple[str, str]:
    """Poll DashScope enrollment status. Returns (status, error_message)."""
    url = _dashscope_customization_url(config["base_url"])
    if _uses_qwen_vc_enrollment(target_model):
        body: dict[str, Any] = {
            "model": "qwen-voice-enrollment",
            "input": {"action": "query", "voice": voice_id},
        }
    else:
        body = {
            "model": "voice-enrollment",
            "input": {"action": "query_voice", "voice_id": voice_id},
        }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config['api_key'].strip()}",
    }
    try:
        with httpx.Client(timeout=30) as client:
            response = client.post(url, headers=headers, json=body)
    except httpx.HTTPError as exc:
        raise tts.SpeechFailed(f"查询复刻进度{transport_reason(exc)}") from exc
    if response.status_code != 200:
        raise tts.SpeechFailed(_extract_dashscope_error(response))
    try:
        payload = response.json()
    except ValueError as exc:
        raise tts.SpeechFailed("查询复刻进度返回的不是有效 JSON") from exc
    output = payload.get("output") or {}
    raw_status = str(output.get("status") or "").upper()
    if raw_status in {"OK", "READY", "SUCCESS"}:
        return "ready", ""
    if raw_status in {"DEPLOYING", "PROCESSING", "PENDING"}:
        return "processing", ""
    if raw_status in {"UNDEPLOYED", "FAILED", "ERROR"}:
        reason = str(output.get("message") or output.get("reason") or "云端复刻未通过，请重新录制清晰干声").strip()
        return "failed", reason
    return "ready", ""


def _call_dashscope_delete_voice(config: SpeechSettings, *, target_model: str, voice_id: str) -> None:
    if not config["base_url"] or not config["api_key"] or not voice_id:
        return
    url = _dashscope_customization_url(config["base_url"])
    if _uses_qwen_vc_enrollment(target_model):
        body: dict[str, Any] = {
            "model": "qwen-voice-enrollment",
            "input": {"action": "delete", "voice": voice_id},
        }
    else:
        body = {
            "model": "voice-enrollment",
            "input": {"action": "delete_voice", "voice_id": voice_id},
        }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config['api_key'].strip()}",
    }
    try:
        with httpx.Client(timeout=15) as client:
            client.post(url, headers=headers, json=body)
    except httpx.HTTPError:
        pass


def _clear_teacher_default(db: Session, user_id: int, *, exclude_id: int | None = None) -> None:
    stmt = update(TeacherVoice).where(TeacherVoice.owner_id == user_id, TeacherVoice.is_default.is_(True))
    if exclude_id is not None:
        stmt = stmt.where(TeacherVoice.id != exclude_id)
    db.execute(stmt.values(is_default=False))


def _check_teacher_voice_quota(db: Session, user_id: int) -> None:
    total = db.scalar(select(func.count(TeacherVoice.id)).where(TeacherVoice.owner_id == user_id)) or 0
    if total >= MAX_VOICES_PER_TEACHER:
        raise ValueError(f"每位教师最多保留 {MAX_VOICES_PER_TEACHER} 个音色，请先删除不再使用的旧音色")


def _clean_voice_name(name: str) -> str:
    cleaned = name.strip()
    if not cleaned:
        raise ValueError("请填写声音名称")
    if len(cleaned) > 80:
        raise ValueError("声音名称不能超过 80 个字符")
    return cleaned


def enroll_voice(
    db: Session,
    user: User,
    *,
    name: str,
    filename: str,
    raw_bytes: bytes,
    target_model: str | None = None,
    is_default: bool = True,
    sample_seconds: int | None = None,
) -> TeacherVoice:
    cleaned_name = _clean_voice_name(name)
    _check_teacher_voice_quota(db, user.id)
    ext = Path(filename or "").suffix.lower()
    mime = ALLOWED_SAMPLE_MIME.get(ext)
    if mime is None:
        raise ValueError("仅支持 .wav / .mp3 / .m4a / .ogg / .flac / .webm 音频文件")
    if len(raw_bytes) < MIN_SAMPLE_BYTES:
        raise ValueError("音频文件过小或为空，请录制至少 10 秒清晰人声")
    if len(raw_bytes) > MAX_SAMPLE_BYTES:
        raise ValueError("音频文件不能超过 10 MB")

    config = tts.settings(db)
    if not config["base_url"]:
        raise tts.SpeechUnavailable("管理员尚未配置语音合成服务")
    if config["protocol"] != "dashscope":
        raise ValueError("当前语音接口协议不支持在线声音复刻，请改用「绑定已有音色 ID」")
    if not config["api_key"]:
        raise tts.SpeechUnavailable("管理员尚未配置阿里百炼 API Key")

    model_name = (target_model or config["model"] or "qwen-audio-3.1-tts-flash").strip()[:120]
    if not model_name:
        raise ValueError("未指定目标语音模型，请先在全站语音设置中配置模型")

    prefix = _make_prefix(user.id)
    remote_voice_id, status = _call_dashscope_create_voice(
        config,
        target_model=model_name,
        prefix=prefix,
        mime=mime,
        audio_bytes=raw_bytes,
    )

    sample_key = f"voice-samples/{user.id}/{uuid4().hex}{ext}"
    storage = get_storage()
    with tempfile.TemporaryDirectory(prefix="voice-sample-", dir=storage_root()) as tmp_name:
        local = Path(tmp_name) / f"sample{ext}"
        local.write_bytes(raw_bytes)
        storage.put(sample_key, local)

    want_default = bool(is_default and status == "ready")
    if want_default:
        _clear_teacher_default(db, user.id)

    voice = TeacherVoice(
        owner_id=user.id,
        name=cleaned_name,
        provider="dashscope",
        target_model=model_name,
        provider_voice_id=remote_voice_id,
        status=status,
        error="",
        sample_key=sample_key,
        sample_seconds=sample_seconds if (sample_seconds and sample_seconds > 0) else None,
        is_default=want_default,
    )
    db.add(voice)
    db.flush()
    return voice


def bind_voice(
    db: Session,
    user: User,
    *,
    name: str,
    provider_voice_id: str,
    target_model: str = "",
    is_default: bool = True,
) -> TeacherVoice:
    cleaned_name = _clean_voice_name(name)
    cleaned_id = provider_voice_id.strip()
    if not cleaned_id:
        raise ValueError("请填写平台生成的音色 ID")
    if len(cleaned_id) > 200:
        raise ValueError("音色 ID 过长")
    _check_teacher_voice_quota(db, user.id)

    config = tts.settings(db)
    provider = config["protocol"] if config["base_url"] else "manual"
    cleaned_model = target_model.strip()[:120]
    if not cleaned_model and provider == "dashscope":
        cleaned_model = config["model"]

    if is_default:
        _clear_teacher_default(db, user.id)

    voice = TeacherVoice(
        owner_id=user.id,
        name=cleaned_name,
        provider=provider,
        target_model=cleaned_model,
        provider_voice_id=cleaned_id,
        status="ready",
        error="",
        sample_key=None,
        sample_seconds=None,
        is_default=is_default,
    )
    db.add(voice)
    db.flush()
    return voice


def refresh_voice(db: Session, user: User, voice_id: int) -> TeacherVoice:
    voice = _get_owned_voice(db, user.id, voice_id)
    if voice.status != "processing" or voice.provider != "dashscope" or not voice.provider_voice_id:
        return voice
    config = tts.settings(db)
    if not config["base_url"] or not config["api_key"]:
        return voice
    next_status, err_msg = _call_dashscope_query_voice(
        config,
        target_model=voice.target_model or config["model"],
        voice_id=voice.provider_voice_id,
    )
    voice.status = next_status
    voice.error = err_msg
    voice.updated_at = now()
    db.flush()
    return voice


def update_voice(
    db: Session,
    user: User,
    voice_id: int,
    *,
    name: str | None = None,
    is_default: bool | None = None,
) -> TeacherVoice:
    voice = _get_owned_voice(db, user.id, voice_id)
    if name is not None:
        voice.name = _clean_voice_name(name)
    if is_default is not None:
        if is_default:
            if voice.status != "ready":
                raise ValueError("音色尚未就绪，不能设为默认")
            _clear_teacher_default(db, user.id, exclude_id=voice.id)
            voice.is_default = True
        else:
            voice.is_default = False
    voice.updated_at = now()
    db.flush()
    return voice


def delete_voice(db: Session, user: User, voice_id: int) -> None:
    voice = _get_owned_voice(db, user.id, voice_id)
    sample_key = voice.sample_key
    remote_provider = voice.provider
    remote_model = voice.target_model
    remote_voice_id = voice.provider_voice_id
    should_remote_delete = remote_provider == "dashscope" and bool(sample_key) and bool(remote_voice_id)

    db.execute(
        update(MaterialNarrationSetting)
        .where(MaterialNarrationSetting.teacher_voice_id == voice.id)
        .values(voice_mode="auto", teacher_voice_id=None, updated_at=now())
    )
    db.delete(voice)
    db.flush()

    if sample_key:
        try:
            get_storage().delete(sample_key)
        except Exception:  # noqa: BLE001
            pass
    if should_remote_delete:
        _call_dashscope_delete_voice(tts.settings(db), target_model=remote_model, voice_id=remote_voice_id)


def preview_voice(
    db: Session,
    user: User,
    voice_id: int,
    *,
    text: str | None = None,
    instruction: str | None = None,
    speed: float | None = None,
) -> tuple[bytes, str]:
    voice = _get_owned_voice(db, user.id, voice_id)
    if voice.status != "ready":
        raise ValueError("该音色尚未就绪，暂不能试听")
    reason = tts.unavailable_reason(db)
    if reason:
        raise tts.SpeechUnavailable(reason)
    base = tts.settings(db)
    if not _voice_compatible(voice, base):
        raise ValueError("该音色与当前全站语音协议不兼容")
    sample_text = (text or "").strip() or DEFAULT_PREVIEW_TEXT
    if len(sample_text) > MAX_PREVIEW_CHARS:
        raise ValueError(f"试听文本不能超过 {MAX_PREVIEW_CHARS} 字")
    engine = _apply_voice_override(base, voice, instruction=instruction, speed=speed)
    payload, stored_format, _ = audio.synthesize_audio_bytes(sample_text, engine)
    return payload, audio.media_type(f"preview.{stored_format}")
