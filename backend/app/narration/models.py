"""Narration rows stay outside `Material.content` so teacher review survives re-uploads."""

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base
from ..models import now

# draft   : AI-written (or teacher-written) and not visible to students
# accepted: teacher approved; the only status students may use
# rejected: teacher refused this draft
# unavailable: the page has no text and no image input, so nothing can be authored
# stale   : the page text changed after this row was written; review is void
STATUSES = frozenset({"draft", "accepted", "rejected", "unavailable", "stale"})
# Course packages preserve all statuses; student visibility remains approval-only.
VISIBLE_STATUSES = frozenset({"accepted"})
# 整理稿（page_contents）：与讲解稿的审校状态分开，stale 表示原文已变。
CONTENT_STATUSES = frozenset({"draft", "accepted", "stale"})
CONTENT_SOURCES = frozenset({"parsed", "ai", "teacher"})
IMAGE_STATES = frozenset({"sent", "policy", "skipped", "render_failed"})


class PageNarration(Base):
    __tablename__ = "page_narrations"
    __table_args__ = (UniqueConstraint("material_id", "page_no", name="uq_page_narrations_material_page"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id", ondelete="CASCADE"), index=True)
    page_no: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text, default="")
    bridge_in: Mapped[str] = mapped_column(Text, default="")
    target_seconds: Mapped[int] = mapped_column(Integer, default=90)
    status: Mapped[str] = mapped_column(String(24), default="draft")

    # Provenance and idempotency: what was read, how it was produced.
    source: Mapped[str] = mapped_column(String(24), default="teacher")
    page_hash: Mapped[str] = mapped_column(String(64), default="")
    input_hash: Mapped[str] = mapped_column(String(64), default="")
    prompt_version: Mapped[str] = mapped_column(String(24), default="")
    model: Mapped[str] = mapped_column(String(80), default="")
    image_used: Mapped[bool] = mapped_column(Boolean, default=False)
    anchors: Mapped[list] = mapped_column(JSON, default=list)

    # Review audit: who approved which wording, and when.
    reviewed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    edited_by_teacher: Mapped[bool] = mapped_column(Boolean, default=False)

    # Audio is derived from the approved wording; the hash makes stale audio unusable.
    audio_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    audio_text_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    audio_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    audio_voice: Mapped[str | None] = mapped_column(String(200), nullable=True)
    audio_model: Mapped[str | None] = mapped_column(String(120), nullable=True)
    audio_created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class PageContent(Base):
    """组织后的每页原文（RAG chunk）与其结构化字段；原始解析文本仍在 `Material.content`。"""

    __tablename__ = "page_contents"
    __table_args__ = (UniqueConstraint("material_id", "page_no", name="uq_page_contents_material_page"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id", ondelete="CASCADE"), index=True)
    page_no: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(120), default="")
    topic: Mapped[str] = mapped_column(String(240), default="")
    tags: Mapped[list] = mapped_column(JSON, default=list)
    text: Mapped[str] = mapped_column(Text, default="")
    # 原文指纹：只算 raw 文本，重传同一份课件不算 stale。
    raw_text_hash: Mapped[str] = mapped_column(String(64), default="")
    source: Mapped[str] = mapped_column(String(16), default="parsed")  # parsed|ai|teacher
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft|accepted|stale
    # 本页组织时到底带没带页图：sent|policy|skipped|render_failed。
    image_state: Mapped[str] = mapped_column(String(16), default="policy")
    model: Mapped[str] = mapped_column(String(80), default="")
    prompt_version: Mapped[str] = mapped_column(String(24), default="")
    input_hash: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class MaterialTagDict(Base):
    """课程级 tag 字典：别名指向标准名，跨资料共享，避免同一门课里标签分裂。"""

    __tablename__ = "material_tag_dicts"
    __table_args__ = (UniqueConstraint("course_instance_id", "alias", name="uq_material_tag_dicts_course_alias"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    course_instance_id: Mapped[int] = mapped_column(ForeignKey("course_instances.id", ondelete="CASCADE"), index=True)
    alias: Mapped[str] = mapped_column(String(80))
    canonical: Mapped[str] = mapped_column(String(80))
    source_material_id: Mapped[int | None] = mapped_column(ForeignKey("materials.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class NarrationQuestion(Base):
    """One student question about one page; the audit trail doubles as the daily cap."""
    __tablename__ = "narration_questions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id", ondelete="CASCADE"), index=True)
    page_no: Mapped[int] = mapped_column(Integer)
    question: Mapped[str] = mapped_column(Text, default="")
    answer: Mapped[str] = mapped_column(Text, default="")
    cites: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class NarrationCalibration(Base):
    """The latest whole-deck review of one material: a report, not a rewrite."""
    __tablename__ = "narration_calibrations"

    id: Mapped[int] = mapped_column(primary_key=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id", ondelete="CASCADE"), index=True)
    report: Mapped[dict] = mapped_column(JSON, default=dict)
    windows: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    applied_pages: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class NarrationJob(Base):
    """每份资料一行的工作状态，用来挡住重复触发，也让前端能显示进度。

    状态只在数据库里，所以重启、多进程都不会丢；心跳超过阈值就认为上一次已经死掉，
    允许接管（否则一个崩掉的进程会把资料永久锁住）。
    """
    __tablename__ = "narration_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id", ondelete="CASCADE"), unique=True, index=True)
    kind: Mapped[str] = mapped_column(String(24), default="")
    status: Mapped[str] = mapped_column(String(16), default="idle")  # idle|running|done|failed
    requested_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    progress: Mapped[dict] = mapped_column(JSON, default=dict)
    message: Mapped[str] = mapped_column(Text, default="")


class NarrationRun(Base):
    """One durable record per attempt; the material job above remains the execution lock."""
    __tablename__ = "narration_runs"
    __table_args__ = (UniqueConstraint("material_id", "started_at", name="uq_narration_runs_attempt"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(24), default="")
    status: Mapped[str] = mapped_column(String(16), default="running")
    requested_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancel_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    progress: Mapped[dict] = mapped_column(JSON, default=dict)
    message: Mapped[str] = mapped_column(Text, default="")


VOICE_STATUSES = frozenset({"processing", "ready", "failed"})
MATERIAL_VOICE_MODES = frozenset({"auto", "system", "custom"})


class TeacherVoice(Base):
    """Teacher-owned cloned or custom TTS voice, isolated per teacher account."""

    __tablename__ = "teacher_voices"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    provider: Mapped[str] = mapped_column(String(32), default="dashscope")
    target_model: Mapped[str] = mapped_column(String(120), default="")
    provider_voice_id: Mapped[str] = mapped_column(String(200), default="")
    status: Mapped[str] = mapped_column(String(24), default="ready")
    error: Mapped[str] = mapped_column(Text, default="")
    sample_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    sample_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class MaterialNarrationSetting(Base):
    """Per-material voice override so a teacher can pick a cloned voice or system default."""

    __tablename__ = "material_narration_settings"

    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id", ondelete="CASCADE"), primary_key=True)
    voice_mode: Mapped[str] = mapped_column(String(16), default="auto")
    teacher_voice_id: Mapped[int | None] = mapped_column(
        ForeignKey("teacher_voices.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    speech_instruction: Mapped[str | None] = mapped_column(String(200), nullable=True)
    speech_speed: Mapped[float | None] = mapped_column(Float, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
