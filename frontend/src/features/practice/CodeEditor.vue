<template>
  <div class="code-editor">
    <div ref="root" class="monaco-host" aria-label="Python代码编辑器"></div>
    <footer v-if="!loadError" class="code-position" aria-label="光标位置">行 {{ position.lineNumber }}，列 {{ position.column }}</footer>
    <p v-if="loadError" role="alert">{{ loadError }}</p>
  </div>
</template>
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import type { editor, IDisposable } from "monaco-editor";
import { parseFillTemplate } from "../../../../shared/codingQuestions";
import { useUiPreferences } from "../../shared/uiPreferences";
const preferences = useUiPreferences();
const props = withDefaults(defineProps<{ modelValue: string; highlightFillSlots?: boolean }>(), { highlightFillSlots: false });
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const root = ref<HTMLElement>(), loadError = ref("");
const position = ref({ lineNumber: 1, column: 1 });
let view: editor.IStandaloneCodeEditor | undefined;
let model: editor.ITextModel | undefined;
let decorations: editor.IEditorDecorationsCollection | undefined;
let subscription: IDisposable | undefined;
let cursorSubscription: IDisposable | undefined;
let disposed = false;
let syncingExternal = false;

function updateFillDecorations() {
  if (!view || !model) return;
  if (!props.highlightFillSlots) {
    decorations?.clear();
    return;
  }
  const { template } = parseFillTemplate(model.getValue());
  if (!template) {
    decorations?.clear();
    return;
  }
  const items: editor.IModelDeltaDecoration[] = [];
  for (const range of template.ranges) {
    items.push({
      range: { startLineNumber: range.startMarkerLine, startColumn: 1, endLineNumber: range.startMarkerLine, endColumn: 1 },
      options: { isWholeLine: true, className: "fill-slot-marker-line" },
    });
    items.push({
      range: { startLineNumber: range.endMarkerLine, startColumn: 1, endLineNumber: range.endMarkerLine, endColumn: 1 },
      options: { isWholeLine: true, className: "fill-slot-marker-line" },
    });
    if (range.endMarkerLine - range.startMarkerLine > 1) {
      items.push({
        range: { startLineNumber: range.startMarkerLine + 1, startColumn: 1, endLineNumber: range.endMarkerLine - 1, endColumn: 1 },
        options: { isWholeLine: true, className: "fill-slot-body-line" },
      });
    }
  }
  if (!decorations) decorations = view.createDecorationsCollection(items);
  else decorations.set(items);
}

onMounted(async () => {
  try {
    const { monaco } = await import("./monaco");
    if (disposed || !root.value) return;
    model = monaco.editor.createModel(props.modelValue, "python");
    view = monaco.editor.create(root.value, {
      model, theme: "town-python", automaticLayout: true,
      ariaLabel: "Python代码编辑器", fontSize: 14 * preferences.textScale, lineHeight: 22 * preferences.textScale,
      fontFamily: '"JetBrains Mono", Consolas, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", monospace',
      minimap: { enabled: false }, glyphMargin: false, folding: false,
      wordWrap: "on", lineNumbersMinChars: 3, scrollBeyondLastLine: false,
      padding: { top: 12, bottom: 12 }, tabSize: 4, overviewRulerLanes: 0,
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      wordBasedSuggestions: "currentDocument",
      snippetSuggestions: "inline",
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      unicodeHighlight: { ambiguousCharacters: false, nonBasicASCII: false },
    });
    updateFillDecorations();
    subscription = view.onDidChangeModelContent(() => {
      if (!syncingExternal) emit("update:modelValue", model!.getValue());
      updateFillDecorations();
    });
    cursorSubscription = view.onDidChangeCursorPosition(event => { position.value = event.position; });
    void document.fonts?.ready.then(() => { if (!disposed) monaco.editor.remeasureFonts(); });
  } catch {
    if (!disposed) loadError.value = "代码编辑器加载失败，请刷新页面后重试。";
  }
});
watch(() => props.modelValue, (value) => {
  if (view && model && value !== model.getValue()) {
    syncingExternal = true;
    try {
      view.executeEdits("draft", [{ range: model.getFullModelRange(), text: value }]);
    } finally {
      syncingExternal = false;
    }
    updateFillDecorations();
  }
});
watch(() => props.highlightFillSlots, () => {
  updateFillDecorations();
});
watch(() => preferences.textScale, (scale) => {
  view?.updateOptions({ fontSize: 14 * scale, lineHeight: 22 * scale });
});
onBeforeUnmount(() => {
  disposed = true;
  decorations?.clear();
  subscription?.dispose(); cursorSubscription?.dispose(); view?.dispose(); model?.dispose();
});
</script>
<style scoped>
.code-editor { display: flex; flex-direction: column; }
.monaco-host { flex: 1; min-height: 0; }
.code-position { flex: 0 0 auto; padding: 5px 12px; text-align: right; color: var(--game-muted); font-size: .75rem; line-height: 1.5; }
</style>
