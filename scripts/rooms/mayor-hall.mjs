// Source coordinates below are native pixels in SuperRetroWorld_Farming_Tileset.png.
// The ivory plaster panels have their own dark timber edging.
export const shell = {
  wall: [1528, 1529, 1530, 1640, 1641, 1642, 1752, 1753, 1754],
};

const props = "/assets/pixel/props/super-retro-world/";
const hall = props + "mayor-hall/";

export default function mayorHall({ prop, frame, floor }) {
  // Native-sized wall ornaments and desk accessories are positioned in pixels.
  const hanging = (name, x, bottom, area) => frame(name, x / 16, bottom / 16 - 1, area);
  const window = (name, x) => [
    hanging(name + "_glass", x + 6, 27, [1668, 120, 24, 15]),
    hanging(name + "_left_curtain", x, 29, [1618, 151, 9, 19]),
    hanging(name + "_right_curtain", x + 27, 29, [1636, 151, 9, 19]),
  ];

  return [
    // Burgundy woven runner. The border comes from the atlas rug at (1653,691),
    // with its own four loom colours repeated in the small compass motif.
    floor("council_runner", 127 / 16, 188 / 16 - 1, hall + "council-runner.png", 50, 106),
    // The map, register and the mayor share one sight line from the front door.
    ...window("west_window", 58),
    ...window("east_window", 209),
    hanging("district_map", 136, 30, [1584, 580, 32, 24]),
    hanging("local_landscape", 22, 26, [1584, 644, 32, 22]),
    hanging("municipal_clock", 254, 30, [1681, 600, 14, 14]),
    // The desk uses the atlas wood table (1618,523), a ceramic seal pot,
    // and the open ledger from Props/Books/Sprites/book_07.png.
    prop("town_register_desk", 8, 4, hall + "council-desk.png", 48, 36, 3, 2),
    // The bench at (1552,456,32,24) has four-pixel slats. Five extra center
    // slats lengthen its seat and backrest between the two original legs.
    prop("waiting_bench", 3, 4, hall + "waiting-bench.png", 48, 24, 3),
    prop("waiting_area_plant", 2, 3, props + "potted_plants/potted_plant_01.png", 16, 25, 1),

    // The town's records occupy the north-east corner. Visitors can approach
    // the small writing station without crossing the central aisle.
    frame("municipal_archives", 13, 3, [1552, 608, 32, 32], 2),
    frame("document_drawers", 15, 3, [1760, 640, 16, 32], 1),
    // The writing table and tucked chair stand close to the record cabinets.
    prop("petition_writing_table", 13, 7, hall + "petition-table.png", 32, 48, 2, 3),
  ];
}
