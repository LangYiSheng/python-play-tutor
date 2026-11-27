"""Teacher voice cloning, binding, multi-teacher isolation and per-material TTS switching."""

from __future__ import annotations

import io
import threading
import wave

import pytest

from app.models import User
from app.narration import jobs, task_commands, tts, voices

from test_narration import url
from test_narration_generation import doc_material


def _sample_wav_bytes(seconds: float = 1.0, rate: int = 24000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x01\x00" * int(rate * seconds))
    return buf.getvalue()


@pytest.fixture(autouse=True)
def _storage_env(monkeypatch, tmp_path):
    monkeypatch.setenv("REBORN_STORAGE_ROOT", str(tmp_path / "storage"))
    monkeypatch.setenv("REBORN_AUTHORING_AI_API_KEY", "test-key")


def _configure_dashscope(monkeypatch, model: str = "qwen-audio-3.1-tts-flash"):
    monkeypatch.setenv("REBORN_TTS_PROTOCOL", "dashscope")
    monkeypatch.setenv("REBORN_TTS_BASE_URL", "https://ws123.cn-beijing.maas.aliyuncs.com")
    monkeypatch.setenv("REBORN_TTS_API_KEY", "dash-key-123")
    monkeypatch.setenv("REBORN_TTS_MODEL", model)
    monkeypatch.setenv("REBORN_TTS_VOICE", "longanhuan_v3.1")
    monkeypatch.setenv("REBORN_TTS_FORMAT", "mp3")


def test_voice_capabilities_reflect_protocol(client, teacher, monkeypatch):
    monkeypatch.delenv("REBORN_TTS_BASE_URL", raising=False)
    res = client.get("/api/teacher/voices", headers=teacher["headers"])
    assert res.status_code == 200
    assert res.json()["capabilities"]["speech_configured"] is False
    assert res.json()["capabilities"]["clone_supported"] is False

    _configure_dashscope(monkeypatch)
    res2 = client.get("/api/teacher/voices", headers=teacher["headers"])
    assert res2.status_code == 200
    caps = res2.json()["capabilities"]
    assert caps["speech_configured"] is True
    assert caps["protocol"] == "dashscope"
    assert caps["clone_supported"] is True


def test_enroll_qwen_voice_sends_base64_and_enforces_consent(client, teacher, monkeypatch):
    _configure_dashscope(monkeypatch, model="qwen-audio-3.1-tts-flash")
    posted: list[tuple[str, dict]] = []

    class FakeResp:
        def __init__(self, payload):
            self.status_code = 200
            self._payload = payload

        def json(self):
            return self._payload

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, req_url, headers=None, json=None):
            posted.append((req_url, json))
            if json["input"]["action"] == "create_voice":
                return FakeResp({"output": {"voice_id": "qwen-audio-3.1-tts-flash-t1v123-abcd"}})
            return FakeResp({"output": {"status": "OK"}})

    monkeypatch.setattr(voices.httpx, "Client", FakeClient)

    wav = _sample_wav_bytes(1.0)
    denied = client.post(
        "/api/teacher/voices/enroll",
        headers=teacher["headers"],
        data={"name": "张老师原声", "consent": "false"},
        files={"file": ("sample.wav", wav, "audio/wav")},
    )
    assert denied.status_code == 422
    assert "本人真实声音" in denied.json()["detail"]

    created = client.post(
        "/api/teacher/voices/enroll",
        headers=teacher["headers"],
        data={"name": "张老师原声", "consent": "true", "is_default": "true", "sample_seconds": "15"},
        files={"file": ("sample.wav", wav, "audio/wav")},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["name"] == "张老师原声"
    assert body["status"] == "ready"
    assert body["is_default"] is True
    assert body["sample_seconds"] == 15
    assert body["provider_voice_id"] == "qwen-audio-3.1-tts-flash-t1v123-abcd"

    assert len(posted) == 2
    req_url, req_body = posted[0]
    assert req_url == "https://ws123.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/customization"
    assert req_body["model"] == "voice-enrollment"
    assert req_body["input"]["action"] == "create_voice"
    assert req_body["input"]["target_model"] == "qwen-audio-3.1-tts-flash"
    assert req_body["input"]["language_hints"] == ["zh"]
    assert req_body["input"]["audio"].startswith("data:audio/wav;base64,")
    assert posted[1][1]["input"]["action"] == "query_voice"


def test_enroll_reports_dashscope_api_key_restriction_clearly(client, teacher, monkeypatch):
    _configure_dashscope(monkeypatch)

    class FakeResp:
        status_code = 403

        def json(self):
            return {"code": "AccessDenied", "message": "Access denied by API-Key restrictions."}

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, req_url, headers=None, json=None):
            return FakeResp()

    monkeypatch.setattr(voices.httpx, "Client", FakeClient)
    resp = client.post(
        "/api/teacher/voices/enroll",
        headers=teacher["headers"],
        data={"name": "测试音色", "consent": "true"},
        files={"file": ("sample.wav", _sample_wav_bytes(0.5), "audio/wav")},
    )
    assert resp.status_code == 502
    assert "模型访问限制" in resp.json()["detail"]


