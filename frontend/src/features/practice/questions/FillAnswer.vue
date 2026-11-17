<template>
  <label class="question-fill" :for="`answer-${question.id}`">填写答案
    <input :id="`answer-${question.id}`" :value="answer" :disabled="disabled" placeholder="输入你的答案" autocomplete="off" @input="$emit('update:answer', ($event.target as HTMLInputElement).value)" />
  </label>
</template>
<script setup lang="ts">
import type { AnswerValue } from '../../../../../shared/questions';
import type { Question } from '../../../shared/types';
defineProps<{ question: Question; answer: AnswerValue; disabled: boolean }>();
defineEmits<{ 'update:answer': [answer: AnswerValue] }>();
</script>
