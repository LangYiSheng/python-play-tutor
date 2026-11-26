import { useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, RefreshCw, Sparkles } from "lucide-react";
import { ErrorNotice } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import {
  lectioApi,
  type ExamGapsResult,
  type ExamRecord,
  type ExamSectionConfig,
  type KnowledgeChapter,
} from "@/lib/lectio-api";

const DEFAULT_SECTIONS: ExamSectionConfig[] = [
  { type: "single", count: 10, scoreEach: 2 },
  { type: "multiple", count: 5, scoreEach: 4 },
  { type: "true_false", count: 10, scoreEach: 2 },
  { type: "fill_blank", count: 5, scoreEach: 4 },
];

const SECTION_LABELS: Record<string, string> = {
  single: "单选题",
  multiple: "多选题",
  true_false: "判断题",
  fill_blank: "填空题（单空）",
};

export function ExamWizard({
  classroomId,
  chapters,
  onCreated,
  onCancel,
  onFillGapJob,
}: {
  classroomId: number;
  chapters: KnowledgeChapter[];
  onCreated: (exam: ExamRecord) => void;
  onCancel: () => void;
  onFillGapJob: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [title, setTitle] = useState("期末综合测试卷");
  const [subtitle, setSubtitle] = useState("");
  const [examMode, setExamMode] = useState("闭卷");
  const [durationMinutes, setDurationMinutes] = useState(90);
  const [abMode, setAbMode] = useState(false);
  const [maxOverlapRate, setMaxOverlapRate] = useState(0);
  const [includeUnreviewed, setIncludeUnreviewed] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>(() => chapters.map((c) => c.id));
  const [weights, setWeights] = useState<Record<number, number>>({});
  const [sections, setSections] = useState<ExamSectionConfig[]>(DEFAULT_SECTIONS);
  const [gaps, setGaps] = useState<ExamGapsResult | null>(null);
  const [multiplier, setMultiplier] = useState<1 | 2>(1);
  const [busy, setBusy] = useState<"" | "gaps" | "fill" | "create">("");
  const [error, setError] = useState("");

  useDraft(true);

  const activeSections = useMemo(
    () => sections.filter((s) => s.count > 0 && s.scoreEach > 0),
    [sections],
  );
  const computedTotal = useMemo(
    () => Math.round(activeSections.reduce((sum, s) => sum + s.count * s.scoreEach, 0) * 10) / 10,
    [activeSections],
  );

  function toggleChapter(id: number, checked: boolean) {
    setSelectedIds((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));
  }

  function updateSection(type: ExamSectionConfig["type"], patch: Partial<ExamSectionConfig>) {
    setSections((prev) => prev.map((s) => (s.type === type ? { ...s, ...patch } : s)));
  }

  function buildGapPayload() {
    return {
      chapter_ids: selectedIds,
      sections: activeSections,
      ab_mode: abMode,
      max_overlap_rate: abMode ? maxOverlapRate : 0,
      include_unreviewed: includeUnreviewed,
    };
  }

  async function inspectGaps(advance = false) {
    if (!title.trim()) {
      setError("请填写试卷标题。");
      return;
    }
    if (selectedIds.length === 0) {
      setError("请至少选择一个考察章节。");
      return;
    }
    if (activeSections.length === 0) {
      setError("请至少配置一种题量大于 0 的客观题题型。");
      return;
    }
    setBusy("gaps");
    setError("");
    try {
      const res = await lectioApi.checkExamGaps(classroomId, buildGapPayload());
      setGaps(res);
      if (advance) setStep(2);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  async function fillGaps() {
    setBusy("fill");
    setError("");
    try {
      await lectioApi.fillExamGaps(classroomId, { ...buildGapPayload(), multiplier });
      toast.add({ title: "已提交 AI 试卷缺口补题任务", type: "success" });
      onFillGapJob();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  async function createExam() {
    setBusy("create");
    setError("");
    try {
      const chapterWeights: Record<number, number> = {};
      for (const cid of selectedIds) chapterWeights[cid] = weights[cid] ?? 1;
      const created = await lectioApi.createExam(classroomId, {
        ...buildGapPayload(),
        title: title.trim(),
        subtitle: subtitle.trim(),
        exam_mode: examMode,
        duration_minutes: durationMinutes,
        total_score: computedTotal,
        chapter_weights: chapterWeights,
      });
      toast.add({ title: "试卷已生成并保存", type: "success" });
      onCreated(created);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="surface p-5 space-y-5" aria-label="智能组卷向导">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
        <div>
          <h2 className="text-lg font-semibold">新建课程试卷</h2>
          <p className="text-xs text-muted-foreground">
            步骤 {step} / 2 · {step === 1 ? "配置命题蓝图与章节权重" : "检查题库缺口并生成试卷"}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={onCancel}>
          返回列表
        </Button>
      </header>

      <ErrorNotice message={error} />

      {step === 1 ? (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="field">
              <Label htmlFor="exam-title">试卷名称</Label>
              <Input id="exam-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="field">
              <Label htmlFor="exam-subtitle">副标题（选填）</Label>
              <Input
                id="exam-subtitle"
                placeholder="如：2026 学年第一学期"
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
              />
            </div>
            <div className="field">
              <Label htmlFor="exam-mode">考试形式</Label>
              <SelectField id="exam-mode" value={examMode} onValueChange={setExamMode}>
                <option value="闭卷">闭卷</option>
                <option value="开卷">开卷</option>
              </SelectField>
            </div>
            <div className="field">
              <Label htmlFor="exam-duration">考试时长（分钟）</Label>
              <Input
                id="exam-duration"
                type="number"
                min={15}
                max={300}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Math.max(15, Number(e.target.value) || 90))}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6 rounded-md border p-3 text-sm">
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox checked={abMode} onCheckedChange={(c: boolean) => setAbMode(c)} />
              <span>生成 A / B 平行卷</span>
            </label>
            {abMode && (
              <label className="flex items-center gap-2">
                <span>最大重复率</span>
                <Input
                  type="number"
                  step={0.05}
                  min={0}
                  max={0.5}
                  className="w-24"
                  value={maxOverlapRate}
                  onChange={(e) => setMaxOverlapRate(Math.max(0, Math.min(0.5, Number(e.target.value) || 0)))}
                />
              </label>
            )}
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={includeUnreviewed}
                onCheckedChange={(c: boolean) => setIncludeUnreviewed(c)}
              />
              <span>包含待审核草稿题</span>
            </label>
            <div className="ml-auto font-medium">当前满分：{computedTotal} 分</div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">题型配比（4 类客观题）</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>题型</TableHead>
                  <TableHead>每卷题数</TableHead>
                  <TableHead>每题分值</TableHead>
                  <TableHead>小计分值</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sections.map((sec) => (
                  <TableRow key={sec.type}>
                    <TableCell className="font-medium">{SECTION_LABELS[sec.type]}</TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={0}
                        max={200}
                        className="w-24"
                        aria-label={`${SECTION_LABELS[sec.type]}题数`}
                        value={sec.count}
                        onChange={(e) => updateSection(sec.type, { count: Math.max(0, Number(e.target.value) || 0) })}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step={0.5}
                        min={0.5}
                        max={100}
                        className="w-24"
                        aria-label={`${SECTION_LABELS[sec.type]}每题分值`}
                        value={sec.scoreEach}
                        onChange={(e) =>
                          updateSection(sec.type, { scoreEach: Math.max(0.5, Number(e.target.value) || 0.5) })
                        }
                      />
                    </TableCell>
                    <TableCell>{Math.round(sec.count * sec.scoreEach * 10) / 10} 分</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">覆盖章节与权重</h3>
            {chapters.length === 0 ? (
              <p className="text-xs text-muted-foreground">课程暂无章节。</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {chapters.map((ch) => {
                  const checked = selectedIds.includes(ch.id);
                  return (
                    <div key={ch.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                      <label className="flex items-center gap-2 cursor-pointer min-w-0">
                        <Checkbox checked={checked} onCheckedChange={(c: boolean) => toggleChapter(ch.id, c)} />
                        <span className="truncate">
                          第 {ch.order_index} 章 · {ch.title}
                        </span>
                      </label>
                      {checked && (
                        <Input
                          type="number"
                          step={0.5}
                          min={0.1}
                          max={10}
                          aria-label={`${ch.title}权重`}
                          className="w-20"
                          value={weights[ch.id] ?? 1}
                          onChange={(e) =>
                            setWeights((prev) => ({
                              ...prev,
                              [ch.id]: Math.max(0.1, Number(e.target.value) || 1),
                            }))
                          }
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              取消
            </Button>
            <Button type="button" disabled={busy === "gaps"} onClick={() => void inspectGaps(true)}>
              {busy === "gaps" ? "检查中…" : "下一步：检查题库缺口"} <ArrowRight />
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {gaps && (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                {gaps.ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                <Badge variant={gaps.ok ? "secondary" : "destructive"}>
                  {gaps.ok ? "题库数量充足，可立即组卷" : `存在 ${gaps.totalShortage} 道题缺口`}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {abMode ? "已按 A/B 平行卷重复率上限核定所需不重复题目数量" : "单卷模式"}
                </span>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>题型</TableHead>
                    <TableHead>单卷配置</TableHead>
                    <TableHead>总需求题数</TableHead>
                    <TableHead>题库可用</TableHead>
                    <TableHead>缺口</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {gaps.byType.map((row) => (
                    <TableRow key={row.type}>
                      <TableCell className="font-medium">{row.label}</TableCell>
                      <TableCell>{row.count}</TableCell>
                      <TableCell>{row.needed}</TableCell>
                      <TableCell>{row.available}</TableCell>
                      <TableCell>
                        <Badge variant={row.shortage > 0 ? "destructive" : "secondary"}>{row.shortage}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {!gaps.ok && (
                <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/20 p-3 text-sm">
                  <Label htmlFor="fill-multiplier">补题倍率</Label>
                  <SelectField
                    id="fill-multiplier"
                    value={String(multiplier)}
                    onValueChange={(v) => setMultiplier(Number(v) === 2 ? 2 : 1)}
                  >
                    <option value="1">1x（按缺口补齐）</option>
                    <option value="2">2x（多生成备用冗余）</option>
                  </SelectField>
                  <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => void fillGaps()}>
                    <Sparkles /> {busy === "fill" ? "提交中…" : "一键 AI 补齐缺口"}
                  </Button>
                </div>
              )}
            </>
          )}

          <div className="flex flex-wrap justify-between gap-2 pt-2">
            <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => setStep(1)}>
              <ArrowLeft /> 上一步修改蓝图
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => void inspectGaps(false)}>
                <RefreshCw /> 重新检测
              </Button>
              <Button type="button" disabled={Boolean(busy) || !gaps?.ok} onClick={() => void createExam()}>
                {busy === "create" ? "生成中…" : "生成试卷"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
