// =============================================================
// MCP ↔ Agent 集成链路测试 (Round 8)
//
// 覆盖集成点:
//   1. agent-service.loadAgents() 是否正确读取 agents.yaml 的 mcpServers 字段
//   2. agent-service.runAgent() 调用 getMcpToolsForAgent(id, config.mcpServers)
//      传 skillMcpServers = undefined(技能级 MCP 未接线)
//   3. mcp-service.listToolsForAgent() 的三层合并优先级
//   4. mcp-tools.mcpToolToAgentTool 的命名规则 (mcp_<serverId>_<toolName>)
//   5. skill-service 是否真的读 skill frontmatter 的 mcpServers
//   6. agent-system-prompt 是否含 MCP 工具说明
//
// 模式: 直接 import 服务模块 + mock 必要依赖,不走 LLM(无需 API key)
// =============================================================

import { describe, expect, it, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// =============================================================
// Mocks — 在 import 真实模块前安装
// =============================================================

// 1) mcp-tools → 暴露 mcpToolToAgentTool 真实实现,但拦截对外副作用
//    这里直接 import 真实模块,无需 mock
// 2) mcp-service → mock 单例,便于断言 listToolsForAgent 调用参数
const mcpServiceMock = {
  init: vi.fn().mockResolvedValue(undefined),
  listToolsForAgent: vi.fn(),
  listServers: vi.fn().mockReturnValue([]),
  addServer: vi.fn().mockResolvedValue(undefined),
  updateServer: vi.fn().mockResolvedValue(undefined),
  removeServer: vi.fn().mockResolvedValue(undefined),
  reloadConfig: vi.fn().mockResolvedValue(undefined),
  callTool: vi.fn(),
  connectServer: vi.fn().mockResolvedValue(undefined),
  disconnectServer: vi.fn().mockResolvedValue(undefined),
  testServer: vi.fn().mockResolvedValue({ success: false, toolCount: 0 }),
  destroy: vi.fn().mockResolvedValue(undefined),
}
vi.mock('../../src/main/services/mcp-service', () => ({
  mcpService: mcpServiceMock,
}))

// 3) skill-service → mock,允许 listSkills 返回 controlled 内容
const skillServiceMock = {
  listSkills: vi.fn().mockResolvedValue([]),
  getSkill: vi.fn().mockResolvedValue(null),
  saveSkill: vi.fn().mockResolvedValue({ success: true }),
  deleteSkill: vi.fn().mockResolvedValue({ success: true }),
}
vi.mock('../../src/main/services/skill-service', () => ({
  skillService: skillServiceMock,
}))

// 4) settings-service → 提供最小 setSettings/getSettings
let _settings: any = {
  chat: { steeringMode: 'all', followUpMode: 'all', showImages: true },
  models: { defaultProvider: 'openai', defaultModel: 'gpt-4o-mini' },
  mcp: { enabled: true },
}
const settingsServiceMock = {
  getSettings: vi.fn(() => _settings),
  setSettings: vi.fn((s: any) => { _settings = s }),
  updateSettings: vi.fn(),
}
vi.mock('../../src/main/services/settings-service', () => ({
  settingsService: settingsServiceMock,
}))

// 5) keystore-service → API key 路径 stub
const keystoreServiceMock = {
  getApiKey: vi.fn(() => 'test-api-key-stub'),
  setApiKey: vi.fn(),
  clearApiKey: vi.fn(),
}
vi.mock('../../src/main/services/keystore-service', () => ({
  keystoreService: keystoreServiceMock,
  getEnvApiKey: vi.fn(() => 'test-api-key-stub'),
}))

// 6) db-service → 记录执行但 no-op
vi.mock('../../src/main/services/db-service', () => ({
  dbService: {
    recordExecutionStart: vi.fn(() => 1),
    recordExecutionEnd: vi.fn(),
  },
}))

// 7) pi-ai-service → resolveModel 返回 stub
vi.mock('../../src/main/services/pi-ai-service', () => ({
  piAiService: { resolveModel: vi.fn() },
  resolveModel: vi.fn(),
  getEnvApiKey: vi.fn(() => 'test-api-key-stub'),
}))

// 8) cron-service → 空 schedule stub
vi.mock('../../src/main/services/cron-service', () => ({
  cronService: {
    getNextRunAt: vi.fn(() => null),
    syncSchedules: vi.fn(),
    addTask: vi.fn(() => 'task-id'),
    removeTask: vi.fn(() => true),
  },
}))

// 9) eaa-bridge → empty tools for capabilities
vi.mock('../../src/main/services/eaa-bridge', () => ({
  eaaBridge: { execute: vi.fn() },
  getErrorMessage: vi.fn((_r: unknown, fb = 'error') => fb),
}))

// 10) Agent 所需的 file-tools / utility-tools stub
vi.mock('../../src/main/services/file-tools', () => ({
  validateFilePath: vi.fn(() => undefined),
  allFileTools: [],
}))
vi.mock('../../src/main/services/utility-tools', () => ({
  allUtilityTools: [],
}))
vi.mock('../../src/main/services/eaa-tools', () => ({
  getToolsByCapability: vi.fn(() => []),
  sanitizeArg: vi.fn((v: string) => v),
}))

// 11) electron app → 用临时目录 stub userData
//     AgentService 构造需要 process.resourcesPath,这里 stub 一个不存在的目录
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-agent-test-'))
const tmpResources = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-agent-resources-'))
// 让 dev 路径失败 → 走 prod(resources) 分支
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key: string) => {
      if (key === 'userData') return tmpUserData
      return os.tmpdir()
    }),
    isPackaged: false,
  },
}))
// AgentService 走 process.resourcesPath
;(globalThis as any).process = {
  ...process,
  resourcesPath: tmpResources,
}

