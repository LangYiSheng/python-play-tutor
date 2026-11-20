from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.characters import validate_characters
from app.course_instances import remap_references
from app.course_content.resources import validate_resources
from app.practice_rules import QuestionShortages, allocate_initial
from app.teaching.authoring.validation import validate_configuration
from app.teaching.quests.validation import validate_definition
from app.teaching.quick_template.compiler import chapter_prefix, compile_template
from app.teaching.quick_template.contracts import Recipe


@pytest.fixture
def course():
    data = {kind: [] for kind in ("chapter", "knowledge_point", "material", "question", "npc", "quest", "story", "activity", "example")}
    recipe = {"template_id": "learn-practice-quiz", "chapters": [], "practice_count": 2, "quiz_count": 2}
    for number in (1, 2):
        chapter = f"chapter-{number}"
        data["chapter"].append({"id": chapter, "title": f"第 {number} 课"})
        material = f"slides-{number}"
        data["material"].append({"id": material, "title": "课件", "kind": "presentation", "status": "ready",
                                 "content": {"pages": [{"id": number, "page_no": 1}]}, "asset_id": "slides",
                                 "preview_asset_id": "pdf", "chapter_ids": [chapter]})
        topics = []
        for name in ("a", "b"):
            point = f"{chapter}-{name}"
            topics.append(point)
            data["knowledge_point"].append({"id": point, "chapter_id": chapter, "title": f"知识点{name}"})
            for i in range(3):
                data["question"].append({"id": f"{point}-{i}", "kind": "boolean", "status": "ready",
                                         "samples": [], "knowledge_point_ids": [point], "chapter_ids": [chapter]})
        recipe["chapters"].append({"chapter_id": chapter, "material_ids": [material], "knowledge_point_ids": topics})
    return data, recipe


def test_itinerary_uses_existing_engine_validators_and_stable_ids(course):
    data, recipe = course
    generated = compile_template(data, recipe)
    for kind in ("npc", "quest", "story", "activity"):
        data[kind].extend(generated[kind])
    validate_characters(data["npc"], [])
    validate_configuration({"world": {"interactions": generated["interactions"]}}, data)
    maps = {kind: {row["id"]: i if kind in {"chapter", "material", "knowledge_point"} else row["id"]
                   for i, row in enumerate(rows, 1)} for kind, rows in data.items()}
    for row in generated["quest"]:
        validate_definition(remap_references(row, maps)["definition"])
    for activity in generated["activity"]:
        validate_resources(activity["resources"], activity["kind"],
                           lambda key: SimpleNamespace(**next(row for row in data["material"] if row["id"] == key)))
    assert generated == compile_template(data, recipe)
    reordered = compile_template(data, {**recipe, "chapters": list(reversed(recipe["chapters"]))})
    for kind in ("activity", "npc"):
        assert {row["id"] for row in generated[kind]} == {row["id"] for row in reordered[kind]}
    original_stories = {row["id"] for row in generated["story"]}
    reordered_stories = {row["id"] for row in reordered["story"]}
    assert original_stories - reordered_stories == {chapter_prefix("chapter-2") + "-quest-farewell"}
    assert reordered_stories - original_stories == {chapter_prefix("chapter-1") + "-quest-farewell"}
    assert {q["id"] for q in generated["quest"] if q["definition"]["kind"] == "main"} == {
        q["id"] for q in reordered["quest"] if q["definition"]["kind"] == "main"}
    assert [release["prerequisite_chapter_id"] for release in generated["releases"]] == [None, "chapter-1"]
    assert [release["prerequisite_chapter_id"] for release in reordered["releases"]] == [None, "chapter-2"]
    first = next(row["content"] for row in reordered["story"] if row["quest_id"] and row["chapter_id"] == "chapter-2")
    assert "{course_name}" in next(node["text"] for node in first["nodes"] if node["id"] == "welcome-mayor")


def personal_draw(activity, data):
    assert activity["question_ids"] == []
    rules = activity["content"]["practice_rules"]
    pool = {goal["knowledge_point_id"]: {} for goal in rules["goals"]}
    for q in sorted(data["question"], key=lambda row: row["id"]):
        if q["status"] == "ready" and activity["chapter_id"] in q["chapter_ids"] and (q["kind"] != "python" or q["samples"]):
            for point in set(q["knowledge_point_ids"]) & pool.keys():
                pool[point][q["id"]] = q["kind"]
    return [q for questions in allocate_initial(rules, pool, shuffle=False).values() for q in questions]


