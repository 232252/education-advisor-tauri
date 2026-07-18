# 设计：技能页面升级为「能力中心」(技能 + MCP + 预留插件)

- **日期**：2026-07-17
- **状态**:核心 R1-R5 已落地(技能 → 能力中心 3 Tab 化、MCP 增删改查 + 模板 + i18n、覆盖语义、连接竞态/SSE/SSRF/原型污染等 10 项修复)。
  **R6 (2026-07-18) 超出本设计范围**:在 AgentsPage ConfigTab 新增 MCP server 多选 UI,Agent 可在 UI 配置引用哪些 MCP server,
  运行时通过 `getMcpToolsForAgent` 合并到工具集。撤销下方 §7 的 YAGNI 决策。详见 `MCP_INTEGRATION_PLAN.md` R6 状态条。
- **作者**：brainstorming 流程产出
- **关联**：`MCP_INTEGRATION_PLAN.md`（MCP 阶段性计划的最终落地 UI）

## 0. 背景与问题陈述

### 0.1 现状（探索结论）

项目已有完整的 MCP 后端，但**完全没有 UI**：

| 层 | 现状 |
|---|---|
| 后端 Service | `mcp-service.ts`（723 行，完整：stdio/sse/websocket 三种传输、连接池、惰性连接、工具列表） |
| 后端 IPC | `mcp-handlers.ts` 提供 5 个接口：`list / connect / disconnect / listTools / test` |
| 前端 API 层 | `ipc-client.ts` L195-201 + `tauri-bridge.ts` 都已声明 `mcp.*` 类型签名 |
| **前端 UI** | **零**。`src/renderer/pages/` 下没有任何文件调用过 `getAPI().mcp.*` |
| 配置存储 | `config/mcp.yaml`（全局只读，打包后位于 `resources/config/`） |

同时，导航栏 `/skills`（📝 技能）入口和 `SkillsPage.tsx`（535 行，完整的 Markdown 技能增删改查）**已存在且端到端贯通**。

### 0.2 用户需求（原话）

> 「MCP 功能虽然写了，但是没有这个接口，我希望这个接口在技能里面，导航栏有个技能……再加一个 MCP 和这个技能的一个功能……包括一些插件啊，都可以在这个技能里面，包括未来的一个设计都在里面把它完成一下。」

### 0.3 已确认的方向决策（来自 brainstorming 提问）

1. **页面形态**：Tab 标签页切换（顶部三个 Tab，复用 `SkillsPage` 外壳）
2. **「插件」定义**：插件就是 MCP 的业务别称，页面只两个真实 Tab（技能 + MCP 服务器）
3. **MCP 配置存储**：用户级 `mcp.user.yaml`（仿 `agents.user.yaml` 模式），与全局只读 `mcp.yaml` 合并
4. **MCP Tab 能力**：服务器 CRUD + 启用开关、连接测试 + 状态显示、工具列表浏览、预设模板一键添加（全选）
5. **未来扩展**：先留扩展位不实现（第三个「插件」Tab 放 EmptyState 占位）

### 0.4 关键技术约束（探索中发现）

- **现有 MCP 后端是「只读 + 连接管理」**：`mcpService.listServers()` 只读 `this.config`（一次性从 `mcp.yaml` 加载），`connectServer(id)` 只能连已存在于 `this.config` 中的 server（`mcp-service.ts:228-232`）。**没有 `addServer / updateServer / removeServer` 方法**，需新增。
- **`config/mcp.yaml` 在打包后是只读的**（`process.resourcesPath/config/`），所以用户改动必须写到可写位置。
- **项目 IPC 全链路改动标准是 6 处**：`ipc-channels.ts` 常量 → `mcp-handlers.ts` 实现 → `mcp-service.ts` 方法 → `ipc-client.ts` 类型 → `tauri-bridge.ts` 桥接 → `types/index.ts` 类型。
- **sidecar 自动复用**：`src/sidecar/sidecar-entry.ts` L71/L139 注册 `registerMcpHandlers`，新 IPC 无需额外注册。
- **测试惯例**：项目偏重纯函数单测（services 函数覆盖 87.6%），组件不测。

