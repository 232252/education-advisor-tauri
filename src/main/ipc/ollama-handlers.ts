// =============================================================
// Ollama IPC Handlers — 本地模型管理
// ollama:detect       检测 ollama 是否可用
// ollama:start-serve  启动 ollama serve
// ollama:stop-serve   停止 ollama serve
// ollama:list-models  列出已安装模型
// ollama:pull-model   下载模型(流式进度推送到渲染进程)
// ollama:delete-model 删除模型
// =============================================================

import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import * as IPC from '../../shared/ipc-channels'
import { ollamaService } from '../services/ollama-service'
import { log } from '../utils/logger'

export function registerOllamaHandlers(win: BrowserWindow): void {
  // 检测 ollama 是否可用
  ipcMain.handle(IPC.IPC_OLLAMA_DETECT, async () => {
    try {
      const available = await ollamaService.detect()
      const serveRunning = await ollamaService.isServeRunning()
      return {
        available,
        serveRunning,
        binaryPath: ollamaService.resolveBinaryPath() ?? undefined,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', 'ollama', `detect failed: ${msg}`)
      return { available: false, serveRunning: false, binaryPath: undefined }
    }
  })

  // 启动 serve
  ipcMain.handle(IPC.IPC_OLLAMA_START_SERVE, async () => {
    try {
      const ok = await ollamaService.startServe()
      return { success: ok }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', 'ollama', `startServe failed: ${msg}`)
      return { success: false, error: msg }
    }
  })

  // 停止 serve
  ipcMain.handle(IPC.IPC_OLLAMA_STOP_SERVE, async () => {
    try {
      ollamaService.stopServe()
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', 'ollama', `stopServe failed: ${msg}`)
      return { success: false, error: msg }
    }
  })

  // 列出已安装模型
  ipcMain.handle(IPC.IPC_OLLAMA_LIST_MODELS, async () => {
    try {
      return await ollamaService.listModels()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', 'ollama', `listModels failed: ${msg}`)
      return []
    }
  })

  // 下载模型(流式进度通过 IPC 事件推送)
  // C-3 修复: modelName 格式校验,防止命令注入
  ipcMain.handle(IPC.IPC_OLLAMA_PULL_MODEL, async (_e, modelName: string) => {
    try {
      if (typeof modelName !== 'string' || modelName.length === 0) {
        throw new Error('modelName must be a non-empty string')
      }
      if (modelName.length > 128) {
        throw new Error('modelName too long (max 128 chars)')
      }
      // Ollama 模型名格式: name[:tag],只允许字母数字/冒号/连字符/下划线/点
      if (!/^[a-zA-Z0-9._:/-]+$/.test(modelName)) {
        throw new Error(`Invalid model name: ${modelName}`)
      }
      log('info', 'ollama', `pull model: ${modelName}`)
      const result = await ollamaService.pullModel(modelName, (progress) => {
        // 推送进度到渲染进程
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.IPC_OLLAMA_PULL_PROGRESS, {
            model: modelName,
            status: progress.status,
            completed: progress.completed,
            total: progress.total,
          })
        }
      })
      log('info', 'ollama', `pull ${modelName} done: success=${result.success}`)
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', 'ollama', `pullModel failed: ${msg}`)
      return { success: false, error: msg }
    }
  })

  // 删除模型
  // C-3 修复: modelName 格式校验
  ipcMain.handle(IPC.IPC_OLLAMA_DELETE_MODEL, async (_e, modelName: string) => {
    try {
      if (typeof modelName !== 'string' || modelName.length === 0) {
        throw new Error('modelName must be a non-empty string')
      }
      if (modelName.length > 128) {
        throw new Error('modelName too long (max 128 chars)')
      }
      if (!/^[a-zA-Z0-9._:/-]+$/.test(modelName)) {
        throw new Error(`Invalid model name: ${modelName}`)
      }
      log('info', 'ollama', `delete model: ${modelName}`)
      return await ollamaService.deleteModel(modelName)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', 'ollama', `deleteModel failed: ${msg}`)
      return { success: false, error: msg }
    }
  })

  log('info', 'ollama-handlers', 'Ollama IPC handlers registered')
}
