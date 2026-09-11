<script setup>
import { onMounted, ref } from 'vue';
import LoginPage from './components/LoginPage.vue';
import Dashboard from './components/Dashboard.vue';
import { api, setUnauthorizedHandler } from './lib/api.js';

const authed = ref(false);
const checking = ref(true);

// 任何 API 返回 401（会话过期）→ 弹回登录页
setUnauthorizedHandler(() => {
  authed.value = false;
});

onMounted(async () => {
  try {
    await api.repos(); // 试探登录态
    authed.value = true;
  } catch {
    authed.value = false;
  } finally {
    checking.value = false;
  }
});

function handleLogin() {
  authed.value = true;
}

async function handleLogout() {
  try {
    await api.logout();
  } catch {
    /* 忽略网络错误，本地状态照常登出 */
  }
  authed.value = false;
}
</script>

<template>
  <div class="app">
    <div v-if="checking" class="loading"><span class="spinner"></span> 加载中…</div>
    <LoginPage v-else-if="!authed" @login="handleLogin" />
    <Dashboard v-else @logout="handleLogout" />
  </div>
</template>
