import { ListEmpty } from "@/components/common";
import { ManagementTable } from "@/components/management-table";
import { useState, type FormEvent } from "react";
import { Copy, Ellipsis, ExternalLink, LoaderCircle, Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorNotice, Loading, PageHeader, TableSearch } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { api, errorMessage, request, token } from "@/lib/api";
import { openTownPreview } from "@/lib/town-preview";
import { useResource } from "@/lib/use-resource";
import { useDraft } from "@/lib/drafts";

interface ManagedClass {
  id: number;
  course_id?: number;
  course_name?: string;
  teacher_id?: number;
  teacher_name?: string;
  name: string;
  join_code?: string;
  status: "active" | "archived" | "deleted";
  student_count: number;
  has_learning_records: boolean;
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

export function ClassroomManagement({ courseId, isAdmin, onOpen, onOpenCourse, onCreate, onChanged }: {
  courseId?: number;
  isAdmin: boolean;
  onOpen: (id: number) => void;
  onOpenCourse?: (courseId: number) => void;
  onCreate?: () => void;
  onChanged: () => void;
}) {
  const globalMode = courseId === undefined;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ManagedClass["status"]>("active");
  const [teacherFilter, setTeacherFilter] = useState("all");
  const [openingTownId, setOpeningTownId] = useState<number | null>(null);
  const [change, setChange] = useState<{ row: ManagedClass; action: Action } | null>(null);
  const endpoint = globalMode
    ? `/teacher/classrooms/management${status === "deleted" ? "?deleted=true" : ""}`
    : `/teacher/courses/${courseId}/classrooms${status === "deleted" ? "?deleted=true" : ""}`;
  const list = useResource<ManagedClass[]>(endpoint);

  const teachers = new Map<number, string>();
  if (globalMode && list.data) {
    for (const row of list.data) {
      if (row.teacher_id !== undefined && row.teacher_name) {
        teachers.set(row.teacher_id, row.teacher_name);
      }
    }
  }

  const needle = query.trim().toLowerCase();
  const rows = list.data?.filter(row => {
    if (row.status !== status) return false;
    if (globalMode && teacherFilter !== "all" && String(row.teacher_id) !== teacherFilter) return false;
    if (!needle) return true;
    const haystack = globalMode
      ? `${row.name} ${row.course_name ?? ""} ${row.teacher_name ?? ""}`
      : row.name;
    return haystack.toLowerCase().includes(needle);
  });

  async function enterTown(id: number) {
    if (openingTownId !== null) return;
    const captured = token();
    setOpeningTownId(id);
    try {
      await openTownPreview(id);
    } catch (err) {
      if (captured === token()) toast.add({ title: errorMessage(err), type: "error" });
    } finally {
      setOpeningTownId(null);
    }
  }

  const isFiltered = Boolean(needle) || status !== "active" || teacherFilter !== "all";

  return <>
    <PageHeader
      title="班级管理"
      description={globalMode ? "查看与管理全站所有课程下的教学班、加入码及班级状态。" : undefined}
    >
      {onCreate && <Button onClick={onCreate}><Plus />创建班级</Button>}
    </PageHeader>
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <TableSearch
        label={globalMode ? "搜索班级、课程或教师" : "搜索班级名称"}
        placeholder={globalMode ? "搜索班级、课程或教师" : undefined}
        value={query}
        onValueChange={setQuery}
      />
      {globalMode && (
        <SelectField aria-label="筛选任课教师" value={teacherFilter} onValueChange={setTeacherFilter}>
          <option value="all">全部任课教师</option>
          {Array.from(teachers, ([id, name]) => <option key={id} value={id}>{name}</option>)}
        </SelectField>
      )}
      <SelectField aria-label="班级状态" value={status} onValueChange={v => setStatus(v as ManagedClass["status"])}>
        {Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </SelectField>
    <span id="classrooms-columns-0" className="ml-auto" /></div>
    <ErrorNotice message={list.error} />
    {list.loading && <Loading />}
    {rows && <div className="overflow-hidden rounded-lg border bg-background"><ManagementTable toolsId="classrooms-columns-0" paginate key={`${query}:${status}:${teacherFilter}`}><TableHeader><TableRow>
      <TableHead>班级名称</TableHead>
      {globalMode && <TableHead>所属课程 / 任课教师</TableHead>}
      <TableHead>班级加入码</TableHead>
      <TableHead>学生数</TableHead>
      <TableHead className="text-right">操作</TableHead>
    </TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.id}>
      <TableCell className="py-2 font-medium">{row.name}</TableCell>
      {globalMode && (
        <TableCell className="max-w-xs py-2 whitespace-normal">
          {row.course_id && onOpenCourse ? (
            <button
              type="button"
              className="text-left font-medium text-foreground underline-offset-4 hover:underline"
              onClick={() => onOpenCourse(row.course_id!)}
            >
              {row.course_name || `课程 #${row.course_id}`}
            </button>
          ) : (
            <span>{row.course_name || "—"}</span>
          )}
          {row.teacher_name && <p className="text-xs text-muted-foreground">{row.teacher_name}</p>}
        </TableCell>
      )}
      <TableCell className="py-2">{row.status === "active" && row.join_code
        ? <div className="flex items-center gap-1.5"><code className="select-all font-mono text-xs">{row.join_code}</code>
          <Button size="icon-sm" variant="ghost" aria-label={`复制${row.name}的加入码`} onClick={() => void copyCode(row.join_code!)}><Copy/></Button></div>
        : "—"}</TableCell>
      <TableCell className="py-2 font-mono tabular-nums">{row.student_count}</TableCell>
      <TableCell className="py-2 text-right whitespace-nowrap"><div className="flex flex-nowrap items-center justify-end gap-1.5">
        {row.status === "active" && (
          <Button
            size="sm"
            variant="outline"
            disabled={openingTownId !== null}
            aria-busy={openingTownId === row.id}
            onClick={() => void enterTown(row.id)}
          >
            {openingTownId === row.id ? (
              <LoaderCircle className="animate-spin motion-reduce:animate-none" />
            ) : (
              <ExternalLink />
            )}
            {openingTownId === row.id ? "正在进入…" : "进入小镇"}
          </Button>
        )}
        {row.status === "active" && <Button size="sm" variant="outline" onClick={() => onOpen(row.id)}><Users />学生管理</Button>}
        {(row.status === "active" || (row.status === "archived" && (isAdmin || !row.has_learning_records))) && <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`管理 ${row.name}`} />}><Ellipsis /></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {row.status === "active" && <DropdownMenuItem onClick={() => setChange({ row, action: "rename" })}>改名</DropdownMenuItem>}
            {row.status === "active" && <DropdownMenuItem onClick={() => setChange({ row, action: "archive" })}>归档</DropdownMenuItem>}
            {(isAdmin || !row.has_learning_records) && <DropdownMenuItem variant="destructive" onClick={() => setChange({ row, action: "delete" })}>正式删除</DropdownMenuItem>}
          </DropdownMenuContent></DropdownMenu>}
      </div></TableCell>
    </TableRow>)}</TableBody></ManagementTable>{!rows.length && <ListEmpty title="尚未创建班级" filtered={isFiltered} reset={() => { setStatus("active"); setQuery(""); setTeacherFilter("all"); }} action={onCreate ? <Button onClick={onCreate}>创建第一个班级</Button> : undefined} />}</div>}
    {change && <ClassActionDialog {...change} onClose={() => setChange(null)} onSaved={() => {
      toast.add({ title: `${change.row.name} 已完成${actions[change.action]}。`, type: "success" });
      setChange(null); list.reload(); onChanged();
    }} />}
  </>;
}

