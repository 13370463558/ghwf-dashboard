<script setup>
import { computed, ref } from 'vue';
import StatusBadge from './StatusBadge.vue';
import { relativeTime, shortSha } from '../lib/format.js';
import { api } from '../lib/api.js';

const props = defineProps({
  repo: { type: Object, required: true }, // { full_name, default_branch }
  data: { type: Object, required: true }, // { workflows, runs, errors }
});

const emit = defineEmits(['dispatched']);

const expanded = ref(null); // workflow id
const dispatching = ref(null); // 正在触发的 workflow id
const dispatchError = ref('');

const runsByWorkflow = computed(() => {
  const map = new Map();
  for (const r of props.data.runs || []) {
    if (!map.has(r.workflow_id)) map.set(r.workflow_id, []);
    map.get(r.workflow_id).push(r);
  }
  return map;
});

function toggle(id) {
  expanded.value = expanded.value === id ? null : id;
}

async function dispatch(wf) {
  if (dispatching.value) return;
  if (!confirm(`确定手动触发「${wf.name}」吗？`)) return;
  dispatching.value = wf.id;
  dispatchError.value = '';
  try {
    await api.dispatchWorkflow(props.repo.full_name, wf.id, props.repo.default_branch || 'main');
    emit('dispatched');
  } catch (e) {
    if (e.status !== 401) dispatchError.value = e.message;
  } finally {
    dispatching.value = null;
  }
}
</script>

<template>
  <div>
    <div v-if="data.errors && data.errors.length" class="error-box">⚠ {{ data.errors.join('；') }}</div>
    <div v-if="dispatchError" class="error-box">{{ dispatchError }}</div>
    <div v-if="!data.workflows || !data.workflows.length" class="empty">
      该仓库没有可用的 GitHub Actions 工作流
    </div>

    <div class="wf-list">
      <div v-for="wf in data.workflows" :key="wf.id" class="wf-item">
        <div class="wf-summary" @click="toggle(wf.id)">
          <StatusBadge
            v-if="wf.last_run"
            :status="wf.last_run.status"
            :conclusion="wf.last_run.conclusion"
          />
          <span v-else class="badge neutral">未运行</span>
          <div class="wf-name">{{ wf.name }}</div>
          <div class="wf-path">{{ wf.path }}</div>
          <div class="wf-info">
            <span v-if="wf.last_run" title="最近一次运行">
              #{{ wf.last_run.run_number }}
              · {{ relativeTime(wf.last_run.created_at) }}
            </span>
            <span v-if="wf.last_run" class="run-actor">
              <img :src="wf.last_run.actor?.avatar_url" alt="" loading="lazy" />
              {{ wf.last_run.actor?.login || 'unknown' }}
            </span>
          </div>
          <button
            v-if="wf.dispatchable && wf.state === 'active'"
            class="wf-run-btn"
            :disabled="dispatching === wf.id"
            title="手动触发该工作流"
            @click.stop="dispatch(wf)"
          >
            {{ dispatching === wf.id ? '触发中…' : '▶ 运行' }}
          </button>
          <span class="badge neutral">{{ expanded === wf.id ? '收起' : '展开' }}</span>
        </div>

        <div v-if="expanded === wf.id" class="wf-runs">
          <div v-if="!runsByWorkflow.has(wf.id)" class="empty" style="padding: 20px">暂无运行记录</div>
          <div v-for="r in (runsByWorkflow.get(wf.id) || []).slice(0, 15)" :key="r.id" class="run-row">
            <StatusBadge :status="r.status" :conclusion="r.conclusion" />
            <span>#{{ r.run_number }}</span>
            <span class="run-event">{{ r.event }}</span>
            <a class="sha" :href="r.html_url" target="_blank" rel="noopener" @click.stop>
              {{ shortSha(r.head_sha) }}
            </a>
            <span v-if="r.head_branch">{{ r.head_branch }}</span>
            <span class="run-actor">
              <img :src="r.actor?.avatar_url" alt="" loading="lazy" />
              {{ r.actor?.login || 'unknown' }}
            </span>
            <span class="run-time">{{ relativeTime(r.created_at) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
