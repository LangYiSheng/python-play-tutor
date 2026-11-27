import type { ReactNode } from "react";
import {
  BookOpen,
  CalendarDays,
  CheckCircle2,
  Circle,
  ClipboardList,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileQuestionMark,
  LoaderCircle,
  Network,
  NotebookPen,
  Plus,
  RefreshCw,
  School,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { ErrorNotice, Loading, PageHeader } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import { downloadRosterTemplate } from "@/lib/roster-template";
import { useResource } from "@/lib/use-resource";

export interface OnboardingClassroom {
  id: number;
  name: string;
  join_code: string;
  student_count: number;
}

export interface OnboardingSummary {
  classrooms: OnboardingClassroom[];
  student_count: number;
  chapter_count: number;
  material_count: number;
  ready_material_count: number;
  narratable_material_count: number;
  narration_accepted_pages: number;
  narration_draft_pages: number;
  audio_ready_pages: number;
  knowledge_point_count: number;
  ready_question_count: number;
  draft_question_count: number;
  published_practice_count: number;
  published_assessment_count: number;
  required_reading_count: number;
  open_chapter_count: number;
  scheduled_chapter_count: number;
}

export type GuideTarget =
  | "classes"
  | "courseware"
  | "content-graph"
  | "assessments"
  | "activities"
  | "teaching";

type StepState = "done" | "in_progress" | "todo";

interface GuideStep {
  title: string;
  description: string;
  icon: LucideIcon;
  state: StepState;
  summary: ReactNode;
  actions: ReactNode;
}

async function copyJoinCode(code: string) {
  try {
    await navigator.clipboard.writeText(code);
    toast.add({ title: "班级加入码已复制", type: "success" });
  } catch {
    toast.add({ title: "复制失败，请选中加入码手动复制", type: "error" });
  }
}

function StepBadge({ state }: { state: StepState }) {
  if (state === "done") {
    return (
      <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800">
        <CheckCircle2 className="size-3.5" aria-hidden="true" />
        已完成
      </Badge>
    );
  }
  if (state === "in_progress") {
    return (
      <Badge variant="secondary" className="bg-amber-50 text-amber-800">
        <Clock3 className="size-3.5" aria-hidden="true" />
        进行中
      </Badge>
    );
  }
  return (
    <Badge variant="secondary">
      <Circle className="size-3.5" aria-hidden="true" />
      待完成
    </Badge>
  );
}

export function CourseGuide({
  courseId,
  classroomId,
  revision = 0,
  openingTown,
  onEnterTown,
  onCreateClass,
  onOpenStudents,
  onOpenReview,
  pageHref,
  onNavigate,
}: {
  courseId: number;
  classroomId: number | null;
  revision?: number;
  openingTown: boolean;
  onEnterTown: (classroomId: number) => void;
  onCreateClass: () => void;
  onOpenStudents: (classroomId: number) => void;
  onOpenReview: () => void;
  pageHref: (target: GuideTarget, extra?: Record<string, string>) => string;
  onNavigate: (target: GuideTarget, extra?: Record<string, string>) => void;
}) {
  const summary = useResource<OnboardingSummary>(`/teacher/courses/${courseId}/onboarding`, revision);
  const d = summary.data;
  const activeClassroom = d?.classrooms.find((room) => room.id === classroomId) ?? d?.classrooms[0] ?? null;
  const hasClasses = Boolean(d && d.classrooms.length > 0);
  const hasStudents = Boolean(d && d.student_count > 0);

  const navButton = (
    target: GuideTarget,
    label: string,
    done: boolean,
    Icon?: LucideIcon,
    extra?: Record<string, string>,
  ) => (
    <ButtonLink
      size="sm"
      variant={done ? "outline" : "default"}
      href={pageHref(target, extra)}
      onClick={(e) => {
        e.preventDefault();
        onNavigate(target, extra);
      }}
    >
      {Icon && <Icon />}
      {label}
    </ButtonLink>
  );

  const steps: GuideStep[] = d
    ? [
        {
          title: "创建第一个班级",
          description: "一门课可开设多个平行教学班（默认命名为「一班」），新班自动生成专属班级加入码，章节初始保持关闭。",
          icon: School,
          state: hasClasses ? "done" : "todo",
          summary: activeClassroom ? (
            <span className="flex flex-wrap items-center gap-2">
              <span>
                已创建 <strong>{d.classrooms.length}</strong> 个在教班级，当前班级「{activeClassroom.name}」加入码：
              </span>
              <code className="rounded bg-muted px-2 py-0.5 font-mono text-foreground select-all">
                {activeClassroom.join_code}
              </code>
              <Button type="button" size="sm" variant="ghost" onClick={() => void copyJoinCode(activeClassroom.join_code)}>
                <Copy />
                复制加入码
              </Button>
            </span>
          ) : (
            "尚未创建在教班级"
          ),
          actions: !hasClasses ? (
            <Button onClick={onCreateClass}>
              <Plus />
              创建第一个班级
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={onCreateClass}>
                <Plus />
                新建班级
              </Button>
              {navButton("classes", "班级管理", true)}
            </>
          ),
        },
        {
          title: "导入或邀请学生加入班级",
          description: "支持两种方式：① 将班级加入码发给已有账号的学生自助加入；② 下载名册模板填写「学号、姓名」，在班级「学生管理」批量导入。",
          icon: Users,
          state: hasStudents ? "done" : "todo",
          summary: (
            <>
              当前在籍正式学生 <strong>{d.student_count}</strong> 人
            </>
          ),
          actions: (
            <>
              <Button type="button" size="sm" variant="outline" onClick={() => void downloadRosterTemplate("xlsx")}>
                <Download />
                下载名册模板 (.xlsx)
              </Button>
              {activeClassroom ? (
                <Button size="sm" variant={hasStudents ? "outline" : "default"} onClick={() => onOpenStudents(activeClassroom.id)}>
                  <Users />
                  去导入/管理学生
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={onCreateClass}>
                  先创建班级
                </Button>
              )}
            </>
          ),
        },
        {
          title: "创建章节并上传课件",
          description: "在「章节与课件」添加课程章节，上传 PDF 讲义、PPTX 演示文稿、教学视频或 Markdown 文档，支持批量拖放与压缩包导入。",
          icon: BookOpen,
          state:
            d.chapter_count > 0 && d.ready_material_count > 0
              ? "done"
              : d.chapter_count > 0 || d.material_count > 0
                ? "in_progress"
                : "todo",
          summary: (
            <>
              已建 <strong>{d.chapter_count}</strong> 个章节 · 已就绪课件 <strong>{d.ready_material_count}</strong> 份
              {d.material_count > d.ready_material_count
                ? `（另有 ${d.material_count - d.ready_material_count} 份正在转换或待检查）`
                : ""}
            </>
          ),
          actions: navButton("courseware", "前往章节与课件", d.chapter_count > 0 && d.ready_material_count > 0, BookOpen),
        },
        {
          title: "生成讲解稿、配音与知识点",
          description: "打开 PDF 或演示文稿课件生成逐页讲解稿，审校通过后合成语音（仅已审校内容对学生可见），并为章节抽取或维护知识点。",
          icon: Sparkles,
          state:
            d.chapter_count > 0 &&
            d.ready_material_count > 0 &&
            d.knowledge_point_count > 0 &&
            (d.narratable_material_count === 0 || (d.narration_accepted_pages > 0 && d.audio_ready_pages > 0))
              ? "done"
              : d.narration_accepted_pages > 0 ||
                  d.narration_draft_pages > 0 ||
                  d.audio_ready_pages > 0 ||
                  d.knowledge_point_count > 0
                ? "in_progress"
                : "todo",
          summary: (
            <>
              已生效讲稿 <strong>{d.narration_accepted_pages}</strong> 页
              {d.narration_draft_pages > 0 ? `（${d.narration_draft_pages} 页待审）` : ""} · 有效配音{" "}
              <strong>{d.audio_ready_pages}</strong> 页 · 知识点 <strong>{d.knowledge_point_count}</strong> 个
            </>
          ),
          actions: (
            <>
              {d.narration_draft_pages > 0 && (
                <Button size="sm" variant="outline" onClick={onOpenReview}>
                  <NotebookPen />
                  审校待审讲稿（{d.narration_draft_pages} 页）
                </Button>
              )}
              {navButton("content-graph", "知识图谱", true, Network)}
              {navButton(
                "courseware",
                "去课件工作区生成",
                d.knowledge_point_count > 0 &&
                  (d.narratable_material_count === 0 || (d.narration_accepted_pages > 0 && d.audio_ready_pages > 0)),
              )}
            </>
          ),
        },
        {
          title: "生成或录入课程题目",
          description: "在「题库与组卷」按章节知识点 AI 生成客观题草稿并审校设为可用，或手动录入客观题、Python 编程题与交互练习题。",
          icon: FileQuestionMark,
          state: d.ready_question_count > 0 ? "done" : d.draft_question_count > 0 ? "in_progress" : "todo",
          summary: (
            <>
              可用题目 <strong>{d.ready_question_count}</strong> 道
              {d.draft_question_count > 0 ? ` · 待审草稿 ${d.draft_question_count} 道` : ""}
            </>
          ),
          actions: (
            <>
              {d.draft_question_count > 0 &&
                navButton("assessments", `审校待审题目（${d.draft_question_count}）`, true, undefined, {
                  tab: "bank",
                  status: "draft",
                  reviewable: "true",
                })}
              {navButton("assessments", "前往题库与组卷", d.ready_question_count > 0, FileQuestionMark, { tab: "bank" })}
            </>
          ),
        },
        {
          title: "发布第一个练习和测验",
          description: "在「学习任务」按章勾选必读资料与阅读要求，分别新增并发布练习和单元测验（小镇按「必读资料 → 练习 → 测验」推进章节）。",
          icon: ClipboardList,
          state:
            d.published_practice_count > 0 && d.published_assessment_count > 0
              ? "done"
              : d.published_practice_count > 0 || d.published_assessment_count > 0 || d.required_reading_count > 0
                ? "in_progress"
                : "todo",
          summary: (
            <>
              必读资料 <strong>{d.required_reading_count}</strong> 项 · 已发布练习{" "}
              <strong>{d.published_practice_count}</strong> 组 · 已发布测验{" "}
              <strong>{d.published_assessment_count}</strong> 份
            </>
          ),
          actions: navButton(
            "activities",
            "配置学习任务",
            d.published_practice_count > 0 && d.published_assessment_count > 0,
            ClipboardList,
          ),
        },
        {
          title: "开放做好的章节",
          description: "前往「定时开放」将已配置妥当的章节设为立即开放或预约开放时间。开放后，本班学生在小镇即可领取对应章节任务。",
          icon: CalendarDays,
          state: d.open_chapter_count > 0 || d.scheduled_chapter_count > 0 ? "done" : "todo",
          summary: (
            <>
              已开放 <strong>{d.open_chapter_count}</strong> 章
              {d.scheduled_chapter_count > 0 ? ` · 等待定时开放 ${d.scheduled_chapter_count} 章` : ""}
            </>
          ),
          actions: activeClassroom ? (
            navButton("teaching", "设置定时开放", d.open_chapter_count > 0 || d.scheduled_chapter_count > 0, CalendarDays)
          ) : (
            <Button size="sm" variant="outline" onClick={onCreateClass}>
              先创建班级
            </Button>
          ),
        },
      ]
    : [];

  const completedCount = steps.filter((s) => s.state === "done").length;
  const percent = steps.length ? Math.round((completedCount / steps.length) * 100) : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="开课引导"
        description="从组建班级、上传课件与 AI 备课，到组题发布练习测验并开放章节，一步步完成开课准备。"
      >
        <Button variant="outline" onClick={summary.reload} disabled={summary.loading}>
          <RefreshCw />
          刷新进度
        </Button>
        {activeClassroom && (
          <Button
            variant="outline"
            disabled={openingTown}
            aria-busy={openingTown}
            onClick={() => onEnterTown(activeClassroom.id)}
          >
            {openingTown ? "正在进入小镇…" : "进入小镇体验"}
            {openingTown ? (
              <LoaderCircle data-icon="inline-end" className="animate-spin motion-reduce:animate-none" />
            ) : (
              <ExternalLink data-icon="inline-end" />
            )}
          </Button>
        )}
      </PageHeader>

      <ErrorNotice message={summary.error} />
      {!d ? (
        summary.loading ? (
          <div className="surface">
            <Loading />
          </div>
        ) : null
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                开课准备进度 · 已完成 {completedCount} / {steps.length} 步
              </CardTitle>
              <CardDescription>
                {completedCount === steps.length
                  ? "所有开课环节已就绪！学生加入班级后即可进入小镇按章节顺序学习，您也可以点击右上角「进入小镇体验」亲自试玩。"
                  : "各步骤可随时反复调整；内容全课共享，名册、章节开放日历与成绩按班级独立隔离。"}
              </CardDescription>
              <CardAction>
                <span className="text-sm font-semibold tabular-nums">{percent}%</span>
              </CardAction>
            </CardHeader>
            <CardContent>
              <Progress value={percent} aria-label="开课准备完成度" />
            </CardContent>
          </Card>

          <ol className="grid gap-4" aria-label="开课引导步骤">
            {steps.map((step, idx) => {
              const Icon = step.icon;
              return (
                <li key={step.title}>
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex flex-wrap items-center gap-2">
                        <span className="inline-grid size-6 place-items-center rounded-full bg-muted text-xs font-semibold">
                          {idx + 1}
                        </span>
                        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                        {step.title}
                      </CardTitle>
                      <CardDescription>{step.description}</CardDescription>
                      <CardAction>
                        <StepBadge state={step.state} />
                      </CardAction>
                    </CardHeader>
                    <CardContent className="flex flex-wrap items-center justify-between gap-3">
                      <div className="text-sm text-muted-foreground">{step.summary}</div>
                      <div className="flex flex-wrap gap-2">{step.actions}</div>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}
