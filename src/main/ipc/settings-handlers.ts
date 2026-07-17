// =============================================================
// 设置 IPC 处理器
// 重构 (v2):
//   - minimizeToTray 变化时立即调用 updateTray 实时生效
//   - feishu.appSecret 变化时记录安全警告
//   - telemetry/autoUpdate 等"待实现"字段不报错(让 UI 安静保存)
// =============================================================

import { app, type BrowserWindow, ipcMain } from 'electron'
import * as IPC from '../../shared/ipc-channels'
import { feishuBotService } from '../services/feishu-bot-service'
import { keystoreService } from '../services/keystore-service'
import { settingsService } from '../services/settings-service'
import { updateTray } from '../services/tray-service'
import { log, setLogLevel } from '../utils/logger'

/**
 * 枚举字段校验表 (Bug R28-1 修复)
 * 对 UI 中使用 <select> 组件的字段,限制为合法的枚举值。
 * 防止 settings.set 接受任意字符串(如 "INVALID_THEME_XYZ")导致配置损坏。
 */
const ENUM_VALIDATORS: Record<string, readonly string[]> = {
  'general.theme': ['dark', 'light', 'system'],
  'general.language': ['zh-CN', 'en-US', 'zh', 'en'],
  'general.closeBehavior': ['ask', 'tray', 'exit'],
  'general.logLevel': ['debug', 'info', 'warn', 'error', 'off'],
  'chat.steeringMode': ['all', 'one-at-a-time'],
  'chat.followUpMode': ['all', 'one-at-a-time'],
  'chat.thinkingLevel': ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
}

/**
 * P4-5 修复: 字段类型校验表
 * 对 settings.json 中的布尔/字符串字段,校验 value 类型与 schema 匹配。
 * 防止 XSS'd renderer 传入错误类型 (如 autoStart='true' 字符串) 污染内存配置。
 * 枚举字段已在 ENUM_VALIDATORS 中隐式要求 string 类型,此处不重复。
 */
const TYPE_VALIDATORS: Record<string, 'string' | 'boolean' | 'number'> = {
  'general.autoStart': 'boolean',
  'general.minimizeToTray': 'boolean',
  'chat.conversationLogging': 'boolean',
  'feishu.appId': 'string',
}

/** P4-6 修复: feishu.appSecret 长度上限 (10KB,合理的 API key 长度) */
const MAX_FEISHU_SECRET_LEN = 10_000

