import type { Workspace } from "../../shared/types";
import type { ExperienceClientState } from "../../shared/devTools";

export type DeveloperTab = "account" | "content" | "checkpoints";

export interface ExperienceOverview {
  chapters: { id: number; title: string; available: boolean; status: string }[];
  materials: {
    id: number;
    title: string;
    kind: string;
    status: string;
    pages: number;
    chapters: number[];
  }[];
  activities: {
    id: string;
    chapter_id: number;
    title: string;
    kind: string;
    published: boolean;
    questions: number;
  }[];
  checkpoints: { id: string; name: string; created_at: string; valid: boolean }[];
}

export interface OpenContentInput {
  kind: "material" | "activity";
  target: string;
  page_no: number;
  question_no: number;
  video_time: number;
}

export interface CheckpointInput {
  request_id: string;
  name: string;
  client_state: ExperienceClientState;
}

export interface ContentDestination {
  workspace: Workspace;
}
