export interface ChapterRelease {
  chapter_id: number;
  status: "published" | "paused";
  opens_at: string | null;
}

export function chapterReleaseState(release: ChapterRelease | undefined) {
  if (!release) return "unpublished";
  if (release.status === "paused") return "paused";
  if (release.opens_at && Date.parse(release.opens_at) > Date.now()) return "scheduled";
  return "published";
}
