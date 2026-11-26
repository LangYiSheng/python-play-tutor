import { narrationApi } from "@/features/materials/narration/api";
import { fileBlob } from "@/lib/api";
import { useEffect, useRef, useState } from "react";

export function usePageMedia(
  courseId: number,
  materialId: number,
  pageNo: number | null,
  _saved: string,
) {
  const [clip, setClip] = useState("");
  const [imageFailed, setImageFailed] = useState(false);
  const [pageImage, setPageImage] = useState("");
  const [pagePdf, setPagePdf] = useState("");
  const [pdfLoading, setPdfLoading] = useState(false);
  const usePdfModeRef = useRef(false);
  const audioGeneration = useRef(0);

  useEffect(() => {
    usePdfModeRef.current = false;
  }, [courseId, materialId]);

  useEffect(() => {
    // 切页必须停掉上一页：否则点过试听后翻页，旧音频会继续播放，看起来像"这一页在放"。
    ++audioGeneration.current;
    setClip("");
    return () => {
      ++audioGeneration.current;
    };
  }, [pageNo]);

  useEffect(() => {
    if (pageNo === null) return;
    let dropped = false;
    let createdImageUrl = "";
    let createdPdfUrl = "";
    setPageImage("");
    setPagePdf("");

    const loadPagePdf = async () => {
      setImageFailed(true);
      setPdfLoading(true);
      try {
        const blob = await fileBlob(
          narrationApi.pagePdf(courseId, materialId, pageNo),
        );
        if (dropped) return;
        if (blob.type === "application/pdf") {
          createdPdfUrl = URL.createObjectURL(blob);
          setPagePdf(createdPdfUrl);
        }
      } catch {
        // Non-PDF or unavailable preview; fall back to slide text.
      } finally {
        if (!dropped) setPdfLoading(false);
      }
    };

    void (async () => {
      if (usePdfModeRef.current) {
        await loadPagePdf();
        return;
      }
      setImageFailed(false);
      setPdfLoading(false);
      try {
        const blob = await fileBlob(
          narrationApi.pageImage(courseId, materialId, pageNo),
        );
        if (dropped) return;
        createdImageUrl = URL.createObjectURL(blob);
        setPageImage(createdImageUrl);
      } catch {
        if (dropped) return;
        usePdfModeRef.current = true;
        await loadPagePdf();
      }
    })();

    return () => {
      dropped = true;
      if (createdImageUrl) URL.revokeObjectURL(createdImageUrl);
      if (createdPdfUrl) URL.revokeObjectURL(createdPdfUrl);
    };
  }, [courseId, materialId, pageNo]);

  useEffect(
    () => () => {
      if (clip) URL.revokeObjectURL(clip);
    },
    [clip],
  );

  return {
    clip,
    setClip,
    imageFailed,
    setImageFailed,
    pageImage,
    setPageImage,
    pagePdf,
    pdfLoading,
    audioGeneration,
  };
}
