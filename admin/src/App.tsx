import { SelectField } from "@/components/select-field";
import { useState, useEffect, lazy, Suspense } from "react";
import {
  GraduationCap,
  Users,
  BookOpen,
  Network,
  ClipboardCheck,
  ListChecks,
  Layers3,
  ChevronDown,
  LogOut,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  Package,
  Settings,
  ArrowUpRight,
  ShieldCheck,
  FileAudio,
  ListPlus,
} from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ErrorNotice, Loading, Empty } from "@/components/common";
import { PasswordDialog } from "@/components/password-dialog";
import { api, errorMessage, setToken, token } from "@/lib/api";
import { DraftProvider, useCanLeave } from "@/lib/drafts";
import { openTownPreview } from "@/lib/town-preview";
import type { User, Classroom } from "@/lib/types";
import { Login } from "@/pages/login";
import { Students } from "@/pages/students";
import { ClassOverview } from "@/pages/class-overview";
const KnowledgeGraph = lazy(() => import("@/features/content-workspace/knowledge-graph").then(module => ({ default: module.KnowledgeGraph })));
const ContentList = lazy(() => import("@/pages/content-list").then(module => ({ default: module.ContentListPage })));
const ContentReview = lazy(() => import("@/pages/content-review").then(module => ({ default: module.ContentReviewPage })));
import { Activities } from "@/features/activities/activities-page";
import { CourseSettings } from "@/pages/course-settings";
import { Packages } from "@/pages/packages";
import { Teaching } from "@/pages/teaching";
const Synthesis = lazy(() => import("@/pages/synthesis").then(module => ({ default: module.Synthesis })));
const Judge = lazy(() => import("@/pages/judge").then(module => ({ default: module.Judge })));
const QuickOrchestration = lazy(() => import("@/features/quick-orchestration/page").then(module => ({ default: module.QuickOrchestration })));
const Authoring = lazy(() =>
  import("@/features/authoring/authoring-page").then((module) => ({ default: module.Authoring })),
);
import { ClassroomManagement, Accounts, GlobalOverview, GlobalSettings } from "@/features/management/pages";

