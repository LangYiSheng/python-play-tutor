import { Download, ExternalLink, FileText } from "lucide-react";
import { Empty, ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { download, errorMessage, fileBlob } from "@/lib/api";
import { materialKindLabel } from "@/lib/material-kind";
import { useEffect, useState } from "react";
import { MaterialPreview } from "./types";
export function MaterialViewer({
  material,
  onClose,
}: {
  material: MaterialPreview;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(""),
    [blobData, setBlobData] = useState<Blob | null>(null),
    [viewMode, setViewMode] = useState<"file" | "text">("file"),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setUrl("");
    setBlobData(null);
    setViewMode("file");
    setError("");
    if (
      material.media_url &&
      (material.kind === "pdf" ||
        material.kind === "presentation" ||
        material.kind === "video")
    ) {
      fileBlob(material.media_url.replace(/^\/api/, ""))
        .then((blob) => {
          if (active) {
            objectUrl = URL.createObjectURL(blob);
            setBlobData(blob);
            setUrl(objectUrl);
          }
        })
        .catch((e) => {
          if (active) setError(errorMessage(e));
        });
    }
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [material]);

  const hasPages = Boolean(material.pages?.length);
  const isMedia = Boolean(
    material.media_url &&
      (material.kind === "pdf" ||
        material.kind === "presentation" ||
        material.kind === "video"),
  );
  const ext = material.kind === "video" ? "mp4" : "pdf";

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{material.title}</DialogTitle>
          <DialogDescription>
            资料预览 · {materialKindLabel(material.kind)}
          </DialogDescription>
        </DialogHeader>
        <ErrorNotice message={error} />
        {material.notice && <p className="hint">{material.notice}</p>}
        {isMedia && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {hasPages && (
              <Button
                type="button"
                size="xs"
                variant={viewMode === "text" ? "secondary" : "outline"}
                onClick={() => setViewMode((m) => (m === "file" ? "text" : "file"))}
              >
                <FileText /> {viewMode === "text" ? "切回原件预览" : `查看提取文字（${material.pages!.length} 页）`}
              </Button>
            )}
            {url && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
              >
                <ExternalLink /> 新窗口打开
              </Button>
            )}
            {blobData && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => download(blobData, `${material.title}.${ext}`)}
              >
                <Download /> 下载原件
              </Button>
            )}
            <span className="text-muted-foreground">
              若内置预览窗口未渲染 PDF，可点「新窗口打开」「下载原件」或切换「查看提取文字」。
            </span>
          </div>
        )}
        {viewMode === "text" && hasPages ? (
          <div className="max-h-[65vh] overflow-y-auto rounded border p-4 space-y-6">
            {material.pages!.map((p, i) => (
              <section key={p.id ?? i} className="border-b pb-4 last:border-b-0">
                <h3 className="font-semibold text-sm">
                  {p.title || `第 ${p.page_no ?? i + 1} 页`}
                </h3>
                <p className="whitespace-pre-wrap leading-7 text-sm mt-2">
                  {p.text ?? p.content ?? "暂无提取文字"}
                </p>
              </section>
            ))}
          </div>
        ) : url ? (
          material.kind === "video" ? (
            <video controls src={url} className="w-full max-h-[65vh]" />
          ) : (
            <iframe
              title={material.title}
              src={url}
              className="w-full h-[65vh] rounded border bg-background"
            />
          )
        ) : hasPages ? (
          <div className="max-h-[65vh] overflow-y-auto space-y-6">
            {material.pages!.map((p, i) => (
              <section key={p.id ?? i}>
                <h3 className="font-semibold">
                  {p.title || `第 ${p.page_no ?? i + 1} 页`}
                </h3>
                <p className="whitespace-pre-wrap leading-7 text-sm mt-3">
                  {p.text ?? p.content ?? "暂无提取文字"}
                </p>
              </section>
            ))}
          </div>
        ) : error ? null : isMedia ? (
          <Loading />
        ) : (
          <Empty title="此资料暂无可预览内容" />
        )}
      </DialogContent>
    </Dialog>
  );
}