def test_town_greets_each_student_in_their_rooms_and_keeps_course_content_in_materials(course):
    data, recipe = course
    for point in data["knowledge_point"]:
        point["content"] = {"teaching_sample": {"reading": "来自旧样板的专有例子"}}
    generated = compile_template(data, recipe)
    assert generated == compile_template(data, {**recipe, "dialogue_style": "teaching-sample"})
    assert [(n["name"], n["placement"]["map_key"], n["sprite"]) for n in generated["npc"]] == [
        ("图书管理员", "library", "builtin:sprite:chara_6"),
        ("练习场教练", "arena", "builtin:sprite:chara_4"),
        ("镇长", "mayor_hall", "builtin:sprite:chara_2"),
    ]
    assert [row["definition"]["kind"] for row in generated["quest"]].count("side") == 1
    for selection in recipe["chapters"]:
        quest = next(row for row in generated["quest"] if row["chapter_id"] == selection["chapter_id"] and row["definition"]["kind"] == "main")
        goals = quest["definition"]["nodes"]
        assert [g["id"] for g in goals] == ["welcome", "meet-lesson", "lesson", "meet-practice", "practice", "meet-assessment", "assessment", "report"]
        for index, goal in enumerate(goals):
            assert goal["dependencies"] == ([goals[index - 1]["id"]] if index else [])
        task = next(row for row in generated["story"] if row["quest_id"] == quest["id"])
        nodes = {n["id"]: n for n in task["content"]["nodes"]}
        assert nodes["mayor-departure"]["checkpoint"] == "welcome"
        assert all(n.get("checkpoint") != "welcome" for n in (nodes["library-location"], nodes["back-to-departure"], nodes["mayor-goodbye"]))
        assert nodes["report"]["checkpoint"] == "report"
        for kind in ("lesson", "practice", "assessment"):
            assert nodes[f"invite-{kind}"]["checkpoint"] == f"meet-{kind}"
            assert nodes[f"ready-{kind}"]["next"] != nodes[f"resume-{kind}"]["next"]
            assert nodes[f"open-{kind}"]["returns"]["suspended"] == f"paused-{kind}"
        text = " ".join(n.get("text", "") for n in nodes.values())
        assert "来自旧样板的专有例子" not in text
        assert not any(point["title"] in text for point in data["knowledge_point"])
        assert "{chapter_name}" in text and "{name}" in text
        if selection is recipe["chapters"][0]:
            assert "{course_name}" in nodes["welcome-mayor"]["text"]
        else:
            assert nodes["welcome-mayor"]["choices"][-1]["id"] == "later"


def test_balanced_fixed_question_counts_and_sparse_pools(course):
    data, recipe = course
    recipe["chapters"] = recipe["chapters"][:1]
    generated = compile_template(data, recipe)
    lesson, practice, quiz = generated["activity"]
    assert lesson["resources"][0]["required"] and not quiz["assistant_allowed"]
    assert personal_draw(practice, data) == ["chapter-1-a-0", "chapter-1-b-0"]
    assert quiz["question_ids"] == ["chapter-1-a-1", "chapter-1-b-1"]
    # With a one-question chapter, the same approved question can serve both roles.
    row = data["question"][0]
    row["knowledge_point_ids"] = recipe["chapters"][0]["knowledge_point_ids"]
    data["question"] = [row, {**row, "id": "draft", "status": "draft"}, {**row, "id": "other", "chapter_ids": ["chapter-2"]}]
    recipe.update(practice_count=1, quiz_count=1)
    _, practice, quiz = compile_template(data, recipe)["activity"]
    assert personal_draw(practice, data) == quiz["question_ids"] == [row["id"]]
    recipe.update(practice_count=2, quiz_count=2)
    adjustments = []
    _, practice, quiz = compile_template(data, recipe, adjustments=adjustments)["activity"]
    assert personal_draw(practice, data) == quiz["question_ids"] == [row["id"]]
    assert adjustments == [
        {"chapter_id": "chapter-1", "stage": stage, "requested": 2, "effective": 1}
        for stage in ("practice", "assessment")
    ]
    # A chapter override that happens to equal the course default is still strict.
    recipe["chapters"][0]["question_plan"] = {"assessment": {"mode": "total", "count": 2}}
    adjustments = []
    with pytest.raises(QuestionShortages, match="测验需要 2 道题.*只有 1 道.*还缺 1 道"):
        compile_template(data, recipe, adjustments=adjustments)
    assert adjustments == [{"chapter_id": "chapter-1", "stage": "practice", "requested": 2, "effective": 1}]


