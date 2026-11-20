import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { usePageMedia } from "./use-page-media";
import type { useNarrationReview } from "./use-review";
export function NarrationPagePreview({
  review,
  media,
}: {
  review: ReturnType<typeof useNarrationReview>;
  media: ReturnType<typeof usePageMedia>;
  classroomId: number;
  materialId: number;
}) {
  const { data, setPageNo, page, previous, next } = review;
  const { imageFailed, setImageFailed, pageImage } = media;
  const digest = page?.digest ?? null;
  if (!page || !data) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button
          size="sm"
          variant="ghost"
          disabled={!previous}
          onClick={() => previous && setPageNo(previous)}
        >
          <ChevronLeft /> 上一页
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!next}
          onClick={() => next && setPageNo(next)}
        >
          下一页 <ChevronRight />
        </Button>
        <span className="hint">
          第 {page.page_no} / {data.coverage.pages} 页
        </span>
        <Input
          type="number"
          aria-label="跳到页码"
          className="ml-auto w-20"
          min={1}
          max={data.coverage.pages}
          placeholder="跳页"
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const target = Number((event.target as HTMLInputElement).value);
            if (data.pages.some((item) => item.page_no === target))
              setPageNo(target);
          }}
        />
      </div>
      <div className="space-y-1 rounded border p-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">
            {digest?.title || page.title || `第 ${page.page_no} 页`}
          </span>
          {digest?.topic && <span className="hint">{digest.topic}</span>}
          {digest && digest.image_state !== "sent" && (
            <Badge
              variant="secondary"
              title="整理这页时没有带页图，内容可能缺少图里的信息"
            >
              本页无图证据
            </Badge>
          )}
        </div>
        {digest?.tags?.length ? (
          <p className="hint">标签：{digest.tags.join("、")}</p>
        ) : null}
        {!digest && (
          <p className="hint">
            这页还没有整理稿，点「一键梳理文本」生成；未整理时讲解会退回解析原文。
          </p>
        )}
      </div>
      <div className="flex max-h-[62vh] min-h-[280px] items-center justify-center overflow-auto rounded border bg-muted/30 p-2">
        {imageFailed ? (
          <p className="hint px-4 text-center">
            这一页没有可渲染的页面图像（文本资料或转换缺少预览）。
            <br />
            右侧仍可查看原文片段与讲解。
          </p>
        ) : (
          <img
            src={pageImage}
            alt={`第 ${page.page_no} 页`}
            className="max-h-[60vh] w-auto max-w-full"
            onError={() => setImageFailed(true)}
          />
        )}
      </div>
      <details className="text-sm" open>
        <summary className="cursor-pointer">
          整理稿（{digest?.text.length ?? 0} 字）
        </summary>
        <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded border p-2 text-xs">
          {digest?.text || "（这页还没有整理稿）"}
        </pre>
      </details>
      <details className="text-sm">
        <summary className="cursor-pointer">
          查看原始文本（{page.source_chars} 字）
        </summary>
        <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded border p-2 text-xs">
          {page.raw_text || page.source_text || "（无文本层，内容在页面图像里）"}
        </pre>
      </details>
    </div>
  );
}
