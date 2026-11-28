import { describe, expect, it } from "vitest";
import tiledTown from "../public/assets/maps/town_hub.json";
import { buildingMessage, getWorldMap, mapTargets, nearbyWorldTarget, portalRoute, reachableApproach, resolveWorldTarget, worldConfig, worldTargetHint, type WorldDefinition, type WorldTarget } from "../src/game/config/worldConfig";
const courseAccess = (can_enter: boolean) => ({ building_access: { library: { enabled: true, unlocked: can_enter, can_enter, blocked_message: "课程尚未开放" } } });

describe("configured world places and portals", () => {
  it("names and reaches every real house, including prop-based cottages", () => {
    const map = getWorldMap("town_hub");
    const art = tiledTown.layers.flatMap(layer => "objects" in layer ? layer.objects : []);
    const collision = tiledTown.layers.find(layer => layer.name === "collision")!;
    const blocked = (x: number, y: number) => "data" in collision && Boolean(collision.data[y * map.width + x]);
    expect(map.buildings).toHaveLength(11);
    for (const building of map.buildings) {
      expect(building.label).toMatch(/[\u4e00-\u9fff]/);
      expect(art.some(object => object.name === building.object_name)).toBe(true);
      const target = resolveWorldTarget(building.id, []);
      expect(target).toBeDefined();
      expect(reachableApproach({ x: worldConfig.default_spawn.tile_x, y: worldConfig.default_spawn.tile_y }, target!, 2, map.width, map.height, blocked)).not.toBeNull();
    }
    const cottage = map.buildings.find(building => building.object_name.startsWith("cottage_"))!;
    expect(resolveWorldTarget(cottage.object_name, [])?.id).toBe(cottage.id);
    expect(buildingMessage(cottage)).not.toContain("暂未开放");
  });
  it("uses the configured library portal once and exposes honest nearby hints", () => {
    const targets = mapTargets("town_hub");
    expect(targets.filter(item => item.x === 8 && item.y === 22)).toHaveLength(1);
    const entrance = resolveWorldTarget("library", [])!;
    expect(entrance.portal?.id).toBe("library_door");
    expect(worldTargetHint(entrance, [], courseAccess(false))).toBe("");
    expect(worldTargetHint(entrance, [], courseAccess(true))).toBe("进入");
    for (const retired of ['practice_plaza', 'town_square', 'library_shelf']) expect(resolveWorldTarget(retired, [])).toBeUndefined();
    expect(worldTargetHint(resolveWorldTarget("mayor_hall", [])!, [], courseAccess(false))).toBe("");
  });
  it("plans both directions through configured portals and honors entry requirements", () => {
    expect(portalRoute("town_hub", "library", [], worldConfig, courseAccess(false))).toBeNull();
    expect(portalRoute("town_hub", "library", [], worldConfig, courseAccess(true))?.map(item => item.id)).toEqual(["library_door"]);
    expect(portalRoute("library", "town_hub", [])?.map(item => item.id)).toEqual(["library_exit"]);
    expect(portalRoute("library", "library", [])).toEqual([]);
    const open = { enabled: true, unlocked: true, can_enter: true, blocked_message: "" };
    const town = { building_access: { library: open, mayor_hall: open, arena: open } };
    expect(portalRoute("mayor_hall", "library", [], worldConfig, town)?.map(item => item.id)).toEqual(["mayor_hall_exit", "library_door"]);
    expect(portalRoute("library", "arena", [], worldConfig, town)?.map(item => item.id)).toEqual(["library_exit", "arena_door"]);
  });
  it("routes through several arbitrary maps without special map-name branches", () => {
    const base = worldConfig.portals[0]!;
    const config: WorldDefinition = { ...worldConfig, portals: [
      { ...base, id: "a-b", from: { ...base.from, map_key: "a" }, to: { ...base.to, map_key: "b" }, required_flags: [] },
      { ...base, id: "b-c", from: { ...base.from, map_key: "b" }, to: { ...base.to, map_key: "c" }, required_flags: ["c_open"] },
      { ...base, id: "b-a", from: { ...base.from, map_key: "b" }, to: { ...base.to, map_key: "a" }, required_flags: [] },
    ] };
    expect(portalRoute("a", "c", [], config)).toBeNull();
    expect(portalRoute("a", "c", ["c_open"], config)?.map(item => item.id)).toEqual(["a-b", "b-c"]);
  });
  it("chooses a reachable approach rather than a nearer isolated tile", () => {
    const walls = new Set(["3,1", "3,3", "2,2", "4,2"]);
    const route = reachableApproach({ x: 0, y: 2 }, { x: 4, y: 2 }, 1, 6, 5, (x, y) => walls.has(`${x},${y}`));
    expect(route).not.toBeNull();
    expect(route!.point).not.toEqual({ x: 3, y: 2 });
    expect(route!.path.length).toBeGreaterThan(0);
    expect(reachableApproach({ x: 0, y: 0 }, { x: 3, y: 3 }, 1, 4, 4, () => true)).toBeNull();
  });
  it("updates compact nearby actions at fractional moving positions and excludes closed buildings", () => {
    const npcTarget: WorldTarget = { id: "person", map_key: "library", x: 15, y: 8, label: "管理员", kind: "npc", radius: 2 };
    expect(nearbyWorldTarget({ map_key: "library", x: 15, y: 10 }, [npcTarget], [])).toEqual(npcTarget);
    expect(nearbyWorldTarget({ map_key: "library", x: 15, y: 10.01 }, [npcTarget], [])).toBeUndefined();
    const closed = resolveWorldTarget("training", [])!;
    expect(nearbyWorldTarget({ map_key: closed.map_key, x: closed.x, y: closed.y }, [closed], [])).toBeUndefined();
    expect(nearbyWorldTarget({ map_key: closed.map_key, x: closed.x, y: closed.y }, [closed], [], closed.id)).toBeUndefined();
    const npc: WorldTarget = { id: "person", map_key: "library", x: 9, y: 5, label: "Very long name", kind: "npc", radius: 2 };
    expect(worldTargetHint(npc, [])).toBe("交谈");
    expect(worldTargetHint(resolveWorldTarget("library_exit", [])!, [])).toBe("返回");
  });
  it("keeps the first configured target when distances tie after the single-pass nearest rewrite", () => {
    const first: WorldTarget = { id: "first", map_key: "library", x: 9, y: 5, label: "A", kind: "npc", radius: 3 };
    const second: WorldTarget = { id: "second", map_key: "library", x: 9, y: 4, label: "B", kind: "npc", radius: 3 };
    const position = { map_key: "library", x: 9, y: 4.5 };
    expect(nearbyWorldTarget(position, [first, second], [])?.id).toBe("first");
    expect(nearbyWorldTarget(position, [second, first], [])?.id).toBe("second");
  });

});
