import { taskFailed, taskPercent, taskStatus } from "./task-presentation";

export type ChapterNode = { id: number; title: string };
export type MaterialNode = { id: number; title: string; kind: string; status: string; chapter_ids: number[] };
export type PointNode = { id: number; chapter_id: number; title: string; pages?: number[] };
export type GraphData = { title: string; chapters: ChapterNode[]; materials: MaterialNode[] };
export type MaterialDetail = { points: PointNode[]; pages: number; narrations: number; drafts: number; audio: number };
export type PointDetail = PointNode & { questions: number; sources: { material_id: number; pages: number[] }[] };
export type Job = {
  material_id: number; kind: string; stage: string; queued: boolean; done: number; total: number;
  id?: number | null; run_id?: number | null; started_at?: string | null; percent?: number | null;
  status?: string; running?: boolean; failed?: { page_no?: number; error?: string }[];
  cancellable?: boolean; retryable?: boolean; retry_note?: string; message?: string;
};
export type Branch = { kind: "chapter" | "material"; id: number };
export type Selection = { kind: "course" | "chapter" | "material" | "point" | "narration" | "audio" | "task"; id: number };
export type Card = Selection & { key: string; title: string; caption?: string; x: number; y: number; side: number; draft?: boolean; task?: Job };
export const nodeKey = (selection: Selection) => selection.kind + "-" + selection.id;
export const materialKinds: Record<string, string> = { presentation: "PPT", pdf: "PDF", text: "文本", video: "视频" };
const jobKinds: Record<string, string> = {
  pipeline: "课程生成", generate: "讲稿生成", calibrate: "讲稿校准", audio: "语音合成", digest: "原文梳理",
};
export const jobTitle = (job: Job) => jobKinds[job.kind] ?? "课件处理";
// Old jobs without a run record have at most one row per material. A negative key
// keeps those nodes distinct from durable (positive) run IDs.
export const taskNodeId = (job: Job) => job.run_id ?? -job.material_id;
function taskCaption(job: Job) {
  const percent = taskPercent(job);
  return taskStatus(job) + (percent === null ? "" : " · " + percent + "%");
}
export const jobStage = (job: Job) => job.queued ? "等待执行" :
  ({ digest: "梳理原文", calibrate: "校准", apply: "应用修正", script: "编写讲稿" }[job.stage] ?? "处理中");

export function pageRanges(pages: number[]) {
  const ranges: [number, number][] = [];
  for (const page of [...new Set(pages)].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && last[1] + 1 === page) last[1] = page;
    else ranges.push([page, page]);
  }
  return ranges.map(([first, last]) => first === last ? first : first + "–" + last).join("、");
}

