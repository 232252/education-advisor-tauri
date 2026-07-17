// =============================================================
// MCP Tools 测试 — JSON Schema 转换 / 参数安全校验 / AgentTool 适配
// 覆盖：jsonSchemaToTypebox、sanitizeMcpArgs、mcpToolToAgentTool(execute)、getMcpToolsForAgent
// 模式：mock mcp-service（callTool/listToolsForAgent）+ mock file-tools（validateFilePath）
//      保留真实 sanitizeArg（纯函数）
// =============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  listToolsForAgent: vi.fn(),
  validateFilePath: vi.fn(),
}))

// mock mcp-service（mcp-tools 的主要依赖）
vi.mock('../../src/main/services/mcp-service', () => ({
  mcpService: {
    callTool: mocks.callTool,
    listToolsForAgent: mocks.listToolsForAgent,
  },
}))

// mock file-tools（validateFilePath 可能耦合 electron 路径）
vi.mock('../../src/main/services/file-tools', () => ({
  validateFilePath: mocks.validateFilePath,
}))

// mock eaa-bridge（eaa-tools 间接导入它，含 electron 依赖）
vi.mock('../../src/main/services/eaa-bridge', () => ({
  eaaBridge: { execute: vi.fn() },
  getErrorMessage: vi.fn((r: unknown, fb = 'error') => fb),
}))

const { jsonSchemaToTypebox, sanitizeMcpArgs, mcpToolToAgentTool, getMcpToolsForAgent } =
  await import('../../src/main/services/mcp-tools')

beforeEach(() => {
  vi.clearAllMocks()
})

// =============================================================
// jsonSchemaToTypebox
// =============================================================
describe('jsonSchemaToTypebox', () => {
  it('null/undefined/非对象 → Any（空对象，无 type 字段）', () => {
    expect(jsonSchemaToTypebox(null)).toEqual({})
    expect(jsonSchemaToTypebox(undefined)).toEqual({})
    expect(jsonSchemaToTypebox('x' as never)).toEqual({})
  })

  it('基础类型：string/number/integer/boolean/null', () => {
    expect(jsonSchemaToTypebox({ type: 'string' })).toMatchObject({ type: 'string' })
    expect(jsonSchemaToTypebox({ type: 'number' })).toMatchObject({ type: 'number' })
    expect(jsonSchemaToTypebox({ type: 'integer' })).toMatchObject({ type: 'integer' })
    expect(jsonSchemaToTypebox({ type: 'boolean' })).toMatchObject({ type: 'boolean' })
    expect(jsonSchemaToTypebox({ type: 'null' })).toMatchObject({ type: 'null' })
  })

  it('enum → Union（anyOf 形式）', () => {
    const result = jsonSchemaToTypebox({ enum: ['a', 'b'] })
    expect(result).toHaveProperty('anyOf')
  })

  it('anyOf / oneOf → Union（anyOf 形式）', () => {
    const anyOfResult = jsonSchemaToTypebox({ anyOf: [{ type: 'string' }, { type: 'number' }] })
    expect(anyOfResult).toHaveProperty('anyOf')
    expect(anyOfResult.anyOf).toHaveLength(2)
    const oneOfResult = jsonSchemaToTypebox({ oneOf: [{ type: 'string' }, { type: 'boolean' }] })
    expect(oneOfResult).toHaveProperty('anyOf')
  })

  it('空 anyOf/oneOf 不视为 Union（降级为 default → Any 空对象）', () => {
    expect(jsonSchemaToTypebox({ anyOf: [] })).toEqual({})
  })

  it('array → Array of items', () => {
    const result = jsonSchemaToTypebox({ type: 'array', items: { type: 'string' } })
    expect(result).toMatchObject({ type: 'array', items: { type: 'string' } })
  })

  it('object 含 properties + required', () => {
    const result = jsonSchemaToTypebox({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
      required: ['name'],
    })
    expect(result).toMatchObject({ type: 'object' })
    expect(result).toHaveProperty('properties')
  })

  it('object 无 properties → 空 properties', () => {
    const result = jsonSchemaToTypebox({ type: 'object' })
    expect(result).toMatchObject({ type: 'object' })
  })

  it('未知 type → Any（空对象）', () => {
    expect(jsonSchemaToTypebox({ type: 'unknown' })).toEqual({})
    expect(jsonSchemaToTypebox({})).toEqual({})
  })

  it('description 被保留', () => {
    const result = jsonSchemaToTypebox({ type: 'string', description: '姓名' }) as {
      description?: string
    }
    expect(result.description).toBe('姓名')
  })
})

