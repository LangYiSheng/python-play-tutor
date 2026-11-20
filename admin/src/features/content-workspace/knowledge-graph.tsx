import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ReactFlowProvider, type Viewport } from "@xyflow/react";
import { ChevronRight, Eye, Headphones, ListTodo, NotebookPen, Pencil, Plus, Search, X } from "lucide-react";
import { Empty, ErrorNotice, Loading, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage, scoped } from "@/lib/api";
import { ContentActionDialog, type ContentAction } from "./action-dialog";
import { GraphCanvas, nodeIcons } from "./graph-canvas";
import { graphLayout, jobStage, jobTitle, materialKinds, nodeKey, pageRanges, type Branch, type GraphData,
  type Job, type MaterialDetail, type PointDetail, type PointNode, type Selection } from "./graph-layout";
import "./knowledge-graph.css";

// Keep the last successful snapshot while refreshing the same URL. Switching object or
// classroom immediately invalidates it, including during the render before the new request.
function useGraphData<T>(url: string | null, revision: number, poll = 0) {
  const [result, setResult] = useState<{ url: string; data?: T; error?: string }>();
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let timer: number;
    async function load(path: string) {
      try {
        const data = await api.get<T>(path, controller.signal);
        if (!controller.signal.aborted) setResult({ url: path, data });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ url: path, error: errorMessage(error) });
      } finally {
        if (poll && !controller.signal.aborted) timer = window.setTimeout(() => void load(path), poll);
      }
    }
    void load(url);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [url, revision, poll]);
  return result?.url === url ? result : undefined;
}

type GraphLocation = { classroomId: number; selection: Selection | null; branch: Branch | null; chapterPage: number; viewport?: Viewport };
const kindNames = { course: "课程", chapter: "章节", material: "教学资料", point: "知识点",
  narration: "讲解稿", audio: "讲解音频", task: "生成任务" };

function Relations({ title, rows, onSelect, empty }: {
  title: string; rows: { id: number; title: string; note?: string }[]; onSelect: (id: number) => void; empty?: string;
}) {
  return <section className="cg-relations"><h3>{title}</h3>{rows.length ? <ul>{rows.map(r => <li key={r.id}>
    <button onClick={() => onSelect(r.id)}><span>{r.title}{r.note && <small>{r.note}</small>}</span><ChevronRight size={14}/></button>
  </li>)}</ul> : <p>{empty ?? "暂无关联"}</p>}</section>;
}

