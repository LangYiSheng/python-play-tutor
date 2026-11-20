import { api } from "@/lib/api";

export type NarrationStatus =
  | "draft"
  | "accepted"
  | "rejected"
  | "unavailable"
  | "stale";

export interface Narration {
  text: string;
  target_seconds: number;
  status: NarrationStatus;
  source: string;
  model: string;
  image_used: boolean;
  anchors: string[];
  edited_by_teacher: boolean;
  reviewed_at: string | null;
  stale_reason: string | null;
}

export interface Digest {
  title: string;
  topic: string;
  tags: string[];
  text: string;
  status: string;
  source: string;
  image_state: string;
  model: string;
}

export interface NarrationPage {
  page_no: number;
  title: string;
  has_text: boolean;
  source_chars: number;
  source_text: string;
  raw_text: string;
  digest: Digest | null;
  narration: Narration | null;
}

export interface NarrationCoverage {
  pages: number;
  covered: number;
  missing: number;
  draft: number;
  accepted: number;
  rejected: number;
  unavailable: number;
  stale: number;
}

export interface NarrationList {
  material_id: number;
  title: string;
  coverage: NarrationCoverage;
  pages: NarrationPage[];
}

export interface NarrationAudioStatus {
  available: boolean;
  voice: string;
  model: string;
  pages: {
    page_no: number;
    status: string;
    ready: boolean;
    seconds: number | null;
  }[];
}

export interface NarrationQuota {
  used_today: number;
  daily_limit: number;
  available: boolean;
}

export interface CalibrationIssue {
  page_no: number;
  kind: "ocr" | "order" | "tag" | "flow" | string;
  detail: string;
  status: "draft" | "accepted";
}

export interface CalibrationFix {
  page_no: number;
  before: string;
  after: string;
  reason: string;
  status?: string;
}

export interface CalibrationUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_hit_tokens?: number;
  cache_miss_tokens?: number;
}

export interface CalibrationReport {
  id: number;
  // false 表示这一轮还没走完整册：只能看进度，不能应用。旧报告没有这个字段。
  complete?: boolean;
  reused?: boolean;
  resuming?: boolean;
  windows: number;
  windows_done?: number;
  next_index?: number;
  pages: number;
  pages_seen?: number;
  summary: string;
  terms: string[];
  issues: CalibrationIssue[];
  fixes?: CalibrationFix[];
  tag_map?: Record<string, string>;
  tag_stats?: { before: number; after: number; merged: number };
  issues_truncated?: boolean;
  shrunk_windows?: number[];
  render_errors?: number[];
  model?: string;
  usage?: CalibrationUsage;
  generated_at?: string | null;
  applied_at?: string | null;
  applied_pages?: {
    pages: number[];
    tags: number;
  } | null;
}

const base = (classroomId: number, materialId: number) =>
  `/teacher/classrooms/${classroomId}/materials/${materialId}/narrations`;

export interface NarrationJobState {
  id: number | null;
  material_id: number;
  kind: string;
  status: string;
  running: boolean;
  queued: boolean;
  done: number;
  total: number;
  message: string;
  failed: { page_no: number; error?: string }[];
  stage?: string;
  chain?: string[];
  started_at: string | null;
}

export const narrationApi = {
  list: (classroomId: number, materialId: number) =>
    api.get<NarrationList>(base(classroomId, materialId)),
  quota: (classroomId: number, materialId: number) =>
    api.get<NarrationQuota>(`${base(classroomId, materialId)}/quota`),
  generatePage: (
    classroomId: number,
    materialId: number,
    pageNo: number,
    targetSeconds?: number,
  ) =>
    api.post<{
      page_no: number;
      status: string;
      reused: boolean;
      model: string;
    }>(
      `${base(classroomId, materialId)}/${pageNo}/generate`,
      targetSeconds ? { target_seconds: targetSeconds } : {},
    ),
  generateRange: (
    classroomId: number,
    materialId: number,
    firstPage: number,
    lastPage: number,
  ) =>
    api.post<{ job: NarrationJobState }>(
      `${base(classroomId, materialId)}/generate`,
      {
        first_page: firstPage,
        last_page: lastPage,
        // 串行：后面的页会读到前面已生成的讲解，过渡句不再凭空编。
        mode: "serial",
      },
    ),
  job: (classroomId: number, materialId: number) =>
    api.get<NarrationJobState>(`${base(classroomId, materialId)}/job`),
  pipeline: (classroomId: number, materialId: number) =>
    api.post<{ job: NarrationJobState }>(
      `${base(classroomId, materialId)}/pipeline`,
      {},
    ),
  acceptBatch: (
    classroomId: number,
    materialId: number,
    firstPage?: number,
    lastPage?: number,
  ) =>
    api.post<{ accepted: number[]; count: number }>(
      `${base(classroomId, materialId)}/accept-batch`,
      {
        first_page: firstPage ?? null,
        last_page: lastPage ?? null,
      },
    ),
  audioBatch: (
    classroomId: number,
    materialId: number,
    firstPage: number,
    lastPage: number,
  ) =>
    api.post<{ job: NarrationJobState }>(
      `${base(classroomId, materialId)}/audio-batch`,
      {
        first_page: firstPage,
        last_page: lastPage,
      },
    ),
  save: (
    classroomId: number,
    materialId: number,
    pageNo: number,
    text: string,
  ) =>
    api.put<{ page_no: number; status: string; text: string }>(
      `${base(classroomId, materialId)}/${pageNo}`,
      { text },
    ),
  accept: (classroomId: number, materialId: number, pageNo: number) =>
    api.post<{ page_no: number; status: string }>(
      `${base(classroomId, materialId)}/${pageNo}/accept`,
      {},
    ),
  reject: (classroomId: number, materialId: number, pageNo: number) =>
    api.post<{ page_no: number; status: string }>(
      `${base(classroomId, materialId)}/${pageNo}/reject`,
      {},
    ),
  remove: (classroomId: number, materialId: number, pageNo: number) =>
    api.delete(`${base(classroomId, materialId)}/${pageNo}`),
  calibrate: (classroomId: number, materialId: number) =>
    api.post<{ job: NarrationJobState }>(
      `${base(classroomId, materialId)}/calibrate`,
      {},
    ),
  calibration: (classroomId: number, materialId: number, partial = false) =>
    api.get<CalibrationReport>(
      `${base(classroomId, materialId)}/calibrate${partial ? "?partial=1" : ""}`,
    ),
  applyCalibration: (classroomId: number, materialId: number) =>
    api.post<CalibrationReport["applied_pages"]>(
      `${base(classroomId, materialId)}/calibrate/apply`,
      {},
    ),
  audioStatus: (classroomId: number, materialId: number) =>
    api.get<NarrationAudioStatus>(`${base(classroomId, materialId)}/audio`),
  synthesizeAudio: (classroomId: number, materialId: number, pageNo: number) =>
    api.post<{
      page_no: number;
      reused: boolean;
      key: string;
      seconds: number;
    }>(`${base(classroomId, materialId)}/${pageNo}/audio`, {}),
  pageImage: (classroomId: number, materialId: number, pageNo: number) =>
    `${base(classroomId, materialId)}/${pageNo}/page-image`,
  audioFile: (classroomId: number, materialId: number, pageNo: number) =>
    `/teacher/classrooms/${classroomId}/materials/${materialId}/narrations/${pageNo}/audio/file`,
};
