// =============================================================
// Sidecar 入口 — 在纯 Node.js 进程里复用 Electron 主进程的全部 handlers
//
// 运行: node sidecar/edu-sidecar.mjs → require dist/sidecar/sidecar.cjs
// 构建: vite build --config vite.config.sidecar.ts
//
// 'electron' 模块由 vite resolve.alias 重定向到 ./electron-shim.ts
// =============================================================

import readline from 'node:readline'
// 先配置 shim 的出口 (事件推送 + sys 请求)
import { setOutbound } from './electron-shim'

// ============================================================
// 劫持 console.log / console.warn / console.error
// 业务 services 用 console 输出日志 (原 Electron 主进程打到终端)。
// 在 sidecar 模式下 stdout 是 JSON-RPC 通道，不能混入纯文本，
// 否则 Rust 读到非 JSON 行会报警告。所以把 console 输出包装成 log 帧。
// (stderr 保持原样，Rust 把它继承到终端)
// ============================================================
const _origStdoutWrite = process.stdout.write.bind(process.stdout)
function writeJsonLine(obj: unknown): void {
  try {
    _origStdoutWrite(`${JSON.stringify(obj)}\n`)
  } catch {
    /* ignore */
  }
}
const _origLog = console.log
const _origWarn = console.warn
const _origError = console.error
console.log = (...args: unknown[]) => {
  writeJsonLine({ type: 'console', level: 'log', data: args.map(String).join(' ') })
}
console.warn = (...args: unknown[]) => {
  writeJsonLine({ type: 'console', level: 'warn', data: args.map(String).join(' ') })
}
console.error = (...args: unknown[]) => {
  // error 也走 stdout 的 console 帧，避免污染 stderr 诊断
  writeJsonLine({ type: 'console', level: 'error', data: args.map(String).join(' ') })
  _origError(...args)
}
// 也处理 process.stdout 的直接 write (有些库绕过 console)
;(process.stdout as unknown as { write: unknown }).write = (...args: unknown[]) => {
  const chunk = args[0]
  if (typeof chunk === 'string') {
    // 如果已经是 JSON 行 (以 { 开头), 直接放行
    const trimmed = chunk.trimStart()
    if (trimmed.startsWith('{')) {
      return _origStdoutWrite(chunk)
    }
    // 否则包装成 console 帧
    if (trimmed.length > 0) {
      writeJsonLine({ type: 'console', level: 'log', data: chunk.replace(/\n$/, '') })
      return true
    }
  }
  return _origStdoutWrite(chunk as Buffer)
}

// 复用 Electron 主进程的全部注册函数与 services
// (此时 'electron' 已被 alias 替换为 shim，所以这些模块不会真正依赖 Electron)
import { registerAcademicHandlers } from '../main/ipc/academic-handlers'
import { registerAgentHandlers } from '../main/ipc/agent-handlers'
import { registerAIHandlers } from '../main/ipc/ai-handlers'
import { registerClassHandlers } from '../main/ipc/class-handlers'
import { registerCronHandlers } from '../main/ipc/cron-handlers'
import { registerEAAHandlers } from '../main/ipc/eaa-handlers'
import { registerFeishuHandlers } from '../main/ipc/feishu-handlers'
import { registerLogHandlers } from '../main/ipc/log-handlers'
import { registerMcpHandlers } from '../main/ipc/mcp-handlers'
import { registerOllamaHandlers } from '../main/ipc/ollama-handlers'
import { registerPrivacyHandlers } from '../main/ipc/privacy-handlers'
import { registerProfileHandlers } from '../main/ipc/profile-handlers'
import { registerSettingsHandlers } from '../main/ipc/settings-handlers'
import { registerSkillHandlers } from '../main/ipc/skill-handlers'
import { registerSysHandlers } from '../main/ipc/sys-handlers'
import { agentService } from '../main/services/agent-service'
import { cronService } from '../main/services/cron-service'
import { dbService } from '../main/services/db-service'
import { eaaBridge } from '../main/services/eaa-bridge'
import { feishuBotService } from '../main/services/feishu-bot-service'
import { keystoreService } from '../main/services/keystore-service'
import { settingsService } from '../main/services/settings-service'
import { BrowserWindow, getHandler, listChannels } from './electron-shim'

// ============================================================
// stdio JSON-RPC 写入 (用劫持前的原始 stdout.write，绕过 console 包装)
// ============================================================
function writeLine(obj: unknown): void {
  writeJsonLine(obj)
}

