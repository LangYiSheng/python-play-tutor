import { useEffect, useState } from "react";
import { PageHeader } from "@/components/common";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Questions } from "@/features/questions/questions-page";
import { Materials } from "@/features/materials/materials-page";
import { Curriculum } from "@/pages/curriculum";

const tabs = { chapters: "章节", materials: "资料", points: "知识点", questions: "题目" } as const;
type Tab = keyof typeof tabs;

function readLocation() {
  const params = new URLSearchParams(location.search);
  const tab = params.get("tab") ?? "chapters";
  const point = Number(params.get("point"));
  return {
    tab: Object.hasOwn(tabs, tab) ? tab as Tab : "chapters" as Tab,
    point: Number.isSafeInteger(point) && point > 0 ? String(point) : undefined,
  };
}

export function ContentListPage({ classroomId }: { classroomId: number }) {
  const [view, setView] = useState(readLocation);
  useEffect(() => {
    const sync = () => setView(readLocation());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  function show(tab: Tab) {
    const params = new URLSearchParams({ tab });
    history.pushState({}, "", "/teacher/content-list?" + params);
    setView(readLocation());
  }
  return <>
    <PageHeader title="内容列表" description="在当前班级课程中查找、添加和编辑教学内容。" />
    <Tabs value={view.tab} onValueChange={value => show(value as Tab)} className="gap-4">
      <TabsList variant="line" aria-label="课程内容类型">
        {Object.entries(tabs).map(([id, title]) => <TabsTrigger key={id} value={id}>{title}</TabsTrigger>)}
      </TabsList>
      <TabsContent key={view.tab} value={view.tab}>
        {view.tab === "questions" ? <Questions key={view.point ?? "all"} classroomId={classroomId} pointId={view.point} clearPoint={() => show("questions")} />
          : view.tab === "materials" ? <Materials classroomId={classroomId} />
          : <Curriculum tab={view.tab} classroomId={classroomId} />}
      </TabsContent>
    </Tabs>
  </>;
}