@pytest.mark.parametrize("legacy_practice", [True, False])
def test_importing_an_outdoor_course_recovers_the_old_baseline_before_migration(course, legacy_practice):
    from app.course_packages.quick_orchestration import restore_template
    from app.teaching.quick_template.plan import merge_course

    data, recipe = course
    installed = compile_template(data, recipe, legacy_itinerary=True, legacy_practice=legacy_practice)
    for kind in ("npc", "quest", "story", "activity"):
        data[kind].extend(deepcopy(installed[kind]))
    cfg = {"world": {"interactions": installed["interactions"]}}
    releases = installed["releases"]
    bundle = {"course": {"quick_orchestration": recipe, "releases": releases}, "configuration": cfg, "data": data}

    state = restore_template(bundle, {})["_quick_orchestration"]
    assert len(data["quest"][0]["definition"]["nodes"]) == 3
    current = compile_template(data, recipe)
    migration = merge_course(data, cfg, releases, current, recipe, state)
    assert not migration.blockers
    assert {q["id"]: q for q in migration.data["quest"]} == {q["id"]: q for q in current["quest"]}
    assert {s["id"]: s for s in migration.data["story"]} == {s["id"]: s for s in current["story"]}
    assert [n["placement"]["map_key"] for n in migration.data["npc"]] == ["library", "arena", "mayor_hall"]

    data["npc"][0]["name"] = "独立编辑过的馆员"
    # A teacher may replace every old invitation. The three-goal quest still
    # identifies the exported version, and reconstructing it detects these edits.
    for flow in data["story"]:
        if flow["quest_id"]:
            flow["content"]["nodes"] = [{"id": "my-lesson", "type": "end"}]
            flow["content"]["entries"] = {"quick-course-reader": [{"when": {"always": True}, "node": "my-lesson"}]}
    modified_state = restore_template(bundle, {})["_quick_orchestration"]
    conflict = merge_course(data, cfg, releases, current, recipe, modified_state)
    assert any("独立编辑过的馆员" in issue for issue in conflict.blockers)
    assert any("剧情" in issue for issue in conflict.blockers)


def test_imported_four_character_prototype_can_play_but_cannot_mix_with_new_shelf_tour(course):
    from app.course_packages.quick_orchestration import restore_template
    from app.teaching.quick_template.plan import merge_course

    data, recipe = course
    recipe["dialogue_style"] = "teaching-sample"
    installed = compile_template(data, recipe, legacy_itinerary=True)
    for kind in ("npc", "quest", "story", "activity"):
        data[kind].extend(installed[kind])
    public = data["story"][0]["content"]
    public["entries"]["quick-course-professor"] = [{"when": {"always": True}, "node": "welcome"}]
    data["npc"].append({**data["npc"][0], "id": "quick-course-professor", "name": "林教授"})
    cfg = {"world": {"interactions": installed["interactions"]}}
    bundle = {"course": {"quick_orchestration": recipe, "releases": installed["releases"]}, "configuration": cfg, "data": data}
    before = deepcopy(bundle)
    state = restore_template(bundle, {})["_quick_orchestration"]
    plan = merge_course(data, cfg, installed["releases"], compile_template(data, recipe), recipe, state)
    assert any("早期四角色样板" in issue for issue in plan.blockers)
    assert not any(plan.edits.values()) and plan.data == data
    assert before == bundle


