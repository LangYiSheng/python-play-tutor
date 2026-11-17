"""页文本长度 → 「发文本还是发页图」的唯一决策点，生成与校准共用。

2026-11-17 用第 1 讲前 50 页实测（记录见 .local/dev-notes/experiments/）：

- 校准：碎片页（<60 字）不发图时，讲对了的页也会被判 mismatch（第 4 页三圈图），
  或自认「无原文可核对」；发图后 3/3 条 mismatch 经页图核实成立（第 27 页版面、
  第 33 页 score=0.6 的样本数、第 47 页计数）。所以校准对 PDF 与演示文稿都用 <60。
- 生成：演示文稿 ≥60 字的页只发文本时与发图实质等价（第 6/22/37 页），没有出现事实
  错误；<60 字的页必然靠通用知识填充。所以演示文稿生成改为 <60（不再无条件发图）。
- PDF 生成保留 200：60–199 档只发文本会丢页面例子与版面锚点（第 11/39/43 页），
  而 200 这条线本轮没有单独复验，按未测不动保留。
"""

from typing import Literal

from ..models import Material

Purpose = Literal["generation", "calibration"]

# 文本层短于这个长度视为碎片：读页图比读碎文本准确。
TEXT_AS_IMAGE_BELOW = 60
# PDF 生成侧的旧阈值，保留到 60–199 档的阈值实验给出结论。
PDF_TEXT_ONLY_THRESHOLD = 200

IMAGE_POLICY: dict[str, dict[str, int]] = {
    "presentation": {"generation": TEXT_AS_IMAGE_BELOW, "calibration": TEXT_AS_IMAGE_BELOW},
    "pdf": {"generation": PDF_TEXT_ONLY_THRESHOLD, "calibration": TEXT_AS_IMAGE_BELOW},
}
DEFAULT_LIMIT = {"generation": PDF_TEXT_ONLY_THRESHOLD, "calibration": TEXT_AS_IMAGE_BELOW}


def prefers_image(material: Material, page_text: str, *, purpose: Purpose) -> bool:
    limit = IMAGE_POLICY.get(material.kind, DEFAULT_LIMIT)[purpose]
    return len(page_text.strip()) < limit


def policy_fingerprint() -> str:
    """发图策略参与整册指纹：改阈值后不能复用旧报告，也不能跨策略续跑。"""
    rules = ";".join(f"{kind}:{purpose}:{limit}" for kind, entries in sorted(IMAGE_POLICY.items())
                     for purpose, limit in sorted(entries.items()))
    return f"image-policy ({rules}; other:{DEFAULT_LIMIT['generation']}/{DEFAULT_LIMIT['calibration']})"
