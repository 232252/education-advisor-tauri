// =============================================================
// settings.set 并发写入压力测试 — CDP 远程调试
// 覆盖: 并发不同路径 / 并发同路径 / set+get 循环 / 节流保存 /
//       混合读写 / 长字符串 / shortcuts 全键并发 / 落盘验证
// 每项测试: 读原值 → 执行并发压力 → 验证 → 恢复原值
// 运行: node scripts/cdp-settings-concurrent.mjs
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
  console.log('CDP connected, running concurrent tests...\n')

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

  // 枚举字段的合法取值 (与 settings-handlers.ts ENUM_VALIDATORS 一致)
  // 并发测试需使用合法值, 否则 settings.set 因 schema 校验返回 success:false
  const ENUM = {
    'general.theme': ['dark', 'light', 'system'],
    'general.language': ['zh-CN', 'en-US', 'zh', 'en'],
    'general.logLevel': ['debug', 'info', 'warn', 'error', 'off'],
    'chat.steeringMode': ['all', 'one-at-a-time'],
    'chat.followUpMode': ['all', 'one-at-a-time'],
    'chat.thinkingLevel': ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    'general.closeBehavior': ['ask', 'tray', 'exit'],
  }
  // 选取与 orig 不同的合法枚举值 (证明写入确实发生), 否则回退首个合法值
  const pickEnum = (orig, valid) => {
    const v = valid.find((x) => x !== orig)
    return v !== undefined ? v : valid[0]
  }

  // 辅助: 恢复多个路径到原始值
  const restorePaths = async (origSettings, paths) => {
    for (const p of paths) {
      try { await setSetting(p, getByPath(origSettings, p)) } catch (_) { /* ignore restore errors */ }
    }
  }

  // ========== 0: 初始设置读取 ==========
  let origSettings = null
  try {
    origSettings = await getSettings()
    if (!origSettings || typeof origSettings !== 'object') {
      record('初始设置读取', false, 'settings.get 返回无效对象')
      ws.close(); process.exit(1)
    }
    record('初始设置读取', true, `keys=${Object.keys(origSettings).join(',')}`)
  } catch (err) {
    record('初始设置读取', false, String(err.message || err))
    ws.close(); process.exit(1)
  }

  // ========== 测试 1: 并发写入不同路径 (10 个) ==========
  // 同时发起 10 个 settings.set, 每个写入不同 dotPath, 验证全部成功且最终值正确
  {
    const name = '并发写入不同路径 (10 个)'
    const pathsAndValues = [
      ['general.theme', pickEnum(getByPath(origSettings, 'general.theme'), ENUM['general.theme'])],
      ['general.language', pickEnum(getByPath(origSettings, 'general.language'), ENUM['general.language'])],
      ['models.defaultProvider', 'provider_ct'],
      ['models.defaultModel', 'model_ct'],
      ['chat.maxTokens', 8192],
      ['chat.steeringMode', pickEnum(getByPath(origSettings, 'chat.steeringMode'), ENUM['chat.steeringMode'])],
      ['privacy.enabled', !getByPath(origSettings, 'privacy.enabled')],
      ['advanced.httpIdleTimeoutMs', 120000],
      ['general.logLevel', pickEnum(getByPath(origSettings, 'general.logLevel'), ENUM['general.logLevel'])],
      ['general.timezone', 'America/New_York_ct'],
    ]
    const paths = pathsAndValues.map(([p]) => p)
    try {
      const setResults = await Promise.all(pathsAndValues.map(([p, v]) => setSetting(p, v)))
      const allSuccess = setResults.every((r) => r?.success === true)
      const after = await getSettings()
      const allMatch = pathsAndValues.every(([p, v]) => getByPath(after, p) === v)
      record(name, allSuccess && allMatch,
        `setSuccess=${allSuccess} valuesMatch=${allMatch} ` +
        pathsAndValues.map(([p, v]) => `${p}=${JSON.stringify(getByPath(after, p))}`).join(' '))
    } catch (err) {
      record(name, false, String(err.message || err))
    } finally {
      await restorePaths(origSettings, paths)
    }
  }

  // ========== 测试 2: 并发写入同一路径 (5 个不同值) ==========
  // 同时发起 5 个 settings.set 写入同一 dotPath 但不同值, 验证最终值是候选之一 (竞态可接受)
  {
    const name = '并发写入同一路径 (5 个不同值)'
    const path = 'general.defaultOperator'
    const candidates = ['OP_A', 'OP_B', 'OP_C', 'OP_D', 'OP_E']
    try {
      const setResults = await Promise.all(candidates.map((v) => setSetting(path, v)))
      const allSuccess = setResults.every((r) => r?.success === true)
      const after = await getSettings()
      const finalVal = getByPath(after, path)
      const isOneOf = candidates.includes(finalVal)
      record(name, allSuccess && isOneOf,
        `allSetSuccess=${allSuccess} final=${JSON.stringify(finalVal)} isOneOfCandidates=${isOneOf}`)
    } catch (err) {
      record(name, false, String(err.message || err))
    } finally {
      await restorePaths(origSettings, [path])
    }
  }

  // ========== 测试 3: 快速连续 set+get 循环 (20 次) ==========
  // 连续 20 次 set+get, 验证每次 get 都能读到刚才 set 的值
  {
    const name = '快速连续 set+get 循环 (20 次)'
    const path = 'general.defaultOperator'
    let mismatches = 0
    try {
      for (let i = 0; i < 20; i++) {
        const val = `loop_${i}`
        const sr = await setSetting(path, val)
        if (!sr?.success) { mismatches++; continue }
        const after = await getSettings()
        if (getByPath(after, path) !== val) mismatches++
      }
      record(name, mismatches === 0, `rounds=20 mismatches=${mismatches}`)
    } catch (err) {
      record(name, false, String(err.message || err))
    } finally {
      await restorePaths(origSettings, [path])
    }
  }

  // ========== 测试 4: 节流保存验证 (10 次快速 update 后立即 get) ==========
  // 连续快速 update 10 次, 然后立即 get, 验证读取到的是最后一次的值 (不是中间值)
  {
    const name = '节流保存验证 (10 次快速 update)'
    const path = 'general.defaultOperator'
    const lastVal = 'throttle_9'
    try {
      for (let i = 0; i < 10; i++) {
        await setSetting(path, `throttle_${i}`)
      }
      // 立即 get (不等待节流落盘)
      const after = await getSettings()
      const finalVal = getByPath(after, path)
      const isLast = finalVal === lastVal
      record(name, isLast, `expected=${JSON.stringify(lastVal)} got=${JSON.stringify(finalVal)}`)
    } catch (err) {
      record(name, false, String(err.message || err))
    } finally {
      await restorePaths(origSettings, [path])
    }
  }

  // ========== 测试 5: 混合读写 (5 get + 5 set 并发) ==========
  // 并发 5 个 get + 5 个 set 交替, 验证不互相阻塞
  {
    const name = '混合读写 (5 get + 5 set 并发)'
    const setPaths = [
      ['general.theme', pickEnum(getByPath(origSettings, 'general.theme'), ENUM['general.theme'])],
      ['models.defaultProvider', 'mix_provider'],
      ['chat.maxTokens', 4096],
      ['privacy.enabled', !getByPath(origSettings, 'privacy.enabled')],
      ['advanced.httpIdleTimeoutMs', 90000],
    ]
    const paths = setPaths.map(([p]) => p)
    try {
      const tasks = []
      // 5 个 get
      for (let i = 0; i < 5; i++) tasks.push(getSettings())
      // 5 个 set
      for (const [p, v] of setPaths) tasks.push(setSetting(p, v))
      const mixed = await Promise.all(tasks)
      const gets = mixed.slice(0, 5)
      const sets = mixed.slice(5)
      const getsOk = gets.every((g) => g && typeof g === 'object')
      const setsOk = sets.every((s) => s?.success === true)
      record(name, getsOk && setsOk, `getsOk=${getsOk} setsOk=${setsOk} (无阻塞完成)`)
    } catch (err) {
      record(name, false, String(err.message || err))
    } finally {
      await restorePaths(origSettings, paths)
    }
  }

  // ========== 测试 6: 长字符串写入 (10 万字符) ==========
  // 写入 10 万字符字符串到 general.defaultOperator, 验证不报错且能读回
  {
    const name = '长字符串写入 (10 万字符)'
    const path = 'general.defaultOperator'
    const longStr = 'x'.repeat(100000)
    try {
      const sr = await setSetting(path, longStr)
      const after = await getSettings()
      const finalVal = getByPath(after, path)
      const ok = sr?.success === true && finalVal === longStr
      record(name, ok, `setSuccess=${sr?.success} len=${finalVal ? finalVal.length : 0} expected=100000`)
    } catch (err) {
      record(name, false, String(err.message || err))
    } finally {
      await restorePaths(origSettings, [path])
    }
  }

  // ========== 测试 7: 所有 shortcuts 键并发更新 (7 个) ==========
  // 同时更新所有 7 个 shortcuts 键, 验证全部成功
  {
    const name = '所有 shortcuts 键并发更新 (7 个)'
    const shortcutKeys = ['chat.new', 'chat.send', 'chat.abort', 'nav.agents', 'nav.models', 'nav.settings', 'nav.scheduler']
    const pathsAndValues = shortcutKeys.map((k, i) => [`shortcuts.${k}`, `Ctrl+Alt+${i + 1}`])
    const paths = pathsAndValues.map(([p]) => p)
    try {
      const setResults = await Promise.all(pathsAndValues.map(([p, v]) => setSetting(p, v)))
      const allSuccess = setResults.every((r) => r?.success === true)
      const after = await getSettings()
      const allMatch = pathsAndValues.every(([p, v]) => getByPath(after, p) === v)
      record(name, allSuccess && allMatch,
        `allSetSuccess=${allSuccess} allValuesMatch=${allMatch} ` +
        pathsAndValues.map(([p, v]) => `${p}=${JSON.stringify(getByPath(after, p))}`).join(' '))
    } catch (err) {
      record(name, false, String(err.message || err))
    } finally {
      // 必须恢复 (shortcuts.chat.abort 默认 Escape)
      await restorePaths(origSettings, paths)
    }
  }

  // ========== 测试 8: 写入后落盘验证 (5 路径, 等 1 秒) ==========
  // 连续 set 5 个不同路径, 等待 1 秒让节流保存触发, 再 get 验证已持久化
  {
    const name = '写入后落盘验证 (5 路径, 等 1 秒)'
    const pathsAndValues = [
      ['general.theme', pickEnum(getByPath(origSettings, 'general.theme'), ENUM['general.theme'])],
      ['models.defaultProvider', 'persist_provider'],
      ['chat.maxTokens', 16384],
      ['privacy.enabled', !getByPath(origSettings, 'privacy.enabled')],
      ['advanced.httpIdleTimeoutMs', 75000],
    ]
    const paths = pathsAndValues.map(([p]) => p)
    try {
      for (const [p, v] of pathsAndValues) {
        await setSetting(p, v)
      }
      await sleep(1000) // 等待节流保存触发
      const after = await getSettings()
      const allMatch = pathsAndValues.every(([p, v]) => getByPath(after, p) === v)
      record(name, allMatch,
        `allPersisted=${allMatch} ` +
        pathsAndValues.map(([p, v]) => `${p}=${JSON.stringify(getByPath(after, p))}`).join(' '))
    } catch (err) {
      record(name, false, String(err.message || err))
    } finally {
      await restorePaths(origSettings, paths)
    }
  }

  // ========== 汇总 ==========
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n========== 总结 ========== 总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`)
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
