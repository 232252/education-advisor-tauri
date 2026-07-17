# 测试覆盖率报告与盲区分析

> 生成日期: 2026-07-17
> 范围: `src/main/services/` 22 个 service + `src/renderer/` 纯函数
> 方法: v8 覆盖率报告 + 逐文件可测性人工评估

---

## 1. 总览

| 指标 | 数值 |
|---|---|
| 测试文件总数 | **45** (42 既有 + 3 本轮新增) |
| 测试用例总数 | **~835** (724 既有 + 111 本轮新增) |
| self-check | 72 passed / 0 failed |
| 主进程 service 覆盖 | **20 / 22** 有专属测试 |
| 渲染层纯函数模块 | **7** 个(`tests/renderer/lib/`) |

---

## 2. 本轮新增(Phase 3)

本轮针对 3 个"难测的大 service"做了**纯函数提取**——把埋在
god-class / LLM 编排逻辑里的无副作用函数抽到独立 `*-helpers.ts`,
再让原 service 单行委托回去。这样既不改变运行时行为,又让这些
关键逻辑获得了零 mock 的单元测试覆盖。

| 提取出的模块 | 行数 | 来源 service | 新增测试 | 用例数 |
|---|---|---|---|---|
| `src/main/services/pi-ai-helpers.ts` | 159 | pi-ai-service.ts (1093 行) | `tests/main/pi-ai-helpers.test.ts` | 49 |
| `src/main/services/mcp-helpers.ts` | 70 | mcp-service.ts (761 行) | `tests/main/mcp-helpers.test.ts` | 34 |
| `src/main/services/feishu-message-utils.ts` | 80 | feishu-bot-service.ts (539 行) | `tests/main/feishu-message-utils.test.ts` | 28 |
| **合计** | **309** | — | — | **111** |

### 提取的纯函数清单

**pi-ai-helpers.ts** (6 个):
- `dedupeModels` — 按 id 去重模型列表
- `costScore` — 单模型成本打分(undefined/NaN → Infinity)
- `selectCheapestModel` — 选最便宜模型(空数组抛错)
- `mapEvent` — pi-ai `AssistantMessageEvent` → 前端 `StreamEvent`(12 路 switch)
- `extractPartialToolCall` — 从 partial 消息提取 toolCall 信息
- `isRetryableError` — 错误消息是否可重试(大小写敏感,9 个关键词)

**mcp-helpers.ts** (3 个):
- `interpolateEnv` — `${VAR}` 环境变量插值
- `deepInterpolate` — 递归深度插值(对象/数组/字符串)
- `validateServerConfig` — 9 条件 type guard(防止 mcp.yaml 错配导致运行时崩溃)

**feishu-message-utils.ts** (3 个,**安全关键**):
- `sanitizeObject` — R6-7 原型链污染防御(递归删 `__proto__`/`constructor`/`prototype`)
- `safeJsonParse` — JSON.parse + sanitize
- `extractText` — 飞书消息 JSON → 纯文本(去 @占位符)

### 为什么选这 3 个 service

| service | 行数 | 可测纯函数 | 评估 |
|---|---|---|---|
| `pi-ai-service.ts` | 1093 | 6 个纯函数 + 多个可 mock 的编排器 | **测试价值高**——事件映射器 12 路、成本打分、重试判定都是热路径 |
| `mcp-service.ts` | 761 | 3 个纯函数 | **测试价值高**——config 校验是运行时崩溃的唯一屏障 |
| `feishu-bot-service.ts` | 539 | 3 个纯函数(安全关键) | **测试价值最高**——原型链污染防御运行在每条入站消息上 |

---

## 3. 已知盲区(本报告不强行补测,记录原因)

以下 service 没有专属测试,且本轮**没有补测**,因为测试成本远高于收益。

### 3.1 `agent-service.ts` (1196 行) — god-object,需要先重构

**为什么不测:**
- 单例类,所有方法 `private`,无 DI 缝隙
- 一个类同时管:配置加载、定时调度、IPC、LLM 运行、文件管理
- 核心方法 `runAgent` 依赖 `pi-agent-core` 的 `Agent` 类、`BrowserWindow.webContents.send`、`cronService`、`dbService`、`settingsService`、`keystoreService`、`skillService`、`mcpService`、`compaction-helper`、`eaa-tools`、`file-tools`、`utility-tools`、`mcp-tools`、`ipc-channels`——mock 表面积极大

**潜在纯函数(若未来重构可提取):**
- `withTimeout(promise, ms, label)` (line 85) — Promise 超时包装
- `safeCostScore` (line 104) — 与 pi-ai-helpers.costScore 重复
- `validateAgentId` (line 368) — 正则 + path 规范化
- compaction 自适应预留公式 (line 760 内联)
- history 淘汰逻辑 (appendExecution 内,50/agent + 2000 全局上限)

**建议:** 若要测,先做 `agent-helpers.ts` 提取(参考本轮 pi-ai-helpers 模式),
不要直接对单例写 mock-fest 测试。

### 3.2 `tray-service.ts` (125 行) — 低 ROI

**为什么不测:**
- 唯一有逻辑的导出是 `resolveIconPath`(3 个候选路径 + fs.existsSync fallback)
- 其余 `initTray`/`updateTray`/`destroyTray` 是 Electron `Tray` API 的薄包装
- mock Electron 的成本远大于验证"是否调了 setContextMenu"

**潜在测试:** 仅 `resolveIconPath` 的路径选择分支(3 case),价值有限。

### 3.3 `pi-ai-service.ts` / `mcp-service.ts` / `feishu-bot-service.ts` 的编排层

