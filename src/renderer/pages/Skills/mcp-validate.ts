import type { McpServerConfig } from '@shared/types'

export type McpConfigErrors = Partial<Record<keyof McpServerConfig | 'id', string>>

const ID_RE = /^[a-zA-Z0-9_-]+$/
const URL_RE = /^https?:\/\/.+/
const SHELL_META_RE = /[;&|`$<>]/

/**
 * 校验 MCP server 配置(前端表单用,纯函数)。
 * 返回 errors 对象,空对象 = 合法。
 * 与后端 validateServerConfig + validateCommandSafe 保持一致语义。
 */
export function validateMcpConfig(config: Partial<McpServerConfig>): McpConfigErrors {
  const errors: McpConfigErrors = {}

  if (!config.id || config.id.trim().length === 0) {
    errors.id = 'ID 不能为空'
  } else if (config.id.length > 128) {
    errors.id = 'ID 过长(最多 128 字符)'
  } else if (!ID_RE.test(config.id)) {
    errors.id = 'ID 只能包含字母、数字、下划线、连字符'
  }

  if (!config.name || config.name.trim().length === 0) {
    errors.name = '名称不能为空'
  }

  if (config.transport === 'stdio') {
    if (!config.command || config.command.trim().length === 0) {
      errors.command = 'stdio 传输必须填写命令'
    } else if (SHELL_META_RE.test(config.command)) {
      errors.command = '命令包含非法 shell 字符'
    }
  }

  if (config.transport === 'sse' || config.transport === 'websocket') {
    if (!config.url || config.url.trim().length === 0) {
      errors.url = '必须填写 URL'
    } else if (!URL_RE.test(config.url)) {
      errors.url = 'URL 格式不正确(需以 http:// 或 https:// 开头)'
    }
  }

  return errors
}