export function registerSettingsHandlers(win: BrowserWindow) {
  // 启动时同步 autoStart 设置到系统
  const currentSettings = settingsService.getSettings()
  app.setLoginItemSettings({ openAtLogin: currentSettings.general.autoStart })

  /**
   * 飞书 appId 或 appSecret 变化后，若两者均已配置则重连长连接机器人；
   * 若 appId 被清空则停止。实现"保存即生效"，无需重启 app。
   * M-IPC-2 修复: debounce 500ms,避免用户快速保存 appId+appSecret 时触发两次重连
   */
  let reconnectTimer: NodeJS.Timeout | null = null
  const reconnectFeishuBot = async (): Promise<void> => {
    // 用户手动停止后,不自动重连(只有保存新 appId/secret 或手动点"连接"才重启)
    if (feishuBotService.isUserStopped()) {
      log('info', 'settings', 'feishu bot skipped reconnect (user stopped)')
      return
    }
    // M-IPC-2: debounce 500ms,合并连续调用
    if (reconnectTimer) clearTimeout(reconnectTimer)
    return new Promise((resolve) => {
      reconnectTimer = setTimeout(async () => {
        reconnectTimer = null
        try {
          const s = settingsService.getSettings()
          const secret = keystoreService.getSecret('feishu-app-secret')
          if (s.feishu.appId && secret) {
            // start 内部已做幂等：若 appId 相同且已连接则跳过
            await feishuBotService.start(s.feishu.appId, secret, win).catch((err) => {
              log('warn', 'settings', `feishu bot reconnect failed: ${err}`)
            })
          } else {
            await feishuBotService.stop().catch((err) => {
              log('warn', 'settings', `feishu bot stop failed (disabled): ${err}`)
            })
          }
        } finally {
          resolve()
        }
      }, 500)
    })
  }

  ipcMain.handle(IPC.IPC_SETTINGS_GET, async () => {
    try {
      const settings = settingsService.getSettings()
      // 如果 keystore 中有飞书 appSecret，用占位符标记（不返回真实密钥）
      if (keystoreService.getSecret('feishu-app-secret')) {
        settings.feishu.appSecret = '__keystore__'
      }
      return settings
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', 'settings', `get failed: ${msg}`)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle(IPC.IPC_SETTINGS_SET, async (_e, path: string, value: unknown) => {
    try {
      if (typeof path !== 'string' || path.length === 0) {
        return { success: false, error: 'path must be a non-empty string' }
      }
      // P4-6 修复: path 含 null byte 拒绝
      if (path.includes('\0')) {
        return { success: false, error: '[IPC] invalid path: contains null byte' }
      }
      // 飞书 appSecret:存入 keystore 加密存储，不写入 settings.json
      if (path === 'feishu.appSecret' && typeof value === 'string' && value.length > 0) {
        // 如果是 keystore 占位符，说明用户没修改，跳过
        if (value === '__keystore__') {
          return { success: true }
        }
        // P4-6 修复: 长度上限 + null byte 校验
        if (value.length > MAX_FEISHU_SECRET_LEN) {
          return { success: false, error: `[IPC] feishu.appSecret too long (${value.length} > ${MAX_FEISHU_SECRET_LEN})` }
        }
        if (value.includes('\0')) {
          return { success: false, error: '[IPC] feishu.appSecret contains null byte' }
        }
        keystoreService.setSecret('feishu-app-secret', value)
        log('info', 'settings', 'feishu.appSecret saved to keystore (encrypted)')
        // 保存即重连：appSecret 变了，用新密钥重启长连接
        await reconnectFeishuBot()
        return { success: true }
      }

      // Bug R28-1 修复: 枚举字段校验,拒绝非法值
      // P4-5 修复: 枚举字段必须是 string 类型,非 string 直接拒绝 (不再跳过校验)
      const allowedValues = ENUM_VALIDATORS[path]
      if (allowedValues) {
        if (typeof value !== 'string') {
          log(
            'warn',
            'settings',
            `Rejected non-string value for enum ${path}: type=${typeof value}`,
          )
          return {
            success: false,
            error: `[IPC] Invalid value type for ${path}: expected string, got ${typeof value}`,
          }
        }
        if (!allowedValues.includes(value)) {
          log(
            'warn',
            'settings',
            `Rejected invalid enum value for ${path}: ${value} (allowed: ${allowedValues.join(', ')})`,
          )
          return {
            success: false,
            error: `Invalid value "${value}" for ${path}. Allowed: ${allowedValues.join(', ')}`,
          }
        }
      }

      // P4-5 修复: 非枚举字段的类型校验
      const expectedType = TYPE_VALIDATORS[path]
      if (expectedType && typeof value !== expectedType) {
        log(
          'warn',
          'settings',
          `Rejected type mismatch for ${path}: expected ${expectedType}, got ${typeof value}`,
        )
        return {
          success: false,
          error: `[IPC] Invalid value type for ${path}: expected ${expectedType}, got ${typeof value}`,
        }
      }

      settingsService.update(path, value)

      // 开机启动：同步到系统登录项
      if (path === 'general.autoStart' && typeof value === 'boolean') {
        app.setLoginItemSettings({ openAtLogin: value })
      }

      // 托盘:实时创建/销毁(原版只启动时读一次,改了不生效)
      if (path === 'general.minimizeToTray' && typeof value === 'boolean') {
        updateTray(value)
      }

      // 飞书 appId 变化：保存即重连长连接(appSecret 从 keystore 读取)
      if (path === 'feishu.appId') {
        await reconnectFeishuBot()
      }

      // T5: 日志级别:实时切换
      if (path === 'general.logLevel' && typeof value === 'string') {
        setLogLevel(value as 'debug' | 'info' | 'warn' | 'error' | 'off')
        log('info', 'settings', `logLevel changed to ${value}`)
      }

      // T5: 对话日志开关变化
      if (path === 'chat.conversationLogging' && typeof value === 'boolean') {
        log('info', 'settings', `chat.conversationLogging changed to ${value}`)
      }

      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', 'settings', `set failed for "${path}": ${msg}`)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle(IPC.IPC_SETTINGS_RESET, async () => {
    try {
      settingsService.reset()
      // 重置时也清除 keystore 中的飞书密钥
      keystoreService.deleteSecret('feishu-app-secret')
      // 重置后停止飞书长连接
      await feishuBotService.stop().catch((err) => {
        log('warn', 'settings', `feishu bot stop failed (reset): ${err}`)
      })
      // 重置后也要同步 autoStart(默认 false)
      app.setLoginItemSettings({ openAtLogin: false })
      // 重置后也要重建托盘
      const newSettings = settingsService.getSettings()
      updateTray(newSettings.general.minimizeToTray)
      // T5: 重置后恢复 logLevel
      setLogLevel(newSettings.general.logLevel)
      log('info', 'settings', `settings reset; logLevel=${newSettings.general.logLevel}`)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('error', 'settings', `reset failed: ${msg}`)
      return { success: false, error: msg }
    }
  })

  console.log('[IPC] Settings handlers registered')
}
