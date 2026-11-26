import type { KnowledgeChapter, KnowledgeOverview, KnowledgePointItem } from "@/lib/lectio-api";

export type GraphNodeKind = "course" | "chapter" | "section" | "point";
export type GraphVisualMode = "tree" | "radial";

export const BRANCH_COLORS = [
  "#0c7483",
  "#2d865e",
  "#c67227",
  "#5d57ac",
  "#2871b2",
  "#b44b60",
  "#198593",
  "#8c6728",
] as const;

export const NODE_RADIUS: Record<GraphNodeKind, number> = {
  course: 11,
  chapter: 8,
  section: 6,
  point: 4.5,
};

const FONT_SIZE: Record<GraphNodeKind, number> = {
  course: 17,
  chapter: 15,
  section: 13.5,
  point: 13.5,
};

export interface GNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  shortLabel: string;
  full: string;
  chapterId: number | null;
  pointId: number | null;
  point?: KnowledgePointItem;
  pages: number[];
  brief: string;
  questionCount: number;
  color: string;
  children: GNode[];
  parent: GNode | null;
  depth: number;
  x: number;
  y: number;
  angle: number;
  pw: number;
  ph: number;
  rot: number;
  flip: boolean;
}

export interface GraphLayoutMetrics {
  width: number;
  height: number;
  minX: number;
  minY: number;
  ring: number;
  orbits: number[];
  nodes: GNode[];
}

const LEADING_PREFIX_PATTERNS: RegExp[] = [
  /^\s*第\s*[一二三四五六七八九十百零〇两\d]+\s*[章节讲单元篇部分]\s*[、.．:：\-—–·•]?\s*/u,
  /^\s*(?:chapter|section|unit|part|lesson)\s+\d+(?:\.\d+)*\s*[.:：\-—–·]?\s*/i,
  /^\s*\d+(?:\.\d+){1,3}\s*[、.．:：\-—–·•]?\s*/,
  /^\s*[一二三四五六七八九十百]+[、.．:：]\s*/u,
  /^\s*[（(][一二三四五六七八九十百\d]+[）)]\s*[、.．:：]?\s*/u,
  /^\s*\d+\s*(?:[、．:：]|\.(?!\d))\s*/,
];

export function cleanGraphLabel(raw: string): string {
  const original = raw.trim();
  if (!original) return "";
  let current = original;
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    for (const pattern of LEADING_PREFIX_PATTERNS) {
      const next = current.replace(pattern, "").trim();
      if (next && next !== current) {
        current = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return current || original;
}

export function trimLabel(text: string, maxUnits: number): string {
  let units = 0;
  let out = "";
  for (const ch of text) {
    units += ch.charCodeAt(0) > 0x2e80 ? 1 : 0.56;
    if (units > maxUnits) return `${out}…`;
    out += ch;
  }
  return text;
}

function measureChars(text: string, size: number): number {
  return [...text].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? size : size * 0.63), 0);
}

function labelWidth(n: GNode): number {
  return measureChars(n.label, FONT_SIZE[n.kind]);
}

function makeNode(
  partial: Partial<GNode> & Pick<GNode, "id" | "kind" | "label">,
): GNode {
  return {
    shortLabel: partial.label,
    full: partial.label,
    chapterId: null,
    pointId: null,
    pages: [],
    brief: "",
    questionCount: 0,
    color: BRANCH_COLORS[0],
    children: [],
    parent: null,
    depth: 0,
    x: 0,
    y: 0,
    angle: 0,
    pw: 80,
    ph: 24,
    rot: 0,
    flip: false,
    ...partial,
  };
}