def test_imported_chapter_shelf_tour_keeps_its_id_and_manual_edits_are_protected(course):
    from app.course_packages.quick_orchestration import restore_template
    from app.teaching.quick_template.plan import merge_course
    from app.teaching.quick_template.room_itinerary import shelf_tour_definition

    data, recipe = course
    start = recipe["chapters"][0]["chapter_id"]
    prefix = chapter_prefix(start)
    key = prefix + "-shelves"
    installed = compile_template(data, recipe)
    tour = shelf_tour_definition(prefix, quest_id=key, chapter_id=start)
    installed["quest"] = [q for q in installed["quest"] if q["definition"]["kind"] == "main"] + [tour]
    for kind in ("npc", "quest", "story", "activity"):
        data[kind].extend(installed[kind])
    releases = installed["releases"]
    config = {"world": {"interactions": installed["interactions"]}, "buildings": installed["buildings"]}
    bundle = {"course": {"quick_orchestration": recipe, "releases": releases}, "data": data, "configuration": config}

    def regenerate():
        state = restore_template(bundle, {})["_quick_orchestration"]
        compiled = compile_template(data, recipe, owned_quests=state["owned"]["quest"])
        return merge_course(data, config, releases, compiled, recipe, state)

    update = regenerate()
    assert not update.blockers
    assert [(q["id"], q["chapter_id"]) for q in update.data["quest"] if q["definition"]["kind"] == "side"] == [(key, None)]
    tour["definition"]["nodes"][0]["title"] = "老师另写的目标"
    assert regenerate().blockers


def test_previous_indoor_package_can_remove_ending_and_tour_without_claiming_authored_dialogue(course):
    from app.course_packages.quick_orchestration import restore_template
    from app.teaching.quick_template.plan import merge_course

    data, recipe = course
    previous = json.loads((Path(__file__).parent / "fixtures" / "quick-town-indoor-v1.json").read_text(encoding="utf-8"))
    installed = compile_template(data, recipe)
    old_sprites = {"quick-course-reader": 5, "quick-course-coach": 7, "quick-course-guide": 6}
    for npc in installed["npc"]:
        npc["sprite"] = f"builtin:sprite:chara_{old_sprites[npc['id']]}"
    flows = {s["id"]: s for s in installed["story"]}
    flows.pop(chapter_prefix("chapter-2") + "-quest-farewell")
    flows["quick-course-directions"] = previous["public"]
    for selection, role in zip(recipe["chapters"], ("first", "last"), strict=True):
        prefix = chapter_prefix(selection["chapter_id"])
        graph = flows[prefix + "-journey"]["content"]
        graph["entries"] = previous["entries"]
        by_id = {n["id"]: n for n in previous["shared_nodes"] + previous[role + "_nodes"]}
        nodes = [by_id[n] for n in previous[role + "_order"]]
        graph["nodes"] = remap_references(nodes, {"activity": {"sample-assessment": prefix + "-assessment"}})
    installed["story"] = list(flows.values())
    for kind in ("npc", "quest", "story", "activity"):
        data[kind].extend(installed[kind])
    cfg = {"world": {"interactions": installed["interactions"]}, "buildings": installed["buildings"]}
    releases = installed["releases"]
    bundle = {"course": {"quick_orchestration": recipe, "releases": releases}, "configuration": cfg, "data": data}
    before = deepcopy(bundle)
    state = restore_template(bundle, {})["_quick_orchestration"]
    assert state["recipe"] == recipe and before == bundle
    updated = {**recipe, "start_chapter_id": "chapter-1", "final_chapter_id": None, "feature_ids": []}
    native = compile_template(data, updated)
    migration = merge_course(data, cfg, releases, native, updated, state)
    assert not migration.blockers
    assert set(migration.edits["npc"]) == set(old_sprites)
    assert {n["id"]: n for n in migration.data["npc"]} == {n["id"]: n for n in native["npc"]}
    assert {s["id"]: s for s in migration.data["story"]} == {s["id"]: s for s in native["story"]}
    assert {s["id"]: s for s in migration.data["quest"]} == {s["id"]: s for s in native["quest"]}

    reader = next(n for n in data["npc"] if n["id"] == "quick-course-reader")
    reader["placement"]["tile_x"] += 1
    coach = next(n for n in data["npc"] if n["id"] == "quick-course-coach")
    coach["sprite"] = "builtin:sprite:chara_3"
    old_flow = flows[chapter_prefix("chapter-1") + "-journey"]["content"]
    next(n for n in old_flow["nodes"] if n["id"] == "report")["text"] = "老师亲自编写的回顾"
    modified = restore_template(bundle, {})["_quick_orchestration"]
    conflict = merge_course(data, cfg, releases, native, updated, modified)
    assert any("剧情" in issue for issue in conflict.blockers)
    assert set(conflict.edits["npc"]) == {"quick-course-guide"}
    assert reader in conflict.data["npc"] and coach in conflict.data["npc"]


