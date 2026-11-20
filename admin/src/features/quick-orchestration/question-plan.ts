import { questionKindLabels, type QuestionKind } from "../../../../shared/questions";
import type { CatalogChapter, ChapterSelection, KindCounts, PointQuota, QuestionStage, Recipe, StageRule } from "./contracts";

export const questionKinds = Object.keys(questionKindLabels) as QuestionKind[];
export const stageNames = { practice: "练习", assessment: "测验" };
export function validCount(count: number, min = 1) {
  return Number.isInteger(count) && count >= min && count <= 100;
}
export function defaultCount(recipe: Recipe, stage: QuestionStage) {
  return stage === "practice" ? recipe.practice_count : recipe.quiz_count;
}
export function stageCount(recipe: Recipe, selection: ChapterSelection, stage: QuestionStage) {
  const rule = selection.question_plan?.[stage];
  if (!rule) return defaultCount(recipe, stage);
  return rule.mode === "total" ? rule.count : rule.points.reduce((total, point) => total + point.count, 0);
}
export function describeKinds(counts?: KindCounts) {
  return questionKinds.filter(kind => counts?.[kind] !== undefined)
    .map(kind => `${questionKindLabels[kind]} ${counts![kind]} 题`).join("、");
}
export function stageSummary(recipe: Recipe, selection: ChapterSelection, stage: QuestionStage) {
  const rule = selection.question_plan?.[stage];
  const count = stageCount(recipe, selection, stage);
  const total = Number.isFinite(count) ? count : "—";
  if (!rule) return `整章最多 ${total} 题（课程默认）`;
  if (rule.mode === "by_point") return `按知识点分配，共 ${total} 题`;
  const kinds = describeKinds(rule.by_kind);
  return `整章共 ${total} 题${kinds ? `（${kinds}）` : ""}`;
}
export function withStageRule(selection: ChapterSelection, stage: QuestionStage, rule?: StageRule): ChapterSelection {
  const plan = { ...selection.question_plan };
  if (rule) plan[stage] = rule;
  else delete plan[stage];
  const result = { ...selection };
  if (Object.keys(plan).length) result.question_plan = plan;
  else delete result.question_plan;
  return result;
}
export function withoutAssessmentPlan(selection: ChapterSelection): ChapterSelection {
  return withStageRule(selection, "assessment");
}
export function pointQuotas(ids: string[], count = 1): PointQuota[] {
  return ids.map(knowledge_point_id => ({ knowledge_point_id, count }));
}
export function withSelectedPoints(selection: ChapterSelection, ids: string[]): ChapterSelection {
  let next = { ...selection, knowledge_point_ids: ids };
  for (const stage of ["practice", "assessment"] as const) {
    const rule = selection.question_plan?.[stage];
    if (rule?.mode !== "by_point") continue;
    const previous = new Map(rule.points.map(point => [point.knowledge_point_id, point]));
    const firstCount = rule.points[0]?.count;
    const commonCount = validCount(firstCount, 0) && rule.points.every(point => point.count === firstCount) ? firstCount : 1;
    const points = ids.map(id => previous.get(id) ?? { knowledge_point_id: id, count: commonCount });
    next = withStageRule(next, stage, { mode: "by_point", points });
  }
  return next;
}
export function applyPerPointToInherited(recipe: Recipe, stage: QuestionStage, perPoint: number): Recipe {
  return { ...recipe, chapters: recipe.chapters.map(selection =>
    selection.question_plan?.[stage] ? selection : withStageRule(selection, stage, {
      mode: "by_point", points: pointQuotas(selection.knowledge_point_ids, perPoint),
    }),
  ) };
}
export function kindProblem(count: number, byKind?: KindCounts) {
  const values = Object.values(byKind ?? {});
  if (values.some(value => !validCount(value, 0))) return "每种题型请填写 0 至 100 的整数。";
  const exact = values.reduce((total, value) => total + value, 0);
  if (exact > count) return `指定题型共 ${exact} 题，超过题数 ${count}。请调整题型或总数。`;
  if (values.length === questionKinds.length && exact < count) return `已指定全部题型，还差 ${count - exact} 题才能满足总数。`;
  return "";
}
export function quotaProblems(recipe: Recipe, withQuiz: boolean, chapters: CatalogChapter[] = []) {
  const errors: string[] = [];
  for (const stage of ["practice", "assessment"] as const) {
    if (stage === "assessment" && !withQuiz) continue;
    if (!validCount(defaultCount(recipe, stage))) errors.push(`每章默认${stageNames[stage]}题数须为 1 至 100 的整数。`);
    for (const [index, row] of recipe.chapters.entries()) {
      const rule = row.question_plan?.[stage];
      if (!rule) continue;
      const chapter = chapters.find(ch => ch.id === row.chapter_id);
      const prefix = `《${chapter?.title ?? `第 ${index + 1} 章`}》${stageNames[stage]}`;
      if (!validCount(stageCount(recipe, row, stage))) errors.push(`${prefix}共需 1 至 100 题。`);
      if (rule.mode === "total") {
        const message = kindProblem(rule.count, rule.by_kind);
        if (message) errors.push(prefix + "：" + message);
      } else {
        const pointIds = new Set(rule.points.map(point => point.knowledge_point_id));
        if (pointIds.size !== rule.points.length || pointIds.size !== row.knowledge_point_ids.length
            || row.knowledge_point_ids.some(id => !pointIds.has(id))) {
          errors.push(`${prefix}的题量设置与所选知识点不一致，请重新选择。`);
        }
        for (const [i, point] of rule.points.entries()) {
          const title = chapter?.knowledge_points.find(item => item.id === point.knowledge_point_id)?.title ?? `知识点 ${i + 1}`;
          const message = validCount(point.count, 0) ? kindProblem(point.count, point.by_kind) : "题数须为 0 至 100 的整数。";
          if (message) errors.push(`${prefix} · ${title}：${message}`);
        }
      }
    }
  }
  return errors;
}
