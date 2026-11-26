import { ListEmpty } from "@/components/common";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { questionKindLabels } from "../../../../shared/questions";
import type { CatalogChapter, ChapterSelection, KindCounts, PointQuota, QuestionStage, StageRule } from "./contracts";
import { describeKinds, kindProblem, pointQuotas, stageKinds, stageNames, validCount } from "./question-plan";

type CountFieldProps = {
  label: string; count: number; min?: number; hint?: string; onChange: (count: number) => void;
};
export function CountField({ label, count, min = 1, hint, onChange }: CountFieldProps) {
  const hintId = useId();
  return <label className="inline-flex items-center gap-2 text-sm">
    <span>{label}</span>
    <Input type="number" aria-label={label} aria-describedby={hint ? hintId : undefined} min={min} max={100} step={1} className="w-20"
      value={Number.isFinite(count) ? count : ""} onChange={event => onChange(event.target.valueAsNumber)} />
    <span className="text-muted-foreground">题</span>
    {hint && <span id={hintId} className="hint">{hint}</span>}
  </label>;
}

function KindEditor({ stage, count, byKind = {}, available, onChange }: {
  stage: QuestionStage; count: number; byKind?: KindCounts; available?: KindCounts; onChange: (counts: KindCounts) => void;
}) {
  const error = kindProblem(stage, count, byKind);
  return <details className="mt-3 rounded-md border px-3 py-2">
    <summary className="cursor-pointer text-sm font-medium">指定题型数量
      <span className="ml-2 font-normal text-muted-foreground">{describeKinds(byKind) || "自动选题"}</span>
    </summary>
    <p className="hint my-3">填写的题型按指定数量选题，填 0 可排除该题型。剩余名额由留空的题型补足。</p>
    <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
      {stageKinds[stage].map(kind => {
        const amount = byKind[kind];
        const stock = available ? available[kind] ?? 0 : undefined;
        return <label className="space-y-1 text-sm" key={kind}>
          <span>{questionKindLabels[kind]}</span>
          <Input type="number" aria-label={questionKindLabels[kind]} min={0} max={100} step={1} value={amount ?? ""}
            placeholder="自动" onChange={event => {
              const next = { ...byKind };
              if (event.target.value === "") delete next[kind];
              else next[kind] = event.target.valueAsNumber;
              onChange(next);
            }} />
          {stock !== undefined && <span className={(amount ?? 0) > stock ? "text-amber-700" : "hint"}>
            可用 {stock} 题{amount !== undefined && amount > stock && `，缺 ${amount - stock} 题`}
          </span>}
        </label>;
      })}
    </div>
    {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
  </details>;
}

function PointRules({ points, catalog, stage, onChange }: {
  points: PointQuota[]; catalog?: CatalogChapter; stage: QuestionStage; onChange: (points: PointQuota[]) => void;
}) {
  const [pointId, setPointId] = useState(points[0]?.knowledge_point_id);
  const [batch, setBatch] = useState(1);
  const [search, setSearch] = useState("");
  const labels = new Map(catalog?.knowledge_points.map(point => [point.id, point]));
  const titles = new Map(points.map((point, i) => [point.knowledge_point_id, labels.get(point.knowledge_point_id)?.title ?? `知识点 ${i + 1}`]));
  const visible = points.filter(point => titles.get(point.knowledge_point_id)?.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const point = visible.find(row => row.knowledge_point_id === pointId) ?? visible[0];
  const available = point && labels.get(point.knowledge_point_id)?.available_questions?.[stage];
  const stock = available && Object.values(available).reduce((sum, amount) => sum + amount, 0);
  function update(next: PointQuota) {
    onChange(points.map(row => row.knowledge_point_id === next.knowledge_point_id ? next : row));
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <CountField label="每个知识点统一设为" count={batch} min={0} onChange={setBatch} />
      <Button type="button" size="sm" variant="outline" disabled={!validCount(batch, 0) || !points.length}
        onClick={() => onChange(points.map(row => ({ ...row, count: batch })))}>应用到本章 {points.length} 个知识点</Button>
    </div>
    <div className="grid overflow-hidden rounded-md border sm:grid-cols-[minmax(9rem,2fr)_minmax(0,3fr)]">
      <div className="border-b p-2 sm:border-r sm:border-b-0">
        {points.length > 7 && <Input type="search" aria-label="查找知识点题量" placeholder="查找知识点" className="mb-2"
          value={search} onChange={event => setSearch(event.target.value)} />}
        <div className="space-y-0.5" aria-label="知识点题量列表">
          {visible.map(row => <button type="button" className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted aria-pressed:bg-muted aria-pressed:font-medium"
            key={row.knowledge_point_id} aria-pressed={row === point} onClick={() => setPointId(row.knowledge_point_id)}>
            <span className="min-w-0 flex-1 break-words">{titles.get(row.knowledge_point_id)}</span>
            <span className="shrink-0 text-muted-foreground">{Number.isFinite(row.count) ? row.count : "—"} 题</span>
          </button>)}
          {!visible.length && <ListEmpty title="请先在章节中勾选知识点。" filtered={Boolean(search.trim())} reset={() => setSearch("")} />}
        </div>
      </div>
      {point && <div className="min-w-0 p-3" key={point.knowledge_point_id}>
        <p className="mb-2 font-medium">{titles.get(point.knowledge_point_id)}</p>
        <CountField label="该知识点题数" count={point.count} min={0} onChange={count => update({ ...point, count })} />
        {point.count === 0 && <p className="hint mt-1">本环节给该点分配 0 题。为其他知识点选中的题也可能涉及它。</p>}
        {stock !== undefined && <p className={stock < point.count ? "mt-1 text-sm text-amber-700" : "hint mt-1"}>
          题库可用 {stock} 题{stock < point.count && `，还缺 ${point.count - stock} 题`}</p>}
        <KindEditor stage={stage} count={point.count} byKind={point.by_kind} available={available} onChange={by_kind => update({ ...point, by_kind })} />
      </div>}
    </div>
  </div>;
}

export function StageRuleEditor({ stage, selection, catalog, inheritedCount, onChange }: {
  stage: QuestionStage; selection: ChapterSelection; catalog?: CatalogChapter; inheritedCount: number;
  onChange: (rule?: StageRule) => void;
}) {
  const group = useId();
  const rule = selection.question_plan?.[stage];
  const mode = rule?.mode ?? "inherit";
  function selectMode(value: string) {
    if (value === "inherit") onChange(undefined);
    else if (value === "total") onChange({ mode: "total", count: inheritedCount });
    else onChange({ mode: "by_point", points: pointQuotas(selection.knowledge_point_ids) });
  }
  return <div className="space-y-3">
    <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
      <legend className="sr-only">{stageNames[stage]}分配方式</legend>
      {([["inherit", "沿用课程默认"], ["total", "自定本章总题数"], ["by_point", "按知识点分配"]] as const).map(([value, label]) =>
        <label key={value} className="inline-flex items-center gap-1.5 text-sm"><input type="radio" name={group}
          checked={mode === value} onChange={() => selectMode(value)} />{label}</label>)}
    </fieldset>
    {!rule && <p className="hint">本章所选知识点合计最多 {inheritedCount} 道{stageNames[stage]}题，题型自动分配。</p>}
    {rule?.mode === "total" && <div>
      <CountField label={`本章${stageNames[stage]}总题数`} count={rule.count} onChange={count => onChange({ ...rule, count })} />
      <KindEditor stage={stage} count={rule.count} byKind={rule.by_kind} onChange={by_kind => onChange({ ...rule, by_kind })} />
    </div>}
    {rule?.mode === "by_point" && <PointRules points={rule.points} catalog={catalog} stage={stage}
      onChange={points => onChange({ mode: "by_point", points })} />}
  </div>;
}
