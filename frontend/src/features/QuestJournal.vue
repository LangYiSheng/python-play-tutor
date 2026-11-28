<template>
  <section class="story-journal">
    <div v-if="session.taskChapters.length" class="journal-book">
      <aside class="journal-index">
        <GamePanelHeader icon="journal" title="章节任务" />
        <nav class="quest-directory" aria-label="章节任务">
          <section v-for="chapter in session.taskChapters" :key="chapter.id" class="quest-card" :class="{'is-current': chapter.id === selected?.id}">
            <button class="chapter-title" :aria-pressed="chapter.id === selected?.id" @click="chapterId = chapter.id">
              <ChapterNumber :number="chapter.order_index"/><strong>{{ chapter.title }}</strong><GameIcon :name="chapter.completed ? 'check' : 'chevron'"/>
            </button>
            <button v-for="goal in goals.filter(g => g.chapter.id === chapter.id)" :key="goal.id" class="journal-goal" :aria-pressed="session.trackedQuest === goal.id" @click="track(goal)">
              <GameIcon name="compass"/><span>{{ goal.title }}</span>
            </button>
          </section>
        </nav>
      </aside>
      <section v-if="selected" class="journal-detail-panel">
        <GamePanelHeader icon="target" title="章节详情" :detail="selected.completed ? '本章已完成' : '本章学习中'" />
        <main class="quest-detail journal-entry">
          <header><h3><ChapterNumber :number="selected.order_index"/> <span>{{ selected.title }}</span></h3></header>
          <section v-if="requiredTasks.length" class="journal-objectives">
            <div><h4 class="game-card-title"><GameIcon name="chart"/>必做任务进度</h4><span>{{ completedCount }} / {{ requiredTasks.length }} 项</span></div>
            <progress class="support-progress-bar" aria-label="必做任务进度" :value="completedCount" :max="requiredTasks.length"/>
          </section>
          <section v-for="kind in taskKinds.filter(k => selected!.tasks.some(t => t.kind === k))" :key="kind" class="journal-checklist">
            <h4 class="game-card-title"><GameIcon :name="kind === 'reading' ? 'book' : kind === 'programming' ? 'code' : 'journal'"/>{{ taskRoles[kind].label }}</h4>
            <ol>
              <li v-for="(task, index) in selected.tasks.filter(t => t.kind === kind)" :key="task.id" :class="{complete:task.completed, ready:!task.locked && !task.completed}">
                <span class="node-icon" aria-hidden="true"><GameIcon v-if="task.completed" name="check"/><template v-else>{{ index + 1 }}</template></span>
                <div class="task-summary">
                  <strong>{{ task.title }}</strong>
                  <small>{{ task.required ? '必做' : '选做' }} · {{ taskProgress(task) }}</small>
                  <progress v-if="task.total > 0" class="support-progress-bar" :aria-label="task.title + '进度'" :value="task.completed ? task.total : task.current" :max="task.total"/>
                </div>
                <button class="town-secondary" @click="session.guideTo(taskRoles[kind].key)">前往{{ taskRoleName(kind, session.world?.npcs) }}<GameIcon name="compass"/></button>
              </li>
            </ol>
          </section>
          <p v-if="!selected.tasks.length" class="town-empty">本章暂无任务点。</p>
        </main>
      </section>
    </div>
    <p v-else class="town-empty">当前班级还没有开放章节。</p>
  </section>
