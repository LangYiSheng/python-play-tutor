import { memo, useEffect, useMemo, useRef } from "react";
import { Background, Handle, Position, ReactFlow, useReactFlow, type Edge, type Node, type NodeProps, type Viewport } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AudioLines, BookOpen, CircleAlert, CircleOff, FileText, FolderOpen, GitBranch, LoaderCircle, NotebookText, Scan, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Card, graphLayout } from "./graph-layout";
import { taskFailed } from "./task-presentation";

export const nodeIcons = { course: BookOpen, chapter: FolderOpen, material: FileText, point: GitBranch,
  narration: NotebookText, audio: AudioLines, task: LoaderCircle };
type CourseNode = Node<{ card: Card; active: boolean }, "content">;
const CardView = memo(function CardView({ data }: NodeProps<CourseNode>) {
  const { card, active } = data;
  const failed = card.task && taskFailed(card.task);
  const cancelled = card.task?.status === "cancelled";
  const Icon = failed ? CircleAlert : cancelled ? CircleOff : nodeIcons[card.kind];
  const taskClass = card.task ? " cg-task-" + (failed ? "error" : card.task.status || "running") : "";
  return <div title={[card.title, card.caption].filter(Boolean).join(" · ")} className={"cg-node cg-" + card.kind + taskClass + (active ? " cg-selected" : "") + (card.draft ? " cg-draft" : "")}>
    {[Position.Left, Position.Right].map(pos => <span key={pos}>
      <Handle type="target" position={pos} id={"in-" + pos} isConnectable={false}/>
      <Handle type="source" position={pos} id={"out-" + pos} isConnectable={false}/>
    </span>)}
    <Icon size={16} aria-hidden="true"/><div><strong>{card.title}</strong>{card.caption && <small>{card.caption}</small>}</div>
  </div>;
});
const nodeTypes = { content: CardView };

function canvasInsets(canvas: HTMLDivElement) {
  const box = canvas.getBoundingClientRect();
  const frame = canvas.closest(".cg-workspace");
  function overlay(selector: string) {
    const rect = frame?.querySelector(selector)?.getBoundingClientRect();
    if (rect && rect.width && rect.height && rect.bottom > box.top && rect.top < box.bottom &&
        rect.right > box.left && rect.left < box.right) return rect;
    return undefined;
  }
  const header = overlay(".cg-overlay-header");
  const inspector = overlay(".cg-inspector");
  const controls = overlay(".cg-map-tools");
  const margin = 14;
  const top = header ? header.bottom - box.top + margin : margin;
  let bottom = controls ? box.bottom - controls.top + margin : margin;
  let right = margin;
  if (inspector) {
    // Use the larger unobscured rectangle: left of the desktop inspector, above the mobile sheet.
    const leftWidth = Math.max(0, inspector.left - box.left);
    const topHeight = Math.max(0, inspector.top - box.top - top);
    if (leftWidth * (box.height - top - bottom) > topHeight * box.width) {
      right = box.right - inspector.left + margin;
    } else {
      bottom = Math.max(bottom, box.bottom - inspector.top + margin);
    }
  }
  return { left: margin, right, top, bottom, width: box.width, height: box.height };
}

export function GraphCanvas({ layout, selected, focus, onSelect, initialViewport, onMove, onOverview }: {
  layout: ReturnType<typeof graphLayout>; selected: string; focus: { key: string; seq: number } | null;
  onSelect: (card: Card) => void; initialViewport?: Viewport; onMove: (v: Viewport) => void; onOverview: () => void;
}) {
  const flow = useReactFlow<CourseNode>();
  const canvas = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const initial = useRef(initialViewport);
  const handled = useRef(-1);
  const nodes = useMemo<CourseNode[]>(() => layout.cards.map(card => ({
    id: card.key, type: "content", position: { x: card.x - 96, y: card.y - 25 },
    width: 192, height: 50, data: { card, active: selected === card.key },
    ariaLabel: card.title + (card.caption ? "，" + card.caption : ""), ariaRole: "button",
  })), [layout, selected]);
  const edges = useMemo<Edge[]>(() => {
    const byId = new Map(layout.cards.map(card => [card.key, card]));
    return layout.links.flatMap(link => {
      const a = byId.get(link.from), b = byId.get(link.to);
      if (!a || !b) return [];
      const right = a.x < b.x;
      const highlight = selected === a.key || selected === b.key;
      return [{ id: a.key + "/" + b.key, source: a.key, target: b.key,
        sourceHandle: "out-" + (right ? "right" : "left"), targetHandle: "in-" + (right ? "left" : "right"),
        animated: link.active, selectable: false, style: { stroke: link.failed ? "#b43633" : highlight ? "#46785c" : "#abc0b1",
          strokeWidth: highlight ? 2 : 1.35 } }];
    });
  }, [layout, selected]);
  useEffect(() => {
    if (!flow.viewportInitialized || !nodes.length) return;
    const frame = requestAnimationFrame(() => {
      if (!canvas.current) return;
      const { left, right, top, bottom, width, height } = canvasInsets(canvas.current);
      const fit = (duration: number) => flow.fitView({ duration, maxZoom: 1.12, minZoom: .05,
        padding: { left: `${left}px`, right: `${right}px`, top: `${top}px`, bottom: `${bottom}px` } });
      if (!initialized.current) {
        initialized.current = true;
        if (initial.current) void flow.setViewport(initial.current);
        else void fit(0);
      } else if (focus && handled.current !== focus.seq) {
        if (focus.key === "overview") {
          handled.current = focus.seq;
          void fit(220);
          return;
        }
        const card = layout.cards.find(c => c.key === focus.key);
        if (!card) return;
        handled.current = focus.seq;
        const availableWidth = Math.max(1, width - left - right);
        const availableHeight = Math.max(1, height - top - bottom);
        const zoom = Math.min(Math.max(.84, flow.getZoom()), 1.15, availableWidth / 192, availableHeight / 50);
        const extra = card.kind === "material" ? Math.min(76, Math.max(0, availableWidth / (2 * zoom) - 96)) : 0;
        void flow.setViewport({ x: left + availableWidth / 2 - (card.x + card.side * extra) * zoom,
          y: top + availableHeight / 2 - card.y * zoom, zoom }, { duration: 240 });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [flow, nodes, layout, focus]);
  return <div ref={canvas} className="cg-canvas">
    <ReactFlow<CourseNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      onNodeClick={(_, n) => onSelect(n.data.card)}
      onMoveEnd={(_, view) => onMove(view)} nodesDraggable={false} nodesConnectable={false}
      edgesFocusable={false} edgesReconnectable={false} deleteKeyCode={null} minZoom={.05} maxZoom={2.2}
      ariaLabelConfig={{"node.a11yDescription.default":"按回车查看节点详情。"}}
      onKeyDown={e => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const target = (e.target as HTMLElement).closest<HTMLElement>(".react-flow__node");
        const card = layout.cards.find(c => c.key === target?.dataset.id);
        if (card) { e.preventDefault(); onSelect(card); }
      }}>
      <Background gap={20} size={1} color="#c9d6cd"/>
    </ReactFlow>
    <div className="cg-map-tools">
      <Button variant="ghost" size="icon-sm" aria-label="放大图谱" onClick={() => void flow.zoomIn()}><ZoomIn/></Button>
      <Button variant="ghost" size="icon-sm" aria-label="缩小图谱" onClick={() => void flow.zoomOut()}><ZoomOut/></Button>
      <Button variant="ghost" size="sm" onClick={onOverview}><Scan/>课程全貌</Button>
    </div>
  </div>;
}
