import * as monaco from "monaco-editor/editor/editor.api.js";
import { PYTHON_COMPLETIONS, type PythonCompletionKind } from "./pythonCompletionData";
import {
  loadPythonModule,
  moduleReference,
  warmPythonModules,
  type PythonMemberKind,
} from "./pythonModuleCompletions";

const { CompletionItemKind: Kind, CompletionItemInsertTextRule: Rule } = monaco.languages;

const kinds: Record<PythonCompletionKind, monaco.languages.CompletionItemKind> = {
  keyword: Kind.Keyword,
  type: Kind.Class,
  function: Kind.Function,
  method: Kind.Method,
  snippet: Kind.Snippet,
};

const moduleKinds: Record<PythonMemberKind, monaco.languages.CompletionItemKind> = {
  function: Kind.Function,
  class: Kind.Class,
  constant: Kind.Constant,
};

let installed = false;

/** Register once; Monaco filters suggestions by the prefix already typed. */
export function installPythonCompletions() {
  if (installed) return;
  installed = true;
  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: ["."],
    async provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      const line = model.getLineContent(position.lineNumber);
      const before = line.slice(0, position.column - 1);
      const module = moduleReference(model.getValue(), line, position.column);
      if (module) {
        const data = await loadPythonModule(module);
        if (data) {
          return {
            suggestions: data.members.map((member) => {
              const callable = member.kind !== "constant";
              return {
                label: member.name,
                kind: moduleKinds[member.kind],
                detail: member.kind === "constant"
                  ? `${data.name} · 常量`
                  : `${data.name}${member.signature ?? ""}`,
                documentation: member.doc || undefined,
                insertText: callable
                  ? `${member.name}(${member.signature === "()" ? "" : "${1}"})`
                  : member.name,
                insertTextRules: callable ? Rule.InsertAsSnippet : undefined,
                range,
              };
            }),
          };
        }
      }
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
  warmPythonModules();
}
