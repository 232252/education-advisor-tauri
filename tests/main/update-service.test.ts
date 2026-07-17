// =============================================================
// Update Service 测试 — 自动更新检查（GitHub Releases API）
// 覆盖：checkForUpdates（无repoUrl分支 + 有repoUrl成功/失败）、getLastCheck、
//       setRepoUrl、showUpdateDialog、compareSemver/sanitizeObject（黑盒间接）
// 模式：mock electron(app/dialog/shell) + mock settingsService + mock node:https
// =============================================================

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getVersion: vi.fn(() => '1.0.0'),
  showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
  openExternal: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() => ({})),
  httpsGet: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getVersion: mocks.getVersion },
  dialog: { showMessageBox: mocks.showMessageBox },
  shell: { openExternal: mocks.openExternal },
}))

vi.mock('../../src/main/services/settings-service', () => ({
  settingsService: { getSettings: mocks.getSettings },
}))

// mock node:https（fetchLatestRelease 用 https.get）
vi.mock('node:https', () => ({
  default: { get: mocks.httpsGet },
  get: mocks.httpsGet,
}))

const { updateService } = await import('../../src/main/services/update-service')

/** 构造一个模拟的 https response（EventEmitter 风格） */
function makeHttpsResponse(data: string, statusCode = 200) {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number
    setEncoding: (e: string) => void
    resume: () => void
    destroy: () => void
  }
  res.statusCode = statusCode
  res.setEncoding = vi.fn()
  res.resume = vi.fn()
  res.destroy = vi.fn()
  // 异步触发 data + end 事件
  queueMicrotask(() => {
    res.emit('data', data)
    res.emit('end')
  })
  return res
}

function makeReq() {
  const req = new EventEmitter() as EventEmitter & { destroy: () => void }
  req.destroy = vi.fn()
  return req
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getVersion.mockReturnValue('1.0.0')
  mocks.getSettings.mockReturnValue({})
  // reset updateService 内部状态
  updateService.setRepoUrl('')
})

afterEach(() => {
  vi.restoreAllMocks()
})

// =============================================================
// checkForUpdates — 无 repoUrl 分支
// =============================================================
describe('checkForUpdates — 无更新源', () => {
  it('未配置 updateUrl 时返回 enabled:false', async () => {
    const info = await updateService.checkForUpdates()
    expect(info.enabled).toBe(false)
    expect(info.hasUpdate).toBe(false)
    expect(info.message).toContain('未配置更新源')
  })

  it('settings 里配置了 updateUrl 但 setRepoUrl 未设置时也能读取', async () => {
    mocks.getSettings.mockReturnValue({ general: { updateUrl: 'https://github.com/a/b' } })
    mocks.httpsGet.mockImplementation((_url: string, _opts: unknown, cb: (r: unknown) => void) => {
      cb(makeHttpsResponse(JSON.stringify({ tag_name: 'v0.9.0', html_url: '', body: '', published_at: '' })))
      return makeReq()
    })
    const info = await updateService.checkForUpdates()
    expect(info.enabled).toBe(true)
    expect(info.latestVersion).toBe('0.9.0')
  })

  it('setRepoUrl 优先级高于 settings', async () => {
    mocks.getSettings.mockReturnValue({ general: { updateUrl: 'https://github.com/settings/value' } })
    updateService.setRepoUrl('https://github.com/owner/explicit')
    mocks.httpsGet.mockImplementation((_url: string, _opts: unknown, cb: (r: unknown) => void) => {
      cb(makeHttpsResponse(JSON.stringify({ tag_name: 'v2.0.0', html_url: '', body: '', published_at: '' })))
      return makeReq()
    })
    await updateService.checkForUpdates()
    expect(mocks.httpsGet.mock.calls[0][0]).toContain('owner/explicit')
  })

  it('返回当前版本/平台/架构信息', async () => {
    const info = await updateService.checkForUpdates()
    expect(info.currentVersion).toBe('1.0.0')
    expect(info.platform).toBe(process.platform)
    expect(info.arch).toBe(process.arch)
  })
})

