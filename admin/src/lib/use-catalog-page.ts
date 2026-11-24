import { useEffect, useState } from "react";
import { scoped } from "./api";
import { useResource } from "./use-resource";

type CatalogPage<T> = { items: T[]; page: number; total: number };

export function useCatalogPage<T>(path: string, courseId: number, query: string,
  filters: Record<string, string>, enabled = true) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [search, setSearch] = useState(query);
  useEffect(() => {
    const timeout = setTimeout(() => setSearch(query), 200);
    return () => clearTimeout(timeout);
  }, [query]);
  const params = new URLSearchParams({ page: String(page), size: String(size), search: search.trim() });
  for (const [key, value] of Object.entries(filters)) {
    if (value !== "all") params.set(key, value);
  }
  const resource = useResource<CatalogPage<T>>(enabled && search === query
    ? scoped(`${path}?${params}`, courseId) : null);
  return {
    ...resource,
    rows: resource.data?.items ?? [],
    loading: resource.loading || search !== query,
    firstPage: () => setPage(1),
    pager: {
      page: resource.data?.page ?? page, size, total: resource.data?.total ?? 0,
      onPage: setPage, onSize: (next: number) => { setSize(next); setPage(1); },
    },
  };
}