## 1. 总体架构

把现有 `SkillsPage` 升级成「能力中心」，统一管理三类能力：Markdown 技能 / MCP 服务器 / （预留）插件。三类用 Tab 切换，共用同一个页面外壳和导航入口 `/skills`。

```
┌─ 📝 技能（能力中心）──────────────────────────────────────┐
│ [ 技能(3) ] [ MCP服务器(2) ] [ 插件 ]   ← 顶部 Tab 栏      │
├──────────────────────────────────────────────────────────┤
│  <当前 Tab 内容区>                                        │
└──────────────────────────────────────────────────────────┘
```

- **复用**：导航项 `/skills`、路由、`SkillsPage.tsx` 文件壳、`getAPI().skill.*`、5 个现有 MCP IPC
- **新增**：3 个 MCP IPC（add/update/remove）+ `mcp.user.yaml` 读写层 + MCP Tab 组件 + 预设模板 + 3 个子组件
- **改动**：`SkillsPage.tsx` 重构成 Tab 容器（瘦到 ~80 行）；原技能逻辑搬到 `tabs/SkillsTab.tsx`

### 设计原则

- **隔离**：三个 Tab 各自独立，通过 `getAPI()` 这一层接口通信，互不依赖内部状态。
- **复用**：左右分栏布局、`useInterval`、`ConfirmDialog`、`EmptyState`、Toast 等都复用现有组件。
- **YAGNI**：第三个「插件」Tab 本次只放占位，不实现任何功能，但目录结构和 Tab 枚举留好扩展位。

## 2. 后端：MCP 增删改（最关键的新增）

### 2.1 新增 `mcp.user.yaml`（用户级，可写）

存放位置：`app.getPath('userData')/mcp.user.yaml`（与 `agents.user.yaml` 同目录）。

```yaml
# 用户级 MCP 服务器配置，覆盖全局 config/mcp.yaml
servers:
  - id: filesystem
    name: 本地文件系统
    description: 让 Agent 读写本地文档目录
    enabled: true
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "${USER_DOCS}"]
    env:
      USER_DOCS: "${env.USERPROFILE}/Documents"
```

### 2.2 `McpService` 新增 3 个方法

文件：`src/main/services/mcp-service.ts`

| 方法 | 签名 | 作用 | 关键点 |
|---|---|---|---|
| `addServer(config)` | `(config: McpServerConfig) => Promise<void>` | 写入 `mcp.user.yaml` 并合并到 `this.config` | 校验 id 唯一（全局+用户都不重复）+ `validateServerConfig` + 写文件 |
| `updateServer(id, patch)` | `(id: string, patch: Partial<McpServerConfig>) => Promise<void>` | 应用 patch 到该 id 的最终配置 | 见下方「覆盖语义」；若 server 正在连接，先断开再合并（下次惰性连接生效新配置） |
| `removeServer(id)` | `(id: string) => Promise<void>` | 移除该 id 的配置 | 见下方「覆盖语义」；若在连则先断开 |

#### 覆盖语义（重要——解决"全局只读 vs 用户想改开关"的矛盾）

原则：**全局 `mcp.yaml` 文件本身永不写入**（保持安装包配置干净），但用户可以「覆盖」全局项。

| 场景 | 当前 `source` | update 行为 | remove 行为 |
|---|---|---|---|
| 改纯用户级 server | `user` | 直接 patch `mcp.user.yaml` 该条 | 从 `mcp.user.yaml` 删除该条 |
| 改全局 server（首次覆盖） | `global` | **复制全局条目到 `mcp.user.yaml` + 应用 patch**，该 id 的 `source` 变为 `user` | 拒绝（throw `'global server has no user override to remove'`）—— 全局项不可从 UI 删除 |
| 改已被覆盖过的全局 server | `user`（覆盖产生的） | 直接 patch `mcp.user.yaml` 该条 | 删除 `mcp.user.yaml` 的覆盖条，**恢复全局默认**（`source` 变回 `global`） |

