import { PaginatedRows } from "@/components/paginated-rows";
import { ListEmpty } from "@/components/common";
import { ManagementTable } from "@/components/management-table";
import { SelectField } from "@/components/select-field";
import { useState, type FormEvent } from "react";
import { CalendarClock, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  PageHeader,
  ErrorNotice,
  Loading,
  Empty,
  TableSearch,
} from "@/components/common";
import { api, scoped, errorMessage } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useDraft } from "@/lib/drafts";
import { toast } from "@/components/ui/toast";
import type { Chapter, Course } from "@/lib/types";
import { formatTimestamp, isoToLocalDateTime, localDateTimeToIso, TIME_ZONE } from "@/lib/time";
import { chapterReleaseState, type ChapterRelease } from "@/lib/chapter-release";
interface StudentRecord {
  assessments?: { id: string; activity_id: string; activity_title?: string; score: number | null; max_score: number; status: string }[];
  student: { name: string; student_id: string | null };
  chapters: {id: number; title: string; completed: boolean; tasks: {id: string; title: string; kind: string; required: boolean; completed: boolean; locked: boolean; current: number; total: number; unit: string}[]}[];
  participation: {
    id: string;
    title: string; chapter: string; kind: string; created_at: string | null;
    read_pages?: number; read_seconds?: number; watched_seconds?: number; current?: number; total?: number;
  }[];
  submissions: {
    id: string;
    question_id: string;
    mode: string;
    status: string;
    answer: unknown;
    code: string | null;
    feedback: unknown;
    created_at: string;
  }[];
}
const date = formatTimestamp;
const taskKinds: Record<string, string> = {reading: "资料阅读", objective: "客观题练习", programming: "编程题练习", assessment: "测验"};
const releaseLabels = {
  unpublished: "未发布",
  paused: "已暂停",
  scheduled: "等待开放",
  published: "已发布",
};
export function Teaching({ classroomId, courseId }: { classroomId: number; courseId: number }) {
  const course = useResource<Course>(scoped("/teacher/catalog", courseId)),
    releases = useResource<ChapterRelease[]>(
      `/teacher/classrooms/${classroomId}/releases`,
    );
  const [editing, setEditing] = useState<Chapter | null>(null),
    [status, setStatus] = useState<ChapterRelease["status"]>("published"),
    [opensAt, setOpensAt] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState(false),
    [releaseQuery, setReleaseQuery] = useState(""),
    [releaseFilter, setReleaseFilter] = useState("all");
  useDraft(!!editing && dirty);
  function edit(chapter: Chapter) {
    const row = releases.data?.find((r) => r.chapter_id === chapter.id);
    setEditing(chapter);
    setStatus(row?.status ?? "published");
    setOpensAt(
      row?.opens_at ? isoToLocalDateTime(row.opens_at) : "",
    );
    setDirty(false);
    setError("");
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      await api.put(
        `/teacher/classrooms/${classroomId}/releases/${editing.id}`,
        {
          status,
          opens_at: opensAt ? localDateTimeToIso(opensAt) : null,
        },
      );
      setEditing(null);
      setDirty(false);
      toast.add({ title: "章节安排已保存", type: "success" });
      releases.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const releaseByChapter = new Map(releases.data?.map((r) => [r.chapter_id, r]));
  const chapters = (course.data?.chapters ?? []).map((chapter) => {
    const release = releaseByChapter.get(chapter.id);
    const state = chapterReleaseState(release);
    return { chapter, release, state } as const;
  }).filter(({ chapter, state }) =>
    chapter.title.toLowerCase().includes(releaseQuery.trim().toLowerCase()) &&
    (releaseFilter === "all" || releaseFilter === state),
  );
  return (
    <>
      <PageHeader
        title="章节安排"
      />
      <ErrorNotice
        message={
          course.error ||
          releases.error ||
          (!editing ? error : "")
        }
      />
        <div className="surface">
          <div className="toolbar">
            <TableSearch label="搜索章节" placeholder="搜索章节名称" value={releaseQuery} onValueChange={setReleaseQuery} />
            <SelectField aria-label="章节开放状态" value={releaseFilter} onValueChange={setReleaseFilter}>
              <option value="all">全部开放状态</option>
              {Object.entries(releaseLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </SelectField>
          <span id="teaching-columns-0" className="ml-auto" /></div>
          {course.loading || releases.loading ? (
            <Loading />
          ) : !chapters.length ? (
            <ListEmpty title="还没有章节" description="可在课程内容列表添加章节。" filtered={Boolean(releaseQuery.trim()) || releaseFilter !== "all"} reset={() => { setReleaseQuery(""); setReleaseFilter("all"); }} />
          ) : (
            <ManagementTable toolsId="teaching-columns-0" paginate key={releaseQuery + releaseFilter}>
              <TableHeader>
                <TableRow>
                  <TableHead>章节</TableHead>
                  <TableHead>开放状态</TableHead>
                  <TableHead>开放时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {chapters.map(({ chapter: c, release: r, state }) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.title}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            r?.status === "published" ? "outline" : "secondary"
                          }
                        >
                          {releaseLabels[state]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {r?.opens_at ? date(r.opens_at) : r ? "立即开放" : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => edit(c)}
                        >
                          <Pencil />
                          设置
                        </Button>
                      </TableCell>
                    </TableRow>
                ))}
              </TableBody>
            </ManagementTable>
          )}
        </div>
      <Dialog
        open={!!editing}
        onOpenChange={(v) => {
          if (!v && !busy) {
            setEditing(null);
            setDirty(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>设置章节安排</DialogTitle>
            <DialogDescription>
              {editing?.title} · 开放时间采用当前设备时区
            </DialogDescription>
          </DialogHeader>
          <form inert={busy} aria-busy={busy} onSubmit={save} onChange={() => setDirty(true)}>
            <ErrorNotice message={error} />
            <div className="field">
              <Label htmlFor="release-status">状态</Label>
              <SelectField
                id="release-status"
                value={status}
                onValueChange={(value) => { setStatus(value as ChapterRelease["status"]); setDirty(true); }}
              >
                <option value="published">发布</option>
                <option value="paused">暂停</option>
              </SelectField>
              <p className="hint">
                暂停后阻止新的学习请求，已经产生的历史记录保留。
              </p>
            </div>
            <div className="field">
              <Label htmlFor="release-time">开放时间（可选）</Label>
              <Input
                id="release-time"
                type="datetime-local"
                value={opensAt}
                onChange={(e) => setOpensAt(e.target.value)}
              />
              <p className="hint">时区：{TIME_ZONE}。留空则立即开放。</p>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy}>
                <CalendarClock />
                {busy ? "保存中…" : "保存安排"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
function readable(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "正确" : "错误";
  if (Array.isArray(value)) return value.map(readable).join("、");
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${k}：${readable(v)}`)
    .join("\n");
}
export function RecordViewer({
  classroomId,
  studentId,
  history = false,
  showGrades = false,
  onClose,
}: {
  classroomId: number;
  studentId: number;
  course?: Course | null;
  history?: boolean;
  showGrades?: boolean;
  onClose: () => void;
}) {
  const result = useResource<StudentRecord>(
      `/teacher/classrooms/${classroomId}/${history ? "history" : "students"}/${studentId}`,
    ),
    [tab, setTab] = useState(history || showGrades ? "assessments" : "submissions");
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {result.data?.student.name ?? "学生"}的学习记录
          </DialogTitle>
          <DialogDescription>
            {result.data?.student.student_id ?? "未分配学号"} · 当前班级
          </DialogDescription>
        </DialogHeader>
        <ErrorNotice message={result.error} />
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList variant="line" aria-label="学生记录类型">
            <TabsTrigger value="assessments">测验成绩</TabsTrigger>
            <TabsTrigger value="submissions">作答记录</TabsTrigger>
            <TabsTrigger value="participation">活动参与</TabsTrigger>
            <TabsTrigger value="chapters">章节任务</TabsTrigger>
          </TabsList>
          <TabsContent value={tab} className="max-h-[60vh] space-y-4 overflow-y-auto">
            {result.loading ? (
              <Loading />
            ) : tab === "assessments" ? (
              result.data?.assessments?.length ? <PaginatedRows rows={result.data.assessments}>{visible => <Table><TableHeader><TableRow>
                <TableHead>测验</TableHead><TableHead>成绩</TableHead>
              </TableRow></TableHeader><TableBody>{visible.map(item => <TableRow key={item.id}>
                <TableCell>{item.activity_title || item.activity_id}</TableCell><TableCell>{item.score === null ? (item.status === "draft" ? "未交" : item.status === "attention" ? "评测异常" : "待判定") : `${item.score} / ${item.max_score}`}</TableCell>
              </TableRow>)}</TableBody></Table>}</PaginatedRows> : <Empty title="暂无测验成绩" />
            ) : tab === "submissions" ? (
            result.data?.submissions.length ? (
              result.data.submissions
                .slice()
                .reverse()
                .map((s) => (
                  <details className="border rounded-lg p-4" key={s.id}>
                    <summary className="cursor-pointer flex flex-wrap gap-3">
                      <Badge variant="outline">
                        {s.mode === "submit" ? "正式提交" : "试运行"}
                      </Badge>
                      <span>{s.status}</span>
                      <time className="ml-auto text-xs text-muted-foreground">
                        {date(s.created_at)}
                      </time>
                    </summary>
                    <div className="mt-4 space-y-3">
                      <p className="text-sm">题目：{s.question_id}</p>
                      <pre className="whitespace-pre-wrap text-sm bg-muted rounded p-3">
                        {s.code || readable(s.answer)}
                      </pre>
                      <p className="whitespace-pre-wrap text-sm">
                        {readable(s.feedback)}
                      </p>
                    </div>
                  </details>
                ))
            ) : (
              <Empty title="暂无作答记录" />
            )
          ) : tab === "participation" ? (
            result.data?.participation.length ? (
              result.data.participation.map((r) => (
                  <article className="border rounded-lg p-4" key={r.id}>
                    <div className="flex justify-between gap-4">
                      <h3 className="font-medium">
                        {r.title}
                      </h3>
                      <time className="text-xs text-muted-foreground">
                        {r.created_at && date(r.created_at)}
                      </time>
                    </div>
                    <p className="text-sm text-muted-foreground mt-2">
                      {r.chapter} · {taskKinds[r.kind]}
                    </p>
                    <p className="text-sm whitespace-pre-wrap mt-2">
                      {r.watched_seconds !== undefined ? `有效观看 ${r.watched_seconds} 秒`
                        : r.read_pages !== undefined ? `已读 ${r.read_pages} 页，有效阅读 ${r.read_seconds} 秒`
                        : `题目进度 ${r.current} / ${r.total}`}
                    </p>
                  </article>
                ))
            ) : (
              <Empty title="暂无参与记录" />
            )
          ) : result.data?.chapters?.length ? (
            result.data.chapters.map(chapter => (
              <section className="rounded-lg border p-4" key={chapter.id}>
                <h3 className="font-medium">{chapter.title} {chapter.completed && <Badge>已完成</Badge>}</h3>
                {chapter.tasks.length ? <ul className="mt-2 divide-y">{chapter.tasks.map(task => (
                  <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm" key={task.id}>
                    <span>{task.title}</span>
                    <span className="text-muted-foreground">{taskKinds[task.kind]} · {task.required ? "必做" : "选做"}</span>
                    <span className="ml-auto">{task.completed ? "已完成" : task.locked ? "待解锁" : "未完成"} · {task.current}/{task.total} {task.unit}</span>
                  </li>
                ))}</ul> : <p className="mt-2 text-sm text-muted-foreground">本章暂无任务</p>}
              </section>
            ))
          ) : (
            <Empty title="本班暂无已开放章节" />
          )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
