import * as React from "react";
import { cn } from "cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type ChartConfig = Record<
  string,
  {
    label: string;
    color: string;
  }
>;

function ChartContainer({
  config,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
}) {
  const style = Object.fromEntries(
    Object.entries(config).map(([key, item]) => [`--color-${key}`, item.color]),
  ) as React.CSSProperties;

  return (
    <div
      data-slot="chart"
      style={style}
      className={cn("flex w-full flex-col gap-3 text-xs", className)}
      {...props}
    >
      {children}
    </div>
  );
}

function ChartLegend({
  config,
  className,
}: {
  config: ChartConfig;
  className?: string;
}) {
  return (
    <div
      data-slot="chart-legend"
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground", className)}
    >
      {Object.entries(config).map(([key, item]) => (
        <span key={key} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-[3px]"
            style={{ backgroundColor: item.color }}
          />
          <span>{item.label}</span>
        </span>
      ))}
    </div>
  );
}

export interface GroupedBarCell {
  key: string;
  value: number | null;
  detail: string;
  mutedLabel?: string;
}

export interface GroupedBarRow {
  id: string | number;
  label: string;
  sublabel?: string;
  badge?: string;
  cells: GroupedBarCell[];
}

function GroupedBarChart({
  config,
  rows,
  className,
}: {
  config: ChartConfig;
  rows: GroupedBarRow[];
  className?: string;
}) {
  return (
    <ChartContainer config={config} className={className}>
      <ChartLegend config={config} />
      <div className="space-y-3">
        {rows.map((row) => (
          <div
            key={row.id}
            className="rounded-lg border border-border/70 bg-muted/20 px-3.5 py-3"
          >
            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="font-medium text-foreground">{row.label}</span>
                {row.sublabel && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {row.sublabel}
                  </span>
                )}
              </div>
              {row.badge && (
                <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {row.badge}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {row.cells.map((cell) => {
                const meta = config[cell.key];
                const pct =
                  cell.value == null ? 0 : Math.max(0, Math.min(100, cell.value));
                return (
                  <Tooltip key={cell.key}>
                    <TooltipTrigger
                      render={
                        <div
                          tabIndex={0}
                          className="group/bar flex flex-col gap-1.5 rounded-md bg-background/80 p-2 ring-1 ring-border/60 transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring outline-none"
                        />
                      }
                    >
                      <div className="flex items-baseline justify-between gap-1">
                        <span className="truncate text-[11px] text-muted-foreground">
                          {meta?.label ?? cell.key}
                        </span>
                        <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
                          {cell.value == null
                            ? (cell.mutedLabel ?? "—")
                            : `${Math.round(pct)}%`}
                        </span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        {cell.value != null && pct > 0 && (
                          <div
                            className="h-full rounded-full transition-all duration-300 motion-reduce:transition-none"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: `var(--color-${cell.key})`,
                            }}
                          />
                        )}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="font-medium">{meta?.label ?? cell.key}</p>
                      <p className="mt-0.5 text-muted-foreground">{cell.detail}</p>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </ChartContainer>
  );
}

export interface DistributionBin {
  key: string;
  label: string;
  count: number;
  color: string;
  detail?: string;
}

function DistributionBarChart({
  bins,
  total,
  className,
}: {
  bins: DistributionBin[];
  total: number;
  className?: string;
}) {
  const maxCount = Math.max(1, ...bins.map((b) => b.count));
  const config: ChartConfig = Object.fromEntries(
    bins.map((b) => [b.key, { label: b.label, color: b.color }]),
  );

  return (
    <ChartContainer config={config} className={className}>
      <div
        role="list"
        aria-label="成绩分数段分布"
        className="grid h-44 grid-cols-6 items-end gap-2.5 pt-5"
      >
        {bins.map((bin) => {
          const heightPct = bin.count > 0 ? Math.max(8, (bin.count / maxCount) * 100) : 0;
          const sharePct = total > 0 ? Math.round((bin.count / total) * 100) : 0;
          return (
            <Tooltip key={bin.key}>
              <TooltipTrigger
                render={
                  <div
                    role="listitem"
                    tabIndex={0}
                    aria-label={`${bin.label}：${bin.count} 人`}
                    className="group flex h-full flex-col items-center justify-end gap-1.5 rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
                  {bin.count}
                </span>
                <div className="flex h-28 w-full max-w-12 items-end overflow-hidden rounded-t-md bg-muted/60">
                  <div
                    className="w-full rounded-t-md transition-all duration-300 group-hover:opacity-85 motion-reduce:transition-none"
                    style={{
                      height: `${heightPct}%`,
                      backgroundColor: bin.color,
                    }}
                  />
                </div>
                <span className="text-center text-[11px] leading-tight text-muted-foreground">
                  {bin.label}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">
                  {bin.label}：{bin.count} 人（{sharePct}%）
                </p>
                {bin.detail && (
                  <p className="mt-0.5 text-muted-foreground">{bin.detail}</p>
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </ChartContainer>
  );
}

export {
  ChartContainer,
  ChartLegend,
  GroupedBarChart,
  DistributionBarChart,
};
