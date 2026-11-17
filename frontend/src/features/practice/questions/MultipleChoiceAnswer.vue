<template>
  <fieldset class="question-options" :disabled="disabled" :aria-labelledby="headingId">
    <p class="question-answer-hint">请选择所有正确选项，少选或多选均不通过。</p>
    <label v-for="(option, index) in question.options" :key="index" class="answer-option">
      <input type="checkbox" :name="`answer-${question.id}`" :value="option" :checked="selected.includes(option)" :disabled="disabled" @change="toggle(option)" />
      <span>{{ option }}</span>
    </label>
  </fieldset>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { AnswerValue } from '../../../../../shared/questions';
import type { Question } from '../../../shared/types';
const props = defineProps<{ question: Question; answer: AnswerValue; disabled: boolean; headingId: string }>();
const emit = defineEmits<{ 'update:answer': [answer: AnswerValue] }>();
const selected = computed(() => Array.isArray(props.answer) ? props.answer : []);
function toggle(option: string) {
  if (!props.disabled) emit('update:answer', selected.value.includes(option)
    ? selected.value.filter(value => value !== option) : [...selected.value, option]);
}
</script>
