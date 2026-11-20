import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/languages/definitions/python/register.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import "@fontsource/jetbrains-mono/latin-400.css";
import { installPythonCompletions } from "./pythonCompletions";
(globalThis as typeof globalThis & { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
installPythonCompletions();
monaco.editor.defineTheme("town-python", {
  base: "vs", inherit: true, rules: [],
  colors: {
    "editor.background": "#FFFAF0", "editor.foreground": "#513B28",
    "editorLineNumber.foreground": "#9B8B70", "editorLineNumber.activeForeground": "#284B43",
    "editor.lineHighlightBackground": "#F3EDDF", "editor.selectionBackground": "#D7E3DA",
    "editorCursor.foreground": "#284B43", "editorGutter.background": "#FFFAF0",
    "editorSuggestWidget.background": "#FFFAF0", "editorSuggestWidget.border": "#D8CCB4",
    "editorSuggestWidget.foreground": "#513B28", "editorSuggestWidget.selectedBackground": "#D7E3DA",
    "editorSuggestWidget.selectedForeground": "#284B43", "editorSuggestWidget.highlightForeground": "#284B43",
    "editorSuggestWidget.focusHighlightForeground": "#284B43", "editorSuggestWidgetStatus.foreground": "#9B8B70",
  },
});
export { monaco };
