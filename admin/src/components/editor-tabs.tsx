import type { ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

export function EditorTabs({ pages, initial }: { pages: { label: string; content: ReactNode }[]; initial?: string }) {
  return <Tabs defaultValue={initial ?? pages[0].label}>
    <TabsList aria-label="编辑栏目">{pages.map(page =>
      <TabsTrigger key={page.label} type="button" value={page.label}>{page.label}</TabsTrigger>)}</TabsList>
    {pages.map(page => <TabsContent value={page.label} key={page.label} className="pt-3">{page.content}</TabsContent>)}
  </Tabs>;
}
