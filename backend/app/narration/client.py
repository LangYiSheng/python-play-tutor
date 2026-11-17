"""OpenAI-compatible chat call used only for course authoring.

Validation is deliberately strict: a thinking-mode budget can burn `max_tokens`
entirely on reasoning and still return an empty message, and a JSON-mode reply can be
replaced with spaces. Neither may be stored as narration.
"""

import json
from typing import Any

import httpx

from .contracts import AuthoringSettings, ChatReply


class ModelUnavailable(RuntimeError):
    """No credentials configured; the feature is unavailable rather than degraded."""


class ModelFailed(RuntimeError):
    """The provider answered but the result cannot be used.

    `hint` 标记可重试的错误类别（目前只有“输入过长”）；`detail` 保留供应商原文，否则老师只看到
    “返回 400”，无法判断是长度、鉴权还是模型名写错。
    """

    def __init__(self, message: str, *, hint: str | None = None, detail: str = "") -> None:
        super().__init__(message)
        self.hint = hint
        self.detail = detail


# 供应商把多种问题都报成 400；只识别长度这一类，其余不自动重试。
LENGTH_HINTS = ("context length", "maximum context", "input is too long", "too long",
                "reduce the length", "length limit", "maximum number of tokens")


def _provider_error(response: httpx.Response) -> tuple[str, str | None]:
    """Return (bounded provider message, hint). Never echo request content or keys."""
    try:
        payload = response.json()
    except ValueError:
        return "", None
    error = payload.get("error") if isinstance(payload, dict) else None
    message = error.get("message") if isinstance(error, dict) else payload.get("message") if isinstance(payload, dict) else None
    text = str(message or "").strip()[:200]
    lowered = text.lower()
    return text, "length" if any(token in lowered for token in LENGTH_HINTS) else None


def _usage(data: dict[str, Any]) -> dict[str, Any]:
    """Normalise provider cache accounting so hit rate can be measured, not guessed."""
    raw = data.get("usage") or {}
    details = raw.get("prompt_tokens_details") or {}
    hit = raw.get("prompt_cache_hit_tokens", details.get("cached_tokens")) or 0
    miss = raw.get("prompt_cache_miss_tokens")
    try:
        hit_value = max(0, int(hit))
        prompt = max(0, int(raw.get("prompt_tokens") or 0))
        miss_value = max(0, int(miss)) if miss is not None else max(0, prompt - hit_value)
    except (TypeError, ValueError):
        return dict(raw)
    return {**raw, "cache_hit_tokens": hit_value, "cache_miss_tokens": miss_value}


def chat(messages: list[dict[str, Any]], *, settings: AuthoringSettings, model: str,
         max_tokens: int | None = None, effort: str | None = None,
         require_text: bool = True) -> ChatReply:
    if not settings["api_key"]:
        raise ModelUnavailable("未配置作者期模型凭据")
    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens or settings["max_tokens"],
        "response_format": {"type": "json_object"},
        "reasoning_effort": effort or settings["effort"],
    }
    try:
        with httpx.Client(base_url=settings["base_url"], timeout=settings["timeout"]) as client:
            response = client.post("/chat/completions",
                                   headers={"Authorization": f"Bearer {settings['api_key']}"}, json=body)
    except httpx.HTTPError as exc:
        raise ModelFailed("作者期模型请求失败，请稍后重试") from exc
    if response.status_code in {401, 403}:
        raise ModelUnavailable("作者期模型鉴权失败")
    if response.status_code != 200:
        message, hint = _provider_error(response)
        raise ModelFailed(f"作者期模型返回 {response.status_code}" + (f"：{message}" if message else ""),
                          hint=hint, detail=message)
    data = response.json()
    choice = (data.get("choices") or [{}])[0]
    answer = choice.get("message") or {}
    content = answer.get("content") or ""
    if choice.get("finish_reason") == "length":
        raise ModelFailed("模型输出被截断，请重试或调高上限")
    if not content.strip():
        raise ModelFailed("模型返回空内容，请重试")
    try:
        parsed = json.loads(content)
    except ValueError as exc:
        raise ModelFailed("模型返回的不是有效 JSON，请重试") from exc
    if not isinstance(parsed, dict):
        raise ModelFailed("模型返回的 JSON 结构不可用，请重试")
    if require_text and not str(parsed.get("text") or "").strip():
        raise ModelFailed("模型返回的讲解为空，请重试")
    anchors = [str(item)[:200] for item in (parsed.get("anchors") or []) if str(item).strip()][:6]
    return ChatReply(
        raw=parsed,
        text=str(parsed.get("text") or "").strip(),
        bridge_in=str(parsed.get("bridge_in") or "")[:300],
        anchors=anchors,
        usage=_usage(data),
        model=str(data.get("model") or model),
    )
