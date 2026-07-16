// =============================================================
// 日志 IPC 处理器 — 真实业务实现
// C-1 修复: 所有 filePath/sourcePath/destPath 参数必须验证在日志目录内,
//   防止路径遍历攻击读取敏感文件(~/.ssh/id_rsa 等)
// =============================================================

import path from 'node:path'
import { app, dialog, ipcMain } from 'electron'
import * as IPC from '../../shared/ipc-channels'
import type { LogLevel } from '../utils/logger'
import {
  clearAllLogs,
  exportLog,
  listLogFiles,
  logRenderer,
  readLogTail,
  readLogTailByLevel,
  searchLog,
} from '../utils/logger'

/**
 * C-1 修复: 验证路径在日志目录内,防止路径遍历攻击读取敏感文件(~/.ssh/id_rsa 等)
 * 纯文件名(无路径分隔符)自动解析到日志目录内,与 IPC_LOG_EXPORT_DIALOG 行为一致。
 * 绝对路径/相对路径必须已在日志目录内,否则拒绝。
 */
function validateLogPath(filePath: string): string {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('filePath must be a non-empty string')
  }
  if (filePath.includes('\0')) {
    throw new Error('filePath contains null bytes')
  }
  const logsDir = path.join(app.getPath('userData'), 'logs')
  const resolvedLogsDir = path.resolve(logsDir)
  // 纯文件名(如 "main-2024-01-01.log")自动解析到日志目录内
  // 含路径分隔符的路径(如 "../secret" 或 "/etc/passwd")按原路径解析后检查
  const hasSep = filePath.includes('/') || filePath.includes('\\')
  const resolved = hasSep ? path.resolve(filePath) : path.resolve(logsDir, filePath)
  // 确保解析后的路径在日志目录内
  if (!resolved.startsWith(resolvedLogsDir + path.sep) && resolved !== resolvedLogsDir) {
    throw new Error(`Path outside logs directory: ${filePath}`)
  }
  // 只允许 .log 和 .txt 文件
  const ext = path.extname(resolved).toLowerCase()
  if (ext && ext !== '.log' && ext !== '.txt') {
    throw new Error(`Invalid log file extension: ${ext}`)
  }
  return resolved
}

/** C-1 修复: 验证导出目标路径(写入路径) */
function validateExportPath(destPath: string): string {
  if (typeof destPath !== 'string' || destPath.length === 0) {
    throw new Error('destPath must be a non-empty string')
  }
  if (destPath.includes('\0')) {
    throw new Error('destPath contains null bytes')
  }
  // 导出路径不能写到系统目录
  const resolved = path.resolve(destPath)
  const ext = path.extname(resolved).toLowerCase()
  if (ext && ext !== '.log' && ext !== '.txt' && ext !== '.json') {
    throw new Error(`Invalid export file extension: ${ext}`)
  }
  return resolved
}

export function registerLogHandlers(): void {
  // 渲染进程 console 转发
  // C-1 修复: 原本只有 preload.send 但主进程无监听者,导致 renderer-*.log 永远不生成
  // Tauri 兼容: ipcMain.on 供 Electron ipcRenderer.send 使用,
  //             ipcMain.handle 供 Tauri invoke (ipc_invoke) 使用
  const handleRendererLog = (level: string, msg: string): void => {
    const validLevels: LogLevel[] = ['debug', 'info', 'warn', 'error']
    const lv = validLevels.includes(level as LogLevel) ? (level as LogLevel) : 'info'
    logRenderer(lv, String(msg))
  }
  ipcMain.on(IPC.IPC_LOG_WRITE_RENDERER, (_event, level: string, msg: string) => {
    handleRendererLog(level, msg)
  })
  ipcMain.handle(IPC.IPC_LOG_WRITE_RENDERER, (_event, level: string, msg: string) => {
    handleRendererLog(level, msg)
    return { success: true }
  })

  ipcMain.handle(IPC.IPC_LOG_LIST, async () => {
    try {
      return await listLogFiles()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`listLogFiles 失败: ${msg}`)
    }
  })

  ipcMain.handle(IPC.IPC_LOG_READ, async (_event, filePath: string, lines?: number) => {
    try {
      const safePath = validateLogPath(filePath)
      return await readLogTail(safePath, lines)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`readLogTail 失败: ${msg}`)
    }
  })

  ipcMain.handle(IPC.IPC_LOG_CLEAR, async () => {
    try {
      return await clearAllLogs()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`clearAllLogs 失败: ${msg}`)
    }
  })

  ipcMain.handle(
    IPC.IPC_LOG_FILTER,
    async (_event, filePath: string, levels: string[], lines?: number) => {
      try {
        const safePath = validateLogPath(filePath)
        return await readLogTailByLevel(safePath, levels, lines)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`readLogTailByLevel 失败: ${msg}`)
      }
    },
  )

  ipcMain.handle(
    IPC.IPC_LOG_SEARCH,
    async (_event, filePath: string, query: string, maxResults?: number) => {
      try {
        const safePath = validateLogPath(filePath)
        return await searchLog(safePath, query, maxResults)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`searchLog 失败: ${msg}`)
      }
    },
  )

  ipcMain.handle(IPC.IPC_LOG_EXPORT, async (_event, sourcePath: string, destPath: string) => {
    try {
      const safeSource = validateLogPath(sourcePath)
      const safeDest = validateExportPath(destPath)
      return await exportLog(safeSource, safeDest)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`exportLog 失败: ${msg}`)
    }
  })

  ipcMain.handle(IPC.IPC_LOG_EXPORT_DIALOG, async (_event, sourceName: string) => {
    try {
      // sourceName 只是文件名,验证它不包含路径分隔符
      if (typeof sourceName !== 'string' || sourceName.length === 0) {
        throw new Error('sourceName must be a non-empty string')
      }
      if (sourceName.includes('/') || sourceName.includes('\\') || sourceName.includes('..')) {
        throw new Error('sourceName must be a plain filename, not a path')
      }
      const result = await dialog.showSaveDialog({
        title: '导出日志文件',
        defaultPath: sourceName,
        filters: [{ name: '日志文件', extensions: ['log', 'txt'] }],
      })
      if (result.canceled || !result.filePath) {
        return { canceled: true, bytes: 0, path: undefined }
      }
      const safeDest = validateExportPath(result.filePath)
      const logsDir = path.join(app.getPath('userData'), 'logs')
      const safeSource = path.join(logsDir, sourceName)
      // 确保源文件存在且在日志目录内
      validateLogPath(safeSource)
      const bytes = await exportLog(safeSource, safeDest)
      return { canceled: false, bytes, path: safeDest }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`exportLogWithDialog 失败: ${msg}`)
    }
  })

  console.log('[IPC] Log handlers registered (real implementation)')
}
