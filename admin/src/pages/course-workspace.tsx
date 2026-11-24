import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Empty, ErrorNotice, Loading, PageHeader } from "@/components/common";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { SelectField } from "@/components/select-field";
import { api, errorMessage, request } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import type { CourseInstance } from "@/lib/types";
import { RecordViewer } from "./teaching";

type CourseList = ReturnType<typeof useResource<CourseInstance[]>>;
export function CoursePicker({courses, onOpen, admin}: {courses: CourseList; onOpen: (id: number) => void; admin: boolean}) {
  const [mode, setMode] = useState<"create" | "rename" | "transfer" | null>(null);
  const [selected, setSelected] = useState<CourseInstance>();
  const [value, setValue] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const teachers = useResource<{items: {id: number; name: string; student_id: string; disabled: boolean}[]}>(
    mode === "transfer" ? "/admin/accounts?role=teacher&size=100&q=" + encodeURIComponent(search) : null);
  function edit(action: typeof mode, course?: CourseInstance) {
    setSelected(course); setValue(action === "rename" ? course?.name ?? "" : ""); setMode(action); setError(""); setSearch("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !value.trim()) return;
    setBusy(true); setError("");
    try {
      if (mode === "create") await api.post("/teacher/courses", {name: value.trim()});
      if (mode === "rename" && selected) await request("/teacher/courses/" + selected.id, {
        method: "PATCH", body: JSON.stringify({name: value.trim(), expected_revision: selected.revision})});
      if (mode === "transfer" && selected) await api.post(`/teacher/courses/${selected.id}/transfer`, {teacher_id: Number(value)});
      setMode(null); courses.reload();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return <><PageHeader title="课程选择"><Button onClick={() => edit("create")}>创建课程</Button></PageHeader>
    <ErrorNotice message={courses.error}/>{courses.loading && <Loading/>}
    {courses.data && !courses.data.length && <Empty title="尚未创建课程"/>}
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{courses.data?.map(c => <section key={c.id} className="surface p-5">
      <h2 className="text-lg font-semibold">{c.name}</h2><p className="hint my-3">负责教师 · {c.teacher_name}</p>
      <div className="flex flex-wrap gap-2"><Button onClick={() => onOpen(c.id)}>进入课程</Button>
      <Button variant="outline" onClick={() => edit("rename", c)}>改名</Button>
      {admin && <Button variant="outline" onClick={() => edit("transfer", c)}>转交整门课程</Button>}</div></section>)}</div>
    {mode && <Dialog open onOpenChange={open => {if (!open && !busy) setMode(null);}}><DialogContent><DialogHeader>
      <DialogTitle>{mode === "create" ? "创建课程" : mode === "rename" ? "修改课程名称" : "转交课程及全部教学班"}</DialogTitle>
    </DialogHeader><form className="space-y-4" onSubmit={save}><ErrorNotice message={error || teachers.error}/>
      {mode === "transfer" ? <><Label htmlFor="find-teacher">搜索教师姓名或工号</Label><Input id="find-teacher" value={search} onChange={e => setSearch(e.target.value)}/>
      <SelectField aria-label="新负责教师" value={value} onValueChange={setValue}><option value="">选择教师</option>
        {teachers.data?.items.filter(t => !t.disabled && t.id !== selected?.teacher_id).map(t => <option key={t.id} value={t.id}>{t.name} · {t.student_id}</option>)}</SelectField></>
      : <><Label htmlFor="course-name">课程名称</Label><Input id="course-name" maxLength={200} required value={value} onChange={e => setValue(e.target.value)}/></>}
      <Button disabled={busy || !value.trim()} type="submit">{mode === "transfer" ? "确认转交" : "保存"}</Button>
    </form></DialogContent></Dialog>}</>;
}

type Counts = {sessions: number; messages: number};
interface Overview {
  name: string; teacher: string; totals: Record<string, number>; usage: Record<string, number>;
  assistant: {learning: Counts; practice: Counts};
}
export function Insights({courseId}: {courseId: number}) {
  const report = useResource<Overview>(`/teacher/courses/${courseId}/insights`);
  const d = report.data;
  if (!d) return report.loading ? <Loading/> : <ErrorNotice message={report.error}/>;
  const groups = [
    ["教学规模", {"在教班级": d.totals.classrooms, "在籍学生": d.totals.students, "资料": d.totals.materials, "知识点": d.totals.points, "题目": d.totals.questions}],
    ["活动参与人次", {"学习": d.usage.learning ?? 0, "练习": d.usage.practice ?? 0, "测验": d.usage.assessment ?? 0}],
    ["智能体使用", {"总会话": d.assistant.learning.sessions + d.assistant.practice.sessions, "总消息": d.assistant.learning.messages + d.assistant.practice.messages,
      "学习会话": d.assistant.learning.sessions, "学习消息": d.assistant.learning.messages, "练习会话": d.assistant.practice.sessions, "练习消息": d.assistant.practice.messages}]
  ] as const;
  return <><PageHeader title={d.name} description={"负责教师 · " + d.teacher}/>{groups.map(([heading, counts]) =>
    <section key={heading} className="surface mb-4 p-5"><h2 className="mb-4 font-semibold">{heading}</h2>
      <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">{Object.entries(counts).map(([label, value]) =>
        <div key={label}><dt className="hint">{label}</dt><dd className="text-2xl font-semibold">{value}</dd></div>)}</dl>
      {heading === "活动参与人次" && <p className="hint mt-4">同一学生在本班参与同一活动计一次。</p>}</section>)}</>;
}

interface ResourceProgress {material_id: number; read_count: number; read_total: number; watched_seconds: number; required_seconds: number}
interface Result {resources?: ResourceProgress[]; completed: boolean; assessment_status?: string; score?: number | null; accepted?: number; assigned?: number; fraction?: number}
interface Report {students: {id: number; student_id: string; name: string; enrolled: boolean}[];
  activities: {material_titles: Record<number, string>; id: string; title: string; chapter: string; opened: boolean; completed: number; results: Record<number,Result>}[]}
function progress(result?: Result) {
  if (!result) return "未开始";
  if (result.assessment_status) return result.score != null ? grade(result) + " 分" : grade(result);
  if (result.completed) return "已完成";
  if (result.accepted !== undefined) return `已通过 ${result.accepted}${result.assigned ? " / " + result.assigned : ""} 题`;
  if (result.fraction !== undefined) return Math.round(result.fraction * 100) + "%";
  return "进行中";
}
function grade(result?: Result) {
  if (result?.score != null) return String(result.score);
  if (result?.assessment_status === "attention") return "评测异常";
  return result?.assessment_status === "grading" ? "待判定" : "未交";
}
export function ClassReport({classroomId, grades}: {classroomId: number; grades: boolean}) {
  const report = useResource<Report>(`/teacher/classrooms/${classroomId}/activity-report?grades=${grades}`);
  const [activity, setActivity] = useState(""), [learner, setLearner] = useState<number | null>(null);
  const d = report.data, selected = d?.activities.find(a => a.id === activity);
  if (!d) return report.loading ? <Loading/> : <ErrorNotice message={report.error}/>;
  return <><PageHeader title={grades ? "学生成绩" : "任务点明细"}/>
    {grades ? <div className="surface overflow-x-auto"><Table><TableHeader><TableRow><TableHead>学生</TableHead>
      {d.activities.map(a => <TableHead key={a.id}>{a.chapter} · {a.title}</TableHead>)}</TableRow></TableHeader><TableBody>
      {d.students.map(s => <TableRow key={s.id}><TableCell><Button variant="link" onClick={() => setLearner(s.id)}>{s.name} · {s.student_id}{!s.enrolled && "（已离班）"}</Button></TableCell>
        {d.activities.map(a => <TableCell key={a.id}>{grade(a.results[s.id])}</TableCell>)}</TableRow>)}</TableBody></Table></div>
    : <div className="surface"><Table><TableHeader><TableRow><TableHead>章节</TableHead><TableHead>活动</TableHead><TableHead>开放状态</TableHead><TableHead>完成人数</TableHead></TableRow></TableHeader>
      <TableBody>{d.activities.map(a => <TableRow key={a.id}><TableCell>{a.chapter}</TableCell><TableCell><Button variant="link" onClick={() => setActivity(a.id)}>{a.title}</Button></TableCell>
        <TableCell>{a.opened ? "已开放" : "尚未开放"}</TableCell><TableCell>{a.completed} / {d.students.length}</TableCell></TableRow>)}</TableBody></Table></div>}
    {!d.activities.length && <Empty title={grades ? "课程暂无测验" : "课程暂无活动"}/>}
    {selected && <Dialog open onOpenChange={open => {if (!open) setActivity("");}}><DialogContent><DialogHeader><DialogTitle>{selected.title}</DialogTitle></DialogHeader>
      <div className="max-h-[60vh] overflow-auto"><Table><TableHeader><TableRow><TableHead>学生</TableHead><TableHead>实际进度</TableHead></TableRow></TableHeader>
      <TableBody>{d.students.map(s => <TableRow key={s.id}><TableCell>{s.name} · {s.student_id}</TableCell><TableCell>{progress(selected.results[s.id])}
        {selected.results[s.id]?.resources?.map(r => <p className="hint" key={r.material_id}>{selected.material_titles[r.material_id]} · {
          r.read_total ? `已读 ${r.read_count} / ${r.read_total} 页` : `已观看 ${Math.floor(r.watched_seconds)} 秒`}</p>)}</TableCell></TableRow>)}</TableBody></Table></div>
    </DialogContent></Dialog>}{learner !== null && <RecordViewer showGrades history={d.students.some(s => s.id === learner && !s.enrolled)} classroomId={classroomId} studentId={learner} onClose={() => setLearner(null)}/>}</>;
}
