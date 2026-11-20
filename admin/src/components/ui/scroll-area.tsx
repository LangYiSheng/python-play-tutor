import { ScrollArea as Primitive } from "@base-ui/react/scroll-area";
import type { ReactNode } from "react";
import { cn } from "cn";

export function ScrollArea({ children, label, className }: {
  children: ReactNode; label: string; className?: string;
}) {
  return (
    <Primitive.Root className={cn("relative min-h-0 min-w-0 rounded-md border", className)}>
      <Primitive.Viewport role="region" aria-label={label}
        className="size-full rounded-[inherit] focus-visible:outline-2 focus-visible:outline-ring">
        {children}
      </Primitive.Viewport>
      <Primitive.Scrollbar className="absolute inset-y-1 right-0 flex w-3 touch-none justify-center px-1 opacity-0 transition-opacity data-hovering:opacity-100 data-scrolling:opacity-100">
        <Primitive.Thumb className="w-full rounded-full bg-muted-foreground/45" />
      </Primitive.Scrollbar>
    </Primitive.Root>
  );
}
