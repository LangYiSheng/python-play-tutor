import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { LectioJobList } from "@/features/content-workspace/lectio-job-list";
import { Questions } from "@/features/questions/questions-page";
import { statuses } from "@/features/questions/types";
import { useCanLeave } from "@/lib/drafts";
import { useLectioJobs, type LectioJob } from "@/lib/lectio-api";
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

export function AssessmentsPage({ classroomId }: { classroomId: number }) {
  const [route, setRoute] = useState<RouteParams>(readParams);
  const [aiOpen, setAiOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [examRevision, setExamRevision] = useState(0);
  const [jobsVisible, setJobsVisible] = useState(false);
  const reloadBankRef = useRef<(() => void) | null>(null);
  const canLeave = useCanLeave();

  const handleJobDone = useCallback((job: LectioJob) => {
    if (job.kind === "exercises_generate" || job.kind === "exam_fill_gaps") {
      reloadBankRef.current?.();
      setExamRevision((n) => n + 1);
      setJobsVisible(false);
      const created = typeof job.result?.created === "number" ? job.result.created : null;
      const summary =
        created === null
          ? "AI 出题任务已完成，已刷新题库草稿"
          : created > 0
            ? `AI 出题已完成，新增 ${created} 道待审题目，已刷新题库`
            : "AI 出题已完成（无新增不重复题目）";
      toast.add({ title: summary, type: "success" });
    }
  }, []);

  const handleJobEnded = useCallback((job: LectioJob) => {
    if (job.kind === "exercises_generate" || job.kind === "exam_fill_gaps") {
      const created = typeof job.result?.created === "number" ? job.result.created : 0;
      if (created > 0) {
        reloadBankRef.current?.();
        setExamRevision((n) => n + 1);
      }
    }
  }, []);

  const lectioJobs = useLectioJobs(classroomId, handleJobDone, handleJobEnded);
  const assessmentJobs = lectioJobs.jobs.filter(
    (j) => j.kind === "exercises_generate" || j.kind === "exam_fill_gaps",
  );
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
        description="统一维护客观题、编程题与实验组卷；AI 出题先生成待审草稿，审校可用后可用于小镇练习与试卷抽取。"
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

      {jobsVisible && assessmentJobs.length > 0 && (
        <div className="surface p-3.5">
          <LectioJobList
            jobs={assessmentJobs}
            onCancel={lectioJobs.cancel}
            onClose={() => setJobsVisible(false)}
          />
        </div>
      )}

      <Tabs value={route.tab} onValueChange={switchTab} className="space-y-4">
        <TabsList variant="line">
          <TabsTrigger value="bank">智能题库</TabsTrigger>
          <TabsTrigger value="exams">课程组卷</TabsTrigger>
        </TabsList>

        <TabsContent value="bank">
          <Questions
            key={classroomId}
            classroomId={classroomId}
            pointId={route.point}
            clearPoint={clearPoint}
            status={route.status}
            onStatusChange={changeStatus}
            reloadRef={reloadBankRef}
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
            key={classroomId}
            classroomId={classroomId}
            revision={examRevision}
            onJobSubmitted={() => {
              lectioJobs.refresh();
              setJobsVisible(true);
            }}
          />
        </TabsContent>
      </Tabs>

      <AiGenerateDialog
        open={aiOpen}
        classroomId={classroomId}
        onOpenChange={setAiOpen}
        onSubmitted={() => {
          lectioJobs.refresh();
          setJobsVisible(true);
        }}
      />

      <XuexitongDialog open={exportOpen} classroomId={classroomId} onOpenChange={setExportOpen} />
    </div>
  );
}
