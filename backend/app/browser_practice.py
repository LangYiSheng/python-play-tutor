"""Public-sample practice receipts. These are not trusted server executions."""

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .coding_questions import check_fill_submission_for_question
from .models import Submission


class BrowserCase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    input: str = Field(max_length=20000)
    output: str = Field(max_length=20000)
    stdout: str = Field(max_length=16000)
    stderr: str = Field(max_length=16000)


def stage_browser_submission(db, user, classroom_id, activity, question, code, key, cases):
    if not code or not code.strip():
        raise HTTPException(422, "请填写代码")
    fill_error = check_fill_submission_for_question(question, code)
    if fill_error:
        raise HTTPException(422, f"请仅在填空区标记内作答：{fill_error}")
    if not question.samples or len(question.samples) > 20:
        raise HTTPException(422, "此题尚未配置有效的公开样例，请联系教师")
    if cases is None or len(cases) != len(question.samples):
        raise HTTPException(422, "请在浏览器执行全部公开样例后提交")
    results = []
    for sample, result in zip(question.samples, cases, strict=True):
        expected = sample.get("expected_output", sample.get("output", ""))
        if (sample.get("input", ""), expected) != (result.input, result.output):
            raise HTTPException(422, "公开样例已变更，请重新载入题目并评测")
        accepted = result.stdout.replace("\r\n", "\n").rstrip() == expected.replace("\r\n", "\n").rstrip()
        status = "runtime_error" if result.stderr else "accepted" if accepted else "wrong_answer"
        results.append({"stdout": result.stdout, "stderr": result.stderr, "compile_output": "", "status": status})
    passed = sum(result["status"] == "accepted" for result in results)
    status = next((result["status"] for result in results if result["status"] == "runtime_error"),
                  "accepted" if passed == len(results) else "wrong_answer")
    row = Submission(user_id=user.id, classroom_id=classroom_id, activity_id=activity.id,
                     question_id=question.id, idempotency_key=key, mode="submit", code=code,
                     answer=[case.model_dump() for case in cases], status=status,
                     feedback={"source": "browser_practice", "passed_count": passed,
                               "total_count": len(results), "samples": results})
    db.add(row)
    db.flush()
    return row
