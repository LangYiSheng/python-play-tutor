import { useCallback, useEffect } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { EditorTabs } from "@/components/editor-tabs";
import { ErrorNotice } from "@/components/common";
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
import { Textarea } from "@/components/ui/textarea";
import { KnowledgePointPicker } from "@/features/curriculum/knowledge-point-picker";
import type { Course, Material, Question } from "@/lib/types";
import { Cases } from "./cases-editor";
import { questionEditors } from "./editor-registry";
import "./questions.css";
import { codingTypeLabels, codingUsageLabels, kinds, statuses, type CodingType, type CodingUsage } from "./types";
import type { useQuestionEditor } from "./use-editor";

export interface QuestionReviewQueue {
  index: number;
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
  loading?: boolean;
  onPrev: () => void;
  onNext: () => void;
  onApproved?: () => void;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(target.closest("[role='combobox'],[role='listbox']"));
}

function statusPillClass(status: Question["status"]): string {
  if (status === "ready") return "border-emerald-300 bg-emerald-50 text-emerald-800";
  if (status === "draft") return "border-amber-300 bg-amber-50 text-amber-800";
  return "border-border bg-muted text-muted-foreground";
}

export function QuestionDialog({
  editor,
  courseId,
  course,
  materials,
  queue,
}: {
  editor: ReturnType<typeof useQuestionEditor>;
  courseId: number;
  course: { data: Pick<Course, "chapters"> | null };
  materials: { data: Material[] | null };
  queue?: QuestionReviewQueue;
}) {
  const {
    editing,
    open,
    setOpen,
    title,
    setTitle,
    prompt,
    setPrompt,
    explanation,
    setExplanation,
    difficulty,
    setDifficulty,
    codingType,
    setCodingType,
    usage,
    setUsage,
    kind,
    setKind,
    status,
    setStatus,
    chapterIds,
    setChapterIds,
    pointIds,
    setPointIds,
    referenceMaterial,
    setReferenceMaterial,
    referencePage,
    setReferencePage,
    error,
    busy,
    dirty,
    setDirty,
    save,
    saveWithStatus,
  } = editor;

  const isComplex = kind === "python" || kind === "interactive";
  const TypeFields = questionEditors[kind].Fields;
  const navBusy = busy || Boolean(queue?.loading);

  const navigateQueue = useCallback(
    (go: () => void) => {
      if (navBusy) return;
      if (dirty && !window.confirm("当前题目有未保存的修改，确定放弃并切换题目？")) return;
      go();
    },
    [dirty, navBusy],
  );

  const approveAndAdvance = useCallback(async () => {
    if (navBusy || !editing) return;
    if (status === "ready" && !dirty) {
      if (queue?.onApproved) queue.onApproved();
      else if (queue?.hasNext) queue.onNext();
      else setOpen(false);
      return;
    }
    const ok = await saveWithStatus("ready", { keepOpen: Boolean(queue?.onApproved) });
    if (ok && queue?.onApproved) queue.onApproved();
  }, [dirty, editing, navBusy, queue, saveWithStatus, setOpen, status]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (navBusy) return;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        if (!editing) return;
        event.preventDefault();
        void approveAndAdvance();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveWithStatus(status);
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        if (event.key === "ArrowLeft" && queue?.hasPrev) {
          event.preventDefault();
          navigateQueue(queue.onPrev);
        } else if (event.key === "ArrowRight" && queue?.hasNext) {
          event.preventDefault();
          navigateQueue(queue.onNext);
        }
        return;
      }
      if (event.ctrlKey || event.metaKey || isEditableElement(event.target)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "a" && editing) {
        event.preventDefault();
        void approveAndAdvance();
      } else if ((event.key === "ArrowLeft" || key === "k") && queue?.hasPrev) {
        event.preventDefault();
        navigateQueue(queue.onPrev);
      } else if ((event.key === "ArrowRight" || key === "j") && queue?.hasNext) {
        event.preventDefault();
        navigateQueue(queue.onNext);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [approveAndAdvance, editing, navBusy, navigateQueue, open, queue, saveWithStatus, status]);

  const linksSection = (
    <div className="flex flex-col gap-4">
      <KnowledgePointPicker
        chapters={course.data?.chapters ?? []}
        courseId={courseId}
        initialChapterId={chapterIds[0] ?? course.data?.chapters[0]?.id ?? 0}
        selected={pointIds}
        chapterSelection={{
          ids: chapterIds,
          change: (ids) => {
            setChapterIds(ids);
            setDirty(true);
          },
        }}
        onChange={(ids) => {
          setPointIds(ids);
          setDirty(true);
        }}
      />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px]">
        <div className="field !mb-0">
          <Label htmlFor="question-source">参考资料（可选）</Label>
          <SelectField
            id="question-source"
            value={referenceMaterial ?? ""}
            onValueChange={(value) => {
              setDirty(true);
              setReferenceMaterial(value ? Number(value) : null);
              setReferencePage("");
            }}
          >
            <option value="">无参考资料</option>
            {materials.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </SelectField>
        </div>
        {referenceMaterial !== null && (
          <div className="field !mb-0">
            <Label htmlFor="question-page">参考页码</Label>
            <Input
              id="question-page"
              type="number"
              min={1}
              step={1}
              value={referencePage}
              onChange={(e) => {
                setReferencePage(e.target.value);
                setDirty(true);
              }}
            />
          </div>
        )}
      </div>
      {referenceMaterial !== null && (
        <p className="hint -mt-2">按原始资料页码填写，保存时会检查页面是否存在。</p>
      )}
    </div>
  );

  const statusSelect = (
    <div className="field !mb-0">
      <Label htmlFor="q-status">状态</Label>
      <SelectField
        id="q-status"
        value={status}
        onValueChange={(value) => {
          setStatus(value as Question["status"]);
          setDirty(true);
        }}
      >
        {Object.entries(statuses).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </SelectField>
    </div>
  );

  const kindSelect = (
    <div className="field !mb-0">
      <Label htmlFor="q-kind">题型</Label>
      <SelectField
        id="q-kind"
        value={kind}
        onValueChange={(value) => {
          setKind(value as Question["kind"]);
          setDirty(true);
        }}
      >
        {Object.entries(kinds).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </SelectField>
    </div>
  );

  const difficultySelect = (
    <div className="field !mb-0">
      <Label htmlFor="q-difficulty">难度</Label>
      <SelectField
        id="q-difficulty"
        value={difficulty || "__none__"}
        onValueChange={(value) => {
          setDifficulty(value === "__none__" ? "" : value);
          setDirty(true);
        }}
      >
        <option value="__none__">未标注</option>
        <option value="易">易</option>
        <option value="中">中</option>
        <option value="难">难</option>
      </SelectField>
    </div>
  );

  const explanationField = (
    <div className="field !mb-0">
      <Label htmlFor="q-explanation">答案解析（可选）</Label>
      <Textarea
        id="q-explanation"
        rows={3}
        className="max-h-40 overflow-y-auto"
        value={explanation}
        maxLength={2000}
        placeholder="填写解题思路或易错点，导出试卷解析与复核时会一并展示"
        onChange={(e) => {
          setExplanation(e.target.value);
          setDirty(true);
        }}
      />
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!navBusy) setOpen(v);
      }}
    >
      <DialogContent className="editor-dialog tabbed-editor">
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2 pr-6">
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle>{editing ? "审校与编辑题目" : "新增题目"}</DialogTitle>
              <Badge variant="outline" className={statusPillClass(status)}>
                {statuses[status]}
              </Badge>
              {editing && (
                <Badge variant="secondary">
                  {editing.source_type === "ai_generated" ? "AI 生成" : "手动 / 导入"}
                </Badge>
              )}
            </div>
            {editing && queue && queue.total > 1 && (
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={!queue.hasPrev || navBusy}
                  onClick={() => navigateQueue(queue.onPrev)}
                >
                  <ChevronLeft /> 上一题
                </Button>
                <span className="px-1 text-xs tabular-nums text-muted-foreground">
                  {queue.index + 1} / {queue.total}
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={!queue.hasNext || navBusy}
                  onClick={() => navigateQueue(queue.onNext)}
                >
                  下一题 <ChevronRight />
                </Button>
              </div>
            )}
          </div>
          <DialogDescription>
            题干、答案、解析与章节关联同屏核对；通过审核设为「可用」后才对学生与组卷开放。
          </DialogDescription>
        </DialogHeader>
        <form
          inert={navBusy}
          aria-busy={navBusy}
          onSubmit={save}
          onChange={() => setDirty(true)}
        >
          <div className="dialog-scroll">
            <ErrorNotice message={error} />
            {isComplex ? (
              <EditorTabs
                key={editor.id}
                pages={[
                  {
                    label: "题目信息",
                    content: (
                      <div className="flex flex-col gap-4">
                        <div className="field !mb-0">
                          <Label htmlFor="q-title">题目名称</Label>
                          <Input
                            id="q-title"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            required
                            maxLength={200}
                          />
                        </div>
                        <div className="grid grid-cols-3 gap-3">
                          {kindSelect}
                          {difficultySelect}
                          {statusSelect}
                        </div>
                        {kind === "python" && (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="field !mb-0">
                              <Label htmlFor="q-coding-type">编程形式</Label>
                              <SelectField
                                id="q-coding-type"
                                value={codingType || "__none__"}
                                onValueChange={(value) => {
                                  setCodingType(value === "__none__" ? "" : (value as CodingType));
                                  setDirty(true);
                                }}
                              >
                                <option value="__none__">未细分（通用编程题）</option>
                                {Object.entries(codingTypeLabels).map(([k, v]) => (
                                  <option key={k} value={k}>
                                    {v}
                                  </option>
                                ))}
                              </SelectField>
                            </div>
                            <div className="field !mb-0">
                              <Label htmlFor="q-coding-usage">教学用途</Label>
                              <SelectField
                                id="q-coding-usage"
                                value={usage}
                                onValueChange={(value) => {
                                  setUsage(value as CodingUsage);
                                  setDirty(true);
                                }}
                              >
                                {Object.entries(codingUsageLabels).map(([k, v]) => (
                                  <option key={k} value={k}>
                                    {v}
                                  </option>
                                ))}
                              </SelectField>
                            </div>
                          </div>
                        )}
                        <div className="field !mb-0">
                          <Label htmlFor="q-prompt">题干</Label>
                          <Textarea
                            id="q-prompt"
                            rows={5}
                            className="max-h-72 overflow-y-auto"
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            required
                            maxLength={30000}
                          />
                        </div>
                        {explanationField}
                      </div>
                    ),
                  },
                  {
                    label: kind === "interactive" ? "编写与试答" : "初始代码与提示",
                    content: <TypeFields {...editor} />,
                  },
                  ...(kind === "python"
                    ? [
                        {
                          label: "测试用例",
                          content: (
                            <Cases
                              samples={editor.samples}
                              hidden={editor.cases}
                              codingType={editor.codingType}
                              starterCode={editor.starterCode}
                              referenceSolution={editor.referenceSolution}
                              onSamples={(value) => {
                                editor.setSamples(value);
                                setDirty(true);
                              }}
                              onHidden={(value) => {
                                editor.setCases(value);
                                setDirty(true);
                              }}
                            />
                          ),
                        },
                      ]
                    : []),
                  { label: "内容关联", content: linksSection },
                ]}
              />
            ) : (
              <div className="grid gap-5 pt-1 lg:grid-cols-[minmax(0,1.45fr)_minmax(310px,1fr)]">
                <div className="flex min-w-0 flex-col gap-4">
                  <div className="field !mb-0">
                    <Label htmlFor="q-prompt">题干</Label>
                    <Textarea
                      id="q-prompt"
                      rows={4}
                      className="max-h-60 overflow-y-auto"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      required
                      maxLength={30000}
                    />
                  </div>
                  <TypeFields {...editor} />
                  {explanationField}
                </div>
                <aside className="question-links-aside flex min-w-0 flex-col gap-4 rounded-lg border bg-muted/20 p-3.5">
                  <div className="grid grid-cols-3 gap-2.5">
                    {kindSelect}
                    {difficultySelect}
                    {statusSelect}
                  </div>
                  <div className="field !mb-0">
                    <Label htmlFor="q-title">题目名称</Label>
                    <Input
                      id="q-title"
                      value={title}
                      placeholder="默认同步题干首行"
                      onChange={(e) => setTitle(e.target.value)}
                      maxLength={200}
                    />
                    <p className="hint">用于列表简短展示，留空时自动取题干首行。</p>
                  </div>
                  <div className="border-t pt-3.5">{linksSection}</div>
                </aside>
              </div>
            )}
          </div>
          <DialogFooter className="mt-3 flex-wrap items-center gap-2 border-t pt-3 sm:justify-between">
            <span className="hidden text-[11px] text-muted-foreground sm:inline">
              {editing
                ? queue
                  ? "快捷键：A / Ctrl+Enter 通过并下一题 · ← / → 切题 · Ctrl+S 保存"
                  : "快捷键：A / Ctrl+Enter 通过审核 · Ctrl+S 保存"
                : "快捷键：Ctrl+S 保存题目"}
            </span>
            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <Button
                type="button"
                variant="outline"
                disabled={navBusy}
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button
                type="submit"
                variant={editing && status !== "ready" ? "outline" : "default"}
                disabled={navBusy}
              >
                {busy ? "保存中…" : "保存题目"}
              </Button>
              {editing && (status !== "ready" || queue?.hasNext) && (
                <Button
                  type="button"
                  disabled={navBusy}
                  className="bg-emerald-600 text-white hover:bg-emerald-700"
                  onClick={() => void approveAndAdvance()}
                >
                  <Check />
                  {status !== "ready"
                    ? queue?.hasNext
                      ? "通过并下一题"
                      : "通过审核"
                    : dirty
                      ? "保存并下一题"
                      : "下一题"}
                </Button>
              )}
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
