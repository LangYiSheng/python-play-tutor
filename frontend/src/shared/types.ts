import type { QuestionKind, AnswerValue } from "../../../shared/questions";
import type { InteractiveSource } from "../../../shared/interactivePractice";
export interface User {
  id: number;
  student_id: string;
  name: string;
  role: string;
  dev_tools_enabled?: boolean;
  town_preview?: boolean;
  must_change_password?: boolean;
}
export interface Classroom {
  id: number;
  name: string;
  course_name?: string | null;
  teacher_id: number;
  teacher_name?: string;
  join_code?: string;
}
export interface Player {
  map_key: string;
  tile_x: number;
  tile_y: number;
  direction: string;
}
export interface StoryDialogue {
  id: string;
  text: string;
  speaker?: string;
  portrait?: string;
  choices?: { id: string; label: string }[];
}
export interface Npc {
  key: string;
  stable_id?: string;
  name: string;
  map_key: string;
  tile_x: number;
  tile_y: number;
  portrait: string;
  direction: string;
  sprite: { id: string; url: string; frame_width: number; frame_height: number };
}
export interface Chapter {
  id: number;
  title: string;
  order_index: number;
  available: boolean;
}
export interface CharacterIdentity { key: string; name: string; portrait: string; sprite: Npc["sprite"] }
export interface World {
  default_role: CharacterIdentity | null;
  player: Player;
  npcs: Npc[];
  chapters: Chapter[];
  flags: string[];
  building_access?: Record<string, BuildingAccess>;
  building_unlock?: string[];
}
export interface BuildingAccess {
  enabled: boolean;
  unlocked: boolean;
  can_enter: boolean;
  blocked_message: string;
}
export interface Page {
  id: string | number;
  page_no: number;
  title: string;
  text: string;
}
export interface Material {
  id: number;
  title: string;
  kind: string;
  status: string;
  pages: Page[];
  media_url?: string | null;
  notice?: string;
  chapter_id?: number;
  chapter_ids?: number[];
  duration_seconds?: number | null;
}
export interface Question {
  interactive?: InteractiveSource;
  hints?: string[];
  starter_code?: string;
  id: string;
  title: string;
  kind: QuestionKind;
  prompt: string;
  options: string[];
  samples: { input: string; output: string }[];
}
export interface Activity {
  knowledge_points?: { id: number; title: string }[];
  role: CharacterIdentity | null;
  id: string;
  chapter_id: number;
  title: string;
  kind: string;
  npc_key: string | null;
  assistant_allowed: boolean;
  resources: ActivityResource[];
  questions: Question[];
  progress?: ActivityProgress;
}
export interface LearningConfiguration {
  reading?: { scope: "all" | "range" | "pages"; start_page?: number; end_page?: number; page_ids?: number[] };
  video?: { minimum_seconds?: number; segments?: { start_seconds: number; end_seconds: number; label: string }[] };
  highlights?: {
    pages?: { start_page: number; end_page: number; label: string }[];
    video?: { start_seconds: number; end_seconds: number; label: string }[];
  };
}
export interface ActivityResource {
  material_id: number;
  material: Material;
  required: boolean;
  learning: LearningConfiguration;
}
export interface ResourceProgress {
  material_id: number; completed: boolean; fraction: number; page_no: number | null;
  visited_pages: number[]; required_page_ids: number[]; read_count: number; read_total: number;
  watched_seconds: number; required_seconds: number; completed_segments: number[];
}
export type QuestionOutlineState = "unanswered" | "answered" | "accepted" | "wrong" | "pending";
export interface PracticeGoalProgress {
  knowledge_point_id: number;
  total: number;
  by_kind: Partial<Record<QuestionKind, number>>;
  accepted: number;
  accepted_by_kind: Partial<Record<QuestionKind, number>>;
}
export interface PracticeItem {
  question_id: string;
  knowledge_point_id: number;
  status: 'unanswered' | 'wrong' | 'accepted';
  appended: boolean;
}
export interface ActivityProgress {
  practice?: { goals: PracticeGoalProgress[]; items: PracticeItem[] };
  resources?: ResourceProgress[];
  material_id?: number | null;
  fraction?: number;
  required_count?: number;
  completed_count?: number;
  page_no: number | null;
  visited_pages: number[];
  completed: boolean;
  accepted_question_ids?: string[];
  required_page_ids?: number[];
  read_count?: number;
  read_total?: number;
  watched_seconds?: number;
  required_seconds?: number;
  score?: number | null;
  max_score?: 100;
}
export type SubmissionStatus =
  | "prepared"
  | "dispatching"
  | "submission_unknown"
  | "queued"
  | "running"
  | "accepted"
  | "wrong_answer"
  | "time_limit"
  | "memory_limit"
  | "compile_error"
  | "runtime_error"
  | "infrastructure_error";
export interface PublicSampleResult {
  status: Exclude<
    SubmissionStatus,
    "prepared" | "dispatching" | "submission_unknown"
  >;
  stdout: string;
  stderr: string;
  compile_output: string;
}
export interface SubmissionFeedback {
  source?: 'browser_practice';
  passed_count?: number;
  total_count?: number;
  detail?: string;
  status?: SubmissionStatus;
  samples?: PublicSampleResult[];
}
export interface Submission {
  id: string;
  activity_id: string;
  question_id: string;
  mode: "run" | "submit";
  status: SubmissionStatus;
  feedback: SubmissionFeedback;
  created_at: string;
}
export interface AssessmentAnswer {
  question_id: string;
  answer?: AnswerValue;
  code?: string | null;
}
export interface AssessmentAttempt {
  id: string | null;
  status: "draft" | "grading" | "graded" | "attention";
  revision: number;
  locked: boolean;
  question_ids: string[];
  answers: AssessmentAnswer[];
  results: Submission[];
  correct_count: number;
  total: number;
  score: number | null;
  max_score: 100;
  completed: boolean;
  passed: boolean;
  legacy: boolean;
}
export type Workspace =
  | { kind: "taskList"; category: Exclude<import("./chapterTasks").TaskKind, "reading"> }
  | { kind: "practice"; activity_id: string; page_no?: number; question_no?: number; video_time?: number }
  | { kind: "material"; material_id: number; chapter_id?: number; page_no?: number; video_time?: number }
  | { kind: "journal" | "library" | "classroom" | "settings" | "map" | "developer" }
  | null;
