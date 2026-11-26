"""Permanent account deletion, including private learning data and owned courses."""

from sqlalchemy import delete, or_, select, update

from .course_exchange_models import CourseImportPreview, CoursePackageState
from .course_instances import CONTENT_MODELS
from .deletion_models import ContentDeletionPreview
from .integration_models import AssistantCall, AssistantSession
from .models import (
    Activity, ActivityProgress, AssessmentAttempt, BuildingUnlock, Chapter, ChapterRelease,
    Classroom, CourseInstance, LearningEvent, LearningRecord, MaterialParticipation, Membership, PlayerPosition,
    PlayerQuest, PracticeSession, Question, QuestionSecret, StorySession, Submission,
    TownPreviewStudent, User, WorldFlag,
)
from .narration.models import NarrationJob, NarrationRun, PageNarration

# References to assistant sessions and quests must go before the parent rows.
# The database cascades node states, submission payloads, narration questions and checkpoints.
LEARNER_ROWS = (
    AssistantCall, AssistantSession, LearningEvent, PlayerQuest, StorySession, ActivityProgress,
    LearningRecord, MaterialParticipation, Submission, AssessmentAttempt, PracticeSession, BuildingUnlock, PlayerPosition,
    WorldFlag, Membership,
)


def owned_classroom_ids(db, teacher_id):
    return list(db.scalars(select(Classroom.id).join(CourseInstance).where(CourseInstance.teacher_id == teacher_id).order_by(Classroom.id)))


def delete_account_data(db, account, classroom_ids):
    removed_users = [account.id]
    if account.role == "teacher":
        removed_users.extend(db.scalars(select(TownPreviewStudent.student_user_id).where(
            or_(TownPreviewStudent.teacher_id == account.id, TownPreviewStudent.classroom_id.in_(classroom_ids))
        )))
    for model in LEARNER_ROWS:
        db.execute(delete(model).where(or_(model.user_id.in_(removed_users), model.classroom_id.in_(classroom_ids))))
    course_ids = list(db.scalars(select(CourseInstance.id).where(CourseInstance.teacher_id == account.id)))
    for model in (ContentDeletionPreview, CourseImportPreview):
        db.execute(delete(model).where(model.teacher_id.in_(removed_users)))
    db.execute(delete(TownPreviewStudent).where(TownPreviewStudent.student_user_id.in_(removed_users)))

    if course_ids:
        delete_course_data(db, classroom_ids, course_ids)

    # Attribution in surviving courses and retained import sources is optional.
    for model in CONTENT_MODELS:
        if hasattr(model, "owner_id"):
            db.execute(update(model).where(model.owner_id.in_(removed_users)).values(owner_id=None))
    db.execute(update(PageNarration).where(PageNarration.reviewed_by.in_(removed_users)).values(reviewed_by=None))
    for model in (NarrationJob, NarrationRun):
        db.execute(update(model).where(model.requested_by.in_(removed_users)).values(requested_by=None))
    db.execute(delete(User).where(User.id.in_(removed_users)))


def delete_course_data(db, classroom_ids, instance_ids):
    """Remove course definitions after callers have resolved classroom and history references."""
    question_ids = select(Question.id).where(Question.course_instance_id.in_(instance_ids)).execution_options(include_deleted=True)
    db.execute(delete(ChapterRelease).where(ChapterRelease.classroom_id.in_(classroom_ids)))
    db.execute(delete(ContentDeletionPreview).where(ContentDeletionPreview.course_instance_id.in_(instance_ids)))
    db.execute(delete(CourseImportPreview).where(CourseImportPreview.course_id.in_(instance_ids)))
    db.execute(delete(CoursePackageState).where(CoursePackageState.course_instance_id.in_(instance_ids)))
    db.execute(delete(QuestionSecret).where(QuestionSecret.question_id.in_(question_ids)).execution_options(include_deleted=True))
    # Activity deletion cascades its material and question links. Chapter comes after its definitions.
    for model in (Activity, *(model for model in CONTENT_MODELS if model not in (Activity, Chapter)), Chapter):
        db.execute(delete(model).where(model.course_instance_id.in_(instance_ids)))
    db.execute(delete(Classroom).where(Classroom.id.in_(classroom_ids)))
    db.execute(delete(CourseInstance).where(CourseInstance.id.in_(instance_ids)))
