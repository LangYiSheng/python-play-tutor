import { useCallback, useEffect, useRef, useState } from "react";
import { api, download, errorMessage, fileBlob } from "@/lib/api";

export type ScriptStylePreset = "natural" | "concise" | "conversational";

export interface ScriptStyleOptions {
  style_preset?: ScriptStylePreset;
  custom_style?: string;
  section_minutes?: number;
  chapter_minutes?: number;
  use_pacing?: boolean;
}

export interface PacingPreview {
  material_id: number;
  summary: string;
  total_chars: number;
  total_seconds: number;
  formatted_time: string;
  section_minutes: number;
  chapter_minutes: number;
  sections: {
    section: string;
    target_minutes: number;
    pages: number[];
    chars: number;
    budget: number;
    seconds: number;
  }[];
  pages: {
    page: number;
    section: string;
    kind: string;
    chars: number;
    budget: number;
    pauses: number;
    seconds: number;
    over: boolean;
    severe: boolean;
    under: boolean;
  }[];
}

export interface KnowledgePointItem {
  id: number;
  stable_id: string;
  chapter_id: number;
  title: string;
  section: string;
  brief: string;
  question_count: number;
  sources: { material_id: number; material_title: string; pages: number[] }[];
}

export interface KnowledgeChapter {
  id: number;
  stable_id: string;
  title: string;
  order_index: number;
  materials: { id: number; stable_id: string; title: string; kind: string; pages: number }[];
  points: KnowledgePointItem[];
}

export interface KnowledgeOverview {
  chapters: KnowledgeChapter[];
}

