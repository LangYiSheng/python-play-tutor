/** Lazy module-member completions generated from the Python stdlib. */
export type PythonMemberKind = "function" | "class" | "constant";

export interface PythonModuleMember {
  name: string;
  kind: PythonMemberKind;
  signature?: string;
  doc?: string;
}

export interface PythonModule {
  name: string;
  members: PythonModuleMember[];
}

const BASE = "/python-completions/";
let manifest: Promise<Set<string>> | undefined;
const modules = new Map<string, Promise<PythonModule | null>>();

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function warmPythonModules() {
  manifest ??= getJson<{ modules?: unknown }>(`${BASE}manifest.json`).then((data) => {
    const names = Array.isArray(data?.modules) ? data.modules : [];
    return new Set(names.filter((name): name is string => typeof name === "string"));
  });
}

export async function loadPythonModule(name: string): Promise<PythonModule | null> {
  warmPythonModules();
  const known = await manifest!;
  if (!known.has(name)) return null;
  let pending = modules.get(name);
  if (!pending) {
    pending = getJson<PythonModule>(`${BASE}${encodeURIComponent(name)}.json`).then((data) => {
      if (!data || data.name !== name || !Array.isArray(data.members)) return null;
      return data;
    });
    modules.set(name, pending);
  }
  return pending;
}

/** Read simple ``import math`` / ``import math as m`` aliases from the document. */
export function importAliases(source: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("import ")) continue;
    const rest = line.slice("import ".length).split("#", 1)[0] ?? "";
    for (const part of rest.split(",")) {
      const match = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(part.trim());
      if (!match) continue;
      const moduleName = match[1];
      if (!moduleName) continue;
      const root = moduleName.split(".")[0] ?? moduleName;
      aliases.set(match[2] ?? root, root);
    }
  }
  return aliases;
}

/** Resolve the token immediately before a dot to a known import alias. */
export function moduleReference(source: string, line: string, column: number): string | undefined {
  const match = /([A-Za-z_]\w*)\.\w*$/.exec(line.slice(0, column - 1));
  const token = match?.[1];
  if (!token) return undefined;
  return importAliases(source).get(token) ?? token;
}

export function clearPythonModuleCache() {
  manifest = undefined;
  modules.clear();
}
