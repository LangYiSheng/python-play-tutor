import { useState, type ReactNode } from "react";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { api, errorMessage, scoped } from "@/lib/api";
import type { Activity } from "@/lib/types";

function ActivityRow({ item, disabled, sortable, children }: {
  item: Activity; disabled: boolean; sortable: boolean; children: ReactNode;
}) {
  const drag = useSortable({id: item.id, disabled: disabled || !sortable});
  return <li ref={drag.setNodeRef} style={{transform: CSS.Transform.toString(drag.transform), transition: drag.transition}}
    className={drag.isDragging ? "relative z-10 bg-accent" : undefined}>
    {sortable && <Button ref={drag.setActivatorNodeRef} {...drag.attributes} {...drag.listeners}
      type="button" size="icon-sm" variant="ghost" className="touch-none cursor-grab active:cursor-grabbing"
      disabled={disabled} aria-label={`拖动排序：${item.title}`}><GripVertical/></Button>}
    {children}
  </li>;
}

export function SortableActivities({items, courseId, chapterId, reload, renderRow}: {
  items: Activity[]; courseId: number; chapterId: number; reload: () => void; renderRow: (item: Activity) => ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{original: Activity[]; ordered: Activity[]} | null>(null);
  const visible = pending?.original === items ? pending.ordered : items;
  const sensors = useSensors(useSensor(PointerSensor, {activationConstraint: {distance: 5}}),
    useSensor(KeyboardSensor, {coordinateGetter: sortableKeyboardCoordinates}));
  async function reorder({active, over}: DragEndEvent) {
    if (busy || !over || active.id === over.id) return;
    const from = visible.findIndex(item => item.id === active.id);
    const to = visible.findIndex(item => item.id === over.id);
    if (from < 0 || to < 0) return;
    const ordered = arrayMove(visible, from, to);
    setBusy(true);
    setError("");
    setPending({original: items, ordered});
    try {
      await api.put(scoped(`/teacher/chapters/${chapterId}/activities/order`, courseId), {
        previous: visible.map(item => item.id), ordered: ordered.map(item => item.id),
      });
    } catch (e) {
      setPending(null);
      setError(errorMessage(e));
    } finally {
      reload();
      setBusy(false);
    }
  }
  return <>
    <ErrorNotice message={error}/>
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}
      accessibility={{screenReaderInstructions: {draggable: "按空格键拾取活动，上下方向键移动，再按空格键放下，或按 Esc 取消。"}}}>
      <SortableContext items={visible.map(item => item.id)} strategy={verticalListSortingStrategy}>
        <ul className={`activity-rows ${visible.length > 1 ? "sortable" : ""}`}>
          {visible.map(item => <ActivityRow key={item.id} item={item} disabled={busy} sortable={visible.length > 1}>{renderRow(item)}</ActivityRow>)}
        </ul>
      </SortableContext>
    </DndContext>
  </>;
}
