"""Narration editing and explicit synthesis request contracts."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

StylePreset = Literal["natural", "concise", "conversational"]


class NarrationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str
    target_seconds: int | None = None


class DigestInput(BaseModel):
    """审校页手工修正整理稿的标题、主题、标签与正文。"""

    model_config = ConfigDict(extra="forbid")
    title: str | None = None
    topic: str | None = None
    tags: list[str] | None = None
    text: str | None = Field(default=None, max_length=12000)


class GenerateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    first_page: int
    last_page: int
    target_seconds: int | None = None
    # serial：把已生成的页作为上下文，过渡句才有依据；independent：每页独立（旧行为）。
    mode: Literal["independent", "serial"] = "independent"
    style_preset: StylePreset = "natural"
    custom_style: str = Field(default="", max_length=1500)
    section_minutes: float | None = Field(default=None, gt=0, le=120)
    chapter_minutes: float | None = Field(default=None, gt=0, le=600)
    use_pacing: bool = False


class RangeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    first_page: int | None = None
    last_page: int | None = None


class PageGenerateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_seconds: int | None = None
    style_preset: StylePreset = "natural"
    custom_style: str = Field(default="", max_length=1500)
    section_minutes: float | None = Field(default=None, gt=0, le=120)
    chapter_minutes: float | None = Field(default=None, gt=0, le=600)
    use_pacing: bool = False


class PipelineInput(BaseModel):
    """一键梳理可选脚本参数（风格与节奏预算）。"""

    model_config = ConfigDict(extra="forbid")
    target_seconds: int | None = None
    style_preset: StylePreset = "natural"
    custom_style: str = Field(default="", max_length=1500)
    section_minutes: float | None = Field(default=None, gt=0, le=120)
    chapter_minutes: float | None = Field(default=None, gt=0, le=600)
    use_pacing: bool = False