def test_enroll_cosyvoice_async_and_refresh_status(client, teacher, monkeypatch):
    _configure_dashscope(monkeypatch, model="cosyvoice-v3-plus")
    calls: list[dict] = []

    class FakeResp:
        def __init__(self, payload):
            self.status_code = 200
            self._payload = payload

        def json(self):
            return self._payload

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, req_url, headers=None, json=None):
            calls.append(json)
            action = json["input"]["action"]
            if action == "create_voice":
                return FakeResp({"output": {"voice_id": "cosyvoice-v3-plus-t1-xyz", "status": "DEPLOYING"}})
            if action == "query_voice":
                return FakeResp({"output": {"voice_id": "cosyvoice-v3-plus-t1-xyz", "status": "OK"}})
            return FakeResp({"output": {}})

    monkeypatch.setattr(voices.httpx, "Client", FakeClient)

    created = client.post(
        "/api/teacher/voices/enroll",
        headers=teacher["headers"],
        data={"name": "Cosy克隆音色", "consent": "true", "is_default": "true"},
        files={"file": ("sample.wav", _sample_wav_bytes(0.5), "audio/wav")},
    )
    assert created.status_code == 201
    v = created.json()
    assert v["status"] == "processing"
    assert v["is_default"] is False
    assert calls[0]["model"] == "voice-enrollment"
    assert calls[0]["input"]["action"] == "create_voice"

    refreshed = client.post(f"/api/teacher/voices/{v['id']}/refresh", headers=teacher["headers"])
    assert refreshed.status_code == 200
    assert refreshed.json()["status"] == "ready"
    assert calls[1]["input"]["action"] == "query_voice"


def test_bind_preview_update_delete_and_teacher_isolation(client, db, teacher, monkeypatch):
    _configure_dashscope(monkeypatch)
    synthesized: list[tuple[str, str, str]] = []

    def fake_synthesize(text, *, settings_override=None):
        synthesized.append((text, settings_override["voice"], settings_override["model"]))
        return b"ID3" + b"\x00" * 2048

    monkeypatch.setattr(tts, "synthesize", fake_synthesize)

    bound = client.post(
        "/api/teacher/voices/bind",
        headers=teacher["headers"],
        json={
            "name": "绑定音色A",
            "provider_voice_id": "custom-voice-a",
            "target_model": "qwen-audio-3.1-tts-plus",
            "is_default": True,
        },
    )
    assert bound.status_code == 201, bound.text
    vid = bound.json()["id"]

    # Preview streams audio using the bound voice + target_model
    prev = client.post(
        f"/api/teacher/voices/{vid}/preview",
        headers=teacher["headers"],
        json={"text": "试听一句列表切片。"},
    )
    assert prev.status_code == 200
    assert prev.headers["content-type"] == "audio/mpeg"
    assert prev.content.startswith(b"ID3")
    assert synthesized[-1] == ("试听一句列表切片。", "custom-voice-a", "qwen-audio-3.1-tts-plus")

    # Rename works
    patched = client.patch(
        f"/api/teacher/voices/{vid}",
        headers=teacher["headers"],
        json={"name": "张老师-精讲版"},
    )
    assert patched.status_code == 200
    assert patched.json()["name"] == "张老师-精讲版"

    # Another teacher cannot view, patch, preview, or delete Teacher A's voice
    from app.auth import hash_password, issue

    other = User(
        student_id="900099",
        name="另一位教师",
        role="teacher",
        password_hash=hash_password("TeacherPass123!"),
    )
    db.add(other)
    db.commit()
    other_headers = {"Authorization": f"Bearer {issue(db, other)['access_token']}"}
    db.commit()

    assert client.get("/api/teacher/voices", headers=other_headers).json()["voices"] == []
    assert client.patch(f"/api/teacher/voices/{vid}", headers=other_headers, json={"name": "越权"}).status_code == 404
    assert client.post(f"/api/teacher/voices/{vid}/preview", headers=other_headers, json={}).status_code == 404
    assert client.delete(f"/api/teacher/voices/{vid}", headers=other_headers).status_code == 404

    # Owner deletes cleanly
    assert client.delete(f"/api/teacher/voices/{vid}", headers=teacher["headers"]).status_code == 204
    assert client.get("/api/teacher/voices", headers=teacher["headers"]).json()["voices"] == []


