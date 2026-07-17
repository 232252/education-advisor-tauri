// =============================================================
// Keystore Service — API Key 安全存储
// 技术方向：Electron safeStorage (Windows DPAPI) 加密存储
// 修复：
//   P1-21: save() 改为异步写盘，不阻塞主进程
//   P1-22: 解密失败时记录 lastError，调用方可查询提示用户重新输入
//   P1-23: 启动时改为异步 load，不再阻塞主进程 50-200ms
// =============================================================

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import { atomicWrite } from '../utils/atomic-write'

class KeystoreService {
  private keyStorePath: string
  private cache: Map<string, string> = new Map()
  /** 异步加载完成的 promise，调用方在 getApiKey 前可 await */
  private _ready: Promise<void>
  /** M-1 修复: load() 是否已完成 */
  private _readyDone = false
  /** M-1 修复: load() 期间的 setApiKey 缓冲 */
  private _pendingSets: Map<string, string> = new Map()
  /** M-1 修复: load() 期间的 deleteApiKey 缓冲 */
  private _pendingDeletes: Set<string> = new Set()
  /** 最近的解密/读写错误 */
  private _lastError: string | null = null
  /** 是否有未完成的写入（用于 graceful shutdown） */
  private _pendingWrites = 0
  /** RISK 修复: 是否正在写盘(防止并发 save 写同一 tmp 文件导致数据丢失) */
  private _writing = false
  /** RISK 修复: 写盘期间有新修改,需要再写一次 */
  private _needsResave = false

  constructor() {
    this.keyStorePath = path.join(app.getPath('userData'), 'keystore.enc')
    // 异步启动加载，不阻塞主进程（P1-23）
    this._ready = this.load().then(() => {
      // M-1 修复: load 完成后回放缓冲的写入
      this._readyDone = true
      for (const [k, v] of this._pendingSets) {
        this.cache.set(k, v)
      }
      for (const k of this._pendingDeletes) {
        this.cache.delete(k)
      }
      this._pendingSets.clear()
      this._pendingDeletes.clear()
    })
  }

