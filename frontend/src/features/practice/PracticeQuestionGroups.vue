<template>
  <section class="practice-skills" aria-label="知识点进度">
    <p class="skill-count">已达标 {{ skills.filter(skill => skill.value === skill.target).length }} / {{ skills.length }} 个知识点</p>
    <section v-for="skill in skills" :key="skill.id" class="practice-skill">
      <header class="skill-heading">
        <h3>{{ skill.name }}</h3>
        <progress class="support-progress-bar" :value="skill.value" :max="skill.target" :aria-label="skill.name + '达标进度'" />
        <span>{{ skill.value }} / {{ skill.target }}</span>
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
  questions: (QuestionOutlineItem & { pointId?: number })[];
}>();
defineEmits<{ selectQuestion: [id: string] }>();
const skills = computed(() => props.goals.map(goal => {
  const quotas = Object.entries(goal.by_kind) as [QuestionKind, number][];
  const target = Math.max(goal.total, quotas.reduce((sum, [, count]) => sum + count, 0));
  const missing = quotas.reduce((sum, [kind, count]) => sum + Math.max(0, count - (goal.accepted_by_kind[kind] ?? 0)), 0);
  return {
    id: goal.knowledge_point_id, name: props.names.get(goal.knowledge_point_id) ?? '知识点',
    target, value: Math.min(goal.accepted, target - missing),
    questions: props.questions.filter(question => question.pointId === goal.knowledge_point_id),
    detail: quotas.map(([kind, count]) => `${questionKindLabels[kind]} ${goal.accepted_by_kind[kind] ?? 0}/${count}`).join(' · '),
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
