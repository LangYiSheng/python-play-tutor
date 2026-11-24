import { Toast } from "@base-ui/react/toast";
import type { ReactNode } from "react";
import { CircleCheck, Info, OctagonX, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "cn";

const toast = Toast.createToastManager();
const icons = { success: CircleCheck, info: Info, error: OctagonX, warning: TriangleAlert };

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((item) => {
    const Icon = icons[item.type as keyof typeof icons];
    return <Toast.Root key={item.id} toast={item} role="group" aria-modal={undefined} data-slot="toast" className={cn(
      "pointer-events-auto absolute right-0 bottom-0 z-[calc(1000-var(--toast-index))] w-full origin-bottom rounded-2xl border bg-popover text-popover-foreground shadow-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
      "[--gap:0.75rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] [--peek:0.75rem] [--scale:calc(max(0,1-(var(--toast-index)*0.1)))] [--shrink:calc(1-var(--scale))]",
      "h-(--height) [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_500ms_cubic-bezier(0.22,1,0.36,1),opacity_500ms,height_150ms] motion-reduce:transition-none",
      "after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
      "data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]",
      "data-limited:opacity-0 data-starting-style:opacity-0 data-ending-style:opacity-0",
    )}>
      <Toast.Content className="flex h-full items-center gap-3 overflow-hidden p-4 data-behind:opacity-0 data-expanded:opacity-100">
        {Icon && <Icon className={cn("size-4 shrink-0", item.type === "error" && "text-destructive")} aria-hidden />}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Toast.Title className="text-sm font-medium wrap-anywhere" />
          <Toast.Description className="text-sm text-muted-foreground wrap-anywhere" />
        </div>
        <Toast.Close aria-label="关闭提示" render={<Button variant="ghost" size="icon-sm" />}><X aria-hidden /></Toast.Close>
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
