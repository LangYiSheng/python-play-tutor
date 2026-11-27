import { useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  Code2,
  Lock,
} from "lucide-react";
import { Empty, ErrorNotice } from "@/components/common";
import { DialogSkeleton } from "@/components/skeletons";
import { PaginatedRows } from "@/components/paginated-rows";
import { SelectField } from "@/components/select-field";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatTimestamp } from "@/lib/time";
import { useResource } from "@/lib/use-resource";
import {
  formatSeconds,
  pct,
  questionLabel,
  submissionStatusLabels,
  taskKindLabels,
} from "./types";

interface StudentAssessmentRow {
  id: string;
  activity_id: string;
  activity_title?: string;
  chapter_title?: string | null;
  submitted_at?: string | null;
  score: number | null;
  max_score: number;
  correct_count?: number;
  total?: number;
  status: string;
}

interface StudentChapterRow {
  id: number;
  title: string;
  completed: boolean;
  tasks: {
    id: string;
    title: string;
    kind: string;
    required: boolean;
    completed: boolean;
    locked: boolean;
    current: number;
    total: number;
    unit: string;
  }[];
}

interface StudentParticipationRow {
  id: string;
  title: string;
  chapter: string;
  kind: string;
  created_at: string | null;
  read_pages?: number;
  read_seconds?: number;
  watched_seconds?: number;
  current?: number;
  total?: number;
}

interface StudentSubmissionRow {
  id: string;
  activity_id?: string;
  activity_title?: string | null;
  question_id: string;
  question_title?: string;
  question_kind?: string | null;
  mode: string;
  status: string;
  answer: unknown;
  code: string | null;
  feedback: unknown;
  created_at: string;
}

interface StudentRecordPayload {
  student: { id?: number; name: string; student_id: string | null };
  assessments?: StudentAssessmentRow[];
  chapters: StudentChapterRow[];
  participation: StudentParticipationRow[];
  submissions: StudentSubmissionRow[];
}

function readableValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value || "—";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "正确" : "错误";
  if (Array.isArray(value)) return value.length ? value.map(readableValue).join("、") : "—";
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([k, v]) => k !== "source" && v !== undefined && v !== null && v !== "",
  );
  if (!entries.length) return "";
  return entries.map(([k, v]) => `${k}：${readableValue(v)}`).join("\n");
}

function isAcceptedStatus(status: string): boolean {
  return status === "accepted" || status === "AC" || status === "ac";
}

