import { useMemo, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  Code2,
  Eye,
  FileQuestionMark,
  LayoutGrid,
  List,
  Lock,
  RefreshCw,
  Unlock,
} from "lucide-react";
import {
  ErrorNotice,
  ListEmpty,
  Loading,
  PageHeader,
  TableSearch,
} from "@/components/common";
import { ManagementTable } from "@/components/management-table";
import { PaginatedRows } from "@/components/paginated-rows";
import { SelectField } from "@/components/select-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress, SegmentedProgress } from "@/components/ui/progress";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useResource } from "@/lib/use-resource";
import { StudentRecordSheet } from "./student-record-sheet";
import {
  activityProgressSummary,
  formatSeconds,
  gradeLabel,
  pct,
  taskKindLabels,
  type ActivityStudentResult,
  type ClassroomActivityReport,
  type ReportActivity,
} from "./types";

function KindIcon({ kind }: { kind: string }) {
  if (kind === "reading") return <BookOpen className="size-3.5 text-(--chart-1)" aria-hidden="true" />;
  if (kind === "programming") return <Code2 className="size-3.5 text-(--chart-3)" aria-hidden="true" />;
  if (kind === "assessment") return <ClipboardCheck className="size-3.5 text-(--chart-4)" aria-hidden="true" />;
  return <FileQuestionMark className="size-3.5 text-(--chart-2)" aria-hidden="true" />;
}

function studentTaskState(
  result?: ActivityStudentResult,
): "completed" | "in_progress" | "not_started" {
  if (!result) return "not_started";
  return result.completed ? "completed" : "in_progress";
}

