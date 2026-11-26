"""Fixed town available to every enrolled learner, independently of authored content."""
from app.chapter_tasks.service import open_chapters
from app.characters import presentation, world_character
from app.course_content.access import authorize_classroom
from app.models import PlayerPosition
from app.platform_roles import roles
from app.world_config import load_world_config


def world_payload(db, user, classroom_id):
    room = authorize_classroom(db, user, classroom_id)
    config = load_world_config()
    position = db.get(PlayerPosition, (user.id, classroom_id))
    player = ({k: getattr(position, k) for k in ("map_key", "tile_x", "tile_y", "direction")}
              if position else dict(config["default_spawn"]))
    fixed = roles(db)
    buildings = {p["building_id"]: {"enabled": True, "unlocked": True, "can_enter": True, "blocked_message": ""}
                 for p in config["portals"] if p.get("building_id")}
    return {"story_available": False, "player": player, "npcs": [world_character(db, classroom_id, n) for n in fixed],
            "default_role": presentation(db, classroom_id, next(n for n in fixed if n.key == "librarian")),
            "quests": [], "flags": [], "building_access": buildings, "building_unlock": list(buildings),
            "interactions": [], "chapters": [{"id": c.id, "title": c.title, "available": True, "order_index": c.order_index}
                                             for c in open_chapters(db, room)]}
