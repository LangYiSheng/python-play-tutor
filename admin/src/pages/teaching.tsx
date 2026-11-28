import { ListEmpty } from "@/components/common";
import { ManagementTable } from "@/components/management-table";
import { SelectField } from "@/components/select-field";
import { useEffect, useState, type FormEvent } from "react";
import { CalendarClock, Pause, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  PageHeader,
  ErrorNotice,
  TableSearch,
} from "@/components/common";
import { TableSkeleton } from "@/components/skeletons";
import { api, scoped, errorMessage } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useDraft } from "@/lib/drafts";
import { toast } from "@/components/ui/toast";
import type { Chapter, Course } from "@/lib/types";
import { formatTimestamp, isoToLocalDateTime, localDateTimeToIso, TIME_ZONE } from "@/lib/time";
import { chapterReleaseState, type ChapterRelease } from "@/lib/chapter-release";

export { StudentRecordSheet as RecordViewer } from "@/features/analytics/student-record-sheet";

const date = formatTimestamp;
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
    [opensAt, setOpensAt] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState(false),
    [releaseQuery, setReleaseQuery] = useState(""),
    [releaseFilter, setReleaseFilter] = useState("all");
  useDraft(!!editing && dirty);
  const nextOpening = Math.min(...(releases.data ?? [])
    .filter(row => row.status === "published" && row.opens_at)
    .map(row => Date.parse(row.opens_at!))
    .filter(time => time > Date.now()));
  const reload = releases.reload;
  useEffect(() => {
    if (!Number.isFinite(nextOpening)) return;
    const timer = window.setTimeout(reload, Math.min(2_147_483_647, nextOpening - Date.now() + 1));
    return () => window.clearTimeout(timer);
  }, [nextOpening, reload, releases.data]);
  function edit(chapter: Chapter) {
    const row = releases.data?.find((r) => r.chapter_id === chapter.id);
    setEditing(chapter);
    setOpensAt(
      row?.opens_at ? isoToLocalDateTime(row.opens_at) : "",
    );
    setDirty(false);
    setError("");
  }
  async function updateRelease(chapter: Chapter, status: ChapterRelease["status"], scheduledTime?: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const opens_at = scheduledTime ? localDateTimeToIso(scheduledTime) : null;
      if (opens_at && Date.parse(opens_at) <= Date.now()) throw new Error("请选择将来的开放时间");
      await api.put(
        `/teacher/classrooms/${classroomId}/releases/${chapter.id}`,
        {
          status,
          opens_at,
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
  function schedule(e: FormEvent) {
    e.preventDefault();
    if (editing && opensAt) void updateRelease(editing, "published", opensAt);
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
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <TableSearch label="搜索章节" placeholder="搜索章节名称" value={releaseQuery} onValueChange={setReleaseQuery} />
        <SelectField aria-label="章节开放状态" value={releaseFilter} onValueChange={setReleaseFilter}>
          <option value="all">全部开放状态</option>
          {Object.entries(releaseLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </SelectField>
        <span id="teaching-columns-0" className="ml-auto" />
      </div>
      {course.loading || releases.loading ? (
        <TableSkeleton rows={4} />
      ) : !chapters.length ? (
        <div className="surface">
          <ListEmpty
            title="还没有章节"
            description="可在「章节与课件」中添加章节。"
            filtered={Boolean(releaseQuery.trim()) || releaseFilter !== "all"}
            reset={() => {
              setReleaseQuery("");
              setReleaseFilter("all");
            }}
          />
        </div>
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
                  {r?.opens_at ? date(r.opens_at) : state === "published" ? "立即开放" : "—"}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    {state === "published" ? (
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => void updateRelease(c, "paused")}>
                        <Pause /> 暂停
                      </Button>
                    ) : (
                      <>
                        <Button size="sm" disabled={busy} onClick={() => void updateRelease(c, "published")}>
                          <Send /> 立即发布
                        </Button>
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => edit(c)}>
                          <CalendarClock /> 设置定时
                        </Button>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ManagementTable>
      )}
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
            <DialogTitle>设置定时开放</DialogTitle>
            <DialogDescription>
              {editing?.title} · {TIME_ZONE}
            </DialogDescription>
          </DialogHeader>
          <form inert={busy} aria-busy={busy} onSubmit={schedule} onChange={() => setDirty(true)}>
            <ErrorNotice message={error} />
            <div className="field">
              <Label htmlFor="release-time">开放时间</Label>
              <Input
                id="release-time"
                type="datetime-local"
                required
                value={opensAt}
                onChange={(e) => setOpensAt(e.target.value)}
              />
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
