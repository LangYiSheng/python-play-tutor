import {ref, type Ref} from "vue";

export function useLessonVideo({readingKey, initialTime, onSeek}: {readingKey:Ref<string>; initialTime:()=>number|undefined; onSeek:()=>void}) {
  const videoElement = ref<HTMLVideoElement>();
  const videoTime = ref(0);
  let pendingSeek:number|undefined;
  let initialTimeUsed=false;
  function resetVideo() {videoTime.value=0;pendingSeek=undefined;}
  function updateTime(event: Event) {
    videoTime.value = (event.target as HTMLVideoElement).currentTime;
    sessionStorage.setItem(
      `${readingKey.value}:video`,
      String(videoTime.value),
    );
  }
  function seekVideo(seconds: number) {
    const video = videoElement.value;
    if (!video || video.readyState === 0) pendingSeek = seconds;
    if (!video) return;
    video.currentTime = Math.max(
      0,
      Math.min(
        seconds,
        Number.isFinite(video.duration) ? video.duration : seconds,
      ),
    );
    onSeek();
  }
  function restoreVideoPosition(event: Event) {
    const video = event.target as HTMLVideoElement,
      saved =
        pendingSeek ?? (initialTimeUsed ? undefined : initialTime()) ??
        Number(sessionStorage.getItem(`${readingKey.value}:video`) ?? 0);
    if (Number.isFinite(saved) && saved > 0 && Number.isFinite(video.duration))
      video.currentTime = Math.min(saved, Math.max(0, video.duration - 0.1));
    pendingSeek = undefined;
    initialTimeUsed = true;
  }

  return {videoElement,videoTime,resetVideo,updateTime,seekVideo,restoreVideoPosition};
}
