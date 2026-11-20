"""阿里语音的模型与常用音色目录。

模型可以走 OpenAI 兼容的 /models 实时拉取；阿里没有公开的音色列表 API，
常用中文音色内置，复刻/设计音色仍可在后台手填。
"""

import httpx

from .contracts import SpeechSettings

FALLBACK_TTS_MODELS = [
    {"id": "qwen-audio-3.1-tts-flash", "name": "Qwen-Audio-3.1-TTS-Flash"},
    {"id": "qwen3-tts-flash", "name": "Qwen3-TTS-Flash"},
    {"id": "qwen3-tts-flash-realtime", "name": "Qwen3-TTS-Flash Realtime"},
    {"id": "qwen-audio-3.1-tts-plus", "name": "Qwen-Audio-3.1-TTS-Plus"},
    {"id": "qwen-audio-3.0-tts-flash", "name": "Qwen-Audio-3.0-TTS-Flash"},
    {"id": "qwen-audio-3.0-tts-plus", "name": "Qwen-Audio-3.0-TTS-Plus"},
    {"id": "cosyvoice-v3.5-plus", "name": "CosyVoice v3.5 Plus"},
    {"id": "cosyvoice-v3.5-flash", "name": "CosyVoice v3.5 Flash"},
    {"id": "cosyvoice-v3-plus", "name": "CosyVoice v3 Plus"},
    {"id": "cosyvoice-v3-flash", "name": "CosyVoice v3 Flash"},
    {"id": "cosyvoice-v2", "name": "CosyVoice v2"},
]

VOICE_CATALOG = [
    {"id": "longanhuan_v3.1", "name": "龙安欢（Qwen 3.1，女）"},
    {"id": "xunanchuan_v3.1", "name": "许南川（Qwen 3.1，男）"},
    {"id": "longanlingxin_v3.1", "name": "龙安灵心（Qwen 3.1，女）"},
    {"id": "longanfengyue_v3.1", "name": "龙安风悦（Qwen 3.1，女）"},
    {"id": "yuxiaoyun_v3.1", "name": "于小云（Qwen 3.1，女）"},
    {"id": "qiaoxiaojiao_v3.1", "name": "乔小娇（Qwen 3.1，女）"},
    {"id": "xiaxiaochen_v3.1", "name": "夏小晨（Qwen 3.1，女）"},
    {"id": "longanyang", "name": "龙安洋（CosyVoice，男）"},
    {"id": "longanhuan_v3", "name": "龙安欢 V3（CosyVoice，女）"},
    {"id": "longhuhu_v3", "name": "龙呼呼（CosyVoice）"},
    {"id": "longpaopao_v3", "name": "龙泡泡（CosyVoice）"},
    {"id": "longling_v3", "name": "龙铃（CosyVoice）"},
    {"id": "longshanshan_v3", "name": "龙闪闪（CosyVoice）"},
    {"id": "longniuniu_v3", "name": "龙牛牛（CosyVoice）"},
    {"id": "longjiaxin_v3", "name": "龙嘉欣（CosyVoice）"},
    {"id": "longjiayi_v3", "name": "龙嘉怡（CosyVoice）"},
]


def catalog_models(config: SpeechSettings) -> tuple[list[dict[str, str]], str]:
    """返回 (模型列表, 来源)。拿不到实时列表时退回内置 TTS 模型。"""
    base = config["base_url"].rstrip("/")
    if not base or not config["api_key"]:
        return FALLBACK_TTS_MODELS, "builtin"
    root = base.split("/compatible-mode")[0]
    url = base + "/models" if base.endswith("/v1") else root + "/compatible-mode/v1/models"
    try:
        with httpx.Client(timeout=10) as client:
            response = client.get(url, headers={"Authorization": f"Bearer {config['api_key']}"})
    except httpx.HTTPError:
        return FALLBACK_TTS_MODELS, "builtin"
    if response.status_code != 200:
        return FALLBACK_TTS_MODELS, "builtin"
    try:
        items = response.json().get("data") or []
    except ValueError:
        return FALLBACK_TTS_MODELS, "builtin"
    live = [{"id": str(item["id"]), "name": str(item["id"])} for item in items
            if isinstance(item, dict) and item.get("id")
            and ("tts" in str(item["id"]).lower() or "cosy" in str(item["id"]).lower())]
    known = {item["id"] for item in live}
    return (live + [item for item in FALLBACK_TTS_MODELS if item["id"] not in known],
            "api" if live else "builtin")
