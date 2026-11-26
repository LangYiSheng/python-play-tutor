import { toast } from "@/components/ui/toast";
import { uploadMaterialsBatch } from "@/features/courseware/drop-import-overlay";
import { api, errorMessage, scoped } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import type { Material } from "@/lib/types";
import { useState, type FormEvent } from "react";

export function useMaterialEditor(courseId: number, onSaved: () => void) {
  const [editing, setEditing] = useState<Material | null>(null),
    [open, setOpen] = useState(false),
    [title, setTitle] = useState(""),
    [chapterIds, setChapterIds] = useState<number[]>([]),
    [file, setFile] = useState<File | null>(null),
    [files, setFiles] = useState<File[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  useDraft(open && dirty);

  const isBatchMode =
    !editing &&
    (files.length > 1 || (files.length === 1 && files[0].name.toLowerCase().endsWith(".zip")));

  function edit(m: Material | null) {
    setEditing(m);
    setTitle(m?.title ?? "");
    setChapterIds(m?.chapter_ids ?? []);
    setFile(null);
    setFiles([]);
    setDirty(false);
    setError("");
    setOpen(true);
  }

  function selectFiles(picked: File[]) {
    if (editing) {
      const first = picked[0] ?? null;
      setFile(first);
      setFiles(first ? [first] : []);
      if (first && !title) setTitle(first.name.replace(/\.[^.]+$/, ""));
    } else {
      setFiles(picked);
      setFile(picked[0] ?? null);
      if (picked.length === 1 && !picked[0].name.toLowerCase().endsWith(".zip") && !title) {
        setTitle(picked[0].name.replace(/\.[^.]+$/, ""));
      }
    }
    setDirty(true);
    setError("");
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (isBatchMode) {
        const res = await uploadMaterialsBatch(courseId, files, chapterIds);
        const chapterCount = res.created_chapters?.length ?? 0;
        const chapterNote = chapterCount > 0 ? `，自动新建 ${chapterCount} 个章节` : "";
        const skippedNote = res.skipped.length > 0 ? `（跳过 ${res.skipped.length} 项）` : "";
        toast.add({ title: `已导入 ${res.created.length} 份资料${chapterNote}${skippedNote}`, type: "success" });
      } else if (file) {
        const body = new FormData();
        body.append("file", file);
        body.append("title", title);
        body.append("chapter_ids", JSON.stringify(chapterIds));
        if (editing) body.append("material_id", String(editing.id));
        const res = await api.upload<{
          id: number;
          title: string;
          created_chapter?: { id: number; title: string; order_index: number };
        }>(scoped("/teacher/materials/upload", courseId), body);
        if (!editing && res?.created_chapter) {
          toast.add({
            title: `已上传「${res.title}」，并自动新建章节「${res.created_chapter.title}」`,
            type: "success",
          });
        }
      } else if (editing) {
        await api.put(scoped(`/teacher/materials/${editing.id}`, courseId), {
          title,
          chapter_ids: chapterIds,
        });
      } else {
        throw new Error("请选择需要上传的文件");
      }
      setOpen(false);
      setDirty(false);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return {
    editing,
    setEditing,
    open,
    setOpen,
    title,
    setTitle,
    chapterIds,
    setChapterIds,
    file,
    setFile,
    files,
    isBatchMode,
    selectFiles,
    error,
    setError,
    busy,
    setBusy,
    dirty,
    setDirty,
    edit,
    save,
  };
}
