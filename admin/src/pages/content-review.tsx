import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { Empty, ErrorNotice, Loading } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ContentActionDialog, type ContentAction } from "@/features/content-workspace/action-dialog";
import { DraftDialog, DraftList, key, title, types, type Action, type Row } from "@/features/content-workspace/review-drafts";
import { ChapterApproval, GroupList, kindLabel, type Chapter, type Group, type Kind, type Material } from "@/features/content-workspace/review-groups";
import { api, errorMessage } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import "@/features/content-workspace/review-panel.css";

type Page<T> = { items: T[]; total: number; page: number; item_total?: number; chapter_title?: string; material_title?: string };
type Props = {
  classroomId: number;
  initialChapterId?: number | null;
  initialMaterialId?: number | null;
  onChanged?: () => void;
};

export function ContentReviewPanel(props: Props) {
  return <ReviewQueue key={props.classroomId} {...props}/>;
}

function ReviewQueue({ classroomId, initialChapterId, initialMaterialId, onChanged }: Props) {
  const [chapter, setChapter] = useState<Group | null>(() => initialChapterId == null ? null : { id: initialChapterId, name: "" });
  const [material, setMaterial] = useState<Group | null>(() => !chapter || initialMaterialId == null ? null : { id: initialMaterialId, name: "" });
  const [kind, setKind] = useState<Kind>("all"), [size, setSize] = useState(10);
  const [pages, setPages] = useState({ chapters: 1, materials: 1, drafts: 1 });
  const [selected, setSelected] = useState<Row[]>([]), [bulk, setBulk] = useState(false);
  const [chapterApproval, setChapterApproval] = useState<Group | null>(null);
  const [active, setActive] = useState<Row | null>(null), [editor, setEditor] = useState<ContentAction | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const inFlight = useRef(false);
  const scopeNav = useRef<HTMLElement>(null), focusScope = useRef(false);
  const base = `/teacher/classrooms/${classroomId}/content-review`;
  const level = material ? "drafts" : chapter ? "materials" : "chapters";
  const params = new URLSearchParams({ page: String(pages[level]), size: String(size) });
  if (kind !== "all") params.set("kind", kind);
  const chapters = useResource<Page<Chapter>>(level === "chapters" ? `${base}/groups?${params}` : null);
  const materials = useResource<Page<Material>>(level === "materials" ? `${base}/groups/${chapter!.id}/materials?${params}` : null);
  const drafts = useResource<Page<Row>>(level === "drafts" ? `${base}?${params}&chapter_id=${chapter!.id}&material_id=${material!.id}` : null);
  const current = level === "chapters" ? chapters : level === "materials" ? materials : drafts;
  const chapterName = current.data?.chapter_title || chapter?.name || (chapter?.id === 0 ? "未归章" : "所选章节");
  const materialName = drafts.data?.material_title || material?.name || (material?.id === 0 ? "无来源资料" : "所选资料");
  const pageCount = Math.max(1, Math.ceil((current.data?.total ?? 0) / size));
  const currentPage = current.data?.page ?? 1;
  const pendingCount = level === "drafts" ? drafts.data?.total : current.data?.item_total;

  useEffect(() => {
    if (focusScope.current) { scopeNav.current?.focus({ preventScroll: true }); focusScope.current = false; }
  }, [chapter, material]);

  function navigate(nextChapter: Group | null, nextMaterial: Group | null) {
    focusScope.current = true;
    if (nextChapter?.id !== chapter?.id) {
      setSelected([]);
      setPages(old => ({ ...old, materials: 1, drafts: 1 }));
    } else if (nextMaterial) {
      setPages(old => ({ ...old, drafts: 1 }));
    }
    setChapter(nextChapter); setMaterial(nextMaterial); setError(""); setMessage("");
  }

  function reload() { setSelected([]); setError(""); current.reload(); onChanged?.(); }
  function reviewed(count: number, accept = true) {
    setMessage(`已${accept ? "通过" : "退回"} ${count} 项`);
    setActive(null); setBulk(false); setChapterApproval(null); reload();
  }
  function toggle(rows: Row[], checked: boolean) {
    const next = new Map(selected.map(row => [key(row), row]));
    rows.forEach(row => { if (checked) next.set(key(row), row); else next.delete(key(row)); });
    if (next.size > 100) { setError("一次最多选择 100 项。整章可使用「按章通过」。"); return; }
    setError(""); setSelected([...next.values()]);
  }
  const decide: Action = async (items, accept, text) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setMessage(""); setError("");
    try {
      const result = await api.post<{count: number}>(base + "/decisions", {
        decision: accept ? "accept" : "reject", items: items.map(({kind, id, revision}) => ({kind, id, revision})), text,
      });
      reviewed(result.count, accept);
    } catch (e) { setError(errorMessage(e)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const emptyTitle = level === "drafts" ? "该资料当前没有符合条件的待审草稿"
    : level === "materials" ? "本章当前没有符合条件的待审草稿"
    : kind === "all" ? "当前班级没有待审批内容" : "该类型暂无待审批内容";

  return <div className="review-panel">
    <nav aria-label="审批范围" className="review-scope" ref={scopeNav} tabIndex={-1}>
      {chapter ? <><button type="button" onClick={() => navigate(null, null)}>全部章节</button>
        <ChevronRight aria-hidden size={13}/>
        {material ? <><button type="button" onClick={() => navigate({ ...chapter, name: chapterName }, null)}>{chapterName}</button>
          <ChevronRight aria-hidden size={13}/><strong aria-current="page">{materialName}</strong></> : <strong aria-current="page">{chapterName}</strong>}
      </> : <strong aria-current="page">全部章节</strong>}
    </nav>
    <div className="review-toolbar">
      <SelectField aria-label="待审内容类型" value={kind} onValueChange={v => {
        setKind(v as Kind); setPages({ chapters: 1, materials: 1, drafts: 1 }); setSelected([]); setMessage(""); setError("");
      }}>
        {Object.entries(kindLabel).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </SelectField>
      <Button variant="ghost" size="icon-sm" aria-label="刷新待审批" onClick={() => { setMessage(""); reload(); }}><RefreshCw /></Button>
      {chapter && level === "materials" && !!materials.data?.total && <Button variant="outline" size="sm" className="ml-auto"
        onClick={() => setChapterApproval({ ...chapter, name: chapterName })}>按章通过</Button>}
    </div>
    {selected.length > 0 && <div className="review-selection">
      <span>本章已选 {selected.length} 项</span>
      <Button size="xs" onClick={() => { setError(""); setBulk(true); }}>通过所选 {selected.length} 项</Button>
      <Button size="xs" variant="ghost" onClick={() => setSelected([])}>清除选择</Button>
    </div>}
    <ErrorNotice message={current.error || (!active && !bulk ? error : "")} />
    {message && <p className="review-feedback" role="status">{message}</p>}
    {current.loading ? <Loading /> : current.error ? null : !current.data?.total ? <Empty title={emptyTitle} />
      : <>
        {chapters.data && level === "chapters" && <GroupList level="章节" rows={chapters.data.items.map(row => ({ ...row, id: row.chapter_id, name: row.chapter_title }))}
          open={row => navigate(row, null)} approve={setChapterApproval} />}
        {materials.data && level === "materials" && <GroupList level="资料" rows={materials.data.items.map(row => ({ ...row, id: row.material_id, name: row.material_title }))}
          open={row => navigate(chapter, row)} />}
        {drafts.data && level === "drafts" && <DraftList rows={drafts.data.items} selected={selected} toggle={toggle}
          review={row => { setError(""); setActive(row); }} />}
        <div className="review-pagination">
          {pendingCount !== undefined && <small>共 {pendingCount} 项待审</small>}
          {(current.data.total > 10 || size !== 10) && <>
            <SelectField aria-label="每页条数" value={size}
              onValueChange={n => { setSize(Number(n)); setPages({ chapters: 1, materials: 1, drafts: 1 }); }}>
              {[10,25,50,100].map(n => <option key={n} value={n}>{n} 项/页</option>)}
            </SelectField>
            <div className="review-page-buttons">
              <Button variant="outline" size="icon-sm" aria-label="上一页" disabled={currentPage <= 1}
                onClick={() => setPages(old => ({ ...old, [level]: currentPage - 1 }))}><ChevronLeft/></Button>
              <span>{currentPage} / {pageCount}</span>
              <Button variant="outline" size="icon-sm" aria-label="下一页" disabled={currentPage >= pageCount}
                onClick={() => setPages(old => ({ ...old, [level]: currentPage + 1 }))}><ChevronRight/></Button>
            </div>
          </>}
        </div>
      </>}
    {active && <DraftDialog key={key(active)} row={active} classroomId={classroomId} decide={decide} busy={busy} error={error}
      close={() => { setActive(null); setError(""); }} edit={materialId => {
        setEditor(materialId ? { kind: "material", mode: "narration", id: materialId, pageNo: active.page_no } : {kind: "question", mode: "edit", id: active.id});
        setActive(null); setError("");
      }} />}
    {editor && <ContentActionDialog classroomId={classroomId} action={editor} onClose={saved => { setEditor(null); if (saved || editor.mode === "narration") reload(); }} />}
    {chapterApproval && <ChapterApproval base={base} chapter={chapterApproval} kind={kind}
      close={() => setChapterApproval(null)} applied={count => reviewed(count)} />}
    {bulk && <Dialog open onOpenChange={open => { if (!open && !busy) { setBulk(false); setError(""); } }}>
      <DialogContent><DialogHeader><DialogTitle>通过所选 {selected.length} 项草稿？</DialogTitle>
        <DialogDescription>{chapterName} · 题目将设为可用，讲解稿将变为已接受。</DialogDescription></DialogHeader>
        <ul className="max-h-60 space-y-1 overflow-auto text-sm">{selected.map(row =>
          <li key={key(row)}>{types[row.kind]} · {title(row)}{row.kind === "question" && row.material_title ? ` · ${row.material_title}` : ""}</li>)}</ul>
        <ErrorNotice message={error} />
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => { setBulk(false); setError(""); }}>取消</Button>
          <Button disabled={busy} onClick={() => void decide(selected, true)}>确认通过 {selected.length} 项</Button></DialogFooter>
      </DialogContent></Dialog>}
  </div>;
}
