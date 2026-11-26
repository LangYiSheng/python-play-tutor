import { Empty as EmptyRoot, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "./ui/empty";
import { SelectField } from "@/components/select-field";
import { AlertCircle, ChevronLeft, ChevronRight, Inbox, LoaderCircle, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export function ErrorNotice({ message }: { message: string }) {
  return message ? (
    <div role="alert" className="notice-error">
      <AlertCircle size={17} />
      <span>{message}</span>
    </div>
  ) : null;
}
export function Loading() {
  return (
    <div role="status" className="empty">
      <LoaderCircle className="animate-spin" size={20} />
      正在加载…
    </div>
  );
}
export function Empty({
  title,
  description,
  children,
  icon,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <EmptyRoot>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon ?? <Inbox aria-hidden />}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </EmptyRoot>
  );
}
export function ListEmpty({ title, filtered, reset, action, description, filteredTitle = "没有匹配的结果" }: {
  title: string; filtered: boolean; reset: () => void; filteredTitle?: string; action?: React.ReactNode; description?: string;
}) {
  return <Empty title={filtered ? filteredTitle : title} description={filtered ? "调整搜索词或筛选条件后再试。" : description}>
    {filtered ? <Button type="button" size="sm" variant="ghost" onClick={reset}>重置筛选</Button> : action}
  </Empty>;
}
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}
export function TableSearch({ label, placeholder, value, onValueChange }: {
  label: string;
  placeholder?: string;
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <div className="search">
      <Search size={16} aria-hidden="true" />
      <Input
        aria-label={label}
        placeholder={placeholder ?? label}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      />
    </div>
  );
}
export function Pager({
  page,
  size,
  total,
  onPage,
  onSize,
}: {
  page: number;
  size: number;
  total: number;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages === 1 && page === 1) return null;
  return (
    <div className="pager">
      <span>第 {(page - 1) * size + 1}–{Math.min(page * size, total)} 条，共 {total} 条</span>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          每页{" "}
          <SelectField
            aria-label="每页条数"
            value={size}
            onValueChange={(value) => onSize(Number(value))}
          >
            {[10, 25, 50, 100].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </SelectField>{" "}
          条
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="上一页" disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft />
        </Button>
        <span>
          {page} / {pages}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="下一页" disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
