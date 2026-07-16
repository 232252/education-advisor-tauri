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

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import yaml from 'yaml'
import type { McpServerConfig, McpServerStatus, McpTool, McpTransport } from '../../shared/types'
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
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>
  // 接收缓冲区(stdio 按行解析)
  buffer?: string
}

/** 连接超时(毫秒) */
const CONNECT_TIMEOUT_MS = 30_000
/** 工具调用超时(毫秒) */
const CALL_TIMEOUT_MS = 60_000
/** 最大重连次数 */
const MAX_RECONNECT = 3
/** 重连间隔(毫秒) */
const RECONNECT_DELAY_MS = 1000
/** 返回内容最大大小(5MB,防止超大响应撑爆上下文) */
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024

/**
 * 环境变量插值: ${VAR} → process.env[VAR]
 */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '')
}

/**
 * 深度插值:递归处理对象中的所有字符串值
 */
function deepInterpolate<T>(obj: T): T {
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
 * 校验 server 配置完整性
 */
function validateServerConfig(server: unknown): server is McpServerConfig {
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

class McpService {
  private clients: Map<string, MCPClient> = new Map()
  private config: McpServerConfig[] = []
  private configPath: string
  private initialized = false

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
   * 加载 mcp.yaml 配置文件
   */
  private async loadConfig(): Promise<void> {
    try {
      const content = await fsp.readFile(this.configPath, 'utf-8')
      const parsed = yaml.parse(content)
      const servers = parsed?.servers
      if (!Array.isArray(servers)) {
        console.warn('[McpService] mcp.yaml has no servers array, entering no-op mode')
        this.config = []
        return
      }
      // 过滤有效配置 + 环境变量插值
      this.config = servers
        .filter(validateServerConfig)
        .map((s) => deepInterpolate(s))
        .filter((s) => s.enabled)
      console.log(`[McpService] Loaded ${this.config.length} enabled servers from ${this.configPath}`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log('[McpService] mcp.yaml not found, entering no-op mode')
        this.config = []
        return
      }
      console.error('[McpService] Failed to load mcp.yaml:', err)
      this.config = []
    }
  }

  /**
   * 重新加载配置(配置文件变更时调用)
   */
  async reloadConfig(): Promise<void> {
    // 断开所有现有连接
    await this.disconnectAll()
    this.config = []
    this.initialized = false
    await this.init()
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
      }
    })
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
        if (globalServer) serversToConnect.push(globalServer)
      }
    }

    // 2. 技能级临时 server(优先级高,覆盖同名全局 server)
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
        console.warn(`[McpService] Failed to connect server ${server.id} for agent ${agentId}:`, err)
        // 不阻塞其他 server,继续收集
      }
    }
    return allTools
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const client = this.clients.get(serverId)
    if (!client || !client.connected) {
      throw new Error(`MCP server ${serverId} not connected`)
    }
    return this.callToolInternal(client, toolName, args)
  }

  /**
   * 连接指定 server(手动连接,IPC 调用)
   */
  async connectServer(serverId: string): Promise<void> {
    const serverConfig = this.config.find((s) => s.id === serverId)
    if (!serverConfig) {
      throw new Error(`MCP server ${serverId} not found in config`)
    }
    await this.ensureConnected(serverConfig)
  }

  /**
   * 断开指定 server
   */
  async disconnectServer(serverId: string): Promise<void> {
    const client = this.clients.get(serverId)
    if (!client) return
    await this.disconnectClient(client)
    this.clients.delete(serverId)
  }

  /**
   * 列出指定 server 的工具
   */
  async listTools(serverId: string): Promise<McpTool[]> {
    const client = this.clients.get(serverId)
    if (!client || !client.connected) return []
    return client.tools
  }

  /**
   * 测试 server 连通性(连接 + listTools + 不调用任何工具)
   */
  async testServer(serverId: string): Promise<{ success: boolean; toolCount: number; error?: string }> {
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
   * 确保 server 已连接(惰性连接)
   */
  private async ensureConnected(server: McpServerConfig): Promise<MCPClient> {
    const existing = this.clients.get(server.id)
    if (existing && existing.connected) return existing
    if (existing) await this.disconnectClient(existing)

    const client: MCPClient = {
      serverId: server.id,
      config: server,
      connected: false,
      tools: [],
      requestId: 1,
      pending: new Map(),
    }

    await this.connectTransport(client, server)
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

    // 连接超时
    await Promise.race([
      connectPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Connect timeout after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS)
      }),
    ])

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
      const env = { ...process.env, ...server.env }
      const child = spawn(server.command, server.args || [], {
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
        console.warn(`[McpService] stdio server ${server.id} exited (code=${code}, signal=${signal})`)
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
        let newlineIdx: number
        while ((newlineIdx = client.buffer.indexOf('\n')) >= 0) {
          const line = client.buffer.slice(0, newlineIdx).trim()
          client.buffer = client.buffer.slice(newlineIdx + 1)
          if (line) this.handleJsonRpcMessage(client, line)
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
      throw new Error(`SSE server ${server.id} responded ${response.status}: ${response.statusText}`)
    }

    // 存储连接信息(SSE 使用 fetch 发送每个请求)
    client.lastError = undefined
  }

  /**
   * WebSocket 传输:使用 ws 库
   */
  private connectWebSocket(client: MCPClient, server: McpServerConfig): Promise<void> {
    return new Promise(async (resolve, reject) => {
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
        client.childProcess.stdin.write(message + '\n')
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
      client.childProcess.stdin.write(message + '\n')
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
      const entry = client.pending.get(m.id)!
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
   * 请求工具列表
   */
  private async requestListTools(client: MCPClient): Promise<McpTool[]> {
    const result = (await this.sendJsonRpc(client, 'tools/list', {})) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: object }>
    }
    if (!result?.tools) return []
    return result.tools.map((t) => ({
      serverId: client.serverId,
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || {},
    }))
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
        content: [{ type: 'text', text: `响应过大 (${(resultStr.length / 1024 / 1024).toFixed(1)} MB),超过 ${MAX_RESPONSE_SIZE / 1024 / 1024} MB 上限` }],
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
    const response = await fetch(client.config.url!, {
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
    if (client.childProcess) {
      try {
        client.childProcess.kill('SIGTERM')
        // 给 1s 优雅退出,然后 SIGKILL
        setTimeout(() => {
          if (!client.childProcess?.killed) {
            client.childProcess?.kill('SIGKILL')
          }
        }, 1000)
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
    this.config = []
    this.initialized = false
  }
}

/** 单例 */
export const mcpService = new McpService()
