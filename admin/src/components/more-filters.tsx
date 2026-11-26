import { Children, cloneElement, isValidElement, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { ListFilter, X } from "lucide-react";
import { Button } from "./ui/button";
import { SelectField } from "./select-field";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./ui/popover";

export function MoreFilters({ children }: { children: ReactNode }) {
  const fields = Children.toArray(children).filter((field): field is ReactElement<ComponentProps<typeof SelectField>> =>
    isValidElement(field) && field.type === SelectField);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const active = fields.filter(field => field.props.value !== "all");
  return <>
    <Popover open={open} onOpenChange={next => {
      if (next) setDraft(fields.map(field => String(field.props.value)));
      setOpen(next);
    }}>
      <PopoverTrigger render={<Button variant="ghost" type="button"/>}><ListFilter/>更多筛选{active.length ? " (" + active.length + ")" : ""}</PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-4"><PopoverTitle>更多筛选</PopoverTitle>
        {fields.map((field,index) => <label key={field.key} className="grid gap-1">{field.props["aria-label"]}
          {cloneElement(field, { value: draft[index] ?? "all", onValueChange: value => setDraft(values => values.map((item,i) => i === index ? value : item)) })}
        </label>)}
        <div className="flex justify-between border-t pt-3">
          <Button variant="ghost" onClick={() => setDraft(fields.map(() => "all"))}>重置</Button>
          <Button onClick={() => { fields.forEach((field,i) => {
            if (draft[i] !== field.props.value) field.props.onValueChange(draft[i]);
          }); setOpen(false); }}>应用筛选</Button>
        </div>
      </PopoverContent>
    </Popover>
    {active.map(field => {
      const option = Children.toArray(field.props.children).find(child =>
        isValidElement<{value: string}>(child) && String(child.props.value) === String(field.props.value));
      const label = isValidElement<{children: ReactNode}>(option) ? option.props.children : field.props.value;
      return <Button key={field.key} size="sm" variant="secondary" onClick={() => field.props.onValueChange("all")}>
        {field.props["aria-label"]} · {label}<X/></Button>;
    })}
  </>;
}
