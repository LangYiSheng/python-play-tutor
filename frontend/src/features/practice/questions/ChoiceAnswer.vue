<template>
  <fieldset class="question-options" :disabled="disabled" :aria-labelledby="headingId">
    <label v-for="(option, index) in choices" :key="index" class="answer-option">
      <input :checked="answer === option.value" :disabled="disabled" type="radio" :name="`answer-${question.id}`" :value="option.value" @change="$emit('update:answer', option.value)" />
      <span>{{ option.label }}</span>
    </label>
  </fieldset>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { questionType, type AnswerValue } from '../../../../../shared/questions';
import type { Question } from '../../../shared/types';
const props = defineProps<{ question: Question; answer: AnswerValue; disabled: boolean; headingId: string }>();
defineEmits<{ 'update:answer': [answer: AnswerValue] }>();
const choices = computed(() => questionType(props.question.kind).choices?.(props.question) ?? []);
</script>
