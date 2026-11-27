import { Fragment, useEffect, useMemo, useState } from "react";
import { Code2, Plus, RotateCcw, Search, Sparkles } from "lucide-react";
import { ErrorNotice } from "@/components/common";
import { DialogSkeleton } from "@/components/skeletons";
import { SelectField } from "@/components/select-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { cleanGraphLabel } from "@/features/content-workspace/studio-graph-layout";
import { codingTypeLabels, codingUsageLabels } from "@/features/questions/types";
import { errorMessage } from "@/lib/api";
import { materialKindLabel } from "@/lib/material-kind";
import {
  courseStudioApi,
  type CodingExerciseDifficulty,
  type CodingExerciseUsage,
  type ExerciseDifficulty,
  type KnowledgeChapter,
  type KnowledgePointItem,
  type PointQuotaPayload,
} from "@/lib/course-studio-api";

type GenerateCategory = "objective" | "coding";

type ObjectiveCounts = {
  single: number;
  multiple: number;
  true_false: number;
  fill_blank: number;
};

type CodingCounts = {
  fill_code: number;
  debug: number;
  design: number;
};

const EMPTY_COUNTS: ObjectiveCounts = { single: 4, multiple: 2, true_false: 2, fill_blank: 2 };
const ZERO_COUNTS: ObjectiveCounts = { single: 0, multiple: 0, true_false: 0, fill_blank: 0 };
const CHAPTER_PRESETS: { label: string; counts: ObjectiveCounts }[] = [
  { label: "精简 6 题", counts: { single: 2, multiple: 1, true_false: 2, fill_blank: 1 } },
  { label: "标准 10 题", counts: { single: 4, multiple: 2, true_false: 2, fill_blank: 2 } },
  { label: "强化 16 题", counts: { single: 6, multiple: 4, true_false: 3, fill_blank: 3 } },
];

const DEFAULT_CODING_COUNTS: CodingCounts = { fill_code: 1, debug: 1, design: 1 };
const CODING_PRESETS: { label: string; counts: CodingCounts }[] = [
  { label: "均衡 3 题（各 1）", counts: { fill_code: 1, debug: 1, design: 1 } },
  { label: "标准 6 题（各 2）", counts: { fill_code: 2, debug: 2, design: 2 } },
  { label: "专项 3 道填空", counts: { fill_code: 3, debug: 0, design: 0 } },
  { label: "专项 3 道改错", counts: { fill_code: 0, debug: 3, design: 0 } },
];

const TYPE_FIELDS: { key: keyof ObjectiveCounts; label: string; shortLabel: string }[] = [
  { key: "single", label: "单选题", shortLabel: "单选" },
  { key: "multiple", label: "多选题", shortLabel: "多选" },
  { key: "true_false", label: "判断题", shortLabel: "判断" },
  { key: "fill_blank", label: "填空题（单空）", shortLabel: "填空" },
];

const CODING_TYPE_FIELDS: { key: keyof CodingCounts; label: string; hint: string }[] = [
  { key: "fill_code", label: codingTypeLabels.fill_code, hint: "补全锁定框架内的核心填空区" },
  { key: "debug", label: codingTypeLabels.debug, hint: "定位并修复预设典型代码错误" },
  { key: "design", label: codingTypeLabels.design, hint: "依据输入输出规范独立编程" },
];

