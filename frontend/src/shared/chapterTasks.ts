import type {Npc} from "./types";

export type TaskKind = "reading" | "objective" | "programming" | "assessment";
export interface ChapterTask {
  id: string;
  material_id?: number;
  activity_id?: string;
  title: string;
  kind: TaskKind;
  required: boolean;
  rule?: {scope?: "all" | "range" | "count"; start_page?:number; end_page?:number; count?:number; minimum_seconds?:number; segments?: {start_seconds:number; end_seconds:number; label:string}[]};
  completed: boolean;
  locked: boolean;
  lock_reason: string | null;
  handed_in?: boolean;
  grading_status?: 'grading' | 'attention' | 'graded' | null;
  current: number;
  total: number;
  unit: string;
}
export interface TaskChapter {
  id: number;
  title: string;
  order_index: number;
  completed: boolean;
  tasks: ChapterTask[];
}
export const taskRoles = {
  reading: { key: "librarian", name: "图书管理员", label: "学习资料", goal: "阅读必读资料" },
  objective: { key: "professor", name: "教授", label: "客观题练习", goal: "完成客观题练习" },
  programming: { key: "coach", name: "练习场教练", label: "编程题练习", goal: "完成编程题练习" },
  assessment: { key: "mayor", name: "镇长", label: "章节测验", goal: "完成章节测验" },
} as const;
export const taskKinds = Object.keys(taskRoles) as TaskKind[];
type RoleNames = readonly Pick<Npc, "key" | "name">[];
export function taskRoleName(kind: TaskKind, npcs: RoleNames = []) {
  const role = taskRoles[kind];
  return npcs.find(npc => npc.key === role.key)?.name || role.name;
}
export function chapterGoals(chapters: TaskChapter[], npcs: RoleNames = []) {
  return chapters.flatMap(chapter => taskKinds.flatMap(kind => {
    const tasks = chapter.tasks.filter(task => task.kind === kind && task.required);
    if (!tasks.some(task => !task.completed && !task.locked && !task.handed_in)) return [];
    const progress = tasks.length > 1 ? `（${tasks.filter(task => task.completed).length}/${tasks.length}）` : "";
    const role = taskRoles[kind];
    return [{ id: `${chapter.id}:${kind}`, chapter, kind, target: role.key, title: `拜访${taskRoleName(kind, npcs)}，${role.goal}${progress}` }];
  }));
}
export function taskProgress(task: ChapterTask) {
  if (task.completed) return "已完成";
  if (task.handed_in) return task.grading_status === 'attention' ? '已交卷，等待老师核查' : '已交卷，正在批改';
  if (task.locked) return task.lock_reason || "请先完成本章前置任务";
  return task.total ? `${task.current} / ${task.total} ${task.unit}` : "待完成";
}
export function readingRequirement(task: ChapterTask) {
  const rule = task.rule;
  if (task.kind !== "reading" || !task.required) return "";
  const pages = rule?.scope === "range" ? `第 ${rule.start_page} 至 ${rule.end_page} 页` :
    rule?.scope === "count" ? `任意 ${rule.count} 个不同页` : rule?.scope === "all" || (!rule?.minimum_seconds && !rule?.segments?.length && task.unit === "页") ? "整份阅读" : "";
  return [pages, rule?.minimum_seconds ? `累计 ${rule.minimum_seconds} 秒` : "", ...(rule?.segments ?? []).map(s => s.label)].filter(Boolean).join("，");
}
const greetings = {
  reading: "来，给你留了个靠窗的位置。书架上的资料按章节放好了，你想先翻哪一份？",
  objective: "欢迎来工坊。我们把读过的知识拿出来试一试，看看哪道题能说清其中的道理。",
  programming: "练习台收拾好了。挑一组题，把自己的想法写成能跑的代码吧！",
  assessment: "来得正好。把这章学过的本领带上，选一份测验，看看自己的收获吧。",
};
export function greeting(chapters: TaskChapter[], kind: TaskKind) {
  const groups = chapters.map(chapter => ({ chapter, tasks: chapter.tasks.filter(t => t.kind === kind) })).filter(group => group.tasks.length);
  const tasks = groups.flatMap(group => group.tasks);
  if (!tasks.length) return { text: `老师还没有发布${taskRoles[kind].label}，等有新安排时再来找我吧。`, open: false };
  if (tasks.every(t => t.locked)) {
    const {chapter, tasks: first} = groups[0]!;
    return { text: `《${chapter.title}》还差一步：${first[0]!.lock_reason || "先完成本章前置任务"}。做好了就回来找我。`, open: false };
  }
  return { text: tasks.every(t => t.completed) ? "这一项你已经全部完成了。想再看看上回学到的内容吗？" : greetings[kind], open: true };
}
export function farewell(before: TaskChapter[], after: TaskChapter[], kind: TaskKind, npcs: RoleNames = []) {
  const changed = after.flatMap(chapter => {
    const old = before.find(c => c.id === chapter.id);
    if (!old) return [];
    const done = chapter.tasks.filter(t => t.kind === kind && t.completed && old.tasks.some(o => o.id === t.id && !o.completed));
    return done.length ? [{chapter, old, done}] : [];
  });
  const complete = changed.find(({chapter, old}) => chapter.completed && !old.completed);
  if (complete) return `《${complete.chapter.title}》的必做任务都完成了。这一章的收获，带着它继续往前走吧！`;
  const next = changed.flatMap(({chapter, old}) => chapter.tasks.filter(t => !t.completed && !t.locked && old.tasks.some(o => o.id === t.id && o.locked)).map(t => taskRoleName(t.kind, npcs)));
  if (next.length) return `这一步完成了。接下来可以去找${[...new Set(next)].join("或")}了。`;
  if (changed.length) return `《${changed[0]!.done[0]!.title}》完成了。剩下的内容，你可以按自己的步子来。`;
  return after.some(c => c.tasks.some(t => t.kind === kind && !t.completed)) ? "今天先到这里。下次回来，我们从刚才的进度接着学。" : "今天就到这里。等老师有了新安排，再来找我吧。";
}
