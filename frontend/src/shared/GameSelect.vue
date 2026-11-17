<template>
  <span ref="root" class="game-select">
    <button
      v-bind="$attrs"
      :id="controlId"
      ref="trigger"
      type="button"
      class="game-select-trigger"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="open ? listId : undefined"
      :disabled="disabled"
      @click="open ? close() : show()"
      @keydown="keydown"
      @blur="close"
    >
      <span class="game-select-value">{{ selected?.label ?? placeholder }}</span>
      <GameIcon name="chevronDown" class="game-select-arrow" :class="{ 'is-open': open }" />
    </button>
    <Teleport :to="host ?? 'body'" :disabled="!host">
      <div v-if="open" ref="portal" class="game-select-portal">
        <div :id="listId" ref="menu" class="game-select-menu" role="listbox" :aria-label="accessibleName" :style="menuStyle" @mousedown.prevent>
          <div
            v-for="(option, index) in options" :id="`${listId}-${index}`" :key="option.value"
            role="option" class="game-select-option"
            :class="{ 'is-selected': option.value === modelValue }"
            :aria-selected="option.value === modelValue" :aria-disabled="option.disabled || undefined"
            @click="choose(index)"
          >
            <span>{{ option.label }}</span><GameIcon v-if="option.value === modelValue" name="check" />
          </div>
          <p v-if="!options.length" class="game-select-empty">暂无选项</p>
        </div>
      </div>
    </Teleport>
  </span>
</template>

<script setup lang="ts" generic="T extends string | number">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useAttrs, useId, watch, type CSSProperties } from "vue";
import GameIcon from "./GameIcon.vue";

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{
  id?: string;
  modelValue?: T;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  disabled?: boolean;
  placeholder?: string;
}>(), { placeholder: "请选择" });
const emit = defineEmits<{ "update:modelValue": [value: T] }>();
const attrs = useAttrs();
const generatedId = `game-select-${useId()}`;
const controlId = computed(() => props.id ?? generatedId);
const listId = `${generatedId}-list`;
const root = ref<HTMLElement>(), trigger = ref<HTMLButtonElement>(), menu = ref<HTMLElement>(), portal = ref<HTMLElement>();
const host = ref<Element>();
const open = ref(false), accessibleName = ref("");
const menuStyle = ref<CSSProperties>({});
const selected = computed(() => props.options.find(option => option.value === props.modelValue));
let resizeObserver: ResizeObserver | undefined;

function close() { open.value = false; }
function position() {
  if (!open.value || !trigger.value || !menu.value || !portal.value) return;
  const anchor = trigger.value.getBoundingClientRect(), origin = portal.value.getBoundingClientRect();
  if (!trigger.value.getClientRects().length) { close(); return; }
  const edge = 8, gap = 4;
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
  const right = left + (viewport?.width ?? window.innerWidth), bottom = top + (viewport?.height ?? window.innerHeight);
  const width = Math.min(Math.max(anchor.width, 160), right - left - edge * 2);
  const below = Math.max(0, bottom - anchor.bottom - gap - edge), above = Math.max(0, anchor.top - top - gap - edge);
  const desired = Math.min(menu.value.scrollHeight + 2, 320);
  const upwards = below < desired && above > below;
  const height = Math.min(desired, upwards ? above : below);
  menuStyle.value = {
    width: `${width}px`, maxHeight: `${height}px`,
    left: `${Math.max(left + edge, Math.min(anchor.left, right - width - edge)) - origin.left}px`,
    top: `${(upwards ? anchor.top - gap - height : anchor.bottom + gap) - origin.top}px`,
  };
}
async function revealSelected() {
  await nextTick();
  const option = menu.value?.querySelector<HTMLElement>('[aria-selected="true"]');
  if (option && menu.value) {
    if (option.offsetTop < menu.value.scrollTop) menu.value.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.value.scrollTop + menu.value.clientHeight)
      menu.value.scrollTop = option.offsetTop + option.offsetHeight - menu.value.clientHeight;
  }
}
async function show() {
  if (props.disabled) return;
  accessibleName.value = String(attrs["aria-label"] ?? (Array.from(trigger.value?.labels ?? []).map(label => label.textContent?.trim()).join(" ") || "选项"));
  open.value = true;
  await nextTick();
  position();
  void revealSelected();
}
function choose(index: number) {
  const option = props.options[index];
  if (!option || option.disabled || props.disabled) return;
  emit("update:modelValue", option.value);
  close();
  trigger.value?.focus({ preventScroll: true });
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Escape" && open.value && !event.isComposing) {
    event.preventDefault();
    event.stopPropagation();
    close();
  }
}
function outside(event: PointerEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target) && !menu.value?.contains(event.target)) close();
}
function scrolled(event: Event) {
  if (open.value && event.target instanceof Node && !menu.value?.contains(event.target)) close();
}
watch(() => props.disabled, disabled => { if (disabled) close(); });
watch(() => props.options, () => { if (open.value) void show(); });
onMounted(() => {
  host.value = root.value?.closest(".game-workspace") ?? undefined;
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("scroll", scrolled, true);
  window.addEventListener("resize", position);
  window.visualViewport?.addEventListener("resize", position);
  if (typeof ResizeObserver !== "undefined" && trigger.value) {
    resizeObserver = new ResizeObserver(position);
    resizeObserver.observe(trigger.value);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside, true);
  document.removeEventListener("scroll", scrolled, true);
  window.removeEventListener("resize", position);
  window.visualViewport?.removeEventListener("resize", position);
  resizeObserver?.disconnect();
});
</script>