function uniqueSorted(nums: number[]): number[] {
  return [...new Set(nums.filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
}

function sectionNodesOf(
  chapter: KnowledgeChapter,
  startColorIdx: number,
): { sections: GNode[]; nextColorIdx: number } {
  const hasNamedSections = chapter.points.some((pt) => pt.section.trim().length > 0);
  if (!hasNamedSections) {
    let colorIdx = startColorIdx;
    const directPoints = chapter.points.map((pt) => {
      const color = BRANCH_COLORS[colorIdx % BRANCH_COLORS.length];
      colorIdx += 1;
      const ptPages = uniqueSorted(pt.sources.flatMap((s) => s.pages));
      const ptTitle = cleanGraphLabel(pt.title);
      return makeNode({
        id: `p:${pt.id}`,
        kind: "point",
        label: ptTitle,
        shortLabel: trimLabel(ptTitle, 14),
        full: ptTitle,
        chapterId: chapter.id,
        pointId: pt.id,
        point: pt,
        pages: ptPages,
        brief: pt.brief || "",
        questionCount: pt.question_count,
        color,
      });
    });
    return { sections: directPoints, nextColorIdx: colorIdx };
  }

  const groups = new Map<string, KnowledgePointItem[]>();
  for (const pt of chapter.points) {
    const rawSec = pt.section.trim();
    const key = rawSec ? cleanGraphLabel(rawSec) : "其他知识点";
    const list = groups.get(key) ?? [];
    list.push(pt);
    groups.set(key, list);
  }

  let colorIdx = startColorIdx;
  const sections: GNode[] = [];
  let si = 0;
  for (const [secTitle, pts] of groups) {
    const color = BRANCH_COLORS[colorIdx % BRANCH_COLORS.length];
    colorIdx += 1;
    const secPages = uniqueSorted(pts.flatMap((p) => p.sources.flatMap((s) => s.pages)));
    const secNode = makeNode({
      id: `s:${chapter.id}:${si}`,
      kind: "section",
      label: secTitle,
      shortLabel: trimLabel(secTitle, 13),
      full: secTitle,
      chapterId: chapter.id,
      pages: secPages,
      questionCount: pts.reduce((acc, p) => acc + p.question_count, 0),
      color,
    });
    for (const pt of pts) {
      const ptPages = uniqueSorted(pt.sources.flatMap((s) => s.pages));
      const ptTitle = cleanGraphLabel(pt.title);
      secNode.children.push(
        makeNode({
          id: `p:${pt.id}`,
          kind: "point",
          label: ptTitle,
          shortLabel: trimLabel(ptTitle, 14),
          full: ptTitle,
          chapterId: chapter.id,
          pointId: pt.id,
          point: pt,
          pages: ptPages,
          brief: pt.brief || "",
          questionCount: pt.question_count,
          color,
        }),
      );
    }
    sections.push(secNode);
    si += 1;
  }
  return { sections, nextColorIdx: colorIdx };
}

export function buildKnowledgeTree(
  overview: KnowledgeOverview | null,
  courseTitle: string,
  scope: string,
): GNode | null {
  const chapters = overview?.chapters ?? [];
  if (!chapters.length) return null;

  let top: GNode;
  if (scope !== "all") {
    const ch = chapters.find((c) => String(c.id) === scope) ?? chapters[0];
    const { sections } = sectionNodesOf(ch, 0);
    const chLabel = cleanGraphLabel(ch.title);
    top = makeNode({
      id: `c:${ch.id}`,
      kind: "chapter",
      label: chLabel,
      shortLabel: trimLabel(chLabel, 12),
      full: chLabel,
      chapterId: ch.id,
      color: BRANCH_COLORS[0],
      children: sections,
    });
  } else if (chapters.length === 1) {
    const ch = chapters[0];
    const { sections } = sectionNodesOf(ch, 0);
    const chLabel = cleanGraphLabel(ch.title);
    const label = chLabel || courseTitle || "课程知识图谱";
    top = makeNode({
      id: `c:${ch.id}`,
      kind: "chapter",
      label,
      shortLabel: trimLabel(label, 12),
      full: chLabel || label,
      chapterId: ch.id,
      color: BRANCH_COLORS[0],
      children: sections,
    });
  } else {
    const rootName = courseTitle || "课程知识图谱";
    top = makeNode({
      id: "root",
      kind: "course",
      label: rootName,
      shortLabel: trimLabel(rootName, 12),
      full: rootName,
      color: BRANCH_COLORS[0],
    });
    let colorIdx = 0;
    for (const ch of chapters) {
      const chColor = BRANCH_COLORS[colorIdx % BRANCH_COLORS.length];
      const built = sectionNodesOf(ch, colorIdx);
      colorIdx = built.nextColorIdx === colorIdx ? colorIdx + 1 : built.nextColorIdx;
      const chPages = uniqueSorted(built.sections.flatMap((s) => s.pages));
      const chLabel = cleanGraphLabel(ch.title);
      const chNode = makeNode({
        id: `c:${ch.id}`,
        kind: "chapter",
        label: chLabel,
        shortLabel: trimLabel(chLabel, 12),
        full: chLabel,
        chapterId: ch.id,
        pages: chPages,
        questionCount: ch.points.reduce((acc, p) => acc + p.question_count, 0),
        color: chColor,
        children: built.sections,
      });
      top.children.push(chNode);
    }
  }

  top.pages = uniqueSorted(
    top.children.flatMap((c) => [...c.pages, ...c.children.flatMap((g) => g.pages)]),
  );

  const assignDepth = (node: GNode, depth: number, parent: GNode | null) => {
    node.depth = depth;
    node.parent = parent;
    for (const child of node.children) assignDepth(child, depth + 1, node);
  };
  assignDepth(top, 0, null);
  return top;
}

function flattenNodes(top: GNode): GNode[] {
  const out: GNode[] = [];
  const walk = (n: GNode) => {
    out.push(n);
    for (const child of n.children) walk(child);
  };
  walk(top);
  return out;
}

function leafSlots(top: GNode): Map<GNode, number> {
  const slots = new Map<GNode, number>();
  let cursor = 0;
  let last: GNode | null = null;
  const walk = (n: GNode) => {
    if (!n.children.length) {
      if (last) {
        const chapterChanged = last.chapterId !== n.chapterId;
        const parentChanged = last.parent !== n.parent;
        cursor += chapterChanged ? 2 : parentChanged ? 1.5 : 1;
      }
      slots.set(n, cursor);
      last = n;
      return;
    }
    for (const child of n.children) walk(child);
  };
  walk(top);
  return slots;
}

function settleParents(n: GNode, key: "angle" | "y") {
  if (!n.children.length) return;
  for (const child of n.children) settleParents(child, key);
  n[key] = (n.children[0][key] + n.children[n.children.length - 1][key]) / 2;
}

function relaxHorizontalPills(items: GNode[]) {
  for (let iter = 0; iter < 18; iter++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const needX = (a.pw + b.pw) / 2 + 12;
        const needY = (a.ph + b.ph) / 2 + 8;
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        if (ax < needX && ay < needY) {
          moved = true;
          const ox = needX - ax;
          const oy = needY - ay;
          if (oy <= ox * 1.15) {
            const sy = dy >= 0 ? 1 : -1;
            const step = oy * 0.52;
            a.y -= sy * step;
            b.y += sy * step;
          } else {
            const sx = dx >= 0 ? 1 : -1;
            const step = ox * 0.45;
            a.x -= sx * step;
            b.x += sx * step;
          }
        }
      }
    }
    if (!moved) break;
  }
}

