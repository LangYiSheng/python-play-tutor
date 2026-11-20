import { ErrorNotice, Loading } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Check, Sparkles, Volume2 } from "lucide-react";
import { useState } from "react";
import { CalibrationPanel } from "./calibration-panel";
import { NarrationPageEditor } from "./page-editor";
import { NarrationPagePreview } from "./page-preview";
import { StatusBadge } from "./status-badge";
import { usePageMedia } from "./use-page-media";
import { useNarrationReview } from "./use-review";

const STAGES: [string, string][] = [
  ["digest", "整理原文"],
  ["calibrate", "整册校准"],
  ["apply", "应用修正"],
  ["script", "生成讲解稿"],
];

export function NarrationReview({
  classroomId,
  materialId,
  title,
  onClose,
}: {
  classroomId: number;
  materialId: number;
  title: string;
  onClose: () => void;
}) {
  const review = useNarrationReview(classroomId, materialId);
  const {
    data,
    quota,
    report,
    audioState,
    pageNo,
    setPageNo,
    busy,
    error,
    message,
    job,
    page,
    saved,
    dirty,
    runPipeline,
    acceptAllDrafts,
    synthesizeAllAudio,
    running,
    busyNow,
  } = review;
  const media = usePageMedia(classroomId, materialId, pageNo, saved);
  const [tab, setTab] = useState("review");
  const chain = job?.chain ?? [];
  const currentStage = job?.stage || chain[0] || "";
  const stageIndex = STAGES.findIndex(([key]) => key === currentStage);
  const calibrationCount =
    (report?.fixes?.length ?? 0) + (report?.issues?.length ?? 0);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-6xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>课程生成 · {title}</DialogTitle>
          <DialogDescription>
            一键完成原文整理、整册校准与讲解稿；草稿需要老师逐页接受才会出现在学生端。
          </DialogDescription>
        </DialogHeader>
        <ErrorNotice message={error} />
        {message && !dirty && (
          <p role="status" className="hint">
            {message}
          </p>
        )}
        {!data || busy === "load" ? (
          <Loading />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="secondary">共 {data.coverage.pages} 页</Badge>
              <Badge variant="secondary">已生成 {data.coverage.covered}</Badge>
              <Badge variant="secondary">待审 {data.coverage.draft}</Badge>
              <Badge variant="secondary">已接受 {data.coverage.accepted}</Badge>
              {data.coverage.stale > 0 && (
                <Badge variant="secondary">已失效 {data.coverage.stale}</Badge>
              )}
              {data.coverage.missing > 0 && (
                <Badge variant="secondary">
                  未生成 {data.coverage.missing}
                </Badge>
              )}
              {quota && (
                <span className="hint ml-auto">
                  今日已生成 {quota.used_today} / {quota.daily_limit}
                  {!quota.available && " · 作者期模型未配置，暂不可生成"}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={!quota?.available || busyNow}
                onClick={() => {
                  if (
                    !window.confirm(
                      `将依次整理原文、校准并生成全部 ${data.coverage.pages} 页讲解；已完成的阶段和页不会重复计费。继续？`,
                    )
                  )
                    return;
                  void runPipeline();
                }}
              >
                <Sparkles /> {busy === "pipeline" ? "正在梳理…" : "一键梳理文本"}
              </Button>
              <Button
                variant="outline"
                disabled={
                  busyNow ||
                  audioState?.available === false ||
                  data.coverage.accepted === 0
                }
                onClick={() => void synthesizeAllAudio()}
              >
                <Volume2 /> {busy === "audio-all" ? "生成中…" : "生成全文配音"}
              </Button>
              <Button
                variant="outline"
                disabled={busyNow || data.coverage.draft === 0}
                onClick={() => void acceptAllDrafts()}
              >
                <Check />{" "}
                {busy === "accept-all"
                  ? "接受中…"
                  : `接受全部草稿（${data.coverage.draft}）`}
              </Button>
              <span className="hint">
                生成后可逐页审校；已接受的内容不会因重新生成被覆盖。
              </span>
            </div>
            {job?.failed?.length ? (
              <p className="hint" role="note">
                失败页：{job.failed.slice(0, 8).map((item) => `第 ${item.page_no} 页`).join("、")}
                {job.failed.length > 8 ? " 等" : ""}
              </p>
            ) : null}
            {job && job.kind === "pipeline" && (chain.length > 0 || running) && (
              <div className="flex flex-wrap items-center gap-2 text-sm" role="status">
                {STAGES.map(([key, label], index) => {
                  const done =
                    job.status === "done" || (stageIndex >= 0 && index < stageIndex);
                  const current = !done && key === currentStage;
                  return (
                    <Badge
                      key={key}
                      variant={done ? "default" : current ? "secondary" : "outline"}
                      className={current ? "animate-pulse" : undefined}
                    >
                      {done ? "✓ " : current ? "● " : "○ "}
                      {label}
                    </Badge>
                  );
                })}
                {job.message && <span className="hint">{job.message}</span>}
              </div>
            )}
            <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
              <TabsList>
                <TabsTrigger value="review">
                  审校（{data.coverage.covered}/{data.coverage.pages}）
                </TabsTrigger>
                <TabsTrigger value="calibration">
                  校准{calibrationCount ? ` · ${calibrationCount}` : ""}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="review">
                <div className="grid gap-4 lg:grid-cols-[140px_minmax(0,1fr)_420px]">
                  <div className="max-h-[66vh] space-y-1 overflow-y-auto pr-1">
                    {data.pages.map((item) => (
                      <button
                        key={item.page_no}
                        type="button"
                        aria-current={item.page_no === pageNo}
                        className={`flex w-full items-center justify-between rounded border px-2 py-1 text-left text-sm ${
                          item.page_no === pageNo
                            ? "border-primary bg-primary/5"
                            : "border-transparent hover:bg-muted"
                        }`}
                        onClick={() => setPageNo(item.page_no)}
                      >
                        <span>第 {item.page_no} 页</span>
                        <StatusBadge status={item.narration?.status} />
                      </button>
                    ))}
                  </div>

                  {page ? (
                    <>
                      <NarrationPagePreview
                        review={review}
                        media={media}
                        classroomId={classroomId}
                        materialId={materialId}
                      />

                      <NarrationPageEditor
                        review={review}
                        media={media}
                        classroomId={classroomId}
                        materialId={materialId}
                      />
                    </>
                  ) : (
                    <p className="hint lg:col-span-2">这份资料没有可讲解的页。</p>
                  )}
                </div>
              </TabsContent>
              <TabsContent value="calibration">
                <CalibrationPanel report={report} setPageNo={setPageNo} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
