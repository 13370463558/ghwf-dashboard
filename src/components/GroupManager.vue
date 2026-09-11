<script setup>
// 管理组弹窗：创建/重命名/删除组、设置默认组、勾选组成员
import { computed, onMounted, ref } from 'vue';
import { api } from '../lib/api.js';

const emit = defineEmits(['saved', 'close']);

const groups = ref([]);
const defaultGroupId = ref(null);
const allRepos = ref([]); // 全部仓库（勾选用，来自 /api/repos?all=1）
const currentId = ref(null); // 左侧当前选中组
const search = ref('');
const loading = ref(true);
const error = ref('');
const saving = ref(false);

// 内联输入（新建/重命名）
const editing = ref(null); // { mode: 'new' | 'rename', id?, value }
const showAll = ref(false); // 显示全部仓库（管理用）时无默认组的提示

const currentGroup = computed(() => groups.value.find((g) => g.id === currentId.value) || null);

const filteredRepos = computed(() => {
  const q = search.value.trim().toLowerCase();
  return allRepos.value.filter((r) => {
    if (q && !`${r.full_name} ${r.description || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
});

const checkedCount = computed(() => (currentGroup.value?.repos || []).length);

function isChecked(fullName) {
  return currentGroup.value?.repos?.includes(fullName) || false;
}

function toggleRepo(fullName) {
  if (!currentGroup.value) return;
  const repos = currentGroup.value.repos;
  const idx = repos.indexOf(fullName);
  if (idx >= 0) repos.splice(idx, 1);
  else repos.push(fullName);
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [g, r] = await Promise.all([api.groups(), api.reposAll()]);
    groups.value = g.groups || [];
    defaultGroupId.value = g.defaultGroupId || null;
    allRepos.value = r.repos || [];
    if (!currentId.value || !groups.value.some((x) => x.id === currentId.value)) {
      currentId.value = groups.value[0]?.id || null;
    }
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function startNew() {
  editing.value = { mode: 'new', value: '' };
}

function startRename(group) {
  editing.value = { mode: 'rename', id: group.id, value: group.name };
}

function confirmEdit() {
  if (!editing.value) return;
  const name = editing.value.value.trim().slice(0, 50);
  if (!name) {
    editing.value = null;
    return;
  }
  if (editing.value.mode === 'new') {
    const g = { id: 'g_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4), name, repos: [] };
    groups.value.push(g);
    currentId.value = g.id;
  } else {
    const g = groups.value.find((x) => x.id === editing.value.id);
    if (g) g.name = name;
  }
  editing.value = null;
}

function removeGroup(id) {
  if (!confirm('确定删除该组？（不会影响仓库本身）')) return;
  groups.value = groups.value.filter((g) => g.id !== id);
  if (defaultGroupId.value === id) defaultGroupId.value = groups.value[0]?.id || null;
  if (currentId.value === id) currentId.value = groups.value[0]?.id || null;
}

function makeDefault(id) {
  defaultGroupId.value = id;
}

async function save() {
  saving.value = true;
  error.value = '';
  try {
    const result = await api.saveGroups({ groups: groups.value, defaultGroupId: defaultGroupId.value });
    groups.value = result.groups;
    defaultGroupId.value = result.defaultGroupId;
    emit('saved', result);
  } catch (e) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

function close() {
  emit('close');
}

onMounted(load);
</script>

<template>
  <div class="modal-mask" @click.self="close">
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">管理仓库分组</div>
        <button class="modal-x" @click="close">✕</button>
      </div>

      <div v-if="error" class="error-box">{{ error }}</div>
      <div v-if="loading" class="loading"><span class="spinner"></span> 加载中…</div>

      <template v-else>
        <div class="group-layout">
          <!-- 左侧：组列表 -->
          <div class="group-side">
            <button class="group-new" @click="startNew">＋ 新建组</button>

            <div v-if="editing && editing.mode === 'new'" class="group-edit-row">
              <input
                v-model="editing.value"
                type="text"
                placeholder="组名称"
                @keyup.enter="confirmEdit"
                @keyup.esc="editing = null"
                autofocus
              />
              <button @click="confirmEdit">✓</button>
              <button @click="editing = null">✕</button>
            </div>

            <div
              v-for="g in groups"
              :key="g.id"
              class="group-item"
              :class="{ active: g.id === currentId }"
              @click="currentId = g.id"
            >
              <div class="group-item-main">
                <div class="group-item-name">
                  {{ g.name }}
                  <span v-if="g.id === defaultGroupId" class="badge success" style="font-size: 10px">默认</span>
                </div>
                <div class="group-item-count">{{ g.repos.length }} 个仓库</div>
              </div>
              <div class="group-item-ops" @click.stop>
                <button title="设为默认组" @click="makeDefault(g.id)">⭐</button>
                <button title="重命名" @click="startRename(g)">✏️</button>
                <button title="删除" @click="removeGroup(g.id)">🗑️</button>
              </div>
              <div v-if="editing && editing.mode === 'rename' && editing.id === g.id" class="group-edit-row">
                <input
                  v-model="editing.value"
                  type="text"
                  @keyup.enter="confirmEdit"
                  @keyup.esc="editing = null"
                  autofocus
                />
                <button @click="confirmEdit">✓</button>
                <button @click="editing = null">✕</button>
              </div>
            </div>

            <div v-if="!groups.length && !(editing && editing.mode === 'new')" class="group-empty">
              还没有分组，点「新建组」开始
            </div>

            <div v-if="!defaultGroupId && groups.length" class="group-hint">
              ⚠ 尚未设置默认组，主视图会显示全部仓库。点击 ⭐ 将某个组设为默认。
            </div>
          </div>

          <!-- 右侧：成员勾选 -->
          <div class="group-main">
            <template v-if="currentGroup">
              <div class="group-main-head">
                <div class="group-main-title">{{ currentGroup.name }} — 已选 {{ checkedCount }} 个仓库</div>
                <input v-model="search" type="search" placeholder="搜索仓库…" />
              </div>
              <div class="group-repo-list">
                <label v-for="r in filteredRepos" :key="r.full_name" class="repo-check">
                  <input type="checkbox" :checked="isChecked(r.full_name)" @change="toggleRepo(r.full_name)" />
                  <span class="repo-check-name">{{ r.full_name }}</span>
                  <span v-if="r.private" class="badge neutral">私有</span>
                  <span v-if="r.archived" class="badge neutral">归档</span>
                </label>
                <div v-if="!filteredRepos.length" class="group-empty">没有匹配的仓库</div>
              </div>
            </template>
            <div v-else class="group-empty">先创建一个组，再勾选仓库</div>
          </div>
        </div>

        <div class="modal-foot">
          <button @click="close">取消</button>
          <button class="btn-primary" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(1, 4, 9, 0.7);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 20px;
}
.modal {
  width: 100%;
  max-width: 900px;
  height: min(680px, 90vh);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-muted);
}
.modal-title {
  font-size: 17px;
  font-weight: 700;
}
.modal-x {
  background: none;
  border: none;
  font-size: 16px;
  color: var(--text-muted);
}
.modal-x:hover {
  color: var(--text);
  background: none;
}
.group-layout {
  display: flex;
  flex: 1;
  min-height: 0;
}
.group-side {
  width: 260px;
  border-right: 1px solid var(--border-muted);
  padding: 14px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.group-new {
  width: 100%;
  border-style: dashed;
  margin-bottom: 6px;
}
.group-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
}
.group-item:hover {
  background: var(--bg-elev-2);
}
.group-item.active {
  background: var(--bg-elev-2);
  border-color: var(--accent);
}
.group-item-main {
  min-width: 0;
  flex: 1;
}
.group-item-name {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.group-item-count {
  font-size: 11.5px;
  color: var(--text-faint);
}
.group-item-ops {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.group-item:hover .group-item-ops {
  opacity: 1;
}
.group-item-ops button {
  padding: 3px 5px;
  font-size: 12px;
  border: none;
  background: none;
}
.group-item-ops button:hover {
  background: var(--neutral-bg);
}
.group-edit-row {
  display: flex;
  gap: 4px;
  padding: 4px 2px;
}
.group-edit-row input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  font-size: 13px;
}
.group-edit-row button {
  padding: 4px 7px;
  font-size: 12px;
}
.group-empty {
  color: var(--text-faint);
  text-align: center;
  padding: 30px 10px;
  font-size: 13px;
}
.group-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--warning);
  background: var(--warning-bg);
  border-radius: 8px;
  padding: 8px 10px;
  line-height: 1.6;
}
.group-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.group-main-head {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-muted);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.group-main-title {
  font-weight: 600;
}
.group-main-head input {
  width: 240px;
}
.group-repo-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
}
.repo-check {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
}
.repo-check:hover {
  background: var(--bg-elev-2);
}
.repo-check input {
  accent-color: var(--accent);
}
.repo-check-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}
.modal-foot {
  padding: 14px 20px;
  border-top: 1px solid var(--border-muted);
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #0d1117;
  font-weight: 600;
}
.btn-primary:hover:not(:disabled) {
  background: #79c0ff;
}
</style>
