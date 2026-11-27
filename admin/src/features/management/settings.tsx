import { useMemo, useState } from "react";
import { Bot, FileAudio, UsersRound, Volume2, type LucideIcon } from "lucide-react";
import { PlatformRoles } from "./platform-roles";
import { AssistantModelSettings } from "@/components/assistant-model-settings";
import { ServiceSettings } from "@/components/service-settings";
import type { SettingsStatus, SettingsStatusReporter } from "@/components/settings-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type SectionKey = "student" | "authoring" | "speech" | "roles";
const sections: { key: SectionKey; label: string; icon: LucideIcon }[] = [
  { key: "student", label: "学生助教", icon: Bot },
  { key: "authoring", label: "讲稿生成", icon: FileAudio },
  { key: "speech", label: "语音合成", icon: Volume2 },
  { key: "roles", label: "教学角色", icon: UsersRound },
];

export function GlobalSettings() {
  const [service, setService] = useState<SectionKey>("student");
  const [statuses, setStatuses] = useState<Partial<Record<SectionKey, SettingsStatus>>>({});
  const reporters = useMemo(() => Object.fromEntries(sections.map(({ key }) => [key, (next: SettingsStatus) => setStatuses(current => {
    const previous = current[key];
    return previous && previous.text === next.text && previous.tone === next.tone && previous.dirty === next.dirty ? current : { ...current, [key]: next };
  })])) as Record<SectionKey, SettingsStatusReporter>, []);
  const props = (key: SectionKey) => ({ active: service === key, onStatus: reporters[key] });
  const panel = (key: SectionKey) => {
    switch (key) {
      case "student": return <AssistantModelSettings {...props("student")} />;
      case "authoring": return <ServiceSettings service="authoring" {...props("authoring")} />;
      case "speech": return <ServiceSettings service="speech" {...props("speech")} />;
      case "roles": return <PlatformRoles />;
    }
  };
  return <Tabs className="settings-layout" orientation="vertical" value={service} onValueChange={value => setService(value as SectionKey)}>
    <nav className="settings-nav-wrap" aria-label="设置分类">
      <TabsList variant="default" className="settings-nav" aria-label="全站设置分类">
        {sections.map(({ key, label, icon: Icon }) => {
          const status = statuses[key];
          return <TabsTrigger key={key} value={key} className="settings-nav-item" aria-describedby={`settings-status-${key}`}>
            <Icon aria-hidden="true" />
            <span className="settings-nav-label">{label}</span>
            <span id={`settings-status-${key}`} className="settings-nav-status" aria-hidden="true" data-tone={status?.tone} data-dirty={status?.dirty ? "true" : undefined}>
              {status ? (status.dirty ? "未保存" : status.text) : ""}
            </span>
          </TabsTrigger>;
        })}
      </TabsList>
    </nav>
    {sections.map(({ key }) => <TabsContent key={key} value={key} keepMounted={key !== "roles"} hidden={service !== key}>
      {(key !== "roles" || service === key) && panel(key)}
    </TabsContent>)}
  </Tabs>;
}