@pytest.mark.parametrize("features", [[], ["public_chat"], ["library_shelf_tour"], ["library_shelf_tour", "public_chat"]])
def test_open_ended_route_and_independent_features_round_trip(course, features):
    from app.course_packages.quick_orchestration import restore_template
    from app.teaching.quick_template.plan import merge_course

    data, recipe = course
    recipe.update(start_chapter_id="chapter-1", final_chapter_id=None, feature_ids=features)
    assert Recipe.model_validate(recipe).model_dump(exclude_unset=True) == recipe
    compiled = compile_template(data, recipe)
    assert [row["kind"] for row in compiled["activity"]] == ["lesson", "practice", "assessment"] * 2
    assert sum(q["definition"]["kind"] == "side" for q in compiled["quest"]) == int("library_shelf_tour" in features)
    assert len([q for q in compiled["quest"] if q["definition"]["kind"] == "main"]) == 2
    flow = {s["id"]: s["content"] for s in compiled["story"]}
    assert not any(key.endswith("-quest-farewell") for key in flow)
    assert any(n.get("workspace") == "library" for n in flow["quick-course-bookshelves"]["nodes"])
    assert any(n["id"].startswith("chat-") for n in flow["quick-course-directions"]["nodes"]) == ("public_chat" in features)
    for kind in ("npc", "quest", "story", "activity"):
        data[kind].extend(compiled[kind])
    cfg = {"world": {"interactions": compiled["interactions"]}, "buildings": compiled["buildings"]}
    releases = compiled["releases"]
    state = restore_template({"data": data, "configuration": cfg, "course": {"releases": releases, "quick_orchestration": recipe}}, {})
    plan = merge_course(data, cfg, releases, compiled, recipe, state["_quick_orchestration"])
    assert plan.metadata["recipe"] == recipe and not plan.blockers and not any(plan.edits.values())
    assert compile_template(data, {k: v for k, v in recipe.items() if k != "final_chapter_id"}) == compiled


@pytest.mark.parametrize("kwargs,reason", [
    ({"start_chapter_id": None}, "起始章"),
    ({"start_chapter_id": "chapter-2"}, "起始章"),
    ({"final_chapter_id": "chapter-1"}, "最终章"),
    ({"final_chapter_id": "chapter-3"}, "最终章"),
    ({"feature_ids": ["other"]}, "未知"),
    ({"feature_ids": ["public_chat", "public_chat"]}, "只能选择一次"),
])
def test_invalid_roles_and_features_fail_before_compilation(course, kwargs, reason):
    data, recipe = course
    with pytest.raises(ValueError, match=reason):
        Recipe.model_validate({**recipe, **kwargs})
    with pytest.raises(ValueError, match=reason):
        compile_template(data, {**recipe, **kwargs})


def test_insert_between_designated_chapters_and_allow_single_chapter_to_finish(course):
    data, recipe = course
    start, final = recipe["chapters"]
    recipe.update(start_chapter_id=start["chapter_id"], final_chapter_id=final["chapter_id"], feature_ids=[])
    original = compile_template(data, recipe)
    assert [s["chapter_id"] for s in original["story"] if s["id"].endswith("-quest-farewell")] == ["chapter-2"]
    data["chapter"].append({"id": "middle", "title": "插入的一章"})
    data["material"][0]["chapter_ids"].append("middle")
    data["knowledge_point"].append({"id": "middle-point", "chapter_id": "middle", "title": "练习要点"})
    for row in data["question"][:2]:
        row["chapter_ids"].append("middle")
        row["knowledge_point_ids"].append("middle-point")
    middle = {"chapter_id": "middle", "material_ids": start["material_ids"], "knowledge_point_ids": ["middle-point"]}
    extended = compile_template(data, {**recipe, "chapters": [start, middle, final]})
    assert [(r["chapter_id"], r["prerequisite_chapter_id"]) for r in extended["releases"]] == [
        ("chapter-1", None), ("middle", "chapter-1"), ("chapter-2", "middle")]
    assert [s for s in extended["story"] if s["id"].endswith("-quest-farewell")] == [
        s for s in original["story"] if s["id"].endswith("-quest-farewell")]

    single = compile_template(data, {**recipe, "chapters": [start], "final_chapter_id": start["chapter_id"]})
    assert [s["chapter_id"] for s in single["story"] if s["id"].endswith("-quest-farewell")] == ["chapter-1"]
    goals = next(q for q in single["quest"] if q["definition"]["kind"] == "main")["definition"]["nodes"]
    assert [g["id"] for g in goals] == ["welcome", "meet-lesson", "lesson", "meet-practice", "practice", "meet-assessment", "assessment", "report"]


