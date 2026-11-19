<template>
  <Teleport defer :to="toolbarTarget || 'body'" :disabled="!toolbarTarget">
    <nav v-if="questions.length && viewMode === 'single'" class="practice-navigation" aria-label="答题翻页">
      <button :disabled="questionIndex <= 0 || requestBusy" aria-label="上一题" title="上一题" @click="selectQuestion(questions[questionIndex - 1]!.id)"><GameIcon name="arrowLeft" /><span class="navigation-label">上一题</span></button>
      <div id="practice-question-actions" class="practice-question-actions">
        <span v-if="!isCodeQuestion" class="practice-question-location" :title="`${questionIndex + 1}/${questions.length} ${current?.title ?? ''}`"><span>{{ questionIndex + 1 }}/{{ questions.length }}</span><span class="practice-question-name">{{ current?.title }}</span></span>
      </div>
      <button :disabled="questionIndex >= questions.length - 1 || requestBusy" aria-label="下一题" title="下一题" @click="selectQuestion(questions[questionIndex + 1]!.id)"><span class="navigation-label">下一题</span><GameIcon name="arrowRight" /></button>
    </nav>
  </Teleport>
  <LearningSplitLayout class="practice-workspace" :has-support="Boolean(activity)" :compact="compact">
    <nav v-if="activity && compact" class="workspace-view-switch game-segmented" aria-label="练习与助教视图">
      <button :aria-pressed="!showAssistant" aria-controls="practice-content-region" @click="switchView(false)">题目与代码</button>
      <button :aria-pressed="showAssistant" aria-controls="practice-assistant-region" @click="switchView(true)">目标与目录</button>
    </nav>
    <section id="practice-content-region" class="practice-content" :class="{ 'coding-content': isCodeQuestion && viewMode === 'single' }" tabindex="-1" aria-label="题目与代码" :hidden="compact && showAssistant" :inert="compact && showAssistant" :aria-busy="loading">
      <GamePanelHeader class="practice-heading" :class="{ 'assessment-heading': isAssessment && !modeTarget }" :title="activity?.title ?? '正在读取题目'" icon="practice" heading>
        <Teleport defer :to="modeTarget || 'body'" :disabled="!modeTarget">
          <button v-if="isAssessment" class="assessment-mode-toggle" type="button" :title="viewMode === 'single' ? '切换到试卷模式' : '切换到单题模式'" @click="setViewMode(viewMode === 'single' ? 'paper' : 'single')">
            <GameIcon :name="viewMode === 'single' ? 'list' : 'practice'" /><span>{{ viewMode === 'single' ? '试卷模式' : '单题模式' }}</span>
          </button>
        </Teleport>
      </GamePanelHeader>
      <p v-if="error" class="error" role="alert">{{ error }}
        <button v-if="practiceRefreshFailed" :disabled="requestBusy" @click="refreshPractice(generation)">刷新题单</button>
      </p>
      <p v-if="draftError" class="error" role="alert">{{ draftError }} <button v-if="draftConflict" @click="load">重新载入试卷</button><button v-else-if="!paper?.locked" @click="retryDraft">重试保存</button></p>
      <p v-if="loading" class="learning-empty" role="status">正在读取题目…</p>
      <div v-else-if="questions.length" ref="questionRegion" class="question-body" :data-coding="current?.kind === 'python' && viewMode === 'single'" :class="{ 'question-paper': isAssessment && viewMode === 'paper' }" @scroll.passive="syncPaperSelection">
        <PracticeQuestionCard v-for="question in visibleQuestions" :key="question.id" :question="question" :paper-mode="isAssessment && viewMode === 'paper'" @open-single="openSingleQuestion(question.id)" :toolbar-target="actionTarget" :index="questions.findIndex(item => item.id === question.id)" :answer="drafts[question.id]?.answer ?? ''" :code="drafts[question.id]?.code ?? ''" :read-only="Boolean(isAssessment && (paper?.locked || paperSubmissionPending))" :busy="questionBusy(question.id)" :show-submit="!isAssessment && !submissionBlocked(question.id)" :pending-mode="drafts[question.id]?.pending?.mode" :result="questionResult(question.id)" :assistant-feedback="assistantFeedback[question.id]" @assistant-feedback="assistantFeedback[question.id] = $event" @running-change="localRunning[question.id] = $event" @update:answer="updateAnswer(question.id, $event)" @update:code="updateCode(question.id, $event)" @submit="submitQuestion(question.id, $event)">
          <template v-if="currentItem" #metadata>
            <span class="question-point">考查知识点：{{ pointNames.get(currentItem.knowledge_point_id) }}
              <span v-if="currentItem.appended"> · 追加题</span><span v-if="currentItem.status === 'accepted'"> · 已通过</span>
            </span>
          </template>
          <template v-if="currentItem?.status === 'wrong'" #correction>
            <div v-if="currentItem.retry_remaining" class="practice-retry-notice">
              <div role="status"><strong>本题暂时不能订正</strong>
                <p>请先提交 {{ currentItem.retry_remaining }} 道其他题的答案，答对或答错都算，再回来订正本题。</p>
              </div>
              <button v-if="nextAvailable" class="primary" :disabled="requestBusy" @click="selectQuestion(nextAvailable.id)">去做第 {{ questions.indexOf(nextAvailable) + 1 }} 题 <GameIcon name="arrowRight" /></button>
            </div>
            <p v-else class="practice-retry-ready" role="status">现在可以订正，修改答案后重新提交。</p>
          </template>
        </PracticeQuestionCard>
      </div>
      <p v-else-if="!loading && activity" class="learning-empty">此活动尚未绑定公开题目，请联系教师。</p>

      <button v-if="storySessionId && !isAssessment && activityProgress?.completed" class="primary practice-complete" @click="$emit('complete')">完成练习</button>
    </section>
    <LearningSupportPanel v-if="activity" :key="activity.id" id="practice-assistant-region" tabindex="-1" :hidden="compact && !showAssistant" :inert="compact && !showAssistant" :aria-hidden="compact && !showAssistant" :activity-id="activity.id" :allowed="activity.assistant_allowed" :code="drafts[current?.id ?? '']?.code ?? ''" :assistant-state="assistantState" :role-name="roleName" :portrait-url="rolePortrait" :sprite="role?.sprite" :goals="learningGoals" :goals-label="personalPractice ? '知识点目标' : undefined" :question-outline="questionOutline" @cite="cite" @select-question="selectQuestion">
      <template v-if="personalPractice" #goals>
        <section class="practice-goal-summary" aria-label="活动进度">
          <strong>{{ activity.title }}</strong>
          <div class="support-goal-progress">
            <span>活动进度 · 已通过 {{ passedCount }} / {{ questions.length }} 题</span>
            <progress class="support-progress-bar" :value="passedCount" :max="Math.max(1, questions.length)" aria-label="活动总进度" />
          </div>
        </section>
      </template>
      <template v-if="personalPractice" #question-list>
        <PracticeQuestionGroups :goals="personalPractice.goals" :names="pointNames" :questions="questionOutline" @select-question="selectQuestion" />
      </template>
      <template #question-actions>
        <div v-if="isAssessment && (paper?.locked || allAnswered)" class="assessment-actions">
          <template v-if="paper?.locked">
            <template v-if="paper.status === 'graded' && paper.score !== null">
              <strong class="assessment-score" role="status">{{ paper.score }} / {{ paper.max_score }} 分</strong>
              <span class="assessment-answer-count">答对 {{ paper.correct_count }} / {{ paper.total }} 题</span>
            </template>
            <p v-else class="assessment-status" role="status">{{ paper.status === 'attention' ? '判定需要教师处理' : '正在判定试卷…' }}</p>
            <p class="assessment-lock-state"><GameIcon name="check" /> 已交卷，答案已锁定</p>
          </template>
          <template v-else>
              <button class="primary" :disabled="requestBusy || publicRunBusy || loading" @click="submitPaper">{{ requestBusy ? '正在交卷…' : paperSubmissionPending ? '重试交卷' : '提交试卷' }}</button>
              <p class="assessment-submit-note">交卷后不可修改</p>
          </template>
        </div>
      </template>
    </LearningSupportPanel>
  </LearningSplitLayout>
