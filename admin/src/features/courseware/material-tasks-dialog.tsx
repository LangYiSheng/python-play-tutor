import { Empty, ErrorNotice } from "@/components/common";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TaskQueue, type TaskCommand } from "@/features/content-workspace/task-queue";
import type { TaskSnapshot } from "@/features/content-workspace/task-presentation";
import "@/features/content-workspace/inspector-content.css";
import type { Material } from "@/lib/types";

export function MaterialTasksDialog({
  open,
  onOpenChange,
  jobs,
  error,
  materials,
  onSelectMaterial,
  request,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobs: TaskSnapshot[];
  error?: string;
  materials: Material[];
  onSelectMaterial: (materialId: number) => void;
  request: (command: TaskCommand) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>课件制作任务（梳理与语音合成）</DialogTitle>
          <DialogDescription>
            查看本班课件的文本梳理、口播生成与语音合成任务进度；失败任务可在此重试或移除。
          </DialogDescription>
        </DialogHeader>
        {error && <ErrorNotice message={error} />}
        {jobs.length === 0 ? (
          <Empty title="当前没有进行中或失败的课件制作任务" />
        ) : (
          <TaskQueue
            jobs={jobs}
            titleOf={(id) => materials.find((m) => m.id === id)?.title ?? "课件"}
            onSelect={(job) => {
              onSelectMaterial(job.material_id);
              onOpenChange(false);
            }}
            request={request}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
