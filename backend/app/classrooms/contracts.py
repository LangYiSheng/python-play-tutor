"""Classroom, member and teacher content input contracts."""

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ClassroomInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)

    @field_validator("name")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("班级名称不能为空")
        return value.strip()


class TransferInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    teacher_id: int = Field(gt=0)


class JoinInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    join_code: str = Field(min_length=4, max_length=24)
