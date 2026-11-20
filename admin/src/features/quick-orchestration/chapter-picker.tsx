import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, ExternalLink, RefreshCw } from "lucide-react";
import { Empty, ErrorNotice, TableSearch } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { CatalogChapter, ChapterSelection, NamedItem } from "./contracts";
import { withSelectedPoints } from "./question-plan";
import { maxChapters } from "./selection-validation";

type ContentOption = NamedItem & { available?: boolean };
function ContentChoices({ title, options, selected, empty, searchable, onChange }: {
  title: string;
  options: ContentOption[];
  selected: string[];
  empty: string;
  searchable?: boolean;
  onChange: (ids: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const visible = options.filter(item => item.title.toLowerCase().includes(needle));
  const available = visible.filter(item => item.available !== false).map(item => item.id);
  const missing = selected.filter(id => !options.some(row => row.id === id));
  const remaining = available.filter(id => !selected.includes(id));
  return <fieldset className="min-w-0">
    <legend className="text-sm font-semibold">{title} <span className="font-normal text-muted-foreground">已选 {selected.length}</span></legend>
    {searchable && options.length > 6 && <div className="mt-2">
      <TableSearch label="搜索本章知识点" placeholder="搜索本章知识点" value={filter} onValueChange={setFilter} />
    </div>}
    {options.length > 1 && <div className="mb-1 flex gap-1">
      <Button size="xs" variant="link" disabled={!remaining.length}
        onClick={() => onChange([...selected, ...remaining])}>{needle ? "选中匹配项" : "全选"}{title}</Button>
      <Button size="xs" variant="link" disabled={!available.some(id => selected.includes(id))}
        onClick={() => onChange(selected.filter(id => !available.includes(id)))}>{needle ? "取消匹配项" : "清空"}{title}</Button>
    </div>}
    <div className="mt-2 grid max-h-64 gap-1 overflow-auto">
      {visible.map(row => {
        const checked = selected.includes(row.id);
        return <label key={row.id} className="flex items-start gap-2 rounded px-1 py-1.5 hover:bg-muted/40">
          <input type="checkbox" className="mt-0.5 shrink-0" checked={checked} disabled={!checked && row.available === false}
            onChange={() => onChange(checked ? selected.filter(id => id !== row.id) : [...selected, row.id])} />
          <span className="break-words">{row.title}{row.available === false && <small className="ml-1 text-muted-foreground">暂不可用</small>}</span>
        </label>;
      })}
      {missing.map(id => <label key={id} className="flex items-center gap-2 py-1">
        <input type="checkbox" checked onChange={() => onChange(selected.filter(item => item !== id))} />
        已移出本章，取消勾选即可移除
      </label>)}
      {!visible.length && <p className="hint">{needle ? "没有匹配的知识点。" : empty}</p>}
    </div>
  </fieldset>;
}

function defaultSelection(chapter: CatalogChapter): ChapterSelection {
  return {
    chapter_id: chapter.id,
    material_ids: chapter.materials.filter(item => item.available).map(item => item.id),
    knowledge_point_ids: chapter.knowledge_points.map(item => item.id),
  };
}

export function ChapterPicker({ chapters, selected, problems, withQuiz, finalId, onChange, onRefresh, refreshing }: {
  chapters: CatalogChapter[];
  selected: ChapterSelection[];
  problems: Map<string, string[]>;
  withQuiz: boolean;
  finalId?: string | null;
  onChange: (rows: ChapterSelection[], finalId?: string | null) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [focusId, setFocusId] = useState(selected[0]?.chapter_id);
  const [filter, setFilter] = useState("");
  const [openError, setOpenError] = useState("");
  function openManager(page: "curriculum" | "materials") {
    const tab = window.open("/teacher/" + page, "_blank");
    if (tab) {
      tab.opener = null;
      setOpenError("");
    } else {
      setOpenError("请允许浏览器打开新的教学管理标签页，然后重试。");
    }
  }
  const catalog = new Map(chapters.map(chapter => [chapter.id, chapter]));
  const chosen = new Map(selected.map(row => [row.chapter_id, row]));
  const orderedIds = [...chosen.keys(), ...chapters.filter(chapter => !chosen.has(chapter.id)).map(chapter => chapter.id)];
  const needle = filter.trim().toLowerCase();
  const visible = orderedIds.filter(id => {
    const item = catalog.get(id);
    return !needle || item?.title.toLowerCase().includes(needle) || item?.knowledge_points.some(point => point.title.toLowerCase().includes(needle));
  });
  const firstSelectedId = visible.find(id => chosen.has(id));
  const active = chosen.get(focusId && visible.includes(focusId) ? focusId : firstSelectedId ?? "");
  const chapter = active && catalog.get(active.chapter_id);
  const messages = active && problems.get(active.chapter_id);
  const available = visible.filter(id => !chosen.has(id));
  const canAddAll = available.length > 0 && selected.length + available.length <= maxChapters;
  const startId = selected[0]?.chapter_id;
  const finalIndex = selected.findIndex(chapter => chapter.chapter_id === finalId);
  const firstMovable = withQuiz ? 1 : 0;
  const lastMovable = finalIndex >= 0 ? finalIndex - 1 : selected.length - 1;
  const titleOf = (id: string) => catalog.get(id)?.title ?? "已移出的章节";

  function add(ids: string[]) {
    const additions = ids.flatMap(id => {
      const entry = catalog.get(id);
      return entry && !chosen.has(id) ? [defaultSelection(entry)] : [];
    });
    const next = [...selected];
    next.splice(finalIndex >= 0 ? finalIndex : next.length, 0, ...additions);
    onChange(next);
    if (additions.length) setFocusId(additions[0].chapter_id);
  }
  function move(from: number, to: number, nextFinal = finalId) {
    const next = [...selected];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    onChange(next, nextFinal);
  }
  function replace(next: ChapterSelection) {
    onChange(selected.map(row => row.chapter_id === next.chapter_id ? next : row));
  }
  return <section aria-label="选择章节" className="surface min-w-0">
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div><h2 className="text-lg">授课章节</h2>
        <p className="hint">勾选章节后，会带入本章可用课件和全部知识点。</p></div>
      <div className="flex flex-wrap gap-1">
        <Button variant="link" size="sm" onClick={() => openManager("curriculum")}>管理章节与知识点<ExternalLink /></Button>
        <Button variant="link" size="sm" onClick={() => openManager("materials")}>管理课件<ExternalLink /></Button>
        <Button variant="ghost" size="sm" onClick={onRefresh}><RefreshCw />{refreshing ? "刷新中…" : "刷新内容"}</Button>
      </div>
    </div>
    <ErrorNotice message={openError} />
    {withQuiz && <div className="mb-4 grid gap-3 rounded-lg bg-muted/40 p-3 sm:grid-cols-2">
      <div className="min-w-0 space-y-1">
        <Label htmlFor="quick-start">起始章</Label>
        <SelectField id="quick-start" className="w-full" value={startId ?? ""} disabled={!selected.length} placeholder="先勾选章节"
          onValueChange={id => move(selected.findIndex(row => row.chapter_id === id), 0)}>
          {selected.map(row => <option key={row.chapter_id} value={row.chapter_id} disabled={selected.length > 1 && row.chapter_id === finalId}>
            {titleOf(row.chapter_id)}
          </option>)}
        </SelectField>
        <p className="hint">起始章排在第一位，学生会在这里初次结识镇上的角色。</p>
      </div>
      <div className="min-w-0 space-y-1">
        <Label htmlFor="quick-final">最终章</Label>
        <SelectField id="quick-final" className="w-full" value={finalId ?? ""} disabled={!selected.length} placeholder="暂不设置" onValueChange={id => {
          if (!id) onChange(selected, null);
          else move(selected.findIndex(row => row.chapter_id === id), selected.length - 1, id);
        }}>
          <option value="">暂不设置</option>
          {selected.map(row => <option key={row.chapter_id} value={row.chapter_id} disabled={selected.length > 1 && row.chapter_id === startId}>
            {titleOf(row.chapter_id)}
          </option>)}
        </SelectField>
        <p className="hint">{finalId ? (startId === finalId ? "本章兼作开场与收尾。若再加一章，新增章将排在它前面。" : "最终章有课程总结，新增章节会排在它前面。") :
          "课程还在编写时可留空。选定后，镇长会在该章测验后为课程收尾。"}</p>
      </div>
    </div>}
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(17rem,2fr)_minmax(0,3fr)]">
      <div className="min-w-0 rounded-lg border">
        <div className="border-b p-3">
          <TableSearch label="搜索章节或知识点" placeholder="搜索章节或知识点" value={filter} onValueChange={setFilter} />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-1">
            <span className="text-sm text-muted-foreground">已选 {selected.length} 章</span>
            <Button size="xs" variant="link" disabled={!canAddAll} onClick={() => add(available)}>
              {needle ? "选中匹配章节" : "选中全部章节"}
            </Button>
          </div>
          {available.length > maxChapters - selected.length && <p className="hint">最多选 {maxChapters} 章，可按名称筛选后勾选。</p>}
        </div>
        <ul className="max-h-[27rem] overflow-auto py-1">
          {visible.map(id => {
            const title = titleOf(id);
            const index = selected.findIndex(row => row.chapter_id === id);
            const checked = index >= 0;
            const current = active?.chapter_id === id;
            return <li key={id} className={"flex items-center gap-1 border-l-2 px-2 py-1 " +
              (current ? "border-primary bg-muted" : "border-transparent")}>
              <input type="checkbox" className="m-1 shrink-0" checked={checked} aria-label={title} disabled={!checked && selected.length >= maxChapters}
                onChange={() => checked ? onChange(selected.filter(row => row.chapter_id !== id)) : add([id])} />
              <button className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1.5 text-left text-sm hover:underline"
                aria-current={current || undefined} aria-label={checked ? "调整" + title + "的内容" : "选择" + title}
                disabled={!checked && selected.length >= maxChapters} onClick={() => checked ? setFocusId(id) : add([id])}>
                {checked && <span className="text-muted-foreground">{index + 1}.</span>}
                <span className="min-w-0 break-words">{title}{problems.has(id) && <span className="ml-1 text-xs text-amber-800">待补全</span>}</span>
                {withQuiz && checked && (id === startId || id === finalId) && <small className="shrink-0 text-muted-foreground">
                  {id === startId && id === finalId ? "起始 / 最终" : id === startId ? "起始" : "最终"}
                </small>}
              </button>
              {checked && <>
                <Button variant="ghost" size="icon-sm" aria-label={"上移" + title} disabled={index <= firstMovable || index > lastMovable} onClick={() => move(index, index - 1)}><ArrowUp /></Button>
                <Button variant="ghost" size="icon-sm" aria-label={"下移" + title} disabled={index < firstMovable || index >= lastMovable} onClick={() => move(index, index + 1)}><ArrowDown /></Button>
              </>}
              {current && <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
            </li>;
          })}
          {!visible.length && <li className="p-3 text-sm text-muted-foreground">没有匹配的章节。</li>}
        </ul>
      </div>
      <div className="min-w-0 rounded-lg border p-4">
        {active ? <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="break-words font-semibold">{chapter?.title ?? "已移出的章节"}</h3>
            {selected.length > 2 && lastMovable > firstMovable && active.chapter_id !== finalId && (!withQuiz || active.chapter_id !== startId) && <div className="flex items-center gap-2">
              <Label htmlFor="quick-position">授课位置</Label>
              <SelectField id="quick-position" value={selected.findIndex(row => row.chapter_id === active.chapter_id)}
                onValueChange={value => move(selected.findIndex(row => row.chapter_id === active.chapter_id), Number(value))}>
                {selected.map((row, i) => <option key={row.chapter_id} value={i} disabled={i < firstMovable || i > lastMovable}>{"第 " + (i + 1) + " 位"}</option>)}
              </SelectField>
            </div>}
          </div>
          {messages && <div className="mb-3 rounded-md bg-amber-50 p-3 text-sm text-amber-950" aria-live="polite">
            <p className="font-medium">{chapter ? "请调整《" + chapter.title + "》" : "请调整章节选择"}</p>
            {messages.map(message => <p key={message}>{message}</p>)}
          </div>}
          {chapter && <div key={chapter.id} className="grid gap-4 text-sm md:grid-cols-2">
            <ContentChoices title="课件" options={chapter.materials} selected={active.material_ids}
              empty="请先在资料库中关联本章课件。" onChange={material_ids => replace({ ...active, material_ids })} />
            <ContentChoices title="知识点" searchable options={chapter.knowledge_points} selected={active.knowledge_point_ids}
              empty="请先在课程结构中添加本章知识点。" onChange={ids => replace(withSelectedPoints(active, ids))} />
          </div>}
        </> : <Empty title={needle ? "请选择匹配的章节" : "请选择要教的章节"} description="从章节列表勾选后，即可调整本次使用的课件和知识点。" />}
      </div>
    </div>
  </section>;
}
