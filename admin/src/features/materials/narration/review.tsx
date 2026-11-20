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
import { Check, Sparkles, Volume2 } from "lucide-react";
import { NarrationPageEditor } from "./page-editor";
import { NarrationPagePreview } from "./page-preview";
import { StatusBadge } from "./status-badge";
import { usePageMedia } from "./use-page-media";
import { useNarrationReview } from "./use-review";

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
  const usage = report?.usage;
  const cachedTokens =
    (usage?.cache_hit_tokens ?? 0) + (usage?.cache_miss_tokens ?? 0);
  const cachePercent = cachedTokens
    ? Math.round(((usage?.cache_hit_tokens ?? 0) / cachedTokens) * 100)
    : null;
  const shrunk = report?.shrunk_windows ?? [];
  const renderErrors = report?.render_errors ?? [];
  const stages: [string, string][] = [
    ["digest", "整理原文"],
    ["calibrate", "整册校准"],
    ["apply", "应用修正"],
    ["script", "生成讲解稿"],
  ];
  const chain = job?.chain ?? [];
  const currentStage = job?.stage || chain[0] || "";
  const stageIndex = stages.findIndex(([key]) => key === currentStage);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-6xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>逐页讲解 · {title}</DialogTitle>
          <DialogDescription>
            AI
            草稿需要老师逐页接受才会出现在学生端；页面原文变化后旧审校会自动失效。
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
              {running && (
                <Badge variant="secondary" className="animate-pulse">
                  正在处理：
                  {job?.kind === "audio"
                    ? "音频"
                    : job?.kind === "pipeline"
                      ? "一键梳理"
                      : job?.kind === "calibrate"
                        ? "校准"
                        : job?.kind === "digest"
                          ? "整理原文"
                          : "生成"}
                  {job?.stage
                    ? ` · ${stages.find(([key]) => key === job.stage)?.[1] ?? job.stage}`
                    : ""}
                  {job && job.total ? ` ${job.done}/${job.total}` : ""}
                </Badge>
              )}
              {quota && (
                <span className="hint">
                  今日已生成 {quota.used_today} / {quota.daily_limit}
                  {!quota.available && " · 作者期模型未配置，暂不可生成"}
                </span>
              )}
            </div>
            {job && job.kind === "pipeline" && (
              <div className="flex flex-wrap items-center gap-2 text-sm" role="status">
                {stages.map(([key, label], index) => {
                  const done = job.status === "done" || (stageIndex >= 0 && index < stageIndex);
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
              </div>
            )}
            <div className="flex flex-wrap items-end gap-2">
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
                disabled={busyNow || data.coverage.draft === 0}
                onClick={() => void acceptAllDrafts()}
              >
                <Check />{" "}
                {busy === "accept-all"
                  ? "接受中…"
                  : `接受全部草稿（${data.coverage.draft}）`}
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
                <Volume2 /> {busy === "audio-all" ? "合成中…" : "批量合成音频"}
              </Button>
            </div>
            {report && (
              <section className="surface space-y-2 p-4 text-sm">
                <p className="font-medium">
                  校准报告 · {report.windows} 个窗口 · {report.pages} 页
                </p>
                {report.complete === false && (
                  <p className="hint" role="status">
                    已跑到 {report.windows_done ?? 0}/{report.windows} 个窗口，后台会自己接着跑完；
                    任务中断时再点「一键梳理文本」从断点继续。
                  </p>
                )}
                <p className="hint">
                  校准修正已自动应用到整理稿（保持草稿，原始文本不动）；审校页正文就是修正后的整理稿。
                </p>
                {report.reused && (
                  <p className="hint">整册输入未变，直接复用了上一次的报告。</p>
                )}
                {cachePercent !== null && (
                  <p className="hint">
                    模型缓存命中 {cachePercent}%（{usage?.cache_hit_tokens ?? 0} / {cachedTokens} tokens）
                  </p>
                )}
                <p className="whitespace-pre-wrap">
                  {report.summary || "（无摘要）"}
                </p>
                {(report.terms ?? []).length > 0 && (
                  <p className="hint">术语：{report.terms.join("、")}</p>
                )}
                {shrunk.length > 0 && (
                  <p className="hint" role="note">
                    第 {shrunk.join("、")} 窗因输入过长按缩减预算完成，覆盖可能不完整。
                  </p>
                )}
                {renderErrors.length > 0 && (
                  <p className="hint" role="note">
                    {renderErrors.length} 页无法渲染页图，已改用文本校对。
                  </p>
                )}
                {(report.fixes ?? []).length > 0 && (
                  <details open>
                    <summary className="cursor-pointer font-medium">
                      原文修正（{report.fixes!.length} 处，已自动应用）
                    </summary>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b">
                            <th className="py-1 pr-2">页</th>
                            <th className="py-1 pr-2">修正前</th>
                            <th className="py-1 pr-2">修正后</th>
                            <th className="py-1">原因</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.fixes!.map((fix) => (
                            <tr key={fix.page_no} className="border-b align-top">
                              <td className="py-1 pr-2">
                                <button
                                  type="button"
                                  className="underline"
                                  onClick={() => setPageNo(fix.page_no)}
                                >
                                  第 {fix.page_no} 页
                                </button>
                              </td>
                              <td className="max-w-[240px] whitespace-pre-wrap py-1 pr-2">
                                {fix.before}
                              </td>
                              <td className="max-w-[240px] whitespace-pre-wrap py-1 pr-2">
                                {fix.after}
                              </td>
                              <td className="py-1">{fix.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
                {Object.keys(report.tag_map ?? {}).length > 0 && (
                  <details>
                    <summary className="cursor-pointer font-medium">
                      标签合并（{Object.keys(report.tag_map ?? {}).length} 组）
                    </summary>
                    {report.tag_stats && (
                      <p className="hint">
                        标签 {report.tag_stats.before} → {report.tag_stats.after}，合并 {report.tag_stats.merged} 组
                      </p>
                    )}
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b">
                            <th className="py-1 pr-2">别名</th>
                            <th className="py-1">标准名</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(report.tag_map ?? {}).map(([alias, canonical]) => (
                            <tr key={alias} className="border-b">
                              <td className="py-1 pr-2">{alias}</td>
                              <td className="py-1">{canonical}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
                {report.issues_truncated && (
                  <p className="hint" role="note">问题过多，只保留前 120 条。</p>
                )}
                {(report.issues ?? []).length === 0 ? (
                  <p className="hint">没有发现问题。</p>
                ) : (
                  <ul className="space-y-1">
                    {(report.issues ?? []).map((issue) => (
                      <li
                        key={`${issue.page_no}-${issue.kind}`}
                        className="flex items-start gap-2"
                      >
                        <button
                          type="button"
                          className="underline"
                          onClick={() => setPageNo(issue.page_no)}
                        >
                          第 {issue.page_no} 页
                        </button>
                        <span className="hint">
                          {issue.kind === "ocr"
                            ? "原文可疑"
                            : issue.kind === "order"
                              ? "页内顺序"
                              : issue.kind === "tag"
                                ? "标签"
                                : "连贯性"}{" "}
                          ·{" "}
                          {issue.status === "accepted"
                            ? "已接受，需老师确认"
                            : "草稿页，可自动重生成"}
                        </span>
                        <span>{issue.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
