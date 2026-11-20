import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read<T>(name: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), "public", "python-completions", name), "utf8")) as T;
}

describe("generated python module completions", () => {
  it("ships a manifest and math members generated from the stdlib", () => {
    const manifest = read<{ modules: string[] }>("manifest.json");
    expect(manifest.modules).toContain("math");
    const math = read<{ name: string; members: { name: string; kind: string; signature?: string }[] }>("math.json");
    expect(math.name).toBe("math");
    const sqrt = math.members.find((member) => member.name === "sqrt");
    expect(sqrt?.kind).toBe("function");
    expect(sqrt?.signature).toBe("(x, /)");
    expect(math.members.find((member) => member.name === "pi")?.kind).toBe("constant");
  });
});