实现要点：
- `McpServerStatus.source` 透传到前端后，前端用 `source === 'global'` 时把「删除」按钮换成「恢复默认（仅覆盖项可恢复）」的禁用提示，避免用户困惑。
- 为区分「纯用户级」和「覆盖全局产生的用户级」，`mcp.user.yaml` 里可选字段 `overrides: 'global'` 标记覆盖来源（加载时若该 id 在全局也存在，则 remove 走"恢复默认"分支）。

### 2.3 配置合并规则（仿 `agents.user.yaml`）

修改 `loadConfig()`：

1. 先读全局 `config/mcp.yaml` → 标记 `source: 'global'`
2. 再读 `mcp.user.yaml` → 标记 `source: 'user'`
3. **用户级覆盖同 id 的全局项**（用户级整条替换，非深合并，简化语义）
4. `this.config` 中每条带 `source` 字段

`McpServerStatus` 类型加 `source: 'global' | 'user'` 字段，前端据此决定能否显示「删除/恢复默认」按钮。

### 2.4 新增 3 个 IPC

文件改动：`src/shared/ipc-channels.ts` + `src/main/ipc/mcp-handlers.ts`

| IPC channel | 字符串 | 入参 | 出参 |
|---|---|---|---|
| `IPC_MCP_ADD` | `mcp:add` | `McpServerConfig` | `{ success: boolean; error?: string }` |
| `IPC_MCP_UPDATE` | `mcp:update` | `{ id: string; patch: Partial<McpServerConfig> }` | `{ success: boolean; error?: string }` |
| `IPC_MCP_REMOVE` | `mcp:remove` | `id: string` | `{ success: boolean; error?: string }` |

### 2.5 安全约束（沿用现有 + 增强）

- 沿用 `validateServerId`（只允许 `^[a-zA-Z0-9_-]+$`，长度 ≤ 128）
- 沿用 `validateServerConfig`（`mcp-helpers.ts` 已有的字段校验）
- 沿用路径参数黑名单（`validateFilePath` 14 个敏感路径）+ `sanitizeArg`（shell 元字符过滤），这些在 `mcp-tools.ts` 工具调用时生效
- **新增**：`addServer / updateServer` 时对 `command` 字段额外做 shell 元字符白名单校验（拒绝 `; & | $ \` > <` 等），防止 `npx pkg && rm -rf` 类注入。校验函数放 `mcp-helpers.ts`，纯函数好测。
- **新增**：`mcp.user.yaml` 写入用原子写（先写 `.tmp` 再 rename），防止半写状态。
- 配置文件大小上限 1MB（防恶意撑爆）。

## 3. 前端：页面结构与组件拆分

### 3.1 目录结构

```
src/renderer/pages/Skills/
├── SkillsPage.tsx          ← 改:瘦成 Tab 容器(~80 行)
├── tabs/
│   ├── SkillsTab.tsx       ← 新:原 SkillsPage 的技能逻辑搬过来(几乎原样)
│   ├── McpTab.tsx          ← 新:MCP 服务器管理主 Tab
│   └── PluginsTab.tsx      ← 新:占位 EmptyState(预留扩展)
├── components/
│   ├── McpServerCard.tsx   ← 新:单个服务器卡片(状态/工具列表/操作按钮)
│   ├── McpServerForm.tsx   ← 新:新增/编辑表单弹窗(transport 切换不同字段)
│   └── PresetTemplates.tsx ← 新:预设模板选择弹窗
├── mcp-presets.ts          ← 新:预设模板常量数组
└── mcp-validate.ts         ← 新:纯函数,表单校验(好单测)
```

### 3.2 Tab 容器（`SkillsPage.tsx`）

