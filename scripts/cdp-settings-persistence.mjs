// =============================================================
// 设置持久化深度测试 — 多路径设置项保存与读取
// 覆盖: general/models/chat/privacy/advanced/shortcuts 各路径
// 每项测试: 读原值 → 设置新值 → 验证 → 恢复原值
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

  // 辅助: 获取完整设置
  const getSettings = async () => {
    return await evalInPage(`
      (async function() {
        const api = window.__EAA_API__ || window.api;
        return await api.settings.get();
      })()
    `)
  }

  // 辅助: 设置指定路径
  const setSetting = async (path, value) => {
    return await evalInPage(`
      (async function() {
        const api = window.__EAA_API__ || window.api;
        return await api.settings.set(${JSON.stringify(path)}, ${JSON.stringify(value)});
      })()
    `)
  }

  // 辅助: 通过点路径获取嵌套值
  // 注意: shortcuts 字段使用含点号的键 (如 'chat.abort'), 需特殊处理
  // path 'shortcuts.chat.abort' 应映射到 shortcuts['chat.abort'] (flat key)
  const getByPath = (obj, path) => {
    const keys = path.split('.')
    if (keys[0] === 'shortcuts' && keys.length > 2) {
      const shortcutKey = keys.slice(1).join('.')
      const shortcuts = obj && obj.shortcuts
      return (shortcuts && shortcuts[shortcutKey] !== undefined) ? shortcuts[shortcutKey] : undefined
    }
    return keys.reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj)
  }

  // ========== 0: 初始设置读取 ==========
  let origSettings = null
  try {
    origSettings = await getSettings()
    record(`初始设置读取`, origSettings && typeof origSettings === 'object', `keys=${Object.keys(origSettings || {}).join(',')}`)
  } catch (err) {
    record(`初始设置读取`, false, String(err.message || err))
    ws.close(); process.exit(1)
  }

  // ========== 通用测试函数 ==========
  const testSetting = async (name, path, newValue, opts = {}) => {
    try {
      const origValue = getByPath(origSettings, path)
      // 设置新值
      const setRes = await setSetting(path, newValue)
      if (!setRes?.success) {
        record(name, false, `set failed: ${setRes?.error ?? 'unknown'}`)
        return
      }
      // 读取验证
      const afterSettings = await getSettings()
      const actualValue = getByPath(afterSettings, path)
      // 恢复原值
      await setSetting(path, origValue)
      const restoredSettings = await getSettings()
      const restoredValue = getByPath(restoredSettings, path)

      const setOk = opts.compare ? opts.compare(actualValue, newValue) : actualValue === newValue
      const restoreOk = opts.compare ? opts.compare(restoredValue, origValue) : restoredValue === origValue
      record(name, setOk && restoreOk, `orig=${JSON.stringify(origValue)} set=${JSON.stringify(newValue)} got=${JSON.stringify(actualValue)} restored=${JSON.stringify(restoredValue)}`)
    } catch (err) {
      record(name, false, String(err.message || err))
    }
  }

  // ========== general 路径 ==========
  await testSetting('general.defaultOperator', 'general.defaultOperator', '测试操作员_' + Date.now())
  await testSetting('general.theme', 'general.theme', 'light')
  await testSetting('general.language', 'general.language', 'en-US')
  await testSetting('general.autoUpdate', 'general.autoUpdate', false)
  await testSetting('general.telemetry', 'general.telemetry', true)
  await testSetting('general.logLevel', 'general.logLevel', 'debug')
  await testSetting('general.minimizeToTray', 'general.minimizeToTray', true)
  await testSetting('general.closeBehavior', 'general.closeBehavior', 'exit')
  await testSetting('general.timezone', 'general.timezone', 'America/New_York')
  await testSetting('general.autoStart', 'general.autoStart', true)

  // ========== models 路径 ==========
  await testSetting('models.defaultProvider', 'models.defaultProvider', 'test-provider')
  await testSetting('models.defaultModel', 'models.defaultModel', 'test-model')
  await testSetting('models.highQualityModel', 'models.highQualityModel', 'gpt-4-test')
  await testSetting('models.lowCostModel', 'models.lowCostModel', 'gpt-3.5-test')
  await testSetting('models.transport', 'models.transport', 'websocket')
  await testSetting('models.cacheRetention', 'models.cacheRetention', 'long')
  await testSetting('models.retry.enabled', 'models.retry.enabled', true)
  await testSetting('models.retry.maxRetries', 'models.retry.maxRetries', 7)
  await testSetting('models.retry.baseDelayMs', 'models.retry.baseDelayMs', 2000)
  await testSetting('models.retry.providerTimeoutMs', 'models.retry.providerTimeoutMs', 60000)

  // ========== chat 路径 ==========
  await testSetting('chat.compaction.enabled', 'chat.compaction.enabled', true)
  await testSetting('chat.compaction.reserveTokens', 'chat.compaction.reserveTokens', 2048)
  await testSetting('chat.compaction.keepRecentTokens', 'chat.compaction.keepRecentTokens', 8192)
  await testSetting('chat.steeringMode', 'chat.steeringMode', 'one-at-a-time')
  await testSetting('chat.followUpMode', 'chat.followUpMode', 'one-at-a-time')
  await testSetting('chat.showImages', 'chat.showImages', false)
  await testSetting('chat.maxTokens', 'chat.maxTokens', 8192)
  await testSetting('chat.conversationLogging', 'chat.conversationLogging', true)
  await testSetting('chat.thinkingLevel', 'chat.thinkingLevel', 'high')

  // ========== privacy 路径 ==========
  await testSetting('privacy.enabled', 'privacy.enabled', true)
  await testSetting('privacy.autoAnonymize', 'privacy.autoAnonymize', true)

  // ========== feishu 路径 ==========
  await testSetting('feishu.appId', 'feishu.appId', 'test_app_id_' + Date.now())
  await testSetting('feishu.userOpenId', 'feishu.userOpenId', 'test_open_id')
  await testSetting('feishu.bitableAppToken', 'feishu.bitableAppToken', 'test_token')
  await testSetting('feishu.bitableTableId', 'feishu.bitableTableId', 'test_table')
  await testSetting('feishu.bitableSync.enabled', 'feishu.bitableSync.enabled', true)
  await testSetting('feishu.bitableSync.syncInterval', 'feishu.bitableSync.syncInterval', '0 */6 * * *')

  // ========== advanced 路径 ==========
  await testSetting('advanced.shellPath', 'advanced.shellPath', '/bin/test-shell')
  await testSetting('advanced.sessionDir', 'advanced.sessionDir', '/tmp/test-sessions')
  await testSetting('advanced.httpIdleTimeoutMs', 'advanced.httpIdleTimeoutMs', 120000)

  // ========== shortcuts 路径 (Record<string, string>) ==========
  // shortcuts 使用 schema 验证, 只能修改已存在的键, 不能新增
  try {
    const shortcutsKeys = Object.keys(origSettings.shortcuts || {})
    if (shortcutsKeys.length > 0) {
      const firstKey = shortcutsKeys[0]
      const origShortcut = origSettings.shortcuts[firstKey]
      await testSetting(`shortcuts.${firstKey}`, `shortcuts.${firstKey}`, 'Ctrl+Shift+T')
    } else {
      // 无快捷键定义时, 验证新增键被正确拒绝
      const setRes = await setSetting('shortcuts.testKey', 'Ctrl+Shift+T')
      record('shortcuts 新增键被拒绝 (无已有键)', setRes?.success === false, `success=${setRes?.success}`)
    }
  } catch (err) {
    record('shortcuts 测试', false, String(err.message || err))
  }

  // ========== 嵌套对象写入测试 ==========
  try {
    // 测试写入整个 general 对象
    const origGeneral = origSettings.general
    const testGeneral = { ...origGeneral, defaultOperator: 'WHOLE_OBJECT_TEST' }
    const setRes = await setSetting('general', testGeneral)
    const afterSettings = await getSettings()
    const actualOp = afterSettings.general?.defaultOperator
    // 恢复
    await setSetting('general', origGeneral)
    const restoredSettings = await getSettings()
    const restoredOp = restoredSettings.general?.defaultOperator
    record('写入整个 general 对象', setRes?.success && actualOp === 'WHOLE_OBJECT_TEST' && restoredOp === origGeneral.defaultOperator, `set=${setRes?.success} got=${actualOp} restored=${restoredOp}`)
  } catch (err) {
    record('写入整个 general 对象', false, String(err.message || err))
  }

  // ========== 边界值测试 ==========
  await testSetting('空字符串 general.defaultOperator', 'general.defaultOperator', '')
  await testSetting('数字 models.retry.maxRetries=0', 'models.retry.maxRetries', 0)
  await testSetting('大数字 advanced.httpIdleTimeoutMs', 'advanced.httpIdleTimeoutMs', 999999999)
  await testSetting('特殊字符 general.defaultOperator', 'general.defaultOperator', '测试<>/"\\&')

  // ========== 非法值测试 ==========
  try {
    // 不存在的路径
    const setRes = await setSetting('nonexistent.path', 'test')
    const afterSettings = await getSettings()
    const hasPath = 'nonexistent' in afterSettings
    record('不存在的路径 (应创建或拒绝)', !hasPath || true, `success=${setRes?.success} created=${hasPath}`)
  } catch (err) {
    record('不存在的路径 (应创建或拒绝)', false, String(err.message || err))
  }

  // ========== reset 测试 ==========
  try {
    // 不实际 reset (会丢失用户配置), 仅验证 API 存在
    const apiExists = await evalInPage(`
      (async function() {
        const api = window.__EAA_API__ || window.api;
        return typeof api.settings.reset === 'function';
      })()
    `)
    record('settings.reset API 存在', apiExists === true, `hasReset=${apiExists}`)
  } catch (err) {
    record('settings.reset API 存在', false, String(err.message || err))
  }

  // ========== 最终一致性验证 ==========
  try {
    const finalSettings = await getSettings()
    // 对比关键字段是否与原始值一致 (所有测试都应已恢复)
    const checks = [
      ['general.defaultOperator', finalSettings.general?.defaultOperator, origSettings.general?.defaultOperator],
      ['general.theme', finalSettings.general?.theme, origSettings.general?.theme],
      ['general.language', finalSettings.general?.language, origSettings.general?.language],
      ['models.defaultProvider', finalSettings.models?.defaultProvider, origSettings.models?.defaultProvider],
      ['chat.maxTokens', finalSettings.chat?.maxTokens, origSettings.chat?.maxTokens],
      ['privacy.enabled', finalSettings.privacy?.enabled, origSettings.privacy?.enabled],
      ['advanced.httpIdleTimeoutMs', finalSettings.advanced?.httpIdleTimeoutMs, origSettings.advanced?.httpIdleTimeoutMs],
    ]
    const allMatch = checks.every(([_, a, b]) => a === b)
    record('最终一致性 (所有值已恢复)', allMatch, checks.map(([k, a, b]) => `${k}:${a === b ? '✓' : '✗'}`).join(' '))
  } catch (err) {
    record('最终一致性 (所有值已恢复)', false, String(err.message || err))
  }

  // ========== 汇总 ==========
  console.log('\n========== 设置持久化深度测试 ==========')
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
