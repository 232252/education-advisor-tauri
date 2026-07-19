// =============================================================
// 定时任务 IPC 处理器
// =============================================================

import { type BrowserWindow, ipcMain } from 'electron'
import cron from 'node-cron'
import * as IPC from '../../shared/ipc-channels'
import type { CronTask } from '../../shared/types'
import { cronService } from '../services/cron-service'

// 严格 cron 表达式校验 — 与前端 validateCron 保持一致
// node-cron.validate 过于宽松(接受 7 段、不校验范围如 hour=25),
// 这里补充 5 段格式 + 字段范围校验,确保前后端校验一致。
const CRON_FIELD_RANGES = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day-of-week (0和7都是周日)
] as const

// node-cron 不支持宏表达式 (@daily/@hourly 等),
// cron.validate('@daily') 返回 false, cron.schedule 会抛错,
// 因此严格拒绝所有 @ 开头的表达式,避免误导用户。
// R57-3 H4 修复: strictValidateCron 导出,供 cron-service.ts 的 registerBitableSync 使用
// 之前 registerBitableSync 直接把 syncInterval 当 cron 表达式用,跳过了严格校验
export function strictValidateCron(expr: string): { ok: boolean; error?: string } {
  if (!expr || typeof expr !== 'string') return { ok: false, error: '表达式不能为空' }
  const macroKey = expr.trim().toLowerCase()
  if (macroKey.startsWith('@')) {
    return {
      ok: false,
      error: `宏表达式不支持 (node-cron 不支持 @daily/@hourly 等), 请使用 5 段表达式如 "0 9 * * *"`,
    }
  }
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5)
    return { ok: false, error: `需要 5 段 (分 时 日 月 周), 当前 ${parts.length} 段` }
  for (let i = 0; i < 5; i++) {
    const field = parts[i]
    const range = CRON_FIELD_RANGES[i]
    if (field === '*') continue
    for (const sub of field.split(',')) {
      if (sub === '') return { ok: false, error: `第 ${i + 1} 段有空子字段` }
      if (sub.startsWith('*/')) {
        const step = Number.parseInt(sub.slice(2), 10)
        if (Number.isNaN(step) || step < 1)
          return { ok: false, error: `第 ${i + 1} 段步长 "${sub}" 无效` }
        continue
      }
      const rangeMatch = sub.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
      if (rangeMatch) {
        const [, startStr, endStr, stepStr] = rangeMatch
        const start = Number.parseInt(startStr, 10)
        const end = Number.parseInt(endStr, 10)
        const effectiveMaxStart = i === 4 && start === 7 ? 7 : range.max
        const effectiveMaxEnd = i === 4 && end === 7 ? 7 : range.max
        if (start < range.min || start > effectiveMaxStart)
          return { ok: false, error: `第 ${i + 1} 段 ${start} 超出范围 ${range.min}-${range.max}` }
        if (end < range.min || end > effectiveMaxEnd)
          return { ok: false, error: `第 ${i + 1} 段 ${end} 超出范围 ${range.min}-${range.max}` }
        if (stepStr) {
          const step = Number.parseInt(stepStr, 10)
          if (step < 1) return { ok: false, error: `第 ${i + 1} 段步长 ${step} 无效` }
        }
        continue
      }
      const num = Number.parseInt(sub, 10)
      if (Number.isNaN(num)) return { ok: false, error: `第 ${i + 1} 段 "${sub}" 不是有效数字` }
      const effectiveMax = i === 4 && num === 7 ? 7 : range.max
      if (num < range.min || num > effectiveMax)
        return { ok: false, error: `第 ${i + 1} 段 ${num} 超出范围 ${range.min}-${range.max}` }
    }
  }
  return { ok: true }
}

/** 双重校验: 严格格式校验 + node-cron 语法校验 */
function validateCronExpression(expr: string): void {
  const strict = strictValidateCron(expr)
  if (!strict.ok) {
    throw new Error(`task.expression "${expr}" 无效: ${strict.error}`)
  }
  if (!cron.validate(expr)) {
    throw new Error(`task.expression "${expr}" 不是合法的 cron 表达式`)
  }
}

// =============================================================
// P5 修复: Cron 任务参数校验 helper
// 防止 XSS'd renderer 传入非法类型/null byte/超长字符串污染 cron-tasks.json
// =============================================================

const MAX_CRON_NAME_LEN = 128
const MAX_CRON_PROMPT_LEN = 10_000

