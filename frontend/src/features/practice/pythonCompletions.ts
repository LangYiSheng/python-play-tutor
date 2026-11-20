import * as monaco from "monaco-editor/editor/editor.api.js";
import { PYTHON_COMPLETIONS, type PythonCompletionKind } from "./pythonCompletionData";

const { CompletionItemKind: Kind, CompletionItemInsertTextRule: Rule } = monaco.languages;

const kinds: Record<PythonCompletionKind, monaco.languages.CompletionItemKind> = {
  keyword: Kind.Keyword,
  type: Kind.Class,
  function: Kind.Function,
  method: Kind.Method,
  snippet: Kind.Snippet,
};

let installed = false;

/** Register once; Monaco filters suggestions by the prefix already typed. */
export function installPythonCompletions() {
  if (installed) return;
  installed = true;
  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: ["."],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const afterDot = /\.\w*$/.test(before);
      const entries = afterDot
        ? PYTHON_COMPLETIONS.filter((entry) => entry.kind === "method")
        : PYTHON_COMPLETIONS;
      return {
        suggestions: entries.map((entry) => ({
          label: entry.label,
          kind: kinds[entry.kind],
          detail: entry.detail,
          insertText: entry.insertText ?? entry.label,
          insertTextRules: entry.kind === "snippet" ? Rule.InsertAsSnippet : undefined,
          range,
        })),
      };
    },
  });
}