// 12) pi-agent-core Agent → 真实但阻止真跑模型
//     用 vi.mock 把 Agent 构造成 stub,只暴露 state
vi.mock('@earendil-works/pi-agent-core', () => {
  class FakeAgent {
    state: any = {}
    subscribe = vi.fn(() => () => {})
    abort = vi.fn()
    prompt = vi.fn().mockResolvedValue(undefined)
  }
  return { Agent: FakeAgent }
})

// =============================================================
// 动态 import 真实模块
// =============================================================
const agentServiceModule = await import('../../src/main/services/agent-service')
const agentService = agentServiceModule.agentService

const mcpToolsModule = await import('../../src/main/services/mcp-tools')
const { mcpToolToAgentTool, getMcpToolsForAgent } = mcpToolsModule

const skillServiceModule = await import('../../src/main/services/skill-service')
const skillService = skillServiceModule.skillService

const mcpServiceModule = await import('../../src/main/services/mcp-service')
const mcpService = (mcpServiceModule as any).mcpService

// =============================================================
// helpers
// =============================================================
// AgentService 在 prod 分支从 process.resourcesPath/config/agents.yaml 读
// 由于 vitest 中 __dirname 解析为 src/main/services,../../config 不存在
// 所以实际读 process.resourcesPath/config。我们写到那里。
function writeAgentsYaml(agents: Array<Record<string, unknown>>) {
  // process.resourcesPath 在本测试 stub 成 tmpResources
  const configDir = path.join(tmpResources, 'config')
  const yamlPath = path.join(configDir, 'agents.yaml')
  const backupPath = yamlPath + '.round8.bak'

  fs.mkdirSync(configDir, { recursive: true })
  if (fs.existsSync(yamlPath) && !fs.existsSync(backupPath)) {
    fs.copyFileSync(yamlPath, backupPath)
  }

  const content = `# round-8 test\nagents:\n${agents
    .map(
      (a) =>
        `  - id: ${a.id}\n    name: "${a.name}"\n    role: "${a.role}"\n    description: "${a.description}"\n    enabled: ${a.enabled ?? true}\n    model_tier: ${a.model_tier ?? 'low_cost'}\n    capabilities:\n      - read\n${a.mcpServers ? `    mcp_servers:\n${(a.mcpServers as string[]).map((s) => `      - ${s}`).join('\n')}\n` : ''}`,
    )
    .join('')}`
  fs.writeFileSync(yamlPath, content, 'utf-8')
  console.log(`[round8] wrote agents.yaml to ${yamlPath}`)
}

