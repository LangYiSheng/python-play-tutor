import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ErrorNotice } from "@/components/common";
import { PasswordInput } from "@/components/password-input";
import { toast } from "@/components/ui/toast";
import { api, errorMessage, setToken } from "@/lib/api";
import type { AuthResult, User } from "@/lib/types";
import { passwordLengthError } from "../../../shared/password-policy";
export function PasswordDialog({
  open,
  onClose,
  onUser,
  user,
  onLogout,
  required = false,
}: {
  open: boolean;
  onClose: () => void;
  onUser: (user: User) => void;
  user: User;
  onLogout?: () => Promise<void>;
  required?: boolean;
}) {
  const [old, setOld] = useState(""),
    [next, setNext] = useState(""),
    [confirm, setConfirm] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const passwordError = next && (passwordLengthError(next) ||
    (next === user.student_id ? "新密码不能与工号相同" : next === old ? "新密码不能与当前密码相同" : ""));
  const confirmError = confirm && next !== confirm ? "两次输入的新密码不一致" : "";
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy || !next || passwordError || next !== confirm) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.post<AuthResult>("/auth/password", {
        ...(!required && { current_password: old }),
        new_password: next,
      });
      setToken(result.access_token);
      onUser(result.user);
      setOld("");
      setNext("");
      setConfirm("");
      onClose();
      toast.add({ title: "密码已修改", type: "success" });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy && !required) onClose();
      }}
    >
      <DialogContent showCloseButton={!required}>
        <DialogHeader>
          <DialogTitle>{required ? "设置密码" : "修改密码"}</DialogTitle>
          <DialogDescription>
            {required ? "设置自己的密码后，即可进入工作台。" : "修改后其他登录会话将失效，当前工作台保持登录。"}
          </DialogDescription>
        </DialogHeader>
        <form inert={busy} aria-busy={busy} onSubmit={save}>
          <ErrorNotice message={error} />
          {!required && <div className="field">
            <Label htmlFor="old-password">当前密码</Label>
            <Input
              id="old-password"
              type="password"
              autoComplete="current-password"
              value={old}
              onChange={(e) => setOld(e.target.value)}
              required
            />
          </div>}
          <PasswordInput id="new-password" label="新密码" value={next} onChange={setNext} error={passwordError} required />
          <PasswordInput id="confirm-password" label="确认新密码" value={confirm} onChange={setConfirm} error={confirmError} required />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => { if (required) void onLogout?.(); else onClose(); }}
              disabled={busy}
            >
              {required ? "退出登录" : "取消"}
            </Button>
            <Button type="submit" disabled={busy || !next || !confirm || Boolean(passwordError || confirmError)}>
              保存密码
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
