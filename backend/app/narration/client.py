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
    """A safe teacher-facing error; hints control bounded retries."""

    def __init__(self, message: str, *, hint: str | None = None) -> None:
        super().__init__(message)
        self.hint = hint


# 供应商把多种问题都报成 400；只识别长度这一类，其余不自动重试。
LENGTH_HINTS = ("context length", "maximum context", "input is too long", "too long",
                "reduce the length", "length limit", "maximum number of tokens")


def _length_error(response: httpx.Response) -> bool:
    """Only classify the provider's text. It may echo secrets or course content."""
    try:
        payload = response.json()
    except ValueError:
        return False
    error = payload.get("error") if isinstance(payload, dict) else None
    message = error.get("message") if isinstance(error, dict) else payload.get("message") if isinstance(payload, dict) else None
    text = str(message or "").strip()[:200]
    lowered = text.lower()
    return any(token in lowered for token in LENGTH_HINTS)


def transport_reason(exc: httpx.HTTPError) -> str:
    for kind, label in ((httpx.ConnectTimeout, "建立连接超时"), (httpx.ReadTimeout, "等待响应超时"),
                        (httpx.WriteTimeout, "发送请求超时"), (httpx.PoolTimeout, "等待可用连接超时"),
                        (httpx.TimeoutException, "请求超时"), (httpx.ProxyError, "代理连接失败"),
                        (httpx.ConnectError, "无法建立网络连接"), (httpx.RemoteProtocolError, "远端响应协议异常"),
                        (httpx.ReadError, "读取响应时连接中断"), (httpx.WriteError, "发送请求时连接中断")):
        if isinstance(exc, kind):
            return label
    return "网络传输失败"


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
        raise ModelFailed(f"作者期模型{transport_reason(exc)}",
                          hint="timeout" if isinstance(exc, httpx.TimeoutException) else None) from exc
    if response.status_code in {401, 403}:
        raise ModelUnavailable(f"作者期模型鉴权失败（HTTP {response.status_code}）")
    if response.status_code != 200:
        length = _length_error(response)
        reason = ("输入超过上下文限制" if length else "请求受到限流" if response.status_code == 429 else
                  "服务端错误" if response.status_code >= 500 else "请求未成功")
        raise ModelFailed(f"作者期模型{reason}（HTTP {response.status_code}）", hint="length" if length else None)
    try:
        data = response.json()
    except ValueError as exc:
        raise ModelFailed("作者期模型响应无法解析为 JSON（HTTP 200）") from exc
    choices = data.get("choices") if isinstance(data, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise ModelFailed("作者期模型响应缺少有效的结果（HTTP 200）")
    choice = choices[0]
    answer = choice.get("message") or {}
    content = answer.get("content") if isinstance(answer, dict) else None
    if choice.get("finish_reason") == "length":
        # 输入太长与输出被截断要分开：前者靠缩窗重试，后者只能加大输出预算。
        raise ModelFailed("模型输出被截断，请重试或调高上限", hint="output")
    if not isinstance(content, str) or not content.strip():
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