function sendLog(msg: string): void {
  writeLine({ type: 'log', data: msg })
}

// 事件出口: 往 stdout 写一行 JSON (event 帧)
const emitEvent = (channel: string, data: unknown): void => {
  writeLine({ type: 'event', channel, data })
}

// 系统请求: 往 stdout 写 sys 帧
// (简化: fire-and-forget; 真正需要阻塞结果的 dialog 由渲染层 Tauri 原生命令处理)
const sysRequest = async (
  request: string,
  args: unknown,
): Promise<{ success: boolean; data?: unknown }> => {
  writeLine({ type: 'sys', request, args })
  return { success: true }
}

setOutbound({ emitEvent, sysRequest })

// ============================================================
// 启动: 注册全部 handlers + 初始化 services
// ============================================================
async function bootstrap(): Promise<void> {
  sendLog('[sidecar] bootstrap starting...')

  // mock BrowserWindow 传给需要 win 的 handler
  const mockWin = new (BrowserWindow as unknown as new () => object)()

  // 复制 registerAllHandlers 的注册顺序 (src/main/ipc/index.ts)
  registerAIHandlers(mockWin as never)
  registerAgentHandlers(mockWin as never)
  registerEAAHandlers(mockWin as never)
  registerPrivacyHandlers(mockWin as never)
  registerCronHandlers(mockWin as never)
  registerSkillHandlers(mockWin as never)
  registerSettingsHandlers(mockWin as never)
  registerSysHandlers(mockWin as never)
  registerProfileHandlers()
  registerAcademicHandlers()
  registerLogHandlers()
  registerFeishuHandlers(mockWin as never)
  registerOllamaHandlers(mockWin as never)
  registerClassHandlers()
  registerMcpHandlers(mockWin as never)

  sendLog('[sidecar] handlers registered, initializing services...')

  // EAA Bridge 初始化 (创建数据目录、复制 reason-codes)
  try {
    const eaaStatus = await eaaBridge.initialize()
    sendLog(`[sidecar] EAA Bridge: ${eaaStatus.message}`)
  } catch (e) {
    sendLog(`[sidecar] EAA Bridge init failed: ${e}`)
  }

  // 初始化 DB
  try {
    await dbService.init()
    sendLog('[sidecar] DB initialized')
  } catch (e) {
    sendLog(`[sidecar] DB init failed: ${e}`)
  }

  // Agent 运行时初始化 (加载配置、桥接 cron)
  try {
    await agentService.init(mockWin as never)
    sendLog('[sidecar] Agent service initialized')
  } catch (e) {
    sendLog(`[sidecar] Agent service init failed: ${e}`)
  }

  // 注册 Bitable 同步 cron
  try {
    cronService.registerBitableSync()
  } catch (e) {
    sendLog(`[sidecar] Bitable sync register failed: ${e}`)
  }

  // 飞书机器人自动启动 (若已配置)
  try {
    const s = settingsService.getSettings()
    const secret = keystoreService.getSecret('feishu-app-secret')
    if (s.feishu.appId && secret) {
      feishuBotService.start(s.feishu.appId, secret, mockWin as never).catch((err: unknown) => {
        sendLog(`[sidecar] feishu bot auto-start failed: ${err}`)
      })
      sendLog(`[sidecar] feishu bot auto-starting, appId=${s.feishu.appId}`)
    }
  } catch (e) {
    sendLog(`[sidecar] feishu bot auto-start skipped: ${e}`)
  }

  const channels = listChannels()
  sendLog(`[sidecar] bootstrap complete. ${channels.length} handlers registered.`)

  // 通知 Rust 已就绪
  writeLine({ type: 'event', channel: '__sidecar__:ready', data: { channels } })

  // 性能优化: 缓存预预热
  // 在 sidecar 就绪后异步触发 EAA 读命令,填充 staticCache/rankingCache/studentsCache/scoreCache。
  // 这样用户的第一次请求 (Dashboard/Students/Classes 同时挂载时) 可直接命中缓存,
  // 避免并发 spawn 4 个 EAA 子进程 (~40-200ms/次)。
  // 预预热是 fire-and-forget,不阻塞请求循环,失败也不影响功能 (缓存未命中时会正常 spawn)。
  void preWarmCaches()

  // 进入请求循环
  startRequestLoop()
}

