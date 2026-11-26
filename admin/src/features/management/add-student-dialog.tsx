import { useId, useState, type FormEvent } from "react";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { api, errorMessage, token } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { MIN_PASSWORD_LENGTH } from "../../../../shared/password-policy";

export function AddStudentDialog({ classroomId, onClose, onAdded }: {
  classroomId?: number;
  onClose: () => void;
  onAdded: () => void;
}) {
  const id = useId();
  const [studentId, setStudentId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const minIdLength = classroomId === undefined ? MIN_PASSWORD_LENGTH : 1;
  const valid = /^[0-9]{1,32}$/.test(studentId) && studentId.length >= minIdLength && Boolean(name.trim());
  useDraft(busy || Boolean(studentId || name));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    const captured = token();
    const student = { student_id: studentId, name: name.trim() };
    try {
      let message = "已创建学生账号";
      if (classroomId === undefined) {
        await api.post("/admin/students", student);
      } else {
        const result = await api.post<{ existing: number }>(`/teacher/classrooms/${classroomId}/students`, { students: [student] });
        message = result.existing ? "该学生已在本班" : "已将学生添加到本班";
      }
      if (captured !== token()) return;
      toast.add({ title: message, type: "success" });
      onAdded();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>添加学生</DialogTitle>
        <DialogDescription>{classroomId === undefined
          ? `学号至少 ${MIN_PASSWORD_LENGTH} 位。初始密码为学号，首次登录须修改。`
          : "已有账号须填写登记的姓名。新账号以学号为初始密码，首次登录须修改。"}</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={save}>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-number`}>学号</Label>
          <Input id={`${id}-number`} inputMode="numeric" minLength={minIdLength} maxLength={32}
            value={studentId} onChange={e => setStudentId(e.target.value)} required disabled={busy} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-name`}>姓名</Label>
          <Input id={`${id}-name`} value={name} maxLength={80} onChange={e => setName(e.target.value)} required disabled={busy} />
        </div>
        <ErrorNotice message={error} />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
          <Button type="submit" disabled={!valid || busy}>{busy ? "正在添加…" : "添加学生"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
