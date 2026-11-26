import { Fragment, useEffect, useMemo, useState } from "react";
import { Plus, RotateCcw, Search, Sparkles } from "lucide-react";
import { ErrorNotice, Loading } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { cleanGraphLabel } from "@/features/content-workspace/lectio-graph-layout";
import { errorMessage } from "@/lib/api";
import { materialKindLabel } from "@/lib/material-kind";
import {
  lectioApi,
  type KnowledgeChapter,
  type KnowledgePointItem,
  type PointQuotaPayload,
} from "@/lib/lectio-api";

type ObjectiveCounts = {
  single: number;
  multiple: number;
  true_false: number;
  fill_blank: number;
};

const EMPTY_COUNTS: ObjectiveCounts = { single: 2, multiple: 1, true_false: 2, fill_blank: 1 };
const ZERO_COUNTS: ObjectiveCounts = { single: 0, multiple: 0, true_false: 0, fill_blank: 0 };

const TYPE_FIELDS: { key: keyof ObjectiveCounts; label: string; shortLabel: string }[] = [
  { key: "single", label: "单选题", shortLabel: "单选" },
  { key: "multiple", label: "多选题", shortLabel: "多选" },
  { key: "true_false", label: "判断题", shortLabel: "判断" },
  { key: "fill_blank", label: "填空题（单空）", shortLabel: "填空" },
];

function DialogBody({
  classroomId,
  mode,
  onModeChange,
  onClose,
  onSubmitted,
}: {
  classroomId: number;
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
  const [quotas, setQuotas] = useState<Record<number, ObjectiveCounts>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    lectioApi
      .listKnowledge(classroomId, controller.signal)
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
  }, [classroomId]);

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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!currentChapter || submitting) return;
    setError("");
    const matNum = materialId !== "all" ? Number(materialId) : undefined;
    let payload;
    if (mode === "chapter") {
      const total = counts.single + counts.multiple + counts.true_false + counts.fill_blank;
      if (total <= 0) {
        setError("请至少设置一种客观题生成数量。");
        return;
      }
      payload = {
        ...(matNum ? { material_id: matNum } : {}),
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
        point_quotas: pointQuotas,
      };
    }

    setSubmitting(true);
    try {
      await lectioApi.generateExercises(classroomId, currentChapter.id, payload);
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
      <ErrorNotice message={error} />
      {loading ? (
        <Loading />
      ) : chapters.length === 0 ? (
        <p className="text-sm text-muted-foreground">请先在「章节与课件」中创建章节并上传课件。</p>
      ) : (
        <>
          <div className="grid shrink-0 gap-3 sm:grid-cols-2">
            <div className="field">
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
            <div className="field">
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
          </div>

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
            <div className="grid gap-3 sm:grid-cols-2">
              {TYPE_FIELDS.map((field) => (
                <div key={field.key} className="field">
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

      <DialogFooter className="shrink-0">
        <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
          取消
        </Button>
        <Button type="submit" disabled={loading || submitting || !currentChapter}>
          <Sparkles /> {submitting ? "提交中…" : "开始生成草稿"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function AiGenerateDialog({
  open,
  classroomId,
  onOpenChange,
  onSubmitted,
}: {
  open: boolean;
  classroomId: number;
  onOpenChange: (open: boolean) => void;
  onSubmitted: () => void;
}) {
  const [mode, setMode] = useState<"chapter" | "points">("chapter");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setMode("chapter");
        onOpenChange(next);
      }}
    >
      <DialogContent
        className={
          mode === "points"
            ? "flex max-h-[90vh] w-[94vw] max-w-4xl flex-col overflow-hidden sm:max-w-4xl"
            : "sm:max-w-xl"
        }
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>AI 智能出题</DialogTitle>
          <DialogDescription>基于章节课件生成客观题草稿，审核通过后同步进入班级题库与小镇活动。</DialogDescription>
        </DialogHeader>
        {open && (
          <DialogBody
            classroomId={classroomId}
            mode={mode}
            onModeChange={setMode}
            onClose={() => {
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
