// =============================================================
// IPC 覆盖率深度测试 — 验证所有注册的 IPC 通道可从渲染进程访问并返回预期类型
//
// 覆盖范围:
//   1. API namespace 存在性 (15 个顶层命名空间)
//   2. 方法存在性 (每个 namespace 的预期方法)
//   3. 方法类型检查 (typeof === 'function')
//   4. preload 与 tauri-bridge 方法一致性 (expected ⊆ actual)
//   5. IPC 通道常量 (ipc-channels.ts 全部 IPC_* 非空字符串 + 格式 + 无重复)
//   6. Handler 注册 (调用各 namespace API 不抛 "No handler registered")
//   7. 只读操作返回类型校验 (array/object/string/boolean)
//   8. 错误处理 (缺失参数返回结构化错误而非崩溃)
//
// 适用: Tauri 2 + Node sidecar, CDP 端口 9222
// =============================================================
import http from 'node:http'

const CDP_PORT = 9222
const BASE = `http://127.0.0.1:${CDP_PORT}`

// ---- 期望的 API 表面 (源自 src/main/preload/index.ts 规范定义) ----
const EXPECTED = {
  ai: ['listProviders', 'listModels', 'testConnection', 'setApiKey', 'deleteApiKey', 'oauthLogin', 'chat', 'abortChat', 'addCustomModel', 'deleteCustomModel', 'updateCustomModel', 'onStream'],
  ollama: ['detect', 'startServe', 'stopServe', 'listModels', 'pullModel', 'deleteModel', 'onPullProgress'],
  agent: ['list', 'get', 'toggle', 'update', 'getSoul', 'setSoul', 'getRules', 'setRules', 'runManual', 'getHistory', 'abort', 'onStatusUpdate'],
  eaa: ['info', 'score', 'ranking', 'replay', 'addEvent', 'revertEvent', 'history', 'search', 'range', 'tag', 'stats', 'validate', 'export', 'listStudents', 'addStudent', 'deleteStudent', 'setStudentMeta', 'import', 'codes', 'doctor', 'summary', 'dashboard', 'exportFormats'],
  academic: ['getConfig', 'setConfig', 'listExams', 'createExam', 'deleteExam', 'getGrades', 'setGrade', 'batchSetGrades', 'getClassGrades'],
  class: ['list', 'create', 'update', 'archive', 'restore', 'delete', 'assign', 'removeStudent'],
  cron: ['list', 'add', 'update', 'remove', 'toggle', 'runNow', 'getLogs', 'onStatusUpdate'],
  settings: ['get', 'set', 'reset'],
  privacy: ['init', 'load', 'enable', 'disable', 'list', 'add', 'anonymize', 'deanonymize', 'filter', 'dryrun', 'backup', 'lock', 'status'],
  log: ['list', 'read', 'clear', 'filter', 'search', 'export', 'exportWithDialog', 'forward'],
  skill: ['list', 'get', 'save', 'delete'],
  sys: ['openDialog', 'saveDialog', 'openExternal', 'getPath', 'checkUpdate', 'showUpdateDialog', 'notify', 'readFile'],
  profile: ['get', 'set'],
  chat: ['saveMessage', 'loadMessages', 'deleteSession', 'listSessions'],
  feishu: ['test', 'listBitable', 'send', 'status', 'syncNow', 'botStart', 'botStop', 'botStatus', 'onBotStatusUpdate'],
}

