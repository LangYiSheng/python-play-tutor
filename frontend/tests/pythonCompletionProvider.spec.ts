import { describe, expect, it, vi } from "vitest";

const { register } = vi.hoisted(() => ({ register: vi.fn() }));

vi.mock("monaco-editor/editor/editor.api.js", () => ({
  languages: {
    CompletionItemKind: { Keyword: 0, Class: 1, Function: 2, Method: 3, Snippet: 4 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    registerCompletionItemProvider: register,
  },
  Range: class {},
}));

import { installPythonCompletions } from "../src/features/practice/pythonCompletions";

const provider = () => {
  installPythonCompletions();
  return register.mock.calls[0]?.[1] as {
    provideCompletionItems: (model: unknown, position: unknown) => {
      suggestions: { label: string; kind: number; insertTextRules?: number }[];
    };
  };
};

function model(line: string) {
  return {
    getLineContent: () => line,
    getWordUntilPosition: () => ({ startColumn: line.length + 1, endColumn: line.length + 1 }),
  };
}

describe("python completion provider", () => {
  it("returns keywords and snippets when typing a word", () => {
    const result = provider().provideCompletionItems(model("for"), { lineNumber: 1, column: 4 });
    expect(result.suggestions.some((item) => item.label === "for")).toBe(true);
    const snippet = result.suggestions.find((item) => item.label === "forrange");
    expect(snippet?.insertTextRules).toBe(4);
  });

  it("only offers methods after a dot", () => {
    const result = provider().provideCompletionItems(model("items."), { lineNumber: 1, column: 7 });
    expect(result.suggestions.some((item) => item.label === "append")).toBe(true);
    expect(result.suggestions.every((item) => item.kind === 3)).toBe(true);
    expect(result.suggestions.some((item) => item.label === "for")).toBe(false);
  });
});
