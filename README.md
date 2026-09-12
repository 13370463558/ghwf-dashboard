# GitHub Workflow Dashboard

在 Cloudflare Pages 上监控你 GitHub 账号下**全部仓库**的 GitHub Actions 工作流运行情况。

- 🔐 单密码登录（httpOnly 签名 cookie，篡改即失效）
- 🗂️ 分组管理：创建多个组、设置默认组，主视图只显示默认组仓库
- 📊 今日运行时间轴图（北京时间 0-24，可横竖切换）：cron 计划时刻 vs 实际运行，一眼看出执行延迟
- ⏰ 每个仓库显示 cron 表达式 + 下次运行时间（当日高亮）+ 定时任务未执行提醒
- ▶️ 工作流一键手动触发（如果该 workflow 配了 `workflow_dispatch`）
- 🔄 cron 自动更新：仓库 push 后自动重新解析（无需手动）

## 技术栈

- 前端：Vue 3 + Vite（SPA，深色仪表盘）
- 服务端：Cloudflare Pages Functions（`functions/` 目录）
- 缓存：Cloudflare KV
- 图表：纯 SVG 手写，零依赖

## 目录结构

```
├── src/                    # 前端（Vue 3）
│   ├── App.vue             # 登录态管理
│   ├── components/         # Dashboard / LoginPage / RepoCard / WorkflowList / TimeChart / GroupManager
│   └── lib/                # api 封装 + 格式化工具
├── functions/              # Pages Functions（服务端）
│   ├── _middleware.js      # 全局守卫：/api/* 必须登录（静态资源放行）
│   ├── api/                # login / logout / groups / repos / workflows / workflowDispatch / cronRefresh
│   └── lib/                # auth / github / cache / crons / groups / wfdata / http
├── index.html
├── vite.config.js
├── wrangler.toml           # Pages 配置 + KV 绑定（需填 KV namespace id）
└── .dev.vars.example       # 本地开发环境变量模板
```

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入 GITHUB_TOKEN / APP_PASSWORD / AUTH_SECRET
npm run build                     # 构建前端到 dist/
npx wrangler pages dev dist       # 本地运行（自动读 .dev.vars，KV 走本地模拟）
```

---

## 🐳 部署到自己的 Node 容器（可选）

如果你有支持 Node 启动脚本的容器（如 katabump 那种：/home/container 持久目录 + npm start），可以自托管，不需要 Cloudflare。

### 容器启动命令

```bash
cd /home/container && if [ -f package.json ]; then npm install --dangerously-allow-all-scripts; fi && npm run build && exec npm start
```

> 这条命令会：装依赖 → 构建前端到 dist/ → 启动 server.js。容器 clone 代码后直接就能跑，无需手动 build。
> 若每次重启都要 build（慢），可改成 `npm install && exec npm start`（前提是 dist/ 已存在）。推荐首次用带 build 的完整版。

### 环境变量（在容器 Environment 配置）

| 变量 | 说明 |
|---|---|
| `GITHUB_TOKEN` | GitHub classic token（最小权限） |
| `APP_PASSWORD` | 登录密码 |
| `AUTH_SECRET` | cookie 签名密钥 |
| `PORT` | 端口（容器一般自动注入；没有则默认 8080） |

### 数据持久化

- 分组和缓存自动写到 `/home/container/data/` 目录，**重启不丢**
- `GITHUB_TOKEN` 环境变量**不要写进代码**，用容器 Environment 注入

### 需要注意

- **Node ≥ 18**（server.js 用了原生 fetch / 顶层 await，Node 18+ 才支持）
- 无 root 不影响：npm 装到项目本地 node_modules

### 和你现在 Cloudflare 部署的关系

同一套代码，两个运行方式二选一：
- **CF Pages**：`functions/` 自动路由，无需 server.js
- **自托管容器**：`server.js` 作为入口，复用 functions/lib 逻辑，存储走 data/ 文件

两个可以并存，代码一致。容器还方便以后加准点触发（node-cron）。

---

## 🚀 部署到 Cloudflare Pages（手动）

> 选 Pages 而非 Workers，架构是 `functions/` 目录形式。

### 1. 创建 KV namespace

[Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → 右上角 **KV** → **Create a namespace**，任意命名（如 `CACHE`）。创建后复制返回的 **id**。

然后**必须**把它填到 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "CACHE"
id = "粘贴你的KV namespace id"
```

