import { useState, type FormEvent } from "react";
import { Ellipsis, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, ErrorNotice, Loading, PageHeader, TableSearch } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage, request } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useDraft } from "@/lib/drafts";
import { RecordViewer } from "@/pages/teaching";
import type { AccountList } from "./accounts";

interface ManagedClass {
  id: number; name: string; teacher_id: number; teacher_name: string;
  status: "active" | "archived" | "deleted"; student_count: number; has_learning_records: boolean;
}
const actions = { rename: "改名", transfer: "转交班级", archive: "归档", delete: "正式删除" };
type Action = keyof typeof actions;
const states = { active: "教学中", archived: "已归档", deleted: "已删除" };

export function ClassroomManagement({ isAdmin, userId, onOpen, onCreate, onChanged }: {
  isAdmin: boolean; userId: number; onOpen: (id: number) => void; onCreate: () => void; onChanged: () => void;
}) {
  const [query, setQuery] = useState(""), [mine, setMine] = useState("all");
  const [status, setStatus] = useState<ManagedClass["status"]>("active");
  const [change, setChange] = useState<{ row: ManagedClass; action: Action } | null>(null);
  const [history, setHistory] = useState<ManagedClass | null>(null), [notice, setNotice] = useState("");
  const list = useResource<ManagedClass[]>(`/teacher/classrooms/management${status === "deleted" ? "?deleted=true" : ""}`);
  const rows = list.data?.filter(row => row.status === status && (mine !== "mine" || row.teacher_id === userId)
    && (row.name + " " + row.teacher_name).toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    <PageHeader title="班级管理"><Button onClick={onCreate}><Plus />创建班级</Button></PageHeader>
    <div className="toolbar">
      <TableSearch label="搜索班级或任课教师" value={query} onValueChange={setQuery} />
      <SelectField aria-label="班级状态" value={status} onValueChange={v => setStatus(v as ManagedClass["status"])}>
        {Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </SelectField>
      {isAdmin && <SelectField aria-label="任课范围" value={mine} onValueChange={setMine}>
        <option value="all">全部班级</option><option value="mine">我负责的班级</option>
      </SelectField>}
    </div>
    {notice && <p role="status" className="success-notice">{notice}</p>}<ErrorNotice message={list.error} />
    {list.loading && <Loading />}
    {rows && <div className="surface overflow-hidden"><Table><TableHeader><TableRow>
      <TableHead>班级</TableHead><TableHead>任课教师</TableHead><TableHead>学生数</TableHead><TableHead className="text-right">操作</TableHead>
    </TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.id}>
      <TableCell className="font-medium">{row.name}</TableCell><TableCell>{row.teacher_name}</TableCell><TableCell>{row.student_count}</TableCell>
      <TableCell><div className="flex justify-end gap-2">
        {row.status === "active" && <Button size="sm" variant="outline" onClick={() => onOpen(row.id)}>进入班级</Button>}
        {row.has_learning_records && <Button size="sm" variant="ghost" onClick={() => setHistory(row)}>学习记录</Button>}
        {(row.status === "active" || (row.status === "archived" && (isAdmin || !row.has_learning_records))) && <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label={`管理 ${row.name}`} />}><Ellipsis /></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {row.status === "active" && <DropdownMenuItem onClick={() => setChange({ row, action: "rename" })}>改名</DropdownMenuItem>}
            {isAdmin && <DropdownMenuItem onClick={() => setChange({ row, action: "transfer" })}>转交班级</DropdownMenuItem>}
            {row.status === "active" && <DropdownMenuItem onClick={() => setChange({ row, action: "archive" })}>归档</DropdownMenuItem>}
            {(isAdmin || !row.has_learning_records) && <DropdownMenuItem onClick={() => setChange({ row, action: "delete" })}>正式删除</DropdownMenuItem>}
          </DropdownMenuContent></DropdownMenu>}
      </div></TableCell>
    </TableRow>)}</TableBody></Table>{!rows.length && <Empty title="没有匹配的班级" />}</div>}
    {change && <ClassActionDialog {...change} onClose={() => setChange(null)} onSaved={() => {
      setNotice(`${change.row.name} 已完成${actions[change.action]}。`); setChange(null); list.reload(); onChanged();
    }} />}
    {history && <HistoryDialog row={history} onClose={() => setHistory(null)} />}
  </>;
}