function matrixCellBadge(activity: ReportActivity, result?: ActivityStudentResult) {
  if (!result) {
    return <span className="text-xs text-muted-foreground">未开始</span>;
  }
  if (activity.kind === "assessment") {
    if (result.score != null) {
      return (
        <Badge
          variant={result.score >= 60 ? "outline" : "destructive"}
          className="font-mono tabular-nums"
        >
          {result.score} 分
        </Badge>
      );
    }
    return (
      <Badge variant={result.assessment_status === "attention" ? "destructive" : "secondary"}>
        {gradeLabel(result)}
      </Badge>
    );
  }
  if (result.completed) {
    return (
      <Badge variant="outline" className="border-(--chart-4)/40 text-(--chart-4)">
        已完成
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="font-mono tabular-nums">
      {activityProgressSummary(result)}
    </Badge>
  );
}

export function TaskDetailsPage({ classroomId }: { classroomId: number }) {
  const report = useResource<ClassroomActivityReport>(
    `/teacher/classrooms/${classroomId}/activity-report?grades=false`,
  );
  const [view, setView] = useState<"list" | "matrix">("list");
  const [query, setQuery] = useState("");
  const [chapterFilter, setChapterFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [reqFilter, setReqFilter] = useState("all");
  const [openFilter, setOpenFilter] = useState("all");
  const [studentScope, setStudentScope] = useState<"all" | "lagging">("all");

  const [selectedActivityId, setSelectedActivityId] = useState("");
  const [drawerTab, setDrawerTab] = useState<"all" | "incomplete" | "in_progress" | "completed">("all");
  const [drawerQuery, setDrawerQuery] = useState("");
  const [learnerId, setLearnerId] = useState<number | null>(null);

  const d = report.data;

  const chapterOptions = useMemo(() => {
    if (!d) return [];
    const seen = new Set<string>();
    const list: string[] = [];
    for (const act of d.activities) {
      if (!seen.has(act.chapter)) {
        seen.add(act.chapter);
        list.push(act.chapter);
      }
    }
    return list;
  }, [d]);

  if (!d) return report.loading ? <Loading /> : <ErrorNotice message={report.error} />;

  const totalStudents = d.students.length;
  const needle = query.trim().toLowerCase();

  const filteredActivities = d.activities.filter((a) => {
    if (chapterFilter !== "all" && a.chapter !== chapterFilter) return false;
    if (kindFilter !== "all" && a.kind !== kindFilter) return false;
    if (reqFilter !== "all" && (reqFilter === "required") !== a.required) return false;
    if (openFilter !== "all" && (openFilter === "active") !== a.opened) return false;
    if (view === "list" && needle) {
      return `${a.chapter} ${a.title}`.toLowerCase().includes(needle);
    }
    return true;
  });

  const openRequiredTasks = d.activities.filter((a) => a.opened && a.required);
  const openReqExpected = openRequiredTasks.length * totalStudents;
  const openReqCompleted = openRequiredTasks.reduce((sum, a) => sum + a.completed, 0);
  const openReqPct = pct(openReqCompleted, openReqExpected);

  let allDoneStudents = 0;
  let startedStudents = 0;
  for (const s of d.students) {
    const anyRecord = d.activities.some((a) => Boolean(a.results[s.id]));
    if (anyRecord) startedStudents += 1;
    if (
      openRequiredTasks.length > 0 &&
      openRequiredTasks.every((a) => Boolean(a.results[s.id]?.completed))
    ) {
      allDoneStudents += 1;
    }
  }
  const notStartedStudents = Math.max(0, totalStudents - startedStudents);
  const inProgressStudents = Math.max(0, totalStudents - allDoneStudents - notStartedStudents);

  const matrixStudents = d.students.filter((s) => {
    if (needle && !`${s.name} ${s.student_id}`.toLowerCase().includes(needle)) {
      return false;
    }
    if (studentScope === "lagging") {
      return openRequiredTasks.some((a) => !a.results[s.id]?.completed);
    }
    return true;
  });

  const selectedActivity = d.activities.find((a) => a.id === selectedActivityId) ?? null;

  const isFiltered =
    Boolean(needle) ||
    chapterFilter !== "all" ||
    kindFilter !== "all" ||
    reqFilter !== "all" ||
    openFilter !== "all" ||
    studentScope !== "all";

  function resetFilters() {
    setQuery("");
    setChapterFilter("all");
    setKindFilter("all");
    setReqFilter("all");
    setOpenFilter("all");
    setStudentScope("all");
  }

  function openTaskDrawer(activityId: string) {
    setSelectedActivityId(activityId);
    setDrawerTab("all");
    setDrawerQuery("");
  }

  const drawerStudents = selectedActivity
    ? d.students.filter((s) => {
        const state = studentTaskState(selectedActivity.results[s.id]);
        if (drawerTab === "completed" && state !== "completed") return false;
        if (drawerTab === "in_progress" && state !== "in_progress") return false;
        if (drawerTab === "incomplete" && state === "completed") return false;
        const q = drawerQuery.trim().toLowerCase();
        if (q && !`${s.name} ${s.student_id}`.toLowerCase().includes(q)) return false;
        return true;
      })
    : [];

  const selectedInProgress = selectedActivity
    ? (selectedActivity.in_progress ??
      Object.values(selectedActivity.results).filter((r) => !r.completed).length)
    : 0;
  const selectedNotStarted = selectedActivity
    ? Math.max(0, totalStudents - selectedActivity.completed - selectedInProgress)
    : 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="任务点明细"
        description="按章节跟踪当前班级必读资料、客观/编程练习与单元测验的实时推进情况。"
      >
        <div className="flex items-center gap-2">
          <Tabs
            value={view}
            onValueChange={(v) => setView(v === "matrix" ? "matrix" : "list")}
          >
            <TabsList aria-label="明细视图切换">
              <TabsTrigger value="list">
                <List className="size-3.5" aria-hidden="true" />
                任务列表
              </TabsTrigger>
              <TabsTrigger value="matrix">
                <LayoutGrid className="size-3.5" aria-hidden="true" />
                学生矩阵
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            variant="outline"
            size="sm"
            onClick={report.reload}
            disabled={report.loading}
          >
            <RefreshCw className={report.loading ? "animate-spin motion-reduce:animate-none" : ""} />
            刷新
          </Button>
        </div>
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <CardDescription>本班在籍学生</CardDescription>
            <CardTitle className="font-sans text-xl font-semibold tabular-nums">
              {totalStudents} 人
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            已产生学习记录 <strong className="font-mono font-medium text-foreground">{startedStudents}</strong> 人
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>章节与任务规模</CardDescription>
            <CardTitle className="font-sans text-xl font-semibold tabular-nums">
              {d.open_chapters !== undefined && d.total_chapters !== undefined
                ? `${d.open_chapters} / ${d.total_chapters} 章已开放`
                : `${d.activities.filter((a) => a.opened).length} 项已开放`}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            共 {d.activities.length} 项任务点（必做 {d.activities.filter((a) => a.required).length} 项）
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>开放必做整体完成率</CardDescription>
            <CardTitle className="flex items-baseline gap-2 font-sans text-xl font-semibold tabular-nums">
              <span>{openReqExpected > 0 ? `${openReqPct}%` : "—"}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {openReqExpected > 0
                  ? `${openReqCompleted}/${openReqExpected} 人次`
                  : "暂无已开放必做"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Progress value={openReqPct} indicatorClassName="bg-(--chart-4)" aria-label="开放必做整体完成率" />
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>学生督学状态</CardDescription>
            <CardTitle className="flex items-baseline gap-2 font-sans text-xl font-semibold tabular-nums">
              <span>{allDoneStudents} 人全通</span>
              <span className="text-xs font-normal text-muted-foreground">
                进行中 {inProgressStudents} · 未开始 {notStartedStudents}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SegmentedProgress
              total={totalStudents}
              aria-label="学生督学三态占比"
              segments={[
                { key: "done", label: "全部完成", value: allDoneStudents, colorClassName: "bg-(--chart-4)" },
                { key: "doing", label: "进行中", value: inProgressStudents, colorClassName: "bg-(--chart-1)" },
                { key: "idle", label: "未开始", value: notStartedStudents, colorClassName: "bg-muted-foreground/25" },
              ]}
            />
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TableSearch
          label={view === "matrix" ? "搜索学生姓名或学号" : "搜索章节或活动"}
          placeholder={view === "matrix" ? "搜索学号或姓名" : "搜索章节或任务点"}
          value={query}
          onValueChange={setQuery}
        />
        <SelectField
          aria-label="筛选章节"
          value={chapterFilter}
          onValueChange={setChapterFilter}
        >
          <option value="all">全部章节</option>
          {chapterOptions.map((ch) => (
            <option key={ch} value={ch}>
              {ch}
            </option>
          ))}
        </SelectField>
        <SelectField
          aria-label="任务类型"
          value={kindFilter}
          onValueChange={setKindFilter}
        >
          <option value="all">全部类型</option>
          <option value="reading">资料阅读</option>
          <option value="objective">客观练习</option>
          <option value="programming">编程练习</option>
          <option value="assessment">单元测验</option>
        </SelectField>
        <SelectField
          aria-label="任务要求"
          value={reqFilter}
          onValueChange={setReqFilter}
        >
          <option value="all">全部要求</option>
          <option value="required">仅看必做</option>
          <option value="optional">仅看选做</option>
        </SelectField>
        <SelectField
          aria-label="开放状态"
          value={openFilter}
          onValueChange={setOpenFilter}
        >
          <option value="all">全部状态</option>
          <option value="active">已开放</option>
          <option value="inactive">尚未开放</option>
        </SelectField>
        {view === "matrix" && (
          <SelectField
            aria-label="学生督学筛选"
            value={studentScope}
            onValueChange={(v) => setStudentScope(v === "lagging" ? "lagging" : "all")}
          >
            <option value="all">全部在班学生</option>
            <option value="lagging">仅看有未完成必做</option>
          </SelectField>
        )}
      </div>

      {!d.activities.length ? (
        <div className="surface">
          <ListEmpty title="课程暂无活动" filtered={false} reset={resetFilters} />
        </div>
      ) : view === "list" ? (
        filteredActivities.length === 0 ? (
          <div className="surface">
            <ListEmpty title="未找到匹配的任务点" filtered={isFiltered} reset={resetFilters} />
          </div>
        ) : (
          <div className="surface overflow-hidden">
            <ManagementTable
              paginate
              columnTools={false}
              key={`list:${query}:${chapterFilter}:${kindFilter}:${reqFilter}:${openFilter}`}
            >
              <TableHeader>
                <TableRow>
                  <TableHead>章节</TableHead>
                  <TableHead>任务点</TableHead>
                  <TableHead>类型 / 要求</TableHead>
                  <TableHead>开放状态</TableHead>
                  <TableHead className="min-w-64">班级推进（已完成 / 进行中 / 未开始）</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredActivities.map((a) => {
                  const inProg =
                    a.in_progress ??
                    Object.values(a.results).filter((r) => !r.completed).length;
                  const notStarted = Math.max(0, totalStudents - a.completed - inProg);
                  const donePct = pct(a.completed, totalStudents);
                  const scores =
                    a.kind === "assessment"
                      ? Object.values(a.results)
                          .map((r) => r.score)
                          .filter((s): s is number => s != null)
                      : [];
                  const avgScore =
                    scores.length > 0
                      ? Math.round((scores.reduce((x, y) => x + y, 0) / scores.length) * 10) / 10
                      : null;
                  const appendedUsers = Object.values(a.results).filter(
                    (r) => (r.appended ?? 0) > 0,
                  ).length;

                  return (
                    <TableRow key={a.id}>
                      <TableCell className="text-muted-foreground">{a.chapter}</TableCell>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => openTaskDrawer(a.id)}
                          className="inline-flex items-center gap-2 text-left font-medium text-foreground underline-offset-4 hover:underline"
                        >
                          <KindIcon kind={a.kind} />
                          <span>{a.title}</span>
                        </button>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="secondary">{taskKindLabels[a.kind] ?? a.kind}</Badge>
                          <Badge variant={a.required ? "outline" : "ghost"}>
                            {a.required ? "必做" : "选做"}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell>
                        {a.opened ? (
                          <Badge variant="outline" className="gap-1">
                            <Unlock className="size-3 text-(--chart-4)" aria-hidden="true" />
                            已开放
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1 text-muted-foreground">
                            <Lock className="size-3" aria-hidden="true" />
                            尚未开放
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1.5">
                          <div className="flex items-baseline justify-between gap-2 text-xs">
                            <span className="font-mono font-medium tabular-nums text-foreground">
                              {a.completed} / {totalStudents} 人完成（{donePct}%）
                            </span>
                            <span className="text-muted-foreground">
                              {inProg > 0 ? `进行中 ${inProg}` : `未开始 ${notStarted}`}
                              {avgScore !== null ? ` · 均分 ${avgScore}` : ""}
                              {appendedUsers > 0 ? ` · 补题 ${appendedUsers} 人` : ""}
                            </span>
                          </div>
                          <SegmentedProgress
                            total={totalStudents}
                            aria-label={`${a.title}完成分布`}
                            segments={[
                              { key: "done", label: "已完成", value: a.completed, colorClassName: "bg-(--chart-4)" },
                              { key: "doing", label: "进行中", value: inProg, colorClassName: "bg-(--chart-1)" },
                            ]}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openTaskDrawer(a.id)}
                        >
                          <Eye />
                          查看学生
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </ManagementTable>
          </div>
        )
      ) : filteredActivities.length === 0 || matrixStudents.length === 0 ? (
        <ListEmpty
          title={!d.students.length ? "本班暂无在籍学生" : "未找到匹配的学生或任务点"}
          filtered={isFiltered}
          reset={resetFilters}
        />
      ) : (
        <div className="surface overflow-x-auto">
          <ManagementTable
            paginate
            columnTools={false}
            key={`matrix:${query}:${chapterFilter}:${kindFilter}:${reqFilter}:${openFilter}:${studentScope}`}
          >
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-44">学生</TableHead>
                <TableHead className="min-w-36">开放必做完成</TableHead>
                {filteredActivities.map((a) => (
                  <TableHead key={a.id} className="min-w-32">
                    <button
                      type="button"
                      onClick={() => openTaskDrawer(a.id)}
                      className="text-left hover:underline"
                    >
                      <span className="block text-[11px] font-normal text-muted-foreground">
                        {a.chapter}
                      </span>
                      <span className="line-clamp-1 font-medium text-foreground">
                        {a.title}
                      </span>
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {matrixStudents.map((s) => {
                const doneCount = openRequiredTasks.filter((a) =>
                  Boolean(a.results[s.id]?.completed),
                ).length;
                const donePct = pct(doneCount, openRequiredTasks.length);
                return (
                  <TableRow key={s.id}>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => setLearnerId(s.id)}
                        className="text-left font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        <span>{s.name}</span>
                        <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">
                          {s.student_id}
                        </span>
                      </button>
                    </TableCell>
                    <TableCell>
                      {openRequiredTasks.length > 0 ? (
                        <div className="space-y-1">
                          <span className="font-mono text-xs tabular-nums">
                            {doneCount} / {openRequiredTasks.length}（{donePct}%）
                          </span>
                          <Progress value={donePct} indicatorClassName="bg-(--chart-4)" />
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    {filteredActivities.map((a) => (
                      <TableCell key={a.id}>
                        <button
                          type="button"
                          onClick={() => openTaskDrawer(a.id)}
                          className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {matrixCellBadge(a, a.results[s.id])}
                        </button>
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </ManagementTable>
        </div>
      )}

      <Sheet
        open={Boolean(selectedActivity)}
        onOpenChange={(open) => {
          if (!open) setSelectedActivityId("");
        }}
      >
        <SheetContent className="sm:max-w-2xl">
          {selectedActivity && (
            <>
              <SheetHeader>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary">
                    {taskKindLabels[selectedActivity.kind] ?? selectedActivity.kind}
                  </Badge>
                  <Badge variant="outline">
                    {selectedActivity.required ? "必做" : "选做"}
                  </Badge>
                  <Badge variant={selectedActivity.opened ? "outline" : "secondary"}>
                    {selectedActivity.opened ? "已开放" : "尚未开放"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {selectedActivity.chapter}
                  </span>
                </div>
                <SheetTitle>{selectedActivity.title}</SheetTitle>
                <SheetDescription>
                  已完成 {selectedActivity.completed} 人 · 进行中 {selectedInProgress} 人 · 未开始{" "}
                  {selectedNotStarted} 人（全班共 {totalStudents} 人）
                </SheetDescription>
              </SheetHeader>

              <div className="flex flex-col gap-3 border-b bg-muted/20 px-5 py-3">
                <SegmentedProgress
                  total={totalStudents}
                  aria-label="任务点学生状态分布"
                  segments={[
                    {
                      key: "done",
                      label: "已完成",
                      value: selectedActivity.completed,
                      colorClassName: "bg-(--chart-4)",
                    },
                    {
                      key: "doing",
                      label: "进行中",
                      value: selectedInProgress,
                      colorClassName: "bg-(--chart-1)",
                    },
                  ]}
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Tabs
                    value={drawerTab}
                    onValueChange={(v) =>
                      setDrawerTab(
                        v as "all" | "incomplete" | "in_progress" | "completed",
                      )
                    }
                  >
                    <TabsList aria-label="按完成状态筛选学生">
                      <TabsTrigger value="all">全部 ({totalStudents})</TabsTrigger>
                      <TabsTrigger value="incomplete">
                        未完成 ({selectedInProgress + selectedNotStarted})
                      </TabsTrigger>
                      <TabsTrigger value="in_progress">
                        进行中 ({selectedInProgress})
                      </TabsTrigger>
                      <TabsTrigger value="completed">
                        已完成 ({selectedActivity.completed})
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <TableSearch
                    label="在任务中搜索学生"
                    placeholder="搜索姓名或学号"
                    value={drawerQuery}
                    onValueChange={setDrawerQuery}
                  />
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-3">
                {drawerStudents.length === 0 ? (
                  <div className="py-12 text-center text-sm text-muted-foreground">
                    当前筛选条件下没有学生记录。
                  </div>
                ) : (
                  <PaginatedRows rows={drawerStudents}>
                    {(visible) => (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>学生</TableHead>
                            <TableHead>状态</TableHead>
                            <TableHead>学习证据明细</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {visible.map((s) => {
                            const res = selectedActivity.results[s.id];
                            const state = studentTaskState(res);
                            return (
                              <TableRow key={s.id}>
                                <TableCell>
                                  <button
                                    type="button"
                                    onClick={() => setLearnerId(s.id)}
                                    className="text-left font-medium text-foreground underline-offset-4 hover:underline"
                                  >
                                    <span>{s.name}</span>
                                    <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">
                                      {s.student_id}
                                    </span>
                                  </button>
                                </TableCell>
                                <TableCell>
                                  {state === "completed" ? (
                                    <Badge
                                      variant="outline"
                                      className="gap-1 border-(--chart-4)/40 text-(--chart-4)"
                                    >
                                      <CheckCircle2 className="size-3" aria-hidden="true" />
                                      已完成
                                    </Badge>
                                  ) : state === "in_progress" ? (
                                    <Badge variant="secondary">进行中</Badge>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">未开始</span>
                                  )}
                                </TableCell>
                                <TableCell className="space-y-1">
                                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                    <span className="font-medium">
                                      {activityProgressSummary(res)}
                                    </span>
                                    {res?.appended ? (
                                      <Badge variant="outline" className="text-[11px]">
                                        含错题补题 +{res.appended}
                                      </Badge>
                                    ) : null}
                                    {res?.correct_count !== undefined && res.total ? (
                                      <span className="text-muted-foreground">
                                        （答对 {res.correct_count}/{res.total} 题）
                                      </span>
                                    ) : null}
                                  </div>
                                  {res?.resources?.map((r) => (
                                    <div
                                      className="space-y-1 text-xs text-muted-foreground"
                                      key={r.material_id}
                                    >
                                      {r.read_total > 0 && (
                                        <div className="flex items-center gap-2">
                                          <Progress
                                            value={pct(r.read_count, r.read_total)}
                                            className="max-w-28"
                                          />
                                          <span className="font-mono tabular-nums">
                                            已读 {r.read_count} / {r.read_total} 页
                                          </span>
                                        </div>
                                      )}
                                      {(r.required_seconds > 0 || r.video) && (
                                        <p>
                                          {r.video ? "有效观看" : "有效阅读"}{" "}
                                          {formatSeconds(r.seconds)}
                                          {r.required_seconds > 0 &&
                                            ` / 要求 ${formatSeconds(r.required_seconds)}`}
                                        </p>
                                      )}
                                    </div>
                                  ))}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    )}
                  </PaginatedRows>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {learnerId !== null && (
        <StudentRecordSheet
          classroomId={classroomId}
          studentId={learnerId}
          history={d.students.some((s) => s.id === learnerId && !s.enrolled)}
          onClose={() => setLearnerId(null)}
        />
      )}
    </div>
  );
}
