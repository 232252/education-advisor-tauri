// =============================================================
// Cron Service — 定时任务调度器
// 通过 node-cron 驱动 Agent 定时执行
// 修复：
//   P1-8: 记录 nextRunAt（监听 node-cron 'scheduled' 事件 + 初始估算）
//   P1-9: 日志改为异步持久化到磁盘（同时保留内存 1000 条上限）
//   P1-10: 取消的 agent 在 finally 块清理
// =============================================================

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app, type BrowserWindow } from 'electron'
import cron from 'node-cron'
import * as IPC from '../../shared/ipc-channels'
import type { CronLogEntry, CronTask } from '../../shared/types'
import { log } from '../utils/logger'
// R57-3 H1 修复: 引入 atomicWrite,用于用户任务持久化(原子写 tmp+rename)
import { atomicWrite } from '../utils/atomic-write'
import { syncBitableNow } from './feishu-service'
import { keystoreService } from './keystore-service'
import { settingsService } from './settings-service'
// R57-3 H4 修复: import strictValidateCron,用于 registerBitableSync 校验 cron 表达式
import { strictValidateCron } from '../ipc/cron-handlers'

class CronService {
  private static readonly MAX_USER_TASKS = 100

  private tasks: Map<string, CronTask> = new Map()
  private scheduledJobs: Map<string, cron.ScheduledTask> = new Map()
  /** 下次执行时间 ISO 字符串 */
  private nextRunAt: Map<string, string> = new Map()
  private logs: CronLogEntry[] = []
  /** 持久化日志路径（追加写入避免频繁重写） */
  private logFilePath: string
  /** 日志写入节流 */
  private logWriteTimer: NodeJS.Timeout | null = null
  /** 待写入的日志缓冲 */
  private logBuffer: CronLogEntry[] = []
  private mainWindow: BrowserWindow | null = null
  /** H-2.3 修复: per-task 执行锁,防止 runNow 与 cron 定时同时触发同一任务造成竞态 */
  private runningTasks: Set<string> = new Set()

  // R57-3 H1 修复: 用户任务持久化路径
  /** 用户任务持久化文件路径 (原子写,应用重启后恢复) */
  private userTasksFilePath: string
  // R57-3 H3 修复: 并发上限控制
  /** 最大并发执行任务数 (从 settings.general.maxConcurrentCronTasks 读取,默认 5) */
  private maxConcurrentTasks = 5
  /** 当前正在执行的任务数 */
  private runningCount = 0

  /** 延迟注入，避免循环依赖 */
  private agentRunner:
    | ((agentId: string, prompt: string, win: BrowserWindow) => Promise<void>)
    | null = null