def test_material_voice_switching_detects_mismatch_and_resynthesizes(client, db, classroom, teacher, monkeypatch):
    _configure_dashscope(monkeypatch)
    monkeypatch.setattr(
        "app.narration.service.model_client.chat",
        lambda *a, **k: {
            "raw": {},
            "text": "这一页讲解字典的常用操作。",
            "bridge_in": "",
            "anchors": [],
            "usage": {},
            "model": "deepseek-flash",
        },
    )
    spoken: list[tuple[str, str]] = []

    def fake_synthesize(text, *, settings_override=None):
        spoken.append((settings_override["voice"], settings_override["model"]))
        return b"ID3" + settings_override["voice"].encode("utf-8") + b"\x00" * 2048

    monkeypatch.setattr(tts, "synthesize", fake_synthesize)

    material = doc_material(db, classroom, "一" * 300)
    db.commit()
    assert client.post(url(classroom, material, "/1/generate"), json=None, headers=teacher["headers"]).status_code == 200
    assert client.post(url(classroom, material, "/1/accept"), headers=teacher["headers"]).status_code == 200

    # 1. Synthesize page 1 with site default voice
    first = client.post(url(classroom, material, "/1/audio"), headers=teacher["headers"])
    assert first.status_code == 200
    assert spoken[-1][0] == "longanhuan_v3.1"

    status1 = client.get(url(classroom, material, "/audio"), headers=teacher["headers"]).json()
    assert status1["voice"] == "longanhuan_v3.1"
    assert status1["voice_source"] == "system"
    assert status1["mismatched_count"] == 0
    assert status1["pages"][0]["voice_mismatch"] is False

    # 2. Teacher binds a personal default voice -> auto mode resolves to teacher's voice -> page 1 flagged mismatch
    bound = client.post(
        "/api/teacher/voices/bind",
        headers=teacher["headers"],
        json={"name": "王老师原声", "provider_voice_id": "wang-voice-01", "is_default": True},
    )
    assert bound.status_code == 201
    vid = bound.json()["id"]

    status2 = client.get(url(classroom, material, "/audio"), headers=teacher["headers"]).json()
    assert status2["voice"] == "wang-voice-01"
    assert status2["voice_name"] == "王老师原声"
    assert status2["voice_source"] == "custom"
    assert status2["mismatched_count"] == 1
    assert status2["pages"][0]["voice_mismatch"] is True

    # 3. Batch without regenerate_mismatch skips already-ready page
    b1 = client.post(
        url(classroom, material, "/audio-batch"),
        headers=teacher["headers"],
        json={"first_page": 1, "last_page": 1, "regenerate_mismatch": False},
    )
    assert b1.status_code == 202
    assert jobs.drain(db) == 1
    assert len(spoken) == 1

    # 4. Batch WITH regenerate_mismatch re-synthesizes with the new custom voice
    b2 = client.post(
        url(classroom, material, "/audio-batch"),
        headers=teacher["headers"],
        json={"first_page": 1, "last_page": 1, "regenerate_mismatch": True},
    )
    assert b2.status_code == 202
    assert jobs.drain(db) == 1
    assert len(spoken) == 2
    assert spoken[-1][0] == "wang-voice-01"

    status3 = client.get(url(classroom, material, "/audio"), headers=teacher["headers"]).json()
    assert status3["mismatched_count"] == 0
    assert status3["pages"][0]["voice_mismatch"] is False
    assert status3["pages"][0]["audio_voice"] == "wang-voice-01"

    # 5. Explicitly switch this material back to system default -> mismatch detected again, single-page re-synth works
    sw = client.put(
        url(classroom, material, "/voice"),
        headers=teacher["headers"],
        json={"mode": "system", "teacher_voice_id": None},
    )
    assert sw.status_code == 200
    assert sw.json()["voice"] == "longanhuan_v3.1"
    assert sw.json()["voice_mode"] == "system"
    assert sw.json()["mismatched_count"] == 1

    single = client.post(url(classroom, material, "/1/audio"), headers=teacher["headers"])
    assert single.status_code == 200
    assert single.json()["reused"] is False
    assert spoken[-1][0] == "longanhuan_v3.1"

    # 6. Deleting custom voice resets explicit custom material setting cleanly
    assert client.put(
        url(classroom, material, "/voice"),
        headers=teacher["headers"],
        json={"mode": "custom", "teacher_voice_id": vid},
    ).status_code == 200
    assert client.delete(f"/api/teacher/voices/{vid}", headers=teacher["headers"]).status_code == 204
    status_after = client.get(url(classroom, material, "/audio"), headers=teacher["headers"]).json()
    assert status_after["voice_source"] == "system"
    assert status_after["voice_mode"] == "auto"


