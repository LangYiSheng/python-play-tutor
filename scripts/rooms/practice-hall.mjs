// Native Farming atlas crops: the mat uses the woven border at (1653,707);
// the slate uses the wood frame at (1584,644) with a chalk diagram.
// Both student desks use the table at (1616,520) and Props/Books/Sprites/book_07.
const art = "/assets/pixel/props/super-retro-world/practice-hall/";

export default function practiceHall({ prop, frame, floor }) {
  return [
    floor("coach_demonstration_mat", 7, 6, art + "demonstration-mat.png", 80, 43),

    frame("west_workshop_window", 2.25, 0.625, [1668, 120, 24, 15]),
    frame("east_workshop_window", 14, 0.625, [1668, 120, 24, 15]),
    prop("teaching_slate", 8, 1.25, art + "teaching-slate.png", 48, 28),

    frame("supplies_cabinet", 13, 3, [1728, 640, 32, 32], 2),
    frame("supplies_drawers", 15, 3, [1760, 640, 16, 32], 1),

    prop("west_student_workbench", 4, 8, art + "student-workbench.png", 48, 36, 3, 2),
    frame("west_student_chair", 5, 9, [1664, 592, 16, 16], 1),
    prop("east_student_workbench", 12, 8, art + "student-workbench.png", 48, 36, 3, 2),
    frame("east_student_chair", 13, 9, [1664, 592, 16, 16], 1),
  ];
}
