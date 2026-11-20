import { SelectField } from "@/components/select-field";
import { DeleteSelection, SelectTablePage, SelectTableRow, useTableDelete } from "@/components/table-delete";
import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CurriculumDialog } from "@/features/content-workspace/curriculum-dialog";
import { Pager, ErrorNotice, Loading, Empty, TableSearch } from "@/components/common";
import { scoped } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useCatalogPage } from "@/lib/use-catalog-page";
import type { Course, Chapter, Point } from "@/lib/types";
export function Curriculum({ classroomId, tab }: { classroomId: number; tab: "chapters" | "points" }) {
  const course = useResource<Course>(scoped("/teacher/courses?view=chapters", classroomId));
  const [page, setPage] = useState(1), [size, setSize] = useState(10),
    [query, setQuery] = useState(""),
    [pointChapter, setPointChapter] = useState("all"),
    [editing, setEditing] = useState<Chapter | Point | null>(null),
    [open, setOpen] = useState(false);
  const points = useCatalogPage<Point>("/teacher/knowledge-points", classroomId, query, { chapter_id: pointChapter }, tab === "points");
  const reload = tab === "points" ? points.reload : course.reload;
  const deletion = useTableDelete<Chapter | Point>((item) => scoped(
    `/teacher/${"order_index" in item ? "chapters" : "knowledge-points"}/${item.id}`, classroomId,
  ), reload, { classroomId, kind: item => "order_index" in item ? "chapter" : null });
  function edit(item: Chapter | Point | null) { setEditing(item); setOpen(true); }
  const filtered = tab === "points" ? points.rows : (course.data?.chapters ?? []).filter(item =>
    item.title.toLowerCase().includes(query.trim().toLowerCase()));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / size)));
  const rows = tab === "points" ? filtered : filtered.slice((currentPage - 1) * size, currentPage * size);
  const add = <Button onClick={() => edit(null)} disabled={course.loading}><Plus />新增{tab === "chapters" ? "章节" : "知识点"}</Button>;
  return (
    <>
      <ErrorNotice message={course.error || points.error} />
      <div className="surface">
        <div className="toolbar">
          <TableSearch label={tab === "chapters" ? "搜索章节" : "搜索知识点"} value={query} onValueChange={(value) => { setQuery(value); deletion.clear(); points.firstPage(); setPage(1); }} />
          {tab === "points" && (
            <SelectField aria-label="知识点所属章节" value={pointChapter} onValueChange={(value) => { setPointChapter(value); deletion.clear(); points.firstPage(); }}>
              <option value="all">全部章节</option>
              {course.data?.chapters.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </SelectField>
          )}
          <div className="ml-auto">{add}</div>
        </div>
        <DeleteSelection actions={deletion} />
        {course.loading || (tab === "points" && points.loading) ? <Loading /> : !rows.length ? <Empty title="没有匹配的内容" /> : (
          <Table>
            <TableHeader><TableRow>
              <TableHead className="w-12"><SelectTablePage actions={deletion} rows={rows} /></TableHead>
              <TableHead>名称</TableHead>
              <TableHead>{tab === "chapters" ? "顺序" : "所属章节"}</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((item) => (
                <TableRow key={item.id} data-state={deletion.isSelected(item) ? "selected" : undefined}>
                  <TableCell><SelectTableRow actions={deletion} row={item} /></TableCell>
                  <TableCell className="font-medium">{item.title}</TableCell>
                  <TableCell>{"order_index" in item
                    ? `第 ${item.order_index} 章`
                    : course.data?.chapters.find((c) => c.id === item.chapter_id)?.title}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" aria-label={`编辑${item.title}`} onClick={() => edit(item)}><Pencil /></Button>
                      <Button variant="ghost" size="icon" aria-label={`删除${item.title}`} onClick={() => deletion.ask([item])}><Trash2 /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {tab === "points" ? <Pager {...points.pager} /> : <Pager page={currentPage} size={size} total={filtered.length} onPage={setPage} onSize={next => { setSize(next); setPage(1); }} />}
      </div>
      {open && <CurriculumDialog classroomId={classroomId} chapters={course.data?.chapters ?? []} tab={tab} editing={editing} onClose={saved => { setOpen(false); if (saved) reload(); }} />}
    </>
  );
}
