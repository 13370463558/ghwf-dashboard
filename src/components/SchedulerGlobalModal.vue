<script setup>
// 全局调度设置：统一调度器检查周期 + 已接管仓库概览
import { onMounted, ref } from 'vue';
import { api } from '../lib/api.js';

const emit = defineEmits(['close', 'changed']);

const loading = ref(true);
const error = ref('');
const interval = ref(5);
const repos = ref([]);
const saving = ref(false);

onMounted(async () => {
  try {
    const s = await api.schedulerState();
    interval.value = s.global_interval_minutes ?? 5;
    repos.value = Object.entries(s.repos || {})
      .filter(([, v]) => v.taken_over)
      .map(([name, v]) => ({ name, cron: v.cron, workflow_path: v.workflow_path }));
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
});

async function save() {
  const n = Number(interval.value);
  if (Number.isNaN(n) || n < 1 || n > 60) { error.value = '周期需在 1-60 分钟'; return; }
  saving.value = true; error.value = '';
  try {
    await api.scheduler({ job: 'setinterval', interval: n });
    emit('changed');
  } catch (e) { error.value = e.message; } finally { saving.value = false; }
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">⚙️ 全局调度设置</div>
        <button class="modal-x" @click="emit('close')">✕</button>
      </div>

      <div v-if="error" class="error-box">{{ error }}</div>
      <div v-if="loading" class="loading"><span class="spinner"></span> 加载中…</div>

      <div v-else class="sched-body">
        <!-- 全局检查周期 -->
        <div class="sched-field">
          <label for="interval">调度器检查周期（分钟，1-60，默认 5）</label>
          <div class="interval-row">
            <input v-model.number="interval" id="interval" class="sched-input short" type="number" min="1" max="60" />
            <span class="hint">分钟 — 越小越准点，越频繁扫描</span>
          </div>
          <button class="btn-primary" :disabled="saving" @click="save" style="align-self: flex-start">
            {{ saving ? '保存中…' : '保存周期' }}
          </button>
        </div>

        <!-- 已接管仓库概览 -->
        <div v-if="repos.length" class="taken-list">
          <div class="taken-title">已接管仓库（由调度器准时执行）</div>
          <div v-for="r in repos" :key="r.name" class="taken-item">
            <span class="taken-name">{{ r.name }}</span>
            <code>{{ r.cron }}</code>
          </div>
        </div>
        <div v-else class="taken-empty">暂无已接管仓库 — 在仓库卡片点「⚙️ 调度」接管</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sched-body { padding: 18px 20px; display: flex; flex-direction: column; gap: 20px; }
.sched-field { display: flex; flex-direction: column; gap: 8px; }
.sched-field label { font-size: 13px; color: var(--text-muted); }
.sched-input { padding: 8px 10px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 6px; color: var(--text); }
.sched-input.short { width: 90px; font-family: monospace; }
.interval-row { display: flex; align-items: center; gap: 10px; }
.hint { font-size: 12px; color: var(--text-faint); }
.taken-list { border-top: 1px solid var(--border-muted); padding-top: 14px; }
.taken-title { font-size: 13px; font-weight: 600; color: var(--text-muted); margin-bottom: 10px; }
.taken-item { display: flex; align-items: center; gap: 12px; padding: 8px 4px; border-bottom: 1px solid var(--border-muted); font-size: 13px; }
.taken-name { flex: 1; word-break: break-all; }
.taken-item code { background: var(--bg-elev-2); border: 1px solid var(--border-muted); padding: 2px 8px; border-radius: 5px; font-size: 12px; color: var(--success); }
.taken-empty { color: var(--text-faint); font-size: 13px; padding: 10px 0; text-align: center; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #0d1117; font-weight: 600; }
.btn-primary:hover:not(:disabled) { background: #79c0ff; }
.error-box { background: var(--failure-bg); border: 1px solid rgba(248,81,73,.4); color: var(--failure); padding: 10px 14px; border-radius: 8px; margin: 12px 20px 0; }
</style>