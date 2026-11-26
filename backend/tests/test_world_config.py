from course_fixtures import create_test_class
import app.teaching.world.rules as teaching_world_rules
from copy import deepcopy

import pytest
from pydantic import ValidationError

from app import world_config

from app.models import PlayerPosition, WorldFlag
from app.teaching.world.contracts import PositionInput
from app.world_config import interaction_points, load_world_config, validate_world_config


def position(client, student, classroom, map_key, x, y):
    return client.put("/api/world/position", json={"classroom_id": classroom["id"], "map_key": map_key, "tile_x": x, "tile_y": y,
                                                  "direction": "down"}, headers=student["headers"])


def transition(client, student, classroom, portal_id):
    return client.post("/api/world/transition", json={"classroom_id": classroom["id"], "portal_id": portal_id}, headers=student["headers"])


def test_canonical_world_and_portal_anchors_have_one_source():
    config = load_world_config()
    assert validate_world_config(config) is config
    points = interaction_points()
    assert points["library_door"] == ("town_hub", 8, 22)
    assert points["library_exit"] == ("library", 9, 12)
    assert ("library", 4, 4) in points["library_shelf"]
    assert ("library", 15, 8) in points["library_shelf"]
    assert len(points["library_shelf"]) == 10
    assert points["practice_plaza"] == ("town_hub", 38, 24)
    assert points["library"] == ("town_hub", 8, 22)
    assert points["training"] == ("town_hub", 8, 31)


@pytest.mark.parametrize("mutation", ["dimension", "spawn", "anchor", "portal", "duplicate_portal", "required_flags", "building_portal", "unknown_map",
                                      "building_anchor_conflict", "building_portal_conflict"])
def test_invalid_world_configuration_is_rejected(mutation):
    config = deepcopy(load_world_config())
    if mutation == "dimension":
        config["maps"]["library"]["width"] = True
    elif mutation == "spawn":
        config["default_spawn"]["tile_x"] = 50
    elif mutation == "anchor":
        config["interactions"]["library_shelf"]["points"][0]["tile_y"] = 14
    elif mutation == "portal":
        config["portals"][0]["to"]["tile_x"] = 18
    elif mutation == "duplicate_portal":
        config["portals"].append(deepcopy(config["portals"][0]))
    elif mutation == "required_flags":
        config["portals"][0]["required_flags"] = ["library_unlocked", "library_unlocked"]
    elif mutation == "building_portal":
        config["maps"]["town_hub"]["buildings"][0]["portal_id"] = "missing"
    elif mutation == "unknown_map":
        config["portals"][0]["to"]["map_key"] = "missing"
    elif mutation == "building_anchor_conflict":
        config["interactions"]["library"] = {"map_key": "town_hub", "tile_x": 9, "tile_y": 22, "kind": "building", "label": "Conflict", "building_id": "library"}
    elif mutation == "building_portal_conflict":
        config["portals"][0]["from"]["tile_x"] = 9
    with pytest.raises(ValueError):
        validate_world_config(config)


def test_position_and_npc_dtos_take_map_names_and_dimensions_from_configuration(monkeypatch):
    config = deepcopy(load_world_config())
    config["maps"]["town_hub"]["width"] = 60
    config["maps"]["town_hub"]["walk_bounds"] = {"x": 0, "y": 0, "width": 60, "height": 40}
    config["maps"]["annex"] = {"label": "Annex", "width": 6, "height": 5, "renderer": "tiled", "asset": "/assets/maps/annex.json", "buildings": []}
    monkeypatch.setattr(world_config, "load_world_config", lambda: config)
    monkeypatch.setattr(teaching_world_rules, "reachable_cells", lambda _: {(5, 4)})
    assert PositionInput(classroom_id=1, map_key="town_hub", tile_x=59, tile_y=39).tile_x == 59
    assert PositionInput(classroom_id=1, map_key="annex", tile_x=5, tile_y=4).map_key == "annex"
    with pytest.raises(ValidationError):
        PositionInput(classroom_id=1, map_key="annex", tile_x=6, tile_y=4)


