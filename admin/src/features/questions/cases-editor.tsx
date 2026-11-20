import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Case } from "./types";

export function Cases({ samples, hidden, onSamples, onHidden }: {
  samples: Case[]; hidden: Case[]; onSamples: (rows: Case[]) => void; onHidden: (rows: Case[]) => void;
}) {
  const [group, setGroup] = useState<"公开样例" | "私有用例">("公开样例");
  const [positions, setPositions] = useState({公开样例: 0, 私有用例: 0});
  const isPublic = group === "公开样例";
  const rows = isPublic ? samples : hidden;
  const change = isPublic ? onSamples : onHidden;
  const index = Math.max(0, Math.min(positions[group], rows.length - 1));
  const select = (next: number) => setPositions(p => ({ ...p, [group]: next }));
  const active = rows[index];
  function insert(copy: boolean) {
    const at = copy ? index + 1 : rows.length;
    change([...rows.slice(0, at), copy ? {...active} : {input:"",expected_output:""}, ...rows.slice(at)]);
    select(at);
  }
  const full = samples.length + hidden.length >= 20;
  return <div className="space-y-3">
    <div className="flex gap-2">{(["公开样例","私有用例"] as const).map(name =>
      <Button key={name} type="button" variant={group === name ? "default" : "outline"} aria-pressed={group === name} onClick={() => setGroup(name)}>
        {name} · {name === "公开样例" ? samples.length : hidden.length}
      </Button>)}</div>
    <p className="hint">{isPublic ? "学生可见，编程练习提交时评测全部公开样例。" : "仅教师可见，用于测验的服务端判题。"}</p>
    <div className="editor-columns"><div className="editor-list">
      {rows.map((_, i) => <button type="button" key={i} className="editor-list-item" aria-pressed={index === i} onClick={() => select(i)}>{group} {i+1}</button>)}
      <Button type="button" variant="outline" disabled={full} onClick={() => insert(false)}>添加用例</Button>
    </div><div>{active ? <>
      <div className="mb-3 flex items-center gap-2"><strong className="mr-auto">{group} {index+1}</strong>
        <Button type="button" variant="outline" size="sm" disabled={full} onClick={() => insert(true)}>复制</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => change(rows.filter((_, i) => index !== i))}>移除</Button></div>
      <div className="grid gap-3 sm:grid-cols-2">{(["input","expected_output"] as const).map(key =>
        <label className="field" key={key}>{key === "input" ? "标准输入" : "预期输出"}
          <Textarea rows={7} className="font-mono" value={active[key]} onChange={e => change(rows.map((r,i) => i === index ? {...r,[key]: e.target.value} : r))} />
        </label>)}</div>
    </> : <p className="hint">点击「添加用例」开始编写。</p>}</div></div>
  </div>;
}
