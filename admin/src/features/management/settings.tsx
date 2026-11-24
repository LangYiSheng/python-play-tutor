import { useState } from "react";
import { Bot, FileAudio, Volume2 } from "lucide-react";
import { AssistantModelSettings } from "@/components/assistant-model-settings";
import { PageHeader } from "@/components/common";
import { ServiceSettings } from "@/components/service-settings";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function GlobalSettings() {
  const [service, setService] = useState("student");
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);
  const actions = (key: string) => ({ active: service === key, actionsTarget });
  return <>
    <PageHeader title="全站设置" description="配置学生助教、讲稿生成与语音合成服务。"><div ref={setActionsTarget} /></PageHeader>
    <Tabs value={service} onValueChange={value => setService(String(value))}>
      <TabsList aria-label="智能体服务"><TabsTrigger value="student"><Bot />学生助教</TabsTrigger>
        <TabsTrigger value="authoring"><FileAudio />讲稿生成</TabsTrigger><TabsTrigger value="speech"><Volume2 />语音合成</TabsTrigger></TabsList>
      <TabsContent value="student" keepMounted hidden={service !== "student"}><AssistantModelSettings {...actions("student")} /></TabsContent>
      <TabsContent value="authoring" keepMounted hidden={service !== "authoring"}><ServiceSettings service="authoring" {...actions("authoring")} /></TabsContent>
      <TabsContent value="speech" keepMounted hidden={service !== "speech"}><ServiceSettings service="speech" {...actions("speech")} /></TabsContent>
    </Tabs>
  </>;
}
