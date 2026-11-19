<template>
  <section class="practice-goal-summary" aria-label="活动进度">
    <strong>{{ title }}</strong>
    <div class="support-goal-progress">
      <span>活动进度 · 已通过 {{ passed }} / {{ total }} 题</span>
      <progress :value="passed" :max="Math.max(1, total)" aria-label="活动总进度" />
    </div>
    <details class="practice-skills">
      <summary>知识点进度 <span>已达标 {{ skills.filter(skill => skill.value === skill.target).length }} / {{ skills.length }}</span></summary>
      <ul>
        <li v-for="skill in skills" :key="skill.id">
          <span>{{ skill.name }}</span>
          <progress :value="skill.value" :max="skill.target" :aria-label="skill.name + '达标进度'" />
          <span>{{ skill.value }} / {{ skill.target }}</span>
          <small v-if="skill.detail">{{ skill.detail }}</small>
        </li>
      </ul>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { questionKindLabels, type QuestionKind } from "../../../../shared/questions";
import type { PracticeGoalProgress } from "../../shared/types";

const props = defineProps<{ title: string; goals: PracticeGoalProgress[]; names: Map<number, string>; passed: number; total: number }>();
const skills = computed(() => props.goals.map(goal => {
  const quotas = Object.entries(goal.by_kind) as [QuestionKind, number][];
  const target = Math.max(goal.total, quotas.reduce((sum, [, count]) => sum + count, 0));
  const missing = quotas.reduce((sum, [kind, count]) => sum + Math.max(0, count - (goal.accepted_by_kind[kind] ?? 0)), 0);
  return {
    id: goal.knowledge_point_id, name: props.names.get(goal.knowledge_point_id) ?? '知识点',
    target, value: Math.min(goal.accepted, target - missing),
    detail: quotas.map(([kind, count]) => `${questionKindLabels[kind]} ${goal.accepted_by_kind[kind] ?? 0}/${count}`).join(' · '),
  };
}));
</script>

<style scoped>
.practice-goal-summary { margin-bottom: .8rem; }
.practice-skills { margin-top: .6rem; border-bottom: 1px solid var(--learn-border); }
.practice-skills summary { cursor: pointer; padding: .5rem 0; font-weight: 600; }
.practice-skills summary span { margin-inline-start: .5rem; font-size: .85em; color: var(--learn-muted); }
.practice-skills ul { list-style: none; margin: 0; padding: 0 0 .5rem .75rem; }
.practice-skills li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(2rem, 22%) auto; gap: .15rem .6rem; align-items: center; padding: .28rem 0; font-size: .875rem; }
.practice-skills progress { width: 100%; height: .4rem; accent-color: var(--learn-forest); }
.practice-skills small { grid-column: 1 / -1; color: var(--learn-muted); }
</style>
