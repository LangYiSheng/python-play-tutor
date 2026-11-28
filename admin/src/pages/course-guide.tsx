import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  ArrowRight,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  ClipboardList,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileQuestionMark,
  LayoutList,
  LoaderCircle,
  Network,
  NotebookPen,
  Plus,
  RefreshCw,
  School,
  Sparkles,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";
import { ErrorNotice } from "@/components/common";
import { GuideSkeleton } from "@/components/skeletons";
import { Button, ButtonLink } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { DropImportOverlay } from "@/features/courseware/drop-import-overlay";
import { MaterialDialog } from "@/features/materials/editor-dialog";
import { useMaterialEditor } from "@/features/materials/use-editor";
import { scoped } from "@/lib/api";
import { downloadRosterTemplate } from "@/lib/roster-template";
import type { Course } from "@/lib/types";
import { useResource } from "@/lib/use-resource";
import { GuideScene } from "./course-guide-scenes";
import "./course-guide.css";

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
  extraContent?: ReactNode;
  actions: ReactNode;
}

const SKIP_KEY_PREFIX = "pythontopia:guide-skipped:";

function readSkipped(courseId: number): number[] {
  try {
    const raw = localStorage.getItem(SKIP_KEY_PREFIX + courseId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

function saveSkipped(courseId: number, indices: number[]) {
  try {
    localStorage.setItem(SKIP_KEY_PREFIX + courseId, JSON.stringify([...new Set(indices)]));
  } catch {
    // Ignore storage quota errors in restricted browsers.
  }
}

async function copyJoinCode(code: string) {
  try {
    await navigator.clipboard.writeText(code);
    toast.add({ title: "班级加入码已复制", type: "success" });
  } catch {
    toast.add({ title: "复制失败，请选中加入码手动复制", type: "error" });
  }
}

function statusMeta(state: StepState, isSkipped: boolean) {
  if (state === "done") return { key: "done", label: "已完成", Icon: CheckCircle2 };
  if (state === "in_progress") return { key: "in_progress", label: "进行中", Icon: Clock3 };
  if (isSkipped) return { key: "skipped", label: "已跳过 · 可随时补做", Icon: Circle };
  return { key: "todo", label: "待设置", Icon: Circle };
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

  const [mode, setMode] = useState<"wizard" | "overview">("wizard");
  const [skipped, setSkipped] = useState<number[]>(() => readSkipped(courseId));
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState<"next" | "prev">("next");
  const [dragActive, setDragActive] = useState(false);
  const [redirectToCourseware, setRedirectToCourseware] = useState(false);
  const initializedCourse = useRef<number | null>(null);
  const dragDepth = useRef(0);
  const dropInputRef = useRef<HTMLInputElement>(null);

  const materialEditor = useMaterialEditor(courseId, () => {
    summary.reload();
    setRedirectToCourseware(true);
  });
  const chaptersCatalog = useResource<Course>(
    materialEditor.open ? scoped("/teacher/catalog?view=chapters", courseId) : null,
  );

  useEffect(() => {
    if (redirectToCourseware && !materialEditor.open && !materialEditor.dirty) {
      setRedirectToCourseware(false);
      onNavigate("courseware");
    }
  }, [redirectToCourseware, materialEditor.open, materialEditor.dirty, onNavigate]);

  function hasDraggedFiles(e: DragEvent) {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }

  function openMaterialUploadWithFiles(picked: File[]) {
    if (!picked.length || materialEditor.busy) return;
    materialEditor.edit(null);
    materialEditor.selectFiles(picked);
  }

  useEffect(() => {
    setSkipped(readSkipped(courseId));
  }, [courseId]);

  const navButton = (
    target: GuideTarget,
    label: string,
    done: boolean,
    Icon?: LucideIcon,
    extra?: Record<string, string>,
  ) => (
    <ButtonLink
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
          description: "为这门课建立第一个教学班，方便组织学生开展课程学习。",
          icon: School,
          state: hasClasses ? "done" : "todo",
          summary: activeClassroom ? (
            <>
              已建 <strong>{d.classrooms.length}</strong> 个在教班级 · 当前「{activeClassroom.name}」加入码{" "}
              <code className="rounded bg-white px-2 py-0.5 font-mono font-semibold select-all">
                {activeClassroom.join_code}
              </code>
            </>
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
              <Button variant="outline" onClick={() => void copyJoinCode(activeClassroom!.join_code)}>
                <Copy />
                复制加入码
              </Button>
              <Button variant="outline" onClick={onCreateClass}>
                <Plus />
                再建一个班
              </Button>
              {navButton("classes", "管理班级", true)}
            </>
          ),
        },
        {
          title: "邀请或导入学生",
          description: "可将班级加入码发给学生登录后自助进班，也可下载预设文本学号列的模板批量导入名册（新生初始密码为本人学号）。",
          icon: Users,
          state: hasStudents ? "done" : "todo",
          summary: activeClassroom ? (
            <>
              当前在籍正式学生 <strong>{d.student_count}</strong> 人 · 「{activeClassroom.name}」邀请码{" "}
              <code className="rounded bg-white px-2 py-0.5 font-mono font-semibold select-all">
                {activeClassroom.join_code}
              </code>
            </>
          ) : (
            <>
              当前在籍正式学生 <strong>{d.student_count}</strong> 人（请先创建班级以生成邀请码）
            </>
          ),
          actions: (
            <>
              {activeClassroom ? (
                <>
                  <Button variant={hasStudents ? "outline" : "default"} onClick={() => onOpenStudents(activeClassroom.id)}>
                    <Users />
                    去导入 / 管理学生
                  </Button>
                  <Button type="button" variant="outline" onClick={() => void copyJoinCode(activeClassroom.join_code)}>
                    <Copy />
                    复制邀请码
                  </Button>
                </>
              ) : (
                <Button variant="outline" onClick={onCreateClass}>
                  先创建班级
                </Button>
              )}
              <Button type="button" variant="outline" onClick={() => void downloadRosterTemplate("xlsx")}>
                <Download />
                下载名册模板 (.xlsx)
              </Button>
            </>
          ),
        },
        {
          title: "创建章节并上传课件",
          description: "直接拖入课件或压缩包即可快速导入（PPT / PDF 可自动按文件名新建章节），也可进入「章节与课件」精细调整。",
          icon: BookOpen,
          state:
            d.chapter_count > 0 && d.ready_material_count > 0
              ? "done"
              : d.chapter_count > 0 || d.material_count > 0
                ? "in_progress"
                : "todo",
          summary: (
            <>
              已建 <strong>{d.chapter_count}</strong> 章 · 已就绪课件 <strong>{d.ready_material_count}</strong> 份
              {d.material_count > d.ready_material_count
                ? `（${d.material_count - d.ready_material_count} 份转换或待检查）`
                : ""}
            </>
          ),
          extraContent: (
            <div
              role="button"
              tabIndex={0}
              aria-label="拖动课件至此或点击选择文件上传"
              data-dragging={dragActive || undefined}
              className="setup-dropzone"
              onClick={() => dropInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  dropInputRef.current?.click();
                }
              }}
            >
              <input
                ref={dropInputRef}
                type="file"
                multiple
                accept=".pdf,.txt,.md,.ppt,.pptx,.mp4,.webm,.zip"
                className="sr-only"
                tabIndex={-1}
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (picked.length > 0) openMaterialUploadWithFiles(picked);
                }}
              />
              <Upload className="size-5 text-emerald-800" aria-hidden="true" />
              <span className="text-sm font-medium text-foreground">
                将课件或 .zip 压缩包拖动至此，或点击选择文件
              </span>
              <span className="text-xs text-muted-foreground">
                支持 .pdf / .ppt / .pptx / .mp4 / .webm / .md / .txt，导入后自动进入章节与课件
              </span>
            </div>
          ),
          actions: navButton("courseware", "前往章节与课件", true, BookOpen),
        },
        {
          title: "生成讲解稿、配音与知识点",
          description: "对 PDF 或演示文稿生成逐页口播讲稿，审校通过后合成语音（仅已审校内容对学生可见），并抽取或维护章节知识点。",
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
              有效讲稿 <strong>{d.narration_accepted_pages}</strong> 页
              {d.narration_draft_pages > 0 ? `（${d.narration_draft_pages} 页待审）` : ""} · 配音{" "}
              <strong>{d.audio_ready_pages}</strong> 页 · 知识点 <strong>{d.knowledge_point_count}</strong> 个
            </>
          ),
          actions: (
            <>
              {navButton(
                "courseware",
                "去课件工作区生成",
                d.knowledge_point_count > 0 &&
                  (d.narratable_material_count === 0 || (d.narration_accepted_pages > 0 && d.audio_ready_pages > 0)),
                Sparkles,
              )}
              {d.narration_draft_pages > 0 && (
                <Button variant="outline" onClick={onOpenReview}>
                  <NotebookPen />
                  审校待审讲稿（{d.narration_draft_pages} 页）
                </Button>
              )}
              {navButton("content-graph", "查看知识图谱", true, Network)}
            </>
          ),
        },
        {
          title: "生成或录入课程题目",
          description: "按章节知识点 AI 生成客观题草稿并审校入库，或手动添加单选、多选、判断、填空、Python 编程题与交互练习题。",
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
              {navButton("assessments", "前往智能题库", d.ready_question_count > 0, FileQuestionMark, { tab: "bank" })}
              {d.draft_question_count > 0 &&
                navButton("assessments", `审校草稿（${d.draft_question_count}）`, true, undefined, {
                  tab: "bank",
                  status: "draft",
                  reviewable: "true",
                })}
            </>
          ),
        },
        {
          title: "发布第一个练习和测验",
          description: "在「学习任务」按章勾选必读资料与阅读要求，分别新增并发布课堂练习和单元测验，组成小镇闯关主线。",
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
          description: "最后一步：在「定时开放」将准备好的章节设为立即开放或预约开放时间，随后即可进入小镇以体验学生视角试玩。",
          icon: CalendarDays,
          state: d.open_chapter_count > 0 || d.scheduled_chapter_count > 0 ? "done" : "todo",
          summary: (
            <>
              已开放 <strong>{d.open_chapter_count}</strong> 章
              {d.scheduled_chapter_count > 0 ? ` · 定时待开放 ${d.scheduled_chapter_count} 章` : ""}
            </>
          ),
          actions: activeClassroom ? (
            navButton("teaching", "设置章节开放", d.open_chapter_count > 0 || d.scheduled_chapter_count > 0, CalendarDays)
          ) : (
            <Button variant="outline" onClick={onCreateClass}>
              先创建班级
            </Button>
          ),
        },
      ]
    : [];

  useEffect(() => {
    if (!steps.length || initializedCourse.current === courseId) return;
    initializedCourse.current = courseId;
    const currentSkipped = readSkipped(courseId);
    const nextPending = steps.findIndex(
      (item, idx) => item.state !== "done" && !currentSkipped.includes(idx),
    );
    setStepIndex(nextPending === -1 ? steps.length : nextPending);
  }, [courseId, steps]);

  function goTo(target: number) {
    const clamped = Math.max(0, Math.min(steps.length, target));
    if (clamped === stepIndex) return;
    setDirection(clamped > stepIndex ? "next" : "prev");
    setStepIndex(clamped);
  }

  function skipCurrentStep() {
    if (stepIndex >= steps.length) return;
    const updated = [...new Set([...skipped, stepIndex])];
    setSkipped(updated);
    saveSkipped(courseId, updated);
    goTo(stepIndex + 1);
  }

  const completedCount = steps.filter((s) => s.state === "done").length;
  const isFinale = steps.length > 0 && stepIndex >= steps.length;
  const currentStep = !isFinale ? steps[stepIndex] : null;
  const currentStatus = currentStep ? statusMeta(currentStep.state, skipped.includes(stepIndex)) : null;

  return (
    <div className="setup-shell">
      <div className="setup-topbar">
        <div className="setup-brand-title">
          <h1>开课引导</h1>
          {d && (
            <span>
              已完成 {completedCount} / {steps.length} 步
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {d && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setMode((m) => (m === "wizard" ? "overview" : "wizard"))}
            >
              <LayoutList />
              {mode === "wizard" ? "全部步骤总览" : "返回分步引导"}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={summary.reload} disabled={summary.loading}>
            <RefreshCw />
            刷新
          </Button>
          {activeClassroom && (
            <Button
              variant="outline"
              size="sm"
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
        </div>
      </div>

      <ErrorNotice message={summary.error} />

      {!d ? (
        summary.loading ? (
          <GuideSkeleton />
        ) : null
      ) : mode === "overview" ? (
        <ol className="page-enter setup-overview-list" aria-label="开课步骤总览">
          {steps.map((step, idx) => {
            const meta = statusMeta(step.state, skipped.includes(idx));
            const Icon = step.icon;
            return (
              <li key={step.title}>
                <button
                  type="button"
                  className="setup-overview-item w-full"
                  onClick={() => {
                    setDirection(idx >= stepIndex ? "next" : "prev");
                    setStepIndex(idx);
                    setMode("wizard");
                  }}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold">
                      {idx + 1}
                    </span>
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="min-w-0">
                      <div className="font-medium">{step.title}</div>
                      <div className="text-xs text-muted-foreground">{step.summary}</div>
                    </div>
                  </div>
                  <span className="setup-eyebrow mb-0! shrink-0" data-status={meta.key}>
                    <meta.Icon className="size-3.5" aria-hidden="true" />
                    {meta.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <section
          className="setup-card"
          aria-label="分步开课向导"
          onDragEnter={(e) => {
            if (stepIndex !== 2 || materialEditor.open || !hasDraggedFiles(e)) return;
            e.preventDefault();
            dragDepth.current += 1;
            setDragActive(true);
          }}
          onDragOver={(e) => {
            if (stepIndex !== 2 || materialEditor.open || !hasDraggedFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(e) => {
            if (stepIndex !== 2 || materialEditor.open || !hasDraggedFiles(e)) return;
            e.preventDefault();
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragActive(false);
          }}
          onDrop={(e) => {
            if (stepIndex !== 2 || materialEditor.open || !hasDraggedFiles(e)) return;
            e.preventDefault();
            dragDepth.current = 0;
            setDragActive(false);
            const dropped = Array.from(e.dataTransfer.files);
            if (dropped.length > 0) openMaterialUploadWithFiles(dropped);
          }}
        >
          <DropImportOverlay
            visible={stepIndex === 2 && dragActive}
            targetLabel="松开后确认上传设置，完成后自动进入「章节与课件」"
          />
          <header className="setup-card-header">
            <span className="setup-step-counter">
              {isFinale ? "设置概览" : `第 ${stepIndex + 1} 步，共 ${steps.length} 步`}
            </span>
            <nav className="setup-dots" aria-label="步骤进度">
              {steps.map((step, idx) => {
                const meta = statusMeta(step.state, skipped.includes(idx));
                return (
                  <button
                    key={step.title}
                    type="button"
                    className="setup-dot"
                    data-status={meta.key}
                    aria-label={`第 ${idx + 1} 步：${step.title}（${meta.label}）`}
                    aria-current={!isFinale && idx === stepIndex ? "step" : undefined}
                    onClick={() => goTo(idx)}
                  />
                );
              })}
            </nav>
          </header>

          <div
            key={`${stepIndex}:${direction}`}
            className={`setup-viewport ${direction === "next" ? "setup-slide-next" : "setup-slide-prev"}`}
          >
            <div className="setup-hero">
              <GuideScene
                step={stepIndex}
                data={d}
                classroom={activeClassroom}
                completedCount={completedCount}
                totalSteps={steps.length}
              />
            </div>

            {isFinale ? (
              <>
                <span className="setup-eyebrow" data-status={completedCount === steps.length ? "done" : "in_progress"}>
                  <CheckCircle2 className="size-3.5" aria-hidden="true" />
                  {completedCount === steps.length ? "全部就绪" : `已完成 ${completedCount} / ${steps.length} 步`}
                </span>
                <h2 className="setup-title">
                  {completedCount === steps.length ? "一切准备就绪，可以开始授课了" : "基础引导已浏览完毕"}
                </h2>
                <p className="setup-desc">
                  {completedCount === steps.length
                    ? "班级、课件、讲稿配音、题库、学习任务与章节开放均已就位。您可以随时进入小镇体验完整学习旅程，或前往班级管理查看学生动态。"
                    : "暂时跳过的环节不会影响其他功能使用，您随时可以点击上方圆点或从左侧导航补齐剩余配置。"}
                </p>
                <div className="setup-primary-actions">
                  {activeClassroom && (
                    <Button
                      disabled={openingTown}
                      aria-busy={openingTown}
                      onClick={() => onEnterTown(activeClassroom.id)}
                    >
                      {openingTown ? "正在进入小镇…" : "进入小镇体验"}
                      <ExternalLink data-icon="inline-end" />
                    </Button>
                  )}
                  {navButton("classes", "前往班级管理", Boolean(activeClassroom), School)}
                  <Button type="button" variant="ghost" onClick={() => goTo(0)}>
                    从第一步重新查看
                  </Button>
                </div>
              </>
            ) : (
              currentStep &&
              currentStatus && (
                <>
                  <span className="setup-eyebrow" data-status={currentStatus.key}>
                    <currentStatus.Icon className="size-3.5" aria-hidden="true" />
                    {currentStatus.label}
                  </span>
                  <h2 className="setup-title">{currentStep.title}</h2>
                  <p className="setup-desc">{currentStep.description}</p>
                  <div className="setup-live-pill">{currentStep.summary}</div>
                  {currentStep.extraContent}
                  <div className="setup-primary-actions">{currentStep.actions}</div>
                </>
              )
            )}
          </div>

          <footer className="setup-footer">
            <div>
              {stepIndex > 0 && (
                <Button type="button" variant="ghost" onClick={() => goTo(stepIndex - 1)}>
                  <ChevronLeft />
                  上一步
                </Button>
              )}
            </div>
            <div className="setup-footer-right">
              {!isFinale && currentStep && currentStep.state !== "done" && (
                <Button type="button" variant="ghost" onClick={skipCurrentStep}>
                  稍后设置
                </Button>
              )}
              {!isFinale && (
                <Button
                  type="button"
                  variant={currentStep?.state === "done" ? "default" : "outline"}
                  onClick={() => goTo(stepIndex + 1)}
                >
                  {stepIndex === steps.length - 1 ? "完成引导" : currentStep?.state === "done" ? "继续下一步" : "下一步"}
                  {stepIndex === steps.length - 1 ? <ArrowRight /> : <ChevronRight />}
                </Button>
              )}
            </div>
          </footer>
          {materialEditor.open && (
            <MaterialDialog
              editor={materialEditor}
              course={{ data: Array.isArray(chaptersCatalog.data?.chapters) ? chaptersCatalog.data : null }}
            />
          )}
        </section>
      )}
    </div>
  );
}
