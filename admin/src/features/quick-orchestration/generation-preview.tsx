import { Fragment, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ResetImpactList } from "@/features/authoring/reset-impact";
import type { CatalogChapter, ChapterSelection, PaperSummary, Preview, QuestionStage, Recipe, TownFeature } from "./contracts";
import { describeKinds, stageCount, stageNames, stageSummary } from "./question-plan";

function StageDetails({ stage, recipe, selection, chapter, paper }: {
  stage: QuestionStage; recipe: Recipe; selection: ChapterSelection; chapter?: CatalogChapter; paper?: PaperSummary;
}) {
  const rule = selection.question_plan?.[stage];
  return <div>
    <h4 className="font-semibold">{stageNames[stage]}</h4>
    <p>出题设置 · {stageSummary(recipe, selection, stage)}</p>
    {paper && <p className="hint">{paper.individual ? "首批按学生抽取，实际题型随抽题变化。" : "实际题型：" + describeKinds(paper.by_kind)}</p>}
    {paper?.point_counts && <ul className="mt-2 space-y-1">
      {selection.knowledge_point_ids.map(id => <li key={id}>
        {chapter?.knowledge_points.find(point => point.id === id)?.title ?? id} · 首批 {paper.point_counts?.[id] ?? 0} 题
      </li>)}
    </ul>}
    {!paper?.point_counts && rule?.mode === "by_point" && <ul className="mt-2 space-y-1">
      {rule.points.map(point => <li key={point.knowledge_point_id}>
        {chapter?.knowledge_points.find(item => item.id === point.knowledge_point_id)?.title ?? "已移出的知识点"}
        <span className="ml-2">{point.count} 题{describeKinds(point.by_kind) && " · " + describeKinds(point.by_kind)}</span>
      </li>)}
    </ul>}
  </div>;
}
export function GenerationPreview({ preview, chapters, recipe, withQuiz, features }: {
  preview: Preview | null; chapters: CatalogChapter[]; recipe: Recipe; withQuiz: boolean; features?: TownFeature[];
}) {
  const [expanded, setExpanded] = useState<string>();
  const stages: QuestionStage[] = withQuiz ? ["practice", "assessment"] : ["practice"];
  const actual = new Map(preview?.papers?.map(paper => [paper.chapter_id, paper]));
  const adjustments = new Map(preview?.adjustments?.map(item => [`${item.chapter_id}:${item.stage}`, item]));
  const verified = recipe.chapters.length > 0 && recipe.chapters.every(row => stages.every(stage => actual.get(row.chapter_id)?.[stage]));
  function stageResult(row: ChapterSelection, stage: QuestionStage) {
    const paper = actual.get(row.chapter_id)?.[stage];
    const adjustment = adjustments.get(`${row.chapter_id}:${stage}`);
    return { paper, adjustment, count: paper?.count ?? adjustment?.effective ?? stageCount(recipe, row, stage) };
  }
  const points = recipe.chapters.reduce((total, row) => total + row.knowledge_point_ids.length, 0);
  const impact = preview?.reset_impact;
  const chapterTitle = (id?: string | null) => chapters.find(chapter => chapter.id === id)?.title ?? "已移出的章节";
  const selectedFeatures = features?.filter(feature => recipe.feature_ids?.includes(feature.id));
  const townQuests = preview?.quests?.filter(quest => quest.chapter_id === null);
  return <section aria-label="课程流程预览" className="surface min-w-0 space-y-4">
    <div>
      <h2 className="text-lg">课程流程预览</h2>
      <p className="hint">章节按下表顺序开放。展开章节可查看任务目标、课件和题量。</p>
    </div>
    {withQuiz && <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground">起始章</dt><dd>{chapterTitle(recipe.start_chapter_id)}</dd>
      <dt className="text-muted-foreground">最终章</dt><dd>{recipe.final_chapter_id ? chapterTitle(recipe.final_chapter_id) : "暂不设置"}</dd>
      {Boolean(features?.length) && <><dt className="text-muted-foreground">可选功能</dt><dd>{selectedFeatures?.length
        ? selectedFeatures.map(feature => feature.title).join("、") : "仅使用基础流程"}</dd></>}
    </dl>}
    <div role="group" aria-label="课程总览" className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-md bg-muted/60 px-3 py-2">
      <span className="font-medium">{verified ? "实际合计" : "预计合计"}</span>
      <span>{recipe.chapters.length} 章</span><span>{points} 个已选知识点</span>
      {stages.map(stage => {
        const total = recipe.chapters.reduce((sum, row) => sum + stageResult(row, stage).count, 0);
        const adaptive = preview?.papers?.some(paper => paper[stage]?.individual);
        return <span key={stage}>{stageNames[stage]}共 {total} 题{adaptive && "（个人抽题按首批计算）"}</span>;
      })}
    </div>
    {preview && preview.blockers.length > 0 && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-950">
      <p className="font-medium">请先处理以下问题</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">{preview.blockers.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
    </div>}
    {preview?.welcome_dialogue && <div>
      <h3 className="mb-2 font-semibold">首章开场对白</h3>
      <blockquote className="whitespace-pre-line rounded-md bg-muted/60 px-3 py-2">{preview.welcome_dialogue}</blockquote>
    </div>}
    <Table>
      <TableHeader><TableRow>
        <TableHead>授课顺序</TableHead><TableHead>课件</TableHead><TableHead>知识点</TableHead>
        {stages.map(stage => <TableHead key={stage}>{stageNames[stage]}总题数</TableHead>)}
      </TableRow></TableHeader>
      <TableBody>{recipe.chapters.map((row, index) => {
        const chapter = chapters.find(item => item.id === row.chapter_id);
        const paper = actual.get(row.chapter_id);
        const open = expanded === row.chapter_id;
        return <Fragment key={row.chapter_id}>
          <TableRow>
            <TableCell className="whitespace-normal"><Button variant="link" size="sm" className="h-auto whitespace-normal px-0 text-left"
              aria-expanded={open} onClick={() => setExpanded(open ? undefined : row.chapter_id)}>
              <ChevronDown className={open ? "rotate-180" : ""} />{index + 1}. {chapter?.title ?? "已移出的章节"}
            </Button></TableCell>
            <TableCell>{row.material_ids.length} 份</TableCell><TableCell>{row.knowledge_point_ids.length} 个</TableCell>
            {stages.map(stage => {
              const { paper, adjustment, count } = stageResult(row, stage);
              return <TableCell key={stage}>
                <span>{paper?.individual ? "首批 " : !paper && !adjustment ? "预计 " : ""}{count} 题</span>
                {adjustment && <span className="hint block whitespace-normal">题库不足，已从默认 {adjustment.requested} 题下调</span>}
              </TableCell>;
            })}
          </TableRow>
          {open && <TableRow><TableCell colSpan={3 + stages.length} className="whitespace-normal bg-muted/30">
            {preview?.quests?.filter(quest => quest.chapter_id === row.chapter_id).map(quest => <div key={quest.id} className="mb-3">
              <h4 className="font-semibold">{quest.kind === "side" ? "支线" : "主线"} · {quest.title}</h4>
              <ol className="mt-1 list-decimal space-y-1 pl-5">{quest.goals.map((goal, i) => <li key={i}>{goal}</li>)}</ol>
            </div>)}
            <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">课件</dt><dd>{chapter?.materials.filter(item => row.material_ids.includes(item.id)).map(item => item.title).join("、")}</dd>
              <dt className="text-muted-foreground">知识点</dt><dd>{chapter?.knowledge_points.filter(item => row.knowledge_point_ids.includes(item.id)).map(item => item.title).join("、")}</dd>
            </dl>
            <div className="grid gap-4 sm:grid-cols-2">{stages.map(stage => <StageDetails key={stage} stage={stage} recipe={recipe}
              selection={row} chapter={chapter} paper={paper?.[stage]} />)}</div>
          </TableCell></TableRow>}
        </Fragment>;
      })}</TableBody>
    </Table>
    {!!townQuests?.length && <section aria-label="全镇支线" className="space-y-2">
      <h3 className="font-semibold">全镇支线</h3>
      {townQuests.map(quest => <div key={quest.id}>
        <h4 className="font-medium">{quest.title}</h4>
        <p className="hint">{quest.available_after ? `完成《${quest.available_after}》后出现` : "进入小镇后出现"}</p>
        <ol className="list-decimal space-y-1 pl-5">{quest.goals.map((goal, i) => <li key={i}>{goal}</li>)}</ol>
      </div>)}
    </section>}
    {preview && !preview.blockers.length && <p className="hint">本次新增 {preview.changes.added} 项、更新 {preview.changes.updated} 项、移除 {preview.changes.removed} 项。</p>}
    {impact && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-950">
      <p className="font-medium">将重置 {impact.students} 人的相关互动或任务进度</p>
      <p>阅读、作答记录和成绩会保留。</p>
      <ResetImpactList impact={impact} />
    </div>}
  </section>;
}
