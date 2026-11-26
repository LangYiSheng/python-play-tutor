<template>
  <div
    ref="panel"
    class="dialogue-layer"
    role="dialog"
    aria-modal="true"
    aria-label="角色对白"
    tabindex="-1"
    @keydown="navigateResponses"
  >
    <div class="dialogue-stage" aria-hidden="true">
    <img
      v-if="portrait"
      class="portrait"
      :src="portrait"
      alt=""
      @error="imageError = true"
    />
    </div>
    <section class="dialogue-box" tabindex="0" aria-label="对白内容，点击或按回车继续" @click="clickDialogue" @keydown.enter.self.prevent="continueDialogue" @keydown.space.self.prevent="continueDialogue">
      <div class="dialogue-heading">
        <p class="eyebrow">{{ speaker }}</p>
      </div>
      <p class="dialogue-text" :aria-label="line?.text">
        {{ displayed }}
      </p>
      <div v-if="!typing" class="dialogue-actions">
        <button
          v-for="(choice, index) in typing ? [] : (line?.choices ?? [])"
          :key="choice.id"
          class="dialogue-response"

          @click="advance(choice.id)"
        >
          <span class="response-number" aria-hidden="true">{{ index + 1 }}.</span>
          <span>{{ choice.label }}</span></button
        >
      </div>
      <footer class="dialogue-footer">
        <span>{{ typing ? "点击显示全文" : line?.choices?.length ? "↑ ↓ 选择 · Enter 确认" : "点击继续 · Enter" }}</span>
        <button class="text-button" @click="close">结束交谈 <kbd>Esc</kbd></button>
      </footer>
    </section>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import type { StoryDialogue } from "../shared/types";
import { useCharacterImage } from "../shared/characterImage";
import { useModalFocus } from "../shared/modalFocus";
import { useUiPreferences } from "../shared/uiPreferences";
const props = defineProps<{ line: StoryDialogue }>();
const emit = defineEmits<{ close: []; advance: [choice?: string] }>();
const displayed = ref(""), typing = ref(false), imageError = ref(false);
const panel = ref<HTMLElement>();
const preferences = useUiPreferences();
useModalFocus(panel, () => props.line.id, close);
const line = computed(() => props.line);
const speaker = computed(() => line.value?.speaker ?? "小镇互动");
const portrait = useCharacterImage(computed(() => imageError.value ? undefined : line.value?.portrait));
let timer: ReturnType<typeof setInterval> | undefined;
function close() { emit("close"); }
function continueDialogue() {
  if (typing.value) reveal();
  else if (!line.value?.choices?.length) void advance();
}
function clickDialogue(event: MouseEvent) {
  if ((event.target as HTMLElement).closest("button")) return;
  continueDialogue();
}
function reveal() {
  clearInterval(timer);
  displayed.value = line.value?.text ?? "";
  typing.value = false;
}
function type() {
  clearInterval(timer);
  imageError.value = false;
  displayed.value = "";
  typing.value = true;
  let i = 0;
  const text = line.value?.text ?? "";
  if (preferences.reducedMotion) {
    reveal();
    return;
  }
  timer = setInterval(() => {
    displayed.value = text.slice(0, ++i);
    if (i >= text.length) reveal();
  }, 20);
}
function navigateResponses(event: KeyboardEvent) {
  if (!['ArrowUp', 'ArrowDown'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
  const buttons = Array.from(panel.value?.querySelectorAll<HTMLButtonElement>('.dialogue-actions button:not(:disabled)') ?? []);
  if (!buttons.length) return;
  event.preventDefault();
  event.stopPropagation();
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = index < 0 ? 0 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
}
async function advance(choice?: string) {
  if (typing.value) { reveal(); return; }
  emit("advance", choice);
}
// Start after the complete prop update, including a new round on the same node.
watch(
  [() => line.value?.id, () => line.value?.text],
  type,
  { immediate: true },
);
onBeforeUnmount(() => {
  clearInterval(timer);
});
</script>

<style scoped src="./world/dialogueUi.css"></style>
