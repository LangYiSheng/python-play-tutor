"""Portable selections in teaching order. All identifiers are scoped to one course."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.teaching.quick_template.compiler import TEMPLATES
from app.teaching.quick_template.features import ROUTE_FIELDS, route_options
from app.teaching.quick_template.question_plan import PointTotals, StableID, StageKey, StageRule, validate_stage_kinds


class ChapterSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    chapter_id: StableID
    material_ids: list[StableID] = Field(min_length=1, max_length=64)
    knowledge_point_ids: list[StableID] = Field(min_length=1, max_length=65)
    question_plan: dict[StageKey, StageRule] = Field(default_factory=dict)

    @field_validator("material_ids", "knowledge_point_ids")
    @classmethod
    def unique_ids(cls, ids):
        if len(ids) != len(set(ids)):
            raise ValueError("同一章的资料与知识点不能重复选择")
        return ids

    @model_validator(mode="after")
    def check_question_plan(self):
        for stage, rule in self.question_plan.items():
            validate_stage_kinds(stage, rule)
            if isinstance(rule, PointTotals):
                rule.check_selection(self.knowledge_point_ids)
        return self


class Recipe(BaseModel):
    model_config = ConfigDict(extra="forbid")
    template_id: StableID
    dialogue_style: Literal["teaching-sample"] | None = None
    start_chapter_id: StableID | None = None
    final_chapter_id: StableID | None = None
    feature_ids: list[StableID] = Field(default_factory=list)
    chapters: list[ChapterSelection] = Field(min_length=1, max_length=64)
    practice_count: int = Field(strict=True, ge=1, le=100)
    quiz_count: int = Field(strict=True, ge=0, le=100)

    @model_validator(mode="after")
    def check_quiz_count(self):
        if self.template_id not in TEMPLATES:
            raise ValueError("请选择可用的课程模板")
        if ("assessment" in TEMPLATES[self.template_id]) != (self.quiz_count > 0):
            raise ValueError("无测验模板的题量应为零，含测验模板至少需要一道测验题。")
        if self.quiz_count == 0 and any("assessment" in row.question_plan for row in self.chapters):
            raise ValueError("无测验模板不能设置章节测验配题")
        selected = self.model_dump(include=ROUTE_FIELDS, exclude_unset=True)
        if selected:
            if self.template_id != "learn-practice-quiz":
                raise ValueError("起始章、最终章和可选功能用于学课件、做练习、做测验模板")
            route_options(selected, [row.chapter_id for row in self.chapters])
        return self

    @field_validator("chapters")
    @classmethod
    def unique_chapters(cls, rows):
        if len(rows) != len({row.chapter_id for row in rows}):
            raise ValueError("同一章节只能选择一次")
        return rows


class PreviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=1)
    recipe: Recipe


class ApplyInput(PreviewInput):
    token: str = Field(pattern=r"^[a-f0-9]{64}$")
