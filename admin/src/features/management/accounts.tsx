import { DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import { ListEmpty } from "@/components/common";
import { ManagementTable } from "@/components/management-table";
import { useState, type FormEvent } from "react";
import { Ban, CircleCheck, Ellipsis, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { ErrorNotice, Loading, PageHeader, Pager, TableSearch } from "@/components/common";
import { PasswordInput } from "@/components/password-input";
import { SelectField } from "@/components/select-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { api, errorMessage, token } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useDraft } from "@/lib/drafts";
import type { User } from "@/lib/types";
import { MIN_PASSWORD_LENGTH, passwordLengthError } from "../../../../shared/password-policy";

export interface Account extends Omit<User, "student_id"> {
  student_id: string | null;
  disabled: boolean;
  classrooms: { id: number; name: string; status?: string }[];
}
export interface AccountList { items: Account[]; total: number }

const actionLabels = { rename: "修改姓名", reset: "重置密码", disable: "停用账号", enable: "启用账号", delete: "删除账号" };
type AccountAction = keyof typeof actionLabels;
type AccountEdit = { action: "create" } | { action: AccountAction; account: Account };

export function Accounts({ role, onChanged }: { role: "teacher" | "student"; onChanged?: () => void }) {
  return <AccountPage key={role} role={role} onChanged={onChanged} />;
}

function AccountPage({ role, onChanged }: { role: "teacher" | "student"; onChanged?: () => void }) {
  const teacher = role === "teacher";
  const numberLabel = teacher ? "工号" : "学号";
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1), [size, setSize] = useState(DEFAULT_PAGE_SIZE);
  const [editing, setEditing] = useState<AccountEdit | null>(null);
  const [selectedClass, setSelectedClass] = useState("all");
  const classes = useResource<{ id: number; name: string; teacher_name: string; status: string }[]>(
    teacher ? null : "/teacher/classrooms/management",
  );
  const params = new URLSearchParams({ role, q: query.trim(), page: String(page), size: String(size) });
  if (selectedClass !== "all") params.set("classroom_id", selectedClass);
  const accounts = useResource<AccountList>(`/admin/accounts?${params}`);
  return <>
    <PageHeader title={teacher ? "教师管理" : "学生管理"}>
      {teacher && <Button onClick={() => setEditing({ action: "create" })}><Plus />创建教师</Button>}
    </PageHeader>
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <TableSearch label={`搜索姓名或${numberLabel}`} value={query} onValueChange={value => { setQuery(value); setPage(1); }} />
      {!teacher && <SelectField aria-label="筛选班级" value={selectedClass} onValueChange={value => { setSelectedClass(value); setPage(1); }}>
        <option value="all">全部班级</option>
        {classes.data?.map(c => <option key={c.id} value={c.id}>{`${c.teacher_name} | ${c.name}${c.status === "archived" ? "（已归档）" : ""}`}</option>)}
      </SelectField>}
    <span id="accounts-columns-0" className="ml-auto" /></div>
    <ErrorNotice message={classes.error} />
    <ErrorNotice message={accounts.error} />
    {accounts.loading && <Loading />}
    {accounts.data && <div className="overflow-hidden rounded-lg border bg-background">
      <ManagementTable toolsId="accounts-columns-0" pageSize={{value:size,total:accounts.data.total,change:v => {setSize(v);setPage(1);}}}><TableHeader><TableRow>
        <TableHead>姓名 / {numberLabel}</TableHead><TableHead>{teacher ? "负责班级" : "所在班级"}</TableHead>
        <TableHead>账号状态</TableHead><TableHead className="text-right">操作</TableHead>
      </TableRow></TableHeader><TableBody>{accounts.data.items.map(row => <TableRow key={row.id}>
        <TableCell>{row.name} {row.role === "admin" && <small>管理员</small>}<div className="hint">{row.student_id || "未分配"}</div></TableCell>
        <TableCell className="max-w-lg whitespace-normal">{row.classrooms.map(c => c.status === "archived" ? `${c.name}（已归档）` : c.name).join("、") || "未关联班级"}</TableCell>
        <TableCell>{row.disabled ? <Badge variant="secondary">已停用</Badge> : row.must_change_password ? "待修改密码" : "正常"}</TableCell>
        <TableCell className="w-px">{row.role !== "admin" && <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing({ account: row, action: "rename" })}><Pencil />修改姓名</Button>
          <Button variant="outline" size="sm" disabled={!row.student_id} onClick={() => setEditing({ account: row, action: "reset" })}><KeyRound />重置密码</Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`管理 ${row.name}`} title="更多操作" />}><Ellipsis /></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditing({ account: row, action: row.disabled ? "enable" : "disable" })}>
                {row.disabled ? <CircleCheck /> : <Ban />}{row.disabled ? "启用账号" : "停用账号"}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => setEditing({ account: row, action: "delete" })}><Trash2 />删除账号</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>}</TableCell>
      </TableRow>)}</TableBody></ManagementTable>
      {!accounts.data.items.length && <ListEmpty title={teacher ? "暂无教师账号" : "暂无学生账号"} filtered={Boolean(query.trim()) || selectedClass !== "all"} reset={() => { setQuery(""); setSelectedClass("all"); setPage(1); }} action={teacher && <Button onClick={() => setEditing({action:"create"})}>创建教师账号</Button>} />}
      <Pager total={accounts.data.total} page={page} size={size} onPage={setPage} onSize={v => { setPage(1); setSize(v); }} />
    </div>}
    {editing && <AccountDialog edit={editing} onClose={() => setEditing(null)} onSaved={message => {
      toast.add({ title: message, type: "success" });
      if (editing.action === "delete" && page > 1 && accounts.data?.items.length === 1) setPage(page - 1);
      setEditing(null);
      accounts.reload();
      if (teacher && (editing.action === "delete" || editing.action === "rename")) onChanged?.();
    }} />}
  </>;
}

