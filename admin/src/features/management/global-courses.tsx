import { useState, type FormEvent } from "react";
import { ArrowUpRight, Ellipsis, Plus, RefreshCw, Trash2 } from "lucide-react";
import { ErrorNotice, ListEmpty, Loading, PageHeader, TableSearch } from "@/components/common";
import { ManagementTable } from "@/components/management-table";
import { SelectField } from "@/components/select-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { api, errorMessage, request } from "@/lib/api";
import type { Classroom, CourseInstance } from "@/lib/types";
import { useResource } from "@/lib/use-resource";
import { CourseDeleteDialog } from "@/pages/course-delete-dialog";
import { CreateCourseDialog } from "@/pages/create-course-dialog";

type CourseResource = ReturnType<typeof useResource<CourseInstance[]>>;

export function GlobalCourses({
  courses,
  classes,
  exporting,
  exportCourse,
  onOpen,
}: {
  courses: CourseResource;
  classes: Classroom[];
  exporting: number | null;
  exportCourse: (course: CourseInstance) => Promise<void>;
  onOpen: (id: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [teacherFilter, setTeacherFilter] = useState("all");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<CourseInstance | null>(null);
  const [mode, setMode] = useState<"rename" | "transfer" | null>(null);
  const [selected, setSelected] = useState<CourseInstance>();
  const [value, setValue] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const teachers = useResource<{
    total: number;
    items: { id: number; name: string; student_id: string; disabled: boolean }[];
  }>(
    mode === "transfer"
      ? `/admin/accounts?role=teacher&size=100&q=${encodeURIComponent(search)}`
      : null,
  );
  const candidates =
    teachers.data?.items.filter(
      (teacher) => !teacher.disabled && teacher.id !== selected?.teacher_id,
    ) ?? [];
  const canSave =
    mode === "transfer"
      ? candidates.some((teacher) => String(teacher.id) === value)
      : Boolean(value.trim());

  const teacherOptions = new Map<number, string>();
  for (const item of courses.data ?? []) {
    if (item.teacher_name) teacherOptions.set(item.teacher_id, item.teacher_name);
  }

  const needle = query.trim().toLowerCase();
  const rows = (courses.data ?? []).filter((c) => {
    if (teacherFilter !== "all" && String(c.teacher_id) !== teacherFilter) return false;
    if (!needle) return true;
    return `${c.name} ${c.teacher_name ?? ""}`.toLowerCase().includes(needle);
  });

  function openEdit(action: "rename" | "transfer", course: CourseInstance) {
    setSelected(course);
    setValue(action === "rename" ? course.name : "");
    setMode(action);
    setError("");
    setSearch("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !canSave || !selected) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "rename") {
        await request(`/teacher/courses/${selected.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: value.trim(), expected_revision: selected.revision }),
        });
        toast.add({ title: "课程名称已更新", type: "success" });
      } else if (mode === "transfer") {
        await api.post(`/teacher/courses/${selected.id}/transfer`, {
          teacher_id: Number(value),
        });
        toast.add({ title: "课程已转交", type: "success" });
      }
      setMode(null);
      courses.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const isFiltered = Boolean(needle) || teacherFilter !== "all";

  return (
    <>
      <PageHeader
        title="课程管理"
        description="管理全站所有教师负责的课程，支持进入课程工作台、导出课程包、转交或删除。"
      >
        <Button variant="outline" onClick={courses.reload} disabled={courses.loading}>
          <RefreshCw />
          刷新
        </Button>
        <Button onClick={() => setCreating(true)}>
          <Plus />
          创建课程
        </Button>
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <TableSearch
          label="搜索课程或教师"
          placeholder="搜索课程名称或负责教师"
          value={query}
          onValueChange={setQuery}
        />
        <SelectField
          aria-label="筛选负责教师"
          value={teacherFilter}
          onValueChange={setTeacherFilter}
        >
          <option value="all">全部负责教师</option>
          {Array.from(teacherOptions, ([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </SelectField>
        <span id="global-courses-columns" className="ml-auto" />
      </div>

      <ErrorNotice message={courses.error} />
      {courses.loading && <Loading />}

      {courses.data && (
        <div className="overflow-hidden rounded-lg border bg-background">
          <ManagementTable
            toolsId="global-courses-columns"
            paginate
            key={`${query}:${teacherFilter}`}
          >
            <TableHeader>
              <TableRow>
                <TableHead>课程名称</TableHead>
                <TableHead>负责教师</TableHead>
                <TableHead>在教班级</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => {
                const courseRooms = classes
                  .filter((room) => room.course_id === c.id)
                  .map((room) => room.name);
                const roomSummary = courseRooms.join("、");
                return (
                  <TableRow key={c.id}>
                    <TableCell className="py-2 font-medium">{c.name}</TableCell>
                    <TableCell className="py-2 text-muted-foreground">
                      {c.teacher_name ?? `#${c.teacher_id}`}
                    </TableCell>
                    <TableCell className="max-w-md py-2 whitespace-normal">
                      {courseRooms.length > 0 ? (
                        <span
                          className="line-clamp-1 text-muted-foreground"
                          title={roomSummary}
                        >
                          {courseRooms.length} 个班 · {roomSummary}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">尚未开班</span>
                      )}
                    </TableCell>
                    <TableCell className="py-2 text-right whitespace-nowrap">
                      <div className="flex flex-nowrap items-center justify-end gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => onOpen(c.id)}>
                          进入课程
                          <ArrowUpRight data-icon="inline-end" />
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`${c.name}的更多操作`}
                              />
                            }
                          >
                            <Ellipsis />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEdit("rename", c)}>
                              修改课程名称
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={exporting !== null}
                              onClick={() => void exportCourse(c)}
                            >
                              导出课程包
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => openEdit("transfer", c)}>
                              转交整门课程
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={exporting === c.id}
                              onClick={() => setDeleting(c)}
                            >
                              <Trash2 />
                              删除课程
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </ManagementTable>
          {!rows.length && (
            <ListEmpty
              title="暂无课程"
              filtered={isFiltered}
              reset={() => {
                setQuery("");
                setTeacherFilter("all");
              }}
              action={
                <Button onClick={() => setCreating(true)}>创建第一门课程</Button>
              }
            />
          )}
        </div>
      )}

      {creating && (
        <CreateCourseDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            courses.reload();
          }}
        />
      )}

      {deleting && (
        <CourseDeleteDialog
          course={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            courses.reload();
            toast.add({ title: "课程已删除", type: "success" });
          }}
        />
      )}

      {mode && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setMode(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {mode === "rename" ? "修改课程名称" : "转交课程及全部教学班"}
              </DialogTitle>
            </DialogHeader>
            <form className="space-y-4" onSubmit={save}>
              <ErrorNotice message={error || teachers.error} />
              {mode === "transfer" ? (
                <div className="grid gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="admin-find-teacher">搜索教师姓名或工号</Label>
                    <Input
                      id="admin-find-teacher"
                      type="search"
                      maxLength={100}
                      value={search}
                      disabled={busy}
                      onChange={(event) => {
                        setSearch(event.target.value);
                        setValue("");
                        setError("");
                      }}
                    />
                  </div>
                  <fieldset disabled={busy} className="min-w-0">
                    <legend className="sr-only">新负责教师</legend>
                    <div className="max-h-44 overflow-y-auto rounded-lg border p-1">
                      {teachers.loading && (
                        <p className="hint p-2" role="status">
                          正在查找教师…
                        </p>
                      )}
                      {teachers.data && !candidates.length && (
                        <p className="hint p-2" role="status">
                          {search.trim() ? "未找到匹配的教师" : "暂无可转交的教师"}
                        </p>
                      )}
                      {teachers.error && (
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={teachers.reload}
                        >
                          重新加载
                        </Button>
                      )}
                      {candidates.map((teacher) => (
                        <label
                          key={teacher.id}
                          className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-muted has-checked:bg-muted"
                        >
                          <input
                            type="radio"
                            name="admin-transfer-teacher"
                            value={teacher.id}
                            checked={value === String(teacher.id)}
                            onChange={() => setValue(String(teacher.id))}
                          />
                          <span className="min-w-0 flex-1 break-words">
                            {teacher.name}
                          </span>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {teacher.student_id}
                          </span>
                        </label>
                      ))}
                    </div>
                    {teachers.data &&
                      teachers.data.total > teachers.data.items.length && (
                        <p className="hint mt-1">输入姓名或工号可缩小范围。</p>
                      )}
                  </fieldset>
                </div>
              ) : (
                <div className="grid gap-2">
                  <Label htmlFor="admin-course-name">课程名称</Label>
                  <Input
                    id="admin-course-name"
                    maxLength={200}
                    required
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                </div>
              )}
              <Button disabled={busy || !canSave} type="submit">
                {mode === "transfer" ? "确认转交" : "保存"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