- 用 `useState<'skills' | 'mcp' | 'plugins'>('skills')` 管理当前 Tab
- 用 `useLocalStorage('skills.activeTab', 'skills')` 记忆用户选择
- **URL 不带 Tab 参数**（与 `AgentsPage` / `Students` 等页面内 Tab 的惯例一致）
- 三个 Tab 按钮显示对应数量徽标：`技能(3)` / `MCP服务器(2)`
- Tab 切换时懒加载对应组件（避免一次性渲染全部）

### 3.3 SkillsTab.tsx

把原 `SkillsPage.tsx`（535 行）的技能列表 / 编辑器 / 新建 / 导入 / 删除逻辑**几乎原样搬过来**，只是从「页面」降级成「Tab 子组件」。改动点：

- 去掉外层 `<div className="page">` 包装，改 `<div className="tab-content">`
- props 透传 `onToast`（统一 Toast 出口）

### 3.4 共享类型扩展

文件：`src/shared/types/index.ts`

```ts
// 现有 McpServerStatus 加 source 字段
export interface McpServerStatus {
  id: string
  name: string
  connected: boolean
  toolCount: number
  lastError?: string
  transport: McpTransport
  source: 'global' | 'user'   // ← 新增
  enabled: boolean             // ← 新增(原来靠 config 过滤,现在透传给前端显示开关)
}
```

`McpServerConfig` 已含 `enabled: boolean` 必填字段，**不变**。但需要新增可选 `overrides?: 'global'` 字段用于覆盖语义（见 §2.2），加载时据此判断 remove 是「删除用户级」还是「恢复全局默认」。

## 4. MCP Tab 详细交互

### 4.1 布局

左右分栏（与原 Skills 页面一致，复用样式）：

```
MCP Tab
┌─服务器列表────┐ ┌─详情面板──────────────────────┐
│● filesystem   │ │ 本地文件系统          [全局]  │
│  stdio · 5工具│ │ id: filesystem                │
│○ web-search   │ │ 传输: stdio                   │
│  sse · 未连接 │ │ 命令: npx -y ...filesystem    │
│ + 添加服务器  │ │ 状态: ●已连接 (5 个工具)      │
│ ⚡ 从模板添加 │ │ ├─工具列表(可展开)            │
│               │ │ │  read_file(path)            │
│               │ │ │  write_file(path, content)  │
│               │ │ ├─操作──────────────────      │
│               │ │ │ [测试][断开][编辑][删除]    │
└───────────────┘ └───────────────────────────────┘
```

### 4.2 操作 → IPC 映射

| 用户操作 | 调用 | 后端方法 | 状态 |
|---|---|---|---|
| 进入 Tab / 刷新 | `mcp.list()` | `listServers()` | 已有 |
| 点「测试连接」 | `mcp.test(id)` | `testServer()` | 已有 |
| 点「连接」/「断开」 | `mcp.connect(id)` / `mcp.disconnect(id)` | 已有 | 已有 |
| 展开「工具列表」 | `mcp.listTools(id)`（懒加载，连上才能拉） | `listTools()` | 已有 |
| 点「+ 添加服务器」 | 弹 `McpServerForm` → `mcp.add(config)` | `addServer()` | **新增** |
| 点「编辑」 | 弹 `McpServerForm`（预填）→ `mcp.update(id, patch)` | `updateServer()` | **新增** |
| 点「删除」 | `ConfirmDialog` → `mcp.remove(id)` | `removeServer()` | **新增** |
| 点「⚡从模板添加」 | 弹 `PresetTemplates` → 选模板填表单 → `mcp.add` | `addServer()` | 复用新增 |
| 改「启用」开关 | `mcp.update(id, { enabled: !cur })` | `updateServer()` | **新增** |

### 4.3 状态轮询

Tab 激活时每 5s 调一次 `mcp.list()` 刷新连接状态点和工具数。复用现有 `useInterval` hook。Tab 失焦时停止轮询（避免无谓 IPC）。

### 4.4 错误处理

- 所有 IPC 调用失败时 Toast 提示错误信息（`toastStore.push`）
- 「测试连接」失败时详情面板显示红色状态 + 错误详情
- `lastError` 字段透传到卡片显示

## 5. 预设模板（一键添加）

