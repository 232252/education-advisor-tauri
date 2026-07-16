# Education Advisor — Code Wiki

> 本文档是 `education-advisor-tuari` 仓库的结构化代码百科，覆盖项目整体架构、主要模块职责、关键类型与函数、依赖关系、运行方式等核心信息。
>
> - **当前版本**: Tauri 0.1.0 / EAA CLI 3.2.2
> - **迁移状态**: 已从 Electron 33 迁移至 Tauri 2（Rust shell + Node sidecar），原 Electron 代码零改动复用，两套架构共存
> - **最后更新**: 2026-07-14

---

## 目录

1. [项目定位](#1-项目定位)
2. [整体架构](#2-整体架构)
3. [目录结构](#3-目录结构)
4. [主要模块职责](#4-主要模块职责)
5. [关键类与函数说明](#5-关键类与函数说明)
6. [数据流与通信协议](#6-数据流与通信协议)
7. [依赖关系](#7-依赖关系)
8. [项目运行方式](#8-项目运行方式)
9. [配置体系](#9-配置体系)
10. [18 个 Agent 清单](#10-18-个-agent-清单)
11. [数据存储与隐私引擎](#11-数据存储与隐私引擎)
12. [测试体系](#12-测试体系)
13. [已知限制与待办](#13-已知限制与待办)

---

## 1. 项目定位

**Education Advisor** 是一个面向中国中学/高中班主任的**本地优先（local-first）桌面应用**，提供操行分管理、家长沟通、周报生成、风险预警等一站式能力，由 18 个协作 AI Agent 驱动。

- **不是** 聊天机器人，也 **不是** SaaS。
- **是** 一个本地桌面工具：所有学生数据存在本地 Rust 事件源存储（EAA CLI）中，LLM 是唯一需要联网的部分。
- **当前形态**: Tauri 2 桌面应用（从 Electron 33 迁移而来）。原 Electron 入口 `src/main/index.ts` 完整保留，两套架构共存，便于回退与对照测试。

### 核心特性

| 特性 | 说明 |
|---|---|
| Rust 事件源数据引擎 | 所有学生事件 append-only、可审计、原子持久化（`tmp → fsync → rename`）、文件锁并发安全 |
| 18 个协作 Agent | 角色定义清晰、权限最小化（read / add-event / summary / ...）、可由 cron 调度 |
| PII 隐私引擎 | AES-256-GCM 加密映射表，11 个 IPC 操作（init/load/enable/disable/list/add/anonymize/deanonymize/filter/dryrun/backup） |
| 30+ LLM Provider | 通过 `@earendil-works/pi-ai` SDK 接入 OpenAI / Anthropic / Google / DeepSeek / Qwen / Doubao / Zhipu / Ollama / LM Studio 等 |
| 飞书集成 | Bitable 同步 + 长连接机器人 |
| 小模型友好 | Agent 提示词专为 3–4B 参数模型设计，受工具约束而非"氛围"约束 |

---

## 2. 整体架构

### 2.1 架构总览

```
┌──────────────────────────────────────────────────────────────────────┐
│  渲染进程 (React 18 + Vite + Tailwind + Zustand)                     │
│  9 个路由页面 · HashRouter · 路由级懒加载 · i18n(zh/en)               │
│  window.api (由 tauri-bridge.ts 构造，签名与 Electron preload 一致)   │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ Tauri invoke('ipc_invoke', {channel, args})
                           │ Tauri listen(channel, cb)  ← 事件订阅
┌──────────────────────────▼───────────────────────────────────────────┐
│  Tauri 主进程 (Rust · src-tauri/)                                     │
│  ┌────────────┐  ┌─────────────────┐  ┌──────────────────────────┐   │
│  │ ipc_invoke │  │ sidecar.rs      │  │ sys_bridge.rs            │   │
│  │ 命令       │──│  spawn(node .mjs)│  │ openExternal/showInFolder│   │
│  │            │  │  stdin: JSON-RPC │  │ getPaths / dialog        │   │
│  │            │  │  stdout: result/ │  │ (Tauri 原生插件)         │   │
│  │            │  │   event/console  │  │                          │   │
│  └────────────┘  │  → window.emit() │  └──────────────────────────┘   │
│       ↑          └────────┬─────────┘                                 │
│  插件: shell / dialog / notification / os / single-instance          │
└───────────────────────────┼──────────────────────────────────────────┘
                            │ 子进程 (stdio JSON-RPC over newline)
┌───────────────────────────▼──────────────────────────────────────────┐
│  Node Sidecar (dist/sidecar/sidecar.mjs)                              │
│  ┌──────────────────────┐  ┌──────────────────────────────────────┐  │
│  │ electron-shim.ts     │  │ 复用原 Electron 全部业务代码(零改动)  │  │
│  │ ipcMain/app/         │  │ 13 组 IPC handler (115 通道)          │  │
│  │ BrowserWindow/dialog │  │ 20+ service:                         │  │
│  │ /shell/safeStorage/  │  │  agent / pi-ai / eaa-bridge / cron /  │  │
│  │ Notification/Tray    │  │  db / feishu / ollama / keystore /   │  │
│  │  全部 mock           │  │  settings / skill / privacy / ...    │  │
│  └──────────────────────┘  └──────────────────────────────────────┘  │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ cross-spawn (子进程 + JSON stdout)
┌───────────────────────────▼──────────────────────────────────────────┐
│  EAA CLI (Rust · core/eaa-cli/ · eaa.exe)                            │
│  事件源存储 · 操行分计算 · 文件锁并发安全 · 缓存层 · 隐私脱敏引擎    │
│  数据: events.jsonl + entities.json + reason-codes.json + 缓存        │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 迁移设计要点

迁移方案选择 **"Tauri (Rust) 作为外壳 + Node.js sidecar 承载原 Electron 全部业务逻辑"**，而非"全部用 Rust 重写"，原因：

1. **业务复杂度**: 原后端 8200+ 行 Node 代码（sqlite、keystore DPAPI、cron、飞书 WebSocket、Ollama、Rust EAA 子进程、AI SDK），一晚全部 Rust 重写不可能且高风险。
2. **功能等价保证**: sidecar 让全部业务代码原样运行，功能 100% 等价，风险最低。
3. **行业标准**: Tauri 官方明确支持 external binary / sidecar 模式。
4. **渐进迁移**: 未来可逐个把 service 改写为 Rust 原生 Tauri command，不影响其他模块。

**关键技巧**: 通过 `vite.config.sidecar.ts` 的 `resolve.alias` 把 `'electron'` 重定向到 `src/sidecar/electron-shim.ts`，让所有 services/handlers 里的 `from 'electron'` 走向 shim，从而零改动复用。

---

## 3. 目录结构

```
education-advisor-tuari/
├── src/
│   ├── main/                    # 原 Electron 主进程业务代码（被 sidecar 复用）
│   │   ├── ipc/                 #   13 组 IPC handler 模块
│   │   │   ├── index.ts         #     注册入口 registerAllHandlers(win)
│   │   │   ├── ai-handlers.ts   #     LLM Provider/Model/chat
│   │   │   ├── agent-handlers.ts#     18 Agent 控制
│   │   │   ├── eaa-handlers.ts  #     EAA 数据操作
│   │   │   ├── privacy-handlers.ts
│   │   │   ├── cron-handlers.ts
│   │   │   ├── feishu-handlers.ts
│   │   │   ├── ollama-handlers.ts
│   │   │   ├── settings-handlers.ts
│   │   │   ├── skill-handlers.ts
│   │   │   ├── profile-handlers.ts
│   │   │   ├── class-handlers.ts
│   │   │   ├── log-handlers.ts
│   │   │   └── sys-handlers.ts
│   │   ├── services/            #   20+ service 模块（业务核心）
│   │   ├── preload/             #   Electron preload（仅 Electron 模式用）
│   │   ├── utils/logger.ts
│   │   └── index.ts             #   Electron 主进程入口（保留）
│   ├── renderer/                # React 18 渲染层
│   │   ├── App.tsx              #   路由 + 布局
│   │   ├── main.tsx             #   入口（检测 Tauri 后安装 bridge）
│   │   ├── pages/               #   9 个页面（路由级懒加载）
│   │   │   ├── Dashboard/ Chat/ Students/ Classes/ Agents/
│   │   │   └── Models/ Skills/ Scheduler/ Privacy/ Settings/
│   │   ├── components/          #   共享 UI 组件
│   │   ├── hooks/               #   12 个自定义 hook
│   │   ├── stores/              #   4 个 Zustand store
│   │   ├── i18n/                #   zh.json + en.json
│   │   ├── layouts/MainLayout.tsx
│   │   ├── lib/
│   │   │   ├── tauri-bridge.ts  #   ★ Tauri 模式下构造 window.api
│   │   │   ├── ipc-client.ts    #   Electron 模式下的 IPC 客户端
│   │   │   ├── cron-utils.ts
│   │   │   └── ui-utils.ts
│   │   └── styles/globals.css
│   ├── sidecar/                 # ★ Tauri 迁移新增
│   │   ├── sidecar-entry.ts     #   sidecar 入口（注册 handler + stdio 循环）
│   │   └── electron-shim.ts     #   Electron API 垫片（ipcMain/app/...）
│   └── shared/                  # 主进程 + 渲染层共享
│       ├── ipc-channels.ts      #   90+ IPC 通道常量
│       ├── types/index.ts       #   共享 TypeScript 类型
│       └── debug.ts             #   调试开关解析
├── src-tauri/                   # ★ Tauri Rust 工程
│   ├── src/
│   │   ├── main.rs              #   Tauri 主入口
│   │   ├── sidecar.rs           #   sidecar 进程管理 + JSON-RPC
│   │   └── sys_bridge.rs        #   原生能力桥接
│   ├── Cargo.toml
│   ├── tauri.conf.json          #   Tauri 配置
│   ├── capabilities/default.json#   权限清单
│   ├── build.rs
│   └── icons/
├── sidecar/                     # sidecar 运行器 + 测试
│   ├── edu-sidecar.mjs          #   Rust 启动的 .mjs（定位 dist 产物）
│   ├── test-sidecar.mjs         #   12 项核心验证
│   ├── test-sidecar-full.mjs    #   24 项全量验证
│   ├── test-stress.mjs          #   压力测试
│   ├── test-longrun.mjs         #   长时间稳定性
│   ├── test-chaos.mjs           #   混沌测试
│   ├── test-edge.mjs            #   边界测试
│   ├── test-restart.mjs         #   启停稳定性
│   ├── test-revert.mjs          #   撤销测试
│   ├── test-events.mjs          #   事件流测试
│   ├── test-prewarm.mjs         #   缓存预热测试
│   ├── test-crash.mjs           #   崩溃恢复
│   ├── test-endless.mjs         #   无限循环
│   └── harness.mjs              #   测试框架
├── core/
│   └── eaa-cli/                 # ★ Rust 数据引擎（EAA CLI）
│       ├── src/
│       │   ├── main.rs          #   clap CLI 入口（27 个子命令）
│       │   ├── commands.rs      #   所有 cmd_* 命令实现
│       │   ├── types.rs         #   Event/Entity/AppError/OutputMode
│       │   ├── storage.rs       #   文件锁/缓存/流式读写
│       │   ├── validation.rs    #   事件校验
│       │   └── privacy/mod.rs   #   PII 脱敏引擎
│       ├── crates/              #   本地子 crate
│       │   ├── log-redact/
│       │   ├── agent-isolation/
│       │   ├── data-validation/
│       │   └── callback-signature/
│       ├── Cargo.toml
│       └── Cargo.lock
├── agents/                      # 18 个 Agent（SOUL.md + AGENTS.md）
│   ├── main/ counselor/ governor/ ...
├── config/                      # 配置
│   ├── agents.yaml              #   18 Agent 注册表
│   └── reason-codes.json        #   原因码 + 标准分值
├── resources/
│   ├── eaa-binaries/            #   平台预编译 EAA 二进制
│   │   └── win32-x64/eaa.exe
│   └── icon-*.png/ico/svg
├── eaa-dashboard/               # EAA CLI 生成的静态仪表盘
├── docs/                        # 文档（ARCHITECTURE/CONFIGURATION/...）
├── scripts/                     # 构建/测试/诊断脚本
├── tests/                       # Vitest 配套
├── vendor/                      # 本地依赖（pi-ai / pi-agent-core）
├── package.json                 # npm 工程定义
├── vite.config.main.ts          # Electron main 构建配置
├── vite.config.sidecar.ts       # ★ sidecar 构建配置（electron alias → shim）
├── vite.config.renderer.ts      # 渲染层构建配置（如存在）
├── vitest.config.ts             # 测试配置
├── biome.json                   # Linter/Formatter
├── tsconfig.json
├── electron-builder.yml         # Electron 打包配置（保留）
├── tailwind.config.js
├── postcss.config.js
└── *.md                         # README/CHANGELOG/CONTRIBUTING/...
```

---

## 4. 主要模块职责

### 4.1 四层架构的模块对照

| 层 | 目录 | 角色 | 关键文件 |
|---|---|---|---|
| **渲染层** | `src/renderer/` | React UI，9 个页面 | `App.tsx`, `main.tsx`, `lib/tauri-bridge.ts` |
| **Tauri 外壳** | `src-tauri/` | Rust 主进程，管理窗口 + sidecar | `src/main.rs`, `src/sidecar.rs`, `src/sys_bridge.rs` |
| **业务 Sidecar** | `src/main/` + `src/sidecar/` | 原 Electron 全部业务逻辑 | `sidecar-entry.ts`, `electron-shim.ts`, `ipc/index.ts`, `services/*` |
| **数据引擎** | `core/eaa-cli/` | Rust 事件源存储 + 操行分 + 隐私 | `src/main.rs`, `commands.rs`, `storage.rs`, `privacy/mod.rs` |

### 4.2 Tauri 外壳层 (`src-tauri/src/`)

| 文件 | 职责 |
|---|---|
| [main.rs](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src-tauri/src/main.rs) | Tauri 应用入口：注册插件（shell/dialog/notification/os/single-instance）、`setup` 中解析 `app_data_dir`/`resource_dir`、定位 sidecar 脚本、`SidecarHandle::spawn`、注册 `invoke_handler`（4 个命令）、窗口关闭时通知 sidecar 优雅退出 |
| [sidecar.rs](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src-tauri/src/sidecar.rs) | **核心通信层** — sidecar 进程管理 + stdio JSON-RPC 多路复用。`SidecarHandle::spawn` 启动 Node 子进程并开读 stdout 线程；`request()` 同步发起 invoke（默认 300s 超时，可由 `EDU_SIDECAR_TIMEOUT_SECS` 配置）；处理 5 种 wire message：`result` / `event` / `sys` / `log` / `console`；幂等 shutdown；poisoned mutex 恢复 |
| [sys_bridge.rs](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src-tauri/src/sys_bridge.rs) | 原生能力桥接：`sys_open_external` / `sys_show_in_folder` / `sys_get_paths` 命令，以及处理 sidecar 转发来的 `openExternal`/`showInFolder`/`dialog`/`getPath` 系统请求 |

### 4.3 业务 Sidecar 层 (`src/sidecar/` + `src/main/`)

#### sidecar 专用文件

| 文件 | 职责 |
|---|---|
| [sidecar-entry.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/sidecar/sidecar-entry.ts) | sidecar 入口：劫持 console（避免污染 stdout JSON 通道）、注入事件出口（`emitEvent`/`sysRequest`）、注册全部 13 组 handler、初始化 EAA Bridge + DB + Agent + Cron + 飞书机器人、缓存预预热、进入 stdin 请求循环、优雅 shutdown（3s 超时保护） |
| [electron-shim.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/sidecar/electron-shim.ts) | **Electron API 垫片** — mock `ipcMain`（handler 路由表 + 进程内事件总线）、`app`（getPath 白名单）、`BrowserWindow`（webContents.send → emitEvent）、`dialog`/`shell`（转发 sysRequest）、`safeStorage`（AES-256-GCM + 机器派生密钥）、`Notification`/`Tray`/`Menu`/`nativeImage`/`protocol`/`net`/`contextBridge`/`ipcRenderer`（降级 no-op） |

#### IPC Handler 层 (`src/main/ipc/`)

13 组 handler，对应 13 个 `window.api` 命名空间，共 115 个通道：

| Handler 文件 | 命名空间 | 主要通道 |
|---|---|---|
| `ai-handlers.ts` | `ai` | list-providers / list-models / test-connection / set-api-key / chat / chat-stream / chat-abort / oauth-login / add-custom-model |
| `agent-handlers.ts` | `agent` | list / get / toggle / update / get-soul / set-soul / get-rules / set-rules / run-manual / get-history / abort |
| `eaa-handlers.ts` | `eaa` | info / score / ranking / add-event / revert-event / history / search / range / tag / stats / validate / export / list-students / add-student / delete-student / set-student-meta / import / codes / doctor / summary / dashboard |
| `privacy-handlers.ts` | `privacy` | init / load / enable / disable / list / add / anonymize / deanonymize / filter / dryrun / backup / lock / status |
| `cron-handlers.ts` | `cron` | list / add / update / remove / toggle / run-now / get-logs |
| `feishu-handlers.ts` | `feishu` | test / bitable / send / status / sync-now / bot-start / bot-stop / bot-status |
| `ollama-handlers.ts` | `ollama` | detect / start-serve / stop-serve / list-models / pull-model / delete-model |
| `settings-handlers.ts` | `settings` | get / set / reset |
| `skill-handlers.ts` | `skill` | list / get / save / delete |
| `profile-handlers.ts` | `profile` | get / set |
| `class-handlers.ts` | `class` | list / create / update / archive / restore / delete / assign / remove |
| `log-handlers.ts` | `log` | list / read / clear / filter / search / export |
| `sys-handlers.ts` | `sys` | open-dialog / save-dialog / open-external / get-path / check-update / show-update-dialog / notification / read-file |

入口 `registerAllHandlers(win)`（[ipc/index.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/ipc/index.ts)）按固定顺序注册全部 handler，并触发 `eaaBridge.initialize()` + `agentService.init(win)`。

#### Service 层 (`src/main/services/`)

| Service 文件 | 职责 |
|---|---|
| [agent-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/agent-service.ts) | Agent 运行时：加载 `agents.yaml` + 用户覆盖 `agents.user.yaml`；为每次执行创建 `Agent` 实例（pi-agent-core）；连接 EAA 工具集；管理 runningAgents / executionHistory / agentScheduleTasks；5min 超时保护 |
| [pi-ai-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/pi-ai-service.ts) | 统一 LLM 接口：`completeSimple`/`streamSimple`；30+ Provider；OAuth provider 识别；5min TTL 缓存在线模型获取失败 |
| [eaa-bridge.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/eaa-bridge.ts) | Rust EAA CLI 子进程管理器：`cross-spawn` 调用 `eaa.exe`；自动判断 JSON/text 输出；跨平台二进制路径解析；静态/排行榜/学生/分数缓存层 |
| [db-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/db-service.ts) | `better-sqlite3` 本地落库：agent_executions / cron_logs / chat_messages / chat_sessions / classes 表；优雅降级（native 模块加载失败时 no-op）；预编译语句缓存；24h 自动清理 |
| [cron-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/cron-service.ts) | 定时任务调度：`node-cron` 驱动 Agent；MAX_USER_TASKS=100；nextRunAt 聚合；日志 1s 节流持久化到 `cron-logs.jsonl`；per-task 执行锁防 runNow 与 cron 竞态 |
| [feishu-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/feishu-service.ts) | 飞书 Bitable 同步 + 消息发送 |
| [feishu-bot-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/feishu-bot-service.ts) | 飞书长连接 WebSocket 机器人 |
| [feishu-command-router.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/feishu-command-router.ts) | 飞书机器人命令路由 |
| [ollama-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/ollama-service.ts) | Ollama 子进程管理（detect / start-serve / pull-model） |
| [keystore-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/keystore-service.ts) | API Key 加密存储（原 safeStorage DPAPI，sidecar 用 AES-256-GCM + 机器派生密钥）；防抖保存 |
| [settings-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/settings-service.ts) | settings.json 读写；三层配置优先级（in-app > config/ > 硬编码 fallback）；防抖保存 |
| [skill-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/skill-service.ts) | Markdown 技能注入 Agent 提示词 |
| [profile-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/profile-service.ts) | 学生档案扩展数据 |
| [class-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/class-service.ts) | 班级管理（与 EAA 学生 class_id 对齐） |
| [tray-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/tray-service.ts) | 系统托盘（Electron 模式用，sidecar 下 no-op） |
| [update-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/update-service.ts) | GitHub Releases 自动更新检查 |
| [compaction-helper.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/compaction-helper.ts) | 对话上下文压缩 |
| [eaa-tools.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/eaa-tools.ts) | 把 EAA 能力封装为 Agent 可调用的工具 |
| [file-tools.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/file-tools.ts) | 文件工具（路径沙箱化、防 `..` 穿越） |
| [utility-tools.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/utility-tools.ts) | 通用工具（时间/计算等） |

### 4.4 渲染层 (`src/renderer/`)

| 模块 | 说明 |
|---|---|
| [main.tsx](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/renderer/main.tsx) | 入口：检测 `window.__TAURI_INTERNALS__`，若在 Tauri 中则 `installTauriBridge()`，再 import App |
| [App.tsx](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/renderer/App.tsx) | HashRouter + 9 路由（路由级懒加载）+ MainLayout + ToastContainer；`usePrefetchPages` 在空闲时预拉取所有 chunk |
| [lib/tauri-bridge.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/renderer/lib/tauri-bridge.ts) | **★ Tauri 模式下的 window.api 构造器** — 90+ 方法，签名与 Electron preload 完全一致；通用 `call(channel, ...args)` → `invoke('ipc_invoke', {channel, args})`；事件订阅 `subscribe(channel, cb)` → `tauriListen` |
| `pages/` | 9 个页面：Dashboard / Chat / Students / Classes / Agents / Models / Skills / Scheduler / Privacy / Settings |
| `stores/` | 4 个 Zustand store：agentStore / chatStore / settingsStore / toastStore |
| `hooks/` | 12 个自定义 hook：useTheme / useForwardConsole / useDebounce / useInterval / useLocalStorage / ... |
| `components/` | 共享 UI：Badge / Card / ConfirmDialog / EmptyState / ErrorBoundary / ModelSelector / Skeleton / ThemeToggle / ToastContainer |
| `i18n/` | zh.json + en.json，运行时热切换 |

### 4.5 数据引擎层 (`core/eaa-cli/src/`)

| 文件 | 职责 |
|---|---|
| [main.rs](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/core/eaa-cli/src/main.rs) | clap CLI 入口，27 个子命令（Info/Validate/Replay/History/Ranking/Score/Add/Revert/Codes/Search/Stats/Tag/Range/ListStudents/AddStudent/DeleteStudent/Import/Export/Doctor/RebuildCache/Privacy/Summary/SetStudentMeta/Dashboard） |
| [commands.rs](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/core/eaa-cli/src/commands.rs) | 所有 `cmd_*` 命令实现；版本常量 `3.2.2`；`LightContext` 轻量上下文跳过 load_events |
| [types.rs](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/core/eaa-cli/src/types.rs) | 核心类型：`Event` / `Entity` / `AppError` / `OutputMode` / `EventType` / `EntityStatus`；常量 `BASE_SCORE=100` / `MAX_DELTA=10` / `MIN_DELTA=-10` |
| [storage.rs](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/core/eaa-cli/src/storage.rs) | 文件锁（FileLock 排他 / SharedFileLock 共享）+ 原子写（`atomic_write_json` + `rename_with_retry`）+ 缓存层（scores/event_stats/daily_dedup）+ 流式聚合（stream_validate/stream_stats/stream_filter/stream_doctor_check/count_events） |
| [validation.rs](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/core/eaa-cli/src/validation.rs) | 事件校验规则 |
| [privacy/mod.rs](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/core/eaa-cli/src/privacy/mod.rs) | PII 脱敏引擎：AES-256-GCM 加密映射表、AhoCorasick 多模式替换、定向过滤 |

---

## 5. 关键类与函数说明

### 5.1 Tauri 外壳层

#### `SidecarHandle`（[sidecar.rs](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src-tauri/src/sidecar.rs)）

```rust
pub struct SidecarHandle {
    child: Mutex<Option<Child>>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<RpcResult>>>>,  // 请求-响应配对
    next_id: AtomicU64,
    shutdown_done: AtomicBool,  // 幂等 shutdown
}
```

| 方法 | 说明 |
|---|---|
| `SidecarHandle::spawn(script, app_data_dir, resource_dir, app)` | 启动 Node sidecar 子进程，开读 stdout 线程，注入环境变量 `EDU_APP_DATA_DIR`/`EDU_RESOURCE_DIR`/`EDU_IS_PACKAGED` |
| `request(&self, channel, args) -> Result<Value, String>` | 同步发起一次 invoke，注册 pending 条目 → write_line → `recv_timeout`（默认 300s，可由 `EDU_SIDECAR_TIMEOUT_SECS` 配置） |
| `write_line(&self, value)` | 序列化 JSON + `\n` 写 stdin，poisoned mutex 恢复 |
| `shutdown(&self)` | 幂等关闭：发 `{"type":"shutdown"}` → sleep 1500ms（让 sidecar flush 防抖保存）→ `child.kill()` + `wait()`（防僵尸进程） |

#### Wire Message 协议（newline-delimited JSON）

| 方向 | type | 字段 | 说明 |
|---|---|---|---|
| Rust → sidecar (stdin) | `invoke` | `id, channel, args` | 请求 |
| Rust → sidecar (stdin) | `shutdown` | — | 优雅退出信号 |
| sidecar → Rust (stdout) | `result` | `id, ok, data/error` | 请求响应 |
| sidecar → Rust (stdout) | `event` | `channel, data` | 主动推送 → Rust `window.emit()` |
| sidecar → Rust (stdout) | `sys` | `id, request, args` | sidecar 请求 Rust 处理原生能力 |
| sidecar → Rust (stdout) | `log` | `data` | sidecar 显式日志 |
| sidecar → Rust (stdout) | `console` | `level, data` | 劫持的 console.log/warn/error |

#### `#[tauri::command]` 命令

| 命令 | 说明 |
|---|---|
| `ipc_invoke(channel, args, state) -> Result<Value, String>` | 渲染层统一入口，转发到 `state.request()` |
| `sys_open_external(url)` | 系统浏览器打开 URL |
| `sys_show_in_folder(path)` | 文件管理器中显示 |
| `sys_get_paths()` | 返回 app_data_dir / resource_dir 等路径 |

### 5.2 业务 Sidecar 层

#### `electron-shim.ts` 的 `ipcMain` 路由表

```typescript
const _handlers = new Map<string, HandlerFn>()     // channel → handler
const _listeners = new Map<string, listener[]>()   // 进程内事件总线

ipcMain.handle(channel, fn)    // 注册
ipcMain.handleOnce(channel, fn)
ipcMain.on(channel, listener)  // 事件总线订阅
ipcMain.emit(channel, event)   // 事件总线触发（handler 间通信，如缓存失效）

export function getHandler(channel): HandlerFn | undefined  // sidecar 主循环用
export function listChannels(): string[]
```

#### `sidecar-entry.ts` 启动流程

```typescript
bootstrap():
  1. 劫持 console.log/warn/error（包装成 console 帧走 stdout，避免污染 JSON 通道）
  2. setOutbound({ emitEvent, sysRequest })  // 注入 shim 出口
  3. 按固定顺序注册 13 组 handler（mockWin）
  4. eaaBridge.initialize()  // 创建数据目录、复制 reason-codes、doctor
  5. dbService.init()
  6. agentService.init(mockWin)  // 加载 agents.yaml + 用户覆盖
  7. cronService.registerBitableSync()
  8. 飞书机器人自动启动（若已配置 appId + secret）
  9. emit('__sidecar__:ready', { channels })  // 通知 Rust 就绪
  10. preWarmCaches()  // 异步预热 EAA 缓存（info/codes/list-students + ranking(10)）
  11. startRequestLoop()  // 进入 stdin readline 循环

gracefulShutdown():
  Promise.race([
    Promise.allSettled([settingsService.flush(), keystoreService.flush(),
                        cronService.shutdown(), dbService.close(), feishuBotService.stop()]),
    new Promise(resolve => setTimeout(resolve, 3000))  // 3s 超时保护
  ])
  process.exit(0)
```

#### `tauri-bridge.ts` 的 `buildAPI()`

构造与 Electron preload **完全一致**的 `window.api` 对象，包含 13 个命名空间（ai/ollama/agent/eaa/privacy/cron/skill/settings/sys/profile/class/chat/log/feishu），每个方法调用通用 `call(channel, ...args)` → `tauriInvoke('ipc_invoke', {channel, args})`。事件订阅方法（`onStream`/`onStatusUpdate`/`onPullProgress`/`onBotStatusUpdate`）返回取消订阅函数。

### 5.3 EAA CLI 关键函数

#### `commands.rs` 的 `cmd_*` 函数

| 函数 | 用途 | 性能要点 |
|---|---|---|
| `cmd_info(output)` | 系统信息（版本/学生数/事件数） | — |
| `cmd_score(name, output)` | 查询学生分数 | v3.1.5 起走 LightContext + scores.cache，~5ms |
| `cmd_ranking(n, output)` | 排行榜 Top N | scores.cache 排序，~18ms |
| `cmd_add(name, reason_code, tags, delta, note, operator, dry_run, force, output)` | 添加事件 | 重复检测（daily_dedup.cache O(1)）+ 缓存增量更新，~28ms |
| `cmd_revert(event_id, reason, operator, dry_run, output)` | 撤销事件 | v3.1.7 流式修改目标行 + append 对冲事件，~330ms |
| `cmd_history(name, output)` | 学生事件时间线 | `load_events_for_entity` 流式按学生过滤 |
| `cmd_validate(output)` | 全量校验 | `stream_validate` 跳过 Vec 分配 |
| `cmd_stats(output)` | 统计摘要 | `stream_stats` 跳过 Vec 分配 |
| `cmd_doctor(output)` | 健康检查 | `stream_doctor_check` 单趟流式 3 检查，~362ms / 200K 事件 |
| `cmd_delete_student(name, confirm, reason, dry_run)` | 软删除学生 | `soft_delete_events_for_entity` 流式，O(1) per student，~540ms / 200K 事件 |
| `cmd_rebuild_cache(output)` | 全量重建 3 缓存 | — |
| `cmd_export(format, output_path)` | 导出 csv/jsonl/html | LightContext + count_events，~18ms |
| `cmd_dashboard(output_dir, open_browser)` | 生成静态 HTML 仪表盘 | LightContext + count_events，~63ms |
| `cmd_summary(since, until, output)` | 区间汇总 | — |
| `cmd_search`/`cmd_tag`/`cmd_range` | 查询类 | `stream_filter` 跳过 Vec 分配 |

#### `storage.rs` 关键函数

| 函数 | 说明 |
|---|---|
| `FileLock::acquire(path)` | 排他文件锁（fs2 `lock_exclusive`），RAII Drop 释放 |
| `SharedFileLock::acquire(path)` | 共享文件锁（v3.1.9），读操作防 rename 打断 |
| `atomic_write_json(path, value)` | `tmp → sync_all → rename_with_retry`（最多 30×20ms 重试，解决 Windows Defender） |
| `load_events` / `save_events` / `append_event` | 双格式自动迁移（json → jsonl），`append_event` O(1) |
| `revert_event_in_file(event_id, ...)` | 流式撤销（v3.1.7），跳过 Vec load+save |
| `soft_delete_events_for_entity(entity_id)` | 流式软删除（v3.2.1），O(1) per student |
| `load_scores_cache` / `_nolock` / `save_scores_cache` / `update_score_delta` / `revert_score_delta` | scores.cache.json 操作；`_nolock` 变体供写命令内部用（防 SharedFileLock 死锁） |
| `load_event_stats_cache` / `_nolock` / `save_event_stats_cache` / `update_event_stats` / `revert_event_stats` | event_stats.cache.json 操作 |
| `load_daily_dedup_cache` / `_nolock` / `check_daily_dedup` / `update_daily_dedup` | daily_dedup.cache.json 操作（O(1) 重复检测） |
| `stream_validate` / `stream_stats` / `stream_filter` / `stream_doctor_check` / `count_events` | 流式聚合，跳过 Vec 分配 |
| `rebuild_all_caches()` | 全量重建 scores + event_stats + daily_dedup |

#### `types.rs` 核心类型

```rust
pub const BASE_SCORE: f64 = 100.0;
pub const MAX_DELTA: f64 = 10.0;
pub const MIN_DELTA: f64 = -10.0;

pub enum OutputMode { Text, Json }  // FromStr

pub enum AppError {                  // thiserror
    Io(io::Error),
    Json(serde_json::Error),
    StudentNotFound(String),
    EventNotFound(String),
    Validation(String),
}

pub enum EventType { ConductDeduct, ConductBonus }  // SCREAMING_SNAKE_CASE 序列化
pub enum EntityStatus { Active, Transferred, Suspended, Deleted }  // v3.1.3 软删除

pub struct Entity {
    id: String, name: String, aliases: Vec<String>, status: EntityStatus,
    created_at: String, metadata: HashMap<String, Value>,
    groups: Vec<String>, roles: Vec<String>, class_id: Option<String>,
}

pub struct Event {                   // 核心数据单元
    event_id: String, entity_id: String, event_type: EventType,
    category_tags: Vec<String>, reason_code: String, original_reason: String,
    score_delta: f64, evidence_ref: Option<String>, operator: Option<String>,
    timestamp: String, is_valid: bool, reverted_by: Option<String>, note: String,
}
```

#### `privacy/mod.rs` 的 `PrivacyEngine`

```rust
pub struct PrivacyEngine {
    enabled: bool,
    forward: HashMap<String, String>,  // 明文 → 化名
    reverse: HashMap<String, String>,  // 化名 → 明文
    cipher: Option<Aes256Gcm>,
    mapping_path: PathBuf,
    nonce: [u8; 12],
}
```

| 方法 | 说明 |
|---|---|
| `init(&mut self, data_dir, password)` | 派生密钥（SHA-256(password)）+ 生成 nonce + 清空映射 + 保存到 `privacy/mapping.enc` |
| `load(&mut self, data_dir, password)` | 从 `mapping.enc` 解密加载 |
| `add_entity(&mut self, entity_type, plain) -> String` | 添加映射，返回化名（如 `S_001`） |
| `auto_scan_students(&mut self, data_dir) -> Result<usize>` | 扫描 `entities.json` 批量添加 |
| `anonymize(&self, text) -> String` | 脱敏：AhoCorasick 多模式替换（发给 AI 前） |
| `deanonymize(&self, text) -> String` | 还原：化名 → 明文（AI 返回后） |
| `filter_for_receiver(&self, text, receiver_name) -> String` | 定向过滤：把其他人替换为"其他同学" |

### 5.4 关键 Service 类

#### `AgentService`（[agent-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/agent-service.ts)）

```typescript
class AgentService {
  agents: Map<string, AgentConfig>           // 18 Agent 配置
  agentsDir / configDir / userOverridesPath
  userOverrides: Map<string, UserAgentOverride>  // agents.user.yaml
  agentStatus: Map<string, AgentStatus>
  executionHistory: Map<string, AgentExecution[]>
  runningAgents: Map<string, RunningAgent>   // { agent, abortController, agentId, startedAt }
  agentScheduleTasks: AgentScheduleMap       // agent → cron task id 列表
}
```

常量：`WAIT_FOR_IDLE_TIMEOUT_MS=5min`、`MAX_CONTINUATIONS=5`、`MIN_OUTPUT_CHARS=200`、`MIN_TURN_COUNT=3`。

#### `PiAIService`（[pi-ai-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/pi-ai-service.ts)）

统一 LLM 接口，30+ Provider。OAuth provider 集合：`{anthropic, github-copilot, openai-codex}`。5min TTL 缓存在线模型获取失败的 provider（H-1 修复，替代永久缓存 Set）。

#### `DBService`（[db-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/db-service.ts)）

better-sqlite3 单例，优雅降级。表：

| 表 | 用途 |
|---|---|
| `agent_executions` | Agent 执行历史（status: running/success/failure/aborted + tokens/cost） |
| `cron_logs` | 定时任务日志（level: info/warn/error/debug） |
| `chat_messages` + `chat_sessions` | 聊天持久化 |
| `classes` | 班级本地存档（class_id 与 EAA 学生对齐） |

24h 自动清理过期数据；预编译语句缓存。

#### `CronService`（[cron-service.ts](file:///c:/Users/sq199/Documents/GitHub/education-advisor-tuari/src/main/services/cron-service.ts)）

```typescript
class CronService {
  static MAX_USER_TASKS = 100
  tasks: Map<string, CronTask>
  scheduledJobs: Map<string, cron.ScheduledTask>
  nextRunAt: Map<string, string>
  logs: CronLogEntry[]                      // 内存上限 1000
  logFilePath: string                       // userData/cron-logs.jsonl
  runningTasks: Set<string>                 // per-task 执行锁（防 runNow 与 cron 竞态）
  agentRunner: (agentId, prompt, win) => Promise<void>  // 延迟注入避免循环依赖
}
```

---

## 6. 数据流与通信协议

### 6.1 渲染层 → 后端调用链

```
页面组件
  └─ window.api.eaa.ranking(10)
       └─ tauri-bridge.ts: call('eaa:ranking', 10)
            └─ tauriInvoke('ipc_invoke', { channel: 'eaa:ranking', args: [10] })
                 └─ Tauri Rust: sidecar::ipc_invoke 命令
                      └─ SidecarHandle::request('eaa:ranking', [10])
                           └─ stdin: {"id":1,"type":"invoke","channel":"eaa:ranking","args":[10]}
                                └─ Node sidecar: startRequestLoop readline
                                     └─ getHandler('eaa:ranking') → eaa-handlers.ts
                                          └─ eaaBridge.execute({ command: 'ranking', args: [10] })
                                               └─ cross-spawn eaa.exe ranking 10 --output json
                                                    └─ Rust EAA CLI: cmd_ranking(10, Json)
                                                         └─ stdout: JSON 结果
           ← sidecar stdout: {"id":1,"type":"result","ok":true,"data":{...}}
           ← Rust: tx.send(RpcResult::Ok(data))
           ← invoke 返回 Promise resolve
```

### 6.2 后端 → 渲染层事件推送

```
Node sidecar（如 ai:chat-stream）
  └─ electron-shim: BrowserWindow.webContents.send('ai:chat-stream', chunk)
       └─ _emitEvent('ai:chat-stream', chunk)
            └─ stdout: {"type":"event","channel":"ai:chat-stream","data":chunk}
                 └─ Rust sidecar.rs: handle_wire_message → app.emit('ai:chat-stream', chunk)
                      └─ 渲染层: tauriListen('ai:chat-stream', cb) → 回调
```

### 6.3 sidecar → Rust 原生能力请求

```
Node sidecar（如 dialog.showOpenDialog）
  └─ electron-shim: dialog.showOpenDialog → _sysRequest('dialog:open', options)
       └─ stdout: {"id":N,"type":"sys","request":"dialog:open","args":options}
            └─ Rust sidecar.rs: handle_wire_message 'sys' 分支
                 └─ 独立线程: sys_bridge::handle_sidecar_sys_request(app, 'dialog:open', args)
                      └─ Tauri dialog 插件
```

---

## 7. 依赖关系

### 7.1 Tauri Rust 依赖（`src-tauri/Cargo.toml`）

| 依赖 | 用途 |
|---|---|
| `tauri` 2 | Tauri 核心 |
| `tauri-plugin-shell` | shell 命令 |
| `tauri-plugin-dialog` | 原生对话框 |
| `tauri-plugin-notification` | 系统通知 |
| `tauri-plugin-os` | OS 信息 |
| `tauri-plugin-single-instance` | 单实例锁 |
| `serde` / `serde_json` | 序列化 |

release profile：`panic=abort`、`codegen-units=1`、`lto=true`、`opt-level="s"`、`strip=true`。

### 7.2 EAA CLI Rust 依赖（`core/eaa-cli/Cargo.toml`）

| 依赖 | 用途 |
|---|---|
| `clap` 4 | CLI 参数解析 |
| `serde` / `serde_json` | 序列化 |
| `chrono` | 时间 |
| `thiserror` | 错误枚举 |
| `uuid` v4 | 事件 ID 生成 |
| `fs2` | 文件锁 |
| `sha2` | 密钥派生 |
| `aes-gcm` | PII 加密 |
| `aho-corasick` | 多模式脱敏替换 |
| `once_cell` | 全局静态 |
| `sqlx`（可选，postgres feature） | PostgreSQL 后端 |
| 本地 crate | `log-redact` / `agent-isolation` / `data-validation` / `callback-signature` |

### 7.3 npm 依赖（`package.json`）

**运行时依赖**：
- `@tauri-apps/api` 2 — Tauri 渲染层 SDK
- `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai`（本地 vendor）— Agent 循环 + LLM SDK
- `@larksuiteoapi/node-sdk` — 飞书
- `better-sqlite3` — 本地 SQLite
- `chokidar` — 文件监听
- `cross-spawn` — 跨平台子进程
- `node-cron` — 定时任务
- `xlsx` — Excel 导入导出
- `yaml` — YAML 解析
- `typebox` — 类型校验

**开发依赖**（关键）：
- `@tauri-apps/cli` 2 — Tauri CLI
- `electron` 33 + `electron-builder`（保留，向后兼容）
- `react` 18 + `react-dom` + `react-router-dom` 6
- `vite` 6 + `vite-plugin-electron`
- `vitest` 3 + `@testing-library/react` + `playwright`
- `tailwindcss` 3 + `postcss` + `autoprefixer`
- `biome` 2 — Linter/Formatter
- `typescript` 5.7
- `zustand` 5 — 状态管理
- `echarts` 5 + `echarts-for-react` — 图表
- `shiki` — 代码高亮
- `sharp` / `to-ico` — 图标处理

### 7.4 模块间依赖图

```
渲染层 (React)
  ├─ window.api (tauri-bridge.ts)
  └─ @tauri-apps/api
        │
        ▼ invoke('ipc_invoke')
Tauri Rust 主进程
  ├─ sidecar.rs ── stdio JSON-RPC ── Node sidecar
  └─ sys_bridge.rs ── Tauri 插件
                                      │
                                      ▼
                              electron-shim.ts (ipcMain 路由表)
                                      │
                                      ▼
                              13 组 IPC handler
                                      │
                                      ▼
                              20+ service
                                      ├─ agent-service ── pi-agent-core ── pi-ai SDK ── 30+ LLM
                                      ├─ eaa-bridge ── cross-spawn ── eaa.exe (Rust)
                                      ├─ db-service ── better-sqlite3
                                      ├─ cron-service ── node-cron ── agent-service
                                      ├─ feishu-bot-service ── @larksuiteoapi/node-sdk
                                      ├─ ollama-service ── 子进程
                                      ├─ keystore-service ── safeStorage shim (AES-256-GCM)
                                      └─ settings-service ── settings.json
```

---

## 8. 项目运行方式

### 8.1 前置要求

| 工具 | 版本 | 用途 |
|---|---|---|
| Node.js | ≥ 22 | sidecar + 渲染层构建 |
| npm | ≥ 10 | 包管理 |
| Rust toolchain | ≥ 1.77 | 编译 Tauri 外壳 + EAA CLI |
| C++ 工具链 | — | `better-sqlite3` 原生模块编译（Node 22 下可正常编译） |

### 8.2 安装

```bash
git clone https://github.com/232252/education-advisor.git
cd education-advisor-tuari
npm ci
```

### 8.3 获取/构建 Rust EAA 二进制

```bash
# 方式一: 下载预编译二进制
npm run build:eaa    # → resources/eaa-binaries/<platform>/eaa.exe

# 方式二: 从源码构建
cd core/eaa-cli
cargo build --release
# 产物: core/eaa-cli/target/release/eaa.exe
# 复制到: resources/eaa-binaries/win32-x64/eaa.exe (Tauri dev 需要)
```

### 8.4 开发模式（Tauri，推荐）

```bash
npm run tauri:dev
```

该命令依次执行：
1. `npm run build:sidecar` — 构建 `dist/sidecar/sidecar.mjs`
2. `tauri dev` — 启动 Vite dev server (`:5173`) + 编译 Rust + 打开 Tauri 窗口 + 启动 sidecar 子进程

### 8.5 开发模式（Electron，向后兼容）

```bash
npm run dev          # 启动 main + renderer 的 vite watch
npm run dev:electron # 另开终端启动 Electron shell
```

### 8.6 生产打包（Tauri）

```bash
npm run tauri:build
# 产物:
#   src-tauri/target/release/education-advisor-tauri.exe           (独立 exe)
#   src-tauri/target/release/bundle/nsis/Education Advisor_0.1.0_x64-setup.exe
#   src-tauri/target/release/bundle/msi/Education Advisor_0.1.0_x64_en-US.msi
```

### 8.7 生产打包（Electron，向后兼容）

```bash
npm run package           # NSIS 安装包
npm run package:portable  # 单文件 exe
```

### 8.8 测试命令

```bash
npm test              # vitest run（422+ 单元测试）
npm run typecheck     # tsc --noEmit
npm run lint          # biome check src/
npm run self-check    # 自检脚本

# sidecar 验证（不开窗口）
node sidecar/test-sidecar.mjs          # 12 项核心
node sidecar/test-sidecar-full.mjs     # 24 项全量
node sidecar/test-stress.mjs           # 压力
node sidecar/test-longrun.mjs          # 长时间
node sidecar/test-chaos.mjs            # 混沌
node sidecar/test-edge.mjs             # 边界
```

### 8.9 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `EAA_DATA_DIR` | `./data` | EAA CLI 数据目录 |
| `EDU_APP_DATA_DIR` | (Tauri 注入) | sidecar userData 路径 |
| `EDU_RESOURCE_DIR` | (Tauri 注入) | sidecar 资源路径 |
| `EDU_IS_PACKAGED` | `0` | sidecar 是否打包模式 |
| `EDU_NODE_BIN` | (PATH) | 指定 node 可执行文件 |
| `EDU_SIDECAR_TIMEOUT_SECS` | `300` | sidecar invoke 超时 |
| `ENABLE_CDP` | (Electron 模式) | 启用 CDP 远程调试（9222 端口） |
| `DEBUG` | — | 调试开关（eaa/ipc/agent/chat/cron/privacy/render/logLevel/cdpPort/slowThresholdMs） |

---

## 9. 配置体系

### 9.1 三层配置优先级（高 → 低）

1. **In-app Settings**（`#/settings`）→ `userData/settings.json`
2. **`config/` 目录**（随应用分发）→ `agents.yaml` + `reason-codes.json`
3. **硬编码 fallback** → `src/main/services/settings-service.ts`

### 9.2 关键配置文件

| 文件 | 说明 |
|---|---|
| `config/agents.yaml` | 18 Agent 注册表（id / role / model_tier / capabilities / schedule.cron / risk_thresholds） |
| `config/reason-codes.json` | 原因码 + 标准分值 + 分类 |
| `tauri.conf.json` | Tauri 配置（productName / identifier `com.educationadvisor.tauri` / 窗口 / CSP / bundle resources） |
| `src-tauri/capabilities/default.json` | Tauri 权限清单（shell/dialog/notification/os 全开） |
| `electron-builder.yml` | Electron 打包配置（保留） |
| `biome.json` | Linter/Formatter |
| `tsconfig.json` | TS 配置 + 路径别名（`@main` / `@shared`） |

### 9.3 Tauri 配置要点（`tauri.conf.json`）

- `identifier`: `com.educationadvisor.tauri`（决定 userData 目录名）
- `frontendDist`: `../dist/renderer`
- `devUrl`: `http://localhost:5173`
- `beforeDevCommand`: `npm run dev:renderer`
- `beforeBuildCommand`: `npm run build`
- 窗口: 1400×900，最小 1024×640，居中
- `bundle.resources`: `["../config", "../resources/eaa-binaries"]`
- `bundle.targets`: `["nsis", "msi"]`
- CSP 白名单: openai / deepseek / feishu / ollama(localhost:11434) / moonshot / anthropic / google / minimax + dev ws

---

## 10. 18 个 Agent 清单

每个 Agent 是一对 Markdown 文件（`SOUL.md` 人格 + `AGENTS.md` 工作规则）+ `config/agents.yaml` 注册条目。

| # | Agent | 角色 | 模型层 | 调度 | 能力范围 |
|---|---|---|---|---|---|
| 1 | `main` | 教育顾问协调员 | high-quality | 按需 | 全部读 + 推送 + 调度 |
| 2 | `governor` | 督察（复盘 + 校验） | low-cost | 6× daily + weekly | read · summary · range · stats · ranking |
| 3 | `counselor` | 辅导员（谈话计划 + 学业日报） | low-cost | 2× daily | read · summary · ranking · add-event |
| 4 | `supervisor` | 日报员 | low-cost | 3× daily | read · summary · ranking · stats · range |
| 5 | `validator` | 数据审计员 | low-cost | every 6h | read · stats · codes |
| 6 | `academic` | 学业分析师 | high-quality | 1× daily | read · summary · stats · ranking |
| 7 | `psychology` | 心理观察员 | low-cost | 1× daily | read · search · history · summary |
| 8 | `safety` | 安全检查员 | low-cost | Mon 08:00 | read · add-event |
| 9 | `home_school` | 家校联络员 | low-cost | 1× daily | read · summary · ranking |
| 10 | `research` | 研究助手 | low-cost | 1× nightly | read · summary · stats |
| 11 | `executor` | 系统执行者 | low-cost | 1× nightly | read · stats · codes |
| 12 | `bug-hunter` | Bug 猎人（Agent 自检） | low-cost | 按需 | read only |
| 13 | `class-monitor` | 班长 | low-cost | 按需 | read · add-event · list · summary |
| 14 | `risk-alert` | 风险预警员 | low-cost | 2× daily + Fri | read · ranking · stats · summary · range |
| 15 | `data-analyst` | 数据分析师 | high-quality | Mon 09:00 | read · stats · ranking · summary · range |
| 16 | `student-care` | 学生关怀员 | low-cost | 按需 | read · history · search · list · ranking · summary · add-event |
| 17 | `discipline-officer` | 纪律委员 | low-cost | 按需 | read · add-event · ranking · history |
| 18 | `weekly-reporter` | 周报员 | high-quality | Fri 16:00 | read · summary · stats · ranking · range |

新增 Agent：在 `agents/your-id/` 放 `SOUL.md` + `AGENTS.md`，在 `config/agents.yaml` 加条目，重启即可。

---

## 11. 数据存储与隐私引擎

### 11.1 EAA CLI 数据布局

```
<userData>/eaa-data/                # EAA_DATA_DIR (sidecar 注入)
├── events.jsonl                    # 事件流（append-only，主存储）
├── events.json                     # 旧格式（首次 append 自动迁移到 jsonl）
├── entities.json                   # 学生实体 + 元数据
├── reason-codes.json               # 原因码 + 标准分值
├── entities/
│   ├── scores.cache.json           # ★ 排行榜/分数查询缓存（v3.1.4）
│   ├── event_stats.cache.json      # ★ 统计缓存（v3.1.5）
│   └── daily_dedup.cache.json      # ★ 重复检测缓存（v3.1.6）
├── privacy/
│   └── mapping.enc                 # PII 加密映射表（AES-256-GCM）
└── logs/
    └── operations.jsonl            # 操作审计日志
```

### 11.2 三个数据存储位置（重要）

| 位置 | 用途 |
|---|---|
| `test-volume-data/eaa-data` | 测试数据（101 学生，193K+ 事件） |
| `C:\Users\<user>\AppData\Roaming\Education Advisor\eaa-data` | 原 Electron 生产数据 |
| `C:\Users\<user>\AppData\Roaming\com.educationadvisor.tauri\eaa-data` | **Tauri 生产数据**（identifier 决定） |

三套独立数据存储。从 Electron 迁移到 Tauri 需手动复制数据目录。

### 11.3 操行分规则

- 基础分: `BASE_SCORE = 100.0`
- 单次最大加减: `MAX_DELTA = +10` / `MIN_DELTA = -10`
- 事件类型: `ConductDeduct`（扣分）/ `ConductBonus`（加分）
- 软删除: `EntityStatus::Deleted`，事件 `is_valid=false` + tombstone（保留历史）
- 撤销: append 对冲事件 + 原事件 `reverted_by` 指向对冲事件 ID

### 11.4 隐私引擎（PII Shield）

- **加密**: AES-256-GCM，密钥由 password 经 SHA-256 派生
- **映射**: 确定性化名（`S_001` / `P_001` / `C_001` / `SCH_001` / `ID_001` / `ADDR_001` / `PH_001`）
- **脱敏**: AhoCorasick 多模式替换（发给 LLM 前）
- **还原**: 化名 → 明文（LLM 返回后）
- **定向过滤**: 发给某接收者时把其他人替换为"其他同学"
- **合规依据**: 《个人信息保护法》《未成年人网络保护条例》

### 11.5 keystore 加密差异（迁移注意）

| 模式 | 加密方式 |
|---|---|
| Electron | `safeStorage` (Windows DPAPI) |
| Tauri sidecar | AES-256-GCM + 机器标识派生密钥（`hostname|username|platform|arch` 的 SHA-256） |

⚠️ 由于密钥派生方式不同，旧 DPAPI 加密的 `keystore.enc` 无法用新方式解密 —— 用户需重新输入 API Key（应用会优雅提示）。

---

## 12. 测试体系

### 12.1 测试矩阵

| 维度 | 工具 | 规模 | 结果 |
|---|---|---|---|
| 单元测试 | vitest | 25 文件 / 422+ 用例 | ✅ 全绿 |
| 渲染层 e2e | page-render + component-render | 15 项 | ✅ |
| Agent 循环 e2e | agent-loop-e2e | 3 项 | ✅ |
| sidecar IPC 核心 | test-sidecar.mjs | 12 项 | ✅ |
| sidecar IPC 全量 | test-sidecar-full.mjs | 24 项（13 命名空间） | ✅ |
| Tauri 端到端 | tauri dev | 启动链路 | ✅ |
| 生产打包 | tauri build | NSIS + MSI | ✅ |
| 持续深度测试 | 18 轮 | 103 通道 / 压力 / 边界 / 持久化 / 启停 / 事件流 / 工作流 / 并发 / 崩溃恢复 / 导出 / 重复 / 长时 / 回归 / 子系统 / 分数 / 混沌 | ✅ |

### 12.2 EAA CLI 性能基线（225K 事件，无并发）

| 命令 | 耗时 |
|---|---|
| add | 45ms |
| score | 19ms |
| history | 264ms |
| ranking | 18ms |
| stats | 295ms |
| search | 290ms |
| export | 18ms |
| dashboard | 66ms |
| revert | 376ms |
| validate | 273ms |
| doctor (stream) | 362ms |
| delete-student | 527ms (O(1) per student) |

### 12.3 压力测试记录

- 5000 ops: 0 errors, 195K events
- 10000 ops: 0 errors, 197K events
- 20000 ops: 0 errors, 199K events
- 36850 ops: 0 errors, add 20ms/score 4ms
- 67400 ops (10 cycles): 0 errors, 274K events, cache 20/20 consistent
- 单学生 5000 events: 0 errors, add 46ms/score 17ms/history 275ms
- 极端并发 5×150 ops (750 total): 0 errors, cache 102/102 consistent

### 12.4 缓存一致性

`cmd_add`/`cmd_revert`/`cmd_delete_student` 后必须更新三个缓存。写命令内部读缓存必须用 `_nolock` 变体（防 SharedFileLock + FileLock 死锁）。`event_stats.cache` 只计 valid / 非 reverted / 非 REVERT 事件。

---

## 13. 已知限制与待办

| # | 项目 | 影响 | 解决方向 |
|---|---|---|---|
| 1 | better-sqlite3 原生模块（环境问题） | Node v26 + Python 3.12 下无法编译，sidecar 降级 no-op，聊天历史重启不持久化 | 用 Node v22 或换 `sql.js` / `@libsql/client` |
| 2 | 系统托盘 | sidecar 下 no-op | `tauri-plugin-tray` |
| 3 | 开机自启 | sidecar 下 no-op | `tauri-plugin-autostart` |
| 4 | 系统通知 | sidecar 下 no-op | `@tauri-apps/plugin-notification`（依赖已装） |
| 5 | 生产打包 sidecar | bundle 不含 sidecar 源码 | 用 Node SEA / `pkg` 打成单 exe，`tauri.conf.json` 用 `externalBin` |
| 6 | OAuth 登录 | 回调端口监听需验证 | 集成测试 OAuth provider |

### 迁移期保留的"双轨"文件

以下文件/目录在迁移期保留，便于回退与对照测试，**不要删除**：
- `src/main/index.ts` — Electron 主进程入口
- `src/main/preload/` — Electron preload
- `electron-builder.yml` — Electron 打包配置
- `package.json` 中的 `dev`/`dev:electron`/`start`/`package*` 脚本
- `vite.config.main.ts` — Electron main 构建

---

## 附：版本与迁移历史

- **EAA CLI**: v3.1.4 → v3.2.2（详见 `project_memory.md` 的性能优化历史）
- **Tauri 迁移**: 2026-07-12 完成，业务代码零改动，115 通道验证通过
- **生产打包**: NSIS 2.4MB + MSI 3.7MB + 独立 exe 5.4MB

> 📖 更多细节参见：`MIGRATION_REPORT.md` / `PROBLEMS.md` / `docs/ARCHITECTURE.md` / `docs/EAA_BRIDGE.md` / `docs/CONFIGURATION.md`
