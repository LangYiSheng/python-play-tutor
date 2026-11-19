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
  return (
    <div className="space-y-4">
      <fieldset className="field">
        <legend>本章练习目标</legend>
        {points.length ? (
          <div className="check-list">
            {points.map(point => {
              const selected = rules.goals.some(goal => goal.knowledge_point_id === point.id);
              return (
                <Label key={point.id} htmlFor={`practice-point-${point.id}`}>
                  <Checkbox id={`practice-point-${point.id}`} checked={selected}
                    disabled={!selected && rules.goals.length >= 65}
                    onCheckedChange={checked => setGoals(checked
                      ? [...rules.goals, { knowledge_point_id: point.id, total: 1, by_kind: {} }]
                      : rules.goals.filter(goal => goal.knowledge_point_id !== point.id))} />
                  {point.title}
                </Label>
              );
            })}
          </div>
        ) : <p className="hint">本章暂无知识点。</p>}
      </fieldset>
      {rules.goals.length > 0 && <p className="hint">总数和各题型最低数可单独填写，也可同时使用。题型数量计入总数，每道题只计入一个知识点。</p>}
      {rules.goals.map(goal => {
        const point = points.find(item => item.id === goal.knowledge_point_id);
        const pool = candidates?.filter(q => q.knowledge_point_ids.includes(goal.knowledge_point_id));
        const minimum = Math.max(goal.total, Object.values(goal.by_kind).reduce((sum, count) => sum + count, 0));
        return (
          <fieldset key={goal.knowledge_point_id} className="space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">{point?.title ?? "知识点已不可用"}</legend>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
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
          </fieldset>
        );
      })}
      <div className="field">
        <Label htmlFor="practice-retry">重做错题前需作答的其他题数</Label>
        <Input id="practice-retry" className="max-w-32" type="number" min={0} max={100} required
          value={rules.retry_interval} onChange={event => onChange({ ...rules, retry_interval: Number(event.target.value) })} />
        <p className="hint">正式提交其他题即可推进间隔。没有其他题可做时，可以直接订正。</p>
      </div>
    </div>
  );
}