function ClassActionDialog({ row, action, onClose, onSaved }: {
  row: ManagedClass; action: Action; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(row.name), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useDraft(busy || (action === "rename" && name !== row.name));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || (action === "rename" && !name.trim())) return;
    setBusy(true); setError("");
    try {
      const url = `/teacher/classrooms/${row.id}`;
      if (action === "rename") await request(url, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
      else if (action === "archive") await api.post(`${url}/archive`, {});
      else await api.delete(url);
      onSaved();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent showCloseButton={!busy}>
    <DialogHeader><DialogTitle>{actions[action]} · {row.name}</DialogTitle><DialogDescription>{
      action === "rename" ? "修改后本班学生看到新的班级名称。" : action === "archive"
        ? `当前班级有 ${row.student_count} 名学生。归档后班级离开教学中列表，学习记录继续保留。`
        : `当前班级有 ${row.student_count} 名学生。正式删除会解除本班成员关系；学生账号和历史学习记录保留。`
    }</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={submit} inert={busy}><ErrorNotice message={error} />
      {action === "rename" && <div className="field"><Label htmlFor="managed-class-name">班级名称</Label>
        <Input id="managed-class-name" maxLength={100} required value={name} onChange={e => setName(e.target.value)} /></div>}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        <Button type="submit" variant={action === "delete" ? "destructive" : "default"} disabled={busy || (action === "rename" && !name.trim())}>
          {busy ? "处理中…" : `确认${actions[action]}`}</Button></DialogFooter>
    </form></DialogContent></Dialog>;
}
