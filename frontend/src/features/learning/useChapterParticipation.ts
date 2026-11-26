import {onBeforeUnmount, onMounted, ref, watch, type Ref} from "vue";
import {api} from "../../shared/api";
import {randomUUID} from "../../shared/uuid";
import {useSession} from "../../shared/session";
import type {ChapterTask} from "../../shared/chapterTasks";

export interface ParticipationSample {
  page_id?: number;
  position?: number;
  playing?: boolean;
  playback_rate?: number;
  visible: boolean;
}

export function useChapterParticipation(chapterId: number | undefined, materialId: number | undefined, sample: Ref<ParticipationSample | null>) {
  const session = useSession(), classroom = session.classroomId, owner = session.user?.id;
  const error = ref("");
  const sessionId = randomUUID();
  let sequence = 0, active = true, started = false;
  let last: ParticipationSample | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let retry: (ParticipationSample & {sequence: number; session_id: string}) | undefined;
  let releaseReset: (() => void) | undefined;
  let pending = Promise.resolve(), unregister: (() => void) | undefined;
  const current = () => session.classroomId === classroom && session.user?.id === owner;
  async function send(value: ParticipationSample) {
    if (!current()) return;
    const url = `/chapters/${chapterId}/materials/${materialId}/participation?classroom_id=${classroom}`;
    const submit = async (packet: NonNullable<typeof retry>) => {
      retry = packet;
      const task = await api.post<ChapterTask>(url, packet);
      retry = undefined;
      if (!current()) return;
      const rows = session.taskChapters.find(c => c.id === chapterId)?.tasks;
      const idx = rows?.findIndex(t => t.id === task.id) ?? -1;
      if (rows && idx >= 0) rows[idx] = task;
      error.value = "";
    };
    if (retry) await submit(retry);
    await submit({...value, sequence: ++sequence, session_id: sessionId});
  }
  function record(stop = false) {
    if (!chapterId || !materialId || !current()) return pending;
    const next = sample.value;
    const visible = !stop && !document.hidden && next?.visible === true;
    if (!visible && !started && !retry) return pending;
    const value = visible ? {...next!,visible:true} : {...last, visible:false, ...(last?.position !== undefined ? {position:next?.position ?? last.position,playing:false} : {})};
    last = value;
    started = visible;
    pending = pending.catch(() => undefined).then(() => send(value));
    void pending.catch(e => {if (active && current()) error.value = e instanceof Error ? e.message : "学习进度保存失败";});
    return pending;
  }
  const observe = () => {void record().catch(() => undefined);};
  watch([() => sample.value?.visible, () => sample.value?.page_id, () => sample.value?.playing, () => sample.value?.playback_rate], observe, {flush:"post"});
  onMounted(() => {
    if (!chapterId || !materialId) return;
    releaseReset = session.registerRestartPreparation(() => record(true));
    unregister = session.registerParticipation(() => record(true));
    document.addEventListener("visibilitychange", observe);
    timer = setInterval(observe, 5000);
    observe();
  });
  onBeforeUnmount(() => {
    active = false; clearInterval(timer); unregister?.();
    document.removeEventListener("visibilitychange", observe);
    void record(true).catch(() => undefined).finally(() => releaseReset?.());
  });
  return {error, retry:observe};
}
