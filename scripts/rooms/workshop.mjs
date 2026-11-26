const art = "/assets/pixel/props/super-retro-world/";

export default function workshop({ frame, prop }) {
  const furniture = [
    prop("chalkboard", 7.5, 1.5, art + "practice-hall/teaching-slate.png", 48, 28),
    frame("reference_shelf", 2, 3, [1552, 608, 32, 32], 2),
    frame("specimen_cabinet", 14, 3, [1728, 640, 32, 32], 2),
    frame("west_window", 4, 1, [1668, 120, 24, 15]),
    frame("east_window", 12.5, 1, [1668, 120, 24, 15]),
  ];
  for (const x of [3, 12]) {
    for (const y of [6, 10]) {
      furniture.push(prop(`desk_${x}_${y}`, x, y, art + "practice-hall/student-workbench.png", 48, 36, 3, 2));
      furniture.push(frame(`chair_${x}_${y}`, x + 1, y + 1, [1664, 592, 16, 16], 1));
    }
  }
  return furniture;
}
