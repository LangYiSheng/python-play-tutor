import { useState, type ReactNode } from "react";
import { DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import { Pager } from "./common";

export function PaginatedRows<T>({ rows, children }: {
  rows: readonly T[];
  children: (visible: readonly T[], offset: number) => ReactNode;
}) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(DEFAULT_PAGE_SIZE);
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / size)));
  const offset = (current - 1) * size;
  return <>
    {children(rows.slice(offset, offset + size), offset)}
    <Pager page={current} size={size} total={rows.length} onPage={setPage}
      onSize={next => { setSize(next); setPage(1); }} />
  </>;
}
