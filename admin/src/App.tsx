import { TablePreferences } from "@/components/management-table";
import { SelectField } from "@/components/select-field";
import { useState, useEffect, lazy, Suspense, type ReactNode } from "react";
import {
  GraduationCap,
  School,
  ChartNoAxesCombined,
  Presentation,
  Users,
  IdCard,
  LayoutDashboard,
  CalendarDays,
  ClipboardList,
  Network,
  BookOpen,
  FileQuestionMark,
  List,
  ChevronDown,
  ChevronLeft,
  LogOut,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  Package,
  Settings,
  ExternalLink,
  LoaderCircle,
  ShieldCheck,
  FileAudio,
} from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
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
import { CoursePicker } from "@/pages/course-workspace";
import { InsightsPage } from "@/features/analytics/insights-page";
import { TaskDetailsPage } from "@/features/analytics/details-page";
import { GradesPage } from "@/features/analytics/grades-page";
import { useResource } from "@/lib/use-resource";
import type { CourseInstance } from "@/lib/types";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LearningTasks } from "@/features/activities/activities-page";
import { Login } from "@/pages/login";
import { Students } from "@/pages/students";
const KnowledgeGraph = lazy(() => import("@/features/content-workspace/knowledge-graph").then(module => ({ default: module.KnowledgeGraph })));
const Courseware = lazy(() => import("@/features/courseware/courseware-page").then(module => ({ default: module.CoursewarePage })));
const Assessments = lazy(() => import("@/features/assessments/assessments-page").then(module => ({ default: module.AssessmentsPage })));
import { Packages } from "@/pages/packages";
import { Teaching } from "@/pages/teaching";
const Synthesis = lazy(() => import("@/pages/synthesis").then(module => ({ default: module.Synthesis })));
const Judge = lazy(() => import("@/pages/judge").then(module => ({ default: module.Judge })));
import { ClassroomManagement, Accounts, GlobalOverview, GlobalSettings } from "@/features/management/pages";

const globalNav = [
  { key: "overview", title: "全局概览", icon: ChartNoAxesCombined },
  { key: "teachers", title: "教师管理", icon: Presentation },
  { key: "accounts", title: "学生管理", icon: Users },
  { key: "global-synthesis", title: "资料合成管理", icon: FileAudio },
  { key: "global-judge", title: "评测管理", icon: ShieldCheck },
  { key: "system", title: "全站设置", icon: Settings },
] as const;
const statisticsNav = [
  { key: "insights", title: "学情洞察", icon: ChartNoAxesCombined },
  { key: "details", title: "任务点明细", icon: List },
  { key: "grades", title: "学生成绩", icon: IdCard },
] as const;
const classNav = [
  { key: "classes", title: "班级管理", icon: School },
  { key: "teaching", title: "定时开放", icon: CalendarDays },
] as const;
const contentNav = [
  { key: "content-graph", title: "知识图谱", icon: Network },
  { key: "courseware", title: "章节与课件", icon: BookOpen },
  { key: "assessments", title: "题库与组卷", icon: FileQuestionMark },
  { key: "activities", title: "学习任务", icon: ClipboardList },
] as const;
const settingsNav = [
  { key: "synthesis", title: "资料合成管理", icon: FileAudio },
  { key: "judge", title: "评测管理", icon: ShieldCheck },
] as const;
const courseNav = [...statisticsNav, ...classNav, ...contentNav, ...settingsNav,
  { key: "students", title: "学生管理", icon: Users }] as const;