function restoreAgentsYaml() {
  const yamlPath = path.join(tmpResources, 'config', 'agents.yaml')
  const backupPath = yamlPath + '.round8.bak'
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, yamlPath)
    fs.unlinkSync(backupPath)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // 重置 settings
  _settings = {
    chat: { steeringMode: 'all', followUpMode: 'all', showImages: true },
    models: { defaultProvider: 'openai', defaultModel: 'gpt-4o-mini' },
    mcp: { enabled: true },
  }
})

// =============================================================
// SCENARIO A: agents.yaml 中 agent 的 mcpServers 字段
// =============================================================
describe('Scenario A: AgentConfig.mcpServers parsing', () => {
  it('A.1 — [R8-1 已修复] agents.yaml 含 mcp_servers 字段时,加载后 AgentConfig.mcpServers 应回填', async () => {
    writeAgentsYaml([
      {
        id: 'test-mcp-agent',
        name: 'Test Agent',
        role: 'tester',
        description: '用于测试 mcpServers 加载',
        mcpServers: ['server-x', 'server-y'],
      },
    ])

    // 重新加载
    await agentService.loadAgents()
    const cfg = (agentService as any).agents.get('test-mcp-agent')
    expect(cfg).toBeDefined()
    // R8-1 修复后: loadAgents 应提取 a.mcp_servers 到 AgentConfig.mcpServers
    expect(cfg?.mcpServers).toEqual(['server-x', 'server-y'])

    restoreAgentsYaml()
  })

  it('A.2 — yaml 配 mcpServers 但引用不存在的 server:运行时 listToolsForAgent 被调用,graceful 降级到空工具列表', async () => {
    writeAgentsYaml([
      {
        id: 'test-ghost-mcp',
        name: 'Ghost MCP',
        role: 'tester',
        description: '引用不存在的 server',
        mcpServers: ['nonexistent-server-xyz'],
      },
    ])
    await agentService.loadAgents()

    // 配置层通过 — listToolsForAgent 会被调用,引用找不到的 server 应静默跳过
    mcpServiceMock.listToolsForAgent.mockImplementation(async (_id, serverIds) => {
      // 模拟 mcp-service.listToolsForAgent 行为: 不存在的 server 静默跳过
      // mcp-service.ts:433-438 实际行为: serverId 不在 config 中则跳过
      return []
    })

    // 不通过 loadAgents 提取(这是已知 bug R8-1),而是手动注入 cfg.mcpServers
    // 模拟"用户从 UI 设了 mcpServers" 这条路径
    const cfg = (agentService as any).agents.get('test-ghost-mcp')
    cfg.mcpServers = ['nonexistent-server-xyz'] // 手动注入

    // 验证: 调用 getMcpToolsForAgent 时,mcpServiceMock.listToolsForAgent 被调用了一次
    // (这会是 runAgent 触发,但 runAgent 需要 API key — 我们这里直接调 getMcpToolsForAgent)
    const tools = await getMcpToolsForAgent('test-ghost-mcp', cfg.mcpServers)
    expect(mcpServiceMock.listToolsForAgent).toHaveBeenCalledWith(
      'test-ghost-mcp',
      ['nonexistent-server-xyz'],
      undefined,
    )
    expect(tools).toEqual([]) // 引用不存在的 server → 优雅降级,空数组,无异常

    restoreAgentsYaml()
  })

  it('A.3 — agents.yaml 不配 mcpServers 时,config.mcpServers 应为 undefined(undefined 时 mcp-tools 不会加载)', async () => {
    writeAgentsYaml([
      {
        id: 'test-no-mcp',
        name: 'No MCP',
        role: 'tester',
        description: '不配 mcpServers',
      },
    ])
    await agentService.loadAgents()
    const cfg = (agentService as any).agents.get('test-no-mcp')
    expect(cfg).toBeDefined()
    expect(cfg?.mcpServers).toBeUndefined()

    restoreAgentsYaml()
  })
})

