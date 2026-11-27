import type { OnboardingClassroom, OnboardingSummary } from "./course-guide";

export function GuideScene({
  step,
  data,
  classroom,
  completedCount = 0,
  totalSteps = 7,
}: {
  step: number;
  data: OnboardingSummary;
  classroom: OnboardingClassroom | null;
  completedCount?: number;
  totalSteps?: number;
}) {
  switch (step) {
    case 0:
      return (
        <div className="scene-float flex flex-col items-center gap-2.5" aria-hidden="true">
          <div className="scene-pop flex items-center gap-3 rounded-2xl border border-emerald-900/10 bg-white px-5 py-3.5 shadow-sm">
            <span className="grid size-10 place-items-center rounded-xl bg-emerald-950 text-sm font-semibold text-white">
              {classroom ? classroom.name.slice(0, 2) : "班级"}
            </span>
            <div className="text-left">
              <div className="text-xs text-muted-foreground">教学班级铭牌</div>
              <div className="text-sm font-semibold text-foreground">
                {classroom ? classroom.name : "新建教学班"}
              </div>
            </div>
            <span className="ml-2 rounded-lg bg-emerald-50 px-2.5 py-1 font-mono text-xs font-semibold tracking-wider text-emerald-800">
              {classroom ? classroom.join_code : "JOIN-CODE"}
            </span>
          </div>
          <div className="scene-pop-2 flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-1 text-[11px] text-muted-foreground shadow-2xs">
            <span className="size-2 rounded-full bg-emerald-500" />
            {classroom ? "班级加入码已就绪" : "一键生成专属班级加入码"}
          </div>
        </div>
      );

    case 1:
      return (
        <div className="flex items-center gap-3" aria-hidden="true">
          <div className="flex flex-col gap-2">
            {[
              { id: "20260001", name: "张同学", cls: "scene-pop" },
              { id: "20260002", name: "李同学", cls: "scene-pop-1" },
              { id: "20260003", name: "王同学", cls: "scene-pop-2" },
            ].map((item) => (
              <div
                key={item.id}
                className={`${item.cls} flex items-center gap-2 rounded-xl border border-black/6 bg-white px-3 py-1.5 text-xs shadow-2xs`}
              >
                <span className="grid size-5 place-items-center rounded-full bg-emerald-100 text-[10px] font-semibold text-emerald-900">
                  {item.name.slice(0, 1)}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{item.id}</span>
                <span className="font-medium">{item.name}</span>
              </div>
            ))}
          </div>
          <svg width="34" height="24" viewBox="0 0 34 24" fill="none" className="scene-pop-2 text-emerald-700">
            <path d="M3 12h24m0 0-6-6m6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="scene-float scene-pop-3 flex flex-col items-center rounded-2xl border border-emerald-900/10 bg-white px-4 py-3 shadow-sm">
            <span className="text-xl font-bold tabular-nums text-emerald-900">{data.student_count}</span>
            <span className="text-[11px] text-muted-foreground">在籍学生</span>
            {classroom && (
              <span className="mt-1.5 rounded bg-emerald-50 px-2 py-0.5 font-mono text-[10px] font-semibold text-emerald-800">
                {classroom.join_code}
              </span>
            )}
          </div>
        </div>
      );

    case 2:
      return (
        <div className="relative flex items-center justify-center" aria-hidden="true">
          <div className="scene-pop -rotate-6 translate-x-3 rounded-xl border border-black/8 bg-white px-3.5 py-3 shadow-xs">
            <div className="rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">PDF</div>
            <div className="mt-2 h-1.5 w-12 rounded-full bg-muted" />
            <div className="mt-1 h-1.5 w-9 rounded-full bg-muted" />
          </div>
          <div className="scene-float scene-pop-1 z-10 -translate-y-1.5 rounded-2xl border border-emerald-900/12 bg-white px-4 py-3.5 shadow-md">
            <div className="rounded bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">PPTX 课件</div>
            <div className="mt-2.5 h-2 w-16 rounded-full bg-emerald-900/15" />
            <div className="mt-1.5 h-1.5 w-12 rounded-full bg-muted" />
            <div className="mt-2 text-[11px] font-semibold tabular-nums text-emerald-800">
              {data.chapter_count} 章 · {data.ready_material_count} 份
            </div>
          </div>
          <div className="scene-pop-2 rotate-6 -translate-x-3 rounded-xl border border-black/8 bg-white px-3.5 py-3 shadow-xs">
            <div className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">MP4</div>
            <div className="mt-2 h-1.5 w-12 rounded-full bg-muted" />
            <div className="mt-1 h-1.5 w-8 rounded-full bg-muted" />
          </div>
        </div>
      );

    case 3:
      return (
        <div className="flex items-center gap-4" aria-hidden="true">
          <div className="scene-pop flex flex-col items-center gap-2 rounded-2xl border border-black/8 bg-white px-4 py-3 shadow-xs">
            <div className="flex h-8 items-end gap-1">
              {[0, 180, 320, 120, 260, 420, 160].map((delay, idx) => (
                <span
                  key={idx}
                  style={{ animationDelay: `${delay}ms` }}
                  className="scene-wave-bar w-1.5 rounded-full bg-emerald-700 h-7"
                />
              ))}
            </div>
            <span className="text-[11px] font-medium text-muted-foreground">
              讲稿 {data.narration_accepted_pages} · 配音 {data.audio_ready_pages}
            </span>
          </div>
          <svg width="112" height="84" viewBox="0 0 112 84" className="scene-float scene-pop-2">
            <line x1="26" y1="42" x2="78" y2="20" stroke="#9ab3a2" strokeWidth="2" />
            <line x1="26" y1="42" x2="78" y2="64" stroke="#9ab3a2" strokeWidth="2" />
            <circle cx="26" cy="42" r="14" className="scene-pulse-ring" fill="#2f7d4f" />
            <circle cx="26" cy="42" r="11" fill="#202c23" />
            <circle cx="78" cy="20" r="9" fill="#2f7d4f" />
            <circle cx="78" cy="64" r="9" fill="#2f7d4f" />
            <text x="78" y="46" textAnchor="middle" fontSize="11" fill="#3a4a3e" fontWeight="600">
              {data.knowledge_point_count} 知识点
            </text>
          </svg>
        </div>
      );

    case 4:
      return (
        <div className="flex items-center gap-3" aria-hidden="true">
          <div className="scene-float scene-pop rounded-2xl border border-black/8 bg-white px-4 py-3 text-left shadow-sm">
            <div className="text-[11px] font-semibold text-muted-foreground">客观题 · AI 出题</div>
            <div className="mt-2 flex items-center gap-2 text-xs">
              <span className="grid size-4 place-items-center rounded-full bg-emerald-600 text-[10px] text-white">✓</span>
              <span className="font-medium">A. print("你好")</span>
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="size-4 rounded-full border" />
              <span>B. echo "你好"</span>
            </div>
          </div>
          <div className="scene-float-delayed scene-pop-2 rounded-2xl border border-emerald-950/15 bg-emerald-950 px-4 py-3 text-left font-mono text-xs text-emerald-100 shadow-sm">
            <div className="text-[10px] text-emerald-400"># Python 编程题</div>
            <div className="mt-1.5">def greet(name):</div>
            <div className="pl-3 text-emerald-300">return f"你好, &#123;name&#125;"</div>
          </div>
        </div>
      );

    case 5:
      return (
        <div className="scene-pop flex items-center gap-2.5" aria-hidden="true">
          {[
            { label: "必读资料", count: `${data.required_reading_count} 项`, done: data.required_reading_count > 0 },
            { label: "课堂练习", count: `${data.published_practice_count} 组`, done: data.published_practice_count > 0 },
            { label: "单元测验", count: `${data.published_assessment_count} 份`, done: data.published_assessment_count > 0 },
          ].map((stage, i) => (
            <div key={stage.label} className="flex items-center gap-2.5">
              <div
                className={`scene-pop-${i + 1} flex flex-col items-center rounded-2xl border px-3.5 py-3 shadow-2xs ${
                  stage.done ? "border-emerald-300 bg-white" : "border-black/8 bg-white/80"
                }`}
              >
                <span
                  className={`grid size-6 place-items-center rounded-full text-xs font-semibold ${
                    stage.done ? "bg-emerald-700 text-white" : "bg-muted text-muted-foreground"
                  }`}
                >
                  {stage.done ? "✓" : i + 1}
                </span>
                <span className="mt-1.5 text-xs font-semibold">{stage.label}</span>
                <span className="text-[11px] text-muted-foreground">{stage.count}</span>
              </div>
              {i < 2 && <span className="h-0.5 w-4 rounded-full bg-emerald-800/25" />}
            </div>
          ))}
        </div>
      );

    case 6:
      return (
        <div className="relative flex flex-col items-center gap-2" aria-hidden="true">
          <svg width="76" height="76" viewBox="0 0 64 64" fill="none" className="scene-pop">
            <circle cx="32" cy="36" r="24" className="scene-pulse-ring" fill="#2f7d4f" />
            <path
              d="M22 28V20a10 10 0 0 1 20 0"
              stroke="#24663f"
              strokeWidth="3.5"
              strokeLinecap="round"
              className="scene-shackle-open"
            />
            <rect x="16" y="28" width="32" height="24" rx="7" fill="#202c23" />
            <circle cx="32" cy="39" r="3" fill="#a7f3d0" />
            <path d="M32 42v4" stroke="#a7f3d0" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          <span className="scene-pop-2 rounded-full bg-white px-3.5 py-1 text-xs font-medium text-emerald-900 shadow-2xs">
            {data.open_chapter_count + data.scheduled_chapter_count > 0
              ? `已安排开放 ${data.open_chapter_count + data.scheduled_chapter_count} 章`
              : "解锁后学生即可进入小镇开启章节"}
          </span>
        </div>
      );

    default:
      return (
        <div className="flex flex-col items-center gap-2" aria-hidden="true">
          <svg width="84" height="84" viewBox="0 0 84 84" fill="none">
            <circle cx="42" cy="42" r="33" stroke="#e3ebe5" strokeWidth="5" />
            <circle
              cx="42"
              cy="42"
              r="33"
              stroke="#24663f"
              strokeWidth="5"
              strokeLinecap="round"
              transform="rotate(-90 42 42)"
              className="scene-ring-draw"
            />
            <path
              d="M28 43.5 37.5 53 57 32.5"
              stroke="#24663f"
              strokeWidth="5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="scene-check-draw"
            />
          </svg>
          <span className="scene-pop-2 text-xs font-medium text-emerald-800">
            已完成 {completedCount} / {totalSteps} 项开课配置
          </span>
        </div>
      );
  }
}
