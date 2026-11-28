<template>
  <component :is="view.paper" v-if="paperMode && view.paper" :question="question" :index="index" :code="code" :read-only="readOnly" :result="result" :feedback="assistantFeedback" @open="$emit('openSingle')" />
  <component :is="view.input" v-else-if="view.standalone" v-bind="$props" @running-change="$emit('runningChange', $event)" @assistant-feedback="$emit('assistantFeedback', $event)" @update:code="$emit('update:code', $event)" @submit="(mode: 'submit', runSample?: RunPythonSample) => $emit('submit', mode, runSample)">
    <template v-if="$slots.next" #next><slot name="next" /></template>
    <template v-if="$slots.metadata" #metadata><slot name="metadata" /></template>
  </component>
  <article v-else class="practice-question-card" :data-question-id="question.id" :aria-labelledby="headingId">
    <header class="practice-question-heading">
      <span class="question-kind">{{ kindName[question.kind] }}</span> <slot name="metadata" />
      <h3 :id="headingId">{{ index + 1 }}. {{ question.title }}</h3>
    </header>
    <section class="problem-description"><p class="question-prompt">{{ question.prompt }}</p><details v-for="(hint, i) in question.hints ?? []" :key="i"><summary>提示 {{ i + 1 }}</summary><p>{{ hint }}</p></details></section>
    <component :is="view.input" v-if="question.kind === 'interactive'" :key="interactiveResetKey" :question="question" :answer="answer"
      :disabled="readOnly || busy || Boolean(pendingMode) || !showSubmit"
      @runtime-change="interactiveRuntime = $event" @update:answer="$emit('update:answer', $event)" />
    <component :is="view.input" v-else :question="question" :answer="answer" :disabled="readOnly || busy || Boolean(pendingMode)" :heading-id="headingId" @update:answer="$emit('update:answer', $event)" />
    <div v-if="!readOnly && showSubmit" class="submission-actions">
      <button class="primary" :disabled="busy || !canSubmit" @click="$emit('submit', 'submit', undefined, interactiveRuntime?.check)">{{ busy ? "等待判定…" : pendingMode === 'submit' ? '重试提交' : "提交答案" }}</button>
      <button v-if="question.kind === 'interactive'" type="button" :disabled="!canResetInteractive"
        title="恢复本题的初始状态，保留提交记录" @click="$emit('resetInteractive')">重置本题</button>
    </div>
    <div v-if="result" class="submission-result" :data-status="result.status">
      <header class="submission-result-heading">
        <GameIcon :name="result.status === 'accepted' ? 'check' : pendingSubmissionStates.includes(result.status) ? 'refresh' : 'close'" class="result-symbol" />
        <strong role="status">{{ result.mode === 'run' ? `公开样例 · ${submissionStatusName[result.status]}` : submissionStatusName[result.status] }}</strong>
        <slot v-if="result.status === 'accepted' && result.mode === 'submit'" name="next" />
      </header>
      <p v-if="resultDetail">{{ resultDetail }}</p>
      <section v-if="resultCorrectAnswer || resultExplanation" class="submission-explanation" aria-label="答案解析">
        <p v-if="resultCorrectAnswer" class="submission-correct-answer"><strong>参考答案：</strong>{{ resultCorrectAnswer }}</p>
        <template v-if="resultExplanation">
          <h4>答案解析</h4>
          <p>{{ resultExplanation }}</p>
        </template>
      </section>
      <section v-for="(sample, sampleIndex) in result.feedback.samples ?? []" :key="sampleIndex" class="public-sample-feedback" aria-label="公开样例反馈">
        <h4>公开样例 {{ sampleIndex + 1 }} · {{ publicStatusName(sample.status) }}</h4>
        <h5>标准输出</h5><pre tabindex="0">{{ sample.stdout || "（无输出）" }}</pre>
        <template v-if="sample.stderr"><h5>错误输出</h5><pre tabindex="0">{{ sample.stderr }}</pre></template>
        <template v-if="sample.compile_output"><h5>编译反馈</h5><pre tabindex="0">{{ sample.compile_output }}</pre></template>
      </section>
    </div>
  </article>
</template>
<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { questionViews } from "./questions/registry";
import { questionType, questionKindLabels, type AnswerValue } from "../../../../shared/questions";
import GameIcon from "../../shared/GameIcon.vue";
import type { RunPythonSample } from './browserSubmission';
import type { InteractiveResult, mountInteractivePractice } from '../../../../shared/interactivePractice';
import type { AssistantFeedback } from '../../shared/assistantState';
import type { Question, Submission, SubmissionStatus } from "../../shared/types";
import { pendingSubmissionStates, submissionStatusName } from "./practicePresentation";
const props = withDefaults(defineProps<{ question: Question; index: number; answer: AnswerValue; code: string; paperMode?: boolean; readOnly?: boolean; busy?: boolean; showSubmit?: boolean; pendingMode?: 'submit'; toolbarTarget?: string; result?: Submission; assistantFeedback?: AssistantFeedback; interactiveResetKey?: number; canResetInteractive?: boolean }>(), { readOnly: false, busy: false, showSubmit: true });
defineEmits<{ openSingle: []; resetInteractive: []; runningChange: [running: boolean]; "update:answer": [value: AnswerValue]; "update:code": [value: string]; submit: [mode: "submit", runSample?: RunPythonSample, checkInteractive?: () => Promise<InteractiveResult>]; assistantFeedback: [feedback: AssistantFeedback] }>();
const headingId = computed(() => `practice-question-${props.question.id}`);
const view = computed(() => questionViews[props.question.kind]);
const interactiveRuntime = shallowRef<ReturnType<typeof mountInteractivePractice>>();
function getInteractiveState() {
  if (!interactiveRuntime.value) throw new Error('交互练习尚未就绪');
  return interactiveRuntime.value.getState();
}
defineExpose({ getInteractiveState });
const canSubmit = computed(() => props.question.kind === 'interactive'
  ? Boolean(props.pendingMode || interactiveRuntime.value)
  : questionType(props.question.kind).complete(props, props.question));
const resultDetail = computed(() => {
  const detail = props.result?.feedback.detail?.trim() ?? "";
  return props.result && detail !== submissionStatusName[props.result.status] ? detail : "";
});
const resultExplanation = computed(() => props.result?.feedback.explanation?.trim() ?? "");
const resultCorrectAnswer = computed(() => props.result?.feedback.correct_answer?.trim() ?? "");
const kindName = questionKindLabels;
function publicStatusName(status: SubmissionStatus) { return status === "accepted" ? "通过" : status === "wrong_answer" ? "答案未通过" : submissionStatusName[status]; }
</script>
