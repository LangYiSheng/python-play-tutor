import { isInteractiveValue, type JsonValue } from "../../../../shared/interactiveValues";

export function parseInteractiveTarget(input: string): JsonValue {
  if (!input.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error('正确提交值须为有效 JSON；文本值请使用双引号。');
  }
  if (!isInteractiveValue(value)) throw new Error("正确提交值超出允许的 JSON 大小、深度或数字范围。");
  return value;
}
