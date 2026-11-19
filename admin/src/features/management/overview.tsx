import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Empty, ErrorNotice, Loading, PageHeader, TableSearch } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useResource } from "@/lib/use-resource";

const judgeLabels: Record<string, string> = {
  prepared: "待评测", dispatching: "评测中", accepted: "已通过", wrong_answer: "解答错误", runtime_error: "运行错误",
  compile_error: "语法错误", time_limit: "运行超时", memory_limit: "内存超限", infrastructure_error: "服务异常",
  submission_unknown: "待核查", queued: "排队中", running: "运行中",
};

interface OverviewRow {
  classroom_id: number; classroom_name: string; teacher_id: number; teacher_name: string;
  student_count: number; task_total: number; task_completed: number;
  synthesis_counts: Record<string, number>; judge_counts: Record<string, number>;
}

export function GlobalOverview({ onOpen }: { onOpen: (id: number) => void }) {
  const overview = useResource<{ items: OverviewRow[] }>("/admin/overview");
  const [teacher, setTeacher] = useState("all"), [query, setQuery] = useState("");
  const teachers = new Map(overview.data?.items.map(row => [row.teacher_id, row.teacher_name]));
  const rows = overview.data?.items.filter(row => (teacher === "all" || String(row.teacher_id) === teacher)
    && row.classroom_name.toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    <PageHeader title="全局概览" description="查看各班的任务完成情况、资料合成进度和代码评测结果。"><Button variant="outline" onClick={overview.reload}><RefreshCw />刷新</Button></PageHeader>
    <div className="mb-4 flex flex-wrap items-center gap-2"><TableSearch label="搜索班级" value={query} onValueChange={setQuery} />
      <SelectField aria-label="筛选任课教师" value={teacher} onValueChange={setTeacher}>
        <option value="all">全部任课教师</option>{Array.from(teachers, ([id, name]) => <option key={id} value={id}>{name}</option>)}
      </SelectField>
    </div><ErrorNotice message={overview.error} />{overview.loading && <Loading />}
    {rows && <div className="overflow-hidden rounded-lg border bg-background"><Table><TableHeader><TableRow>
      <TableHead>班级 / 任课教师</TableHead><TableHead>学生数</TableHead><TableHead>学习任务（完成 / 总数）</TableHead>
      <TableHead>资料合成</TableHead><TableHead>代码评测</TableHead><TableHead className="text-right">操作</TableHead>
    </TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.classroom_id}>
      <TableCell>{row.classroom_name}<p className="hint">{row.teacher_name}</p></TableCell><TableCell>{row.student_count}</TableCell>
      <TableCell>{row.task_completed} / {row.task_total}</TableCell>
      <TableCell>处理中 {row.synthesis_counts.running ?? 0} · 已完成 {row.synthesis_counts.done ?? 0}
        <p className="hint">失败 {row.synthesis_counts.failed ?? 0} · 待核查 {row.synthesis_counts.interrupted ?? 0}</p></TableCell>
      <TableCell className="max-w-sm whitespace-normal">共 {Object.values(row.judge_counts).reduce((sum, count) => sum + count, 0)} 次提交
        <p className="hint">{Object.entries(row.judge_counts).filter(([, count]) => count > 0)
          .map(([status, count]) => `${judgeLabels[status] ?? status} ${count}`).join(" · ")}</p></TableCell>
      <TableCell className="text-right"><Button variant="outline" size="sm" onClick={() => onOpen(row.classroom_id)}>进入班级</Button></TableCell>
    </TableRow>)}</TableBody></Table>{!rows.length && <Empty title="没有匹配的班级" />}</div>}
  </>;
}
