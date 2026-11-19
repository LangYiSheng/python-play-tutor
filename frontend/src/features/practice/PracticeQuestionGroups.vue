<template>
  <section class="practice-skills" aria-label="知识点进度">
    <p class="skill-count">已达标 {{ skills.filter(skill => skill.total > 0 && skill.passed === skill.total).length }} / {{ skills.length }} 个知识点</p>
    <section v-for="skill in skills" :key="skill.id" class="practice-skill">
      <header class="skill-heading">
        <h3>{{ skill.name }}</h3>
        <progress class="support-progress-bar" :value="skill.passed" :max="Math.max(1, skill.total)" :aria-label="skill.name + '达标进度'" />
        <span>{{ skill.passed }} / {{ skill.total }}</span>
        <small v-if="skill.detail">{{ skill.detail }}</small>
      </header>
      <QuestionOutlineList :questions="skill.questions" :label="skill.name + '题目列表'" @select-question="$emit('selectQuestion', $event)" />
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { questionKindLabels, type QuestionKind } from "../../../../shared/questions";
import type { PracticeGoalProgress } from "../../shared/types";
import QuestionOutlineList from "../support/QuestionOutlineList.vue";
import type { QuestionOutlineItem } from "../support/questionOutline";

const props = defineProps<{
  goals: PracticeGoalProgress[];
  names: Map<number, string>;
  questions: (QuestionOutlineItem & { pointId?: number; kind: QuestionKind })[];
}>();
defineEmits<{ selectQuestion: [id: string] }>();
const skills = computed(() => props.goals.map(goal => {
  const questions = props.questions.filter(question => question.pointId === goal.knowledge_point_id);
  const totalsByKind = new Map<QuestionKind, number>();
  for (const { kind } of questions) totalsByKind.set(kind, (totalsByKind.get(kind) ?? 0) + 1);
  const detail = Object.keys(goal.by_kind).length
    ? Array.from(totalsByKind, ([kind, total]) => `${questionKindLabels[kind]} ${goal.accepted_by_kind[kind] ?? 0}/${total}`).join(' · ')
    : '';
  return {
    id: goal.knowledge_point_id, name: props.names.get(goal.knowledge_point_id) ?? '知识点',
    passed: goal.accepted, total: questions.length, questions, detail,
  };
}));
</script>

<style scoped>
.practice-skills { display: grid; gap: .85rem; margin-top: .75rem; }
.skill-count { margin: 0; color: var(--game-muted); font-size: .8rem; }
.skill-heading { display: grid; grid-template-columns: minmax(0, 1fr) 20% auto; gap: .15rem .5rem; align-items: center; font-size: .85rem; }
.skill-heading h3 { margin: 0; font: inherit; font-weight: 600; overflow-wrap: anywhere; }
.skill-heading progress { --support-bar-height: 5px; }
.skill-heading span { color: var(--game-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.skill-heading small { grid-column: 1 / -1; color: var(--game-muted); }
.practice-skill .support-detailed-questions { margin-top: .3rem; }
</style>
