import { useRef, useState, type FormEvent } from "react";
import { ErrorNotice } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, token } from "@/lib/api";
import { type AvailablePackages, createCourseFromPackage, requestId } from "@/lib/course-packages";
import { useResource } from "@/lib/use-resource";

export function CreateCourseDialog({
  teacherName = "",
  onClose,
  onCreated,
}: {
  teacherName?: string;
  onClose: () => void;
  onCreated: (course: { id: number; name: string }) => void;
}) {
  const defaultTitle = teacherName.trim() ? `${teacherName.trim()}的课程` : "我的课程";
  const [name, setName] = useState(defaultTitle);
  const [customName, setCustomName] = useState(false);
  const [source, setSource] = useState<"empty" | "package" | null>(null);
  const [packageKey, setPackageKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<{ name: string; key: string; id: string } | null>(null);
  const catalog = useResource<AvailablePackages>(source === "package" ? "/teacher/course/packages" : null);
  const packages = catalog.data?.items.filter((item) => item.mine || item.shared) ?? [];
  const ready = Boolean(
    name.trim() &&
      (source === "empty" || (source === "package" && packages.some((item) => item.key === packageKey))),
  );

  function selectSource(kind: "empty" | "package") {
    setSource(kind);
    setError("");
    if (!customName) {
      const selectedPkg = kind === "package" ? packages.find((item) => item.key === packageKey) : undefined;
      setName(selectedPkg ? selectedPkg.name : defaultTitle);
    }
  }

  function selectPackage(key: string) {
    setPackageKey(key);
    if (!customName) {
      const selectedPkg = packages.find((item) => item.key === key);
      if (selectedPkg) setName(selectedPkg.name);
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    const session = token();
    const title = name.trim();
    setBusy(true);
    setError("");
    try {
      let result: { id: number; name?: string };
      if (source === "package") {
        if (attempt.current?.name !== title || attempt.current.key !== packageKey) {
          attempt.current = { name: title, key: packageKey, id: requestId() };
        }
        result = await createCourseFromPackage(packageKey, title, attempt.current.id);
      } else {
        result = await api.post<{ id: number; name?: string }>("/teacher/courses", { name: title });
      }
      if (session === token()) onCreated({ id: result.id, name: result.name || title });
    } catch (err) {
      if (session === token()) setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent showCloseButton={!busy} className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>创建课程</DialogTitle>
        </DialogHeader>
        <form className="grid min-w-0 gap-5" onSubmit={create}>
          <div className="grid gap-2">
            <Label htmlFor="course-name">课程名称</Label>
            <Input
              id="course-name"
              value={name}
              required
              maxLength={200}
              disabled={busy}
              onChange={(e) => {
                setName(e.target.value);
                setCustomName(true);
              }}
            />
          </div>
          <fieldset disabled={busy}>
            <legend className="mb-2 text-sm font-medium">创建方式</legend>
            <div className="grid grid-cols-2 gap-2">
              {(["empty", "package"] as const).map((kind) => (
                <label
                  key={kind}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 has-checked:border-primary"
                >
                  <input
                    type="radio"
                    name="course-source"
                    required
                    checked={source === kind}
                    onChange={() => selectSource(kind)}
                  />
                  {kind === "empty" ? "创建空课程" : "导入课程包"}
                </label>
              ))}
            </div>
          </fieldset>
          {source === "package" && (
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="course-package">课程包</Label>
              <SelectField
                className="w-full"
                id="course-package"
                disabled={busy || !packages.length}
                value={packageKey}
                onValueChange={selectPackage}
              >
                <option value="" disabled>
                  选择课程包
                </option>
                {packages.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.name} · {item.directory}
                  </option>
                ))}
              </SelectField>
              {catalog.loading && (
                <div role="status" aria-busy="true" className="flex items-center gap-2 pt-0.5">
                  <span className="sr-only">正在加载课程包…</span>
                  <Skeleton className="h-3.5 w-36" />
                </div>
              )}
              {catalog.error && (
                <>
                  <ErrorNotice message={catalog.error} />
                  <Button type="button" variant="outline" onClick={catalog.reload}>
                    重试
                  </Button>
                </>
              )}
              {catalog.data && !packages.length && (
                <p className="hint" role="status">
                  暂无可导入的课程包。
                </p>
              )}
            </div>
          )}
          <ErrorNotice message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy || !ready}>
              {busy ? "正在创建…" : "创建课程"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
