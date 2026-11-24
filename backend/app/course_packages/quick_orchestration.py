"""Recover editable template settings using only verified, portable course content."""

from app.course_packages.legacy_town import restore_ordinary_fingerprints, restore_story_fingerprints
from app.teaching.quick_template.compiler import chapter_prefix, compile_template
from app.teaching.quick_template.features import ROUTE_FIELDS
from app.teaching.quick_template.plan import MANAGED, digest, index_rows
from app.teaching.quick_template.room_itinerary import LEGACY_SHELF_ID, shelf_tour_definition


_PREVIOUS_INDOOR_SPRITES = {
    "quick-course-reader": "builtin:sprite:chara_5",
    "quick-course-coach": "builtin:sprite:chara_7",
    "quick-course-guide": "builtin:sprite:chara_6",
}


def _installed_itinerary(data, recipe):
    """Identify exported routes by their stable course-owned flow and node IDs."""
    prefixes = [chapter_prefix(chapter["chapter_id"]) for chapter in recipe["chapters"]]
    flows = index_rows("story", data["story"])
    quests = index_rows("quest", data["quest"])
    journeys = {prefix + "-journey": {n["id"] for n in flows[prefix + "-journey"]["content"]["nodes"]}
                for prefix in prefixes if prefix + "-journey" in flows}
    old_journeys = [key for key, nodes in journeys.items() if {"invite-lesson", "invite-practice"} <= nodes and "welcome-mayor" not in nodes]
    discussions = [prefix + "-after-reading" for prefix in prefixes if prefix + "-after-reading" in flows]
    public = flows.get("quick-course-directions", {}).get("content", {})
    has_room_flows = any(prefix + "-around-town" in flows for prefix in prefixes) or any("welcome-mayor" in nodes for nodes in journeys.values())
    sample_cast = "quick-course-professor" in public.get("entries", {})
    sample_recipe = recipe.get("dialogue_style") == "teaching-sample" and old_journeys
    if discussions or (not has_room_flows and (sample_cast or sample_recipe)):
        return False, discussions + list(journeys) + (["quick-course-directions"] if public else [])
    old_goals = any([n["id"] for n in quests[prefix + "-quest"]["definition"]["nodes"]] == ["lesson", "practice", "assessment"]
                    for prefix in prefixes if prefix + "-quest" in quests)
    outdoors = recipe["template_id"] == "learn-practice-quiz" and not has_room_flows and (old_goals or bool(old_journeys))
    return outdoors, []


def _previous_shelf(data, recipe, previous):
    quests = index_rows("quest", data["quest"])
    if "quick-course-shelf-tour" in quests:
        return None
    first = recipe["chapters"][0]["chapter_id"]
    prefix = chapter_prefix(first)
    for key, row in quests.items():
        if not LEGACY_SHELF_ID.fullmatch(key):
            continue
        baseline = shelf_tour_definition(prefix, quest_id=key, chapter_id=first if row["chapter_id"] is not None else None)
        # After the starting chapter is changed, an upgraded town tour still carries
        # its original ID. Only an exact template match or prior ownership identifies it.
        if key == prefix + "-shelves" or key in previous.get("owned", {}).get("quest", {}) or row == baseline:
            return baseline
    return None


def restore_template(bundle, previous):
    recipe = bundle["course"].get("quick_orchestration")
    if recipe is None:
        return {}
    state = {"recipe": recipe, "owned": {}, "prerequisites_before": {}}
    outdoors, sample_stories = _installed_itinerary(bundle["data"], recipe)
    if sample_stories:
        # The retired four-character prototype included authored point-specific text.
        # It can still be played and edited natively, but its baseline cannot be reconstructed.
        state["unverified_sample_stories"] = sample_stories
        return {"_quick_orchestration": state}
    prior_shelf = _previous_shelf(bundle["data"], recipe, previous)
    shelf_ids = [prior_shelf["id"]] if prior_shelf else []
    try:
        expected = compile_template(bundle["data"], recipe, legacy_itinerary=outdoors, owned_quests=shelf_ids)
    except ValueError:
        # The bank or available materials may have changed since the last generation.
        # Keep the selection editable without claiming any existing definitions.
        return {"_quick_orchestration": state}

    current = {
        **bundle["data"],
        "interactions": bundle["configuration"]["world"].get("interactions", []),
        "buildings": bundle["configuration"].get("buildings", {}),
        "prerequisites": bundle["course"]["prerequisites"],
    }
    legacy = {}
    if any(row["kind"] == "practice" and row["question_ids"] for row in current["activity"]):
        legacy = index_rows("activity", compile_template(bundle["data"], recipe, legacy_practice=True, legacy_itinerary=outdoors)["activity"])
    for kind in MANAGED:
        actual = index_rows(kind, current[kind])
        rows = index_rows(kind, expected.get(kind, []))
        # The baseline is computed from the installed template. A customized row
        # therefore stays a manual edit when the next preview compares it.
        owned = {key: digest(row) for key, row in rows.items()
                 if key in actual and (kind != "buildings" or row == actual[key])}
        if kind == "npc" and not outdoors and recipe["template_id"] == "learn-practice-quiz":
            for key, sprite in _PREVIOUS_INDOOR_SPRITES.items():
                if key in owned and actual[key] == {**rows[key], "sprite": sprite}:
                    owned[key] = digest(actual[key])
        if kind == "activity":
            for key in owned:
                if key in legacy and actual[key] == legacy[key]:
                    owned[key] = digest(legacy[key])
        if kind == "quest" and prior_shelf and prior_shelf["id"] in owned:
            owned[prior_shelf["id"]] = digest(prior_shelf)
        if (kind == "story" and not outdoors and recipe["template_id"] == "learn-practice-quiz" and not ROUTE_FIELDS.intersection(recipe)
                and not any(row["id"] in actual for row in expected[kind] if row["id"].endswith("-quest-farewell"))):
            restore_story_fingerprints(owned, actual, rows, recipe["chapters"])
        if kind == "story" and not outdoors and recipe["template_id"] == "learn-practice-quiz":
            restore_ordinary_fingerprints(owned, actual, rows, recipe)
        state["owned"][kind] = owned
        if kind == "prerequisites":
            for key in owned:
                # A new classroom keeps the release it received if a chapter leaves
                # the template. On a same-course update retain its local prior policy.
                state["prerequisites_before"][key] = previous.get("prerequisites_before", {}).get(key, actual[key])
    return {"_quick_orchestration": state}
