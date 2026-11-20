import { SelectField } from "@/components/select-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Authoring, Quest } from "@/features/authoring/model";
export function QuestSettings({
  quest,
  data,
  onChange: replace,
}: {
  quest: Quest;
  data: Authoring;
  onChange: (quest: Quest) => void;
}) {
  const isSide = quest.definition.kind === "side";
  const gate = quest.definition.when?.activity_completed;
  const defaultGate = quest.chapter_id === null ? "进入小镇后" : "章节开放后";
  const activities = data.catalog.activities.filter(a => a.published !== false &&
    (quest.chapter_id === null || a.chapter_id === quest.chapter_id));
  const chapters = new Map(data.catalog.chapters.map(c => [c.id, c.title]));
  return (
    <>
      <div className="field">
        <Label htmlFor="quest-title">任务名称</Label>
        <Input
          id="quest-title"
          value={quest.title}
          onChange={(e) => replace({ ...quest, title: e.target.value })}
        />
      </div>
      <div className="field">
        <Label htmlFor="quest-kind">任务类型</Label>
        <SelectField
          id="quest-kind"
          value={quest.definition.kind ?? "main"}
          onValueChange={kind => {
            const definition = { ...quest.definition, kind: kind as "main" | "side" };
            if (kind === "main") delete definition.when;
            replace({ ...quest, definition, chapter_id: kind === "main"
              ? quest.chapter_id ?? data.catalog.chapters[0].id : quest.chapter_id });
          }}
        >
          <option value="main" disabled={!data.catalog.chapters.length}>主线</option>
          <option value="side">支线</option>
        </SelectField>
      </div>
      <div className="field">
        <Label htmlFor="quest-chapter">任务归属</Label>
        <SelectField
          id="quest-chapter"
          placeholder={isSide ? "全镇" : "选择章节"}
          value={quest.chapter_id ?? ""}
          onValueChange={id => replace({ ...quest, chapter_id: id || null })}
        >
          {isSide && <option value="">全镇</option>}
          {data.catalog.chapters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </SelectField>
        {data.flows.some(flow => flow.quest_id === quest.id) &&
          <p className="hint">关联的任务流程会随任务调整归属。</p>}
      </div>
      {isSide && <div className="field">
        <Label htmlFor="quest-gate">出现时机</Label>
        <SelectField
          id="quest-gate"
          placeholder={defaultGate}
          value={gate ?? ""}
          onValueChange={id => {
            const definition = { ...quest.definition };
            if (id) definition.when = { activity_completed: id };
            else delete definition.when;
            replace({ ...quest, definition });
          }}
        >
          <option value="">{defaultGate}</option>
          {gate && !activities.some(a => a.id === gate) && <option value={gate} disabled>原活动不可用，请重新选择</option>}
          {activities.map(a => {
            const group = quest.chapter_id === null && a.chapter_id && chapters.get(a.chapter_id);
            return <option key={a.id} value={a.id}>{group ? group + " · " : ""}完成《{a.title}》后</option>;
          })}
        </SelectField>
      </div>}
    </>
  );
}