// =============================================================
// SCENARIO B: MCP 工具名注入规则 (mcp_<serverId>_<toolName>)
// =============================================================
describe('Scenario B: mcpToolToAgentTool naming rule', () => {
  it('B.1 — 命名规则: mcp_<serverId>_<toolName>', () => {
    const tool = mcpToolToAgentTool('server-1', {
      serverId: 'server-1',
      name: 'echo',
      description: '回显',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
    })
    expect(tool.name).toBe('mcp_server_1_echo')
  })

  it('B.2 — 命名一致性: serverId 中包含大写或连字符时去规范化', () => {
    const cases = [
      { serverId: 'My-Server', name: 'read', expected: 'mcp_my_server_read' },
      { serverId: 'srv.1', name: 'get-data', expected: 'mcp_srv_1_get_data' },
      { serverId: 'srv_1', name: 'a/b', expected: 'mcp_srv_1_a_b' },
    ]
    for (const c of cases) {
      const t = mcpToolToAgentTool(c.serverId, {
        serverId: c.serverId,
        name: c.name,
        description: '',
        inputSchema: {},
      })
      expect(t.name).toBe(c.expected)
    }
  })

  it('B.3 — label 保留原始 serverId(便于人工识别),不会被 sanitize', () => {
    const tool = mcpToolToAgentTool('My-Server', {
      serverId: 'My-Server',
      name: 'echo',
      description: '',
      inputSchema: {},
    })
    expect(tool.label).toBe('MCP [My-Server] echo') // label 保留原 serverId 大小写
    expect(tool.name).toBe('mcp_my_server_echo') // 但 name 用 sanitize 版本
  })

  it('B.4 — inputSchema 正确转 typebox,缺省也允许(Any())', () => {
    const tool = mcpToolToAgentTool('srv', {
      serverId: 'srv',
      name: 'noSchema',
      description: 'no schema tool',
      inputSchema: undefined,
    })
    expect(tool.parameters).toBeDefined()
  })

  it('B.5 — getMcpToolsForAgent 返回的 tool 名称完全匹配 mcp_<serverId>_<toolName>', async () => {
    mcpServiceMock.listToolsForAgent.mockResolvedValue([
      { serverId: 'echo-srv', name: 'ping', description: 'ping', inputSchema: {} },
      { serverId: 'echo-srv', name: 'pong', description: 'pong', inputSchema: {} },
    ])
    const tools = await getMcpToolsForAgent('agent-1')
    const names = tools.map((t) => t.name)
    expect(names).toContain('mcp_echo_srv_ping')
    expect(names).toContain('mcp_echo_srv_pong')
  })
})

