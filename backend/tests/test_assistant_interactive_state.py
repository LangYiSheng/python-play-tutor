import json

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app import assistant
from app.assistant_context import MessageInput, build_tools, state_text
from app.models import QuestionSecret, Submission, User
from conftest import make_question
from test_assistant import create_session


@pytest.mark.parametrize("panel", [None, {"available": 1, "value": 0}, {"available": True}, {"available": False, "value": None},
                                   {"available": False, "reason": "example"}, {"available": True, "value": 2**53},
                                   {"available": True, "value": "界" * 6000}, {"available": True, "value": float("inf")}])
def test_invalid_panel_state(panel):
    with pytest.raises(ValidationError):
        MessageInput(message="帮我看看", state={"interactive_state": panel})


def test_interactive_turn_freezes_student_state_and_keeps_feedback_separate(client, db, student, classroom):
    activity_id = "ch1-practice"
    question = make_question(db, chapter_ids=[179], activity_id=activity_id, id="interactive-panel", title="小镇计数器",
                             kind="interactive", prompt="把数值调整到目标", source={},
                             interactive={"html": "private-html-marker", "css": "private-css-marker", "js": "private-js-marker"})
    db.add(QuestionSecret(question_id=question.id, answer="private-target-marker", hidden_cases=[]))
    ordinary = make_question(db, chapter_ids=[179], activity_id=activity_id, id="plain-fill", title="填空", kind="fill", prompt="作答", source={})
    db.add(Submission(user_id=student["id"], classroom_id=classroom["id"], activity_id=activity_id, question_id=question.id,
                      idempotency_key="panel-current", status="wrong_answer", mode="submit",
                      answer={"value": 7, "correct": False, "message": "上次选择了七"},
                      feedback={"source": "interactive_practice", "detail": "上次选择了七"}))
    db.commit()
    sid = create_session(client, student, classroom, activity_id).json()["id"]
    user = db.get(User, student["id"])
    session, activity = assistant.authorized_session(db, user, sid)
    def ask(question_id, **state):
        return assistant.build_context(db, user, session, activity, MessageInput(message="现在该怎么操作？", state={"question_id": question_id, **state}))

    panel = {"available": True, "value": {"当前位置": 2, "开关": False}}
    first = ask(question.id, interactive_state=panel)
    for marker in ["private-html-marker", "private-css-marker", "private-js-marker", "private-target-marker"]:
        assert marker not in json.dumps(first, ensure_ascii=False)
    tools = {t.name: t for t in build_tools(first, {})}
    initial = first["snapshot"]
    assert json.loads(initial["提问时的交互状态"]) == panel["value"]
    assert "最近正式提交" in initial and "上次选择了七" not in json.dumps(initial, ensure_ascii=False)
    assert not {"当前作答", "正在查看的结果", "选中公开用例"}.intersection(initial)
    feedback = tools["get_current_question_feedback"].invoke({})
    assert feedback["source"] == "submission" and "selected_case" not in feedback
    assert json.loads(feedback["text"])["answer"]["value"] == 7
    panel["value"]["当前位置"] = 5
    second = ask(question.id, interactive_state=panel)["snapshot"]
    assert json.loads(tools["read_current_attempt"].invoke({})["text"])["当前位置"] == 2
    assert "5" in state_text(second, initial)
    for state in ({}, {"interactive_state": {"available": False}}):
        unavailable = ask(question.id, **state)
        assert "不可用" in unavailable["snapshot"]["提问时的交互状态"]
        lookup = next(tool for tool in build_tools(unavailable, {}) if tool.name == "read_current_attempt")
        assert "不可用" in lookup.invoke({})["text"]
    assert ask(question.id, interactive_state={"available": True, "value": None})["snapshot"]["提问时的交互状态"] == "null"
    long_state = ask(question.id, interactive_state={"available": True, "value": "x" * 4000})
    assert "read_current_attempt" in long_state["snapshot"]["提问时的交互状态"]
    lookup = next(t for t in build_tools(long_state, {}) if t.name == "read_current_attempt")
    assert lookup.invoke({"offset": 3000, "limit": 10})["text"] == "x" * 10
    with pytest.raises(HTTPException, match="交互状态"):
        ask(ordinary.id, interactive_state=panel)
    with pytest.raises(HTTPException, match="当前活动"):
        ask("not-my-question", interactive_state=panel)


def test_interactive_state_depth_limit():
    value = "ok"
    for _ in range(17):
        value = [value]
    with pytest.raises(ValidationError, match="16层"):
        MessageInput(message="问", state={"interactive_state": {"available": True, "value": value}})


def test_overflowing_json_number_returns_422_without_echo(client, student):
    response = client.post("/api/assistant/sessions/invalid/messages", headers={**student["headers"], "Content-Type": "application/json"},
                           content='{"message":"help","state":{"interactive_state":{"available":true,"value":{"current":1e309}}}}')
    assert response.status_code == 422 and "current" not in response.text
