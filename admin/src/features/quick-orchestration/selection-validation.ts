import type { CatalogChapter, ChapterSelection } from "./contracts";

export const maxChapters = 64;

export function chapterProblems(selected: ChapterSelection[], catalog: CatalogChapter[]) {
  const chapters = new Map(catalog.map(chapter => [chapter.id, chapter]));
  const problems = new Map<string, string[]>();
  selected.forEach((row, index) => {
    const chapter = chapters.get(row.chapter_id);
    if (!chapter) {
      problems.set(row.chapter_id, [`第 ${index + 1} 个章节已移出本课程，请取消勾选该章。`]);
      return;
    }
    const messages: string[] = [];
    const ready = new Set(chapter.materials.filter(item => item.available).map(item => item.id));
    const points = new Set(chapter.knowledge_points.map(item => item.id));
    const materials = row.material_ids.length;
    const topics = row.knowledge_point_ids.length;
    if (!materials) {
      messages.push(ready.size ? "尚未选择课件，请至少勾选 1 份。" : "本章有 0 份可用课件，请在「管理课件」中关联可阅读的 PPT 或 PDF 后刷新。");
    } else if (materials > 64) {
      messages.push(`已选 ${materials} 份课件，请保留最多 64 份。`);
    }
    const unavailable = row.material_ids.filter(id => !ready.has(id)).length;
    if (unavailable) messages.push(`已选课件中有 ${unavailable} 份已移出本章或暂不可用，请取消勾选并选择可用课件。`);
    if (!topics) {
      messages.push(points.size ? "尚未选择知识点，请至少勾选 1 个。" : "本章有 0 个知识点，请在「管理章节与知识点」中添加后刷新。");
    } else if (topics > 65) {
      messages.push(`已选 ${topics} 个知识点，请保留最多 65 个。`);
    }
    const removed = row.knowledge_point_ids.filter(id => !points.has(id)).length;
    if (removed) messages.push(`已选知识点中有 ${removed} 个已移出本章，请取消勾选并选择本章知识点。`);
    if (messages.length) problems.set(chapter.id, messages);
  });
  return problems;
}