// =============================================================
// sanitizeMcpArgs
// =============================================================
describe('sanitizeMcpArgs', () => {
  it('普通字符串参数通过校验', () => {
    const args = { name: '张三', age: 18 }
    expect(sanitizeMcpArgs('tool1', args)).toEqual({ name: '张三', age: 18 })
  })

  it('含控制字符的字符串被拒绝', () => {
    expect(() => sanitizeMcpArgs('tool1', { x: 'a\x01b' })).toThrow('校验失败')
  })

  it('含 shell 元字符的字符串被拒绝', () => {
    expect(() => sanitizeMcpArgs('tool1', { x: 'a;b' })).toThrow('校验失败')
  })

  it('以 -- 开头的字符串被拒绝', () => {
    expect(() => sanitizeMcpArgs('tool1', { x: '--inject' })).toThrow('校验失败')
  })

  it('路径参数（名含 path/file/dir）走 validateFilePath', () => {
    mocks.validateFilePath.mockImplementation(() => {})
    sanitizeMcpArgs('tool1', { filepath: '/safe/path' })
    expect(mocks.validateFilePath).toHaveBeenCalledWith('/safe/path')
  })

  it('路径参数 validateFilePath 失败时错误信息含工具名和参数名', () => {
    mocks.validateFilePath.mockImplementation(() => {
      throw new Error('path traversal')
    })
    expect(() => sanitizeMcpArgs('tool1', { filepath: '../etc' })).toThrow('tool1 参数 filepath')
  })

  it('嵌套对象递归校验', () => {
    expect(() => sanitizeMcpArgs('tool1', { nested: { x: 'a|b' } })).toThrow('tool1.nested')
  })

  it('数组中的字符串元素被校验', () => {
    expect(() => sanitizeMcpArgs('tool1', { list: ['ok', 'a;b'] })).toThrow('list[1]')
  })

  it('非字符串值（数字/布尔/null）不校验直接通过', () => {
    const args = { n: 123, b: true, nil: null }
    expect(sanitizeMcpArgs('tool1', args)).toEqual(args)
  })

  it('空对象返回空对象', () => {
    expect(sanitizeMcpArgs('tool1', {})).toEqual({})
  })
})

