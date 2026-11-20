import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type Suggestion = { id: string; name: string };

export function SuggestInput({
  id,
  value,
  onChange,
  options,
  placeholder,
  label,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: Suggestion[];
  placeholder?: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="relative" ref={box}>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="pr-8"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`选择${label}`}
        aria-expanded={open}
        className="absolute right-1 top-1 text-muted-foreground"
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown aria-hidden="true" />
      </Button>
      {open && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
          {options.length === 0 ? (
            <p className="hint px-2 py-1">暂无可选{label}，可直接手填。</p>
          ) : (
            options.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted ${
                  item.id === value ? "bg-primary/5" : ""
                }`}
                onClick={() => {
                  onChange(item.id);
                  setOpen(false);
                }}
              >
                <span>{item.name}</span>
                <span className="hint ml-2">{item.id}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
