<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import RepoCard from './RepoCard.vue';
import WorkflowList from './WorkflowList.vue';
import GroupManager from './GroupManager.vue';
import TimeChart from './TimeChart.vue';
import { isBeijingToday } from '../lib/format.js';
import { api } from '../lib/api.js';

const emit = defineEmits(['logout']);

const repos = ref([]);
const loading = ref(true);
const error = ref('');
const generatedAt = ref('');
const refreshing = ref(false);

// 当前视图信息（来自 /api/repos 响应）
const scope = ref('all'); // 'default' | 'all'
const currentGroup = ref(null); // { id, name }
const groups = ref([]);
const defaultGroupId = ref(null);

const search = ref('');
const autoRefresh = ref(true);

const showGroupManager = ref(false);

const selected = ref(null); // 当前查看的仓库
const detailData = ref(null);
const detailLoading = ref(false);
const detailError = ref('');

let timer = null;

// ---- 概览数据 ----
async function loadRepos(silent = false) {
  if (silent) refreshing.value = true;
  else loading.value = true;
  error.value = '';
  try {
    const data = await api.repos();
    repos.value = data.repos || [];
    generatedAt.value = data.generated_at || '';
    scope.value = data.scope || 'all';
    currentGroup.value = data.group || null;
    groups.value = data.groups || [];
    defaultGroupId.value = data.defaultGroupId || null;
  } catch (e) {
    if (e.status !== 401) error.value = e.message;
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

// ---- 详情数据 ----
async function openRepo(repo) {
  selected.value = repo;
  detailData.value = null;
  detailError.value = '';
  detailLoading.value = true;
  try {
    detailData.value = await api.workflows(repo.full_name);
  } catch (e) {
    if (e.status !== 401) detailError.value = e.message;
  } finally {
    detailLoading.value = false;
  }
}

function closeDetail() {
  selected.value = null;
  detailData.value = null;
  detailError.value = '';
}

// 触发 workflow 后重新拉详情（不重置 selected）
async function reloadDetail() {
  if (!selected.value) return;
  detailLoading.value = true;
  detailError.value = '';
  try {
    detailData.value = await api.workflows(selected.value.full_name);
  } catch (e) {
    if (e.status !== 401) detailError.value = e.message;
  } finally {
    detailLoading.value = false;
  }
}

// ---- 筛选 + 排序 ----
// 排序：今天（北京时间）有 cron 要跑的仓库置顶，其余按最近活动时间倒序
const filteredRepos = computed(() => {
  const q = search.value.trim().toLowerCase();
  const list = repos.value.filter((r) => {
    if (r.archived) return false;
    if (q) {
      const hay = `${r.full_name} ${r.description || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return [...list].sort((a, b) => {
    const aToday = (a.crons || []).some((c) => isBeijingToday(c.next_at)) ? 0 : 1;
    const bToday = (b.crons || []).some((c) => isBeijingToday(c.next_at)) ? 0 : 1;
    if (aToday !== bToday) return aToday - bToday;
    return (b.last_activity_at || '').localeCompare(a.last_activity_at || '');
  });
});

// ---- 今日运行统计（北京时间）----
const todayRuns = computed(() => repos.value.reduce((s, r) => s + (r.today_runs || 0), 0));
const todayScheduled = computed(() => repos.value.reduce((s, r) => s + (r.today_scheduled || 0), 0));

// ---- 管理组 ----
function openManager() {
  showGroupManager.value = true;
}

function onGroupsSaved() {
  showGroupManager.value = false;
  loadRepos(); // 组变了，立即刷新主视图
}

// ---- 生命周期 ----
onMounted(async () => {
  await loadRepos();
  timer = setInterval(() => {
    if (!autoRefresh.value || selected.value) return;
    loadRepos(true);
  }, 60000);
});

onBeforeUnmount(() => clearInterval(timer));

function toggleAuto() {
  autoRefresh.value = !autoRefresh.value;
}
</script>

<template>
  <div class="dash">
    <header class="dash-header">
      <div class="dash-title">
        <span class="dot"></span> Workflow Dashboard
        <span class="badge-count">{{ scope === 'default' ? `组「${currentGroup?.name}」${repos.length} 个仓库` : `${repos.length} 个仓库` }}</span>
        <span class="badge-count today-count">📅 今日 {{ todayRuns }}/{{ todayScheduled }}</span>
      </div>
      <div class="dash-actions">
        <label class="switch" title="每 60 秒自动刷新概览">
          <input type="checkbox" :checked="autoRefresh" @change="toggleAuto" />
          自动刷新
        </label>
        <button :disabled="refreshing || loading" @click="loadRepos(true)">
          {{ refreshing ? '刷新中…' : '🔄 刷新' }}
        </button>
        <button @click="openManager">🗂️ 管理分组</button>
        <button @click="emit('logout')">退出登录</button>
      </div>
    </header>

    <!-- 无默认组提示 -->
    <div v-if="scope === 'all' && !defaultGroupId && !selected" class="error-box" style="background: var(--warning-bg); border-color: rgba(210,153,34,.4); color: var(--warning)">
      ⚠ 尚未设置默认组，当前显示全部仓库。点击「🗂️ 管理分组」创建分组并设为默认，之后只显示该组仓库。
    </div>
    <div v-else-if="scope === 'all' && !selected && groups.length" class="error-box" style="background: var(--warning-bg); border-color: rgba(210,153,34,.4); color: var(--warning)">
      ⚠ 当前显示全部仓库（默认组未设置）。去「🗂️ 管理分组」把某组设为默认。
    </div>

    <!-- 概览视图 -->
    <template v-if="!selected">
      <div class="toolbar">
        <input v-model="search" type="search" placeholder="搜索仓库名称或描述…" />
      </div>

      <TimeChart :repos="repos" />

      <div v-if="error" class="error-box">{{ error }}</div>
      <div v-if="loading" class="loading"><span class="spinner"></span> 正在从 GitHub 拉取数据…</div>
      <div v-else-if="!filteredRepos.length" class="empty">
        {{ repos.length ? '没有匹配的仓库，试试调整筛选条件' : scope === 'default' ? '默认组里还没有仓库，去「管理分组」添加' : '未获取到任何仓库，请检查 GITHUB_TOKEN 权限' }}
      </div>
      <div v-else class="repo-grid">
        <RepoCard v-for="r in filteredRepos" :key="r.full_name" :repo="r" @open="openRepo" />
      </div>
    </template>

    <!-- 详情视图 -->
    <template v-else>
      <button class="detail-back" @click="closeDetail">← 返回仓库列表</button>
      <div class="detail-title">{{ selected.full_name }}</div>
      <div class="detail-sub">
        {{ selected.private ? '私有' : '公开' }}
        <span v-if="selected.description"> · {{ selected.description }}</span>
      </div>

      <div v-if="detailError" class="error-box">{{ detailError }}</div>
      <div v-if="detailLoading" class="loading"><span class="spinner"></span> 加载工作流…</div>
      <WorkflowList v-else-if="detailData" :repo="selected" :data="detailData" @dispatched="reloadDetail" />
    </template>

    <footer class="footer-note">
      <template v-if="generatedAt">数据缓存自 {{ new Date(generatedAt).toLocaleString('zh-CN') }}</template>
      <template v-else>GitHub Workflow Dashboard</template>
    </footer>

    <GroupManager v-if="showGroupManager" @saved="onGroupsSaved" @close="showGroupManager = false" />
  </div>
</template>