def test_material_speech_instruction_speed_and_force_resynthesis(client, db, classroom, teacher, monkeypatch):
    _configure_dashscope(monkeypatch)
    monkeypatch.setenv("REBORN_TTS_INSTRUCTION", "全站默认授课语气")
    monkeypatch.setenv("REBORN_TTS_SPEED", "1.0")
    monkeypatch.setattr(
        "app.narration.service.model_client.chat",
        lambda *a, **k: {
            "raw": {},
            "text": "这一页讲解循环语句的常见写法。",
            "bridge_in": "",
            "anchors": [],
            "usage": {},
            "model": "deepseek-flash",
        },
    )
    calls: list[dict] = []

    def fake_synthesize(text, *, settings_override=None):
        calls.append({"text": text, **dict(settings_override or {})})
        return b"ID3" + f"{len(calls)}".encode("ascii") + b"\x00" * 2048

    monkeypatch.setattr(tts, "synthesize", fake_synthesize)

    # Preview forwards explicit instruction & speed
    bound = client.post(
        "/api/teacher/voices/bind",
        headers=teacher["headers"],
        json={"name": "林老师原声", "provider_voice_id": "lin-voice-01", "is_default": True},
    )
    assert bound.status_code == 201
    vid = bound.json()["id"]

    prev = client.post(
        f"/api/teacher/voices/{vid}/preview",
        headers=teacher["headers"],
        json={"text": "试听连贯性。", "instruction": "流畅明快连贯朗读", "speed": 1.1},
    )
    assert prev.status_code == 200
    assert calls[-1]["instruction"] == "流畅明快连贯朗读"
    assert calls[-1]["speed"] == 1.1

    material = doc_material(db, classroom, "循环语句" * 80)
    db.commit()
    assert client.post(url(classroom, material, "/1/generate"), json=None, headers=teacher["headers"]).status_code == 200
    assert client.post(url(classroom, material, "/1/accept"), headers=teacher["headers"]).status_code == 200

    # Default inherits site instruction and speed
    st0 = client.get(url(classroom, material, "/audio"), headers=teacher["headers"]).json()
    assert st0["instruction_supported"] is True
    assert len(st0["instruction_presets"]) >= 3
    assert st0["speech_instruction"] is None
    assert st0["effective_instruction"] == "全站默认授课语气"
    assert st0["speech_speed"] is None
    assert st0["effective_speed"] == 1.0

    r1 = client.post(url(classroom, material, "/1/audio"), headers=teacher["headers"])
    assert r1.status_code == 200
    assert r1.json()["reused"] is False
    assert calls[-1]["instruction"] == "全站默认授课语气"
    assert calls[-1]["speed"] == 1.0

    # Override instruction & speed for this material
    sw = client.put(
        url(classroom, material, "/voice"),
        headers=teacher["headers"],
        json={
            "mode": "custom",
            "teacher_voice_id": vid,
            "speech_instruction": "请用自然连贯的大学课堂语气朗读",
            "speech_speed": 1.15,
        },
    )
    assert sw.status_code == 200, sw.text
    assert sw.json()["speech_instruction"] == "请用自然连贯的大学课堂语气朗读"
    assert sw.json()["effective_instruction"] == "请用自然连贯的大学课堂语气朗读"
    assert sw.json()["speech_speed"] == 1.15
    assert sw.json()["effective_speed"] == 1.15

    # Without force, existing matching-voice audio is reused; with force=true, it re-synthesizes
    r2 = client.post(url(classroom, material, "/1/audio"), headers=teacher["headers"])
    assert r2.status_code == 200
    assert r2.json()["reused"] is True

    r3 = client.post(url(classroom, material, "/1/audio"), headers=teacher["headers"], json={"force": True})
    assert r3.status_code == 200
    assert r3.json()["reused"] is False
    assert calls[-1]["instruction"] == "请用自然连贯的大学课堂语气朗读"
    assert calls[-1]["speed"] == 1.15

    # Explicit empty string disables site instruction; explicit null restores inheritance
    sw_off = client.put(
        url(classroom, material, "/voice"),
        headers=teacher["headers"],
        json={"mode": "custom", "teacher_voice_id": vid, "speech_instruction": ""},
    )
    assert sw_off.status_code == 200
    assert sw_off.json()["speech_instruction"] == ""
    assert sw_off.json()["effective_instruction"] == ""

    sw_inherit = client.put(
        url(classroom, material, "/voice"),
        headers=teacher["headers"],
        json={"mode": "custom", "teacher_voice_id": vid, "speech_instruction": None, "speech_speed": None},
    )
    assert sw_inherit.status_code == 200
    assert sw_inherit.json()["speech_instruction"] is None
    assert sw_inherit.json()["effective_instruction"] == "全站默认授课语气"
    assert sw_inherit.json()["speech_speed"] is None
    assert sw_inherit.json()["effective_speed"] == 1.0


