// tauri-bridge 单元测试 — 验证 window.api 桥的每个方法都正确映射到 invoke
// 用 mock 拦截 @tauri-apps/api/core 的 invoke 和 event 的 listen
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @tauri-apps/api/core 和 event
const mockInvoke = vi.fn()
const mockListen = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
  unlisten: vi.fn(),
}))

describe('tauri-bridge', () => {
  let api: Record<string, Record<string, (...args: unknown[]) => unknown>>

  beforeEach(async () => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue({ success: true })
    mockListen.mockResolvedValue(() => {})
    // 动态导入 (因为 main.tsx 里有 top-level await, 不能直接 import)
    const mod = await import('../../../src/renderer/lib/tauri-bridge')
    api = mod.installTauriBridge() as never
  })

  it('ai 命名空间方法应调用 invoke', async () => {
    await api.ai.listProviders()
    expect(mockInvoke).toHaveBeenCalledWith('ipc_invoke', {
      channel: 'ai:list-providers',
      args: [],
    })
  })

  it('ai.listModels 应传 providerId', async () => {
    await api.ai.listModels('openai')
    expect(mockInvoke).toHaveBeenCalledWith('ipc_invoke', {
      channel: 'ai:list-models',
      args: ['openai'],
    })
  })

  it('eaa.addStudent 应传 name', async () => {
    await api.eaa.addStudent('张三')
    expect(mockInvoke).toHaveBeenCalledWith('ipc_invoke', {
      channel: 'eaa:add-student',
      args: ['张三'],
    })
  })

  it('eaa.addEvent 应传 params 对象', async () => {
    const params = { studentName: '张三', reasonCode: 'LATE' }
    await api.eaa.addEvent(params)
    expect(mockInvoke).toHaveBeenCalledWith('ipc_invoke', {
      channel: 'eaa:add-event',
      args: [params],
    })
  })

  it('eaa.deleteStudent 应附带 confirm 标志', async () => {
    await api.eaa.deleteStudent('张三', '测试')
    expect(mockInvoke).toHaveBeenCalledWith('ipc_invoke', {
      channel: 'eaa:delete-student',
      args: ['张三', { confirm: true, reason: '测试' }],
    })
  })

  it('agent.toggle 应传 id + enabled', async () => {
    await api.agent.toggle('class-monitor', true)
    expect(mockInvoke).toHaveBeenCalledWith('ipc_invoke', {
      channel: 'agent:toggle',
      args: ['class-monitor', true],
    })
  })

  it('settings.set 应传 path + value', async () => {
    await api.settings.set('general.theme', 'dark')
    expect(mockInvoke).toHaveBeenCalledWith('ipc_invoke', {
      channel: 'settings:set',
      args: ['general.theme', 'dark'],
    })
  })

  it('class.create 应传 params', async () => {
    const params = { class_id: 'G7A', name: '初一A班' }
    await api.class.create(params)
    expect(mockInvoke).toHaveBeenCalledWith('ipc_invoke', {
      channel: 'class:create',
      args: [params],
    })
  })

  it('cron.add 应传 task', async () => {
    const task = { name: 't', expression: '0 9 * * *' }
    await api.cron.add(task)
    expect(mockInvoke).toHaveBeenCalledWith('ipc_invoke', {
      channel: 'cron:add',
      args: [task],
    })
  })

  it('privacy.init 应传 password', async () => {
    await api.privacy.init('pass123')
    expect(mockInvoke).toHaveBeenCalledWith('ipc_invoke', {
      channel: 'privacy:init',
      args: ['pass123', undefined],
    })
  })

  it('ai.onStream 应订阅 listen 并返回取消函数', async () => {
    const cb = vi.fn()
    const unsub = api.ai.onStream(cb)
    expect(mockListen).toHaveBeenCalled()
    expect(typeof unsub).toBe('function')
    unsub()
  })

  it('feishu.onBotStatusUpdate 应订阅 listen', async () => {
    const cb = vi.fn()
    const unsub = api.feishu.onBotStatusUpdate(cb)
    expect(mockListen).toHaveBeenCalled()
    expect(typeof unsub).toBe('function')
  })

  it('sys.getPath 应传路径名', async () => {
    await api.sys.getPath('userData')
    expect(mockInvoke).toHaveBeenCalledWith('ipc_invoke', {
      channel: 'sys:get-path',
      args: ['userData'],
    })
  })

  it('chat.saveMessage 应传 msg 对象', async () => {
    const msg = { role: 'user', content: 'hi', timestamp: 123 }
    await api.chat.saveMessage(msg)
    expect(mockInvoke).toHaveBeenCalledWith('ipc_invoke', {
      channel: 'chat:save-message',
      args: [msg],
    })
  })

  it('所有命名空间都存在', () => {
    const namespaces = ['ai', 'ollama', 'agent', 'eaa', 'privacy', 'cron', 'skill', 'settings', 'sys', 'profile', 'class', 'chat', 'log', 'feishu']
    for (const ns of namespaces) {
      expect(api[ns]).toBeDefined()
      expect(typeof api[ns]).toBe('object')
    }
  })
})
