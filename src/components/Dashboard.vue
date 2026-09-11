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
const cronPending = ref(new Set()); // 正在补齐 cron 的仓库
const cronProgress = ref('');

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
    // 概览返回后，对 cron 为空的仓库逐个补齐（独立请求，避免批量 subrequest 限制）
    fillMissingCrons();
  } catch (e) {
    if (e.status !== 401) error.value = e.message;
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

// ---- 补齐缺失的 cron ----
// /api/repos 因 subrequest 限制可能部分仓库 cron 为空；逐个独立请求 /api/cron 补齐
async function fillMissingCrons() {
  const missing = repos.value.filter(
    (r) => !r.crons || !r.crons.length
  );
  if (!missing.length) {
    cronProgress.value = '';
    return;
  }
  for (const r of missing) {
    if (cronPending.value.has(r.full_name) || r.archived) continue;
    cronPending.value.add(r.full_name);
    cronProgress.value = `正在计算 cron：${r.name}…`;
    try {
      const data = await api.cron(r.full_name);
      // 更新该仓库的 crons（在 repos 数组里替换）
      const idx = repos.value.findIndex((x) => x.full_name === r.full_name);
      if (idx >= 0) repos.value[idx].crons = data.crons || [];
    } catch {
      /* 单个补齐失败不影响整体，下轮自动重试 */
    } finally {
      cronPending.value.delete(r.full_name);
    }
  }
  // 全补齐后允许 60s 轮询自然刷新
  cronProgress.value = '';
}

// ---- 详情数据 ----
// 打开仓库：写入 hash（#/repo/owner/name），让浏览器返回键/reload 都能回到正确视图
async function openRepo(repo) {
  // 记录当前概览滚动位置（返回时恢复）
  sessionStorage.setItem('dash-scroll', String(window.scrollY));
  window.location.hash = `#/repo/${encodeURIComponent(repo.full_name)}`;
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
  window.location.hash = '#/';
  selected.value = null;
  detailData.value = null;
  detailError.value = '';
  // 返回概览后恢复之前的滚动位置（延迟到 DOM 渲染完成）
  requestAnimationFrame(() => {
    const saved = sessionStorage.getItem('dash-scroll');
    if (saved) {
      window.scrollTo(0, Number(saved));
      sessionStorage.removeItem('dash-scroll');
    } else {
      window.scrollTo(0, 0);
    }
  });
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
// 从 hash 解析出要展示的仓库名（若无则回概览）
function repoFromHash() {
  const m = window.location.hash.match(/^#\/repo\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

onMounted(async () => {
  await loadRepos();
  timer = setInterval(() => {
    if (!autoRefresh.value || selected.value) return;
    loadRepos(true);
  }, 60000);

  // 处理浏览器返回键/hash 变化：回到概览或切到对应仓库
  window.addEventListener('hashchange', handleHashChange);
  // 初始加载时若 hash 指向某仓库，直接打开该仓库（支持刷新/分享链接）
  const initial = repoFromHash();
  if (initial && !selected.value) {
    const r = repos.value.find((x) => x.full_name === initial);
    if (r) openRepo(r);
  }
});

function handleHashChange() {
  const target = repoFromHash();
  if (!target && selected.value) {
    // 回到概览
    selected.value = null;
    detailData.value = null;
    detailError.value = '';
    requestAnimationFrame(() => {
      const saved = sessionStorage.getItem('dash-scroll');
      if (saved) {
        window.scrollTo(0, Number(saved));
        sessionStorage.removeItem('dash-scroll');
      } else {
        window.scrollTo(0, 0);
      }
    });
  } else if (target && target !== selected.value?.full_name) {
    // 切到另一个仓库
    const r = repos.value.find((x) => x.full_name === target);
    if (r) openRepo(r);
  }
}

onBeforeUnmount(() => {
  clearInterval(timer);
  window.removeEventListener('hashchange', handleHashChange);
});

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

      <div v-if="cronProgress" class="cron-progress">⏳ {{ cronProgress }}</div>

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
