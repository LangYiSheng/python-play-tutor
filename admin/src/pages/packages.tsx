import { PaginatedRows } from "@/components/paginated-rows";
import { useEffect, useId, useRef, useState } from "react";
import { MoreHorizontal, RefreshCw, Search, LoaderCircle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import type { CourseInstance } from "@/lib/types";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ListEmpty, ErrorNotice } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { errorMessage, request, token } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { toast } from "@/components/ui/toast";
import { type TransferBytes } from "@/lib/package-transfer";
import { formatTimestamp } from "@/lib/time";
import { useResource } from "@/lib/use-resource";
import { type AvailablePackages, createCourseFromPackage, requestId } from "@/lib/course-packages";
interface Preview {
  id: string;
  expected_revision: number;
  package_id: string;
  package_version: string;
  name: string;
  can_apply: boolean;
  expires_at: string;
  blockers: string[];
  diff: Record<
    string,
    { added: string[]; updated: string[]; removed: string[] }
  >;
  warnings: string[];
  learning_impact?: {
    kind: string;
    stable_id: string;
    affected_records: number;
    reason: string;
  }[];
}
const labels: Record<string, string> = {
  chapter: "章节",
  knowledge_point: "知识点",
  material: "资料",
  question: "题目",
  activity: "活动",
  example: "示例",
  chapters: "章节",
  knowledge_points: "知识点",
  materials: "资料",
  questions: "题目",
  activities: "活动",
  examples: "示例",
  configuration: "课程配置",
  releases: "发布安排",
  assets: "资源文件",
  narrations: "逐页讲稿与配音",
  exams: "课程试卷",
  manifest: "包信息",
  answers: "答案与用例",
};
const phaseLabels = {
  uploading: "正在上传课程包",
  validating: "正在校验课程包并生成差异",
  applying: "正在导入课程和资源",
  creating: "正在从课程包创建课程",
  downloading: "正在下载课程包",
  deleting: "正在删除导出的课程包",
};
type Phase = keyof typeof phaseLabels;
type Operation = { phase: Phase; bytes?: TransferBytes };

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function OperationProgress({ operation }: { operation: Operation | null }) {
  const id = useId();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!operation) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [operation]);
  const { transferred = 0, total = null } = operation?.bytes ?? {};
  const percent = total
    ? Math.min(100, Math.floor((100 * transferred) / total))
    : null;
  return (
    <div className={operation ? "mt-4 space-y-2 rounded-md border bg-muted/30 p-4" : undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span id={id} aria-live="polite" className="font-medium">
          {operation ? phaseLabels[operation.phase] : ""}
        </span>
        {total && percent !== null ? (
          <span className="tabular-nums text-muted-foreground">
            {formatBytes(transferred)} / {formatBytes(total)} · {percent}%
          </span>
        ) : transferred > 0 ? (
          <span className="tabular-nums text-muted-foreground">
            已传输 {formatBytes(transferred)}
          </span>
        ) : null}
      </div>
      {operation && !total ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          已等待 {elapsed} 秒 · 正在处理课程资料，请稍候
        </div>
      ) : operation ? (
        <progress
          aria-labelledby={id}
          max={total ?? undefined}
          value={total ? transferred : undefined}
          className="block h-2 w-full accent-primary"
        />
      ) : null}
    </div>
  );
}

type PackageItem = AvailablePackages["items"][number];

