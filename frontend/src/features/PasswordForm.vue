<template>
  <form class="password-form" @submit.prevent="submit">
    <h3 v-if="!compact" class="game-card-title"><GameIcon name="settings"/>修改密码</h3>
    <p v-if="!initialSetup">修改后其他设备需要重新登录。</p>
    <label v-if="!initialSetup">当前密码<input v-model="currentPassword" type="password" autocomplete="current-password" maxlength="200" required :disabled="busy" /></label>
    <div class="password-field">
      <label>新密码<input v-model="newPassword" type="password" autocomplete="new-password" required :disabled="busy"
        :aria-invalid="Boolean(passwordError)" :aria-describedby="passwordError ? passwordFeedback : undefined" /></label>
      <small :id="passwordFeedback" :class="{ error: passwordError }" aria-live="polite">{{ passwordError }}</small>
    </div>
    <div class="password-field">
      <label>确认新密码<input v-model="confirmation" type="password" autocomplete="new-password" required :disabled="busy"
        :aria-invalid="Boolean(confirmationError)" :aria-describedby="confirmationError ? confirmationFeedback : undefined" /></label>
      <small :id="confirmationFeedback" :class="{ error: confirmationError }" aria-live="polite">{{ confirmationError }}</small>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="success" role="status">密码已修改，其他设备的登录已失效。</p>
    <button type="submit" :class="{ primary: initialSetup }" :disabled="busy || !ready">{{ busy ? '正在保存…' : initialSetup ? '设置密码并继续' : '保存新密码' }}</button>
  </form>
</template>
<script setup lang="ts">
import GameIcon from "../shared/GameIcon.vue";
import { computed, ref, useId } from "vue";
import { api } from "../shared/api";
import { useSession } from "../shared/session";
import type { User } from "../shared/types";
import { passwordLengthError } from "../../../shared/password-policy";
const emit = defineEmits<{ changed: []; busyChange: [busy: boolean] }>();
const props = defineProps<{ compact?: boolean; initialSetup?: boolean }>();
const session = useSession();
const currentPassword = ref(""), newPassword = ref(""), confirmation = ref(""), error = ref(""), success = ref(false), busy = ref(false);
const passwordFeedback = useId(), confirmationFeedback = useId();
const passwordError = computed(() => {
  if (!newPassword.value) return "";
  return passwordLengthError(newPassword.value) ||
    (newPassword.value === session.user?.student_id ? "新密码不能与登录账号相同" :
      newPassword.value === currentPassword.value ? "新密码不能与当前密码相同" : "");
});
const confirmationError = computed(() => confirmation.value && newPassword.value !== confirmation.value ? "两次输入的新密码不一致" : "");
const ready = computed(() => Boolean((props.initialSetup || currentPassword.value) && newPassword.value && confirmation.value &&
  !passwordError.value && !confirmationError.value));
async function submit() {
  if (busy.value || !ready.value) return;
  error.value = ""; success.value = false;
  busy.value = true;
  emit("busyChange", true);
  try {
    const result = await api.post<{ access_token: string; user: User }>("/auth/password", {
      ...(!props.initialSetup ? { current_password: currentPassword.value } : {}),
      new_password: newPassword.value,
    });
    api.setToken(result.access_token); session.user = result.user;
    currentPassword.value = ""; newPassword.value = ""; confirmation.value = "";
    success.value = true; emit("changed");
  } catch (e) { error.value = e instanceof Error ? e.message : "修改失败"; }
  finally { busy.value = false; emit("busyChange", false); }
}
</script>
<style scoped>
.password-form { display:grid; gap:14px; max-width:520px; padding:20px; }
.password-form h3, .password-form p { margin:0; }
.password-form label { display:grid; gap:6px; }
.password-field { display:grid; gap:4px; }
.password-form input { width:100%; min-height:44px; }
.password-form input[aria-invalid="true"] { border-color: var(--game-danger, #af3427); }
.password-form small:empty { position:absolute; }
.password-form button { min-height:44px; }
.arrival-panel .password-form { padding:0; max-width:none; }
.game-workspace .password-form { padding:0; gap:10px; }
.game-workspace .password-form :is(input, button) { min-height:var(--game-control-height); }
</style>
