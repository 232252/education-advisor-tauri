# Education Advisor — 工程百科 (WIKI.md)

> **本文是 `education-advisor-tauri` 的权威工程指南，比普通 wiki 更详细。**
> 目标读者：接手维护的开发者、AI 编程助手（包括能力较弱的小模型）、想理解"这套东西究竟怎么搭起来"的任何人。
> 写作原则：**每一条结论都带源文件行号引用**，小模型也能照着行号打开文件核对。
>
> - **当前版本**：Tauri `0.1.0` / `package.json` `0.1.0-rc.1` / `pi-agent-core` & `pi-ai` `0.80.3`（vendored）
> - **最后更新**：2026-07-17
> - **配套文档**：[`BUILD.md`](./BUILD.md)（构建）、[`TESTING.md`](./TESTING.md)（测试总览）、[`docs/CODE_WIKI.md`](./docs/CODE_WIKI.md)（结构化代码索引）、[`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md)（故障排查大全）

---

## 📑 目录

1. [这个项目到底是什么](#1-这个项目到底是什么)
2. [30 秒看懂整体架构](#2-30-秒看懂整体架构)
3. [运行时进程模型（三个进程）](#3-运行时进程模型三个进程)
4. [目录结构速查](#4-目录结构速查)
5. [源代码逐层精读](#5-源代码逐层精读)
   - 5.1 [Tauri Rust 外壳（`src-tauri/src/`）](#51-tauri-rust-外壳src-taurisrc)
   - 5.2 [Node Sidecar + Electron Shim（`src/sidecar/`）](#52-node-sidecar--electron-shimsrcsidecar)
   - 5.3 [IPC 通道与 Handler（`src/main/ipc/` + `src/shared/ipc-channels.ts`）](#53-ipc-通道与-handlersrcmainipc--srcsharedipc-channelsts)
   - 5.4 [业务服务层（`src/main/services/` 22 个 service）](#54-业务服务层srcmainservices-22-个-service)
   - 5.5 [数据引擎 EAA CLI（`core/eaa-cli/`）](#55-数据引擎-eaa-clicoreeaa-cli)
   - 5.6 [渲染层 React 前端（`src/renderer/`）](#56-渲染层-react-前端srcrenderer)
6. [18 个 Agent 清单](#6-18-个-agent-清单)
7. [数据存储与持久化](#7-数据存储与持久化)
8. [页面指导（Page Guide）](#8-页面指导page-guide)
9. [怎么编译 / 怎么跑](#9-怎么编译--怎么跑)
10. [构建产物与体积预估](#10-构建产物与体积预估)
11. [可能出现的问题（最常见）](#11-可能出现的问题最常见)
12. [怎么加新功能（动手指南）](#12-怎么加新功能动手指南)
13. [文档地图（其他文档去哪看）](#13-文档地图其他文档去哪看)

---

## 1. 这个项目到底是什么

**Education Advisor** 是一个面向中国中学 / 高中班主任的 **本地优先（local-first）桌面应用**，提供：

- 操行分（event-based score）管理：所有加分 / 扣分事件 append-only、可审计、原子持久化
- 家长沟通：飞书（Lark）机器人长连接 + Bitable 同步
- 周报 / 风险预警：18 个 AI Agent 协作生成
- 学生档案 / 学业成绩：本地 SQLite + JSON 文件
- 隐私保护：PII 脱敏引擎（AES-256-GCM）

**它不是**：聊天机器人、SaaS、云端服务。**它是**：一个本地桌面工具。所有学生数据存在本地 Rust 事件源存储（EAA CLI）中，**LLM 是唯一需要联网的部分**。

**当前形态**：Tauri 2 桌面应用（2026-07 从 Electron 33 迁移而来）。迁移核心思路是 **"业务代码零改动，只换 shell"**——所有原本跑在 Electron 主进程里的业务代码，现在原封不动跑在一个 Node sidecar 子进程里，由 Rust 外壳拉起、通过 stdin/stdout JSON-RPC 通信。原 Electron 入口 `src/main/index.ts` 完整保留，两套架构共存，便于回退与对照。

### 核心技术栈一览

| 层 | 技术 |
|---|---|
| 外壳 | Tauri 2（Rust 1.95）+ WebView2 |
| Sidecar | Node.js ≥ 22，跑原 Electron 主进程业务代码（通过 electron-shim 伪装 `electron` 模块） |
| 数据引擎 | Rust CLI（`eaa-cli`），子进程 spawn 调用 |
| LLM SDK | `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`，**vendored 在 `vendor/`，版本 `0.80.3`** |
| 前端 | React 18 + Vite 6 + TailwindCSS 3 + Zustand 5 + react-router-dom 6 + ECharts 5 |
| 数据库 | better-sqlite3（SQLite，WAL 模式）+ JSON 文件 + Rust 事件源 |
| 测试 | Vitest 3（双 project：renderer/jsdom + main/node） |

---

## 2. 30 秒看懂整体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│ ① WebView2 渲染进程 (React SPA)                                       │
│   src/renderer/ · 11 个路由页面 · window.api (typed)                  │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ Tauri invoke('ipc_invoke', {channel, args})
                           │ Tauri listen(channel) ← 事件推送
┌──────────────────────────▼───────────────────────────────────────────┐
│ ② Rust 外壳 (education-advisor-tauri.exe)                             │
│   src-tauri/src/{main.rs, sidecar.rs, sys_bridge.rs}                 │
│   职责：拉起 Node sidecar、转发 JSON-RPC、原生能力(打开浏览器/对话框)  │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ stdin/stdout (newline-delimited JSON-RPC)
┌──────────────────────────▼───────────────────────────────────────────┐
│ ③ Node Sidecar (node dist/sidecar/sidecar.mjs)                        │
│   · 跑全部原 Electron 业务代码（经 electron-shim 伪装）               │
│   · 16 组 IPC handler（~135 个通道）+ 22 个 service                   │
│   · 拥有 SQLite、agents.yaml、cron、飞书 bot、LLM 调用                │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ cross-spawn (per-command)
┌──────────────────────────▼───────────────────────────────────────────┐
│ ④ Rust EAA CLI (eaa.exe) — 子进程                                     │
│   操行分数据引擎：事件追加、打分、排名、统计、隐私加密                 │
└──────────────────────────────────────────────────────────────────────┘
```

**关键边界**：
- **进程①（渲染）↔ 进程②（Rust 外壳）**：用 Tauri 标准 `invoke` / `listen`，与普通 Tauri 应用一致。
- **进程②（Rust 外壳）↔ 进程③（Node sidecar）**：**stdio 上的 newline-delimited JSON-RPC**。不是 WebSocket、不是命名管道、不是 HTTP——就是 stdin/stdout。这是迁移设计的核心（`src-tauri/src/main.rs:1-11` 的注释明确说明）。
- **进程③（sidecar）↔ 进程④（EAA CLI）**：sidecar 用 `cross-spawn` 为每条 EAA 命令拉起一个短命子进程，捕获 stdout 解析成 JSON。

---

## 3. 运行时进程模型（三个进程）

打包后双击 `Education Advisor_0.1.0_x64-setup.exe` 安装运行，会同时存在 **3 个 OS 进程**（不算 WebView2 的辅助进程）：

| 进程 | 可执行 | 谁拉起的 | 拥有什么 | 死了会怎样 |
|---|---|---|---|---|
| ① Rust 外壳 | `education-advisor-tauri.exe`（~5.4 MB） | 用户双击 / 开机自启 | 窗口、系统托盘、原生对话框、所有 Tauri 插件 | 应用退出 |
| ② WebView2 渲染 | `msedgewebview2.exe`（系统自带） | Rust 外壳 | React UI | UI 消失 |
| ③ Node sidecar | `node.exe`（打包携带，~98 MB） | Rust 外壳 spawn | **全部业务逻辑**：SQLite、agents.yaml、cron、飞书 bot、LLM 调用 | **不会自动重启**，后续 IPC 调用会挂起到 300 秒超时（`src-tauri/src/sidecar.rs:174-178`） |
| ④ EAA CLI | `eaa.exe`（Rust 编译，~10 MB） | Node sidecar 每次命令 spawn | 操行分数据计算 | 单次命令失败，下次重试 |

### 跨进程通信协议

**渲染 → Rust**：Tauri 命令 `ipc_invoke`（`src-tauri/src/sidecar.rs:312-319`），载荷是 `{ channel: string, args: any[] }`。

**Rust → Node sidecar**：写入一行 JSON 到 sidecar 的 stdin，格式：
```json
{"id":1,"type":"invoke","channel":"academic:set-grade","args":[{...}]}
```

**Node sidecar → Rust**：写入一行 JSON 到 stdout，三种类型：
```json
{"id":1,"type":"result","ok":true,"data":{...}}        // 响应某次 invoke
{"type":"event","channel":"agent:status-update","data":{...}}  // 主动推送事件给渲染层
{"type":"sys","request":"openExternal","args":{"url":"..."}}   // 请求 Rust 帮忙做原生操作
```

**Rust → 渲染**：sidecar 发出的 `event` 帧，Rust 读到后调用 `app.emit(channel, data)`，渲染层 `listen(channel)` 收到。

⚠️ **注意**：sidecar 发出的 `sys` 请求（如 sidecar 自己想打开浏览器），Rust 处理后 **不会回传结果给 sidecar**（`src-tauri/src/sidecar.rs:266-284` 的代码注释里写着 `/* not sent back */`）。所以凡是需要原生能力的操作，**都走渲染层发起**（路径 A），而不是 sidecar 自己发起（路径 B）。这是当前架构的一个已知限制。

### 启动顺序

应用启动时，Rust 外壳 `main.rs:63-94` 会：
1. 注册 Tauri 插件（shell/dialog/notification/os/single-instance）
2. 调用 `SidecarHandle::spawn()` 拉起 `node dist/sidecar/sidecar.mjs`，设置环境变量 `EDU_APP_DATA_DIR` / `EDU_RESOURCE_DIR` / `EDU_IS_PACKAGED`
3. 创建主窗口，加载 `http://localhost:5173`（dev）或 `tauri://localhost`（prod，前端已编译进 `dist/renderer/`）

sidecar 启动后 `src/sidecar/sidecar-entry.ts` 会：
1. 劫持 `console.*`，把日志也包装成 `{type:"console",...}` JSON 帧写到 stdout（避免污染 JSON-RPC 流）
2. 在 stdin 上装 readline 逐行解析
3. 复用 `src/main/ipc/index.ts` 的 `registerAllHandlers()` 注册全部 16 组 handler
4. 初始化 EAA bridge、agent runtime、cron、settings、keystore
5. 进入事件循环等待请求

---

## 4. 目录结构速查

```
education-advisor-tuari/
├── src/
│   ├── main/              # 原 Electron 主进程业务代码（现在跑在 sidecar 里）
│   │   ├── index.ts        # Electron 入口（保留，向后兼容）
│   │   ├── preload/index.ts# Electron preload（暴露 window.api）
│   │   ├── ipc/            # 16 组 IPC handler（见 §5.3）
│   │   ├── services/       # 22 个 service（见 §5.4）
│   │   └── utils/logger.ts # 日志（30 天滚动）
│   ├── renderer/          # React 前端（见 §5.6）
│   │   ├── App.tsx         # 路由 + providers
│   │   ├── main.tsx        # 入口，装 tauri-bridge
│   │   ├── pages/          # 11 个页面目录
│   │   ├── components/     # 共享组件（Toast/ContextMenu/Card/Badge/...）
│   │   ├── stores/         # zustand: chatStore/agentStore/settingsStore/toastStore
│   │   ├── hooks/          # useTheme/useT/useAsync/useDataLoader/...
│   │   ├── i18n/           # zh.json / en.json
│   │   ├── lib/            # ipc-client.ts / tauri-bridge.ts / ui-utils.ts
│   │   ├── layouts/        # MainLayout.tsx（侧边栏 + Outlet）
│   │   └── styles/globals.css
│   ├── shared/            # 主进程与渲染层共享
│   │   ├── ipc-channels.ts # 全部 ~141 个 IPC 通道字符串常量
│   │   ├── types/          # 共享 TypeScript 类型
│   │   └── debug.ts        # DEBUG 环境变量解析
│   └── sidecar/           # sidecar 专用代码
│       ├── sidecar-entry.ts # 实际 sidecar 入口
│       └── electron-shim.ts # 伪装 electron 模块（见 §5.2）
├── src-tauri/             # Tauri Rust 外壳
│   ├── src/{main.rs, sidecar.rs, sys_bridge.rs}
│   ├── tauri.conf.json     # Tauri 配置（见 §9）
│   ├── Cargo.toml          # Rust 依赖
│   ├── capabilities/       # Tauri 2 权限配置
│   ├── nsis/               # 自定义安装器素材（ico/bmp/hooks.nsh）
│   └── icons/              # 应用图标
├── core/eaa-cli/          # Rust 数据引擎源码（独立 crate）
├── sidecar/
│   └── edu-sidecar.mjs     # 固定路径启动器（见 §5.2）
├── config/                # 打包进安装器的配置
│   ├── agents.yaml         # 18 个 agent 定义（见 §6）
│   ├── mcp.yaml            # MCP 服务器配置（当前空）
│   ├── default-settings.json
│   ├── reason-codes.json   # 操行分原因码（加分/扣分代码表）
│   └── SMALL_MODEL_RULES.md
├── agents/                # 18 个 agent 的 prompt（每个目录 SOUL.md + AGENTS.md）
├── vendor/                # vendored 依赖
│   ├── pi-agent-core/      # @earendil-works/pi-agent-core@0.80.3
│   └── pi-ai/              # @earendil-works/pi-ai@0.80.3
├── resources/
│   ├── eaa-binaries/        # 预编译 EAA CLI（按平台分子目录）
│   └── node.exe             # 打包携带的 Node 22 运行时
├── tests/                 # 测试（见 TESTING.md）
│   ├── main/               # service 单测
│   ├── renderer/           # 渲染层纯函数单测
│   ├── e2e/                # 端到端（含真 EAA 二进制）
│   └── setup.ts
├── scripts/               # 构建/自检/调试脚本（130+ 个）
├── docs/                  # 文档（见 §13）
├── package.json           # npm 脚本与依赖
├── vite.config.{main,renderer,sidecar}.ts  # 三套构建配置
└── vitest.config.ts       # 测试配置
```

---

## 5. 源代码逐层精读

### 5.1 Tauri Rust 外壳（`src-tauri/src/`）

只有 3 个 Rust 源文件，加起来 ~600 行。**这是整个项目里最容易看懂的部分**，强烈建议接手时先读这 3 个文件。

#### `src-tauri/src/main.rs`（~130 行）
- `main()` 函数（`main.rs:63-94`）：注册插件、`SidecarHandle::spawn()`、创建窗口。
- `which_node()`（`main.rs:75-88`）：决定用哪个 node 可执行——打包后用 `resources/node.exe`，开发时用 `PATH` 上的 node。
- 窗口关闭处理（`main.rs:121-132`）：detached thread 调 `handle.shutdown()`，避免阻塞 UI 线程。
- 单实例保护（`main.rs:32-39`）：`tauri-plugin-single-instance`，防止开两个。

#### `src-tauri/src/sidecar.rs`（~400 行）——**最核心**
- `SidecarHandle::spawn()`（`sidecar.rs:75-147`）：spawn `node edu-sidecar.mjs`，stdin/stdout pipe，启动一个 reader 线程逐行解析 stdout。
- `WireMessage` 协议（`sidecar.rs:42-62`）：上面 §3 列的四种 JSON 帧。
- `request()`（`sidecar.rs:151-188`）：用 `mpsc::channel` + `AtomicU64` 自增 id 做请求/响应配对，`recv_timeout` 默认 300 秒（`EDU_SIDECAR_TIMEOUT_SECS` 可调）。
- reader 线程（`sidecar.rs:114-138`）：逐行 `serde_json::from_str`，按 `type` 字段分发到 `handle_wire_message`。
- `handle_wire_message`（`sidecar.rs:242-309`）：`result` → 配对 mpsc；`event` → `app.emit`；`sys` → 调 `sys_bridge`；`console` → `eprintln!`。
- `ipc_invoke` Tauri 命令（`sidecar.rs:312-319`）：渲染层调 `invoke('ipc_invoke', {channel, args})` 时，转发给 `state.request(channel, args)`。
- 优雅关闭（`sidecar.rs:206-223`）：写 `{"type":"shutdown"}` → sleep 1500ms（让 settings/keystore 落盘）→ `child.kill()` + `child.wait()`。`Drop` 实现（`sidecar.rs:226-240`）做兜底强杀。

#### `src-tauri/src/sys_bridge.rs`（~220 行）
- `handle_sidecar_sys_request()`（`sys_bridge.rs:149-214`）：处理 sidecar 发来的 `openExternal` / `showInFolder` / `getPath` 等原生请求。
- `sys_open_external` Tauri 命令（`sys_bridge.rs:92-101`）：渲染层直接调的原生打开 URL。
- 一堆 `#[tauri::command]` 函数：sys_show_in_folder / sys_notification / sys_show_save_dialog / ...

#### `src-tauri/tauri.conf.json`（78 行，见 §9 完整说明）
- `version: "0.1.0"`，`identifier: "com.educationadvisor.tauri"`
- `bundle.targets: ["nsis", "msi"]`
- `bundle.resources`（`tauri.conf.json:43-56`）：列出全部打包进安装器的资源（见 §10 体积预估）。
- `security.csp`（`tauri.conf.json:26`）：connect-src 白名单写死了 7 个 LLM provider + 飞书 + Ollama 本地。**新增 LLM provider 必须改这里**，否则前端 fetch 会被 CSP 拦截。

---

### 5.2 Node Sidecar + Electron Shim（`src/sidecar/`）

这是迁移最巧妙的部分。原本 `src/main/index.ts` 是 Electron 主进程入口，里面 `import { app, BrowserWindow, ... } from 'electron'`。为了让这些代码在普通 Node 进程里也能跑，sidecar 用 `vite.config.sidecar.ts:51-56` 把 `'electron'` 这个模块 **alias 到 `src/sidecar/electron-shim.ts`**——一个伪装的 electron 模块。

#### `src/sidecar/electron-shim.ts`（编译后是 `sidecar/electron-shim/index.mjs`，~500 行）
提供了 electron 全部 API 的"假装实现"：

| electron API | shim 实现 | 说明 |
|---|---|---|
| `app.getPath('userData')` | 返回 `process.env.EDU_APP_DATA_DIR` | sidecar 用环境变量找 userData |
| `app.isPackaged` | `process.env.EDU_IS_PACKAGED === '1'` | |
| `app.getVersion()` | 硬编码 `'0.1.0'` | 改版本要同步这里 |
| `app.resourcesPath` | `process.env.EDU_RESOURCE_DIR` | |
| `BrowserWindow.webContents.send` | 写 `{type:"event",...}` 到 stdout | **sidecar→渲染层事件的唯一出口** |
| `ipcMain.handle(channel, fn)` | 注册到内存 Map，sidecar-entry 路由调用 | |
| `safeStorage.encryptString/decryptString` | **真实 AES-256-GCM**，key 从 hostname+username+platform 派生 | 替代 Windows DPAPI，跨平台 |
| `dialog/shell.openExternal/Notification/Tray/Menu` | 转发到 `sys` 请求 | **结果回不来**（见 §3 警告） |
| `contextBridge/ipcRenderer` | 占位空实现 | 防止遗留 preload 代码 import 失败 |

#### `src/sidecar/sidecar-entry.ts`（~340 行）
真正的 sidecar 入口。做的事：
1. `setOutbound({ emitEvent, sysRequest })` —— 把两个出站回调装到 shim 上
2. 劫持 `console.*` 包装成 `{type:"console",level:...,data:...}` 写 stdout（关键！stdout 是 JSON-RPC 通道，非 JSON 文本会破坏协议，Rust 端 `sidecar.rs:124-128` 会打 `[sidecar:txt]` 警告）
3. 在 stdin 装 readline，逐行 `JSON.parse`
4. 收到 `{type:"invoke",...}` → `getHandler(channel)(event, ...args)` → 写回 `{type:"result",...}`
5. 复用 `src/main/ipc/index.ts` 的 `registerAllHandlers()` —— **跟 Electron 模式跑同一份代码**
6. `eaaBridge.initialize()` + `agentService.init()` + `cronService.registerBitableSync()`

#### `sidecar/edu-sidecar.mjs`（启动器，固定路径）
为什么 Rust 不直接 spawn `dist/sidecar/sidecar.mjs`？因为 vite 构建产物路径可能会变（`.mjs` / `.js` / `.cjs`），而 Rust 启动命令要稳定。所以留了一个固定路径 `sidecar/edu-sidecar.mjs`，它做的事就是 `findBundle()` 找到真实 bundle 然后 `import()` 它。注释在文件开头第 5 行说得很清楚。

---

### 5.3 IPC 通道与 Handler（`src/main/ipc/` + `src/shared/ipc-channels.ts`）

#### 通道常量 `src/shared/ipc-channels.ts`
全部通道名是普通字符串常量（如 `'academic:set-grade'`），按命名空间分组导出。**没有中央路由**，各 handler 文件按需 `import { IPC_ACADEMIC_SET_GRADE } from '../../shared/ipc-channels'`。

| 前缀 | 数量 | 文件 | 典型通道 |
|---|---:|---|---|
| `ai:*` | 12 | `ipc-channels.ts:6-17` | `list-providers`, `chat`, `chat-stream`(event) |
| `ollama:*` | 7 | `:20-27` | `detect`, `start-serve`, `pull-model`, `pull-progress`(event) |
| `agent:*` | 12 | `:30-41` | `run-manual`, `status-update`(event), `abort` |
| `eaa:*` | 25 | `:44-68` | `add-student`, `add-event`, `score`, `ranking`, `history` |
| `privacy:*` | 13 | `:70-82` | `init`, `load`, `lock`, `anonymize` |
| `cron:*` | 8 | `:85-92` | `add`, `toggle`, `run-now`, `status-update`(event) |
| `skill:*` | 4 | `:95-98` | `list`, `save`, `delete` |
| `settings:*` | 3 | `:101-103` | `get`, `set`, `reset` |
| `sys:*` | 8 | `:106-112,176` | `open-dialog`, `check-update`, `notification` |
| `profile:*` | 2 | `:115-116` | `get`, `set` |
| `academic:*` | 10 | `:119-128` | `set-grade`, `batch-set-grades`, `analyze-paper` |
| `class:*` | 10 | `:131-141` | `create`, `assign`, `assign-progress`(event) |
| `chat:*` | 4 | `:144-147` | `save-message`, `load-messages`, `list-sessions` |
| `feishu:*` | 9 | `:151-160` | `test`, `bot-start`, `bot-status-update`(event) |
| `log:*` | 9 | `:164-172` | `list`, `read`, `clear`, `write-renderer` |
| `mcp:*` | 5 | `:179-183` | `list`, `connect`, `list-tools`, `test` |

**合计约 141 个通道常量、135 个 handler 端点**（有的通道是 send-only 事件，没有 handler）。

#### Handler 注册 `src/main/ipc/index.ts`
`registerAllHandlers(win)` 是一个扁平的注册序列（`index.ts:24-49`）：

```ts
export async function registerAllHandlers(win) {
  registerAIHandlers(win)         // 12 个，含 chat 持久化
  registerAgentHandlers(win)      // 11 个
  registerEAAHandlers(win)        // 24 个 + 1 个 cache 失效内部事件
  registerPrivacyHandlers(win)    // 13 个
  registerCronHandlers(win)       // 7 个
  registerSkillHandlers(win)      // 4 个
  registerSettingsHandlers(win)   // 3 个 + 副作用
  registerSysHandlers(win)        // 8 个
  registerProfileHandlers()       // 2 个
  registerAcademicHandlers()      // 10 个
  registerLogHandlers()           // 8 个
  registerFeishuHandlers(win)     // 8 个
  registerOllamaHandlers(win)     // 6 个
  registerClassHandlers()         // 8 个
  registerMcpHandlers(win)        // 5 个
  await eaaBridge.initialize()    // EAA 引导
  await agentService.init(win)    // Agent 运行时引导
}
```

注意：`chat:*` 通道注册在 `ai-handlers.ts` 里（没有独立的 chat-handlers.ts 文件），因为 chat 持久化复用了 ai-handlers 已经 import 的 `dbService`。

#### 标准 Handler 模板
每个 handler 长这样：
```ts
ipcMain.handle(IPC.IPC_ACADEMIC_SET_GRADE, async (_e, record) => {
  try {
    sanitizeName(record.studentName, 'studentName')   // 输入消毒
    validateString(record.examId, 'examId', 64)
    return await academicService.setGrade(record)     // 调 service
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[IPC] set-grade failed:', msg)
    return { success: false, error: msg }
  }
})
```

#### 错误流的 3 种形状（没有统一信封！）
| 形状 | 何时用 | 例子 |
|---|---|---|
| `{ success: false, error: string }` | 大多数 handler 捕获异常 | `academic-handlers.ts:47` |
| `{ success: false, message: string }` | agent / cron 用 message 不用 error | `agent-handlers.ts:151` |
| `throw err`（向外抛） | ai-handlers 故意抛，让 invoke 直接 reject | `ai-handlers.ts:104` |

⚠️ **写前端时务必查具体 handler 的返回形状**，没有统一的 `{success, data}` 信封。

#### 输入消毒（defense in depth）
即便渲染层是沙箱，每个 handler 都会自己再做一遍参数校验：
- **学生/班级名**：`sanitizeName` 去零宽字符、控制字符、shell 元字符、拒绝 `--` 开头（防 arg 注入）
- **class_id**：`^[A-Za-z0-9.-]+$`，≤32 字符
- **MCP server id**：`^[a-zA-Z0-9_-]+$`，≤128 字符
- **Ollama 模型名**：`^[a-zA-Z0-9._:/-]+$`，≤128 字符
- **日志路径**：`validateLogPath` 解析后断言 `startsWith(logsDir)`，防路径穿越
- **外部 URL**：协议白名单 `https:` / `mailto:`
- **Cron 表达式**：5 段严格校验 + `node-cron.validate`

---

### 5.4 业务服务层（`src/main/services/` 22 个 service）

按职责分 5 组，每个都是**模块级单例**（如 `export const dbService = new DBService()`），没有 DI 容器。

#### 组 A：数据持久化

| service | 职责 | 关键依赖 | 状态/陷阱 |
|---|---|---|---|
| `db-service.ts` | SQLite（`workstation.db`）：chat 消息、agent 执行历史、cron 日志、classes 表 | `better-sqlite3`（原生模块） | WAL 模式，24h 清理 90 天前数据；**原生模块加载失败会优雅降级**（`_ready=false`，所有方法变 no-op） |
| `academic-service.ts` | 学业（科目/考试/成绩），JSON 文件存 `userData/eaa-data/academics/` | `node:fs/promises` | `safeName` 防路径穿越；`atomicWrite` 用 tmp+rename |
| `class-service.ts` | 班级 CRUD，存 SQLite `classes` 表 | `db-service` | `validateClassId` 限 `[A-Za-z0-9.-]+` ≤32 字符；archive 不删数据只翻转标志 |
| `profile-service.ts` | 学生扩展档案 JSON | `node:fs/promises` | `safeName` 同上 |

#### 组 B：EAA 数据引擎桥接

| service | 职责 | 关键依赖 |
|---|---|---|
| `eaa-bridge.ts`（~880 行） | spawn Rust EAA CLI、路由 21 个子命令、序列化写、缓存读、隐私密码 | `cross-spawn`、`node:fs` |
| `eaa-tools.ts` | 把 11 个 EAA 命令包装成 AgentTool（见 §5.5） | `@earendil-works/pi-agent-core`、`typebox` |

`eaa-bridge.ts` 的核心设计（**这是全项目最复杂的服务，强烈建议精读**）：

- **路径解析**（`eaa-bridge.ts:233`）：按顺序试 3 个位置——dev `resources/eaa-binaries/<platform>/<bin>`、打包 `process.resourcesPath/eaa-binaries/...`、兄弟仓库 `education-advisor/core/eaa-cli/target/release/`。ARM Windows 回退到 x64。
- **写命令串行化**（`eaa-bridge.ts:144, 552-573`）：`WRITE_COMMANDS`（add, add-student, delete-student, set-student-meta, revert, import, init, config, privacy）全部走同一条 Promise 链 `writeQueue`，**避免 Rust JSON writer 看到并发编辑**。读命令等 writeQueue 快照后并发执行。
- **读缓存**（`eaa-bridge.ts:153`）：TTL 10 秒、硬上限 64 条。任何写操作清空整个缓存。
- **stdout/stderr OOM 保护**（`eaa-bridge.ts:634-670`）：10MB stdout / 5MB stderr 上限，超了 `SIGTERM` 杀进程并追加截断标记。
- **Windows exit/close 竞态**（`eaa-bridge.ts:723`）：优先用 `close` 事件，但 Windows 上 `close` 偶尔不触发，所以 `exit` 后延迟 200ms 兜底 resolve。
- **隐私密码**（`eaa-bridge.ts:290`）：只存内存，通过 `EAA_PRIVACY_PASSWORD` 环境变量传给子进程；`sanitizeArgsForLog` 永远不打印它。
- **ENOENT 自愈**（`eaa-bridge.ts:494`）：如果 binaryPath 因杀软隔离变 null，下次 `execute()` 会重新 resolveBinaryPath()，而不是永久禁用——这是 "High 1.1 fix"。

#### 组 C：Agent / LLM 运行时

| service | 职责 | 依赖 |
|---|---|---|
| `agent-service.ts`（~1100 行） | Agent 运行时：加载 agents.yaml、串 cron、调 LLM、调工具、推 status 事件 | `@earendil-works/pi-agent-core.Agent`、`yaml`、`cross-spawn` |
| `pi-ai-service.ts`（~950 行） | LLM provider 列表 / 测试连接 / 流式 chat / 自定义模型管理 | `@earendil-works/pi-ai/compat` |
| `skill-service.ts` | 加载 `userData/skills/*.md` 和项目 `skills/*.md`，每个文件 = 一个 skill | `node:fs` |
| `compaction-helper.ts` | 上下文压缩：token 超限时调 LLM 生成摘要替代旧消息 | `@earendil-works/pi-agent-core` |
| `mcp-service.ts` | MCP 服务器客户端（stdio/sse/websocket 三种 transport） | `node:child_process`、`ws`、`fetch` |
| `mcp-tools.ts` | 把 MCP 工具适配成 AgentTool（含 JSON Schema → TypeBox 转换） | `mcp-service`、`typebox` |
| `file-tools.ts` | 6 个文件工具（read_file/read_excel/write_file/write_excel/write_csv/list_dir），供 agent 调用 | `node:fs`、`xlsx` |
| `utility-tools.ts` | 2 个工具（get_current_time / calculate，安全沙箱求值） | `typebox` |

**Agent 运行流程**（`agent-service.ts:643-1077` 的 `runAgent`，这是项目第二复杂的函数）：

1. 校验 + 防并发（先写占位 `RunningAgent`）
2. 选模型 `selectModel(tier)`（`agent-service.ts:497-631`）：按 settings 优先级 fallback——defaultModel → highQualityModel/lowCostModel → 默认 provider 任意带 key 的模型 → 任意带 key 的模型 → 知名兜底（claude-sonnet-4 / gpt-4o-mini / deepseek-chat）
3. 组装工具：`getToolsByCapability(agents.yaml 里的 capabilities)` + `allFileTools` + `allUtilityTools` + `getMcpToolsForAgent(...)`
4. 拼 system prompt：SOUL.md + skills（只放 name+description 省 token）+ AGENTS.md 规则 + 写死的"你在本地桌面不是沙箱"提示
5. 配置压缩：自适应 `reserveTokens = max(4096, min(userReserve, 10% contextWindow))`
6. `new Agent({ initialState: { systemPrompt, model, thinkingLevel }, getApiKey, transformContext })`
7. 订阅事件：`message_update`→ 推 token 给前端；`tool_execution_*` → 推工具调用；`turn_end` → 计数；`agent_end` → 收 usage
8. 注入历史：把前端 `[{role,content}]` 重建成 `AgentMessage[]`（合成零 usage 的 AssistantMessage）
9. `agent.prompt(text)` 然后 `waitForIdle()` 带 5 分钟超时
10. **continuation 循环**（`agent-service.ts:961-986`）：如果模型输出太短（<200 字符 且 turn<3 且 未 abort），自动重 prompt 最多 5 次——防小模型提前停。
11. 落库 `dbService.updateExecution(...)`，`executionHistory` 上限每 agent 50 条、全局 2000 条。

#### 组 D：外部集成

| service | 职责 | 依赖 | 陷阱 |
|---|---|---|---|
| `ollama-service.ts` | 检测 / 启动 / 停止本地 Ollama，列出 / pull / delete 模型 | `node:child_process.spawn`、`fetch` | `OLLAMA_BASE_URL='http://127.0.0.1:11434'`；`KEYLESS_PROVIDERS=Set(['ollama'])` |
| `feishu-service.ts` | 飞书 REST API（无状态）：token、bitable、发消息 | `fetch`（15s 超时） | 模块级 `cachedToken` 单例（测试要 `vi.resetModules()`） |
| `feishu-bot-service.ts` | 飞书 WebSocket 长连接 bot，收消息 → 路由命令 / 调 agent | `@larksuiteoapi/node-sdk` | 用自定义 fetch HttpInstance 绕过 axios 在 Node22 上的 bug；`startPromise` 防并发 start |
| `feishu-command-router.ts` | `/help /score /ranking /stats /dashboard /agents /list /echo` 命令路由（纯函数，无 electron 依赖，可单测） | 无 | 通过 `CommandContext` 注入依赖 |
| `update-service.ts` | 查 GitHub Releases 有没有新版 | `node:https`、`electron.dialog` | 自带 `compareSemver`；不自动装，只弹对话框 |

#### 组 E：基础设施

| service | 职责 |
|---|---|
| `settings-service.ts` | `userData/settings.json`，dotPath 更新（防原型链污染），300ms 节流落盘 |
| `keystore-service.ts` | API key / 飞书 appSecret 加密存（`userData/keystore.enc`）。Electron 用 safeStorage(DPAPI)，sidecar 用 shim 里的 AES-256-GCM |
| `cron-service.ts` | node-cron 调度。两类任务：用户定义的 + 从 agents.yaml 自动生成的 `agent-schedule-*`。每任务锁防 runNow 与 cron tick 撞车 |
| `tray-service.ts` | 系统托盘（Electron only，Tauri 用插件） |
| `log-handler-utils.ts` | 给 logger 用的辅助函数 |

---

### 5.5 数据引擎 EAA CLI（`core/eaa-cli/`）

独立的 Rust crate（**不在这个仓库的主 Cargo workspace 里**），通过 `npm run build:eaa` 编译成 `resources/eaa-binaries/<platform>/eaa.exe`，被打包进安装器，运行时由 sidecar 的 `eaa-bridge` spawn。

**它拥有什么**（sidecar 完全不碰这部分逻辑）：
- 学生 / 事件 / 分数 / 原因码的持久化（JSON 文件 append-only，`tmp → fsync → rename` 原子写）
- 所有打分数学：基础分 100、delta 累加、百分位排名、按时间区间统计
- 数据校验：对照 `schema/reason_codes.json` 检查 label/category/score_delta
- 数据导出：csv / jsonl / html
- 隐私模式：`EAA_PRIVACY_PASSWORD` 环境变量启用 AES-256-GCM 加密

**21 个子命令**：`info, score, ranking, replay, add, revert, history, search, range, tag, stats, validate, export, list-students, add-student, delete-student, set-student-meta, import, codes, doctor, summary, dashboard`（外加 `init/config/privacy` 系统命令）。

**JSON 输出**：`eaa-bridge` 自动给"JSON 兼容命令"追加 `--output json` 参数，stdout 直接 `JSON.parse`。纯文本命令（doctor/validate）走 stderr 文本模式。

**为什么这么分？** 项目原本有独立的 `eaa-cli` 仓库，后来合进 monorepo。Rust 负责所有数值正确性，JS 只负责命令路由和结果解析——这样 Rust 那边的逻辑可以独立 review 和审计。

---

### 5.6 渲染层 React 前端（`src/renderer/`）

#### 入口与路由
- `main.tsx`：挂载 React 18 StrictMode。**如果检测到 `window.__TAURI_INTERNALS__`**，先动态 import `lib/tauri-bridge.ts` 调 `installTauriBridge()` 装 `window.api`，再 import App。Electron 模式下 preload 已经装好了。
- `App.tsx`：用 `HashRouter`（`App.tsx:84`），全部页面是 `lazy(() => import(...))` 做代码分割。默认路由 `/` → 重定向 `/dashboard`。`<ToastContainer />` 和 `<ContextMenu />` 装在 router 外面（跨路由存活）。
- `usePrefetchPages()`（`App.tsx:52-73`）：用 `requestIdleCallback`（兜底 `setTimeout 1500`）预取所有页面 chunk，第一次导航秒开。

#### IPC 客户端 `src/renderer/lib/ipc-client.ts`
- 声明了完整的 `WindowAPI` TypeScript 接口（`ipc-client.ts:50-362`），覆盖所有命名空间。
- `getAPI()`（`ipc-client.ts:372`）：返回 `window.api`，缺了就抛。
- `getErrorMessage(result, fallback='未知错误')`（`ipc-client.ts:384`）：EAA 文本命令的错误优先取 `data`，JSON 命令取 `stderr`。

#### `lib/tauri-bridge.ts`（Tauri 专用，489 行）
- 构造跟 Electron preload **一模一样形状**的 `window.api`，所有方法变成 `tauriInvoke('ipc_invoke', { channel, args })`。
- 通道常量在文件顶部 `:23-176` 重新声明一份（注释说"与 `src/shared/ipc-channels.ts` 保持一致"，Tauri 编译期命令不能引用运行时常量）。
- 事件订阅（`onStream` / `onPullProgress` / `onStatusUpdate` / ...）用 `@tauri-apps/api/event` 的 `listen`，返回一个捕获了 `unlisten` + `cancelled` flag 的闭包，防竞态。
- `installTauriBridge()`（`:484`）：把构造好的对象赋给 `window.api`。

#### 状态管理 Zustand（4 个 store）

| store | 持有 | 谁订阅 |
|---|---|---|
| `chatStore.ts` | messages、isStreaming、currentModel、sessions、thinkingLevel | ChatPage（重逻辑都在这：流处理、session CRUD、agent 事件桥接） |
| `agentStore.ts` | agents 列表、liveOutput、liveToolCalls、isRunning | MainLayout 初始化 IPC 监听；AgentsPage / ChatPage 通过 `subscribeStatus(fn)` 派生订阅 |
| `settingsStore.ts` | 完整 UnifiedSettings 缓存 | 实际 SettingsPage 不用它（自己维护本地 state）；未来组件可复用 |
| `toastStore.ts` | toast 队列 + 定时器 | 全局；**静态 `toast.error/success/...` 是页面报错的唯一推荐方式**（不要只 `console.error`） |

⚠️ **agent status 事件只有一个 IPC 订阅**（`agentStore.initStatusListener()` 由 MainLayout 调一次）。需要响应的组件用 `useAgentStore.getState().subscribeStatus(fn)`，避免重复订阅丢流。

#### i18n（`src/renderer/i18n/`）
- 两本字典 `zh.json` / `en.json`（442 个 key 对齐）。
- 模块级 `currentLang` + `localStorage` 持久化 + `i18n-changed` CustomEvent 通知。
- `useT()` 返回 `{ t, lang }`，订阅事件重渲染。
- SettingsPage 把 `general.language`（`zh-CN`/`en-US`）和 i18n `Lang`（`zh`/`en`）双向同步。

#### 主题（`src/renderer/hooks/useTheme.ts`）
- 三态：`dark` / `light` / `system`。`system` 跟 `matchMedia('(prefers-color-scheme: dark)')`。
- `applyTheme()` 切换 `<html class="dark">`。
- 监听 `matchMedia change` 和 `theme-changed` CustomEvent（由 SettingsPage / ThemeToggle 派发）。
- CSS 变量在 `styles/globals.css` 的 `:root` 和 `.dark` 定义，Tailwind `dark:` 变体叠在上面。`tailwind.config.js` 设 `darkMode: 'class'`。

#### 共享组件 `src/renderer/components/`

| 组件 | 用途 |
|---|---|
| `ToastContainer.tsx` | 右上角 toast 栈，订阅 toastStore |
| `ContextMenu.tsx` | **全局右键**。三级优先级：自定义 `[data-ctx-menu]` > 可编辑输入 > 选中文本。自定义动作派发冒泡 `ctx-menu-action` 事件，页面监听 |
| `ErrorBoundary.tsx` | 类组件 + 监听 `window.error` 和 `unhandledrejection`（React 边界只抓渲染错误） |
| `Card.tsx` / `Badge.tsx` | 容器与徽章（含 `<RiskBadge>`） |
| `ComboBox.tsx` | 可输入 + 下拉的混合控件（键盘导航、点击外部关闭） |
| `ConfirmDialog.tsx` | `window.confirm` 的模态替代品 |
| `EmptyState.tsx` / `Skeleton.tsx` | 空态与骨架屏 |
| `ModelSelector.tsx` | 双栏 popover 选 provider + model，记忆化避免流式输出时重渲染 |
| `ThemeToggle.tsx` | 侧边栏主题切换按钮 |

#### 布局 `src/renderer/layouts/MainLayout.tsx`
- `w-52` 侧边栏 + `<Outlet />`。
- 侧边栏：logo + `NAV_ITEMS` 导航（`MainLayout.tsx:13-29`，每项 `path/icon/labelKey`）+ 实时 agent 状态点（前 6 个 agent）+ `ThemeToggle`。
- **页面初始化只在这里发生一次**：`fetchAgents()` 和 `initStatusListener()`。其他页面共享。

---

## 6. 18 个 Agent 清单

定义在 `config/agents.yaml`（18 个 `- id:` 项），每个 agent 在 `agents/<id>/` 目录下有 `SOUL.md`（人设）和 `AGENTS.md`（规则）。每个 agent 字段：`id, name, role, description, enabled, model_tier (high_quality|low_cost), capabilities (工具白名单), schedule.cron (数组), risk_thresholds`。

**教育参谋体系（来自 education-advisor，10 个）**：

| id | name | 一句话职责 | 典型 cron |
|---|---|---|---|
| `main` | 教育参谋 | 主协调员，接用户消息、分派给其他 agent、推送报告 | 手动 |
| `governor` | 督导 | 7 个 cron 任务（每天 6/12/18/22 点 + 周五提醒 + 周日周报 + 月度），数据质量审计、风险分析 | 多时段 |
| `counselor` | 辅导员 | 每天 07:05 学业报告 + 20:00 更新；追踪后 25% 学生 | 2 个 |
| `supervisor` | 督导汇总员 | 多维度学生风险评估（学业/纪律/心理/社交）生成综合报告 | 手动 |
| `validator` | 数据效验 AI | 每 6h 数据完整性 / 准确性 / 覆盖度检查 | `0 */6 * * *` |
| `academic` | 学业分析师 | 每天 07:05 学业报告，6 科加权分析、挂科管理 | `5 7 * * *` |
| `psychology` | 心理危机监测员 | 每天 21:00 心理检查、危机干预建议 | `0 21 * * *` |
| `safety` | 安全检查员 | 每周一 08:00 实验室安全 + 校园周边环境检查 | `0 8 * * 1` |
| `home_school` | 家校沟通员 | 每天 08:30 家长沟通通知（学业/行为/紧急） | `30 8 * * *` |
| `research` | 科研助理 | 每天 22:10 科研项目 + 论文数据收集 | `10 22 * * *` |
| `executor` | 系统执行员 | 每天 01:00 系统自维护、错误修复、备份管理 | `0 1 * * *` |

**班级管理 Agent（原 class-management，7 个）**：

| id | name | 一句话职责 | 典型 cron |
|---|---|---|---|
| `class-monitor` | 班务助理 | 每天加减分录入、学生分查询、班级汇总（班主任/班长用） | 手动 |
| `risk-alert` | 风险预警员 | 工作日 08:00 + 周五 17:00 扫描全员分数、提风险生 | `0 8 * * 1-5` |
| `data-analyst` | 数据分析师 | 每周一 09:00 多维度统计分析 | `0 9 * * 1` |
| `student-care` | 学生关怀员 | 正向行为追踪与奖励生成、提振班风 | 手动 |
| `discipline-officer` | 纪律管理员 | 严重违纪处理（吸烟饮酒实验室违规） | 手动 |
| `weekly-reporter` | 周报撰写员 | 每周五 16:00 自动生成班级周报 | `0 16 * * 5` |
| `bug-hunter` | Bug Hunter | 代码质量把关：复现 bug、定位根因、写回归测试、生成报告 | 手动 |

（共 18 个；`talk_planner` 已合并进 `counselor` 并删除，见 `agents.yaml:271-272` 注释。）

**risk_thresholds** 统一为 `{ high: 85, medium: 93, low: 93 }`（P2-12 修复后）。

**MCP 配置**（`config/mcp.yaml`）：当前 `servers: []` 是空的（文件只是模板，有 3 个注释掉的示例）。没有任何 agent 引用 MCP 服务器，系统作为单进程 sidecar 跑，没有外部工具服务器。安全护栏（路径校验 + shell 元字符消毒）实现了但当前未启用。

---

## 7. 数据存储与持久化

`userData/` 目录布局（`userData` 在 Windows 是 `%APPDATA%/Education Advisor`，由 sidecar `EDU_APP_DATA_DIR` 环境变量决定）：

```
userData/
├── workstation.db              # db-service (SQLite, WAL 模式)
│                                 chat_messages / chat_sessions / agent_executions / cron_logs / classes
├── keystore.enc                # keystore-service (AES-256-GCM 加密，存 API key + 飞书 appSecret)
├── settings.json               # settings-service (UnifiedSettings)
├── agents.user.yaml            # agent-service (用户对 agents.yaml 的覆盖)
├── cron-logs.jsonl             # cron-service (加载时只读最后 2MB)
├── skills/*.md                 # skill-service (用户可编辑)
├── logs/                       # logger (main/chat/renderer 三流，30 天滚动)
│   ├── main-YYYY-MM-DD.log
│   ├── chat-YYYY-MM-DD.log
│   └── renderer-YYYY-MM-DD.log
└── eaa-data/                   # EAA Rust 引擎拥有
    ├── entities/entities.json  # 学生主数据
    ├── entities/name_index.json
    ├── events/events.json      # append-only 事件流
    ├── logs/                   # EAA 自己的日志
    ├── reason_codes.json       # JS 引导生成 → Rust 消费
    ├── schema/reason_codes.json # Rust 期望的嵌套格式
    ├── academics/              # academic-service
    │   ├── config.json
    │   ├── exams.json
    │   └── grades/<safeName>.json
    └── profiles/<name>.json    # profile-service
```

**两套长期数据完全独立**：EAA 不知道学业（academic），学业不知道分数。它们只共享"学生名字"字符串作为软外键。删班级不会动 EAA 学生；删 EAA 学生不会动 `academics/grades/<name>.json`。

**`workstation.db` 的优雅降级**是关键设计：如果 `better-sqlite3` 原生模块加载失败（Node 版本不对、缺 C++ 工具链），`_ready=false`，所有方法变 no-op 返回 `false / [] / -1 / null`。**应用不会崩**，chat 历史只是变成内存态。这也是测试用 `dbService.isReady()` 守门的原因。

---

## 8. 页面指导（Page Guide）

11 个页面，全部 `src/renderer/pages/<Name>/`。下表是每个页面的"做什么 + 调哪些 IPC + 用哪些 store"快速索引：

| 路由 | 页面文件 | 做什么 | 主要 IPC | Store |
|---|---|---|---|---|
| `/dashboard` | `Dashboard/DashboardPage.tsx` | 5 张统计卡 + 柱/饼图 + top10 排名 + 周期摘要 + 班级对比表 + 双班级 PK + doctor 面板 | `eaa.stats/summary/ranking/info/tag/listStudents/range/invalidateCache`、`class.list` | 无（本地 useState） |
| `/chat` | `Chat/ChatPage.tsx` | Agent 对话（**始终经过 agent**，没有"直聊"），左侧 session 列表、上传文件、上下文进度条 | `agent.runManual`、`ai.onStream`、`chat.saveMessage/loadMessages/listSessions/deleteSession`、`settings.set` | chatStore + agentStore |
| `/students` | `Students/StudentsPage.tsx` + `StudentProfile.tsx` | 学生表（筛选/搜索/批量/导入导出）+ 单生详情 5 标签页 | `eaa.listStudents/addStudent/deleteStudent/export/import/history/addEvent/revertEvent`、`class.list/assign`、`profile.get/set`、`academic.getGrades` | 无（本地） |
| `/classes` | `Classes/ClassesPage.tsx` + `ClassProfile.tsx` | 班级主从表 + 自动编号（`G7-3`）+ 模板克隆 + 调班进度条 | `class.list/create/update/archive/restore/delete/assign/onAssignProgress` | 无 |
| `/academics` | `Academics/AcademicsPage.tsx`（2148 行，最大页面） | 学生选 + 成绩仪表盘（线/柱/雷达）+ 考试管理 + 成绩录入（单 + 批量粘贴）+ AI 试卷分析 | `academic.getConfig/listExams/createExam/deleteExam/getGrades/setGrade/batchSetGrades/getClassGrades`、`eaa.listStudents/score`、`ai.chat/onStream` | 无 |
| `/agents` | `Agents/AgentsPage.tsx` | Agent 控制中心：列表 + 开关 + 配置 + 手动跑 + 编辑 SOUL.md/AGENTS.md + 执行历史 | 几乎全走 `useAgentStore` | agentStore |
| `/models` | `Models/ModelsPage.tsx` + `LocalModelsSection.tsx` | 云端 LLM provider 管理（API key、模型、测连、OAuth、自定义模型）+ Ollama 本地管理 | `ai.listProviders/listModels/testConnection/setApiKey/oauthLogin/addCustomModel`、`ollama.detect/startServe/stopServe/listModels/pullModel/onPullProgress` | 无 |
| `/skills` | `Skills/SkillsPage.tsx` | Skill（Markdown）管理：列表/新建/编辑/导入/删除 | `skill.list/get/save/delete` | 无 |
| `/scheduler` | `Scheduler/SchedulerPage.tsx` | Cron 任务管理 + 执行日志查看 | `cron.list/add/update/remove/toggle/runNow/getLogs/onStatusUpdate` | 无 |
| `/privacy` | `Privacy/PrivacyPage.tsx` | 隐私引擎控制：init/load/lock + 脱敏映射 + 增删 + dry-run 预览 + 备份 | `privacy.status/init/load/lock/list/add/dryrun/backup`、`sys.saveDialog` | 无 |
| `/settings` | `Settings/SettingsPage.tsx`（1336 行） | 设置中心：通用/对话/飞书/诊断/日志/关于（**不用 settingsStore**，自己维护 state） | `settings.get/set/reset`、`eaa.doctor/validate`、`log.list/read/filter/search/clear/exportWithDialog`、`feishu.test/botStart/botStop/botStatus/onBotStatusUpdate`、`sys.checkUpdate/showUpdateDialog` | 无 |

### 跨页面共用模式

1. **所有 IPC 走 `getAPI().<namespace>.<method>(...)`** —— 永远不要在页面里直接碰 `window.api`。
2. **错误用 `toast.error(message, 5000)` 上报** —— 只 `console.error` 等于没报。
3. **右键菜单**：行级 `data-ctx-menu='[{label:..,action:..}]'` JSON + `data-ctx-<key>` 数据属性 + 监听 `ctx-menu-action` 事件。优先级见 `ContextMenu.tsx:160+`。
4. **班级筛选三态约定**：`__ALL__`（全部）/ `__NONE__`（未分班）/ 具体 `class_id`，多个页面共用（Dashboard / Students / Classes / Academics）。
5. **纯函数提取**：每个大页面的过滤 / 排序 / 计算逻辑提取成 `*.ts`（如 `class-id.ts` / `student-filters.ts` / `dashboard-stats.ts`），便于单测、避免组件测试。

### 几个特别值得注意的页面细节

- **`/students` 深链**：支持 `?entity_id=...` URL 参数，从 Dashboard 排名点击跳转过来时自动打开该学生详情（`StudentsPage.tsx:240-260`）。
- **`/classes` 自动编号**：填年级"七年级"+ 名称"3 班"→ 自动生成 `G7-3`。用户手改编号后自动生成关闭（`onClassIdChange`，`ClassesPage.tsx:194`）。逻辑见 `class-id.ts`：`gradeToNumber`（中文一二三→123，含阿拉伯数字直接用）+ `classNoFromName`（取第一个 `\d+`）+ `computeAutoClassId`。
- **`/students` 学生排序**：按风险等级 `极高 > 高 > 中 > 低` 排序（`student-filters.ts:57` 的 `RISK_ORDER`）。
- **`/chat` 上下文进度条**：3 色（绿 <60% / 黄 60-90% / 红 ≥90% "即将压缩"）。
- **`/privacy` 安全**：调 `privacy.init/load` 后**立即清空组件里的 password state**（main 进程里缓存了），不持有。`handleLoad` 失败不再自动 init（之前会覆盖加密存储导致数据丢失，见 `PrivacyPage.tsx:81` 注释）。
- **`/agents` 选择性订阅**：`isRunning/liveOutput/liveToolCalls` 在 `AgentDetailPanel` 内部订阅（`AgentsPage.tsx:191-193`），避免流式输出让左侧列表重渲染。

---

## 9. 怎么编译 / 怎么跑

权威构建文档是 [`BUILD.md`](./BUILD.md)。这里给"够用版"。

### 环境要求

| 工具 | 版本 | 检查 |
|---|---|---|
| Node.js | **≥ 22**（⚠️ 不要用 26，better-sqlite3 编译不过） | `node -v` |
| npm | ≥ 10 | `npm -v` |
| Rust 工具链 | stable（本仓库用 1.95） | `rustc -V` / `cargo -V` |
| Tauri CLI | 2.x（devDependency 自带） | `npx tauri -V` |
| Windows C++ 构建工具 | VS 2022 Build Tools（含 C++ 工作负载） | 编 better-sqlite3 用 |
| WebView2 | Win10/11 自带 | Tauri 运行时依赖 |

### 三步准备

```bash
git clone https://github.com/232252/education-advisor-tauri.git
cd education-advisor-tauri
npm ci                              # 装 JS 依赖（编译 better-sqlite3 原生模块）
npm run build:eaa                   # 编译 Rust EAA CLI 到 resources/eaa-binaries/
```

### 日常开发（HMR）

```bash
npm run tauri:dev
# = npm run build:sidecar && tauri dev
# 启 Rust 外壳、拉 sidecar、打开带 HMR 的原生窗口
```

### 一键生产构建（出安装包）

```bash
npm run tauri:build
# 等价于：
#   npm run build:sidecar
#   node scripts/copy-sidecar-deps.mjs
#   npm run build           # main + renderer
#   tauri build             # 编 Rust release + 打 NSIS/MSI
# 产物：
#   src-tauri/target/release/education-advisor-tauri.exe
#   src-tauri/target/release/bundle/nsis/Education Advisor_0.1.0_x64-setup.exe
#   src-tauri/target/release/bundle/msi/Education Advisor_0.1.0_x64_zh-CN.msi
```

首次 Rust 编译 5-10 分钟（全量编依赖），后续增量很快。

### 分步构建（出错时调试）

```bash
npm run prebuild:check              # ① 预检资源齐备
npm run build:sidecar               # ② dist/sidecar/sidecar.mjs
node scripts/copy-sidecar-deps.mjs  # ③ 拷 sidecar 运行时依赖到 dist/node_modules
npm run build                       # ④ main + renderer bundle
npx tauri build                     # ⑤ Rust release + NSIS + MSI
```

### 常用脚本速查

| 命令 | 作用 |
|---|---|
| `npm run tauri:build` | 生产构建（出安装包） |
| `npm run tauri:dev` | 开发模式（HMR） |
| `npm run typecheck` | `tsc --noEmit` 类型检查 |
| `npm run lint` / `lint:fix` | biome 代码检查 / 自动修 |
| `npm test` | Vitest 全套（见 TESTING.md） |
| `npm run test:coverage` | 测试 + 覆盖率报告 |
| `npm run self-check` | 72 项自检（agents/IPC/docs/CI 配置齐全） |
| `npm run clean` | 清 `dist/` `release/` |

### 改版本号要同步三处

`src-tauri/tauri.conf.json` → `version`、`src-tauri/Cargo.toml` → `version`、`package.json` → `version`。还有 sidecar 的 `electron-shim` 里硬编码的 `app.getVersion()`（当前 `'0.1.0'`）。

---

## 10. 构建产物与体积预估

### 单个组件大小（实测 2026-07-17）

| 组件 | 大小 | 路径 |
|---|---:|---|
| Rust 外壳 exe（release） | 5.4 MB | `src-tauri/target/release/education-advisor-tauri.exe` |
| 打包携带的 Node 运行时 | 98 MB | `resources/node.exe` |
| sidecar 运行时依赖 | **193 MB** | `dist/node_modules/`（135 个包） |
| main bundle（CJS） | 1.5 MB | `dist/main/` |
| renderer bundle | 1.3 MB | `dist/renderer/` |
| sidecar bundle（ESM） | 0.4 MB | `dist/sidecar/sidecar.mjs` |
| vendored pi-agent-core | 8.3 MB | `vendor/pi-agent-core/`（含 devDeps） |
| vendored pi-ai | 14 MB | `vendor/pi-ai/`（含 devDeps） |
| agents/ | 0.2 MB | |
| config/ | 0.04 MB | |
| **未压缩总计** | **~322 MB** | |

### 安装包大小

| 安装器 | 大小 | 压缩比 | 路径 |
|---|---:|---:|---|
| NSIS（LZMA） | **40.2 MB** | 8.0× | `bundle/nsis/Education Advisor_0.1.0_x64-setup.exe` |
| MSI（WiX，未压缩） | **77.1 MB** | 4.2× | `bundle/msi/Education Advisor_0.1.0_x64_zh-CN.msi` |

**NSIS 比 MSI 小一半**因为 NSIS 用 LZMA（对高熵的 node.exe 和文本 bundle 压得很狠）。MSI 适合企业 GPO 分发。日常用户推荐 NSIS。

### node_modules 大头（193 MB 拆分）

| 包 | 大小 |
|---|---:|
| `@larksuiteoapi/node-sdk` | 26 MB |
| `@google`（Gemini SDK） | 14 MB |
| `better-sqlite3` | 12 MB |
| `xlsx` | 7.2 MB |
| `@anthropic-ai/sdk` | 5.8 MB |
| `@aws-sdk`（Bedrock） | 5.6 MB |
| `@earendil-works/pi-agent-core` | 8.3 MB |
| `@earendil-works/pi-ai` | 14 MB |
| 其他 ~127 包 | ~100 MB |

### 打包进安装器的资源清单（`tauri.conf.json:43-56`）

```
config/             ← agents.yaml + mcp.yaml + default-settings.json + reason-codes.json
eaa-binaries/        ← Rust EAA CLI（按平台分目录）
node.exe             ← 98 MB Node 运行时
agents/              ← 18 个 agent 的 SOUL.md + AGENTS.md
sidecar/             ← edu-sidecar.mjs 固定路径启动器
dist/sidecar/        ← 真实 sidecar bundle
dist/main/           ← Electron 兼容 main bundle（向后兼容用）
dist/node_modules/   ← 193 MB sidecar 依赖
vendor/pi-ai/dist    ← LLM provider registry
package.json + package-lock.json
```

**注意**：renderer bundle（`dist/renderer/`）走 Tauri 标准的 `frontendDist`（`tauri.conf.json:7`），不进 `bundle.resources`。

---

## 11. 可能出现的问题（最常见）

更完整的故障排查见 [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md)。这里只列**最容易踩的几个**。

### 🔴 必须知道的 3 个

1. **必须用 Node 22，不要用 Node 26**：`better-sqlite3` 在 Node 26（ABI 147 + Python 3.12 + node-gyp）上编译失败，chat/班级持久化会**静默降级为 no-op**（数据只存内存，重启丢失）。症状不明显，最容易坑人。

2. **`npm ci` 之后必须跑 `npm run build:eaa`**：Rust EAA CLI 现在从源码编译（不再自动下载预编译二进制），没跑这步 `resources/eaa-binaries/` 是空的，应用启动后所有操行分相关功能不工作（`eaa.isAvailable()` 返回 false）。

3. **任何新加的"防抖落盘"writer 必须在 `main/index.ts` 的 `gracefulShutdown` 里加 `flush()`**：之前出过 R4 数据丢失 bug（settings/keystore 500ms 防抖 + 关闭时没 flush）。这是历史教训，照着做。

### 🟡 构建相关

- **`better-sqlite3` 编译失败 `gyp ERR! find Python`**：装 VS 2022 Build Tools 勾"使用 C++ 的桌面开发"工作负载。
- **Tauri CLI 找不到**：用 `npx tauri ...` 或确认 `@tauri-apps/cli` 在 devDependencies（随 `npm ci` 装）。
- **打包报缺资源（config/agents/vendor/...）**：先 `npm run prebuild:check` 按提示补。`vendor/` 仓库自带，`resources/eaa-binaries/` 由 `build:eaa` 生成。
- **首次 Rust 编译很慢（5-10 分钟）**：正常，后续增量快。`src-tauri/target/` 是缓存别手删。
- **改了版本号但安装包名没变**：检查三处（`tauri.conf.json` / `Cargo.toml` / `package.json`）+ shim 硬编码。

### 🟡 运行相关

- **应用启动后操行分功能不可用**：检查 `resources/eaa-binaries/<平台>/eaa.exe` 是否存在，被杀软隔离的话 `eaa-bridge` 会自愈重试（见 §5.4）。
- **飞书 bot 一直 connecting 不动**：飞书后台没配 `im.message.receive_v1` 事件订阅。3 秒轮询会在 60 秒后报可操作错误提示（`feishu-bot-service.ts:324`）。
- **Windows SmartScreen 提示"已保护你的电脑"**：未签名构建首次运行正常现象。点"更多信息 → 仍要运行"。要消除需代码签名。
- **`dist/renderer/assets/` 重建后留旧 chunk**：work-around `npm run clean && npm run build`。
- **LLM provider 新增后前端 fetch 被 CSP 拦截**：`src-tauri/tauri.conf.json:26` 的 `connect-src` 白名单要加域名。

### 🟡 已知小问题（不影响主功能）

- `db-service.ts:528-540` 有 4 处 `!` 非空断言（在 SQLite 事务回调里）：**故意的**，"修"成 `?.` 会破坏事务原子性，不要动。
- `eaa:search` IPC 没有逐 token 消毒（只有 `tokenizeQuery` 切分）：低风险，只 UI 路径。见 `BUG_REPORT.md` item B。
- `release.yml` CI 还在用 `electron-builder`，Tauri 安装包路径 `npm run tauri:build` 没进 CI：已知 gap，Tauri 迁移代码完成但发布流水线还是旧的。
- `docs/decisions/0001`（"Rust 和 TS 分开仓库"）已被现实推翻（现在是 monorepo），0004（contextBridge）已被 Tauri 安全模型取代——读的时候要知道这是历史决策。

---

## 12. 怎么加新功能（动手指南）

### 加一个新 IPC 通道（最常见）

1. 在 `src/shared/ipc-channels.ts` 加通道常量（按命名空间分组）：
   ```ts
   export const IPC_FOO_BAR = 'foo:bar'
   ```
2. 在对应的 `src/main/ipc/<domain>-handlers.ts` 注册：
   ```ts
   ipcMain.handle(IPC.IPC_FOO_BAR, async (_e, arg) => {
     try { validateString(arg, 'arg', 64); return await fooService.bar(arg) }
     catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) } }
   })
   ```
3. 在 `src/main/preload/index.ts` 暴露给渲染层：
   ```ts
   foo: { bar: (arg) => ipcRenderer.invoke(IPC.IPC_FOO_BAR, arg) }
   ```
4. **Tauri 模式还要**在 `src/renderer/lib/tauri-bridge.ts` 镜像：
   - 顶部 `:23-176` 加 `const FOO_BAR = 'foo:bar'`
   - `buildAPI()` 里加 `foo: { bar: (arg) => call(FOO_BAR, arg) }`
5. 在 `src/renderer/lib/ipc-client.ts` 的 `WindowAPI` 接口加类型。
6. 渲染层调：`const res = await getAPI().foo.bar('x')`。

### 加一个新 service

1. 在 `src/main/services/foo-service.ts` 写 `class FooService { ... } export const fooService = new FooService()`。
2. 单例 + 模块级状态。不要搞 DI 容器（项目惯例）。
3. 写单测 `tests/main/foo-service.test.ts`，参考 `TESTING.md` 的 mock 模式目录选合适的 pattern。
4. 在对应 handler 文件 `import { fooService } from '../services/foo-service'`。

### 加一个新页面

1. 在 `src/renderer/pages/Foo/` 建 `FooPage.tsx`。
2. 在 `src/renderer/App.tsx:91-107` 加路由（`<Route path="/foo" element={<LazyFoo/>} />`）。
3. 在 `src/renderer/layouts/MainLayout.tsx:13-29` 的 `NAV_ITEMS` 加导航项（`path/icon/labelKey`）。
4. 在 `src/renderer/i18n/zh.json` + `en.json` 加 `page.foo.*` 翻译。
5. 页面里用 `getAPI().<namespace>.<method>(...)` 拿数据，用 `toast.error(...)` 报错。
6. 纯函数（过滤/排序/计算）提取到 `FooPage.tsx` 同目录的 `foo-helpers.ts`，单测放 `tests/renderer/lib/foo-helpers.test.ts`。

### 加一个新 Agent

1. 在 `config/agents.yaml` 加一项（`id/name/role/description/enabled/model_tier/capabilities/schedule.cron/risk_thresholds`）。
2. 在 `agents/<id>/` 建 `SOUL.md`（人设）和 `AGENTS.md`（规则）。参考 `docs/AGENT_AUTHORING.md`。
3. 重启应用，agent 自动被 `agentService.loadAgents()` 加载。
4. 自检会校验"agents/ 目录必须正好 18 个"——加了第 19 个要么更新 `scripts/self-check.cjs` 的期望数，要么先确认意图。

### 加一个新 LLM Provider

1. CSP 白名单加域名（`src-tauri/tauri.conf.json:26`）。
2. 如果 `pi-ai` 已支持，配 API key 就能用（前端 `/models` 页）。
3. 如果是自定义 provider，前端 `/models` 加自定义模型（`ai.addCustomModel`）。

---

## 13. 文档地图（其他文档去哪看）

| 想了解 | 看哪 |
|---|---|
| 构建 / 打包细节 | [`BUILD.md`](./BUILD.md) |
| 测试体系 / mock 模式 / 覆盖率 | [`TESTING.md`](./TESTING.md) |
| 结构化代码索引（带跳转链接） | [`docs/CODE_WIKI.md`](./docs/CODE_WIKI.md) |
| 故障排查大全（700+ 行） | [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) |
| 配置体系（settings/agents.yaml/env） | [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md) |
| EAA 桥接协议 | [`docs/EAA_BRIDGE.md`](./docs/EAA_BRIDGE.md) |
| 隐私引擎（AES-256-GCM） | [`docs/PRIVACY_ENGINE.md`](./docs/PRIVACY_ENGINE.md) |
| Cron 调度 | [`docs/CRON.md`](./docs/CRON.md) |
| 写新 Agent | [`docs/AGENT_AUTHORING.md`](./docs/AGENT_AUTHORING.md) |
| 开发环境配置 | [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) |
| 分发与发布 | [`docs/DISTRIBUTION.md`](./docs/DISTRIBUTION.md) |
| 架构决策记录（ADR） | [`docs/decisions/`](./docs/decisions/)（7 个，注意 0001/0004 已过时） |
| 快速上手（15 分钟） | [`docs/QUICK_START.md`](./docs/QUICK_START.md) |
| FAQ | [`docs/FAQ.md`](./docs/FAQ.md) |
| 开发流程 SOP | [`docs/SOP.md`](./docs/SOP.md) |
| 项目定位深度介绍 | [`PROJECT_INTRO.md`](./PROJECT_INTRO.md)（⚠️ 部分内容是 pre-Tauri） |
| 迁移过程 | [`MIGRATION_REPORT.md`](./MIGRATION_REPORT.md) |
| 飞书 MCP 集成规划 | [`MCP_INTEGRATION_PLAN.md`](./MCP_INTEGRATION_PLAN.md) |
| 已知 backlog | [`BACKLOG.md`](./BACKLOG.md) |
| 路线图 | [`ROADMAP.md`](./ROADMAP.md) |
| 贡献指南 | [`CONTRIBUTING.md`](./CONTRIBUTING.md) |
| 安全策略 | [`SECURITY.md`](./SECURITY.md) |

### ⚠️ 文档新旧提醒

部分根目录 / `docs/` 文档是 pre-Tauri 时代的（迁移前写的），看到提 Electron 33 / electron-builder / "两个仓库"等内容时要知道是历史描述。最权威、最新的：
- 本文件（`WIKI.md`）
- `BUILD.md`
- `TESTING.md`
- `docs/CODE_WIKI.md`（2026-07-14 更新，已是 Tauri 版）
- `MIGRATION_REPORT.md`

---

*本文档由 ZCode 基于代码精读 + 6 个并行研究子代理的调研综合编写，所有结论均带源文件行号引用以便核对。如发现描述与代码不符，以代码为准，并请提 issue 修正本文。*