export function Packages({ courses, onCreated, revision = 0 }: { revision?: number; courses: Pick<CourseInstance, "id" | "name">[]; onCreated: () => void }) {
  const [scope, setScope] = useState("mine");
  const [action, setAction] = useState<"create" | "update" | null>(null);
  const [selected, setSelected] = useState<PackageItem | null>(null);
  const [courseId, setCourseId] = useState("");
  const [courseName, setCourseName] = useState("");
  const base = `/teacher/courses/${courseId}`;
  const available = useResource<AvailablePackages>("/teacher/course/packages", revision);
  const [deleting, setDeleting] = useState<AvailablePackages["items"][number] | null>(null);
  const [packageSearch, setPackageSearch] = useState("");
  const packages = available.data?.items ?? [];
  const packageQuery = packageSearch.trim().toLowerCase();
  const visiblePackages = packages.filter((item) =>
    (scope === "mine" ? item.mine : item.shared) && (item.name + " " + item.directory).toLowerCase().includes(packageQuery),
  );
  const pending = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null),
    [requestKey, setRequestKey] = useState(""),
    [error, setError] = useState<{ phase: Phase; message: string } | null>(null),
    [operation, setOperation] = useState<Operation | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [search, setSearch] = useState(""),
    [changes, setChanges] = useState("all");
  const busy = operation !== null;
  useDraft(Boolean(preview || busy));
  useEffect(() => () => pending.current?.abort(), []);

  async function operate<T>(
    phase: Phase,
    execute: (signal: AbortSignal, report: (operation: Operation) => void) => Promise<T>,
    finish: (result: T) => void,
  ) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    const captured = token();
    const isCurrent = () => !controller.signal.aborted && captured === token();
    setOperation({ phase });
    setError(null);
    try {
      const result = await execute(controller.signal, (progress) => {
        if (isCurrent()) setOperation(progress);
      });
      if (isCurrent()) finish(result);
    } catch (e) {
      if (isCurrent()) setError({ phase, message: errorMessage(e) });
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setOperation(null);
    }
  }

  function deletePackage() {
    if (!deleting?.can_delete) return;
    return operate("deleting", (signal) => request(`/teacher/course/packages/${encodeURIComponent(deleting.key)}`, { method: "DELETE", signal }), () => {
      setDeleting(null);
      setPreview(null);
      setConfirmed(false);
      toast.add({ title: "课程包已删除", type: "success" });
      available.reload();
    });
  }

  function inspectAvailable(packageKey: string) {
    if (pending.current) return;
    setPreview(null);
    setConfirmed(false);
    return operate(
      "validating",
      (signal) => request<Preview>(`${base}/imports/available/preview`, {
        method: "POST", body: JSON.stringify({ package_key: packageKey }), signal,
      }),
      (result) => {
        setAction(null);
        setPreview(result);
        setRequestKey(requestId());
        setSearch("");
        setChanges("all");
      },
    );
  }

  function apply() {
    if (!preview || !preview.can_apply || !confirmed) return;
    return operate(
      "applying",
      (signal) =>
        request(`${base}/imports/${encodeURIComponent(preview.id)}/apply`, {
          method: "POST",
          body: JSON.stringify({
            request_id: requestKey,
            expected_revision: preview.expected_revision,
          }),
          signal,
        }),
      () => {
        setPreview(null);
        setConfirmed(false);
        available.reload();
        toast.add({ title: "课程包已导入", type: "success" });
      },
    );
  }

  function choose(item: PackageItem, next: "create" | "update") {
    setSelected(item);
    setCourseName(item.name);
    setCourseId(courses.length === 1 ? String(courses[0].id) : "");
    setRequestKey(requestId());
    setError(null);
    setAction(next);
  }

  function createCourse() {
    if (!selected || !courseName.trim()) return;
    return operate("creating", signal => createCourseFromPackage(selected.key, courseName.trim(), requestKey, signal), result => {
      setAction(null);
      onCreated();
      toast.add({ title: `已创建课程「${result.name}」`, type: "success" });
    });
  }

  const searchText = search.trim().toLowerCase();
  const rows = Object.entries(preview?.diff ?? {}).filter(([key, row]) => {
    if (!(labels[key] ?? key).toLowerCase().includes(searchText)) return false;
    if (changes === "changed") return row.added.length + row.updated.length + row.removed.length > 0;
    if (changes === "added" || changes === "updated" || changes === "removed") {
      return row[changes].length > 0;
    }
    return true;
  });

  return (
    <>
      <Dialog open={Boolean(deleting)} onOpenChange={(open) => { if (!open && !busy) setDeleting(null); }}>
        <DialogContent showCloseButton={!busy}>
          <DialogHeader><DialogTitle>删除导出的课程包</DialogTitle><DialogDescription>删除后仍可使用此前由它创建的课程，学生进度和成绩也会保留。</DialogDescription></DialogHeader>
          <p className="font-medium">{deleting?.name}</p><p className="break-all text-sm text-muted-foreground">{deleting?.directory}</p>
          <ErrorNotice message={error?.phase === "deleting" ? error.message : ""} />
          <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void deletePackage()}><Trash2 />{busy ? "正在删除…" : "确认删除"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <h1 className="sr-only">课程包管理</h1>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <SelectField aria-label="课程包来源" value={scope} onValueChange={setScope}>
          <option value="mine">我的导出</option><option value="shared">共享课程包</option>
        </SelectField>
        <Input aria-label="搜索课程包" placeholder="搜索课程名称或文件夹" className="max-w-sm" value={packageSearch} onChange={e => setPackageSearch(e.target.value)} />
        <Button variant="outline" aria-label="刷新列表" disabled={busy} onClick={available.reload}><RefreshCw/>刷新</Button>
      </div>
      <ErrorNotice message={available.error}/>
      {available.loading && <p role="status" className="hint mt-5">正在加载课程包…</p>}
      <div className="hub-grid">{visiblePackages.map(item => <article className="surface hub-card" key={item.key}>
        <div className="hub-card-head"><h2>{item.name}</h2>
          {(courses.length > 0 || item.can_delete) && <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" disabled={busy || Boolean(preview)} aria-label={item.name + "的更多操作"}/>}><MoreHorizontal/></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {courses.length > 0 && <DropdownMenuItem onClick={() => choose(item, "update")}>更新已有课程</DropdownMenuItem>}
              {item.can_delete && <DropdownMenuItem onClick={() => {setDeleting(item); setError(null);}}>删除课程包</DropdownMenuItem>}
            </DropdownMenuContent></DropdownMenu>}
        </div>
        <p className="hint">{item.chapter_count} 章 · {item.question_count} 道题{item.created_at && <> · {formatTimestamp(item.created_at)}</>}</p>
        <p className="hint break-all">{item.directory}</p>
        <div className="hub-card-footer"><Button disabled={busy || Boolean(preview)} onClick={() => choose(item, "create")}>以此创建课程</Button></div>
      </article>)}</div>
      {!available.loading && !available.error && !visiblePackages.length && <ListEmpty title={scope === "mine" ? "还没有导出的课程包" : "暂无共享课程包"} description={scope === "mine" ? "可在课程卡片的更多操作中选择「导出课程包」。" : undefined} filtered={Boolean(packageQuery)} reset={() => setPackageSearch("")} />}
      {available.data?.unavailable ? <p className="hint">有 {available.data.unavailable} 份课程包暂不可用。</p> : null}
      <Dialog open={action !== null} onOpenChange={open => { if (!open && !busy) setAction(null); }}>
        <DialogContent showCloseButton={!busy}><DialogHeader><DialogTitle>{action === "create" ? "从课程包创建课程" : "更新已有课程"}</DialogTitle>
          <DialogDescription>{selected?.name} · {selected?.chapter_count} 章 · {selected?.question_count} 道题</DialogDescription></DialogHeader>
          <form className="space-y-4" onSubmit={e => { e.preventDefault(); if (action === "create") void createCourse(); else if (selected && courseId) void inspectAvailable(selected.key); }}>
            {action === "create" ? <><Label htmlFor="package-course-name">新课程名称</Label><Input id="package-course-name" value={courseName} onChange={e => setCourseName(e.target.value)} required maxLength={200} disabled={busy}/></> :
              <><Label htmlFor="package-target">目标课程</Label><SelectField className="w-full" id="package-target" value={courseId} onValueChange={setCourseId} disabled={busy}>
                <option value="">选择课程</option>{courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField></>}
            <ErrorNotice message={error?.phase === "creating" || error?.phase === "validating" ? error.message : ""}/>
            <OperationProgress operation={operation}/>
            <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setAction(null)} type="button">取消</Button>
              <Button type="submit" disabled={busy || (action === "create" ? !courseName.trim() : !courseId)}>{action === "create" ? "创建课程" : "预览差异"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {preview ? (
        <Dialog open onOpenChange={open => { if (!open && !busy) setPreview(null); }}>
          <DialogContent className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl" showCloseButton={!busy}>
          <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
            <DialogTitle>导入差异</DialogTitle>
            <DialogDescription className="break-words">
              {preview.name} · {preview.package_version} → {courses.find(c => String(c.id) === courseId)?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto">
          <div className="toolbar">
            <div className="search">
              <Search size={16} aria-hidden="true" />
              <Input
                aria-label="搜索差异内容"
                placeholder="搜索内容类型"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <SelectField aria-label="变更类型" value={changes} onValueChange={setChanges}>
              <option value="all">全部变更</option>
              <option value="changed">仅显示有变化的内容</option>
              <option value="added">有新增</option>
              <option value="updated">有更新</option>
              <option value="removed">有移除</option>
            </SelectField>
          </div>
          <PaginatedRows rows={rows}>{visible => <Table>
            <TableHeader>
              <TableRow>
                <TableHead>内容</TableHead>
                <TableHead>新增</TableHead>
                <TableHead>更新</TableHead>
                <TableHead>移除</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map(([key, row]) => (
                <TableRow key={key}>
                  <TableCell>{labels[key] ?? key}</TableCell>
                  <TableCell>{row.added.length}</TableCell>
                  <TableCell>{row.updated.length}</TableCell>
                  <TableCell>{row.removed.length}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    没有符合筛选条件的变更
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>}</PaginatedRows>
          {preview.learning_impact?.length ? (
            <div className="p-5 border-t">
              <h3 className="font-semibold mb-3">学习记录影响</h3>
              {preview.learning_impact.map((item, i) => (
                <p className="text-sm my-2" key={i}>
                  {labels[item.kind] ?? item.kind} · 涉及{" "}
                  {item.affected_records} 条记录：{item.reason}
                </p>
              ))}
            </div>
          ) : null}
          {preview.blockers?.length ? (
            <div className="p-5">
              <ErrorNotice message={preview.blockers.join("；")} />
            </div>
          ) : null}
          {preview.warnings?.length ? (
            <div className="p-5 text-amber-800 bg-amber-50">
              {preview.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          ) : null}
          </div>
          <div className="max-h-[45dvh] shrink-0 overflow-y-auto border-t p-4">
            <ErrorNotice message={error?.phase === "applying" ? error.message : ""} />
            <div className="flex items-center gap-2 mb-4">
              <Checkbox
                id="confirm-course-import"
                aria-labelledby="confirm-course-import-label"
                checked={confirmed}
                onCheckedChange={setConfirmed}
                disabled={busy || !preview.can_apply}
              />
              <Label htmlFor="confirm-course-import" id="confirm-course-import-label">
                我已核对差异，确认更新本课程及所有教学班的共享内容
              </Label>
            </div>
            <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => setPreview(null)}>取消导入</Button><Button
              onClick={() => void apply()}
              disabled={!confirmed || busy || !preview.can_apply}
            >
              确认导入
            </Button></div>
            <OperationProgress operation={operation?.phase === "applying" ? operation : null} />
            <p className="hint mt-3">
              若课程已被其他操作修改，需要重新预览。导入不清除已有学习记录。
              预览有效期至{" "}
              {formatTimestamp(preview.expires_at)}。
            </p>
          </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
