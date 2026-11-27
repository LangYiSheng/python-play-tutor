import { Toast } from "@base-ui/react/toast";
import type { ReactNode } from "react";
import { CircleCheck, Info, LoaderCircle, OctagonX, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "cn";

export interface ToastProgressData {
  progress?: number | "indeterminate";
}

const toast = Toast.createToastManager<ToastProgressData>();
const icons = {
  success: CircleCheck,
  info: Info,
  error: OctagonX,
  warning: TriangleAlert,
  loading: LoaderCircle,
};

function ToastList() {
  const { toasts } = Toast.useToastManager<ToastProgressData>();
  return toasts.map((item) => {
    const Icon = icons[item.type as keyof typeof icons];
    const isLoading = item.type === "loading";
    const numericProgress = typeof item.data?.progress === "number" ? item.data.progress : null;
    const showIndeterminate = isLoading && numericProgress === null;

    return <Toast.Root key={item.id} toast={item} role="group" aria-modal={undefined} data-slot="toast" className={cn(
      "pointer-events-auto absolute right-0 bottom-0 z-[calc(1000-var(--toast-index))] w-full origin-bottom rounded-2xl border bg-popover text-popover-foreground shadow-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
      "[--gap:0.75rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] [--peek:0.75rem] [--scale:calc(max(0,1-(var(--toast-index)*0.1)))] [--shrink:calc(1-var(--scale))]",
      "h-(--height) [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_500ms_cubic-bezier(0.22,1,0.36,1),opacity_500ms,height_150ms] motion-reduce:transition-none",
      "after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
      "data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]",
      "data-limited:opacity-0 data-starting-style:opacity-0 data-ending-style:opacity-0",
    )}>
      <Toast.Content className="flex h-full items-start gap-3 overflow-hidden p-4 data-behind:opacity-0 data-expanded:opacity-100">
        {Icon && (
          <Icon
            className={cn(
              "mt-0.5 size-4 shrink-0",
              item.type === "error" && "text-destructive",
              item.type === "success" && "text-(--chart-4)",
              isLoading && "animate-spin text-primary motion-reduce:animate-none",
            )}
            aria-hidden
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Toast.Title className="text-sm font-medium wrap-anywhere" />
          <Toast.Description className="text-xs text-muted-foreground wrap-anywhere" />
          {numericProgress !== null ? (
            <Progress value={numericProgress} className="mt-1.5" aria-label="任务进度" />
          ) : showIndeterminate ? (
            <div
              role="progressbar"
              aria-label="正在处理"
              className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full w-2/5 animate-pulse rounded-full bg-primary/80 motion-reduce:animate-none" />
            </div>
          ) : null}
        </div>
        {!isLoading && (
          <Toast.Close aria-label="关闭提示" render={<Button variant="ghost" size="icon-sm" />}>
            <X aria-hidden />
          </Toast.Close>
        )}
      </Toast.Content>
    </Toast.Root>;
  });
}

function Toaster({ children }: { children: ReactNode }) {
  return <Toast.Provider toastManager={toast}>
    {children}
    <Toast.Portal>
      <Toast.Viewport aria-label="操作通知" className="pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto w-auto max-w-sm outline-none sm:right-4 sm:left-auto sm:mx-0 sm:w-full">
        <ToastList />
      </Toast.Viewport>
    </Toast.Portal>
  </Toast.Provider>;
}

export { Toaster, toast };
