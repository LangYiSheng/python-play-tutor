"""The reusable town rooms and optional first visit to the library shelves."""

import re

LEGACY_SHELF_ID = re.compile(r"quick-[0-9a-f]{24}-shelves")


def add_room_itinerary(result):
    result["buildings"] = {
        room: {"enabled": True, "default_unlocked": True, "blocked_message": "这间屋子暂时没有开放。"}
        for room in ("mayor_hall", "library", "arena")
    }
    shelf = "library_shelf"
    result["interactions"].append({
        "id": shelf, "label": "图书馆书架", "prompt": "查阅学习资料", "trigger": "click",
        "map_key": "library", "target": {"object_id": shelf},
    })
    result["story"].append({
        "id": "quick-course-bookshelves", "chapter_id": None, "quest_id": None,
        "content": {"schema_version": 1, "mode": "public", "title": "在书架查阅学习资料",
                    "entries": {"interaction:" + shelf: [{"when": {"always": True}, "node": "read"}]},
                    "bindings": {}, "nodes": [
                        {"id": "read", "type": "action", "action": "open_workspace", "workspace": "library", "next": "end"},
                        {"id": "end", "type": "end"},
                    ]},
    })


def shelf_tour_definition(first_prefix, *, quest_id, chapter_id=None):
    task = {"id": quest_id, "title": "认识图书馆的书架", "chapter_id": chapter_id}
    return {
        **task, "definition": {**task, "kind": "side", "when": {"activity_completed": first_prefix + "-lesson"},
                              "nodes": [{"id": "open-shelf", "type": "INTERACT_OBJECT", "target": "library_shelf", "workspace": "library",
                                         "title": "走到图书馆的任一书架旁，打开学习资料", "dependencies": []}], "effects": []},
    }


def add_shelf_tour(result, first_prefix, owned_quests):
    # Published first-chapter tours keep their ID, player receipts and journal history.
    quest_id = next((key for key in owned_quests if LEGACY_SHELF_ID.fullmatch(key)), "quick-course-shelf-tour")
    result["quest"].append(shelf_tour_definition(first_prefix, quest_id=quest_id))
