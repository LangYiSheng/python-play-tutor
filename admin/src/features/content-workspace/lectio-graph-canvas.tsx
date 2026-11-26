import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pageRanges } from "./graph-layout";
import {
  computeGraphLayout,
  edgePath,
  NODE_RADIUS,
  treeLabelAttrs,
  type GNode,
  type GraphVisualMode,
} from "./lectio-graph-layout";

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function LectioGraphCanvas({
  root,
  mode,
  selectedId,
  onSelect,
}: {
  root: GNode | null;
  mode: GraphVisualMode;
  selectedId: string;
  onSelect: (node: GNode) => void;
}) {
  const layout = useMemo(() => computeGraphLayout(root, mode), [root, mode]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; bx: number; by: number; moved: boolean } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const [hoveredId, setHoveredId] = useState("");
  const [box, setBox] = useState<ViewBox>({ x: -200, y: -150, w: 800, h: 500 });

  const userInteractedRef = useRef(false);

  const fit = useCallback((resetInteraction = true) => {
    if (!layout.width || !layout.height) return;
    if (resetInteraction) userInteractedRef.current = false;
    const el = svgRef.current;
    const aspect = el && el.clientHeight > 0 ? el.clientWidth / el.clientHeight : 1.6;
    let w = layout.width;
    let h = layout.height;
    if (w / h < aspect) w = h * aspect;
    else h = w / aspect;
    setBox({
      x: layout.minX - (w - layout.width) / 2,
      y: layout.minY - (h - layout.height) / 2,
      w,
      h,
    });
  }, [layout.width, layout.height, layout.minX, layout.minY]);

  useEffect(() => {
    userInteractedRef.current = false;
    const id = requestAnimationFrame(() => fit(true));
    return () => cancelAnimationFrame(id);
  }, [fit]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const obs = new ResizeObserver(() => {
      if (!userInteractedRef.current) fit(false);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [fit]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handleWheel = (event: WheelEvent) => {
      if (!layout.width) return;
      event.preventDefault();
      userInteractedRef.current = true;
      const rect = el.getBoundingClientRect();
      const fx = (event.clientX - rect.left) / Math.max(1, rect.width);
      const fy = (event.clientY - rect.top) / Math.max(1, rect.height);
      const factor = Math.exp(Math.sign(event.deltaY) * 0.12);
      setBox((prev) => {
        const w = Math.min(Math.max(prev.w * factor, 120), layout.width * 4 || 4000);
        const h = (w / prev.w) * prev.h;
        return {
          x: prev.x + (prev.w - w) * fx,
          y: prev.y + (prev.h - h) * fy,
          w,
          h,
        };
      });
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [layout.width]);

  useEffect(() => {
    const endDrag = () => {
      setGrabbing(false);
      window.setTimeout(() => {
        dragRef.current = null;
      }, 0);
    };
    window.addEventListener("pointerup", endDrag);
    return () => window.removeEventListener("pointerup", endDrag);
  }, []);

  const zoomBy = (factor: number) => {
    if (!layout.width) return;
    userInteractedRef.current = true;
    setBox((prev) => {
      const w = Math.min(Math.max(prev.w * factor, 120), layout.width * 4 || 4000);
      const h = (w / prev.w) * prev.h;
      return {
        x: prev.x + (prev.w - w) * 0.5,
        y: prev.y + (prev.h - h) * 0.5,
        w,
        h,
      };
    });
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    userInteractedRef.current = true;
    dragRef.current = { x: event.clientX, y: event.clientY, bx: box.x, by: box.y, moved: false };
    setGrabbing(true);
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    const el = svgRef.current;
    if (!drag || !el || el.clientWidth <= 0) return;
    const scale = box.w / el.clientWidth;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    setBox((prev) => ({
      ...prev,
      x: drag.bx - dx * scale,
      y: drag.by - dy * scale,
    }));
  };

  const focusIds = useMemo(() => {
    const out = new Set<string>();
    const addAncestors = (start: GNode | null) => {
      let cur = start;
      while (cur) {
        out.add(cur.id);
        cur = cur.parent;
      }
    };
    const sel = layout.nodes.find((n) => n.id === selectedId) ?? null;
    const hov = layout.nodes.find((n) => n.id === hoveredId) ?? null;
    if (sel) addAncestors(sel);
    if (hov) {
      addAncestors(hov);
      const addSub = (cur: GNode) => {
        out.add(cur.id);
        for (const c of cur.children) addSub(c);
      };
      addSub(hov);
    }
    return out;
  }, [layout.nodes, selectedId, hoveredId]);

  const hasFocus = Boolean(selectedId || hoveredId);

  return (
    <div className="lg-canvas-wrap">
      <svg
        ref={svgRef}
        className={`lg-svg view-${mode}${grabbing ? " grabbing" : ""}`}
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        role="img"
        aria-label="PPT 知识点图谱画布"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
      >
        <defs>
          <filter id="lg-pill-shadow" x="-15%" y="-25%" width="130%" height="160%">
            <feDropShadow dx="0" dy="2" stdDeviation="2.4" floodColor="#0f172a" floodOpacity="0.09" />
          </filter>
        </defs>

        {mode === "radial" && (
          <g className="lg-orbits" aria-hidden="true">
            <circle cx={0} cy={0} r={(layout.orbits[1] ?? 120) * 0.72} className="lg-orbit-glow" />
            {layout.orbits.slice(1).map((r, idx) => (
              <circle key={idx} cx={0} cy={0} r={r} className="lg-orbit-ring" />
            ))}
          </g>
        )}

        <g className={`lg-edges${hasFocus ? " dimmed" : ""}`}>
          {layout.nodes
            .filter((n) => n.parent)
            .map((n) => (
              <path
                key={`e-${n.id}`}
                d={edgePath(n, mode)}
                style={{ "--edge-color": n.color } as CSSProperties}
                className={`${focusIds.has(n.id) ? "hot " : ""}to-${n.kind}`}
              />
            ))}
        </g>

        {layout.nodes.map((n) => {
          const isSelected = n.id === selectedId;
          const isPath = focusIds.has(n.id);
          const isDim = hasFocus && !isPath;
          const isEmpty = n.kind === "point" && n.pages.length === 0;
          const cls = `lg-node lg-k-${n.kind}${isSelected ? " on" : ""}${isPath ? " path" : ""}${isDim ? " dim" : ""}${isEmpty ? " empty" : ""}`;
          const tip = [
            n.full,
            n.pages.length ? `第 ${pageRanges(n.pages)} 页` : n.kind === "point" ? "暂无页码标记" : "",
            n.brief,
          ]
            .filter(Boolean)
            .join("\n");

          return (
            <g
              key={n.id}
              className={cls}
              style={{ "--node-color": n.color } as CSSProperties}
              onPointerEnter={() => setHoveredId(n.id)}
              onPointerLeave={() => setHoveredId((prev) => (prev === n.id ? "" : prev))}
              onClick={(e) => {
                e.stopPropagation();
                if (dragRef.current?.moved) return;
                onSelect(n);
              }}
            >
              <title>{tip}</title>
              {mode === "radial" ? (
                n.depth === 0 ? (
                  <>
                    <rect
                      className="lg-hub-aura"
                      x={n.x - n.pw / 2 - 6}
                      y={n.y - n.ph / 2 - 6}
                      width={n.pw + 12}
                      height={n.ph + 12}
                      rx={(n.ph + 12) / 2}
                    />
                    <rect
                      className="lg-hub-pill"
                      filter="url(#lg-pill-shadow)"
                      x={n.x - n.pw / 2}
                      y={n.y - n.ph / 2}
                      width={n.pw}
                      height={n.ph}
                      rx={n.ph / 2}
                    />
                    <text className="lg-hub-text" x={n.x} y={n.y} dy="0.35em" textAnchor="middle">
                      {n.shortLabel}
                    </text>
                  </>
                ) : n.children.length > 0 ? (
                  <>
                    {isSelected && (
                      <rect
                        className="lg-pill-halo"
                        x={n.x - n.pw / 2 - 4}
                        y={n.y - n.ph / 2 - 4}
                        width={n.pw + 8}
                        height={n.ph + 8}
                        rx={(n.ph + 8) / 2}
                      />
                    )}
                    <rect
                      className="lg-card-pill"
                      filter="url(#lg-pill-shadow)"
                      x={n.x - n.pw / 2}
                      y={n.y - n.ph / 2}
                      width={n.pw}
                      height={n.ph}
                      rx={n.ph / 2}
                    />
                    <circle className="lg-pill-gem" cx={n.x - n.pw / 2 + 13} cy={n.y} r={n.kind === "chapter" ? 4.8 : 4} />
                    <text className="lg-pill-text" x={n.x - n.pw / 2 + 23} y={n.y} dy="0.35em" textAnchor="start">
                      {n.shortLabel}
                    </text>
                  </>
                ) : (
                  <g transform={`translate(${n.x} ${n.y}) rotate(${n.rot})`}>
                    {isSelected && <circle className="lg-halo" cx={0} cy={0} r={9.5} />}
                    <rect
                      className="lg-leaf-pill"
                      x={n.flip ? -7 - n.pw : 7}
                      y={-10.5}
                      width={n.pw}
                      height={21}
                      rx={7}
                    />
                    <circle className="lg-dot" cx={0} cy={0} r={4.2} />
                    <text
                      className="lg-leaf-text"
                      x={n.flip ? -15 : 15}
                      y={0}
                      dy="0.35em"
                      textAnchor={n.flip ? "end" : "start"}
                    >
                      {n.shortLabel}
                    </text>
                  </g>
                )
              ) : (
                <>
                  {isSelected && <circle className="lg-halo" cx={n.x} cy={n.y} r={NODE_RADIUS[n.kind] + 7} />}
                  <circle className="lg-dot" cx={n.x} cy={n.y} r={NODE_RADIUS[n.kind]} />
                  {(() => {
                    const attr = treeLabelAttrs(n);
                    return (
                      <text x={attr.x} y={attr.y} textAnchor={attr.anchor}>
                        {n.label}
                      </text>
                    );
                  })()}
                </>
              )}
            </g>
          );
        })}
      </svg>

      <div className="lg-legend" aria-hidden="true">
        <span className="lg-leg-item">
          <i className="lg-leg-dot" style={{ background: "#0c7483" }} /> 课程 / 章
        </span>
        <span className="lg-leg-item">
          <i className="lg-leg-dot" style={{ background: "var(--card)", border: "2px solid #0c7483" }} /> 节
        </span>
        <span className="lg-leg-item">
          <i className="lg-leg-dot" style={{ background: "#cfe8ec", border: "1.5px solid #0c7483" }} /> 知识点
        </span>
        <span className="lg-leg-item">
          <i className="lg-leg-dot" style={{ background: "var(--background)", border: "1.5px dashed var(--muted-foreground)" }} /> 未标页
        </span>
      </div>

      <div className="lg-zoom" role="group" aria-label="视图缩放">
        <Button size="icon-xs" variant="ghost" aria-label="放大" title="放大" onClick={() => zoomBy(0.82)}>
          <Plus />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="缩小" title="缩小" onClick={() => zoomBy(1.22)}>
          <Minus />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="适应窗口" title="适应窗口" onClick={() => fit(true)}>
          <Maximize2 />
        </Button>
      </div>
    </div>
  );
}