</template>
<script setup lang="ts">
import { questionType, restoreDraft, submissionAnswer, type AnswerValue, type QuestionDraft } from "../../../../shared/questions";
import { randomUUID } from "../../shared/uuid";
import type { AssistantFeedback } from '../../shared/assistantState';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, ApiError, notify } from "../../shared/api";
import { useSession } from "../../shared/session";
import type { Activity, ActivityProgress, AssessmentAnswer, AssessmentAttempt, Question, QuestionOutlineState, Submission } from "../../shared/types";
import { pendingSubmissionStates } from "./practicePresentation";
import { createAssessmentDraftQueue } from "./assessmentDraft";
import { evaluateBrowserSubmission, type BrowserCase } from './browserSubmission';
import { useWorkspaceSidebar } from "../../shared/workspaceSidebar";
import GameIcon from "../../shared/GameIcon.vue";
import GamePanelHeader from "../../shared/GamePanelHeader.vue";
import LearningSupportPanel from "../support/LearningSupportPanel.vue";
import LearningSplitLayout from "../support/LearningSplitLayout.vue";
import PracticeQuestionGroups from "./PracticeQuestionGroups.vue";
import PracticeQuestionCard from "./PracticeQuestionCard.vue";
import "../support/learningUi.css";
import "./practiceUi.css";
import "./programmingUi.css";
interface Draft extends QuestionDraft { submission_id?: string; pending?: { key: string; mode: 'submit'; answer: AnswerValue; code: string; browser_cases?: BrowserCase[] } }
const props = defineProps<{ activityId: string; storySessionId?: string; toolbarTarget?: string; modeTarget?: string; initialQuestion?: number }>();
const emit = defineEmits<{ complete: []; activityKind: [kind: string] }>();
const session = useSession(), { collapsed: sidebarCollapsed } = useWorkspaceSidebar();
const activity = ref<Activity>(), activityProgress = ref<ActivityProgress>(), paper = ref<AssessmentAttempt>();
const drafts = ref<Record<string, Draft>>({}), results = ref<Record<string, Submission>>({});
const assistantFeedback = ref<Record<string, AssistantFeedback>>({});
const questionIndex = ref(0), viewMode = ref<'single' | 'paper'>('single'), questionRegion = ref<HTMLElement>();
const loading = ref(true), error = ref(''), draftError = ref(''), draftConflict = ref(false), requestBusy = ref(false), busyQuestionId = ref('');
const compact = ref(false), showAssistant = ref(false), paperSubmissionPending = ref(false);
const contextUserId = session.user?.id, contextClassroomId = session.classroomId, contextToken = api.token();
const polls = new Map<string, ReturnType<typeof setTimeout>>();
let closed = false, generation = 0, saveTimer: ReturnType<typeof setTimeout> | undefined, paperPoll: ReturnType<typeof setTimeout> | undefined;
let compactMedia: MediaQueryList | undefined, draftQueue: ReturnType<typeof createAssessmentDraftQueue> | undefined;
const draftTasks = new Set<Promise<void>>();
const mutationTasks = new Set<Promise<unknown>>();
function trackMutation<T>(task: Promise<T>) { mutationTasks.add(task); void task.then(() => mutationTasks.delete(task), () => mutationTasks.delete(task)); return task; }
let unregisterPreparation: (() => void) | undefined;
let browserSubmission: AbortController | undefined;
const ownerActive = () => session.user?.id === contextUserId && session.classroomId === contextClassroomId && api.token() === contextToken;
const currentOwner = () => !closed && ownerActive();
const isAssessment = computed(() => activity.value?.kind === 'assessment');
const questions = computed(() => {
  if (!isAssessment.value || !paper.value) return activity.value?.questions ?? [];
  const available = activity.value?.questions ?? [];
  if (!paper.value.locked) return paper.value.question_ids.map(id => available.find(question => question.id === id)).filter((question): question is Question => Boolean(question));
  return paper.value.question_ids.map(id => {
    const known = available.find(question => question.id === id);
    if (known) return known;
    const submitted = paper.value?.answers.find(answer => answer.question_id === id);
    return { id, title: '题目已调整', kind: submitted?.code ? 'python' : typeof submitted?.answer === 'boolean' ? 'boolean' : Array.isArray(submitted?.answer) ? 'multiple_choice' : 'fill', prompt: '原题内容已调整，以下保留已提交答案和判定结果。', options: Array.isArray(submitted?.answer) ? submitted.answer : [], samples: [] } as Question;
  });
});
const actionTarget = computed(() => viewMode.value === 'single' && props.toolbarTarget ? '#practice-question-actions' : undefined);
const localRunning = ref<Record<string, boolean>>({});
const publicRunBusy = computed(() => Object.values(localRunning.value).some(Boolean));
const current = computed(() => questions.value[questionIndex.value]);
const practiceRefreshFailed = ref(false);
const personalPractice = computed(() => activityProgress.value?.practice);
const passedCount = computed(() => activityProgress.value?.accepted_question_ids?.length ?? 0);
const practiceItems = computed(() => new Map(personalPractice.value?.items.map(item => [item.question_id, item])));
const pointNames = computed(() => new Map(activity.value?.knowledge_points?.map(point => [point.id, point.title])));
const currentItem = computed(() => practiceItems.value.get(current.value?.id ?? ''));
const nextAvailable = computed(() => {
  const ordered = [...questions.value.slice(questionIndex.value + 1), ...questions.value.slice(0, questionIndex.value)];
  return ordered.find(question => {
    const item = practiceItems.value.get(question.id);
    return item && item.status !== 'accepted' && !item.retry_remaining && !submissionBlocked(question.id);
  });
});
function submissionBlocked(id: string) {
  if (practiceRefreshFailed.value) return true;
  if (drafts.value[id]?.pending) return false;
  const item = practiceItems.value.get(id);
  return item?.status === 'accepted' || (item?.retry_remaining ?? 0) > 0;
}
const isCodeQuestion = computed(() => current.value && questionType(current.value.kind).execution === 'python');
const assistantState = computed(() => ({ question_id: current.value?.id, answer: drafts.value[current.value?.id ?? '']?.answer ?? '',
  code: drafts.value[current.value?.id ?? '']?.code ?? '', ...assistantFeedback.value[current.value?.id ?? ''] }));
