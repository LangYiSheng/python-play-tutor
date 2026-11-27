import type { ReactNode } from "react";
import { cn } from "cn";
import { Skeleton } from "./ui/skeleton";

function StatusRegion({
  className,
  embedded = false,
  label = "正在加载…",
  children,
}: {
  className?: string;
  embedded?: boolean;
  label?: string;
  children: ReactNode;
}) {
  if (embedded) {
    return <div className={className}>{children}</div>;
  }
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export function PanelSkeleton({
  rows = 3,
  className,
  embedded,
}: {
  rows?: number;
  className?: string;
  embedded?: boolean;
}) {
  const widths = ["w-3/5", "w-4/5", "w-2/3", "w-3/4", "w-1/2"];
  return (
    <StatusRegion embedded={embedded} className={cn("space-y-3 py-5 px-4", className)}>
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-7 w-20 rounded-lg" />
      </div>
      <div className="space-y-2.5 pt-1">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className={cn("h-3.5", widths[i % widths.length])} />
        ))}
      </div>
    </StatusRegion>
  );
}

export function AppShellSkeleton() {
  return (
    <StatusRegion className="course-hub">
      <div className="hub-header">
        <div className="flex items-center gap-3">
          <Skeleton className="size-9.5 rounded-[10px]" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <Skeleton className="h-8 w-28 rounded-lg" />
        </div>
      </div>
      <div className="flex gap-4 border-b pb-2.5">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-24" />
      </div>
      <div className="hub-grid">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="surface hub-card">
            <div className="hub-card-head">
              <Skeleton className="h-6 w-3/5" />
              <Skeleton className="size-7 rounded-md" />
            </div>
            <Skeleton className="h-3.5 w-2/5" />
            <div className="hub-card-footer">
              <Skeleton className="h-8 w-24 rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </StatusRegion>
  );
}

export function HubCardsSkeleton({
  count = 2,
  inline = false,
}: {
  count?: number;
  inline?: boolean;
}) {
  const cards = Array.from({ length: count }, (_, i) => (
    <div key={i} className="surface hub-card" aria-hidden="true">
      <div className="hub-card-head">
        <Skeleton className="h-6 w-3/5" />
        <Skeleton className="size-7 rounded-md" />
      </div>
      <Skeleton className="h-3.5 w-1/2" />
      <Skeleton className="h-3 w-2/3" />
      <div className="hub-card-footer">
        <Skeleton className="h-8 w-24 rounded-lg" />
      </div>
    </div>
  ));
  if (inline) {
    return (
      <>
        <span role="status" aria-busy="true" className="sr-only">
          正在加载…
        </span>
        {cards}
      </>
    );
  }
  return <StatusRegion className="hub-grid">{cards}</StatusRegion>;
}

export function TableSkeleton({
  rows = 5,
  framed = true,
  className,
  embedded,
}: {
  rows?: number;
  framed?: boolean;
  className?: string;
  embedded?: boolean;
}) {
  const primaryWidths = ["w-40", "w-52", "w-36", "w-48", "w-44", "w-32"];
  const secondaryWidths = ["w-28", "w-36", "w-24", "w-32", "w-28", "w-20"];
  return (
    <StatusRegion
      embedded={embedded}
      className={cn(
        framed && "overflow-hidden rounded-[9px] border bg-background",
        className,
      )}
    >
      <div className="flex items-center gap-4 border-b bg-muted/30 px-4 py-3">
        <Skeleton className="h-3.5 w-28" />
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="hidden h-3.5 w-20 sm:block" />
        <Skeleton className="ml-auto h-3.5 w-14" />
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className={cn("h-4 max-w-full", primaryWidths[i % primaryWidths.length])} />
              <Skeleton className={cn("h-3 max-w-full", secondaryWidths[i % secondaryWidths.length])} />
            </div>
            <Skeleton className="hidden h-5 w-16 rounded-full sm:block" />
            <Skeleton className="hidden h-3.5 w-24 md:block" />
            <div className="flex shrink-0 items-center gap-1.5">
              <Skeleton className="h-7 w-16 rounded-lg" />
              <Skeleton className="size-7 rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </StatusRegion>
  );
}

export function MetricsRowSkeleton({
  count = 4,
  embedded,
}: {
  count?: number;
  embedded?: boolean;
}) {
  return (
    <StatusRegion
      embedded={embedded}
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-lg border bg-background p-3.5 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-4 w-12 rounded-full" />
          </div>
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-2 w-full rounded-full" />
        </div>
      ))}
    </StatusRegion>
  );
}

