import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { Loading } from "@/components/common";
import { SettingsGroup } from "@/components/settings-layout";
import {
  AppShellSkeleton,
  DashboardSkeleton,
  DialogSkeleton,
  GraphSkeleton,
  GuideSkeleton,
  HubCardsSkeleton,
  MetricsRowSkeleton,
  SettingsSkeleton,
  TableSkeleton,
  WorkspaceSkeleton,
} from "@/components/skeletons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SlidePageRail } from "@/features/materials/narration/slide-page-rail";

it("renders shadcn Skeleton with reduced-motion safeguard and accessible status regions", () => {
  const { unmount } = render(<Skeleton data-testid="raw-skeleton" className="h-6 w-32" />);
  const raw = screen.getByTestId("raw-skeleton");
  expect(raw).toHaveAttribute("data-slot", "skeleton");
  expect(raw.className).toContain("motion-reduce:animate-none");
  expect(raw.className).toContain("h-6");
  unmount();

  const presets = [
    <Loading key="loading" />,
    <AppShellSkeleton key="shell" />,
    <TableSkeleton key="table" rows={3} />,
    <DashboardSkeleton key="dashboard" />,
    <SettingsSkeleton key="settings" />,
    <WorkspaceSkeleton key="workspace" />,
    <GraphSkeleton key="graph" />,
    <GuideSkeleton key="guide" />,
    <DialogSkeleton key="dialog" rows={2} />,
    <MetricsRowSkeleton key="metrics" count={4} />,
  ];

  for (const element of presets) {
    const view = render(element);
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveAttribute("aria-busy", "true");
    expect(view.container.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThan(0);
    view.unmount();
  }
});

it("handles boundary row counts and inline/embedded skeleton modes without duplicate status roles", () => {
  const { container, unmount } = render(
    <div role="status" aria-busy="true">
      <TableSkeleton rows={0} embedded />
      <MetricsRowSkeleton count={0} embedded />
    </div>,
  );
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(container.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThan(0);
  unmount();

  const hub = render(
    <div className="hub-grid">
      <HubCardsSkeleton count={2} inline />
    </div>,
  );
  expect(screen.getByRole("status")).toHaveTextContent("正在加载");
  expect(hub.container.querySelectorAll(".hub-card")).toHaveLength(2);
});

it("toggles Collapsible and respects forceOpen on SettingsGroup", async () => {
  const user = userEvent.setup();
  const { unmount } = render(
    <Collapsible>
      <CollapsibleTrigger>展开详情</CollapsibleTrigger>
      <CollapsibleContent>
        <p>折叠面板正文</p>
      </CollapsibleContent>
    </Collapsible>,
  );

  const trigger = screen.getByRole("button", { name: "展开详情" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("折叠面板正文")).toBeNull();

  await user.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("折叠面板正文")).toBeVisible();
  expect(
    screen.getByText("折叠面板正文").closest("[data-slot='collapsible-content']"),
  ).not.toBeNull();

  await user.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("折叠面板正文")).toBeNull();
  unmount();

  function ForcedDemo() {
    const [force, setForce] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setForce(false)}>
          解除强制展开
        </button>
        <SettingsGroup title="高级参数" collapsible forceOpen={force}>
          <label>
            最大并发
            <input type="number" defaultValue={4} />
          </label>
        </SettingsGroup>
      </>
    );
  }

  render(<ForcedDemo />);
  const groupToggle = screen.getByRole("button", { name: "高级参数" });
  expect(groupToggle.closest(".settings-group")).toHaveAttribute("data-collapsible", "true");
  expect(groupToggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("spinbutton", { name: "最大并发" })).toBeVisible();

  await user.click(screen.getByRole("button", { name: "解除强制展开" }));
  expect(groupToggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("spinbutton", { name: "最大并发" })).toBeNull();
});

it("keeps exit fill-mode-forwards and matched durations on Dialog and Sheet overlays", () => {
  const { unmount } = render(
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>示例弹窗</DialogTitle>
          <DialogDescription>验证退出动画不会在卸载前闪回不透明背景</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>,
  );
  const dialogOverlay = document.querySelector("[data-slot='dialog-overlay']")!;
  const dialogContent = document.querySelector("[data-slot='dialog-content']")!;
  expect(dialogOverlay.className).toContain("data-closed:fill-mode-forwards");
  expect(dialogContent.className).toContain("data-closed:fill-mode-forwards");
  expect(dialogOverlay.className).toContain("data-closed:duration-140");
  expect(dialogContent.className).toContain("data-closed:duration-140");
  unmount();

  const sheetView = render(
    <Sheet open>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>示例抽屉</SheetTitle>
          <SheetDescription>验证抽屉遮罩同步退出</SheetDescription>
        </SheetHeader>
      </SheetContent>
    </Sheet>,
  );
  const sheetOverlay = document.querySelector("[data-slot='sheet-overlay']")!;
  const sheetContent = document.querySelector("[data-slot='sheet-content']")!;
  expect(sheetOverlay.className).toContain("data-closed:fill-mode-forwards");
  expect(sheetContent.className).toContain("data-closed:fill-mode-forwards");
  expect(sheetOverlay.className).toContain("data-closed:duration-170");
  expect(sheetContent.className).toContain("data-closed:duration-170");
  sheetView.unmount();
});

it("collapses and expands SlidePageRail knowledge groups via Collapsible", async () => {
  const user = userEvent.setup();
  const pages = [
    { page_no: 1, title: "封面", text: "", narration: "", status: "accepted" },
    { page_no: 2, title: "变量定义", text: "", narration: "", status: "draft" },
  ] as never[];
  render(
    <SlidePageRail
      pages={pages}
      pageNo={1}
      onSelectPage={() => {}}
      pointsByPage={new Map()}
      groups={[
        {
          key: "kp-1",
          kind: "knowledge",
          section: "1.1 基础语法",
          title: "变量与赋值",
          point: null,
          pages,
          firstPageNo: 1,
        },
      ]}
      hasKnowledgeGroups
      railMode="knowledge"
      onRailModeChange={() => {}}
      fullHeight={false}
    />,
  );

  const groupBtn = screen.getByRole("button", { name: /变量与赋值/ });
  expect(groupBtn).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: /第 1 页/ })).toBeVisible();

  await user.click(groupBtn);
  expect(groupBtn).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: /第 1 页/ })).toBeNull();
});

it("renders sliding TabsIndicator and switches TabsContent cleanly", async () => {
  const user = userEvent.setup();
  const { container } = render(
    <Tabs defaultValue="first">
      <TabsList variant="line" aria-label="示例页签">
        <TabsTrigger value="first">第一页</TabsTrigger>
        <TabsTrigger value="second">第二页</TabsTrigger>
      </TabsList>
      <TabsContent value="first">内容一</TabsContent>
      <TabsContent value="second">内容二</TabsContent>
    </Tabs>,
  );

  const indicator = container.querySelector("[data-slot='tabs-indicator']");
  expect(indicator).not.toBeNull();
  expect(screen.getByText("内容一")).toHaveClass("tab-panel-enter");
  expect(screen.queryByText("内容二")).toBeNull();

  await user.click(screen.getByRole("tab", { name: "第二页" }));
  expect(screen.getByText("内容二")).toBeVisible();
  expect(screen.queryByText("内容一")).toBeNull();
});