  constructor() {
    this.logFilePath = path.join(app.getPath('userData'), 'cron-logs.jsonl')
    // R57-3 H1 修复: 用户任务持久化文件路径
    this.userTasksFilePath = path.join(app.getPath('userData'), 'cron.user.json')
    // R57-3 H3 修复: 从 settings 读取并发上限,默认 5
    try {
      const maxConcurrent = settingsService.getSettings().general?.maxConcurrentCronTasks
      if (typeof maxConcurrent === 'number' && maxConcurrent > 0) {
        this.maxConcurrentTasks = maxConcurrent
      }
    } catch {
      // 读取失败保持默认值 5
    }
  }

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win
  }

  /** 注入 agent 执行函数（由 agent-service 在初始化时调用） */
  setAgentRunner(fn: (agentId: string, prompt: string, win: BrowserWindow) => Promise<void>) {
    this.agentRunner = fn
  }

  /** 列出所有任务 */
  listTasks(): CronTask[] {
    return Array.from(this.tasks.values())
  }

  /** 获取任务下次执行时间（P1-8） */
  getNextRunAt(taskId: string): string | undefined {
    return this.nextRunAt.get(taskId)
  }

  /** 添加任务 */
  addTask(task: Omit<CronTask, 'id'>): string {
    // 仅统计用户任务(排除 agent-schedule-* 和 feishu-bitable-sync 等系统任务)
    let userTaskCount = 0
    for (const id of this.tasks.keys()) {
      if (!id.startsWith('agent-schedule-') && id !== 'feishu-bitable-sync') {
        userTaskCount++
      }
    }
    if (userTaskCount >= CronService.MAX_USER_TASKS) {
      throw new Error(`Task limit reached (max ${CronService.MAX_USER_TASKS} user tasks)`)
    }
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fullTask: CronTask = { ...task, id }
    this.tasks.set(id, fullTask)
    this.schedule(id, fullTask)
    // R57-3 H1 修复: 用户任务变更后持久化到磁盘
    this.persistUserTasks()
    return id
  }

  /** 更新任务 */
  updateTask(id: string, patch: Partial<CronTask>) {
    const task = this.tasks.get(id)
    if (!task) return { success: false, error: 'Task not found' }

    this.unschedule(id)
    Object.assign(task, patch)
    this.schedule(id, task)

    // R57-3 H1 修复: 用户任务变更后持久化到磁盘
    this.persistUserTasks()

    return { success: true }
  }

  /** 删除任务 */
  removeTask(id: string) {
    const task = this.tasks.get(id)
    if (!task) {
      return { success: false, error: 'Task not found' }
    }
    this.unschedule(id)
    this.tasks.delete(id)
    this.nextRunAt.delete(id)
    // R57-3 H1 修复: 用户任务变更后持久化到磁盘
    this.persistUserTasks()
    return { success: true }
  }

  /** 启用/禁用任务 */
  toggleTask(id: string, enabled: boolean) {
    const task = this.tasks.get(id)
    if (!task) return { success: false, error: 'Task not found' }

    task.enabled = enabled

    if (enabled) {
      this.schedule(id, task)
    } else {
      this.unschedule(id)
    }

    // R57-3 H1 修复: 用户任务变更后持久化到磁盘
    this.persistUserTasks()

    return { success: true }
  }

  /** 立即执行任务 */
  async runNow(id: string) {
    await this.executeTask(id)
  }

  /** 获取执行日志 */
  getLogs(taskId?: string): CronLogEntry[] {
    if (taskId) {
      return this.logs.filter((l) => l.taskId === taskId)
    }
    return [...this.logs]
  }

  /** T4: 注册 bitable 同步任务(根据 settings.feishu.bitableSync) */
  registerBitableSync(): void {
    try {
      const s = settingsService.getSettings()
      if (!s.feishu?.bitableSync?.enabled) {
        log('info', 'cron', 'bitableSync disabled, skipping task registration')
        return
      }
      const intervalRaw = s.feishu.bitableSync.syncInterval ?? '0 */6 * * *'
      // syncInterval 可能是 cron 表达式(包含空格)或分钟数
      let expr: string
      if (typeof intervalRaw === 'string' && intervalRaw.trim().split(/\s+/).length >= 5) {
        // R57-3 H4 修复: 已经是完整的 cron 表达式（5 字段）,但必须通过 strictValidateCron 校验
        // 之前此处直接使用,跳过了严格校验,可能导致无效表达式(如 hour=25)进入调度器
        const validation = strictValidateCron(intervalRaw)
        if (!validation.ok) {
          log('warn', 'cron', `bitableSync syncInterval "${intervalRaw}" 校验失败: ${validation.error}, fallback 到默认 60 分钟`)
          expr = '0 */1 * * *' // 默认每 60 分钟
        } else {
          expr = intervalRaw
        }
      } else {
        // 视为分钟数，转换为 cron 表达式
        // R8 / 1B 修复: 之前 ≥24h 的 interval 被 Math.min(23, hours) 静默截断到 23h,
        // 导致用户配 5 天实际变成 23h,且无任何信号。改用"每 N 天"语法 0 0 */N * *
        const minutes = typeof intervalRaw === 'number' ? intervalRaw : Number(intervalRaw) || 360
        // R57-3 H4 修复: 分钟数加下限校验,最小 1 分钟,不合法则 fallback 到默认 60 分钟
        if (minutes < 1) {
          log('warn', 'cron', `bitableSync syncInterval 分钟数 ${minutes} < 1, fallback 到默认 60 分钟`)
          expr = '0 */1 * * *'
        } else if (minutes < 60) {
          expr = `*/${Math.max(1, Math.round(minutes))} * * * *`
        } else if (minutes < 24 * 60) {
          const hours = Math.max(1, Math.round(minutes / 60))
          expr = `0 */${hours} * * *`
        } else {
          // 1 天以上:用 day-of-month 语法,Node-cron 支持的最小间隔是 1 天
          const days = Math.max(1, Math.round(minutes / (24 * 60)))
          expr = `0 0 */${days} * *`
        }
      }
      const taskId = 'feishu-bitable-sync'
      const task: CronTask = {
        id: taskId,
        name: '飞书 Bitable 同步',
        agentId: '__feishu__',
        expression: expr,
        enabled: true,
        prompt: 'periodic bitable sync heartbeat',
        modelTier: 'low_cost',
      }
      this.tasks.set(taskId, task)
      this.schedule(taskId, task)
      log('info', 'cron', `bitableSync registered, expr='${expr}' taskId=${taskId}`)
    } catch (err) {
      log(
        'warn',
        'cron',
        `bitableSync register failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** T4: 执行一次 bitable 同步(graceful 降级)
   *  M-CRON-1 修复: 独立锁防止 executeBitableSync 并发执行 */
  private bitableSyncRunning = false
  async executeBitableSync(): Promise<{
    success: boolean
    skipped?: string
    recordId?: string
    error?: string
  }> {
    // M-CRON-1 修复: 独立锁,防止高频 cron 配置下多个同步并发
    if (this.bitableSyncRunning) {
      return { success: false, skipped: 'bitable sync already running' }
    }
    this.bitableSyncRunning = true
    try {
      const s = settingsService.getSettings()
      if (!s.feishu?.bitableSync?.enabled) {
        return { success: false, skipped: 'bitableSync disabled' }
      }
      const appId = s.feishu.appId ?? ''
      // appSecret 从 keystore 加密存储读取
      const appSecret = keystoreService.getSecret('feishu-app-secret') ?? ''
      // C-1 修复: 从 settings 读取 bitableAppToken 和 bitableTableId,
      // 不再用 userOpenId 占位 + tableId 硬编码 'log'
      const appToken = s.feishu.bitableAppToken ?? ''
      const tableId = s.feishu.bitableTableId ?? 'log'
      if (!appToken) {
        return {
          success: false,
          error: 'feishu.bitableAppToken 未配置,请在设置页面填写 Bitable App Token',
        }
      }
      const fields = {
        timestamp: new Date().toISOString(),
        source: 'education-advisor',
        level: 'info',
        message: 'periodic bitable sync heartbeat',
      }
      return await syncBitableNow(appId, appSecret, appToken, tableId, fields)
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.bitableSyncRunning = false
    }
  }

  /** 启动时从磁盘恢复历史日志
   *  R57-3 H1 修复: 同时恢复持久化的用户任务(在系统任务注册之前) */
  async loadPersistedLogs(): Promise<void> {
    // R57-3 H1 修复: 在系统任务(registerBitableSync/syncAgentSchedules)注册之前,
    // 先恢复用户持久化任务,避免与系统任务重建冲突
    await this.loadPersistedUserTasks()

    try {
      await fsp.access(this.logFilePath, fs.constants.F_OK)
    } catch {
      return
    }
    try {
      // 防止大日志文件导致 OOM: 只读取文件末尾 2MB（足够包含 1000 条日志）
      const stats = await fsp.stat(this.logFilePath)
      const maxReadBytes = 2 * 1024 * 1024
      let content: string
      if (stats.size > maxReadBytes) {
        const fd = await fsp.open(this.logFilePath, 'r')
        try {
          const buffer = Buffer.alloc(maxReadBytes)
          await fd.read(buffer, 0, maxReadBytes, stats.size - maxReadBytes)
          content = buffer.toString('utf-8')
          // 丢弃第一个可能不完整的行
          const firstNewline = content.indexOf('\n')
          if (firstNewline >= 0) content = content.slice(firstNewline + 1)
        } finally {
          await fd.close()
        }
      } else {
        content = await fsp.readFile(this.logFilePath, 'utf-8')
      }
      const lines = content.split('\n').filter((l) => l.trim().length > 0)
      // 仅加载最近 1000 条
      const recent = lines.slice(-1000)
      const entries: CronLogEntry[] = []
      for (const line of recent) {
        try {
          const entry = JSON.parse(line) as CronLogEntry
          if (entry && typeof entry.taskId === 'string') {
            entries.push(entry)
          }
        } catch {
          // 忽略单行解析错误
        }
      }
      this.logs = entries

      // 日志文件过大时截断（只保留最近 1000 条），防止无限增长
      if (stats.size > 5 * 1024 * 1024 && entries.length > 0) {
        try {
          const truncated = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`
          await fsp.writeFile(this.logFilePath, truncated, 'utf-8')
          console.log(
            `[CronService] Log file truncated from ${Math.round(stats.size / 1024)}KB to ${Math.round(truncated.length / 1024)}KB`,
          )
        } catch {
          // 截断失败不影响启动
        }
      }
    } catch (err) {
      console.warn('[CronService] Failed to load persisted logs:', err)
    }
  }

  /** 为 Agent 的 schedule 字段自动创建 cron 任务
   * 返回 agentId → cron taskIds 映射,供 AgentService 聚合 nextRunAt(P1-1)
   */
  syncAgentSchedules(
    agents: Array<{
      id: string
      name: string
      schedule: string[]
      modelTier: 'high_quality' | 'low_cost'
    }>,
  ): Map<string, string[]> {
    const mapping: Map<string, string[]> = new Map()

    // 清理已有的 agent-schedule-* 前缀任务
    for (const [id] of this.tasks) {
      if (id.startsWith('agent-schedule-')) {
        this.unschedule(id)
        this.tasks.delete(id)
      }
    }

    for (const agent of agents) {
      const taskIds: string[] = []
      for (let i = 0; i < agent.schedule.length; i++) {
        const expression = agent.schedule[i]
        if (!cron.validate(expression)) continue

        const id = `agent-schedule-${agent.id}-${i}`
        const task: CronTask = {
          id,
          name: `${agent.name} 定时任务 ${i + 1}`,
          agentId: agent.id,
          expression,
          prompt: `执行 ${agent.name} 的定时任务`,
          enabled: true,
          modelTier: agent.modelTier,
        }
        this.tasks.set(id, task)
        this.schedule(id, task)
        taskIds.push(id)
      }
      if (taskIds.length > 0) {
        mapping.set(agent.id, taskIds)
      }
    }
    return mapping
  }

  // ===========================================================
  // 内部方法
  // ===========================================================

  private schedule(id: string, task: CronTask) {
    if (!task.enabled || !cron.validate(task.expression)) return
    // H-4 修复: 时区从 settings.general.timezone 读取,不再硬编码 'Asia/Shanghai'
    // 读取失败时回退到 'Asia/Shanghai'(保持向后兼容)
    let timezone = 'Asia/Shanghai'
    try {
      const tz = settingsService.getSettings().general?.timezone
      if (typeof tz === 'string' && tz.length > 0) timezone = tz
    } catch (err) {
      console.warn('[CronService] Failed to read timezone from settings, using default:', err)
    }
    const job = cron.schedule(task.expression, () => this.executeTask(id), {
      timezone,
    })
    this.scheduledJobs.set(id, job)
    // 监听 scheduled 事件更新 nextRunAt（P1-8）
    job.on('scheduled', (next: Date) => {
      this.nextRunAt.set(id, next.toISOString())
    })
    // 初始估算：1 分钟后（保守值，会被 scheduled 事件覆盖）
    this.nextRunAt.set(id, new Date(Date.now() + 60_000).toISOString())
  }

  private unschedule(id: string) {
    this.scheduledJobs.get(id)?.stop()
    this.scheduledJobs.delete(id)
    this.nextRunAt.delete(id)
  }

  /** 执行任务 — Critical 2.2 修复: __feishu__ 路由到 executeBitableSync 而非 agentRunner
   *  High 2.3 修复: per-task 锁防止 runNow + cron 定时并发执行同一任务
   *  R57-3 H2 修复: agentRunner 加超时,默认 5 分钟,防止 LLM 挂起数小时
   *  R57-3 H3 修复: 并发上限控制,超过 maxConcurrentTasks 则跳过执行 */
  private async executeTask(taskId: string) {
    const task = this.tasks.get(taskId)
    if (!task) return
    if (!this.mainWindow) return

    // R57-3 H3 修复: 并发上限检查,超过则跳过执行并记录 skipped_concurrent_limit
    if (this.runningCount >= this.maxConcurrentTasks) {
      log('warn', 'cron', `Task ${taskId} skipped: concurrent limit reached (${this.runningCount}/${this.maxConcurrentTasks})`)
      task.lastStatus = 'skipped_concurrent_limit'
      this.pushLog({
        taskId,
        agentId: task.agentId,
        timestamp: Date.now(),
        durationMs: 0,
        status: 'skipped_concurrent_limit',
        error: `并发上限已达 (${this.runningCount}/${this.maxConcurrentTasks})`,
      })
      // 即使跳过也发送状态更新,让前端知道
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        try {
          this.mainWindow.webContents.send(IPC.IPC_CRON_STATUS_UPDATE, {
            taskId,
            lastRunAt: task.lastRunAt,
            lastStatus: task.lastStatus,
          })
        } catch {
          // 窗口可能在发送过程中被销毁，忽略
        }
      }
      return
    }

    // High 2.3 修复: per-task 锁,避免 runNow + cron 同时触发同一任务
    if (this.runningTasks.has(taskId)) {
      log('info', 'cron', `Task ${taskId} already running, skip this trigger`)
      return
    }
    this.runningTasks.add(taskId)
    // R57-3 H3 修复: 递增并发计数
    this.runningCount++

    const timestamp = Date.now()
    const startTime = Date.now()

    // R57-3 H2 修复: 从 settings 读取超时分钟数,默认 5 分钟
    let timeoutMins = 5
    try {
      const configured = settingsService.getSettings().general?.agentTimeoutMins
      if (typeof configured === 'number' && configured > 0) {
        timeoutMins = configured
      }
    } catch {
      // 读取失败保持默认 5 分钟
    }
    const timeoutMs = timeoutMins * 60 * 1000

    try {
      // Critical 2.2 修复: __feishu__ 任务路由到 executeBitableSync
      // 之前所有任务都调 agentRunner(task.agentId, ...),但 __feishu__ 不是真实 agentId,
      // agentRunner('__feishu__', ...) 必然抛 "Agent not found",真正的 executeBitableSync 从未被调用
      if (task.agentId === '__feishu__') {
        const result = await this.executeBitableSync()
        if (!result.success) {
          // 同步失败按 error 记录,但不算 throw,避免污染日志
          log('warn', 'cron', `bitable sync failed: ${result.error ?? result.skipped ?? 'unknown'}`)
          task.lastRunAt = timestamp
          task.lastStatus = 'error'
          this.pushLog({
            taskId,
            agentId: task.agentId,
            timestamp,
            durationMs: Date.now() - startTime,
            status: 'error',
            error: result.error ?? result.skipped ?? 'bitable sync failed',
          })
        } else {
          task.lastRunAt = timestamp
          task.lastStatus = 'success'
          this.pushLog({
            taskId,
            agentId: task.agentId,
            timestamp,
            durationMs: Date.now() - startTime,
            status: 'success',
          })
        }
      } else if (this.agentRunner) {
        // R57-3 H2 修复: agentRunner 加超时,Promise.race 竞速
        // 超时后记录 lastStatus: 'timeout',不调用 agent.abort(agentRunner 可能不接受)
        const agentPromise = this.agentRunner(task.agentId, task.prompt, this.mainWindow)
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error(`Agent execution timed out after ${timeoutMins}min`))
          }, timeoutMs)
        })

        try {
          await Promise.race([agentPromise, timeoutPromise])
          task.lastRunAt = timestamp
          task.lastStatus = 'success'

          this.pushLog({
            taskId,
            agentId: task.agentId,
            timestamp,
            durationMs: Date.now() - startTime,
            status: 'success',
          })
        } catch (raceErr: unknown) {
          // 判断是否是超时
          const isTimeout = raceErr instanceof Error && raceErr.message.includes('timed out')
          if (isTimeout) {
            log('warn', 'cron', `Agent execution timed out after ${timeoutMins}min for task ${taskId}`)
            task.lastRunAt = timestamp
            task.lastStatus = 'timeout'
            this.pushLog({
              taskId,
              agentId: task.agentId,
              timestamp,
              durationMs: Date.now() - startTime,
              status: 'timeout',
              error: raceErr instanceof Error ? raceErr.message : String(raceErr),
            })
          } else {
            // 非超时错误,按普通 error 处理
            throw raceErr
          }
        }
      } else {
        console.warn(`[CronService] Agent runner not set, skipping task ${taskId}`)
      }
    } catch (err: unknown) {
      task.lastRunAt = timestamp
      task.lastStatus = 'error'

      this.pushLog({
        taskId,
        agentId: task.agentId,
        timestamp,
        durationMs: Date.now() - startTime,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      // High 2.3: 释放 per-task 锁
      this.runningTasks.delete(taskId)
      // R57-3 H3 修复: 递减并发计数
      this.runningCount = Math.max(0, this.runningCount - 1)
      // 不管成功失败都发送状态更新（P1-10：被中止的 agent 也算完成了）
      // 防御: 检查窗口是否已销毁，避免未处理异常
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        try {
          this.mainWindow.webContents.send(IPC.IPC_CRON_STATUS_UPDATE, {
            taskId,
            lastRunAt: task.lastRunAt,
            lastStatus: task.lastStatus,
          })
        } catch {
          // 窗口可能在发送过程中被销毁，忽略
        }
      }
    }
  }

  // ===========================================================
  // R57-3 H1 修复: 用户任务持久化 (persistTasks + loadPersistedTasks)
  // 应用重启后用户创建的任务全丢失,因为 this.tasks 纯内存。
  // 持久化策略: 只持久化用户任务(id 不以 agent-schedule- 开头且不等于 feishu-bitable-sync),
  // 系统任务由 registerBitableSync / syncAgentSchedules 重建。
  // 使用原子写(tmp + rename),读时容错(JSON 解析失败不崩,只 log warn)。
  // ===========================================================

  /** R57-3 H1 修复: 将用户任务持久化到 {userData}/cron.user.json (原子写: atomicWrite helper)
   *  只持久化 id 不以 agent-schedule- 开头且不等于 feishu-bitable-sync 的任务,
   *  系统任务由 registerBitableSync / syncAgentSchedules 启动时重建。
   *  持久化时剥离运行时状态字段(nextRunAt / lastStatus),下次启动重新计算。 */
  private persistUserTasks(): void {
    try {
      // 只收集用户任务,排除系统任务
      const userTasks: CronTask[] = []
      for (const [id, task] of this.tasks) {
        if (!id.startsWith('agent-schedule-') && id !== 'feishu-bitable-sync') {
          // 持久化时剥离运行时状态字段,避免恢复时残留过期状态
          const { lastRunAt: _lr, lastStatus: _ls, nextRunAt: _nr, ...rest } = task
          userTasks.push(rest as CronTask)
        }
      }
      const json = JSON.stringify(userTasks, null, 2)
      // 原子写: atomicWrite(tmp + renameWithRetry),防止写一半断电导致文件损坏
      void atomicWrite(this.userTasksFilePath, json, 'utf-8')
    } catch (err) {
      // 持久化失败不阻塞主流程,仅 log warn
      log('warn', 'cron', `Failed to persist user tasks: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** R57-3 H1 修复: 从 {userData}/cron.user.json 恢复用户任务
   *  应用启动时调用(在 registerBitableSync / syncAgentSchedules 之前,避免与系统任务重建冲突)。
   *  恢复时 nextRunAt 设为 undefined(由 schedule() 重新计算),lastStatus 设为 'pending'。
   *  失败仅 log warn 不抛出。 */
  private async loadPersistedUserTasks(): Promise<void> {
    try {
      const content = await fsp.readFile(this.userTasksFilePath, 'utf-8')
      const parsed = JSON.parse(content)
      if (!Array.isArray(parsed)) {
        log('warn', 'cron', 'cron.user.json is not an array, skipping load')
        return
      }
      let restored = 0
      for (const raw of parsed) {
        if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') continue
        // 只恢复用户任务,跳过系统任务(防止旧文件中残留的系统任务被重复注册)
        if (raw.id.startsWith('agent-schedule-') || raw.id === 'feishu-bitable-sync') continue
        // R57-3 H1 修复: 恢复时重置运行时状态
        // nextRunAt 由 schedule() 重新计算; lastStatus 设为 'pending'
        const task: CronTask = {
          ...(raw as CronTask),
          nextRunAt: undefined,
          lastStatus: 'pending',
        }
        this.tasks.set(task.id, task)
        this.schedule(task.id, task)
        restored++
      }
      if (restored > 0) {
        log('info', 'cron', `R57-3 H1: Restored ${restored} user tasks from cron.user.json`)
      }
    } catch (err) {
      // 文件不存在或 JSON 解析失败: 不崩,只 log warn
      // 文件不存在是正常情况(首次使用),不记 warn
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg.includes('ENOENT')) {
        // 首次使用,无持久化文件,正常情况
        return
      }
      log('warn', 'cron', `R57-3 H1: Failed to load persisted user tasks: ${errMsg}`)
    }
  }

  private pushLog(entry: CronLogEntry) {
    this.logs.push(entry)
    // 超过 1000 条时用 shift 移除头部，避免每次 slice 创建新数组
    if (this.logs.length > 1000) {
      this.logs.shift()
    }
    // 异步持久化到磁盘（P1-9）
    // HIGH 5.2 修复: logBuffer 加大小上限,防止磁盘写入变慢时无限增长
    // 超过 5000 条时丢弃最旧的,优先保留最新日志
    if (this.logBuffer.length >= 5000) {
      this.logBuffer.splice(0, this.logBuffer.length - 4999)
    }
    this.logBuffer.push(entry)
    this.scheduleLogWrite()
  }

  /** 节流写日志：500ms 内合并 */
  private scheduleLogWrite(): void {
    if (this.logWriteTimer) return
    this.logWriteTimer = setTimeout(() => {
      this.logWriteTimer = null
      void this.flushLogs()
    }, 500)
  }

  /** 立即 flush 日志（graceful shutdown） */
  async flushLogs(): Promise<void> {
    if (this.logBuffer.length === 0) return
    const toWrite = this.logBuffer
    this.logBuffer = []
    try {
      const lines = `${toWrite.map((e) => JSON.stringify(e)).join('\n')}\n`
      await fsp.appendFile(this.logFilePath, lines, 'utf-8')
    } catch (err) {
      console.error('[CronService] Failed to persist logs:', err)
    }
  }

  /** 优雅关闭 */
  async shutdown(): Promise<void> {
    if (this.logWriteTimer) {
      clearTimeout(this.logWriteTimer)
      this.logWriteTimer = null
    }
    await this.flushLogs()
    for (const [, job] of this.scheduledJobs) {
      job.stop()
    }
  }
}

export const cronService = new CronService()