export function DashboardSkeleton({ withHeader = true }: { withHeader?: boolean }) {
  return (
    <StatusRegion className="space-y-4">
      {withHeader && (
        <div className="flex flex-wrap items-center justify-between gap-4 pb-1">
          <div className="space-y-2">
            <Skeleton className="h-7 w-44" />
            <Skeleton className="h-3.5 w-64 max-w-full" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-24 rounded-lg" />
            <Skeleton className="h-8 w-16 rounded-lg" />
          </div>
        </div>
      )}
      <MetricsRowSkeleton embedded />
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-7 rounded-xl border bg-background p-4 space-y-4">
          <div className="space-y-1.5 border-b pb-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-3.5 w-64 max-w-full" />
          </div>
          <div className="space-y-3 pt-1">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="flex justify-between">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3.5 w-16" />
                </div>
                <Skeleton className="h-2.5 w-full rounded-full" />
              </div>
            ))}
          </div>
        </div>
        <div className="lg:col-span-5 rounded-xl border bg-background p-4 space-y-3">
          <div className="space-y-1.5 border-b pb-3">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-3.5 w-52 max-w-full" />
          </div>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="rounded-lg border p-3 space-y-2">
              <div className="flex justify-between gap-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-6 w-16 rounded-md" />
              </div>
              <Skeleton className="h-2 w-full rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </StatusRegion>
  );
}

export function SettingsSkeleton() {
  return (
    <StatusRegion className="space-y-4">
      <div className="rounded-[9px] border bg-background">
        <div className="flex items-center justify-between border-b px-4.5 py-3.5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-7 w-28 rounded-lg" />
        </div>
        <div className="grid gap-5 p-4.5 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-8 w-full rounded-lg" />
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between rounded-[9px] border bg-background px-4.5 py-3.5">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="size-4 rounded" />
      </div>
    </StatusRegion>
  );
}

export function WorkspaceSkeleton() {
  return (
    <StatusRegion className="flex flex-1 min-h-[420px] flex-col gap-3 lg:flex-row">
      <div className="surface flex flex-col gap-2.5 p-3 lg:w-56 shrink-0">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3.5 w-16" />
          <Skeleton className="h-6 w-12 rounded-md" />
        </div>
        <div className="flex gap-1.5">
          <Skeleton className="h-7 flex-1 rounded-md" />
          <Skeleton className="h-7 flex-1 rounded-md" />
        </div>
        <Skeleton className="h-8 w-full rounded-lg" />
        <div className="space-y-2 pt-1">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="rounded-md border p-2 space-y-1.5">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      </div>
      <div className="surface flex-1 space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3.5">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-6 rounded-md" />
            <Skeleton className="h-6 w-44" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-8 w-24 rounded-lg" />
            <Skeleton className="h-8 w-28 rounded-lg" />
          </div>
        </div>
        <TableSkeleton rows={4} framed={false} embedded />
      </div>
    </StatusRegion>
  );
}

export function GraphSkeleton() {
  return (
    <StatusRegion className="flex flex-1 min-h-[420px] w-full flex-col items-center justify-center gap-5 p-8">
      <div className="flex items-center gap-6">
        <Skeleton className="h-10 w-32 rounded-full" />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-4">
        <Skeleton className="h-8 w-28 rounded-full" />
        <Skeleton className="h-8 w-32 rounded-full" />
        <Skeleton className="h-8 w-28 rounded-full" />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-6 w-24 rounded-full" />
        ))}
      </div>
    </StatusRegion>
  );
}

export function GuideSkeleton() {
  return (
    <StatusRegion className="mx-auto flex max-w-lg flex-col items-center gap-4 py-8 px-4 text-center">
      <div className="flex items-center gap-2">
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className={cn("h-2 rounded-full", i === 0 ? "w-7" : "w-2")} />
        ))}
      </div>
      <Skeleton className="my-2 h-36 w-64 max-w-full rounded-2xl" />
      <Skeleton className="h-5 w-20 rounded-full" />
      <Skeleton className="h-7 w-56 max-w-full" />
      <div className="w-full space-y-2">
        <Skeleton className="mx-auto h-3.5 w-4/5" />
        <Skeleton className="mx-auto h-3.5 w-3/5" />
      </div>
      <Skeleton className="h-9 w-48 rounded-xl" />
      <div className="flex gap-2.5 pt-1">
        <Skeleton className="h-8 w-28 rounded-lg" />
        <Skeleton className="h-8 w-24 rounded-lg" />
      </div>
    </StatusRegion>
  );
}

export function DialogSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <StatusRegion className="space-y-3 py-2">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="rounded-lg bg-muted/50 p-2.5 space-y-1.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-12" />
          </div>
        ))}
      </div>
      <div className="space-y-2 pt-1">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className={cn("h-9 w-full rounded-lg")} />
        ))}
      </div>
    </StatusRegion>
  );
}
