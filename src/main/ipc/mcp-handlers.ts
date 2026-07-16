// =============================================================
// MCP IPC 处理器
//
// 提供 5 个 IPC 接口供前端管理 MCP server:
//   - mcp:list        列出所有配置的 server 及连接状态
//   - mcp:connect     手动连接指定 server
//   - mcp:disconnect  断开指定 server
//   - mcp:list-tools  列出指定 server 的工具
//   - mcp:test        测试 server 连通性(连接 + listTools)
//
// 安全说明:
//   - 所有 serverId 参数做格式校验(只允许字母数字_-)
//   - 实际工具调用通过 AgentTool.execute 走 mcp-tools.ts 的 sanitizeMcpArgs
//   - 这里只提供管理接口,不直接调用工具(工具调用由 Agent 运行时触发)
// =============================================================

import { type BrowserWindow, ipcMain } from 'electron'
import * as IPC from '../../shared/ipc-channels'
import { mcpService } from '../services/mcp-service'

/** 校验 serverId 格式(防注入) */
function validateServerId(id: unknown): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('serverId must be a non-empty string')
  }
  if (id.length > 128) {
    throw new Error('serverId too long (max 128 chars)')
  }
  // 只允许字母数字下划线连字符
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('serverId contains invalid characters (only a-zA-Z0-9_- allowed)')
  }
  return id
}

export function registerMcpHandlers(_win: BrowserWindow) {
  // 列出所有配置的 server 及连接状态
  ipcMain.handle(IPC.IPC_MCP_LIST, async () => {
    try {
      return { success: true, servers: mcpService.listServers() }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] mcp:list failed:', msg)
      return { success: false, servers: [], error: msg }
    }
  })

  // 手动连接指定 server
  ipcMain.handle(IPC.IPC_MCP_CONNECT, async (_e, serverId: string) => {
    try {
      const safeId = validateServerId(serverId)
      await mcpService.connectServer(safeId)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] mcp:connect(${serverId}) failed:`, msg)
      return { success: false, error: msg }
    }
  })

  // 断开指定 server
  ipcMain.handle(IPC.IPC_MCP_DISCONNECT, async (_e, serverId: string) => {
    try {
      const safeId = validateServerId(serverId)
      await mcpService.disconnectServer(safeId)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] mcp:disconnect(${serverId}) failed:`, msg)
      return { success: false, error: msg }
    }
  })

  // 列出指定 server 的工具
  ipcMain.handle(IPC.IPC_MCP_LIST_TOOLS, async (_e, serverId: string) => {
    try {
      const safeId = validateServerId(serverId)
      const tools = await mcpService.listTools(safeId)
      return { success: true, tools }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] mcp:list-tools(${serverId}) failed:`, msg)
      return { success: false, tools: [], error: msg }
    }
  })

  // 测试 server 连通性(连接 + listTools)
  ipcMain.handle(IPC.IPC_MCP_TEST, async (_e, serverId: string) => {
    try {
      const safeId = validateServerId(serverId)
      const result = await mcpService.testServer(safeId)
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] mcp:test(${serverId}) failed:`, msg)
      return { success: false, toolCount: 0, error: msg }
    }
  })

  console.log('[IPC] MCP handlers registered')
}