export interface LectioJob {
  id: string;
  course_instance_id: number;
  kind: "knowledge_extract" | "exercises_generate" | "exam_fill_gaps" | string;
  scope_key: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted" | string;
  progress: { done: number; total: number; message: string };
  result: Record<string, unknown> | null;
  error: string;
  cancel_requested: boolean;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PointQuotaPayload {
  knowledge_point_id: number;
  single: number;
  multiple: number;
  true_false: number;
  fill_blank: number;
}

export interface ExerciseGeneratePayload {
  material_id?: number;
  counts?: Record<string, number>;
  point_quotas?: PointQuotaPayload[];
}

export interface ExerciseValidateResult {
  ok: boolean;
  total: number;
  skipped_non_objective: number;
  errors: string[];
  warnings: string[];
}

export type ExamSectionType = "single" | "multiple" | "true_false" | "fill_blank";

export interface ExamSectionConfig {
  type: ExamSectionType;
  count: number;
  scoreEach: number;
}

export interface ExamGapsPayload {
  chapter_ids: number[];
  sections: ExamSectionConfig[];
  ab_mode: boolean;
  max_overlap_rate: number;
  include_unreviewed: boolean;
}

export interface ExamGapsResult {
  ok: boolean;
  totalShortage: number;
  byType: {
    type: string;
    label: string;
    count: number;
    needed: number;
    available: number;
    shortage: number;
  }[];
}

export interface ExamQuestionSnapshot {
  uid: string;
  sourceId: string;
  chapter: string;
  type: ExamSectionType;
  score: number;
  question: string;
  options: Record<string, string>;
  answer: unknown;
  explanation: string;
  knowledge_points: string[];
  page: number;
}

export interface ExamVariantStats {
  count: number;
  totalScore: number;
  byType: Record<string, { count: number; score: number }>;
  byChapter: Record<string, { count: number; score: number }>;
  coveredPoints: number;
}

export interface ExamRecord {
  id: string;
  stable_id: string;
  title: string;
  subtitle: string;
  examMode: string;
  durationMinutes: number;
  totalScore: number;
  abMode: boolean;
  maxOverlapRate: number;
  includeUnreviewed: boolean;
  chapters: string[];
  chapterWeights: Record<string, number>;
  sections: ExamSectionConfig[];
  variants: Record<string, { label: string; totalScore: number; questions: ExamQuestionSnapshot[] }>;
  stats: {
    overlapCount: number;
    overlapRate: number;
    variantA?: ExamVariantStats;
    variantB?: ExamVariantStats | null;
    knowledgeCoverage?: { covered: number; total: number };
  };
  createdAt: string;
  updatedAt: string;
}

export interface ExamCandidate {
  id: string;
  chapter: string;
  type: ExamSectionType;
  question: string;
  options: Record<string, string>;
  answer: unknown;
  explanation: string;
  knowledge_points: string[];
  page: number;
  usedInOtherVariant: boolean;
}

const root = (classroomId: number) => `/teacher/classrooms/${classroomId}/lectio`;

async function downloadFrom(path: string, filename: string) {
  const blob = await fileBlob(path);
  download(blob, filename);
}

export const lectioApi = {
  previewPacing: (
    classroomId: number,
    materialId: number,
    sectionMinutes = 10,
    chapterMinutes = 90,
  ) =>
    api.get<PacingPreview>(
      `${root(classroomId)}/materials/${materialId}/pacing?section_minutes=${sectionMinutes}&chapter_minutes=${chapterMinutes}`,
    ),
  exportMaterial: (
    classroomId: number,
    materialId: number,
    kind: "source" | "script",
    fmt: "docx" | "md",
    title: string,
  ) =>
    downloadFrom(
      `${root(classroomId)}/materials/${materialId}/export?kind=${kind}&fmt=${fmt}`,
      `${title}-${kind === "source" ? "整理稿" : "口播讲稿"}.${fmt}`,
    ),
  listKnowledge: (classroomId: number, signal?: AbortSignal) =>
    api.get<KnowledgeOverview>(`${root(classroomId)}/knowledge`, signal),
  extractKnowledge: (classroomId: number, chapterId: number, materialIds?: number[]) =>
    api.post<LectioJob>(`${root(classroomId)}/chapters/${chapterId}/knowledge/extract`, {
      ...(materialIds ? { material_ids: materialIds } : {}),
    }),
  exportKnowledge: (
    classroomId: number,
    fmt: "xmind" | "xlsx" | "docx",
    chapterId?: number,
    label = "课程知识图谱",
  ) =>
    downloadFrom(
      `${root(classroomId)}/knowledge/export?fmt=${fmt}${chapterId ? `&chapter_id=${chapterId}` : ""}`,
      `${label}.${fmt}`,
    ),
  generateExercises: (classroomId: number, chapterId: number, body: ExerciseGeneratePayload) =>
    api.post<LectioJob>(`${root(classroomId)}/chapters/${chapterId}/exercises/generate`, body),
  validateExercises: (
    classroomId: number,
    opts?: { chapterId?: number; status?: "all" | "ready" | "draft" },
  ) => {
    const q = new URLSearchParams();
    if (opts?.chapterId) q.set("chapter_id", String(opts.chapterId));
    if (opts?.status) q.set("status", opts.status);
    const qs = q.toString();
    return api.get<ExerciseValidateResult>(`${root(classroomId)}/exercises/validate${qs ? `?${qs}` : ""}`);
  },
  exportExercises: (
    classroomId: number,
    fmt: "xuexitong_xlsx" | "xuexitong_txt" | "xlsx",
    opts?: { chapterId?: number; status?: "all" | "ready" | "draft"; label?: string },
  ) => {
    const q = new URLSearchParams({ fmt });
    if (opts?.chapterId) q.set("chapter_id", String(opts.chapterId));
    if (opts?.status) q.set("status", opts.status);
    const ext = fmt === "xuexitong_txt" ? "txt" : "xlsx";
    const suffix =
      fmt === "xuexitong_xlsx" ? "学习通导入" : fmt === "xuexitong_txt" ? "学习通智能导入" : "客观题汇总";
    return downloadFrom(`${root(classroomId)}/exercises/export?${q}`, `${opts?.label ?? "课程题库"}-${suffix}.${ext}`);
  },
  listExams: (classroomId: number, signal?: AbortSignal) =>
    api.get<{ exams: ExamRecord[] }>(`${root(classroomId)}/exams`, signal),
  getExam: (classroomId: number, examId: string, signal?: AbortSignal) =>
    api.get<ExamRecord>(`${root(classroomId)}/exams/${encodeURIComponent(examId)}`, signal),
  checkExamGaps: (classroomId: number, body: ExamGapsPayload) =>
    api.post<ExamGapsResult>(`${root(classroomId)}/exams/gaps`, body),
  createExam: (
    classroomId: number,
    body: ExamGapsPayload & {
      title: string;
      subtitle?: string;
      exam_mode?: string;
      duration_minutes?: number;
      total_score: number;
      chapter_weights?: Record<number, number>;
    },
  ) => api.post<ExamRecord>(`${root(classroomId)}/exams/generate`, body),
  fillExamGaps: (classroomId: number, body: ExamGapsPayload & { multiplier?: number }) =>
    api.post<LectioJob>(`${root(classroomId)}/exams/fill-gaps`, body),
  patchExam: (classroomId: number, examId: string, body: Record<string, unknown>) =>
    api.patch<ExamRecord>(`${root(classroomId)}/exams/${encodeURIComponent(examId)}`, body),
  deleteExam: (classroomId: number, examId: string) =>
    api.delete(`${root(classroomId)}/exams/${encodeURIComponent(examId)}`),
  listExamCandidates: (classroomId: number, examId: string, variant: "A" | "B", uid: string) =>
    api.get<{ candidates: ExamCandidate[] }>(
      `${root(classroomId)}/exams/${encodeURIComponent(examId)}/candidates?variant=${variant}&uid=${encodeURIComponent(uid)}`,
    ),
  exportExam: (
    classroomId: number,
    examId: string,
    kind: "student_docx" | "teacher_docx" | "blueprint_xlsx" | "xuexitong_xlsx" | "xuexitong_txt" | "zip",
    variant: "A" | "B",
    title: string,
    abMode = true,
  ) => {
    const vTag = abMode ? `-${variant}卷` : "";
    const map: Record<typeof kind, string> = {
      student_docx: `${title}${vTag}-学生卷.docx`,
      teacher_docx: `${title}${vTag}-答案解析卷.docx`,
      blueprint_xlsx: `${title}-命题双向细目表.xlsx`,
      xuexitong_xlsx: `${title}${vTag}-学习通导入.xlsx`,
      xuexitong_txt: `${title}${vTag}-学习通智能导入.txt`,
      zip: `${title}-试卷包.zip`,
    };
    return downloadFrom(
      `${root(classroomId)}/exams/${encodeURIComponent(examId)}/export?kind=${kind}&variant=${variant}`,
      map[kind],
    );
  },
  listJobs: (classroomId: number, limit = 20, signal?: AbortSignal) =>
    api.get<{ jobs: LectioJob[] }>(`${root(classroomId)}/jobs?limit=${limit}`, signal),
  cancelJob: (classroomId: number, jobId: string) =>
    api.post<LectioJob>(`${root(classroomId)}/jobs/${encodeURIComponent(jobId)}/cancel`, {}),
};

export function useLectioJobs(
  classroomId: number,
  onJobDone?: (job: LectioJob) => void,
  onJobFailed?: (job: LectioJob) => void,
) {
  const [jobs, setJobs] = useState<LectioJob[]>([]);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const doneRef = useRef<Set<string>>(new Set());
  const failedRef = useRef<Set<string>>(new Set());
  const cbRef = useRef(onJobDone);
  const failCbRef = useRef(onJobFailed);
  useEffect(() => {
    cbRef.current = onJobDone;
    failCbRef.current = onJobFailed;
  }, [onJobDone, onJobFailed]);

  useEffect(() => {
    doneRef.current.clear();
    failedRef.current.clear();
  }, [classroomId]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    lectioApi
      .listJobs(classroomId, 20, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        const list = Array.isArray(res?.jobs) ? res.jobs : [];
        setError("");
        setJobs(list);
        for (const job of list) {
          if (job.status === "done" && !doneRef.current.has(job.id)) {
            doneRef.current.add(job.id);
            if (tick > 0) cbRef.current?.(job);
          } else if (
            (job.status === "failed" || job.status === "cancelled" || job.status === "interrupted")
            && !failedRef.current.has(job.id)
          ) {
            failedRef.current.add(job.id);
            if (tick > 0) failCbRef.current?.(job);
          }
        }
        if (list.some((j) => j.status === "queued" || j.status === "running")) {
          timer = window.setTimeout(() => setTick((n) => n + 1), 3000);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => {
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [classroomId, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const cancel = useCallback(
    async (jobId: string) => {
      const updated = await lectioApi.cancelJob(classroomId, jobId);
      setJobs((prev) => prev.map((j) => (j.id === jobId ? updated : j)));
      return updated;
    },
    [classroomId],
  );
  const activeCount = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  return { jobs, activeCount, error, refresh, cancel };
}
