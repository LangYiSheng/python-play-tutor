<template>
  <main class="arrival-page">

    <strong class="arrival-brand">PYTHONTOPIA</strong>
    <section class="arrival-panel" :class="{ departing }" :inert="departing">
      <template v-if="passwordSetup">
        <p class="eyebrow">欢迎来到小镇</p>
        <h2>设置密码</h2>
        <p class="muted arrival-intro">你已登录。设置自己的密码后，即可继续进入小镇。</p>
        <PasswordForm v-if="session.user?.must_change_password" compact initial-setup @changed="continueAfterPassword" @busy-change="passwordBusy = $event" />
        <template v-else>
          <p role="status">密码已设置，请继续进入小镇。</p>
          <button class="primary" :disabled="busy" @click="continueAfterPassword">{{ busy ? "正在进入…" : "继续进入小镇" }}</button>
        </template>
        <p v-if="error || resourceError" class="error" role="alert">{{ error || resourceError }}</p>
        <p class="muted arrival-intro">新密码至少6位，不能与学号或初始密码相同。</p>
        <button class="text-button" :disabled="busy || passwordBusy" @click="logout">换个账号？退出登录</button>
      </template>
      <template v-else>
        <p class="eyebrow">欢迎来到小镇</p>
        <h2>{{ register ? "注册" : "登录" }}</h2>
        <form @submit.prevent="submit">
          <label v-if="register"
            >名字<input
              v-model="name"
              autocomplete="name"
              required
              maxlength="80" /></label
          ><label
            >学号<input
              v-model="student_id"
              type="text"
              inputmode="numeric"
              pattern="[0-9]{1,32}"
              maxlength="32"
              autocomplete="username"
              required /></label
          ><label
            >密码<input
              v-model="password"
              type="password"
              :autocomplete="register ? 'new-password' : 'current-password'"
              required
              :minlength="register ? 6 : 1"
          /></label>
          <p v-if="error || resourceError" class="error" role="alert">{{ error || resourceError }}</p>
          <button class="primary" :disabled="busy || !backdropReady || !worldAssetsReady">
            {{ !backdropReady || !worldAssetsReady ? "正在准备小镇…" : busy ? "正在进入…" : register ? "注册并进入" : "进入小镇" }}
          </button>
        </form>
        <button class="text-button" :disabled="busy" @click="register = !register; error = ''">
          {{ register ? "已有居民证？登录" : "初次到访？注册居民证" }}
        </button>
        <p class="muted">学生可直接领取居民证；教师请使用学校提供的账号登录。</p>
      </template>
      <RouterLink to="/credits">素材许可与来源</RouterLink>
    </section>

  </main>
</template>
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { preloadWorld, startArrival, endArrival, backdropReady, worldAssetsReady, resourceError } from "../app/arrival";
import { useRouter, RouterLink } from "vue-router";
import { api } from "../shared/api";
import { useSession } from "../shared/session";
import type { User } from "../shared/types";
import PasswordForm from "./PasswordForm.vue";
const register = ref(false),
  name = ref(""),
  student_id = ref(""),
  password = ref(""),
  error = ref(""),
  busy = ref(false),
  departing = ref(false),
  router = useRouter(),
  session = useSession();
const passwordSetup = ref(Boolean(session.user?.must_change_password));
const passwordBusy = ref(false);
onMounted(() => { void preloadWorld().catch(() => { resourceError.value = "游戏资源加载失败，请刷新重试。"; }); });
async function enterTown() {
  if (session.user?.role === "student") {
    sessionStorage.setItem("reborn-arrival", "yes");
    await preloadWorld();
    await session.load();
    startArrival();
    departing.value = true;
    await new Promise(resolve => setTimeout(resolve, 450));
    await router.push("/world");
  } else window.location.assign("/teacher/");
}
async function continueAfterPassword() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try { await enterTown(); }
  catch (e) {
    endArrival();
    departing.value = false;
    error.value = e instanceof Error ? e.message : "进入失败，请重试";
  } finally { busy.value = false; }
}
async function logout() {
  if (busy.value || passwordBusy.value) return;
  busy.value = true;
  try { await api.post("/auth/logout", {}); }
  catch (e) { error.value = e instanceof Error ? e.message : "退出失败，请重试"; return; }
  finally { busy.value = false; }
  session.reset();
  passwordSetup.value = false;
  password.value = "";
  register.value = false;
  error.value = "";
}
async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    session.reset();
    const result = await api.post<{ access_token: string; user: User }>(
      `/auth/${register.value ? "register" : "login"}`,
      register.value
        ? { student_id: student_id.value, password: password.value, name: name.value }
        : { student_id: student_id.value, password: password.value },
    );
    api.setToken(result.access_token);
    session.user = result.user;
    password.value = "";
    if (result.user.must_change_password) { passwordSetup.value = true; return; }
    await enterTown();
  } catch (e) {
    endArrival();
    departing.value = false;
    error.value = e instanceof Error ? e.message : "进入失败";
  } finally {
    busy.value = false;
  }
}
</script>
