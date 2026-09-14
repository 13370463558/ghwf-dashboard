<script setup>
// 调度日志：调度器每次触发（成功/失败/找不到 workflow）都会写一条
// 数据源 /api/schedulerLog（KV "scheduler:log"，最近 100 条，新→旧）
import { onMounted, ref } from 'vue';
import { api } from '../lib/api.js';

const emit = defineEmits(['close']);

const loading = ref(true);
const error = ref('');
const entries = ref([]);

function fmtAt(iso) {
  if (!iso) return '—';
  const t = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api.schedulerLog();
    entries.value = data.entries || [];
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal modal-wide">
      <div class="modal-head">
        <div class="modal-title">📋 调度日志（最近 {{ entries.length }} 条）</div>
        <div class="head-actions">
          <button class="mini-btn" @click="load">🔄 刷新</button>
          <button class="modal-x" @click="emit('close')">✕</button>
        </div>
      </div>

      <div v-if="error" class="error-box">{{ error }}</div>
      <div v-if="loading" class="loading"><span class="spinner"></span> 加载中…</div>

      <div v-else-if="!entries.length" class="log-empty">
        暂无调度记录 — 调度器每次到点触发后会在这里留下一条日志
      </div>

      <div v-else class="log-list">
        <div v-for="(e, i) in entries" :key="i" class="log-row" :class="{ fail: e.result !== 'success' }">
          <div class="log-line1">
            <span class="log-result" :class="e.result">
              {{ e.result === 'success' ? '✅' : e.result === 'not_found' ? '❓' : '❌' }}
            </span>
            <span class="log-time">{{ fmtAt(e.at) }}</span>
            <span class="log-repo">{{ e.repo }}</span>
            <code class="log-cron">{{ e.cron }}</code>
          </div>
          <div class="log-line2">
            <span class="log-detail">{{ e.detail }}</span>
            <code v-if="e.workflow_path" class="log-path">{{ e.workflow_path }}</code>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-wide { max-width: 760px; }
.head-actions { display: flex; align-items: center; gap: 8px; }
.mini-btn { padding: 4px 10px; font-size: 12px; }
.log-empty { color: var(--text-faint); text-align: center; padding: 40px 0; font-size: 13px; }
.log-list { max-height: 60vh; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; }
.log-row { padding: 8px 10px; border-bottom: 1px solid var(--border-muted); border-radius: 6px; }
.log-row:hover { background: var(--bg-elev); }
.log-row.fail { background: var(--failure-bg); }
.log-line1 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.log-time { font-family: monospace; font-size: 12px; color: var(--text-muted); white-space: nowrap; }
.log-repo { font-weight: 600; font-size: 13px; word-break: break-all; }
.log-cron { background: var(--bg-elev-2); border: 1px solid var(--border-muted); padding: 1px 6px; border-radius: 4px; font-size: 11px; color: var(--success); }
.log-line2 { margin-top: 4px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.log-detail { font-size: 12px; color: var(--text-muted); }
.log-path { font-size: 11px; color: var(--text-faint); }
</style>