// =============================================================
// checkForUpdates — 有 repoUrl 成功路径
// =============================================================
describe('checkForUpdates — 有更新源', () => {
  beforeEach(() => {
    updateService.setRepoUrl('https://github.com/owner/repo')
  })

  it('远端版本更高时 hasUpdate=true', async () => {
    mocks.httpsGet.mockImplementation((_url: string, _opts: unknown, cb: (r: unknown) => void) => {
      cb(makeHttpsResponse(JSON.stringify({
        tag_name: 'v2.0.0', html_url: 'https://release', body: '新功能', published_at: '2024-01-01',
      })))
      return makeReq()
    })
    const info = await updateService.checkForUpdates()
    expect(info.hasUpdate).toBe(true)
    expect(info.latestVersion).toBe('2.0.0')
    expect(info.releaseUrl).toBe('https://release')
    expect(info.message).toContain('发现新版本')
  })

  it('远端版本相同时 hasUpdate=false（已是最新）', async () => {
    mocks.getVersion.mockReturnValue('1.0.0')
    mocks.httpsGet.mockImplementation((_url: string, _opts: unknown, cb: (r: unknown) => void) => {
      cb(makeHttpsResponse(JSON.stringify({ tag_name: 'v1.0.0', html_url: '', body: '', published_at: '' })))
      return makeReq()
    })
    const info = await updateService.checkForUpdates()
    expect(info.hasUpdate).toBe(false)
    expect(info.message).toContain('已是最新版本')
  })

  it('releaseNotes 被截断到 500 字符', async () => {
    const longBody = 'x'.repeat(800)
    mocks.httpsGet.mockImplementation((_url: string, _opts: unknown, cb: (r: unknown) => void) => {
      cb(makeHttpsResponse(JSON.stringify({ tag_name: 'v2.0.0', html_url: '', body: longBody, published_at: '' })))
      return makeReq()
    })
    const info = await updateService.checkForUpdates()
    expect(info.releaseNotes.length).toBe(500)
  })

  it('v 前缀被剥离', async () => {
    mocks.httpsGet.mockImplementation((_url: string, _opts: unknown, cb: (r: unknown) => void) => {
      cb(makeHttpsResponse(JSON.stringify({ tag_name: 'v3.5.2', html_url: '', body: '', published_at: '' })))
      return makeReq()
    })
    const info = await updateService.checkForUpdates()
    expect(info.latestVersion).toBe('3.5.2')
  })

  it('compareSemver：pre-release 版本低于正式版（1.0.0-beta.1 < 1.0.0）', async () => {
    mocks.getVersion.mockReturnValue('1.0.0-beta.1')
    mocks.httpsGet.mockImplementation((_url: string, _opts: unknown, cb: (r: unknown) => void) => {
      cb(makeHttpsResponse(JSON.stringify({ tag_name: 'v1.0.0', html_url: '', body: '', published_at: '' })))
      return makeReq()
    })
    const info = await updateService.checkForUpdates()
    expect(info.hasUpdate).toBe(true)
  })
})

