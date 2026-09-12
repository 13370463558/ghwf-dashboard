<script setup>
// 调度管理弹窗：接管/取消接管/改 cron + 未来5次预览 + 检查周期设置
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../lib/api.js';
import { beijingNext } from '../lib/format.js';

const props = defineProps({
  repo: { type: Object, required: true }, // { full_name, workflows, crons }
});
const emit = defineEmits(['close', 'changed']);

const loading = ref(true);
const error = ref('');
const state = ref(null); // scheduler state（全量）

const selectedWorkflow = ref(''); // 选中的 workflow_path
const cronInput = ref('');
const preview = ref([]);
const previewLoading = ref(false);
const saving = ref(false);
const previewError = ref(''); // cron 预览的合法性问题（不混入全局 error）

// 该仓库带 schedule 的 workflow（从 repo.crons 关联 workflow path）
const schedulableWorkflows = computed(() => {
  const list = [];
  for (const c of props.repo?.crons || []) {
    list.push({ workflow_name: c.workflow_name, cron: c.cron, path: c.path });
  }
  // 若无 crons，退化为列出所有 active workflow
  if (!list.length) {
    for (const w of props.repo?.workflows || []) {
      if (w.state === 'active') list.push({ workflow_name: w.name, cron: '', path: w.path });
    }
  }
  return list;
});

const takeoverState = computed(() => {
  // 该仓库是否已接管（从 state.repos）
  return state.value?.repos?.[props.repo.full_name] || null;
});