export function graphLayout(graph: GraphData, branch: Branch | null,
                            detail: MaterialDetail | null, jobs: Job[], point?: PointDetail) {
  const cards: Card[] = [];
  const links: { from: string; to: string; active?: boolean; failed?: boolean }[] = [];
  function add(kind: Selection["kind"], id: number, title: string, caption: string, x: number, y: number, side: number) {
    const key = nodeKey({ kind, id });
    const card: Card = { key, kind, id, title, caption, x, y, side };
    cards.push(card);
    return card;
  }
  const root = add("course", 0, graph.title, "课程", 0, 0, 1);
  const groups = graph.chapters.map(ch => ({ chapter: ch as ChapterNode | null, materials: [] as MaterialNode[] }));
  const unassigned = { chapter: null, materials: [] as MaterialNode[] };
  const chapterGroups = new Map(groups.map(g => [g.chapter!.id, g]));
  const collator = new Intl.Collator("zh-CN", { numeric: true });
  const sorted = [...graph.materials].sort((a, b) => collator.compare(a.title, b.title) || a.id - b.id);
  for (const m of sorted) {
    // One material card, with one edge from each actual chapter.
    (chapterGroups.get(m.chapter_ids[0]) ?? unassigned).materials.push(m);
  }
  if (unassigned.materials.length) groups.push(unassigned);
  const latestJobs = new Map<number, Job>();
  for (const job of jobs) {
    const prior = latestJobs.get(job.material_id);
    if (!prior || (job.run_id ?? 0) > (prior.run_id ?? 0)) latestJobs.set(job.material_id, job);
  }
  const rows = groups.map(g => {
    const selectedPoint = branch?.kind === "chapter" && branch.id === g.chapter?.id && point?.chapter_id === branch.id
      ? point : undefined;
    return { ...g, selectedPoint, height: Math.max(1, g.materials.length + (selectedPoint ? 1 : 0)) * 58 + 18 };
  });
  const height = rows.reduce((sum, g) => sum + g.height, 0);
  let split = rows.length > 1 ? 1 : rows.length;
  let leftHeight = rows[0]?.height ?? 0;
  while (split + 1 < rows.length && Math.abs(height / 2 - leftHeight - rows[split].height) < Math.abs(height / 2 - leftHeight)) {
    leftHeight += rows[split++].height;
  }
  const sides = [rows.slice(0, split), rows.slice(split)];
  for (const [index, sideGroups] of sides.entries()) {
    const side = index === 0 ? -1 : 1;
    let top = -sideGroups.reduce((sum, g) => sum + g.height, 0) / 2;
    for (const group of sideGroups) {
      const centerY = top + (group.height - 18) / 2;
      const chapter = group.chapter && add("chapter", group.chapter.id, group.chapter.title, "", side * 224, centerY, side);
      if (chapter) links.push({ from: root.key, to: chapter.key });
      let y = top + 29;
      for (const m of group.materials) {
        const item = add("material", m.id, m.title, materialKinds[m.kind] ?? "资料", side * 455, y, side);
        const job = latestJobs.get(m.id);
        if (job && (job.running || job.status === "running" || job.status === "cancelling" || taskFailed(job))) {
          item.caption += " · " + taskCaption(job);
          item.task = job;
        }
        if (m.chapter_ids.length) {
          for (const cid of m.chapter_ids) links.push({ from: "chapter-" + cid, to: item.key });
        } else links.push({ from: root.key, to: item.key });
        y += 58;
      }
      if (group.selectedPoint) {
        const p = group.selectedPoint;
        const item = add("point", p.id, p.title, "章节知识点", side * 455, y, side);
        links.push({ from: chapter!.key, to: item.key });
      }
      top += group.height;
    }
  }
  const parent = branch?.kind === "material" && cards.find(c => c.key === nodeKey(branch));
  if (parent) {
    const children: { kind: Selection["kind"]; id: number; title: string; caption: string; draft?: boolean; task?: Job }[] =
      (detail?.points ?? []).map(p => ({ kind: "point", id: p.id, title: p.title, caption: "知识点 · 第 " + pageRanges(p.pages ?? []) + " 页" }));
    if (detail?.narrations) children.push({ kind: "narration", id: parent.id, title: "逐页讲解稿", caption: detail.narrations + " 页" +
      (detail.drafts ? " · " + detail.drafts + " 页待审核" : ""), draft: detail.drafts > 0 });
    if (detail?.audio) children.push({ kind: "audio", id: parent.id, title: "讲解音频", caption: detail.audio + " 页已配音" });
    for (const job of jobs.filter(j => j.material_id === parent.id)) {
      children.push({ kind: "task", id: taskNodeId(job), title: jobTitle(job),
        caption: taskCaption(job), task: job });
    }
    children.forEach((child, i) => {
      const card = add(child.kind, child.id, child.title, child.caption, parent.x + parent.side * 234,
        parent.y + (i - (children.length - 1) / 2) * 59, parent.side);
      card.draft = child.draft;
      card.task = child.task;
      links.push({ from: parent.key, to: card.key,
        active: child.task?.status === "running" && !child.task.queued,
        failed: child.task && taskFailed(child.task) });
    });
  }
  if (point) {
    const to = nodeKey({ kind: "point", id: point.id });
    const existing = new Set(links.filter(link => link.to === to).map(link => link.from));
    for (const source of point.sources) {
      const from = nodeKey({ kind: "material", id: source.material_id });
      if (!existing.has(from)) links.push({ from, to });
    }
  }
  return { cards, links };
}
