"""TTS 协议适配：DeepSeek 的 /v1/tools/tts 与 OpenAI 的 /v1/audio/speech 请求形状不同。"""
import io
import wave

import pytest

from app.narration import tts


def wav_bytes(seconds: float = 1.0, rate: int = 24000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x00" * int(rate * seconds))
    return buffer.getvalue()


@pytest.fixture
def captured(monkeypatch):
    calls: list[tuple[str, dict]] = []

    class FakeResponse:
        status_code = 200
        content = wav_bytes(1.0)

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, headers=None, json=None):
            calls.append((url, json))
            return FakeResponse()

    monkeypatch.setattr(tts.httpx, "Client", FakeClient)
    return calls


def test_deepseek_protocol_sends_its_own_fields(monkeypatch, captured):
    monkeypatch.setenv("REBORN_TTS_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("REBORN_TTS_API_KEY", "k")
    monkeypatch.setenv("REBORN_TTS_PROTOCOL", "deepseek")

    audio = tts.synthesize("这一页讲变量。")

    url, body = captured[0]
    assert url.endswith("/v1/tools/tts")
    assert body == {"text": "这一页讲变量。", "voice_id": "stella", "format": "wav", "filter_markdown": False}
    assert audio[:4] == b"RIFF"


def test_deepseek_rejects_a_container_it_cannot_produce(monkeypatch, captured):
    monkeypatch.setenv("REBORN_TTS_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("REBORN_TTS_PROTOCOL", "deepseek")
    monkeypatch.setenv("REBORN_TTS_FORMAT", "mp3")
    with pytest.raises(tts.SpeechFailed, match="只支持 wav/pcm"):
        tts.synthesize("x")


def test_deepseek_pcm_is_wrapped_into_wav(monkeypatch):
    payload = b"\x01\x02" * 1200  # 1200 帧 @24kHz = 50ms

    class FakeResponse:
        status_code = 200
        content = payload

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, headers=None, json=None):
            return FakeResponse()

    monkeypatch.setattr(tts.httpx, "Client", FakeClient)
    monkeypatch.setenv("REBORN_TTS_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("REBORN_TTS_PROTOCOL", "deepseek")
    monkeypatch.setenv("REBORN_TTS_FORMAT", "pcm")

    audio = tts.synthesize("一段话")
    assert audio[:4] == b"RIFF" and audio[8:12] == b"WAVE"
    with wave.open(io.BytesIO(audio)) as handle:
        assert handle.getframerate() == 24000
        assert handle.getnchannels() == 1
        assert handle.getnframes() == 1200


def test_truncated_wav_is_a_failure(monkeypatch):
    full = wav_bytes(1.0)

    class FakeResponse:
        status_code = 200
        content = full[: len(full) // 2]

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, headers=None, json=None):
            return FakeResponse()

    monkeypatch.setattr(tts.httpx, "Client", FakeClient)
    monkeypatch.setenv("REBORN_TTS_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("REBORN_TTS_PROTOCOL", "deepseek")
    with pytest.raises(tts.SpeechFailed, match="中途断开"):
        tts.synthesize("这一页讲变量。")


def test_openai_protocol_unchanged(monkeypatch, captured):
    monkeypatch.setenv("REBORN_TTS_BASE_URL", "http://tts.local")
    monkeypatch.setenv("REBORN_TTS_PROTOCOL", "openai")
    monkeypatch.delenv("REBORN_TTS_FORMAT", raising=False)

    tts.synthesize("这一页讲变量。")

    url, body = captured[0]
    assert url.endswith("/v1/audio/speech")
    assert body["input"] == "这一页讲变量。"
    assert body["response_format"] == "mp3"
    assert body["voice"] == "Meilin"


def test_status_codes_map_to_readable_errors(monkeypatch):
    def respond(status: int):
        class FakeResponse:
            content = b"{}"
            status_code = status

        class FakeClient:
            def __init__(self, **kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def post(self, url, headers=None, json=None):
                return FakeResponse()

        return FakeClient

    monkeypatch.setattr(tts, "_sleep", lambda _s: None)
    monkeypatch.setenv("REBORN_TTS_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("REBORN_TTS_PROTOCOL", "deepseek")
    for status, fragment in ((400, "内容审核"), (429, "并发"), (503, "繁忙"), (504, "繁忙")):
        monkeypatch.setattr(tts.httpx, "Client", respond(status))
        with pytest.raises(tts.SpeechFailed, match=fragment):
            tts.synthesize("这一页讲变量。")


def test_tts_retries_429_and_recovers(monkeypatch):
    payload = wav_bytes(1.0)
    statuses = [429, 503, 200]
    attempts = 0

    class FakeResponse:
        def __init__(self, code: int):
            self.status_code = code
            self.headers = {}
            self.content = payload if code == 200 else b"{}"

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, headers=None, json=None):
            nonlocal attempts
            attempts += 1
            return FakeResponse(statuses.pop(0))

    monkeypatch.setattr(tts, "_sleep", lambda _s: None)
    monkeypatch.setattr(tts.httpx, "Client", FakeClient)
    monkeypatch.setenv("REBORN_TTS_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("REBORN_TTS_PROTOCOL", "deepseek")

    audio = tts.synthesize("这一页讲变量。")
    assert attempts == 3
    assert audio[:4] == b"RIFF"


def test_dashscope_posts_native_body_and_downloads_the_audio(monkeypatch):
    posts: list[tuple[str, dict]] = []
    downloads: list[str] = []
    payload = wav_bytes(1.0)

    class FakeResponse:
        def __init__(self, json_body=None, content=b""):
            self.status_code = 200
            self.content = content
            self._json = json_body

        def json(self):
            return self._json

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, headers=None, json=None):
            posts.append((url, json))
            return FakeResponse({"output": {"audio": {"data": "", "url": "https://oss.example/audio.wav"}}})

        def get(self, url):
            downloads.append(url)
            return FakeResponse(content=payload)

    monkeypatch.setattr(tts.httpx, "Client", FakeClient)
    monkeypatch.setenv("REBORN_TTS_BASE_URL", "https://workspace.cn-beijing.maas.aliyuncs.com")
    monkeypatch.setenv("REBORN_TTS_PROTOCOL", "dashscope")
    monkeypatch.setenv("REBORN_TTS_MODEL", "qwen-audio-3.0-tts-flash")
    monkeypatch.setenv("REBORN_TTS_VOICE", "longanhuan_v3.6")
    monkeypatch.setenv("REBORN_TTS_FORMAT", "wav")

    audio = tts.synthesize("这一页讲变量。")

    url, body = posts[0]
    assert url == "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer"
    assert body == {"model": "qwen-audio-3.0-tts-flash",
                    "input": {"text": "这一页讲变量。", "voice": "longanhuan_v3.6",
                              "format": "wav", "sample_rate": 24000}}
    assert downloads == ["https://oss.example/audio.wav"]
    assert audio[:4] == b"RIFF"


def test_dashscope_rejects_a_format_or_speed_it_cannot_use(monkeypatch):
    monkeypatch.setenv("REBORN_TTS_BASE_URL", "https://workspace.cn-beijing.maas.aliyuncs.com")
    monkeypatch.setenv("REBORN_TTS_PROTOCOL", "dashscope")
    monkeypatch.setenv("REBORN_TTS_FORMAT", "flac")
    with pytest.raises(tts.SpeechFailed, match="mp3/wav/pcm/opus"):
        tts.synthesize("x")
    monkeypatch.setenv("REBORN_TTS_FORMAT", "mp3")
    monkeypatch.setenv("REBORN_TTS_SPEED", "3")
    with pytest.raises(tts.SpeechFailed, match="0.5–2"):
        tts.synthesize("x")


def test_endpoint_accepts_a_full_dashscope_url():
    root = "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer"
    assert tts.endpoint(root, "/api/v1/services/audio/tts/SpeechSynthesizer") == root
    assert tts.endpoint("  https://workspace.cn-beijing.maas.aliyuncs.com  ", "/api/v1/services/audio/tts/SpeechSynthesizer") == root


def test_dashscope_instruction_respects_model_support_and_cosyvoice_weight(monkeypatch):
    posts: list[dict] = []
    payload = wav_bytes(1.0)

    class FakeResponse:
        def __init__(self, json_body=None, content=b""):
            self.status_code = 200
            self.content = content
            self._json = json_body

        def json(self):
            return self._json

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, headers=None, json=None):
            posts.append(json)
            return FakeResponse({"output": {"audio": {"data": "", "url": "https://oss.example/a.wav"}}})

        def get(self, url):
            return FakeResponse(content=payload)

    monkeypatch.setattr(tts.httpx, "Client", FakeClient)
    base = {
        "protocol": "dashscope",
        "base_url": "https://workspace.cn-beijing.maas.aliyuncs.com",
        "api_key": "k",
        "voice": "custom-v1",
        "format": "wav",
        "speed": 1.05,
        "timeout": 30,
    }

    # qwen-audio-3.1-tts-flash supports instruction + rate
    tts.synthesize(
        "这一页讲列表推导式。",
        settings_override={**base, "model": "qwen-audio-3.1-tts-flash", "instruction": "请用自然连贯的大学课堂语气朗读。"},
    )
    assert posts[-1]["input"]["instruction"] == "请用自然连贯的大学课堂语气朗读。"
    assert posts[-1]["input"]["rate"] == 1.05

    # cosyvoice-v3.5-plus trims instruction to 100 weighted chars (50 CJK chars)
    long_cjk = "流畅" * 35  # 70 CJK chars => weight 140
    tts.synthesize(
        "这一页讲函数。",
        settings_override={**base, "model": "cosyvoice-v3.5-plus", "instruction": long_cjk},
    )
    assert len(posts[-1]["input"]["instruction"]) == 50

    # cosyvoice-v2 does not support instruction -> omitted cleanly
    tts.synthesize(
        "这一页讲循环。",
        settings_override={**base, "model": "cosyvoice-v2", "instruction": "请自然朗读"},
    )
    assert "instruction" not in posts[-1]["input"]

    # blank instruction -> omitted even on supported model
    tts.synthesize(
        "这一页讲异常。",
        settings_override={**base, "model": "qwen-audio-3.1-tts-flash", "instruction": "   "},
    )
    assert "instruction" not in posts[-1]["input"]
