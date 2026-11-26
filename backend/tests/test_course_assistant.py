"""Platform rules bind each learning scene to its teaching role."""
from types import SimpleNamespace
import pytest
from fastapi import HTTPException

def test_runtime_roles_and_platform_budget(db):
    from app.course_assistant import default_npc, activity_npc, ensure_enabled, runtime_policy
    from app.integration_models import AssistantModelSettings
    assert default_npc(db, 1).key == "librarian"
    for category, key in [("objective","professor"),("programming","coach")]:
        assert activity_npc(db, 1, SimpleNamespace(kind="practice",content={"practice_kind":category})).key == key
    assert activity_npc(db, 2, SimpleNamespace(kind="assessment")).key == "mayor"
    ensure_enabled(db, 1)
    db.add(AssistantModelSettings(id=1,configuration={"enabled":False,"model_calls":3}))
    db.flush()
    for room in (1,2):
        with pytest.raises(HTTPException, match="平台暂未开放答疑"):
            ensure_enabled(db, room)
        assert runtime_policy(db, room)[1]["model_calls"] == 3


def test_role_budgets_compile_real_agent_without_network(monkeypatch):
    from app.assistant import AgentFactory
    monkeypatch.setenv("REBORN_AI_API_KEY", "test-not-real")
    monkeypatch.setenv("REBORN_AI_MODEL", "test-not-real")
    context = {"pages": [], "activity": {"id": "test", "questions": []}, "role": {"name": "老师", "tone": "清晰", "instructions": "分层提示"},
               "current_page": None, "progress": [], "submissions": [], "student_code": None,
               "limits": {"tool_calls": 0, "model_calls": 1, "output_tokens": 64, "request_tokens": 2000, "timeout_seconds": 5}}
    agent = AgentFactory.create(context, {}, {"model_calls": 0})
    assert "model" in agent.get_graph().nodes