def test_cross_map_put_cannot_bypass_entrance_and_initial_spawn_is_enforced(client, db, student, classroom):
    assert position(client, student, classroom, "library", 9, 5).status_code == 409
    assert db.get(PlayerPosition, (student["id"], classroom["id"])) is None
    assert transition(client, student, classroom, "library_door").status_code == 422
    assert position(client, student, classroom, "town_hub", 8, 22).status_code == 200
    assert transition(client, student, classroom, "missing").status_code == 404
    assert position(client, student, classroom, "library", 9, 5).status_code == 409
    assert db.get(PlayerPosition, (student["id"], classroom["id"])).map_key == "town_hub"


def test_transition_requires_correct_source_then_uses_exact_configured_spawn(client, db, student, classroom):
    assert transition(client, student, classroom, "library_door").status_code == 422
    assert position(client, student, classroom, "town_hub", 8, 22).status_code == 200
    response = transition(client, student, classroom, "library_door")
    assert response.status_code == 200, response.text
    expected = {"map_key": "library", "tile_x": 9, "tile_y": 11, "direction": "up"}
    assert response.json()["player"] == response.json()["world"]["player"] == expected
    assert transition(client, student, classroom, "library_door").status_code == 422
    assert position(client, student, classroom, "library", 18, 4).status_code == 422
    assert position(client, student, classroom, "library", 9, 5).status_code == 200
    assert transition(client, student, classroom, "library_exit").status_code == 422
    assert position(client, student, classroom, "library", 9, 12).status_code == 200
    response = transition(client, student, classroom, "library_exit")
    assert response.status_code == 200 and response.json()["player"]["map_key"] == "town_hub"
    assert (response.json()["player"]["tile_x"], response.json()["player"]["tile_y"]) == (8, 22)
    from sqlalchemy import func, select
    from app.integration_models import AssistantCall

    assert db.scalar(select(func.count()).select_from(AssistantCall)) == 0


def test_historical_library_save_without_old_flag_loads_moves_and_exits_without_reset(client, db, student, classroom):
    saved = PlayerPosition(user_id=student["id"], classroom_id=classroom["id"], map_key="library", tile_x=9, tile_y=5, direction="up")
    db.add(saved)
    db.commit()
    assert not db.get(WorldFlag, (student["id"], classroom["id"], "library_unlocked"))
    response = client.get(f"/api/world?classroom_id={classroom['id']}", headers=student["headers"])
    assert response.status_code == 200 and response.json()["player"]["map_key"] == "library"
    assert response.json()["player"]["tile_y"] == 5
    assert position(client, student, classroom, "library", 9, 12).status_code == 200
    assert transition(client, student, classroom, "library_exit").status_code == 200
    assert transition(client, student, classroom, "library_door").status_code == 200


def test_transition_does_not_accept_another_classroom(client, student, teacher, classroom):
    other = create_test_class(client, json={"name": "Other"}, headers=teacher["headers"]).json()
    response = client.post("/api/world/transition", json={"classroom_id": other["id"], "portal_id": "library_door"}, headers=student["headers"])
    assert response.status_code == 403


def test_walk_bounds_exclude_decoration_from_player_and_npc_positions(client, student, classroom, monkeypatch):
    config = deepcopy(load_world_config())
    config["maps"]["town_hub"]["walk_bounds"] = {"x": 1, "y": 1, "width": 48, "height": 38}
    config["maps"]["town_hub"]["render_bounds"] = {"x": -18, "y": -14, "width": 86, "height": 68}
    monkeypatch.setattr(world_config, "load_world_config", lambda: config)
    assert position(client, student, classroom, "town_hub", 0, 10).status_code == 422
    assert position(client, student, classroom, "town_hub", -1, 10).status_code == 422
    assert position(client, student, classroom, "town_hub", 1, 10).status_code == 200


@pytest.mark.parametrize("invalid", ["empty", "duplicate", "too_many", "unknown_map", "mixed"])
def test_multi_point_interactions_reject_unbounded_duplicate_or_invalid_geometry(invalid):
    config = deepcopy(load_world_config())
    shelf = config["interactions"]["library_shelf"]
    if invalid == "empty":
        shelf["points"] = []
    elif invalid == "duplicate":
        shelf["points"].append(deepcopy(shelf["points"][0]))
    elif invalid == "too_many":
        shelf["points"] = [deepcopy(shelf["points"][0]) for _ in range(65)]
    elif invalid == "unknown_map":
        shelf["points"][0]["map_key"] = "missing"
    elif invalid == "mixed":
        shelf["map_key"] = "library"
    with pytest.raises(ValueError):
        validate_world_config(config)
