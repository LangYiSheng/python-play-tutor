import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Download,
  RefreshCw,
} from "lucide-react";
import {
  ErrorNotice,
  ListEmpty,
  Loading,
  PageHeader,
  TableSearch,
} from "@/components/common";
import { ManagementTable } from "@/components/management-table";
import { SelectField } from "@/components/select-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DistributionBarChart, type DistributionBin } from "@/components/ui/chart";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useResource } from "@/lib/use-resource";
import { StudentRecordSheet } from "./student-record-sheet";
import {
  gradeLabel,
  pct,
  type ActivityStudentResult,
  type ClassroomActivityReport,
  type ReportStudent,
} from "./types";

function medianOf(sortedValues: number[]): number | null {
  if (sortedValues.length === 0) return null;
  const mid = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[mid];
  return Math.round(((sortedValues[mid - 1] + sortedValues[mid]) / 2) * 10) / 10;
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function GradeCellContent({ result }: { result?: ActivityStudentResult }) {
  if (result?.score != null) {
    if (result.score < 60) {
      return (
        <Badge variant="destructive" className="font-mono tabular-nums">
          {result.score}
        </Badge>
      );
    }
    if (result.score >= 90) {
      return (
        <Badge
          variant="outline"
          className="border-(--chart-4)/45 font-mono tabular-nums text-(--chart-4)"
        >
          {result.score}
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="font-mono tabular-nums">
        {result.score}
      </Badge>
    );
  }
  if (result?.assessment_status === "attention") {
    return <Badge variant="destructive">评测异常</Badge>;
  }
  if (result?.assessment_status === "grading") {
    return <Badge variant="secondary">待判定</Badge>;
  }
  return <span className="text-xs text-muted-foreground">未交</span>;
}

export function GradesPage({
  classroomId,
  classroomName,
  onOpenJudge,
}: {
  classroomId: number;
  classroomName?: string;
  onOpenJudge?: () => void;
}) {
  const report = useResource<ClassroomActivityReport>(
    `/teacher/classrooms/${classroomId}/activity-report?grades=true`,
  );
  const [selectedExamId, setSelectedExamId] = useState("all");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [gradeFilter, setGradeFilter] = useState("all");
  const [sortBy, setSortBy] = useState("student_id");
  const [learnerId, setLearnerId] = useState<number | null>(null);

  const d = report.data;

  const studentStats = useMemo(() => {
    const map = new Map<
      number,
      {
        submittedCount: number;
        gradedScores: number[];
        average: number | null;
        hasMissing: boolean;
        hasPendingOrAttention: boolean;
      }
    >();
    if (!d) return map;
    for (const s of d.students) {
      let submittedCount = 0;
      const gradedScores: number[] = [];
      let hasMissing = false;
      let hasPendingOrAttention = false;
      for (const a of d.activities) {
        const res = a.results[s.id];
        if (!res || (!res.assessment_status && res.score == null)) {
          hasMissing = true;
          continue;
        }
        if (res.assessment_status === "draft" && res.score == null) {
          hasMissing = true;
          continue;
        }
        submittedCount += 1;
        if (res.score != null) {
          gradedScores.push(res.score);
        } else if (
          res.assessment_status === "grading" ||
          res.assessment_status === "attention"
        ) {
          hasPendingOrAttention = true;
        }
      }
      const average =
        gradedScores.length > 0
          ? Math.round(
              (gradedScores.reduce((x, y) => x + y, 0) / gradedScores.length) * 10,
            ) / 10
          : null;
      map.set(s.id, {
        submittedCount,
        gradedScores,
        average,
        hasMissing,
        hasPendingOrAttention,
      });
    }
    return map;
  }, [d]);

  if (!d) return report.loading ? <Loading /> : <ErrorNotice message={report.error} />;

  const activeExam =
    selectedExamId === "all"
      ? null
      : (d.activities.find((a) => a.id === selectedExamId) ?? null);

  const enrolledStudents = d.students.filter((s) => s.enrolled);
  const analysisPopulation = enrolledStudents.length > 0 ? enrolledStudents : d.students;

  let submittedPairs = 0;
  let expectedPairs: number;
  let gradingCount = 0;
  let attentionCount = 0;
  const distributionScores: number[] = [];
  let missingStudentsInDist = 0;

  if (activeExam) {
    expectedPairs = analysisPopulation.length;
    for (const s of analysisPopulation) {
      const res = activeExam.results[s.id];
      if (!res || (res.score == null && (!res.assessment_status || res.assessment_status === "draft"))) {
        missingStudentsInDist += 1;
        continue;
      }
      submittedPairs += 1;
      if (res.score != null) {
        distributionScores.push(res.score);
      } else if (res.assessment_status === "grading") {
        gradingCount += 1;
      } else if (res.assessment_status === "attention") {
        attentionCount += 1;
      }
    }
  } else {
    expectedPairs = analysisPopulation.length * d.activities.length;
    for (const s of analysisPopulation) {
      const st = studentStats.get(s.id);
      submittedPairs += st?.submittedCount ?? 0;
      if (st?.average != null) {
        distributionScores.push(st.average);
      } else if (d.activities.length > 0) {
        missingStudentsInDist += 1;
      }
      for (const a of d.activities) {
        const res = a.results[s.id];
        if (res?.assessment_status === "grading") gradingCount += 1;
        if (res?.assessment_status === "attention") attentionCount += 1;
      }
    }
  }

  const sortedDistScores = [...distributionScores].sort((a, b) => a - b);
  const meanScore =
    sortedDistScores.length > 0
      ? Math.round(
          (sortedDistScores.reduce((a, b) => a + b, 0) / sortedDistScores.length) * 10,
        ) / 10
      : null;
  const medianScore = medianOf(sortedDistScores);
  const maxScore = sortedDistScores.length > 0 ? sortedDistScores[sortedDistScores.length - 1] : null;
  const minScore = sortedDistScores.length > 0 ? sortedDistScores[0] : null;
  const passCount = sortedDistScores.filter((v) => v >= 60).length;
  const passRate = sortedDistScores.length > 0 ? pct(passCount, sortedDistScores.length) : null;

  const bins: DistributionBin[] = [
    {
      key: "missing",
      label: "未交",
      count: missingStudentsInDist,
      color: "oklch(0.75 0 0)",
      detail: activeExam ? "尚未提交本场测验" : "尚无已判完测验成绩",
    },
    {
      key: "fail",
      label: "<60",
      count: sortedDistScores.filter((v) => v < 60).length,
      color: "var(--chart-5)",
      detail: "不及格（低于 60 分）",
    },
    {
      key: "pass60",
      label: "60–69",
      count: sortedDistScores.filter((v) => v >= 60 && v < 70).length,
      color: "var(--chart-3)",
      detail: "及格档（60–69 分）",
    },
    {
      key: "good70",
      label: "70–79",
      count: sortedDistScores.filter((v) => v >= 70 && v < 80).length,
      color: "var(--chart-2)",
      detail: "中等档（70–79 分）",
    },
    {
      key: "great80",
      label: "80–89",
      count: sortedDistScores.filter((v) => v >= 80 && v < 90).length,
      color: "var(--chart-1)",
      detail: "良好档（80–89 分）",
    },
    {
      key: "top90",
      label: "90–100",
      count: sortedDistScores.filter((v) => v >= 90).length,
      color: "var(--chart-4)",
      detail: "优秀档（90–100 分）",
    },
  ];

  const needle = query.trim().toLowerCase();
  const filteredStudents = d.students
    .filter((s) => {
      if (needle && !`${s.name} ${s.student_id}`.toLowerCase().includes(needle)) {
        return false;
      }
      if (scope !== "all" && (scope === "active") !== s.enrolled) {
        return false;
      }
      const st = studentStats.get(s.id);
      if (gradeFilter === "missing") return Boolean(st?.hasMissing);
      if (gradeFilter === "below60") return st?.average != null && st.average < 60;
      if (gradeFilter === "attention") return Boolean(st?.hasPendingOrAttention);
      if (gradeFilter === "passed_all") {
        return !st?.hasMissing && st?.average != null && st.average >= 60;
      }
      return true;
    })
    .sort((a: ReportStudent, b: ReportStudent) => {
      const sa = studentStats.get(a.id);
      const sb = studentStats.get(b.id);
      if (sortBy === "avg_desc") {
        return (sb?.average ?? -1) - (sa?.average ?? -1) || a.student_id.localeCompare(b.student_id, "zh-CN", { numeric: true });
      }
      if (sortBy === "avg_asc") {
        return (sa?.average ?? 999) - (sb?.average ?? 999) || a.student_id.localeCompare(b.student_id, "zh-CN", { numeric: true });
      }
      if (sortBy === "submitted_desc") {
        return (sb?.submittedCount ?? 0) - (sa?.submittedCount ?? 0) || a.student_id.localeCompare(b.student_id, "zh-CN", { numeric: true });
      }
      if (sortBy.startsWith("exam:")) {
        const examId = sortBy.slice(5);
        const ex = d.activities.find((item) => item.id === examId);
        const va = ex?.results[a.id]?.score ?? -1;
        const vb = ex?.results[b.id]?.score ?? -1;
        return vb - va || a.student_id.localeCompare(b.student_id, "zh-CN", { numeric: true });
      }
      return a.student_id.localeCompare(b.student_id, "zh-CN", { numeric: true });
    });

  const isFiltered = Boolean(needle) || scope !== "all" || gradeFilter !== "all";

  function resetFilters() {
    setQuery("");
    setScope("all");
    setGradeFilter("all");
  }

  function exportCsv() {
    if (!d) return;
    const headers = [
      "学号",
      "姓名",
      "在班状态",
      "已交测验",
      "应交测验",
      "已判平均分",
      ...d.activities.map((a) => `${a.chapter} · ${a.title}`),
    ];
    const lines = [headers.map(escapeCsvCell).join(",")];
    for (const s of filteredStudents) {
      const st = studentStats.get(s.id);
      const row = [
        `\t${s.student_id}`,
        s.name,
        s.enrolled ? "在班" : "已离班",
        String(st?.submittedCount ?? 0),
        String(d.activities.length),
        st?.average != null ? String(st.average) : "",
        ...d.activities.map((a) => gradeLabel(a.results[s.id])),
      ];
      lines.push(row.map(escapeCsvCell).join(","));
    }
    const blob = new Blob([`\uFEFF${lines.join("\r\n")}`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const safeClass = (classroomName ?? `class-${classroomId}`).replace(/[\\/:*?"<>|]/g, "-");
    link.href = url;
    link.download = `成绩单-${safeClass}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="学生成绩"
        description="汇总本班单元测验交卷情况、分数段分布与学生个人成绩档案。"
      >
        <div className="flex flex-wrap items-center gap-2">
          {d.activities.length > 0 && filteredStudents.length > 0 && (
            <Button variant="outline" size="sm" onClick={exportCsv}>
              <Download />
              导出 CSV 成绩单
            </Button>
          )}
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

      {d.activities.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-12">
          <Card className="lg:col-span-5">
            <CardHeader className="border-b">
              <CardTitle>测验成绩统计</CardTitle>
              <CardDescription>
                按在班正式学生统计；未交与待判定试卷不按 0 分混入已判平均分。
              </CardDescription>
              {d.activities.length > 1 && (
                <CardAction>
                  <SelectField
                    aria-label="选择统计测验"
                    value={selectedExamId}
                    onValueChange={setSelectedExamId}
                  >
                    <option value="all">全部测验（个人均分）</option>
                    {d.activities.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.chapter} · {a.title}
                      </option>
                    ))}
                  </SelectField>
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="space-y-3 pt-1">
              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">交卷进度</p>
                  <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
                    {expectedPairs > 0
                      ? `${pct(submittedPairs, expectedPairs)}%`
                      : "—"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {submittedPairs} / {expectedPairs} 份已交
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">已判平均分</p>
                  <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
                    {meanScore !== null ? `${meanScore} 分` : "—"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    共 {sortedDistScores.length} 人已有有效成绩
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">中位数 / 极值</p>
                  <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
                    {medianScore !== null ? `${medianScore} 分` : "—"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {maxScore !== null && minScore !== null
                      ? `最高 ${maxScore} · 最低 ${minScore}`
                      : "暂无极值"}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">及格率（≥60）</p>
                  <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
                    {passRate !== null ? `${passRate}%` : "—"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {sortedDistScores.length > 0
                      ? `及格 ${passCount} / ${sortedDistScores.length} 人`
                      : "等待出分"}
                  </p>
                </div>
              </div>

              {(gradingCount > 0 || attentionCount > 0) && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <AlertTriangle
                      className="size-3.5 text-(--chart-5)"
                      aria-hidden="true"
                    />
                    <span>
                      {attentionCount > 0 ? `评测异常 ${attentionCount} 份` : ""}
                      {attentionCount > 0 && gradingCount > 0 ? " · " : ""}
                      {gradingCount > 0 ? `待判定 ${gradingCount} 份` : ""}
                    </span>
                  </span>
                  {onOpenJudge && (
                    <Button variant="outline" size="xs" onClick={onOpenJudge}>
                      前往评测管理
                      <ArrowUpRight data-icon="inline-end" />
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-7">
            <CardHeader className="border-b">
              <CardTitle>
                {activeExam
                  ? `${activeExam.chapter} · ${activeExam.title} 分数段分布`
                  : "全班个人测验均分分布"}
              </CardTitle>
              <CardDescription>
                直观查看未交人数与各分数段人数聚集情况（悬浮柱体查看比例）。
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-1">
              <DistributionBarChart
                bins={bins}
                total={analysisPopulation.length}
              />
            </CardContent>
          </Card>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <TableSearch
          label="搜索学生姓名或学号"
          placeholder="搜索学号或姓名"
          value={query}
          onValueChange={setQuery}
        />
        <SelectField
          aria-label="在班状态"
          value={scope}
          onValueChange={setScope}
        >
          <option value="all">全部状态</option>
          <option value="active">在班</option>
          <option value="inactive">已离班</option>
        </SelectField>
        {d.activities.length > 0 && (
          <>
            <SelectField
              aria-label="成绩状态筛选"
              value={gradeFilter}
              onValueChange={setGradeFilter}
            >
              <option value="all">全部成绩状态</option>
              <option value="missing">有未交测验</option>
              <option value="below60">均分低于 60 分</option>
              <option value="attention">含待判定或异常</option>
              <option value="passed_all">全部已交且及格</option>
            </SelectField>
            <SelectField
              aria-label="成绩排序"
              value={sortBy}
              onValueChange={setSortBy}
            >
              <option value="student_id">按学号升序</option>
              <option value="avg_desc">按个人均分从高到低</option>
              <option value="avg_asc">按个人均分从低到高</option>
              <option value="submitted_desc">按已交场次从多到少</option>
              {d.activities.map((a) => (
                <option key={a.id} value={`exam:${a.id}`}>
                  按「{a.title}」从高到低
                </option>
              ))}
            </SelectField>
          </>
        )}
        <span id="report-columns" className="ml-auto" />
      </div>

      {!d.activities.length || !filteredStudents.length ? (
        <div className="surface">
          <ListEmpty
            title={!d.activities.length ? "课程暂无测验" : "暂无学生成绩"}
            filtered={isFiltered}
            reset={resetFilters}
          />
        </div>
      ) : (
        <div className="surface overflow-x-auto">
          <ManagementTable
            paginate
            toolsId="report-columns"
            key={`${query}:${scope}:${gradeFilter}:${sortBy}`}
          >
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-44">学生</TableHead>
                <TableHead>已交 / 应交</TableHead>
                <TableHead>个人均分</TableHead>
                {d.activities.map((a) => (
                  <TableHead key={a.id} className="min-w-28">
                    {a.chapter} · {a.title}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredStudents.map((s) => {
                const st = studentStats.get(s.id);
                return (
                  <TableRow key={s.id}>
                    <TableCell>
                      <Button
                        variant="link"
                        className="h-auto p-0 text-left"
                        onClick={() => setLearnerId(s.id)}
                      >
                        {s.name} · {s.student_id}
                        {!s.enrolled && "（已离班）"}
                      </Button>
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                      {st?.submittedCount ?? 0} / {d.activities.length}
                    </TableCell>
                    <TableCell className="font-mono text-xs font-medium tabular-nums">
                      {st?.average != null ? (
                        <span
                          className={
                            st.average < 60 ? "text-destructive" : "text-foreground"
                          }
                        >
                          {st.average} 分
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    {d.activities.map((a) => (
                      <TableCell key={a.id}>
                        <GradeCellContent result={a.results[s.id]} />
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </ManagementTable>
        </div>
      )}

      {learnerId !== null && (
        <StudentRecordSheet
          showGrades
          history={d.students.some((s) => s.id === learnerId && !s.enrolled)}
          classroomId={classroomId}
          studentId={learnerId}
          onClose={() => setLearnerId(null)}
        />
      )}
    </div>
  );
}
