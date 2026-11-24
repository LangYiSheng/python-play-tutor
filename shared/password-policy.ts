export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

export function passwordLengthError(value: string): string {
  const length = Array.from(value).length;
  if (length < MIN_PASSWORD_LENGTH) return `密码至少需要 ${MIN_PASSWORD_LENGTH} 位`;
  if (length > MAX_PASSWORD_LENGTH) return `密码最多允许 ${MAX_PASSWORD_LENGTH} 位`;
  return "";
}
