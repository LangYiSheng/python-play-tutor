import { useState } from "react";
import { ArrowDown, ArrowLeft, ArrowLeftRight, ArrowUp, Download, Pencil, Trash2 } from "lucide-react";
import { Empty, ErrorNotice } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api";
import { lectioApi, type ExamCandidate, type ExamRecord } from "@/lib/lectio-api";
import { EXAM_TYPE_LABELS, ExamSwapDialog, formatExamAnswer } from "./exam-swap-dialog";

export function ExamEditor({
  classroomId,
  exam,
  onUpdated,
  onDeleted,
  onBack,
}: {
  classroomId: number;
  exam: ExamRecord;
  onUpdated: (exam: ExamRecord) => void;
  onDeleted: (examId: string) => void;
  onBack: () => void;
}) {
  const [variant, setVariant] = useState<"A" | "B">("A");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [swapUid, setSwapUid] = useState<string | null>(null);
  const [metaOpen, setMetaOpen] = useState(false);
  const [metaTitle, setMetaTitle] = useState(exam.title);
  const [metaSubtitle, setMetaSubtitle] = useState(exam.subtitle);
  const [metaMode, setMetaMode] = useState(exam.examMode || "闭卷");
  const [metaDuration, setMetaDuration] = useState(exam.durationMinutes || 90);
  const [scoreDrafts, setScoreDrafts] = useState<Record<string, string>>({});

  const activeVar = exam.abMode && variant === "B" && exam.variants.B ? "B" : "A";
  const variantObj = exam.variants[activeVar] ?? exam.variants.A;
  const questions = variantObj?.questions ?? [];

  async function patch(body: Record<string, unknown>, message?: string) {
    setBusy(true);
    setError("");
    try {
      const updated = await lectioApi.patchExam(classroomId, exam.id, body);
      onUpdated(updated);
      if (message) toast.add({ title: message, type: "success" });
      return updated;
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function saveMeta(event: React.FormEvent) {
    event.preventDefault();
    if (!metaTitle.trim()) return;
    await patch(
      {
        title: metaTitle.trim(),
        subtitle: metaSubtitle.trim(),
        examMode: metaMode,
        durationMinutes: metaDuration,
      },
      "试卷信息已更新",
    );
    setMetaOpen(false);
  }

  async function applyScore(uid: string, currentScore: number) {
    const raw = scoreDrafts[uid];
    if (raw === undefined) return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("分值必须大于 0。");
      return;
    }
    if (Math.abs(parsed - currentScore) < 0.01) return;
    await patch({ action: "score", variant: activeVar, uid, score: parsed }, "已更新本题分值");
  }

  async function replaceWith(candidate: ExamCandidate) {
    if (!swapUid) return;
    await patch(
      {
        action: "replace",
        variant: activeVar,
        uid: swapUid,
        candidateId: candidate.id,
        candidateChapter: candidate.chapter,
      },
      "已替换为新题目",
    );
  }

  async function removeQuestion(uid: string) {
    if (!window.confirm("确定将本题从当前试卷移出？")) return;
    await patch({ action: "remove", variant: activeVar, uid }, "已移出试题");
  }

  async function handleExport(
    kind: "student_docx" | "teacher_docx" | "blueprint_xlsx" | "xuexitong_xlsx" | "xuexitong_txt" | "zip",
  ) {
    setBusy(true);
    setError("");
    try {
      await lectioApi.exportExam(classroomId, exam.id, kind, activeVar, exam.title, exam.abMode);
      toast.add({ title: "试卷文件已导出", type: "success" });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeExam() {
    if (!window.confirm(`确定永久删除试卷「${exam.title}」？此操作不会删除题库原题。`)) return;
    setBusy(true);
    try {
      await lectioApi.deleteExam(classroomId, exam.id);
      toast.add({ title: "试卷已删除", type: "success" });
      onDeleted(exam.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="surface p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={onBack}>
                <ArrowLeft /> 返回列表
              </Button>
              <h2 className="text-lg font-semibold">{exam.title}</h2>
              <Badge variant="outline">{exam.examMode || "闭卷"}</Badge>
              <Badge variant="secondary">{exam.durationMinutes} 分钟</Badge>
              {exam.abMode && <Badge>A/B 平行卷</Badge>}
            </div>
            {exam.subtitle && <p className="text-xs text-muted-foreground pl-2">{exam.subtitle}</p>}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setMetaTitle(exam.title);
                setMetaSubtitle(exam.subtitle);
                setMetaMode(exam.examMode || "闭卷");
                setMetaDuration(exam.durationMinutes || 90);
                setMetaOpen(true);
              }}
            >
              <Pencil /> 编辑信息
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="sm" variant="outline" disabled={busy} />}>
                <Download /> 导出试卷
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuItem className="whitespace-nowrap" onClick={() => void handleExport("student_docx")}>
                  学生卷 (.docx)
                </DropdownMenuItem>
                <DropdownMenuItem className="whitespace-nowrap" onClick={() => void handleExport("teacher_docx")}>
                  教师答案解析卷 (.docx)
                </DropdownMenuItem>
                <DropdownMenuItem className="whitespace-nowrap" onClick={() => void handleExport("blueprint_xlsx")}>
                  命题双向细目表 (.xlsx)
                </DropdownMenuItem>
                <DropdownMenuItem className="whitespace-nowrap" onClick={() => void handleExport("xuexitong_xlsx")}>
                  学习通导入表 (.xlsx)
                </DropdownMenuItem>
                <DropdownMenuItem className="whitespace-nowrap" onClick={() => void handleExport("xuexitong_txt")}>
                  学习通智能导入 (.txt)
                </DropdownMenuItem>
                <DropdownMenuItem className="whitespace-nowrap" onClick={() => void handleExport("zip")}>
                  完整试卷资料包 (.zip)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void removeExam()}>
              <Trash2 /> 删除试卷
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/20 px-4 py-2.5 text-sm">
          <span>
            当前卷总分：<strong>{variantObj?.totalScore ?? exam.totalScore}</strong> 分
          </span>
          <span>题数：{questions.length} 题</span>
          {exam.stats.knowledgeCoverage && (
            <span>
              知识点覆盖：{exam.stats.knowledgeCoverage.covered} / {exam.stats.knowledgeCoverage.total}
            </span>
          )}
          {exam.abMode && (
            <>
              <span>
                AB 卷重复：{exam.stats.overlapCount} 题（{Math.round(exam.stats.overlapRate * 100)}%）
              </span>
              <div className="ml-auto inline-flex rounded-md border bg-background p-0.5">
                <Button
                  type="button"
                  size="xs"
                  variant={activeVar === "A" ? "secondary" : "ghost"}
                  onClick={() => setVariant("A")}
                >
                  A 卷
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant={activeVar === "B" ? "secondary" : "ghost"}
                  onClick={() => setVariant("B")}
                >
                  B 卷
                </Button>
              </div>
            </>
          )}
        </div>

        <ErrorNotice message={error} />

        {questions.length === 0 ? (
          <Empty title="当前卷暂无试题" />
        ) : (
          <ol className="space-y-3">
            {questions.map((q, idx) => {
              const optionKeys = Object.keys(q.options ?? {});
              const scoreVal = scoreDrafts[q.uid] ?? String(q.score);
              return (
                <li key={q.uid} className="rounded-md border p-4 space-y-2.5 bg-background">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="font-semibold text-sm">第 {idx + 1} 题</span>
                      <Badge variant="outline">{EXAM_TYPE_LABELS[q.type] ?? q.type}</Badge>
                      <Badge variant="secondary">{q.chapter}</Badge>
                      {q.knowledge_points.map((kp) => (
                        <Badge key={kp} variant="outline">
                          {kp}
                        </Badge>
                      ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Input
                        type="number"
                        step={0.5}
                        min={0.5}
                        max={100}
                        aria-label={`第 ${idx + 1} 题分值`}
                        className="h-7 w-20 text-xs"
                        disabled={busy}
                        value={scoreVal}
                        onChange={(e) => setScoreDrafts((prev) => ({ ...prev, [q.uid]: e.target.value }))}
                        onBlur={() => void applyScore(q.uid, q.score)}
                      />
                      <span className="text-xs text-muted-foreground mr-1">分</span>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`上移第 ${idx + 1} 题`}
                        disabled={busy || idx === 0 || questions[idx - 1]?.type !== q.type}
                        onClick={() => void patch({ action: "move", variant: activeVar, uid: q.uid, direction: "up" })}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`下移第 ${idx + 1} 题`}
                        disabled={busy || idx === questions.length - 1 || questions[idx + 1]?.type !== q.type}
                        onClick={() => void patch({ action: "move", variant: activeVar, uid: q.uid, direction: "down" })}
                      >
                        <ArrowDown />
                      </Button>
                      <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => setSwapUid(q.uid)}>
                        <ArrowLeftRight /> 换题
                      </Button>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`移出第 ${idx + 1} 题`}
                        disabled={busy}
                        onClick={() => void removeQuestion(q.uid)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>

                  <p className="text-sm font-medium leading-relaxed">{q.question}</p>

                  {optionKeys.length > 0 && q.type !== "true_false" && (
                    <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                      {optionKeys.map((key) => (
                        <div key={key}>
                          {key.toUpperCase()}. {q.options[key]}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="rounded bg-muted/30 px-3 py-2 text-xs space-y-1">
                    <div>
                      <strong>参考答案：</strong>
                      {formatExamAnswer(q.answer, q.type)}
                    </div>
                    {q.explanation && (
                      <div className="text-muted-foreground">
                        <strong>解析：</strong>
                        {q.explanation}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <ExamSwapDialog
        target={swapUid}
        classroomId={classroomId}
        examId={exam.id}
        variant={activeVar}
        onPick={replaceWith}
        onClose={() => setSwapUid(null)}
      />

      <Dialog open={metaOpen} onOpenChange={(o) => !busy && setMetaOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑试卷信息</DialogTitle>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(e) => void saveMeta(e)}>
            <div className="field">
              <Label htmlFor="edit-exam-title">试卷标题</Label>
              <Input id="edit-exam-title" required value={metaTitle} onChange={(e) => setMetaTitle(e.target.value)} />
            </div>
            <div className="field">
              <Label htmlFor="edit-exam-sub">副标题</Label>
              <Input id="edit-exam-sub" value={metaSubtitle} onChange={(e) => setMetaSubtitle(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="field">
                <Label htmlFor="edit-exam-mode">考试方式</Label>
                <SelectField id="edit-exam-mode" value={metaMode} onValueChange={setMetaMode}>
                  <option value="闭卷">闭卷</option>
                  <option value="开卷">开卷</option>
                </SelectField>
              </div>
              <div className="field">
                <Label htmlFor="edit-exam-duration">时长（分钟）</Label>
                <Input
                  id="edit-exam-duration"
                  type="number"
                  min={15}
                  max={300}
                  value={metaDuration}
                  onChange={(e) => setMetaDuration(Math.max(15, Number(e.target.value) || 90))}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setMetaOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={busy || !metaTitle.trim()}>
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
