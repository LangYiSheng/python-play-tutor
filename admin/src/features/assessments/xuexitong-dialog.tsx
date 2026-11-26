import { useEffect, useState } from "react";
import { CheckCircle2, Download, FileSpreadsheet, FileText, ShieldCheck } from "lucide-react";
import { ErrorNotice, Loading } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api";
import { lectioApi, type ExerciseValidateResult, type KnowledgeChapter } from "@/lib/lectio-api";

function XuexitongBody({ courseId, onClose }: { courseId: number; onClose: () => void }) {
  const [chapters, setChapters] = useState<KnowledgeChapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [chapterId, setChapterId] = useState("all");
  const [status, setStatus] = useState<"ready" | "all" | "draft">("ready");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [validation, setValidation] = useState<ExerciseValidateResult | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lectioApi
      .listKnowledge(courseId, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) {
          setChapters(res.chapters);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(e));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [courseId]);

  const scopeOpts = {
    chapterId: chapterId !== "all" ? Number(chapterId) : undefined,
    status,
    label: chapters.find((ch) => String(ch.id) === chapterId)?.title ?? "课程题库",
  };

  async function runValidate() {
    setBusy(true);
    setError("");
    try {
      const res = await lectioApi.validateExercises(courseId, {
        chapterId: scopeOpts.chapterId,
        status: scopeOpts.status,
      });
      setValidation(res);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function runExport(fmt: "xuexitong_xlsx" | "xuexitong_txt" | "xlsx") {
    setBusy(true);
    setError("");
    try {
      await lectioApi.exportExercises(courseId, fmt, scopeOpts);
      toast.add({ title: "题库导出已开始", type: "success" });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <ErrorNotice message={error} />
      {loading ? (
        <Loading />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="field">
              <Label htmlFor="xuetong-chapter">章节范围</Label>
              <SelectField
                id="xuetong-chapter"
                value={chapterId}
                disabled={busy}
                onValueChange={(v) => {
                  setChapterId(v);
                  setValidation(null);
                }}
              >
                <option value="all">全部章节</option>
                {chapters.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    第 {ch.order_index} 章 · {ch.title}
                  </option>
                ))}
              </SelectField>
            </div>
            <div className="field">
              <Label htmlFor="xuetong-status">题目状态</Label>
              <SelectField
                id="xuetong-status"
                value={status}
                disabled={busy}
                onValueChange={(v) => {
                  setStatus(v as "ready" | "all" | "draft");
                  setValidation(null);
                }}
              >
                <option value="ready">仅可用（推荐）</option>
                <option value="all">可用 + 待审核</option>
                <option value="draft">仅待审核草稿</option>
              </SelectField>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => void runValidate()}>
              <ShieldCheck /> 执行合规预检
            </Button>
            <Button type="button" disabled={busy} onClick={() => void runExport("xuexitong_xlsx")}>
              <FileSpreadsheet /> 学习通批量导入 (.xlsx)
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void runExport("xuexitong_txt")}>
              <FileText /> 学习通智能导入 (.txt)
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void runExport("xlsx")}>
              <Download /> 客观题汇总表 (.xlsx)
            </Button>
          </div>

          {validation && (
            <section className="rounded-md border p-3 space-y-2 text-sm" aria-label="题库合规预检结果">
              <div className="flex flex-wrap items-center gap-2">
                <CheckCircle2 size={16} />
                <strong>预检结果：</strong>
                <Badge variant={validation.ok ? "secondary" : "destructive"}>
                  {validation.ok ? "通过导出校验" : "存在阻塞项"}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  可用客观题 {validation.total} 道
                  {validation.skipped_non_objective > 0
                    ? ` · 自动跳过 ${validation.skipped_non_objective} 道编程/非客观题`
                    : ""}
                </span>
              </div>
              {validation.errors.length > 0 && (
                <ul className="list-disc pl-5 text-xs text-destructive space-y-0.5">
                  {validation.errors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              )}
              {validation.warnings.length > 0 && (
                <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                  {validation.warnings.map((warn, i) => (
                    <li key={i}>{warn}</li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          关闭
        </Button>
      </DialogFooter>
    </div>
  );
}

export function XuexitongDialog({
  open,
  courseId,
  onOpenChange,
}: {
  open: boolean;
  courseId: number;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>导出试题与合规预检</DialogTitle>
          <DialogDescription>检查当前客观题是否满足学习通与教学汇总模板要求，并导出标准文件。</DialogDescription>
        </DialogHeader>
        {open && <XuexitongBody courseId={courseId} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
