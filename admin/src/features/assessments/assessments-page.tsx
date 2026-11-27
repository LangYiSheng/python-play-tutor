import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { StudioJobList } from "@/features/content-workspace/studio-job-list";
import { Questions } from "@/features/questions/questions-page";
import { statuses } from "@/features/questions/types";
import { useCanLeave } from "@/lib/drafts";
import { useCourseStudioJobs, type CourseStudioJob } from "@/lib/course-studio-api";
import { AiGenerateDialog } from "./ai-generate-dialog";
import { ExamsTab } from "./exams-tab";
import { XuexitongDialog } from "./xuexitong-dialog";

type AssessmentTab = "bank" | "exams";

interface RouteParams {
  tab: AssessmentTab;
  point?: string;
  status: string;
}

function readParams(): RouteParams {
  const params = new URLSearchParams(location.search);
  const rawTab = params.get("tab");
  const tab: AssessmentTab = rawTab === "exams" ? "exams" : "bank";
  const rawPoint = Number(params.get("point"));
  const rawStatus = params.get("status") ?? "all";
  const status =
    rawStatus === "draft" && params.get("reviewable") === "true"
      ? "reviewable"
      : Object.hasOwn(statuses, rawStatus)
        ? rawStatus
        : "all";
  return {
    tab,
    point: Number.isSafeInteger(rawPoint) && rawPoint > 0 ? String(rawPoint) : undefined,
    status,
  };
}

