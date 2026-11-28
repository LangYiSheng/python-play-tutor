"""Strict Pydantic v2 request/response schemas for Course Studio HTTP APIs."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..coding_questions import CODING_TYPES
from .engine import coding_exercises as coding_exercises_engine
from .engine import exercises as exercises_engine

_ALLOWED_OBJECTIVE_ALIASES = frozenset(
    {"single", "single_choice", "multiple", "multiple_choice", "true_false", "boolean", "judge", "fill_blank", "fill", "blank"}
)


class JobProgress(BaseModel):
    model_config = ConfigDict(extra="forbid")

    done: int = 0
    total: int = 0
    message: str = ""


class JobSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    course_instance_id: int
    kind: str
    scope_key: str
    status: str
    progress: JobProgress
    result: dict[str, Any] | None = None
    error: str = ""
    cancel_requested: bool = False
    retried: bool = False
    started_at: str | None = None
    finished_at: str | None = None
    created_at: str
    updated_at: str


class JobOutputQuestion(BaseModel):
    id: str
    title: str


class JobDetail(JobSnapshot):
    output_questions: list[JobOutputQuestion]


class JobListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    jobs: list[JobSnapshot]


class PacingSectionItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    section: str
    target_minutes: float
    pages: list[int]
    chars: int
    budget: int
    seconds: float


class PacingPageItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page: int
    section: str
    kind: str
    chars: int
    budget: int
    pauses: int
    seconds: float
    over: bool
    severe: bool
    under: bool


class PacingPreviewResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    material_id: int
    summary: str
    total_chars: int
    total_seconds: float
    formatted_time: str
    section_minutes: float
    chapter_minutes: float
    sections: list[PacingSectionItem]
    pages: list[PacingPageItem]


class KnowledgeExtractRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    material_ids: list[int] | None = Field(default=None, max_length=50)

    @field_validator("material_ids")
    @classmethod
    def check_material_ids(cls, value: list[int] | None) -> list[int] | None:
        if value is not None and any(type(item) is not int or item < 1 for item in value):
            raise ValueError("资料 ID 必须为正整数")
        return list(dict.fromkeys(value)) if value is not None else None


class KnowledgeSourceItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    material_id: int
    material_title: str
    pages: list[int]


class KnowledgePointSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    stable_id: str
    chapter_id: int
    title: str
    section: str = ""
    brief: str = ""
    question_count: int = 0
    sources: list[KnowledgeSourceItem] = Field(default_factory=list)


class ChapterMaterialSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    stable_id: str
    title: str
    kind: str
    pages: int


class ChapterKnowledgeSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    stable_id: str
    title: str
    order_index: int
    materials: list[ChapterMaterialSummary]
    points: list[KnowledgePointSummary]


class KnowledgeOverviewResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chapters: list[ChapterKnowledgeSummary]


class PointQuotaInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    knowledge_point_id: int = Field(ge=1, strict=True)
    single: int = Field(default=0, ge=0, le=20)
    multiple: int = Field(default=0, ge=0, le=20)
    true_false: int = Field(default=0, ge=0, le=20)
    fill_blank: int = Field(default=0, ge=0, le=20)


ExerciseDifficulty = Literal["balanced", "foundational", "challenging"]


class ExerciseGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    material_id: int | None = Field(default=None, ge=1)
    counts: dict[str, int] | None = None
    point_quotas: list[PointQuotaInput] | None = Field(default=None, max_length=60)
    difficulty: ExerciseDifficulty = "balanced"

    @field_validator("counts")
    @classmethod
    def check_counts(cls, value: dict[str, int] | None) -> dict[str, int] | None:
        if value is None:
            return None
        cleaned: dict[str, int] = {}
        for key, raw in value.items():
            norm = str(key or "").strip().lower()
            canon = exercises_engine.canonical_type(norm)
            if norm not in _ALLOWED_OBJECTIVE_ALIASES or canon not in exercises_engine.OBJECTIVE_TYPES:
                raise ValueError("AI 智能出题仅支持单选、多选、判断、单空填空四类客观题，不支持简答题")
            if raw < 0 or raw > 30:
                raise ValueError("单题型生成数量需在 0 到 30 之间")
            if raw > 0:
                cleaned[canon] = cleaned.get(canon, 0) + int(raw)
        return cleaned

    @model_validator(mode="after")
    def require_target(self) -> ExerciseGenerateRequest:
        has_counts = bool(self.counts and sum(self.counts.values()) > 0)
        has_quotas = bool(
            self.point_quotas
            and any((q.single + q.multiple + q.true_false + q.fill_blank) > 0 for q in self.point_quotas)
        )
        if not has_counts and not has_quotas:
            raise ValueError("请至少设置一种客观题题量或知识点配额")
        return self


class ExerciseValidateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: bool
    total: int
    skipped_non_objective: int = 0
    errors: list[str]
    warnings: list[str]


CodingDifficulty = Literal["balanced", "易", "中", "难"]
CodingUsage = Literal["both", "practice", "assessment"]


class CodingExerciseGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    material_id: int | None = Field(default=None, ge=1)
    counts: dict[str, int]
    difficulty: CodingDifficulty = "balanced"
    usage: CodingUsage = "both"
    knowledge_point_ids: list[int] | None = Field(default=None, max_length=20)
    allowed_syntax_note: str = Field(default="", max_length=400)
    enable_blind_solve: bool = True

    @field_validator("counts")
    @classmethod
    def check_coding_counts(cls, value: dict[str, int]) -> dict[str, int]:
        cleaned: dict[str, int] = {}
        for key, raw in value.items():
            norm = str(key or "").strip().lower()
            if norm not in CODING_TYPES:
                raise ValueError("编程题形式仅支持 fill_code（程序填空）、debug（程序改错）和 design（程序设计）")
            if type(raw) is not int or raw < 0 or raw > coding_exercises_engine.MAX_PER_CODING_TYPE:
                raise ValueError(f"单种编程形式生成数量需在 0 到 {coding_exercises_engine.MAX_PER_CODING_TYPE} 之间")
            if raw > 0:
                cleaned[norm] = cleaned.get(norm, 0) + raw
        total = sum(cleaned.values())
        if total <= 0:
            raise ValueError("请至少设置一种编程题形式的生成数量")
        if total > coding_exercises_engine.MAX_TOTAL_CODING_PER_JOB:
            raise ValueError(f"单次 AI 编程出题最多生成 {coding_exercises_engine.MAX_TOTAL_CODING_PER_JOB} 道，请分批生成")
        return cleaned

    @field_validator("knowledge_point_ids")
    @classmethod
    def check_kp_ids(cls, value: list[int] | None) -> list[int] | None:
        if value is not None and any(type(item) is not int or item < 1 for item in value):
            raise ValueError("知识点 ID 必须为正整数")
        return list(dict.fromkeys(value)) if value is not None else None


ExamSectionType = Literal[
    "single", "multiple", "true_false", "fill_blank",
    "single_choice", "multiple_choice", "boolean", "fill",
]


class ExamSectionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: ExamSectionType
    count: int = Field(ge=1, le=200)
    scoreEach: float = Field(gt=0, le=100)


class ExamGapsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chapter_ids: list[int] = Field(min_length=1, max_length=100)
    sections: list[ExamSectionInput] = Field(min_length=1, max_length=10)
    ab_mode: bool = False
    max_overlap_rate: float = Field(default=0.0, ge=0.0, le=0.5)
    include_unreviewed: bool = False

    @field_validator("chapter_ids")
    @classmethod
    def unique_chapters(cls, value: list[int]) -> list[int]:
        if any(type(cid) is not int or cid < 1 for cid in value):
            raise ValueError("章节 ID 必须为正整数")
        return list(dict.fromkeys(value))


class ExamGenerateRequest(ExamGapsRequest):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=80)
    subtitle: str = Field(default="", max_length=80)
    exam_mode: str = Field(default="闭卷", max_length=20)
    duration_minutes: int = Field(default=90, ge=15, le=300)
    total_score: float = Field(default=100, gt=0, le=500)
    chapter_weights: dict[int, float] | None = None


class ExamFillGapsRequest(ExamGapsRequest):
    model_config = ConfigDict(extra="forbid")

    multiplier: int = Field(default=1, ge=1, le=3)


class ExamPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=80)
    subtitle: str | None = Field(default=None, max_length=80)
    examMode: str | None = Field(default=None, max_length=20)
    durationMinutes: int | None = Field(default=None, ge=15, le=300)
    action: Literal["replace", "move", "score", "remove", "add"] | None = None
    variant: Literal["A", "B"] = "A"
    uid: str | None = None
    candidateId: str | None = None
    candidateChapter: str | None = None
    direction: Literal["up", "down"] | None = None
    score: float | None = Field(default=None, gt=0, le=100)