export function computeGraphLayout(top: GNode | null, mode: GraphVisualMode): GraphLayoutMetrics {
  if (!top) return { width: 0, height: 0, minX: 0, minY: 0, ring: 0, orbits: [], nodes: [] };
  const nodes = flattenNodes(top);
  const slots = leafSlots(top);
  const span = Math.max(1, ...slots.values()) + 1;
  const maxDepth = Math.max(1, ...nodes.map((n) => n.depth));

  if (mode === "radial") {
    for (const n of nodes) {
      if (n.depth === 0) {
        n.pw = Math.max(120, measureChars(n.shortLabel, 15.5) + 40);
        n.ph = 42;
      } else if (n.kind === "chapter") {
        n.pw = Math.max(88, measureChars(n.shortLabel, 13.5) + 34);
        n.ph = 30;
      } else if (n.kind === "section") {
        n.pw = Math.max(96, measureChars(n.shortLabel, 12.5) + 36);
        n.ph = 27;
      } else {
        n.pw = Math.max(66, measureChars(n.shortLabel, 12) + 22);
        n.ph = 21;
      }
    }

    const sectionsCount = nodes.filter((n) => n.kind === "section" && n.depth > 0).length;
    const minLeafArc = span >= 30 ? 44 : 34;
    const radius = [0];
    if (maxDepth >= 3) {
      const r1 = Math.max(132, top.pw / 2 + 86);
      const r2 = Math.max(r1 + 168, (sectionsCount * 96) / (2 * Math.PI));
      const r3 = Math.max(r2 + 168, (span * minLeafArc) / (2 * Math.PI));
      radius.push(r1, r2, r3);
      for (let d = 4; d <= maxDepth; d++) radius.push(radius[d - 1] + 140);
    } else if (maxDepth === 2) {
      const r1 = Math.max(176, top.pw / 2 + 112, (sectionsCount * 92) / (2 * Math.PI));
      const r2 = Math.max(r1 + 172, (span * minLeafArc) / (2 * Math.PI));
      radius.push(r1, r2);
    } else {
      radius.push(Math.max(176, top.pw / 2 + 114, (span * minLeafArc) / (2 * Math.PI)));
    }

    for (const [leaf, slot] of slots) leaf.angle = (slot / span) * Math.PI * 2;
    settleParents(top, "angle");
    if (!top.children.length) top.angle = 0;

    for (const n of nodes) {
      const r = radius[n.depth] ?? 0;
      const theta = n.angle - Math.PI / 2;
      n.x = r * Math.cos(theta);
      n.y = r * Math.sin(theta);
      if (!n.children.length && n.depth > 0) {
        const deg = (n.angle * 180) / Math.PI - 90;
        n.flip = Math.cos(theta) < 0;
        n.rot = n.flip ? deg + 180 : deg;
      } else {
        n.flip = false;
        n.rot = 0;
      }
    }

    const sections = nodes.filter((n) => n.kind === "section" && n.depth > 0);
    if (sections.length > 1) relaxHorizontalPills(sections);
    const chaptersLayer = nodes.filter((n) => n.kind === "chapter" && n.depth > 0);
    if (chaptersLayer.length > 1) relaxHorizontalPills(chaptersLayer);

    const ring = radius[maxDepth];
    let minX = -top.pw / 2 - 20;
    let maxX = top.pw / 2 + 20;
    let minY = -top.ph / 2 - 20;
    let maxY = top.ph / 2 + 20;

    for (const n of nodes) {
      if (n.depth === 0 || n.children.length) {
        minX = Math.min(minX, n.x - n.pw / 2 - 8);
        maxX = Math.max(maxX, n.x + n.pw / 2 + 8);
        minY = Math.min(minY, n.y - n.ph / 2 - 8);
        maxY = Math.max(maxY, n.y + n.ph / 2 + 8);
        continue;
      }
      const theta = n.angle - Math.PI / 2;
      const rNode = Math.hypot(n.x, n.y);
      const rTip = rNode + 9 + n.pw;
      const tipX = rTip * Math.cos(theta);
      const tipY = rTip * Math.sin(theta);
      const pad = 15;
      minX = Math.min(minX, n.x - pad, tipX - pad);
      maxX = Math.max(maxX, n.x + pad, tipX + pad);
      minY = Math.min(minY, n.y - pad, tipY - pad);
      maxY = Math.max(maxY, n.y + pad, tipY + pad);
    }

    minX -= 48;
    maxX += 48;
    minY -= 44;
    maxY += 88;
    return { width: maxX - minX, height: maxY - minY, minX, minY, ring, orbits: radius, nodes };
  }

  const maxInternalLabel = Math.max(
    140,
    ...nodes.filter((n) => n.depth > 0 && n.children.length > 0).map((n) => labelWidth(n) + 32),
  );
  const maxLeafLabel = Math.max(
    240,
    ...nodes.filter((n) => n.children.length === 0).map((n) => labelWidth(n) + 40),
  );
  const col = Math.min(320, Math.max(220, maxInternalLabel));
  const row = 30;
  for (const [leaf, slot] of slots) leaf.y = slot * row;
  settleParents(top, "y");
  for (const n of nodes) n.x = n.depth * col;
  const height = span * row;
  const left = labelWidth(top) + NODE_RADIUS[top.kind] + 32;
  return {
    width: maxDepth * col + maxLeafLabel + left,
    height: height + 112,
    minX: -left,
    minY: -56,
    ring: 0,
    orbits: [],
    nodes,
  };
}

