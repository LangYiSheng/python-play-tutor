import type { ResetImpact } from "@/features/authoring/contracts";
import type { QuestionKind } from "../../../../shared/questions";

export type NamedItem = { id: string; title: string };
export type TownFeature = NamedItem & { description: string; default_enabled: boolean };
export type CourseTemplate = NamedItem & {
  stages: { kind: "lesson" | "practice" | "assessment"; label: string; location: string }[];
  features?: TownFeature[];
};
export type QuestionStage = "practice" | "assessment";
export type KindCounts = Partial<Record<QuestionKind, number>>;
export type PointQuota = { knowledge_point_id: string; count: number; by_kind?: KindCounts };
export type StageRule = { mode: "total"; count: number; by_kind?: KindCounts } | { mode: "by_point"; points: PointQuota[] };
export type KnowledgePoint = NamedItem & { available_questions?: Record<QuestionStage, KindCounts> };
export type CatalogChapter = NamedItem & {
  materials: (NamedItem & { available: boolean })[];
  knowledge_points: KnowledgePoint[];
};
export type ChapterSelection = {
  chapter_id: string;
  material_ids: string[];
  knowledge_point_ids: string[];
  question_plan?: Partial<Record<QuestionStage, StageRule>>;
};
export type Recipe = {
  template_id: string;
  start_chapter_id?: string;
  final_chapter_id?: string | null;
  feature_ids?: string[];
  dialogue_style?: "teaching-sample";
  chapters: ChapterSelection[];
  practice_count: number;
  quiz_count: number;
};
export function sameRecipe(first: Recipe | null, second: Recipe | null) {
  const kinds = (counts?: KindCounts) => Object.entries(counts ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const ruleValue = (rule?: StageRule) => {
    if (!rule) return null;
    return rule.mode === "total" ? ["total", rule.count, kinds(rule.by_kind)] : [
      "by_point", rule.points.map(point => [point.knowledge_point_id, point.count, kinds(point.by_kind)]),
    ];
  };
  const content = (recipe: Recipe | null) => recipe && [
    recipe.template_id, recipe.dialogue_style, recipe.practice_count, recipe.quiz_count,
    recipe.start_chapter_id, recipe.final_chapter_id !== undefined, recipe.final_chapter_id,
    recipe.feature_ids && [...recipe.feature_ids].sort(),
    recipe.chapters.map(row => [row.chapter_id, row.material_ids, row.knowledge_point_ids,
      ruleValue(row.question_plan?.practice), ruleValue(row.question_plan?.assessment)]),
  ];
  return JSON.stringify(content(first)) === JSON.stringify(content(second));
}
export type QuickCatalog = {
  revision: number;
  recipe: Recipe | null;
  templates: CourseTemplate[];
  chapters: CatalogChapter[];
};
export type PaperSummary = { count: number; by_kind: KindCounts; individual?: boolean; point_counts?: Record<string, number> };
export type Preview = {
  quests?: { id: string; chapter_id: string | null; title: string; kind: string; goals: string[]; available_after?: string | null }[];
  papers?: { chapter_id: string; practice: PaperSummary; assessment?: PaperSummary }[];
  adjustments?: { chapter_id: string; stage: QuestionStage; requested: number; effective: number }[];
  token: string | null;
  blockers: string[];
  welcome_dialogue: string | null;
  changes: { added: number; updated: number; removed: number };
  reset_impact: ResetImpact | null;
};
