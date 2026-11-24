"""Compile a teacher's chapter selections into portable, class-scoped game definitions."""

from hashlib import sha256

from app.practice_rules import QuestionShortages, practice_question_available
from app.teaching.quick_template.features import FEATURES, feature_catalog, route_options
from app.teaching.quick_template.itinerary import STAGES, chapter_journey, characters, public_route, signpost
from app.teaching.quick_template.question_plan import ASSESSMENT_KINDS, practice_goals, select_questions
from app.teaching.quick_template.room_itinerary import add_room_itinerary
from app.teaching.quick_template.town_itinerary import ROOMS, town_cast, town_chapter, town_farewell, town_public


TEMPLATES = {
    "learn-practice-quiz": ("lesson", "practice", "assessment"),
    "learn-practice": ("lesson", "practice"),
}


def template_catalog(saved_template=None):
    templates = []
    for template_id, kinds in TEMPLATES.items():
        if template_id != "learn-practice-quiz" and template_id != saved_template:
            continue
        stages = [{"kind": kind, "label": STAGES[kind].label,
                   "location": ROOMS[kind][1] if template_id == "learn-practice-quiz" else STAGES[kind].location} for kind in kinds]
        options = feature_catalog() if template_id == "learn-practice-quiz" else []
        templates.append({"id": template_id, "title": "、".join(stage["label"] for stage in stages), "stages": stages, "features": options})
    return templates


def eligible_material(row):
    return bool(
        row["status"] == "ready" and row["kind"] in {"presentation", "pdf"}
        and row.get("asset_id") and row["content"].get("pages")
        and (row["kind"] == "pdf" or row.get("preview_asset_id"))
    )


def chapter_prefix(chapter_id):
    return "quick-" + sha256(chapter_id.encode()).hexdigest()[:24]


def _selected_ids(values, limit, label):
    if not isinstance(values, list) or not 1 <= len(values) <= limit:
        raise ValueError(f"{label}需要选择 1 至 {limit} 项")
    if any(not isinstance(value, str) or not value for value in values) or len(set(values)) != len(values):
        raise ValueError(f"{label}含无效或重复选择")
    return values


def _chapter_activities(selection, chapter, points, materials, questions, practice_count, quiz_count, prefix, stages, legacy_practice, adjustments):
    title, chapter_id = chapter["title"], chapter["id"]
    point_ids = _selected_ids(selection["knowledge_point_ids"], 65, f"「{title}」的知识点")
    for key in point_ids:
        if key not in points or points[key]["chapter_id"] != chapter_id:
            raise ValueError(f"「{title}」有知识点已移除或属于其他章节，请重新选择")
    material_ids = _selected_ids(selection["material_ids"], 64, f"「{title}」的课件")
    for key in material_ids:
        material = materials.get(key)
        if not material or chapter_id not in material["chapter_ids"] or not eligible_material(material):
            raise ValueError(f"「{title}」有课件尚未就绪、无法阅读或不属于该章节，请重新选择")

    selected_points = set(point_ids)
    quiz_pool, practice_pool, kinds = {}, {}, {}
    for row in questions:
        tags = selected_points.intersection(row["knowledge_point_ids"])
        if row["status"] != "ready" or not tags:
            continue
        if row["kind"] in ASSESSMENT_KINDS:
            quiz_pool[row["id"]] = tags
        kinds[row["id"]] = row["kind"]
        if practice_question_available(row["kind"], row["status"], bool(row["samples"])):
            practice_pool[row["id"]] = tags
    plan = selection.get("question_plan", {})
    point_titles = {key: points[key]["title"] for key in point_ids}
    sets = {"lesson": []}
    shortages = []
    for stage, label, default_count, pool in (("practice", "练习", practice_count, practice_pool), ("assessment", "测验", quiz_count, quiz_pool)):
        if stage not in stages:
            continue
        rule = plan.get(stage)
        practice = sets.get("practice", [])
        try:
            selected = select_questions(pool, kinds, point_titles, default_count, rule, f"「{title}」的{label}", stage=stage, avoid=practice,
                                        earlier_points=(tag for key in practice for tag in practice_pool[key]))
        except QuestionShortages as exc:
            shortages.extend(exc.messages)
            continue
        sets[stage] = selected
        if adjustments is not None and rule is None and len(selected) < default_count:
            adjustments.append({"chapter_id": chapter_id, "stage": stage, "requested": default_count, "effective": len(selected)})
    if shortages:
        raise QuestionShortages(shortages)
    resources = [{"material_id": key, "required": True, "learning": {"reading": {"scope": "all"}}} for key in material_ids]
    practice_content = {}
    if not legacy_practice:
        goals = practice_goals(sets["practice"], practice_pool, kinds, point_titles, plan.get("practice"))
        practice_content = {"practice_rules": {"goals": goals}, "knowledge_point_ids": [g["knowledge_point_id"] for g in goals]}
        sets["practice"] = []
    return [{
        "id": f"{prefix}-{kind}", "chapter_id": chapter_id, "title": f"{STAGES[kind].label} · {title}"[:200], "kind": kind,
        "npc_key": STAGES[kind].npc_id, "assistant_allowed": kind != "assessment",
        "content": {"knowledge_point_ids": point_ids, "published": True, **(practice_content if kind == "practice" else {})}, "question_ids": sets[kind],
        "resources": resources if kind == "lesson" else [],
    } for kind in stages]


