import { useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { scoped } from "@/lib/api";
import { useGraphData } from "./use-graph-data";
import type { Card, Selection } from "./graph-layout";

const filters = { all: "全部", chapter: "章节", material: "资料", point: "知识点", question: "题目" };
type SearchKind = Exclude<keyof typeof filters, "all">;
type Hit = { kind: SearchKind; id: string | number; title: string; chapter_id?: number | null };
const size = 10;

export function GraphSearch({ classroomId, revision, cards, select }: {
  classroomId: number; revision: number; cards: Card[]; select: (s: Selection, chapterId?: number | null) => void;
}) {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<keyof typeof filters>("all");
  const [page, setPage] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const term = text.trim();
  const isOpen = !!term;
  useEffect(() => {
    if (!term) { setSearch(""); return; }
    const timer = window.setTimeout(() => setSearch(term), 180);
    return () => clearTimeout(timer);
  }, [term]);
  function close() { setText(""); setSearch(""); setPage(1); setKind("all"); }
  useEffect(() => {
    if (!isOpen) return;
    const outside = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [isOpen]);
  const params = new URLSearchParams({ search, kind, page: String(page), size: String(size) });
  const result = useGraphData<{ items: Hit[]; page: number; total: number }>(search && search === term
    ? scoped("/teacher/course-graph/search?" + params, classroomId) : null, revision);
  const found = result?.data;
  const resident = kind === "all" && page === 1 && term && found ? cards.filter(c =>
    (c.kind === "course" || c.kind === "audio" || c.kind === "narration" || c.kind === "task") &&
    c.title.toLocaleLowerCase().includes(term.toLocaleLowerCase())) : [];
  function pick(s: Selection, chapterId?: number | null) { close(); select(s, chapterId); }
  function hitToSelection(hit: Hit): Selection {
    return hit.kind === "question" ? {kind: hit.kind, id: String(hit.id)} : {kind: hit.kind, id: Number(hit.id)};
  }
  return <div className="cg-search" ref={box} onBlur={e => {
    if (e.relatedTarget && !box.current?.contains(e.relatedTarget)) close();
  }} onKeyDown={e => {
    if (e.key === "Escape") { e.preventDefault(); close(); input.current?.focus(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rows = Array.from(box.current?.querySelectorAll<HTMLButtonElement>(".cg-search-hit") ?? []);
      if (!rows.length) return;
      e.preventDefault();
      const idx = rows.indexOf(document.activeElement as HTMLButtonElement);
      const direction = e.key === "ArrowDown" ? 1 : -1;
      const next = idx < 0 ? (direction > 0 ? 0 : rows.length - 1) : (idx + direction + rows.length) % rows.length;
      rows[next].focus();
    }
  }}><Search size={16}/><Input ref={input} aria-label="搜索图谱节点" aria-controls={term ? id : undefined}
    placeholder="查找课程内容" maxLength={240} value={text} onChange={e => { setText(e.target.value); setPage(1); }}
    onKeyDown={e => { if (e.key === "Enter") box.current?.querySelector<HTMLButtonElement>(".cg-search-hit")?.click(); }}/>
    {term && <div className="cg-results" id={id} role="region" aria-label="课程搜索结果">
      <div className="cg-search-filters" role="group" aria-label="搜索范围">
        {(Object.keys(filters) as (keyof typeof filters)[]).map(k => <button type="button" key={k}
          aria-pressed={kind === k} onClick={() => { setKind(k); setPage(1); }}>{filters[k]}</button>)}
      </div>
      {result?.error ? <p role="alert">{result.error}</p> : !found ? <p role="status">正在查找…</p> : <>
        {found.items.map(hit => <button type="button" className="cg-search-hit" key={hit.kind + "-" + hit.id}
          onClick={() => pick(hitToSelection(hit), hit.chapter_id)}><small>{filters[hit.kind]}</small>{hit.title}</button>)}
        {resident.map(card => <button type="button" className="cg-search-hit" key={card.key} onClick={() => pick(card)}>
          <small>当前图谱</small>{card.title}</button>)}
        {!found.total && !resident.length && <p>未找到匹配内容</p>}
        {found.total > size && <div className="cg-pagination" aria-label="搜索结果翻页">
          <Button size="xs" variant="outline" disabled={found.page <= 1} onClick={() => setPage(found.page - 1)}>上一页</Button>
          <span>{found.page} / {Math.ceil(found.total / size)} · 共 {found.total} 项</span>
          <Button size="xs" variant="outline" disabled={found.page * size >= found.total} onClick={() => setPage(found.page + 1)}>下一页</Button>
        </div>}
      </>}
    </div>}
  </div>;
}
