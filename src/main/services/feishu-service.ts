// =============================================================
// Feishu Service — 飞书开放平台集成 (基于官方 Open API)
// 实现:
//   - tenant_access_token 鉴权(POST /open-apis/auth/v3/tenant_access_token/internal)
//   - 测连接(testConnection)
//   - bitable 列表(listBitableTables)
//   - 发文本消息(sendTextMessage)
// 设计参考: OpenClaw 飞书插件的鉴权 + 直发模式
// =============================================================

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis'

/** fetch 超时上限,防止 DNS 失败或服务器 hang 导致无限等待 */
const FEISHU_FETCH_TIMEOUT_MS = 15_000

interface TenantTokenResponse {
  code: number
  msg: string
  tenant_access_token?: string
  expire?: number
}

interface BitableTable {
  table_id: string
  name: string
}

interface BitableListResponse {
  code: number
  msg: string
  data?: { items?: BitableTable[] }
}

interface MessageResponse {
  code: number
  msg: string
  data?: { message_id?: string }
}

/**
 * R8 / 2A 修复: tenant_access_token 缓存按 appId 分桶。
 * 旧实现是模块级单变量 cachedToken,无 key —— 切换 app (appId/secret) 后,
 * 第二个 app 的 token 会覆盖第一个 app 的缓存,导致多租户串味
 * (用 app A 凭证换 app B 后,A 的后续 API 调用会拿 B 的 token)。
 */
const cachedTokens = new Map<string, { token: string; expireAt: number }>()

/** 内部:获取 tenant_access_token,自动缓存到过期前 5 分钟 */
async function getTenantToken(
  appId: string,
  appSecret: string,
): Promise<{ token: string; expireSec: number }> {
  // 命中缓存(按 appId 隔离)
  const cached = cachedTokens.get(appId)
  if (cached && cached.expireAt > Date.now() + 5 * 60 * 1000) {
    return {
      token: cached.token,
      expireSec: Math.floor((cached.expireAt - Date.now()) / 1000),
    }
  }
  const res = await fetch(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(FEISHU_FETCH_TIMEOUT_MS),
  })
  const data = (await res.json()) as TenantTokenResponse
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Feishu auth failed: code=${data.code} msg=${data.msg}`)
  }
  const entry = {
    token: data.tenant_access_token,
    expireAt: Date.now() + (data.expire ?? 7200) * 1000,
  }
  cachedTokens.set(appId, entry)
  return { token: data.tenant_access_token, expireSec: data.expire ?? 7200 }
}

/** 测试连接:用 appId/secret 拿 token,返回 token + 过期秒数 */
export async function testConnection(
  appId: string,
  appSecret: string,
): Promise<{ success: boolean; token?: string; expireSec?: number; error?: string }> {
  try {
    // R8 / 2A: 强制刷新当前 appId 的缓存,而不是清空所有(其他 app 的缓存保持)
    cachedTokens.delete(appId)
    const { token, expireSec } = await getTenantToken(appId, appSecret)
    return { success: true, token: `${token.slice(0, 8)}...`, expireSec }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** MEDIUM 修复: 校验 token 格式,防止 URL 路径注入(如 ../ 或 / 等) */
function validateToken(token: unknown, name: string): void {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw new Error(`Invalid ${name}: expected non-empty alphanumeric string (max 256 chars)`)
  }
}

/** 列出某 bitable app 下的所有表 */
export async function listBitableTables(
  appId: string,
  appSecret: string,
  appToken: string,
): Promise<{ success: boolean; tables?: BitableTable[]; error?: string }> {
  try {
    // MEDIUM 修复: 校验 appToken,防止 URL 路径注入
    validateToken(appToken, 'appToken')
    const { token } = await getTenantToken(appId, appSecret)
    const res = await fetch(`${FEISHU_API_BASE}/bitable/v1/apps/${appToken}/tables`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FEISHU_FETCH_TIMEOUT_MS),
    })
    const data = (await res.json()) as BitableListResponse
    if (data.code !== 0) {
      return { success: false, error: `code=${data.code} msg=${data.msg}` }
    }
    return { success: true, tables: data.data?.items ?? [] }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 给 userOpenId 发文本消息 */
export async function sendTextMessage(
  appId: string,
  appSecret: string,
  userOpenId: string,
  text: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const { token } = await getTenantToken(appId, appSecret)
    const res = await fetch(`${FEISHU_API_BASE}/im/v1/messages?receive_id_type=open_id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: userOpenId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
      signal: AbortSignal.timeout(FEISHU_FETCH_TIMEOUT_MS),
    })
    const data = (await res.json()) as MessageResponse
    if (data.code !== 0) {
      return { success: false, error: `code=${data.code} msg=${data.msg}` }
    }
    return { success: true, messageId: data.data?.message_id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 内部诊断日志:R8 / 2A 后改用按 appId 分桶的 cachedTokens Map */
export function feishuInfo(): string {
  if (cachedTokens.size === 0) return 'no cached token'
  // 多租户场景下报告每个 appId 各自的剩余时间(对运维更清晰)
  const entries = Array.from(cachedTokens.entries()).map(
    ([appId, c]) => `${appId}: expires in ${Math.floor((c.expireAt - Date.now()) / 1000)}s`,
  )
  return `token cached (${cachedTokens.size}): ${entries.join(', ')}`
}

/** T4: 往 bitable 写一条记录 */
export async function addBitableRecord(
  appId: string,
  appSecret: string,
  appToken: string,
  tableId: string,
  fields: Record<string, unknown>,
): Promise<{ success: boolean; recordId?: string; error?: string }> {
  try {
    // MEDIUM 修复: 校验 appToken 和 tableId,防止 URL 路径注入
    validateToken(appToken, 'appToken')
    validateToken(tableId, 'tableId')
    const { token } = await getTenantToken(appId, appSecret)
    const res = await fetch(
      `${FEISHU_API_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields }),
        signal: AbortSignal.timeout(FEISHU_FETCH_TIMEOUT_MS),
      },
    )
    const data = (await res.json()) as {
      code: number
      msg: string
      data?: { record?: { record_id?: string } }
    }
    if (data.code !== 0) {
      return { success: false, error: `code=${data.code} msg=${data.msg}` }
    }
    return { success: true, recordId: data.data?.record?.record_id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** T4: 手动触发一次 bitable 同步(graceful 降级) */
export async function syncBitableNow(
  appId: string,
  appSecret: string,
  appToken: string,
  tableId: string,
  fields: Record<string, unknown>,
): Promise<{ success: boolean; skipped?: string; recordId?: string; error?: string }> {
  if (!appId || !appSecret) {
    return { success: false, skipped: 'feishu credentials not configured' }
  }
  if (!appToken || !tableId) {
    return { success: false, skipped: 'bitable app_token/table_id not configured' }
  }
  return addBitableRecord(appId, appSecret, appToken, tableId, fields)
}
