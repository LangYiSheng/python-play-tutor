export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
export interface InteractiveSource { html: string; css: string; js: string }
export interface InteractiveResult { value: JsonValue; correct: boolean; message: string }

/** Keep browser drafts and grading evidence within the server's JSON contract. */
export function isInteractiveValue(value: unknown): value is JsonValue {
  let remaining = 16384;
  function valid(item: unknown, depth: number): boolean {
    if (depth > 16 || --remaining < 0) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'string') {
      remaining -= item.length;
      return remaining >= 0;
    }
    if (typeof item === 'number') return Number.isFinite(item) && Math.abs(item) <= Number.MAX_SAFE_INTEGER;
    if (Array.isArray(item)) {
      if (item.length > remaining) return false;
      for (const entry of item) if (!valid(entry, depth + 1)) return false;
      return true;
    }
    if (typeof item !== 'object' || Object.prototype.toString.call(item) !== '[object Object]') return false;
    return Object.entries(item).every(([key, entry]) => {
      remaining -= key.length;
      return valid(entry, depth + 1);
    });
  }
  return valid(value, 0) && new TextEncoder().encode(JSON.stringify(value)).length <= 16384;
}

export function equalInteractiveValues(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length && left.every((v, i) => equalInteractiveValues(v, right[i]!));
  }
  return !Array.isArray(right) && Object.keys(left).length === Object.keys(right).length
    && Object.entries(left).every(([k, v]) => Object.hasOwn(right, k) && equalInteractiveValues(v, right[k]!));
}
