import { questionKindLabels, type QuestionKind } from "../../../../shared/questions";

export interface StageCount {
  completed: number;
  total: number;
}

export interface ChapterStageCount extends StageCount {
  task_count: number;
}

export interface ChapterFunnel {
  id: number;
  title: string;
  order_index: number;
  open_classrooms: number;
  target_students: number;
  stages: Record<"reading" | "objective" | "programming" | "assessment", ChapterStageCount>;
}

export interface ClassroomInsight {
  id: number;
  name: string;
  student_count: number;
  active_students: number;
  open_chapters: number;
  total_chapters: number;
  required_completed: number;
  required_total: number;
  assessment_submitted: number;
  assessment_expected: number;
  average_score: number | null;
  assistant_messages: number;
}

export interface DifficultQuestion {
  question_id: string;
  title: string;
  kind: string;
  chapter_title: string | null;
  attempts: number;
  learners: number;
  failed_attempts: number;
  accepted_learners: number;
  appended_count: number;
}

export interface AssistantHotspot {
  key: string;
  kind: "material" | "practice" | "learning";
  title: string;
  chapter_title: string | null;
  learners: number;
  sessions: number;
  messages: number;
}

export interface InsightsOverview {
  name: string;
  teacher: string;
  totals: Record<string, number>;
  usage: Record<string, number>;
  assistant: {
    learning: { sessions: number; messages: number };
    practice: { sessions: number; messages: number };
  };
  active_students?: number;
  assistant_students?: number;
  completion?: {
    required_completed: number;
    required_total: number;
    open_classroom_count: number;
    by_stage: Record<string, StageCount>;
  };
  assessment_summary?: {
    expected: number;
    submitted: number;
    graded: number;
    grading: number;
    attention: number;
    average_score: number | null;
    pass_count: number;
  };
  chapters?: ChapterFunnel[];
  classrooms?: ClassroomInsight[];
  difficult_questions?: DifficultQuestion[];
  assistant_hotspots?: AssistantHotspot[];
}

export interface ResourceProgress {
  material_id: number;
  read_count: number;
  read_total: number;
  seconds: number;
  required_seconds: number;
  video: boolean;
}

export interface ActivityStudentResult {
  current?: number;
  total?: number;
  unit?: string;
  resources?: ResourceProgress[];
  completed: boolean;
  assessment_status?: string;
  score?: number | null;
  correct_count?: number;
  submitted_at?: string | null;
  accepted?: number;
  assigned?: number;
  appended?: number;
  fraction?: number;
}

export interface ReportStudent {
  id: number;
  student_id: string;
  name: string;
  enrolled: boolean;
}

export interface ReportActivity {
  id: string;
  title: string;
  chapter: string;
  chapter_id?: number;
  chapter_order?: number;
  kind: string;
  material_kind?: string;
  required: boolean;
  material_titles: Record<number, string>;
  opened: boolean;
  initial_total?: number;
  completed: number;
  in_progress?: number;
  results: Record<number, ActivityStudentResult>;
}

export interface ClassroomActivityReport {
  total_chapters?: number;
  open_chapters?: number;
  students: ReportStudent[];
  activities: ReportActivity[];
}

export const taskKindLabels: Record<string, string> = {
  reading: "资料阅读",
  objective: "客观练习",
  programming: "编程练习",
  practice: "课程练习",
  assessment: "单元测验",
};

export const submissionStatusLabels: Record<string, string> = {
  accepted: "已通过",
  AC: "已通过",
  ac: "已通过",
  wrong_answer: "解答错误",
  wrong: "解答错误",
  runtime_error: "运行错误",
  compile_error: "语法错误",
  time_limit: "运行超时",
  memory_limit: "内存超限",
  prepared: "待评测",
  queued: "排队中",
  dispatching: "评测中",
  running: "运行中",
  infrastructure_error: "服务异常",
  submission_unknown: "待核查",
};

export function questionLabel(kind?: string | null): string {
  if (!kind) return "题目";
  return questionKindLabels[kind as QuestionKind] ?? kind;
}

export function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 100);
}

export function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m} 分 ${rem} 秒` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h} 小时 ${rm} 分` : `${h} 小时`;
}

export function gradeLabel(result?: ActivityStudentResult): string {
  if (result?.score != null) return String(result.score);
  if (result?.assessment_status === "attention") return "评测异常";
  return result?.assessment_status === "grading" ? "待判定" : "未交";
}

export function activityProgressSummary(result?: ActivityStudentResult): string {
  if (!result) return "未开始";
  if (result.assessment_status) {
    return result.score != null ? `${result.score} 分` : gradeLabel(result);
  }
  if (result.completed) return "已完成";
  if (result.accepted !== undefined) {
    return `已通过 ${result.accepted}${result.assigned ? ` / ${result.assigned}` : ""} 题`;
  }
  if (result.current !== undefined && result.total !== undefined) {
    return `${result.current} / ${result.total} ${result.unit ?? ""}`.trim();
  }
  if (result.fraction !== undefined) {
    return `${Math.round(result.fraction * 100)}%`;
  }
  return "进行中";
}
