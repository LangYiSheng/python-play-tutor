"""Data-only contracts for authored interactive exercises. Course scripts run in the browser."""

import json
import math

from pydantic import BaseModel, ConfigDict, Field


class InteractiveContent(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    html: str = Field(max_length=32000)
    css: str = Field(default="", max_length=16000)
    js: str = Field(max_length=32000)


def validate_json_value(value: object, depth: int = 0) -> None:
    if depth > 16:
        raise ValueError("交互题答案最多嵌套16层")
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str):
                raise ValueError("交互题答案对象的键必须是字符串")
            validate_json_value(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            validate_json_value(child, depth + 1)
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if abs(value) > 2**53 - 1 or not math.isfinite(value):
            raise ValueError("交互题答案数字超出有效范围")
    elif value is not None and type(value) not in {str, bool}:
        raise ValueError("交互题答案必须为JSON值")
    if depth == 0 and len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()) > 16384:
        raise ValueError("交互题答案不能超过16 KiB")


def same_json(left: object, right: object) -> bool:
    """JSON numbers share a type, while a boolean is never equal to a number."""
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(same_json(value, right[key]) for key, value in left.items())
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(same_json(a, b) for a, b in zip(left, right))
    if type(left) in {int, float} and type(right) in {int, float}:
        return left == right
    return type(left) is type(right) and left == right


def validate_receipt(answer: object) -> None:
    if (not isinstance(answer, dict) or set(answer) != {"value", "correct", "message"}
            or type(answer["correct"]) is not bool or not isinstance(answer["message"], str) or len(answer["message"]) > 1000):
        raise ValueError("交互题需提交作答值、布尔判定和最多1000字符的反馈")
    validate_json_value(answer["value"])


def interactive_feedback(answer: dict[str, object], target: object) -> tuple[str, str]:
    if not answer["correct"]:
        return "wrong_answer", str(answer["message"]) or "请调整后再试。"
    if not same_json(answer["value"], target):
        return "wrong_answer", "提交的作答值与本题目标不符，请检查后重新提交。"
    return "accepted", str(answer["message"]) or "回答正确"
