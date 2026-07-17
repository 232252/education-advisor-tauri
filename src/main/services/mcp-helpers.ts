// =============================================================
// mcp-helpers — 从 mcp-service.ts 提取的纯函数
//
// MCP client 管理器中存在大量网络/进程副作用(stdio spawn、SSE、
// WebSocket),难以单元测试。这里抽出三类无副作用的纯逻辑:
//   1. 环境变量插值 (${VAR} 替换)
//   2. 配置完整性校验 (9 条件 type guard)
//   3. 深度对象遍历
//
// 这些是 config/mcp.yaml 加载链路上的关键纯函数,出 bug 会静默
// 导致所有 MCP server 连接失败,因此值得单独测试覆盖。
// =============================================================

import type { McpServerConfig } from '../../shared/types'

/**
 * 环境变量插值: ${VAR} → process.env[VAR]
 * 未定义的环境变量替换为空字符串。
 * @example interpolateEnv('http://${HOST}') → 'http://example.com'(当 HOST=example.com)
 */
export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '')
}

/**
 * 深度插值:递归处理对象/数组中的所有字符串值。
 * 非字符串原样返回。
 */
export function deepInterpolate<T>(obj: T): T {
  if (typeof obj === 'string') return interpolateEnv(obj) as unknown as T
  if (Array.isArray(obj)) return obj.map(deepInterpolate) as unknown as T
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = deepInterpolate(value)
    }
    return result as unknown as T
  }
  return obj
}

/**
 * 校验 server 配置完整性(9 条件 type guard)。
 *
 * 这是从 mcp.yaml 加载到 connectTransport 之间的唯一类型安全屏障——
 * 任何一条失败都意味着配置不完整,connectTransport 会在运行时崩溃。
 *
 * 规则:
 *   - 必须是非空对象
 *   - id 必须是非空字符串
 *   - name 必须是字符串
 *   - enabled 必须是 boolean
 *   - transport 必须是 'stdio' | 'sse' | 'websocket' 之一
 *   - stdio 传输必须有 command
 *   - sse/websocket 传输必须有 url
 */
export function validateServerConfig(server: unknown): server is McpServerConfig {
  if (!server || typeof server !== 'object') return false
  const s = server as Record<string, unknown>
  if (typeof s.id !== 'string' || s.id.length === 0) return false
  if (typeof s.name !== 'string') return false
  if (typeof s.enabled !== 'boolean') return false
  const transport = s.transport
  if (transport !== 'stdio' && transport !== 'sse' && transport !== 'websocket') return false
  // stdio 需要 command
  if (transport === 'stdio' && typeof s.command !== 'string') return false
  // sse/websocket 需要 url
  if ((transport === 'sse' || transport === 'websocket') && typeof s.url !== 'string') return false
  return true
}