// ---- 全部 IPC_* 通道常量 (源自 src/shared/ipc-channels.ts) ----
const IPC_CHANNELS = [
  // AI / LLM
  'ai:list-providers', 'ai:list-models', 'ai:test-connection', 'ai:set-api-key', 'ai:delete-api-key', 'ai:chat', 'ai:chat-stream', 'ai:chat-abort', 'ai:oauth-login', 'ai:add-custom-model', 'ai:del-custom-model', 'ai:update-custom-model',
  // Ollama
  'ollama:detect', 'ollama:start-serve', 'ollama:stop-serve', 'ollama:list-models', 'ollama:pull-model', 'ollama:delete-model', 'ollama:pull-progress',
  // Agent
  'agent:list', 'agent:get', 'agent:update', 'agent:toggle', 'agent:get-soul', 'agent:set-soul', 'agent:get-rules', 'agent:set-rules', 'agent:run-manual', 'agent:get-history', 'agent:status-update', 'agent:abort',
  // EAA
  'eaa:info', 'eaa:score', 'eaa:ranking', 'eaa:replay', 'eaa:add-event', 'eaa:revert-event', 'eaa:history', 'eaa:search', 'eaa:range', 'eaa:tag', 'eaa:stats', 'eaa:validate', 'eaa:export', 'eaa:list-students', 'eaa:add-student', 'eaa:delete-student', 'eaa:set-student-meta', 'eaa:import', 'eaa:codes', 'eaa:doctor', 'eaa:summary', 'eaa:dashboard', 'eaa:export-formats',
  // Privacy
  'privacy:init', 'privacy:load', 'privacy:enable', 'privacy:disable', 'privacy:list', 'privacy:add', 'privacy:anonymize', 'privacy:deanonymize', 'privacy:filter', 'privacy:dryrun', 'privacy:backup', 'privacy:lock', 'privacy:status',
  // Cron
  'cron:list', 'cron:add', 'cron:update', 'cron:remove', 'cron:toggle', 'cron:run-now', 'cron:get-logs', 'cron:status-update',
  // Skill
  'skill:list', 'skill:get', 'skill:save', 'skill:delete',
  // Settings
  'settings:get', 'settings:set', 'settings:reset',
  // Sys
  'sys:open-dialog', 'sys:save-dialog', 'sys:open-external', 'sys:get-path', 'sys:check-update', 'sys:notification', 'sys:read-file', 'sys:show-update-dialog',
  // Profile
  'profile:get', 'profile:set',
  // Academic
  'academic:get-config', 'academic:set-config', 'academic:list-exams', 'academic:create-exam', 'academic:delete-exam', 'academic:get-grades', 'academic:set-grade', 'academic:batch-set-grades', 'academic:get-class-grades', 'academic:analyze-paper',
  // Class
  'class:list', 'class:create', 'class:update', 'class:archive', 'class:restore', 'class:delete', 'class:assign', 'class:remove',
  // Chat
  'chat:save-message', 'chat:load-messages', 'chat:delete-session', 'chat:list-sessions',
  // Feishu
  'feishu:test', 'feishu:bitable', 'feishu:send', 'feishu:status', 'feishu:sync-now', 'feishu:bot-start', 'feishu:bot-stop', 'feishu:bot-status', 'feishu:bot-status-update',
  // Log
  'log:list', 'log:read', 'log:clear', 'log:filter', 'log:search', 'log:export', 'log:export-dialog', 'log:write-renderer',
]

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error(`JSON parse fail: ${e.message}`)) }
      })
    }).on('error', reject)
  })
}

// 判定返回值是否为"受控错误" (非崩溃: 无 __error 或 __error 是短消息且无栈帧)
function isControlled(r) {
  if (r && typeof r === 'object' && r.__error) {
    const e = String(r.__error)
    if (/at\s.+:\d+:\d+/.test(e)) return false
    if (/TypeError|ReferenceError|SyntaxError|RangeError/.test(e)) return false
    return e.length < 500
  }
  return true
}

// 判定返回值是否为"结构化错误" (null / 含 success:false / 含 error 字段 / 字符串 / 数组)
function isStructuredError(r) {
  if (r === null || r === undefined) return true
  if (r && typeof r === 'object' && r.__error) return isControlled(r)
  if (typeof r === 'object') {
    return r.success === false || typeof r.error === 'string' || typeof r.stderr === 'string' || Array.isArray(r) || 'code' in r
  }
  return typeof r === 'string'
}

