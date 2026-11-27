"""Typed shapes shared across the narration package.

These are the values that cross module boundaries (settings, model replies, per-page
results, student answers). They are intentionally plain TypedDicts rather than pydantic
models: the wire contract lives in `router.py`, and these only describe in-process data.
"""

from typing import Any, NotRequired, TypedDict


class AuthoringSettings(TypedDict):
    api_key: str
    base_url: str
    model: str
    vision_model: str
    effort: str
    max_tokens: int
    timeout: int
    daily_pages: int


class SpeechSettings(TypedDict):
    protocol: str
    base_url: str
    api_key: str
    model: str
    voice: str
    format: str
    speed: float
    timeout: int
    instruction: NotRequired[str]


class ChatReply(TypedDict):
    raw: dict[str, Any]
    text: str
    bridge_in: str
    anchors: list[str]
    usage: dict[str, Any]
    model: str


class GeneratedPage(TypedDict, total=False):
    page_no: int
    status: str
    reused: bool
    model: str | None
    chars: int
    image_used: bool
    error: str


class Quota(TypedDict):
    used_today: int
    daily_limit: int
    available: bool


class AudioRecord(TypedDict):
    page_no: int
    reused: bool
    key: str
    seconds: int


class CalibrationIssue(TypedDict):
    page_no: int
    kind: str
    detail: str
    status: str


class CalibrationReport(TypedDict):
    """One calibration run. `complete` 为 false 时只表示进度，不能被应用。"""
    complete: bool
    deck_fingerprint: str
    calibrate_version: str
    prefix_hash: str
    model: str
    effort: str
    windows: int
    windows_done: int
    next_index: int
    pages: int
    pages_seen: int
    summary: str
    terms: list[str]
    issues: list[CalibrationIssue]
    issues_truncated: bool
    render_errors: list[int]
    shrunk_windows: list[int]
    revisions: dict[str, str]
    window_budget: dict[str, int]
    usage: dict[str, int]
    generated_at: str | None


class AppliedCalibration(TypedDict):
    """应用校准报告的结果：改了哪些整理稿、哪些建议被拒绝、写了多少标签映射。"""

    applied_fixes: list[int]
    rejected_fixes: list[dict[str, Any]]
    tags: int
