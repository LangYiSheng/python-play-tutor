import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ReactFlowProvider, type Viewport } from "@xyflow/react";
import { ChevronRight, ClipboardCheck, Eye, Headphones, ListTodo, NotebookPen, Pencil, Plus, Upload, X, type LucideIcon } from "lucide-react";
import { ErrorNotice, Loading } from "@/components/common";
import { Button, ButtonLink } from "@/components/ui/button";
import { kinds, statuses } from "@/features/questions/types";
import { scoped } from "@/lib/api";
import { ContentActionDialog, type ContentAction } from "./action-dialog";
import { GraphCanvas, nodeIcons } from "./graph-canvas";
import { graphLayout, jobTitle, materialKinds, nodeKey, pageRanges, taskNodeId, type Branch, type GraphData,
  type GraphQuestion, type MaterialDetail, type NumericKind, type PointDetail, type PointNode, type QuestionNode, type Selection } from "./graph-layout";
import { GraphSearch } from "./graph-search";
import { useGraphData } from "./use-graph-data";
import { TaskDetail, TaskQueue, useTaskCommands } from "./task-queue";
import { taskStatus, type TaskSnapshot } from "./task-presentation";
import "./knowledge-graph.css";
import "./inspector-content.css";

const ContentReviewPanel = lazy(() => import("@/pages/content-review").then(module => ({ default: module.ContentReviewPanel })));
const emptyGraph: GraphData = { title: "", chapters: [], materials: [] };
type GraphLocation = { classroomId: number; selection: Selection | null; branch: Branch | null; chapterPage: number;
  questionPoint?: number | null; questionPage?: number; viewport?: Viewport };
const pageSize = 6;
const kindNames = { course: "课程", chapter: "章节", material: "教学资料", point: "知识点",
  narration: "讲解稿", audio: "讲解音频", task: "生成任务", question: "题目" };

function ToolbarLabel({ icon: Icon, label, count }: {icon: LucideIcon; label: string; count?: number}) {
  return <><Icon data-icon="inline-start" aria-hidden="true"/><span>{label}</span>
    {count != null && <span className="tabular-nums">{count} 项</span>}</>;
}

function Relations<T extends string | number>({ title, rows, onSelect, empty }: {
  title: string; rows: { id: T; title: string; note?: string }[]; onSelect: (id: T) => void; empty?: string;
}) {
  return <section className="inspector-section"><h3>{title}</h3>{rows.length ? <ul className="inspector-links">{rows.map(r => <li key={r.id}>
    <button onClick={() => onSelect(r.id)}><span>{r.title}{r.note && <small>{r.note}</small>}</span><ChevronRight size={14}/></button>
  </li>)}</ul> : <p className="inspector-empty">{empty ?? "暂无关联"}</p>}</section>;
}

function MaterialOutputs({ detail, open }: { detail: MaterialDetail; open: (mode: "narration" | "audio") => void }) {
  if (!detail.narrations && !detail.audio) return null;
  return <section className="inspector-section"><h3>讲解与配音</h3><ul className="inspector-links">
    {detail.narrations > 0 && <li><button onClick={() => open("narration")}><NotebookPen size={16}/>
      <span>逐页讲解稿<small>{detail.narrations} 页{detail.drafts > 0 && ` · ${detail.drafts} 页待审核`}</small></span><ChevronRight size={14}/></button></li>}
    {detail.audio > 0 && <li><button onClick={() => open("audio")}><Headphones size={16}/>
      <span>可播放配音<small>{detail.audio} 页</small></span><ChevronRight size={14}/></button></li>}
  </ul></section>;
}

