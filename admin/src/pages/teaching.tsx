import { ListEmpty } from "@/components/common";
import { ManagementTable } from "@/components/management-table";
import { SelectField } from "@/components/select-field";
import { useState, type FormEvent } from "react";
import { CalendarClock, Pencil } from "lucide-react";
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