文件：`src/renderer/pages/Skills/mcp-presets.ts`

```ts
export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'filesystem',
    name: '本地文件系统',
    description: '让 Agent 读写本地文档目录',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '${USER_DOCS}'],
    env: { USER_DOCS: '${env.USERPROFILE}/Documents' },
  },
  {
    id: 'web-search',
    name: '网页搜索',
    description: '让 Agent 搜索互联网（需要 API key）',
    transport: 'sse',
    url: 'https://mcpsearch.example.com/sse',
    headers: { Authorization: 'Bearer ${MCP_SEARCH_KEY}' },
  },
  {
    id: 'sqlite',
    name: 'SQLite 数据库',
    description: '查询本地 SQLite 数据库',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', '${USER_DATA}/app.db'],
  },
]
```

点模板 → 把模板字段填入 `McpServerForm`（用户可再改）→ 提交走标准 `mcp.add`。模板是种子数据，不锁定。

## 6. i18n / 测试 / 扩展位

### 6.1 i18n

文件：`src/renderer/i18n/zh.json` + `en.json`

新增 key（约 25 个），命名空间 `page.skills.*`：

- `page.skills.tab.skills` / `tab.mcp` / `tab.plugins`
- `page.skills.mcp.title` / `add` / `edit` / `delete` / `test` / `connect` / `disconnect`
- `page.skills.mcp.status.connected` / `disconnected` / `testing` / `error`
- `page.skills.mcp.field.id` / `name` / `transport` / `command` / `url` / `args` / `env` / `enabled`
- `page.skills.mcp.preset.title`
- `page.skills.mcp.toast.added` / `updated` / `removed` / `test_ok` / `test_fail`
- `page.skills.plugins.placeholder`

### 6.2 测试（沿用项目纯函数优先惯例）

**后端**（`tests/main/mcp-service-crud.test.ts` 新建，仿 `tests/main/mcp-tools.test.ts` 的 `vi.mock` 风格）：

- `addServer` 写入 `mcp.user.yaml` + 合并到 `this.config`
- `addServer` 拒绝重复 id（全局已有 / 用户已有）
- `updateServer` 改用户级条目
- `updateServer` 改全局项时走「复制覆盖」分支
- `removeServer` 删用户级 + 断开连接
- `removeServer` 删覆盖产生的用户级时恢复全局默认
- `removeServer` 拒绝删纯全局项（throw）
- `loadConfig` 合并：用户级覆盖全局同 id
- 新增 `validateCommandSafe`（shell 元字符白名单）纯函数单测，放 `tests/main/mcp-helpers.test.ts` 扩展

**前端**（`tests/renderer/lib/mcp-validate.test.ts` 新建，仿 `tests/renderer/lib/ui-utils.test.ts` 风格）：

- `mcp-validate.ts` 的 `validateMcpConfig(config): errors` 纯函数单测（必填校验、transport 对应字段校验、id 格式校验）
- 组件本身不测（项目惯例）

目标：新增代码函数覆盖 ≥ 85%（对齐项目现有 87.6%）。

### 6.3 扩展位（本次不实现，结构留好）

- 第三个 Tab「插件」：`PluginsTab.tsx` 只渲染 `<EmptyState title="插件" desc="未来支持本地脚本/函数插件扩展" />`
- `McpServerForm` 的 `transport` 下拉未来可加新传输方式（不改表单结构）
- `MCP_PRESETS` 抽成独立文件，未来可从远端拉
- `McpServerConfig` 已预留 `headers` 字段，未来鉴权不用改类型

## 7. 不做的事（YAGNI）

明确排除，避免范围蔓延：

