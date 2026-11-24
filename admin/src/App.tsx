import { SelectField } from "@/components/select-field";
import { useState, useEffect, lazy, Suspense } from "react";
import {
  GraduationCap,
  School,
  ChartNoAxesCombined,
  Presentation,
  Users,
  IdCard,
  LayoutDashboard,
  CalendarDays,
  BookOpen,
  Network,
  List,
  GitBranch,
  ChevronDown,
  LogOut,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  Package,
  Settings,
  ExternalLink,
  LoaderCircle,
  MessageCircleQuestionMark,
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
import { toast } from "@/components/ui/toast";
import { api, errorMessage, setToken, token } from "@/lib/api";
import { DraftProvider, useCanLeave } from "@/lib/drafts";
import { openTownPreview } from "@/lib/town-preview";
import type { User, Classroom } from "@/lib/types";
import { CoursePicker, Insights, ClassReport } from "@/pages/course-workspace";
import { useResource } from "@/lib/use-resource";
import type { CourseInstance } from "@/lib/types";
import { Login } from "@/pages/login";
import { Students } from "@/pages/students";
import { ClassOverview } from "@/pages/class-overview";
const KnowledgeGraph = lazy(() => import("@/features/content-workspace/knowledge-graph").then(module => ({ default: module.KnowledgeGraph })));
const ContentList = lazy(() => import("@/pages/content-list").then(module => ({ default: module.ContentListPage })));
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
  { key: "courses", title: "课程选择", icon: School, adminOnly: false },
  { key: "overview", title: "全局概览", icon: ChartNoAxesCombined, adminOnly: true },
  { key: "teachers", title: "教师管理", icon: Presentation, adminOnly: true },
  { key: "accounts", title: "学生管理", icon: Users, adminOnly: true },
  { key: "system", title: "全站设置", icon: Settings, adminOnly: true },
] as const;
const courseNav = [
  { key: "insights", title: "学情洞察", icon: ChartNoAxesCombined },
  { key: "classes", title: "班级管理", icon: School },
  { key: "details", title: "任务点明细", icon: List },
  { key: "grades", title: "学生成绩", icon: IdCard },
  { key: "classroom", title: "班级概况", icon: LayoutDashboard },
  { key: "students", title: "学生账号", icon: IdCard },
  { key: "teaching", title: "章节开放安排", icon: CalendarDays },
  { key: "content-graph", title: "知识图谱", icon: Network },
  { key: "content-list", title: "内容列表", icon: List },
  { key: "quick-orchestration", title: "快速编排", icon: ListPlus },
  { key: "activities", title: "学习活动", icon: BookOpen },
  { key: "authoring", title: "教学流程", icon: GitBranch },
  { key: "packages", title: "课程包", icon: Package },
  { key: "settings", title: "课程答疑设置", icon: MessageCircleQuestionMark },
  { key: "synthesis", title: "资料合成管理", icon: FileAudio },
  { key: "judge", title: "评测管理", icon: ShieldCheck },
] as const;
const pages = [...globalNav, ...courseNav] as const;
type Page = (typeof pages)[number]["key"];
const courseScreens = {
  packages: Packages, settings: CourseSettings, synthesis: Synthesis, authoring: Authoring,
  "content-list": ContentList,
  "quick-orchestration": QuickOrchestration,
};
const legacyContentTabs = new Map([["curriculum", "chapters"], ["materials", "materials"], ["questions", "questions"]]);
function currentPage(): Page {
  const part = location.pathname.split("/")[2];
  if (part === "content-review") {
    const params = new URLSearchParams(location.search);
    const rawMaterial = params.get("material_id") ?? "";
    const id = Number(rawMaterial);
    const initialReview = { materialId: /^\d+$/.test(rawMaterial) && Number.isSafeInteger(id) && id > 0 ? id : undefined };
    history.replaceState({ ...history.state, initialReview }, "", "/teacher/content-graph?" + params);
    return "content-graph";
  }
  const legacyTab = legacyContentTabs.get(part);
  if (legacyTab) {
    const url = new URL(location.href);
    url.pathname = "/teacher/content-list";
    url.searchParams.set("tab", legacyTab);
    history.replaceState(history.state, "", url);
    return "content-list";
  }
  return pages.some((n) => n.key === part) ? (part as Page) : "courses";
}
function returnToCourses() {
  history.replaceState({}, "", "/teacher/courses");
  return "courses" as const;
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
    [courseId, setCourseId] = useState(Number(new URLSearchParams(location.search).get("course"))),
    [busy, setBusy] = useState(false),
    [openingTown, setOpeningTown] = useState(false),
    [sidebar, setSidebar] = useState(true);
  const [classListRevision, setClassListRevision] = useState(0);
  const canLeave = useCanLeave();
  const courses = useResource<CourseInstance[]>(user && !user.must_change_password ? "/teacher/courses" : null);
  const course = courses.data?.find(row => row.id === courseId);
  const inCourse = classes.filter(row => row.course_id === courseId);
  const classPage = ["classroom", "students", "teaching", "judge", "details", "grades"].includes(page);
  function pageUrl(next: Page, cid = courseId, room = classroomId) {
    if (globalNav.some(item => item.key === next)) return `/teacher/${next}`;
    return `/teacher/${next}?course=${cid}${room ? "&class=" + room : ""}`;
  }
  function selectCourse(id: number) {
    if (!canLeave()) return;
    setCourseId(id); setClassroomId(null);
    history.pushState({}, "", pageUrl("insights", id, null)); setPage("insights");
  }
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
            } else {
              if (u.role !== "admin" && globalNav.some(item => item.key === location.pathname.split("/")[2] && item.adminOnly))
                setPage(returnToCourses());
              setUser(u);
            }
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
      toast.close();
      setUser(null);
      setClasses([]);
      setClassroomId(null);
      setPasswordOpen(false);
      setNewClass(false);
      setClassName("");
      setPage(returnToCourses());
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
        const saved = Number(new URLSearchParams(location.search).get("class"));
        setClassroomId(
          rows.some((c) => c.id === saved) ? saved : null,
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [user?.id, user?.must_change_password, classListRevision]);
  useEffect(() => {
    const pop = () => {
      if (canLeave()) {
        const next = currentPage();
        setCourseId(Number(new URLSearchParams(location.search).get("course")));
        setClassroomId(Number(new URLSearchParams(location.search).get("class")) || null);
        setPage(user?.role !== "admin" && globalNav.some(item => item.key === next && item.adminOnly) ? returnToCourses() : next);
      }
      else history.pushState({}, "", pageUrl(page));
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [canLeave, page, user?.role]);
  function navigate(next: Page) {
    if (next === page) return;
    if (!canLeave()) return;
    history.pushState({}, "", pageUrl(next));
    setPage(next);
    if (next === "courses") courses.reload();
  }
  function changeClass(id: number) {
    if (id === classroomId || !canLeave()) return;
    if (page === "content-list") {
      const url = new URL(location.href);
      for (const filter of ["point", "pointName"]) url.searchParams.delete(filter);
      history.replaceState(history.state, "", url);
    }
    if (page === "content-graph" && history.state?.initialReview) {
      history.replaceState({ ...history.state, initialReview: {} }, "");
    }
    setClassroomId(id);
    history.pushState({}, "", pageUrl(page, courseId, id));
    if (user) sessionStorage.setItem(`classroom:${user.id}`, String(id));
    setError("");
  }
  async function createClass() {
    if (!canLeave()) return;
    const capturedToken = token();
    setBusy(true);
    setError("");
    try {
      const row = await api.post<Classroom>(`/teacher/courses/${courseId}/classrooms`, { name: className });
      if (capturedToken !== token()) return;
      setClasses((v) => [...v, row]);
      setClassName("");
      setNewClass(false);
      if (user) sessionStorage.setItem(`classroom:${user.id}`, String(row.id));
      setClassroomId(row.id);
      history.pushState({}, "", pageUrl("classroom", courseId, row.id));
      setPage("classroom");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    if (busy || !canLeave()) return;
    setBusy(true);
    try {
      await api.post("/auth/logout", {});
      setToken(null);
      toast.close();
      if (user) sessionStorage.removeItem(`classroom:${user.id}`);
      setUser(null);
      setClasses([]);
      setClassroomId(null);
      setPasswordOpen(false);
      setNewClass(false);
      setClassName("");
      setError("");
      setPage(returnToCourses());
    } catch (e) {
      if (token()) toast.add({ title: errorMessage(e), type: "error" });
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
            setPage(returnToCourses());
            setUser(u);
          }}
        />
      </>
    );
  if (user.must_change_password) {
    return <PasswordDialog open required onClose={() => {}} onUser={setUser} user={user} onLogout={logout} />;
  }
  const classroom = inCourse.find((c) => c.id === classroomId);
  const isAdmin = user.role === "admin";
  const globalPage = globalNav.find(item => item.key === page);

  const allowed = !globalPage?.adminOnly || isAdmin;
  function openClass(id: number) {
    if (!user || !canLeave()) return;
    setClassroomId(id);
    const selectedCourse = classes.find(row => row.id === id)?.course_id ?? courseId;
    setCourseId(selectedCourse);
    if (!classes.some(row => row.id === id)) setClassListRevision(value => value + 1);
    history.pushState({}, "", pageUrl("classroom", selectedCourse, id));
    setPage("classroom");
  }
  function link({ key, title, icon: Icon }: (typeof globalNav | typeof courseNav)[number]) {
    return <a key={key} href={pageUrl(key)} aria-current={page === key ? "page" : undefined}
      onClick={event => { event.preventDefault(); navigate(key); }}><Icon size={18} aria-hidden />{title}</a>;
  }
  function renderPage(currentUser: User) {
    if (!allowed) return <ErrorNotice message="此页面仅管理员可访问。" />;
    switch (page) {
      case "courses":
        return <CoursePicker courses={courses} onOpen={selectCourse} admin={isAdmin}/>;
      case "classes":
        if (!course) break;
        return <ClassroomManagement courseId={course.id} isAdmin={isAdmin} userId={currentUser.id} onOpen={openClass}
          onCreate={() => setNewClass(true)} onChanged={() => setClassListRevision(value => value + 1)} />;
      case "teachers":
      case "accounts":
        return <Accounts role={page === "teachers" ? "teacher" : "student"} onChanged={() => setClassListRevision(value => value + 1)} />;
      case "overview":
        return <GlobalOverview onOpen={openClass} />;
      case "system":
        return <GlobalSettings />;
    }
    if (!course) return courses.loading ? <Loading/> : <CoursePicker courses={courses} onOpen={selectCourse} admin={isAdmin}/>;
    if (page === "insights") return <Insights courseId={course.id}/>;
    if (classPage && !classroom) return <div className="surface">
      <Empty title="尚未进入班级" />
      <div className="flex justify-center pb-8"><Button onClick={() => navigate("classes")}>班级管理</Button></div>
    </div>;
    if (page === "classroom") return <ClassOverview classroom={classroom!}/>;
    if (page === "students") return <Students classroomId={classroom!.id}/>;
    if (page === "details" || page === "grades") return <ClassReport classroomId={classroom!.id} grades={page === "grades"}/>;
    if (page === "teaching") return <Teaching classroomId={classroom!.id} courseId={course.id}/>;
    if (page === "judge") return <Judge classroomId={classroom!.id} canManage={false} />;
    if (page === "content-graph") {
      const entry = history.state;
      const initialReview = entry?.initialReview && entry.courseGraph && entry.courseGraph.courseId !== course.id
        ? {} : entry?.initialReview;
      return <KnowledgeGraph courseId={course.id} initialReview={initialReview} />;
    }
    if (page === "activities") return <Activities courseId={course.id} teacherId={course.teacher_id} />;
    if (!(page in courseScreens)) return null;
    const Screen = courseScreens[page as keyof typeof courseScreens];
    return <Screen courseId={course.id} />;
  }
  return (
    <div className={`workbench ${sidebar ? "" : "sidebar-collapsed"}`}>
      <aside id="workbench-sidebar" className="sidebar">
        <a
          href="/teacher/"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate("courses");
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
          {course && !globalPage && <nav aria-label="课程导航">
            {courseNav.map(item => (
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
              <span className="avatar" aria-hidden>{user.name.slice(0, 1)}</span>
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
            aria-expanded={sidebar}
            aria-controls="workbench-sidebar"
            onClick={() => setSidebar((v) => !v)}
          >
            {sidebar ? <PanelLeftClose /> : <PanelLeftOpen />}
          </Button>
          <span className="text-muted-foreground">教学工作台</span>
          <span className="text-border">/</span>
          {course && !globalPage && <span>{course.name} / </span>}
          <span>{pages.find((n) => n.key === page)?.title}</span>
          {classPage && <div className="class-picker">
            <label className="class-picker-label" htmlFor="active-class">当前班级</label>
            <SelectField fitOptions
              id="active-class"
              disabled={busy || inCourse.length === 0}
              value={classroomId ?? ""}
              onValueChange={(value) => changeClass(Number(value))}
            >
              <option value="" disabled>
                选择班级
              </option>
              {inCourse.map((c) => (
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
            aria-busy={openingTown}
            onClick={() => classroom && void enterTown(classroom.id)}
          >
            {openingTown ? "正在进入小镇…" : "进入小镇"}
            {openingTown ? <LoaderCircle data-icon="inline-end" className="animate-spin motion-reduce:animate-none" /> : <ExternalLink data-icon="inline-end" />}
          </Button>}
        </header>
        <main className={page === "content-graph" && course ? "main-content graph-main" : "main-content"}>
          <ErrorNotice message={error} />
          <Suspense key={`${user.id}:${classPage ? classroomId : courseId}:${page}`} fallback={<Loading />}>
            {renderPage(user)}
          </Suspense>
        </main>
      </div>
      {passwordOpen && <PasswordDialog
        open={passwordOpen}
        onClose={() => setPasswordOpen(false)}
        onUser={setUser}
        user={user}
      />}
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
              新班使用当前课程的内容，章节默认关闭。
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
