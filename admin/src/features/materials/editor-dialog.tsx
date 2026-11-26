import { useRef, useState } from "react";
import { Save, Upload } from "lucide-react";
import { ErrorNotice } from "@/components/common";
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
import type { Course } from "@/lib/types";
import type { useMaterialEditor } from "./use-editor";

export function MaterialDialog({
  editor,
  course,
}: {
  editor: ReturnType<typeof useMaterialEditor>;
  course: { data: Course | null };
}) {
  const {
    editing,
    open,
    setOpen,
    title,
    setTitle,
    chapterIds,
    setChapterIds,
    files,
    isBatchMode,
    selectFiles,
    error,
    busy,
    setDirty,
    save,
  } = editor;
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = editing
    ? ".pdf,.txt,.md,.ppt,.pptx,.mp4,.webm"
    : ".pdf,.txt,.md,.ppt,.pptx,.mp4,.webm,.zip";
  const singleIsDeck =
    !editing && !isBatchMode && files.length === 1 && /\.(ppt|pptx|pdf)$/i.test(files[0].name);
  const autoChapterWillApply =
    !editing && chapterIds.length === 0 && (isBatchMode || singleIsDeck || files.length === 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) setOpen(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "编辑资料" : "上传资料"}</DialogTitle>
          <DialogDescription>
            文件保存在私有存储中，仅向有权限的学生开放。
          </DialogDescription>
        </DialogHeader>
        <form
          inert={busy}
          aria-busy={busy}
          onSubmit={save}
          onChange={() => setDirty(true)}
        >
          <ErrorNotice message={error} />

          {!isBatchMode ? (
            <div className="field">
              <Label htmlFor="material-title">资料名称</Label>
              <Input
                id="material-title"
                required
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
          ) : (
            <p className="mb-3 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              批量或压缩包导入将自动以各课件文件名作为资料名称。
            </p>
          )}

          <div className="field">
            <Label htmlFor="material-file">
              {editing ? "替换文件（可选）" : "文件（支持拖入多文件或 .zip）"}
            </Label>
            <div
              className={`rounded-lg border-2 border-dashed p-4 text-center transition-colors ${
                dragging ? "border-foreground bg-muted/50" : "border-input hover:bg-muted/20"
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!dragging) setDragging(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragging(false);
                const dropped = Array.from(e.dataTransfer.files);
                if (dropped.length > 0) selectFiles(dropped);
              }}
            >
              <input
                ref={inputRef}
                id="material-file"
                type="file"
                multiple={!editing}
                required={!editing && files.length === 0}
                accept={accept}
                className="sr-only"
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  if (picked.length > 0) selectFiles(picked);
                }}
              />
              <div className="flex flex-col items-center gap-2">
                <Upload size={18} className="text-muted-foreground" />
                {files.length > 0 ? (
                  <p className="text-sm font-medium">
                    {files.length === 1
                      ? files[0].name
                      : `已选择 ${files.length} 个文件（${files
                          .slice(0, 2)
                          .map((f) => f.name)
                          .join("、")}${files.length > 2 ? " 等" : ""}）`}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">将文件拖到此处，或点击下方选择文件</p>
                )}
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => inputRef.current?.click()}
                >
                  {files.length > 0 ? "重新选择" : "选择文件"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {editing
                    ? "支持 .pdf / .ppt / .pptx / .txt / .md / .mp4 / .webm（需保持原资料类型）"
                    : "支持 .pdf / .ppt / .pptx / .txt / .md / .mp4 / .webm，以及自动解压含课件的 .zip"}
                </p>
              </div>
            </div>
          </div>

          <fieldset className="field">
            <legend>关联章节</legend>
            <div className="check-list">
              {course.data?.chapters.map((c) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={chapterIds.includes(c.id)}
                    onChange={() =>
                      setChapterIds((v) =>
                        v.includes(c.id)
                          ? v.filter((id) => id !== c.id)
                          : [...v, c.id],
                      )
                    }
                  />
                  {c.title}
                </label>
              ))}
            </div>
            {editing ? (
              <p className="hint">可调整归属章节，或取消全部勾选使其进入未归类资料。</p>
            ) : chapterIds.length > 0 ? (
              <p className="hint">已选 {chapterIds.length} 个章节，资料将直接归入所选章节（不新建章节）。</p>
            ) : autoChapterWillApply ? (
              <p className="mt-2 rounded-md border border-primary/25 bg-primary/5 px-2.5 py-1.5 text-xs text-foreground">
                {isBatchMode
                  ? "未勾选章节时，导入的每份 PPT / PDF 课件将自动按文件名各自新建独立章节并关联。"
                  : `未勾选章节时，上传 PPT / PDF 将自动以「${title.trim() || "课件名称"}」新建独立章节并关联；如需放进已有章节，勾选上方章节即可。`}
              </p>
            ) : (
              <p className="hint">可以暂不归类，之后再关联章节。</p>
            )}
          </fieldset>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={busy}>
              {editing ? <Save /> : <Upload />}
              {busy ? "处理中…" : isBatchMode ? "开始批量导入" : "保存资料"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
