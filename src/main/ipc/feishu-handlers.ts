// =============================================================
// Feishu IPC Handlers — 飞书集成 IPC 通道
// feishu:test          测连接(返回 token 前 8 位 + 过期秒数)
// feishu:bitable       列 bitable 表
// feishu:send          发文本消息
// feishu:status        返回当前 token 缓存状态
// feishu:sync-now      手动触发一次 bitable 同步
// feishu:bot-start     启动长连接机器人
// feishu:bot-stop      停止长连接机器人
// feishu:bot-status    查询机器人状态
// appSecret 统一从 keystore 读取，不再通过 IPC 参数传递
// =============================================================

import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import * as IPC from '../../shared/ipc-channels'
import { feishuBotService } from '../services/feishu-bot-service'
import {
  feishuInfo,
  listBitableTables,
  sendTextMessage,
  syncBitableNow,
  testConnection,
} from '../services/feishu-service'
import { keystoreService } from '../services/keystore-service'
import { settingsService } from '../services/settings-service'
import { log } from '../utils/logger'

/** 内部辅助：从 keystore 获取飞书 appSecret，获取不到则返回空字符串 */
function getFeishuSecret(): string {
  return keystoreService.getSecret('feishu-app-secret') ?? ''
}

/**
 * R6-8 修复: IPC 输入验证 helper(飞书版)。
 * 防止 XSS'd renderer 传入 undefined/非字符串/超长/含空字节的输入。
 */
function validateString(value: unknown, field: string, maxLen = 10_000): string {
  if (typeof value !== 'string') {
    throw new Error(`[IPC] invalid ${field}: expected string, got ${typeof value}`)
  }
  if (value.length === 0) {
    throw new Error(`[IPC] invalid ${field}: empty string`)
  }
  if (value.length > maxLen) {
    throw new Error(`[IPC] invalid ${field}: too long (${value.length} > ${maxLen})`)
  }
  if (value.includes('\0')) {
    throw new Error(`[IPC] invalid ${field}: contains null byte`)
  }
  return value
}

export function registerFeishuHandlers(win: BrowserWindow): void {
  // P2 修复: 先清除旧 listener,避免热重载/窗口重建时 listener 累积+旧窗口引用泄漏
  feishuBotService.removeAllListeners('status')
  // 机器人状态变化时推送给渲染进程(设置页徽章实时更新)
  feishuBotService.on('status', (info) => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.IPC_FEISHU_BOT_STATUS_UPDATE, info)
    }
  })

  ipcMain.handle(IPC.IPC_FEISHU_TEST, async (_e, appId: string) => {
    try {
      // R6-8 修复: 输入验证
      validateString(appId, 'appId', 256)
      const appSecret = getFeishuSecret()
      log('info', 'feishu', `test connection, appId=${appId.slice(0, 8)}...`)
      return await testConnection(appId, appSecret)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', 'feishu', `test failed: ${msg}`)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle(IPC.IPC_FEISHU_BITABLE, async (_e, appId: string, appToken: string) => {
    try {
      // R6-8 修复: 输入验证
      validateString(appId, 'appId', 256)
      validateString(appToken, 'appToken', 512)
      const appSecret = getFeishuSecret()
      log('info', 'feishu', `list bitable tables, appToken=${appToken}`)
      return await listBitableTables(appId, appSecret, appToken)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', 'feishu', `bitable failed: ${msg}`)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle(
    IPC.IPC_FEISHU_SEND,
    async (_e, appId: string, userOpenId: string, text: string) => {
      try {
        // R6-8 修复: 输入验证
        validateString(appId, 'appId', 256)
        validateString(userOpenId, 'userOpenId', 256)
        validateString(text, 'text', 10_000)
        const appSecret = getFeishuSecret()
        log('info', 'feishu', `send text to ${userOpenId}, len=${text.length}`)
        return await sendTextMessage(appId, appSecret, userOpenId, text)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log('error', 'feishu', `send failed: ${msg}`)
        return { success: false, error: msg }
      }
    },
  )

  ipcMain.handle(IPC.IPC_FEISHU_STATUS, async () => {
    try {
      return feishuInfo()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', 'feishu', `status failed: ${msg}`)
      return { available: false, error: msg }
    }
  })

  // T4: 手动触发一次 bitable 同步(graceful 降级)
  ipcMain.handle(
    IPC.IPC_FEISHU_SYNC_NOW,
    async (
      _e,
      appId: string,
      appToken: string,
      tableId: string,
      fields: Record<string, unknown>,
    ) => {
      try {
        // R6-8 修复: 输入验证
        validateString(appId, 'appId', 256)
        validateString(appToken, 'appToken', 512)
        validateString(tableId, 'tableId', 256)
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
          throw new Error('[IPC] invalid fields: expected object')
        }
        const appSecret = getFeishuSecret()
        log('info', 'feishu', `sync-now trigger, appToken=${appToken} tableId=${tableId}`)
        const result = await syncBitableNow(appId, appSecret, appToken, tableId, fields)
        if (result.skipped) {
          log('warn', 'feishu', `bitable sync skipped: ${result.skipped}`)
        } else if (result.success) {
          log('info', 'feishu', `bitable sync ok, recordId=${result.recordId}`)
        } else {
          log('warn', 'feishu', `bitable sync failed: ${result.error}`)
        }
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log('error', 'feishu', `sync-now failed: ${msg}`)
        return { success: false, error: msg, skipped: false }
      }
    },
  )

  // ===== 飿书长连接机器人 =====
  // 启动:从 settings 读 appId + keystore 读 appSecret,启动长连接
  ipcMain.handle(IPC.IPC_FEISHU_BOT_START, async () => {
    try {
      const settings = settingsService.getSettings()
      const appId = settings.feishu.appId
      const appSecret = getFeishuSecret()
      if (!appId || !appSecret) {
        return { success: false, error: '请先填写 App ID 和 App Secret 并保存' }
      }
      await feishuBotService.start(appId, appSecret, win)
      const status = feishuBotService.getStatus()
      return { success: status.status === 'connected', status }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', 'feishu', `bot-start failed: ${msg}`)
      return { success: false, error: msg, status: feishuBotService.getStatus() }
    }
  })

  // 停止
  ipcMain.handle(IPC.IPC_FEISHU_BOT_STOP, async () => {
    try {
      await feishuBotService.stop()
      return { success: true, status: feishuBotService.getStatus() }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', 'feishu', `bot-stop failed: ${msg}`)
      return { success: false, error: msg, status: feishuBotService.getStatus() }
    }
  })

  // 查询状态
  ipcMain.handle(IPC.IPC_FEISHU_BOT_STATUS, async () => {
    try {
      return feishuBotService.getStatus()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', 'feishu', `bot-status failed: ${msg}`)
      return { status: 'disconnected', error: msg }
    }
  })

  log('info', 'feishu-handlers', 'Feishu IPC handlers registered (appSecret from keystore)')
}
