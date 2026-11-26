import { Upload } from "lucide-react";
import { api, scoped } from "@/lib/api";

export interface BatchUploadResult {
  created: { id: number; title: string; kind: string; status: string; filename: string }[];
  skipped: { filename: string; reason: string }[];
  created_chapters?: { id: number; title: string; order_index: number }[];
}

export async function uploadMaterialsBatch(
  courseId: number,
  files: File[],
  chapterIds: number[],
  autoCreateChapter?: boolean,
): Promise<BatchUploadResult> {
  const body = new FormData();
  for (const file of files) body.append("files", file);
  if (chapterIds.length > 0) body.append("chapter_ids", JSON.stringify(chapterIds));
  if (autoCreateChapter !== undefined) body.append("auto_create_chapter", String(autoCreateChapter));
  return api.upload<BatchUploadResult>(scoped("/teacher/materials/upload-batch", courseId), body);
}

export function DropImportOverlay({
  visible,
  targetLabel,
}: {
  visible: boolean;
  targetLabel: string;
}) {
  if (!visible) return null;
  return (
    <div
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-xs"
      role="status"
      aria-live="polite"
    >
      <div className="flex max-w-md flex-col items-center gap-3 rounded-xl border-2 border-dashed border-foreground/40 bg-background px-10 py-10 text-center shadow-lg">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <Upload size={22} />
        </div>
        <p className="text-base font-semibold">松开鼠标即可导入资料</p>
        <p className="text-sm text-muted-foreground">将自动导入到「{targetLabel}」</p>
        <p className="text-xs text-muted-foreground">
          支持 .pdf / .ppt / .pptx / .txt / .md / .mp4 / .webm，支持多选及 .zip 压缩包自动解压
        </p>
      </div>
    </div>
  );
}
