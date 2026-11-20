import { describe, expect, it } from "vitest";
import { PYTHON_COMPLETIONS } from "../src/features/practice/pythonCompletionData";

describe("python completion data", () => {
  it("covers beginner keywords, builtins and common methods without duplicates", () => {
    const labels = PYTHON_COMPLETIONS.map((entry) => entry.label);
    for (const label of ["for", "while", "def", "print", "input", "range", "append", "split"]) {
      expect(labels).toContain(label);
    }
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("offers executable snippets for common input and control-flow patterns", () => {
    const snippets = new Map(
      PYTHON_COMPLETIONS.filter((entry) => entry.kind === "snippet")
        .map((entry) => [entry.label, entry.insertText]),
    );
    expect(snippets.get("readint")).toBe("n = int(input())");
    expect(snippets.get("readlist")).toContain("input().split()");
    expect(snippets.get("forrange")).toContain("range(");
    expect(snippets.get("defmain")).toContain('__name__ == "__main__"');
    expect(snippets.get("tryexcept")).toContain("except");
  });
});
