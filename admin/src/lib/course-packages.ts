import { request } from "./api";

export interface AvailablePackages {
  items: { key: string; name: string; package_id: string; package_version: string; source: "mounted" | "uploaded"; directory: string; created_at: string; chapter_count: number; question_count: number; mine: boolean; shared: boolean; exporter_name?: string | null; protected?: boolean; can_delete?: boolean }[];
  unavailable: number;
}

export function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createCourseFromPackage(packageKey: string, name: string, requestKey: string, signal?: AbortSignal) {
  return request<{id: number; name: string}>("/teacher/course/packages/create-course", {
    method: "POST", signal, body: JSON.stringify({ package_key: packageKey, name, request_id: requestKey }),
  });
}