/** 校验 task.name: 非空字符串 + 长度上限 + null byte + 控制字符 */
function validateCronName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new Error(`task.name must be a string, got ${name === null ? 'null' : typeof name}`)
  }
  if (name.length === 0) {
    throw new Error('task.name must be a non-empty string')
  }
  if (name.length > MAX_CRON_NAME_LEN) {
    throw new Error(`task.name too long (${name.length} > ${MAX_CRON_NAME_LEN})`)
  }
  if (name.includes('\0')) {
    throw new Error('task.name contains null byte')
  }
  // 拒绝控制字符 (换行/制表符等,防止 cron-tasks.json 行结构被破坏)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char guard
  if (/[\x00-\x1F\x7F]/.test(name)) {
    throw new Error('task.name contains control characters')
  }
  return name
}

/** 校验 task.expression: 非空字符串 + null byte (语法校验由 validateCronExpression 完成) */
function validateCronExpressionInput(expr: unknown): string {
  if (typeof expr !== 'string') {
    throw new Error(`task.expression must be a string, got ${expr === null ? 'null' : typeof expr}`)
  }
  if (expr.length === 0) {
    throw new Error('task.expression must be a non-empty string')
  }
  if (expr.includes('\0')) {
    throw new Error('task.expression contains null byte')
  }
  return expr
}

/** 校验 task.prompt: 字符串 + 长度上限 + null byte (可选字段) */
function validateCronPrompt(prompt: unknown): string | undefined {
  if (prompt === undefined || prompt === null) return undefined
  if (typeof prompt !== 'string') {
    throw new Error(`task.prompt must be a string, got ${typeof prompt}`)
  }
  if (prompt.length > MAX_CRON_PROMPT_LEN) {
    throw new Error(`task.prompt too long (${prompt.length} > ${MAX_CRON_PROMPT_LEN})`)
  }
  if (prompt.includes('\0')) {
    throw new Error('task.prompt contains null byte')
  }
  return prompt
}

/** modelTier 白名单 (与 agent-handlers 保持一致) */
const VALID_CRON_MODEL_TIERS = ['high_quality', 'low_cost'] as const

/** 校验 task.modelTier: 枚举白名单 (可选字段) */
function validateCronModelTier(tier: unknown): 'high_quality' | 'low_cost' | undefined {
  if (tier === undefined || tier === null) return undefined
  if (typeof tier !== 'string') {
    throw new Error(`task.modelTier must be a string, got ${typeof tier}`)
  }
  if (!VALID_CRON_MODEL_TIERS.includes(tier as (typeof VALID_CRON_MODEL_TIERS)[number])) {
    throw new Error(
      `task.modelTier "${tier}" invalid (allowed: ${VALID_CRON_MODEL_TIERS.join(', ')})`,
    )
  }
  return tier as 'high_quality' | 'low_cost'
}

/** 校验 task.agentId: 非空字符串 + null byte + 控制字符 */
function validateCronAgentId(agentId: unknown): string {
  if (typeof agentId !== 'string') {
    throw new Error(
      `task.agentId must be a string, got ${agentId === null ? 'null' : typeof agentId}`,
    )
  }
  if (agentId.length === 0) {
    throw new Error('task.agentId must be a non-empty string')
  }
  if (agentId.length > 128) {
    throw new Error(`task.agentId too long (${agentId.length} > 128)`)
  }
  if (agentId.includes('\0')) {
    throw new Error('task.agentId contains null byte')
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char guard
  if (/[\x00-\x1F\x7F]/.test(agentId)) {
    throw new Error('task.agentId contains control characters')
  }
  return agentId
}

/**
 * 校验完整 task 对象 (用于 add)
 * 返回经过校验的 Omit<CronTask, 'id'>
 */
function validateCronTaskInput(task: unknown): {
  name: string
  expression: string
  enabled?: boolean
  agentId: string
  prompt?: string
  modelTier?: 'high_quality' | 'low_cost'
} {
  if (!task || typeof task !== 'object') {
    throw new Error('task must be a non-null object')
  }
  const t = task as Record<string, unknown>
  const name = validateCronName(t.name)
  const expression = validateCronExpressionInput(t.expression)
  // 语法校验
  validateCronExpression(expression)
  // agentId 必填 (cronService.addTask 需要)
  const agentId = validateCronAgentId(t.agentId)
  // enabled 可选,但必须是 boolean
  let enabled: boolean | undefined
  if (t.enabled !== undefined && t.enabled !== null) {
    if (typeof t.enabled !== 'boolean') {
      throw new Error(`task.enabled must be a boolean, got ${typeof t.enabled}`)
    }
    enabled = t.enabled
  }
  const prompt = validateCronPrompt(t.prompt)
  const modelTier = validateCronModelTier(t.modelTier)
  return { name, expression, agentId, enabled, prompt, modelTier }
}

/**
 * 校验 patch 对象 (用于 update, 所有字段可选)
 * 排除 id 字段,返回安全 patch
 */
function validateCronPatchInput(patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== 'object') {
    throw new Error('patch must be a non-null object')
  }
  const p = patch as Record<string, unknown>
  // 排除 id 字段,防止 id 被篡改
  const { id: _ignored, ...safePatch } = p
  if (safePatch.name !== undefined) safePatch.name = validateCronName(safePatch.name)
  if (safePatch.expression !== undefined) {
    safePatch.expression = validateCronExpressionInput(safePatch.expression)
    validateCronExpression(safePatch.expression as string)
  }
  if (safePatch.agentId !== undefined) safePatch.agentId = validateCronAgentId(safePatch.agentId)
  if (safePatch.prompt !== undefined) safePatch.prompt = validateCronPrompt(safePatch.prompt)
  if (safePatch.modelTier !== undefined)
    safePatch.modelTier = validateCronModelTier(safePatch.modelTier)
  if (safePatch.enabled !== undefined && safePatch.enabled !== null) {
    if (typeof safePatch.enabled !== 'boolean') {
      throw new Error(`patch.enabled must be a boolean, got ${typeof safePatch.enabled}`)
    }
  }
  return safePatch
}

