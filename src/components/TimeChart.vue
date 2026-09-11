<script setup>
// 今日运行时间轴图（北京时间 0-24）
// 支持横版（X=时间/Y=仓库）与竖版（X=仓库/Y=时间，0 在顶部）切换，选择存 localStorage
// 灰色虚线 = cron 计划时刻，圆点 = 实际运行（绿成功/红失败/黄进行中/灰其他）
import { computed, ref } from 'vue';

const props = defineProps({
  repos: { type: Array, required: true },
});

const orientation = ref(localStorage.getItem('chart-ori') || 'v'); // 'v' 竖版 | 'h' 横版

function toggleOrientation() {
  orientation.value = orientation.value === 'v' ? 'h' : 'v';
  localStorage.setItem('chart-ori', orientation.value);
}

const cols = computed(() =>
  props.repos.filter(
    (r) => r.chart && ((r.chart.planned || []).length || (r.chart.runs || []).length)
  )
);

const kindColor = {
  success: 'var(--success)',
  failure: 'var(--failure)',
  running: 'var(--warning)',
  neutral: 'var(--neutral)',
};
const kindText = {
  success: '成功',
  failure: '失败',
  running: '进行中',
  neutral: '其他',
};

function hm(min) {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}
function shortName(name) {
  return name.length > 9 ? name.slice(0, 9) + '…' : name;
}

// ---- 横版：X=时间(0-24)，Y=仓库行 ----
const HOUR_W = 34;
const ROW_H = 42;
const LABEL_W = 132;
const PAD_TH = 34;
const PAD_BH = 34;
const hWidth = computed(() => LABEL_W + 24 * HOUR_W + 12);
const hHeight = computed(() => PAD_TH + PAD_BH + cols.value.length * ROW_H);
function hx(min) {
  return LABEL_W + (min / 60) * HOUR_W;
}
function hy(i) {
  return PAD_TH + i * ROW_H + ROW_H / 2;
}

// ---- 竖版：X=仓库列，Y=时间(0-24 顶部) ----
const COL_W = 88;
const HOUR_H = 18;
const AXIS_W = 44;
const PAD_TV = 36;
const PAD_BV = 28;
const vChartH = computed(() => 24 * HOUR_H);
const vWidth = computed(() => AXIS_W + cols.value.length * COL_W + AXIS_W + 6); // 右侧留刻度
const vHeight = computed(() => PAD_TV + vChartH.value + PAD_BV);
function vx(i) {
  return AXIS_W + i * COL_W + COL_W / 2;
}
function vy(min) {
  return PAD_TV + (min / 60) * HOUR_H;
}
</script>