const globalNav = [
  { key: "classes", title: "班级管理", icon: GraduationCap, adminOnly: false },
  { key: "overview", title: "全局概览", icon: Layers3, adminOnly: true },
  { key: "teachers", title: "教师管理", icon: Users, adminOnly: true },
  { key: "accounts", title: "学生管理", icon: Users, adminOnly: true },
  { key: "system", title: "全站设置", icon: Settings, adminOnly: true },
] as const;
const classNav = [
  { key: "classroom", title: "班级概况", icon: GraduationCap },
  { key: "students", title: "学生账号", icon: Users },
  { key: "teaching", title: "教学管理", icon: GraduationCap },
  { key: "content-graph", title: "知识图谱", icon: Network },
  { key: "content-list", title: "内容列表", icon: ListChecks },
  { key: "content-review", title: "待审批", icon: ClipboardCheck },
  { key: "quick-orchestration", title: "快速编排", icon: ListPlus },
  { key: "activities", title: "学习活动", icon: BookOpen },
  { key: "authoring", title: "教学流程", icon: Layers3 },
  { key: "packages", title: "课程包", icon: Package },
  { key: "settings", title: "本班答疑设置", icon: Settings },
  { key: "synthesis", title: "资料合成管理", icon: FileAudio },
  { key: "judge", title: "评测管理", icon: ShieldCheck },
] as const;
const nav = [...globalNav, ...classNav];
type Page = (typeof nav)[number]["key"];
const classroomScreens = {
  packages: Packages, students: Students, teaching: Teaching, settings: CourseSettings, synthesis: Synthesis, authoring: Authoring,
  "content-graph": KnowledgeGraph, "content-list": ContentList, "content-review": ContentReview,
  "quick-orchestration": QuickOrchestration,
};
const legacyContentTabs = new Map([["curriculum", "chapters"], ["materials", "materials"], ["questions", "questions"]]);
function currentPage(): Page {
  const part = location.pathname.split("/")[2];
  const legacyTab = legacyContentTabs.get(part);
  if (legacyTab) {
    const url = new URL(location.href);
    url.pathname = "/teacher/content-list";
    url.searchParams.set("tab", legacyTab);
    history.replaceState(history.state, "", url);
    return "content-list";
  }
  return nav.some((n) => n.key === part) ? (part as Page) : "classes";
}
export default function App() {
  return (
    <DraftProvider>
      <Workbench />
    </DraftProvider>
  );
}
function Workbench() {
  const [user, setUser] = useState<User | null>(null),
    [classes, setClasses] = useState<Classroom[]>([]),
    [classroomId, setClassroomId] = useState<number | null>(null),
    [loading, setLoading] = useState(Boolean(token())),
    [error, setError] = useState(""),
    [page, setPage] = useState<Page>(currentPage),
    [passwordOpen, setPasswordOpen] = useState(false),
    [newClass, setNewClass] = useState(false),
    [className, setClassName] = useState(""),
    [courseStart, setCourseStart] = useState("import"),
    [busy, setBusy] = useState(false),
    [openingTown, setOpeningTown] = useState(false),
    [sidebar, setSidebar] = useState(true);
  const [classListRevision, setClassListRevision] = useState(0);
  const canLeave = useCanLeave();
  useEffect(() => {
    let active = true;
    const captured = token();
    if (captured)
      api
        .get<User>("/auth/me")
        .then((u) => {
          if (active && captured === token()) {
            if (u.role === "student") {
              setToken(null);
              setError("请使用教师账号登录");
            } else setUser(u);
          }
        })
        .catch((e) => {
          if (active) setError(errorMessage(e));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const expire = () => {
      setUser(null);
      setClasses([]);
      setClassroomId(null);
      setPasswordOpen(false);
      setNewClass(false);
      setClassName("");
      setError("登录已失效，请重新登录。");
    };
    window.addEventListener("session-expired", expire);
    return () => window.removeEventListener("session-expired", expire);
  }, []);
  useEffect(() => {
    if (!user || user.must_change_password) return;
    const controller = new AbortController();
    const captured = token();
    api
      .get<Classroom[]>("/classrooms", controller.signal)
      .then((rows) => {
        if (controller.signal.aborted || captured !== token()) return;
        setClasses(rows);
        const saved = Number(sessionStorage.getItem(`classroom:${user.id}`));
        setClassroomId(
          rows.some((c) => c.id === saved) ? saved : (rows[0]?.id ?? null),
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [user?.id, user?.must_change_password, classListRevision]);
  useEffect(() => {
    const pop = () => {
      if (canLeave()) setPage(currentPage());
      else history.pushState({}, "", `/teacher/${page}`);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [canLeave, page]);
  function navigate(next: Page) {
    if (next === page) return;
    if (!canLeave()) return;
    history.pushState({}, "", `/teacher/${next}`);
    setPage(next);
  }
  function changeClass(id: number) {
    if (id === classroomId || !canLeave()) return;
    if (page === "content-list") {
      const url = new URL(location.href);
      url.searchParams.delete("point");
      url.searchParams.delete("pointName");
      history.replaceState(history.state, "", url);
    }
    setClassroomId(id);
    if (user) sessionStorage.setItem(`classroom:${user.id}`, String(id));
    setError("");
  }
  async function createClass() {
    if (!canLeave()) return;
    const capturedToken = token();
    setBusy(true);
    setError("");
    try {
      const row = await api.post<Classroom>("/classrooms", { name: className });
      if (capturedToken !== token()) return;
      setClasses((v) => [...v, row]);
      setClassName("");
      setNewClass(false);
      if (user) sessionStorage.setItem(`classroom:${user.id}`, String(row.id));
      if (courseStart === "empty") {
        try {
          await api.post(`/teacher/classrooms/${row.id}/course/empty`, {
            confirmed: true,
            name: `${row.name}的课程`,
          });
        } catch (e) {
          if (capturedToken === token()) setClassroomId(row.id);
          throw e;
        }
      }
      if (capturedToken !== token()) return;
      setClassroomId(row.id);
      const next = courseStart === "import" ? "packages" : "classroom";
      history.pushState({}, "", `/teacher/${next}`);
      setPage(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    if (!canLeave()) return;
    setBusy(true);
    try {
      await api.post("/auth/logout", {});
      setToken(null);
      setUser(null);
      setClasses([]);
      setClassroomId(null);
      setPasswordOpen(false);
      setNewClass(false);
      setClassName("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function enterTown(id: number) {
    const capturedToken = token();
    setOpeningTown(true);
    setError("");
    try {
      await openTownPreview(id);
    } catch (e) {
      if (capturedToken === token()) setError(errorMessage(e));
    } finally {
      setOpeningTown(false);
    }
  }
  if (loading) return <Loading />;
  if (!user)
    return (
      <>
        <ErrorNotice message={error} />
        <Login
          onLogin={(u) => {
            setError("");
            setUser(u);
          }}
        />
      </>
    );
  if (user.must_change_password) {
    return <PasswordDialog open required onClose={() => {}} onUser={setUser} />;
  }
  const classroom = classes.find((c) => c.id === classroomId);
  const isAdmin = user.role === "admin";
  const globalPage = globalNav.find(item => item.key === page);
  const classPage = !globalPage;
  const allowed = !globalPage?.adminOnly || isAdmin;
  function openClass(id: number) {
    if (!user || !canLeave()) return;
    setClassroomId(id);
    sessionStorage.setItem(`classroom:${user.id}`, String(id));
    if (!classes.some(row => row.id === id)) setClassListRevision(value => value + 1);
    history.pushState({}, "", "/teacher/classroom");
    setPage("classroom");
  }
  function link({ key, title, icon: Icon }: (typeof nav)[number]) {
    return <a key={key} href={`/teacher/${key}`} aria-current={page === key ? "page" : undefined}
      onClick={event => { event.preventDefault(); navigate(key); }}><Icon size={18} />{title}</a>;
  }
  function renderPage(currentUser: User) {
    if (!allowed) return <ErrorNotice message="此页面仅管理员可访问。" />;
    switch (page) {
      case "classes":
        return <ClassroomManagement isAdmin={isAdmin} userId={currentUser.id} onOpen={openClass}
          onCreate={() => setNewClass(true)} onChanged={() => setClassListRevision(value => value + 1)} />;
      case "teachers":
      case "accounts":
        return <Accounts role={page === "teachers" ? "teacher" : "student"} />;
      case "overview":
        return <GlobalOverview onOpen={openClass} />;
      case "system":
        return <GlobalSettings />;
    }
    if (!classroom) return <div className="surface">
      <Empty title="尚未进入班级" />
      <div className="flex justify-center pb-8"><Button onClick={() => navigate("classes")}>班级管理</Button></div>
    </div>;
    if (page === "classroom") return <ClassOverview classroom={classroom}
      onRenamed={name => setClasses(rows => rows.map(row => row.id === classroom.id ? { ...row, name } : row))}
      onContent={() => navigate("content-graph")} onImport={() => navigate("packages")} />;
    if (page === "judge") return <Judge classroomId={classroom.id} canManage={false} />;
    if (page === "activities") return <Activities classroomId={classroom.id} teacherId={classroom.teacher_id} />;
    const Screen = classroomScreens[page];
    return <Screen classroomId={classroom.id} />;
  }
  return (
    <div className={`workbench ${sidebar ? "" : "sidebar-collapsed"}`}>
      <aside className="sidebar">
        <a
          href="/teacher/"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate("classes");
          }}
        >
          <span className="brand-mark">
            <GraduationCap size={22} />
          </span>
          <span>
            Pythontopia<small>教学工作台</small>
          </span>
        </a>
        <div className="sidebar-scroll">
          <nav aria-label="工作台导航">
            {globalNav.filter(item => !item.adminOnly || isAdmin).map(link)}
          </nav>
          {classroom && <nav aria-label="班级导航">
            {classNav.map(item => (
              <div key={item.key}>
                {item.key === "classroom" && <p className="nav-label">班级教学</p>}
                {item.key === "content-graph" && <p className="nav-label">课程内容</p>}
                {item.key === "quick-orchestration" && <p className="nav-label">课程编排</p>}
                {item.key === "settings" && <p className="nav-label">任务与设置</p>}
                {link(item)}
              </div>
            ))}
          </nav>}
        </div>
        <div className="sidebar-bottom">
          <DropdownMenu>
            <DropdownMenuTrigger render={<button className="account" />}>
              <span className="avatar">{user.name.slice(0, 1)}</span>
              <span>
                {user.name}
                <small>{user.role === "admin" ? "管理员" : "教师"}</small>
              </span>
              <ChevronDown size={15} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => setPasswordOpen(true)}>
                <KeyRound />
                修改密码
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onClick={() => void logout()}>
                <LogOut />
                退出账号
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <Button
            variant="ghost"
            size="icon"
            aria-label={sidebar ? "收起导航" : "展开导航"}
            onClick={() => setSidebar((v) => !v)}
          >
            {sidebar ? <PanelLeftClose /> : <PanelLeftOpen />}
          </Button>
          <span className="text-muted-foreground">教学工作台</span>
          <span className="text-border">/</span>
          <span>{nav.find((n) => n.key === page)?.title}</span>
          {classPage && <div className="class-picker">
            <label className="class-picker-label" htmlFor="active-class">当前班级</label>
            <SelectField fitOptions
              id="active-class"
              disabled={busy || classes.length === 0}
              value={classroomId ?? ""}
              onValueChange={(value) => changeClass(Number(value))}
            >
              <option value="" disabled>
                选择班级
              </option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {isAdmin ? `${c.teacher_name || (c.teacher_id === user.id ? user.name : "未知教师")} | ${c.name}` : c.name}
                </option>
              ))}
            </SelectField>
          </div>}
          {classPage && <Button
            className="shrink-0"
            variant="outline"
            size="sm"
            disabled={!classroom || openingTown || user.must_change_password}
            onClick={() => classroom && void enterTown(classroom.id)}
          >
            {openingTown ? "正在进入小镇…" : "进入小镇"}
            <ArrowUpRight />
          </Button>}
        </header>
        <main className={page === "content-graph" && classroom ? "main-content graph-main" : "main-content"}>
          <ErrorNotice message={error} />
          <Suspense key={`${user.id}:${classPage ? classroomId : "global"}:${page}`} fallback={<Loading />}>
            {renderPage(user)}
          </Suspense>
        </main>
      </div>
      <PasswordDialog
        open={passwordOpen}
        onClose={() => setPasswordOpen(false)}
        onUser={setUser}
      />
      <Dialog
        open={newClass}
        onOpenChange={(v) => {
          if (!busy) setNewClass(v);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>创建班级</DialogTitle>
            <DialogDescription>
              填写班级名称，选择如何开始本班课程。
            </DialogDescription>
          </DialogHeader>
          <form
            inert={busy}
            aria-busy={busy}
            onSubmit={(e) => {
              e.preventDefault();
              void createClass();
            }}
          >
            <ErrorNotice message={error} />
            <div className="field">
              <Label htmlFor="class-name">班级名称</Label>
              <Input
                id="class-name"
                value={className}
                onChange={(e) => setClassName(e.target.value)}
                required
                maxLength={100}
              />
            </div>
            <div className="field">
              <Label htmlFor="class-course-start">课程来源</Label>
              <SelectField
                id="class-course-start"
                value={courseStart}
                onValueChange={(value) => setCourseStart(value)}
              >
                <option value="import">创建后导入课程包</option>
                <option value="empty">创建空课程</option>
                <option value="later">稍后配置课程</option>
              </SelectField>
              <p className="hint" aria-live="polite">
                {courseStart === "empty" ? "同时创建一门空白课程，建班后即可自己添加章节和教学内容。"
                  : courseStart === "later" ? "只创建班级，可以先添加学生。准备好后，在班级概况中导入课程包或创建空课程。"
                  : "建班后打开课程包列表，由你选择并确认导入本班要使用的课程。"}
              </p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setNewClass(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                创建班级
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
