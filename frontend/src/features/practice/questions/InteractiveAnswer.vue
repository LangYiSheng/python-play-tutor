<template>
  <p v-if="error" class="error" role="alert">{{ error }}
    <button v-if="question.interactive" type="button" :disabled="disabled" @click="start">重新载入交互练习</button>
  </p>
  <iframe v-if="question.interactive" ref="frame" class="interactive-answer"
    :title="`${question.title}作答区`" :hidden="Boolean(error)" :inert="disabled"
    :tabindex="disabled ? -1 : 0" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue';
import { mountInteractivePractice } from '../../../../../shared/interactivePractice';
import type { AnswerValue } from '../../../../../shared/questions';
import type { Question } from '../../../shared/types';

const props = defineProps<{ question: Question; answer: AnswerValue; disabled: boolean }>();
const emit = defineEmits<{
  'update:answer': [answer: AnswerValue];
  'runtime-change': [runtime: ReturnType<typeof mountInteractivePractice> | undefined];
}>();
const frame = ref<HTMLIFrameElement>();
const error = ref('');
let runtime: ReturnType<typeof mountInteractivePractice> | undefined;

function unavailable(message: string) {
  error.value = message;
  emit('runtime-change', undefined);
}

function start() {
  runtime?.dispose();
  runtime = undefined;
  emit('runtime-change', undefined);
  error.value = '';
  const source = props.question.interactive;
  if (!source || !frame.value) {
    unavailable('此题缺少交互内容，请联系教师。');
    return;
  }
  const answer = props.answer;
  const draft = answer && typeof answer === 'object' && 'interactiveDraft' in answer ? toRaw(answer.interactiveDraft) : undefined;
  try {
    runtime = mountInteractivePractice(frame.value, source, {
      initialDraft: draft,
      onDraft(value) { if (!props.disabled) emit('update:answer', { interactiveDraft: value }); },
      onReady() { emit('runtime-change', runtime); },
      onError: unavailable,
    });
  } catch (cause) {
    unavailable(cause instanceof Error ? cause.message : '交互练习载入失败。');
  }
}
onMounted(start);
watch([() => props.question.interactive?.html, () => props.question.interactive?.css, () => props.question.interactive?.js], start, { flush: 'post' });
onBeforeUnmount(() => runtime?.dispose());
</script>

<style scoped>
.interactive-answer {
  display: block;
  width: 100%;
  border: 0;
  border-radius: var(--game-radius);
}
.interactive-answer[hidden] { display: none; }
.interactive-answer[inert] { pointer-events: none; }
</style>