export function StudentRecordSheet({
  classroomId,
  studentId,
  history = false,
  showGrades = false,
  onClose,
}: {
  classroomId: number;
  studentId: number;
  history?: boolean;
  showGrades?: boolean;
  onClose: () => void;
}) {
  const result = useResource<StudentRecordPayload>(
    `/teacher/classrooms/${classroomId}/${history ? "history" : "students"}/${studentId}`,
  );
  const [tab, setTab] = useState(
    history || showGrades ? "assessments" : "submissions",
  );
  const [subMode, setSubMode] = useState<"all" | "submit" | "run">("all");

  const data = result.data;
  const chapters = data?.chapters ?? [];
  const participation = data?.participation ?? [];
  const completedChapters = chapters.filter((c) => c.completed).length;
  const assessments = data?.assessments ?? [];
  const gradedScores = assessments
    .map((a) => a.score)
    .filter((s): s is number => s != null);
  const avgScore =
    gradedScores.length > 0
      ? Math.round(
          (gradedScores.reduce((a, b) => a + b, 0) / gradedScores.length) * 10,
        ) / 10
      : null;

  const submissions = data?.submissions ?? [];
  const formalSubs = submissions.filter((s) => s.mode === "submit");
  const passedFormalSubs = formalSubs.filter((s) => isAcceptedStatus(s.status));
  const filteredSubs = submissions
    .filter((s) => subMode === "all" || s.mode === subMode)
    .slice()
    .reverse();

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="sm:max-w-2xl lg:max-w-3xl">
        <SheetHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={history ? "secondary" : "outline"}>
              {history ? "离班历史档案" : "在班学生档案"}
            </Badge>
            <span className="font-mono text-xs text-muted-foreground">
              {data?.student.student_id ?? "未分配学号"}
            </span>
          </div>
          <SheetTitle>{data?.student.name ?? "学生"}的学习记录</SheetTitle>
          <SheetDescription>
            汇总该生在当前班级的章节通关、单元测验、作答详情与课件学习记录。
          </SheetDescription>
        </SheetHeader>

        <div className="px-5 pt-3">
          <ErrorNotice message={result.error} />
        </div>

        {data && (
          <div className="grid grid-cols-2 gap-2.5 border-b bg-muted/20 px-5 py-3 sm:grid-cols-4">
            <div className="rounded-lg border bg-background px-3 py-2">
              <p className="text-[11px] text-muted-foreground">章节通关</p>
              <p className="mt-0.5 font-mono text-base font-semibold tabular-nums">
                {completedChapters} / {chapters.length}
              </p>
            </div>
            <div className="rounded-lg border bg-background px-3 py-2">
              <p className="text-[11px] text-muted-foreground">测验均分</p>
              <p className="mt-0.5 font-mono text-base font-semibold tabular-nums">
                {avgScore !== null ? `${avgScore} 分` : "—"}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  ({gradedScores.length} 场)
                </span>
              </p>
            </div>
            <div className="rounded-lg border bg-background px-3 py-2">
              <p className="text-[11px] text-muted-foreground">正式提交</p>
              <p className="mt-0.5 font-mono text-base font-semibold tabular-nums">
                {formalSubs.length} 次
                {formalSubs.length > 0 && (
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    ({pct(passedFormalSubs.length, formalSubs.length)}% 通过)
                  </span>
                )}
              </p>
            </div>
            <div className="rounded-lg border bg-background px-3 py-2">
              <p className="text-[11px] text-muted-foreground">活动参与</p>
              <p className="mt-0.5 font-mono text-base font-semibold tabular-nums">
                {participation.length} 项
              </p>
            </div>
          </div>
        )}

        <Tabs
          value={tab}
          onValueChange={setTab}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="border-b px-5 pt-2">
            <TabsList variant="line" aria-label="学生记录类型">
              <TabsTrigger value="assessments">
                测验成绩
                <span aria-hidden="true" className="ml-1 font-mono text-xs text-muted-foreground">
                  {assessments.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="submissions">
                作答记录
                <span aria-hidden="true" className="ml-1 font-mono text-xs text-muted-foreground">
                  {submissions.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="participation">
                活动参与
                <span aria-hidden="true" className="ml-1 font-mono text-xs text-muted-foreground">
                  {participation.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="chapters">
                章节任务
                <span aria-hidden="true" className="ml-1 font-mono text-xs text-muted-foreground">
                  {chapters.length}
                </span>
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent
            value={tab}
            className="flex-1 space-y-3 overflow-y-auto px-5 py-4"
          >
            {result.loading ? (
              <DialogSkeleton rows={4} />
            ) : tab === "assessments" ? (
              assessments.length ? (
                <PaginatedRows rows={assessments}>
                  {(visible) => (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>测验名称</TableHead>
                          <TableHead>交卷时间</TableHead>
                          <TableHead>题数判定</TableHead>
                          <TableHead className="text-right">成绩</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visible.map((item) => (
                          <TableRow key={item.id}>
                            <TableCell>
                              <p className="font-medium">
                                {item.activity_title || item.activity_id}
                              </p>
                              {item.chapter_title && (
                                <p className="text-xs text-muted-foreground">
                                  {item.chapter_title}
                                </p>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {item.submitted_at
                                ? formatTimestamp(item.submitted_at)
                                : "—"}
                            </TableCell>
                            <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                              {item.status === "graded" && item.total !== undefined
                                ? `${item.correct_count ?? 0} / ${item.total} 题`
                                : "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              {item.score === null ? (
                                <Badge
                                  variant={
                                    item.status === "attention"
                                      ? "destructive"
                                      : "secondary"
                                  }
                                >
                                  {item.status === "draft"
                                    ? "未交"
                                    : item.status === "attention"
                                      ? "评测异常"
                                      : "待判定"}
                                </Badge>
                              ) : (
                                <Badge
                                  variant={
                                    item.score >= 60 ? "outline" : "destructive"
                                  }
                                  className="font-mono tabular-nums"
                                >
                                  {item.score} / {item.max_score}
                                </Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </PaginatedRows>
              ) : (
                <Empty title="暂无测验成绩" />
              )
            ) : tab === "submissions" ? (
              submissions.length ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      共 {filteredSubs.length} 条记录（按时间倒序）
                    </span>
                    <SelectField
                      aria-label="筛选提交模式"
                      value={subMode}
                      onValueChange={(v) =>
                        setSubMode(v as "all" | "submit" | "run")
                      }
                    >
                      <option value="all">全部模式</option>
                      <option value="submit">正式提交</option>
                      <option value="run">样例试运行</option>
                    </SelectField>
                  </div>
                  <PaginatedRows rows={filteredSubs}>
                    {(visible) => (
                      <div className="space-y-2.5">
                        {visible.map((s) => {
                          const passed = isAcceptedStatus(s.status);
                          const feedbackText = readableValue(s.feedback);
                          return (
                            <details
                              className="group rounded-lg border bg-card px-4 py-3"
                              key={s.id}
                            >
                              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-sm">
                                <Badge
                                  variant={
                                    s.mode === "submit" ? "outline" : "secondary"
                                  }
                                >
                                  {s.mode === "submit" ? "正式提交" : "试运行"}
                                </Badge>
                                <Badge
                                  variant={
                                    passed
                                      ? "outline"
                                      : s.status === "infrastructure_error"
                                        ? "destructive"
                                        : "secondary"
                                  }
                                  className={
                                    passed
                                      ? "border-(--chart-4)/40 text-(--chart-4)"
                                      : undefined
                                  }
                                >
                                  {submissionStatusLabels[s.status] ?? s.status}
                                </Badge>
                                {s.question_kind && (
                                  <Badge variant="ghost">
                                    {questionLabel(s.question_kind)}
                                  </Badge>
                                )}
                                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                                  {s.question_title || s.question_id}
                                </span>
                                <time className="font-mono text-xs text-muted-foreground">
                                  {formatTimestamp(s.created_at)}
                                </time>
                              </summary>
                              <div className="mt-3 space-y-2.5 border-t pt-3">
                                {s.activity_title && (
                                  <p className="text-xs text-muted-foreground">
                                    所属活动：{s.activity_title}
                                  </p>
                                )}
                                <div>
                                  <p className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                                    <Code2 className="size-3.5" aria-hidden="true" />
                                    {s.code ? "提交代码" : "提交作答"}
                                  </p>
                                  <pre className="max-h-64 overflow-auto rounded-md bg-muted/70 p-3 font-mono text-xs whitespace-pre-wrap">
                                    {s.code || readableValue(s.answer)}
                                  </pre>
                                </div>
                                {feedbackText && feedbackText !== "—" && (
                                  <div className="rounded-md bg-muted/40 px-3 py-2 text-xs whitespace-pre-wrap text-muted-foreground">
                                    {feedbackText}
                                  </div>
                                )}
                              </div>
                            </details>
                          );
                        })}
                      </div>
                    )}
                  </PaginatedRows>
                </div>
              ) : (
                <Empty title="暂无作答记录" />
              )
            ) : tab === "participation" ? (
              data?.participation?.length ? (
                <div className="space-y-2.5">
                  {data.participation.map((r) => (
                    <article className="rounded-lg border bg-card p-3.5" key={r.id}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          {r.kind === "reading" ? (
                            <BookOpen
                              className="size-4 text-(--chart-1)"
                              aria-hidden="true"
                            />
                          ) : (
                            <ClipboardCheck
                              className="size-4 text-(--chart-2)"
                              aria-hidden="true"
                            />
                          )}
                          <p className="font-sans font-medium">{r.title}</p>
                          <Badge variant="secondary">
                            {taskKindLabels[r.kind] ?? r.kind}
                          </Badge>
                        </div>
                        {r.created_at && (
                          <time className="font-mono text-xs text-muted-foreground">
                            {formatTimestamp(r.created_at)}
                          </time>
                        )}
                      </div>
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        {r.chapter} · {taskKindLabels[r.kind] ?? r.kind}
                      </p>
                      <p className="mt-1 text-xs text-foreground">
                        {r.watched_seconds !== undefined
                          ? `有效观看 ${formatSeconds(r.watched_seconds)}`
                          : r.read_pages !== undefined
                            ? `已读 ${r.read_pages} 页，有效阅读 ${formatSeconds(r.read_seconds ?? 0)}`
                            : `题目进度 ${r.current ?? 0} / ${r.total ?? 0}`}
                      </p>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty title="暂无参与记录" />
              )
            ) : chapters.length ? (
              <div className="space-y-3">
                {chapters.map((chapter) => (
                  <section className="rounded-lg border bg-card p-4" key={chapter.id}>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="font-bold">{chapter.title}</h3>
                      {chapter.completed ? (
                        <Badge
                          variant="outline"
                          className="gap-1 border-(--chart-4)/40 text-(--chart-4)"
                        >
                          <CheckCircle2 className="size-3" aria-hidden="true" />
                          已通关
                        </Badge>
                      ) : (
                        <Badge variant="secondary">进行中</Badge>
                      )}
                    </div>
                    {chapter.tasks.length ? (
                      <ul className="mt-2.5 divide-y">
                        {chapter.tasks.map((task) => {
                          const taskPct = pct(task.current, task.total);
                          return (
                            <li
                              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 text-xs"
                              key={task.id}
                            >
                              <span className="font-medium text-foreground">
                                {task.title}
                              </span>
                              <span className="text-muted-foreground">
                                {taskKindLabels[task.kind] ?? task.kind} ·{" "}
                                {task.required ? "必做" : "选做"}
                              </span>
                              <div className="ml-auto flex items-center gap-2">
                                {task.total > 0 && (
                                  <Progress
                                    value={task.completed ? 100 : taskPct}
                                    className="w-20"
                                  />
                                )}
                                <span className="font-mono tabular-nums text-muted-foreground">
                                  {task.completed ? (
                                    <span className="text-(--chart-4)">
                                      已完成 · {task.current}/{task.total} {task.unit}
                                    </span>
                                  ) : task.locked ? (
                                    <span className="inline-flex items-center gap-1">
                                      <Lock className="size-3" aria-hidden="true" />
                                      待解锁 · {task.current}/{task.total} {task.unit}
                                    </span>
                                  ) : (
                                    `未完成 · ${task.current}/${task.total} ${task.unit}`
                                  )}
                                </span>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">
                        本章暂无任务
                      </p>
                    )}
                  </section>
                ))}
              </div>
            ) : (
              <Empty title="本班暂无已开放章节" />
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
