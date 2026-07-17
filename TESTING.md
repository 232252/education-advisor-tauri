# 🧪 测试总览 (TESTING.md)

> **本文是 `education-advisor-tauri` 测试体系的总索引 + Mock 模式目录。**
> 目标：让任何人（包括能力较弱的小模型）照着就能写出一个合格的新测试。
>
> - **当前规模**：51 个测试文件，**972 个测试用例**，全绿（2026-07-18 实测）
> - **自检**：`scripts/self-check.cjs` 72 项全过
> - **配套文档**：[`WIKI.md`](./WIKI.md) §5、[`docs/CODE_WIKI.md`](./docs/CODE_WIKI.md) §12

---

## 📑 目录

1. [跑测试（命令速查）](#1-跑测试命令速查)
2. [Vitest 配置（双 project）](#2-vitest-配置双-project)
3. [全局 setup（`tests/setup.ts`）](#3-全局-setuptestssetupts)
4. [测试文件总索引（51 个）](#4-测试文件总索引51-个)
5. [Mock 模式目录（12 种，照抄即可）](#5-mock-模式目录12-种照抄即可)
6. [覆盖率与门槛](#6-覆盖率与门槛)
7. [E2E vs 单测哲学](#7-e2e-vs-单测哲学)
8. [`self-check.cjs` 自检项](#8-self-checkcjs-自检项)
9. [写新测试的决策树](#9-写新测试的决策树)
10. [常见坑](#10-常见坑)

---

## 1. 跑测试（命令速查）

| 目的 | 命令 |
|---|---|
| 全套（两个 project） | `npm test` （= `vitest run`） |
| watch 模式 | `npm run test:watch` |
| 覆盖率报告 | `npm run test:coverage` |
| 只跑一个 project | `npx vitest run --project main` 或 `--project renderer` |
| 只跑一个文件 | `npx vitest run tests/main/academic-service.test.ts` |
| 按测试名过滤 | `npx vitest run -t "原子写入"` （子串匹配） |
| 一个 e2e 文件 | `npx vitest run tests/e2e/agent-loop-e2e.test.ts` |
| 覆盖率门槛检查 | `node scripts/coverage-threshold.mjs` （需先跑 `test:coverage`） |
| 开源就绪自检 | `npm run self-check` （72 项） |
| **跑全套但跳过 10 分钟 stress-long** | `npx vitest run --exclude "**/stress-long.test.tsx"` |

**默认串行**：`vitest.config.ts:59` 设了 `fileParallelism: false`（避免端口 / 资源冲突，尤其 e2e 用真 EAA 二进制）。整套跑下来 ~14 分钟（主要耗时在 e2e）。

**reporters**：本地 `['verbose']`，CI 环境（`process.env.CI`）切 `['default']`（`vitest.config.ts:61`）。

---

## 2. Vitest 配置（双 project）

`vitest.config.ts:26-55` 用 `test.projects:[]` 分成两个 project：

| project | 环境 | include | setup |
|---|---|---|---|
| `renderer` | `jsdom` | `src/renderer/**` + `tests/renderer/**` | `./tests/setup.ts` |
| `main` | `node` | `src/main/**` + `tests/main/**` + `tests/shared/**` + `tests/e2e/**` | `./tests/setup.ts` |

**关键参数**：
- `globals: true` —— `describe/it/expect/vi` 全局可用，不用 import
- `testTimeout: 30_000` —— 单测 30 秒超时（CI 友好，e2e 自定义更长）
- `fileParallelism: false` —— 串行
- **别名**：`@main` / `@renderer` / `@shared` → `src/main` / `src/renderer` / `src/shared`
- **coverage**（`:63-72`）：v8 provider，`text/html/json-summary` 三种报告，include `src/**/*.{ts,tsx}`，排除 `__tests__/**` 和 `*.test.*`（测试代码不稀释覆盖率）

⚠️ **加新测试目录要注意**：如果你新建了 `tests/<新领域>/`，**必须同时把它加进 `vitest.config.ts` 对应 project 的 `include`**——否则 Vitest 根本不会发现这些文件（之前出过 `tests/renderer/**` 没被 include 导致 19 个测试长期不跑的事故，见 BUG_REPORT.md item G）。

---

## 3. 全局 setup（`tests/setup.ts`）

`tests/setup.ts`（65 行）两个项目共用，做两件事：

### jsdom localStorage polyfill（`:13-38`）
如果 `window.localStorage` 缺失（jsdom 默认有，但保险起见），装一个内存版，让 React Testing Library 和 zustand persisters 能用。

### Console 静默（`:42-64`）
默认把 `console.error` / `console.warn` 替换成 no-op（测试里 service 故意触发的错误日志不刷屏）。

**故意要打印的逃生口**：第一个参数以 `"SUPPRESS:"` 开头会 fall through 到原 handler：
```ts
console.error('SUPPRESS: 这条会真的打印', someDetail)
```
`afterAll` 自动恢复 + `vi.restoreAllMocks()`。

**注意**：`tests/setup.ts` **不 mock `electron`**。每个需要的测试自己用 `vi.hoisted` + `vi.mock('electron', ...)`。

---

## 4. 测试文件总索引（51 个）

> 文件分布：`tests/main/` 26 + `tests/renderer/` 13 + `tests/shared/` 1 + `tests/e2e/` 6 + `src/**/__tests__/` 5 = 51。

### 主进程单测（`tests/main/`，26 个文件）

| 文件 | `it` 数 | 测什么 | Mock 模式 |
||---|---:|---|---|
| `academic-service.test.ts` | 21 | 学业数据 CRUD、`safeName` 路径穿越防御、`batchSetGrades` upsert、`deleteExam` 级联 | A（electron + 真 fs） |
| `atomic-write.test.ts` | 4 | R4 新增：`atomicWrite` 并发安全（s1 同文件并发写 100 次、s2 并发读写一致性、s3 5MB 大文件、s4 `renameWithRetry` EPERM 重试） | K + 真 fs |
| `class-service.test.ts` | 25 | 班级 CRUD、`validateClassId`、archive/restore 时间戳、`archived` 0/1→bool | B（mock dbService） |
| `compaction-helper.test.ts` | 23 | `evaluateCompaction` 阈值、token 估算、`compactChatMessagesSimple` 截断、`compactAgentMessages` | E（importActual spread） |
| `cron-service.test.ts` | 18 | addTask/updateTask/toggle/runNow、bitable sync、`syncAgentSchedules`、`loadPersistedLogs` | A + 多 service mock |
| `db-service.test.ts` | 13 | 真 better-sqlite3、isReady、recordExecution、chat 消息持久化、NaN→null | 真 native（带 `isReady()` 守门） |
| `eaa-bridge.test.ts` | 26 | EAABridge ctor、`execute()` JSON 解析、`--output json` 注入、ENOENT 自愈、`initialize` 健康检查 | D（MockChildProcess + cross-spawn mock）+ G（existsSync） |
| `eaa-tools-sanitize.test.ts` | 27 | `safeExecute`（控制字符 / shell 元字符 / `--` 拒绝）、`sanitizeArg` flags、`tokenizeQuery` | B（mock eaa-bridge）+ `it.each` |
| `eaa-tools-tokenize.test.ts` | 12 | `tokenizeQuery` 引号 / 空格 / 空 / 边界 | B + K（纯函数） |
| `feishu-message-utils.test.ts` | 28 | R6-7 原型链污染防御（`sanitizeObject`）、`safeJsonParse`、`extractText` 去 @占位符 | K（纯函数，零 mock） |
| `feishu-service.test.ts` | 21 | testConnection token 截断、tenantToken 缓存、listBitableTables、sendTextMessage、URL 注入防御 | C（fetch spy）+ F（resetModules） |
| `file-tools.test.ts` | 21 | read/write_file/excel/csv、list_dir 往返、BOM、CSV 转义、5MB 限制、maxRows | K（无 mock，真 fs+xlsx） |
| `keystore-service.test.ts` | 11 | setApiKey/getApiKey 原子写、`__secret__:` 前缀、加密不可用降级 | A（含完整 safeStorage mock） |
| `log-handler-utils.test.ts` | 11 | `readLogTail` 空文件安全、`searchLog`、`readLogTailByLevel`、`listLogFiles` | A（真 fs） |
| `log-handlers.test.ts` | 31 | initLogger/getLogsDir、listLogFiles（三流）、searchLog 大小写无关、exportLog、clearAllLogs | A（真 fs） |
| `mcp-agent-integration.test.ts` | 18 | R8 新增：Agent ↔ MCP 集成（agents.yaml `mcp_servers` 字段加载回填到 `AgentConfig.mcpServers`、引用不存在 server 时 graceful 降级、不配 mcpServers 时为 undefined 等） | A（electron + 真 fs + 真 yaml） |
| `mcp-helpers.test.ts` | 39 | `interpolateEnv`/`deepInterpolate` 环境变量插值、`validateServerConfig` 9 条件 type guard（4 ACCEPT / 17 REJECT）、`validateCommandSafe` 防 shell 注入（5 条） | K（纯函数 + process.env 快照） |
| `mcp-service-crud.test.ts` | 21 | McpService 增删改 + 覆盖语义：user yaml 覆盖全局、addServer/updateServer/removeServer 原子写、拒绝重复 id / 危险 command、删除不存在 id 抛错 + R4-EDGE-MCP-ID 路径分隔符防御 | A（electron + 真 fs） |
| `mcp-tools.test.ts` | 38 | `jsonSchemaToTypebox`（各种类型）、`sanitizeMcpArgs` 递归、`mcpToolToAgentTool` 命名/execute、去重 | B（三 service mock） |
| `ollama-service.test.ts` | 28 | isServeRunning、listModels、pullModel NDJSON 流、deleteModel、detect 缓存、RECOMMENDED_MODELS schema | D（spawn mock）+ C（fetch spy） |
| `pi-ai-helpers.test.ts` | 49 | `dedupeModels`、`costScore`（Infinity 降权）、`selectCheapestModel`、`mapEvent`（12 路 switch）、`extractPartialToolCall`、`isRetryableError`（大小写敏感） | K（纯函数，零 mock） |
| `profile-service.test.ts` | 7 | profile get/set/update、路径穿越、中文名 | A（真 fs） |
| `settings-service.test.ts` | 19 | dotPath 校验、深合并、原子写、节流、shortcuts 含点号键、3 个回归 | A（真 fs） |
| `skill-service.test.ts` | 11 | list/save/get/delete、YAML frontmatter、名字校验 | A（真 fs + isPackaged:false） |
| `update-service.test.ts` | 21 | checkForUpdates（无 repo / 成功 / 404 / JSON 解析失败 / 原型污染）、setRepoUrl 优先级、showUpdateDialog | H（mock node:https）+ 多 service mock |
| `utility-tools.test.ts` | 27 | getCurrentTime 时区、calculate（Math 白名单、全角符号、百分号、除零、安全） | K（纯函数） |
| `__tests__/feishu-command-router.test.ts`（在 `src/main/services/` 下） | 27 | parseCommand、default router 分发（/help /echo /agents /score /dashboard）、自定义注册、错误截断 | K（纯函数 + 内联 vi.fn） |

### 渲染层单测（`tests/renderer/`，13 个文件）

| 文件 | `it` 数 | 测什么 | Mock 模式 |
||---|---:|---|---|
| `lib/class-id.test.ts` | 20 | gradeToNumber（中/阿/混）、classNoFromName、computeAutoClassId | K（纯函数） |
| `lib/cron-utils.test.ts` | 29 | validateCron（5 段、范围、step、拒绝 `@` 宏）、CRON_PRESETS | K |
| `lib/dashboard-stats.test.ts` | 26 | computeScoreIntervals 分桶、computeReasonDistribution、computePeriodSummary（top-N）、computeClassComparison | K |
| `lib/exam-comparison.test.ts` | 40 | 考试对比（ExamComparison）纯函数：scoreDelta、trendScore、风险归因 | K |
| `lib/ipc-client.test.ts` | 8 | `getErrorMessage`（data → stderr → fallback） | K |
| `lib/mcp-validate.test.ts` | 9 | 前端表单校验 `validateMcpConfig`：合法 stdio/sse 无错误、id/name 空、id 非法字符、stdio 缺 command、sse 缺 url、url 非法、command 含 shell 元字符 | K（纯函数） |
| `lib/merge-settings.test.ts` | 10 | UI-1 修复新增：`mergeSettings(partial, defaults)` 递归合并 — 完整 settings 后端覆盖默认、稀疏 settings 缺 feishu/chat.compaction 不抛、空对象/null/undefined 边界、数组按值覆盖、显式 null 覆盖 | K |
| `lib/student-filters.test.ts` | 25 | filterStudents（班级/搜索/存档）、sortStudentsByRisk、isAllSelected、countArchivedHidden、buildClassIdToNameMap | K |
| `lib/tauri-bridge.test.ts` | 16 | `installTauriBridge` 命名空间映射 → `invoke('ipc_invoke', {channel, args})` | I（mock @tauri-apps/api） |
| `lib/ui-utils.test.ts` | 30 | cn、riskColor/BgColor/DotColor、btnStyle、badgeStyle、INPUT_BASE | K |
| `stores/chatStore.test.ts` | 19 | handleStreamEvent（start/text_delta/done/error/thinking）、session CRUD、setModel、handleAgentEvent | J（mock getAPI） |
| `stores/settingsStore.test.ts` | 6 | fetchSettings、updateSetting、resetSettings + 失败处理 | J |
| `stores/toastStore.test.ts` | 12 | push/dismiss/clear + toast.success/error/...、fake timers 自动消失 | `vi.useFakeTimers()` |

### 共享层 + E2E（`tests/shared/` + `tests/e2e/`，7 个文件）

| 文件 | `it` 数 | 测什么 | Mock 模式 |
|---|---:|---|---|
| `shared/debug.test.ts` | 20 | buildConfig（DEBUG / DEBUG_EAA / ...）、debugPrefix、debugLog、startIpcTimer | F（resetModules）+ process.env 修改 |
| `e2e/agent-loop-e2e.test.ts` | 3 | Agent 完整循环（3 轮 tool calls）、`transformContext` 中途压缩不中断 | 真 `Agent` + mock streamFn |
| `e2e/business-scenario.test.tsx` | 12 | 班级 / 学生 / 仪表盘（含 class_id 修复）、20-50-10 压力 | L（真 eaa 二进制 + RTL） |
| `e2e/component-render.test.tsx` | 6 | 真 eaa + RTL：ranking/summary 含 class_id、30 ranking < 3s | L |
| `e2e/page-render.test.tsx` | 9 | 用户报 Bug 验证（4）+ 业务场景（5：链路/筛选/对比/100 混合/10 并发） | L |
| `e2e/stress-long.test.tsx` | 1 | **10 分钟**（12min 超时）持续随机操作；40% add / 30% event / 20% query / 10% delete | L |
| `e2e/user-flow-simulation.test.tsx` | 18 | 14 场景（9 个 user action helper）、3 分钟压力、4 个用户报 Bug 验证 | L |

### 渲染层 inline 测试（`src/renderer/**/__tests__/`，4 个文件）

| 文件 | `it` 数 | 测什么 |
||---|---:||
| `src/renderer/hooks/__tests__/hooks.test.tsx` | — | hooks 聚合测试 |
| `src/renderer/hooks/__tests__/useDebounce.test.tsx` | — | `useDebounce` 防抖行为 |
| `src/renderer/i18n/__tests__/i18n.test.ts` | 11 | t/setLang/useT、`i18n-changed` 事件 |
| `src/renderer/stores/__tests__/agentStore.test.ts` | 7 | subscribeStatus、selectAgent、refreshDetail、runAgent |

> 另有 1 个 main 端 inline 测试 `src/main/services/__tests__/feishu-command-router.test.ts`(27 用例),归在主进程表里。

**合计 51 个测试文件、972 个测试用例**（含 `it.each` 展开后的子用例）。跑 `npm test` 全绿（实测 2026-07-18，14 分钟）。本轮（R1-R10）累计新增/扩展关键测试文件 6 个共 ~125 个用例：
- `tests/main/atomic-write.test.ts`（4 用例，R4 并发安全）
- `tests/main/mcp-agent-integration.test.ts`（18 用例，R8 Agent↔MCP 集成）
- `tests/main/mcp-service-crud.test.ts`（9→21 用例，R4-EDGE-MCP-ID 路径分隔符防御）
- `tests/renderer/lib/merge-settings.test.ts`（10 用例，UI-1 嵌套访问白屏修复）
- `tests/renderer/lib/exam-comparison.test.ts`（40 用例，纯函数）
- `tests/renderer/lib/mcp-validate.test.ts`（9 用例，前端表单校验）

详见 [`docs/TEST_COVERAGE_REPORT.md`](./docs/TEST_COVERAGE_REPORT.md)。

---

## 5. Mock 模式目录（12 种，照抄即可）

**这是本文最有价值的部分**。写新测试时先对照下表选模式，再去对应范例文件抄代码。

### Pattern A — `vi.hoisted` + `vi.mock('electron')` + 真 fs 到 tmpDir

**何时用**：service 往 `userData` 写文件（academic、class via db、settings、profile、skill、keystore、cron、log-handler）。
**范例**：`tests/main/academic-service.test.ts:8-44`、`tests/main/keystore-service.test.ts:6-49`。

```ts
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// ⚠️ vi.hoisted 里 os/fs 还在 TDZ，用 process.env.TEMP 拼路径
const tmpDir = path.join(
  process.env.TEMP || '/tmp',
  `myservice-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
)

const mocks = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => {
    if (name === 'userData') return tmpDir
    throw new Error(`Unexpected path: ${name}`)
  }),
}))

vi.mock('electron', () => ({ app: { getPath: mocks.getPath, isPackaged: false } }))
// 如果 service 用了 logger，再 mock 一下避免刷屏：
vi.mock('../../src/main/utils/logger', () => ({ log: vi.fn() }))

const { myService } = await import('../../src/main/services/my-service')

beforeAll(async () => { await fsp.mkdir(tmpDir, { recursive: true }) })
afterAll(async () => {
  try { await fsp.rm(tmpDir, { recursive: true, force: true }) } catch {}
  vi.restoreAllMocks()
})
```

### Pattern B — `vi.mock('../other-service')`（mock 依赖的 service，不 mock electron）

**何时用**：service 是另一个 service 的薄包装（class → db、mcp-tools → mcp-service/file-tools/eaa-bridge）。
**范例**：`tests/main/class-service.test.ts:9-36`、`tests/main/mcp-tools.test.ts:10-40`。

```ts
const mocks = vi.hoisted(() => ({
  insertClass: vi.fn(() => true),
  updateClass: vi.fn(() => true),
  getLastError: vi.fn(() => null),
  // ... 把包装调用的每个方法都列出来
}))

vi.mock('../../src/main/services/db-service', () => ({
  dbService: {
    insertClass: mocks.insertClass,
    updateClass: mocks.updateClass,
    getLastError: mocks.getLastError,
  },
}))

const { classService } = await import('../../src/main/services/class-service')

beforeEach(() => { vi.clearAllMocks() })

it('DB 写失败时返回 lastError', () => {
  mocks.updateClass.mockReturnValue(false)
  mocks.getLastError.mockReturnValue('not found')
  expect(classService.update('r1', { name: 'x' })).toEqual({ success: false, error: 'not found' })
})
```

### Pattern C — `vi.spyOn(globalThis, 'fetch')` 给 HTTP service

**何时用**：service 是 REST 客户端（feishu-service、ollama-service 的 HTTP 部分）。
**范例**：`tests/main/feishu-service.test.ts:17-39`。

```ts
let mod: typeof import('../../src/main/services/feishu-service')
let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  vi.resetModules()                                    // 清模块级缓存（如 cachedToken）
  mod = await import('../../src/main/services/feishu-service')
  fetchSpy = vi.spyOn(globalThis, 'fetch')
})

function mockTokenResponse(token = 't-xxx', expire = 7200): Response {
  return new Response(JSON.stringify({ code: 0, tenant_access_token: token, expire }), { status: 200 })
}

it('token 跨调用缓存', async () => {
  fetchSpy.mockResolvedValue(mockTokenResponse())
  await mod.testConnection('id', 'secret')
  fetchSpy.mockResolvedValue(new Response(JSON.stringify({code:0,data:{items:[]}}), {status:200}))
  await mod.listBitableTables('id', 'secret', 'appToken')
  const tokenCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('tenant_access_token'))
  expect(tokenCalls).toHaveLength(1)                  // 缓存命中
})
```

NDJSON 流式响应用 `ReadableStream` + `TextEncoder` 构造 body（见 `tests/main/ollama-service.test.ts:46-56`）。

### Pattern D — `vi.hoisted` + `vi.mock('cross-spawn')` + `MockChildProcess`

**何时用**：service spawn 子进程（eaa-bridge、ollama 的 spawn 部分）。
**范例**：`tests/main/eaa-bridge.test.ts:19-50`。

```ts
import { EventEmitter } from 'node:events'

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  emitData(stream: 'stdout' | 'stderr', chunk: string) { this[stream].emit('data', Buffer.from(chunk)) }
  emitClose(code: number) { this.emit('close', code) }
  emitError(err: Error) { this.emit('error', err) }
}

const mocks = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => name === 'userData' ? tmpDir : (() => { throw new Error() })()),
  spawnImpl: vi.fn(() => new MockChildProcess()),
}))

