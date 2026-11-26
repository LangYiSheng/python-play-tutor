import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NarrationWorkbench } from "./workbench";

export function NarrationReview({
  classroomId,
  materialId,
  title,
  initialPage,
  onClose,
}: {
  classroomId: number;
  materialId: number;
  title: string;
  initialPage?: number;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-6xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>课程生成 · {title}</DialogTitle>
          <DialogDescription>
            一键完成原文整理、整册校准、讲解稿与知识点抽取；草稿需要老师逐页接受才会出现在学生端。
          </DialogDescription>
        </DialogHeader>
        <NarrationWorkbench
          classroomId={classroomId}
          materialId={materialId}
          title={title}
          initialPage={initialPage}
          mode="full"
        />
      </DialogContent>
    </Dialog>
  );
}
