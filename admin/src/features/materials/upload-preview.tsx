import { useEffect, useState } from "react";
import { ErrorNotice } from "@/components/common";
import { errorMessage, request, scoped } from "@/lib/api";
import type { Chapter } from "@/lib/types";

interface Preview {
  items: { filename: string; title: string; chapter: { title: string; order_index: number; new: boolean } | null }[];
  skipped: { filename: string; reason: string }[];
}

export function UploadPreview({ courseId, files, title, chapters }: {
  courseId: number; files: File[]; title?: string; chapters: Chapter[];
}) {
  const [result, setResult] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError("");
    const timer = window.setTimeout(async () => {
      const body = new FormData();
      body.append("manifest", JSON.stringify(files.map(({ name, size }) => ({ name, size }))));
      if (title !== undefined) body.append("title", title);
      for (const file of files) if (/\.zip$/i.test(file.name)) body.append("archives", file);
      try {
        const data = await request<Preview>(scoped("/teacher/materials/upload-preview", courseId), {
          method: "POST", body, signal: controller.signal,
        });
        if (!controller.signal.aborted) setResult(data);
      } catch (err) {
        if (!controller.signal.aborted) setError(errorMessage(err));
      }
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [courseId, files, title]);
  const selected = chapters.map(ch => `第 ${ch.order_index} 章 · ${ch.title}`).join("、");
  return <section className="mb-4" aria-label="导入预览">
    <h3 className="mb-2 font-medium">导入预览</h3>
    <ErrorNotice message={error} />
    {!result && !error && <p className="hint" role="status">正在读取文件清单…</p>}
    {result && <div className="max-h-52 overflow-auto">
      <table className="w-full table-fixed text-left text-xs">
        <thead><tr className="border-b"><th scope="col">文件</th><th scope="col">归入章节</th><th scope="col">资料名称</th></tr></thead>
        <tbody>{result.items.map(({ filename, title: material, chapter }, i) =>
          <tr key={i} className="border-b align-top [&>td]:break-words [&>td]:py-2 [&>td]:pr-2">
            <td>{filename}</td>
            <td>{selected || (chapter ? `第 ${chapter.order_index} 章 · ${chapter.title}${chapter.new ? "（新建）" : ""}` : "未归类")}</td>
            <td>{material}</td>
          </tr>)}
          {result.skipped.map((row, i) => <tr key={`skip-${i}`}><td className="break-words py-2">{row.filename}</td><td colSpan={2}>跳过 · {row.reason}</td></tr>)}
        </tbody>
      </table>
    </div>}
  </section>;
}