function AccountDialog({ edit, onClose, onSaved }: {
  edit: AccountEdit; onClose: () => void; onSaved: (message: string) => void;
}) {
  const account = "account" in edit ? edit.account : null;
  const { action } = edit;
  const creating = action === "create", renaming = action === "rename", deleting = action === "delete";
  const student = account?.role === "student";
  const numberLabel = student ? "学号" : "工号";
  const [name, setName] = useState(renaming ? account?.name ?? "" : "");
  const [id, setId] = useState(""), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const loginId = creating ? id : account?.student_id || "";
  const settingPassword = creating || action === "reset";
  const needsPassword = (action === "reset" && !student) || (settingPassword && loginId.length < MIN_PASSWORD_LENGTH);
  const passwordError = password ? passwordLengthError(password) : "";
  const valid = (!creating || /^[0-9]{1,32}$/.test(id)) &&
    (!(creating || renaming) || Boolean(name.trim())) &&
    (!settingPassword || (!passwordError && (!needsPassword || Boolean(password))));
  useDraft(busy || Boolean(id || password || (renaming ? name !== account?.name : name)));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !valid) return;
    setBusy(true); setError("");
    const captured = token();
    try {
      const temporaryPassword = password ? { password } : {};
      if (creating) {
        await api.post("/admin/teachers", { student_id: id, name: name.trim(), ...temporaryPassword });
        if (captured === token()) onSaved(`已创建教师账号 ${id}。`);
      } else if (account) {
        const path = `/admin/accounts/${account.id}`;
        if (renaming) await api.put(`${path}/name`, { name: name.trim() });
        else if (action === "reset") await api.post(`${path}/reset-password`, temporaryPassword);
        else if (deleting) await api.delete(path);
        else await api.put(`${path}/status`, { disabled: action === "disable" });
        if (captured === token()) onSaved(`已${actionLabels[action]} · ${renaming ? name.trim() : account.name}`);
      }
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const title = creating ? "创建教师" : `${actionLabels[action]} · ${account?.name}`;
  const description = {
    create: "教师首次登录时须设置自己的密码。",
    rename: "新姓名会显示在账号列表和关联班级中。",
    reset: "现有登录会话将失效，下次登录须修改密码。",
    disable: "现有登录会话将失效。启用后，账号可重新登录。",
    enable: "账号启用后可使用原密码重新登录。",
    delete: student
      ? "永久删除该学生账号及其在所有班级的存档、提交、成绩和助教会话。此操作无法撤销。"
      : "永久删除该教师账号、名下所有课程（包括尚未开班的课程）、教学班和学习记录。班级里的学生账号保留。此操作无法撤销。",
  }[action];

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent showCloseButton={!busy}><DialogHeader>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>{description}</DialogDescription>
    </DialogHeader><form className="space-y-4" onSubmit={save} inert={busy}><ErrorNotice message={error} />
      {(creating || renaming) && <div className="field"><Label htmlFor="account-name">姓名</Label><Input id="account-name" required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></div>}
      {creating && <div className="field"><Label htmlFor="account-login">工号</Label><Input id="account-login" inputMode="numeric" pattern="[0-9]{1,32}" maxLength={32} required value={id} onChange={e => setId(e.target.value)} /></div>}
      {settingPassword && <PasswordInput id="account-password" label={creating ? "初始密码" : "临时密码"} value={password} onChange={setPassword}
        required={needsPassword} error={passwordError} hint={action === "reset" && !student ? undefined :
          loginId && needsPassword ? `${numberLabel}不足 ${MIN_PASSWORD_LENGTH} 位，请设置密码。` : `留空时使用${numberLabel}。`} />}
      {deleting && loginId && <p className="text-sm">{numberLabel} · {loginId}</p>}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        <Button type="submit" variant={deleting ? "destructive" : "default"} disabled={!valid || busy}>
          {busy ? "处理中…" : creating ? "确认创建" : renaming ? "保存姓名" : `确认${actionLabels[action]}`}
        </Button>
      </DialogFooter>
    </form></DialogContent>
  </Dialog>;
}
