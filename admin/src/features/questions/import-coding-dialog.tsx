import { useEffect, useState } from "react";
import { CheckCircle2, FileUp, Upload } from "lucide-react";
import { ErrorNotice } from "@/components/common";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { api, errorMessage, scoped } from "@/lib/api";
import type { Chapter } from "@/lib/types";

interface ImportResult {
  created: number;
  skipped: number;
  created_ids: string[];
  skipped_ids: string[];
  errors: { index: number; id: string; detail: string }[];
}

const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024;

function parseImportItems(raw: string): Record<string, unknown>[] {
  const trimmed = raw.replace(/^\ufeff/, "").trim();
  if (!trimmed) throw new Error("请上传 JSON/JSONL 文件或粘贴编程题数据。");
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { problems?: unknown }).problems)) {
        return (parsed as { problems: Record<string, unknown>[] }).problems;
      }
      if (parsed && typeof parsed === "object") {
        return [parsed as Record<string, unknown>];
      }
    } catch (jsonErr) {
      // Multi-line JSONL files start with '{' on line 1; fall through to line-by-line parsing.
      if (!trimmed.includes("\n")) {
        throw new Error(`JSON 解析失败：${errorMessage(jsonErr)}`, { cause: jsonErr });
      }
    }
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new Error("未解析出任何题目条目。");
  return lines.map((line, index) => {
    try {
      const obj = JSON.parse(line) as unknown;
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        throw new Error("必须为 JSON 对象");
      }
      return obj as Record<string, unknown>;
    } catch (cause) {
      throw new Error(`第 ${index + 1} 行 JSONL 解析失败：${errorMessage(cause)}`, { cause });
    }
  });
}