- ❌ 不做 MCP 工具的实际调用 UI（工具调用由 Agent 运行时触发，`mcp-tools.ts` 已处理）
- ❌ 不做「插件」Tab 的实际功能（只占位）
- ❌ 不做技能级 `mcpServers` 的 frontmatter 可视化编辑（`Skill.mcpServers` 字段已存在，但本次不动 SkillsTab）
- ~~❌ 不做 Agent 级 `mcpServers` 启用 UI（`AgentConfig.mcpServers` 字段已存在，本次不动 AgentsPage）~~ **R6 已撤销**:AgentsPage ConfigTab 加了多选 UI(`src/renderer/pages/Agents/AgentsPage.tsx` + `agent-service.updateAgent` 接受 mcpServers,持久化到 `agents.user.yaml`)
- ❌ 不做 Tab 入 URL（保持与其他页面 Tab 惯例一致）
- ❌ 不做配置导入导出（YAGNI，等用户提出）
- ❌ 不做 MCP server 市场/远程拉取（YAGNI）

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| `mcp.user.yaml` 半写损坏 | 原子写（`.tmp` + rename）|
| shell 命令注入 | `command` 字段白名单校验 + 工具调用时 `sanitizeArg` 已有 |
| 用户改了 server 配置但旧连接没断 | `updateServer` 检测到在连时先 `disconnectServer` 再合并 |
| 全局 server 被误删 | 全局项不可删除（§2.2 覆盖语义：remove 只作用于用户级条目，对全局项 throw）；前端对 `source==='global'` 禁用删除按钮 |
| 全局 server 配置文件被污染 | 全局 `mcp.yaml` 永不写入；用户改动通过「复制+覆盖」落到 `mcp.user.yaml` |
| sidecar 模式 IPC 路由 | `sidecar-entry.ts` 已自动复用 `registerMcpHandlers`，新 IPC 自动生效 |
| Tab 切换丢失技能编辑器草稿 | SkillsTab 用 `useState` 保持挂载（不 unmount），或用 `display:none` 切换 |

## 9. 落地顺序建议（给实施计划用）

1. **后端先行**：类型扩展 → `mcp-service` 三方法 → `mcp-handlers` 三 IPC → 全链路 6 处 → 后端单测
2. **前端骨架**：`SkillsPage` 拆 Tab → `SkillsTab` 搬迁 → `McpTab` 空壳 → `PluginsTab` 占位
3. **MCP Tab 功能**：`McpServerCard` → `McpServerForm` → `PresetTemplates` → 状态轮询 → 错误处理
4. **收尾**：i18n → 前端纯函数单测 → 手测走查 → 文档更新

## 10. 涉及文件清单（实施时核对）

**新增（10 个）**：
- `src/renderer/pages/Skills/tabs/SkillsTab.tsx`
- `src/renderer/pages/Skills/tabs/McpTab.tsx`
- `src/renderer/pages/Skills/tabs/PluginsTab.tsx`
- `src/renderer/pages/Skills/components/McpServerCard.tsx`
- `src/renderer/pages/Skills/components/McpServerForm.tsx`
- `src/renderer/pages/Skills/components/PresetTemplates.tsx`
- `src/renderer/pages/Skills/mcp-presets.ts`
- `src/renderer/pages/Skills/mcp-validate.ts`
- `tests/main/mcp-service-crud.test.ts`
- `tests/renderer/lib/mcp-validate.test.ts`

**改动（9 个）**：
- `src/main/services/mcp-service.ts`（+3 方法 + loadConfig 合并）
- `src/main/services/mcp-helpers.ts`（+ `validateCommandSafe`）
- `src/main/ipc/mcp-handlers.ts`（+3 IPC）
- `src/shared/ipc-channels.ts`（+3 常量）
- `src/shared/types/index.ts`（`McpServerStatus` +2 字段）
- `src/renderer/lib/ipc-client.ts`（`mcp.*` +3 方法签名）
- `src/renderer/lib/tauri-bridge.ts`（+3 桥接）
- `src/renderer/pages/Skills/SkillsPage.tsx`（瘦身成 Tab 容器）
- `src/renderer/i18n/zh.json` + `en.json`（+25 key）

**复用（不改）**：导航项、路由、`skill-handlers.ts`、`skill-service.ts`、所有技能相关代码、Toast/ConfirmDialog/EmptyState/useInterval。
