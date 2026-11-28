import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { ErrorNotice } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { codingTypeLabels, kinds, type CodingType } from "@/features/questions/types";
import { scoped } from "@/lib/api";
import type { Question, QuestionCandidate } from "@/lib/types";
import { useResource } from "@/lib/use-resource";

export function QuestionTags({ question }: { question: QuestionCandidate }) {
  return <span className="inline-flex flex-wrap items-center gap-1">
    <Badge variant="secondary">{kinds[question.kind]}</Badge>
    {question.kind === "python" && <Badge variant="outline">{codingTypeLabels[question.coding_type as CodingType] ?? "子类未标注"}</Badge>}
    <Badge variant="outline">{question.difficulty ? `难度：${question.difficulty}` : "难度未标注"}</Badge>
  </span>;
}

export function QuestionChoice({question, courseId, checked, disabled, onChange}: {
  question: QuestionCandidate; courseId: number; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return <div className="space-y-2 py-3">
    <div className="flex items-start gap-2">
      <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
        <input className="mt-1" type="checkbox" aria-label={question.title} checked={checked} disabled={disabled}
          onChange={e => onChange(e.target.checked)}/>
        <span className="min-w-0 space-y-1.5"><strong className="block break-words font-medium">{question.title}</strong>
          <QuestionTags question={question}/></span>
      </label>
      <Button type="button" size="sm" variant="ghost" aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}${question.title}的详情`}
        onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronUp/> : <ChevronDown/>}详情</Button>
    </div>
    {question.kind === "python" && !expanded && question.prompt_preview && question.prompt_preview !== question.title &&
      <p className="line-clamp-2 whitespace-pre-line pl-5 text-sm text-muted-foreground">{question.prompt_preview}</p>}
    {expanded && <QuestionDetail courseId={courseId} questionId={question.id}/>}
  </div>;
}

function QuestionDetail({courseId, questionId}: {courseId: number; questionId: string}) {
  const detail = useResource<Question>(scoped(`/teacher/questions/${encodeURIComponent(questionId)}`, courseId));
  const q = detail.data;
  return <div className="space-y-2 border-l pl-3 text-sm">
      {detail.loading && <p role="status">正在读取题目…</p>}
      <ErrorNotice message={detail.error}/>
      {q && <>
        <p className="whitespace-pre-wrap break-words">{q.prompt}</p>
        {q.options?.length > 0 && <ol className="list-inside list-[upper-alpha]">{q.options.map((option, i) => <li key={i}>{option}</li>)}</ol>}
        {q.samples?.map((sample, i) => <div key={i} className="rounded bg-muted p-2">
          <strong>公开样例 {i + 1}</strong>
          <div>输入</div><pre className="whitespace-pre-wrap break-all">{sample.input}</pre>
          <div>输出</div><pre className="whitespace-pre-wrap break-all">{sample.expected_output ?? sample.output}</pre>
        </div>)}
      </>}
  </div>;
}
