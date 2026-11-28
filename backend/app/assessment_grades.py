"""Academic and pending outcomes shared by assessment sheets and chapter progress."""
from .question_types import question_type


def assessment_answered(question, answer, code):
    if question.kind == "python" and (code or "").strip() == (question.starter_code or "").strip():
        return False
    return question_type(question.kind).complete(question, answer, code)


ACCEPTED = {"accepted", "AC", "ac"}
GRADED = ACCEPTED | {"wrong_answer", "compile_error", "runtime_error", "time_limit", "memory_limit"}
PENDING = {"prepared", "dispatching", "queued", "running"}


def grade_status(statuses, total):
    if total and len(statuses) == total and all(status in GRADED for status in statuses):
        return "graded"
    if any(status not in GRADED | PENDING for status in statuses):
        return "attention"
    return "grading"
