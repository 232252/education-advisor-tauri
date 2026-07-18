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
    // R4-2: 返回 i18n key 而非硬编码中文
    expect(errors.id).toBe('page.mcp.validation.idRequired')
  })

  it('id 含非法字符报错', () => {
    const errors = validateMcpConfig({
      id: 'test; rm',
      name: '测试',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
    })
    expect(errors.id).toBe('page.mcp.validation.idFormat')
  })

  it('id 超长报错', () => {
    const errors = validateMcpConfig({
      id: 'a'.repeat(129),
      name: '测试',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
    })
    expect(errors.id).toBe('page.mcp.validation.idTooLong')
  })

  it('name 为空报错', () => {
    const errors = validateMcpConfig({
      id: 'test',
      name: '',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
    })
    expect(errors.name).toBe('page.mcp.validation.nameRequired')
  })

  it('stdio 缺 command 报错', () => {
    const errors = validateMcpConfig({
      id: 'test',
      name: '测试',
      enabled: true,
      transport: 'stdio',
    })
    expect(errors.command).toBe('page.mcp.validation.commandRequired')
  })

  it('sse 缺 url 报错', () => {
    const errors = validateMcpConfig({
      id: 'test',
      name: '测试',
      enabled: true,
      transport: 'sse',
    })
    expect(errors.url).toBe('page.mcp.validation.urlRequired')
  })

  it('url 格式非法报错', () => {
    const errors = validateMcpConfig({
      id: 'test',
      name: '测试',
      enabled: true,
      transport: 'sse',
      url: 'not-a-url',
    })
    expect(errors.url).toBe('page.mcp.validation.urlFormat')
  })

  it('command 含 shell 元字符报错', () => {
    const errors = validateMcpConfig({
      id: 'test',
      name: '测试',
      enabled: true,
      transport: 'stdio',
      command: 'npx && rm -rf /',
    })
    expect(errors.command).toBe('page.mcp.validation.commandShellChars')
  })
})