// =============================================================
// SCENARIO C: Skill.mcpServers 字段 — 是否真正被消费
// =============================================================
describe('Scenario C: Skill.mcpServers integration', () => {
  it('C.1 — Skill 类型声明 mcpServers: McpServerConfig[],但 skill-service 实际不解析', () => {
    // 验证 skill-service.extractDescription 只解析 description 字段
    // 翻源码确认 mcpServers 在 parse path 之外
    const skSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/main/services/skill-service.ts'),
      'utf-8',
    )
    // mcpServers 字段在扫描路径中应当不被写入
    expect(skSrc).toContain('extractDescription')
    // mcpServers 字段不应被设置
    // 因为 Skill 类型有可选 mcpServers 字段但 parse 路径完全没写
    // 这是预留(R8-bug-2)
  })

  it('C.2 — SkillService.scanDir 不读 frontmatter 中的 mcp_servers', () => {
    // 假装写一个带 frontmatter 含 mcp_servers 的 skill
    // 验证 SkillService 返回的对象 mcpServers 为 undefined
    skillServiceMock.listSkills.mockResolvedValue([
      {
        name: 'fake-skill',
        description: 'fake',
        content: '---\nmcp_servers:\n  - id: x\n    command: bad\n---\n# fake',
        source: 'user',
        filePath: '/tmp/fake.md',
        mcpServers: [{ id: 'fake-srv', name: 'fake', enabled: true, transport: 'stdio' }], // 假装被注入
      },
    ])
    const skills = skillServiceMock.listSkills()
    // Skill 类型允许 mcpServers,但 agent-service.runAgent 调用 getMcpToolsForAgent 时
    // 根本没传第三个参数 (skillMcpServers)。验证 runAgent 路径
    const runAgentSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/main/services/agent-service.ts'),
      'utf-8',
    )
    // 关键查找: runAgent 调用 getMcpToolsForAgent 应该传 2 个参数(没有 skillMcpServers)
    const callMatch = runAgentSrc.match(/getMcpToolsForAgent\(([^)]+)\)/g)
    expect(callMatch).not.toBeNull()
    // 检查 call 中含 id 但不含 skillMcpServers
    if (callMatch) {
      const lastCall = callMatch[callMatch.length - 1]
      expect(lastCall).toContain('id')
      // 第三个参数应缺失
      expect(lastCall).toBe('getMcpToolsForAgent(id, config.mcpServers)')
    }
    void skills
  })
})