const hubNav = [{ key: "courses", title: "课程选择", icon: School }, { key: "packages", title: "课程包管理", icon: Package }] as const;
const pages = [...hubNav, ...globalNav, ...courseNav] as const;
type Page = (typeof pages)[number]["key"];
const courseScreens = {
  synthesis: Synthesis,
  courseware: Courseware,
  assessments: Assessments,
};
const legacyCoursewareRoutes = ["curriculum", "materials", "content-list"];
function currentPage(): Page {
  const part = location.pathname.split("/")[2];
  if (part === "packages" && location.search) history.replaceState({}, "", "/teacher/packages");
  if (part === "content-review") {
    const params = new URLSearchParams(location.search);
    const rawMaterial = params.get("material_id") ?? "";
    const id = Number(rawMaterial);
    const initialReview = { materialId: /^\d+$/.test(rawMaterial) && Number.isSafeInteger(id) && id > 0 ? id : undefined };
    history.replaceState({ ...history.state, initialReview }, "", "/teacher/content-graph?" + params);
    return "content-graph";
  }
  if (part === "classroom") {
    const url = new URL(location.href);
    url.pathname = "/teacher/classes";
    history.replaceState(history.state, "", url);
    return "classes";
  }
  if (part === "questions" || legacyCoursewareRoutes.includes(part)) {
    const url = new URL(location.href);
    const next = part === "questions" || url.searchParams.get("tab") === "questions" ? "assessments" : "courseware";
    url.pathname = `/teacher/${next}`;
    if (next === "assessments") url.searchParams.set("tab", "bank");
    else url.searchParams.delete("tab");
    history.replaceState(history.state, "", url);
    return next;
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
function SidebarGroup({ id, label, icon: Icon, active, sidebar, expandSidebar, children }: {
  id: string; label: string; icon: typeof Settings; active: boolean; sidebar: boolean;
  expandSidebar: () => void; children: ReactNode;
}) {
  const [open, setOpen] = useState(active);
  const expanded = sidebar && open;
  return <div className="nav-group">
    <button type="button" className="nav-group-trigger" aria-label={label} title={sidebar ? undefined : label}
      aria-expanded={expanded} aria-controls={id} data-current={active || undefined}
      onClick={() => { if (!sidebar) expandSidebar(); setOpen(!expanded); }}>
      <Icon size={18} aria-hidden/><span className="nav-text">{label}</span>
      <ChevronDown size={15} aria-hidden className="group-chevron"/>
    </button>
    <div className="nav-children" id={id} hidden={!expanded}>{children}</div>
  </div>;
}
function Workbench() {
  const [user, setUser] = useState<User | null>(null),
    [classes, setClasses] = useState<Classroom[] | null>(null),
    [requestedClass, setRequestedClass] = useState(Number(new URLSearchParams(location.search).get("class")) || null),
    [loading, setLoading] = useState(Boolean(token())),
    [error, setError] = useState(""),
    [page, setPage] = useState<Page>(currentPage),
    [passwordOpen, setPasswordOpen] = useState(false),
    [newClass, setNewClass] = useState(false),
    [className, setClassName] = useState(""),
    [courseId, setCourseId] = useState(Number(new URLSearchParams(location.search).get("course"))),
    [busy, setBusy] = useState(false),
    [openingTown, setOpeningTown] = useState(false),
    [sidebar, setSidebar] = useState(() => !window.matchMedia?.("(max-width: 700px)").matches);
  const [classError, setClassError] = useState("");
  const [classListRevision, setClassListRevision] = useState(0);
  const [packageRevision, setPackageRevision] = useState(0);
  const [exporting, setExporting] = useState<number | null>(null);
  async function exportCourse(course: CourseInstance) {
    if (exporting !== null) return;
    const session = token();
    setExporting(course.id);
    try {
      await api.get(`/teacher/courses/${course.id}/export`);
      if (session === token()) {
        setPackageRevision(value => value + 1);
        toast.add({ title: "课程包已导出", type: "success" });
      }
    } catch (err) {
      if (session === token()) toast.add({ title: errorMessage(err), type: "error" });
    } finally { setExporting(null); }
  }
  const canLeave = useCanLeave();
  const courses = useResource<CourseInstance[]>(user && !user.must_change_password ? "/teacher/courses" : null);
  const course = courses.data?.find(row => row.id === courseId);
  const inCourse = (classes ?? []).filter(row => row.course_id === courseId).sort((a, b) => a.id - b.id);
  const storageKey = user && courseId ? `classroom:${user.id}:${courseId}` : null;
  const remembered = storageKey ? Number(sessionStorage.getItem(storageKey)) : null;
  const classroom = inCourse.find(row => row.id === requestedClass) ?? inCourse.find(row => row.id === remembered) ?? inCourse[0];
  const classroomId = classroom?.id ?? null;
  const classPage = ["students", "teaching", "judge", "details", "grades"].includes(page);
  const usesClassPicker = classPage || page === "activities";
  useEffect(() => {
    if (!classroomId || !storageKey || !usesClassPicker) return;
    sessionStorage.setItem(storageKey, String(classroomId));
    const url = new URL(location.href);
    if (url.searchParams.get("class") !== String(classroomId)) {
      url.searchParams.set("class", String(classroomId));
      history.replaceState(history.state, "", url);
    }
  }, [classroomId, usesClassPicker, storageKey, requestedClass, page]);
  function pageUrl(next: Page, cid = courseId, room: number | null = classroomId) {
    if (!courseNav.some(item => item.key === next)) return `/teacher/${next}`;
    return `/teacher/${next}?course=${cid}${room ? "&class=" + room : ""}`;
  }
  function selectCourse(id: number) {
    if (!canLeave()) return;
    setCourseId(id); setRequestedClass(null);
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
              if (u.role !== "admin" && globalNav.some(item => item.key === location.pathname.split("/")[2]))
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
      setClasses(null);
      setRequestedClass(null);
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
    setClassError("");
    const controller = new AbortController();
    const captured = token();
    api
      .get<Classroom[]>("/classrooms", controller.signal)
      .then((rows) => {
        if (controller.signal.aborted || captured !== token()) return;
        setClasses(rows);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setClassError(errorMessage(e));
      });
    return () => controller.abort();
  }, [user?.id, user?.must_change_password, classListRevision]);
  useEffect(() => {
    const pop = () => {
      if (canLeave()) {
        const next = currentPage();
        setCourseId(Number(new URLSearchParams(location.search).get("course")));
        setRequestedClass(Number(new URLSearchParams(location.search).get("class")) || null);
        setPage(user?.role !== "admin" && globalNav.some(item => item.key === next) ? returnToCourses() : next);
      }
      else history.pushState({}, "", pageUrl(page));
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [canLeave, page, user?.role]);
  function navigate(next: Page) {
    if (next !== page && !canLeave()) return;
    if (window.matchMedia?.("(max-width: 700px)").matches) setSidebar(false);
    if (next === page) return;
    history.pushState({}, "", pageUrl(next));
    setPage(next);
    if (next === "courses") courses.reload();
  }
  function changeClass(id: number) {
    if (id === classroomId || !canLeave()) return;
    setRequestedClass(id);
    const url = new URL(pageUrl(page, courseId, id), location.origin);
    const chapter = page === "activities" && new URLSearchParams(location.search).get("chapter");
    if (chapter) url.searchParams.set("chapter", chapter);
    history.pushState({}, "", url);
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
      setClasses((v) => [...(v ?? []), row]);
      setClassName("");
      setNewClass(false);
      setRequestedClass(row.id);
      history.pushState({}, "", pageUrl("students", courseId, row.id));
      setPage("students");
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
      setClasses(null);
      setRequestedClass(null);
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
  const isAdmin = user.role === "admin";
  const globalPage = globalNav.find(item => item.key === page);

  const allowed = !globalPage || isAdmin;
  async function openClass(id: number) {
    if (!user || !canLeave()) return;
    const session = token();
    let room = classes?.find(row => row.id === id);
    if (!room) {
      try {
        const rows = await api.get<Classroom[]>("/classrooms");
        if (session !== token()) return;
        setClasses(rows);
        room = rows.find(row => row.id === id);
      } catch (e) {
        if (session === token()) setError(errorMessage(e));
        return;
      }
    }
    if (!room) { setError("此班级已无法访问，请刷新列表。"); return; }
    setRequestedClass(id);
    setCourseId(room.course_id);
    history.pushState({}, "", pageUrl("students", room.course_id, id));
    setPage("students");
  }
  type NavItem = (typeof globalNav | typeof courseNav)[number];
  function navLink({ key, title, icon: Icon }: NavItem, active: boolean) {
    return <a key={key} href={pageUrl(key)} aria-label={title} title={sidebar ? undefined : title} aria-current={active ? (key === page ? "page" : "location") : undefined}
      onClick={event => { event.preventDefault(); navigate(key); }}><Icon size={18} aria-hidden /><span className="nav-text">{title}</span></a>;
  }
  function link(item: NavItem) { return navLink(item, item.key === page); }
  function renderPage() {
    if (!allowed) return <ErrorNotice message="此页面仅管理员可访问。" />;
    switch (page) {
      case "classes":
        if (!course) break;
        return <ClassroomManagement courseId={course.id} isAdmin={isAdmin} onOpen={openClass}
          onCreate={() => setNewClass(true)} onChanged={() => setClassListRevision(value => value + 1)} />;
      case "teachers":
      case "accounts":
        return <Accounts role={page === "teachers" ? "teacher" : "student"} onChanged={() => setClassListRevision(value => value + 1)} />;
      case "overview":
        return <GlobalOverview onOpen={openClass} />;
      case "global-synthesis":
        return <Synthesis />;
      case "global-judge":
        return <Judge canManage />;
      case "system":
        return <GlobalSettings />;
    }
    if (!course) return courses.loading ? <Loading/> : <Empty title="课程不存在或无法访问" />;
    if (page === "insights") return <InsightsPage courseId={course.id} onOpenClassAnalytics={(roomId, target) => {
      if (!canLeave()) return;
      setRequestedClass(roomId);
      history.pushState({}, "", pageUrl(target, course.id, roomId));
      setPage(target);
    }}/>;
    if (page === "activities") return <LearningTasks courseId={course.id} classroomId={classroomId} />;
    if (classPage && classError) return <><ErrorNotice message={classError}/><Button variant="outline" onClick={() => setClassListRevision(v => v + 1)}>重新加载班级</Button></>;
    if (classPage && classes === null) return <Loading/>;
    if (classPage && !classroom) return <div className="surface">
      <Empty title="本课程尚未创建班级" />
      <div className="flex justify-center pb-8"><Button onClick={() => setNewClass(true)}>创建班级</Button></div>
    </div>;
    if (page === "students") return <><ButtonLink href={pageUrl("classes")} variant="ghost" className="mb-3" onClick={e => { e.preventDefault(); navigate("classes"); }}><ChevronLeft/>返回班级列表</ButtonLink><Students classroomId={classroom!.id}/></>;
    if (page === "details") return <TaskDetailsPage classroomId={classroom!.id} />;
    if (page === "grades") return <GradesPage classroomId={classroom!.id} classroomName={classroom!.name} onOpenJudge={() => navigate("judge")} />;
    if (page === "teaching") return <Teaching classroomId={classroom!.id} courseId={course.id}/>;
    if (page === "judge") return <Judge classroomId={classroom!.id} canManage={false} />;
    if (page === "content-graph") {
      const entry = history.state;
      const initialReview = entry?.initialReview && entry.courseGraph && entry.courseGraph.courseId !== course.id
        ? {} : entry?.initialReview;
      return <KnowledgeGraph courseId={course.id} initialReview={initialReview} />;
    }
    if (!(page in courseScreens)) return null;
    const Screen = courseScreens[page as keyof typeof courseScreens];
    return <Screen courseId={course.id} />;
  }
  function group(id: string, label: string, icon: typeof Settings, items: typeof statisticsNav | typeof settingsNav) {
    const active = items.some(item => item.key === page);
    return <SidebarGroup key={`${courseId}:${id}:${active}`} id={id} label={label} icon={icon}
      active={active} sidebar={sidebar} expandSidebar={() => setSidebar(true)}>{items.map(link)}</SidebarGroup>;
  }
  const hub = page === "courses" || page === "packages";
  const brand = (<a
          href="/teacher/"
          className="brand"
          aria-label="Pythontopia 教学工作台" title={!sidebar && !hub ? "教学工作台" : undefined}
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
        </a>);
  const accountMenu = (<DropdownMenu>
            <DropdownMenuTrigger render={<button className="account" aria-label={!hub && !sidebar ? `${user.name}，账号菜单` : undefined} title={!hub && !sidebar ? `${user.name}，账号菜单` : undefined} />}>
              {!hub && <span className="avatar" aria-hidden>{user.name.slice(0, 1)}</span>}
              <span>
                {hub ? `欢迎，${user.name}！` : user.name}
                {!hub && <small>{user.role === "admin" ? "管理员" : "教师"}</small>}
              </span>
              <ChevronDown size={15} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align={hub ? "end" : "start"}>
              <DropdownMenuItem onClick={() => setPasswordOpen(true)}>
                <KeyRound />
                修改密码
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onClick={() => void logout()}>
                <LogOut />
                退出账号
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>);
  const myCourses = courses.data?.filter(row => row.teacher_id === user.id) ?? [];
  return (
    <>
    {hub ? <main className="course-hub">
      <header className="hub-header">{brand}<div className="hub-actions">
        {accountMenu}
        {isAdmin && <ButtonLink href="/teacher/overview" variant="outline" onClick={e => { e.preventDefault(); navigate("overview"); }}><LayoutDashboard/>进入后台</ButtonLink>}

      </div></header>
      <ErrorNotice message={error}/>
      <Tabs value={page} onValueChange={value => navigate(value === "packages" ? "packages" : "courses")}>
        <TabsList aria-label="教学工作台">{hubNav.map(item => <TabsTrigger key={item.key} value={item.key}>{item.title}</TabsTrigger>)}</TabsList>
        <TabsContent value="courses"><CoursePicker classes={classes ?? []} exportCourse={exportCourse} exporting={exporting} courses={courses} items={myCourses} onOpen={selectCourse} admin={isAdmin}/></TabsContent>
        <TabsContent value="packages"><Packages revision={packageRevision} courses={myCourses} onCreated={courses.reload}/></TabsContent>
      </Tabs>
    </main> : <div className={`workbench ${sidebar ? "" : "sidebar-collapsed"}`}>
      {sidebar && <button className="sidebar-backdrop" aria-label="关闭导航菜单" onClick={() => setSidebar(false)} />}
      <aside id="workbench-sidebar" className="sidebar">
        {brand}
        <div className="sidebar-scroll">
          <div className="sidebar-return"><a href="/teacher/courses" aria-label="返回课程选择" title={sidebar ? undefined : "返回课程选择"} onClick={e => { e.preventDefault(); navigate("courses"); }}><ChevronLeft size={18} aria-hidden/><span className="nav-text">返回课程选择</span></a></div>
          {globalPage && isAdmin && <nav aria-label="工作台导航">{globalNav.map(link)}</nav>}
          {course && !globalPage && <nav aria-label="课程导航">
            {navLink(classNav[0], page === "classes" || page === "students")}
            {group("statistics-nav", "学情统计", ChartNoAxesCombined, statisticsNav)}
            {link(classNav[1])}
            <p className="nav-label">课程内容</p>{contentNav.map(link)}
            <div className="course-settings-nav">{group("settings-nav", "设置", Settings, settingsNav)}</div>
          </nav>}
        </div>
        <div className="sidebar-bottom">
          {accountMenu}
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
          {usesClassPicker && classroom && <div className="class-picker">
            <span className="class-picker-label">当前班级</span>
            {inCourse.length === 1 ? <span aria-label="当前班级">{classroom.name}</span> : <SelectField aria-label="当前班级"
              id="active-class"
              disabled={busy || inCourse.length === 0}
              value={classroomId ?? ""}
              onValueChange={(value) => changeClass(Number(value))}
            >
              {inCourse.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectField>}
          </div>}
          {classPage && classroom && <Button
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
        <main className={course && page === "content-graph" ? "main-content graph-main"
          : course && page === "courseware" ? "main-content courseware-main" : "main-content"}>
          <ErrorNotice message={error} />
          <Suspense key={`${user.id}:${classPage ? classroomId : courseId}:${page}`} fallback={<Loading />}>
            <TablePreferences>{renderPage()}</TablePreferences>
          </Suspense>
        </main>
      </div>
    </div>}
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
    </>
  );
}
