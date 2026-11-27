import { useMemo, useState } from "react";
import { Check, Download, Mic, Sparkles, Timer, Volume2 } from "lucide-react";
import { ErrorNotice, Loading } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { MyVoicesDialog } from "@/features/voices/my-voices-dialog";
import { errorMessage } from "@/lib/api";
import { SPEECH_INSTRUCTION_PRESETS } from "@/lib/voice-api";
import {
  courseStudioApi,
  type KnowledgePointItem,
  type PacingPreview,
  type ScriptStylePreset,
} from "@/lib/course-studio-api";
import { CalibrationPanel } from "./calibration-panel";
import { JobProgressBar } from "./job-progress-bar";
import { NarrationPageEditor } from "./page-editor";
import { NarrationPagePreview, NarrationSourceInspector } from "./page-preview";
import { buildSlidePageGroups, SlidePageRail, type SlideRailMode } from "./slide-page-rail";
import { usePageMedia } from "./use-page-media";
import { useNarrationReview } from "./use-review";

export type WorkbenchMode = "full" | "source" | "script";

export function NarrationWorkbench({
  courseId,
  materialId,
  title,
  initialPage,
  mode = "full",
  materialPoints = [],
  onOpenKnowledgeTab,
  onKnowledgeUpdated,
  jumpTarget,
}: {
  courseId: number;
  materialId: number;
  title: string;
  initialPage?: number;
  mode?: WorkbenchMode;
  materialPoints?: KnowledgePointItem[];
  onOpenKnowledgeTab?: () => void;
  onKnowledgeUpdated?: () => void;
  jumpTarget?: { pageNo: number; seq: number } | null;
}) {
  const review = useNarrationReview(courseId, materialId, initialPage, jumpTarget, onKnowledgeUpdated);
  const {
    data,
    quota,
    report,
    audioState,
    pageNo,
    setPageNo,
    busy,
    error,
    job,
    page,
    saved,
    runPipeline,
    acceptAllDrafts,
    synthesizeAllAudio,
    retryFailedJob,
    busyNow,
    stylePreset,
    setStylePreset,
    customStyle,
    setCustomStyle,
    usePacing,
    setUsePacing,
    sectionMinutes,
    setSectionMinutes,
    chapterMinutes,
    setChapterMinutes,
    myVoices,
    reloadVoices,
    selectMaterialVoice,
    speechStyleDirty,
    load,
  } = review;
  const media = usePageMedia(courseId, materialId, pageNo, saved);
  const [tab, setTab] = useState("review");
  const [railMode, setRailMode] = useState<SlideRailMode>("knowledge");
  const [exporting, setExporting] = useState(false);
  const [pacingInfo, setPacingInfo] = useState<PacingPreview | null>(null);
  const [pacingBusy, setPacingBusy] = useState(false);
  const [voicesOpen, setVoicesOpen] = useState(false);
  const [mismatchConfirmOpen, setMismatchConfirmOpen] = useState(false);
  const [customInstructionOpen, setCustomInstructionOpen] = useState(false);
  const [customInstructionDraft, setCustomInstructionDraft] = useState("");

  const readyMyVoices = useMemo(() => myVoices.filter((v) => v.status === "ready"), [myVoices]);
  const voiceSelectValue =
    audioState?.voice_mode === "custom" && audioState.selected_voice_id
      ? `custom:${audioState.selected_voice_id}`
      : audioState?.voice_mode === "system"
        ? "system"
        : "auto";
  const currentVoiceMode = audioState?.voice_mode ?? "auto";
  const currentVoiceId = currentVoiceMode === "custom" ? (audioState?.selected_voice_id ?? null) : null;
  const defaultPersonalVoice = readyMyVoices.find((v) => v.is_default);
  const mismatchedCount = audioState?.mismatched_count ?? 0;
  const readyAudioCount = audioState?.pages.filter((p) => p.ready).length ?? 0;
  const instructionPresets = audioState?.instruction_presets ?? SPEECH_INSTRUCTION_PRESETS;
  const instructionSelectValue = useMemo(() => {
    const raw = audioState?.speech_instruction;
    if (raw === undefined || raw === null) return "inherit";
    if (raw === "") return "none";
    const matched = instructionPresets.find((p) => p.text === raw);
    return matched ? `preset:${matched.id}` : "custom";
  }, [audioState?.speech_instruction, instructionPresets]);
  const speedSelectValue =
    audioState?.speech_speed !== undefined && audioState.speech_speed !== null
      ? String(audioState.speech_speed)
      : "inherit";

  function handleVoiceSelection(value: string) {
    if (value === "__manage__") {
      setVoicesOpen(true);
      return;
    }
    if (value === "auto" || value === "system") {
      void selectMaterialVoice(value, null);
      return;
    }
    if (value.startsWith("custom:")) {
      const id = Number(value.slice("custom:".length));
      if (Number.isFinite(id) && id > 0) {
        void selectMaterialVoice("custom", id);
      }
    }
  }

  function handleInstructionSelection(value: string) {
    if (value === "custom") {
      setCustomInstructionDraft(audioState?.effective_instruction || "");
      setCustomInstructionOpen(true);
      return;
    }
    setCustomInstructionOpen(false);
    if (value === "inherit") {
      void selectMaterialVoice(currentVoiceMode, currentVoiceId, {
        speechInstruction: null,
        note: "朗读语气已恢复跟随全站默认",
      });
      return;
    }
    if (value === "none") {
      void selectMaterialVoice(currentVoiceMode, currentVoiceId, {
        speechInstruction: "",
        note: "已关闭本课件朗读风格指令",
      });
      return;
    }
    if (value.startsWith("preset:")) {
      const id = value.slice("preset:".length);
      const preset = instructionPresets.find((p) => p.id === id);
      if (preset) {
        void selectMaterialVoice(currentVoiceMode, currentVoiceId, {
          speechInstruction: preset.text,
          note: `已切换朗读语气为「${preset.label}」`,
        });
      }
    }
  }

  function handleSpeedSelection(value: string) {
    if (value === "inherit") {
      void selectMaterialVoice(currentVoiceMode, currentVoiceId, {
        speechSpeed: null,
        note: "语速已恢复跟随全站默认",
      });
      return;
    }
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0.5 && num <= 2.0) {
      void selectMaterialVoice(currentVoiceMode, currentVoiceId, {
        speechSpeed: num,
        note: `已将本课件合成语速设为 ${num}x`,
      });
    }
  }

  function handleSynthesizeAllClick() {
    if (mismatchedCount > 0 || (speechStyleDirty && readyAudioCount > 0)) {
      setMismatchConfirmOpen(true);
      return;
    }
    void synthesizeAllAudio();
  }

  const calibrationCount = (report?.fixes?.length ?? 0) + (report?.issues?.length ?? 0);

  const pointsByPage = useMemo(() => {
    const map = new Map<number, KnowledgePointItem[]>();
    for (const pt of materialPoints) {
      const src = pt.sources.find((s) => s.material_id === materialId);
      if (!src) continue;
      for (const p of src.pages) {
        const list = map.get(p) ?? [];
        list.push(pt);
        map.set(p, list);
      }
    }
    return map;
  }, [materialPoints, materialId]);
  const { groups: slideGroups, hasKnowledgeGroups } = useMemo(
    () => buildSlidePageGroups(data?.pages ?? [], materialPoints, materialId),
    [data?.pages, materialPoints, materialId],
  );
  const currentPagePoints = page ? (pointsByPage.get(page.page_no) ?? []) : [];

  async function handleExport(kind: "source" | "script", fmt: "docx" | "md") {
    setExporting(true);
    try {
      await courseStudioApi.exportMaterial(courseId, materialId, kind, fmt, title);
      toast.add({ title: `已导出${kind === "source" ? "整理稿" : "口播讲稿"}`, type: "success" });
    } catch (e) {
      toast.add({ title: errorMessage(e), type: "error" });
    } finally {
      setExporting(false);
    }
  }

  async function checkPacing() {
    setPacingBusy(true);
    try {
      const res = await courseStudioApi.previewPacing(courseId, materialId, sectionMinutes, chapterMinutes);
      setPacingInfo(res);
    } catch (e) {
      toast.add({ title: errorMessage(e), type: "error" });
    } finally {
      setPacingBusy(false);
    }
  }

  if (!data || busy === "load") return <><ErrorNotice message={error} /><Loading /></>;

  const fullHeight = mode !== "full";
  const groupedRail = hasKnowledgeGroups && railMode === "knowledge";

  const pageList = (
    <SlidePageRail
      pages={data.pages}
      pageNo={pageNo}
      onSelectPage={setPageNo}
      pointsByPage={pointsByPage}
      groups={slideGroups}
      hasKnowledgeGroups={hasKnowledgeGroups}
      railMode={railMode}
      onRailModeChange={setRailMode}
      fullHeight={fullHeight}
    />
  );

  const showSourceExport = mode === "source" || mode === "full";
  const showScriptExport = mode === "script" || mode === "full";

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(String(value))}
      className={fullHeight ? "flex flex-1 min-h-0 flex-col gap-2 overflow-hidden" : "space-y-3"}
    >
      <ErrorNotice message={error} />

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b pb-2">
        <Button
          size="xs"
          disabled={!quota?.available || busyNow}
          onClick={() => {
            if (
              !window.confirm(
                `将依次整理原文、校准、生成全部 ${data.coverage.pages} 页讲解并抽取知识点；已完成的阶段和页不会重复计费。继续？`,
              )
            )
              return;
            void runPipeline();
          }}
        >
          <Sparkles /> {busy === "pipeline" ? "正在梳理…" : "一键梳理文本"}
        </Button>
        {mode !== "source" && (
          <Button
            size="xs"
            variant="outline"
            disabled={busyNow || audioState?.available === false || data.coverage.accepted === 0}
            onClick={handleSynthesizeAllClick}
          >
            <Volume2 />{" "}
            {busy === "audio-all"
              ? "生成中…"
              : mismatchedCount > 0
                ? `生成全文配音（${mismatchedCount} 页旧音色）`
                : "生成全文配音"}
          </Button>
        )}
        {(mode !== "source" || data.coverage.draft > 0) && (
          <Button
            size="xs"
            variant={data.coverage.draft > 0 ? "secondary" : "outline"}
            disabled={busyNow || data.coverage.draft === 0}
            title="一键接受全部待审讲稿，无需逐页点击确认"
            onClick={() => void acceptAllDrafts()}
          >
            <Check /> {busy === "accept-all" ? "接受中…" : `一键接受全部草稿（${data.coverage.draft}）`}
          </Button>
        )}
        {showSourceExport && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="xs" variant="outline" disabled={exporting} />}>
              <Download /> 导出整理稿
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => void handleExport("source", "docx")}>Word 文档 (.docx)</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void handleExport("source", "md")}>Markdown (.md)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {showScriptExport && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="xs" variant="outline" disabled={exporting} />}>
              <Download /> 导出讲稿
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => void handleExport("script", "docx")}>Word 文档 (.docx)</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void handleExport("script", "md")}>Markdown (.md)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          <Badge variant="secondary" className="h-5 px-1.5 text-[11px] font-normal">共 {data.coverage.pages} 页</Badge>
          {mode === "source" && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[11px] font-normal">
              已整理 {data.pages.filter((p) => Boolean(p.digest?.text?.trim())).length}
            </Badge>
          )}
          <Badge variant="secondary" className="h-5 px-1.5 text-[11px] font-normal">已生成 {data.coverage.covered}</Badge>
          <Badge variant="secondary" className="h-5 px-1.5 text-[11px] font-normal">待审 {data.coverage.draft}</Badge>
          <Badge variant="secondary" className="h-5 px-1.5 text-[11px] font-normal">已接受 {data.coverage.accepted}</Badge>
          {data.coverage.stale > 0 && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[11px] font-normal">已失效 {data.coverage.stale}</Badge>
          )}
          {!fullHeight && data.coverage.missing > 0 && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[11px] font-normal">未生成 {data.coverage.missing}</Badge>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {quota && (
            <span className={fullHeight ? "hint hidden text-[11px] 2xl:inline" : "hint text-xs"}>
              今日已生成 {quota.used_today} / {quota.daily_limit}
              {!quota.available && " · 作者期模型未配置，暂不可生成"}
            </span>
          )}
          <TabsList variant="default" className="h-7">
            <TabsTrigger value="review" className="px-2 text-xs">
              {mode === "source" ? `整理对照（${data.coverage.pages}）` : `审校（${data.coverage.covered}/${data.coverage.pages}）`}
            </TabsTrigger>
            <TabsTrigger value="calibration" className="px-2 text-xs">
              校准{calibrationCount ? ` · ${calibrationCount}` : ""}
            </TabsTrigger>
          </TabsList>
        </div>
      </div>

      {mode !== "source" && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 rounded-md border bg-muted/20 px-3 py-1.5 text-xs">
          <div className="flex items-center gap-2">
            <Label htmlFor="narration-style" className="text-xs font-medium">授课风格</Label>
            <SelectField
              id="narration-style"
              value={stylePreset}
              onValueChange={(v) => setStylePreset(v as ScriptStylePreset)}
              className="h-7 w-28 text-xs"
            >
              <option value="natural">自然授课</option>
              <option value="concise">精炼干货</option>
              <option value="conversational">启发互动</option>
            </SelectField>
          </div>
          <Input
            aria-label="补充风格要求"
            placeholder="可选：补充口吻或举例要求"
            className="h-7 w-48 text-xs"
            value={customStyle}
            maxLength={300}
            onChange={(e) => setCustomStyle(e.target.value)}
          />
          <label className="flex items-center gap-1.5 cursor-pointer">
            <Checkbox checked={usePacing} onCheckedChange={setUsePacing} />
            <span>按节节奏控制</span>
          </label>
          {usePacing && (
            <div className="flex items-center gap-1.5">
              <span>单节</span>
              <Input
                type="number"
                aria-label="单节目标分钟"
                className="h-7 w-16 text-xs"
                min={1}
                max={120}
                value={sectionMinutes}
                onChange={(e) => setSectionMinutes(Math.max(1, Number(e.target.value) || 10))}
              />
              <span>分 · 整章上限</span>
              <Input
                type="number"
                aria-label="整章上限分钟"
                className="h-7 w-16 text-xs"
                min={5}
                max={600}
                value={chapterMinutes}
                onChange={(e) => setChapterMinutes(Math.max(5, Number(e.target.value) || 90))}
              />
              <span>分</span>
            </div>
          )}
          <Button size="xs" variant="ghost" disabled={pacingBusy} onClick={() => void checkPacing()}>
            <Timer /> {pacingBusy ? "测算中…" : "测算节奏"}
          </Button>
          {pacingInfo && <span className="text-muted-foreground">{pacingInfo.summary}</span>}

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Label htmlFor="narration-voice-picker" className="text-xs font-medium">
              配音音色
            </Label>
            <SelectField
              id="narration-voice-picker"
              aria-label="配音音色"
              disabled={busyNow}
              value={voiceSelectValue}
              onValueChange={handleVoiceSelection}
              className="h-7 min-w-40 max-w-56 text-xs"
            >
              <option value="auto">
                自动（默认：{defaultPersonalVoice ? defaultPersonalVoice.name : audioState?.system_voice || audioState?.voice || "系统音色"}）
              </option>
              {readyMyVoices.map((v) => (
                <option key={v.id} value={`custom:${v.id}`}>
                  我的声音：{v.name}{v.is_default ? "（默认）" : ""}
                </option>
              ))}
              <option value="system">
                系统默认（{audioState?.system_voice || audioState?.voice || "全站音色"}）
              </option>
              <option value="__manage__">＋ 复刻 / 管理我的声音…</option>
            </SelectField>
            <Button
              size="xs"
              variant="outline"
              disabled={busyNow}
              onClick={() => setVoicesOpen(true)}
            >
              <Mic /> 我的声音
            </Button>
            {audioState?.instruction_supported && (
              <>
                <Label htmlFor="narration-instruction-picker" className="text-xs font-medium">
                  朗读语气
                </Label>
                <SelectField
                  id="narration-instruction-picker"
                  aria-label="朗读语气"
                  disabled={busyNow}
                  value={customInstructionOpen ? "custom" : instructionSelectValue}
                  onValueChange={handleInstructionSelection}
                  className="h-7 w-28 text-xs"
                >
                  <option value="inherit">跟随默认</option>
                  {instructionPresets.map((preset) => (
                    <option key={preset.id} value={`preset:${preset.id}`}>
                      {preset.label}
                    </option>
                  ))}
                  <option value="none">关闭指令</option>
                  <option value="custom">自定义…</option>
                </SelectField>
              </>
            )}
            {audioState && audioState.model !== "deepseek" && (
              <SelectField
                aria-label="合成语速"
                disabled={busyNow}
                value={speedSelectValue}
                onValueChange={handleSpeedSelection}
                className="h-7 w-24 text-xs"
              >
                <option value="inherit">
                  语速 {audioState.effective_speed ? `${audioState.effective_speed}x` : "默认"}
                </option>
                <option value="0.95">0.95x</option>
                <option value="1">1.0x</option>
                <option value="1.05">1.05x</option>
                <option value="1.1">1.1x</option>
                <option value="1.15">1.15x</option>
                <option value="1.2">1.2x</option>
              </SelectField>
            )}
          </div>
          {customInstructionOpen && audioState?.instruction_supported && (
            <div className="flex w-full flex-wrap items-center gap-1.5 pt-1 border-t">
              <Input
                aria-label="自定义朗读风格指令"
                className="h-7 min-w-56 flex-1 text-xs"
                maxLength={200}
                value={customInstructionDraft}
                placeholder="例如：请用自然连贯的普通话大学课堂授课语气朗读，句中不要多余停顿。"
                onChange={(e) => setCustomInstructionDraft(e.target.value)}
              />
              <Button
                size="xs"
                disabled={busyNow}
                onClick={() => {
                  setCustomInstructionOpen(false);
                  void selectMaterialVoice(currentVoiceMode, currentVoiceId, {
                    speechInstruction: customInstructionDraft.trim(),
                    note: customInstructionDraft.trim() ? "已保存自定义朗读风格指令" : "已关闭本课件朗读风格指令",
                  });
                }}
              >
                应用指令
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setCustomInstructionOpen(false)}>
                取消
              </Button>
            </div>
          )}
        </div>
      )}

      <JobProgressBar job={job} onRetry={() => void retryFailedJob()} retrying={busy === "retry"} />

      <TabsContent
        value="review"
        className={fullHeight ? "mt-0 min-h-0 flex-1 overflow-hidden [&:not([hidden])]:flex [&:not([hidden])]:flex-col" : "mt-2"}
      >
        <div
          className={
            mode === "source"
              ? groupedRail
                ? "grid flex-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[184px_minmax(0,1fr)_256px] xl:grid-cols-[204px_minmax(0,1fr)_280px] 2xl:grid-cols-[224px_minmax(0,1fr)_312px]"
                : "grid flex-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[84px_minmax(0,1fr)_256px] xl:grid-cols-[92px_minmax(0,1fr)_280px] 2xl:grid-cols-[100px_minmax(0,1fr)_320px]"
              : mode === "script"
                ? groupedRail
                  ? "grid flex-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[184px_minmax(0,1fr)_308px] xl:grid-cols-[204px_minmax(0,1fr)_348px] 2xl:grid-cols-[224px_minmax(0,1fr)_372px]"
                  : "grid flex-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[84px_minmax(0,1fr)_320px] xl:grid-cols-[92px_minmax(0,1fr)_360px]"
                : groupedRail
                  ? "grid gap-4 lg:grid-cols-[210px_minmax(0,1fr)_380px]"
                  : "grid gap-4 lg:grid-cols-[140px_minmax(0,1fr)_400px]"
          }
        >
          {pageList}
          {page ? (
            <>
              <NarrationPagePreview
                review={review}
                media={media}
                courseId={courseId}
                materialId={materialId}
                layout={fullHeight ? "canvas" : "stacked"}
                pagePoints={currentPagePoints}
                totalMaterialPoints={materialPoints.length}
                onOpenKnowledgeTab={onOpenKnowledgeTab}
              />
              {mode === "source" ? (
                <NarrationSourceInspector
                  review={review}
                  courseId={courseId}
                  materialId={materialId}
                />
              ) : (
                <div className={fullHeight ? "min-h-0 lg:h-full lg:overflow-y-auto overscroll-contain pr-1 [scrollbar-width:thin]" : ""}>
                  <NarrationPageEditor review={review} media={media} courseId={courseId} materialId={materialId} />
                </div>
              )}
            </>
          ) : (
            <p className="hint lg:col-span-2">这份资料没有可展示的页。</p>
          )}
        </div>
      </TabsContent>
      <TabsContent value="calibration" className={fullHeight ? "mt-0 flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1" : "mt-2"}>
        <CalibrationPanel
          report={report}
          setPageNo={(targetPage) => {
            setPageNo(targetPage);
            setTab("review");
          }}
        />
      </TabsContent>

      <MyVoicesDialog
        open={voicesOpen}
        onOpenChange={setVoicesOpen}
        onChanged={() => {
          void reloadVoices();
          void load();
        }}
        onApplyVoice={async (voice) => {
          await selectMaterialVoice("custom", voice.id);
          void reloadVoices();
        }}
        applyLabel="应用到此课件"
      />

      <Dialog open={mismatchConfirmOpen} onOpenChange={setMismatchConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {mismatchedCount > 0 ? `检测到 ${mismatchedCount} 页旧音色音频` : "已调整朗读语气或语速"}
            </DialogTitle>
            <DialogDescription>
              当前课件音色为「{audioState?.voice_name || audioState?.voice}」。你可以只补齐未生成的页面，或用当前音色与朗读风格重新合成全部已接受页面。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => setMismatchConfirmOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setMismatchConfirmOpen(false);
                void synthesizeAllAudio({ regenerateMismatch: false, force: false, skipConfirm: true });
              }}
            >
              仅补齐未生成页
            </Button>
            <Button
              type="button"
              onClick={() => {
                setMismatchConfirmOpen(false);
                void synthesizeAllAudio({
                  regenerateMismatch: true,
                  force: speechStyleDirty,
                  skipConfirm: true,
                });
              }}
            >
              用当前音色重合成全部页
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Tabs>
  );
}
