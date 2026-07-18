// =============================================================
// Agent IPC 处理器
// =============================================================

import { type BrowserWindow, ipcMain } from 'electron'
import { startIpcTimer } from '../../shared/debug'
import * as IPC from '../../shared/ipc-channels'
import type { AgentConfig } from '../../shared/types'
import { agentService } from '../services/agent-service'

// =============================================================
// P4-1/P4-4 修复: Agent 参数校验 helper
// 防止 XSS'd renderer 传入非法类型污染 agents.user.yaml / SOUL.md
// =============================================================

/** 校验可选字符串字段:类型 + 长度上限 + null byte */
function validateOptionalAgentString(
  value: unknown,
  field: string,
  maxLen: number,
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`[IPC] invalid ${field}: expected string, got ${typeof value}`)
  }
  if (value.length > maxLen) {
    throw new Error(`[IPC] invalid ${field}: too long (${value.length} > ${maxLen})`)
  }
  if (value.includes('\0')) {
    throw new Error(`[IPC] invalid ${field}: contains null byte`)
  }
  return value
}

/** modelTier 白名单 */
const VALID_MODEL_TIERS = ['high_quality', 'low_cost'] as const

/** 校验 modelTier 枚举值 */
function validateModelTier(value: unknown): 'high_quality' | 'low_cost' | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`[IPC] invalid modelTier: expected string, got ${typeof value}`)
  }
  if (!VALID_MODEL_TIERS.includes(value as (typeof VALID_MODEL_TIERS)[number])) {
    throw new Error(`[IPC] invalid modelTier: ${value} (allowed: ${VALID_MODEL_TIERS.join(', ')})`)
  }
  return value as 'high_quality' | 'low_cost'
}

/** SOUL.md / AGENTS.md content 长度上限 (1MB,与 skill.save 一致) */
const MAX_SOUL_CONTENT_LEN = 1_000_000

/** 校验 SOUL/Rules content:类型 + 长度上限 + null byte */
function validateSoulContent(content: unknown): string {
  if (typeof content !== 'string') {
    throw new Error('[IPC] content must be a string')
  }
  if (content.length > MAX_SOUL_CONTENT_LEN) {
    throw new Error(`[IPC] content too long (${content.length} > ${MAX_SOUL_CONTENT_LEN})`)
  }
  if (content.includes('\0')) {
    throw new Error('[IPC] content contains null byte')
  }
  return content
}

/** history 单条 content 长度上限 (1MB) */
const MAX_HISTORY_MSG_LEN = 1_000_000

/**
 * P4-2 修复: 校验 runManual history 参数
 * - 必须是数组 (如果提供)
 * - 每个元素必须是含 role/content 字符串的对象
 * - content 长度上限 + null byte 校验
 */
function validateHistory(history: unknown): Array<{ role: string; content: string }> | undefined {
  if (history === undefined || history === null) return undefined
  if (!Array.isArray(history)) {
    throw new Error(`[IPC] invalid history: expected array, got ${typeof history}`)
  }
  // 限制总条数,防止内存暴涨
  if (history.length > 1000) {
    throw new Error(`[IPC] invalid history: too many messages (${history.length} > 1000)`)
  }
  const result: Array<{ role: string; content: string }> = []
  for (let i = 0; i < history.length; i++) {
    const msg = history[i]
    if (msg === null || typeof msg !== 'object') {
      throw new Error(
        `[IPC] invalid history[${i}]: expected object, got ${msg === null ? 'null' : typeof msg}`,
      )
    }
    const m = msg as { role?: unknown; content?: unknown }
    if (typeof m.role !== 'string' || m.role.length === 0) {
      throw new Error(`[IPC] invalid history[${i}].role: expected non-empty string`)
    }
    if (typeof m.content !== 'string') {
      throw new Error(
        `[IPC] invalid history[${i}].content: expected string, got ${typeof m.content}`,
      )
    }
    if (m.content.length > MAX_HISTORY_MSG_LEN) {
      throw new Error(
        `[IPC] invalid history[${i}].content: too long (${m.content.length} > ${MAX_HISTORY_MSG_LEN})`,
      )
    }
    if (m.content.includes('\0')) {
      throw new Error(`[IPC] invalid history[${i}].content: contains null byte`)
    }
    result.push({ role: m.role, content: m.content })
  }
  return result
}