onMounted(async () => {
  try {
    state.value = await api.schedulerState();
    // 若已接管，预填 cron 和 workflow
    const ts = takeoverState.value;
    if (ts) {
      selectedWorkflow.value = ts.workflow_path;
      cronInput.value = ts.cron || '';
      if (cronInput.value) doPreview();
    } else if (schedulableWorkflows.value.length) {
      selectedWorkflow.value = schedulableWorkflows.value[0].path;
      cronInput.value = schedulableWorkflows.value[0].cron || '30 0 * * *';
    }
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
});

async function doPreview() {
  const cron = cronInput.value.trim();
  // cron 需 5 段，段之间用空格；若不足 5 段（输入中）则不显示，等完整
  const parts = cron.split(/\s+/).filter(Boolean);
  if (parts.length < 5) {
    preview.value = [];
    previewError.value = '';
    return;
  }
  previewLoading.value = true;
  previewError.value = '';
  try {
    const r = await api.cronPreview(cron);
    if (r.ok) {
      preview.value = r.times;
      previewError.value = '';
    } else {
      preview.value = [];
      previewError.value = r.error || 'cron 表达式不合法';
    }
  } catch (e) {
    preview.value = [];
    previewError.value = e.message;
  } finally {
    previewLoading.value = false;
  }
}
// 输入变化实时校验+预览（cron 完整时才显示）
watch(cronInput, () => { error.value = ''; doPreview(); });

// 接管
async function doTakeover() {
  const wf = schedulableWorkflows.value.find((w) => w.path === selectedWorkflow.value);
  if (!wf) { error.value = '请选择要接管的工作流'; return; }
  if (!cronInput.value.trim()) { error.value = '请填写 cron'; return; }
  saving.value = true; error.value = '';
  try {
    await api.scheduler({
      job: 'takeover', repo: props.repo.full_name,
      workflow_path: wf.path, cron: cronInput.value.trim(),
    });
    // 本地更新 cron 显示为新接管值
    applyCronUpdate(cronInput.value.trim());
    emit('changed');
    emit('close');
  } catch (e) { error.value = e.message; } finally { saving.value = false; }
}

// 取消接管
async function doUntakeover() {
  const ts = takeoverState.value;
  if (!ts) return;
  saving.value = true; error.value = '';
  try {
    await api.scheduler({
      job: 'untakeover', repo: props.repo.full_name,
      workflow_path: ts.workflow_path,
    });
    emit('changed');
    emit('close');
  } catch (e) { error.value = e.message; } finally { saving.value = false; }
}

// 改 cron
async function doSetCron() {
  if (!cronInput.value.trim()) { error.value = '请填写 cron'; return; }
  const ts = takeoverState.value;
  saving.value = true; error.value = '';
  try {
    await api.scheduler({
      job: 'setcron', repo: props.repo.full_name,
      workflow_path: ts ? ts.workflow_path : (schedulableWorkflows.value.find((w) => w.path === selectedWorkflow.value)?.path || ''),
      cron: cronInput.value.trim(),
    });
    // 成功：本地立即更新 crons（不刷新整个页面）
    applyCronUpdate(cronInput.value.trim());
    emit('changed');
    emit('close');
  } catch (e) { error.value = e.message; } finally { saving.value = false; }
}

// 本地更新 repo.crons 里对应 workflow 的 cron 值（立即反映到卡片，无需刷新）
function applyCronUpdate(newCron) {
  const targetPath = takeoverState.value?.workflow_path || selectedWorkflow.value;
  if (!props.repo || !Array.isArray(props.repo.crons)) return;
  // 更新匹配该 workflow_path 的 cron
  const idx = props.repo.crons.findIndex((c) => c.path === targetPath);
  if (idx >= 0) {
    // 直接改该 cron 条目
    props.repo.crons[idx].cron = newCron;
  } else if (props.repo.crons.length === 1) {
    // 单 cron 兜底
    props.repo.crons[0].cron = newCron;
  }
}

const isTakenOver = computed(() => !!takeoverState.value);
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal sched-modal">
      <div class="modal-head">
        <div class="modal-title">调度管理 — {{ repo.name }}</div>
        <button class="modal-x" @click="emit('close')">✕</button>
      </div>

      <div v-if="error" class="error-box">{{ error }}</div>
      <div v-if="loading" class="loading"><span class="spinner"></span> 加载调度状态…</div>

      <div v-else class="sched-body">
        <!-- 接管状态徽章 -->
        <div v-if="isTakenOver" class="taken-badge">✅ 该仓库已被接管，由调度器准时执行（GitHub schedule 已注释）</div>
        <div v-else class="free-badge">未接管 — 由 GitHub schedule 执行（可能有延迟）</div>

        <!-- workflow 选择（未接管时才需要选）-->
        <div v-if="!isTakenOver" class="sched-field">
          <label>选择要接管的 workflow</label>
          <select v-model="selectedWorkflow" class="sched-select">
            <option v-for="w in schedulableWorkflows" :key="w.path" :value="w.path">
              {{ w.workflow_name }}<template v-if="w.cron">（当前 {{ w.cron }}）</template>
            </option>
          </select>
          <div v-if="!schedulableWorkflows.length" class="sched-hint">该仓库没有检测到带 schedule 的 workflow</div>
        </div>

        <!-- cron 输入 -->
        <div class="sched-field">
          <label>cron 表达式（分 时 日 月 周）</label>
          <input v-model="cronInput" class="sched-input" type="text" placeholder="如 0 0 * * *" />
        </div>

        <!-- cron 合法性 + 未来5次预览（实时，输入完整才显示）-->
        <div v-if="previewLoading" class="sched-preview">⏳ 校验中…</div>
        <div v-else-if="previewError" class="sched-preview invalid">❌ {{ previewError }}</div>
        <div v-else-if="preview.length" class="sched-preview">
          <div class="preview-title">✅ 合法 · 未来 5 次运行时间：</div>
          <div v-for="(t, i) in preview" :key="i" class="preview-row">🕐 北京时间 {{ beijingNext(t) }}</div>
        </div>
        <div v-else class="sched-preview dim">输入完整的 5 段 cron 后显示校验结果</div>

        <!-- 操作按钮 -->
        <div class="sched-actions">
          <template v-if="isTakenOver">
            <button class="btn-primary" :disabled="saving" @click="doSetCron">💾 更新 cron（仅调度器）</button>
            <button class="btn-danger" :disabled="saving" @click="doUntakeover">↩️ 取消接管并还原</button>
          </template>
          <template v-else>
            <button class="btn-primary" :disabled="saving || !schedulableWorkflows.length" @click="doTakeover">🚀 接管并启用调度器</button>
            <button class="btn-primary" :disabled="saving" @click="doSetCron">✏️ 修改 YAML 中 cron</button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sched-modal { max-width: 520px; }
.sched-body { padding: 18px 20px; display: flex; flex-direction: column; gap: 16px; }
.taken-badge { background: rgba(63,185,80,.12); border: 1px solid rgba(63,185,80,.4); color: var(--success); padding: 8px 12px; border-radius: 8px; font-size: 13px; }
.free-badge { background: var(--bg-elev-2); border: 1px solid var(--border-muted); color: var(--text-muted); padding: 8px 12px; border-radius: 8px; font-size: 13px; }
.sched-field { display: flex; flex-direction: column; gap: 6px; }
.sched-field label { font-size: 13px; color: var(--text-muted); }
.sched-input { padding: 8px 10px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-family: monospace; }
.sched-input.short { width: 90px; }
.sched-select { padding: 8px 10px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 6px; color: var(--text); }
.sched-hint { color: var(--text-faint); font-size: 12px; }
.sched-preview { background: var(--bg-elev-2); border-radius: 8px; padding: 10px 12px; }
.sched-preview.invalid { border: 1px solid rgba(248,81,73,.4); color: var(--failure); }
.sched-preview.dim { color: var(--text-faint); font-size: 12px; }
.preview-title { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
.preview-row { font-size: 13px; color: var(--accent); padding: 2px 0; }
.sched-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.btn-danger { background: rgba(248,81,73,.12); border-color: rgba(248,81,73,.5); color: var(--failure); }
.interval-row { display: flex; gap: 8px; align-items: center; }
</style>