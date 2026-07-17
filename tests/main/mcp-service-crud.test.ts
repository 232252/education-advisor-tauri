// =============================================================
// McpService CRUD 测试 — addServer/updateServer/removeServer + 覆盖语义
// 模式:mock electron app.getPath 用 tmpdir 隔离,真实读写 yaml 文件
// =============================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 用 tmpdir 隔离每次测试的 userData
// 注意:McpService 是单例,构造函数在模块加载时立即调用 app.getPath('userData'),
// 因此 tmpDir 必须在 import 之前就有合法初值,否则 path.join(undefined) 会抛错。
let tmpDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-seed-'))

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
