<template>
  <section class="town-workspace">
    <div v-if="session.taskChapters.length" class="town-book">
      <aside class="town-sidebar"><nav class="town-directory" aria-label="章节任务">
        <div v-for="chapter in session.taskChapters" :key="chapter.id">
          <button class="town-directory-item" :class="{'is-current': chapter.id === selected?.id}" @click="chapterId = chapter.id">{{ chapter.title }}</button>
          <button v-for="goal in goals.filter(g => g.chapter.id === chapter.id)" :key="goal.id" class="journal-goal" :aria-pressed="session.trackedQuest === goal.id" @click="track(goal)">{{ goal.title }}</button>
        </div>
      </nav></aside>
      <main v-if="selected" class="town-content"><section class="town-section">
        <h3 class="game-card-title">{{ selected.title }}</h3>
        <p>{{ selected.completed ? '本章已完成' : '本章学习中' }}</p>
        <div v-for="kind in taskKinds.filter(k => selected!.tasks.some(t => t.kind === k))" :key="kind">
          <h4>{{ taskRoles[kind].label }}</h4>
          <div v-for="task in selected.tasks.filter(t => t.kind === kind)" :key="task.id" class="journal-row">
            <div><strong>{{ task.title }}</strong><small>{{ task.required ? '必做' : '选做' }} · {{ taskProgress(task) }}</small></div>
            <button class="town-secondary" @click="session.guideTo(taskRoles[kind].key)">前往{{ taskRoleName(kind, session.world?.npcs) }}</button>
          </div>
        </div>
        <p v-if="!selected.tasks.length" class="town-empty">本章暂无任务点。</p>
      </section></main>
    </div>
    <p v-else class="town-empty">当前班级还没有开放章节。</p>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from "vue";
import {useSession} from "../shared/session";
import {chapterGoals, taskKinds, taskProgress, taskRoleName, taskRoles} from "../shared/chapterTasks";
const session = useSession();
const goals = computed(() => chapterGoals(session.taskChapters, session.world?.npcs));
const chapterId = ref(goals.value.find(g => g.id === session.trackedQuest)?.chapter.id);
const selected = computed(() => session.taskChapters.find(c => c.id === chapterId.value) ?? session.taskChapters[0]);
function track(goal: ReturnType<typeof chapterGoals>[number]) { chapterId.value = goal.chapter.id; session.trackedQuest = goal.id; }
</script>
<style scoped>
.journal-goal {width:100%;margin:3px 0 5px;text-align:left;font-size:.875rem;}
.journal-goal[aria-pressed=true] {border-color:var(--game-forest);}
.journal-row {display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--game-line);padding:10px 0;}
.journal-row small {display:block;color:var(--game-muted);margin-top:4px;}
</style>
