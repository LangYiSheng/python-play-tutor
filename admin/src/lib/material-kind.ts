export function materialKindLabel(kind: string): string {
  const normalized = kind.trim().toLowerCase();
  if (normalized === "presentation") return "PPT";
  if (normalized === "pdf") return "PDF";
  if (normalized === "video") return "视频";
  if (normalized === "markdown" || normalized === "text") return "文本";
  return normalized ? normalized.toUpperCase() : "";
}
