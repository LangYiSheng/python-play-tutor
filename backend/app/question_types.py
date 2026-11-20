"""Question policies shared by authoring, package validation and assessment.

Register each kind here. Policies are pure; authentication, transactions and
Python execution remain in the submission services. Never default unknown kinds
to equality grading.
"""

from dataclasses import dataclass
from typing import Any, Callable, Literal
from .interactive_practice import validate_json_value

QuestionKind = Literal["single_choice", "multiple_choice", "boolean", "fill", "python", "interactive"]


def answer_value(value):
    return value["value"] if isinstance(value, dict) and "value" in value else value


def _choice_definition(question):
    if question.status == "ready" and (not question.options or answer_value(question.answer) not in question.options):
        raise ValueError("单选答案必须属于选项")


def _multiple_selection(value, options):
    return (isinstance(value, list) and bool(value) and all(isinstance(item, str) for item in value)
            and len(set(value)) == len(value) and all(item in options for item in value))


def _multiple_definition(question):
    if question.status != "ready":
        return
    options = question.options
    if (len(options) < 2 or any(not isinstance(item, str) or not item.strip() for item in options)
            or len(set(options)) != len(options)):
        raise ValueError("多选题须有至少两个非空且不重复的选项")
    expected = answer_value(question.answer)
    if not _multiple_selection(expected, options) or len(expected) < 2:
        raise ValueError("多选题须设置至少两个不重复且属于选项的正确答案")


def _boolean_definition(question):
    if question.status == "ready" and not isinstance(answer_value(question.answer), bool):
        raise ValueError("判断题答案必须是布尔值")


def _fill_definition(question):
    expected = answer_value(question.answer)
    if question.status == "ready" and (not isinstance(expected, (str, list)) or not expected):
        raise ValueError("填空题必须设置答案")


def _python_definition(question):
    if len(question.samples) + len(question.hidden_cases) > 20:
        raise ValueError("编程题公开样例与隐藏用例合计不能超过20个")
    if question.status == "ready" and not question.hidden_cases:
        raise ValueError("就绪编程题必须设置私有用例")


def _interactive_definition(question: Any) -> None:
    if question.status == "ready" and (not question.interactive or not question.interactive.html.strip()
                                      or not question.interactive.js.strip() or question.answer is None):
        raise ValueError("就绪交互练习题必须设置 HTML、JavaScript 和私有目标答案")
    validate_json_value(question.answer)


def _equal(answer, expected):
    return type(answer) is type(expected) and answer == expected


def _fill_grade(answer, expected):
    accepted = expected if isinstance(expected, list) else [expected]
    return isinstance(answer, str) and answer.strip().casefold() in [str(item).strip().casefold() for item in accepted]


def _multiple_grade(answer, expected):
    return (isinstance(expected, list) and _multiple_selection(expected, expected)
            and _multiple_selection(answer, expected) and set(answer) == set(expected))


@dataclass(frozen=True)
class QuestionType:
    validate_definition: Callable[[Any], None]
    complete: Callable[[Any, Any, str | None], bool]
    grade: Callable[[Any, Any], bool] | None
    execution: Literal["answer", "python", "interactive"] = "answer"


QUESTION_TYPES: dict[QuestionKind, QuestionType] = {
    "single_choice": QuestionType(_choice_definition,
        lambda q, a, c: a is not None and (not q.options or a in q.options), _equal),
    "multiple_choice": QuestionType(_multiple_definition,
        lambda q, a, c: _multiple_selection(a, q.options), _multiple_grade),
    "boolean": QuestionType(_boolean_definition,
        lambda q, a, c: type(a) is bool, lambda a, e: type(a) is bool and type(e) is bool and a is e),
    "fill": QuestionType(_fill_definition,
        lambda q, a, c: isinstance(a, str) and bool(a.strip()), _fill_grade),
    "python": QuestionType(_python_definition,
        lambda q, a, c: isinstance(c, str) and bool(c.strip()), None, "python"),
    "interactive": QuestionType(_interactive_definition, lambda q, a, c: isinstance(a, dict), None, "interactive"),
}


def question_type(kind: str) -> QuestionType:
    if kind not in QUESTION_TYPES:
        raise ValueError(f"不支持的题型：{kind}")
    return QUESTION_TYPES[kind]


def grade_answer(answer, expected, kind: str) -> bool:
    policy = question_type(kind)
    if policy.grade is None:
        raise ValueError("此题型须通过代码评测服务判定")
    return policy.grade(answer, answer_value(expected))