function DialogBody({
  courseId,
  category,
  onCategoryChange,
  mode,
  onModeChange,
  onClose,
  onSubmitted,
}: {
  courseId: number;
  category: GenerateCategory;
  onCategoryChange: (next: GenerateCategory) => void;
  mode: "chapter" | "points";
  onModeChange: (next: "chapter" | "points") => void;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [chapters, setChapters] = useState<KnowledgeChapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [chapterId, setChapterId] = useState("");
  const [materialId, setMaterialId] = useState("all");
  const [pointSearch, setPointSearch] = useState("");
  const [sectionFilter, setSectionFilter] = useState("all");
  const [onlyConfigured, setOnlyConfigured] = useState(false);
  const [counts, setCounts] = useState<ObjectiveCounts>(EMPTY_COUNTS);
  const [difficulty, setDifficulty] = useState<ExerciseDifficulty>("balanced");
  const [quotas, setQuotas] = useState<Record<number, ObjectiveCounts>>({});

  // Coding generation state
  const [codingCounts, setCodingCounts] = useState<CodingCounts>(DEFAULT_CODING_COUNTS);
  const [codingDifficulty, setCodingDifficulty] = useState<CodingExerciseDifficulty>("balanced");
  const [codingUsage, setCodingUsage] = useState<CodingExerciseUsage>("both");
  const [codingPointIds, setCodingPointIds] = useState<number[]>([]);
  const [syntaxNote, setSyntaxNote] = useState("");
  const [enableBlindSolve, setEnableBlindSolve] = useState(true);

  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    courseStudioApi
      .listKnowledge(courseId, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setChapters(res.chapters);
        const preferred = res.chapters.find((ch) => ch.materials.some((m) => m.pages > 0)) ?? res.chapters[0];
        if (preferred) setChapterId(String(preferred.id));
        setLoading(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(e));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [courseId]);

  const currentChapter = chapters.find((ch) => String(ch.id) === chapterId) ?? null;
  const usableMaterials = (currentChapter?.materials ?? []).filter((m) => m.pages > 0);

  const sections = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const pt of currentChapter?.points ?? []) {
      const sec = pt.section.trim() ? cleanGraphLabel(pt.section) : "未分节";
      if (!seen.has(sec)) {
        seen.add(sec);
        out.push(sec);
      }
    }
    return out;
  }, [currentChapter]);

  const filteredPoints = useMemo(() => {
    const term = pointSearch.trim().toLowerCase();
    return (currentChapter?.points ?? []).filter((pt) => {
      const sec = pt.section.trim() ? cleanGraphLabel(pt.section) : "未分节";
      if (sectionFilter !== "all" && sec !== sectionFilter) return false;
      if (onlyConfigured) {
        const q = quotas[pt.id] ?? ZERO_COUNTS;
        if (q.single + q.multiple + q.true_false + q.fill_blank === 0) return false;
      }
      if (!term) return true;
      return (
        pt.title.toLowerCase().includes(term)
        || pt.section.toLowerCase().includes(term)
        || sec.toLowerCase().includes(term)
      );
    });
  }, [currentChapter, pointSearch, sectionFilter, onlyConfigured, quotas]);

  const groupedFiltered = useMemo(() => {
    const map = new Map<string, KnowledgePointItem[]>();
    for (const pt of filteredPoints) {
      const sec = pt.section.trim() ? cleanGraphLabel(pt.section) : "未分节";
      const list = map.get(sec) ?? [];
      list.push(pt);
      map.set(sec, list);
    }
    return Array.from(map.entries());
  }, [filteredPoints]);

  const activePointQuotas = (currentChapter?.points ?? [])
    .map((pt) => {
      const q = quotas[pt.id] ?? ZERO_COUNTS;
      return {
        knowledge_point_id: pt.id,
        ...q,
        sum: q.single + q.multiple + q.true_false + q.fill_blank,
      };
    })
    .filter((item) => item.sum > 0);
  const typeTotals = activePointQuotas.reduce<ObjectiveCounts>(
    (acc, item) => ({
      single: acc.single + item.single,
      multiple: acc.multiple + item.multiple,
      true_false: acc.true_false + item.true_false,
      fill_blank: acc.fill_blank + item.fill_blank,
    }),
    ZERO_COUNTS,
  );
  const totalQuotaQuestions =
    typeTotals.single + typeTotals.multiple + typeTotals.true_false + typeTotals.fill_blank;
  const totalCodingQuestions = codingCounts.fill_code + codingCounts.debug + codingCounts.design;

  function updateQuota(pointId: number, field: keyof ObjectiveCounts, value: number) {
    setQuotas((prev) => ({
      ...prev,
      [pointId]: {
        ...(prev[pointId] ?? ZERO_COUNTS),
        [field]: Math.max(0, Math.min(20, value)),
      },
    }));
  }

  function batchAdjustVisible(field: keyof ObjectiveCounts, delta: number) {
    if (filteredPoints.length === 0) return;
    setQuotas((prev) => {
      const next = { ...prev };
      for (const pt of filteredPoints) {
        const current = next[pt.id] ?? ZERO_COUNTS;
        next[pt.id] = {
          ...current,
          [field]: Math.max(0, Math.min(20, current[field] + delta)),
        };
      }
      return next;
    });
  }

  function clearVisible() {
    if (filteredPoints.length === 0) return;
    setQuotas((prev) => {
      const next = { ...prev };
      for (const pt of filteredPoints) {
        delete next[pt.id];
      }
      return next;
    });
  }

  function toggleCodingPoint(pointId: number) {
    setCodingPointIds((prev) => {
      if (prev.includes(pointId)) return prev.filter((id) => id !== pointId);
      if (prev.length >= 20) return prev;
      return [...prev, pointId];
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!currentChapter || submitting) return;
    setError("");
    const matNum = materialId !== "all" ? Number(materialId) : undefined;

    if (category === "coding") {
      if (totalCodingQuestions <= 0) {
        setError("请至少设置一种编程题形式的生成数量。");
        return;
      }
      if (totalCodingQuestions > 12) {
        setError("单次 AI 编程出题最多生成 12 道，请分批生成。");
        return;
      }
      setSubmitting(true);
      try {
        await courseStudioApi.generateCodingExercises(courseId, currentChapter.id, {
          ...(matNum ? { material_id: matNum } : {}),
          counts: codingCounts,
          difficulty: codingDifficulty,
          usage: codingUsage,
          ...(codingPointIds.length > 0 ? { knowledge_point_ids: codingPointIds } : {}),
          ...(syntaxNote.trim() ? { allowed_syntax_note: syntaxNote.trim() } : {}),
          enable_blind_solve: enableBlindSolve,
        });
        toast.add({ title: "已提交 AI 编程出题任务", type: "success" });
        onSubmitted();
        onClose();
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    let payload;
    if (mode === "chapter") {
      const total = counts.single + counts.multiple + counts.true_false + counts.fill_blank;
      if (total <= 0) {
        setError("请至少设置一种客观题生成数量。");
        return;
      }
      payload = {
        ...(matNum ? { material_id: matNum } : {}),
        ...(difficulty !== "balanced" ? { difficulty } : {}),
        counts,
      };
    } else {
      const pointQuotas: PointQuotaPayload[] = currentChapter.points
        .map((pt) => {
          const q = quotas[pt.id] ?? ZERO_COUNTS;
          return { knowledge_point_id: pt.id, ...q };
        })
        .filter((item) => item.single + item.multiple + item.true_false + item.fill_blank > 0);
      if (pointQuotas.length === 0) {
        setError("请至少为一个知识点配置不少于 1 道客观题。");
        return;
      }
      if (pointQuotas.length > 60) {
        setError("单次最多同时为 60 个知识点分配配额，请分批生成。");
        return;
      }
      payload = {
        ...(matNum ? { material_id: matNum } : {}),
        ...(difficulty !== "balanced" ? { difficulty } : {}),
        point_quotas: pointQuotas,
      };
    }

    setSubmitting(true);
    try {
      await courseStudioApi.generateExercises(courseId, currentChapter.id, payload);
      toast.add({ title: "已提交 AI 智能出题任务", type: "success" });
      onSubmitted();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="flex min-h-0 flex-1 flex-col gap-3.5" onSubmit={(e) => void submit(e)}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b pb-3">
        <Button
          type="button"
          size="sm"
          variant={category === "objective" ? "default" : "outline"}
          aria-pressed={category === "objective"}
          disabled={submitting}
          onClick={() => {
            setError("");
            onCategoryChange("objective");
          }}
        >
          <Sparkles /> 客观题
        </Button>
        <Button
          type="button"
          size="sm"
          variant={category === "coding" ? "default" : "outline"}
          aria-pressed={category === "coding"}
          disabled={submitting}
          onClick={() => {
            setError("");
            onCategoryChange("coding");
          }}
        >
          <Code2 /> Python 编程题（自动验题）
        </Button>
      </div>

      <ErrorNotice message={error} />
      {loading ? (
        <DialogSkeleton rows={3} />
      ) : chapters.length === 0 ? (
        <p className="text-sm text-muted-foreground">请先在「章节与课件」中创建章节并上传课件。</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto pr-0.5">
          <div className="grid shrink-0 gap-3 sm:grid-cols-3">
            <div className="field !mb-0">
              <Label htmlFor="ai-gen-chapter">目标章节</Label>
              <SelectField
                id="ai-gen-chapter"
                value={chapterId}
                disabled={submitting}
                onValueChange={(v) => {
                  setChapterId(v);
                  setMaterialId("all");
                  setPointSearch("");
                  setSectionFilter("all");
                  setOnlyConfigured(false);
                  setCodingPointIds([]);
                  const nextCh = chapters.find((ch) => String(ch.id) === v);
                  if (!nextCh || nextCh.points.length === 0) onModeChange("chapter");
                }}
              >
                {chapters.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    第 {ch.order_index} 章 · {ch.title}
                  </option>
                ))}
              </SelectField>
            </div>
            <div className="field !mb-0">
              <Label htmlFor="ai-gen-material">资料范围</Label>
              <SelectField
                id="ai-gen-material"
                value={materialId}
                disabled={submitting}
                onValueChange={setMaterialId}
              >
                <option value="all">本章全部资料（自动综合）</option>
                {usableMaterials.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}（{materialKindLabel(m.kind)} · {m.pages} 页）
                  </option>
                ))}
              </SelectField>
            </div>
            {category === "objective" ? (
              <div className="field !mb-0">
                <Label htmlFor="ai-gen-difficulty">难度定位</Label>
                <SelectField
                  id="ai-gen-difficulty"
                  value={difficulty}
                  disabled={submitting}
                  onValueChange={(v) => setDifficulty(v as ExerciseDifficulty)}
                >
                  <option value="balanced">均衡进阶（推荐：代码追踪与易错辨析）</option>
                  <option value="foundational">基础巩固（偏核心概念与入门语法）</option>
                  <option value="challenging">综合拔高（偏多步追踪与边界陷阱）</option>
                </SelectField>
              </div>
            ) : (
              <div className="field !mb-0">
                <Label htmlFor="ai-coding-difficulty">目标难度</Label>
                <SelectField
                  id="ai-coding-difficulty"
                  value={codingDifficulty}
                  disabled={submitting}
                  onValueChange={(v) => setCodingDifficulty(v as CodingExerciseDifficulty)}
                >
                  <option value="balanced">均衡分布（易 / 中 / 难混合）</option>
                  <option value="易">易（基础语法与直觉应用）</option>
                  <option value="中">中（多步转换与边界处理）</option>
                  <option value="难">难（高思维密度与综合逻辑）</option>
                </SelectField>
              </div>
            )}
          </div>

          {category === "coding" ? (
            <div className="flex flex-col gap-3.5">
              <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/25 px-2.5 py-1.5 text-xs">
                <span className="text-muted-foreground">题量预设：</span>
                {CODING_PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    type="button"
                    size="xs"
                    variant="outline"
                    className="h-6 bg-background px-2 text-[11px]"
                    disabled={submitting}
                    onClick={() => setCodingCounts({ ...preset.counts })}
                  >
                    {preset.label}
                  </Button>
                ))}
                <Badge variant={totalCodingQuestions > 12 ? "destructive" : "secondary"} className="ml-auto text-[11px] tabular-nums">
                  共 {totalCodingQuestions} / 12 题
                </Badge>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                {CODING_TYPE_FIELDS.map((field) => (
                  <div key={field.key} className="field !mb-0">
                    <Label htmlFor={`ai-coding-count-${field.key}`}>{field.label}</Label>
                    <Input
                      id={`ai-coding-count-${field.key}`}
                      type="number"
                      min={0}
                      max={10}
                      disabled={submitting}
                      value={codingCounts[field.key]}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) =>
                        setCodingCounts((prev) => ({
                          ...prev,
                          [field.key]: Math.max(0, Math.min(10, Number(e.target.value) || 0)),
                        }))
                      }
                    />
                    <span className="text-[11px] text-muted-foreground">{field.hint}</span>
                  </div>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="field !mb-0">
                  <Label htmlFor="ai-coding-usage">教学用途</Label>
                  <SelectField
                    id="ai-coding-usage"
                    value={codingUsage}
                    disabled={submitting}
                    onValueChange={(v) => setCodingUsage(v as CodingExerciseUsage)}
                  >
                    {Object.entries(codingUsageLabels).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </SelectField>
                </div>
                <div className="field !mb-0">
                  <Label htmlFor="ai-coding-syntax-note">语法范围补充约束（可选）</Label>
                  <Input
                    id="ai-coding-syntax-note"
                    maxLength={400}
                    disabled={submitting}
                    value={syntaxNote}
                    placeholder="例如：仅限顺序结构，禁用 if / for / while / def"
                    onChange={(e) => setSyntaxNote(e.target.value)}
                  />
                </div>
              </div>

              {(currentChapter?.points.length ?? 0) > 0 && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">
                      聚焦知识点（可选，不勾选则覆盖整章；已选 {codingPointIds.length} 个）
                    </span>
                    {codingPointIds.length > 0 && (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={submitting}
                        onClick={() => setCodingPointIds([])}
                      >
                        清空选择
                      </Button>
                    )}
                  </div>
                  <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-md border bg-muted/15 p-2">
                    {(currentChapter?.points ?? []).map((pt) => {
                      const checked = codingPointIds.includes(pt.id);
                      return (
                        <button
                          key={pt.id}
                          type="button"
                          disabled={submitting}
                          aria-pressed={checked}
                          className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                            checked
                              ? "border-primary bg-primary/10 font-medium text-primary"
                              : "border-border bg-background text-foreground hover:bg-muted/50"
                          }`}
                          onClick={() => toggleCodingPoint(pt.id)}
                        >
                          {pt.title}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <label className="flex items-center gap-2 text-xs text-foreground">
                <Checkbox
                  checked={enableBlindSolve}
                  disabled={submitting}
                  onCheckedChange={(checked) => setEnableBlindSolve(Boolean(checked))}
                />
                <span>启用独立盲解复验（让模型仅看题干与样例独立求解并过全部用例，拦截题干歧义，推荐开启）</span>
              </label>

              <p className="text-xs text-muted-foreground">
                每道编程题会自动执行参考答案回填输出、检验初始代码不会直接满分，并通过沙箱验题后入库为「待审核」草稿，审校设为「可用」后才对学生开放。
              </p>
            </div>
          ) : (
            <>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <span className="text-sm font-medium">配额方式：</span>
                <Button
                  type="button"
                  size="xs"
                  variant={mode === "chapter" ? "default" : "outline"}
                  className={mode === "chapter" ? "font-medium shadow-xs" : undefined}
                  disabled={submitting}
                  onClick={() => onModeChange("chapter")}
                >
                  整章按题型
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant={mode === "points" ? "default" : "outline"}
                  className={mode === "points" ? "font-medium shadow-xs" : undefined}
                  disabled={submitting || (currentChapter?.points.length ?? 0) === 0}
                  onClick={() => onModeChange("points")}
                >
                  按知识点配额（{currentChapter?.points.length ?? 0}）
                </Button>
                {mode === "points" && (
                  <div className="ml-auto flex flex-wrap items-center gap-1.5">
                    <Badge variant={totalQuotaQuestions > 0 ? "default" : "secondary"} className="text-[11px] tabular-nums">
                      已配 {activePointQuotas.length} 个知识点 · 共 {totalQuotaQuestions} 题
                    </Badge>
                    {totalQuotaQuestions > 0 && (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={submitting}
                        onClick={() => setQuotas({})}
                      >
                        <RotateCcw /> 全部清空
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {mode === "chapter" ? (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/25 px-2.5 py-1.5 text-xs">
                    <span className="text-muted-foreground">题量预设：</span>
                    {CHAPTER_PRESETS.map((preset) => (
                      <Button
                        key={preset.label}
                        type="button"
                        size="xs"
                        variant="outline"
                        className="h-6 bg-background px-2 text-[11px]"
                        disabled={submitting}
                        onClick={() => setCounts({ ...preset.counts })}
                      >
                        {preset.label}
                      </Button>
                    ))}
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      每题自动校验自包含与详细解析
                    </span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {TYPE_FIELDS.map((field) => (
                      <div key={field.key} className="field !mb-0">
                        <Label htmlFor={`ai-count-${field.key}`}>{field.label}</Label>
                        <Input
                          id={`ai-count-${field.key}`}
                          type="number"
                          min={0}
                          max={30}
                          disabled={submitting}
                          value={counts[field.key]}
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) =>
                            setCounts((prev) => ({
                              ...prev,
                              [field.key]: Math.max(0, Math.min(30, Number(e.target.value) || 0)),
                            }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-2">
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <div className="relative min-w-48 flex-1">
                      <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-muted-foreground" />
                      <Input
                        aria-label="筛选知识点配额"
                        placeholder="搜索知识点名称或小节…"
                        className="h-8 pl-8 text-xs"
                        value={pointSearch}
                        onChange={(e) => setPointSearch(e.target.value)}
                      />
                    </div>
                    {sections.length > 1 && (
                      <SelectField
                        aria-label="按小节筛选"
                        value={sectionFilter}
                        onValueChange={setSectionFilter}
                        className="h-8 w-44 text-xs"
                      >
                        <option value="all">全部小节（{sections.length}）</option>
                        {sections.map((sec) => (
                          <option key={sec} value={sec}>
                            {sec}
                          </option>
                        ))}
                      </SelectField>
                    )}
                    <Button
                      type="button"
                      size="xs"
                      variant={onlyConfigured ? "secondary" : "outline"}
                      className="h-8 px-2.5 text-xs"
                      disabled={submitting}
                      onClick={() => setOnlyConfigured((v) => !v)}
                    >
                      仅看已配（{activePointQuotas.length}）
                    </Button>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-1.5 rounded-md border bg-muted/25 px-2.5 py-1.5 text-xs">
                    <span className="text-muted-foreground">
                      快捷填充（当前 {filteredPoints.length} 个知识点）：
                    </span>
                    {TYPE_FIELDS.map((f) => (
                      <Button
                        key={f.key}
                        type="button"
                        size="xs"
                        variant="outline"
                        className="h-6 bg-background px-2 text-[11px]"
                        disabled={submitting || filteredPoints.length === 0}
                        onClick={() => batchAdjustVisible(f.key, 1)}
                      >
                        <Plus size={11} /> 各 +1 {f.shortLabel}
                      </Button>
                    ))}
                    {(sectionFilter !== "all" || pointSearch.trim()) && filteredPoints.length > 0 && (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        className="ml-auto h-6 px-2 text-[11px]"
                        disabled={submitting}
                        onClick={clearVisible}
                      >
                        清空当前筛选
                      </Button>
                    )}
                  </div>

                  <div className="min-h-[280px] max-h-[48vh] flex-1 overflow-y-auto rounded-md border overscroll-contain [scrollbar-width:thin]">
                    {groupedFiltered.length === 0 ? (
                      <p className="p-8 text-center text-xs text-muted-foreground">
                        {onlyConfigured ? "当前筛选下尚无已配额的知识点" : "没有匹配的知识点"}
                      </p>
                    ) : (
                      <table className="w-full border-collapse text-xs">
                        <thead className="sticky top-0 z-10 border-b bg-muted/95 text-muted-foreground backdrop-blur-xs">
                          <tr>
                            <th scope="col" className="px-3 py-2 text-left font-medium">
                              知识点
                            </th>
                            <th scope="col" className="w-16 px-2 py-2 text-center font-medium">
                              现有题
                            </th>
                            {TYPE_FIELDS.map((f) => (
                              <th key={f.key} scope="col" className="w-20 px-1.5 py-2 text-center font-medium">
                                {f.shortLabel}
                              </th>
                            ))}
                            <th scope="col" className="w-16 px-3 py-2 text-right font-medium">
                              小计
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {groupedFiltered.map(([section, pts]) => {
                            const secSum = pts.reduce((acc, pt) => {
                              const q = quotas[pt.id] ?? ZERO_COUNTS;
                              return acc + q.single + q.multiple + q.true_false + q.fill_blank;
                            }, 0);
                            return (
                              <Fragment key={`sec:${section}`}>
                                <tr className="bg-muted/35">
                                  <td colSpan={7} className="px-3 py-1.5 text-[11px] font-semibold text-muted-foreground">
                                    <div className="flex items-center justify-between gap-2">
                                      <span>{section}</span>
                                      <span className="font-normal tabular-nums">
                                        {pts.length} 个知识点{secSum > 0 ? ` · 已配 ${secSum} 题` : ""}
                                      </span>
                                    </div>
                                  </td>
                                </tr>
                                {pts.map((pt) => {
                                  const q = quotas[pt.id] ?? ZERO_COUNTS;
                                  const rowSum = q.single + q.multiple + q.true_false + q.fill_blank;
                                  return (
                                    <tr
                                      key={pt.id}
                                      className={`transition-colors hover:bg-muted/30 ${rowSum > 0 ? "bg-primary/[0.03]" : ""}`}
                                    >
                                      <td className="px-3 py-1.5 align-middle">
                                        <div className="font-medium text-sm text-foreground leading-snug" title={pt.brief || pt.title}>
                                          {pt.title}
                                        </div>
                                      </td>
                                      <td className="px-2 py-1.5 text-center align-middle tabular-nums">
                                        <span
                                          className={
                                            pt.question_count === 0
                                              ? "text-muted-foreground/70"
                                              : "font-medium text-foreground"
                                          }
                                        >
                                          {pt.question_count}
                                        </span>
                                      </td>
                                      {TYPE_FIELDS.map((f) => (
                                        <td key={f.key} className="px-1.5 py-1.5 text-center align-middle">
                                          <Input
                                            aria-label={`${pt.title} ${f.label}`}
                                            type="number"
                                            min={0}
                                            max={20}
                                            disabled={submitting}
                                            className={`mx-auto h-7 w-16 px-1.5 text-center text-xs tabular-nums ${
                                              q[f.key] > 0 ? "border-primary/60 bg-primary/5 font-medium" : ""
                                            }`}
                                            value={q[f.key]}
                                            onFocus={(e) => e.currentTarget.select()}
                                            onChange={(e) => updateQuota(pt.id, f.key, Number(e.target.value) || 0)}
                                          />
                                        </td>
                                      ))}
                                      <td className="px-3 py-1.5 text-right align-middle tabular-nums">
                                        {rowSum > 0 ? (
                                          <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
                                            {rowSum} 题
                                          </Badge>
                                        ) : (
                                          <span className="text-muted-foreground/60">0</span>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-1.5 text-xs tabular-nums">
                    <span className="text-muted-foreground">
                      配额汇总：单选 <strong className="text-foreground">{typeTotals.single}</strong> · 多选{" "}
                      <strong className="text-foreground">{typeTotals.multiple}</strong> · 判断{" "}
                      <strong className="text-foreground">{typeTotals.true_false}</strong> · 填空{" "}
                      <strong className="text-foreground">{typeTotals.fill_blank}</strong>
                    </span>
                    <span className="font-medium text-foreground">
                      共 {totalQuotaQuestions} 题（单次上限 60 个知识点）
                    </span>
                  </div>
                </div>
              )}

              <p className="shrink-0 text-xs text-muted-foreground">
                仅生成单选、多选、判断、单空填空四类客观题草稿；教师审校设为「可用」后可用于小镇练习活动与课程组卷。
              </p>
            </>
          )}
        </div>
      )}

      <DialogFooter className="shrink-0">
        <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
          取消
        </Button>
        <Button type="submit" disabled={loading || submitting || !currentChapter}>
          {category === "coding" ? <Code2 /> : <Sparkles />}{" "}
          {submitting ? "提交中…" : category === "coding" ? "生成并自动验题" : "开始生成草稿"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function AiGenerateDialog({
  open,
  courseId,
  onOpenChange,
  onSubmitted,
}: {
  open: boolean;
  courseId: number;
  onOpenChange: (open: boolean) => void;
  onSubmitted: () => void;
}) {
  const [category, setCategory] = useState<GenerateCategory>("objective");
  const [mode, setMode] = useState<"chapter" | "points">("chapter");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setCategory("objective");
          setMode("chapter");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        className={
          category === "objective" && mode === "points"
            ? "flex max-h-[90vh] w-[94vw] max-w-4xl flex-col overflow-hidden sm:max-w-4xl"
            : "flex max-h-[90vh] flex-col overflow-hidden sm:max-w-2xl"
        }
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>AI 智能出题</DialogTitle>
          <DialogDescription>
            基于章节课件生成客观题或经沙箱验题的 Python 编程题草稿，审核通过后即可在课程题库选用。
          </DialogDescription>
        </DialogHeader>
        {open && (
          <DialogBody
            courseId={courseId}
            category={category}
            onCategoryChange={setCategory}
            mode={mode}
            onModeChange={setMode}
            onClose={() => {
              setCategory("objective");
              setMode("chapter");
              onOpenChange(false);
            }}
            onSubmitted={onSubmitted}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