</template>
<script setup lang="ts">
import ChapterNumber from "../shared/ChapterNumber.vue";
import GamePanelHeader from "../shared/GamePanelHeader.vue";
import { computed, ref } from "vue";
import GameIcon from "../shared/GameIcon.vue";
import {useSession} from "../shared/session";
import {chapterGoals, taskKinds, taskProgress, taskRoleName, taskRoles} from "../shared/chapterTasks";
const session = useSession();
const goals = computed(() => chapterGoals(session.taskChapters, session.world?.npcs));
const chapterId = ref(goals.value.find(g => g.id === session.trackedQuest)?.chapter.id);
const selected = computed(() => session.taskChapters.find(c => c.id === chapterId.value) ?? session.taskChapters[0]);
const requiredTasks = computed(() => selected.value?.tasks.filter(task => task.required) ?? []);
const completedCount = computed(() => requiredTasks.value.filter(task => task.completed).length);
function track(goal: ReturnType<typeof chapterGoals>[number]) { chapterId.value = goal.chapter.id; session.trackedQuest = goal.id; }
</script>
<style scoped>
.story-journal { display:flex; flex:1; min-width:0; min-height:0; color:var(--game-ink); }
.journal-book { display:grid; grid-template-columns:minmax(290px,28%) minmax(0,1fr); gap:var(--game-gap); flex:1; min-width:0; min-height:0; }
.journal-index,.journal-detail-panel { display:flex; flex-direction:column; min-width:0; min-height:0; overflow:hidden; border:1px solid var(--game-line); border-radius:var(--game-radius); background:var(--game-paper); }
.quest-directory,.quest-detail { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; }
.quest-directory { padding:10px; }
.quest-card { padding:4px; margin-bottom:8px; border:1px solid var(--game-line); border-radius:var(--game-control-radius); background:var(--game-paper-raised); }
.quest-card.is-current { --chapter-badge-bg:var(--game-forest); --chapter-badge-border:var(--game-forest); --chapter-badge-color:var(--game-paper-raised); background:#e8eddf; border-color:#b8c7ab; }
.quest-card button { display:flex; align-items:center; gap:8px; width:100%; padding:8px; margin:0; border:0; box-shadow:none; background:transparent; text-align:left; overflow-wrap:anywhere; }
.chapter-title { color:var(--game-forest); }
.chapter-title > strong { flex:1; min-width:0; }
.quest-card .journal-goal { color:var(--game-muted); font-size:var(--game-caption-size); line-height:1.5; }
.quest-card button:hover,.quest-card .journal-goal[aria-pressed=true] { background:var(--game-paper); color:var(--game-forest); }
.quest-card .game-icon,.town-secondary .game-icon { flex:none; width:16px; height:16px; }
.quest-detail { padding:var(--game-panel-padding); }
.quest-detail h3 { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:0 0 14px; color:var(--game-forest); font-size:1.25rem; overflow-wrap:anywhere; }
.quest-detail small,.journal-objectives span { color:var(--game-muted); font-size:var(--game-caption-size); }
.journal-objectives { margin-bottom:16px; padding:12px 0; border-block:1px solid var(--game-line); }
.journal-objectives > div { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:8px; }
.quest-detail h4 { margin:0; }
.support-progress-bar { display:block; }
.journal-checklist ol { display:grid; gap:8px; margin:10px 0 18px; padding:0; list-style:none; }
.journal-checklist li { display:flex; align-items:center; flex-wrap:wrap; gap:12px; padding:12px; border:1px solid var(--game-line); border-radius:var(--game-control-radius); background:#eee9dd; }
.journal-checklist li.ready { background:#f9efd6; border-color:#cbb47d; }
.journal-checklist li.complete { background:#e8eddf; border-color:#c5d0bb; }
.node-icon { display:grid; place-items:center; width:24px; height:24px; border:1px solid var(--game-line); border-radius:6px; background:var(--game-paper-raised); font-size:var(--game-caption-size); }
.complete .node-icon { background:var(--game-forest); color:var(--game-paper); }
.node-icon svg { width:16px; height:16px; }
.task-summary { display:grid; flex:1 1 140px; min-width:0; gap:4px; overflow-wrap:anywhere; }
.task-summary progress { max-width:20rem; --support-bar-height:6px; }
.journal-checklist button { display:inline-flex; align-items:center; gap:6px; }
@media(max-width:760px) {
  .journal-book { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(0,35%) minmax(0,1fr); }
  .quest-detail { padding:12px; }
}
</style>