export function registerAgentHandlers(win: BrowserWindow) {
  // 列出所有 Agent
  ipcMain.handle(IPC.IPC_AGENT_LIST, async () => {
    try {
      return agentService.listAgents()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] agent:list failed:', msg)
      return []
    }
  })

  // 获取 Agent 详情
  ipcMain.handle(IPC.IPC_AGENT_GET, async (_e, id: string) => {
    try {
      if (typeof id !== 'string' || id.length === 0) {
        return { success: false, error: 'id must be a non-empty string' }
      }
      return agentService.getAgent(id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] agent:get failed for "${id}":`, msg)
      return { success: false, error: msg }
    }
  })

  // 启用/禁用 Agent
  ipcMain.handle(IPC.IPC_AGENT_TOGGLE, async (_e, id: string, enabled: boolean) => {
    try {
      if (typeof id !== 'string' || id.length === 0) {
        return { success: false, error: 'id must be a non-empty string' }
      }
      if (typeof enabled !== 'boolean') {
        return { success: false, error: 'enabled must be a boolean' }
      }
      return agentService.toggleAgent(id, enabled)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] agent:toggle failed for "${id}":`, msg)
      return { success: false, error: msg }
    }
  })

  // 更新 Agent 配置
  // P4-1 修复: patch 字段类型校验 (name/description/modelTier),防止内存配置污染
  ipcMain.handle(IPC.IPC_AGENT_UPDATE, async (_e, id: string, patch: unknown) => {
    try {
      if (!id || typeof id !== 'string') {
        return { success: false, error: 'id must be a non-empty string' }
      }
      if (!patch || typeof patch !== 'object') {
        return { success: false, error: 'patch must be a non-null object' }
      }
      // P4-1 修复: 校验 patch 字段类型 + 长度 + null byte
      const p = patch as Record<string, unknown>
      const safePatch: Partial<
        Pick<AgentConfig, 'name' | 'description' | 'modelTier' | 'capabilities'>
      > = {}
      if (p.name !== undefined) safePatch.name = validateOptionalAgentString(p.name, 'name', 256)
      if (p.description !== undefined)
        safePatch.description = validateOptionalAgentString(p.description, 'description', 2000)
      if (p.modelTier !== undefined) safePatch.modelTier = validateModelTier(p.modelTier)
      if (p.capabilities !== undefined) safePatch.capabilities = p.capabilities as string[]
      return agentService.updateAgent(id, safePatch)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] agent:update failed for "${id}":`, msg)
      return { success: false, error: msg }
    }
  })

  // 读取 SOUL.md
  ipcMain.handle(IPC.IPC_AGENT_GET_SOUL, async (_e, id: string) => {
    try {
      if (typeof id !== 'string' || id.length === 0) {
        return { success: false, error: 'id must be a non-empty string' }
      }
      return agentService.getSoul(id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] agent:get-soul failed for "${id}":`, msg)
      return { success: false, error: msg }
    }
  })

  // 写入 SOUL.md
  // R3 修复: 验证 content 类型,避免 fs.writeFile 抛 raw TypeError
  // P4-4 修复: content 长度上限 (1MB) + null byte 校验
  ipcMain.handle(IPC.IPC_AGENT_SET_SOUL, async (_e, id: string, content: string) => {
    try {
      if (typeof id !== 'string' || id.length === 0) {
        return { success: false, error: 'id must be a non-empty string' }
      }
      const safeContent = validateSoulContent(content)
      return agentService.setSoul(id, safeContent)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] agent:set-soul failed for "${id}":`, msg)
      return { success: false, error: msg }
    }
  })

  // 读取 AGENTS.md
  ipcMain.handle(IPC.IPC_AGENT_GET_RULES, async (_e, id: string) => {
    try {
      if (typeof id !== 'string' || id.length === 0) {
        return { success: false, error: 'id must be a non-empty string' }
      }
      return agentService.getRules(id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] agent:get-rules failed for "${id}":`, msg)
      return { success: false, error: msg }
    }
  })

  // 写入 AGENTS.md
  // R3 修复: 验证 content 类型,避免 fs.writeFile 抛 raw TypeError
  // P4-4 修复: content 长度上限 (1MB) + null byte 校验
  ipcMain.handle(IPC.IPC_AGENT_SET_RULES, async (_e, id: string, content: string) => {
    try {
      if (typeof id !== 'string' || id.length === 0) {
        return { success: false, error: 'id must be a non-empty string' }
      }
      const safeContent = validateSoulContent(content)
      return agentService.setRules(id, safeContent)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] agent:set-rules failed for "${id}":`, msg)
      return { success: false, error: msg }
    }
  })

  // 手动触发 Agent — 异步执行，通过 AGENT_STATUS_UPDATE 推送进度
  // P1-39 修复:捕获 IIFE 异常并 await runAgent,错误也返回前端
  // P3-2 修复: prompt null byte + 长度上限校验
  // P4-2 修复: history 参数校验 (数组/元素类型/content 长度/null byte)
  ipcMain.handle(
    IPC.IPC_AGENT_RUN_MANUAL,
    async (_e, id: string, prompt: string, history?: Array<{ role: string; content: string }>) => {
      const stop = startIpcTimer('agent:run-manual')
      try {
        if (typeof id !== 'string' || id.length === 0) {
          return { success: false, message: 'id must be a non-empty string' }
        }
        if (typeof prompt !== 'string') {
          return { success: false, message: 'prompt must be a string' }
        }
        if (prompt.length === 0) {
          return { success: false, message: 'prompt cannot be empty' }
        }
        // P3-2 修复: prompt 安全校验 — null byte 注入 + 超长输入 OOM 防护
        // null byte 可注入到下游 LLM 请求,绕过 prompt 模板边界
        if (prompt.includes('\0')) {
          return { success: false, message: '[IPC] invalid prompt: contains null byte' }
        }
        // 1MB 上限: 防止超大 prompt 导致内存/OOM(LLM 上下文窗口通常 << 1MB)
        const MAX_PROMPT_LEN = 1_000_000
        if (prompt.length > MAX_PROMPT_LEN) {
          return {
            success: false,
            message: `[IPC] invalid prompt: too long (${prompt.length} > ${MAX_PROMPT_LEN})`,
          }
        }
        // P4-2 修复: history 参数校验 (在 IIFE 前同步执行,IPC 直接返回错误)
        let safeHistory: Array<{ role: string; content: string }> | undefined
        try {
          safeHistory = validateHistory(history)
        } catch (histErr) {
          const histMsg = histErr instanceof Error ? histErr.message : String(histErr)
          return { success: false, message: histMsg }
        }
        // R21 修复:同步校验 agent 是否存在(避免对不存在的 agent 返回误导性 success:true)
        const exists = agentService.listAgents().some((a) => a.id === id)
        if (!exists) {
          return { success: false, message: `Agent not found: ${id}` }
        }
        // R13-2 修复:同步校验 agent 是否启用(disabled agent 不应返回 success:true
        // 再异步报 error,会让前端收到矛盾信号)
        const agent = agentService.listAgents().find((a) => a.id === id)
        if (agent && !agent.enabled) {
          return { success: false, message: `Agent is disabled: ${id}` }
        }
        // 不 await:手动触发是 fire-and-forget,通过 stream 推送状态
        // 但同步 try/catch 同步参数错误,异步错误由 runAgent 内部 sendStatus 推送
        agentService.runAgent(id, prompt, win, safeHistory).catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          console.error(`[Agent] Execution error for ${id}:`, message)
          // 已通过 sendStatus 推送到渲染进程,这里仅做兜底日志
        })
        return { success: true, message: 'Agent execution started', id }
      } finally {
        stop()
      }
    },
  )

  // 中止 Agent 执行
  // P1-40 修复:await abortAgent,等 agent 进入 idle 后再返回
  ipcMain.handle(IPC.IPC_AGENT_ABORT, async (_e, id: string) => {
    const stop = startIpcTimer('agent:abort')
    try {
      const aborted = await agentService.abortAgent(id, win)
      return { success: aborted, message: aborted ? 'Agent aborted' : 'Agent not running' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[Agent] Abort error for ${id}:`, message)
      return { success: false, message }
    } finally {
      stop()
    }
  })

  // 获取执行历史
  ipcMain.handle(IPC.IPC_AGENT_GET_HISTORY, async (_e, id: string) => {
    try {
      if (typeof id !== 'string' || id.length === 0) {
        return { success: false, error: 'id must be a non-empty string' }
      }
      return agentService.getHistory(id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] agent:get-history failed for "${id}":`, msg)
      return { success: false, error: msg, history: [] }
    }
  })

  console.log('[IPC] Agent handlers registered (pi-agent-core integrated)')
}
