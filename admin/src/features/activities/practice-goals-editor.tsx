import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { kinds } from "@/features/questions/types";
import type { Point, PracticeGoal, PracticeRules, Question } from "@/lib/types";

const questionKinds = Object.keys(kinds) as Question["kind"][];

interface Props {
  rules: PracticeRules;
  points: Point[];
  candidates: Question[] | null;
  onChange: (rules: PracticeRules) => void;
}

export function PracticeGoalsEditor({ rules, points, candidates, onChange }: Props) {
  function setGoals(goals: PracticeGoal[]) {
    onChange({ ...rules, goals });
  }
  function updateGoal(goal: PracticeGoal) {
    setGoals(rules.goals.map(item => item.knowledge_point_id === goal.knowledge_point_id ? goal : item));
  }
  const [focusedId, setFocusedId] = useState<number>();
  const goal = rules.goals.find(item => item.knowledge_point_id === focusedId) ?? rules.goals[0];
  const point = points.find(item => item.id === goal?.knowledge_point_id);
  const pool = candidates?.filter(q => goal && q.knowledge_point_ids.includes(goal.knowledge_point_id));
  const minimum = goal ? Math.max(goal.total, Object.values(goal.by_kind).reduce((sum, count) => sum + count, 0)) : 0;
  function include(id: number) {
    if (!rules.goals.some(item => item.knowledge_point_id === id)) {
      setGoals([...rules.goals, { knowledge_point_id: id, total: 1, by_kind: {} }]);
    }
    setFocusedId(id);
  }
  return (
    <div className="space-y-4">
      <fieldset className="min-w-0">
        <legend className="mb-2 text-sm font-medium">本章练习目标</legend>
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] overflow-hidden rounded-md border">
          <div aria-label="章节知识点" className="max-h-80 overflow-y-auto border-r bg-muted/30 p-1">
            {points.map(p => {
              const selected = rules.goals.some(item => item.knowledge_point_id === p.id);
              const active = goal?.knowledge_point_id === p.id;
              const disabled = !selected && rules.goals.length >= 65;
              return (
                <div key={p.id} className={`flex items-center gap-2 rounded px-2 ${active ? "bg-accent text-accent-foreground" : ""}`}>
                  <Checkbox checked={selected} aria-label={p.title} disabled={disabled}
                    onCheckedChange={checked => checked ? include(p.id) : setGoals(rules.goals.filter(item => item.knowledge_point_id !== p.id))} />
                  <button type="button" disabled={disabled} aria-current={active || undefined}
                    className="min-w-0 flex-1 py-2 text-left text-sm" onClick={() => include(p.id)}>{p.title}</button>
                </div>
              );
            })}
            {!points.length && <p className="hint p-2">本章暂无知识点。</p>}
          </div>
          {goal ? <fieldset key={goal.knowledge_point_id} className="m-2 min-w-0 space-y-2 sm:m-3">
            <legend className="text-sm font-medium">{point?.title ?? "知识点已不可用"}</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <label className="space-y-1 text-sm">
                <span>答对总数</span>
                <Input type="number" min={0} max={500} placeholder="不限" value={goal.total || ""}
                  onChange={event => updateGoal({ ...goal, total: Number(event.target.value) })} />
                {pool && <span className="hint">可用 {pool.length} 题</span>}
              </label>
              {questionKinds.map(kind => {
                const available = pool?.filter(q => q.kind === kind).length;
                const required = goal.by_kind[kind] ?? 0;
                return (
                  <label key={kind} className="space-y-1 text-sm">
                    <span>{kinds[kind]}至少</span>
                    <Input type="number" min={0} max={500} placeholder="不限" value={required || ""}
                      onChange={event => {
                        const by_kind = { ...goal.by_kind };
                        const count = Number(event.target.value);
                        if (count) by_kind[kind] = count;
                        else delete by_kind[kind];
                        updateGoal({ ...goal, by_kind });
                      }} />
                    {available !== undefined && <span className={available < required ? "text-destructive" : "hint"}>
                      可用 {available} 题{available < required && `，还缺 ${required - available} 题`}
                    </span>}
                  </label>
                );
              })}
            </div>
            {!minimum && <p className="text-sm text-destructive">请填写答对总数或至少一项题型数量。</p>}
            {pool && minimum > pool.length && <p className="text-sm text-destructive">按此目标至少需要 {minimum} 道不同题目，当前还缺 {minimum - pool.length} 道。</p>}
          </fieldset> : <p className="hint p-3">勾选知识点后，在这里设置题量。</p>}
        </div>
      </fieldset>
      <div className="field">
        <Label htmlFor="practice-retry">重做错题前需作答的其他题数</Label>
        <Input id="practice-retry" className="max-w-32" type="number" min={0} max={100} required
          value={rules.retry_interval} onChange={event => onChange({ ...rules, retry_interval: Number(event.target.value) })} />
        <p className="hint">正式提交其他题即可推进间隔。没有其他题可做时，可以直接订正。</p>
      </div>
    </div>
  );
}
