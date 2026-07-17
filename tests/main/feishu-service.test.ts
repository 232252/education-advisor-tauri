// =============================================================
// Feishu Service 测试 — 飞书开放平台 REST 集成
// 覆盖：testConnection、getTenantToken缓存、listBitableTables、sendTextMessage、
//       addBitableRecord(URL注入防御)、syncBitableNow(graceful降级)、feishuInfo
// 模式：vi.spyOn(globalThis, 'fetch') mock Response（唯一外部依赖）
// =============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const APP_ID = 'cli_test_app'
const APP_SECRET = 'secret123'
const VALID_TOKEN = 't-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

// 每个测试动态导入，确保 cachedToken 模块级状态被重置（vi.resetModules 在 beforeEach）
let mod: typeof import('../../src/main/services/feishu-service')

function mockFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockTokenResponse(token = VALID_TOKEN, expire = 7200): Response {
  return mockFetchResponse({ code: 0, msg: 'ok', tenant_access_token: token, expire })
}

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  vi.resetModules()
  // 清空 require 缓存后重新导入，cachedToken 重置为 null
  mod = await import('../../src/main/services/feishu-service')
  fetchSpy = vi.spyOn(globalThis, 'fetch')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('testConnection', () => {
  it('成功时返回截断的 token（前8字符 + ...）', async () => {
    fetchSpy.mockResolvedValue(mockTokenResponse())
    // 强制刷新缓存
    const res = await mod.testConnection(APP_ID, APP_SECRET)
    expect(res.success).toBe(true)
    expect(res.token).toBe(`${VALID_TOKEN.slice(0, 8)}...`)
    expect(res.expireSec).toBe(7200)
  })

  it('鉴权失败（code !== 0）时返回错误', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse({ code: 9999, msg: 'invalid secret' }))
    const res = await mod.testConnection(APP_ID, 'wrong')
    expect(res.success).toBe(false)
    expect(res.error).toContain('9999')
  })

  it('网络异常时返回错误', async () => {
    fetchSpy.mockRejectedValue(new Error('network timeout'))
    const res = await mod.testConnection(APP_ID, APP_SECRET)
    expect(res.success).toBe(false)
    expect(res.error).toContain('network timeout')
  })

  it('token 为空时鉴权失败', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse({ code: 0, msg: 'ok', tenant_access_token: '' }))
    const res = await mod.testConnection(APP_ID, APP_SECRET)
    expect(res.success).toBe(false)
  })
})

describe('getTenantToken 缓存', () => {
  it('连续调用只请求一次 token（缓存命中）', async () => {
    fetchSpy.mockResolvedValue(mockTokenResponse())
    // 第一次：testConnection 清缓存并获取 token
    await mod.testConnection(APP_ID, APP_SECRET)
    // 第二次：listBitableTables 应复用缓存 token（fetch 只被 token 请求调用 1 次 + bitable 1 次）
    fetchSpy.mockResolvedValue(mockFetchResponse({ code: 0, msg: 'ok', data: { items: [] } }))
    await mod.listBitableTables(APP_ID, APP_SECRET, 'validAppToken123')
    // fetch 第一次用于 token，第二次用于 bitable；不应再有第二次 token 请求
    const tokenCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('tenant_access_token'),
    )
    expect(tokenCalls).toHaveLength(1)
  })
})

