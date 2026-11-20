"""Prepare and publish a template under the existing classroom content lock."""

from collections import Counter
from hmac import compare_digest

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError

from app.authoring_diagnostics import AuthoringIssue
from app.authoring_protection import publication_plan
from app.characters import validate_characters
from app.course_content.snapshot import snapshot_content, stable_id
from app.course_exchange_models import CoursePackageState
from app.course_instances import MODEL_NAMES, remap_references
from app.models import Chapter, CourseInstance, KnowledgePoint, Material, MaterialChapter, Question, QuestionChapter, QuestionKnowledgePoint
from app.practice_rules import QuestionShortages, practice_question_available
from app.teacher_scope import teacher_course_scope
from app.teaching.authoring.validation import validate_configuration
from app.teaching.quests.validation import validate_definition
from app.teaching.quick_template.compiler import compile_template, eligible_material, template_catalog
from app.teaching.quick_template.features import route_options
from app.teaching.quick_template.persistence import protect_learning, runtime_ids, write_plan
from app.teaching.quick_template.plan import digest, merge_course
from app.teaching.quick_template.question_plan import ASSESSMENT_KINDS
from app.teaching.story.dialogue import render_dialogue
from app.world_config import interaction_points


STATE_KEY = "_quick_orchestration"


def _course(db, user, classroom_id, *, exclusive=False):
    classroom, key = teacher_course_scope(db, user, classroom_id, exclusive=exclusive)
    query = select(CourseInstance).where(CourseInstance.id == key)
    instance = db.scalar((query.with_for_update() if exclusive else query).execution_options(populate_existing=True))
    return classroom, instance, db.get(CoursePackageState, key)


def get_editor(db, user, classroom_id):
    classroom, instance, state = _course(db, user, classroom_id)

    def selectable(model):
        return model.course_instance_id == instance.id, or_(model.owner_id.is_(None), model.owner_id == classroom.teacher_id)

    chapters = {
        row.id: {"id": row.stable_id, "title": row.title, "materials": [], "knowledge_points": []}
        for row in db.scalars(select(Chapter).where(*selectable(Chapter)).order_by(Chapter.order_index, Chapter.id))
    }
    point_counts = {}
    for point in db.scalars(select(KnowledgePoint).where(*selectable(KnowledgePoint)).order_by(KnowledgePoint.id)):
        if point.chapter_id in chapters:
            counts = {"practice": {}, "assessment": {}}
            point_counts[point.id] = counts
            chapters[point.chapter_id]["knowledge_points"].append({"id": point.stable_id, "title": point.title, "available_questions": counts})
    # Both chapter and point associations must match, including for cross-tagged questions.
    has_samples = Question.samples[0].as_string().is_not(None)
    bank = (
        select(KnowledgePoint.id, Question.kind, has_samples, func.count())
        .select_from(KnowledgePoint)
        .join(QuestionKnowledgePoint, QuestionKnowledgePoint.knowledge_point_id == KnowledgePoint.id)
        .join(Question, Question.id == QuestionKnowledgePoint.question_id)
        .join(QuestionChapter, and_(QuestionChapter.question_id == Question.id, QuestionChapter.chapter_id == KnowledgePoint.chapter_id))
        .where(*selectable(KnowledgePoint), *selectable(Question), Question.status == "ready")
        .group_by(KnowledgePoint.id, Question.kind, has_samples)
    )
    for point_id, kind, samples, count in db.execute(bank):
        if point_id in point_counts:
            counts = point_counts[point_id]
            if kind in ASSESSMENT_KINDS:
                counts["assessment"][kind] = counts["assessment"].get(kind, 0) + count
            if practice_question_available(kind, "ready", samples):
                counts["practice"][kind] = counts["practice"].get(kind, 0) + count
    materials = select(MaterialChapter.chapter_id, Material).join(Material, Material.id == MaterialChapter.material_id).where(
        *selectable(Material), Material.kind.in_(("presentation", "pdf"))
    ).order_by(Material.id)
    for chapter_id, row in db.execute(materials):
        if chapter_id in chapters:
            available = eligible_material({"status": row.status, "kind": row.kind, "content": row.content,
                                           "asset_id": row.storage_key, "preview_asset_id": row.content.get("preview_key")})
            chapters[chapter_id]["materials"].append({"id": row.stable_id, "title": row.title, "available": available})
    saved = state.configuration.get(STATE_KEY, {}) if state else {}
    recipe = saved.get("recipe")
    return {"revision": instance.revision, "recipe": recipe, "chapters": list(chapters.values()),
            "templates": template_catalog(recipe["template_id"] if recipe else None)}


