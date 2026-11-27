import { useState, type FormEvent } from "react";
import { MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorNotice, Loading } from "@/components/common";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage, request } from "@/lib/api";
import { toast } from "@/components/ui/toast";
import { useResource } from "@/lib/use-resource";
import type { Classroom, CourseInstance } from "@/lib/types";
import { CreateCourseDialog } from "./create-course-dialog";
import { CourseDeleteDialog } from "./course-delete-dialog";

type CourseList = ReturnType<typeof useResource<CourseInstance[]>>;
export function CoursePicker({courses, items, classes, onOpen, onCreated, teacherName, admin, exporting, exportCourse}: {
  courses: CourseList; items: CourseInstance[]; classes: Classroom[]; onOpen: (id: number) => void;
  onCreated: (course: { id: number; name: string }) => void; teacherName: string;
  admin: boolean; exporting: number | null; exportCourse: (course: CourseInstance) => Promise<void>;
}) {
  const [mode, setMode] = useState<"rename" | "transfer" | null>(null);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<CourseInstance>();
  const [deleting, setDeleting] = useState<CourseInstance | null>(null);
  const [value, setValue] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const teachers = useResource<{total: number; items: {id: number; name: string; student_id: string; disabled: boolean}[]}>(
    mode === "transfer" ? "/admin/accounts?role=teacher&size=100&q=" + encodeURIComponent(search) : null);
  const candidates = teachers.data?.items.filter(teacher => !teacher.disabled && teacher.id !== selected?.teacher_id) ?? [];
  const canSave = mode === "transfer"
    ? candidates.some(teacher => String(teacher.id) === value)
    : Boolean(value.trim());
  function edit(action: typeof mode, course?: CourseInstance) {
    setSelected(course); setValue(action === "rename" ? course?.name ?? "" : ""); setMode(action); setError(""); setSearch("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !canSave) return;
    setBusy(true); setError("");
    try {
      if (mode === "rename" && selected) await request("/teacher/courses/" + selected.id, {
        method: "PATCH", body: JSON.stringify({name: value.trim(), expected_revision: selected.revision})});
      if (mode === "transfer" && selected) await api.post(`/teacher/courses/${selected.id}/transfer`, {teacher_id: Number(value)});
      setMode(null); courses.reload();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return <><h1 className="sr-only">课程选择</h1>
    <ErrorNotice message={courses.error}/>{courses.loading && <Loading/>}
    <div className="hub-grid">
      <button className="hub-create" onClick={() => setCreating(true)}><Plus size={24}/>创建新课程</button>
      {items.map(c => {
        const rooms = classes.filter(room => room.course_id === c.id).map(room => room.name).join("、");
        return <article key={c.id} className="surface hub-card">
        <div className="hub-card-head"><h2>{c.name}</h2>
          <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={c.name + "的更多操作"}/>}><MoreHorizontal/></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => edit("rename", c)}>修改课程名称</DropdownMenuItem>
              <DropdownMenuItem disabled={exporting !== null} onClick={() => void exportCourse(c)}>导出课程包</DropdownMenuItem>
              {admin && <DropdownMenuItem onClick={() => edit("transfer", c)}>转交整门课程</DropdownMenuItem>}
              <DropdownMenuSeparator/>
              <DropdownMenuItem variant="destructive" disabled={exporting === c.id} onClick={() => setDeleting(c)}><Trash2/>删除课程</DropdownMenuItem>
            </DropdownMenuContent></DropdownMenu></div>
        {rooms && <p className="hint line-clamp-2" title={rooms}>教学班 · {rooms}</p>}
        <div className="hub-card-footer"><Button onClick={() => onOpen(c.id)}>进入课程</Button></div>
      </article>})}</div>
    {creating && <CreateCourseDialog teacherName={teacherName} onClose={() => setCreating(false)} onCreated={created => { setCreating(false); onCreated(created); }}/>}
    {deleting && <CourseDeleteDialog course={deleting} onClose={() => setDeleting(null)} onDeleted={() => {
      setDeleting(null);
      courses.reload();
      toast.add({ title: "课程已删除", type: "success" });
    }}/>}
    {mode && <Dialog open onOpenChange={open => {if (!open && !busy) setMode(null);}}><DialogContent><DialogHeader>
      <DialogTitle>{mode === "rename" ? "修改课程名称" : "转交课程及全部教学班"}</DialogTitle>
    </DialogHeader><form className="space-y-4" onSubmit={save}><ErrorNotice message={error || teachers.error}/>
      {mode === "transfer" ? <div className="grid gap-3">
        <div className="grid gap-2">
          <Label htmlFor="find-teacher">搜索教师姓名或工号</Label>
          <Input id="find-teacher" type="search" maxLength={100} value={search} disabled={busy}
            onChange={event => { setSearch(event.target.value); setValue(""); setError(""); }}/>
        </div>
        <fieldset disabled={busy} className="min-w-0">
          <legend className="sr-only">新负责教师</legend>
          <div className="max-h-44 overflow-y-auto rounded-lg border p-1">
            {teachers.loading && <p className="hint p-2" role="status">正在查找教师…</p>}
            {teachers.data && !candidates.length && <p className="hint p-2" role="status">{search.trim() ? "未找到匹配的教师" : "暂无可转交的教师"}</p>}
            {teachers.error && <Button type="button" variant="ghost" onClick={teachers.reload}>重新加载</Button>}
            {candidates.map(teacher => <label key={teacher.id}
              className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-muted has-checked:bg-muted">
              <input type="radio" name="transfer-teacher" value={teacher.id} checked={value === String(teacher.id)}
                onChange={() => setValue(String(teacher.id))}/>
              <span className="min-w-0 flex-1 break-words">{teacher.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{teacher.student_id}</span>
            </label>)}
          </div>
          {teachers.data && teachers.data.total > teachers.data.items.length && <p className="hint mt-1">输入姓名或工号可缩小范围。</p>}
        </fieldset>
      </div>
      : <><Label htmlFor="course-name">课程名称</Label><Input id="course-name" maxLength={200} required value={value} onChange={e => setValue(e.target.value)}/></>}
      <Button disabled={busy || !canSave} type="submit">{mode === "transfer" ? "确认转交" : "保存"}</Button>
    </form></DialogContent></Dialog>}</>;
}
