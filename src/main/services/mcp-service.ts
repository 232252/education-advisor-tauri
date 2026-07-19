// =============================================================
// MCP Service — Model Context Protocol client 管理器(单例)
//
// 职责:
//   - 加载 config/mcp.yaml 全局配置(含环境变量插值)
//   - 管理 MCP client 连接池(Map<serverId, MCPClient>)
//   - 按需连接/断开 server(stdio spawn / SSE / WebSocket)
//   - 提供 listToolsForAgent() 和 callTool()
//   - 生命周期管理:初始化、重连、超时、清理
//
// Feature flag: settings.mcp.enabled === false 时进入 no-op 模式
//
// 传输方式:
//   - stdio: spawn 子进程 + stdin/stdout JSON-RPC
//   - sse:   HTTP POST + EventSource(MCP SSE 传输)
//   - websocket: ws 库双向通信
//
// 安全屏障复用:
//   - 路径参数走 validateFilePath()(14 个敏感路径黑名单)
//   - 字符串参数走 sanitizeArg()(shell 元字符过滤)
//   详见 mcp-tools.ts
// =============================================================

import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import yaml from 'yaml'
import type { McpServerConfig, McpServerStatus, McpTool } from '../../shared/types'
import { atomicWrite } from '../utils/atomic-write'
import {
  deepInterpolate,
  isSafeMcpUrl,
  sanitizeObject,
  validateCommandSafe,
  validateServerConfig,
} from './mcp-helpers'
import { settingsService } from './settings-service'

/** MCP 工具调用结果(兼容 MCP 协议) */
export interface McpCallResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** 单个 MCP client 连接 */
interface MCPClient {
  serverId: string
  config: McpServerConfig
  connected: boolean
  tools: McpTool[]
  lastError?: string
  // stdio
  childProcess?: ChildProcess
  // websocket
  ws?: import('ws').WebSocket
  // 请求计数器(JSON-RPC id)
  requestId: number
  // 待响应请求 Map
  pending: Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >
  // 接收缓冲区(stdio 按行解析)
  buffer?: string
}

/** 连接超时(毫秒) */
const CONNECT_TIMEOUT_MS = 30_000
/** server id 格式(与 mcp-handlers.ts validateServerId 一致) */
const SERVER_ID_RE = /^[a-zA-Z0-9_-]+$/
/** 工具调用超时(毫秒) */
const CALL_TIMEOUT_MS = 60_000
/** 最大重连次数 */
const _MAX_RECONNECT = 3
/** 重连间隔(毫秒) */
const _RECONNECT_DELAY_MS = 1000
/** 返回内容最大大小(5MB,防止超大响应撑爆上下文) */
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024

// interpolateEnv / deepInterpolate / validateServerConfig / isSafeMcpUrl 已提取到 mcp-helpers.ts

/**
 * SSRF 防护断言(薄封装,逻辑在 mcp-helpers.isSafeMcpUrl 纯函数,便于单测)。
 * R4-SSRF-1 修复:防止 sidecar 被诱导连接云元数据服务或扫描内网。
 */
function assertSafeMcpUrl(rawUrl: string | undefined, serverId: string): void {
  if (!isSafeMcpUrl(rawUrl)) {
    throw new Error(
      `MCP server ${serverId} url refused (SSRF protection): ${rawUrl ?? '(missing)'}`,
    )
  }
}

class McpService {
  private clients: Map<string, MCPClient> = new Map()
  private config: McpServerConfig[] = []
  private configPath: string
  private initialized = false
  /** 写操作串行队列(防止 add/update/remove 并发竞态) */
  private writeQueue: Promise<unknown> = Promise.resolve()
  /**
   * 每个 serverId 的"正在连接"互斥锁(R1-3 / B1 修复)。
   * 并发 ensureConnected 同一 server 时,后续调用方复用同一个进行中的连接 Promise,
   * 避免产生重复子进程 / 孤儿进程。
   */
  private connecting: Map<string, Promise<MCPClient>> = new Map()

  constructor() {
    const devConfigDir = path.join(__dirname, '..', '..', 'config')
    const prodConfigDir = path.join(process.resourcesPath || '', 'config')
    const configDir = fs.existsSync(devConfigDir) ? devConfigDir : prodConfigDir
    this.configPath = path.join(configDir, 'mcp.yaml')
  }

  /**
   * 初始化:加载 mcp.yaml 配置
   * 不实际连接 server(惰性连接,Agent 启用时才连)
   */
  async init(): Promise<void> {
    if (this.initialized) return

    // Feature flag 检查
    const settings = settingsService.getSettings()
    const mcpEnabled = settings?.mcp?.enabled === true
    if (!mcpEnabled) {
      console.log('[McpService] MCP feature flag disabled, entering no-op mode')
      this.initialized = true
      return
    }

    await this.loadConfig()
    this.initialized = true
    console.log(`[McpService] Initialized with ${this.config.length} server configs`)
  }

  /**
   * 加载配置:全局 mcp.yaml + 用户级 mcp.user.yaml(用户覆盖全局同 id)
   */
  private async loadConfig(): Promise<void> {
    const globalServers = await this.loadConfigFile(this.configPath, 'global')
    // 每次加载时按当前 userData 解析,避免单例构造期缓存过期路径
    const userPath = path.join(app.getPath('userData'), 'mcp.user.yaml')
    const userServers = await this.loadConfigFile(userPath, 'user')

    // 合并:用户级整条覆盖同 id 的全局项
    const byId = new Map<string, McpServerConfig>()
    for (const s of globalServers) byId.set(s.id, s)
    for (const s of userServers) byId.set(s.id, s) // user 覆盖 global
    this.config = Array.from(byId.values())
    console.log(
      `[McpService] Loaded ${globalServers.length} global + ${userServers.length} user servers → ${this.config.length} total`,
    )
  }

