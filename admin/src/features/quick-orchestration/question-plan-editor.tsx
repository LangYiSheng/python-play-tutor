import { ListEmpty } from "@/components/common";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/select-field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CatalogChapter, QuestionStage, Recipe } from "./contracts";
import { applyPerPointToInherited, defaultCount, stageCount, stageNames, validCount, withStageRule } from "./question-plan";
import { CountField, StageRuleEditor } from "./stage-rule-editor";

type Props = {
  recipe: Recipe;
  chapters: CatalogChapter[];
  withQuiz: boolean;
  onChange: (recipe: Recipe) => void;
};

function CourseDefaults({ recipe, withQuiz, onChange }: Omit<Props, "chapters">) {
  const [stage, setStage] = useState<QuestionStage>("practice");
  const [perPoint, setPerPoint] = useState(1);
  const activeStage = withQuiz ? stage : "practice";
  const inheritedByStage = {
    practice: recipe.chapters.filter(row => !row.question_plan?.practice),
    assessment: recipe.chapters.filter(row => !row.question_plan?.assessment),
  };
  const inherited = inheritedByStage[activeStage];
  function defaultHint(stage: QuestionStage) {
    return recipe.chapters.length ? `${inheritedByStage[stage].length}/${recipe.chapters.length} 章沿用` : undefined;
  }
  const tooMany = inherited.some(row => row.knowledge_point_ids.length * perPoint > 100);
  return <section className="surface space-y-3" aria-label="课程默认题量">
    <div><h2 className="text-lg">课程默认题量</h2>
      <p className="hint mt-1">沿用默认时，每章最多取下方设置的题数。例如设为 10 题、本章有 6 道可用题，实际取 6 题。手动指定章节、知识点或题型数量后，缺题会在预览时提示补足。</p>
      <p className="hint mt-1">练习尽量均分给所选知识点。若 10 个知识点的题源充足且独立，共 22 题时，2 个点各 3 题，8 个点各 2 题。学生首次进入时抽题，答错后可能追加练习。</p></div>
    <div className="flex flex-wrap gap-x-6 gap-y-2">
      <CountField label="每章练习总题数" count={recipe.practice_count} hint={defaultHint("practice")}
        onChange={practice_count => onChange({ ...recipe, practice_count })} />
      {withQuiz && <CountField label="每章测验总题数" count={recipe.quiz_count} hint={defaultHint("assessment")}
        onChange={quiz_count => onChange({ ...recipe, quiz_count })} />}
    </div>
    {recipe.chapters.length > 0 && <details className="border-t pt-3 text-sm">
      <summary className="cursor-pointer font-medium">按知识点批量设置</summary>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {withQuiz && <SelectField aria-label="批量设置环节" value={activeStage} onValueChange={value => setStage(value as QuestionStage)}>
          <option value="practice">练习</option><option value="assessment">测验</option>
        </SelectField>}
        <CountField label="每个知识点各" count={perPoint} onChange={setPerPoint} />
        <Button type="button" size="sm" variant="outline" disabled={!inherited.length || !validCount(perPoint) || tooMany}
          onClick={() => onChange(applyPerPointToInherited(recipe, activeStage, perPoint))}>
          应用到 {inherited.length} 个默认章节</Button>
      </div>
      <p className="hint mt-2">仅应用到当前沿用默认{stageNames[activeStage]}题量的章节，保留已单独设置的章节。</p>
      {tooMany && <p className="mt-1 text-destructive">有章节将超过 100 题，请减少每个知识点的题数。</p>}
    </details>}
  </section>;
}