def compile_template(data, recipe, *, legacy_practice=False, legacy_itinerary=False, owned_quests=(), adjustments=None):
    """Return only template-owned rows. The caller merges and validates before publishing."""
    stages = TEMPLATES.get(recipe["template_id"])
    if not stages:
        raise ValueError("请选择可用的课程模板")
    practice_count, quiz_count = recipe["practice_count"], recipe["quiz_count"]
    if type(practice_count) is not int or not 1 <= practice_count <= 100:
        raise ValueError("每章的练习需要 1 至 100 道题")
    if type(quiz_count) is not int or not 0 <= quiz_count <= 100 or (quiz_count > 0) != ("assessment" in stages):
        raise ValueError("含测验模板每章需要 1 至 100 道测验题，无测验模板的测验题量应为零")
    chapters = {row["id"]: row for row in data["chapter"]}
    points = {row["id"]: row for row in data["knowledge_point"]}
    materials = {row["id"]: row for row in data["material"]}
    chapter_ids = _selected_ids([row["chapter_id"] for row in recipe["chapters"]], 64, "课程章节")
    if not all(key in chapters for key in chapter_ids):
        raise ValueError("所选章节已移除或不属于本课程，请重新选择")
    questions = {key: [] for key in chapter_ids}
    for row in data["question"]:
        for key in row["chapter_ids"]:
            if key in questions:
                questions[key].append(row)
    indoor = recipe["template_id"] == "learn-practice-quiz" and not legacy_itinerary
    final_id, enabled = route_options(recipe, chapter_ids)
    has_chat = "public_chat" in enabled
    has_tour = "library_shelf_tour" in enabled
    cast = town_cast(data["npc"]) if indoor else characters(data["npc"], stages)
    public = town_public(public_chat=has_chat) if indoor else public_route(stages)
    result = {"npc": cast, "activity": [], "quest": [], "story": [public],
              "interactions": [signpost()], "prerequisites": []}
    shortages = []
    for position, selection in enumerate(recipe["chapters"]):
        key = selection["chapter_id"]
        chapter = chapters[key]
        previous = chapters[chapter_ids[position - 1]] if position else None
        following = chapters[chapter_ids[position + 1]] if position + 1 < len(chapter_ids) else None
        prefix = chapter_prefix(key)
        try:
            activities = _chapter_activities(selection, chapter, points, materials, questions[key], practice_count, quiz_count, prefix, stages,
                                             legacy_practice, adjustments)
        except QuestionShortages as exc:
            shortages.extend(exc.messages)
            continue
        result["activity"].extend(activities)
        if indoor:
            quest, story, directions = town_chapter(chapter, following, position, prefix, final=key == final_id, shelf_tour=has_tour, public_chat=has_chat)
            result["story"].extend((story, directions))
            if key == final_id:
                result["story"].append(town_farewell(key, quest["id"], public_chat=has_chat))
        else:
            topic = points[selection["knowledge_point_ids"][0]]["title"]
            quest, story = chapter_journey(chapter, previous, following, topic, position, prefix, stages)
            result["story"].append(story)
        result["quest"].append(quest)
        if indoor and position == 0:
            add_room_itinerary(result)
            for feature_id, feature in FEATURES.items():
                if feature_id in enabled and feature.add_to_start:
                    feature.add_to_start(result, prefix, owned_quests)
        if previous:
            result["prerequisites"].append({"chapter_id": key, "prerequisite_chapter_id": previous["id"]})
    if shortages:
        raise QuestionShortages(shortages)
    return result