export function KnowledgeGraph({ classroomId }: { classroomId: number }) {
  return <GraphPage key={classroomId} classroomId={classroomId}/>;
}
function GraphPage({ classroomId }: { classroomId: number }) {
  const saved = useRef<GraphLocation | undefined>(history.state?.courseGraph?.classroomId === classroomId ? history.state.courseGraph : undefined);
  const [selection, setSelection] = useState<Selection | null>(saved.current?.selection ?? null);
  const [branch, setBranch] = useState<Branch | null>(saved.current?.branch ?? null);
  const [chapterPage, setChapterPage] = useState(saved.current?.chapterPage ?? 1);
  const [focus, setFocus] = useState<{ key: string; seq: number } | null>(null);
  const [queue, setQueue] = useState(false);
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState<ContentAction | null>(null);
  const view = useRef(saved.current?.viewport);
  const refresh = () => setRevision(n => n + 1);
  const endpoint = (suffix: string) => scoped("/teacher/course-graph" + suffix, classroomId);
  const catalog = useGraphData<GraphData>(endpoint(""), revision);
  const taskList = useGraphData<Job[]>(endpoint("/tasks"), revision, 8000);
  const material = useGraphData<MaterialDetail>(branch?.kind === "material" ? endpoint("/materials/" + branch.id) : null, revision);
  const points = useGraphData<{ items: PointNode[]; total: number; page: number }>(branch?.kind === "chapter"
    ? scoped("/teacher/knowledge-points?chapter_id=" + branch.id + "&page=" + chapterPage + "&size=12", classroomId) : null, revision);
  const point = useGraphData<PointDetail>(selection?.kind === "point" ? endpoint("/points/" + selection.id) : null, revision);
  const graph = catalog?.data;
  const jobs = taskList?.data;
  const layout = useMemo(() => graph ? graphLayout(graph, branch, points?.data?.items ?? [], material?.data ?? null, jobs ?? [], point?.data) : null,
    [graph, branch, points?.data, material?.data, jobs, point?.data]);
  const previousJobs = useRef<number[]>([]);
  useEffect(() => {
    if (!jobs) return;
    const active = jobs.map(j => j.material_id);
    if (previousJobs.current.some(id => !active.includes(id))) setRevision(n => n + 1);
    previousJobs.current = active;
  }, [jobs]);
  function persist(viewport = view.current) {
    view.current = viewport;
    history.replaceState({ ...history.state, courseGraph: { classroomId, branch, selection, chapterPage, viewport } }, "");
  }
  useEffect(() => { persist(); }, [classroomId, branch, selection, chapterPage]);
  function focusOn(key: string) { setFocus(prev => ({ key, seq: (prev?.seq ?? 0) + 1 })); }
  function choose(kind: Selection["kind"], id: number) {
    setQuery(""); setQueue(false); setSelection({ kind, id });
    if (kind === "chapter" || kind === "material") {
      setBranch({ kind, id }); setChapterPage(1);
    } else if (kind === "course") setBranch(null);
    focusOn(nodeKey({ kind, id }));
  }
  function overview() {
    setSelection(null); setBranch(null); setQueue(false); setQuery(""); focusOn("overview");
  }
  if (!graph || !layout) return <><PageHeader title="知识图谱"/>{catalog?.error
    ? <><ErrorNotice message={catalog.error}/><Button variant="outline" onClick={refresh}>重新加载</Button></> : <Loading/>}</>;
  const deck = branch?.kind === "material" ? graph.materials.find(m => m.id === branch.id) : null;
  const chapter = branch?.kind === "chapter" ? graph.chapters.find(ch => ch.id === branch.id) : null;
  const currentCard = selection && layout.cards.find(c => c.key === nodeKey(selection));
  const selectedTitle = selection?.kind === "point" ? (point?.data?.title ?? currentCard?.title) : currentCard?.title;
  const task = deck && jobs?.find(j => j.material_id === deck.id);
  const searchText = query.trim().toLocaleLowerCase();
  const matches = searchText ? layout.cards.filter(c => c.title.toLocaleLowerCase().includes(searchText)).slice(0, 12) : [];
  function edit(kind: ContentAction["kind"], mode: ContentAction["mode"], id?: number, chapterId?: number) {
    setAction({ kind, mode, id, chapterId });
  }
  const chapterLookup = (id: number) => graph.chapters.find(ch => ch.id === id)?.title ?? "所属章节";
  let details: ReactNode;
  if (selection?.kind === "course") {
    details = <><Button variant="outline" onClick={() => edit("chapter", "create")}><Plus/>新增章节</Button>
      <Relations title="课程章节" rows={graph.chapters} onSelect={id => choose("chapter", id)} empty="尚无章节"/></>;
  } else if (selection?.kind === "chapter" && chapter) {
    const chapterMaterials = graph.materials.filter(m => m.chapter_ids.includes(chapter.id));
    details = <><p className="cg-meta">{graph.title}</p><div className="cg-actions">
      <Button variant="outline" onClick={() => edit("chapter", "edit", chapter.id)}><Pencil/>编辑章节</Button>
      <Button variant="outline" onClick={() => edit("point", "create", undefined, chapter.id)}><Plus/>知识点</Button>
      <Button variant="outline" onClick={() => edit("material", "create", undefined, chapter.id)}><Plus/>资料</Button>
    </div><Relations title={`教学资料 · ${chapterMaterials.length}`} rows={chapterMaterials} onSelect={id => choose("material", id)}/>
      {points?.data ? <><Relations title={`章节知识点 · ${points.data.total}`} rows={points.data.items} onSelect={id => choose("point", id)}/>
        {points.data.total > 12 && <div className="cg-pagination">
          <Button size="xs" variant="outline" disabled={points.data.page <= 1} onClick={() => setChapterPage(points.data!.page - 1)}>上一页</Button>
          <span>{points.data.page} / {Math.ceil(points.data.total / 12)}</span>
          <Button size="xs" variant="outline" disabled={points.data.page * 12 >= points.data.total} onClick={() => setChapterPage(points.data!.page + 1)}>下一页</Button>
        </div>}</> : points?.error ? <ErrorNotice message={points.error}/> : <Loading/>}</>;
  } else if (selection?.kind === "material" && deck) {
    const canNarrate = ["pdf", "presentation"].includes(deck.kind) && deck.status === "ready";
    details = <><p className="cg-meta">{materialKinds[deck.kind] ?? deck.kind}{material?.data?.pages ? " · " + material.data.pages + " 页" : ""}</p>
      <div className="cg-actions"><Button onClick={() => edit("material", "preview", deck.id)}><Eye/>查看资料</Button>
        <Button variant="outline" onClick={() => edit("material", "edit", deck.id)}><Pencil/>编辑资料</Button>
        {canNarrate && <Button variant="outline" onClick={() => edit("material", "narration", deck.id)}><NotebookPen/>课程生成与审校</Button>}
      </div><Relations title="所属章节" rows={graph.chapters.filter(ch => deck.chapter_ids.includes(ch.id))} onSelect={id => choose("chapter", id)} empty="尚未归章"/>
      {material?.data ? <><Relations title="有页码依据的知识点" rows={material.data.points.map(p => ({ ...p, note: "第 " + pageRanges(p.pages ?? []) + " 页" }))}
        onSelect={id => choose("point", id)} empty="暂无可核对的课件页与知识点关联"/>
        {canNarrate && <section className="cg-relations"><h3>讲解与配音</h3>
          <button onClick={() => edit("material", "narration", deck.id)}><NotebookPen size={15}/>逐页讲解稿<span>{material.data.narrations} 页</span></button>
          <button disabled={!material.data.audio} onClick={() => edit("material", "audio", deck.id)}><Headphones size={15}/>可播放配音<span>{material.data.audio} 页</span></button>
        </section>}</> : material?.error ? <ErrorNotice message={material.error}/> : <Loading/>}</>;
  } else if (selection?.kind === "point") {
    const p = point?.data;
    details = p ? <><p className="cg-meta">{chapterLookup(p.chapter_id)}</p>
      <div className="cg-actions"><a className="cg-primary-link" href={`/teacher/content-list?tab=questions&point=${p.id}&pointName=${encodeURIComponent(p.title)}`}>
        查看关联题目（{p.questions}）<ChevronRight size={15}/></a>
        <Button variant="outline" onClick={() => edit("point", "edit", p.id)}><Pencil/>编辑知识点</Button></div>
      <Relations title="课件来源" rows={p.sources.map(s => ({ id: s.material_id,
        title: graph.materials.find(m => m.id === s.material_id)?.title ?? "课件", note: "第 " + pageRanges(s.pages) + " 页" }))}
        onSelect={id => choose("material", id)} empty="暂无已确认的课件来源"/></> : point?.error ? <ErrorNotice message={point.error}/> : <Loading/>;
  } else if (deck && selection) {
    details = <><p className="cg-meta">来源课件 · {deck.title}</p>
      {selection.kind === "task" && <p>{task ? jobStage(task) + (task.total ? ` · ${task.done} / ${task.total}` : "") : "当前任务已结束"}</p>}
      <Button onClick={() => edit("material", selection.kind === "audio" ? "audio" : "narration", deck.id)}>
        {selection.kind === "audio" ? "试听讲解音频" : "查看讲解与审校"}</Button></>;
  }
  const Icon = selection ? nodeIcons[selection.kind] : ListTodo;
  return <><PageHeader title="知识图谱" description={graph.title}/>
    <section className="cg-workspace" aria-label="课程知识图谱">
      <header className="cg-bar"><div className="cg-search"><Search size={16}/><Input aria-label="搜索图谱节点" placeholder="查找章节或资料" value={query}
        onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Escape") setQuery(""); if (e.key === "Enter" && matches[0]) choose(matches[0].kind, matches[0].id); }}/>
        {searchText && <div className="cg-results">{matches.length ? matches.map(c => <button key={c.key} onClick={() => choose(c.kind, c.id)}>
          <small>{kindNames[c.kind]}</small>{c.title}</button>) : <p>未找到匹配节点</p>}</div>}</div>
        <span className="cg-stats">{graph.chapters.length} 章 · {graph.materials.length} 份资料</span>
        <Button variant={queue ? "secondary" : "outline"} size="sm" onClick={() => setQueue(!queue)}><ListTodo/>任务队列{jobs?.length ? `（${jobs.length}）` : ""}</Button>
      </header>
      <div className={"cg-body" + (selection || queue ? " cg-inspecting" : "")}>
        <ReactFlowProvider><GraphCanvas layout={layout} selected={selection ? nodeKey(selection) : ""} focus={focus}
          onSelect={c => choose(c.kind, c.id)} initialViewport={view.current} onMove={persist} onOverview={overview}/></ReactFlowProvider>
        {(selection || queue) && <aside className="cg-inspector" aria-label={queue ? "任务队列" : "节点详情"}>
          <div className="cg-inspector-top"><span>{queue ? <ListTodo size={16}/> : <Icon size={16}/>}
            {queue ? "生成任务" : kindNames[selection!.kind]}</span><Button aria-label="关闭详情栏" size="icon-xs" variant="ghost"
            onClick={() => {setQueue(false); setSelection(null);}}><X/></Button></div>
          <h2>{queue ? "任务队列" : selectedTitle ?? kindNames[selection!.kind]}</h2>
          {queue ? taskList?.error ? <ErrorNotice message={taskList.error}/> : !jobs ? <Loading/> : jobs.length ?
            <Relations title="进行中" rows={jobs.map(j => ({id: j.material_id, title: graph.materials.find(m => m.id === j.material_id)?.title ?? "资料",
              note: jobTitle(j) + " · " + jobStage(j) + (j.total ? ` · ${j.done} / ${j.total}` : "")}))} onSelect={id => choose("material", id)}/> :
            <Empty title="当前没有进行中的生成任务"/> : details}
        </aside>}
      </div>
    </section>
    {action && <ContentActionDialog classroomId={classroomId} action={action} onClose={changed => {
      if (changed || action.mode === "narration" || action.mode === "audio") refresh();
      setAction(null);
    }}/>}
  </>;
}
