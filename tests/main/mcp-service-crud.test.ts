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

  it('更新 server 的 enabled 开关', async () => {
    await mcpService.init()
    await mcpService.addServer({
      id: 'toggle',
      name: '开关测试',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
    })
    await mcpService.updateServer('toggle', { enabled: false })
    // update 直接改内存 config,不重新 load(否则 disabled 的会被过滤)
    // listServers 读的是内存 config,所以仍能看到该项
    const servers = mcpService.listServers()
    const found = servers.find((s) => s.id === 'toggle')
    expect(found).toBeDefined()
    expect(found?.enabled).toBe(false)
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

describe('McpService 并发安全 (M7 修复)', () => {
  it('并发 add 同一 id 应只成功1次', async () => {
    await mcpService.init()
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        mcpService
          .addServer({
            id: 'race-target',
            name: '竞态目标',
            enabled: true,
            transport: 'stdio',
            command: 'npx',
          })
          .then(
            () => 'success' as const,
            (e) => `error: ${(e as Error).message}` as const,
          ),
      ),
    )
    const successCount = results.filter((r) => r === 'success').length
    expect(successCount).toBe(1)
    // 内存里只有1条
    const servers = mcpService.listServers()
    const matches = servers.filter((s) => s.id === 'race-target')
    expect(matches).toHaveLength(1)
  })

  it('并发 add 不同 id 应全部成功', async () => {
    await mcpService.init()
    const ids = ['a', 'b', 'c', 'd', 'e']
    const results = await Promise.all(
      ids.map((id) =>
        mcpService
          .addServer({
            id,
            name: `server-${id}`,
            enabled: true,
            transport: 'stdio',
            command: 'npx',
          })
          .then(
            () => 'success' as const,
            () => 'error' as const,
          ),
      ),
    )
    expect(results.every((r) => r === 'success')).toBe(true)
    const servers = mcpService.listServers()
    for (const id of ids) {
      expect(servers.some((s) => s.id === id)).toBe(true)
    }
  })
})
