<template>
  <div class="developer-panel">
    <section class="developer-section" aria-labelledby="developer-chapter-title">
      <h4 id="developer-chapter-title" class="game-card-title"><GameIcon name="book" />章节</h4>
      <div class="developer-field-action">
        <label class="town-field" for="developer-chapter">选择章节
          <GameSelect id="developer-chapter" v-model="chapterId" :disabled="action.busy" aria-label="选择章节" :options="(overview?.chapters ?? []).map(item => ({ value: item.id, label: `${item.title} · ${chapterState(item)}` }))" />
        </label>
      </div>
    </section>
    <div class="developer-columns">
      <section class="developer-section" aria-labelledby="developer-material-title">
        <h4 id="developer-material-title" class="game-card-title"><GameIcon name="description" />资料定位</h4>
        <label class="town-field" for="developer-material">选择资料
          <GameSelect id="developer-material" v-model="materialId" :disabled="action.busy" aria-label="选择资料" :options="[{ value: '', label: '请选择资料' }, ...materials.map(item => ({ value: String(item.id), label: item.title }))]" />
        </label>
        <label v-if="material?.kind === 'video'" class="town-field developer-position" for="developer-video-time">视频时间（秒）
          <input id="developer-video-time" v-model.number="videoTime" type="number" min="0" max="86400" :disabled="action.busy">
        </label>
        <label v-else class="town-field developer-position" for="developer-page">页码
          <input id="developer-page" v-model.number="pageNo" type="number" min="1" :max="material?.pages ?? 1" :disabled="action.busy || !material">
        </label>
        <button class="town-primary" :disabled="action.busy || !chapter?.available || !material || material.status !== 'ready'" @click="openContent('material')">
          <GameIcon name="book" />打开资料
        </button>
        <p v-if="!materials.length" class="developer-help">本章暂无资料。</p>
        <p v-else-if="material && material.status !== 'ready'" class="developer-help">此资料尚未处理完成。</p>
        <ToolFeedback v-if="action.name === 'material'" :error="action.error" :message="action.message" />
      </section>
      <section class="developer-section" aria-labelledby="developer-activity-title">
        <h4 id="developer-activity-title" class="game-card-title"><GameIcon name="practice" />活动定位</h4>
        <label class="town-field" for="developer-activity">选择活动
          <GameSelect id="developer-activity" v-model="activityId" :disabled="action.busy" aria-label="选择活动" :options="[{ value: '', label: '请选择活动' }, ...activities.map(item => ({ value: item.id, label: `${item.title}${item.published ? '' : ' · 未发布'}` }))]" />
        </label>
        <label v-if="activity && ['practice', 'assessment'].includes(activity.kind)" class="town-field developer-position" for="developer-question">题号
          <input id="developer-question" v-model.number="questionNo" type="number" min="1" :max="activity.questions" :disabled="action.busy">
        </label>
        <button class="town-primary" :disabled="action.busy || !chapter?.available || !activity?.published" @click="openContent('activity')">
          <GameIcon name="practice" />打开活动
        </button>
        <p v-if="!activities.length" class="developer-help">本章暂无学习活动。</p>
        <p v-else-if="activity && !activity.published" class="developer-help">此活动尚未发布。</p>
        <ToolFeedback v-if="action.name === 'activity'" :error="action.error" :message="action.message" />
      </section>
    </div>
    <footer class="developer-section developer-footer">
      <p class="developer-help">打开内容不会记为完成。{{ chapter && !chapter.available ? '请先定位到可进入的章节。' : '' }}</p>
      <button class="town-secondary" :disabled="action.busy" @click="spawn"><GameIcon name="compass" />回到小镇出生点</button>
      <ToolFeedback v-if="action.name === 'spawn'" :error="action.error" />
    </footer>
  </div>
</template>

<script setup lang="ts">
import GameSelect from "../../shared/GameSelect.vue";
import { computed, reactive, ref, watch } from "vue";
import GameIcon from "../../shared/GameIcon.vue";
import ToolFeedback from "./ToolFeedback.vue";
import { useDeveloperTools, useToolAction } from "./useDeveloperTools";
import type { ExperienceOverview } from "./types";

const { overview, session } = useDeveloperTools();
const action = reactive(useToolAction());
const chapterId = ref<number>();
const materialId = ref("");
const activityId = ref("");
const pageNo = ref(1);
const questionNo = ref(1);
const videoTime = ref(0);
const chapter = computed(() => overview.value?.chapters.find(item => item.id === chapterId.value));
const materials = computed(() => overview.value?.materials.filter(item => item.chapters.includes(chapterId.value!)) ?? []);
const activities = computed(() => overview.value?.activities.filter(item => item.chapter_id === chapterId.value) ?? []);
const material = computed(() => materials.value.find(item => String(item.id) === materialId.value));
const activity = computed(() => activities.value.find(item => item.id === activityId.value));

function chapterState(item: ExperienceOverview["chapters"][number]) {
  return item.available ? "可进入" : item.status === "published" ? "等待开放" : "未发布";
}

function openContent(kind: "material" | "activity") {
  const body = {
    kind,
    target: kind === "material" ? materialId.value : activityId.value,
    page_no: kind === "material" ? pageNo.value : 1,
    question_no: kind === "activity" ? questionNo.value : 1,
    video_time: kind === "material" ? videoTime.value : 0,
  };
  return action.run(kind, async ({ client, current }) => {
    const result = await client.openContent(body);
    if (current() && result.workspace) {
      session.navigate(result.workspace.kind === "material" ? {...result.workspace, chapter_id:chapterId.value} : result.workspace);
    }
  });
}

function spawn() {
  return action.run("spawn", async ({ client, current }) => {
    const completed = await session.restartCurrentClassroom(client.spawnMutation());
    if (current() && !completed) throw new Error("返回出生点未完成，请重试。");
  });
}

watch(overview, value => {
  if (!value?.chapters.some(item => item.id === chapterId.value)) chapterId.value = value?.chapters[0]?.id;
}, { immediate: true });
watch(chapterId, () => {
  materialId.value = activityId.value = "";
  pageNo.value = questionNo.value = 1;
  videoTime.value = 0;
  action.clear();
});
watch(materialId, () => { pageNo.value = 1; videoTime.value = 0; });
watch(activityId, () => { questionNo.value = 1; });
</script>
