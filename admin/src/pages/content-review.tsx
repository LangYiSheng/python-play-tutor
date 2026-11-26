import { useState } from "react";
import { ChevronLeft, ChevronRight, FileQuestionMark, FileText, Presentation, RefreshCw } from "lucide-react";
import { Empty, ErrorNotice, Loading } from "@/components/common";
import { Button, ButtonLink } from "@/components/ui/button";
import { useGraphData } from "@/features/content-workspace/use-graph-data";
import "@/features/content-workspace/review-panel.css";

type PendingMaterial = {
  material_id: number;
  material_title: string;
  material_kind: "presentation" | "pdf";
  narration_count: number;
  first_page_no: number;
};
type MaterialPage = { items: PendingMaterial[]; total: number; page: number; question_count: number };
type Props = {
  classroomId: number;
  revision?: number;
  onOpenMaterial: (materialId: number, pageNo: number) => void;
};

const pageSize = 25;

export function ContentReviewPanel(props: Props) {
  return <PendingContent key={props.classroomId} {...props}/>;
}

function PendingContent({ classroomId, revision = 0, onOpenMaterial }: Props) {
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const result = useGraphData<MaterialPage>(
    `/teacher/classrooms/${classroomId}/content-review/materials?page=${page}&size=${pageSize}`,
    revision + retry,
  );
  if (result?.error) return <div className="review-panel">
    <ErrorNotice message={result.error}/>
    <Button size="sm" variant="outline" onClick={() => setRetry(n => n + 1)}><RefreshCw/>重新加载</Button>
  </div>;
  if (!result?.data) return <Loading/>;
  const {items, total, page: current, question_count: questions} = result.data;
  if (!total && !questions) return <Empty title="当前班级没有待审批内容"/>;

  const pages = Math.ceil(total / pageSize);
  return <div className="review-panel">
    <ul className="review-list" aria-label="待审批内容">
      {items.map(item => {
        const ppt = item.material_kind === "presentation";
        const Icon = ppt ? Presentation : FileText;
        return <li key={item.material_id}>
          <Button className="review-row" variant="ghost" onClick={() => onOpenMaterial(item.material_id, item.first_page_no)}>
            <Icon aria-hidden/><span className="review-row-copy">
              <strong>{item.material_title}</strong><small>{ppt ? "PPT" : "PDF"} · {item.narration_count} 页讲解稿待审</small>
            </span><ChevronRight aria-hidden/>
          </Button>
        </li>;
      })}
      {questions > 0 && <li>
        <ButtonLink className="review-row" variant="ghost" href="/teacher/assessments?tab=bank&status=draft&reviewable=true">
          <FileQuestionMark aria-hidden/><span className="review-row-copy">
            <strong>待审题目</strong><small>{questions} 道题目草稿</small>
          </span><ChevronRight aria-hidden/>
        </ButtonLink>
      </li>}
    </ul>
    {pages > 1 && <nav className="review-pagination" aria-label="待审课件分页">
      <span>共 {total} 份课件</span>
      <div><Button size="icon-sm" variant="outline" aria-label="上一页课件" disabled={current <= 1}
        onClick={() => setPage(current - 1)}><ChevronLeft/></Button>
        <span>{current} / {pages}</span>
        <Button size="icon-sm" variant="outline" aria-label="下一页课件" disabled={current >= pages}
          onClick={() => setPage(current + 1)}><ChevronRight/></Button></div>
    </nav>}
  </div>;
}