export function AssessmentsPage({ courseId }: { courseId: number }) {
  const [route, setRoute] = useState<RouteParams>(readParams);
  const [aiOpen, setAiOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [examRevision, setExamRevision] = useState(0);
  const [jobsVisible, setJobsVisible] = useState(false);
  const [recentQuestionIds, setRecentQuestionIds] = useState<string[]>([]);
  const reloadBankRef = useRef<(() => void) | null>(null);
  const canLeave = useCanLeave();

  const captureJobQuestionIds = useCallback((job: CourseStudioJob) => {
    const rawIds = job.result?.question_ids;
    if (Array.isArray(rawIds)) {
      const ids = rawIds.filter((id): id is string => typeof id === "string" && id.length > 0);
      if (ids.length > 0) setRecentQuestionIds(ids);
    }
  }, []);

  const handleJobDone = useCallback((job: CourseStudioJob) => {
    if (
      job.kind === "exercises_generate"
      || job.kind === "coding_exercises_generate"
      || job.kind === "exam_fill_gaps"
    ) {
      captureJobQuestionIds(job);
      reloadBankRef.current?.();
      setExamRevision((n) => n + 1);
      setJobsVisible(false);
      const created = typeof job.result?.created === "number" ? job.result.created : null;
      const isCoding = job.kind === "coding_exercises_generate";
      const summary =
        created === null
          ? isCoding
            ? "AI 编程出题任务已完成，已刷新题库草稿"
            : "AI 出题任务已完成，已刷新题库草稿"
          : created > 0
            ? isCoding
              ? `AI 编程出题已完成，新增 ${created} 道已验草稿，已刷新题库`
              : `AI 出题已完成，新增 ${created} 道待审题目，已刷新题库`
            : isCoding
              ? "AI 编程出题已完成（未新增题目，可在任务面板查看原因）"
              : "AI 出题已完成（无新增不重复题目）";
      toast.add({ title: summary, type: "success" });
    }
  }, [captureJobQuestionIds]);

  const handleJobEnded = useCallback((job: CourseStudioJob) => {
    if (
      job.kind === "exercises_generate"
      || job.kind === "coding_exercises_generate"
      || job.kind === "exam_fill_gaps"
    ) {
      const created = typeof job.result?.created === "number" ? job.result.created : 0;
      if (created > 0) {
        captureJobQuestionIds(job);
        reloadBankRef.current?.();
        setExamRevision((n) => n + 1);
      }
    }
  }, [captureJobQuestionIds]);

  const studioJobs = useCourseStudioJobs(courseId, handleJobDone, handleJobEnded);
  const assessmentJobs = studioJobs.jobs.filter(
    (j) =>
      j.kind === "exercises_generate"
      || j.kind === "coding_exercises_generate"
      || j.kind === "exam_fill_gaps",
  );
  const recentIdSet = useMemo(() => {
    const ids = new Set<string>(recentQuestionIds);
    const latestFinished = assessmentJobs.find(
      (j) => Array.isArray(j.result?.question_ids) && (j.result?.question_ids as unknown[]).length > 0,
    );
    if (latestFinished && latestFinished.finished_at) {
      const finMs = Date.parse(latestFinished.finished_at);
      if (!Number.isNaN(finMs) && Date.now() - finMs <= 2 * 60 * 60 * 1000) {
        for (const item of latestFinished.result?.question_ids as unknown[]) {
          if (typeof item === "string" && item) ids.add(item);
        }
      }
    }
    return ids;
  }, [assessmentJobs, recentQuestionIds]);
  const activeCount = assessmentJobs.filter(
    (j) => j.status === "queued" || j.status === "running",
  ).length;

  useEffect(() => {
    const sync = () => setRoute(readParams());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  function updateSearch(mutate: (params: URLSearchParams) => void, mode: "push" | "replace" = "replace") {
    const params = new URLSearchParams(location.search);
    mutate(params);
    const qs = params.toString();
    const target = `${location.pathname}${qs ? `?${qs}` : ""}`;
    if (mode === "push") history.pushState({}, "", target);
    else history.replaceState(history.state, "", target);
    setRoute(readParams());
  }

  function switchTab(next: string) {
    if (next !== "bank" && next !== "exams") return;
    if (next === route.tab) return;
    if (!canLeave()) return;
    updateSearch((params) => {
      params.set("tab", next);
      if (next !== "bank") {
        params.delete("point");
        params.delete("pointName");
        params.delete("status");
        params.delete("reviewable");
      }
    }, "push");
  }

  function clearPoint() {
    updateSearch((params) => {
      params.set("tab", "bank");
      params.delete("point");
      params.delete("pointName");
    });
  }

  function changeStatus(value: string) {
    updateSearch((params) => {
      params.set("tab", "bank");
      params.delete("reviewable");
      if (value === "reviewable") {
        params.set("status", "draft");
        params.set("reviewable", "true");
      } else if (value === "all") {
        params.delete("status");
      } else {
        params.set("status", value);
      }
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="题库与组卷"
        description="维护课程题库、编写并导出试卷。AI 生成的题目经审核后可用于组卷，学生练习与测验在「学习任务」发布。"
      >
        {(assessmentJobs.length > 0 || activeCount > 0) && (
          <Button
            variant="outline"
            size="sm"
            aria-expanded={jobsVisible}
            onClick={() => setJobsVisible((v) => !v)}
          >
            {activeCount > 0 && <Loader2 className="animate-spin" />}
            AI 出题任务（{activeCount > 0 ? `${activeCount} 进行中` : assessmentJobs.length}）
          </Button>
        )}
      </PageHeader>

      <Collapsible className="mb-0!" open={jobsVisible && assessmentJobs.length > 0}>
        <CollapsibleContent>
          <div className="pb-4">
            <div className="surface p-3.5">
              <StudioJobList
                jobs={assessmentJobs}
                onCancel={studioJobs.cancel}
                onClose={() => setJobsVisible(false)}
              />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Tabs value={route.tab} onValueChange={switchTab} className="space-y-4">
        <TabsList variant="line">
          <TabsTrigger value="bank">智能题库</TabsTrigger>
          <TabsTrigger value="exams">课程组卷</TabsTrigger>
        </TabsList>

        <TabsContent value="bank">
          <Questions
            key={courseId}
            courseId={courseId}
            pointId={route.point}
            clearPoint={clearPoint}
            status={route.status}
            onStatusChange={changeStatus}
            reloadRef={reloadBankRef}
            recentIds={recentIdSet}
            toolbarExtra={
              <>
                <Button type="button" variant="outline" onClick={() => setAiOpen(true)}>
                  <Sparkles /> AI 智能出题
                </Button>
                <Button type="button" variant="outline" onClick={() => setExportOpen(true)}>
                  <Download /> 导出试题
                </Button>
              </>
            }
          />
        </TabsContent>

        <TabsContent value="exams">
          <ExamsTab
            key={courseId}
            courseId={courseId}
            revision={examRevision}
            onJobSubmitted={() => {
              studioJobs.refresh();
              setJobsVisible(true);
            }}
          />
        </TabsContent>
      </Tabs>

      <AiGenerateDialog
        open={aiOpen}
        courseId={courseId}
        onOpenChange={setAiOpen}
        onSubmitted={() => {
          studioJobs.refresh();
          setJobsVisible(true);
        }}
      />

      <XuexitongDialog open={exportOpen} courseId={courseId} onOpenChange={setExportOpen} />
    </div>
  );
}
