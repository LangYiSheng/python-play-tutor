"""OpenAI-compatible synchronous LLM client for authoring background tasks."""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping
from typing import Any

import httpx

from .text_utils import extract_json_payload

_MAX_TRANSIENT_RETRIES = 2
_MAX_CONTENT_RETRIES = 2
_MAX_TOKEN_CEILING = 32000
_RETRY_DELAYS = (0.4, 1.2)
_NO_RETRY_TRANSPORT = (httpx.LocalProtocolError, httpx.UnsupportedProtocol, httpx.InvalidURL)


def _sleep(seconds: float) -> None:
    if seconds > 0:
        time.sleep(seconds)


def _retry_after(response: httpx.Response, default: float) -> float:
    headers = getattr(response, "headers", None)
    raw = (headers.get("retry-after") or "").strip() if headers else ""
    if raw:
        try:
            return min(5.0, max(0.2, float(raw)))
        except ValueError:
            pass
    return default


class LLMUnavailable(RuntimeError):
    """Credentials or endpoint are missing/unauthorized."""


class LLMFailed(RuntimeError):
    """Model request or output parsing failed without leaking secrets."""


_LENGTH_HINTS = (
    "context length",
    "maximum context",
    "input is too long",
    "too long",
    "reduce the length",
    "length limit",
    "maximum number of tokens",
)


def _has_length_error(response: httpx.Response) -> bool:
    try:
        payload = response.json()
    except ValueError:
        return False
    if not isinstance(payload, dict):
        return False
    error = payload.get("error")
    message = error.get("message") if isinstance(error, dict) else payload.get("message")
    lowered = str(message or "").strip()[:200].lower()
    return any(token in lowered for token in _LENGTH_HINTS)


def _transport_reason(exc: httpx.HTTPError) -> str:
    mapping: tuple[tuple[type[httpx.HTTPError], str], ...] = (
        (httpx.ConnectTimeout, "建立连接超时"),
        (httpx.ReadTimeout, "等待响应超时"),
        (httpx.WriteTimeout, "发送请求超时"),
        (httpx.PoolTimeout, "等待可用连接超时"),
        (httpx.TimeoutException, "请求超时"),
        (httpx.ProxyError, "代理连接失败"),
        (httpx.ConnectError, "无法建立网络连接"),
        (httpx.RemoteProtocolError, "远端响应协议异常"),
        (httpx.ReadError, "读取响应时连接中断"),
        (httpx.WriteError, "发送请求时连接中断"),
    )
    for kind, label in mapping:
        if isinstance(exc, kind):
            return label
    return "网络传输失败"


def _normalize_usage(data: dict[str, Any]) -> dict[str, Any]:
    raw = data.get("usage")
    if not isinstance(raw, dict):
        return {}
    details = raw.get("prompt_tokens_details")
    cached = details.get("cached_tokens") if isinstance(details, dict) else None
    hit = raw.get("prompt_cache_hit_tokens", cached) or 0
    miss = raw.get("prompt_cache_miss_tokens")
    try:
        hit_val = max(0, int(hit))
        prompt_val = max(0, int(raw.get("prompt_tokens") or 0))
        miss_val = max(0, int(miss)) if miss is not None else max(0, prompt_val - hit_val)
    except (TypeError, ValueError):
        return dict(raw)
    return {**raw, "cache_hit_tokens": hit_val, "cache_miss_tokens": miss_val}