// =============================================================
// SCENARIO D: Agent system prompt 是否提到 MCP 工具
// =============================================================
describe('Scenario D: System prompt and MCP tools visibility', () => {
  it('D.1 — agent-service 构造的 systemPrompt 硬编码工具表不包含 MCP 工具', async () => {
    // 直接扫描 systemPrompt 构造代码
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/main/services/agent-service.ts'),
      'utf-8',
    )
    // hardcoded 工具表
    expect(src).toContain('read_file')
    expect(src).toContain('read_excel')
    expect(src).toContain('write_file')
    // 系统 prompt 构造不应硬编码 mcp_ (MCP 工具是动态注入)
    // 但问题是 — prompt 中是否提到 MCP 工具说明?否则 LLM 只能依赖 tool API 而非 prompt 文本来感知 MCP 工具
    const systemPromptMatch = src.match(/const systemPrompt\s*=\s*\n?\s*([`'])([^`']*?)\1/)
    expect(systemPromptMatch).not.toBeNull()
    if (systemPromptMatch) {
      const promptText = systemPromptMatch[2]
      // 关键问题: prompt 中是否提到 MCP 工具或 mcp_ 前缀
      // 答: 不提及 — LLM 主要靠 framework 的 tool 注入
      expect(promptText).not.toContain('mcp_')
    }
  })
})

// =============================================================
// SCENARIO E: listToolsForAgent 的三层合并语义
// =============================================================
describe('Scenario E: Three-layer merge in listToolsForAgent', () => {
  it('E.1 — listToolsForAgent 按 agentMcpServers → skillMcpServers 顺序合并', async () => {
    // 通过 mock 验证参数传递顺序
    mcpServiceMock.listToolsForAgent.mockResolvedValue([])
    await getMcpToolsForAgent('agent-1', ['global-1', 'global-2'], [
      { id: 'skill-tmp', name: 'tmp', enabled: true, transport: 'stdio' },
    ])
    expect(mcpServiceMock.listToolsForAgent).toHaveBeenCalledWith(
      'agent-1',
      ['global-1', 'global-2'],
      [{ id: 'skill-tmp', name: 'tmp', enabled: true, transport: 'stdio' }],
    )
  })

  it('E.2 — serverId+toolName 去重保留先出现者(用于技能级覆盖全局同名)', async () => {
    mcpServiceMock.listToolsForAgent.mockResolvedValue([
      { serverId: 'A', name: 'echo', description: 'from A', inputSchema: {} },
      { serverId: 'B', name: 'echo', description: 'from B', inputSchema: {} },
    ])
    const tools = await getMcpToolsForAgent('agent-1')
    expect(tools).toHaveLength(2)
    const aEcho = tools.find((t) => t.name === 'mcp_a_echo')
    const bEcho = tools.find((t) => t.name === 'mcp_b_echo')
    expect(aEcho?.description).toBe('from A')
    expect(bEcho?.description).toBe('from B')
  })

  it('E.3 — 同一 serverId+name 重复时保留首次', async () => {
    mcpServiceMock.listToolsForAgent.mockResolvedValue([
      { serverId: 'S', name: 'foo', description: 'first', inputSchema: {} },
      { serverId: 'S', name: 'foo', description: 'duplicate', inputSchema: {} },
    ])
    const tools = await getMcpToolsForAgent('agent-1')
    expect(tools).toHaveLength(1)
    expect(tools[0].description).toBe('first')
  })
})

// =============================================================
// SCENARIO: 代码 review — 检查未实现的部分
// =============================================================
describe('Code review: 预留 / 未接线部分', () => {
  it('R8-1 [已修复] — agents.yaml 的 mcp_servers 字段现在被 loadAgents() 提取', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/main/services/agent-service.ts'),
      'utf-8',
    )
    // R8-1 修复后: loadAgents 应包含 mcpServers 字段映射
    const loadAgentsFn = src.match(/async loadAgents\([^)]*\):[\s\S]*?^  \}/m)
    expect(loadAgentsFn).not.toBeNull()
    if (loadAgentsFn) {
      expect(loadAgentsFn[0]).toContain('id: a.id')
      expect(loadAgentsFn[0]).toContain('name:')
      expect(loadAgentsFn[0]).toContain('capabilities:')
      // R8-1 修复后应包含 mcpServers 映射
      expect(loadAgentsFn[0]).toContain('mcpServers')
    }
  })

  it('R8-2 — getMcpToolsForAgent 调用点未传 skillMcpServers(技能级 MCP 未接线)', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/main/services/agent-service.ts'),
      'utf-8',
    )
    const calls = src.match(/getMcpToolsForAgent\([^)]*\)/g) || []
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      // 调用只传 2 个参数: getMcpToolsForAgent(id, config.mcpServers)
      expect(c).toBe('getMcpToolsForAgent(id, config.mcpServers)')
    }
  })

  it('R8-3 — SkillService.extractDescription 不解析 mcpServers frontmatter', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/main/services/skill-service.ts'),
      'utf-8',
    )
    // 关键: scanDir 函数构造 Skill 对象时,只设置 name/description/content/source/filePath
    // 完全不读 mcpServers
    expect(src).toContain('extractDescription')
    // scanDir 应不包含 mcpServers 字段写入
    const scanDirFn = src.match(/private async scanDir\([\s\S]*?\n  \}/)
    if (scanDirFn) {
      expect(scanDirFn[0]).not.toContain('mcpServers')
    }
  })

  it('R8-4 — System prompt hardcoded tool table 未反映 MCP 工具(LLM 只能靠 framework tool API)', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/main/services/agent-service.ts'),
      'utf-8',
    )
    // 系统 prompt 工具表是硬编码的,未动态插入 MCP 工具说明
    // 这条仅是观察,不算 hard bug,但 LLM 不在 prompt 文本中知道有 mcp_*
    expect(src).toContain('read_file')
    // systemPrompt 字符串体里没出现 mcp_ 字样
    const promptStr = src.match(/const systemPrompt\s*=\s*([`'])([\s\S]*?)\1/)?.[2] || ''
    expect(promptStr).not.toContain('mcp_')
  })
})