type GraphProps = { classroomId: number; initialReview?: { materialId?: number } };
type Panel = "node" | "review" | "tasks" | null;
export function KnowledgeGraph(props: GraphProps) {
  return <GraphPage key={props.classroomId} {...props}/>;
}
function GraphPage({ classroomId, initialReview }: GraphProps) {
  const saved = useRef<GraphLocation | undefined>(history.state?.courseGraph?.classroomId === classroomId ? history.state.courseGraph : undefined);
  const [selection, setSelection] = useState<Selection | null>(saved.current?.selection ?? null);
  const [branch, setBranch] = useState<Branch | null>(saved.current?.branch ?? null);
  const [chapterPage, setChapterPage] = useState(saved.current?.chapterPage ?? 1);
  const [questionPoint, setQuestionPoint] = useState(saved.current?.questionPoint ?? null);
  const [questionPage, setQuestionPage] = useState(saved.current?.questionPage ?? 1);
  const [focus, setFocus] = useState<{ key: string; seq: number } | null>(null);
  const [panel, setPanel] = useState<Panel>(initialReview ? "review" : saved.current?.selection ? "node" : null);
  const [reviewScope, setReviewScope] = useState(initialReview);
  const [bookmarkNotice, setBookmarkNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [reviewRevision, setReviewRevision] = useState(0);
  const [action, setAction] = useState<ContentAction | null>(null);
  const view = useRef(saved.current?.viewport);
  const inspector = useRef<HTMLElement>(null);
  const inspectorId = useId();
  const reviewButton = useRef<HTMLButtonElement>(null);
  const taskButton = useRef<HTMLButtonElement>(null);
  const selectedKey = selection ? nodeKey(selection) : "";
  useEffect(() => { inspector.current?.scrollTo(0, 0); }, [selectedKey, panel]);
  const refresh = () => setRevision(n => n + 1);
  const commands = useTaskCommands(classroomId, refresh);
  useEffect(() => {
    // Another teacher or browser tab may have reviewed drafts while this tab was idle.
    const updateCount = () => setReviewRevision(n => n + 1);
    window.addEventListener("focus", updateCount);
    return () => window.removeEventListener("focus", updateCount);
  }, []);
  const endpoint = (suffix: string) => scoped("/teacher/course-graph" + suffix, classroomId);
  const catalog = useGraphData<GraphData>(endpoint(""), revision);
  const taskList = useGraphData<TaskSnapshot[]>(endpoint("/tasks"), revision, 4000);
  const pending = useGraphData<{ material_count: number; question_count: number }>(
    `/teacher/classrooms/${classroomId}/content-review/summary`, revision + reviewRevision);
  const pendingEntries = pending?.data && pending.data.material_count + Number(pending.data.question_count > 0);
  const material = useGraphData<MaterialDetail>(branch?.kind === "material" ? endpoint("/materials/" + branch.id) : null, revision);
  const points = useGraphData<{ items: PointNode[]; total: number; page: number }>(branch?.kind === "chapter" && selection?.kind === "chapter"
    ? scoped("/teacher/knowledge-points?chapter_id=" + branch.id + "&page=" + chapterPage + "&size=12", classroomId) : null, revision);
  const contextPoint = selection?.kind === "point" ? selection.id : selection?.kind === "question" ? questionPoint : null;
  const point = useGraphData<PointDetail>(contextPoint != null ? endpoint("/points/" + contextPoint) : null, revision);
  const questions = useGraphData<{ items: QuestionNode[]; total: number; page: number }>(contextPoint != null ?
    scoped("/teacher/questions?knowledge_point_id=" + contextPoint + "&page=" + questionPage + "&size=" + pageSize, classroomId) : null, revision);
  const question = useGraphData<GraphQuestion>(selection?.kind === "question" ? endpoint("/questions/" + encodeURIComponent(selection.id)) : null, revision);
  const graph = catalog?.data ?? emptyGraph;
  useEffect(() => {
    const id = reviewScope?.materialId;
    if (!id || panel !== "review" || !catalog?.data) return;
    // Old chapter/material bookmarks open the original dialog once. A deck can move
    // between chapters; only the current classroom's material identity is authoritative.
    setReviewScope({});
    history.replaceState({ ...history.state, initialReview: {} }, "");
    const deck = catalog.data.materials.find(m => m.id === id);
    if (deck && ["presentation", "pdf"].includes(deck.kind)) setAction({kind: "material", mode: "narration", id});
    else setBookmarkNotice("这份资料在当前班级无法审校。");
  }, [reviewScope, panel, catalog?.data]);
  const jobs = taskList?.data;
  const layout = useMemo(() => graphLayout(graph, branch, material?.data ?? null, jobs ?? [], point?.data,
    point?.data ? questions?.data?.items : undefined, question?.data),
    [graph, branch, material?.data, jobs, point?.data, questions?.data, question?.data]);
  const previousJobs = useRef<number[]>([]);
  useEffect(() => {
    if (!jobs) return;
    const active = jobs.filter(j => !j.status || j.status === "running" || j.status === "cancelling").map(taskNodeId);
    if (previousJobs.current.some(id => !active.includes(id))) setRevision(n => n + 1);
    previousJobs.current = active;
  }, [jobs]);
  function persist(viewport = view.current) {
    view.current = viewport;
    history.replaceState({ ...history.state, courseGraph: { classroomId, branch, selection, chapterPage, questionPoint, questionPage, viewport } }, "");
  }
  useEffect(() => { persist(); }, [classroomId, branch, selection, chapterPage, questionPoint, questionPage]);
  function focusOn(key: string) { setFocus(prev => ({ key, seq: (prev?.seq ?? 0) + 1 })); }
  function showPanel(next: Panel) {
    if (next !== "review" && reviewScope) {
      setBookmarkNotice("");
      setReviewScope(undefined);
      const state = { ...history.state };
      delete state.initialReview;
      history.replaceState(state, "");
    }
    setPanel(next);
  }
  function closePanel() {
    if (panel === "node") setSelection(null);
    if (panel === "review") reviewButton.current?.focus();
    if (panel === "tasks") taskButton.current?.focus();
    showPanel(panel !== "node" && selection ? "node" : null);
  }
  function togglePanel(next: "tasks" | "review", keyboard: boolean) {
    if (panel === next) { closePanel(); return; }
    showPanel(next);
    if (keyboard) requestAnimationFrame(() => inspector.current?.focus({preventScroll: true}));
  }
  function choose(kind: NumericKind, id: number) {
    showPanel("node"); setSelection({ kind, id });
    if (kind !== "point" || questionPoint !== id) setQuestionPage(1);
    setQuestionPoint(kind === "point" ? id : null);
    if (kind === "chapter" || kind === "material") {
      setBranch({ kind, id }); setChapterPage(1);
    } else if (kind === "course") setBranch(null);
    focusOn(nodeKey({ kind, id }));
  }
  function chooseQuestion(id: string) {
    setSelection({kind: "question", id}); showPanel("node"); focusOn(nodeKey({kind: "question", id}));
  }
  function searchSelect(s: Selection, chapterId?: number | null) {
    if (s.kind === "question") {
      setBranch(null); setQuestionPoint(null); setQuestionPage(1); chooseQuestion(s.id);
    } else {
      if (s.kind === "point") setBranch(chapterId == null ? null : {kind: "chapter", id: chapterId});
      choose(s.kind, s.id);
    }
  }
  function overview() {
    setSelection(null); setBranch(null); showPanel(null); setQuestionPoint(null); setQuestionPage(1); focusOn("overview");
  }
  function chooseTask(job: TaskSnapshot) {
    setBranch({kind: "material", id: job.material_id});
    choose("task", taskNodeId(job));
  }
  const deck = branch?.kind === "material" ? graph.materials.find(m => m.id === branch.id) : null;
  const chapter = branch?.kind === "chapter" ? graph.chapters.find(ch => ch.id === branch.id) : null;
  const currentCard = selection && layout.cards.find(c => c.key === nodeKey(selection));
  const selectedTitle = selection?.kind === "point" ? (point?.data?.title ?? currentCard?.title) : currentCard?.title;
  const deckTasks = deck ? jobs?.filter(j => j.material_id === deck.id) ?? [] : [];
  const task = selection?.kind === "task" ? deckTasks.find(j => taskNodeId(j) === selection.id) : undefined;
  function edit(kind: ContentAction["kind"], mode: ContentAction["mode"], id?: number | string, chapterId?: number) {
    setAction({ kind, mode, id, chapterId });
  }
  const chapterLookup = (id: number) => graph.chapters.find(ch => ch.id === id)?.title ?? "所属章节";
  let details: ReactNode;
  if (selection?.kind === "course") {
    details = <><div className="inspector-actions"><Button onClick={() => edit("chapter", "create")}><Plus/>新增章节</Button></div>
      <Relations title="课程章节" rows={graph.chapters} onSelect={id => choose("chapter", id)} empty="尚无章节"/></>;
  } else if (selection?.kind === "chapter" && chapter) {
    const chapterMaterials = graph.materials.filter(m => m.chapter_ids.includes(chapter.id));
    details = <><p className="inspector-meta">{graph.title}</p><div className="inspector-actions">
      <Button onClick={() => edit("material", "create", undefined, chapter.id)}><Upload/>上传资料</Button>
      <Button variant="outline" onClick={() => edit("point", "create", undefined, chapter.id)}><Plus/>添加知识点</Button>
      <Button variant="ghost" onClick={() => edit("chapter", "edit", chapter.id)}><Pencil/>编辑章节</Button>
    </div><Relations title={`教学资料 · ${chapterMaterials.length}`} rows={chapterMaterials} onSelect={id => choose("material", id)}/>
      {points?.data ? <><Relations title={`章节知识点 · ${points.data.total}`} rows={points.data.items} onSelect={id => choose("point", id)}/>
        {points.data.total > 12 && <div className="cg-pagination">
          <Button size="xs" variant="outline" disabled={points.data.page <= 1} onClick={() => setChapterPage(points.data!.page - 1)}>上一页</Button>
          <span>{points.data.page} / {Math.ceil(points.data.total / 12)}</span>
          <Button size="xs" variant="outline" disabled={points.data.page * 12 >= points.data.total} onClick={() => setChapterPage(points.data!.page + 1)}>下一页</Button>
        </div>}</> : points?.error ? <ErrorNotice message={points.error}/> : <Loading/>}</>;
  } else if (selection?.kind === "material" && deck) {
    const canNarrate = ["pdf", "presentation"].includes(deck.kind) && deck.status === "ready";
    details = <><p className="inspector-meta">{materialKinds[deck.kind] ?? deck.kind}{material?.data?.pages ? " · " + material.data.pages + " 页" : ""}</p>
      <div className="inspector-actions"><Button onClick={() => edit("material", "preview", deck.id)}><Eye/>查看资料</Button>
        <Button variant="outline" onClick={() => edit("material", "edit", deck.id)}><Pencil/>编辑资料</Button>
        {canNarrate && <Button variant="ghost" onClick={() => edit("material", "narration", deck.id)}><NotebookPen/>课程生成与审校</Button>}
      </div><Relations title="所属章节" rows={graph.chapters.filter(ch => deck.chapter_ids.includes(ch.id))} onSelect={id => choose("chapter", id)} empty="尚未归章"/>
      {material?.data ? <><Relations title="有页码依据的知识点" rows={material.data.points.map(p => ({ ...p, note: "第 " + pageRanges(p.pages ?? []) + " 页" }))}
        onSelect={id => choose("point", id)} empty="暂无可核对的课件页与知识点关联"/>
        {canNarrate && <MaterialOutputs detail={material.data} open={mode => edit("material", mode, deck.id)}/>}</> : material?.error ? <ErrorNotice message={material.error}/> : <Loading/>}
      {deckTasks.length > 0 && <Relations title="课件任务" rows={deckTasks.map(j => ({id: taskNodeId(j), title: jobTitle(j), note: taskStatus(j)}))}
        onSelect={id => choose("task", id)}/>}</>;
  } else if (selection?.kind === "point") {
    const p = point?.data;
    details = p ? <><p className="inspector-meta">{chapterLookup(p.chapter_id)}</p>
      <div className="inspector-actions"><ButtonLink href={`/teacher/content-list?tab=questions&point=${p.id}&pointName=${encodeURIComponent(p.title)}`}>
        查看关联题目（{p.questions}）<ChevronRight data-icon="inline-end" aria-hidden="true"/></ButtonLink>
        <Button variant="outline" onClick={() => edit("point", "edit", p.id)}><Pencil/>编辑知识点</Button></div>
      {questions?.data ? <><Relations title={`关联题目 · ${questions.data.total}`} rows={questions.data.items.map(q => ({ ...q, note: kinds[q.kind] }))}
        onSelect={chooseQuestion} empty="暂无关联题目"/>
        {questions.data.total > pageSize && <div className="cg-pagination" aria-label="关联题目翻页">
          <Button size="xs" variant="outline" disabled={questions.data.page <= 1} onClick={() => setQuestionPage(questions.data!.page - 1)}>上一页</Button>
          <span>{questions.data.page} / {Math.ceil(questions.data.total / pageSize)}</span>
          <Button size="xs" variant="outline" disabled={questions.data.page * pageSize >= questions.data.total} onClick={() => setQuestionPage(questions.data!.page + 1)}>下一页</Button>
        </div>}</> : questions?.error ? <ErrorNotice message={questions.error}/> : <Loading/>}
      <Relations title="课件来源" rows={p.sources.map(s => ({ id: s.material_id,
        title: graph.materials.find(m => m.id === s.material_id)?.title ?? "课件", note: "第 " + pageRanges(s.pages) + " 页" }))}
        onSelect={id => choose("material", id)} empty="暂无已确认的课件来源"/></> : point?.error ? <ErrorNotice message={point.error}/> : <Loading/>;
  } else if (selection?.kind === "question") {
    const q = question?.data;
    details = q ? <><p className="inspector-meta">{kinds[q.kind]} · {statuses[q.status]} · {q.source_type === "ai_generated" ? "AI 生成" : "导入"}</p>
      <div className="inspector-actions"><Button onClick={() => edit("question", "edit", q.id)}><Pencil/>编辑题目</Button></div>
      <section className="inspector-section"><h3>题干</h3><p className="cg-question-prompt">{q.prompt}</p></section>
      <Relations title="关联知识点" rows={q.points} onSelect={id => choose("point", id)} empty="尚未关联知识点"/>
      <Relations title="所属章节" rows={graph.chapters.filter(ch => q.chapter_ids.includes(ch.id))}
        onSelect={id => choose("chapter", id)} empty="尚未归章"/>
      <Relations title="题目来源资料" rows={q.sources.map(s => ({ id: s.material_id,
        title: graph.materials.find(m => m.id === s.material_id)?.title ?? "资料", note: s.pages.length ? "第 " + pageRanges(s.pages) + " 页" : undefined }))}
        onSelect={id => choose("material", id)} empty="暂无已确认的题目来源资料"/></> : question?.error ? <ErrorNotice message={question.error}/> : <Loading/>;
  } else if (deck && selection?.kind === "task") {
    const taskActions = <><Button size="sm" variant="outline" onClick={() => edit("material", "narration", deck.id)}><NotebookPen/>打开课件审校</Button>
      <Button size="sm" variant="outline" onClick={() => edit("material", "preview", deck.id)}><Eye/>查看资料</Button></>;
    details = <><Relations title="任务课件" rows={[deck]} onSelect={id => choose("material", id)}/>
      {task ? <TaskDetail job={task} material={deck.title} request={commands.request} actions={taskActions}/> : taskList?.error ? <ErrorNotice message={taskList.error}/> : !jobs ? <Loading/> :
        <><p className="inspector-meta">任务已离开执行队列，可到课件审校中查看结果。</p><div className="inspector-task-actions">{taskActions}</div></>}</>;
  } else if (deck && selection && (selection.kind === "audio" || selection.kind === "narration")) {
    const audio = selection.kind === "audio";
    const count = material?.data && (audio ? material.data.audio : material.data.narrations);
    details = <><Relations title="来源课件" rows={[deck]} onSelect={id => choose("material", id)}/>
      {count ? <><p className="inspector-meta">{count} 页{audio ? "可播放配音" : "讲解稿"}
        {!audio && !!material?.data?.drafts && ` · ${material.data.drafts} 页待审核`}</p>
        <div className="inspector-actions"><Button onClick={() => edit("material", audio ? "audio" : "narration", deck.id)}>
          {audio ? <Headphones/> : <NotebookPen/>}{audio ? "试听讲解音频" : "查看讲解与审校"}</Button></div></>
        : material?.error ? <ErrorNotice message={material.error}/> : material?.data ? <p className="inspector-empty">当前课件暂无该内容。</p> : <Loading/>}</>;
  }
  const panelName = panel === "review" ? "待审批" : panel === "tasks" ? "任务队列" : "节点详情";
  const Icon = panel === "review" ? ClipboardCheck : panel === "node" && selection ? nodeIcons[selection.kind] : ListTodo;
  return <><section className="cg-workspace" aria-label="课程知识图谱">
      <header className="cg-overlay-header">
        <div className="cg-heading"><h1>知识图谱</h1>{catalog?.data && <><p>{graph.title}</p>
          <span className="cg-stats">{graph.chapters.length} 章 · {graph.materials.length} 份资料</span></>}</div>
        <div className="cg-bar">{catalog?.data && <GraphSearch classroomId={classroomId} revision={revision} cards={layout.cards} select={searchSelect}/>}
        <Button ref={reviewButton} variant="outline" size="sm" aria-expanded={panel === "review"} aria-controls={panel === "review" ? inspectorId : undefined}
          onClick={e => togglePanel("review", e.detail === 0)}><ToolbarLabel icon={ClipboardCheck} label="待审批" count={pendingEntries}/></Button>
        <Button ref={taskButton} variant="outline" size="sm" aria-expanded={panel === "tasks"} aria-controls={panel === "tasks" ? inspectorId : undefined}
          onClick={e => togglePanel("tasks", e.detail === 0)}>
          <ToolbarLabel icon={ListTodo} label="任务队列" count={jobs?.length}/></Button>
        </div>
      </header>
      <div className={"cg-body" + (panel ? " cg-inspecting" : "")}>
        {catalog?.data ? <ReactFlowProvider><GraphCanvas layout={layout} selected={selectedKey} focus={selection?.kind === "question" && !question?.data ? null : focus}
          onSelect={c => c.kind === "question" ? chooseQuestion(c.id) : choose(c.kind, c.id)} initialViewport={view.current} onMove={persist} onOverview={overview}/></ReactFlowProvider>
          : <div className="cg-catalog-status">{catalog?.error ? <><ErrorNotice message={catalog.error}/><Button variant="outline" onClick={refresh}>重新加载</Button></> : <Loading/>}</div>}
        {panel && <aside id={inspectorId} className="cg-inspector" ref={inspector} tabIndex={-1} aria-label={panelName}
          onKeyDown={e => { if (e.key === "Escape" && !e.defaultPrevented && e.currentTarget.contains(e.target as Node)) { e.preventDefault(); closePanel(); } }}>
          <div className="cg-inspector-top"><span><Icon size={16}/>
            {panel === "node" && selection ? kindNames[selection.kind] : null}</span>
            <Button aria-label="关闭详情栏" size="icon-xs" variant="ghost" onClick={closePanel}><X/></Button></div>
          <h2>{panel === "node" && selection ? selectedTitle ?? kindNames[selection.kind] : panelName}</h2>
          {panel !== "review" && commands.feedback}
          {panel === "node" && details}
          {panel === "tasks" && (taskList?.error ? <ErrorNotice message={taskList.error}/> : !jobs ? <Loading/> :
            <TaskQueue jobs={jobs} titleOf={id => graph.materials.find(m => m.id === id)?.title ?? "课件"} onSelect={chooseTask} request={commands.request}/>)}
          {panel === "review" && <Suspense fallback={<Loading/>}>{bookmarkNotice && <p className="inspector-meta" role="status">{bookmarkNotice}</p>}
            <ContentReviewPanel classroomId={classroomId} revision={revision + reviewRevision}
              onOpenMaterial={(id, pageNo) => setAction({kind: "material", mode: "narration", id, pageNo})}/></Suspense>}
        </aside>}
      </div>
    </section>
    {action && <ContentActionDialog classroomId={classroomId} action={action} onClose={changed => {
      if (changed || action.mode === "narration" || action.mode === "audio") refresh();
      setAction(null);
    }}/>}
  </>;
}
