"""Course assistant limits and shared character identity."""
import os
from fastapi import HTTPException

from .assistant_settings import CAPS, configuration


def policy(db, classroom_id):
    return {"enabled": configuration(db, include_key=False)["enabled"]}


def default_npc(db, classroom_id):
    from .platform_roles import role
    return role(db, "librarian")


def activity_npc(db, classroom_id, activity):
    from .platform_roles import role
    if activity.kind == "assessment":
        return role(db, "mayor")
    if activity.kind == "practice":
        return role(db, "coach" if activity.content.get("practice_kind") == "programming" else "professor")
    return default_npc(db, classroom_id)


def ensure_enabled(db, classroom_id):
    if not policy(db, classroom_id)["enabled"]:
        raise HTTPException(403, "平台暂未开放答疑")


def runtime_policy(db, classroom_id, activity=None, npc=None):
    global_config = configuration(db, include_key=False)
    limits = {key: min(global_config[key], cap) for key, cap in CAPS.items()}
    if os.getenv("REBORN_AI_REQUEST_TOKEN_RESERVATION"):
        limits["request_tokens"] = min(limits["request_tokens"], int(os.environ["REBORN_AI_REQUEST_TOKEN_RESERVATION"]))
    if os.getenv("REBORN_AI_TIMEOUT_SECONDS"):
        limits["timeout_seconds"] = min(limits["timeout_seconds"], int(os.environ["REBORN_AI_TIMEOUT_SECONDS"]))
    return {}, limits


def decorate_context(db, classroom_id, activity, npc, context):
    from .characters import presentation
    role = presentation(db, classroom_id, npc)
    if role is None:
        raise HTTPException(409, "请先配置此学习场景的助教角色")
    context["role"] = {**role, "persona": npc.persona, "tone": "温和、清晰，以分层提示引导学生自己思考"}
    _, context["limits"] = runtime_policy(db, classroom_id)
    return context