export function ImportCodingDialog({
  open,
  courseId,
  chapters,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  courseId: number;
  chapters: Chapter[];
  onOpenChange: (open: boolean) => void;
  onImported: (createdIds?: string[]) => void;
}) {
  const [rawJson, setRawJson] = useState("");
  const [fileName, setFileName] = useState("");
  const [defaultChapterId, setDefaultChapterId] = useState("");
  const [skipExisting, setSkipExisting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    setRawJson("");
    setFileName("");
    setDefaultChapterId("");
    setError("");
    setResult(null);
  }, [courseId]);

  async function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    setResult(null);
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setError("文件超过 2 MiB 上限，请拆分后再导入。");
      event.target.value = "";
      return;
    }
    setFileName(file.name);
    try {
      setRawJson(await file.text());
    } catch (cause) {
      setError(`读取文件失败：${errorMessage(cause)}`);
    } finally {
      event.target.value = "";
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setResult(null);
    let items: Record<string, unknown>[];
    try {
      items = parseImportItems(rawJson);
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }
    if (!items.length) {
      setError("文件中没有可导入的题目条目。");
      return;
    }
    if (items.length > 100) {
      setError("单次最多批量导入 100 道编程题，请分批导入。");
      return;
    }

    setBusy(true);
    try {
      const response = await api.post<ImportResult>(
        scoped("/teacher/questions/import-coding", courseId),
        {
          items,
          default_chapter_id: defaultChapterId ? Number(defaultChapterId) : null,
          skip_existing: skipExisting,
        },
      );
      setResult(response);
      if (response.created > 0) {
        toast.add({
          title: `已导入 ${response.created} 道编程题草稿${response.skipped ? `（跳过 ${response.skipped} 道重复）` : ""}`,
          type: "success",
        });
        onImported(response.created_ids);
      } else if (response.errors.length === 0) {
        toast.add({ title: `全部 ${response.skipped} 道题目均已存在，未新增`, type: "info" });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function handleOpenChange(next: boolean) {
    if (busy) return;
    if (!next) {
      setRawJson("");
      setFileName("");
      setDefaultChapterId("");
      setError("");
      setResult(null);
    }
    onOpenChange(next);
  }

  let parsedCount: number | null = null;
  if (rawJson.trim()) {
    try {
      parsedCount = parseImportItems(rawJson).length;
    } catch {
      parsedCount = null;
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>批量导入编程题</DialogTitle>
          <DialogDescription>
            支持导入标准编程题数据集 JSON / JSONL（含程序填空、程序改错、程序设计）。导入题目默认保存为「待审核」草稿，审校通过后才对学生开放。
          </DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col gap-4" onSubmit={(e) => void submit(e)}>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            <ErrorNotice message={error} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="field !mb-0">
                <Label htmlFor="import-coding-file">从文件加载（.json / .jsonl）</Label>
                <div className="flex items-center gap-2">
                  <label className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted/50">
                    <FileUp size={15} /> 选择文件
                    <input
                      id="import-coding-file"
                      type="file"
                      accept=".json,.jsonl,application/json"
                      className="sr-only"
                      disabled={busy}
                      onChange={(e) => void onPickFile(e)}
                    />
                  </label>
                  <span className="truncate text-xs text-muted-foreground">
                    {fileName || "未选择文件，也可直接粘贴"}
                  </span>
                </div>
              </div>
              <div className="field !mb-0">
                <Label htmlFor="import-coding-chapter">兜底章节（文件未指定章节时归入）</Label>
                <SelectField
                  id="import-coding-chapter"
                  value={defaultChapterId}
                  disabled={busy}
                  onValueChange={setDefaultChapterId}
                >
                  <option value="">自动按 chapter_order 匹配（不兜底）</option>
                  {chapters.map((ch) => (
                    <option key={ch.id} value={String(ch.id)}>
                      第 {ch.order_index} 章 · {ch.title}
                    </option>
                  ))}
                </SelectField>
              </div>
            </div>

            <div className="field !mb-0">
              <div className="mb-1 flex items-center justify-between gap-2">
                <Label htmlFor="import-coding-json">编程题 JSON 内容</Label>
                {parsedCount !== null && (
                  <Badge variant="secondary" className="text-[11px] tabular-nums">
                    已识别 {parsedCount} 道题目
                  </Badge>
                )}
              </div>
              <Textarea
                id="import-coding-json"
                rows={9}
                className="field-sizing-fixed h-52 max-h-60 resize-y overflow-y-auto font-mono text-xs"
                disabled={busy}
                value={rawJson}
                placeholder='粘贴包含 "problems": [...] 的数据集 JSON，或编程题数组 [...]'
                onChange={(e) => {
                  setRawJson(e.target.value);
                  setResult(null);
                }}
              />
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={skipExisting}
                disabled={busy}
                onCheckedChange={(checked) => setSkipExisting(Boolean(checked))}
              />
              <span>自动跳过当前课程中已存在的题目 ID</span>
            </label>

            {result && (
              <section className="space-y-2 rounded-md border p-3 text-sm" aria-label="批量导入结果">
                <div className="flex flex-wrap items-center gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600" />
                  <strong>导入完成：</strong>
                  <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800">
                    新增草稿 {result.created} 道
                  </Badge>
                  {result.skipped > 0 && <Badge variant="secondary">跳过重复 {result.skipped} 道</Badge>}
                  {result.errors.length > 0 && (
                    <Badge variant="destructive">校验失败 {result.errors.length} 道</Badge>
                  )}
                </div>
                {result.errors.length > 0 && (
                  <ul className="max-h-36 list-disc space-y-1 overflow-y-auto pl-5 text-xs text-destructive">
                    {result.errors.map((item) => (
                      <li key={`${item.index}-${item.id}`}>
                        第 {item.index} 题（{item.id}）：{item.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>

          <DialogFooter className="shrink-0">
            <Button type="button" variant="outline" disabled={busy} onClick={() => handleOpenChange(false)}>
              关闭
            </Button>
            <Button type="submit" disabled={busy || !rawJson.trim()}>
              <Upload /> {busy ? "正在导入…" : "导入为待审草稿"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
