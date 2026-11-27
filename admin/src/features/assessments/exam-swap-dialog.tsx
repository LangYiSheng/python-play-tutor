import { useEffect, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { Empty, ErrorNotice, Loading } from "@/components/common";
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
import { errorMessage } from "@/lib/api";
import { courseStudioApi, type ExamCandidate, type ExamSectionType } from "@/lib/course-studio-api";

export const EXAM_TYPE_LABELS: Record<ExamSectionType, string> = {
  single: "单选题",
  multiple: "多选题",
  true_false: "判断题",
  fill_blank: "填空题",
};

export function formatExamAnswer(ans: unknown, qtype: ExamSectionType): string {
  if (typeof ans === "boolean" || qtype === "true_false") {
    const normalized = typeof ans === "string" ? ans.trim().toLowerCase() : ans;
    if (normalized === true || normalized === "true" || normalized === "正确" || normalized === "a" || normalized === "对") {
      return "正确";
    }
    if (normalized === false || normalized === "false" || normalized === "错误" || normalized === "b" || normalized === "错") {
      return "错误";
    }
  }
  if (qtype === "single" || qtype === "multiple") {
    if (Array.isArray(ans)) return ans.map((x) => String(x).trim().toUpperCase()).filter(Boolean).join("、");
    if (typeof ans === "string" && ans.trim()) return ans.trim().toUpperCase();
  }
  if (Array.isArray(ans)) return ans.join("、");
  if (ans == null || ans === "") return "—";
  return String(ans);
}

function SwapBody({
  courseId,
  examId,
  variant,
  uid,
  onPick,
  onClose,
}: {
  courseId: number;
  examId: string;
  variant: "A" | "B";
  uid: string;
  onPick: (candidate: ExamCandidate) => Promise<void>;
  onClose: () => void;
}) {
  const [candidates, setCandidates] = useState<ExamCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    courseStudioApi
      .listExamCandidates(courseId, examId, variant, uid)
      .then((res) => {
        if (!controller.signal.aborted) {
          setCandidates(res.candidates);
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
  }, [courseId, examId, variant, uid]);

  async function choose(c: ExamCandidate) {
    setBusyId(c.id);
    setError("");
    try {
      await onPick(c);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="space-y-3">
      <ErrorNotice message={error} />
      {loading ? (
        <Loading />
      ) : candidates.length === 0 ? (
        <Empty title="当前题库中暂无同题型可替换候选" />
      ) : (
        <ul className="max-h-96 space-y-2 overflow-y-auto pr-1">
          {candidates.map((c) => (
            <li key={c.id} className="rounded-md border p-3 space-y-1.5 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">{c.chapter}</Badge>
                  {c.knowledge_points.slice(0, 3).map((kp) => (
                    <Badge key={kp} variant="secondary">
                      {kp}
                    </Badge>
                  ))}
                  {c.usedInOtherVariant && <Badge variant="destructive">另一卷已用</Badge>}
                </div>
                <Button size="xs" disabled={Boolean(busyId)} onClick={() => void choose(c)}>
                  <ArrowLeftRight /> {busyId === c.id ? "替换中…" : "选为本题"}
                </Button>
              </div>
              <p className="font-medium leading-relaxed">{c.question}</p>
              <p className="text-xs text-muted-foreground">答案：{formatExamAnswer(c.answer, c.type)}</p>
            </li>
          ))}
        </ul>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          关闭
        </Button>
      </DialogFooter>
    </div>
  );
}

export function ExamSwapDialog({
  target,
  courseId,
  examId,
  variant,
  onPick,
  onClose,
}: {
  target: string | null;
  courseId: number;
  examId: string;
  variant: "A" | "B";
  onPick: (candidate: ExamCandidate) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>替换试题（{variant} 卷）</DialogTitle>
          <DialogDescription>优先推荐同知识点、未出现在本卷及平行卷中的候选客观题。</DialogDescription>
        </DialogHeader>
        {target !== null && (
          <SwapBody
            courseId={courseId}
            examId={examId}
            variant={variant}
            uid={target}
            onPick={onPick}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