/**
 * 缓存预预热 — 在 sidecar 就绪后异步调用 EAA 读命令填充缓存。
 * 分两阶段:
 *   1) 并行: info/codes/list-students (互不依赖)
 *   2) ranking(10) — 复用阶段1填充的 studentsCache 做 class_id 增强,避免额外 spawn
 * Dashboard 首屏调用 eaa.ranking(10),所以预预热用 n=10 匹配最常见的 cacheKey。
 * 预预热失败静默忽略 (缓存未命中时正常路径会重新 spawn)。
 */
async function preWarmCaches(): Promise<void> {
  const start = Date.now()
  // 阶段1: 独立读命令并行
  const phase1 = ['eaa:info', 'eaa:codes', 'eaa:list-students']
  const results1 = await Promise.allSettled(
    phase1.map((ch) => {
      const handler = getHandler(ch)
      if (!handler) return Promise.reject(new Error(`no handler: ${ch}`))
      return Promise.resolve(handler({}))
    }),
  )
  // 阶段2: ranking(10) — 复用 studentsCache 做 class_id 增强
  const rankingHandler = getHandler('eaa:ranking')
  const result2 = rankingHandler
    ? await Promise.allSettled([Promise.resolve(rankingHandler({}, 10))])
    : [{ status: 'rejected' as const, reason: 'no handler' }]
  const allResults = [...results1, ...result2]
  const ok = allResults.filter((r) => r.status === 'fulfilled').length
  const fail = allResults.length - ok
  sendLog(
    `[sidecar] cache pre-warm: ${ok}/${allResults.length} ok, ${fail} failed, ${Date.now() - start}ms`,
  )
}

// ============================================================
// 请求循环 — 读 stdin 行, 分发到注册的 handler
// ============================================================
interface InvokeMessage {
  id: number
  type: string
  channel?: string
  args?: unknown[]
}

function startRequestLoop(): void {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

  rl.on('line', (line: string) => {
    if (!line || line.trim() === '') return
    let msg: InvokeMessage
    try {
      msg = JSON.parse(line)
    } catch (e) {
      sendLog(`[sidecar] invalid JSON on stdin: ${e}`)
      return
    }

    // shutdown 信号
    if (msg.type === 'shutdown') {
      sendLog('[sidecar] received shutdown, exiting...')
      void gracefulShutdown()
      return
    }

    if (msg.type !== 'invoke') {
      return
    }
    if (!msg.channel) {
      writeLine({ id: msg.id, type: 'result', ok: false, error: 'Empty channel name' })
      return
    }

    const { id, channel, args } = msg
    const handler = getHandler(channel)
    if (!handler) {
      writeLine({ id, type: 'result', ok: false, error: `No handler for channel: ${channel}` })
      return
    }

    // 调用 handler (Electron handler 签名: (_event, ...args) => Promise<any>)
    Promise.resolve()
      .then(() => handler({}, ...(Array.isArray(args) ? args : [])))
      .then(
        (data) => writeLine({ id, type: 'result', ok: true, data }),
        (err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err)
          sendLog(`[sidecar] handler "${channel}" threw: ${errMsg}`)
          writeLine({ id, type: 'result', ok: false, error: errMsg })
        },
      )
  })

  rl.on('close', () => {
    sendLog('[sidecar] stdin closed, shutting down...')
    void gracefulShutdown()
  })
}

let _shuttingDown = false
async function gracefulShutdown(): Promise<void> {
  if (_shuttingDown) return
  _shuttingDown = true
  try {
    // 先 flush 所有待写入 (settings/keystore 用了防抖保存，不 flush 会丢数据)
    const { settingsService } = await import('../main/services/settings-service')
    const { keystoreService } = await import('../main/services/keystore-service')
    // L-SIDECAR-3 修复: 加 3 秒超时保护,防止 flush 卡住导致 sidecar 无法退出
    await Promise.race([
      Promise.allSettled([
        settingsService.flush(),
        keystoreService.flush(),
        cronService.shutdown(),
        dbService.close(),
        feishuBotService.stop(),
      ]),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])
  } catch {
    /* ignore */
  }
  process.exit(0)
}

// 处理未捕获异常 — 记录但不崩 sidecar
process.on('uncaughtException', (err: unknown) => {
  sendLog(`[sidecar] uncaughtException: ${err instanceof Error ? err.stack : err}`)
})
process.on('unhandledRejection', (reason: unknown) => {
  sendLog(`[sidecar] unhandledRejection: ${reason}`)
})

void bootstrap().catch((err: unknown) => {
  sendLog(`[sidecar] bootstrap FAILED: ${err instanceof Error ? err.stack : err}`)
  process.exit(1)
})
