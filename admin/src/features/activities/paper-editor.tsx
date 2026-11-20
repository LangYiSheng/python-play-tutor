import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SelectField } from "@/components/select-field";
import type { Point, Question } from "@/lib/types";
import { kinds } from "@/features/questions/types";

interface Props {
  candidates: Question[]; questions: Question[]; points: Point[]; selected: string[];
  assessment: boolean; order: boolean; onChange: (ids: string[]) => void;
}

export function PaperEditor({candidates, questions, points, selected, assessment, order, onChange}: Props) {
  const [focused, setFocused] = useState<number>();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const rank = new Map(points.map((p,i) => [p.id, i]));
  const groups = new Map<number, Question[]>(points.map(p => [p.id, []]));
  groups.set(0, []);
  for (const q of candidates) {
    const ids = [...new Set(q.knowledge_point_ids.filter(id => rank.has(id)))];
    for (const id of ids.length ? ids : [0]) groups.get(id)!.push(q);
  }
  const active = focused !== undefined && groups.has(focused) ? focused : [...groups].find(([,qs]) => qs.length)?.[0] ?? 0;
  const pointOptions = [...points, ...(groups.get(0)!.length ? [{id:0,title:"未关联本章知识点"}] : [])];
  const selectedSet = new Set(selected);
  const byId = new Map(questions.map(q => [q.id,q]));
  const candidatesSet = new Set(candidates.map(q => q.id));
  const visible = (groups.get(active) ?? []).filter(q => (!kind || q.kind === kind) && q.title.toLowerCase().includes(search.trim().toLowerCase()));
  const limit = assessment ? 100 : 5000;
  function toggle(ids: string[], checked: boolean) {
    const affected = new Set(ids);
    onChange(checked ? [...new Set([...selected,...ids])] : selected.filter(id => !affected.has(id)));
  }
  function pointRank(id: string) {
    const ranks = byId.get(id)?.knowledge_point_ids.map(k => rank.get(k) ?? points.length) ?? [];
    return Math.min(points.length,...ranks);
  }
  if (order) {
    return <div className="paper-order"><div className="flex flex-wrap items-center gap-2"><strong className="mr-auto">作答顺序 · {selected.length} 题</strong>
      <Button type="button" variant="outline" disabled={selected.length < 2} onClick={() => onChange([...selected].sort((a,b) =>
        (byId.get(a)?.title ?? a).localeCompare(byId.get(b)?.title ?? b,"zh-CN",{numeric:true})))}>按题目名称排序</Button>
      <Button type="button" variant="outline" disabled={selected.length < 2} onClick={() => onChange([...selected].sort((a,b) => pointRank(a)-pointRank(b)))}>按知识点排序</Button></div>
      {selected.length ? <ScrollArea label="作答顺序"><ol className="paper-rows">{selected.map((id,i) => <li className="paper-row" key={id}>
        <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">{i+1}.</span>
        <span>{byId.get(id)?.title ?? "题目已不可用"}</span>
        <small>{points[pointRank(id)]?.title ?? "未关联本章知识点"}</small>
        {!candidatesSet.has(id) && <Button type="button" variant="outline" onClick={() => toggle([id],false)}>移除</Button>}
      </li>)}</ol></ScrollArea> : <p className="hint">请先在「按知识点选题」中勾选题目。</p>}
    </div>;
  }
  const count = visible.filter(q => selectedSet.has(q.id)).length;
  return <div className="paper-picker"><section><div className="flex items-center justify-between gap-2"><strong>本章知识点</strong><small>已选 / 可选</small></div>
    <ScrollArea label="本章知识点"><div className="knowledge-rows">
    {pointOptions.map(p => { const rows = groups.get(p.id)!; return <button className="editor-list-item" type="button" key={p.id} aria-pressed={p.id === active}
      onClick={() => { setFocused(p.id); setSearch(""); setKind(""); }}>{p.title}<small>{rows.filter(q=>selectedSet.has(q.id)).length} / {rows.length}</small></button>; })}
    </div></ScrollArea></section><section><div className="flex flex-wrap items-center justify-between gap-2"><strong>{pointOptions.find(p=>p.id === active)?.title ?? "本章题库"}</strong><small>题单共 {selected.length} 题</small></div>
    <div className="flex gap-2"><Input aria-label="搜索当前知识点题目" placeholder="搜索当前知识点题目" value={search} onChange={e=>{ e.stopPropagation(); setSearch(e.target.value); }} />
      <SelectField aria-label="筛选题型" placeholder="全部题型" value={kind} onValueChange={setKind}><option value="">全部题型</option>
        {Object.entries(kinds).filter(([k])=>!assessment || k!=="interactive").map(([k,v])=><option key={k} value={k}>{v}</option>)}</SelectField></div>
    <label className="flex items-center gap-2"><input type="checkbox" ref={el=>{ if(el) el.indeterminate = count > 0 && count < visible.length; }}
      checked={visible.length > 0 && count === visible.length} disabled={!visible.length || selected.length + visible.length-count > limit}
      onChange={e=>toggle(visible.map(q=>q.id),e.target.checked)} />全选当前 {visible.length} 题</label>
    <ScrollArea label="可选题目" key={active}><div className="paper-rows">{visible.map(q=><label className="paper-row cursor-pointer hover:bg-muted" key={q.id}>
      <input type="checkbox" aria-label={q.title} checked={selectedSet.has(q.id)} disabled={!selectedSet.has(q.id) && selected.length>=limit}
        onChange={e=>toggle([q.id],e.target.checked)} /><span>{q.title}</span><small>{kinds[q.kind]}</small></label>)}
      {!visible.length && <p className="hint p-2">当前范围没有可选题目。</p>}</div></ScrollArea>
    </section></div>;
}