function ClassActionDialog({ row, action, onClose, onSaved }: {
  row: ManagedClass; action: Action; onClose: () => void; onSaved: () => void;
}) {
  const [value, setValue] = useState(action === "rename" ? row.name : "");
  const [search, setSearch] = useState(""), [teacher, setTeacher] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const teachers = useResource<AccountList>(action === "transfer" ? `/admin/accounts?role=teacher&size=100&q=${encodeURIComponent(search.trim())}` : null);
  useDraft(busy || Boolean(teacher) || (action === "rename" && value !== row.name));
  const valid = action === "delete" ? value === row.name : action === "transfer" ? Boolean(teacher) : action !== "rename" || Boolean(value.trim());
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !valid) return;
    setBusy(true); setError("");
    const path = `/teacher/classrooms/${row.id}`;
    try {
      if (action === "rename") await request(path, { method: "PATCH", body: JSON.stringify({ name: value.trim() }) });
      if (action === "delete") await api.delete(path);
      if (action === "archive") await api.post(`${path}/archive`, {});
      if (action === "transfer") await api.post(`${path}/transfer`, { teacher_id: Number(teacher) });
      onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent showCloseButton={!busy}>
    <DialogHeader><DialogTitle>{actions[action]} · {row.name}</DialogTitle>
      <DialogDescription>{{
        rename: "新名称将显示在教师和学生的班级列表中。",
        archive: "归档后退出日常教学，保留班级成员和历史学习记录。",
        transfer: "授课与编辑权限移交给新任课教师，原班课程和学习记录保留。",
        delete: `将解除本班与 ${row.student_count} 名学生的绑定。学生账号和历史学习记录保留。请输入班级全名确认。`,
      }[action]}</DialogDescription>
    </DialogHeader><form className="space-y-4" onSubmit={save}>
      <ErrorNotice message={error || teachers.error} />
      {(action === "rename" || action === "delete") && <div className="field"><Label htmlFor="class-action-name">{action === "rename" ? "新班级名" : "确认班级全名"}</Label><Input id="class-action-name" maxLength={100} value={value} required onChange={e => setValue(e.target.value)} /></div>}
      {action === "transfer" && <div className="field">
        <TableSearch label="搜索教师姓名或学号" value={search} onValueChange={v => { setTeacher(""); setSearch(v); }} />
        <Label htmlFor="next-class-teacher">新任课教师</Label>
        <SelectField id="next-class-teacher" value={teacher} disabled={teachers.loading} onValueChange={setTeacher}>
          {(teachers.data?.items ?? []).filter(item => item.id !== row.teacher_id).map(item => <option value={item.id} key={item.id}>{item.name}（{item.student_id}）</option>)}
        </SelectField>
        {teachers.data && teachers.data.total > teachers.data.items.length && <p className="hint">当前显示前 100 人，可按学号搜索。</p>}
      </div>}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        <Button type="submit" variant={action === "delete" ? "destructive" : "default"} disabled={!valid || busy}>{busy ? "处理中…" : `确认${actions[action]}`}</Button>
      </DialogFooter>
    </form></DialogContent></Dialog>;
}

function HistoryDialog({ row, onClose }: { row: ManagedClass; onClose: () => void }) {
  const history = useResource<{ students: { id: number; student_id: string; name: string; records: number }[] }>(`/teacher/classrooms/${row.id}/history`);
  const [student, setStudent] = useState<number | null>(null), [query, setQuery] = useState("");
  const students = history.data?.students.filter(s => s.name.includes(query.trim()) || s.student_id?.includes(query.trim()));
  if (student !== null) return <RecordViewer classroomId={row.id} studentId={student} history onClose={() => setStudent(null)} />;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent><DialogHeader>
    <DialogTitle>{row.name} · 学习记录</DialogTitle><DialogDescription>按学生查阅该班保留的历史记录。</DialogDescription>
  </DialogHeader><TableSearch label="搜索姓名或学号" value={query} onValueChange={setQuery} />
    <ErrorNotice message={history.error} />{history.loading && <Loading />}
    <div className="max-h-[60vh] overflow-y-auto">{students?.map(s => <div key={s.id} className="flex items-center justify-between gap-3 border-b py-2">
      <span>{s.name} · {s.student_id}</span><Button variant="outline" size="sm" onClick={() => setStudent(s.id)}>查看记录</Button>
    </div>)}{students?.length === 0 && <Empty title="没有匹配的记录" />}</div>
  </DialogContent></Dialog>;
}