def test_deselected_points_and_sampleless_python_are_excluded_from_practice(course):
    data, recipe = course
    recipe["chapters"] = recipe["chapters"][:1]
    point = recipe["chapters"][0]["knowledge_point_ids"].pop()
    row = data["question"][0]
    row.update(id="0-python", kind="python", samples=[])
    _, practice, quiz = compile_template(data, recipe)["activity"]
    assert all(point not in key for key in personal_draw(practice, data) + quiz["question_ids"])
    assert "0-python" in quiz["question_ids"] and "0-python" not in personal_draw(practice, data)

    recipe.update(practice_count=10, quiz_count=10)
    adjustments = []
    _, practice, quiz = compile_template(data, recipe, adjustments=adjustments)["activity"]
    assert len(personal_draw(practice, data)) == 2 and len(quiz["question_ids"]) == 3
    assert adjustments == [
        {"chapter_id": "chapter-1", "stage": "practice", "requested": 10, "effective": 2},
        {"chapter_id": "chapter-1", "stage": "assessment", "requested": 10, "effective": 3},
    ]
    # A sampleless code question supports a quiz but cannot make a playable practice.
    data["question"] = [row]
    adjustments = []
    with pytest.raises(QuestionShortages, match="第 1 课.*练习没有可用题.*至少需要 1 道") as caught:
        compile_template(data, recipe, adjustments=adjustments)
    assert len(caught.value.messages) == 1
    assert adjustments == [{"chapter_id": "chapter-1", "stage": "assessment", "requested": 10, "effective": 1}]


def test_unusable_or_unrelated_selections_fail_and_existing_roles_keep_their_position(course):
    data, recipe = course
    with pytest.raises(ValueError, match="属于其他章节"):
        bad = deepcopy(recipe)
        bad["chapters"][0]["knowledge_point_ids"] = recipe["chapters"][1]["knowledge_point_ids"]
        compile_template(data, bad)
    with pytest.raises(ValueError, match="无效或重复"):
        compile_template(data, {**recipe, "chapters": recipe["chapters"] * 2})
    with pytest.raises(ValueError, match="不属于该章节"):
        bad = deepcopy(recipe)
        bad["chapters"][0]["material_ids"] = recipe["chapters"][1]["material_ids"]
        compile_template(data, bad)
    guide = compile_template(data, recipe)["npc"][2]
    existing = {**guide, "id": "custom-guide"}
    data["npc"].append(existing)
    new = compile_template(data, recipe)
    validate_characters([existing, *new["npc"]], [])
    assert new["npc"][2]["placement"] != existing["placement"]
    data["material"][0]["preview_asset_id"] = None
    with pytest.raises(ValueError, match="无法阅读"):
        compile_template(data, recipe)


def test_shorter_template_ends_with_practice_and_has_no_quiz_directions(course):
    data, recipe = course
    shorter = compile_template(data, {**recipe, "template_id": "learn-practice", "quiz_count": 0})
    assert len(shorter["npc"]) == 2
    assert [row["kind"] for row in shorter["activity"]] == ["lesson", "practice"] * 2
    assert all(row["definition"]["nodes"][-1]["id"] == "practice" for row in shorter["quest"])
    assert all("测验" not in node.get("text", "") for story in shorter["story"] for node in story["content"]["nodes"])
    assert "第 2 课" in next(node["text"] for node in shorter["story"][1]["content"]["nodes"] if node["id"] == "done-practice")
    for kind in ("npc", "quest", "story", "activity"):
        data[kind].extend(shorter[kind])
    validate_configuration({"world": {"interactions": shorter["interactions"]}}, data)


