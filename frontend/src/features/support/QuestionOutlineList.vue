<template>
  <nav v-if="questions.length" :aria-label="label ?? '题目列表'" class="support-detailed-questions">
    <button v-for="(question, index) in questions" :key="question.id"
      :aria-current="question.current || currentQuestionId === question.id ? 'step' : undefined"
      @click="$emit('selectQuestion', question.id)">
      <span class="question-status-icon" :data-state="question.state ?? 'unanswered'" :aria-label="questionStateLabel[question.state ?? 'unanswered']"><GameIcon :name="question.state === 'accepted' ? 'check' : question.state === 'wrong' ? 'circleX' : question.state === 'pending' ? 'clock' : question.state === 'answered' ? 'practice' : 'circle'" /></span>
      <span class="question-list-title" :title="question.title">{{ question.index ?? index + 1 }}. {{ question.title }}</span>
      <span class="question-list-kind">{{ questionKindLabel[question.kind ?? 'unknown'] }}</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import GameIcon from "../../shared/GameIcon.vue";
import { questionKindLabel, questionStateLabel, type QuestionOutlineItem } from "./questionOutline";

defineProps<{ questions: QuestionOutlineItem[]; currentQuestionId?: string; label?: string }>();
defineEmits<{ selectQuestion: [id: string] }>();
</script>