class LLMClient:
    """Stateless wrapper around OpenAI-compatible /chat/completions."""

    def __init__(
        self,
        settings: Mapping[str, Any],
        *,
        check_cancel: Callable[[], None] | None = None,
    ) -> None:
        self.base_url = str(settings.get("base_url") or "").rstrip("/")
        self.api_key = str(settings.get("api_key") or "")
        self.model = str(settings.get("model") or "")
        self.timeout = max(10, int(settings.get("timeout") or 120))
        self.max_tokens = max(128, int(settings.get("max_tokens") or 8000))
        self.effort = str(settings.get("effort") or "").strip()
        self.check_cancel = check_cancel

    def chat_text(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str | None = None,
        max_tokens: int | None = None,
        effort: str | None = None,
        temperature: float | None = None,
        json_mode: bool = False,
    ) -> tuple[str, dict[str, Any]]:
        """Execute one chat completion request and return (content_text, usage_dict)."""
        if self.check_cancel is not None:
            self.check_cancel()
        if not self.base_url or not self.api_key:
            raise LLMUnavailable("未配置作者期模型凭据")
        target_model = (model or self.model).strip()
        if not target_model:
            raise LLMUnavailable("未配置作者期模型名称")

        chosen_effort = self.effort if effort is None else effort
        current_max_tokens = int(max_tokens or self.max_tokens)
        transient_attempts = 0
        content_attempts = 0

        while True:
            if self.check_cancel is not None:
                self.check_cancel()
            body: dict[str, Any] = {
                "model": target_model,
                "messages": messages,
                "max_tokens": current_max_tokens,
            }
            if chosen_effort:
                body["reasoning_effort"] = chosen_effort
            if temperature is not None:
                body["temperature"] = float(temperature)
            if json_mode:
                body["response_format"] = {"type": "json_object"}

            try:
                with httpx.Client(base_url=self.base_url, timeout=self.timeout) as client:
                    response = client.post(
                        "/chat/completions",
                        headers={"Authorization": f"Bearer {self.api_key}"},
                        json=body,
                    )
            except httpx.HTTPError as exc:
                if not isinstance(exc, _NO_RETRY_TRANSPORT) and transient_attempts < _MAX_TRANSIENT_RETRIES:
                    _sleep(_RETRY_DELAYS[transient_attempts])
                    transient_attempts += 1
                    continue
                raise LLMFailed(f"作者期模型{_transport_reason(exc)}") from exc

            if response.status_code in {401, 403}:
                raise LLMUnavailable(f"作者期模型鉴权失败（HTTP {response.status_code}）")
            if response.status_code != 200:
                has_length = _has_length_error(response)
                if (
                    not has_length
                    and (response.status_code == 429 or response.status_code >= 500)
                    and transient_attempts < _MAX_TRANSIENT_RETRIES
                ):
                    _sleep(_retry_after(response, _RETRY_DELAYS[transient_attempts]))
                    transient_attempts += 1
                    continue
                if has_length:
                    reason = "输入超过上下文限制"
                elif response.status_code == 429:
                    reason = "请求受到限流"
                elif response.status_code >= 500:
                    reason = "服务端错误"
                else:
                    reason = "请求未成功"
                raise LLMFailed(f"作者期模型{reason}（HTTP {response.status_code}）")

            try:
                data = response.json()
            except ValueError as exc:
                if content_attempts < _MAX_CONTENT_RETRIES:
                    _sleep(_RETRY_DELAYS[content_attempts])
                    content_attempts += 1
                    continue
                raise LLMFailed("作者期模型响应无法解析为 JSON（HTTP 200）") from exc

            choices = data.get("choices") if isinstance(data, dict) else None
            if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
                if content_attempts < _MAX_CONTENT_RETRIES:
                    _sleep(_RETRY_DELAYS[content_attempts])
                    content_attempts += 1
                    continue
                raise LLMFailed("作者期模型响应缺少有效结果（HTTP 200）")
            choice = choices[0]
            if choice.get("finish_reason") == "length":
                raise LLMFailed("模型输出被截断，请重试或调高输出上限")
            message = choice.get("message")
            content = message.get("content") if isinstance(message, dict) else None
            if not isinstance(content, str) or not content.strip():
                if content_attempts < _MAX_CONTENT_RETRIES:
                    _sleep(_RETRY_DELAYS[content_attempts])
                    content_attempts += 1
                    if chosen_effort and chosen_effort != "none":
                        chosen_effort = "none"
                    current_max_tokens = min(max(128, current_max_tokens) * 2, _MAX_TOKEN_CEILING)
                    continue
                raise LLMFailed("模型返回空内容，请重试")
            return content.strip(), _normalize_usage(data if isinstance(data, dict) else {})

    def chat_json(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str | None = None,
        max_tokens: int | None = None,
        effort: str | None = None,
        temperature: float | None = None,
    ) -> tuple[Any, dict[str, Any]]:
        """Execute a JSON-mode chat request and parse the returned payload."""
        text, usage = self.chat_text(
            messages,
            model=model,
            max_tokens=max_tokens,
            effort=effort,
            temperature=temperature,
            json_mode=True,
        )
        try:
            return json.loads(text), usage
        except ValueError:
            try:
                return extract_json_payload(text), usage
            except ValueError as exc:
                raise LLMFailed("模型返回的不是有效 JSON，请重试") from exc
