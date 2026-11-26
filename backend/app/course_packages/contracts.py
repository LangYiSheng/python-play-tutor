"""HTTP inputs and resource limits for course package exchange."""

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.course_packages.manifest import PackageLimits
from app.models import Activity, Chapter, CourseExample, KnowledgePoint, Material, Question

LIMITS = PackageLimits()


PACKAGE_MODELS = (Chapter, KnowledgePoint, Material, Question, Activity, CourseExample)
EXTRAS = {Material: {"chapter_ids", "task_points", "asset_id", "preview_asset_id"}, Question: {"chapter_ids", "knowledge_point_ids"}, Activity: {"question_ids"}}


JSONL_FILES = {
    Material: "content/materials.jsonl",
    Question: "content/questions/questions-001.jsonl",
    KnowledgePoint: "content/knowledge-points.jsonl",
    CourseExample: "content/examples.jsonl",
}


class AvailablePackageInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    package_key: str = Field(pattern=r"^mounted-[0-9a-f]{64}$", max_length=80)


class ApplyInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    expected_revision: int = Field(ge=0, strict=True)


class CreateFromPackageInput(AvailablePackageInput):
    name: str = Field(min_length=1, max_length=200)
    request_id: UUID
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
