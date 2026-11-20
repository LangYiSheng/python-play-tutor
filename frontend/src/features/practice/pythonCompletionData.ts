/** Static Python completions for beginners: keywords, builtins, common methods and snippets. */
export type PythonCompletionKind = "keyword" | "type" | "function" | "method" | "snippet";

export interface PythonCompletion {
  label: string;
  insertText?: string;
  detail: string;
  kind: PythonCompletionKind;
}

const keywords = [
  "and", "as", "assert", "async", "await", "break", "case", "class", "continue",
  "def", "del", "elif", "else", "except", "False", "finally", "for", "from",
  "global", "if", "import", "in", "is", "lambda", "match", "None", "nonlocal",
  "not", "or", "pass", "raise", "return", "True", "try", "while", "with", "yield",
];

const types = [
  "int", "float", "str", "bool", "list", "dict", "set", "tuple", "bytes",
  "Exception", "ValueError", "TypeError", "IndexError", "KeyError",
  "ZeroDivisionError", "FileNotFoundError",
];

const builtins = [
  "print", "input", "len", "range", "sum", "min", "max", "abs", "round", "sorted",
  "reversed", "enumerate", "zip", "map", "filter", "open", "isinstance", "type",
  "ord", "chr", "pow", "any", "all", "format", "repr", "iter", "next",
];

const methods = [
  "append", "extend", "insert", "remove", "pop", "clear", "index", "count",
  "sort", "reverse", "copy", "split", "rsplit", "strip", "lstrip", "rstrip",
  "join", "replace", "find", "rfind", "startswith", "endswith", "lower", "upper",
  "title", "capitalize", "items", "keys", "values", "get", "update", "setdefault",
  "add", "discard", "union", "intersection",
];

function snippet(label: string, insertText: string, detail: string): PythonCompletion {
  return { label, insertText, detail, kind: "snippet" };
}

const snippets = [
  snippet(
    "defmain",
    'def main():\n    ${1:pass}\n\n\nif __name__ == "__main__":\n    main()',
    "主函数与入口守卫",
  ),
  snippet("ifmain", 'if __name__ == "__main__":\n    main()', "入口守卫"),
  snippet("readint", "n = int(input())", "读一个整数"),
  snippet("readlist", "a = list(map(int, input().split()))", "读一行整数数组"),
  snippet("forrange", "for i in range(${1:n}):\n    ${2:pass}", "按次数循环"),
  snippet("forin", "for ${1:item} in ${2:items}:\n    ${3:pass}", "遍历元素"),
  snippet("whileloop", "while ${1:condition}:\n    ${2:pass}", "条件循环"),
  snippet(
    "tryexcept",
    "try:\n    ${1:pass}\nexcept ${2:Exception} as exc:\n    ${3:print(exc)}",
    "捕获异常",
  ),
  snippet(
    "withopen",
    'with open(${1:"data.txt"}, "r", encoding="utf-8") as f:\n    ${2:pass}',
    "安全打开文件",
  ),
  snippet("listcomp", "[${1:expr} for ${2:item} in ${3:items}]", "列表推导式"),
  snippet("dictcomp", "{${1:key}: ${2:value} for ${3:item} in ${4:items}}", "字典推导式"),
  snippet(
    "classdef",
    "class ${1:Name}:\n    def __init__(self, ${2:args}):\n        ${3:pass}",
    "类与初始化方法",
  ),
];

function unique(entries: PythonCompletion[]) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.label)) return false;
    seen.add(entry.label);
    return true;
  });
}

export const PYTHON_COMPLETIONS: PythonCompletion[] = unique([
  ...keywords.map((label) => ({ label, detail: "关键字", kind: "keyword" as const })),
  ...types.map((label) => ({ label, detail: "类型", kind: "type" as const })),
  ...builtins.map((label) => ({ label, detail: "内置函数", kind: "function" as const })),
  ...methods.map((label) => ({ label, detail: "常用方法", kind: "method" as const })),
  ...snippets,
]);
