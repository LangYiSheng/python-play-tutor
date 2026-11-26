"""OpenAI-compatible chat call used only for course authoring.

Validation is deliberately strict: a thinking-mode budget can burn `max_tokens`
entirely on reasoning and still return an empty message, and a JSON-mode reply can be
replaced with spaces. Neither may be stored as narration.
"""

import json
import re
import time
from typing import Any

import httpx

from .contracts import AuthoringSettings, ChatReply

MAX_TRANSIENT_RETRIES = 2
MAX_TIMEOUT_RETRIES = 1
MAX_CONTENT_RETRIES = 2
MAX_TOKEN_CEILING = 32000
CONTENT_RETRY_DELAYS = (0.3, 0.8)
TRANSIENT_RETRY_DELAYS = (0.5, 1.2)
NO_RETRY_TRANSPORT = (httpx.LocalProtocolError, httpx.UnsupportedProtocol, httpx.InvalidURL)
_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL | re.IGNORECASE)


def _sleep(seconds: float) -> None:
    if seconds > 0:
        time.sleep(seconds)


def _retry_after(response: httpx.Response, default: float) -> float:
    raw = (response.headers.get("retry-after") or "").strip()
    if raw:
        try:
            return min(5.0, max(0.2, float(raw)))
        except ValueError:
            pass
    return default


def _parse_json_object(content: str) -> dict[str, Any] | None:
    text = content.strip()
    match = _FENCE_RE.match(text)
    if match:
        text = match.group(1).strip()
    parsed = json.loads(text)
    return parsed if isinstance(parsed, dict) else None


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
                        (httpx.LocalProtocolError, "请求头或密钥包含非法字符（请检查空格或换行）"),
                        (httpx.UnsupportedProtocol, "API 地址协议无效（请检查是否缺少 https:// 或包含空格）"),
                        (httpx.InvalidURL, "API 地址格式无效（请检查是否包含空格或非法字符）"),
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
    current_effort = effort or settings["effort"]
    current_max_tokens = max_tokens or settings["max_tokens"]
    transient_attempts = 0
    timeout_attempts = 0
    content_attempts = 0
    while True:
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": current_max_tokens,
            "response_format": {"type": "json_object"},
            "reasoning_effort": current_effort,
        }
        try:
            with httpx.Client(base_url=settings["base_url"], timeout=settings["timeout"]) as client:
                response = client.post("/chat/completions",
                                       headers={"Authorization": f"Bearer {settings['api_key']}"}, json=body)
        except httpx.HTTPError as exc:
            is_timeout = isinstance(exc, httpx.TimeoutException)
            if not isinstance(exc, NO_RETRY_TRANSPORT):
                if is_timeout and timeout_attempts < MAX_TIMEOUT_RETRIES:
                    _sleep(TRANSIENT_RETRY_DELAYS[0])
                    timeout_attempts += 1
                    continue
                if not is_timeout and transient_attempts < MAX_TRANSIENT_RETRIES:
                    _sleep(TRANSIENT_RETRY_DELAYS[transient_attempts])
                    transient_attempts += 1
                    continue
            raise ModelFailed(f"作者期模型{transport_reason(exc)}",
                              hint="timeout" if is_timeout else None) from exc
        if response.status_code in {401, 403}:
            raise ModelUnavailable(f"作者期模型鉴权失败（HTTP {response.status_code}）")
        if response.status_code != 200:
            length = _length_error(response)
            if (not length and (response.status_code == 429 or response.status_code >= 500)
                    and transient_attempts < MAX_TRANSIENT_RETRIES):
                _sleep(_retry_after(response, TRANSIENT_RETRY_DELAYS[transient_attempts]))
                transient_attempts += 1
                continue
            reason = ("输入超过上下文限制" if length else "请求受到限流" if response.status_code == 429 else
                      "服务端错误" if response.status_code >= 500 else "请求未成功")
            raise ModelFailed(f"作者期模型{reason}（HTTP {response.status_code}）", hint="length" if length else None)
        try:
            data = response.json()
        except ValueError as exc:
            if content_attempts < MAX_CONTENT_RETRIES:
                _sleep(CONTENT_RETRY_DELAYS[content_attempts])
                content_attempts += 1
                continue
            raise ModelFailed("作者期模型响应无法解析为 JSON（HTTP 200）") from exc
        choices = data.get("choices") if isinstance(data, dict) else None
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            if content_attempts < MAX_CONTENT_RETRIES:
                _sleep(CONTENT_RETRY_DELAYS[content_attempts])
                content_attempts += 1
                continue
            raise ModelFailed("作者期模型响应缺少有效的结果（HTTP 200）")
        choice = choices[0]
        answer = choice.get("message") or {}
        content = answer.get("content") if isinstance(answer, dict) else None
        if choice.get("finish_reason") == "length":
            # 输入太长与输出被截断要分开：前者靠缩窗重试，后者只能加大输出预算。
            raise ModelFailed("模型输出被截断，请重试或调高上限", hint="output")
        if not isinstance(content, str) or not content.strip():
            if content_attempts < MAX_CONTENT_RETRIES:
                _sleep(CONTENT_RETRY_DELAYS[content_attempts])
                content_attempts += 1
                # 推理模型在低档位下可能将预算耗在思考或吐出空正文；重试时关闭思考并提升预算。
                if current_effort != "none":
                    current_effort = "none"
                current_max_tokens = min(max(1, current_max_tokens) * 2, MAX_TOKEN_CEILING)
                continue
            raise ModelFailed("模型返回空内容，请重试", hint="empty")
        try:
            parsed = _parse_json_object(content)
        except ValueError as exc:
            if content_attempts < MAX_CONTENT_RETRIES:
                _sleep(CONTENT_RETRY_DELAYS[content_attempts])
                content_attempts += 1
                continue
            raise ModelFailed("模型返回的不是有效 JSON，请重试") from exc
        if parsed is None:
            if content_attempts < MAX_CONTENT_RETRIES:
                _sleep(CONTENT_RETRY_DELAYS[content_attempts])
                content_attempts += 1
                continue
            raise ModelFailed("模型返回的 JSON 结构不可用，请重试")
        if require_text and not str(parsed.get("text") or "").strip():
            if content_attempts < MAX_CONTENT_RETRIES:
                _sleep(CONTENT_RETRY_DELAYS[content_attempts])
                content_attempts += 1
                continue
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
