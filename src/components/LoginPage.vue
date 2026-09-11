<script setup>
import { ref } from 'vue';
import { api } from '../lib/api.js';

const emit = defineEmits(['login']);

const password = ref('');
const remember = ref(false);
const error = ref('');
const loading = ref(false);

async function submit() {
  if (!password.value) {
    error.value = '请输入密码';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    await api.login(password.value, remember.value);
    emit('login');
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-logo">🚀</div>
      <div class="login-title">Workflow Dashboard</div>
      <div class="login-sub">GitHub Actions 运行监控</div>

      <form class="login-form" @submit.prevent="submit">
        <label for="password">访问密码</label>
        <input
          id="password"
          v-model="password"
          type="password"
          placeholder="请输入访问密码"
          autocomplete="current-password"
          autofocus
        />
        <label class="login-remember">
          <input v-model="remember" type="checkbox" />
          记住我（30 天内免登录）
        </label>
        <div v-if="error" class="login-error">{{ error }}</div>
        <button class="login-btn" type="submit" :disabled="loading">
          {{ loading ? '验证中…' : '登 录' }}
        </button>
      </form>
    </div>
  </div>
</template>
