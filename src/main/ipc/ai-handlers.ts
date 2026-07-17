// =============================================================
// AI / LLM IPC 处理器
// 已接入 pi-ai，支持 Provider 列表、模型列表、连接测试、流式对话
// =============================================================

import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import { type BrowserWindow, ipcMain } from 'electron'
import { startIpcTimer } from '../../shared/debug'
import * as IPC from '../../shared/ipc-channels'
import { dbService } from '../services/db-service'
import { piAIService } from '../services/pi-ai-service'

// 当前正在进行的流式会话计数(用于跟踪/调试)
let activeChatCount = 0

/**
 * R6-8 修复: IPC 输入验证 helper。
 * 防止 XSS'd renderer 传入 undefined/非字符串/超长/含空字节的输入到主进程。
 */
const MAX_STRING_LEN = 1_000_000 // 1MB,防止超大输入导致内存/性能问题
function validateString(value: unknown, field: string, maxLen = MAX_STRING_LEN): string {
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

function validateOptionalString(
  value: unknown,
  field: string,
  maxLen = MAX_STRING_LEN,
): string | undefined {
  if (value === undefined || value === null) return undefined
  return validateString(value, field, maxLen)
}

/**
 * 允许空字符串的验证: 用于消息 content 等合法可为空的字段。
 * createSession 会写入 role='system' content='' 的占位消息,
 * agent idle 时 assistant 可能只有 toolCalls 无文本内容。
 * 仍然拦截: 非字符串 / 超长 / 含空字节。
 */
function validateStringAllowEmpty(value: unknown, field: string, maxLen = MAX_STRING_LEN): string {
  if (typeof value !== 'string') {
    throw new Error(`[IPC] invalid ${field}: expected string, got ${typeof value}`)
  }
  if (value.length > maxLen) {
    throw new Error(`[IPC] invalid ${field}: too long (${value.length} > ${maxLen})`)
  }
  if (value.includes('\0')) {
    throw new Error(`[IPC] invalid ${field}: contains null byte`)
  }
  return value
}

// ----- Provider 列表缓存 -----
// listProviders() 内部会检测 Ollama(网络调用) + 遍历所有 provider 的 models,
// 耗时约 80ms。Provider 列表在会话期间很少变化(仅增删 API Key 或 Ollama 启停时),
// 缓存 5s 可将重复调用降至 0ms。写操作(set/delete API Key)后自动失效。
let providersCache: { data: unknown; ts: number } | null = null
const PROVIDERS_CACHE_TTL_MS = 5_000

function invalidateProvidersCache(): void {
  providersCache = null
}

export function registerAIHandlers(win: BrowserWindow) {
  // ----- 列出所有 Provider (缓存 5s) -----
  ipcMain.handle(IPC.IPC_AI_LIST_PROVIDERS, async () => {
    try {
      const now = Date.now()
      if (providersCache && now - providersCache.ts < PROVIDERS_CACHE_TTL_MS) {
        return providersCache.data
      }
      const result = await piAIService.listProviders()
      providersCache = { data: result, ts: now }
      return result
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] ai:list-providers failed:', msg)
      throw err
    }
  })

  // ----- 列出指定 Provider 的模型 -----
  ipcMain.handle(IPC.IPC_AI_LIST_MODELS, async (_e, providerId: string) => {
    const stop = startIpcTimer('ai:list-models')
    try {
      // R6-8 修复: 输入验证
      validateString(providerId, 'providerId', 256)
      return await piAIService.listModels(providerId)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] ai:list-models failed for "${providerId}":`, msg)
      throw err
    } finally {
      stop()
    }
  })

  // ----- 测试连接 -----
  ipcMain.handle(
    IPC.IPC_AI_TEST_CONNECTION,
    async (_e, providerId: string, apiKey: string, baseUrl?: string) => {
      const stop = startIpcTimer('ai:test-connection')
      try {
        // R6-8 修复: 输入验证
        validateString(providerId, 'providerId', 256)
        validateString(apiKey, 'apiKey', 10_000)
        validateOptionalString(baseUrl, 'baseUrl', 2048)
        // H-1 修复: testConnection 内部已 try-catch 返回结构化错误,
        // 但仍要兜底外部异常(如 keystoreService.ready 抛错)
        return await piAIService.testConnection(providerId, apiKey, baseUrl)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[IPC] ai:test-connection threw for "${providerId}":`, msg)
        return {
          success: false,
          latencyMs: 0,
          model: '',
          error: msg,
        }
      } finally {
        stop()
      }
    },
  )

  // ----- 设置 API Key (写操作后失效 provider 缓存) -----
  ipcMain.handle(IPC.IPC_AI_SET_API_KEY, async (_e, providerId: string, apiKey: string) => {
    // H-2 修复: keystoreService 可能抛错(如 keychain 不可用),必须 try-catch
    try {
      // R6-8 修复: 输入验证
      validateString(providerId, 'providerId', 256)
      validateString(apiKey, 'apiKey', 10_000)
      piAIService.setApiKey(providerId, apiKey)
      return { success: true }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] ai:set-api-key failed for "${providerId}":`, msg)
      return { success: false, error: msg }
    } finally {
      // 无论成功失败都失效缓存: keystore 状态可能已部分变更,下次调用需重新获取
      invalidateProvidersCache()
    }
  })

  // ----- 删除 API Key (写操作后失效 provider 缓存) -----
  ipcMain.handle(IPC.IPC_AI_DELETE_API_KEY, async (_e, providerId: string) => {
    try {
      // R6-8 修复: 输入验证
      validateString(providerId, 'providerId', 256)
      piAIService.deleteApiKey(providerId)
      return { success: true }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] ai:delete-api-key failed for "${providerId}":`, msg)
      return { success: false, error: msg }
    } finally {
      invalidateProvidersCache()
    }
  })

  // ----- OAuth 登录(P0 修复)-----
  ipcMain.handle(IPC.IPC_AI_OAUTH_LOGIN, async (_e, providerId: string) => {
    try {
      // R6-8 修复: 输入验证
      validateString(providerId, 'providerId', 256)
      return await piAIService.oauthLogin(providerId)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] ai:oauth-login failed for "${providerId}":`, msg)
      return { success: false, error: msg }
    }
  })

  // ----- 流式对话 -----
  // 前端调用 ai:chat 后，主进程通过 ai:chat-stream 逐事件推送
  ipcMain.handle(
    IPC.IPC_AI_CHAT,
    async (
      _e,
      params: {
        providerId: string
        modelId: string
        messages: Array<{ role: string; content: string }>
        systemPrompt?: string
        thinking?: string
        maxTokens?: number
      },
    ) => {
      // R6-8 修复: 输入验证(同步执行,在 IIFE 前)
      // P3-1 修复: 验证前移至 IIFE 外,使 IPC 返回值能反映验证失败
      //   之前验证在 IIFE 内异步执行,IPC 立即返回 success:true,
      //   调用方不订阅 stream 时无法感知验证失败
      try {
        validateString(params.providerId, 'params.providerId', 256)
        validateString(params.modelId, 'params.modelId', 256)
        if (!Array.isArray(params.messages)) {
          throw new Error('[IPC] invalid params.messages: expected array')
        }
        // P1-42 修复:thinking 通过 ModelThinkingLevel 类型安全转换
        // 6 个枚举值: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
        // 运行时枚举校验: 防止 XSS 注入非法值透传到 Provider API
        const ALLOWED_THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
        const thinking = params.thinking as ModelThinkingLevel | undefined
        if (thinking !== undefined && !ALLOWED_THINKING.includes(thinking)) {
          throw new Error(
            `[IPC] invalid thinking: ${thinking} (allowed: ${ALLOWED_THINKING.join(', ')})`,
          )
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[IPC] ai:chat validation failed:', msg)
        return { success: false, error: msg, sessionId: null }
      }

      // 异步执行流式对话，逐事件推送到渲染进程
      // P1-41 修复:跟踪会话状态,主动捕获 IIFE 异常,确保错误始终送到前端
      activeChatCount++
      const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const sendToRenderer = (event: unknown) => {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.IPC_AI_CHAT_STREAM, event)
        }
      }

      // thinking 已在上面验证,这里直接使用
      const validatedThinking = params.thinking as ModelThinkingLevel | undefined

      ;(async () => {
        try {
          const stream = piAIService.chatStream({
            providerId: params.providerId,
            modelId: params.modelId,
            messages: params.messages,
            systemPrompt: params.systemPrompt,
            thinking: validatedThinking,
            maxTokens: params.maxTokens,
          })

          for await (const event of stream) {
            sendToRenderer(event)
          }
        } catch (err: unknown) {
          sendToRenderer({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          })
        } finally {
          activeChatCount = Math.max(0, activeChatCount - 1)
          console.log(`[AI] Chat session ${sessionId} ended (active: ${activeChatCount})`)
        }
      })()

      return { success: true, message: 'Stream started', sessionId }
    },
  )

  // ----- 中止对话 -----
  ipcMain.handle(IPC.IPC_AI_CHAT_ABORT, async () => {
    try {
      piAIService.abortCurrentChat()
      return { success: true, activeChats: activeChatCount }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] ai:chat-abort failed:', msg)
      return { success: false, error: msg, activeChats: activeChatCount }
    }
  })

  // ----- 对话持久化: 保存消息 -----
  // R4 修复: timestamp 字段可选,未提供时默认 Date.now(),避免 NOT NULL 约束失败
  ipcMain.handle(
    IPC.IPC_CHAT_SAVE_MESSAGE,
    async (
      _e,
      msg: {
        sessionId?: string
        role: string
        content: string
        thinking?: string
        toolCalls?: string
        timestamp?: number
        provider?: string
        model?: string
        tokenInput?: number
        tokenOutput?: number
        cost?: number
      },
    ) => {
      try {
        if (!msg || typeof msg !== 'object') {
          return { success: false, error: 'msg must be a non-null object' }
        }
        // 健壮性: 若调用方未传 timestamp,自动填充当前时间
        // R6-8 修复: 输入验证
        validateString(msg.role, 'msg.role', 64)
        // content 允许空字符串: createSession 占位消息 / agent 无文本输出
        validateStringAllowEmpty(msg.content, 'msg.content', 10_000_000) // 10MB for large context
        validateOptionalString(msg.sessionId, 'msg.sessionId', 256)
        // 数值字段类型校验: 防止字符串/对象污染统计
        if (msg.tokenInput !== undefined && typeof msg.tokenInput !== 'number') {
          return { success: false, error: `[IPC] invalid msg.tokenInput: expected number, got ${typeof msg.tokenInput}`, id: -1 }
        }
        if (msg.tokenOutput !== undefined && typeof msg.tokenOutput !== 'number') {
          return { success: false, error: `[IPC] invalid msg.tokenOutput: expected number, got ${typeof msg.tokenOutput}`, id: -1 }
        }
        if (msg.cost !== undefined && typeof msg.cost !== 'number') {
          return { success: false, error: `[IPC] invalid msg.cost: expected number, got ${typeof msg.cost}`, id: -1 }
        }
        const enrichedMsg = { ...msg, timestamp: msg.timestamp ?? Date.now() }
        const id = dbService.saveChatMessage(enrichedMsg)
        return { success: id >= 0, id }
      } catch (err: unknown) {
        const msg2 = err instanceof Error ? err.message : String(err)
        console.error('[IPC] chat:save-message failed:', msg2)
        return { success: false, error: msg2, id: -1 }
      }
    },
  )

  // ----- 对话持久化: 加载消息 -----
  ipcMain.handle(IPC.IPC_CHAT_LOAD_MESSAGES, async (_e, sessionId?: string) => {
    try {
      validateOptionalString(sessionId, 'sessionId', 256)
      const messages = dbService.loadChatMessages(sessionId)
      return { success: true, messages }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] chat:load-messages failed:', msg)
      return { success: false, error: msg, messages: [] }
    }
  })

  // ----- 对话持久化: 删除会话 -----
  ipcMain.handle(IPC.IPC_CHAT_DELETE_SESSION, async (_e, sessionId: string) => {
    try {
      // R6-8 修复: 输入验证
      validateString(sessionId, 'sessionId', 256)
      const success = dbService.deleteChatSession(sessionId)
      return { success }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] chat:delete-session failed for "${sessionId}":`, msg)
      return { success: false, error: msg }
    }
  })

  // ----- 对话持久化: 列出所有会话 -----
  ipcMain.handle(IPC.IPC_CHAT_LIST_SESSIONS, async () => {
    try {
      const rows = dbService.listChatSessions()
      // DB 列名 snake_case → 前端 camelCase 映射
      const sessions = rows.map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.created_at,
        messageCount: r.message_count,
      }))
      return { success: true, sessions }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[IPC] chat:list-sessions failed:', msg)
      return { success: false, error: msg, sessions: [] }
    }
  })

  // ----- 自定义模型管理 (写操作后失效 provider 缓存,因 modelCount 会变) -----
  // P3-3 修复: 数值/布尔字段类型校验 helper,防止 XSS'd renderer 传入字符串/对象
  // 污染 settings.json (piAIService.addCustomModel 直接存储,不做类型转换)
  function validateOptionalNumber(value: unknown, field: string): number | undefined {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`[IPC] invalid ${field}: expected finite number, got ${typeof value}=${String(value).slice(0, 32)}`)
    }
    return value
  }
  function validateOptionalBoolean(value: unknown, field: string): boolean | undefined {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'boolean') {
      throw new Error(`[IPC] invalid ${field}: expected boolean, got ${typeof value}=${String(value).slice(0, 32)}`)
    }
    return value
  }

  ipcMain.handle(
    IPC.IPC_AI_ADD_CUSTOM_MODEL,
    async (
      _e,
      params: {
        providerId: string
        modelId: string
        name?: string
        contextWindow?: number
        maxOutputTokens?: number
        supportsReasoning?: boolean
      },
    ) => {
      try {
        if (!params || typeof params !== 'object') {
          return { success: false, error: 'params must be a non-null object' }
        }
        // R6-8 修复: 输入验证
        validateString(params.providerId, 'params.providerId', 256)
        validateString(params.modelId, 'params.modelId', 256)
        validateOptionalString(params.name, 'params.name', 256)
        // P3-3 修复: 数值/布尔字段类型校验
        validateOptionalNumber(params.contextWindow, 'params.contextWindow')
        validateOptionalNumber(params.maxOutputTokens, 'params.maxOutputTokens')
        validateOptionalBoolean(params.supportsReasoning, 'params.supportsReasoning')
        const result = piAIService.addCustomModel(params.providerId, {
          id: params.modelId,
          name: params.name,
          contextWindow: params.contextWindow,
          maxOutputTokens: params.maxOutputTokens,
          supportsReasoning: params.supportsReasoning,
        })
        invalidateProvidersCache()
        return result
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[IPC] ai:add-custom-model failed:', msg)
        return { success: false, error: msg }
      }
    },
  )

  ipcMain.handle(IPC.IPC_AI_DEL_CUSTOM_MODEL, async (_e, providerId: string, modelId: string) => {
    try {
      // R6-8 修复: 输入验证
      validateString(providerId, 'providerId', 256)
      validateString(modelId, 'modelId', 256)
      const removed = piAIService.removeCustomModel(providerId, modelId)
      invalidateProvidersCache()
      return { success: removed }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] ai:del-custom-model failed for "${providerId}/${modelId}":`, msg)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle(
    IPC.IPC_AI_UPDATE_CUSTOM_MODEL,
    async (
      _e,
      params: {
        providerId: string
        modelId: string
        name?: string
        contextWindow?: number
        maxOutputTokens?: number
        supportsReasoning?: boolean
        costPerInputToken?: number
        costPerOutputToken?: number
        api?: string
        baseUrl?: string
      },
    ) => {
      try {
        if (!params || typeof params !== 'object') {
          return { success: false, error: 'params must be a non-null object' }
        }
        // R6-8 修复: 输入验证
        validateString(params.providerId, 'params.providerId', 256)
        validateString(params.modelId, 'params.modelId', 256)
        validateOptionalString(params.name, 'params.name', 256)
        validateOptionalString(params.api, 'params.api', 64)
        validateOptionalString(params.baseUrl, 'params.baseUrl', 2048)
        // P3-3 修复: 数值/布尔字段类型校验
        validateOptionalNumber(params.contextWindow, 'params.contextWindow')
        validateOptionalNumber(params.maxOutputTokens, 'params.maxOutputTokens')
        validateOptionalNumber(params.costPerInputToken, 'params.costPerInputToken')
        validateOptionalNumber(params.costPerOutputToken, 'params.costPerOutputToken')
        validateOptionalBoolean(params.supportsReasoning, 'params.supportsReasoning')
        const updated = piAIService.updateCustomModel(params.providerId, params.modelId, {
          name: params.name,
          contextWindow: params.contextWindow,
          maxOutputTokens: params.maxOutputTokens,
          supportsReasoning: params.supportsReasoning,
          costPerInputToken: params.costPerInputToken,
          costPerOutputToken: params.costPerOutputToken,
          api: params.api,
          baseUrl: params.baseUrl,
        })
        invalidateProvidersCache()
        return { success: updated }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[IPC] ai:update-custom-model failed:', msg)
        return { success: false, error: msg }
      }
    },
  )

  console.log('[IPC] AI handlers registered (pi-ai integrated + chat persistence)')
}