### 2. 推代码到 GitHub（私有仓库）

```bash
git init -b main
git add -A && git commit -m "init"
git remote add origin git@github.com:你的账号/ghwf-dashboard.git
git push -u origin main
```

确保仓库设为 **Private**。

### 3. 在 CF 创建 Pages 项目

1. Dashboard → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
2. 授权 GitHub，选择 `ghwf-dashboard` 仓库
3. 配置：
   - **Framework preset**：`Vite`
   - **Build command**：`npm run build`
   - **Build output directory**：`dist`
4. 点击 **Save and Deploy**，等构建完成

### 4. 配置环境变量（必做，否则页面白屏）

到刚创建的 Pages 项目 → **Settings → Environment variables** → **Production**，添加：

| 变量 | 说明 |
|---|---|
| `GITHUB_TOKEN` | GitHub classic token（最小权限：私有仓库勾 `repo`，只看公开勾 `public_repo`） |
| `APP_PASSWORD` | 登录密码（单账户） |
| `AUTH_SECRET` | cookie 签名密钥，长随机串（`openssl rand -hex 32` 生成） |

> 三个都勾选 **Encrypt**。部署后**重新部署一次**让环境变量生效。`AUTH_SECRET` 一旦更换，所有已登录会话立即失效。

### 5. KV 绑定到 Pages 项目

在 Pages 项目 → **Settings → Functions → KV namespace bindings** → **Add binding**：
- Variable name：`CACHE`
- KV namespace：选择你第一步创建的 `CACHE`

> **这一步很容易漏**。如果没有该绑定，分组管理和所有缓存功能会失效（代码会自动降级为不缓存，但分组保存会报错）。

### 6. 绑定自定义域名（可选）

Pages 项目 → **Custom domains** → 添加你的域名，或直接使用 `xxx.pages.dev` 默认地址访问。

---

## 安全说明

- 前端代码里**没有任何** token / 密码 / 密钥；它们只存在于 Cloudflare 环境变量（加密存储）
- 会话 cookie：HttpOnly + Secure + SameSite=Lax，HMAC-SHA256 签名，篡改即失效
- 登录防暴力：同一 IP 失败 8 次锁定 15 分钟（计数存 KV）
- 密码比较使用常数时间算法，防时序攻击
- GitHub API 调用全部在服务端完成，浏览器永远拿不到 GITHUB_TOKEN

## API 一览（全部需登录）

| 路由 | 说明 |
|---|---|
| `POST /api/login` | 密码登录，body `{password, remember?}` |
| `POST /api/logout` | 退出登录 |
| `GET /api/groups` | 读分组配置 |
| `PUT /api/groups` | 保存分组配置（创建/重命名/删除/设默认） |
| `GET /api/repos` | 默认组仓库概览（不含 `?all=1` 时）；`?all=1` 为管理用全量 |
| `GET /api/workflows?repo=owner/name` | 指定仓库的 workflows + 最近 100 次 runs |
| `POST /api/workflowDispatch` | 手动触发 workflow，body `{repo, workflowId, ref}` |
| `POST /api/cronRefresh` | 强制刷新 cron 缓存（一般无需手动，有自动更新） |

## 常见问题

- **页面白屏 / 登录后无数据**：多半是环境变量没配或没配 KV 绑定，检查第 4、5 步
- **"获取仓库失败: Bad credentials"**：GITHUB_TOKEN 无效或权限不足
- **"未获取到任何仓库"**：GITHUB_TOKEN 权限不足，确认勾选 `repo`（私有）或 `public_repo`
- **分组保存报"KV 未绑定"**：第 5 步的 KV binding 没加
- **cron 不自动更新**：改动 workflow 文件 push 后需等缓存刷新（最长 10-15 分钟），或 POST `/api/cronRefresh` 手动刷新