async function main() {
  const results = []
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  }

  const targets = (await fetchJson(`${BASE}/json`)).filter((t) => t.type === 'page')
  if (targets.length === 0) { console.log('FAIL: No CDP targets'); process.exit(1) }
  const target = targets[0]
  console.log(`Target: ${target.title} (${target.url})\n`)

  const { default: WebSocket } = await import('ws')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let msgId = 1
  const pending = new Map()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = msgId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evalInPage = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) {
      throw new Error(`Eval error: ${r.result.exceptionDetails.text}`)
    }
    return r.result?.result?.value
  }

  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP connected, running tests...\n')

  // callIpc: 包装 window.__EAA_API__ || window.api, 捕获异常为 {__error}
  const callIpc = async (code) => {
    return await evalInPage(`
      (async function() {
        const api = window.__EAA_API__ || window.api;
        if (!api) return { __error: 'no-api' };
        try {
          ${code}
        } catch (e) {
          return { __error: String(e && e.message ? e.message : e) };
        }
      })()
    `)
  }

  // 等待 window.api 就绪 (最多 6 秒)
  let apiReady = false
  for (let i = 0; i < 30; i++) {
    const ok = await evalInPage(`(function(){ return !!(window.__EAA_API__ || window.api); })()`)
    if (ok) { apiReady = true; break }
    await new Promise((r) => setTimeout(r, 200))
  }

  // =============================================================
  // 1. API namespace 存在性 + 方法存在性 + 类型检查
  // =============================================================
  console.log('--- 1. API 表面: namespace / 方法存在性 / 类型 ---')

  record('window.api 可用 (Tauri bridge 已安装)', apiReady, apiReady ? 'ready' : 'timeout waiting for window.api')

  // 一次性获取完整 API 形状 {ns: {method: typeof}}
  const shape = apiReady
    ? await evalInPage(`
        (function(){
          const api = window.__EAA_API__ || window.api;
          if(!api) return null;
          const out = {};
          for(const ns of Object.keys(api)){
            out[ns] = {};
            const v = api[ns];
            if(v && typeof v === 'object'){
              for(const m of Object.keys(v)){ out[ns][m] = typeof v[m]; }
            }
          }
          return out;
        })()
      `)
    : null

  for (const ns of Object.keys(EXPECTED)) {
    const actual = shape?.[ns]
    const expectedMethods = EXPECTED[ns]
    if (!actual) {
      record(`namespace.${ns} 方法完整 (${expectedMethods.length} methods)`, false, `namespace 缺失`)
      continue
    }
    const missing = expectedMethods.filter((m) => actual[m] !== 'function')
    const badType = expectedMethods.filter((m) => actual[m] !== undefined && actual[m] !== 'function')
    const ok = missing.length === 0 && badType.length === 0
    const detail = missing.length
      ? `missing=${missing.join(',')}`
      : (badType.length ? `badType=${badType.map((m) => `${m}:${actual[m]}`).join(',')}` : `all ${expectedMethods.length} typeof function`)
    record(`namespace.${ns} 方法完整 (${expectedMethods.length} methods)`, ok, detail)
  }

  // =============================================================
  // 4. preload 与 tauri-bridge 一致性 (expected ⊆ actual, 报告 extras)
  // =============================================================
  console.log('\n--- 2. preload / tauri-bridge 方法一致性 ---')
  {
    const allMissing = []
    const allExtras = []
    for (const ns of Object.keys(EXPECTED)) {
      const actual = shape?.[ns] || {}
      for (const m of EXPECTED[ns]) {
        if (actual[m] !== 'function') allMissing.push(`${ns}.${m}`)
      }
      for (const m of Object.keys(actual)) {
        if (!EXPECTED[ns].includes(m)) allExtras.push(`${ns}.${m}`)
      }
    }
    record('preload 方法 ⊆ tauri-bridge 方法 (全部预期方法存在)', allMissing.length === 0,
      allMissing.length ? `missing=${allMissing.join(',')}` : `extras=${allExtras.join(',') || 'none'}`)
  }

  // =============================================================
  // 5. IPC 通道常量校验
  // =============================================================
  console.log('\n--- 3. IPC 通道常量 (ipc-channels.ts) ---')
  {
    const nonEmpty = IPC_CHANNELS.every((c) => typeof c === 'string' && c.length > 0)
    record('全部 IPC_* 常量为非空字符串', nonEmpty, `count=${IPC_CHANNELS.length} bad=${IPC_CHANNELS.filter((c) => !c).length}`)
  }
  {
    const re = /^[a-z]+:[a-z][a-z-]*$/
    const bad = IPC_CHANNELS.filter((c) => !re.test(c))
    record('全部通道匹配 ns:method 格式', bad.length === 0, bad.length ? `bad=${bad.join(',')}` : `all ${IPC_CHANNELS.length} ok`)
  }
  {
    const seen = new Set()
    const dup = []
    for (const c of IPC_CHANNELS) { if (seen.has(c)) dup.push(c); else seen.add(c) }
    record('通道名无重复', dup.length === 0, dup.length ? `dup=${dup.join(',')}` : `unique=${seen.size}`)
  }

  // =============================================================
  // 6. Handler 注册: 调用各 namespace API 不抛 "No handler registered"
  // =============================================================
  console.log('\n--- 4. Handler 注册扫描 (无 "No handler registered") ---')
  if (!apiReady) {
    record('Handler 注册扫描', false, 'window.api 不可用, 跳过')
  } else {
    const sweep = [
      ['ai.listProviders', 'api.ai.listProviders()'],
      ['ollama.detect', 'api.ollama.detect()'],
      ['agent.list', 'api.agent.list()'],
      ['eaa.info', 'api.eaa.info()'],
      ['privacy.status', 'api.privacy.status()'],
      ['cron.list', 'api.cron.list()'],
      ['skill.list', 'api.skill.list()'],
      ['settings.get', 'api.settings.get()'],
      ['sys.getPath', "api.sys.getPath('userData')"],
      ['class.list', 'api.class.list()'],
      ['academic.getConfig', 'api.academic.getConfig()'],
      ['chat.listSessions', 'api.chat.listSessions()'],
      ['log.list', 'api.log.list()'],
      ['feishu.status', 'api.feishu.status()'],
      ['profile.get', "api.profile.get('__cdp_handler_probe__')"],
    ]
    const handlerErrors = []
    for (const [name, expr] of sweep) {
      const r = await callIpc(`const res = await ${expr}; return res;`)
      const blob = JSON.stringify(r)
      if (/no handler|handler registered|not registered/i.test(blob)) {
        handlerErrors.push(`${name}: ${r?.__error || blob}`)
      }
    }
    record('15 namespace 扫描无 "No handler registered" 错误', handlerErrors.length === 0,
      handlerErrors.length ? handlerErrors.join(' | ') : 'all 15 namespaces reachable')
  }

  // =============================================================
  // 7. 只读操作返回类型校验
  // =============================================================
  console.log('\n--- 5. 只读操作返回类型校验 ---')

  // ai.listProviders → array
  {
    const r = await callIpc(`const res = await api.ai.listProviders(); return res;`)
    record('ai.listProviders 返回 array', !r?.__error && Array.isArray(r),
      `type=${Array.isArray(r) ? 'array' : typeof r} len=${Array.isArray(r) ? r.length : ''} err=${r?.__error || ''}`)
  }
  // agent.list → array
  {
    const r = await callIpc(`const res = await api.agent.list(); return res;`)
    record('agent.list 返回 array', !r?.__error && Array.isArray(r),
      `type=${Array.isArray(r) ? 'array' : typeof r} len=${Array.isArray(r) ? r.length : ''} err=${r?.__error || ''}`)
  }
  // cron.list → array
  {
    const r = await callIpc(`const res = await api.cron.list(); return res;`)
    record('cron.list 返回 array', !r?.__error && Array.isArray(r),
      `type=${Array.isArray(r) ? 'array' : typeof r} len=${Array.isArray(r) ? r.length : ''} err=${r?.__error || ''}`)
  }
  // cron.getLogs → array
  {
    const r = await callIpc(`const res = await api.cron.getLogs(); return res;`)
    record('cron.getLogs 返回 array', !r?.__error && Array.isArray(r),
      `type=${Array.isArray(r) ? 'array' : typeof r} len=${Array.isArray(r) ? r.length : ''} err=${r?.__error || ''}`)
  }
  // skill.list → array
  {
    const r = await callIpc(`const res = await api.skill.list(); return res;`)
    record('skill.list 返回 array', !r?.__error && Array.isArray(r),
      `type=${Array.isArray(r) ? 'array' : typeof r} len=${Array.isArray(r) ? r.length : ''} err=${r?.__error || ''}`)
  }
  // settings.get → object
  {
    const r = await callIpc(`const res = await api.settings.get(); return res;`)
    record('settings.get 返回 object', !r?.__error && r && typeof r === 'object',
      `type=${r && typeof r === 'object' ? 'object' : typeof r} keys=${r && typeof r === 'object' ? Object.keys(r).length : ''} err=${r?.__error || ''}`)
  }
  // privacy.status → {unlocked:boolean}
  {
    const r = await callIpc(`const res = await api.privacy.status(); return res;`)
    record('privacy.status 返回 {unlocked:boolean}', !r?.__error && r && typeof r === 'object' && typeof r.unlocked === 'boolean',
      `unlocked=${r?.unlocked} err=${r?.__error || ''}`)
  }
  // eaa.info → object (EAAResult)
  {
    const r = await callIpc(`const res = await api.eaa.info(); return res;`)
    record('eaa.info 返回 EAAResult object', !r?.__error && r && typeof r === 'object',
      `success=${r?.success} hasData=${!!r?.data} err=${r?.__error || ''}`)
  }
  // eaa.stats → object
  {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    record('eaa.stats 返回 object', !r?.__error && r && typeof r === 'object',
      `success=${r?.success} hasData=${!!r?.data} err=${r?.__error || ''}`)
  }
  // eaa.validate → object
  {
    const r = await callIpc(`const res = await api.eaa.validate(); return res;`)
    record('eaa.validate 返回 object', !r?.__error && r && typeof r === 'object',
      `success=${r?.success} hasData=${!!r?.data} err=${r?.__error || ''}`)
  }
  // eaa.codes → object
  {
    const r = await callIpc(`const res = await api.eaa.codes(); return res;`)
    record('eaa.codes 返回 object', !r?.__error && r && typeof r === 'object',
      `success=${r?.success} hasData=${!!r?.data} err=${r?.__error || ''}`)
  }
  // eaa.doctor → object
  {
    const r = await callIpc(`const res = await api.eaa.doctor(); return res;`)
    record('eaa.doctor 返回 object', !r?.__error && r && typeof r === 'object',
      `success=${r?.success} hasData=${!!r?.data} err=${r?.__error || ''}`)
  }
  // eaa.listStudents → object
  {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    record('eaa.listStudents 返回 object', !r?.__error && r && typeof r === 'object',
      `success=${r?.success} students=${r?.data?.students?.length ?? ''} err=${r?.__error || ''}`)
  }
  // eaa.exportFormats → array
  {
    const r = await callIpc(`const res = await api.eaa.exportFormats(); return res;`)
    record('eaa.exportFormats 返回 array', !r?.__error && Array.isArray(r),
      `type=${Array.isArray(r) ? 'array' : typeof r} len=${Array.isArray(r) ? r.length : ''} err=${r?.__error || ''}`)
  }
  // log.list → array
  {
    const r = await callIpc(`const res = await api.log.list(); return res;`)
    record('log.list 返回 array', !r?.__error && Array.isArray(r),
      `type=${Array.isArray(r) ? 'array' : typeof r} len=${Array.isArray(r) ? r.length : ''} err=${r?.__error || ''}`)
  }
  // class.list → {success, data}
  {
    const r = await callIpc(`const res = await api.class.list(); return res;`)
    record('class.list 返回 {success,data} object', !r?.__error && r && typeof r === 'object' && typeof r.success === 'boolean',
      `success=${r?.success} dataLen=${Array.isArray(r?.data) ? r.data.length : ''} err=${r?.__error || ''}`)
  }
  // academic.getConfig → {success,...}
  {
    const r = await callIpc(`const res = await api.academic.getConfig(); return res;`)
    record('academic.getConfig 返回 {success} object', !r?.__error && r && typeof r === 'object' && typeof r.success === 'boolean',
      `success=${r?.success} hasData=${!!r?.data} err=${r?.__error || ''}`)
  }
  // chat.listSessions → {success, sessions:[]}
  {
    const r = await callIpc(`const res = await api.chat.listSessions(); return res;`)
    record('chat.listSessions 返回 {success,sessions:[]}', !r?.__error && r && typeof r === 'object' && Array.isArray(r.sessions),
      `success=${r?.success} sessions=${r?.sessions?.length} err=${r?.__error || ''}`)
  }
  // chat.loadMessages() → object
  {
    const r = await callIpc(`const res = await api.chat.loadMessages(); return res;`)
    record('chat.loadMessages() 返回 object', !r?.__error && r && typeof r === 'object',
      `success=${r?.success} messages=${Array.isArray(r?.messages) ? r.messages.length : ''} err=${r?.__error || ''}`)
  }
  // feishu.status → string
  {
    const r = await callIpc(`const res = await api.feishu.status(); return res;`)
    record('feishu.status 返回 string', !r?.__error && typeof r === 'string',
      `type=${typeof r} val=${String(r).slice(0, 40)} err=${r?.__error || ''}`)
  }
  // feishu.botStatus → object
  {
    const r = await callIpc(`const res = await api.feishu.botStatus(); return res;`)
    record('feishu.botStatus 返回 object', !r?.__error && r && typeof r === 'object',
      `running=${r?.running} err=${r?.__error || ''}`)
  }
  // ollama.detect → object
  {
    const r = await callIpc(`const res = await api.ollama.detect(); return res;`)
    record('ollama.detect 返回 object', !r?.__error && r && typeof r === 'object',
      `available=${r?.available} err=${r?.__error || ''}`)
  }

  // =============================================================
  // 8. 错误处理: 缺失/非法参数返回结构化错误, 不崩溃
  // =============================================================
  console.log('\n--- 6. 错误处理 (缺失参数 → 结构化错误, 非崩溃) ---')

  // skill.get('')
  {
    const r = await callIpc(`const res = await api.skill.get(''); return res;`)
    record('skill.get("") null/结构化, 不崩溃', isControlled(r) && (r === null || isStructuredError(r)),
      `ret=${JSON.stringify(r)?.slice(0, 100)}`)
  }
  // eaa.score('')
  {
    const r = await callIpc(`const res = await api.eaa.score(''); return res;`)
    record('eaa.score("") 结构化错误, 不崩溃', isControlled(r) && isStructuredError(r),
      `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  }
  // agent.get(nonexistent)
  {
    const r = await callIpc(`const res = await api.agent.get('nonexistent_xyz_' + Date.now()); return res;`)
    record('agent.get(不存在) null/结构化, 不崩溃', isControlled(r) && (r === null || isStructuredError(r)),
      `ret=${JSON.stringify(r)?.slice(0, 100)}`)
  }
  // profile.get(nonexistent) — 返回空对象 {} (merge 语义, 非错误), 关键是不崩溃
  {
    const r = await callIpc(`const res = await api.profile.get('nonexistent_xyz_' + Date.now()); return res;`)
    record('profile.get(不存在) 受控响应, 不崩溃', isControlled(r),
      `type=${r && typeof r === 'object' ? 'object' : typeof r} keys=${r && typeof r === 'object' ? Object.keys(r).length : 0} err=${r?.__error || ''}`)
  }
  // class.create(null)
  {
    const r = await callIpc(`const res = await api.class.create(null); return res;`)
    record('class.create(null) 结构化错误, 不崩溃', isControlled(r) && isStructuredError(r),
      `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  }
  // cron.add(null)
  {
    const r = await callIpc(`const res = await api.cron.add(null); return res;`)
    record('cron.add(null) 结构化错误, 不崩溃', isControlled(r) && isStructuredError(r),
      `ret=${JSON.stringify(r)?.slice(0, 100)}`)
  }
  // academic.deleteExam('')
  {
    const r = await callIpc(`const res = await api.academic.deleteExam(''); return res;`)
    record('academic.deleteExam("") 结构化错误, 不崩溃', isControlled(r) && isStructuredError(r),
      `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  }
  // eaa.addEvent({}) missing required fields
  {
    const r = await callIpc(`const res = await api.eaa.addEvent({}); return res;`)
    record('eaa.addEvent({}) 结构化错误, 不崩溃', isControlled(r) && isStructuredError(r),
      `success=${r?.success} err=${r?.error || r?.stderr || r?.__error || ''}`)
  }

  // =============================================================
  // 汇总
  // =============================================================
  console.log('\n========== IPC 覆盖率深度测试 ==========')
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  console.log(`总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`)
  if (failed > 0) {
    console.log('\n失败项:')
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  - ${r.name}: ${r.detail}`)
    }
  }

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
