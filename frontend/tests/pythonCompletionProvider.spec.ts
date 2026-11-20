import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { register } = vi.hoisted(() => ({ register: vi.fn() }));

vi.mock("monaco-editor/editor/editor.api.js", () => ({
  languages: {
    CompletionItemKind: { Keyword: 0, Class: 1, Function: 2, Method: 3, Snippet: 4, Constant: 5 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    registerCompletionItemProvider: register,
  },
  Range: class {},
}));

import { installPythonCompletions } from "../src/features/practice/pythonCompletions";
import { clearPythonModuleCache } from "../src/features/practice/pythonModuleCompletions";

const json = (data: unknown) => ({ ok: true, json: async () => data });
const math = {
  name: "math",
  members: [
    { name: "sqrt", kind: "function", signature: "(x, /)", doc: "Return the square root of x." },
    { name: "pi", kind: "constant", signature: "", doc: "" },
  ],
};

const provider = () => {
  installPythonCompletions();
  return register.mock.calls[0]?.[1] as {
    provideCompletionItems: (model: unknown, position: unknown) => Promise<{
      suggestions: {
        label: string;
        kind: number;
        detail?: string;
        insertText?: string;
        insertTextRules?: number;
      }[];
    }>;
  };
};

function model(line: string, source = line) {
  return {
    getValue: () => source,
    getLineContent: () => line,
    getWordUntilPosition: () => ({ startColumn: line.length + 1, endColumn: line.length + 1 }),
  };
}

beforeEach(() => {
  clearPythonModuleCache();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("manifest.json")) return json({ modules: ["math"] });
    if (url.endsWith("math.json")) return json(math);
    return { ok: false, json: async () => ({}) };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("python completion provider", () => {
  it("returns keywords and snippets when typing a word", async () => {
    const result = await provider().provideCompletionItems(model("for"), { lineNumber: 1, column: 4 });
    expect(result.suggestions.some((item) => item.label === "for")).toBe(true);
    const snippet = result.suggestions.find((item) => item.label === "forrange");
    expect(snippet?.insertTextRules).toBe(4);
  });

  it("only offers methods after a dot for a non-module value", async () => {
    const result = await provider().provideCompletionItems(model("items."), { lineNumber: 1, column: 7 });
    expect(result.suggestions.some((item) => item.label === "append")).toBe(true);
    expect(result.suggestions.every((item) => item.kind === 3)).toBe(true);
    expect(result.suggestions.some((item) => item.label === "for")).toBe(false);
  });

  it("loads module members lazily and inserts callable snippets", async () => {
    const result = await provider().provideCompletionItems(model("math."), { lineNumber: 1, column: 6 });
    const sqrt = result.suggestions.find((item) => item.label === "sqrt");
    const pi = result.suggestions.find((item) => item.label === "pi");
    expect(sqrt?.kind).toBe(2);
    expect(sqrt?.insertText).toBe("sqrt(${1})");
    expect(sqrt?.detail).toBe("math(x, /)");
    expect(pi?.kind).toBe(5);
    expect(pi?.insertText).toBe("pi");
  });

  it("resolves import aliases before loading a module", async () => {
    const source = "import math as m\nm.";
    const result = await provider().provideCompletionItems(model("m.", source), { lineNumber: 2, column: 3 });
    expect(result.suggestions.some((item) => item.label === "sqrt")).toBe(true);
  });

  it("requests a module only once", async () => {
    await provider().provideCompletionItems(model("math."), { lineNumber: 1, column: 6 });
    await provider().provideCompletionItems(model("math."), { lineNumber: 1, column: 6 });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("math.json"))).toHaveLength(1);
  });
});