def test_independent_stage_totals_exact_types_and_inherited_sibling_chapter(course):
    data, recipe = course
    first = recipe["chapters"][0]
    assert Recipe.model_validate(recipe).model_dump(exclude_unset=True) == recipe
    for row, kind in zip(data["question"][:6], ["fill", "boolean", "boolean", "fill", "multiple_choice", "single_choice"], strict=True):
        row["kind"] = kind
    first["question_plan"] = {
        "practice": {"mode": "total", "count": 3, "by_kind": {"boolean": 1, "fill": 0}},
        "assessment": {"mode": "by_point", "points": [
            {"knowledge_point_id": first["knowledge_point_ids"][0], "count": 2, "by_kind": {"boolean": 1}},
            {"knowledge_point_id": first["knowledge_point_ids"][1], "count": 0},
        ]},
    }
    stored = Recipe.model_validate(recipe).model_dump(exclude_unset=True)
    assert stored == recipe
    _, practice, quiz, _, next_practice, next_quiz = compile_template(data, stored)["activity"]
    kinds = {row["id"]: row["kind"] for row in data["question"]}
    assert sorted(kinds[key] for key in personal_draw(practice, data)) == ["boolean", "multiple_choice", "single_choice"]
    assert sorted(kinds[key] for key in quiz["question_ids"]) == ["boolean", "fill"]
    assert all(key.startswith("chapter-1-a") for key in quiz["question_ids"])
    assert not set(personal_draw(practice, data)) & set(quiz["question_ids"])
    assert personal_draw(next_practice, data) == ["chapter-2-a-0", "chapter-2-b-0"]
    assert next_quiz["question_ids"] == ["chapter-2-a-1", "chapter-2-b-1"]


def test_multi_tag_questions_are_assigned_once_and_can_move_to_fill_tight_quotas(course):
    data, recipe = course
    recipe["chapters"] = recipe["chapters"][:1]
    first = recipe["chapters"][0]
    a, b = first["knowledge_point_ids"]
    c = "chapter-1-c"
    first["knowledge_point_ids"].append(c)
    data["knowledge_point"].append({"id": c, "chapter_id": first["chapter_id"], "title": "知识点c"})
    question = data["question"][0]
    data["question"] = [{**question, "id": key, "knowledge_point_ids": tags}
                        for key, tags in [("shared", [a, b, c]), ("topic-a", [a]), ("topic-bc", [b, c])]]
    rule = {"mode": "by_point", "points": [
        {"knowledge_point_id": key, "count": 1, "by_kind": {"boolean": 1}} for key in (a, b, c)
    ]}
    first["question_plan"] = {"practice": rule, "assessment": rule}
    def split():
        practice, quiz = compile_template(data, recipe)["activity"][1:]
        return [personal_draw(practice, data), quiz["question_ids"]]

    practice, quiz = split()
    assert practice[0] == "topic-a" and set(practice) == set(quiz) == {"topic-a", "topic-bc", "shared"}
    data["question"].reverse()
    assert split() == [practice, quiz]
    data["question"] = [row for row in data["question"] if row["id"] != "topic-a"]
    with pytest.raises(ValueError, match="第 1 课.*练习.*知识点.*判断.*缺少 1 道"):
        split()


@pytest.mark.parametrize("rule", [
    {"mode": "total", "count": 3, "by_kind": {"single_choice": 2, "fill": 2}},
    {"mode": "total", "count": 2, "by_kind": {"single_choice": 1, "multiple_choice": 0, "boolean": 0, "fill": 0, "python": 0, "interactive": 0}},
    {"mode": "total", "count": 1, "by_kind": {"essay": 1}},
    {"mode": "total", "count": 0},
    {"mode": "by_point", "points": [{"knowledge_point_id": "chapter-1-a", "count": 1}]},
    {"mode": "by_point", "points": [{"knowledge_point_id": "chapter-1-a", "count": 1}] * 2},
    {"mode": "by_point", "points": [{"knowledge_point_id": "chapter-1-a", "count": 1}, {"knowledge_point_id": "chapter-2-b", "count": 3}]},
    {"mode": "by_point", "points": [{"knowledge_point_id": "chapter-1-a", "count": 99}, {"knowledge_point_id": "chapter-1-b", "count": 2}]},
    {"mode": "by_point", "points": [{"knowledge_point_id": "chapter-1-a", "count": 0}, {"knowledge_point_id": "chapter-1-b", "count": 0}]},
])
def test_invalid_chapter_plans_rejected_before_publication(course, rule):
    _, recipe = course
    recipe["chapters"][0]["question_plan"] = {"practice": rule}
    with pytest.raises(ValueError):
        Recipe.model_validate(recipe)