<style scoped>
.game-select { display:inline-flex; min-width:0; max-width:100%; vertical-align:middle; }
.game-select-trigger { display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; min-width:0; min-height:var(--game-control-height,34px); padding:6px 10px; border:1px solid var(--game-line,#d7c7a9); border-radius:var(--game-control-radius,8px); background:var(--game-paper-raised,#fffaf0); color:var(--game-ink,#513b28); font:inherit; font-size:var(--game-label-size,.875rem); text-align:left; cursor:pointer; }
.game-select-trigger:hover:not(:disabled),.game-select-trigger[aria-expanded="true"] { border-color:var(--game-forest,#284b43); background:#f2eddf; }
.game-select-trigger:disabled { opacity:.55; cursor:not-allowed; }
.game-select-value { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.game-select-arrow { flex-shrink:0; width:16px; height:16px; color:var(--game-muted,#7c6b55); }
.game-select-arrow.is-open { transform:rotate(180deg); }
.game-select-portal { position:fixed; inset:0; z-index:100; pointer-events:none; }
.game-select-menu { position:absolute; box-sizing:border-box; overflow:auto; overscroll-behavior:contain; padding:4px; margin:0; border:1px solid var(--game-line,#d7c7a9); border-radius:var(--game-control-radius,8px); background:var(--game-paper-raised,#fffaf0); color:var(--game-ink,#513b28); font-size:var(--game-label-size,.875rem); line-height:1.5; box-shadow:0 6px 18px #203b3226; pointer-events:auto; }
.game-select-option { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:var(--game-control-height,34px); padding:6px 8px; border-radius:4px; cursor:pointer; }
.game-select-option > span { min-width:0; overflow-wrap:anywhere; }
.game-select-option > .game-icon { flex-shrink:0; width:16px; height:16px; }
.game-select-option.is-selected { color:var(--game-forest,#284b43); font-weight:600; }
.game-select-option.is-selected,.game-select-option:hover:not([aria-disabled="true"]) { background:#e8eddf; color:var(--game-forest,#284b43); }
.game-select-option[aria-disabled="true"] { opacity:.5; cursor:not-allowed; }
.game-select-empty { margin:0; padding:8px; color:var(--game-muted,#7c6b55); }
@media(pointer:coarse) { .game-select-trigger,.game-select-option { min-height:44px; } }
@media(forced-colors:active) { .game-select-option.is-selected,.game-select-option:hover:not([aria-disabled="true"]) { background:Highlight; color:HighlightText; forced-color-adjust:none; } }
</style>