// =============================================================
// mcpToolToAgentTool
// =============================================================
describe('mcpToolToAgentTool', () => {
  const mockTool = {
    serverId: 'test-server',
    name: 'search',
    description: '搜索工具',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  }

  it('命名规则：mcp_<serverId>_<toolName> 全小写', () => {
    const tool = mcpToolToAgentTool('TestServer', {
      serverId: 'TestServer',
      name: 'My-Tool',
      description: '',
      inputSchema: {},
    })
    expect(tool.name).toBe('mcp_testserver_my_tool')
  })

  it('特殊字符替换为 _', () => {
    const tool = mcpToolToAgentTool('srv.1', {
      serverId: 'srv.1',
      name: 'tool-2',
      description: '',
      inputSchema: {},
    })
    expect(tool.name).toBe('mcp_srv_1_tool_2')
  })

  it('label 格式：MCP [serverId] toolName', () => {
    const tool = mcpToolToAgentTool('TestServer', mockTool)
    expect(tool.label).toBe('MCP [TestServer] search')
  })

  it('description 透传，无 description 时用默认文案', () => {
    const withDesc = mcpToolToAgentTool('srv', mockTool)
    expect(withDesc.description).toBe('搜索工具')

    const noDesc = mcpToolToAgentTool('srv', {
      serverId: 'srv',
      name: 'x',
      description: '',
      inputSchema: {},
    })
    expect(noDesc.description).toContain('srv')
    expect(noDesc.description).toContain('x')
  })

  it('parameters 由 JSON Schema 转换而来', () => {
    const tool = mcpToolToAgentTool('srv', mockTool)
    expect(tool.parameters).toBeDefined()
  })

  it('execute 成功路径：调用 callTool 并格式化结果', async () => {
    mocks.callTool.mockResolvedValue({
      content: [{ type: 'text', text: '搜索结果' }],
      isError: false,
    })
    const tool = mcpToolToAgentTool('test-server', mockTool)
    const result = await tool.execute('call-1', { query: 'hello' })
    expect(mocks.callTool).toHaveBeenCalledWith('test-server', 'search', { query: 'hello' })
    expect(result.content[0].text).toContain('✅')
    expect(result.content[0].text).toContain('搜索结果')
    expect(result.details).toEqual({ serverError: false })
  })

  it('execute 无 signal 时直接调 mcpService.callTool', async () => {
    mocks.callTool.mockResolvedValue({ content: [], isError: false })
    const tool = mcpToolToAgentTool('srv', mockTool)
    await tool.execute('c1', {})
    expect(mocks.callTool).toHaveBeenCalledOnce()
  })

  it('execute 结果 isError 时前缀 ⚠️ 且 serverError=true', async () => {
    mocks.callTool.mockResolvedValue({
      content: [{ type: 'text', text: '出错了' }],
      isError: true,
    })
    const tool = mcpToolToAgentTool('srv', mockTool)
    const result = await tool.execute('c1', {})
    expect(result.content[0].text).toContain('⚠️')
    expect(result.details.serverError).toBe(true)
  })

  it('execute 空响应显示 (空响应)', async () => {
    mocks.callTool.mockResolvedValue({ content: [], isError: false })
    const tool = mcpToolToAgentTool('srv', mockTool)
    const result = await tool.execute('c1', {})
    expect(result.content[0].text).toContain('(空响应)')
  })

  it('execute callTool 抛错且无 signal 时包装错误', async () => {
    mocks.callTool.mockRejectedValue(new Error('连接失败'))
    const tool = mcpToolToAgentTool('srv', mockTool)
    await expect(tool.execute('c1', {})).rejects.toThrow('调用失败')
  })

  it('execute callTool 抛错且 signal 已 abort 时报"被取消"', async () => {
    mocks.callTool.mockRejectedValue(new Error('timeout'))
    const ac = new AbortController()
    ac.abort()
    const tool = mcpToolToAgentTool('srv', mockTool)
    await expect(tool.execute('c1', {}, ac.signal)).rejects.toThrow('被取消')
  })

  it('execute 带 signal 正常完成', async () => {
    mocks.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], isError: false })
    const ac = new AbortController()
    const tool = mcpToolToAgentTool('srv', mockTool)
    const result = await tool.execute('c1', {}, ac.signal)
    expect(result.content[0].text).toContain('ok')
  })

  it('execute 参数含非法字符时先校验失败', async () => {
    const tool = mcpToolToAgentTool('srv', mockTool)
    await expect(tool.execute('c1', { query: 'a;b' })).rejects.toThrow('校验失败')
    expect(mocks.callTool).not.toHaveBeenCalled()
  })

  it('execute params 非对象时降级为空对象', async () => {
    mocks.callTool.mockResolvedValue({ content: [], isError: false })
    const tool = mcpToolToAgentTool('srv', mockTool)
    await tool.execute('c1', null as never)
    expect(mocks.callTool).toHaveBeenCalledWith('srv', 'search', {})
  })
})

// =============================================================
// getMcpToolsForAgent
// =============================================================
describe('getMcpToolsForAgent', () => {
  it('无 MCP 工具时返回空数组', async () => {
    mocks.listToolsForAgent.mockResolvedValue([])
    const result = await getMcpToolsForAgent('agent-1')
    expect(result).toEqual([])
  })

  it('适配 MCP 工具为 AgentTool', async () => {
    mocks.listToolsForAgent.mockResolvedValue([
      { serverId: 'srv1', name: 'tool-a', description: 'A', inputSchema: {} },
    ])
    const result = await getMcpToolsForAgent('agent-1')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('mcp_srv1_tool_a')
  })

  it('按 serverId+toolName 去重（保留第一个）', async () => {
    mocks.listToolsForAgent.mockResolvedValue([
      { serverId: 'srv1', name: 'dup', description: 'first', inputSchema: {} },
      { serverId: 'srv1', name: 'dup', description: 'second', inputSchema: {} },
      { serverId: 'srv2', name: 'dup', description: 'other-server', inputSchema: {} },
    ])
    const result = await getMcpToolsForAgent('agent-1')
    expect(result).toHaveLength(2) // srv1::dup 去重，srv2::dup 保留
    expect(result[0].description).toBe('first')
    expect(result[1].description).toBe('other-server')
  })

  it('listToolsForAgent 抛错时降级返回空数组（不抛出）', async () => {
    mocks.listToolsForAgent.mockRejectedValue(new Error('MCP 未启动'))
    const result = await getMcpToolsForAgent('agent-1')
    expect(result).toEqual([])
  })
})
