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
