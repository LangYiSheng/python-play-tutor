import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mayorHall, { shell as mayorShell } from "./rooms/mayor-hall.mjs";
import workshop from "./rooms/workshop.mjs";
import practiceHall from "./rooms/practice-hall.mjs";

const maps = fileURLToPath(new URL("../frontend/public/assets/maps/", import.meta.url));
const library = JSON.parse(await fs.readFile(path.join(maps, "library.json"), "utf8"));
const tiles = "/assets/pixel/tilesets/super-retro-world/farming_source.png";
const props = "/assets/pixel/props/super-retro-world/";
const tile = library.tilewidth;

function prop(name, col, footRow, texture, width, height, footprintWidth = 0, footprintDepth = 1) {
  const properties = { texture, collidable: false };
  return { name, col, footRow, width, height, footprintWidth, footprintDepth, properties };
}

function frame(name, col, row, [x, y, width, height], footprint, depth) {
  const item = prop(name, col, row, tiles, width, height, footprint, depth);
  Object.assign(item.properties, { frame_x: x, frame_y: y, frame_width: width, frame_height: height });
  return item;
}
function floor(name, col, row, texture, width, height) {
  const item = prop(name, col, row, texture, width, height);
  item.properties.depth = -10;
  return item;
}
const framing = floor("timber_framing", 0, 13, props + "teaching-rooms/timber-framing.png", 288, 224);
const exit = floor("exit_door", 8, 13, props + "teaching-rooms/threshold.png", 48, 16);

const rooms = {
  mayor_hall: {label: "镇长办公室", furnish: mayorHall, wall: mayorShell.wall, plank: 4818},
  workshop: { label: "教学工坊", furnish: workshop, wall: mayorShell.wall, plank: 4930 },
  arena: {label: "练习会馆", furnish: practiceHall, wall: [1186, 1187, 1188, 1298, 1299, 1300, 1746, 1747, 1748], plank: 4930},
};
for (const [key, {label, furnish, wall, plank}] of Object.entries(rooms)) {
  const room = structuredClone(library);
  room.properties.find(p => p.name === "mapKey").value = key;
  room.properties.find(p => p.name === "label").value = label;
  room.layers = room.layers.filter(layer => layer.name !== "reading_rug");
  const ground = room.layers.find(layer => layer.name === "ground");
  ground.data = ground.data.map((_, index) => {
    const x = index % room.width, y = Math.floor(index / room.width);
    // The four source tiles share a grain. Stagger the joints down neighboring boards.
    return plank + [0, 2, 0, 0, 3, 0, 1][(y + 3 * x) % 7];
  });
  const walls = room.layers.find(layer => layer.name === "walls");
  const timber = (x, y) => 1 + y * room.tilesets[0].columns + x;
  walls.data = walls.data.map((_, index) => {
    const x = index % room.width, y = Math.floor(index / room.width);
    const col = x === 0 ? 0 : x === room.width - 1 ? 2 : 1;
    if (y === 0) return wall[col];
    if (y === 1) return wall[3 + col];
    if (y === 2) return wall[6 + col];
    if (y === room.height - 1) return timber(74 + col, 7);
    return col === 1 ? 0 : timber(74 + col, 8);
  });
  const collision = room.layers.find(layer => layer.name === "collision");
  // Furniture footprints extend back from the front edge of each piece.
  collision.data = collision.data.map((_, index) => {
    const x = index % room.width, y = Math.floor(index / room.width);
    return Number(x === 0 || x === room.width - 1 || y < 2 || y === room.height - 1);
  });
  const layout = [framing, ...furnish({ prop, frame, floor }), exit];
  room.layers.find(layer => layer.name === "furniture").objects = layout.map((item, index) => {
    const { name, col, footRow, width, height, footprintWidth, footprintDepth, properties } = item;
    for (let dy = 0; dy < footprintDepth; dy++) {
      for (let dx = 0; dx < footprintWidth; dx++) {
        const x = col + dx, y = footRow - dy;
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= room.width || y < 0 || y >= room.height) {
          throw new Error("Invalid furniture footprint: " + name);
        }
        collision.data[y * room.width + x] = 1;
      }
    }
    return {
      id: index + 1, name, type: "prop", x: col * tile, y: (footRow + 1) * tile - height, width, height, rotation: 0, visible: true,
      properties: Object.entries(properties).map(([name, value]) => ({
        name, type: typeof value === "boolean" ? "bool" : typeof value === "number" ? "int" : "string", value,
      })),
    };
  });
  room.nextobjectid = layout.length + 1;
  const file = path.join(maps, key + ".json"), encoded = JSON.stringify(room, null, 2) + "\n";
  if (process.argv.includes("--check")) {
    if (await fs.readFile(file, "utf8") !== encoded) throw new Error("Map differs from its layout: " + key);
  } else {
    await fs.writeFile(file, encoded);
  }
}
