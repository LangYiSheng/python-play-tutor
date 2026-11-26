import { useState, type FormEvent } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/select-field";
import { ErrorNotice, Loading } from "@/components/common";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { api, errorMessage, scoped } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useDraft } from "@/lib/drafts";
import type { Chapter, Material } from "@/lib/types";
import { MaterialDialog } from "@/features/materials/editor-dialog";
import { useMaterialEditor } from "@/features/materials/use-editor";

interface Segment {start_seconds: number; end_seconds: number; label: string}
interface Rule {scope?: "all" | "range" | "count"; start_page?: number; end_page?: number; count?: number; minimum_seconds?: number; segments?: Segment[]}
interface Task {material_id: number; title: string; kind: string; required: boolean; rule: Rule; order_index: number}

function MaterialOptions({item, onSave, onClose}: {item: Task; onSave: (item: Task) => Promise<void>; onClose: () => void}) {
  const video = item.kind === "video";
  const [scope, setScope] = useState<"all" | "range" | "count" | "time">(item.rule.scope ?? (item.rule.minimum_seconds ? "time" : "all"));
  const [start,setStart] = useState(item.rule.start_page ?? 1), [end,setEnd] = useState(item.rule.end_page ?? 1);
  const [count,setCount] = useState(item.rule.count ?? 1), [seconds,setSeconds] = useState(item.rule.minimum_seconds ?? 0);
  const [segments,setSegments] = useState(item.rule.segments ?? []);
  const [order,setOrder] = useState(item.order_index);
  const [error,setError] = useState(""), [busy,setBusy] = useState(false), [dirty,setDirty] = useState(false);
  useDraft(dirty);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const rule: Rule = {};
    if (!video && scope !== "time") rule.scope = scope;
    if (!video && scope === "range") Object.assign(rule, {start_page:start, end_page:end});
    if (!video && scope === "count") rule.count = count;
    if (seconds) rule.minimum_seconds = seconds;
    if (video && segments.length) rule.segments = segments;
    setBusy(true);
    try { await onSave({...item, rule, order_index: order}); onClose(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={v=>{if(!v && !busy) onClose();}}><DialogContent><DialogHeader><DialogTitle>{item.title} · 高级设置</DialogTitle></DialogHeader>
    <form onSubmit={submit} onChange={()=>setDirty(true)} className="space-y-4" inert={busy}><ErrorNotice message={error}/>
      <label className="field">显示顺序<Input type="number" value={order} min={0} max={100000} required onChange={e=>setOrder(Number(e.target.value))}/></label>
      {!video && <label className="field">阅读要求<SelectField value={scope} onValueChange={v=>{setScope(v as typeof scope);setDirty(true);}}>
        <option value="all">读完整份</option><option value="range">指定连续页</option><option value="count">任意不同页</option><option value="time">仅要求阅读时长</option>
      </SelectField></label>}
      {scope === "range" && !video && <div className="grid grid-cols-2 gap-3">
        <label>起始页<Input type="number" min={1} required value={start} onChange={e=>setStart(Number(e.target.value))}/></label>
        <label>结束页<Input type="number" min={start} required value={end} onChange={e=>setEnd(Number(e.target.value))}/></label></div>}
      {scope === "count" && !video && <label className="field">至少阅读页数<Input type="number" min={1} required value={count} onChange={e=>setCount(Number(e.target.value))}/></label>}
      <label className="field">{video ? "有效观看秒数" : "有效阅读秒数"}<Input type="number" min={scope === "time" && !video ? 1 : 0} max={86400} required value={seconds} onChange={e=>setSeconds(Number(e.target.value))}/></label>
      {video && <fieldset className="space-y-2"><legend>必看片段</legend>
        {segments.map((seg,i)=><div className="flex gap-2" key={i}>
          {(["label","start_seconds","end_seconds"] as const).map((field,j)=><label key={field}>{["名称","开始秒","结束秒"][j]}<Input type={j ? "number" : "text"} required min={j===2 ? seg.start_seconds+1 : 0} value={seg[field]}
            onChange={e=>setSegments(segments.map((s,n)=>n===i?{...s,[field]:j ? Number(e.target.value) : e.target.value}:s))}/></label>)}
          <Button type="button" variant="ghost" onClick={()=>{setSegments(segments.filter((_,n)=>i!==n));setDirty(true);}}>移除</Button>
        </div>)}
        <Button type="button" variant="outline" onClick={()=>{setSegments([...segments,{label:"",start_seconds:0,end_seconds:1}]);setDirty(true);}}>添加片段</Button>
      </fieldset>}
      <DialogFooter><Button type="button" variant="outline" onClick={onClose}>取消</Button><Button type="submit">保存</Button></DialogFooter>
    </form></DialogContent></Dialog>;
}

function readingRequirement({kind, rule}: Task) {
  const conditions: string[] = [];
  if (kind === "video") {
    if (rule.segments?.length) conditions.push(`观看 ${rule.segments.length} 个指定片段`);
  } else if (rule.scope === "range") {
    conditions.push(`阅读第 ${rule.start_page}–${rule.end_page} 页`);
  } else if (rule.scope === "count") {
    conditions.push(`阅读任意 ${rule.count} 个不同页`);
  } else if (rule.scope === "all" || !rule.minimum_seconds) {
    conditions.push("读完整份");
  }
  if (rule.minimum_seconds) conditions.push(`有效${kind === "video" ? "观看" : "阅读"} ${rule.minimum_seconds} 秒`);
  return conditions.join("，") || "完整观看";
}

export function ChapterMaterials({courseId, chapter, editRequirements = false}: {
  courseId: number; chapter: Chapter; editRequirements?: boolean;
}) {
  const path = scoped(`/teacher/chapters/${chapter.id}/material-tasks`,courseId);
  const tasks = useResource<{items:Task[]}>(path);
  const [attach,setAttach] = useState(false), [choice,setChoice] = useState("");
  const materials = useResource<Material[]>(attach ? scoped("/teacher/materials",courseId) : null);
  const editor = useMaterialEditor(courseId,tasks.reload);
  const [advanced,setAdvanced] = useState<Task|null>(null), [error,setError] = useState(""), [busy,setBusy] = useState(false);
  async function put(item: Pick<Task,"material_id"|"required"|"rule"|"order_index">) {
    await api.put(path+"/"+item.material_id,{required:item.required,rule:item.rule,order_index:item.order_index});
    tasks.reload();
  }
  async function change(item: Parameters<typeof put>[0]) {
    setBusy(true); setError("");
    try {await put(item); setAttach(false); setChoice("");} catch (err) {setError(errorMessage(err));}
    finally {setBusy(false);}
  }
  const rows = tasks.data?.items ?? [];
  return <section className="surface p-4"><div className="mb-3 flex flex-wrap items-center gap-2">
    <h2 className="mr-auto font-semibold">学习资料</h2>
    {!editRequirements && <><Button variant="outline" disabled={tasks.loading || Boolean(tasks.error)} onClick={()=>setAttach(true)}>关联已有资料</Button>
    <Button variant="outline" onClick={()=>{editor.edit(null);editor.setChapterIds([chapter.id]);}}>上传资料</Button></>}</div>
    <ErrorNotice message={error || tasks.error || materials.error}/>
    {!editRequirements && attach && <div className="mb-3 flex gap-2"><SelectField aria-label="选择课程资料" value={choice} onValueChange={setChoice}>
      <option value="">选择课程资料</option>{materials.data?.filter(m=>!rows.some(row=>row.material_id===m.id)).map(m=><option key={m.id} value={m.id}>{m.title}</option>)}
    </SelectField><Button disabled={busy || !choice} onClick={()=>void change({material_id:Number(choice),required:false,rule:{},order_index:rows.length+1})}>关联</Button>
    <Button variant="ghost" onClick={()=>setAttach(false)}>取消</Button></div>}
    {tasks.loading ? <Loading/> : !rows.length && <p className="hint">本章暂无学习资料。</p>}
    {rows.map(row=><div key={row.material_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t py-3">
      <div className="min-w-0 flex-1 break-words"><p>{row.title}</p>
        {editRequirements && row.required && <p className="hint">{readingRequirement(row)}</p>}
      </div>
      {editRequirements ? <div className="flex items-center gap-2">
        <label className="inline-flex h-7 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm hover:bg-muted">
          <Checkbox aria-label={row.title+"必读"} checked={row.required} disabled={busy} onCheckedChange={required=>void change({...row,required})}/>必读
        </label>
        <Button size="sm" variant="ghost" aria-label={row.title+"高级设置"} onClick={()=>setAdvanced(row)}><SlidersHorizontal/>高级设置</Button>
      </div> : <small className="hint">{row.required ? "必读" : "选读"}</small>}
    </div>)}
    {advanced && <MaterialOptions item={advanced} onSave={put} onClose={()=>setAdvanced(null)}/>}
    {!editRequirements && <MaterialDialog course={{data:{chapters:[chapter]}}} editor={editor} fixedChapter/>}
  </section>;
}