// =============================================================
// checkForUpdates — 失败路径
// =============================================================
describe('checkForUpdates — 错误处理', () => {
  beforeEach(() => {
    updateService.setRepoUrl('https://github.com/owner/repo')
  })

  it('GitHub API 返回非 200 时 message 含状态码', async () => {
    mocks.httpsGet.mockImplementation((_url: string, _opts: unknown, cb: (r: unknown) => void) => {
      cb(makeHttpsResponse('', 404))
      return makeReq()
    })
    const info = await updateService.checkForUpdates()
    expect(info.hasUpdate).toBe(false)
    expect(info.message).toContain('404')
    expect(info.enabled).toBe(true)
  })

  it('https 请求 error 事件时降级', async () => {
    mocks.httpsGet.mockImplementation(() => {
      const req = makeReq()
      queueMicrotask(() => req.emit('error', new Error('ENOTFOUND')))
      return req
    })
    const info = await updateService.checkForUpdates()
    expect(info.hasUpdate).toBe(false)
    expect(info.message).toContain('ENOTFOUND')
  })

  it('JSON 解析失败时降级', async () => {
    mocks.httpsGet.mockImplementation((_url: string, _opts: unknown, cb: (r: unknown) => void) => {
      cb(makeHttpsResponse('not json{'))
      return makeReq()
    })
    const info = await updateService.checkForUpdates()
    expect(info.hasUpdate).toBe(false)
    expect(info.message).toContain('检查更新失败')
  })

  it('sanitizeObject 防原型链污染：__proto__ 键被删除', async () => {
    const malicious = '{"tag_name":"v2.0.0","html_url":"","body":"","published_at":"","__proto__":{"polluted":true}}'
    mocks.httpsGet.mockImplementation((_url: string, _opts: unknown, cb: (r: unknown) => void) => {
      cb(makeHttpsResponse(malicious))
      return makeReq()
    })
    await updateService.checkForUpdates()
    // 全局对象不应被污染
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})

// =============================================================
// getLastCheck
// =============================================================
describe('getLastCheck', () => {
  it('checkForUpdates 后可获取上次结果', async () => {
    await updateService.checkForUpdates()
    expect(updateService.getLastCheck()).not.toBeNull()
    expect(updateService.getLastCheck()?.currentVersion).toBe('1.0.0')
  })
})

// =============================================================
// showUpdateDialog
// =============================================================
describe('showUpdateDialog', () => {
  it('无更新时弹 info 对话框（按钮：确定）', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    // 先 checkForUpdates 建立无更新状态
    await updateService.checkForUpdates()
    await updateService.showUpdateDialog()
    expect(mocks.showMessageBox).toHaveBeenCalled()
    const lastCall = mocks.showMessageBox.mock.calls[mocks.showMessageBox.mock.calls.length - 1][0]
    expect(lastCall.buttons).toEqual(['确定'])
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('有更新且用户点"前往下载"时打开 releaseUrl', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    updateService.setRepoUrl('https://github.com/owner/repo')
    mocks.httpsGet.mockImplementation((_url: string, _opts: unknown, cb: (r: unknown) => void) => {
      cb(makeHttpsResponse(JSON.stringify({
        tag_name: 'v2.0.0', html_url: 'https://release/url', body: '', published_at: '',
      })))
      return makeReq()
    })
    // 先 check 建立有更新状态，再 showUpdateDialog（复用 lastCheck）
    await updateService.checkForUpdates()
    expect(updateService.getLastCheck()?.hasUpdate).toBe(true)
    await updateService.showUpdateDialog()
    expect(mocks.openExternal).toHaveBeenCalledWith('https://release/url')
  })

  it('有更新但用户点"稍后提醒"时不打开链接', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 1 })
    updateService.setRepoUrl('https://github.com/owner/repo')
    mocks.httpsGet.mockImplementation((_url: string, _opts: unknown, cb: (r: unknown) => void) => {
      cb(makeHttpsResponse(JSON.stringify({
        tag_name: 'v2.0.0', html_url: 'https://release/url', body: '', published_at: '',
      })))
      return makeReq()
    })
    await updateService.checkForUpdates()
    await updateService.showUpdateDialog()
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('checkForUpdates 后 showUpdateDialog 能弹对话框', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    updateService.setRepoUrl('https://github.com/owner/repo')
    mocks.httpsGet.mockImplementation((_url: string, _opts: unknown, cb: (r: unknown) => void) => {
      cb(makeHttpsResponse(JSON.stringify({ tag_name: 'v2.0.0', html_url: '', body: '', published_at: '' })))
      return makeReq()
    })
    // checkForUpdates 必然调用 https
    await updateService.checkForUpdates()
    expect(mocks.httpsGet).toHaveBeenCalled()
    await updateService.showUpdateDialog()
    expect(mocks.showMessageBox).toHaveBeenCalled()
  })
})
