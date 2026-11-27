import * as React from "react";
import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { cn } from "cn";

function Progress({
  className,
  value = 0,
  indicatorClassName,
  ...props
}: ProgressPrimitive.Root.Props & {
  indicatorClassName?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Number(value ?? 0)));
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={clamped}
      className={cn("relative w-full", className)}
      {...props}
    >
      <ProgressPrimitive.Track
        data-slot="progress-track"
        className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn(
            "h-full rounded-full bg-primary transition-all duration-300 motion-reduce:transition-none",
            indicatorClassName,
          )}
          style={{ width: `${clamped}%` }}
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

interface Segment {
  key: string;
  label: string;
  value: number;
  colorClassName: string;
}

function SegmentedProgress({
  total,
  segments,
  className,
  "aria-label": ariaLabel,
}: {
  total: number;
  segments: Segment[];
  className?: string;
  "aria-label"?: string;
}) {
  const safeTotal = Math.max(total, 0);
  return (
    <div
      data-slot="segmented-progress"
      role="img"
      aria-label={
        ariaLabel ??
        segments.map((s) => `${s.label} ${s.value}`).join("，")
      }
      className={cn(
        "flex h-2 w-full overflow-hidden rounded-full bg-muted",
        className,
      )}
    >
      {safeTotal > 0 &&
        segments.map((seg) => {
          if (seg.value <= 0) return null;
          const pct = Math.min(100, (seg.value / safeTotal) * 100);
          return (
            <div
              key={seg.key}
              className={cn(
                "h-full transition-all duration-300 motion-reduce:transition-none",
                seg.colorClassName,
              )}
              style={{ width: `${pct}%` }}
            />
          );
        })}
    </div>
  );
}

export { Progress, SegmentedProgress };
