// =============================================================
// Tauri Bridge — 在渲染进程里构造与 Electron preload 完全一致的 window.api
//
// 这样 13 个页面的代码零改动: 它们继续调用 window.api.ai.listProviders() 等，
// 只不过底层从 ipcRenderer.invoke 变成了 @tauri-apps/api invoke('ipc_invoke', ...)
//
// 调用路径:
//   页面 → window.api.xxx.method(...args)
//        → invoke('ipc_invoke', {channel: 'xxx:method', args: [...]})
//        → Rust sidecar.rs ipc_invoke 命令
//        → sidecar (Node) 通过 stdin/stdout JSON-RPC 转发到对应 handler
//        → 返回结果
//
// 事件路径 (ai:chat-stream / agent:status-update / cron:status-update / feishu):
//   sidecar → stdout event 帧 → Rust window.emit(channel, data)
//           → 渲染进程 listen(channel, cb) → 调用页面注册的回调
// =============================================================

import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event'

// IPC 通道常量 (与 src/shared/ipc-channels.ts 保持一致)
const CH = {
  // AI
  AI_LIST_PROVIDERS: 'ai:list-providers',
  AI_LIST_MODELS: 'ai:list-models',
  AI_TEST_CONNECTION: 'ai:test-connection',
  AI_SET_API_KEY: 'ai:set-api-key',
  AI_DELETE_API_KEY: 'ai:delete-api-key',
  AI_CHAT: 'ai:chat',
  AI_CHAT_STREAM: 'ai:chat-stream',
  AI_CHAT_ABORT: 'ai:chat-abort',
  AI_OAUTH_LOGIN: 'ai:oauth-login',
  AI_ADD_CUSTOM_MODEL: 'ai:add-custom-model',
  AI_DEL_CUSTOM_MODEL: 'ai:del-custom-model',
  AI_UPDATE_CUSTOM_MODEL: 'ai:update-custom-model',
  // Ollama
  OLLAMA_DETECT: 'ollama:detect',
  OLLAMA_START_SERVE: 'ollama:start-serve',
  OLLAMA_STOP_SERVE: 'ollama:stop-serve',
  OLLAMA_LIST_MODELS: 'ollama:list-models',
  OLLAMA_PULL_MODEL: 'ollama:pull-model',
  OLLAMA_DELETE_MODEL: 'ollama:delete-model',
  OLLAMA_PULL_PROGRESS: 'ollama:pull-progress',
  // Agent
  AGENT_LIST: 'agent:list',
  AGENT_GET: 'agent:get',
  AGENT_UPDATE: 'agent:update',
  AGENT_TOGGLE: 'agent:toggle',
  AGENT_GET_SOUL: 'agent:get-soul',
  AGENT_SET_SOUL: 'agent:set-soul',
  AGENT_GET_RULES: 'agent:get-rules',
  AGENT_SET_RULES: 'agent:set-rules',
  AGENT_RUN_MANUAL: 'agent:run-manual',
  AGENT_GET_HISTORY: 'agent:get-history',
  AGENT_STATUS_UPDATE: 'agent:status-update',
  AGENT_ABORT: 'agent:abort',
  // EAA
  EAA_INFO: 'eaa:info',
  EAA_SCORE: 'eaa:score',
  EAA_RANKING: 'eaa:ranking',
  EAA_REPLAY: 'eaa:replay',
  EAA_ADD_EVENT: 'eaa:add-event',
  EAA_REVERT_EVENT: 'eaa:revert-event',
  EAA_HISTORY: 'eaa:history',
  EAA_SEARCH: 'eaa:search',
  EAA_RANGE: 'eaa:range',
  EAA_TAG: 'eaa:tag',
  EAA_STATS: 'eaa:stats',
  EAA_VALIDATE: 'eaa:validate',
  EAA_EXPORT: 'eaa:export',
  EAA_LIST_STUDENTS: 'eaa:list-students',
  EAA_ADD_STUDENT: 'eaa:add-student',
  EAA_DELETE_STUDENT: 'eaa:delete-student',
  EAA_SET_STUDENT_META: 'eaa:set-student-meta',
  EAA_IMPORT: 'eaa:import',
  EAA_CODES: 'eaa:codes',
  EAA_DOCTOR: 'eaa:doctor',
  EAA_SUMMARY: 'eaa:summary',
  EAA_DASHBOARD: 'eaa:dashboard',
  EAA_EXPORT_FORMATS: 'eaa:export-formats',
  // Privacy
  PRIVACY_INIT: 'privacy:init',
  PRIVACY_LOAD: 'privacy:load',
  PRIVACY_ENABLE: 'privacy:enable',
  PRIVACY_DISABLE: 'privacy:disable',
  PRIVACY_LIST: 'privacy:list',
  PRIVACY_ADD: 'privacy:add',
  PRIVACY_ANONYMIZE: 'privacy:anonymize',
  PRIVACY_DEANONYMIZE: 'privacy:deanonymize',
  PRIVACY_FILTER: 'privacy:filter',
  PRIVACY_DRYRUN: 'privacy:dryrun',
  PRIVACY_BACKUP: 'privacy:backup',
  PRIVACY_LOCK: 'privacy:lock',
  PRIVACY_STATUS: 'privacy:status',
  // Cron
  CRON_LIST: 'cron:list',
  CRON_ADD: 'cron:add',
  CRON_UPDATE: 'cron:update',
  CRON_REMOVE: 'cron:remove',
  CRON_TOGGLE: 'cron:toggle',
  CRON_RUN_NOW: 'cron:run-now',
  CRON_GET_LOGS: 'cron:get-logs',
  CRON_STATUS_UPDATE: 'cron:status-update',
  // Skill
  SKILL_LIST: 'skill:list',
  SKILL_GET: 'skill:get',
  SKILL_SAVE: 'skill:save',
  SKILL_DELETE: 'skill:delete',
  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_RESET: 'settings:reset',
  // MCP (Model Context Protocol)
  MCP_LIST: 'mcp:list',
  MCP_CONNECT: 'mcp:connect',
  MCP_DISCONNECT: 'mcp:disconnect',
  MCP_LIST_TOOLS: 'mcp:list-tools',
  MCP_TEST: 'mcp:test',
  MCP_ADD: 'mcp:add',
  MCP_UPDATE: 'mcp:update',
  MCP_REMOVE: 'mcp:remove',
  // System
  SYS_OPEN_DIALOG: 'sys:open-dialog',
  SYS_SAVE_DIALOG: 'sys:save-dialog',
  SYS_OPEN_EXTERNAL: 'sys:open-external',
  SYS_GET_PATH: 'sys:get-path',
  SYS_CHECK_UPDATE: 'sys:check-update',
  SYS_SHOW_UPDATE_DIALOG: 'sys:show-update-dialog',
  SYS_NOTIFICATION: 'sys:notification',
  SYS_READ_FILE: 'sys:read-file',
  // Profile
  PROFILE_GET: 'profile:get',
  PROFILE_SET: 'profile:set',
  // Class
  CLASS_LIST: 'class:list',
  CLASS_CREATE: 'class:create',
  CLASS_UPDATE: 'class:update',
  CLASS_ARCHIVE: 'class:archive',
  CLASS_RESTORE: 'class:restore',
  CLASS_DELETE: 'class:delete',
  CLASS_ASSIGN: 'class:assign',
  CLASS_REMOVE: 'class:remove',
  // Academic
  ACADEMIC_GET_CONFIG: 'academic:get-config',
  ACADEMIC_SET_CONFIG: 'academic:set-config',
  ACADEMIC_LIST_EXAMS: 'academic:list-exams',
  ACADEMIC_CREATE_EXAM: 'academic:create-exam',
  ACADEMIC_DELETE_EXAM: 'academic:delete-exam',
  ACADEMIC_GET_GRADES: 'academic:get-grades',
  ACADEMIC_SET_GRADE: 'academic:set-grade',
  ACADEMIC_BATCH_SET_GRADES: 'academic:batch-set-grades',
  ACADEMIC_GET_CLASS_GRADES: 'academic:get-class-grades',
  ACADEMIC_ANALYZE_PAPER: 'academic:analyze-paper',
  // Chat persistence
  CHAT_SAVE_MESSAGE: 'chat:save-message',
  CHAT_LOAD_MESSAGES: 'chat:load-messages',
  CHAT_DELETE_SESSION: 'chat:delete-session',
  CHAT_LIST_SESSIONS: 'chat:list-sessions',
  CHAT_WRITE_RENDERER: 'log:write-renderer',
  // Log
  LOG_LIST: 'log:list',
  LOG_READ: 'log:read',
  LOG_CLEAR: 'log:clear',
  LOG_FILTER: 'log:filter',
  LOG_SEARCH: 'log:search',
  LOG_EXPORT: 'log:export',
  LOG_EXPORT_DIALOG: 'log:export-dialog',
  // Feishu
  FEISHU_TEST: 'feishu:test',
  FEISHU_BITABLE: 'feishu:bitable',
  FEISHU_SEND: 'feishu:send',
  FEISHU_STATUS: 'feishu:status',
  FEISHU_SYNC_NOW: 'feishu:sync-now',
  FEISHU_BOT_START: 'feishu:bot-start',
  FEISHU_BOT_STOP: 'feishu:bot-stop',
  FEISHU_BOT_STATUS: 'feishu:bot-status',
  FEISHU_BOT_STATUS_UPDATE: 'feishu:bot-status-update',
} as const

