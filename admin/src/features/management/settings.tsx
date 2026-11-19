import { lazy, Suspense, useState } from "react";
import { Bot, FileAudio, ShieldCheck, Volume2 } from "lucide-react";
import { AssistantModelSettings } from "@/components/assistant-model-settings";
import { Loading, PageHeader } from "@/components/common";
import { ServiceSettings } from "@/components/service-settings";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const Judge = lazy(() => import("@/pages/judge").then(module => ({ default: module.Judge })));
const Synthesis = lazy(() => import("@/pages/synthesis").then(module => ({ default: module.Synthesis })));

export function GlobalSettings() {
  const [section, setSection] = useState("agent"), [service, setService] = useState("student");
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);
  const actions = (key: string) => ({ active: section === "agent" && service === key, actionsTarget });
  return <>
    <PageHeader title="全站设置" description="配置教学使用的模型与语音服务，查看全站资料合成和评测任务。"><div ref={setActionsTarget} /></PageHeader>
    <Tabs value={section} onValueChange={value => setSection(String(value))}>
      <TabsList aria-label="全站设置">
        <TabsTrigger value="agent"><Bot />智能体设置</TabsTrigger>
        <TabsTrigger value="synthesis"><FileAudio />资料合成管理</TabsTrigger>
        <TabsTrigger value="judge"><ShieldCheck />评测管理</TabsTrigger>
      </TabsList>
      <TabsContent value="agent" keepMounted hidden={section !== "agent"}>
        <Tabs value={service} onValueChange={value => setService(String(value))}>
          <TabsList aria-label="智能体服务"><TabsTrigger value="student"><Bot />学生助教</TabsTrigger>
            <TabsTrigger value="authoring"><FileAudio />讲稿生成</TabsTrigger><TabsTrigger value="speech"><Volume2 />语音合成</TabsTrigger></TabsList>
          <TabsContent value="student" keepMounted hidden={service !== "student"}><AssistantModelSettings {...actions("student")} /></TabsContent>
          <TabsContent value="authoring" keepMounted hidden={service !== "authoring"}><ServiceSettings service="authoring" {...actions("authoring")} /></TabsContent>
          <TabsContent value="speech" keepMounted hidden={service !== "speech"}><ServiceSettings service="speech" {...actions("speech")} /></TabsContent>
        </Tabs>
      </TabsContent>
      <TabsContent value="synthesis">{section === "synthesis" && <Suspense fallback={<Loading />}><Synthesis actionsTarget={actionsTarget} /></Suspense>}</TabsContent>
      <TabsContent value="judge">{section === "judge" && <Suspense fallback={<Loading />}><Judge canManage actionsTarget={actionsTarget} /></Suspense>}</TabsContent>
    </Tabs>
  </>;
}