def _paper_summaries(chapters, generated_activities, data):
    """Count the actual fixed papers after merging any edits made in the activity editor."""
    papers = {chapter["chapter_id"]: {"chapter_id": chapter["chapter_id"]} for chapter in chapters}
    activities = {activity["id"]: activity for activity in data["activity"]}
    kinds = {question["id"]: question["kind"] for question in data["question"]}
    for generated in generated_activities:
        stage = generated["kind"]
        if stage not in {"practice", "assessment"}:
            continue
        activity = activities[generated["id"]]
        if rules := activity["content"].get("practice_rules"):
            initial = sum(max(goal.get("total", 0), sum(goal.get("by_kind", {}).values())) for goal in rules["goals"])
            summary = {"count": initial, "by_kind": {}, "individual": True, "point_counts": {
                g["knowledge_point_id"]: max(g.get("total", 0), sum(g.get("by_kind", {}).values())) for g in rules["goals"]
            }}
        else:
            questions = activity["question_ids"]
            summary = {"count": len(questions), "by_kind": dict(Counter(kinds[question] for question in questions))}
        papers[generated["chapter_id"]][stage] = summary
    return list(papers.values())


def _sample_dialogue(generated, data, chapter_id, node_ids, course_name):
    main_quests = {q["id"] for q in generated["quest"] if q["chapter_id"] == chapter_id and q["definition"].get("kind", "main") == "main"}
    flow_ids = {s["id"] for s in generated["story"] if s["quest_id"] in main_quests}
    lines = {n["id"]: n.get("text") for s in data["story"] if s["id"] in flow_ids for n in s["content"]["nodes"]}
    for node_id in node_ids:
        if line := lines.get(node_id):
            title = next(c["title"] for c in data["chapter"] if c["id"] == chapter_id)
            return render_dialogue(line, name="同学", course_name=course_name, chapter_name=title)
    return None