// 通用 invoke: 转发到 Rust sidecar.rs 的 ipc_invoke 命令
function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  return tauriInvoke<T>('ipc_invoke', { channel, args })
}

// 通用事件订阅: 返回取消订阅函数
async function subscribe(channel: string, callback: (data: unknown) => void): Promise<UnlistenFn> {
  return tauriListen<unknown>(channel, (event) => {
    callback(event.payload)
  })
}

// ============================================================
// 构造与 Electron preload 完全一致的 window.api
// ============================================================
function buildAPI() {
  return {
    // ---------- AI / LLM ----------
    ai: {
      listProviders: () => call(CH.AI_LIST_PROVIDERS),
      listModels: (providerId: string) => call(CH.AI_LIST_MODELS, providerId),
      testConnection: (providerId: string, apiKey: string, baseUrl?: string) =>
        call(CH.AI_TEST_CONNECTION, providerId, apiKey, baseUrl),
      setApiKey: (providerId: string, apiKey: string) =>
        call(CH.AI_SET_API_KEY, providerId, apiKey),
      deleteApiKey: (providerId: string) => call(CH.AI_DELETE_API_KEY, providerId),
      oauthLogin: (providerId: string) => call(CH.AI_OAUTH_LOGIN, providerId),
      chat: (params: unknown) => call(CH.AI_CHAT, params),
      abortChat: () => call(CH.AI_CHAT_ABORT),
      addCustomModel: (params: unknown) => call(CH.AI_ADD_CUSTOM_MODEL, params),
      deleteCustomModel: (providerId: string, modelId: string) =>
        call(CH.AI_DEL_CUSTOM_MODEL, providerId, modelId),
      updateCustomModel: (params: unknown) => call(CH.AI_UPDATE_CUSTOM_MODEL, params),
      onStream: (callback: (event: unknown) => void) => {
        let unlisten: UnlistenFn | null = null
        let cancelled = false
        subscribe(CH.AI_CHAT_STREAM, callback)
          .then((fn) => {
            if (cancelled) fn()
            else unlisten = fn
          })
          .catch((err) => console.warn('[tauri-bridge] subscribe AI_CHAT_STREAM failed:', err))
        return () => {
          cancelled = true
          unlisten?.()
        }
      },
    },

    // ---------- 本地模型 (Ollama) ----------
    ollama: {
      detect: () => call(CH.OLLAMA_DETECT),
      startServe: () => call(CH.OLLAMA_START_SERVE),
      stopServe: () => call(CH.OLLAMA_STOP_SERVE),
      listModels: () => call(CH.OLLAMA_LIST_MODELS),
      pullModel: (modelName: string) => call(CH.OLLAMA_PULL_MODEL, modelName),
      deleteModel: (modelName: string) => call(CH.OLLAMA_DELETE_MODEL, modelName),
      onPullProgress: (callback: (info: unknown) => void) => {
        let unlisten: UnlistenFn | null = null
        let cancelled = false
        subscribe(CH.OLLAMA_PULL_PROGRESS, callback)
          .then((fn) => {
            if (cancelled) fn()
            else unlisten = fn
          })
          .catch((err) =>
            console.warn('[tauri-bridge] subscribe OLLAMA_PULL_PROGRESS failed:', err),
          )
        return () => {
          cancelled = true
          unlisten?.()
        }
      },
    },

    // ---------- Agent ----------
    agent: {
      list: () => call(CH.AGENT_LIST),
      get: (id: string) => call(CH.AGENT_GET, id),
      toggle: (id: string, enabled: boolean) => call(CH.AGENT_TOGGLE, id, enabled),
      update: (id: string, patch: unknown) => call(CH.AGENT_UPDATE, id, patch),
      getSoul: (id: string) => call(CH.AGENT_GET_SOUL, id),
      setSoul: (id: string, content: string) => call(CH.AGENT_SET_SOUL, id, content),
      getRules: (id: string) => call(CH.AGENT_GET_RULES, id),
      setRules: (id: string, content: string) => call(CH.AGENT_SET_RULES, id, content),
      runManual: (id: string, prompt: string, history?: unknown[]) =>
        call(CH.AGENT_RUN_MANUAL, id, prompt, history),
      getHistory: (id: string) => call(CH.AGENT_GET_HISTORY, id),
      abort: (id: string) => call(CH.AGENT_ABORT, id),
      onStatusUpdate: (callback: (data: unknown) => void) => {
        let unlisten: UnlistenFn | null = null
        let cancelled = false
        subscribe(CH.AGENT_STATUS_UPDATE, callback)
          .then((fn) => {
            if (cancelled) fn()
            else unlisten = fn
          })
          .catch((err) => console.warn('[tauri-bridge] subscribe AGENT_STATUS_UPDATE failed:', err))
        return () => {
          cancelled = true
          unlisten?.()
        }
      },
    },

    // ---------- EAA ----------
    eaa: {
      info: () => call(CH.EAA_INFO),
      score: (name: string) => call(CH.EAA_SCORE, name),
      ranking: (n?: number) => call(CH.EAA_RANKING, n),
      replay: () => call(CH.EAA_REPLAY),
      addEvent: (params: unknown) => call(CH.EAA_ADD_EVENT, params),
      revertEvent: (eventId: string, reason: string) => call(CH.EAA_REVERT_EVENT, eventId, reason),
      history: (name: string) => call(CH.EAA_HISTORY, name),
      search: (query: string, limit?: number) => call(CH.EAA_SEARCH, query, limit),
      range: (start: string, end: string, limit?: number) => call(CH.EAA_RANGE, start, end, limit),
      tag: (tag?: string) => call(CH.EAA_TAG, tag),
      stats: () => call(CH.EAA_STATS),
      validate: () => call(CH.EAA_VALIDATE),
      export: (format: string, outputFile?: string) => call(CH.EAA_EXPORT, format, outputFile),
      listStudents: () => call(CH.EAA_LIST_STUDENTS),
      addStudent: (name: string) => call(CH.EAA_ADD_STUDENT, name),
      deleteStudent: (name: string, reason?: string) =>
        call(CH.EAA_DELETE_STUDENT, name, { confirm: true, reason }),
      setStudentMeta: (params: unknown) => call(CH.EAA_SET_STUDENT_META, params),
      import: (filePath: string) => call(CH.EAA_IMPORT, filePath),
      codes: () => call(CH.EAA_CODES),
      doctor: () => call(CH.EAA_DOCTOR),
      summary: (since?: string, until?: string) => call(CH.EAA_SUMMARY, since, until),
      dashboard: (outputDir?: string) => call(CH.EAA_DASHBOARD, outputDir),
      exportFormats: () => call(CH.EAA_EXPORT_FORMATS),
    },

    // ---------- 隐私引擎 ----------
    privacy: {
      init: (password: string, autoScan?: boolean) => call(CH.PRIVACY_INIT, password, autoScan),
      load: (password: string) => call(CH.PRIVACY_LOAD, password),
      enable: () => call(CH.PRIVACY_ENABLE),
      disable: (password: string) => call(CH.PRIVACY_DISABLE, password),
      list: (password?: string) => call(CH.PRIVACY_LIST, password),
      add: (entityType: string, text: string) => call(CH.PRIVACY_ADD, entityType, text),
      anonymize: (text: string) => call(CH.PRIVACY_ANONYMIZE, text),
      deanonymize: (text: string) => call(CH.PRIVACY_DEANONYMIZE, text),
      filter: (receiver: string, text: string) => call(CH.PRIVACY_FILTER, receiver, text),
      dryrun: (text: string) => call(CH.PRIVACY_DRYRUN, text),
      backup: (destPath: string) => call(CH.PRIVACY_BACKUP, destPath),
      lock: () => call(CH.PRIVACY_LOCK),
      status: () => call(CH.PRIVACY_STATUS),
    },

    // ---------- 定时任务 ----------
    cron: {
      list: () => call(CH.CRON_LIST),
      add: (task: unknown) => call(CH.CRON_ADD, task),
      update: (id: string, patch: unknown) => call(CH.CRON_UPDATE, id, patch),
      remove: (id: string) => call(CH.CRON_REMOVE, id),
      toggle: (id: string, enabled: boolean) => call(CH.CRON_TOGGLE, id, enabled),
      runNow: (id: string) => call(CH.CRON_RUN_NOW, id),
      getLogs: (taskId?: string) => call(CH.CRON_GET_LOGS, taskId),
      onStatusUpdate: (callback: (data: unknown) => void) => {
        let unlisten: UnlistenFn | null = null
        let cancelled = false
        subscribe(CH.CRON_STATUS_UPDATE, callback)
          .then((fn) => {
            if (cancelled) fn()
            else unlisten = fn
          })
          .catch((err) => console.warn('[tauri-bridge] subscribe CRON_STATUS_UPDATE failed:', err))
        return () => {
          cancelled = true
          unlisten?.()
        }
      },
    },

    // ---------- 技能 ----------
    skill: {
      list: () => call(CH.SKILL_LIST),
      get: (name: string) => call(CH.SKILL_GET, name),
      save: (name: string, content: string) => call(CH.SKILL_SAVE, name, content),
      delete: (name: string) => call(CH.SKILL_DELETE, name),
    },

    // ---------- 设置 ----------
    settings: {
      get: () => call(CH.SETTINGS_GET),
      set: (path: string, value: unknown) => call(CH.SETTINGS_SET, path, value),
      reset: () => call(CH.SETTINGS_RESET),
    },

    // ---------- MCP (Model Context Protocol) ----------
    mcp: {
      list: () => call(CH.MCP_LIST),
      connect: (serverId: string) => call(CH.MCP_CONNECT, serverId),
      disconnect: (serverId: string) => call(CH.MCP_DISCONNECT, serverId),
      listTools: (serverId: string) => call(CH.MCP_LIST_TOOLS, serverId),
      test: (serverId: string) => call(CH.MCP_TEST, serverId),
      add: (config: unknown) => call(CH.MCP_ADD, config),
      update: (serverId: string, patch: unknown) => call(CH.MCP_UPDATE, serverId, patch),
      remove: (serverId: string) => call(CH.MCP_REMOVE, serverId),
    },

    // ---------- 系统 ----------
    sys: {
      openDialog: (options: unknown) => call(CH.SYS_OPEN_DIALOG, options),
      saveDialog: (options: unknown) => call(CH.SYS_SAVE_DIALOG, options),
      openExternal: (url: string) => call(CH.SYS_OPEN_EXTERNAL, url),
      getPath: (name: string) => call(CH.SYS_GET_PATH, name),
      checkUpdate: () => call(CH.SYS_CHECK_UPDATE),
      showUpdateDialog: () => call(CH.SYS_SHOW_UPDATE_DIALOG),
      notify: (title: string, body: string) => call(CH.SYS_NOTIFICATION, title, body),
      readFile: (filePath: string) => call(CH.SYS_READ_FILE, filePath),
    },

    // ---------- 学生档案 ----------
    profile: {
      get: (name: string) => call(CH.PROFILE_GET, name),
      set: (name: string, data: unknown) => call(CH.PROFILE_SET, name, data),
    },

    // ---------- 班级管理 ----------
    class: {
      list: () => call(CH.CLASS_LIST),
      create: (params: unknown) => call(CH.CLASS_CREATE, params),
      update: (id: string, fields: unknown) => call(CH.CLASS_UPDATE, id, fields),
      archive: (id: string) => call(CH.CLASS_ARCHIVE, id),
      restore: (id: string) => call(CH.CLASS_RESTORE, id),
      delete: (id: string) => call(CH.CLASS_DELETE, id),
      assign: (params: unknown) => call(CH.CLASS_ASSIGN, params),
      removeStudent: (params: unknown) => call(CH.CLASS_REMOVE, params),
    },

    // ---------- 学业管理 ----------
    academic: {
      getConfig: () => call(CH.ACADEMIC_GET_CONFIG),
      setConfig: (config: unknown) => call(CH.ACADEMIC_SET_CONFIG, config),
      listExams: (semester?: string) => call(CH.ACADEMIC_LIST_EXAMS, semester),
      createExam: (exam: unknown) => call(CH.ACADEMIC_CREATE_EXAM, exam),
      deleteExam: (examId: string) => call(CH.ACADEMIC_DELETE_EXAM, examId),
      getGrades: (studentName: string) => call(CH.ACADEMIC_GET_GRADES, studentName),
      setGrade: (record: unknown) => call(CH.ACADEMIC_SET_GRADE, record),
      batchSetGrades: (records: unknown[]) => call(CH.ACADEMIC_BATCH_SET_GRADES, records),
      getClassGrades: (studentNames: string[], examId: string, subjectId?: string) =>
        call(CH.ACADEMIC_GET_CLASS_GRADES, studentNames, examId, subjectId),
      analyzePaper: (filePath: string, examId?: string, subjectId?: string) =>
        call(CH.ACADEMIC_ANALYZE_PAPER, filePath, examId, subjectId),
    },

    // ---------- 对话持久化 ----------
    chat: {
      saveMessage: (msg: unknown) => call(CH.CHAT_SAVE_MESSAGE, msg),
      loadMessages: (sessionId?: string) => call(CH.CHAT_LOAD_MESSAGES, sessionId),
      deleteSession: (sessionId: string) => call(CH.CHAT_DELETE_SESSION, sessionId),
      listSessions: () => call(CH.CHAT_LIST_SESSIONS),
    },

    // ---------- 日志系统 ----------
    log: {
      list: () => call(CH.LOG_LIST),
      read: (name: string, lines?: number) => call(CH.LOG_READ, name, lines),
      clear: () => call(CH.LOG_CLEAR),
      filter: (name: string, levels: string[], lines?: number) =>
        call(CH.LOG_FILTER, name, levels, lines),
      search: (name: string, query: string, lines?: number) =>
        call(CH.LOG_SEARCH, name, query, lines),
      export: (name: string, targetPath: string) => call(CH.LOG_EXPORT, name, targetPath),
      exportWithDialog: (name: string) => call(CH.LOG_EXPORT_DIALOG, name),
      forward: (level: string, msg: string) => call(CH.CHAT_WRITE_RENDERER, level, msg),
    },

    // ---------- 飞书集成 ----------
    feishu: {
      test: (appId: string) => call(CH.FEISHU_TEST, appId),
      listBitable: (appId: string, appToken: string) => call(CH.FEISHU_BITABLE, appId, appToken),
      send: (appId: string, userOpenId: string, text: string) =>
        call(CH.FEISHU_SEND, appId, userOpenId, text),
      status: () => call(CH.FEISHU_STATUS),
      syncNow: (
        appId: string,
        appToken: string,
        tableId: string,
        fields: Record<string, unknown>,
      ) => call(CH.FEISHU_SYNC_NOW, appId, appToken, tableId, fields),
      botStart: () => call(CH.FEISHU_BOT_START),
      botStop: () => call(CH.FEISHU_BOT_STOP),
      botStatus: () => call(CH.FEISHU_BOT_STATUS),
      onBotStatusUpdate: (callback: (info: unknown) => void) => {
        let unlisten: UnlistenFn | null = null
        let cancelled = false
        subscribe(CH.FEISHU_BOT_STATUS_UPDATE, callback)
          .then((fn) => {
            if (cancelled) fn()
            else unlisten = fn
          })
          .catch((err) =>
            console.warn('[tauri-bridge] subscribe FEISHU_BOT_STATUS_UPDATE failed:', err),
          )
        return () => {
          cancelled = true
          unlisten?.()
        }
      },
    },
  }
}

// ============================================================
// 安装到 window.api (与 Electron preload 行为一致)
// ============================================================
export function installTauriBridge() {
  const api = buildAPI()
  ;(window as unknown as { api: unknown }).api = api
  return api
}