export function QuestionPlanEditor({ recipe, chapters, withQuiz, onChange }: Props) {
  const [chapterId, setChapterId] = useState(recipe.chapters[0]?.chapter_id);
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<QuestionStage>("practice");
  const activeStage = withQuiz ? stage : "practice";
  const [batch, setBatch] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const catalog = new Map(chapters.map(chapter => [chapter.id, chapter]));
  const visible = recipe.chapters.filter(row => (catalog.get(row.chapter_id)?.title ?? "已移出的章节")
    .toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const current = visible.find(row => row.chapter_id === chapterId) ?? visible[0];
  const stages: QuestionStage[] = withQuiz ? ["practice", "assessment"] : ["practice"];
  return <div className="grid gap-4">
    <CourseDefaults recipe={recipe} withQuiz={withQuiz} onChange={onChange} />
    <section className="surface space-y-3" aria-label="各章题量">
      <h2 className="text-lg">各章题量</h2>
      {recipe.chapters.length ? <div className="grid gap-4 md:grid-cols-[minmax(10rem,1fr)_minmax(0,3fr)]">
        <div className="min-w-0 space-y-2">
          {recipe.chapters.length > 7 && <Input type="search" aria-label="查找章节题量" placeholder="查找章节"
            value={search} onChange={event => setSearch(event.target.value)} />}
          <Button variant="outline" size="sm" aria-expanded={batch} onClick={() => { setBatch(!batch); setChecked([]); }}>
            {batch ? "结束批量选择" : "批量恢复默认"}
          </Button>
          {batch && <div className="space-y-2 rounded-md border p-2">
            <p className="hint">恢复所选章节的{stageNames[activeStage]}题量与题型。</p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox"
              checked={visible.length > 0 && visible.every(row => checked.includes(row.chapter_id))}
              onChange={event => setChecked(event.target.checked
                ? [...new Set([...checked, ...visible.map(row => row.chapter_id)])]
                : checked.filter(id => !visible.some(row => row.chapter_id === id)))} />
              {search.trim() ? "全选匹配章节" : "全选章节"}</label>
            <Button variant="outline" size="sm" disabled={!recipe.chapters.some(row => checked.includes(row.chapter_id) && row.question_plan?.[activeStage])}
              onClick={() => {
                onChange({ ...recipe, chapters: recipe.chapters.map(row => checked.includes(row.chapter_id)
                  ? withStageRule(row, activeStage) : row) });
                setChecked([]); setBatch(false);
              }}>所选章节恢复默认{stageNames[activeStage]}</Button>
          </div>}
          <div className="space-y-1">
            {visible.map(row => <div key={row.chapter_id} className="flex items-center">
              {batch && <input type="checkbox" aria-label={"勾选" + catalog.get(row.chapter_id)?.title}
                checked={checked.includes(row.chapter_id)} onChange={event => setChecked(event.target.checked
                  ? [...checked, row.chapter_id] : checked.filter(id => id !== row.chapter_id))} />}
              <button type="button" aria-pressed={row === current}
              className="block w-full rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted aria-pressed:bg-muted"
              onClick={() => setChapterId(row.chapter_id)}>
              <span className="block break-words font-medium">{catalog.get(row.chapter_id)?.title ?? "已移出的章节"}</span>
              <span className="hint">{stages.map(s => `${stageNames[s]} ${Number.isFinite(stageCount(recipe, row, s)) ? stageCount(recipe, row, s) : "—"} 题`).join(" · ")}</span>
            </button></div>)}
            {!visible.length && <ListEmpty title="尚未选择授课章节" filteredTitle="没有匹配的章节。" filtered={Boolean(search.trim())} reset={() => setSearch("")} />}
          </div>
        </div>
        {current && <div className="min-w-0 rounded-lg border p-3">
          <h3 className="break-words font-medium">{catalog.get(current.chapter_id)?.title ?? "已移出的章节"}</h3>
          <Tabs value={activeStage} onValueChange={value => setStage(value as QuestionStage)}>
            <TabsList aria-label="当前章节设置环节">{stages.map(s => <TabsTrigger key={s} value={s}>{stageNames[s]}</TabsTrigger>)}</TabsList>
            {stages.map(s => <TabsContent key={s} value={s} className="mt-3">
              <StageRuleEditor key={current.chapter_id} stage={s} selection={current} catalog={catalog.get(current.chapter_id)}
                inheritedCount={defaultCount(recipe, s)} onChange={rule => onChange({
                  ...recipe, chapters: recipe.chapters.map(row => row === current ? withStageRule(row, s, rule) : row),
                })} />
            </TabsContent>)}
          </Tabs>
        </div>}
      </div> : <p className="hint">选择授课章节后，可以在这里调整各章题量。</p>}
    </section>
  </div>;
}
