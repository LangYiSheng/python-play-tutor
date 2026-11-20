import { useEffect } from "react";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MaterialDialog } from "@/features/materials/editor-dialog";
import { MaterialViewer } from "@/features/materials/material-viewer";
import { NarrationPlayer } from "@/features/materials/narration/player";
import { NarrationReview } from "@/features/materials/narration/review";
import type { MaterialPreview } from "@/features/materials/types";
import { useMaterialEditor } from "@/features/materials/use-editor";
import { QuestionDialog } from "@/features/questions/editor-dialog";
import { useQuestionEditor } from "@/features/questions/use-editor";
import { scoped } from "@/lib/api";
import type { Course, Material, Point, Question } from "@/lib/types";
import { useResource } from "@/lib/use-resource";
import { CurriculumDialog } from "./curriculum-dialog";

export type ContentAction = {
  kind: "chapter" | "point" | "material" | "question";
  mode: "create" | "edit" | "preview" | "narration" | "audio";
  id?: number | string;
  chapterId?: number;
  pageNo?: number;
};
type Props = { classroomId: number; action: ContentAction; onClose: (saved: boolean) => void };

function Pending({ error, onClose }: { error?: string; onClose: () => void }) {
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent><DialogHeader><DialogTitle>打开课程内容</DialogTitle></DialogHeader>
      {error ? <ErrorNotice message={error} /> : <Loading />}
      <DialogFooter><Button variant="outline" onClick={onClose}>关闭</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function StructureAction({ classroomId, action, onClose }: Props) {
  const course = useResource<Course>(scoped("/teacher/courses?view=chapters", classroomId));
  const point = useResource<Point>(action.kind === "point" && action.mode === "edit"
    ? scoped("/teacher/knowledge-points/" + action.id, classroomId) : null);
  if (!course.data || point.loading) return <Pending error={course.error || point.error} onClose={() => onClose(false)} />;
  const item = action.kind === "chapter" ? course.data.chapters.find(row => row.id === Number(action.id)) : point.data;
  if (!item && action.mode === "edit") return <Pending error={point.error || "当前班级中找不到这条内容。"} onClose={() => onClose(false)} />;
  return <CurriculumDialog classroomId={classroomId} tab={action.kind === "chapter" ? "chapters" : "points"}
    chapters={course.data.chapters} editing={item ?? null} chapterId={action.chapterId} onClose={onClose} />;
}

function MaterialAction({ classroomId, action, onClose }: Props) {
  const material = useResource<Material & MaterialPreview>(action.mode !== "create"
    ? scoped("/teacher/materials/" + action.id, classroomId) : null);
  const editing = action.mode === "edit" || action.mode === "create";
  const course = useResource<Course>(editing ? scoped("/teacher/courses?view=chapters", classroomId) : null);
  const editor = useMaterialEditor(classroomId, () => onClose(true));
  useEffect(() => {
    if (editing && (material.data || action.mode === "create")) {
      editor.edit(material.data);
      if (action.mode === "create" && action.chapterId) editor.setChapterIds([action.chapterId]);
    }
  }, [action.mode, action.chapterId, editing, material.data]);
  if ((editing && !course.data) || (!material.data && action.mode !== "create")) {
    return <Pending error={course.error || material.error} onClose={() => onClose(false)} />;
  }
  if (editing) return <MaterialDialog editor={{ ...editor, setOpen: value => {
    if (value === false) onClose(false); else editor.setOpen(value);
  } }} course={course} />;
  if (!material.data) return null;
  const row = material.data;
  if (action.mode === "preview") return <MaterialViewer material={row} onClose={() => onClose(false)} />;
  if (action.mode === "audio") return <NarrationPlayer classroomId={classroomId} materialId={row.id} title={row.title} onClose={() => onClose(false)} />;
  return <NarrationReview classroomId={classroomId} materialId={row.id} title={row.title} initialPage={action.pageNo} onClose={() => onClose(true)} />;
}

function QuestionAction({ classroomId, action, onClose }: Props) {
  const row = useResource<Question>(action.mode === "edit"
    ? scoped("/teacher/questions/" + encodeURIComponent(String(action.id)), classroomId) : null);
  const course = useResource<Course>(scoped("/teacher/courses?view=chapters", classroomId));
  const materials = useResource<Material[]>(scoped("/teacher/materials", classroomId));
  const editor = useQuestionEditor(classroomId, () => onClose(true));
  useEffect(() => {
    if (row.data || action.mode === "create") editor.edit(row.data);
  }, [row.data, action.mode]);
  if ((action.mode === "edit" && !row.data) || !course.data || !materials.data) {
    return <Pending error={row.error || course.error || materials.error} onClose={() => onClose(false)} />;
  }
  return <QuestionDialog editor={{ ...editor, setOpen: value => {
    if (value === false) onClose(false); else editor.setOpen(value);
  } }} classroomId={classroomId} course={course} materials={materials} />;
}

export function ContentActionDialog(props: Props) {
  const { action, classroomId } = props;
  const Action = action.kind === "material" ? MaterialAction : action.kind === "question" ? QuestionAction : StructureAction;
  return <Action key={[classroomId, action.kind, action.mode, action.id, action.chapterId].join(":")} {...props} />;
}
