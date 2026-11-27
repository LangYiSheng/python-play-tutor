import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ErrorNotice } from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SelectField } from "@/components/select-field";
import { api, errorMessage } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { useResource } from "@/lib/use-resource";
import { CharacterPreview } from "./character-preview";

export interface CharacterAsset { id:string; kind:"portrait"|"sprite"; name:string; url:string; frame_width?:number; frame_height?:number }
interface Role { key: string; revision: number; name: string; persona: string; portrait:CharacterAsset; sprite:CharacterAsset }
const roles:Record<string,string> = {librarian:"学习资料 · 图书馆",professor:"客观题练习 · 教学工坊",coach:"编程题练习 · 练习会馆",mayor:"测验 · 镇长办公室"};

function EditRole({role,assets,done}: {role:Role; assets:CharacterAsset[]; done:(saved:boolean)=>void}) {
  const [name,setName]=useState(role.name), [persona,setPersona]=useState(role.persona);
  const [refs,setRefs]=useState({portrait:role.portrait.id,sprite:role.sprite.id});
  const [files,setFiles]=useState<Partial<Record<CharacterAsset["kind"], File>>>({});
  const [width,setWidth]=useState(role.sprite.frame_width??16),[height,setHeight]=useState(role.sprite.frame_height??20);
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const dirty= name!==role.name || persona!==role.persona || refs.portrait!==role.portrait.id || refs.sprite!==role.sprite.id || !!files.portrait || !!files.sprite;
  useDraft(dirty);
  async function save() {
    setBusy(true);setError("");
    try {
      const form=new FormData();
      form.append("metadata",JSON.stringify({name,persona,expected_revision:role.revision,...refs,frame_width:width,frame_height:height}));
      for(const key of ["portrait","sprite"] as const) if(files[key]) form.append(key,files[key]!);
      await api.upload("/admin/teaching-roles/"+role.key,form);
      done(true);
    }catch(err){setError(errorMessage(err));}finally{setBusy(false);}
  }
  return <Dialog open onOpenChange={v=>{if(!v && !busy && (!dirty || window.confirm("放弃未保存的角色修改？"))) done(false);}}><DialogContent className="editor-dialog">
    <DialogHeader><DialogTitle>编辑教学角色 · {roles[role.key]}</DialogTitle></DialogHeader>
    <form inert={busy} onSubmit={e=>{e.preventDefault();void save();}}><div className="dialog-scroll space-y-4">
      <ErrorNotice message={error}/>
      <label className="field">角色名称<Input required maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label>
      <label className="field">人设<Textarea maxLength={4000} value={persona} onChange={e=>setPersona(e.target.value)}/></label>
      <div className="grid gap-4 md:grid-cols-2">{(["portrait","sprite"] as const).map(kind=>{
        const available = assets.filter(a=>a.kind===kind);
        if(role[kind].id==="custom") available.unshift(role[kind]);
        return <section key={kind} className="space-y-2"><label className="field">{kind==="portrait"?"对话立绘":"像素角色"}
          <SelectField value={refs[kind]} onValueChange={v=>{setRefs({...refs,[kind]:v});setFiles({...files,[kind]:undefined});}}>
            {available.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}<option value="upload">上传新图片</option>
          </SelectField></label>
          {refs[kind]==="upload" ? <><Input type="file" aria-label={kind==="portrait"?"上传立绘":"上传像素角色"} required accept={kind==="sprite"?".png":".jpg,.jpeg,.png,.webp"}
            onChange={e=>setFiles({...files,[kind]:e.target.files?.[0]})}/>
            {kind==="sprite" && <div className="grid grid-cols-2 gap-2"><label>帧宽<Input type="number" min={8} max={256} required value={width} onChange={e=>setWidth(Number(e.target.value))}/></label>
            <label>帧高<Input type="number" min={8} max={256} required value={height} onChange={e=>setHeight(Number(e.target.value))}/></label></div>}</> :
            <CharacterPreview asset={available.find(a=>a.id===refs[kind])}/>}
        </section>;})}</div></div>
      <DialogFooter><Button type="button" variant="outline" onClick={()=>done(false)}>取消</Button><Button type="submit" disabled={busy || !dirty}>保存</Button></DialogFooter>
    </form></DialogContent></Dialog>;
}

export function PlatformRoles() {
  const data=useResource<{roles:Role[];assets:CharacterAsset[]}>("/admin/teaching-roles");
  const [editing,setEditing]=useState<Role|null>(null);
  return <section className="space-y-3"><ErrorNotice message={data.error}/>{data.loading && <div role="status" aria-busy="true" className="grid gap-3 xl:grid-cols-2">
      <span className="sr-only">正在加载…</span>
      {Array.from({ length: 4 }, (_, i) => <div className="surface flex items-center gap-4 p-3" key={i}>
        <Skeleton className="size-12 shrink-0 rounded-lg" />
        <div className="flex-1 space-y-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-3 w-36" /></div>
        <Skeleton className="h-8 w-14 rounded-lg" />
      </div>)}
    </div>}
    <div className="grid gap-3 xl:grid-cols-2">{data.data?.roles.map(r=><div className="surface flex items-center gap-4 p-3" key={r.key}>
      <CharacterPreview compact asset={r.portrait}/><div className="flex-1"><strong>{r.name}</strong><p className="hint">{roles[r.key]}</p></div>
      <Button variant="outline" aria-label={`编辑${r.name}`} onClick={()=>setEditing(r)}>编辑</Button></div>)}</div>
    {editing && data.data && <EditRole role={editing} assets={data.data.assets} done={saved=>{setEditing(null);if(saved)data.reload();}}/>}
  </section>;
}
