<script setup>
// 运行状态徽章。根据 status / conclusion 归类：
// success / failure / running(进行中) / waiting(排队) / neutral(取消/跳过等)
import { computed } from 'vue';

const props = defineProps({
  status: { type: String, default: '' }, // queued | in_progress | completed | waiting | requested | pending
  conclusion: { type: String, default: '' }, // success | failure | cancelled | skipped | neutral | timed_out ...
  label: { type: String, default: '' },
});

const RUNNING = ['in_progress', 'queued', 'waiting', 'requested', 'pending'];

const kind = computed(() => {
  if (RUNNING.includes(props.status)) return 'running';
  if (props.status === 'completed' || props.conclusion) {
    if (props.conclusion === 'success') return 'success';
    if (['failure', 'timed_out', 'startup_failure'].includes(props.conclusion)) return 'failure';
    return 'neutral'; // cancelled / skipped / neutral / stale / action_required
  }
  return 'neutral';
});

const text = computed(() => {
  if (props.label) return props.label;
  if (kind.value === 'success') return '成功';
  if (kind.value === 'failure') return '失败';
  if (kind.value === 'running') return '进行中';
  return props.conclusion || '未知';
});
</script>

<template>
  <span class="badge" :class="kind">{{ text }}</span>
</template>