def test_audio_batch_sliding_window_concurrency_and_force(client, db, classroom, teacher, monkeypatch):
    _configure_dashscope(monkeypatch)
    monkeypatch.delenv("REBORN_TTS_WORKERS", raising=False)
    monkeypatch.setattr(task_commands, "AUDIO_WORKERS", task_commands._DEFAULT_AUDIO_WORKERS)
    assert task_commands._effective_audio_workers("dashscope") == 6
    assert task_commands._effective_audio_workers("openai") == 4
    assert task_commands._effective_audio_workers("deepseek") == 2

    monkeypatch.setenv("REBORN_TTS_WORKERS", "3")
    assert task_commands._effective_audio_workers("dashscope") == 3

    material = doc_material(db, classroom, "页一", "页二", "页三", "页四", "页五")
    db.commit()
    for p in range(1, 6):
        monkeypatch.setattr(
            "app.narration.service.model_client.chat",
            lambda *a, page_no=p, **k: {
                "raw": {},
                "text": f"PAGE-{page_no}-讲稿内容。",
                "bridge_in": "",
                "anchors": [],
                "usage": {},
                "model": "deepseek-flash",
            },
        )
        assert client.post(url(classroom, material, f"/{p}/generate"), json=None, headers=teacher["headers"]).status_code == 200
        assert client.post(url(classroom, material, f"/{p}/accept"), headers=teacher["headers"]).status_code == 200

    # Sliding-window proof: with 3 workers, page 1 stalls until page 4 starts & finishes.
    # A chunk-barrier pool would never start page 4 while page 1 is still running.
    page4_done = threading.Event()
    page1_released_after_page4 = False
    active_lock = threading.Lock()
    active_now = 0
    max_active = 0
    synth_texts: list[str] = []

    def fake_synthesize(text, *, settings_override=None):
        nonlocal active_now, max_active, page1_released_after_page4
        with active_lock:
            active_now += 1
            max_active = max(max_active, active_now)
            synth_texts.append(text)
        try:
            if "PAGE-1-" in text:
                page1_released_after_page4 = page4_done.wait(timeout=3.0)
            elif "PAGE-4-" in text:
                page4_done.set()
            return b"ID3" + text.encode("utf-8") + b"\x00" * 2048
        finally:
            with active_lock:
                active_now -= 1

    monkeypatch.setattr(tts, "synthesize", fake_synthesize)

    b1 = client.post(
        url(classroom, material, "/audio-batch"),
        headers=teacher["headers"],
        json={"first_page": 1, "last_page": 5},
    )
    assert b1.status_code == 202
    assert jobs.drain(db) == 1
    assert page1_released_after_page4 is True
    assert max_active >= 2
    assert len(synth_texts) == 5

    # Second batch with force=True re-synthesizes all 5 already-ready pages
    page4_done.set()
    b2 = client.post(
        url(classroom, material, "/audio-batch"),
        headers=teacher["headers"],
        json={"first_page": 1, "last_page": 5, "force": True},
    )
    assert b2.status_code == 202
    assert jobs.drain(db) == 1
    assert len(synth_texts) == 10
