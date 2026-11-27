/** Shared Python coding-question subtype metadata and fill-code skeleton validation. */

export const CODING_TYPES = ["fill_code", "debug", "design"] as const;
export type CodingType = (typeof CODING_TYPES)[number];

export const codingTypeLabels: Record<CodingType, string> = {
  fill_code: "程序填空",
  debug: "程序改错",
  design: "程序设计",
};

export const CODING_USAGES = ["both", "practice", "assessment"] as const;
export type CodingUsage = (typeof CODING_USAGES)[number];

export const codingUsageLabels: Record<CodingUsage, string> = {
  both: "通用",
  practice: "练习池",
  assessment: "测验专用",
};

export const FILL_START_RE = /^[ \t]*#[ \t]*===[ \t]*填空区(?:[ \t]*([0-9]+))?[ \t]*开始[ \t]*===[ \t]*$/;
export const FILL_END_RE = /^[ \t]*#[ \t]*===[ \t]*填空区(?:[ \t]*([0-9]+))?[ \t]*结束[ \t]*===[ \t]*$/;

export interface FillSlotRange {
  id: string;
  /** 1-based line number of `# === 填空区 N 开始 ===`. */
  startMarkerLine: number;
  /** 1-based line number of `# === 填空区 N 结束 ===`. */
  endMarkerLine: number;
}

export interface FillTemplate {
  slotIds: string[];
  skeletonSegments: string[][];
  slots: string[][];
  ranges: FillSlotRange[];
  markerLines: number[];
}

export function isCodingType(value: unknown): value is CodingType {
  return typeof value === "string" && (CODING_TYPES as readonly string[]).includes(value);
}

export function isCodingUsage(value: unknown): value is CodingUsage {
  return typeof value === "string" && (CODING_USAGES as readonly string[]).includes(value);
}

export function readCodingType(source: Record<string, unknown> | undefined | null): CodingType | "" {
  const raw = source?.coding_type;
  return isCodingType(raw) ? raw : "";
}

export function readCodingUsage(source: Record<string, unknown> | undefined | null): CodingUsage {
  const raw = source?.usage;
  return isCodingUsage(raw) ? raw : "both";
}

export function readReferenceSolution(answer: unknown): string {
  if (answer && typeof answer === "object" && !Array.isArray(answer) && "reference_solution" in answer) {
    const raw = (answer as { reference_solution?: unknown }).reference_solution;
    return typeof raw === "string" ? raw : "";
  }
  return "";
}

function normCode(code: string): string {
  return code.replace(/^\ufeff/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normLines(code: string): string[] {
  return normCode(code).split("\n");
}

export function nextFillSlotSnippet(existingCode: string): string {
  const lines = normLines(existingCode);
  let maxId = 0;
  for (const line of lines) {
    const match = FILL_START_RE.exec(line);
    if (match?.[1]) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed > maxId) maxId = parsed;
    } else if (match) {
      maxId += 1;
    }
  }
  const next = maxId + 1;
  return `# === 填空区 ${next} 开始 ===\npass  # 请在此补全代码\n# === 填空区 ${next} 结束 ===`;
}

function trimOuterBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !(lines[start] ?? "").trim()) start += 1;
  while (end > start && !(lines[end - 1] ?? "").trim()) end -= 1;
  return lines.slice(start, end);
}

