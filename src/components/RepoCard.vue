<script setup>
import { computed, ref } from 'vue';
import { relativeTime, beijingNext, isBeijingToday } from '../lib/format.js';
import SchedulerModal from './SchedulerModal.vue';

const props = defineProps({
  repo: { type: Object, required: true },
});

const emit = defineEmits(['open']);

const RUNNING = ['in_progress', 'queued', 'waiting', 'requested', 'pending'];
const showScheduler = ref(false);
const takenOver = ref(false);

async function onSchedulerChanged() {
  emit('open', props.repo); // 触发数据刷新（借用 open 事件重新拉）
}

// 上次运行状态：成功绿 / 失败红 / 进行中黄 / 其他灰
const lastRun = computed(() => {
  const r = props.repo.last_run;
  if (!r) return null;
  if (RUNNING.includes(r.status)) return { cls: 'running', text: '进行中' };
  if (r.conclusion === 'success') return { cls: 'success', text: '成功' };
  if (['failure', 'timed_out', 'startup_failure'].includes(r.conclusion)) return { cls: 'failure', text: '失败' };
  return { cls: 'neutral', text: r.conclusion || '未知' };
});

// 今天（北京时间）是否有 cron 要跑（下次运行落在今天）
const hasTodayCron = computed(() =>
  (props.repo.crons || []).some((c) => isBeijingToday(c.next_at))
);

// 到时间未执行的任务时刻（分钟数）
const missedList = computed(() => props.repo.chart?.missed || []);
const missedText = computed(() =>
  missedList.value
    .map((m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`)
    .join('、')
);
</script>

<template>
  <div class="repo-card" :class="{ archived: repo.archived, 'has-today': hasTodayCron }" @click="emit('open', repo)">
    <div class="repo-head">
      <div class="repo-name">{{ repo.name }}</div>
      <div class="repo-tags">
        <button v-if="showScheduler" class="cp-btn-taken" @click.stop>⚡ 已接管</button>
        <button class="cp-btn" @click.stop="showScheduler = true">⚙️ 调度</button>
        <a class="gh-link" :href="repo.html_url" target="_blank" rel="noopener" title="打开 GitHub 仓库" @click.stop>GitHub ↗</a>
        <span v-if="repo.private" class="badge neutral">私有</span>
        <span v-if="repo.archived" class="badge neutral">归档</span>
      </div>
    </div>

    <div class="repo-desc">{{ repo.description || '（无描述）' }}</div>

    <div v-if="lastRun" class="repo-last-run" :class="lastRun.cls">
      <span class="run-dot" :class="lastRun.cls"></span>
      上次运行 {{ relativeTime(repo.last_run.created_at) }} · {{ lastRun.text }}
    </div>
    <div v-else class="repo-last-run neutral">
      <span class="run-dot neutral"></span>
      尚无运行记录
    </div>

    <div v-for="(c, i) in (repo.crons || [])" :key="i" class="repo-cron">
      <span>⏰</span>
      <code>{{ c.cron }}</code>
      <span v-if="c.next_at" class="cron-next" :class="{ 'cron-next-today': isBeijingToday(c.next_at) }">
        下次 {{ beijingNext(c.next_at) }}
      </span>
      <span v-else class="cron-warn">解析失败</span>
    </div>

    <div v-if="missedList.length" class="repo-missed" title="cron 计划时间已到，但未检测到实际运行">
      ⚠ 今日 {{ missedText }} 定时任务未执行
    </div>

    <div class="repo-meta">
      <span>更新于 {{ relativeTime(repo.last_activity_at) }}</span>
    </div>

    <div v-if="repo.wf_error" class="repo-desc" style="color: var(--failure)">⚠ {{ repo.wf_error }}</div>
  </div>

  <SchedulerModal
    v-if="showScheduler"
    :repo="repo"
    @close="showScheduler = false"
    @changed="onSchedulerChanged"
  />
</template>
