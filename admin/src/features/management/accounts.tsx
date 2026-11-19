import { useState, type FormEvent } from "react";
import { KeyRound, Plus } from "lucide-react";
import { Empty, ErrorNotice, Loading, PageHeader, Pager, TableSearch } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useDraft } from "@/lib/drafts";
import type { User } from "@/lib/types";

export interface Account extends User { classrooms: { id: number; name: string; status?: string }[] }
export interface AccountList { items: Account[]; total: number }

export function Accounts({ role }: { role: "teacher" | "student" }) {
  return <AccountPage key={role} role={role} />;
}

function AccountPage({ role }: { role: "teacher" | "student" }) {
  const teacher = role === "teacher";
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1), [size, setSize] = useState(25);
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [notice, setNotice] = useState("");
  const params = new URLSearchParams({ role, q: query.trim(), page: String(page), size: String(size) });
  const accounts = useResource<AccountList>(`/admin/accounts?${params}`);
  return <>
    <PageHeader title={teacher ? "教师管理" : "学生管理"}>
      {teacher && <Button onClick={() => setEditing("new")}><Plus />创建教师</Button>}
    </PageHeader>
    <div className="toolbar"><TableSearch label="搜索姓名或学号" value={query} onValueChange={value => { setQuery(value); setPage(1); }} /></div>
    <ErrorNotice message={accounts.error} />
    {notice && <p role="status" className="success-notice">{notice}</p>}
    {accounts.loading && <Loading />}
    {accounts.data && <div className="surface overflow-hidden">
      <Table><TableHeader><TableRow>
        <TableHead>姓名 / 学号</TableHead><TableHead>{teacher ? "负责班级" : "所在班级"}</TableHead>
        <TableHead>账号状态</TableHead><TableHead className="text-right">操作</TableHead>
      </TableRow></TableHeader><TableBody>{accounts.data.items.map(row => <TableRow key={row.id}>
        <TableCell>{row.name} {row.role === "admin" && <small>管理员</small>}<div className="hint">{row.student_id}</div></TableCell>
        <TableCell className="max-w-lg whitespace-normal">{row.classrooms.map(c => c.status === "archived" ? `${c.name}（已归档）` : c.name).join("、") || "未关联班级"}</TableCell>
        <TableCell>{row.must_change_password ? "待修改密码" : "正常"}</TableCell>
        <TableCell className="text-right">{row.role !== "admin" && <Button variant="outline" size="sm" onClick={() => setEditing(row)}><KeyRound />重置密码</Button>}</TableCell>
      </TableRow>)}</TableBody></Table>
      {!accounts.data.items.length && <Empty title="没有匹配的账号" />}
      <Pager total={accounts.data.total} page={page} size={size} onPage={setPage} onSize={v => { setPage(1); setSize(v); }} />
    </div>}
    {editing && <AccountDialog account={editing} onClose={() => setEditing(null)} onSaved={message => {
      setNotice(message); setEditing(null); accounts.reload();
    }} />}
  </>;
}

function AccountDialog({ account, onClose, onSaved }: {
  account: Account | "new"; onClose: () => void; onSaved: (message: string) => void;
}) {
  const creating = account === "new";
  const student = !creating && account.role === "student";
  const [name, setName] = useState(""), [id, setId] = useState(""), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useDraft(Boolean(name || id || password || busy));
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      if (creating) await api.post("/admin/teachers", { student_id: id, name: name.trim(), password });
      else await api.post(`/admin/accounts/${account.id}/reset-password`, student ? {} : { password });
      onSaved(creating ? `已创建教师账号 ${id}。` : `已重置 ${account.name} 的密码。`);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent showCloseButton={!busy}><DialogHeader>
      <DialogTitle>{creating ? "创建教师" : `重置 ${account.name} 的密码`}</DialogTitle>
      <DialogDescription>{student ? `初始密码将恢复为学号 ${account.student_id}，适用于该学生加入的所有班级。下次登录须修改密码。` :
        "请将初始密码单独告知教师，教师下次登录须修改密码。"}</DialogDescription>
    </DialogHeader><form className="space-y-4" onSubmit={save}><ErrorNotice message={error} />
      {creating && <>
        <div className="field"><Label htmlFor="account-name">姓名</Label><Input id="account-name" required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></div>
        <div className="field"><Label htmlFor="account-login">登录学号</Label><Input id="account-login" inputMode="numeric" pattern="[0-9]{1,32}" maxLength={32} required value={id} onChange={e => setId(e.target.value)} /></div>
      </>}
      {!student && <div className="field"><Label htmlFor="account-password">初始密码（至少 12 位）</Label><Input id="account-password" type="password" autoComplete="new-password" required minLength={12} maxLength={200} value={password} onChange={e => setPassword(e.target.value)} /></div>}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button disabled={busy} type="submit">{busy ? "保存中…" : creating ? "确认创建" : "确认重置"}</Button></DialogFooter>
    </form></DialogContent>
  </Dialog>;
}
