import { DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import { createPortal } from "react-dom";
import { createContext, useContext, Children, cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Columns3 } from "lucide-react";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./ui/popover";
import { Table, TableBody, TableHeader } from "./ui/table";
import { Pager } from "./common";
import { SelectField } from "./select-field";
import "./management-table.css";

type ColumnPreferences = { hidden: string[]; left: number; right: number };
const Preferences = createContext<Map<string, ColumnPreferences> | null>(null);
export function TablePreferences({ children }: { children: ReactNode }) {
  const [settings] = useState(() => new Map<string, ColumnPreferences>());
  return <Preferences.Provider value={settings}>{children}</Preferences.Provider>;
}
type Child = ReactElement<{ children?: ReactNode; className?: string }>;
function elements(children: ReactNode) {
  return Children.toArray(children).filter((child): child is Child => isValidElement(child));
}
function labelOf(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{children?: ReactNode}>(child)
    ? labelOf(child.props.children) : String(child)).join("");
}

export function ManagementTable({ children, paginate = false, toolsId, columnTools = true, pageSize, ...props }: React.ComponentProps<typeof Table> & { paginate?: boolean; toolsId?: string; columnTools?: boolean; pageSize?: { value: number; total: number; change: (size: number) => void } }) {
  const [host,setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setHost(toolsId ? document.getElementById(toolsId) : null); }, [toolsId]);
  const sections = elements(children);
  const head = sections.find(child => child.type === TableHeader);
  const body = sections.find(child => child.type === TableBody);
  const headers = elements(elements(head?.props.children)[0]?.props.children);
  const rows = elements(body?.props.children);
  const columns = headers.map((header, index) => ({
    id: String(header.key ?? index), label: labelOf(header.props.children) || "选择",
  }));
  const firstData = columns[0]?.label === "选择" ? 1 : 0;
  const action = columns.at(-1)?.label === "操作";
  const settings = useContext(Preferences);
  const view = (toolsId ?? "") + ":" + columns.map(col => col.label).join("|");
  const saved = settings?.get(view);
  const [hidden, setHidden] = useState<string[]>(saved?.hidden ?? []);
  const [left, setLeft] = useState(saved?.left ?? (firstData + 1)), [right, setRight] = useState(saved?.right ?? (action ? 1 : 0));
  useEffect(() => { settings?.set(view, { hidden,left,right }); }, [settings,view,hidden,left,right]);
  const [page, setPage] = useState(1), [size, setSize] = useState(DEFAULT_PAGE_SIZE);
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / size)));
  const visible = columns.map((_, i) => i).filter(i => !hidden.includes(columns[i].id));
  const table = useRef<HTMLTableElement>(null), rail = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ width: 0, widths: [] as number[] });
  const signature = JSON.stringify(visible.map(i => columns[i]));
  useLayoutEffect(() => {
    const el = table.current, viewport = el?.parentElement;
    if (!el || !viewport || !el.tHead || typeof ResizeObserver === "undefined") return;
    const cells = Array.from(el.tHead.rows[0].cells);
    const observer = new ResizeObserver(() => {
      const next = { width: viewport.clientWidth, widths: cells.map(cell => cell.getBoundingClientRect().width) };
      setLayout(old => old.width === next.width && old.widths.join() === next.widths.join() ? old : next);
    });
    observer.observe(viewport); cells.forEach(cell => observer.observe(cell));
    return () => observer.disconnect();
  }, [signature]);
  const widths = layout.widths;
  const total = widths.reduce((a,b) => a+b, 0);
  let leftCount = Math.min(left, visible.length), rightCount = Math.min(right, visible.length-leftCount);
  const sum = (start: number, end: number) => widths.slice(start,end).reduce((a,b) => a+b, 0);
  while (total > layout.width && sum(0,leftCount) + sum(visible.length-rightCount,visible.length) > layout.width-50) {
    if (leftCount > 1) leftCount--;
    else if (rightCount > 0) rightCount--;
    else { leftCount = 0; break; }
  }
  const leading = sum(0,leftCount), trailing = sum(visible.length-rightCount,visible.length);
  const overflow = total > layout.width + 1;
  useEffect(() => {
    const viewport = table.current?.parentElement, track = rail.current;
    if (!viewport || !track) return;
    const fromTable = () => { track.scrollLeft = viewport.scrollLeft; };
    const fromRail = () => { viewport.scrollLeft = track.scrollLeft; };
    fromTable(); viewport.addEventListener("scroll", fromTable); track.addEventListener("scroll", fromRail);
    return () => { viewport.removeEventListener("scroll", fromTable); track.removeEventListener("scroll", fromRail); };
  }, [overflow, leading, trailing, total, layout.width]);
  function renderRow(row: Child) {
    const cells = elements(row.props.children);
    return cloneElement(row, {}, visible.map((i, pos) => {
      const cell = cells[i];
      if (!cell) return null;
      const style = pos < leftCount ? { position: "sticky", left: sum(0,pos) } : pos >= visible.length-rightCount
        ? { position: "sticky", right: sum(pos+1,visible.length) } : {};
      return cloneElement(cell as ReactElement<React.HTMLAttributes<HTMLElement>>, {
        key: columns[i].id, style: style as React.CSSProperties,
        className: [cell.props.className, style.position && "fixed-cell", i === firstData && "identity-cell",
          pos === leftCount - 1 && "left-edge", pos === visible.length-rightCount && "right-edge", action && i === columns.length-1 && "action-cell"].filter(Boolean).join(" "),
      });
    }));
  }
  const pageControl = paginate ? { value: size, total: rows.length, change: (value: number) => { setSize(value); setPage(1); } } : pageSize;
  const menu = <Popover><PopoverTrigger render={<Button type="button" variant="ghost" />}><Columns3/>列设置</PopoverTrigger>
      <PopoverContent align="end" className="max-h-[75vh] overflow-y-auto w-60 p-4"><PopoverTitle>显示列</PopoverTitle>
        {columns.map((col,i) => <label key={col.id} className="flex items-center gap-2"><input type="checkbox" checked={!hidden.includes(col.id)}
          disabled={i <= firstData || (action && i === columns.length-1)} onChange={e => setHidden(e.target.checked ? hidden.filter(id => id !== col.id) : [...hidden,col.id])}/>{col.label}</label>)}
        {pageControl && pageControl.total > 10 && pageControl.total <= pageControl.value && <label className="flex justify-between items-center">
          每页条数<SelectField aria-label="每页条数" value={pageControl.value} onValueChange={value => pageControl.change(Number(value))}>
            {[10,25,50,100].map(n => <option key={n}>{n}</option>)}
          </SelectField></label>}
        {[{label:"左侧冻结",value:left,set:setLeft},{label:"右侧冻结",value:right,set:setRight}].map(side =>
          <label key={side.label} className="flex justify-between items-center">{side.label}<SelectField aria-label={side.label} value={side.value} onValueChange={v => side.set(Number(v))}>
            {[0,1,2].map(n => <option key={n} value={n}>{n} 列</option>)}</SelectField></label>)}
      </PopoverContent></Popover>;
  return <div className="management-list">
    {columnTools && (host ? createPortal(menu,host) : <div className="management-tools">{menu}</div>)}
    <div className="management-frame"><Table {...props} ref={table}><TableHeader>{head && elements(head.props.children).map(renderRow)}</TableHeader>
      <TableBody>{(paginate ? rows.slice((current-1)*size,current*size) : rows).map(renderRow)}</TableBody></Table>
      {overflow && <div ref={rail} className="management-rail" role="region" aria-label="横向滚动未冻结列" tabIndex={0} style={{marginLeft:leading,marginRight:trailing}}>
        <div style={{width:total-leading-trailing,height:1}}/></div>}
    </div>
    {paginate && <Pager page={current} size={size} total={rows.length} onPage={setPage} onSize={v => {setSize(v);setPage(1);}}/>}
  </div>;
}