  /**
   * 读单个 yaml 文件并解析为带 source 标记的 server 列表
   */
  private async loadConfigFile(
    filePath: string,
    source: 'global' | 'user',
  ): Promise<McpServerConfig[]> {
    try {
      const content = await fsp.readFile(filePath, 'utf-8')
      const parsed = yaml.parse(content)
      const servers = parsed?.servers
      if (!Array.isArray(servers)) return []
      // R1-10 / B6 修复: 这里不再 .filter((s) => s.enabled) —— 否则 addServer 写入的
      // enabled:false server 在下次 reloadConfig/loadConfig 时会被静默丢弃,造成
      // 内存与磁盘不一致。enabled 由 UI 层展示开关,listServers 仍列出全部以便用户重新启用。
      return servers
        .filter(validateServerConfig)
        .map((s) => deepInterpolate(sanitizeObject({ ...s, source })))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      console.warn(`[McpService] Failed to load ${filePath}:`, err)
      return []
    }
  }

  /**
   * 重新加载配置(配置文件变更时调用)。
   *
   * R1-10 / B7 修复: 走 serializeWrite,避免与并发 add/update/remove 竞态
   * (reloadConfig 直接 loadConfig 会用磁盘旧状态覆盖内存新状态)。
   */
  async reloadConfig(): Promise<void> {
    return this.serializeWrite(async () => {
      // 断开所有现有连接
      await this.disconnectAll()
      // R5-1 / 泄漏 #3 修复: 清理进行中的连接锁,避免 inflight doConnect 在
      // disconnectAll 后又把 stale client 插回 this.clients(用旧 config)。
      this.connecting.clear()
      this.config = []
      this.initialized = false
      await this.init()
    })
  }

  /**
   * 列出所有配置的 server 及其状态
   */
  listServers(): McpServerStatus[] {
    return this.config.map((c) => {
      const client = this.clients.get(c.id)
      return {
        id: c.id,
        name: c.name,
        connected: client?.connected ?? false,
        toolCount: client?.tools.length ?? 0,
        lastError: client?.lastError,
        transport: c.transport,
        source: c.source ?? 'global',
        enabled: c.enabled,
      }
    })
  }

  /**
   * 新增 server(写入 mcp.user.yaml)
   * 校验:id 唯一、配置合法、command 安全
   */
  async addServer(config: McpServerConfig): Promise<void> {
    return this.serializeWrite(() => this.addServerInternal(config))
  }

  /** addServer 的串行化实现 */
  private async addServerInternal(config: McpServerConfig): Promise<void> {
    if (!validateServerConfig(config)) {
      throw new Error('Invalid server config')
    }
    // R4-EDGE-MCP-ID 修复: id 格式校验,与 mcp-handlers.ts 的 validateServerId 一致
    // 防止 add 接受非法 id 但 remove/update 拒绝,形成不可删除的脏配置
    if (!SERVER_ID_RE.test(config.id)) {
      throw new Error(
        `Server id "${config.id}" contains invalid characters (only a-zA-Z0-9_- allowed)`,
      )
    }
    if (this.config.some((s) => s.id === config.id)) {
      throw new Error(`Server ${config.id} already exists`)
    }
    if (config.transport === 'stdio' && !validateCommandSafe(config.command)) {
      throw new Error(`Server ${config.id} command failed safety check`)
    }
    // R5-ERR-2 修复: sse/websocket 的 URL 在 add 时也校验 SSRF(不只是 connect 时),
    // 防止 file:// 等危险 URL 写入 mcp.user.yaml
    if (config.transport !== 'stdio' && !isSafeMcpUrl(config.url)) {
      throw new Error(`Server ${config.id} url failed SSRF check`)
    }
    // 读取现有 user 配置 + 追加
    const userServers = await this.readUserConfig()
    // R1-5 / B5 修复: 净化原型污染 key 后再落盘/合并,防止 __proto__ 等注入
    const newServer: McpServerConfig = sanitizeObject({ ...config, source: 'user' })
    userServers.push(newServer)
    await this.writeUserConfig(userServers)
    // 更新内存
    this.config.push(newServer)
    console.log(`[McpService] Added server ${config.id}`)
  }

