import { ListEmpty } from "@/components/common";
import { ManagementTable } from "@/components/management-table";
import { useState, type FormEvent } from "react";
import { Copy, Ellipsis, Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorNotice, Loading, PageHeader, TableSearch } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { api, errorMessage, request } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useDraft } from "@/lib/drafts";

interface ManagedClass {
  id: number; name: string; join_code?: string;
  status: "active" | "archived" | "deleted"; student_count: number; has_learning_records: boolean;
}
const actions = { rename: "改名", archive: "归档", delete: "正式删除" };
type Action = keyof typeof actions;
async function copyCode(code: string) {
  try {
    await navigator.clipboard.writeText(code);
    toast.add({ title: "班级加入码已复制", type: "success" });
  } catch {
    toast.add({ title: "复制失败，请选中加入码手动复制", type: "error" });
  }
}
const states = { active: "教学中", archived: "已归档", deleted: "已删除" };

export function ClassroomManagement({ courseId, isAdmin, onOpen, onCreate, onChanged }: {
  courseId: number; isAdmin: boolean; onOpen: (id: number) => void; onCreate: () => void; onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ManagedClass["status"]>("active");
  const [change, setChange] = useState<{ row: ManagedClass; action: Action } | null>(null);
  const list = useResource<ManagedClass[]>(`/teacher/courses/${courseId}/classrooms${status === "deleted" ? "?deleted=true" : ""}`);
  const rows = list.data?.filter(row => row.status === status
    && row.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    <PageHeader title="班级管理"><Button onClick={onCreate}><Plus />创建班级</Button></PageHeader>
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <TableSearch label="搜索班级名称" value={query} onValueChange={setQuery} />
      <SelectField aria-label="班级状态" value={status} onValueChange={v => setStatus(v as ManagedClass["status"])}>
        {Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </SelectField>
    <span id="classrooms-columns-0" className="ml-auto" /></div>
    <ErrorNotice message={list.error} />
    {list.loading && <Loading />}
    {rows && <div className="overflow-hidden rounded-lg border bg-background"><ManagementTable toolsId="classrooms-columns-0" paginate key={query + status}><TableHeader><TableRow>
      <TableHead>班级名称</TableHead><TableHead>班级加入码</TableHead><TableHead>学生数</TableHead><TableHead className="text-right">操作</TableHead>
    </TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.id}>
      <TableCell className="font-medium">{row.name}</TableCell><TableCell>{row.status === "active" && row.join_code
        ? <div className="flex items-center gap-2"><code className="select-all">{row.join_code}</code>
          <Button size="icon-sm" variant="ghost" aria-label={`复制${row.name}的加入码`} onClick={() => void copyCode(row.join_code!)}><Copy/></Button></div>
        : "—"}</TableCell><TableCell>{row.student_count}</TableCell>
      <TableCell><div className="flex justify-end gap-2">
        {row.status === "active" && <Button size="sm" variant="outline" onClick={() => onOpen(row.id)}><Users />学生管理</Button>}
        {(row.status === "active" || (row.status === "archived" && (isAdmin || !row.has_learning_records))) && <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label={`管理 ${row.name}`} />}><Ellipsis /></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {row.status === "active" && <DropdownMenuItem onClick={() => setChange({ row, action: "rename" })}>改名</DropdownMenuItem>}
            {row.status === "active" && <DropdownMenuItem onClick={() => setChange({ row, action: "archive" })}>归档</DropdownMenuItem>}
            {(isAdmin || !row.has_learning_records) && <DropdownMenuItem onClick={() => setChange({ row, action: "delete" })}>正式删除</DropdownMenuItem>}
          </DropdownMenuContent></DropdownMenu>}
      </div></TableCell>
    </TableRow>)}</TableBody></ManagementTable>{!rows.length && <ListEmpty title="尚未创建班级" filtered={Boolean(query.trim()) || status !== "active"} reset={() => { setStatus("active"); setQuery(""); }} action={<Button onClick={onCreate}>创建第一个班级</Button>} />}</div>}
    {change && <ClassActionDialog {...change} onClose={() => setChange(null)} onSaved={() => {
      toast.add({ title: `${change.row.name} 已完成${actions[change.action]}。`, type: "success" });
      setChange(null); list.reload(); onChanged();
    }} />}
  </>;
}

function ClassActionDialog({ row, action, onClose, onSaved }: {
  row: ManagedClass; action: Action; onClose: () => void; onSaved: () => void;
}) {
  const [value, setValue] = useState(action === "rename" ? row.name : "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useDraft(busy || (action === "rename" && value !== row.name));
  const valid = action === "delete" ? value === row.name : action !== "rename" || Boolean(value.trim());
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !valid) return;
    setBusy(true); setError("");
    const path = `/teacher/classrooms/${row.id}`;
    try {
      if (action === "rename") await request(path, { method: "PATCH", body: JSON.stringify({ name: value.trim() }) });
      if (action === "delete") await api.delete(path);
      if (action === "archive") await api.post(`${path}/archive`, {});
      onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent showCloseButton={!busy}>
    <DialogHeader><DialogTitle>{actions[action]} · {row.name}</DialogTitle>
      <DialogDescription>{{
        rename: "新名称将显示在教师和学生的班级列表中。",
        archive: "归档后退出日常教学，保留班级成员和历史学习记录。",
        delete: `将解除本班与 ${row.student_count} 名学生的绑定。学生账号和历史学习记录保留。请输入班级全名确认。`,
      }[action]}</DialogDescription>
    </DialogHeader><form className="space-y-4" onSubmit={save}>
      <ErrorNotice message={error} />
      {(action === "rename" || action === "delete") && <div className="field"><Label htmlFor="class-action-name">{action === "rename" ? "新班级名" : "确认班级全名"}</Label><Input id="class-action-name" maxLength={100} value={value} required onChange={e => setValue(e.target.value)} /></div>}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        <Button type="submit" variant={action === "delete" ? "destructive" : "default"} disabled={!valid || busy}>{busy ? "处理中…" : `确认${actions[action]}`}</Button>
      </DialogFooter>
    </form></DialogContent></Dialog>;
}