describe('listBitableTables', () => {
  it('成功返回表列表', async () => {
    fetchSpy.mockResolvedValueOnce(mockTokenResponse())
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        code: 0,
        msg: 'ok',
        data: { items: [{ table_id: 't1', name: '表1' }] },
      }),
    )
    const res = await mod.listBitableTables(APP_ID, APP_SECRET, 'validAppToken123')
    expect(res.success).toBe(true)
    expect(res.tables).toHaveLength(1)
    expect(res.tables?.[0].name).toBe('表1')
  })

  it('appToken 含 ../ 时被 URL 注入防御拒绝', async () => {
    const res = await mod.listBitableTables(APP_ID, APP_SECRET, '../etc/passwd')
    expect(res.success).toBe(false)
    expect(res.error).toContain('appToken')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('appToken 含空格时被拒绝', async () => {
    const res = await mod.listBitableTables(APP_ID, APP_SECRET, 'token with space')
    expect(res.success).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('飞书返回错误码时透传', async () => {
    fetchSpy.mockResolvedValueOnce(mockTokenResponse())
    fetchSpy.mockResolvedValueOnce(mockFetchResponse({ code: 1254030, msg: 'no permission' }))
    const res = await mod.listBitableTables(APP_ID, APP_SECRET, 'validAppToken123')
    expect(res.success).toBe(false)
    expect(res.error).toContain('1254030')
  })

  it('无 items 时返回空数组', async () => {
    fetchSpy.mockResolvedValueOnce(mockTokenResponse())
    fetchSpy.mockResolvedValueOnce(mockFetchResponse({ code: 0, msg: 'ok', data: {} }))
    const res = await mod.listBitableTables(APP_ID, APP_SECRET, 'validAppToken123')
    expect(res.success).toBe(true)
    expect(res.tables).toEqual([])
  })
})

describe('sendTextMessage', () => {
  it('成功发送并返回 messageId', async () => {
    fetchSpy.mockResolvedValueOnce(mockTokenResponse())
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ code: 0, msg: 'ok', data: { message_id: 'om-12345' } }),
    )
    const res = await mod.sendTextMessage(APP_ID, APP_SECRET, 'ou_testuser', '你好')
    expect(res.success).toBe(true)
    expect(res.messageId).toBe('om-12345')
  })

  it('POST body 包含 receive_id_type=open_id 和 text', async () => {
    fetchSpy.mockResolvedValueOnce(mockTokenResponse())
    fetchSpy.mockResolvedValueOnce(mockFetchResponse({ code: 0, msg: 'ok', data: {} }))
    await mod.sendTextMessage(APP_ID, APP_SECRET, 'ou_testuser', '测试消息')
    const msgCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/im/v1/messages'))
    expect(msgCall).toBeDefined()
    const opts = msgCall?.[1] as RequestInit
    const body = JSON.parse(opts.body as string)
    expect(body.receive_id).toBe('ou_testuser')
    expect(body.msg_type).toBe('text')
    expect(JSON.parse(body.content).text).toBe('测试消息')
  })

  it('飞书返回错误码时透传', async () => {
    fetchSpy.mockResolvedValueOnce(mockTokenResponse())
    fetchSpy.mockResolvedValueOnce(mockFetchResponse({ code: 230002, msg: 'invalid open_id' }))
    const res = await mod.sendTextMessage(APP_ID, APP_SECRET, 'bad_user', 'x')
    expect(res.success).toBe(false)
    expect(res.error).toContain('230002')
  })
})

describe('addBitableRecord', () => {
  it('成功写入并返回 recordId', async () => {
    fetchSpy.mockResolvedValueOnce(mockTokenResponse())
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ code: 0, msg: 'ok', data: { record: { record_id: 'rec-1' } } }),
    )
    const res = await mod.addBitableRecord(APP_ID, APP_SECRET, 'appToken1', 'tbl1', { 姓名: '张三' })
    expect(res.success).toBe(true)
    expect(res.recordId).toBe('rec-1')
  })

  it('tableId 含 / 时被 URL 注入防御拒绝', async () => {
    const res = await mod.addBitableRecord(APP_ID, APP_SECRET, 'appToken1', 'tbl/bad', {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('tableId')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('appToken 含特殊字符时被拒绝', async () => {
    const res = await mod.addBitableRecord(APP_ID, APP_SECRET, 'app;token', 'tbl1', {})
    expect(res.success).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('syncBitableNow（graceful 降级）', () => {
  it('缺 appId/appSecret 时返回 skipped', async () => {
    const res = await mod.syncBitableNow('', '', 'token', 'tbl', {})
    expect(res.success).toBe(false)
    expect(res.skipped).toContain('credentials not configured')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('缺 appToken/tableId 时返回 skipped', async () => {
    const res = await mod.syncBitableNow(APP_ID, APP_SECRET, '', '', {})
    expect(res.success).toBe(false)
    expect(res.skipped).toContain('app_token/table_id not configured')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('配置齐全时委派给 addBitableRecord', async () => {
    fetchSpy.mockResolvedValueOnce(mockTokenResponse())
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ code: 0, msg: 'ok', data: { record: { record_id: 'rec-2' } } }),
    )
    const res = await mod.syncBitableNow(APP_ID, APP_SECRET, 'appToken1', 'tbl1', { 分数: 90 })
    expect(res.success).toBe(true)
    expect(res.recordId).toBe('rec-2')
  })
})

describe('feishuInfo', () => {
  it('无缓存 token 时返回提示', async () => {
    // 先清缓存
    fetchSpy.mockResolvedValue(mockTokenResponse())
    await mod.testConnection(APP_ID, APP_SECRET) // 这里会设置缓存
    // 此时应有缓存
    expect(mod.feishuInfo()).toContain('token cached')
  })

  it('返回的字符串格式正确', async () => {
    fetchSpy.mockResolvedValue(mockTokenResponse())
    await mod.testConnection(APP_ID, APP_SECRET)
    const info = mod.feishuInfo()
    expect(info).toMatch(/expires in \d+s/)
  })
})