  /**
   * 把写操作串行化执行(防止并发 add/update/remove 竞态)
   * 每个操作等前一个完成后再开始
   *
   * 关键:
   *   - run = writeQueue.then(fn, fn) — 即使前一个操作 reject,本操作也能基于
   *     已 settle 的队列开始(reject/recover 都会触发 .then 的第2个 handler)
   *   - writeQueue = run.then(_, _)  — 即使本操作 reject,后续操作依然能排队
   *     (catch 会吞掉 reject,否则后续 addServer 会卡死)
   */
  private async serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn)
    // 关键: 即使 fn 失败也要让队列继续(reject 不应阻塞后续操作)
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 更新 server(用户级直接改;全局级复制覆盖到 user)
   */
  async updateServer(id: string, patch: Partial<McpServerConfig>): Promise<void> {
    return this.serializeWrite(() => this.updateServerInternal(id, patch))
  }

  /** updateServer 的串行化实现 */
  private async updateServerInternal(id: string, patch: Partial<McpServerConfig>): Promise<void> {
    const existing = this.config.find((s) => s.id === id)
    if (!existing) throw new Error(`Server ${id} not found`)

    // 若 command 被改,校验安全性
    if (patch.command !== undefined && !validateCommandSafe(patch.command)) {
      throw new Error(`Server ${id} command failed safety check`)
    }

    // R5-ERR-2 修复: patch 含 url → 校验 SSRF;
    // patch 改为非 stdio transport → 校验 existing.url(新 transport 会用到它)
    // 注意:patch 同时含 transport + url 时,patch.url 优先(校验 patch.url 即可)
    if (patch.url !== undefined) {
      if (!isSafeMcpUrl(patch.url)) {
        throw new Error(`Server ${id} url failed SSRF check`)
      }
    } else if (
      patch.transport !== undefined &&
      patch.transport !== 'stdio' &&
      !isSafeMcpUrl(existing.url)
    ) {
      throw new Error(`Server ${id} url failed SSRF check`)
    }

    // 若正在连接,先断开(新配置下次连接生效)。
    // 注意: 这里直接调 disconnectClient 而非 disconnectServer,因为本方法已运行在
    // serializeWrite 队列内,若再调 disconnectServer(也入队)会造成队列自等待死锁。
    if (this.clients.has(id)) {
      const inflight = this.connecting.get(id)
      if (inflight) {
        try {
          await inflight
        } catch {
          // 忽略连接失败,继续清理
        }
      }
      const client = this.clients.get(id)
      if (client) {
        await this.disconnectClient(client)
        this.clients.delete(id)
      }
    }

    const userServers = await this.readUserConfig()
    const userIdx = userServers.findIndex((s) => s.id === id)

    // R1-5 / B5 修复: 净化 patch 的原型污染 key,再 spread 合并
    const safePatch = sanitizeObject({ ...patch })
    if (existing.source === 'user' || userIdx >= 0) {
      // 已是用户级(或覆盖过),直接 patch user 配置中的对应条目
      if (userIdx >= 0) {
        userServers[userIdx] = sanitizeObject({
          ...userServers[userIdx],
          ...safePatch,
          source: 'user',
        })
      } else {
        // 内存中是 user 但文件里没有(异常情况),追加
        userServers.push(sanitizeObject({ ...existing, ...safePatch, source: 'user' }))
      }
    } else {
      // 全局项首次覆盖:复制到 user 级 + 应用 patch + 标记 overrides
      userServers.push(
        sanitizeObject({ ...existing, ...safePatch, source: 'user', overrides: 'global' }),
      )
    }
    await this.writeUserConfig(userServers)

    // 更新内存 config
    const idx = this.config.findIndex((s) => s.id === id)
    if (idx >= 0) {
      this.config[idx] = sanitizeObject({ ...this.config[idx], ...safePatch, source: 'user' })
    }
    console.log(`[McpService] Updated server ${id}`)
  }

  /**
   * 删除 server
   * - 纯用户级:从 mcp.user.yaml 删除
   * - 覆盖全局产生的用户级:删除覆盖,恢复全局默认(overrides='global')
   * - 纯全局:拒绝
   */
  async removeServer(id: string): Promise<void> {
    return this.serializeWrite(() => this.removeServerInternal(id))
  }

  /** removeServer 的串行化实现 */
  private async removeServerInternal(id: string): Promise<void> {
    const existing = this.config.find((s) => s.id === id)
    if (!existing) throw new Error(`Server ${id} not found`)

    // 断开连接。
    // 同 updateServerInternal: 不调 disconnectServer(避免队列自等待),直接清理。
    if (this.clients.has(id)) {
      const inflight = this.connecting.get(id)
      if (inflight) {
        try {
          await inflight
        } catch {
          // 忽略连接失败,继续清理
        }
      }
      const client = this.clients.get(id)
      if (client) {
        await this.disconnectClient(client)
        this.clients.delete(id)
      }
    }

    const userServers = await this.readUserConfig()
    const userIdx = userServers.findIndex((s) => s.id === id)

    if (userIdx < 0) {
      // 不在 user yaml 里 = 纯全局项
      throw new Error(`Server ${id} is global (read-only), cannot remove`)
    }

    const userEntry = userServers[userIdx]
    userServers.splice(userIdx, 1)
    await this.writeUserConfig(userServers)

    // 更新内存
    if (userEntry.overrides === 'global') {
      // 恢复全局默认:重新加载该项
      const globalServers = await this.loadConfigFile(this.configPath, 'global')
      const globalEntry = globalServers.find((s) => s.id === id)
      const idx = this.config.findIndex((s) => s.id === id)
      if (globalEntry && idx >= 0) {
        this.config[idx] = globalEntry
      } else if (idx >= 0) {
        this.config.splice(idx, 1)
      }
      console.log(`[McpService] Removed override for ${id}, restored global default`)
    } else {
      // 纯用户级,直接从内存删除
      const idx = this.config.findIndex((s) => s.id === id)
      if (idx >= 0) this.config.splice(idx, 1)
      console.log(`[McpService] Removed server ${id}`)
    }
  }

  /**
   * 读取 mcp.user.yaml 的 server 列表(不过滤 enabled,保留全部以便编辑)
   */
  private async readUserConfig(): Promise<McpServerConfig[]> {
    try {
      const userPath = path.join(app.getPath('userData'), 'mcp.user.yaml')
      const content = await fsp.readFile(userPath, 'utf-8')
      const parsed = yaml.parse(content)
      const servers = parsed?.servers
      if (!Array.isArray(servers)) return []
      return servers.filter(validateServerConfig)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      console.warn('[McpService] Failed to read user config:', err)
      return []
    }
  }

  /**
   * 写入 mcp.user.yaml(原子写:tmp + rename)
   */
  private async writeUserConfig(servers: McpServerConfig[]): Promise<void> {
    // 大小上限 1MB
    const payload = `\
# Education Advisor MCP 用户配置
# 此文件由 UI 自动生成,主配置文件 config/mcp.yaml 不会被修改
# 仅记录用户添加或覆盖的 MCP server
${yaml.stringify({ servers })}
`
    if (Buffer.byteLength(payload, 'utf-8') > 1024 * 1024) {
      throw new Error('mcp.user.yaml exceeds 1MB limit')
    }
    const userPath = path.join(app.getPath('userData'), 'mcp.user.yaml')
    await atomicWrite(userPath, payload, 'utf-8')
  }

  /**
   * 获取 Agent 可用的所有 MCP 工具
   * 合并三层配置:全局 mcp.yaml + Agent 级 mcpServers + 技能级临时 server
   */
  async listToolsForAgent(
    agentId: string,
    agentMcpServers?: string[],
    skillMcpServers?: McpServerConfig[],
  ): Promise<McpTool[]> {
    if (!this.initialized) await this.init()

    // Feature flag 关闭时返回空
    const settings = settingsService.getSettings()
    if (settings?.mcp?.enabled !== true) return []

    // 合并 server 列表:Agent 级引用全局 + 技能级临时
    const serversToConnect: McpServerConfig[] = []

    // 1. Agent 级启用的全局 server
    if (agentMcpServers && agentMcpServers.length > 0) {
      for (const serverId of agentMcpServers) {
        const globalServer = this.config.find((s) => s.id === serverId)
        if (globalServer) {
          serversToConnect.push(globalServer)
        } else {
          // R8-5 修复: 引用不存在的 server 时记录警告(之前静默跳过,用户 typo 无信号)
          console.warn(
            `[McpService] Agent ${agentId} referenced missing MCP server "${serverId}", skipped`,
          )
        }
      }
    }

    // 2. 技能级临时 server(优先级高,覆盖同名全局 server)
    // ⚠️ 未接线(NOT WIRED): 此分支目前是死代码。
    //   - skill-service.ts 不解析 SKILL.md frontmatter 的 mcp_servers 字段
    //   - agent-service.ts:699 调 getMcpToolsForAgent 时只传 2 个参数,第三参恒为 undefined
    //   设计文档(specs/2026-07-17-skills-mcp-hub-design.md §7)明确本次不做技能级 MCP。
    //   保留此分支是为了未来接线时三层合并逻辑已就绪。若要启用,需:
    //   1) skill-service.ts 解析 frontmatter mcp_servers → Skill.mcpServers
    //   2) agent-service.ts 把激活技能的 mcpServers 传给 getMcpToolsForAgent 第三参
    if (skillMcpServers && skillMcpServers.length > 0) {
      for (const skillServer of skillMcpServers) {
        // 移除同名的全局 server
        const idx = serversToConnect.findIndex((s) => s.id === skillServer.id)
        if (idx >= 0) serversToConnect.splice(idx, 1)
        serversToConnect.push(skillServer)
      }
    }

    // 惰性连接 + 收集工具
    const allTools: McpTool[] = []
    for (const server of serversToConnect) {
      try {
        const client = await this.ensureConnected(server)
        allTools.push(...client.tools)
      } catch (err) {
        console.warn(
          `[McpService] Failed to connect server ${server.id} for agent ${agentId}:`,
          err,
        )
        // 不阻塞其他 server,继续收集
      }
    }
    return allTools
  }

  /**
   * 调用 MCP 工具。
   *
   * R2-2 修复: 若 client 存在但已断开(child exit / ws close),尝试惰性重连一次,
   * 而非直接抛 "not connected" 让调用方永久失败直到重启。
   * 重连失败才抛错。这覆盖了 stdio 子进程崩溃后 Agent 下次调用自动恢复的场景。
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    let client = this.clients.get(serverId)
    if (!client?.connected) {
      // 惰性重连: 找到配置则重连,无配置才抛错
      const serverConfig = this.config.find((s) => s.id === serverId)
      if (!serverConfig) {
        throw new Error(`MCP server ${serverId} not connected and no config to reconnect`)
      }
      try {
        client = await this.ensureConnected(serverConfig)
      } catch (err) {
        throw new Error(`MCP server ${serverId} reconnect failed: ${(err as Error).message}`)
      }
    }
    return this.callToolInternal(client, toolName, args)
  }

  /**
   * 连接指定 server(手动连接,IPC 调用)。
   *
   * R1-10 / B8 修复: 走 serializeWrite,避免与 update 的"先断开再合并"竞态
   * (否则 update 写新配置→断开旧连接之间,connect 可能读新配置连上,随后被 update 的断开杀掉)。
   */
  async connectServer(serverId: string): Promise<void> {
    return this.serializeWrite(async () => {
      const serverConfig = this.config.find((s) => s.id === serverId)
      if (!serverConfig) {
        throw new Error(`MCP server ${serverId} not found in config`)
      }
      await this.ensureConnected(serverConfig)
    })
  }

  /**
   * 断开指定 server。
   * 同样走 serializeWrite,与 connect/update 的断开顺序保持一致。
   */
  async disconnectServer(serverId: string): Promise<void> {
    return this.serializeWrite(async () => {
      // 若该 server 正在连接中,先等连接结束再断开,避免留下半连接
      const inflight = this.connecting.get(serverId)
      if (inflight) {
        try {
          await inflight
        } catch {
          // 连接失败也无所谓,下面正常清理
        }
      }
      const client = this.clients.get(serverId)
      if (!client) return
      await this.disconnectClient(client)
      this.clients.delete(serverId)
    })
  }

  /**
   * 列出指定 server 的工具
   */
  async listTools(serverId: string): Promise<McpTool[]> {
    const client = this.clients.get(serverId)
    if (!client?.connected) return []
    return client.tools
  }

  /**
   * 测试 server 连通性(连接 + listTools + 不调用任何工具)
   */
  async testServer(
    serverId: string,
  ): Promise<{ success: boolean; toolCount: number; error?: string }> {
    try {
      const serverConfig = this.config.find((s) => s.id === serverId)
      if (!serverConfig) {
        return { success: false, toolCount: 0, error: `Server ${serverId} not found` }
      }
      const client = await this.ensureConnected(serverConfig)
      return { success: true, toolCount: client.tools.length }
    } catch (err) {
      return { success: false, toolCount: 0, error: (err as Error).message }
    }
  }

  /**
   * 确保 server 已连接(惰性连接)。
   *
   * R1-3 / B1 修复: 用 per-serverId 互斥锁串行化连接。
   * 并发调用同一 server 时,第二个调用方会 await 同一个进行中的连接 Promise,
   * 而不是各自走 check→disconnect→connect 流程(否则会产生重复子进程、孤儿进程)。
   */
  private async ensureConnected(server: McpServerConfig): Promise<MCPClient> {
    // 已连接:直接复用
    const existing = this.clients.get(server.id)
    if (existing?.connected) return existing

    // 已有进行中的连接:复用同一 Promise(关键: 防并发重复 spawn)
    const inflight = this.connecting.get(server.id)
    if (inflight) return inflight

    // 发起新连接,把 Promise 缓存,无论成功失败都清理
    const p = this.doConnect(server).finally(() => {
      this.connecting.delete(server.id)
    })
    this.connecting.set(server.id, p)
    return p
  }

  /** ensureConnected 的实际连接实现(由 ensureConnected 保证单线程进入) */
  private async doConnect(server: McpServerConfig): Promise<MCPClient> {
    const existing = this.clients.get(server.id)
    if (existing?.connected) return existing
    if (existing) await this.disconnectClient(existing)

    const client: MCPClient = {
      serverId: server.id,
      config: server,
      connected: false,
      tools: [],
      requestId: 1,
      pending: new Map(),
    }

    // R5-1 / 泄漏 #2 修复: connectTransport 可能在 spawn/ws.open 之后再失败
    // (initialize 握手超时/错误/transport closed)。此时 client.childProcess/ws 已存在,
    // 但 client 还没进 this.clients,disconnectAll 看不到 → 子进程/ws 泄漏。
    // 这里用 try/catch 包裹,失败时主动 disconnectClient 清理已持有的 transport 资源。
    try {
      await this.connectTransport(client, server)
    } catch (err) {
      // 清理已 spawn 的子进程 / 已打开的 ws,避免泄漏
      try {
        await this.disconnectClient(client)
      } catch {
        // 清理失败不掩盖原始连接错误
      }
      throw err
    }
    this.clients.set(server.id, client)

    // 连接成功后列出工具
    try {
      const tools = await this.requestListTools(client)
      client.tools = tools
      console.log(`[McpService] Server ${server.id} connected, ${tools.length} tools available`)
    } catch (err) {
      console.warn(`[McpService] Server ${server.id} connected but listTools failed:`, err)
      client.lastError = `listTools failed: ${(err as Error).message}`
    }

    return client
  }

  /**
   * 根据传输方式连接
   */
  private async connectTransport(client: MCPClient, server: McpServerConfig): Promise<void> {
    // R4-SSRF-1 修复: sse/websocket 连接前校验 URL,拒绝内网/云元数据地址
    if (server.transport === 'sse' || server.transport === 'websocket') {
      assertSafeMcpUrl(server.url, server.id)
    }
    const connectPromise = (() => {
      switch (server.transport) {
        case 'stdio':
          return this.connectStdio(client, server)
        case 'sse':
          return this.connectSse(client, server)
        case 'websocket':
          return this.connectWebSocket(client, server)
        default:
          return Promise.reject(new Error(`Unsupported transport: ${server.transport}`))
      }
    })()

    // 连接超时。
    // R5-1 / 泄漏 #1 修复: 成功连接后主动 clearTimeout,避免 timer 持有 reject 闭包
    // 长达 CONNECT_TIMEOUT_MS(此前每次成功 connect 都会泄漏一个 30s timer)。
    let connectTimer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        connectPromise,
        new Promise<never>((_, reject) => {
          connectTimer = setTimeout(
            () => reject(new Error(`Connect timeout after ${CONNECT_TIMEOUT_MS}ms`)),
            CONNECT_TIMEOUT_MS,
          )
        }),
      ])
    } finally {
      if (connectTimer) clearTimeout(connectTimer)
    }

    client.connected = true
  }

  /**
   * stdio 传输:spawn 子进程 + stdin/stdout JSON-RPC
   */
  private connectStdio(client: MCPClient, server: McpServerConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!server.command) {
        reject(new Error(`stdio server ${server.id} missing command`))
        return
      }
      // R52 修复: sidecar 的 PATH 不含用户系统的 npm/npx 路径,
      // 导致 spawn npx 报 ENOENT。用 buildSpawnEnv 合并常见 Node.js 安装路径,
      // 用 resolveSpawnCommand 在 Windows 上解析 npx → npx.cmd / npx.ps1。
      const env = this.buildSpawnEnv(server.env)
      const resolvedCommand = this.resolveSpawnCommand(server.command, env)
      const child = spawn(resolvedCommand, server.args || [], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })

      client.childProcess = child
      client.buffer = ''

      child.on('error', (err) => {
        client.lastError = `spawn error: ${err.message}`
        reject(err)
      })

      child.on('exit', (code, signal) => {
        if (!client.connected) {
          reject(new Error(`stdio server exited before connect (code=${code}, signal=${signal})`))
          return
        }
        console.warn(
          `[McpService] stdio server ${server.id} exited (code=${code}, signal=${signal})`,
        )
        client.connected = false
        // 拒绝所有待响应请求
        for (const [, entry] of client.pending) {
          clearTimeout(entry.timer)
          entry.reject(new Error(`Server exited (code=${code})`))
        }
        client.pending.clear()
      })

      child.stdout?.on('data', (chunk: Buffer) => {
        if (!client.buffer) client.buffer = ''
        client.buffer += chunk.toString('utf-8')
        // 按行解析 JSON-RPC
        let newlineIdx = client.buffer.indexOf('\n')
        while (newlineIdx >= 0) {
          const line = client.buffer.slice(0, newlineIdx).trim()
          client.buffer = client.buffer.slice(newlineIdx + 1)
          if (line) this.handleJsonRpcMessage(client, line)
          newlineIdx = client.buffer.indexOf('\n')
        }
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8').trim()
        if (text) console.warn(`[McpService] stdio ${server.id} stderr: ${text}`)
      })

      // 发送 initialize 请求
      this.sendJsonRpc(client, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'education-advisor', version: '1.0.0' },
      })
        .then(() => {
          // 发送 initialized 通知
          this.sendNotification(client, 'notifications/initialized', {})
          resolve()
        })
        .catch(reject)
    })
  }

  /**
   * SSE 传输:使用 HTTP POST 发送请求
   * 注意:完整 SSE 传输需要 EventSource 接收 server 推送
   * 这里实现简化版:POST 请求/响应模式(适用于大多数 MCP SSE server)
   */
  private async connectSse(client: MCPClient, server: McpServerConfig): Promise<void> {
    if (!server.url) throw new Error(`sse server ${server.id} missing url`)

    // 验证 URL 可达性(发送 initialize 请求)
    const response = await fetch(server.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...server.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: client.requestId++,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'education-advisor', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    })

    if (!response.ok) {
      throw new Error(
        `SSE server ${server.id} responded ${response.status}: ${response.statusText}`,
      )
    }

    // 存储连接信息(SSE 使用 fetch 发送每个请求)
    client.lastError = undefined
  }

  /**
   * WebSocket 传输:使用 ws 库
   */
  private connectWebSocket(client: MCPClient, server: McpServerConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      void (async () => {
        if (!server.url) {
          reject(new Error(`websocket server ${server.id} missing url`))
          return
        }
        try {
          const { default: WebSocket } = await import('ws')
          const ws = new WebSocket(server.url, { headers: server.headers })
          client.ws = ws

          const timeout = setTimeout(() => {
            reject(new Error(`WebSocket connect timeout after ${CONNECT_TIMEOUT_MS}ms`))
            ws.close()
          }, CONNECT_TIMEOUT_MS)

          ws.on('open', () => {
            clearTimeout(timeout)
            // 发送 initialize 请求
            this.sendJsonRpc(client, 'initialize', {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'education-advisor', version: '1.0.0' },
            })
              .then(() => {
                this.sendNotification(client, 'notifications/initialized', {})
                resolve()
              })
              .catch(reject)
          })

          ws.on('message', (...args: unknown[]) => {
            const raw = args[0] as Buffer
            const text = raw.toString('utf-8').trim()
            if (text) this.handleJsonRpcMessage(client, text)
          })

          ws.on('error', (...args: unknown[]) => {
            const err = args[0] as Error
            clearTimeout(timeout)
            client.lastError = `ws error: ${err.message}`
            if (!client.connected) reject(err)
            else {
              client.connected = false
              // 拒绝所有待响应请求
              for (const [, entry] of client.pending) {
                clearTimeout(entry.timer)
                entry.reject(new Error(`WebSocket error: ${err.message}`))
              }
              client.pending.clear()
            }
          })

          ws.on('close', () => {
            console.warn(`[McpService] websocket server ${server.id} closed`)
            client.connected = false
            for (const [, entry] of client.pending) {
              clearTimeout(entry.timer)
              entry.reject(new Error('WebSocket closed'))
            }
            client.pending.clear()
          })
        } catch (err) {
          reject(err)
        }
      })()
    })
  }

  /**
   * 发送 JSON-RPC 请求(stdio/websocket)
   */
  private sendJsonRpc(client: MCPClient, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = client.requestId++
      const message = JSON.stringify({ jsonrpc: '2.0', id, method, params })

      const timer = setTimeout(() => {
        client.pending.delete(id)
        reject(new Error(`Request ${method} timeout after ${CALL_TIMEOUT_MS}ms`))
      }, CALL_TIMEOUT_MS)

      client.pending.set(id, { resolve, reject, timer })

      if (client.childProcess?.stdin?.writable) {
        client.childProcess.stdin.write(`${message}\n`)
      } else if (client.ws?.readyState === 1 /* OPEN */) {
        client.ws.send(message)
      } else {
        clearTimeout(timer)
        client.pending.delete(id)
        reject(new Error(`Server ${client.serverId} not writable (transport closed)`))
      }
    })
  }

  /**
   * 发送 JSON-RPC 通知(无 id,无响应)
   */
  private sendNotification(client: MCPClient, method: string, params: unknown): void {
    const message = JSON.stringify({ jsonrpc: '2.0', method, params })
    if (client.childProcess?.stdin?.writable) {
      client.childProcess.stdin.write(`${message}\n`)
    } else if (client.ws?.readyState === 1) {
      client.ws.send(message)
    }
  }

  /**
   * 处理 JSON-RPC 响应消息
   */
  private handleJsonRpcMessage(client: MCPClient, raw: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      console.warn(`[McpService] Invalid JSON from server ${client.serverId}: ${raw.slice(0, 200)}`)
      return
    }

    const m = msg as { id?: number; result?: unknown; error?: { message: string }; method?: string }
    // 响应(有 id)
    if (m.id !== undefined && client.pending.has(m.id)) {
      const entry = client.pending.get(m.id)
      if (!entry) return
      client.pending.delete(m.id)
      clearTimeout(entry.timer)
      if (m.error) {
        entry.reject(new Error(m.error.message || 'JSON-RPC error'))
      } else {
        entry.resolve(m.result)
      }
    }
    // 通知/请求(无 id 或有 method)— 当前不处理 server→client 请求
  }

  /**
   * 请求工具列表。
   *
   * R1-2 / B3 修复: SSE 传输没有 stdin/ws 通道,sendJsonRpc 对 SSE 会直接 reject
   * "transport closed",导致 SSE server 静默显示"已连接 0 工具"。
   * 这里对 SSE 单独走 HTTP POST(与 callToolSse 同一通道)。
   */
  private async requestListTools(client: MCPClient): Promise<McpTool[]> {
    const result = await this.requestListToolsInternal(client)
    const typed = result as {
      tools?: Array<{ name: string; description?: string; inputSchema?: object }>
    }
    if (!typed?.tools) return []
    return typed.tools.map((t) => ({
      serverId: client.serverId,
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || {},
    }))
  }

  /** requestListTools 的分派实现: SSE 走 HTTP,stdio/websocket 走 JSON-RPC */
  private async requestListToolsInternal(client: MCPClient): Promise<unknown> {
    if (client.config.transport === 'sse') {
      return this.requestSse(client, 'tools/list', {})
    }
    return this.sendJsonRpc(client, 'tools/list', {})
  }

  /**
   * SSE 通用 JSON-RPC 请求(HTTP POST)。
   * R1-2 / B3: 让 listTools 与 callTool 共用同一 SSE 通道。
   */
  private async requestSse(
    client: MCPClient,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    if (!client.config.url) {
      throw new Error(`sse server ${client.serverId} missing url`)
    }
    const response = await fetch(client.config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...client.config.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: client.requestId++,
        method,
        params,
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`SSE ${method} failed: ${response.status} ${response.statusText}`)
    }
    const msg = (await response.json()) as { result?: unknown; error?: { message: string } }
    if (msg.error) throw new Error(msg.error.message)
    return msg.result
  }

  /**
   * 内部工具调用实现
   */
  private async callToolInternal(
    client: MCPClient,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    // SSE 传输使用 HTTP POST
    if (client.config.transport === 'sse') {
      return this.callToolSse(client, toolName, args)
    }

    // stdio / websocket 使用 JSON-RPC
    const result = (await this.sendJsonRpc(client, 'tools/call', {
      name: toolName,
      arguments: args,
    })) as McpCallResult | undefined

    if (!result) {
      return { content: [{ type: 'text', text: '(empty result)' }] }
    }

    // 大小限制
    const resultStr = JSON.stringify(result)
    if (resultStr.length > MAX_RESPONSE_SIZE) {
      return {
        content: [
          {
            type: 'text',
            text: `响应过大 (${(resultStr.length / 1024 / 1024).toFixed(1)} MB),超过 ${MAX_RESPONSE_SIZE / 1024 / 1024} MB 上限`,
          },
        ],
        isError: true,
      }
    }

    return result
  }

  /**
   * SSE 工具调用(HTTP POST)
   */
  private async callToolSse(
    client: MCPClient,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    if (!client.config.url) {
      throw new Error(`sse server ${client.serverId} missing url`)
    }
    const response = await fetch(client.config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...client.config.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: client.requestId++,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })

    if (!response.ok) {
      throw new Error(`SSE callTool ${toolName} failed: ${response.status}`)
    }

    const msg = (await response.json()) as { result?: McpCallResult; error?: { message: string } }
    if (msg.error) throw new Error(msg.error.message)
    return msg.result || { content: [{ type: 'text', text: '(empty)' }] }
  }

  /**
   * 断开单个 client
   */
  private async disconnectClient(client: MCPClient): Promise<void> {
    client.connected = false

    // 清理 pending
    for (const [, entry] of client.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Client disconnected'))
    }
    client.pending.clear()

    // stdio: kill 子进程
    // R4-MAP-LEAK-3 修复: 用局部变量捕获 childProcess,避免 setTimeout 触发时
    // client.childProcess 已被置 undefined 导致可选链 no-op,SIGKILL fallback 永不执行
    const cp = client.childProcess
    if (cp) {
      try {
        cp.kill('SIGTERM')
        // 给 1s 优雅退出,然后 SIGKILL
        const killTimer = setTimeout(() => {
          if (!cp.killed) {
            cp.kill('SIGKILL')
          }
        }, 1000)
        // R1-10 / B10 修复: unref 让该 timer 不阻止进程优雅退出
        // (SIGTERM 成功但子进程不 emit exit 的极端情况下,避免事件循环多挂 1s)
        killTimer.unref?.()
        // 子进程已退出则清理 timer,避免内存泄漏
        cp.once('exit', () => clearTimeout(killTimer))
      } catch {
        // ignore
      }
      client.childProcess = undefined
    }

    // websocket: close
    if (client.ws) {
      try {
        client.ws.close()
      } catch {
        // ignore
      }
      client.ws = undefined
    }
  }

  /**
   * 构建 spawn 子进程的 env,合并常见 Node.js 安装路径到 PATH。
   *
   * R52 修复: sidecar 由 Tauri Rust 启动,用打包的 node.exe,其 PATH 不包含
   * 用户系统的 npm/npx 路径。当 MCP server 配置用 `npx -y @modelcontextprotocol/server-echo`
   * 时,spawn 报 `spawn npx ENOENT`。
   *
   * 策略:在当前 process.env.PATH 基础上追加平台相关的 Node.js 常见安装路径,
   * 仅传给 spawn 的 env,不改全局 process.env.PATH。
   * 合并失败时 graceful:log warn 后返回原始 env,不阻塞 spawn。
   */
  private buildSpawnEnv(serverEnv?: Record<string, string>): Record<string, string> {
    // 从 process.env 浅拷贝(避免全局副作用),再叠加 server 级 env
    const env: Record<string, string> = { ...process.env as Record<string, string>, ...serverEnv }

    try {
      const extraPaths: string[] = []
      const homeDir = os.homedir()
      const platform = process.platform

      if (platform === 'win32') {
        // Windows 常见 Node.js 路径
        // %APPDATA%\npm — npm 全局安装目录(npx.cmd 通常在此)
        const appData = process.env.APPDATA
        if (appData) extraPaths.push(path.join(appData, 'npm'))
        // %ProgramFiles%\nodejs — Node.js 官方安装目录
        const programFiles = process.env.ProgramFiles
        if (programFiles) extraPaths.push(path.join(programFiles, 'nodejs'))
        const programFilesX86 = process.env['ProgramFiles(x86)']
        if (programFilesX86) extraPaths.push(path.join(programFilesX86, 'nodejs'))
        // scoop 安装:~/scoop/apps/nodejs/current/bin 及 ~/scoop/shims
        extraPaths.push(path.join(homeDir, 'scoop', 'apps', 'nodejs', 'current', 'bin'))
        extraPaths.push(path.join(homeDir, 'scoop', 'apps', 'nodejs', 'current'))
        extraPaths.push(path.join(homeDir, 'scoop', 'shims'))
        // nvm-windows:经常安装在 %APPDATA%\nvm\vXX.XX.X
        if (appData) {
          const nvmDir = path.join(appData, 'nvm')
          try {
            // nvm-windows 的 symlink 指向当前版本,直接加 nvm 目录即可
            if (fs.existsSync(nvmDir)) extraPaths.push(nvmDir)
          } catch { /* ignore */ }
        }
        // Volta:~/AppData/Local/Volta/bin
        const localAppData = process.env.LOCALAPPDATA
        if (localAppData) extraPaths.push(path.join(localAppData, 'Volta', 'bin'))
      } else {
        // macOS / Linux 常见 Node.js 路径
        extraPaths.push('/usr/local/bin')
        extraPaths.push('/opt/homebrew/bin')
        extraPaths.push(path.join(homeDir, '.npm-global', 'bin'))
        // nvm:~/.nvm/versions/node/*/bin(取当前激活版本或最新版本)
        const nvmDir = path.join(homeDir, '.nvm', 'versions', 'node')
        try {
          const versions = fs.readdirSync(nvmDir).sort().reverse()
          if (versions.length > 0) {
            // 取排序后最新版本的 bin 目录
            extraPaths.push(path.join(nvmDir, versions[0], 'bin'))
          }
        } catch { /* nvm 目录不存在,忽略 */ }
        // fnm:~/.local/share/fnm/multishells/*/bin 或 ~/.fnm
        extraPaths.push(path.join(homeDir, '.local', 'share', 'fnm'))
        extraPaths.push(path.join(homeDir, '.fnm'))
        // Volta:~/.volta/bin
        extraPaths.push(path.join(homeDir, '.volta', 'bin'))
      }

      // 过滤掉不存在的路径(减少无效 PATH 条目)
      const validPaths = extraPaths.filter((p) => {
        try { return fs.existsSync(p) } catch { return false }
      })

      if (validPaths.length > 0) {
        const pathKey = platform === 'win32' ? 'Path' : 'PATH'
        // Windows env 大小写不敏感,但 process.env 中 key 可能是 'Path' 或 'PATH'
        // 优先用已有 key,不存在则用平台默认
        const existingKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || pathKey
        const existingPath = env[existingKey] || ''
        // 追加新路径(放在末尾,不覆盖系统已有路径)
        const separator = platform === 'win32' ? ';' : ':'
        env[existingKey] = existingPath
          ? existingPath + separator + validPaths.join(separator)
          : validPaths.join(separator)
        console.log(
          `[McpService] buildSpawnEnv: appended ${validPaths.length} PATH entries for spawn`,
        )
      }
    } catch (err) {
      // graceful:合并 PATH 失败不阻塞 spawn,log warn 后继续用原始 env
      console.warn('[McpService] buildSpawnEnv: failed to merge PATH, using original env:', err)
    }

    return env
  }

  /**
   * 解析 spawn 的 command,处理 Windows 上 npx/npm 需要 .cmd/.ps1 后缀的问题。
   *
   * R52 修复: Windows 的 spawn('npx', ...) 报 ENOENT,因为 Windows 上 npx
   * 实际是 npx.cmd 或 npx.ps1(不在 PATHEXT 搜索路径时)。
   * 本方法在 Windows 上对 npx/npm 尝试在 spawnEnv(已含合并后的 PATH)中
   * 找 .cmd/.ps1 后缀的真实可执行路径,
   * 找不到则返回原始 command(保留原 spawn 行为)。
   *
   * @param command 原始 command(如 'npx')
   * @param spawnEnv buildSpawnEnv 构建的 env(已含合并后的 PATH)
   */
  private resolveSpawnCommand(command: string, spawnEnv: Record<string, string>): string {
    // 仅在 Windows 且 command 是裸 npx/npm 时处理
    if (process.platform !== 'win32') return command
    const needsResolve = ['npx', 'npm']
    if (!needsResolve.includes(command.toLowerCase())) return command

    // 从 spawnEnv 中提取 PATH(已经过 buildSpawnEnv 合并)
    const pathKey = Object.keys(spawnEnv).find((k) => k.toLowerCase() === 'path') || 'Path'
    const pathEnv = spawnEnv[pathKey] || ''
    const separator = ';'
    const extensions = ['.cmd', '.ps1']

    // 遍历 PATH 目录寻找 npx.cmd / npm.cmd / npx.ps1 / npm.ps1
    for (const dir of pathEnv.split(separator)) {
      if (!dir) continue
      for (const ext of extensions) {
        const candidate = path.join(dir, `${command}${ext}`)
        try {
          if (fs.existsSync(candidate)) {
            console.log(`[McpService] resolveSpawnCommand: ${command} → ${candidate}`)
            return candidate
          }
        } catch { /* ignore */ }
      }
    }

    // 找不到 .cmd/.ps1,返回原始 command(保留原 spawn 行为,可能仍然 ENOENT)
    console.warn(
      `[McpService] resolveSpawnCommand: could not find ${command}.cmd/.ps1 in PATH, ` +
      `using original command (may still ENOENT)`,
    )
    return command
  }

  /**
   * 断开所有连接
   */
  private async disconnectAll(): Promise<void> {
    const disconnectPromises: Promise<void>[] = []
    for (const [, client] of this.clients) {
      disconnectPromises.push(this.disconnectClient(client))
    }
    await Promise.allSettled(disconnectPromises)
    this.clients.clear()
  }

  /**
   * 清理所有连接(应用退出时调用)
   */
  async destroy(): Promise<void> {
    console.log(`[McpService] destroy() — disconnecting ${this.clients.size} servers`)
    await this.disconnectAll()
    // R1-3: 清理可能残留的连接锁(正常情况 finally 已清,这里兜底防止 reloadConfig 循环累积)
    this.connecting.clear()
    this.config = []
    this.initialized = false
  }
}

/** 单例 */
export const mcpService = new McpService()