<template>
  <div class="chart-wrap">
    <div class="chart-head">
      <div class="chart-title">📊 今日运行时间轴（北京时间）</div>
      <button class="chart-toggle" @click="toggleOrientation">
        ⇄ {{ orientation === 'v' ? '切换到横版' : '切换到竖版' }}
      </button>
    </div>

    <div v-if="cols.length" class="chart-scroll">
      <!-- ============ 竖版 ============ -->
      <svg
        v-if="orientation === 'v'"
        :viewBox="`0 0 ${vWidth} ${vHeight}`"
        class="time-chart"
        preserveAspectRatio="xMidYMid meet"
      >
        <!-- 水平网格 + 左侧 Y 轴刻度 -->
        <g v-for="h in 24" :key="h">
          <line
            :x1="AXIS_W"
            :y1="vy(h * 60)"
            :x2="vWidth - AXIS_W"
            :y2="vy(h * 60)"
            stroke="var(--border-muted)"
            :stroke-dasharray="h % 4 === 0 ? '' : '3 5'"
            stroke-width="1"
          />
          <text
            v-if="h % 4 === 0"
            :x="AXIS_W - 6"
            :y="vy(h * 60) + 3"
            text-anchor="end"
            fill="var(--text-faint)"
            font-size="10"
          >
            {{ h }}:00
          </text>
          <!-- 右侧刻度 -->
          <text
            v-if="h % 4 === 0"
            :x="vWidth - AXIS_W + 6"
            :y="vy(h * 60) + 3"
            text-anchor="start"
            fill="var(--text-faint)"
            font-size="10"
          >
            {{ h }}:00
          </text>
        </g>

        <!-- 仓库列 -->
        <g v-for="(r, i) in cols" :key="r.full_name">
          <line
            :x1="vx(i)"
            :y1="PAD_TV"
            :x2="vx(i)"
            :y2="PAD_TV + vChartH"
            stroke="var(--border-muted)"
            stroke-width="0.5"
            opacity="0.4"
          />
          <text :x="vx(i)" :y="vHeight - PAD_BV + 16" text-anchor="middle" fill="var(--text-muted)" font-size="11">
            {{ shortName(r.name) }}
            <title>{{ r.full_name }}</title>
          </text>

          <g v-for="p in (r.chart.planned || [])" :key="'p' + p">
            <line
              :x1="vx(i) - 12"
              :y1="vy(p)"
              :x2="vx(i) + 12"
              :y2="vy(p)"
              stroke="var(--text-faint)"
              stroke-width="2"
              stroke-dasharray="3 3"
            >
              <title>计划 {{ hm(p) }}</title>
            </line>
          </g>

          <circle
            v-for="(run, j) in (r.chart.runs || [])"
            :key="'r' + j"
            :cx="vx(i)"
            :cy="vy(run.m)"
            r="5"
            :fill="kindColor[run.kind] || kindColor.neutral"
            stroke="#0d1117"
            stroke-width="1.5"
          >
            <title>{{ kindText[run.kind] || '其他' }} {{ hm(run.m) }}</title>
          </circle>
        </g>

        <g transform="translate(10, 14)">
          <line x1="0" y1="0" x2="12" y2="0" stroke="var(--text-faint)" stroke-width="2" stroke-dasharray="3 3" />
          <text x="18" y="4" fill="var(--text-muted)" font-size="10">计划(cron)</text>
          <circle cx="76" cy="0" r="4" fill="var(--success)" />
          <text x="86" y="4" fill="var(--text-muted)" font-size="10">成功</text>
          <circle cx="126" cy="0" r="4" fill="var(--failure)" />
          <text x="136" y="4" fill="var(--text-muted)" font-size="10">失败</text>
          <circle cx="176" cy="0" r="4" fill="var(--warning)" />
          <text x="186" y="4" fill="var(--text-muted)" font-size="10">进行中</text>
        </g>
      </svg>

      <!-- ============ 横版 ============ -->
      <svg
        v-else
        :viewBox="`0 0 ${hWidth} ${hHeight}`"
        class="time-chart"
        preserveAspectRatio="xMidYMid meet"
      >
        <!-- 垂直网格 + 底部时间刻度 -->
        <g v-for="h in 24" :key="h">
          <line
            :x1="hx(h * 60)"
            :y1="PAD_TH - 6"
            :x2="hx(h * 60)"
            :y2="hHeight - PAD_BH + 6"
            stroke="var(--border-muted)"
            :stroke-dasharray="h % 4 === 0 ? '' : '3 5'"
            stroke-width="1"
          />
          <text
            v-if="h % 4 === 0"
            :x="hx(h * 60)"
            :y="hHeight - PAD_BH + 22"
            text-anchor="middle"
            fill="var(--text-faint)"
            font-size="10"
          >
            {{ h }}:00
          </text>
        </g>

        <!-- 仓库行 -->
        <g v-for="(r, i) in cols" :key="r.full_name">
          <line
            :x1="LABEL_W"
            :y1="hy(i)"
            :x2="hWidth"
            :y2="hy(i)"
            stroke="var(--border-muted)"
            stroke-width="0.5"
            opacity="0.4"
          />
          <text :x="LABEL_W - 8" :y="hy(i) + 4" text-anchor="end" fill="var(--text-muted)" font-size="11">
            {{ shortName(r.name) }}
            <title>{{ r.full_name }}</title>
          </text>

          <g v-for="p in (r.chart.planned || [])" :key="'p' + p">
            <line
              :x1="hx(p)"
              :y1="hy(i) - 11"
              :x2="hx(p)"
              :y2="hy(i) + 11"
              stroke="var(--text-faint)"
              stroke-width="2"
              stroke-dasharray="3 3"
            >
              <title>计划 {{ hm(p) }}</title>
            </line>
          </g>

          <circle
            v-for="(run, j) in (r.chart.runs || [])"
            :key="'r' + j"
            :cx="hx(run.m)"
            :cy="hy(i)"
            r="5"
            :fill="kindColor[run.kind] || kindColor.neutral"
            stroke="#0d1117"
            stroke-width="1.5"
          >
            <title>{{ kindText[run.kind] || '其他' }} {{ hm(run.m) }}</title>
          </circle>
        </g>

        <g transform="translate(10, 14)">
          <line x1="0" y1="0" x2="12" y2="0" stroke="var(--text-faint)" stroke-width="2" stroke-dasharray="3 3" />
          <text x="18" y="4" fill="var(--text-muted)" font-size="10">计划(cron)</text>
          <circle cx="76" cy="0" r="4" fill="var(--success)" />
          <text x="86" y="4" fill="var(--text-muted)" font-size="10">成功</text>
          <circle cx="126" cy="0" r="4" fill="var(--failure)" />
          <text x="136" y="4" fill="var(--text-muted)" font-size="10">失败</text>
          <circle cx="176" cy="0" r="4" fill="var(--warning)" />
          <text x="186" y="4" fill="var(--text-muted)" font-size="10">进行中</text>
        </g>
      </svg>
    </div>
    <div v-else class="empty" style="padding: 30px">今日暂无定时任务或运行记录</div>
  </div>
</template>

<style scoped>
.chart-wrap {
  background: var(--bg-elev);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius);
  padding: 14px 16px 10px;
  margin-bottom: 20px;
}
.chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.chart-title {
  font-size: 14px;
  font-weight: 600;
}
.chart-toggle {
  padding: 4px 12px;
  font-size: 12px;
  border-radius: 999px;
}
.chart-scroll {
  overflow-x: auto;
}
.time-chart {
  width: 100%;
  height: auto;
  min-width: 500px;
  display: block;
}
</style>