vi.mock('electron', () => ({ app: { getPath: mocks.getPath, isPackaged: false } }))
vi.mock('cross-spawn', () => ({ default: mocks.spawnImpl, __esModule: true }))

// 测 JSON 解析：
mocks.spawnImpl.mockImplementationOnce(() => {
  const proc = new MockChildProcess()
  setImmediate(() => {
    proc.emitData('stdout', JSON.stringify({ ok: true }))
    proc.emitClose(0)
  })
  return proc
})
```

模拟"平台不支持"（强制走不 spawn 的分支），覆盖 `process.platform`：
```ts
Object.defineProperty(process, 'platform', { value: 'aix', configurable: true })
try { /* test */ } finally { Object.defineProperty(process, 'platform', origPlatform) }
```

### Pattern E — `vi.importActual` spread 部分覆盖三方模块

**何时用**：只想覆盖几个具名导出，其余保持真实（compaction-helper 要真实 `Agent` 类型但 mock `completeSimple`）。
**范例**：`tests/main/compaction-helper.test.ts:14-37`。

```ts
vi.mock('@earendil-works/pi-ai/compat', async () => {
  const actual = await vi.importActual<typeof import('@earendil-works/pi-ai/compat')>(
    '@earendil-works/pi-ai/compat',
  )
  return { ...actual, completeSimple: mocks.completeSimple }
})
```

### Pattern F — `vi.resetModules()` + 动态 `await import` 重置模块状态

**何时用**：SUT 有模块级缓存 / 状态需要每次测试 fresh init（feishu-service `cachedToken`、eaa-bridge `binaryPath`、debug.ts）。
**范例**：`tests/main/feishu-service.test.ts:30-35`、`tests/main/eaa-bridge.test.ts:97-103`。

```ts
beforeEach(async () => {
  vi.resetModules()
  mod = await import('../../src/main/services/feishu-service')   // 全新模块 → cachedToken = null
  fetchSpy = vi.spyOn(globalThis, 'fetch')
})
```

### Pattern G — `vi.spyOn(fs, 'existsSync')` 让缺失文件"存在"

**何时用**：SUT 检查文件存在再行动（eaa-bridge 找 Rust 二进制）。
**范例**：`tests/main/eaa-bridge.test.ts:74-81`。

```ts
const origExistsSync = fs.existsSync.bind(fs)
const mockExists = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
  const ps = typeof p === 'string' ? p : ''
  if (ps.includes('eaa-binaries') && (ps.endsWith('eaa.exe') || ps.endsWith('eaa'))) return true
  return origExistsSync(p)
})
```

### Pattern H — `vi.mock('node:https')` 给老式 HTTP

**何时用**：service 用 `https.get` 而非 `fetch`（update-service 调 GitHub Releases API）。
**范例**：`tests/main/update-service.test.ts:30-62`。配套 `makeHttpsResponse` 工厂：

```ts
function makeHttpsResponse(data: string, statusCode = 200) {
  const res = new EventEmitter() as EventEmitter & { statusCode; setEncoding; resume; destroy }
  Object.assign(res, { statusCode, setEncoding: vi.fn(), resume: vi.fn(), destroy: vi.fn() })
  queueMicrotask(() => { res.emit('data', data); res.emit('end') })
  return res
}
```

### Pattern I — 给 renderer 测试 mock Tauri API 桥

**何时用**：测的代码用了 `@tauri-apps/api/core` `invoke` 或 `@tauri-apps/api/event` `listen`。
**范例**：`tests/renderer/lib/tauri-bridge.test.ts:6-15`。

```ts
const mockInvoke = vi.fn()
const mockListen = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => mockInvoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args) => mockListen(...args), unlisten: vi.fn() }))
```

### Pattern J — Mock `getAPI` 给 zustand store 测试

**何时用**：store 从 `lib/ipc-client` 导入 `getAPI`，需要 IPC 调用可观察。
**范例**：`tests/renderer/stores/chatStore.test.ts:9-46`。

```ts
const mockSaveMessage = vi.fn().mockResolvedValue({ success: true, id: 1 })
vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  getAPI: () => ({
    chat: { saveMessage: mockSaveMessage, deleteSession: vi.fn() },
    settings: { get: vi.fn().mockResolvedValue({...}) },
    ai: { listModels: vi.fn().mockResolvedValue([]) },
  }),
}))
vi.mock('../../../src/renderer/stores/toastStore', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

const { useChatStore } = await import('../../../src/renderer/stores/chatStore')

beforeEach(() => {
  vi.clearAllMocks()
  useChatStore.setState({ messages: [], isStreaming: false })  // 重置 zustand state
})
```

### Pattern K — 纯函数测试（无 mock）

**何时用**：模块导出纯辅助函数，无 I/O 无全局（class-id、cron-utils、dashboard-stats、student-filters、ui-utils、utility-tools、eaa-tools-tokenize、feishu-command-router）。
**范例**：`tests/renderer/lib/ui-utils.test.ts`、`tests/main/utility-tools.test.ts`。

```ts
import { describe, expect, it } from 'vitest'
import { myPureFn } from '../../src/...'
it('边界处理', () => { expect(myPureFn('x')).toBe('y') })
```

### Pattern L — 真 Rust sidecar via `spawn`（仅 E2E）

**何时用**：需要真正端到端数据流验证（business-scenario、component-render、page-render、user-flow-simulation）。
**范例**：`tests/e2e/business-scenario.test.tsx:24-72`。

```ts
const EAA_BIN = join(__dirname, '..', '..', 'resources', 'eaa-binaries',
  process.platform === 'win32' ? 'win32-x64' : (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'),
  process.platform === 'win32' ? 'eaa.exe' : 'eaa')

function eaaRun(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(EAA_BIN, args, { env: { ...process.env, EAA_DATA_DIR: TEST_DATA }, timeout: 10_000 })
    let out = '', err = ''
    proc.stdout?.on('data', (d) => out += d.toString())
    proc.stderr?.on('data', (d) => err += d.toString())
    proc.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error(`eaa exit ${code}`)))
  })
}
```

配套 `vi.mock('react-i18next')` 和 `vi.mock('echarts-for-react')` 给 RTL 用。

---

## 6. 覆盖率与门槛

### 跑覆盖率

```bash
npm run test:coverage       # 产出 coverage/ 目录（text + html + json-summary）
node scripts/coverage-threshold.mjs   # 读 coverage/coverage-summary.json 校验门槛，失败 exit 1
```

### 门槛（`scripts/coverage-threshold.mjs:30-62`）

| 类别 | lines | functions | statements | branches |
|---|---:|---:|---:|---:|
| **Core**（11 个核心 service） | 60% | 60% | 60% | 50% |
| **Shared**（debug.ts + ipc-channels.ts） | 90% | 90% | 90% | 85% |
| **Overall**（全项目） | 10% | 40% | 10% | 40% |
| **db-service.ts** 单独覆盖 | 35% | 45% | — | — |

**Overall 故意低**：渲染层页面需要 Electron，今天覆盖率是 0%。

### Core 11 个 service（必达标）

`settings-service` / `eaa-bridge` / `compaction-helper` / `cron-service` / `profile-service` / `keystore-service` / `db-service` / `skill-service` / `utility-tools` / `file-tools` / `eaa-tools`

### 明确排除的 service（`coverage-threshold.mjs:44-47` 注释）

| service | 排除原因 | 实际单测情况 |
|---|---|---|
| `agent-service.ts` | 依赖 LLM API，需集成测试 | 无独立单测，e2e 间接覆盖 |
| `pi-ai-service.ts` | 依赖 LLM API | 无单测 |
| `feishu-service.ts` | 依赖飞书 API | **有**（`feishu-service.test.ts` 21 用例，fetch spy） |
| `tray-service.ts` | 依赖 Electron 运行时 | 无 |
| `update-service.ts` | 依赖 Electron 运行时 | **有**（`update-service.test.ts` 21 用例，mock electron） |
| `mcp-service.ts` | 不在 core 列表 | 间接被 `mcp-tools.test.ts` 覆盖 |

### 渲染层覆盖

- 纯函数 `lib/*` 和 `stores/*` 有单测
- React 组件渲染测试目前没有（项目惯例：纯函数提取 + e2e 间接覆盖）
- 唯二的 inline 测：`src/renderer/i18n/__tests__/i18n.test.ts`、`src/renderer/stores/__tests__/agentStore.test.ts`

---

## 7. E2E vs 单测哲学

### 单测（`tests/main/*`、`tests/renderer/lib/*`、`tests/renderer/stores/*`、`tests/shared/*`）
- 跑在对应 `environment`（jsdom 或 node），**无 React、无 eaa 二进制、无真 Electron**
- 重度依赖 mock（Pattern A–K）
- 快（全套几十秒）
- 确定性

### E2E（`tests/e2e/*`）
- 全部归在 **`main` project**（`vitest.config.ts:43-53` 的 include 有 `tests/e2e/**`），用 `environment: 'node'`
- `.tsx` e2e（business-scenario / component-render / page-render / user-flow-simulation）：
  - 从 `@testing-library/react` 和 `react-router-dom` import，在 node 环境造 React 元素（**渲染层 project 的 jsdom setup 不生效**，因为这些文件匹配 main project 的 include）
  - 用 `globalThis.window = { api: mockApi }` 和 `Object.defineProperty(globalThis, 'matchMedia', ...)` 模拟浏览器全局
- **所有 `.tsx` e2e 都 spawn 真 `eaa` Rust 二进制**（`resources/eaa-binaries/<平台>/<arch>/eaa[.exe]`），用 `mkdtempSync` 建独立 tmp 数据目录，从 `core/eaa-cli/schema/reason_codes.json` 拷 schema
- `vi.mock('react-i18next')` 和 `vi.mock('echarts-for-react')` stub 掉需要浏览器的库
- 用 `MemoryRouter` 驱动路由

### 从默认 `npm test` 排除的

- **`tests/e2e/stress-long.test.tsx`**：10 分钟持续操作（12min 超时）。**没有 `.skip` 标记**，所以默认会跑——日常迭代时建议：
  ```bash
  npx vitest run --exclude "**/stress-long.test.tsx"
  ```
- `agent-loop-e2e.test.ts`：快（3 个测试，各 10s 超时）

### Playwright

`playwright ^1.61.1` 在 devDependencies（`package.json:96`），但 **`tests/e2e/` 里没有任何测试用它**——预留给未来浏览器驱动测试或 `scripts/` 下的手动脚本。

---

## 8. `self-check.cjs` 自检项

`npm run self-check` = `node scripts/self-check.cjs`，**72 项**校验开源就绪度，失败 exit 1，可作 CI 门禁。

| 桶 | 项数 | 内容 |
|---|---:|---|
| 根目录开源文件 | 13 | LICENSE/README/PROJECT_INTRO/CHANGELOG/CONTRIBUTING/SECURITY/ROADMAP/CODE_OF_CONDUCT/DEPLOY_TO_AI/BACKLOG/.env.example/.editorconfig/.gitignore（每个 >200 字节） |
| `docs/` | 13 | QUICK_START/ARCHITECTURE/CONFIGURATION/EAA_BRIDGE/AGENT_AUTHORING/DESKTOP_BUILD/DISTRIBUTION/DEVELOPMENT/PRIVACY_ENGINE/CRON/FAQ/TROUBLESHOOTING/SOP（每个 >500 字节） |
| `docs/decisions/` ADR | 1 | 必须正好 7 个 |
| `.github/` | 14 | CODEOWNERS、FUNDING.yml、dependabot.yml、labeler.yml、PR 模板、4 个 workflow、5 个 issue 模板 |
| `scripts/` | 3 | build-eaa.mjs、generate-update-manifest.mjs、analyze-links.mjs（每个 >1000 字节） |
| `package.json` 元数据 | 15 | name/version/license/private:false/author/repo/bugs.url/keywords≥5/engines.node 含 "22"/含 `build:eaa`/`package`/`typecheck`/`test`/`lint` script |
| IPC 通道 | 1 | `src/shared/ipc-channels.ts` 里 ≥85 个通道常量 |
| Agents | 4 | `agents/` 下正好 18 个目录，每个都有 `SOUL.md` + `AGENTS.md` |
| 配置 / Skills | 5 | `config/agents.yaml`、`reason-codes.json`、`default-settings.json`、`SMALL_MODEL_RULES.md`、`skills/STUDENT_MANAGEMENT.md` |
| 清理校验 | 4 | 根目录无 `verify-*` / `check-*` / `test-cdp-*` / `e2e-test.mjs`，无 `logs/` 目录 |

**当前状态：72 passed, 0 failed** ✅

---

## 9. 写新测试的决策树

```
被测模块是不是纯函数（无 I/O 无全局）？
├─ 是 → Pattern K（直接 import + it），收工。
└─ 否 → 它 spawn 子进程吗？
   ├─ 是 cross-spawn（eaa-bridge 风格）→ Pattern D（MockChildProcess）
   ├─ 是 node:child_process（ollama spawn）→ Pattern D 的变体
   └─ 否 → 它用 fetch 吗？
      ├─ 是 → Pattern C（fetch spy）+ 看有没有模块级缓存要 resetModules（Pattern F）
      ├─ 用 node:https → Pattern H（makeHttpsResponse）
      └─ 否 → 它依赖 electron API 吗（app.getPath / safeStorage）？
         ├─ 是 → Pattern A（vi.hoisted + vi.mock('electron') + 真 fs 到 tmpDir）
         │        └─ 还需要 mock logger 吗？是 → 加 vi.mock('../../src/main/utils/logger')
         └─ 否 → 它是另一个 service 的薄包装吗？
            ├─ 是 → Pattern B（vi.mock('../other-service')）
            └─ 是三方模块（@earendil-works/* / @tauri-apps/*）？
               ├─ Tauri API → Pattern I
               ├─ pi-agent-core/pi-ai → Pattern E（importActual spread）
               └─ 其他 → 全 mock 或 importActual
```

特殊情况：
- **store 测试**（zustand）→ Pattern J（mock `getAPI`）
- **需要端到端验证** → Pattern L（真 eaa 二进制）
- **模块级状态泄漏**（cachedToken / binaryPath / process.env 快照）→ 加 Pattern F（`vi.resetModules()` + 动态 import）

---

## 10. 常见坑

1. **`vi.hoisted` 里 `os` 和 `fs` 还在 TDZ**：用 `process.env.TEMP` + 字符串拼接，别 import `os`（见 `db-service.test.ts:13-21`、`log-handlers.test.ts:14-21`）。

2. **动态 import SUT 一致用 `await import('../../src/main/services/x')`**：在 `vi.mock(...)` 之后，模式统一。

3. **`vi.resetModules()` 在 beforeEach**：SUT 缓存模块级状态时必加（feishu-service.test.ts、eaa-bridge.test.ts、debug.test.ts）。

4. **`beforeEach(() => vi.clearAllMocks())`**：mock 调用历史清零，避免断言污染。

5. **`useChatStore.setState({...})` 重置 zustand**：store 状态跨测试泄漏的标配。

6. **真 better-sqlite3 测试用 `isReady()` 守门**：
   ```ts
   if (!dbService.isReady()) return  // 原生模块加载失败的优雅路径
   ```
   避免在没装 C++ 工具链的机器上测试整个挂掉。

7. **改 `process.env` 要 `vi.resetModules()`**：`debug.ts` 在模块加载时快照 env，光改 env 不重载模块没用。

8. **改 `process.platform` 要包 try/finally 还原**：`Object.defineProperty(process, 'platform', { value: 'aix', configurable: true })` 之后必须还原，否则后续测试全挂。

9. **Tauri 模块只能 mock 不能真跑**：`@tauri-apps/api/*` 在 node/jsdom 里没初始化，必走 Pattern I。

10. **`tests/setup.ts` 静默了 console.error/warn**：想看日志用 `console.error('SUPPRESS: ...', detail)` 逃生口。

11. **e2e 跑前必须 `npm run build:eaa`**：否则 `resources/eaa-binaries/` 是空的，所有 e2e 失败。

12. **新增测试目录要改 `vitest.config.ts`**：否则 Vitest 发现不了（历史教训：`tests/renderer/**` 没被 include 导致 19 个测试长期不跑）。

---

*本文档由 ZCode 基于代码精读 + 测试文件逐一分析编写。所有 Pattern 都附真实范例文件行号，照抄即可。如发现 Mock 模式有遗漏或描述不准，请提 issue。*
