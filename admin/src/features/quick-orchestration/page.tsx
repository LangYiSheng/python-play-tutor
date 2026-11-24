import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, ClipboardCheck, ListChecks, RefreshCw, Route } from "lucide-react";
import { Empty, ErrorNotice, Loading, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, errorMessage, request } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { toast } from "@/components/ui/toast";
import { useResource } from "@/lib/use-resource";
import { ChapterPicker } from "./chapter-picker";
import type { ChapterSelection, CourseTemplate, Preview, QuickCatalog, Recipe } from "./contracts";
import { sameRecipe } from "./contracts";
import { GenerationPreview } from "./generation-preview";
import { quotaProblems, withoutAssessmentPlan } from "./question-plan";
import { QuestionPlanEditor } from "./question-plan-editor";
import { chapterProblems, maxChapters } from "./selection-validation";

const stageIcons = { lesson: BookOpen, practice: ListChecks, assessment: ClipboardCheck };
const steps = [
  { key: "template", title: "模板与功能" }, { key: "chapters", title: "授课章节" },
  { key: "questions", title: "题量与题型" }, { key: "preview", title: "预览与生成" },
] as const;
type Step = (typeof steps)[number]["key"];
function hasQuiz(template?: CourseTemplate) {
  return Boolean(template?.stages.some(stage => stage.kind === "assessment"));
}
function editorRecipe(catalog: QuickCatalog): Recipe {
  const saved = catalog.recipe;
  const template = saved ? catalog.templates.find(item => item.id === saved.template_id) : catalog.templates[0];
  const recipe = saved ?? { template_id: template?.id ?? "", chapters: [], practice_count: 1, quiz_count: hasQuiz(template) ? 1 : 0 };
  if (!hasQuiz(template)) return recipe;
  const legacy = saved && saved.start_chapter_id === undefined && saved.final_chapter_id === undefined && saved.feature_ids === undefined;
  const features = template?.features ?? [];
  return {
    ...recipe,
    start_chapter_id: recipe.start_chapter_id ?? recipe.chapters[0]?.chapter_id,
    final_chapter_id: recipe.final_chapter_id ?? (legacy ? recipe.chapters.at(-1)?.chapter_id ?? null : null),
    feature_ids: recipe.feature_ids ?? features.filter(item => saved
      ? ["public_chat", "library_shelf_tour"].includes(item.id)
      : item.default_enabled).map(item => item.id),
  };
}

export function QuickOrchestration({ classroomId }: { classroomId: number }) {
  const path = "/teacher/classrooms/" + classroomId + "/quick-orchestration";
  return <ClassQuickOrchestration key={path} path={path} />;
}
function ClassQuickOrchestration({ path }: { path: string }) {
  const catalog = useResource<QuickCatalog>(path);
  return <>
    <PageHeader title="快速编排" description="设置小镇功能，选择授课内容，预览并生成课程流程。" />
    {catalog.loading ? <Loading /> : catalog.error ? <>
      <ErrorNotice message={catalog.error} /><Button variant="outline" onClick={catalog.reload}>重新加载</Button>
    </> : catalog.data && <RecipeEditor path={path} initial={catalog.data} />}
  </>;
}

function StageRoute({ template }: { template: CourseTemplate }) {
  return <ol aria-label="每章教学流程" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
    {template.stages.map(({ kind, label, location }, index) => {
      const Icon = stageIcons[kind];
      return <li key={kind} className="flex items-center gap-2">
        {index > 0 && <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden="true" />}
        <Icon className="size-4" aria-hidden="true" />
        <span className="font-medium">{label}</span><span className="text-muted-foreground">{location}</span>
      </li>;
    })}
  </ol>;
}

