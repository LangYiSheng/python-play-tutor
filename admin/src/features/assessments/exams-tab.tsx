import { useEffect, useState } from "react";
import { Download, Eye, Plus, Trash2 } from "lucide-react";
import { Empty, ErrorNotice } from "@/components/common";
import { TableSkeleton } from "@/components/skeletons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api";
import { courseStudioApi, type ExamRecord, type KnowledgeChapter } from "@/lib/course-studio-api";
import { ExamEditor } from "./exam-editor";
import { ExamWizard } from "./exam-wizard";

export function ExamsTab({
  courseId,
  revision,
  onJobSubmitted,
}: {
  courseId: number;
  revision: number;
  onJobSubmitted: () => void;
}) {
  const [exams, setExams] = useState<ExamRecord[]>([]);
  const [chapters, setChapters] = useState<KnowledgeChapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"list" | "wizard">("list");
  const [activeExam, setActiveExam] = useState<ExamRecord | null>(null);
  const [busyId, setBusyId] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      courseStudioApi.listExams(courseId, controller.signal),
      courseStudioApi.listKnowledge(courseId, controller.signal),
    ])
      .then(([examRes, knowRes]) => {
        if (controller.signal.aborted) return;
        setExams(examRes.exams);
        setChapters(knowRes.chapters);
        setError("");
        setLoading(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(e));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [courseId, revision]);

  async function downloadZip(row: ExamRecord) {
    setBusyId(row.id);
    try {
      await courseStudioApi.exportExam(courseId, row.id, "zip", "A", row.title);
      toast.add({ title: "试卷资料包已导出", type: "success" });
    } catch (e) {
      toast.add({ title: errorMessage(e), type: "error" });
    } finally {
      setBusyId("");
    }
  }

  async function removeRow(row: ExamRecord) {
    if (!window.confirm(`确定删除试卷「${row.title}」？此操作不会影响题库已有试题。`)) return;
    setBusyId(row.id);
    try {
      await courseStudioApi.deleteExam(courseId, row.id);
      setExams((prev) => prev.filter((x) => x.id !== row.id));
      toast.add({ title: "已删除试卷", type: "success" });
    } catch (e) {
      toast.add({ title: errorMessage(e), type: "error" });
    } finally {
      setBusyId("");
    }
  }

  if (activeExam) {
    return (
      <ExamEditor
        key={activeExam.id}
        courseId={courseId}
        exam={activeExam}
        onUpdated={(updated) => {
          setActiveExam(updated);
          setExams((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
        }}
        onDeleted={(deletedId) => {
          setActiveExam(null);
          setExams((prev) => prev.filter((x) => x.id !== deletedId));
        }}
        onBack={() => setActiveExam(null)}
      />
    );
  }

  if (mode === "wizard") {
    return (
      <ExamWizard
        courseId={courseId}
        chapters={chapters}
        onCreated={(created) => {
          setExams((prev) => [created, ...prev]);
          setMode("list");
          setActiveExam(created);
        }}
        onCancel={() => setMode("list")}
        onFillGapJob={onJobSubmitted}
      />
    );
  }

  return (
    <div className="space-y-4">
      <ErrorNotice message={error} />
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-muted-foreground">
            基于客观题库智能抽取生成单卷或 A/B 平行卷，支持双向细目表及多格式导出（随课程包同步备份）。
          </div>
          <Button type="button" disabled={loading} onClick={() => setMode("wizard")}>
            <Plus /> 新建试卷
          </Button>
        </div>

        {loading ? (
          <TableSkeleton framed={false} rows={3} />
        ) : exams.length === 0 ? (
          <Empty title="本课程尚未生成试卷" description="点击右上角「新建试卷」配置命题蓝图并生成试卷。" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>试卷名称</TableHead>
                <TableHead>模式与范围</TableHead>
                <TableHead>规模</TableHead>
                <TableHead>最近更新</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exams.map((row) => {
                const countA = row.variants.A?.questions?.length ?? 0;
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <p className="font-medium">{row.title}</p>
                      {row.subtitle && <p className="text-xs text-muted-foreground">{row.subtitle}</p>}
                    </TableCell>
                    <TableCell className="space-x-1">
                      <Badge variant="outline">{row.abMode ? "A/B 平行卷" : "单卷"}</Badge>
                      <Badge variant="secondary">{row.chapters.length} 章</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {countA} 题 · {row.totalScore} 分
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.updatedAt.slice(0, 16).replace("T", " ")}
                    </TableCell>
                    <TableCell className="text-right space-x-1">
                      <Button type="button" size="xs" variant="outline" onClick={() => setActiveExam(row)}>
                        <Eye /> 打开审校
                      </Button>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`导出 ${row.title} 资料包`}
                        disabled={busyId === row.id}
                        onClick={() => void downloadZip(row)}
                      >
                        <Download />
                      </Button>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`删除 ${row.title}`}
                        disabled={busyId === row.id}
                        onClick={() => void removeRow(row)}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
