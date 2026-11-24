import { useEffect, useState } from "react";
import { PageHeader } from "@/components/common";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Questions } from "@/features/questions/questions-page";
import { statuses } from "@/features/questions/types";
import { Materials } from "@/features/materials/materials-page";
import { Curriculum } from "@/pages/curriculum";

const tabs = { chapters: "章节", materials: "资料", points: "知识点", questions: "题目" } as const;
type Tab = keyof typeof tabs;

function readLocation() {
  const params = new URLSearchParams(location.search);
  const tab = params.get("tab") ?? "chapters";
  const point = Number(params.get("point"));
  const status = params.get("status") ?? "all";
  return {
    tab: Object.hasOwn(tabs, tab) ? tab as Tab : "chapters" as Tab,
    point: Number.isSafeInteger(point) && point > 0 ? String(point) : undefined,
    status: status === "draft" && params.get("reviewable") === "true"
      ? "reviewable" : Object.hasOwn(statuses, status) ? status : "all",
  };
}

export function ContentListPage({ courseId }: { courseId: number }) {
  const [view, setView] = useState(readLocation);
  useEffect(() => {
    const sync = () => setView(readLocation());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  function show(tab: Tab) {
    const params = new URLSearchParams({ tab, course: String(courseId) });
    history.pushState({}, "", "/teacher/content-list?" + params);
    setView(readLocation());
  }
  function updateFilters(update: (params: URLSearchParams) => void) {
    const url = new URL(location.href);
    update(url.searchParams);
    history.replaceState(history.state, "", url);
    setView(readLocation());
  }
  function setQuestionStatus(status: string) {
    updateFilters(params => {
      if (status === "all") params.delete("status");
      else params.set("status", status === "reviewable" ? "draft" : status);
      if (status === "reviewable") params.set("reviewable", "true");
      else params.delete("reviewable");
    });
  }
  return <>
    <PageHeader title="内容列表" />
    <Tabs value={view.tab} onValueChange={value => show(value as Tab)} className="gap-4">
      <TabsList variant="line" aria-label="课程内容类型">
        {Object.entries(tabs).map(([id, title]) => <TabsTrigger key={id} value={id}>{title}</TabsTrigger>)}
      </TabsList>
      <TabsContent key={view.tab} value={view.tab}>
        {view.tab === "questions" ? <Questions key={view.point ?? "all"} courseId={courseId} pointId={view.point}
          status={view.status} onStatusChange={setQuestionStatus}
          clearPoint={() => updateFilters(params => { params.delete("point"); params.delete("pointName"); })} />
          : view.tab === "materials" ? <Materials courseId={courseId} />
          : <Curriculum tab={view.tab} courseId={courseId} />}
      </TabsContent>
    </Tabs>
  </>;
}
