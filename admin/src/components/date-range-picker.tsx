import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { zhCN } from "react-day-picker/locale";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isoToLocalDateTime } from "@/lib/time";

function dayKey(day?: Date) {
  if (!day) return "";
  return [day.getFullYear(), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0")].join("-");
}
const presets = [["今天", 0, 0], ["昨天", 1, 1], ["最近7天", 6, 0], ["最近30天", 29, 0]] as const;

export function DateRangePicker({ start, end, change }: {
  start: string; end: string; change: (start: string, end: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const from = start ? new Date(start + "T12:00:00") : undefined;
  const to = end ? new Date(end + "T12:00:00") : undefined;
  const today = new Date(isoToLocalDateTime(new Date().toISOString()).slice(0, 10) + "T12:00:00");
  const calendar = { locale: zhCN, defaultMonth: from ?? today, today, showOutsideDays: false };
  function daysAgo(days: number) {
    const date = new Date(today);
    date.setDate(date.getDate() - days);
    return dayKey(date);
  }
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button type="button" variant="outline" className="w-full justify-start" />}>
      <CalendarDays />{start ? (start === end ? start : start + " 至 " + (end || "…")) : "选择日期"}
    </PopoverTrigger>
    <PopoverContent align="start" collisionPadding={8} aria-label="日期范围日历" className="range-calendar">
      <Calendar {...calendar} mode="range" numberOfMonths={2} resetOnSelect
        selected={from ? { from, to } : undefined}
        onSelect={range => { change(dayKey(range?.from), dayKey(range?.to)); if (range?.to) setOpen(false); }} />
      <div className="flex flex-wrap gap-1 border-t pt-2">{presets.map(([label, first, last]) =>
        <Button key={label} type="button" size="sm" variant="ghost" onClick={() => {
          change(daysAgo(first), daysAgo(last)); setOpen(false);
        }}>{label}</Button>)}</div>
    </PopoverContent>
  </Popover>;
}