const visibleQuestions = computed(() => isAssessment.value && viewMode.value === 'paper' ? questions.value : current.value ? [current.value] : []);
const role = computed(() => activity.value?.role);
const roleName = computed(() => role.value?.name ?? '练习助教'), rolePortrait = computed(() => role.value?.portrait);
const containerKey = computed(() => `draft:${contextUserId}:${contextClassroomId}:assessment-${props.activityId}`);
const questionKey = (id: string) => activityProgress.value?.practice
  ? `draft:${contextUserId}:${contextClassroomId}:practice:${props.activityId}:${id}`
  : `draft:${contextUserId}:${contextClassroomId}:${id}`;
const questionPositionKey = () => `read:${contextUserId}:${contextClassroomId}:question:${props.activityId}`;
watch(questionIndex, value => { if (currentOwner() && !loading.value) sessionStorage.setItem(questionPositionKey(), String(value + 1)); });
const answeredCount = computed(() => questions.value.filter(question => hasAnswer(question)).length);
const allAnswered = computed(() => questions.value.length > 0 && answeredCount.value === questions.value.length);
const questionOutline = computed(() => questions.value.map((question, index) => {
  return { id: question.id, index: index + 1, title: question.title, kind: question.kind,
    pointId: practiceItems.value.get(question.id)?.knowledge_point_id,
    current: index === questionIndex.value, state: outlineState(question) };
}));
function outlineState(question: Question): QuestionOutlineState {
  const assigned = practiceItems.value.get(question.id);
  if (assigned?.status === 'accepted' || assigned?.status === 'wrong') return assigned.status;
  const result = questionResult(question.id);
  if (result && (isAssessment.value ? paper.value?.locked : result.mode === 'submit')) {
    if (result.status === 'accepted') return 'accepted';
    return [...pendingSubmissionStates, 'infrastructure_error', 'submission_unknown'].includes(result.status) ? 'pending' : 'wrong';
  }
  if (!isAssessment.value && activityProgress.value?.accepted_question_ids?.includes(question.id)) return 'accepted';
  if (assigned && question.kind === 'python' && drafts.value[question.id]?.code === question.starter_code) return 'unanswered';
  return hasAnswer(question) ? 'answered' : 'unanswered';
}
const markedCount = computed(() => paper.value?.results.filter(result => ['accepted', 'wrong_answer', 'compile_error', 'runtime_error', 'time_limit', 'memory_limit'].includes(result.status)).length ?? 0);
const learningGoals = computed(() => {
  const total = questions.value.length;
  if (isAssessment.value) return [{ title: '完成测验', completed: paper.value?.completed ?? false,
    progress: { value: paper.value?.locked ? markedCount.value : answeredCount.value, max: total,
      label: paper.value?.locked ? `已判定 ${markedCount.value} / ${total} 题` : `已作答 ${answeredCount.value} / ${total} 题` } }];
  const passed = questions.value.filter(question => activityProgress.value?.accepted_question_ids?.includes(question.id));
  return [{ title: '完成练习', completed: activityProgress.value?.completed ?? false, progress: { value: passed.length, max: total, label: `已完成 ${passed.length} / ${total} 题` } }];
});
function hasAnswer(question: Question) { const draft = drafts.value[question.id]; return Boolean(draft && questionType(question.kind).complete(draft, question)); }
function questionResult(id: string) { return isAssessment.value && paper.value?.locked ? paper.value.results.find(result => result.question_id === id) : results.value[id]; }
function questionBusy(id: string) { const result = results.value[id]; return isAssessment.value && requestBusy.value || requestBusy.value && busyQuestionId.value === id || !isAssessment.value && Boolean(result && pendingSubmissionStates.includes(result.status)); }
function normalizeAnswer(question: Question): AssessmentAnswer { const draft = drafts.value[question.id] ?? restoreDraft(question, null); return { question_id: question.id, ...submissionAnswer(question, draft) }; }
function allAnswers() { return questions.value.map(normalizeAnswer); }
function applyAnswers(answers: AssessmentAnswer[]) {
  for (const answer of answers) {
    const draft = drafts.value[answer.question_id], question = questions.value.find(item => item.id === answer.question_id);
    if (draft && question) Object.assign(draft, restoreDraft(question, answer.answer, answer.code ?? ''));
  }
}
function localJson(key: string) { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; } }
function persistLocal() {
  if (!ownerActive()) return;
  try {
    if (isAssessment.value) localStorage.setItem(containerKey.value, JSON.stringify({ revision: draftQueue?.revision() ?? paper.value?.revision ?? 0, answers: allAnswers(), mode: viewMode.value, submission: pendingPaper }));
    else for (const [id, draft] of Object.entries(drafts.value)) localStorage.setItem(questionKey(id), JSON.stringify(draft));
  } catch { draftError.value = '本机草稿保存失败，请保持页面打开并重试。'; }
}
function edit(id: string, change: Partial<QuestionDraft>) {
  if (!currentOwner() || drafts.value[id]?.pending || isAssessment.value && (paper.value?.locked || paperSubmissionPending.value || requestBusy.value) || !drafts.value[id]) return;
  Object.assign(drafts.value[id]!, change);
  persistLocal();
  if (isAssessment.value) { draftQueue?.set(allAnswers()); clearTimeout(saveTimer); saveTimer = setTimeout(() => void flushDrafts(), 450); }
}
function updateAnswer(id: string, value: AnswerValue) { edit(id, { answer: value }); }
function updateCode(id: string, value: string) { edit(id, { code: value }); }
function trackDraftTask(task: Promise<void>) { draftTasks.add(task); void task.finally(() => draftTasks.delete(task)); return task; }
async function flushDrafts() { clearTimeout(saveTimer); if (draftQueue) await trackDraftTask(draftQueue.flush()); }
async function retryDraft() { draftError.value = ''; await flushDrafts(); }
async function prepareRestart() { browserSubmission?.abort(); clearTimeout(saveTimer); await flushDrafts(); await Promise.all([...draftTasks]); await Promise.allSettled([...mutationTasks]); if (draftQueue?.hasPending()) throw new Error(draftError.value || '试卷草稿尚未保存，请重试。'); }
function updateCompact() { if (!compactMedia) return; if (compactMedia.matches && !compact.value) showAssistant.value = Boolean(document.getElementById('practice-assistant-region')?.contains(document.activeElement)); compact.value = compactMedia.matches; }
async function switchView(support: boolean) { if (support) sidebarCollapsed.value = false; showAssistant.value = support; await nextTick(); document.getElementById(support ? 'practice-assistant-region' : 'practice-content-region')?.focus({ preventScroll: true }); }
async function selectQuestion(id: string) {
  if (requestBusy.value) return;
  const index = questions.value.findIndex(question => question.id === id);
  if (index < 0) return;
  questionIndex.value = index;
  if (compact.value) await switchView(false);
  await nextTick();
  if (viewMode.value === 'paper' && isAssessment.value) Array.from(questionRegion.value?.querySelectorAll<HTMLElement>('.practice-question-card') ?? []).find(element => element.dataset.questionId === id)?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
  else if (questionRegion.value) questionRegion.value.scrollTop = 0;
}
async function openSingleQuestion(id: string) {
  viewMode.value = 'single';
  await selectQuestion(id);
  persistLocal();
  document.getElementById('practice-content-region')?.focus({ preventScroll: true });
}
function syncPaperSelection() { if (!isAssessment.value || viewMode.value !== 'paper' || !questionRegion.value) return; const top = questionRegion.value.getBoundingClientRect().top; const cards = Array.from(questionRegion.value.querySelectorAll<HTMLElement>('.practice-question-card')); const selected = cards.find(card => card.getBoundingClientRect().bottom > top + 36); if (selected) questionIndex.value = Math.max(0, questions.value.findIndex(question => question.id === selected.dataset.questionId)); }
async function setViewMode(mode: 'single' | 'paper') { if (!isAssessment.value) return; viewMode.value = mode; persistLocal(); await nextTick(); await selectQuestion(current.value?.id ?? ''); }
let pendingPaper: { key: string; answers: AssessmentAnswer[] } | undefined;
function configureDraftQueue(saved: AssessmentAttempt, ticket: number, activityId: string) {
  if (!currentOwner() || ticket !== generation || saved.locked) return;
  draftQueue = createAssessmentDraftQueue({ revision: saved.revision, initial: saved.answers, active: ownerActive,
    send: (revision, answers) => api.put<AssessmentAttempt>(`/activities/${activityId}/assessment`, { classroom_id: contextClassroomId, revision, answers }),
    saved: next => { if (currentOwner() && ticket === generation) { paper.value = next; draftError.value = ''; persistLocal(); } },
    failed: cause => { if (currentOwner() && ticket === generation) { draftError.value = cause instanceof Error ? cause.message : '试卷草稿保存失败，请重试。'; draftConflict.value = cause instanceof ApiError && cause.status === 409; } } });
  draftQueue.set(allAnswers());
}
function restoreQuestion(question: Question) {
  const old = localJson(questionKey(question.id));
  drafts.value[question.id] = {
    ...restoreDraft(question, old?.answer, old?.code ?? question.starter_code ?? ''),
    submission_id: old?.submission_id, pending: old?.pending,
  };
}
let refreshSequence = 0;
async function refreshPractice(ticket: number) {
  const sequence = ++refreshSequence;
  let updated: Activity;
  try {
    updated = await session.activity(props.activityId);
  } catch (cause) {
    if (currentOwner() && ticket === generation && sequence === refreshSequence) {
      practiceRefreshFailed.value = true;
      error.value = cause instanceof Error ? `题单刷新失败：${cause.message}` : '题单刷新失败';
    }
    return;
  }
  if (!currentOwner() || ticket !== generation || sequence !== refreshSequence) return;
  if (practiceRefreshFailed.value) error.value = '';
  practiceRefreshFailed.value = false;
  activityProgress.value = updated.progress;
  for (const question of updated.questions) {
    if (!drafts.value[question.id]) restoreQuestion(question);
  }
  activity.value = updated;
  if (updated.progress?.completed && !props.storySessionId) await advanceTask();
  return updated.progress;
}
async function load() {
  browserSubmission?.abort(); requestBusy.value = false; busyQuestionId.value = '';
  const ticket = ++generation;
  practiceRefreshFailed.value = false;
  activity.value = undefined; activityProgress.value = undefined;
  clearTimeout(saveTimer); clearTimeout(paperPoll); for (const timer of polls.values()) clearTimeout(timer); polls.clear();
  if (draftQueue) trackDraftTask(draftQueue.flush());
  draftQueue = undefined; pendingPaper = undefined; paperSubmissionPending.value = false; paper.value = undefined; loading.value = true; error.value = ''; draftError.value = ''; draftConflict.value = false; results.value = {}; drafts.value = {};
  try {
    const loaded = await session.activity(props.activityId);
    if (!currentOwner() || ticket !== generation) return;
    const savedQuestion = Number(sessionStorage.getItem(questionPositionKey())) || 1;
    activity.value = loaded; emit('activityKind', loaded.kind); activityProgress.value = loaded.progress; questionIndex.value = Math.max(0, Math.min((props.initialQuestion ?? savedQuestion) - 1, loaded.questions.length - 1)); viewMode.value = 'single';
    for (const question of loaded.questions) { restoreQuestion(question); }
    if (loaded.kind === 'assessment') {
      const saved = await api.get<AssessmentAttempt>(`/activities/${loaded.id}/assessment?classroom_id=${contextClassroomId}`);
      if (!currentOwner() || ticket !== generation) return;
      paper.value = saved; for (const id of saved.question_ids) drafts.value[id] ??= { answer: '', code: '' }; applyAnswers(saved.answers);
      const local = localJson(containerKey.value);
      if (!saved.locked && local?.revision === saved.revision && Array.isArray(local.answers)) { applyAnswers(local.answers); pendingPaper = local.submission; paperSubmissionPending.value = Boolean(pendingPaper); }
      if (local?.mode === 'paper') viewMode.value = 'paper';
      if (saved.locked) { persistLocal(); schedulePaperPoll(); if (saved.completed && !props.storySessionId && saved.results.length) await advanceTask(saved.results[saved.results.length - 1]!.id); }
      else {
        configureDraftQueue(saved, ticket, loaded.id);
        if (pendingPaper) error.value = '上次交卷结果尚未确认，请重试交卷。';
      }
    } else {
      for (const [id, draft] of Object.entries(drafts.value)) {
        if (draft.submission_id) void pollQuestion(id, draft.submission_id, ticket, true);
      }
      if (loaded.progress?.practice && loaded.progress.completed && !props.storySessionId) await advanceTask();
    }
  } catch (cause) { if (currentOwner() && ticket === generation) error.value = cause instanceof Error ? cause.message : '题目加载失败'; }
  finally { if (currentOwner() && ticket === generation) { loading.value = false; if (activity.value) sessionStorage.setItem(questionPositionKey(), String(questionIndex.value + 1)); } }
}
async function submitQuestion(id: string, mode: 'submit') {
  const question = questions.value.find(item => item.id === id), draft = drafts.value[id];
  if (!currentOwner() || !question || !draft || !activity.value || !hasAnswer(question) || submissionBlocked(id) || requestBusy.value || publicRunBusy.value || isAssessment.value) return;
  const ticket = generation; requestBusy.value = true; busyQuestionId.value = id; error.value = '';
  const body = { answer: questionType(question.kind).serialize(draft.answer), code: draft.code, mode };
  const pending: NonNullable<Draft['pending']> = draft.pending ?? { ...body, key: randomUUID() };
  try {
    // An older saved request may already have reached the server judge. Resolve
    // its original key first; a missing receipt returns 422 and allows a fresh run.
    if (questionType(question.kind).execution === 'python' && !draft.pending) {
      const controller = new AbortController(); browserSubmission = controller;
      pending.browser_cases = await evaluateBrowserSubmission(pending.code, question.samples, controller.signal);
      if (!currentOwner() || ticket !== generation || controller.signal.aborted) return;
    }
    draft.pending = pending; persistLocal();
    const received = await trackMutation(api.post<Submission>('/submissions', { classroom_id: contextClassroomId, activity_id: activity.value.id, question_id: id, idempotency_key: pending.key, answer: pending.answer, code: pending.code, mode: pending.mode, browser_cases: pending.browser_cases }));
    if (!currentOwner() || ticket !== generation) return;
    results.value[id] = received; draft.submission_id = received.id; draft.pending = undefined; persistLocal();
    await handleQuestionResult(id, received, ticket);
  } catch (cause) { if (currentOwner() && ticket === generation) { error.value = cause instanceof Error ? cause.message : '提交失败，请重试。'; if (cause instanceof ApiError && (cause.status === 422 || cause.status === 409)) { draft.pending = undefined; persistLocal(); if (activityProgress.value?.practice) await refreshPractice(ticket); } } }
  finally { if (currentOwner() && ticket === generation) { requestBusy.value = false; busyQuestionId.value = ''; } }
}
async function handleQuestionResult(id: string, result: Submission, ticket: number) {
  if (!currentOwner() || ticket !== generation) return;
  if (pendingSubmissionStates.includes(result.status)) { polls.set(id, setTimeout(() => void pollQuestion(id, result.id, ticket), 1500)); return; }
  if (isAssessment.value || result.mode !== 'submit') return;
  if (activityProgress.value?.practice) {
    await refreshPractice(ticket);
  } else if (result.status === 'accepted') {
    const progress = await api.get<ActivityProgress>(`/activities/${props.activityId}/progress?classroom_id=${contextClassroomId}`);
    if (!currentOwner() || ticket !== generation) return;
    activityProgress.value = progress;
    if (!props.storySessionId && progress.completed) await advanceTask(result.id);
  }
}
async function pollQuestion(id: string, submissionId: string, ticket: number, restoring = false) {
  try {
    const received = await api.get<Submission>(`/submissions/${submissionId}?classroom_id=${contextClassroomId}`);
    if (!currentOwner() || ticket !== generation || received.question_id !== id || received.activity_id !== props.activityId) return;
    if (drafts.value[id]?.submission_id !== submissionId) return;
    results.value[id] = received;
    if (!(restoring && activityProgress.value?.practice && !pendingSubmissionStates.includes(received.status))) {
      await handleQuestionResult(id, received, ticket);
    }
  } catch (cause) {
    if (currentOwner() && ticket === generation) error.value = cause instanceof Error ? cause.message : '结果读取失败';
  }
}
async function advanceTask(submissionId?: string) {
  if (!activity.value || !currentOwner()) return;
  let advanced = false;
  for (const quest of session.world?.quests ?? []) for (const node of quest.nodes) {
    if (node.status !== 'ready' || !['COMPLETE_PRACTICE', 'PASS_ASSESSMENT'].includes(node.type) || node.activity_id !== activity.value.id) continue;
    try { await session.event(quest, node, { submission_id: submissionId }); advanced = true; }
    catch (cause) { notify(cause instanceof Error ? cause.message : '仍有待完成题目'); }
  }
  if (advanced && currentOwner()) await session.refresh();
}
async function submitPaper() {
  if (!activity.value || !isAssessment.value || paper.value?.locked || requestBusy.value || !allAnswered.value) return;
  const ticket = generation; requestBusy.value = true; error.value = '';
  try {
    await flushDrafts();
    if (!currentOwner() || ticket !== generation) return;
    pendingPaper ??= { key: randomUUID(), answers: allAnswers() }; paperSubmissionPending.value = true; applyAnswers(pendingPaper.answers); persistLocal();
    const saved = await trackMutation(api.post<AssessmentAttempt>(`/activities/${activity.value.id}/assessment/submit`, { classroom_id: contextClassroomId, idempotency_key: pendingPaper.key, answers: pendingPaper.answers }));
    if (!currentOwner() || ticket !== generation) return;
    paper.value = saved; pendingPaper = undefined; paperSubmissionPending.value = false; draftQueue = undefined; applyAnswers(saved.answers); persistLocal();
    if (saved.question_ids.some(id => !activity.value?.questions.some(question => question.id === id))) error.value = '试卷中的部分题目已调整，请联系教师查看。';
    if (saved.completed && !props.storySessionId && saved.results.length) await advanceTask(saved.results[saved.results.length - 1]!.id);
    schedulePaperPoll();
  } catch (cause) { if (currentOwner() && ticket === generation) { error.value = cause instanceof Error ? cause.message : '交卷失败，请重试。'; if (cause instanceof ApiError && cause.status === 422) { pendingPaper = undefined; paperSubmissionPending.value = false; persistLocal(); } if (cause instanceof ApiError && cause.status === 409 || cause instanceof Error && /锁定|已提交|已交卷/.test(cause.message)) await refreshPaper(ticket); } }
  finally { if (currentOwner() && ticket === generation) requestBusy.value = false; }
}
function schedulePaperPoll() { clearTimeout(paperPoll); if (paper.value?.locked && paper.value.status === 'grading') paperPoll = setTimeout(() => void refreshPaper(generation), 1500); }
async function refreshPaper(ticket: number) {
  try {
    const saved = await api.get<AssessmentAttempt>(`/activities/${props.activityId}/assessment?classroom_id=${contextClassroomId}`);
    if (!currentOwner() || ticket !== generation) return;
    const wasCompleted = paper.value?.completed, wasLocked = paper.value?.locked;
    paper.value = saved;
    if (saved.locked) {
      draftQueue = undefined;
      applyAnswers(saved.answers);
      persistLocal();
    } else if (wasLocked) {
      for (const id of saved.question_ids) drafts.value[id] ??= { answer: '', code: '' };
      applyAnswers(saved.answers);
      configureDraftQueue(saved, ticket, props.activityId);
      persistLocal();
    }
    if (saved.completed && !wasCompleted && !props.storySessionId && saved.results.length) await advanceTask(saved.results[saved.results.length - 1]!.id);
    schedulePaperPoll();
  } catch (cause) {
    if (currentOwner() && ticket === generation) error.value = cause instanceof Error ? cause.message : '试卷结果读取失败';
  }
}
function cite(id: number, page: number) { session.navigate({ kind: 'material', material_id: id, page_no: page }); }
watch(() => props.activityId, load);
watch(ownerActive, active => { if (!active) browserSubmission?.abort(); });
watch(sidebarCollapsed, value => { if (value) showAssistant.value = false; });
onMounted(() => { compactMedia = window.matchMedia?.('(max-width: 900px), (max-height: 540px)'); updateCompact(); compactMedia?.addEventListener('change', updateCompact); unregisterPreparation = session.registerRestartPreparation(prepareRestart); void load(); });
onBeforeUnmount(() => { browserSubmission?.abort(); clearTimeout(saveTimer); persistLocal(); const finalSave = flushDrafts(); closed = true; clearTimeout(paperPoll); for (const timer of polls.values()) clearTimeout(timer); compactMedia?.removeEventListener('change', updateCompact); void Promise.allSettled([finalSave, ...draftTasks, ...mutationTasks]).finally(() => unregisterPreparation?.()); });
</script>