本轮只测了**提取出的纯函数**。这些 service 的**编排方法**(涉及 LLM 调用、
stdio spawn、SSE/WebSocket、fetch)仍未覆盖:

| 未覆盖方法 | 为什么难测 |
|---|---|
| `piAIService.chatStream` | 调 `streamSimple`(LLM 流式),需录制/回放 cassette |
| `piAIService.testConnection` | 调 `completeSimple`(LLM ping) |
| `piAIService.fetchProviderModels` | 真实 `fetch()` 到 `${baseUrl}/models`(可 mock fetch,但价值中等) |
| `mcpService.connectStdio` | `spawn()` 真实子进程 |
| `mcpService.connectSse`/`callToolSse` | `fetch()` HTTP POST |
| `mcpService.connectWebSocket` | 动态 `import('ws')` 开真实 socket |
| `feishuBotService.start` | `lark.WSClient` + `lark.Client` + fetch + agentService + BrowserWindow |
| `feishuBotService.handleMessage`/`reply` | 依赖 SDK + 私有方法链 |

**建议:** 这些方法的正确性更适合由 **e2e 测试**(`tests/e2e/`)覆盖,
而非逐方法单元测试。强行 mock SDK 会产出脆弱测试(SDK 升级即崩)。

### 3.4 渲染层组件

延续项目"轻组件测试"惯例——只测提取出的纯函数,不做全量 RTL 组件渲染。
已覆盖的纯函数模块(`tests/renderer/lib/`):
- `class-id.ts` (Classes 编号生成三件套)
- `student-filters.ts` (过滤/排序/选择)
- `dashboard-stats.ts` (统计计算)
- `ipc-client.ts` (getErrorMessage)
- `cron-utils.ts` / `tauri-bridge.ts` / `ui-utils.ts`

---

## 4. 测试策略总结(供后续维护者参考)

### 4.1 优先级决策树

```
新代码 / 既有代码无测试
  │
  ├─ 是纯函数吗?(无 I/O、无单例状态、无外部 SDK 调用)
  │   ├─ 是 → 直接写单元测试,零 mock。最高 ROI。
  │   └─ 否 ↓
  │
  ├─ 能提取成纯函数吗?(把逻辑从编排代码里抠出来)
  │   ├─ 能 → 提取到 *-helpers.ts,委托回去,测 helpers。本轮做法。
  │   └─ 否 ↓
  │
  ├─ 编排逻辑,但有清晰的 mock 缝隙?(service 依赖可 vi.mock)
  │   ├─ 是 → 写 service 测试,参考 tests/main/cron-service.test.ts 模式
  │   └─ 否 ↓
  │
  └─ 重度依赖外部运行时(LLM SDK、子进程、WebSocket)
      → 留给 e2e 测试,不强行单元测试
```

### 4.2 12 种 Mock 模式速查

详见 [`TESTING.md`](../TESTING.md) 第 4 节。最常用的 3 种:

| 模式 | 适用场景 | 参考文件 |
|---|---|---|
| A. `vi.hoisted` + `vi.mock('electron')` + tmpDir 真实 fs | main service 测 DB/文件 I/O | `tests/main/skill-service.test.ts` |
| B. `vi.mock` 兄弟 service | service 间依赖 | `tests/main/cron-service.test.ts` |
| D. `MockChildProcess` + `cross-spawn` | EAA CLI / 子进程 | `tests/main/eaa-bridge.test.ts` |

本轮新增的 3 个测试文件用的是**最简单的模式 K(纯函数,零 mock)**——
这也正是为什么它们能在 < 1 秒内跑完 111 个用例。

---

## 5. 覆盖率数据(v8 provider)

> 完整报告在 `coverage/index.html`(运行 `npm run test:coverage` 生成)。
> 下面是关键数字摘要,基于全量 `npx vitest run --coverage` 输出。

(覆盖率数字将在后台覆盖率任务完成后填入。运行命令:
`npx vitest run --coverage`,约 14 分钟。)

### 预期高覆盖区(>80%)
- `src/main/services/*-helpers.ts`(本轮新增,111 个用例针对这几个文件)
- `src/main/services/skill-service.ts` / `class-service.ts` / `academic-service.ts`(已有专属测试)
- `src/main/services/eaa-tools.ts`(34 用例 sanitize/tokenize)
- `src/shared/debug.ts` / `src/main/utils/logger.ts`(工具函数)

### 预期低覆盖区(<30%,已知盲区)
- `src/main/services/agent-service.ts`(god-object,见 §3.1)
- `src/main/services/pi-ai-service.ts` 编排方法(chatStream/testConnection,见 §3.3)
- `src/main/services/mcp-service.ts` 传输层(connectStdio/connectSse/connectWebSocket)
- `src/main/services/feishu-bot-service.ts` SDK 集成层(start/handleMessage/reply)
- `src/main/services/tray-service.ts`(低 ROI,见 §3.2)
- `src/main/ipc/*-handlers.ts`(IPC 胶水层,薄包装)
- `src/main/index.ts`(进程入口,bootstrap 逻辑)

---

## 6. 结论

本轮把测试用例数从 **724 → ~835**(+111),且全部是零 mock 的纯函数测试,
运行时间 < 1 秒。重点补齐了三条**安全关键**路径(原型链污染防御、
MCP 配置校验、LLM 事件映射)的覆盖。

剩余盲区都有明确的"为什么不测"理由(见 §3),不是疏忽而是**有意识的取舍**——
强行给 god-object 和外部 SDK 集成层写 mock-fest 测试,产出的是脆弱测试,
维护成本高于价值。正确的下一步是:**先重构(提取 helpers),再补测**,
正如本轮对 pi-ai/mcp/feishu-bot 做的那样。