function RecipeEditor({ path, initial }: { path: string; initial: QuickCatalog }) {
  const [catalog, setCatalog] = useState(initial);
  const { templates, chapters, revision, recipe: saved } = catalog;
  const [recipe, setRecipe] = useState(() => editorRecipe(initial));
  const template = templates.find(item => item.id === recipe.template_id);
  const withQuiz = hasQuiz(template);
  const savedTemplate = templates.find(item => item.id === saved?.template_id);
  const standardTemplate = templates[0];
  const canAddQuiz = savedTemplate && !hasQuiz(savedTemplate) && hasQuiz(standardTemplate);
  const [step, setStep] = useState<Step>("template");
  const [pending, setPending] = useState<"refresh" | "preview" | "apply" | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const lastQuizCount = useRef(initial.recipe?.quiz_count || 1);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);
  const dirty = !sameRecipe(recipe, editorRecipe(catalog));
  useDraft(dirty);

  function change(next: Recipe) {
    setRecipe(next);
    setError("");
    setPreview(null);
  }
  function selectTemplate(next: CourseTemplate) {
    if (withQuiz && recipe.quiz_count > 0 && recipe.quiz_count <= 100) lastQuizCount.current = recipe.quiz_count;
    const updated = { ...recipe, template_id: next.id, quiz_count: hasQuiz(next) ? lastQuizCount.current : 0 };
    if (hasQuiz(next)) {
      updated.start_chapter_id = updated.chapters[0]?.chapter_id;
      updated.final_chapter_id = null;
      updated.feature_ids = next.features?.filter(item => item.default_enabled).map(item => item.id) ?? [];
    } else {
      delete updated.start_chapter_id;
      delete updated.final_chapter_id;
      delete updated.feature_ids;
    }
    change(updated);
  }
  function changeChapterOrder(rows: ChapterSelection[], finalId = recipe.final_chapter_id) {
    if (!withQuiz) return change({ ...recipe, chapters: rows });
    change({ ...recipe, chapters: rows, start_chapter_id: rows[0]?.chapter_id,
      final_chapter_id: rows.some(row => row.chapter_id === finalId) ? finalId : null });
  }
  async function run(action: "refresh" | "preview" | "apply") {
    if (inFlight.current || (action === "apply" && !preview?.token)) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setError("");
    setConflict(false);
    setPending(action);
    try {
      if (action === "refresh") {
        const current = await request<QuickCatalog>(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!sameRecipe(current.recipe, saved)) {
          if (dirty && !window.confirm("本班已保存一份新的编排。载入最新编排将放弃当前调整，是否继续？")) {
            setConflict(true);
            setError("已保留当前调整。生成前请先载入本班的最新编排。");
            return;
          }
          setRecipe(editorRecipe(current));
          lastQuizCount.current = current.recipe?.quiz_count || 1;
        }
        setPreview(null);
        setCatalog(current);
        toast.add({ title: "教学内容已刷新", type: "success" });
        setStep("chapters");
        return;
      }
      const submission = withQuiz ? recipe : { ...recipe, chapters: recipe.chapters.map(withoutAssessmentPlan) };
      const options = {
        method: "POST", signal: controller.signal,
        body: JSON.stringify({ expected_revision: revision, recipe: submission, ...(action === "apply" ? { token: preview?.token } : {}) }),
      };
      if (action === "preview") {
        const result = await request<Preview>(path + "/preview", options);
        if (!controller.signal.aborted) setPreview(result);
      } else {
        const result = await request<{ revision: number }>(path + "/apply", options);
        if (controller.signal.aborted) return;
        setCatalog(current => ({ ...current, recipe: submission, revision: result.revision }));
        setRecipe(submission);
        setPreview(current => current && { ...current, token: null, reset_impact: null });
        toast.add({ title: "课程流程已生成", description: "可点击「进入小镇」体验课程。", type: "success" });
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      setPreview(null);
      setError(errorMessage(e));
      setConflict(e instanceof ApiError && e.status === 409);
    } finally {
      if (!controller.signal.aborted) setPending(null);
      inFlight.current = null;
    }
  }
  const problems = chapterProblems(recipe.chapters, chapters);
  let chapterHint = "";
  if (!recipe.chapters.length) chapterHint = "请至少勾选一个章节。";
  else if (recipe.chapters.length > maxChapters) chapterHint = "请保留最多 " + maxChapters + " 个章节。";
  else if (problems.size) chapterHint = "请补全标为「待补全」的 " + problems.size + " 个章节。";
  const questionHint = quotaProblems(recipe, withQuiz, chapters)[0] ?? "";
  const blocked = { template: false, chapters: false, questions: !template || Boolean(chapterHint),
    preview: !template || Boolean(chapterHint || questionHint) };
  const index = steps.findIndex(item => item.key === step);
  const next = steps[index + 1];
  const hint = step === "chapters" ? (!template ? "课程模板暂不可用，请刷新内容。" : chapterHint) : step === "questions" ? questionHint : "";
  function navigate(to: Step) {
    if (inFlight.current || blocked[to]) return;
    if (step === "preview" && to !== "preview") setPreview(null);
    setStep(to);
    if (to === "preview" && !preview) void run("preview");
  }

  return <div className="max-w-6xl space-y-4">
    <Tabs value={step} onValueChange={value => navigate(value as Step)} className="gap-4">
      <TabsList aria-label="课程编排步骤" variant="line">
        {steps.map(({ key, title }, i) => <TabsTrigger key={key} value={key} aria-label={title} disabled={Boolean(pending) || blocked[key]}>
          <span aria-hidden="true" className="tabular-nums">{i + 1}.</span>{title}
        </TabsTrigger>)}
      </TabsList>
      <TabsContent value="template">
          {template ? <section aria-label="课程模板" className="surface space-y-3" inert={Boolean(pending)}>
            <h2 className="text-lg">课程模板</h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="text-sm font-semibold">每章必做</span>
              <StageRoute template={template} />
            </div>
            {withQuiz && Boolean(template.features?.length) && <fieldset className="border-t pt-3">
              <legend className="float-left w-full pb-2 text-sm font-semibold">可选功能</legend>
              <div className="clear-both grid gap-2 sm:grid-cols-2">
                {template.features?.map(feature => {
                  const enabled = recipe.feature_ids?.includes(feature.id) ?? false;
                  return <label key={feature.id} className="flex items-start gap-2 rounded px-1 py-1 hover:bg-muted/40">
                    <input type="checkbox" className="mt-1 shrink-0" aria-label={feature.title} checked={enabled} onChange={() => {
                      const ids = recipe.feature_ids ?? [];
                      change({ ...recipe, feature_ids: enabled ? ids.filter(id => id !== feature.id) : [...ids, feature.id] });
                    }} />
                    <span><span className="block text-sm font-medium">{feature.title}</span><span className="hint">{feature.description}</span></span>
                  </label>;
                })}
              </div>
            </fieldset>}
            {canAddQuiz && <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={withQuiz} onChange={event => selectTemplate(event.target.checked ? standardTemplate : savedTemplate)} />
              为原有课程增加测验
            </label>}
          </section> : <ErrorNotice message="课程模板暂不可用，请到「授课章节」刷新内容。" />}
      </TabsContent>
      <TabsContent value="chapters" keepMounted inert={Boolean(pending)}>
        {chapters.length || recipe.chapters.length
          ? <ChapterPicker chapters={chapters} selected={recipe.chapters} problems={problems} withQuiz={withQuiz} finalId={recipe.final_chapter_id}
            onChange={changeChapterOrder} onRefresh={() => void run("refresh")} refreshing={pending === "refresh"} />
          : <div className="surface"><Empty title="先为这门课程添加章节" description="在「课程结构」中创建章节和知识点，再到「资料库」关联课件。" />
            <div className="flex justify-center gap-3 pb-5">
              <a href="/teacher/content-list?tab=chapters" className="text-sm underline underline-offset-2">前往章节列表</a>
              <Button variant="outline" size="sm" disabled={Boolean(pending)} onClick={() => void run("refresh")}><RefreshCw />刷新章节</Button>
            </div>
          </div>}
      </TabsContent>
      <TabsContent value="questions" keepMounted>
        <QuestionPlanEditor recipe={recipe} chapters={chapters} withQuiz={withQuiz} onChange={change} />
      </TabsContent>
      <TabsContent value="preview"><GenerationPreview preview={preview} chapters={chapters} recipe={recipe} withQuiz={withQuiz}
        features={template?.features} /></TabsContent>
    </Tabs>

    <div aria-live="polite">
      <ErrorNotice message={error} />
      {conflict && <Button variant="outline" disabled={Boolean(pending)} onClick={() => void run("refresh")}>重新载入课程</Button>}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
      <span className="hint">{hint || (dirty ? "有未生成的调整" : saved ? "当前流程已保存" : "")}</span>
      <div className="flex flex-wrap items-center gap-2">
        {index > 0 && <Button variant="outline" disabled={Boolean(pending)} onClick={() => navigate(steps[index - 1].key)}><ArrowLeft />上一步</Button>}
        {next && <Button disabled={Boolean(pending) || blocked[next.key]} onClick={() => navigate(next.key)}>{next.title}<ArrowRight /></Button>}
        {step === "preview" && (preview ? <Button disabled={!preview.token || Boolean(preview.blockers.length) || Boolean(pending)}
          variant={preview.reset_impact ? "destructive" : "default"} onClick={() => void run("apply")}>
          <Route />{pending === "apply" ? "正在生成…" : !preview.token && !preview.blockers.length ? "已生成课程流程" : preview.reset_impact ? "确认重置并生成" : "确认生成课程流程"}
        </Button> : <Button disabled={Boolean(pending) || blocked.preview || conflict} onClick={() => void run("preview")}>
          {pending === "preview" ? "正在检查课程…" : "重新检查流程"}
        </Button>)}
      </div>
    </div>
  </div>;
}
