import { useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError, errorMessage, token } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import type { CourseInstance } from "@/lib/types";
import { useResource } from "@/lib/use-resource";

const countLabels = {
  classrooms: "教学班",
  students: "受影响学生",
  reading_records: "阅读记录",
  submissions: "作答记录",
  assessment_attempts: "测验记录",
  chapters: "章节",
  materials: "学习资料",
  knowledge_points: "知识点",
  questions: "题目",
  activities: "练习与测验",
  exam_drafts: "组卷草稿",
} as const;
type CourseDeletionPreview = {
  name: string;
  revision: number;
  confirmation: string;
  can_delete: boolean;
  blocked_reason: string | null;
  counts: Partial<Record<keyof typeof countLabels, number>>;
};

export function CourseDeleteDialog({course, onClose, onDeleted}: {
  course: CourseInstance; onClose: () => void; onDeleted: () => void;
}) {
  const path = `/teacher/courses/${course.id}`;
  const {data: preview, loading, error: previewError, reload} = useResource<CourseDeletionPreview>(`${path}/deletion-preview`);
  const [confirmation, setConfirmation] = useState("");
  const [outdatedPreview, setOutdatedPreview] = useState<CourseDeletionPreview | null>(null);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  useDraft(busy);
  const outdated = Boolean(preview && preview === outdatedPreview);
  const canDelete = Boolean(preview?.can_delete && !loading && !stale && !outdated && !previewError && confirmation === preview.name);

  function refresh() {
    setOutdatedPreview(preview);
    setConfirmation("");
    setError("");
    setStale(false);
    reload();
  }

  async function remove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview || !canDelete || busy) return;
    const captured = token();
    setError("");
    setBusy(true);
    try {
      const confirmationQuery = new URLSearchParams({
        expected_revision: String(preview.revision),
        confirmation: preview.confirmation,
      });
      await api.delete(`${path}?${confirmationQuery}`);
      if (token() === captured) onDeleted();
    } catch (reason) {
      setError(errorMessage(reason));
      if (reason instanceof ApiError && reason.status === 409) setStale(true);
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle className="break-words">删除课程 · {preview?.name ?? course.name}</DialogTitle>
        <DialogDescription>请核对课程内容及其关联教学班。</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={remove}>
        <ErrorNotice message={error || previewError}/>
        {loading && <Loading/>}
        {preview && <dl aria-label="课程删除影响" className="grid grid-cols-2 gap-3 rounded-lg bg-muted p-3 text-sm sm:grid-cols-3">
          {(Object.keys(countLabels) as (keyof typeof countLabels)[]).filter(key => preview.counts[key] !== undefined).map(key => <div key={key}>
            <dt className="text-muted-foreground">{countLabels[key]}</dt>
            <dd className="font-semibold tabular-nums">{preview.counts[key]}</dd>
          </div>)}
        </dl>}
        {preview && (preview.can_delete ? <>
          <p className="text-sm text-destructive">
            {preview.counts.classrooms
              ? "本课程及其所有关联教学班、教学内容、班级名册、阅读进度、作答、成绩、答疑记录和小镇存档将永久删除。"
              : "删除后，本课程及其教学内容将永久移除。"}
          </p>
          <div className="field">
            <Label htmlFor="course-delete-name">输入课程全名确认</Label>
            <Input id="course-delete-name" autoComplete="off" maxLength={200} value={confirmation}
              onChange={event => setConfirmation(event.target.value)} disabled={busy || stale || outdated || Boolean(previewError)} required/>
          </div>
        </> : <p className="text-sm text-destructive">{preview.blocked_reason ?? "此课程暂不可删除。"}</p>)}
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose} disabled={busy}>取消</Button>
          {(previewError || stale) && <Button variant="outline" type="button" onClick={refresh}>重新预览</Button>}
          {preview?.can_delete && <Button variant="destructive" type="submit" disabled={!canDelete || busy}>
            <Trash2/>{busy ? "正在删除…" : "确认删除课程"}
          </Button>}
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
