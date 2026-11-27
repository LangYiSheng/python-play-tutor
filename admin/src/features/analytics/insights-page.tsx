import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Bot,
  CheckCircle2,
  ClipboardCheck,
  Flame,
  Info,
  MessageSquareText,
  RefreshCw,
  School,
  Users,
} from "lucide-react";
import { ErrorNotice, Loading, PageHeader } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { GroupedBarChart, type ChartConfig } from "@/components/ui/chart";
import { Progress, SegmentedProgress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useResource } from "@/lib/use-resource";
import { pct, questionLabel, type InsightsOverview } from "./types";

const stageChartConfig: ChartConfig = {
  reading: { label: "必读资料", color: "var(--chart-1)" },
  objective: { label: "客观练习", color: "var(--chart-2)" },
  programming: { label: "编程练习", color: "var(--chart-3)" },
  assessment: { label: "单元测验", color: "var(--chart-4)" },
};

export function InsightsPage({
  courseId,
  onOpenClassAnalytics,
}: {
  courseId: number;
  onOpenClassAnalytics?: (classroomId: number, target: "details" | "grades") => void;
}) {
  const report = useResource<InsightsOverview>(`/teacher/courses/${courseId}/insights`);
  const d = report.data;
  if (!d) return report.loading ? <Loading /> : <ErrorNotice message={report.error} />;

  const totalClassrooms = d.totals.classrooms ?? 0;
  const totalStudents = d.totals.students ?? 0;
  const activeStudents = d.active_students ?? 0;
  const coveragePct = pct(activeStudents, totalStudents);

  const reqCompleted = d.completion?.required_completed ?? 0;
  const reqTotal = d.completion?.required_total ?? 0;
  const reqPct = pct(reqCompleted, reqTotal);
  const byStage = d.completion?.by_stage ?? {};

  const exam = d.assessment_summary;
  const examSubmitted = exam?.submitted ?? 0;
  const examExpected = exam?.expected ?? 0;
  const examSubmitPct = pct(examSubmitted, examExpected);
  const examPassPct = exam && exam.graded > 0 ? pct(exam.pass_count, exam.graded) : null;

  const learningSessions = d.assistant.learning.sessions;
  const practiceSessions = d.assistant.practice.sessions;
  const totalSessions = learningSessions + practiceSessions;
  const learningMessages = d.assistant.learning.messages;
  const practiceMessages = d.assistant.practice.messages;
  const totalMessages = learningMessages + practiceMessages;

  const chapters = d.chapters ?? [];
  const openChapters = chapters.filter((ch) => ch.open_classrooms > 0);
  const classrooms = d.classrooms ?? [];
  const difficultQuestions = d.difficult_questions ?? [];
  const assistantHotspots = d.assistant_hotspots ?? [];

  const scaleItems = [
    { label: "在教班级", value: totalClassrooms },
    { label: "在籍学生", value: totalStudents },
    ...(d.totals.chapters !== undefined ? [{ label: "章节", value: d.totals.chapters }] : []),
    { label: "资料", value: d.totals.materials ?? 0 },
    { label: "知识点", value: d.totals.points ?? 0 },
    { label: "题目", value: d.totals.questions ?? 0 },
  ];

  const funnelRows = openChapters.map((ch) => ({
    id: ch.id,
    label: ch.title,
    sublabel: `覆盖 ${ch.target_students} 名学生`,
    badge: `已开放 ${ch.open_classrooms}/${totalClassrooms} 班`,
    cells: (["reading", "objective", "programming", "assessment"] as const).map((key) => {
      const s = ch.stages[key];
      if (!s || s.task_count === 0) {
        return {
          key,
          value: null,
          mutedLabel: "未设",
          detail: "本章未设置该类型的必做任务",
        };
      }
      if (s.total === 0) {
        return {
          key,
          value: 0,
          detail: `共 ${s.task_count} 项任务，当前已开放班级暂无在籍学生`,
        };
      }
      const rate = (s.completed / s.total) * 100;
      return {
        key,
        value: rate,
        detail: `${s.task_count} 项任务 · 已完成 ${s.completed} / ${s.total} 人次（${Math.round(rate)}%）`,
      };
    }),
  }));

  return (
    <div className="space-y-5">
      <PageHeader title={d.name} description={`负责教师 · ${d.teacher}`}>
        <div className="flex flex-wrap items-center gap-1.5">
          {scaleItems.map((item) => (
            <Badge key={item.label} variant="secondary" className="gap-1 px-2.5 py-1 font-normal">
              <span className="text-muted-foreground">{item.label}</span>
              <span className="font-mono font-semibold tabular-nums text-foreground">
                {item.value}
              </span>
            </Badge>
          ))}
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

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <Users className="size-4 text-muted-foreground" aria-hidden="true" />
              活跃学生覆盖率
            </CardDescription>
            <CardAction>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="参与人次统计口径"
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    />
                  }
                >
                  <Info className="size-3.5" aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent>
                  在教班正式学生中已产生阅读、练习或测验记录的人数占比；下方人次按同一学生在本班参与同一活动计一次。
                </TooltipContent>
              </Tooltip>
            </CardAction>
            <CardTitle className="flex items-baseline gap-2 font-sans text-2xl font-semibold tabular-nums">
              <span>{totalStudents > 0 ? `${coveragePct}%` : "—"}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {activeStudents} / {totalStudents} 人已学习
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <Progress value={coveragePct} aria-label="活跃学生覆盖率" />
            <div className="grid grid-cols-3 gap-2 pt-0.5 text-xs">
              <div className="rounded-md bg-muted/50 px-2 py-1">
                <span className="text-muted-foreground">学习 </span>
                <span className="font-mono font-medium tabular-nums">{d.usage.learning ?? 0}</span>
              </div>
              <div className="rounded-md bg-muted/50 px-2 py-1">
                <span className="text-muted-foreground">练习 </span>
                <span className="font-mono font-medium tabular-nums">{d.usage.practice ?? 0}</span>
              </div>
              <div className="rounded-md bg-muted/50 px-2 py-1">
                <span className="text-muted-foreground">测验 </span>
                <span className="font-mono font-medium tabular-nums">{d.usage.assessment ?? 0}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <CheckCircle2 className="size-4 text-muted-foreground" aria-hidden="true" />
              开放必做总完成率
            </CardDescription>
            <CardAction>
              <Badge variant="outline" className="font-normal">
                {d.completion?.open_classroom_count
                  ? `${d.completion.open_classroom_count} 班已开课`
                  : "待开放章节"}
              </Badge>
            </CardAction>
            <CardTitle className="flex items-baseline gap-2 font-sans text-2xl font-semibold tabular-nums">
              <span>{reqTotal > 0 ? `${reqPct}%` : "—"}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {reqTotal > 0 ? `${reqCompleted} / ${reqTotal} 人次` : "暂无开放必做项"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <Progress
              value={reqPct}
              indicatorClassName="bg-(--chart-4)"
              aria-label="开放必做总完成率"
            />
            <div className="flex flex-wrap justify-between gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>
                必读{" "}
                <strong className="font-mono font-medium text-foreground">
                  {byStage.reading?.total ? `${pct(byStage.reading.completed, byStage.reading.total)}%` : "—"}
                </strong>
              </span>
              <span>
                客观{" "}
                <strong className="font-mono font-medium text-foreground">
                  {byStage.objective?.total ? `${pct(byStage.objective.completed, byStage.objective.total)}%` : "—"}
                </strong>
              </span>
              <span>
                编程{" "}
                <strong className="font-mono font-medium text-foreground">
                  {byStage.programming?.total ? `${pct(byStage.programming.completed, byStage.programming.total)}%` : "—"}
                </strong>
              </span>
              <span>
                测验{" "}
                <strong className="font-mono font-medium text-foreground">
                  {byStage.assessment?.total ? `${pct(byStage.assessment.completed, byStage.assessment.total)}%` : "—"}
                </strong>
              </span>
            </div>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <ClipboardCheck className="size-4 text-muted-foreground" aria-hidden="true" />
              课程测验表现
            </CardDescription>
            <CardAction>
              {exam && exam.attention > 0 ? (
                <Badge variant="destructive">评测异常 {exam.attention}</Badge>
              ) : exam && exam.grading > 0 ? (
                <Badge variant="secondary">待判定 {exam.grading}</Badge>
              ) : examPassPct !== null ? (
                <Badge variant="outline">及格率 {examPassPct}%</Badge>
              ) : null}
            </CardAction>
            <CardTitle className="flex items-baseline gap-2 font-sans text-2xl font-semibold tabular-nums">
              <span>
                {exam?.average_score != null ? `${exam.average_score} 分` : "—"}
              </span>
              <span className="text-xs font-normal text-muted-foreground">
                已出分均分
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <Progress
              value={examSubmitPct}
              indicatorClassName="bg-(--chart-1)"
              aria-label="测验交卷率"
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>交卷进度</span>
              <span className="font-mono text-foreground tabular-nums">
                {examExpected > 0
                  ? `${examSubmitted} / ${examExpected} 份（${examSubmitPct}%）`
                  : "尚无已开放测验"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription className="flex items-center gap-1.5">
              <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
              AI 助教答疑活跃度
            </CardDescription>
            <CardAction>
              <Badge variant="outline" className="font-normal">
                {d.assistant_students ?? 0} 人提问
              </Badge>
            </CardAction>
            <CardTitle className="flex items-baseline gap-2 font-sans text-2xl font-semibold tabular-nums">
              <span>{totalMessages}</span>
              <span className="text-xs font-normal text-muted-foreground">
                条对话消息 · {totalSessions} 次会话
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <SegmentedProgress
              total={Math.max(1, totalMessages)}
              aria-label="助教消息场景占比"
              segments={[
                {
                  key: "learning",
                  label: "学习答疑",
                  value: learningMessages,
                  colorClassName: "bg-(--chart-1)",
                },
                {
                  key: "practice",
                  label: "练习辅导",
                  value: practiceMessages,
                  colorClassName: "bg-(--chart-3)",
                },
              ]}
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                学习答疑 <strong className="font-mono font-medium text-foreground">{learningMessages}</strong>（{learningSessions} 会话）
              </span>
              <span>
                练习辅导 <strong className="font-mono font-medium text-foreground">{practiceMessages}</strong>（{practiceSessions} 会话）
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="lg:col-span-7">
          <CardHeader className="border-b">
            <CardTitle>章节推进总览</CardTitle>
            <CardDescription>
              按课程顺序展示已开放章节的「必读资料 → 客观练习 → 编程练习 → 单元测验」必做完成率，快速定位教学卡点。
            </CardDescription>
            {chapters.length > 0 && (
              <CardAction>
                <Badge variant="outline" className="font-normal">
                  已开放 {openChapters.length} / {chapters.length} 章
                </Badge>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="pt-1">
            {chapters.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                课程尚未创建章节，可在「章节与课件」编排教学内容。
              </div>
            ) : openChapters.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                当前在教班级尚未开放任何章节，可在「定时开放」或「学习任务」开放章节后查看推进情况。
              </div>
            ) : (
              <GroupedBarChart config={stageChartConfig} rows={funnelRows} />
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-5">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <School className="size-4 text-muted-foreground" aria-hidden="true" />
              在教班级横向对比
            </CardTitle>
            <CardDescription>
              对比各在教班的活跃度、必做任务进度与测验均分，支持直达单班明细或成绩册。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-1">
            {classrooms.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                当前暂无在教班级，可在「班级管理」创建教学班并导入名册。
              </div>
            ) : (
              classrooms.map((room) => {
                const roomReqPct = pct(room.required_completed, room.required_total);
                const roomActivePct = pct(room.active_students, room.student_count);
                return (
                  <div
                    key={room.id}
                    className="rounded-lg border border-border/80 bg-muted/15 p-3.5 transition-colors hover:bg-muted/30"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-sans font-semibold text-foreground">{room.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          在籍 <span className="font-mono text-foreground">{room.student_count}</span> 人 · 活跃{" "}
                          <span className="font-mono text-foreground">{room.active_students}</span> 人（{roomActivePct}%） · 开放{" "}
                          <span className="font-mono text-foreground">
                            {room.open_chapters}/{room.total_chapters}
                          </span>{" "}
                          章
                        </p>
                      </div>
                      {onOpenClassAnalytics && (
                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => onOpenClassAnalytics(room.id, "details")}
                          >
                            任务明细
                            <ArrowUpRight data-icon="inline-end" />
                          </Button>
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => onOpenClassAnalytics(room.id, "grades")}
                          >
                            成绩册
                            <ArrowUpRight data-icon="inline-end" />
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="mt-3 space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">开放必做完成率</span>
                        <span className="font-mono font-medium tabular-nums">
                          {room.required_total > 0
                            ? `${roomReqPct}%（${room.required_completed}/${room.required_total}）`
                            : "暂未开放必做任务"}
                        </span>
                      </div>
                      <Progress value={roomReqPct} aria-label={`${room.name}必做完成率`} />
                    </div>
                    <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        测验均分{" "}
                        <strong className="font-mono font-medium text-foreground">
                          {room.average_score != null ? `${room.average_score} 分` : "—"}
                        </strong>
                      </span>
                      <span>
                        交卷{" "}
                        <strong className="font-mono font-medium text-foreground">
                          {room.assessment_expected > 0
                            ? `${room.assessment_submitted}/${room.assessment_expected}`
                            : "—"}
                        </strong>
                      </span>
                      <span>
                        助教消息{" "}
                        <strong className="font-mono font-medium text-foreground">
                          {room.assistant_messages}
                        </strong>
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-(--chart-5)" aria-hidden="true" />
              高频卡点题目 Top {Math.max(difficultQuestions.length, 8)}
            </CardTitle>
            <CardDescription>
              汇总全课正式作答中错误提交次数最多或触发练习补题最多的题目，便于课堂集中讲评。
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-1">
            {difficultQuestions.length === 0 ? (
              <div className="rounded-lg border border-dashed py-9 text-center text-sm text-muted-foreground">
                暂无错题或补题记录。学生在练习或测验中正式提交答案后，将自动汇总易错题目。
              </div>
            ) : (
              <ul className="divide-y">
                {difficultQuestions.map((q, idx) => {
                  const passRate = pct(q.accepted_learners, q.learners);
                  return (
                    <li key={q.question_id} className="flex items-start justify-between gap-3 py-2.5 first:pt-1 last:pb-1">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-muted font-mono text-xs font-medium text-muted-foreground">
                            {idx + 1}
                          </span>
                          <span className="font-medium text-foreground">{q.title}</span>
                          <Badge variant="secondary">{questionLabel(q.kind)}</Badge>
                          {q.chapter_title && (
                            <span className="text-xs text-muted-foreground">{q.chapter_title}</span>
                          )}
                        </div>
                        <p className="pl-6 text-xs text-muted-foreground">
                          作答 {q.learners} 人（通过率 {passRate}%） · 共 {q.attempts} 次提交
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1 text-right">
                        <Badge variant="outline" className="border-destructive/30 text-destructive">
                          未通过 {q.failed_attempts} 次
                        </Badge>
                        {q.appended_count > 0 && (
                          <span className="text-[11px] text-muted-foreground">
                            关联补题 {q.appended_count} 人次
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <Flame className="size-4 text-(--chart-3)" aria-hidden="true" />
              AI 助教高频提问源 Top {Math.max(assistantHotspots.length, 8)}
            </CardTitle>
            <CardDescription>
              定位学生向图书管理员或练习助教提问最密集的课件资料与练习活动。
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-1">
            {assistantHotspots.length === 0 ? (
              <div className="rounded-lg border border-dashed py-9 text-center text-sm text-muted-foreground">
                暂无学生助教提问记录。学生在阅读课件或做练习时主动提问后，将在此展示提问热点。
              </div>
            ) : (
              <ul className="divide-y">
                {assistantHotspots.map((spot, idx) => (
                  <li key={spot.key} className="flex items-start justify-between gap-3 py-2.5 first:pt-1 last:pb-1">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-muted font-mono text-xs font-medium text-muted-foreground">
                          {idx + 1}
                        </span>
                        <span className="font-medium text-foreground">{spot.title}</span>
                        <Badge variant="outline">
                          {spot.kind === "material" ? (
                            <>
                              <BookOpen data-icon="inline-start" />
                              课件答疑
                            </>
                          ) : (
                            <>
                              <MessageSquareText data-icon="inline-start" />
                              练习辅导
                            </>
                          )}
                        </Badge>
                      </div>
                      <p className="pl-6 text-xs text-muted-foreground">
                        {spot.chapter_title ? `${spot.chapter_title} · ` : ""}
                        覆盖 {spot.learners} 名学生 · {spot.sessions} 次有效会话
                      </p>
                    </div>
                    <Badge variant="secondary" className="shrink-0 font-mono tabular-nums">
                      {spot.messages} 条消息
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
          <CardFooter className="text-xs text-muted-foreground">
            仅统计学生主动发送过问题的会话；走路、剧情与翻页不调用模型且不计入统计。
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