  /** 异步从磁盘加载并解密 */
  private async load(): Promise<void> {
    console.log(`[Keystore] Loading from: ${this.keyStorePath}`)
    try {
      await fsp.access(this.keyStorePath, fs.constants.F_OK)
    } catch {
      // 文件不存在，缓存保持空
      console.log('[Keystore] No keystore file found — starting with empty cache')
      return
    }
    try {
      const encrypted = await fsp.readFile(this.keyStorePath)
      if (!safeStorage.isEncryptionAvailable()) {
        // safeStorage 不可用（Linux 无 keyring 等）——读不到也写不进去
        this._lastError = 'Encryption backend not available on this platform'
        console.warn(`[Keystore] ${this._lastError}`)
        return
      }
      const decrypted = safeStorage.decryptString(encrypted)
      const parsed = JSON.parse(decrypted) as Record<string, string>
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof key === 'string' && typeof value === 'string') {
            this.cache.set(key, value)
          }
        }
        console.log(`[Keystore] Loaded ${this.cache.size} API key(s) from keystore`)
      }
    } catch (err) {
      // 解密失败（可能换了机器 / 重装系统 / DPAPI key 已失效）
      // 清空缓存，提示用户重新输入（P1-22）
      const msg = err instanceof Error ? err.message : String(err)
      this._lastError = `Keystore decryption failed (${msg}). Please re-enter your API keys.`
      console.warn('[Keystore] Failed to decrypt keystore, clearing cache:', msg)
      this.cache.clear()
    }
  }

  /** 加密后异步保存到磁盘，不阻塞调用方（P1-21）
   *  RISK 修复: 加 _writing + _needsResave 机制,防止并发 save 写同一 tmp 文件导致数据丢失
   *  之前两个并发 save() 各自读 cache 快照后都写同一个 .tmp 文件,
   *  后写入者会覆盖前者的修改,且 rename 后另一个 save 找不到 tmp 文件
   *  现在采用与 settings-service 一致的 do-while 模式 */
  private async save(): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      this._lastError = 'Cannot save: encryption backend not available'
      console.warn(`[Keystore] ${this._lastError}`)
      return
    }
    // 如果正在写盘,标记需要再写一次,本次直接返回
    if (this._writing) {
      this._needsResave = true
      return
    }
    this._writing = true
    this._pendingWrites++
    try {
      do {
        this._needsResave = false
        const obj = Object.fromEntries(this.cache)
        const json = JSON.stringify(obj)
        const encrypted = safeStorage.encryptString(json)
        await atomicWrite(this.keyStorePath, encrypted)
      } while (this._needsResave)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this._lastError = `Failed to save keystore: ${msg}`
      console.error('[Keystore] Save failed:', msg)
    } finally {
      this._writing = false
      this._pendingWrites--
    }
  }

  /**
   * 等待初始加载完成。在调用 getApiKey 前可 await 此方法以保证拿到最新数据。
   */
  async ready(): Promise<void> {
    return this._ready
  }

  /** 获取最近一次错误信息（启动解密失败 / 平台不支持 / 写盘失败） */
  getLastError(): string | null {
    return this._lastError
  }

  /** 清除最近一次错误（用户重新输入 key 后可调用） */
  clearLastError(): void {
    this._lastError = null
  }

  getApiKey(provider: string): string | undefined {
    return this.cache.get(provider)
  }

  /**
   * 设置 API key。setApiKey 是同步返回（写入磁盘是异步 fire-and-forget），
   * 这样调用方不用 await，但数据丢失风险已被原子 rename 缓解。
   *
   * M-1 修复: 在 load() 期间 setApiKey 的值会被 load() 的 cache.set 覆盖。
   * 使用 _pendingSets 缓冲 load 期间的写入，load 完成后回放。
   */
  setApiKey(provider: string, apiKey: string): void {
    if (typeof provider !== 'string' || provider.length === 0) {
      throw new Error('provider must be a non-empty string')
    }
    if (typeof apiKey !== 'string') {
      throw new Error('apiKey must be a string')
    }
    // M-1 修复: 如果 load() 尚未完成，缓冲写入，load 完成后回放
    // L-4 修复: set 时清除 pendingDeletes,保证操作语义
    if (!this._readyDone) {
      this._pendingSets.set(provider, apiKey)
      this._pendingDeletes.delete(provider)
    } else {
      this.cache.set(provider, apiKey)
    }
    this._lastError = null
    // 立即标记有待写入,让 flush() 能等到完成
    this._pendingWrites++
    // M-9 修复: 加 catch 防止 _ready reject 时 _pendingWrites 永不递减
    void this._ready
      .then(() => this.save())
      .catch((err) => {
        // HIGH 4.1 修复: 不再静默吞错,记录日志让用户能在日志页看到密钥保存失败
        console.error('[Keystore] save failed (key may not have persisted):', err)
        this._lastError = `save failed: ${err instanceof Error ? err.message : String(err)}`
      })
      .finally(() => {
        this._pendingWrites--
      })
  }

  deleteApiKey(provider: string): void {
    // L-4 修复: delete 时清除 pendingSets,保证操作语义
    if (!this._readyDone) {
      this._pendingDeletes.add(provider)
      this._pendingSets.delete(provider)
    } else {
      this.cache.delete(provider)
    }
    this._pendingWrites++
    void this._ready
      .then(() => this.save())
      .catch((err) => {
        // HIGH 4.1 修复: 不再静默吞错,记录日志让用户能在日志页看到密钥保存失败
        console.error('[Keystore] save failed (key may not have persisted):', err)
        this._lastError = `save failed: ${err instanceof Error ? err.message : String(err)}`
      })
      .finally(() => {
        this._pendingWrites--
      })
  }

  /** 列出已保存的 provider 名称（不含 key 内容，排除内部 secret） */
  listProviders(): string[] {
    return Array.from(this.cache.keys()).filter((k) => !k.startsWith('__secret__:'))
  }

  /** 获取通用密钥（非 API key 的敏感信息，如飞书 appSecret） */
  getSecret(key: string): string | undefined {
    return this.cache.get(`__secret__:${key}`)
  }

  /** 设置通用密钥
   *  M-4 修复: 与 setApiKey 一致,load() 期间缓冲到 _pendingSets */
  setSecret(key: string, value: string): void {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('key must be a non-empty string')
    }
    const k = `__secret__:${key}`
    if (!this._readyDone) {
      this._pendingSets.set(k, value)
      this._pendingDeletes.delete(k) // L-4 修复: set 覆盖 delete
    } else {
      this.cache.set(k, value)
    }
    this._lastError = null
    this._pendingWrites++
    void this._ready
      .then(() => this.save())
      .catch((err) => {
        // HIGH 4.1 修复: 不再静默吞错,记录日志让用户能在日志页看到密钥保存失败
        console.error('[Keystore] save failed (key may not have persisted):', err)
        this._lastError = `save failed: ${err instanceof Error ? err.message : String(err)}`
      })
      .finally(() => {
        this._pendingWrites--
      })
  }

  /** 删除通用密钥
   *  M-4 修复: 与 deleteApiKey 一致,load() 期间缓冲到 _pendingDeletes */
  deleteSecret(key: string): void {
    const k = `__secret__:${key}`
    if (!this._readyDone) {
      this._pendingDeletes.add(k)
      this._pendingSets.delete(k) // L-4 修复: delete 覆盖 set
    } else {
      this.cache.delete(k)
    }
    this._pendingWrites++
    void this._ready
      .then(() => this.save())
      .catch((err) => {
        // HIGH 4.1 修复: 不再静默吞错,记录日志让用户能在日志页看到密钥保存失败
        console.error('[Keystore] save failed (key may not have persisted):', err)
        this._lastError = `save failed: ${err instanceof Error ? err.message : String(err)}`
      })
      .finally(() => {
        this._pendingWrites--
      })
  }

  /** 检查 DPAPI / 平台安全存储是否可用 */
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  /** 优雅关闭：等待所有待写入完成
   *  M-9 修复: 加超时保护,防止 _ready reject 或 save() 挂起导致退出流程卡死 */
  async flush(timeoutMs = 5000): Promise<void> {
    const start = Date.now()
    while (this._pendingWrites > 0) {
      if (Date.now() - start > timeoutMs) {
        console.warn('[Keystore] flush timed out, forcing exit')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

export const keystoreService = new KeystoreService()