export function registerCronHandlers(win: BrowserWindow) {
  // 设置窗口引用，用于推送状态更新
  cronService.setMainWindow(win)

  // 启动时从磁盘恢复历史日志（P1-9 持久化日志的配套）
  cronService.loadPersistedLogs().catch((err) => {
    console.warn('[Cron] Failed to load persisted logs:', err)
  })

  // R57-3 H1 修复: 启动时从磁盘恢复用户任务(应用重启后用户创建的任务全丢失)
  cronService.loadPersistedUserTasks().catch((err) => {
    console.warn('[Cron] Failed to load persisted user tasks:', err)
  })

  ipcMain.handle(IPC.IPC_CRON_LIST, async () => {
    return cronService.listTasks()
  })

  // P1-36 修复:用 Omit<CronTask, 'id'> 替代 as any,
  // 拒绝畸形数据(空对象/缺失 name/expression 等)
  // H-3 修复:增加 cron 表达式语法校验,防止无效表达式进入调度器
  // P5 修复: 全字段校验 (name/expression/agentId/prompt/modelTier/enabled 类型+长度+null byte+控制字符)
  ipcMain.handle(IPC.IPC_CRON_ADD, async (_e, task: unknown) => {
    try {
      const safeTask = validateCronTaskInput(task)
      const id = cronService.addTask(safeTask as Omit<CronTask, 'id'>)
      return { success: true, id }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // P1-37 修复:用 Partial<CronTask> 替代 as any,
  // 过滤 patch 中 id 等不可变字段
  // H-3 修复:update 中若包含 expression,也需校验
  // P5 修复: 全字段校验 (与 add 一致,所有字段可选)
  ipcMain.handle(IPC.IPC_CRON_UPDATE, async (_e, id: string, patch: unknown) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('id must be a non-empty string')
    }
    const safePatch = validateCronPatchInput(patch)
    return cronService.updateTask(id, safePatch as Partial<CronTask>)
  })

  ipcMain.handle(IPC.IPC_CRON_REMOVE, async (_e, id: string) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('id must be a non-empty string')
    }
    return cronService.removeTask(id)
  })

  ipcMain.handle(IPC.IPC_CRON_TOGGLE, async (_e, id: string, enabled: boolean) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('id must be a non-empty string')
    }
    if (typeof enabled !== 'boolean') {
      throw new Error(`enabled must be a boolean, got ${typeof enabled}`)
    }
    return cronService.toggleTask(id, enabled)
  })

  // P1-38 修复:await runNow() 并捕获错误,避免误导前端
  // R3 修复: 不存在的 task 应返回 failure,而非 "Task execution completed"
  ipcMain.handle(IPC.IPC_CRON_RUN_NOW, async (_e, id: string) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('id must be a non-empty string')
    }
    try {
      // 先检查任务是否存在,executeTask 对不存在 id 静默 return 会导致误导性 "completed" 消息
      const exists = cronService.listTasks().some((t) => t.id === id)
      if (!exists) {
        return { success: false, message: `Task not found: ${id}` }
      }
      await cronService.runNow(id)
      return { success: true, message: 'Task execution completed' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[Cron] runNow failed for ${id}:`, message)
      return { success: false, message }
    }
  })

  ipcMain.handle(IPC.IPC_CRON_GET_LOGS, async (_e, taskId?: string) => {
    return cronService.getLogs(taskId)
  })

  console.log('[IPC] Cron handlers registered')
}