export function parseFillTemplate(code: string): { template: FillTemplate | null; error: string | null } {
  const lines = normLines(code);
  const skeletonSegments: string[][] = [];
  const slots: string[][] = [];
  const slotIds: string[] = [];
  const seenIds = new Set<string>();
  const ranges: FillSlotRange[] = [];
  const markerLines: number[] = [];

  let currentSkeleton: string[] = [];
  let currentSlot: string[] | null = null;
  let activeId: string | null = null;
  let activeStartLine = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const rawLine = lines[i] ?? "";
    const trimmedRight = rawLine.trimEnd();
    const startMatch = FILL_START_RE.exec(rawLine);
    const endMatch = FILL_END_RE.exec(rawLine);

    if (startMatch) {
      if (currentSlot !== null) {
        return { template: null, error: `第 ${lineNo} 行出现嵌套的填空区开始标记` };
      }
      const slotId = startMatch[1] || String(slotIds.length + 1);
      if (seenIds.has(slotId)) {
        return { template: null, error: `第 ${lineNo} 行出现重复的填空区编号：${slotId}` };
      }
      seenIds.add(slotId);
      markerLines.push(lineNo);
      currentSkeleton.push(trimmedRight);
      skeletonSegments.push(currentSkeleton);
      currentSkeleton = [];
      currentSlot = [];
      activeId = slotId;
      activeStartLine = lineNo;
    } else if (endMatch) {
      if (currentSlot === null) {
        return { template: null, error: `第 ${lineNo} 行出现未配对的填空区结束标记` };
      }
      const endId = endMatch[1] || activeId;
      if (endId !== activeId) {
        return {
          template: null,
          error: `第 ${lineNo} 行填空区编号不匹配（开始为 ${activeId}，结束为 ${endId}）`,
        };
      }
      const id = activeId ?? String(slotIds.length + 1);
      markerLines.push(lineNo);
      slots.push(currentSlot);
      slotIds.push(id);
      ranges.push({ id, startMarkerLine: activeStartLine, endMarkerLine: lineNo });
      currentSlot = null;
      activeId = null;
      activeStartLine = 0;
      currentSkeleton = [trimmedRight];
    } else if (currentSlot !== null) {
      currentSlot.push(trimmedRight);
    } else {
      currentSkeleton.push(trimmedRight);
    }
  }

  if (currentSlot !== null) {
    return { template: null, error: `填空区 ${activeId} 缺少结束标记` };
  }
  if (!slotIds.length) {
    return {
      template: null,
      error: "程序填空题缺少 `# === 填空区 1 开始 ===` / `# === 填空区 1 结束 ===` 标记",
    };
  }
  skeletonSegments.push(currentSkeleton);
  return { template: { slotIds, skeletonSegments, slots, ranges, markerLines }, error: null };
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Lightweight Python lexical scan verifying markers stay outside strings and bracket depth matches. */
function lexicalMarkerState(
  code: string,
  markerLines: number[],
): { commentLines: Set<number>; depths: Map<number, number>; error: string | null } {
  const src = normCode(code);
  const markerSet = new Set(markerLines);
  const commentLines = new Set<number>();
  const depths = new Map<number, number>();
  let line = 1;
  let depth = 0;
  let i = 0;
  let quote: string | null = null;
  let triple = false;
  let escaped = false;

  while (i < src.length) {
    const ch = src[i] ?? "";
    if (quote) {
      if (ch === "\n") {
        if (!triple && !escaped) {
          return { commentLines, depths, error: `第 ${line} 行存在未闭合的字符串` };
        }
        line += 1;
        escaped = false;
        i += 1;
        continue;
      }
      if (escaped) {
        escaped = false;
        i += 1;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        i += 1;
        continue;
      }
      if (triple) {
        if (src.startsWith(quote.repeat(3), i)) {
          quote = null;
          triple = false;
          i += 3;
          continue;
        }
      } else if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }

    if (ch === "#") {
      if (markerSet.has(line)) {
        commentLines.add(line);
        depths.set(line, depth);
      }
      const nl = src.indexOf("\n", i);
      if (nl < 0) break;
      line += 1;
      i = nl + 1;
      continue;
    }
    if (ch === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (src.startsWith(ch.repeat(3), i)) {
        quote = ch;
        triple = true;
        i += 3;
      } else {
        quote = ch;
        triple = false;
        i += 1;
      }
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
    }
    i += 1;
  }

  if (quote) {
    return { commentLines, depths, error: "代码存在未闭合的字符串字面量" };
  }
  return { commentLines, depths, error: null };
}

/** Verify submitted code preserves all locked skeleton lines outside fill slots. */
export function validateFillSubmission(starterCode: string, submittedCode: string): string[] {
  const starter = parseFillTemplate(starterCode);
  if (starter.error || !starter.template) {
    return [`初始模板无效：${starter.error ?? "解析失败"}`];
  }
  const submitted = parseFillTemplate(submittedCode);
  if (submitted.error || !submitted.template) {
    return [`提交代码破坏了填空区标记：${submitted.error ?? "解析失败"}`];
  }
  if (!sameLines(starter.template.slotIds, submitted.template.slotIds)) {
    return [
      `填空区数量或编号被修改（期望 ${starter.template.slotIds.join(", ")}，实际 ${submitted.template.slotIds.join(", ")}）`,
    ];
  }
  const errors: string[] = [];
  const total = starter.template.skeletonSegments.length;
  for (let i = 0; i < total; i += 1) {
    const exp = starter.template.skeletonSegments[i] ?? [];
    const act = submitted.template.skeletonSegments[i] ?? [];
    const normExp = i === 0 || i === total - 1 ? trimOuterBlankLines(exp) : exp;
    const normAct = i === 0 || i === total - 1 ? trimOuterBlankLines(act) : act;
    if (!sameLines(normExp, normAct)) {
      errors.push(`锁定框架第 ${i + 1} 段被修改，请仅在填空区标记内作答`);
    }
  }
  if (errors.length) return errors;

  const subLex = lexicalMarkerState(submittedCode, submitted.template.markerLines);
  if (subLex.error) return [subLex.error];
  for (const mLine of submitted.template.markerLines) {
    if (!subLex.commentLines.has(mLine)) {
      return ["填空区标记被未闭合的字符串吞并，请勿跨填空区包裹锁定框架"];
    }
  }
  const starterLex = lexicalMarkerState(starterCode, starter.template.markerLines);
  if (!starterLex.error) {
    for (let i = 0; i < starter.template.markerLines.length; i += 1) {
      const expLine = starter.template.markerLines[i] ?? 0;
      const actLine = submitted.template.markerLines[i] ?? 0;
      if ((subLex.depths.get(actLine) ?? 0) !== (starterLex.depths.get(expLine) ?? 0)) {
        return ["填空区内存在未闭合的括号跨过锁定框架，请检查圆括号、方括号或花括号配对"];
      }
    }
  }
  return [];
}