def _prepare(db, user, classroom, instance, state, body):
    if body.expected_revision != instance.revision:
        raise HTTPException(409, "课程已更新，请重新加载后预览")
    data, _, releases, config, rows = snapshot_content(db, instance, include_secrets=False)
    recipe = body.recipe.model_dump(exclude_unset=True)
    saved = state.configuration.get(STATE_KEY, {}) if state else {}
    plan, maps, impact, welcome, closing = None, None, None, None, None
    blockers, papers, quests, adjustments = [], [], [], []
    try:
        sources = dict(data)
        for model in (Chapter, KnowledgePoint, Material, Question):
            allowed = {stable_id(row) for row in rows[model] if row.owner_id in (None, classroom.teacher_id)}
            kind = MODEL_NAMES[model]
            sources[kind] = [row for row in data[kind] if row["id"] in allowed]
        generated = compile_template(sources, recipe, owned_quests=saved.get("owned", {}).get("quest", {}), adjustments=adjustments)
        plan = merge_course(data, config, releases, generated, recipe, saved)
        maps = runtime_ids(db, instance, plan)
        changed_objectives = protect_learning(db, instance.classroom_id, plan, maps)
        blockers = plan.blockers
        if not blockers:
            if len(plan.data["story"]) > 500 or len(plan.data["quest"]) > 500:
                raise ValueError("本班最多可维护500条流程和500项任务，请减少本次章节数量。")
            first_id = recipe["chapters"][0]["chapter_id"]
            welcome = _sample_dialogue(generated, plan.data, first_id, ("welcome-mayor", "invite-lesson"), instance.name)
            if recipe["template_id"] == "learn-practice-quiz":
                final_id, _ = route_options(recipe, [c["chapter_id"] for c in recipe["chapters"]])
                if final_id:
                    closing = _sample_dialogue(generated, plan.data, final_id, ("report",), instance.name)
            validate_characters(plan.data["npc"], config.get("_assets", []))
            validate_configuration(plan.configuration, plan.data)
            objects = set(interaction_points()) | {row["id"] for row in plan.configuration["world"]["interactions"]}
            for row in plan.data["quest"]:
                validate_definition(remap_references(row["definition"], maps), objects=objects)
            _validate_releases(plan)
            diagnostics, plan.reset = publication_plan(db, instance, plan.data, maps, plan.configuration, changed_activity_ids=changed_objectives)
            blockers.extend(issue["message"] for issue in diagnostics)
            impact = plan.reset.impact(instance, user.id, recipe)
            if not blockers:
                papers = _paper_summaries(recipe["chapters"], generated["activity"], plan.data)
                if adjustments:
                    # The activity editor may have its own saved paper or practice goals.
                    by_chapter = {paper["chapter_id"]: paper for paper in papers}
                    adjustments = [item for item in adjustments
                                   if by_chapter[item["chapter_id"]][item["stage"]]["count"] == item["effective"]]
                generated_quests = {row["id"] for row in generated["quest"]}
                activity_titles = {row["id"]: row["title"] for row in plan.data["activity"]}
                quests = [{"id": row["id"], "chapter_id": row["chapter_id"], "title": row["title"],
                           "available_after": activity_titles.get(row["definition"].get("when", {}).get("activity_completed")),
                           "kind": row["definition"].get("kind", "main"), "goals": [node["title"] for node in row["definition"]["nodes"]]}
                          for row in plan.data["quest"] if row["id"] in generated_quests]
    except AuthoringIssue as exc:
        blockers.append(exc.diagnostic()["message"])
    except QuestionShortages as exc:
        blockers.extend(exc.messages)
    except ValueError as exc:
        blockers.append(str(exc))
    changes = plan.counts() if plan else {"added": 0, "updated": 0, "removed": 0}
    token = None if blockers else digest([user.id, instance.id, instance.revision, recipe, plan.edits, impact])
    return {"token": token, "blockers": blockers, "adjustments": adjustments, "changes": changes, "reset_impact": impact,
            "welcome_dialogue": welcome, "closing_dialogue": closing, "papers": papers, "quests": quests}, plan, maps


def _validate_releases(plan):
    indexed = {row["chapter_id"]: row for row in plan.releases}
    removed = {key for key, (_, after) in plan.edits["releases"].items() if after is None}
    for key in indexed:
        seen = set()
        while key in indexed:
            if key in seen:
                raise ValueError("所选顺序与已有章节前置形成循环，请核对章节开放设置。")
            seen.add(key)
            key = indexed[key]["prerequisite_chapter_id"]
            if key in removed:
                raise ValueError("其他章节仍依赖即将撤下的章节，请先调整其前置章节。")


def preview(db, user, classroom_id, body):
    classroom, instance, state = _course(db, user, classroom_id)
    result, _, _ = _prepare(db, user, classroom, instance, state, body)
    return result


def apply(db, user, classroom_id, body):
    classroom, instance, state = _course(db, user, classroom_id, exclusive=True)
    saved = state.configuration.get(STATE_KEY, {}) if state else {}
    receipt = {"teacher": user.id, "expected_revision": body.expected_revision, "token": body.token}
    if saved.get("receipt") == receipt and saved.get("recipe") == body.recipe.model_dump(exclude_unset=True) and instance.revision == body.expected_revision + 1:
        return {"revision": instance.revision}
    result, plan, maps = _prepare(db, user, classroom, instance, state, body)
    if result["blockers"]:
        raise HTTPException(409, result["blockers"][0])
    if not compare_digest(result["token"], body.token):
        raise HTTPException(409, "课程内容或学生进度已变化，请重新预览后生成。")
    if not any(plan.edits.values()) and all(saved.get(key) == value for key, value in plan.metadata.items()):
        return {"revision": instance.revision}
    try:
        write_plan(db, classroom, instance, plan, maps)
        if state is None:
            state = CoursePackageState(course_instance_id=instance.id, configuration={})
            db.add(state)
        state.configuration = {**state.configuration, "world": plan.configuration["world"], "buildings": plan.configuration["buildings"],
                               STATE_KEY: {**plan.metadata, "receipt": receipt}}
        instance.revision += 1
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "课程引用已变化，请重新预览后生成。") from exc
    return {"revision": instance.revision}