def test_exact_type_shortage_and_no_quiz_override(course):
    data, recipe = course
    first = recipe["chapters"][0]
    first["question_plan"] = {"assessment": {"mode": "total", "count": 2, "by_kind": {"multiple_choice": 1}}}
    with pytest.raises(ValueError, match="第 1 课.*测验.*多选.*需要 1 道.*只有 0 道"):
        compile_template(data, recipe)
    with pytest.raises(ValueError, match="无测验模板不能设置章节测验配题"):
        Recipe.model_validate({**recipe, "template_id": "learn-practice", "quiz_count": 0})


@pytest.mark.parametrize("legacy_practice", [False, True])
def test_interactive_bank_is_for_practice_only(course, legacy_practice):
    data, recipe = course
    first = recipe["chapters"][0]
    recipe.update(chapters=[first], quiz_count=6)
    a, b = first["knowledge_point_ids"]
    data["question"][0]["kind"] = "interactive"
    first["question_plan"] = {"practice": {"mode": "by_point", "points": [
        {"knowledge_point_id": a, "count": 1, "by_kind": {"interactive": 1}}, {"knowledge_point_id": b, "count": 0}
    ]}}
    adjustments = []
    _, practice, quiz = compile_template(data, recipe, legacy_practice=legacy_practice, adjustments=adjustments)["activity"]
    selected = practice["question_ids"] if legacy_practice else personal_draw(practice, data)
    assert selected == [data["question"][0]["id"]]
    assert len(quiz["question_ids"]) == 5 and selected[0] not in quiz["question_ids"]
    assert adjustments == [{"chapter_id": first["chapter_id"], "stage": "assessment", "requested": 6, "effective": 5}]


@pytest.mark.parametrize("by_point", [False, True])
def test_assessment_rejects_interactive_quotas(course, by_point):
    data, recipe = course
    first = recipe["chapters"][0]
    quota = {"count": 1, "by_kind": {"interactive": 1}}
    rule = {"mode": "by_point", "points": [dict(knowledge_point_id=p, **quota) for p in first["knowledge_point_ids"]]} if by_point else {
        "mode": "total", **quota}
    first["question_plan"] = {"assessment": rule}
    with pytest.raises(ValueError, match="交互练习题只能用于练习"):
        Recipe.model_validate(recipe)
    with pytest.raises(ValueError, match="交互练习题只能用于练习"):
        compile_template(data, recipe)


def test_one_preview_lists_each_missing_quota_across_chapters_and_stages(course):
    data, recipe = course
    for chapter in recipe["chapters"]:
        a, b = chapter["knowledge_point_ids"]
        chapter["question_plan"] = {
            "practice": {"mode": "by_point", "points": [
                {"knowledge_point_id": a, "count": 1, "by_kind": {"python": 1}},
                {"knowledge_point_id": b, "count": 1, "by_kind": {"fill": 1}},
            ]},
            "assessment": {"mode": "total", "count": 2, "by_kind": {"single_choice": 1, "multiple_choice": 1}},
        }
    with pytest.raises(QuestionShortages) as caught:
        compile_template(data, recipe)

    messages = caught.value.messages
    assert len(messages) == 8
    for number in (1, 2):
        title = f"第 {number} 课"
        for kind, point in [("编程", "知识点a"), ("填空", "知识点b")]:
            assert any(all(part in msg for part in (title, "练习", point, kind, "缺少 1 道", "调整题量")) for msg in messages)
        for kind in ("单选", "多选"):
            assert any(all(part in msg for part in (title, "测验", kind, "需要 1 道", "只有 0 道", "减少题量")) for msg in messages)
