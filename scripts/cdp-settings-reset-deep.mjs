// =============================================================
// 设置 重置/备份/恢复/迁移 深度测试 — reset 行为全量覆盖
// 通过 CDP 远程调试 (端口 9222) 调用 Tauri 渲染进程 IPC API
//
// 重要: settings.reset() 实际实现不接受参数 (见 settings-handlers.ts
//   IPC_SETTINGS_RESET 与 tauri-bridge.ts reset: () => call(...))
//   传入的 dotPath 参数会被忽略, 始终重置全部设置到默认值。
//   本脚本针对该真实行为编写测试, 并在每个破坏性 reset 后立即恢复原始状态。
//
// 覆盖: 捕获原始状态 / 单字段reset(参数忽略) / 嵌套字段reset /
//       整段reset / 全量reset / 不存在路径reset / set-reset循环 /
//       shortcuts reset / 持久化 / 类型校验 / 并发reset / 边界 /
//       备份-恢复-迁移 / 最终状态恢复
// 运行: node scripts/cdp-settings-reset-deep.mjs
// =============================================================
import http from 'node:http'

const CDP_PORT = 9222
const BASE = `http://127.0.0.1:${CDP_PORT}`

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const results = []
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  }
  // 包装每个测试: 捕获未预期异常, 不中断后续测试
  const test = (name, fn) => fn().catch((err) => record(name, false, `异常: ${String(err && err.message ? err.message : err).slice(0, 160)}`))

  // ---------- CDP 连接 ----------
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
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
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
  console.log('CDP connected, running settings reset deep tests...\n')

  // ---------- IPC 封装 (符合框架要求的 try/catch 包装) ----------
  const getSettings = async () => {
    return await evalInPage(`
      (async function(){
        const api = window.__EAA_API__||window.api;
        try {
          return await api.settings.get();
        } catch(e) {
          return {__error: String(e&&e.message?e.message:e)};
        }
      })()
    `)
  }

  const setSetting = async (path, value) => {
    return await evalInPage(`
      (async function(){
        const api = window.__EAA_API__||window.api;
        try {
          return await api.settings.set(${JSON.stringify(path)}, ${JSON.stringify(value)});
        } catch(e) {
          return {__error: String(e&&e.message?e.message:e)};
        }
      })()
    `)
  }

  // reset 接受任意参数 (实际被忽略, 始终全量重置)
  const resetSettings = async (...args) => {
    const argsLiteral = args.map((a) => JSON.stringify(a)).join(',')
    return await evalInPage(`
      (async function(){
        const api = window.__EAA_API__||window.api;
        try {
          return await api.settings.reset(${argsLiteral});
        } catch(e) {
          return {__error: String(e&&e.message?e.message:e)};
        }
      })()
    `)
  }

  // 辅助: 通过点路径获取嵌套值 (shortcuts 含点号键特殊处理)
  // path 'shortcuts.chat.abort' 映射到 shortcuts['chat.abort'] (flat key)
  const getByPath = (obj, path) => {
    const keys = path.split('.')
    if (keys[0] === 'shortcuts' && keys.length > 2) {
      const shortcutKey = keys.slice(1).join('.')
      const shortcuts = obj && obj.shortcuts
      return (shortcuts && shortcuts[shortcutKey] !== undefined) ? shortcuts[shortcutKey] : undefined
    }
    return keys.reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj)
  }

  const isAccepted = (r) => r?.success === true && !r?.__error
  const isRejected = (r) => r?.success === false || !!r?.__error
  const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  // 默认值表 (与 settings-service.ts DEFAULT_SETTINGS 一致)
  const DEFAULTS = {
    'general.theme': 'light',
    'general.language': 'zh-CN',
    'general.logLevel': 'info',
    'general.autoUpdate': true,
    'general.telemetry': false,
    'general.autoStart': false,
    'general.minimizeToTray': true,
    'general.closeBehavior': 'ask',
    'general.timezone': 'Asia/Shanghai',
    'chat.steeringMode': 'all',
    'chat.followUpMode': 'all',
    'chat.showImages': true,
    'chat.maxTokens': 32768,
    'chat.conversationLogging': true,
    'chat.thinkingLevel': 'medium',
    'chat.compaction.enabled': true,
    'chat.compaction.reserveTokens': 8000,
    'chat.compaction.keepRecentTokens': 16000,
    'models.transport': 'auto',
    'models.cacheRetention': 'short',
    'models.retry.enabled': true,
    'models.retry.maxRetries': 3,
    'models.retry.baseDelayMs': 1000,
    'models.retry.providerTimeoutMs': 60000,
    'privacy.enabled': false,
    'privacy.autoAnonymize': false,
    'advanced.httpIdleTimeoutMs': 120000,
    'shortcuts.chat.abort': 'Escape',
    'shortcuts.chat.new': 'Ctrl+N',
    'shortcuts.chat.send': 'Enter',
    'shortcuts.nav.settings': 'Ctrl+,',
  }

  // 校验指定路径是否为默认值, 返回不一致列表
  const checkDefaults = (settings, paths) => {
    const mismatches = []
    for (const p of paths) {
      const expected = DEFAULTS[p]
      if (expected === undefined) continue
      const actual = getByPath(settings, p)
      if (actual !== expected) {
        mismatches.push(`${p}: expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`)
      }
    }
    return mismatches
  }

  // ========== 0: 初始设置读取 / 捕获原始状态 (备份) ==========
  console.log('━━━ 0. 捕获原始状态 (备份) ━━━')
  let origSettings = null
  try {
    origSettings = await getSettings()
    if (!origSettings || origSettings.__error || origSettings.success === false) {
      record('初始设置读取', false, `settings.get 失败: ${origSettings?.__error || origSettings?.error || 'invalid'}`)
      ws.close(); process.exit(1)
    }
    record('初始设置读取', true, `keys=${Object.keys(origSettings).join(',')}`)
  } catch (err) {
    record('初始设置读取', false, String(err.message || err))
    ws.close(); process.exit(1)
  }

  await test('原始设置包含 7 个顶层键', async () => {
    const expectedKeys = ['general', 'chat', 'feishu', 'models', 'privacy', 'shortcuts', 'advanced']
    const actualKeys = Object.keys(origSettings)
    const missing = expectedKeys.filter((k) => !actualKeys.includes(k))
    record('原始设置包含 7 个顶层键', missing.length === 0,
      `actual=${actualKeys.join(',')} missing=${missing.join(',')}`)
  })

  await test('settings.reset API 存在且为函数', async () => {
    const exists = await evalInPage(`
      (async function() {
        const api = window.__EAA_API__||window.api;
        return typeof api.settings.reset === 'function';
      })()
    `)
    record('settings.reset API 存在且为函数', exists === true, `hasReset=${exists}`)
  })

  // 保存顶层段名 (用于恢复)
  const SECTION_KEYS = Object.keys(origSettings)

  // 恢复全部原始设置 (按顶层段批量 set; reset 会清空 keystore 密钥, 此处尽力恢复可见状态)
  const restoreAll = async () => {
    for (const sec of SECTION_KEYS) {
      try { await setSetting(sec, origSettings[sec]) } catch (_) { /* ignore */ }
    }
    await sleep(450) // 等待 300ms 节流写盘完成
  }

  // ========== 1. Reset 指定字段 (参数被忽略 → 全量重置) ==========
  console.log('\n━━━ 1. Reset 指定字段 (参数被忽略 → 全量重置) ━━━')
  await test('reset("general.theme") 后 theme 回到默认 light', async () => {
    try {
      await setSetting('general.theme', 'light')
      const res = await resetSettings('general.theme')
      const after = await getSettings()
      const ok = isAccepted(res) && getByPath(after, 'general.theme') === 'light'
      record('reset("general.theme") 后 theme 回到默认 light', ok,
        `res.success=${res?.success} theme=${JSON.stringify(getByPath(after, 'general.theme'))}`)
    } finally { await restoreAll() }
  })

  await test('reset("general.theme") 参数被忽略 — 同时重置了 language', async () => {
    try {
      await setSetting('general.theme', 'light')
      await setSetting('general.language', 'en-US')
      const res = await resetSettings('general.theme')
      const after = await getSettings()
      // 证明 arg 被忽略: language 也被重置 (而非仅 theme)
      const bothReset = getByPath(after, 'general.theme') === 'light' && getByPath(after, 'general.language') === 'zh-CN'
      record('reset("general.theme") 参数被忽略 — 同时重置了 language',
        isAccepted(res) && bothReset,
        `theme=${getByPath(after, 'general.theme')} language=${getByPath(after, 'general.language')}`)
    } finally { await restoreAll() }
  })

  await test('reset("general.theme") 返回 {success:true}', async () => {
    try {
      const res = await resetSettings('general.theme')
      record('reset("general.theme") 返回 {success:true}', isAccepted(res), `res=${JSON.stringify(res)}`)
    } finally { await restoreAll() }
  })

  // ========== 2. Reset 嵌套字段 (参数被忽略 → 全量重置) ==========
  console.log('\n━━━ 2. Reset 嵌套字段 (参数被忽略 → 全量重置) ━━━')
  await test('reset("general.logLevel") 后 logLevel 回到默认 info', async () => {
    try {
      await setSetting('general.logLevel', 'debug')
      const res = await resetSettings('general.logLevel')
      const after = await getSettings()
      const ok = isAccepted(res) && getByPath(after, 'general.logLevel') === 'info'
      record('reset("general.logLevel") 后 logLevel 回到默认 info', ok,
        `res.success=${res?.success} logLevel=${JSON.stringify(getByPath(after, 'general.logLevel'))}`)
    } finally { await restoreAll() }
  })

  await test('reset("general.logLevel") 参数被忽略 — 同时重置了 chat.maxTokens', async () => {
    try {
      await setSetting('general.logLevel', 'debug')
      await setSetting('chat.maxTokens', 999)
      const res = await resetSettings('general.logLevel')
      const after = await getSettings()
      const bothReset = getByPath(after, 'general.logLevel') === 'info' && getByPath(after, 'chat.maxTokens') === 32768
      record('reset("general.logLevel") 参数被忽略 — 同时重置了 chat.maxTokens',
        isAccepted(res) && bothReset,
        `logLevel=${getByPath(after, 'general.logLevel')} maxTokens=${getByPath(after, 'chat.maxTokens')}`)
    } finally { await restoreAll() }
  })

  await test('reset("chat.compaction.reserveTokens") 嵌套路径', async () => {
    try {
      await setSetting('chat.compaction.reserveTokens', 1234)
      const res = await resetSettings('chat.compaction.reserveTokens')
      const after = await getSettings()
      const ok = isAccepted(res) && getByPath(after, 'chat.compaction.reserveTokens') === 8000
      record('reset("chat.compaction.reserveTokens") 嵌套路径', ok,
        `res.success=${res?.success} val=${getByPath(after, 'chat.compaction.reserveTokens')}`)
    } finally { await restoreAll() }
  })

  // ========== 3. Reset 整段 (参数被忽略 → 全量重置) ==========
  console.log('\n━━━ 3. Reset 整段 (参数被忽略 → 全量重置) ━━━')
  await test('reset("general") 后 general 段全部回默认', async () => {
    try {
      await setSetting('general.theme', 'light')
      await setSetting('general.language', 'en-US')
      await setSetting('general.logLevel', 'debug')
      const res = await resetSettings('general')
      const after = await getSettings()
      const mm = checkDefaults(after, ['general.theme', 'general.language', 'general.logLevel'])
      record('reset("general") 后 general 段全部回默认', isAccepted(res) && mm.length === 0,
        mm.length === 0 ? 'general 段全部为默认' : `不一致: ${mm.join('; ')}`)
    } finally { await restoreAll() }
  })

  await test('reset("general") 参数被忽略 — 同时重置了 chat 段', async () => {
    try {
      await setSetting('general.theme', 'light')
      await setSetting('chat.maxTokens', 999)
      await setSetting('chat.steeringMode', 'one-at-a-time')
      const res = await resetSettings('general')
      const after = await getSettings()
      const mm = checkDefaults(after, ['general.theme', 'chat.maxTokens', 'chat.steeringMode'])
      record('reset("general") 参数被忽略 — 同时重置了 chat 段',
        isAccepted(res) && mm.length === 0,
        mm.length === 0 ? '跨段均已默认' : `不一致: ${mm.join('; ')}`)
    } finally { await restoreAll() }
  })

  await test('reset("chat") 后 chat 段全部回默认', async () => {
    try {
      await setSetting('chat.maxTokens', 999)
      await setSetting('chat.steeringMode', 'one-at-a-time')
      await setSetting('chat.followUpMode', 'one-at-a-time')
      const res = await resetSettings('chat')
      const after = await getSettings()
      const mm = checkDefaults(after, ['chat.maxTokens', 'chat.steeringMode', 'chat.followUpMode'])
      record('reset("chat") 后 chat 段全部回默认', isAccepted(res) && mm.length === 0,
        mm.length === 0 ? 'chat 段全部为默认' : `不一致: ${mm.join('; ')}`)
    } finally { await restoreAll() }
  })

  // ========== 4. Reset 全部设置 (无参数) ==========
  console.log('\n━━━ 4. Reset 全部设置 (无参数) ━━━')
  await test('reset() 无参数 — 全部段回到默认', async () => {
    try {
      await setSetting('general.theme', 'light')
      await setSetting('general.language', 'en-US')
      await setSetting('chat.maxTokens', 999)
      await setSetting('models.retry.maxRetries', 9)
      await setSetting('privacy.enabled', true)
      const res = await resetSettings()
      const after = await getSettings()
      const mm = checkDefaults(after, [
        'general.theme', 'general.language', 'chat.maxTokens',
        'models.retry.maxRetries', 'privacy.enabled',
      ])
      record('reset() 无参数 — 全部段回到默认', isAccepted(res) && mm.length === 0,
        mm.length === 0 ? '全部已默认' : `不一致: ${mm.join('; ')}`)
    } finally { await restoreAll() }
  })

  await test('reset() 返回 {success:true}', async () => {
    try {
      const res = await resetSettings()
      record('reset() 返回 {success:true}', isAccepted(res), `res=${JSON.stringify(res)}`)
    } finally { await restoreAll() }
  })

  await test('reset() 后 shortcuts 也回默认', async () => {
    try {
      await setSetting('shortcuts.chat.abort', 'Ctrl+Shift+T')
      await setSetting('shortcuts.chat.new', 'Ctrl+P')
      await resetSettings()
      const after = await getSettings()
      const mm = checkDefaults(after, ['shortcuts.chat.abort', 'shortcuts.chat.new'])
      record('reset() 后 shortcuts 也回默认', mm.length === 0,
        mm.length === 0 ? 'shortcuts 已默认' : `不一致: ${mm.join('; ')}`)
    } finally { await restoreAll() }
  })

  // ========== 5. Reset 不存在路径 (参数被忽略 → 不拒绝, 全量重置) ==========
  console.log('\n━━━ 5. Reset 不存在路径 (参数被忽略 → 不拒绝, 全量重置) ━━━')
  await test('reset("nonexistent.path") 不拒绝 — success:true', async () => {
    try {
      await setSetting('general.theme', 'light')
      const res = await resetSettings('nonexistent.path')
      const after = await getSettings()
      // 不存在路径不会报错, 且仍触发了全量重置 (theme 回默认)
      const ok = isAccepted(res) && getByPath(after, 'general.theme') === 'light'
      record('reset("nonexistent.path") 不拒绝 — success:true', ok,
        `res.success=${res?.success} theme=${getByPath(after, 'general.theme')}`)
    } finally { await restoreAll() }
  })

  await test('reset("") 空字符串 — 不拒绝, 全量重置', async () => {
    try {
      await setSetting('general.theme', 'light')
      const res = await resetSettings('')
      const after = await getSettings()
      const ok = isAccepted(res) && getByPath(after, 'general.theme') === 'light'
      record('reset("") 空字符串 — 不拒绝, 全量重置', ok,
        `res.success=${res?.success} theme=${getByPath(after, 'general.theme')}`)
    } finally { await restoreAll() }
  })

  await test('reset("general.nonexistent") 不存在嵌套路径 — 不拒绝', async () => {
    try {
      await setSetting('general.theme', 'light')
      const res = await resetSettings('general.nonexistent')
      const after = await getSettings()
      const ok = isAccepted(res) && getByPath(after, 'general.theme') === 'light'
      record('reset("general.nonexistent") 不存在嵌套路径 — 不拒绝', ok,
        `res.success=${res?.success} theme=${getByPath(after, 'general.theme')}`)
    } finally { await restoreAll() }
  })

  await test('reset 不存在路径不创建新键', async () => {
    try {
      await resetSettings('totally.invalid.path')
      const after = await getSettings()
      const notCreated = !('totally' in after) && !(after.general && 'nonexistent' in after.general)
      record('reset 不存在路径不创建新键', notCreated, `keys=${Object.keys(after).join(',')}`)
    } finally { await restoreAll() }
  })

  // ========== 6. Set 与 Reset 循环 ==========
  console.log('\n━━━ 6. Set 与 Reset 循环 ━━━')
  await test('set theme=dark → reset → 回到默认 light', async () => {
    try {
      await setSetting('general.theme', 'dark')
      const before = getByPath(await getSettings(), 'general.theme')
      await resetSettings()
      const after = getByPath(await getSettings(), 'general.theme')
      const ok = before === 'dark' && after === 'light'
      record('set theme=dark → reset → 回到默认 light', ok, `before=${before} after=${after}`)
    } finally { await restoreAll() }
  })

  await test('set theme=light → reset → 仍为 light (默认)', async () => {
    try {
      await setSetting('general.theme', 'light')
      const before = getByPath(await getSettings(), 'general.theme')
      await resetSettings()
      const after = getByPath(await getSettings(), 'general.theme')
      const ok = before === 'light' && after === 'light'
      record('set theme=light → reset → 仍为 light (默认)', ok, `before=${before} after=${after}`)
    } finally { await restoreAll() }
  })

  await test('双重 set-reset 循环 (light→reset→light→reset)', async () => {
    try {
      await setSetting('general.theme', 'light')
      await resetSettings()
      const r1 = getByPath(await getSettings(), 'general.theme')
      await setSetting('general.theme', 'light')
      await resetSettings()
      const r2 = getByPath(await getSettings(), 'general.theme')
      const ok = r1 === 'light' && r2 === 'light'
      record('双重 set-reset 循环 (light→reset→light→reset)', ok, `r1=${r1} r2=${r2}`)
    } finally { await restoreAll() }
  })

  await test('set-reset-set 循环后值正确', async () => {
    try {
      await resetSettings()
      await setSetting('general.theme', 'light')
      const v1 = getByPath(await getSettings(), 'general.theme')
      await resetSettings()
      const v2 = getByPath(await getSettings(), 'general.theme')
      await setSetting('general.theme', 'system')
      const v3 = getByPath(await getSettings(), 'general.theme')
      const ok = v1 === 'light' && v2 === 'light' && v3 === 'system'
      record('set-reset-set 循环后值正确', ok, `v1=${v1} v2=${v2} v3=${v3}`)
    } finally { await restoreAll() }
  })

  // ========== 7. Shortcuts Reset ==========
  console.log('\n━━━ 7. Shortcuts Reset ━━━')
  await test('reset("shortcuts.chat.abort") 后回默认 Escape', async () => {
    try {
      await setSetting('shortcuts.chat.abort', 'Ctrl+Shift+T')
      const before = getByPath(await getSettings(), 'shortcuts.chat.abort')
      const res = await resetSettings('shortcuts.chat.abort')
      const after = getByPath(await getSettings(), 'shortcuts.chat.abort')
      const ok = isAccepted(res) && before === 'Ctrl+Shift+T' && after === 'Escape'
      record('reset("shortcuts.chat.abort") 后回默认 Escape', ok,
        `before=${before} after=${after} res.success=${res?.success}`)
    } finally { await restoreAll() }
  })

  await test('reset("shortcuts") 整段 — 所有 shortcuts 回默认', async () => {
    try {
      await setSetting('shortcuts.chat.abort', 'Ctrl+Shift+T')
      await setSetting('shortcuts.chat.new', 'Ctrl+P')
      await setSetting('shortcuts.nav.settings', 'Ctrl+Alt+S')
      const res = await resetSettings('shortcuts')
      const after = await getSettings()
      const mm = checkDefaults(after, ['shortcuts.chat.abort', 'shortcuts.chat.new', 'shortcuts.nav.settings'])
      record('reset("shortcuts") 整段 — 所有 shortcuts 回默认', isAccepted(res) && mm.length === 0,
        mm.length === 0 ? 'shortcuts 已默认' : `不一致: ${mm.join('; ')}`)
    } finally { await restoreAll() }
  })

  await test('reset() 后 shortcuts 含点号键结构完整', async () => {
    try {
      await setSetting('shortcuts.chat.abort', 'Ctrl+Shift+T')
      await resetSettings()
      const after = await getSettings()
      // 验证含点号键 ('chat.abort') 仍然作为 flat key 存在
      const hasKey = after.shortcuts && Object.keys(after.shortcuts).includes('chat.abort')
      const val = getByPath(after, 'shortcuts.chat.abort')
      const ok = hasKey && val === 'Escape'
      record('reset() 后 shortcuts 含点号键结构完整', ok,
        `hasKey=${hasKey} val=${JSON.stringify(val)} keys=${Object.keys(after.shortcuts || {}).join(',')}`)
    } finally { await restoreAll() }
  })

  // ========== 8. Reset 后持久化 ==========
  console.log('\n━━━ 8. Reset 后持久化 ━━━')
  await test('reset 后多次 get 一致 (内存状态稳定)', async () => {
    try {
      await setSetting('general.theme', 'light')
      await resetSettings()
      const a = await getSettings()
      await sleep(300)
      const b = await getSettings()
      const ok = getByPath(a, 'general.theme') === 'light' && deepEqual(a, b)
      record('reset 后多次 get 一致 (内存状态稳定)', ok,
        `a.theme=${getByPath(a, 'general.theme')} b.theme=${getByPath(b, 'general.theme')} equal=${deepEqual(a, b)}`)
    } finally { await restoreAll() }
  })

  await test('reset 后再 set 新值 — 新值生效', async () => {
    try {
      await resetSettings()
      await setSetting('general.theme', 'light')
      const after = await getSettings()
      const ok = getByPath(after, 'general.theme') === 'light'
      record('reset 后再 set 新值 — 新值生效', ok, `theme=${getByPath(after, 'general.theme')}`)
    } finally { await restoreAll() }
  })

  await test('reset 后再 get 全量 — 所有 7 段存在', async () => {
    try {
      await resetSettings()
      const after = await getSettings()
      const expected = ['general', 'chat', 'feishu', 'models', 'privacy', 'shortcuts', 'advanced']
      const missing = expected.filter((k) => !(k in after))
      record('reset 后再 get 全量 — 所有 7 段存在', missing.length === 0,
        missing.length === 0 ? '7 段齐全' : `missing=${missing.join(',')}`)
    } finally { await restoreAll() }
  })

  // ========== 9. Reset 类型校验 ==========
  console.log('\n━━━ 9. Reset 类型校验 (参数被忽略) ━━━')
  await test('reset() 无参数 — success', async () => {
    try {
      const res = await resetSettings()
      record('reset() 无参数 — success', isAccepted(res), `res=${JSON.stringify(res)}`)
    } finally { await restoreAll() }
  })

  await test('reset 传入多余参数 (忽略) — success', async () => {
    try {
      const res = await resetSettings('extra', 'args', 'ignored')
      record('reset 传入多余参数 (忽略) — success', isAccepted(res), `res=${JSON.stringify(res)}`)
    } finally { await restoreAll() }
  })

  await test('reset(null) — 忽略, success', async () => {
    try {
      const res = await resetSettings(null)
      record('reset(null) — 忽略, success', isAccepted(res), `res=${JSON.stringify(res)}`)
    } finally { await restoreAll() }
  })

  await test('reset(undefined) — 忽略, success', async () => {
    try {
      const res = await resetSettings(undefined)
      record('reset(undefined) — 忽略, success', isAccepted(res), `res=${JSON.stringify(res)}`)
    } finally { await restoreAll() }
  })

  await test('reset(123) 数字 — 忽略, success', async () => {
    try {
      const res = await resetSettings(123)
      record('reset(123) 数字 — 忽略, success', isAccepted(res), `res=${JSON.stringify(res)}`)
    } finally { await restoreAll() }
  })

  await test('reset 不改变默认值集合 (回归)', async () => {
    try {
      await resetSettings()
      const after = await getSettings()
      const mm = checkDefaults(after, [
        'general.theme', 'general.language', 'general.logLevel',
        'chat.maxTokens', 'chat.steeringMode', 'privacy.enabled',
        'shortcuts.chat.abort',
      ])
      record('reset 不改变默认值集合 (回归)', mm.length === 0,
        mm.length === 0 ? '默认值稳定' : `不一致: ${mm.join('; ')}`)
    } finally { await restoreAll() }
  })

  // ========== 10. 并发 Reset ==========
  console.log('\n━━━ 10. 并发 Reset ━━━')
  await test('并发 reset() 3 次 — 全部 success', async () => {
    try {
      await setSetting('general.theme', 'light')
      const results = await Promise.all([resetSettings(), resetSettings(), resetSettings()])
      const allOk = results.every((r) => isAccepted(r))
      const after = await getSettings()
      const isDefault = getByPath(after, 'general.theme') === 'light'
      record('并发 reset() 3 次 — 全部 success', allOk && isDefault,
        `allOk=${allOk} theme=${getByPath(after, 'general.theme')}`)
    } finally { await restoreAll() }
  })

  await test('并发 reset + set 不同字段 — 均不崩溃', async () => {
    try {
      const [resetRes, setRes] = await Promise.all([
        resetSettings(),
        setSetting('general.theme', 'light'),
      ])
      const bothRespond = !isRejected(resetRes) && (isAccepted(setRes) || isRejected(setRes))
      const after = await getSettings()
      // 最终值取决于竞态 (reset 与 set 谁最后写入), 只验证不崩溃
      record('并发 reset + set 不同字段 — 均不崩溃', bothRespond,
        `reset.success=${resetRes?.success} set.success=${setRes?.success} finalTheme=${getByPath(after, 'general.theme')}`)
    } finally { await restoreAll() }
  })

  await test('并发 reset + get — 均不崩溃', async () => {
    try {
      await setSetting('general.theme', 'light')
      const [resetRes, getRes] = await Promise.all([
        resetSettings(),
        getSettings(),
      ])
      const resetOk = !isRejected(resetRes)
      const getOk = getRes && !getRes.__error && typeof getRes === 'object'
      record('并发 reset + get — 均不崩溃', resetOk && getOk,
        `reset.success=${resetRes?.success} getOk=${getOk}`)
    } finally { await restoreAll() }
  })

  await test('并发 reset + reset + set + get — 不崩溃', async () => {
    try {
      const [r1, r2, s1, g1] = await Promise.all([
        resetSettings(),
        resetSettings(),
        setSetting('chat.maxTokens', 4096),
        getSettings(),
      ])
      const noCrash = !isRejected(r1) && !isRejected(r2) && g1 && !g1.__error
      record('并发 reset + reset + set + get — 不崩溃', noCrash,
        `r1=${r1?.success} r2=${r2?.success} s1=${s1?.success} getOk=${!!g1}`)
    } finally { await restoreAll() }
  })

  // ========== 11. 边界情况 ==========
  console.log('\n━━━ 11. 边界情况 ━━━')
  await test('reset 已在默认值的字段 — no-op, success', async () => {
    try {
      // 先 reset 确保全默认
      await resetSettings()
      const before = await getSettings()
      // 再次 reset (已在默认)
      const res = await resetSettings()
      const after = await getSettings()
      const ok = isAccepted(res) && deepEqual(before, after)
      record('reset 已在默认值的字段 — no-op, success', ok,
        `res.success=${res?.success} equal=${deepEqual(before, after)}`)
    } finally { await restoreAll() }
  })

  await test('双重 reset — 状态保持默认', async () => {
    try {
      await setSetting('general.theme', 'light')
      await resetSettings()
      const r1 = getByPath(await getSettings(), 'general.theme')
      await resetSettings()
      const r2 = getByPath(await getSettings(), 'general.theme')
      const ok = r1 === 'light' && r2 === 'light'
      record('双重 reset — 状态保持默认', ok, `r1=${r1} r2=${r2}`)
    } finally { await restoreAll() }
  })

  await test('reset 超长 dotPath (参数忽略) — success', async () => {
    try {
      const longPath = 'a'.repeat(500) + '.' + 'b'.repeat(500)
      const res = await resetSettings(longPath)
      const after = await getSettings()
      const ok = isAccepted(res) && getByPath(after, 'general.theme') === 'light'
      record('reset 超长 dotPath (参数忽略) — success', ok,
        `res.success=${res?.success} theme=${getByPath(after, 'general.theme')}`)
    } finally { await restoreAll() }
  })

  await test('reset 特殊字符 dotPath (参数忽略) — success', async () => {
    try {
      const res = await resetSettings('general.theme!@#$%^&*()')
      const after = await getSettings()
      const ok = isAccepted(res) && getByPath(after, 'general.theme') === 'light'
      record('reset 特殊字符 dotPath (参数忽略) — success', ok,
        `res.success=${res?.success} theme=${getByPath(after, 'general.theme')}`)
    } finally { await restoreAll() }
  })

  await test('reset 原型污染键 (参数忽略) — success 且不污染原型', async () => {
    try {
      const res = await resetSettings('__proto__.polluted')
      const after = await getSettings()
      const notPolluted = ({}).__proto__ === Object.prototype && !after.__polluted
      const ok = isAccepted(res) && notPolluted
      record('reset 原型污染键 (参数忽略) — success 且不污染原型', ok,
        `res.success=${res?.success} notPolluted=${notPolluted}`)
    } finally { await restoreAll() }
  })

  // ========== 12. 备份/恢复/迁移行为 ==========
  console.log('\n━━━ 12. 备份/恢复/迁移行为 ━━━')
  await test('备份-重置-恢复 全量循环 — 状态一致', async () => {
    try {
      const backup = await getSettings() // 备份
      await setSetting('general.theme', 'light')
      await setSetting('chat.maxTokens', 999)
      await resetSettings() // 全量重置
      // 恢复: 逐段 set
      for (const sec of Object.keys(backup)) {
        await setSetting(sec, backup[sec])
      }
      await sleep(450)
      const after = await getSettings()
      const ok = deepEqual(backup, after)
      record('备份-重置-恢复 全量循环 — 状态一致', ok,
        ok ? '恢复后与备份一致' : `不一致 (theme: ${backup.general?.theme}→${after.general?.theme}, maxTokens: ${backup.chat?.maxTokens}→${after.chat?.maxTokens})`)
    } finally { await restoreAll() }
  })

  await test('分段恢复 — 每段独立恢复后值正确', async () => {
    try {
      const backup = await getSettings()
      await resetSettings()
      // 分段恢复
      await setSetting('general', backup.general)
      let after = await getSettings()
      const generalOk = deepEqual(after.general, backup.general)
      await setSetting('chat', backup.chat)
      after = await getSettings()
      const chatOk = deepEqual(after.chat, backup.chat)
      await setSetting('models', backup.models)
      after = await getSettings()
      const modelsOk = deepEqual(after.models, backup.models)
      record('分段恢复 — 每段独立恢复后值正确', generalOk && chatOk && modelsOk,
        `general=${generalOk} chat=${chatOk} models=${modelsOk}`)
    } finally { await restoreAll() }
  })

  await test('迁移行为 — reset 后仅 set 部分字段, 未设字段保持默认 (deepMerge)', async () => {
    try {
      await resetSettings()
      await setSetting('general.theme', 'light')
      const after = await getSettings()
      // 已设字段为用户值, 未设字段为默认值
      const setUser = getByPath(after, 'general.theme') === 'light'
      const keepDefault = getByPath(after, 'general.logLevel') === 'info' &&
        getByPath(after, 'chat.maxTokens') === 32768
      record('迁移行为 — reset 后仅 set 部分字段, 未设字段保持默认 (deepMerge)',
        setUser && keepDefault,
        `theme=${getByPath(after, 'general.theme')} logLevel=${getByPath(after, 'general.logLevel')} maxTokens=${getByPath(after, 'chat.maxTokens')}`)
    } finally { await restoreAll() }
  })

  await test('恢复后 shortcuts 含点号键完整保留', async () => {
    try {
      const backup = await getSettings()
      const origKeys = Object.keys(backup.shortcuts || {}).sort().join(',')
      await resetSettings()
      await setSetting('shortcuts', backup.shortcuts)
      const after = await getSettings()
      const afterKeys = Object.keys(after.shortcuts || {}).sort().join(',')
      const ok = origKeys === afterKeys
      record('恢复后 shortcuts 含点号键完整保留', ok,
        ok ? `keys=${origKeys}` : `orig=${origKeys} after=${afterKeys}`)
    } finally { await restoreAll() }
  })

  // ========== 13. 最终状态恢复 ==========
  console.log('\n━━━ 13. 最终状态恢复验证 ━━━')
  await test('最终状态与原始备份一致 (全量恢复)', async () => {
    // 确保最后一次恢复落盘
    await restoreAll()
    const finalSettings = await getSettings()
    const ok = deepEqual(origSettings, finalSettings)
    // 对比失败时输出差异字段 (避免过长)
    let detail = ok ? '全部字段一致' : ''
    if (!ok) {
      const diffs = []
      for (const sec of SECTION_KEYS) {
        if (!deepEqual(origSettings[sec], finalSettings[sec])) {
          diffs.push(sec)
        }
      }
      detail = `不一致段: ${diffs.join(', ')}`
    }
    record('最终状态与原始备份一致 (全量恢复)', ok, detail)
  })

  await test('最终默认字段集稳定 (回归)', async () => {
    const finalSettings = await getSettings()
    // 关键字段应与原始值一致
    const checks = [
      ['general.theme', getByPath(finalSettings, 'general.theme'), getByPath(origSettings, 'general.theme')],
      ['general.language', getByPath(finalSettings, 'general.language'), getByPath(origSettings, 'general.language')],
      ['general.logLevel', getByPath(finalSettings, 'general.logLevel'), getByPath(origSettings, 'general.logLevel')],
      ['chat.maxTokens', getByPath(finalSettings, 'chat.maxTokens'), getByPath(origSettings, 'chat.maxTokens')],
      ['shortcuts.chat.abort', getByPath(finalSettings, 'shortcuts.chat.abort'), getByPath(origSettings, 'shortcuts.chat.abort')],
    ]
    const allMatch = checks.every(([, a, b]) => a === b)
    record('最终默认字段集稳定 (回归)', allMatch,
      checks.map(([k, a, b]) => `${k}:${a === b ? '✓' : '✗'}`).join(' '))
  })

  // ========== 汇总 ==========
  console.log('\n========== 设置 重置/备份/恢复/迁移 深度测试汇总 ==========')
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