export function edgePath(n: GNode, mode: GraphVisualMode): string {
  const p = n.parent;
  if (!p) return "";
  if (mode === "tree") {
    const mx = (p.x + n.x) / 2;
    return `M${p.x},${p.y} C${mx},${p.y} ${mx},${n.y} ${n.x},${n.y}`;
  }
  const pr = Math.hypot(p.x, p.y);
  const nr = Math.hypot(n.x, n.y);
  const mid = (pr + nr) / 2;
  const fromTheta = p.depth === 0 ? Math.atan2(n.y, n.x) : Math.atan2(p.y, p.x);
  const toTheta = Math.atan2(n.y, n.x);
  const c1x = mid * Math.cos(fromTheta);
  const c1y = mid * Math.sin(fromTheta);
  const c2x = mid * Math.cos(toTheta);
  const c2y = mid * Math.sin(toTheta);
  return `M${p.x},${p.y} C${c1x},${c1y} ${c2x},${c2y} ${n.x},${n.y}`;
}

export function treeLabelAttrs(n: GNode) {
  const r = NODE_RADIUS[n.kind] + 6;
  if (n.depth === 0) return { x: n.x - r, y: n.y + 5, anchor: "end" as const };
  if (n.children.length) return { x: n.x - r, y: n.y - r - 2, anchor: "end" as const };
  return { x: n.x + r, y: n.y + 4, anchor: "start" as const };
}
