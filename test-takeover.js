// 端到端验证：ensureWorkflowDispatch + operateSchedule 组合（接管时的完整 YAML 变换）
// 纯函数测试，无需网络。运行：node test-takeover.js
import { ensureWorkflowDispatch, operateSchedule } from './functions/lib/yaml.js';

let passed = 0, failed = 0;
function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

// ---------- 测试 1：标准形态（有 schedule、无 workflow_dispatch）----------
{
  const yaml = `name: CI
on:
  schedule:
    - cron: '0 9 * * *'
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
  const withD = ensureWorkflowDispatch(yaml);
  const after = operateSchedule(withD, 'takeover');
  console.log('\n[测试1] 标准形态：takeover 后的 on 块');
  console.log(after.split('\n').slice(0, 8).join('\n'));
  assert('插入了 workflow_dispatch:', /^\s*workflow_dispatch:/m.test(after));
  assert('workflow_dispatch 未被注释', !/^\s*#\s*workflow_dispatch/m.test(after));
  assert('schedule: 被注释', /# schedule:/m.test(after));
  assert('cron 行被注释', /#\s*-\s*cron:/m.test(after));
  assert('push: 保留', /^\s{2}push:/m.test(after));
  assert('jobs 不受影响', /^jobs:/m.test(after));

  // untakeover 还原
  const restored = operateSchedule(after, 'untakeover');
  console.log('[测试1] untakeover 还原后');
  console.log(restored.split('\n').slice(0, 8).join('\n'));
  assert('还原后 schedule: 未注释', /^\s{2}schedule:/m.test(restored));
  assert('还原后 cron 未注释', /^\s{4}- cron:/m.test(restored));
  assert('还原后 workflow_dispatch 仍在', /^\s{2}workflow_dispatch:/m.test(restored));
}

// ---------- 测试 2：已有 workflow_dispatch（不重复插入）----------
{
  const yaml = `name: CI
on:
  workflow_dispatch:
  schedule:
    - cron: '0 9 * * *'

jobs:
  build:
    runs-on: ubuntu-latest
`;
  const withD = ensureWorkflowDispatch(yaml);
  const count = (withD.match(/^\s*workflow_dispatch:/gm) || []).length;
  assert('已有 workflow_dispatch 不重复插入', count === 1, `实际 ${count} 处`);
  const after = operateSchedule(withD, 'takeover');
  assert('takeover 后 workflow_dispatch 仍在', /^\s{2}workflow_dispatch:/m.test(after));
}

// ---------- 测试 3：无 on: 块的文件（不该乱插）----------
{
  const yaml = `name: only jobs
jobs:
  build:
    runs-on: ubuntu-latest
`;
  const after = ensureWorkflowDispatch(yaml);
  assert('无 on: 块时不应插入 workflow_dispatch', !after.includes('workflow_dispatch:'));
  assert('文件内容不变', after === yaml);
}

// ---------- 测试 4：被注释掉的 workflow_dispatch（应激活）----------
{
  const yaml = `name: CI
on:
  # workflow_dispatch:
  schedule:
    - cron: '0 9 * * *'
jobs:
  build:
    runs-on: ubuntu-latest
`;
  const after = ensureWorkflowDispatch(yaml);
  assert('注释的 workflow_dispatch 被激活', /^\s{2}workflow_dispatch:/m.test(after));
  assert('不再有注释的 workflow_dispatch', !/#\s*workflow_dispatch/m.test(after));
}

// ---------- 测试 5：on 是最后一行、文件有尾随换行 ----------
{
  const yaml = `name: X
on:
  schedule:
    - cron: '0 9 * * *'
`;
  const after = ensureWorkflowDispatch(yaml);
  assert('on 块在末尾也能插入', /workflow_dispatch:/.test(after));
  console.log('[测试5] 输出：\n' + after);
}

// ---------- 测试 6：'on' 引号写法 ----------
{
  const yaml = `name: X
'on':
  schedule:
    - cron: '0 9 * * *'
jobs:
  b:
    runs-on: ubuntu-latest
`;
  const after = ensureWorkflowDispatch(yaml);
  assert("'on' 引号写法也能识别", /^\s{2}workflow_dispatch:/m.test(after));
  assert("'on' 写法下 jobs 前插入", /workflow_dispatch:\njobs:/m.test(after));
}

// ---------- 测试 7：确认 take/untake 多轮不漂移 ----------
{
  const yaml = `name: CI
on:
  schedule:
    - cron: '0 9 * * *'
jobs:
  build:
    runs-on: ubuntu-latest
`;
  let cur = yaml;
  for (let i = 0; i < 3; i++) {
    cur = operateSchedule(ensureWorkflowDispatch(cur), 'takeover');
    cur = operateSchedule(cur, 'untakeover');
  }
  assert('3 轮 take/untake 后 workflow_dispatch 只有一份', (cur.match(/workflow_dispatch:/g) || []).length === 1);
  assert('3 轮后 cron 行完好', /^\s{4}- cron: '0 9 \* \* \*'$/m.test(cur));
}

console.log(`\n========== 结果：${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
