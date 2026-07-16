// =============================================================
// 设置枚举深度测试 — enum 校验 / 类型检查 / 边界值 / shortcuts 点键
// 通过 CDP 远程调试 (端口 9222) 调用 Tauri 渲染进程 IPC API
// 覆盖: 合法枚举 round-trip / 非法枚举拒绝 / 类型校验 / 边界值 /
//       shortcuts 含点键 / 不存在路径 / 并发写入 / 状态恢复
// 每项测试: 读原值 → 执行测试 → 验证 → 恢复原值
// 运行: node scripts/cdp-settings-enum-deep.mjs
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
  console.log('CDP connected, running settings enum deep tests...\n')

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

  // 判断 set 结果是否被拒绝
  const isRejected = (r) => r?.success === false || !!r?.__error
  // 判断 set 结果是否被接受
  const isAccepted = (r) => r?.success === true && !r?.__error

  // 枚举字段的合法取值 (与 settings-handlers.ts ENUM_VALIDATORS 一致)
  const ENUM = {
    'general.theme': ['dark', 'light', 'system'],
    'general.language': ['zh-CN', 'en-US', 'zh', 'en'],
    'general.logLevel': ['debug', 'info', 'warn', 'error', 'off'],
    'chat.steeringMode': ['all', 'one-at-a-time'],
    'chat.followUpMode': ['all', 'one-at-a-time'],
  }

  // ========== 0: 初始设置读取 ==========
  console.log('━━━ 0. 初始设置读取 ━━━')
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

  // 恢复多个路径到原始值
  const restorePaths = async (paths) => {
    for (const p of paths) {
      try { await setSetting(p, getByPath(origSettings, p)) } catch (_) { /* ignore restore errors */ }
    }
  }

  // ========== 1. 枚举校验 — 合法值 round-trip ==========
  console.log('\n━━━ 1. 枚举校验 — 合法值 round-trip ━━━')
  for (const [path, validValues] of Object.entries(ENUM)) {
    for (const val of validValues) {
      await test(`合法枚举 ${path} = ${JSON.stringify(val)}`, async () => {
        const origValue = getByPath(origSettings, path)
        const setRes = await setSetting(path, val)
        const after = await getSettings()
        const actual = getByPath(after, path)
        await setSetting(path, origValue) // 恢复
        const ok = isAccepted(setRes) && actual === val
        record(`合法枚举 ${path} = ${JSON.stringify(val)}`, ok,
          `set=${setRes?.success} expected=${JSON.stringify(val)} got=${JSON.stringify(actual)}`)
      })
    }
  }

  // ========== 2. 枚举校验 — 非法字符串值 (应拒绝) ==========
  console.log('\n━━━ 2. 枚举校验 — 非法字符串值 (应拒绝) ━━━')
  const invalidStringValues = {
    'general.theme': ['purple', 'DARK', ''],
    'general.language': ['fr-FR', 'chinese', ''],
    'general.logLevel': ['trace', 'DEBUG', ''],
    'chat.steeringMode': ['none', 'all-and-more', ''],
    'chat.followUpMode': ['none', ''],
  }
  for (const [path, invalidValues] of Object.entries(invalidStringValues)) {
    for (const val of invalidValues) {
      await test(`非法枚举 ${path} = ${JSON.stringify(val)}`, async () => {
        const origValue = getByPath(origSettings, path)
        const setRes = await setSetting(path, val)
        const after = await getSettings()
        const actual = getByPath(after, path)
        // 恢复 (即使被拒绝也确保恢复, 以防万一)
        if (actual !== origValue) await setSetting(path, origValue)
        const rejected = isRejected(setRes)
        const unchanged = actual === origValue
        record(`非法枚举 ${path} = ${JSON.stringify(val)}`, rejected && unchanged,
          `rejected=${rejected} unchanged=${unchanged} orig=${JSON.stringify(origValue)} got=${JSON.stringify(actual)}`)
      })
    }
  }

  // ========== 2b. 枚举校验 — null 值 (应拒绝) ==========
  console.log('\n━━━ 2b. 枚举校验 — null 值 (应拒绝) ━━━')
  for (const path of Object.keys(ENUM)) {
    await test(`非法枚举 ${path} = null`, async () => {
      const origValue = getByPath(origSettings, path)
      const setRes = await setSetting(path, null)
      const after = await getSettings()
      const actual = getByPath(after, path)
      if (actual !== origValue) await setSetting(path, origValue)
      // null 被 settingsService.update 拒绝 (Invalid value type)
      const rejected = isRejected(setRes)
      const unchanged = actual === origValue
      record(`非法枚举 ${path} = null`, rejected && unchanged,
        `rejected=${rejected} unchanged=${unchanged} orig=${JSON.stringify(origValue)} got=${JSON.stringify(actual)}`)
    })
  }

  // ========== 3. 类型校验 ==========
  console.log('\n━━━ 3. 类型校验 (general.theme) ━━━')
  // null → 应拒绝 (settingsService.update 抛 Invalid value type)
  await test('类型校验: null → 拒绝', async () => {
    const origValue = getByPath(origSettings, 'general.theme')
    const setRes = await setSetting('general.theme', null)
    const after = await getSettings()
    const actual = getByPath(after, 'general.theme')
    if (actual !== origValue) await setSetting('general.theme', origValue)
    const rejected = isRejected(setRes)
    record('类型校验: null → 拒绝', rejected, `success=${setRes?.success} error=${setRes?.error || setRes?.__error || ''}`)
  })

  // undefined → 应拒绝 (JSON 序列化后变 null, 同样被拒绝)
  await test('类型校验: undefined → 拒绝', async () => {
    const origValue = getByPath(origSettings, 'general.theme')
    const setRes = await setSetting('general.theme', undefined)
    const after = await getSettings()
    const actual = getByPath(after, 'general.theme')
    if (actual !== origValue) await setSetting('general.theme', origValue)
    const rejected = isRejected(setRes)
    record('类型校验: undefined → 拒绝', rejected, `success=${setRes?.success} error=${setRes?.error || setRes?.__error || ''}`)
  })

  // number (123) → 实际行为: 接受 (枚举校验仅检查 string, update 不校验类型)
  await test('类型校验: number(123) → 实际接受', async () => {
    const origValue = getByPath(origSettings, 'general.theme')
    const setRes = await setSetting('general.theme', 123)
    const after = await getSettings()
    const actual = getByPath(after, 'general.theme')
    await setSetting('general.theme', origValue) // 恢复
    // 枚举校验仅对 string 生效, number 绕过校验直接写入
    const accepted = isAccepted(setRes) && actual === 123
    record('类型校验: number(123) → 实际接受', accepted,
      `success=${setRes?.success} got=${JSON.stringify(actual)} (枚举校验仅检查 string)`)
  })

  // boolean (true) → 实际行为: 接受
  await test('类型校验: boolean(true) → 实际接受', async () => {
    const origValue = getByPath(origSettings, 'general.theme')
    const setRes = await setSetting('general.theme', true)
    const after = await getSettings()
    const actual = getByPath(after, 'general.theme')
    await setSetting('general.theme', origValue) // 恢复
    const accepted = isAccepted(setRes) && actual === true
    record('类型校验: boolean(true) → 实际接受', accepted,
      `success=${setRes?.success} got=${JSON.stringify(actual)} (枚举校验仅检查 string)`)
  })

  // object ({foo:'bar'}) → 实际行为: 接受 (depth=1 ≤ 10)
  await test('类型校验: object({foo:bar}) → 实际接受', async () => {
    const origValue = getByPath(origSettings, 'general.theme')
    const setRes = await setSetting('general.theme', { foo: 'bar' })
    const after = await getSettings()
    const actual = getByPath(after, 'general.theme')
    await setSetting('general.theme', origValue) // 恢复
    const accepted = isAccepted(setRes) && actual && actual.foo === 'bar'
    record('类型校验: object({foo:bar}) → 实际接受', accepted,
      `success=${setRes?.success} got=${JSON.stringify(actual)} (depth ≤ 10)`)
  })

  // ========== 4. 边界值 ==========
  console.log('\n━━━ 4. 边界值 ━━━')
  // 空字符串 (string, 枚举校验拒绝)
  await test('边界值: general.theme = "" → 拒绝', async () => {
    const origValue = getByPath(origSettings, 'general.theme')
    const setRes = await setSetting('general.theme', '')
    const after = await getSettings()
    const actual = getByPath(after, 'general.theme')
    if (actual !== origValue) await setSetting('general.theme', origValue)
    const rejected = isRejected(setRes)
    record('边界值: general.theme = "" → 拒绝', rejected, `success=${setRes?.success} got=${JSON.stringify(actual)}`)
  })

  // 超长字符串 (>100 字符, string, 枚举校验拒绝)
  await test('边界值: general.language = 超长字符串 → 拒绝', async () => {
    const origValue = getByPath(origSettings, 'general.language')
    const longStr = 'x'.repeat(200)
    const setRes = await setSetting('general.language', longStr)
    const after = await getSettings()
    const actual = getByPath(after, 'general.language')
    if (actual !== origValue) await setSetting('general.language', origValue)
    const rejected = isRejected(setRes)
    record('边界值: general.language = 超长字符串 → 拒绝', rejected,
      `success=${setRes?.success} len=${longStr.length} got=${JSON.stringify(actual)}`)
  })

  // 空白填充值 '  debug  ' (string, 枚举校验拒绝, 无 trim)
  await test('边界值: general.logLevel = "  debug  " → 拒绝 (无 trim)', async () => {
    const origValue = getByPath(origSettings, 'general.logLevel')
    const setRes = await setSetting('general.logLevel', '  debug  ')
    const after = await getSettings()
    const actual = getByPath(after, 'general.logLevel')
    if (actual !== origValue) await setSetting('general.logLevel', origValue)
    const rejected = isRejected(setRes)
    record('边界值: general.logLevel = "  debug  " → 拒绝 (无 trim)', rejected,
      `success=${setRes?.success} got=${JSON.stringify(actual)}`)
  })

  // 大写 'DEBUG' (string, 枚举校验拒绝, 大小写敏感)
  await test('边界值: general.logLevel = "DEBUG" → 拒绝 (大小写敏感)', async () => {
    const origValue = getByPath(origSettings, 'general.logLevel')
    const setRes = await setSetting('general.logLevel', 'DEBUG')
    const after = await getSettings()
    const actual = getByPath(after, 'general.logLevel')
    if (actual !== origValue) await setSetting('general.logLevel', origValue)
    const rejected = isRejected(setRes)
    record('边界值: general.logLevel = "DEBUG" → 拒绝 (大小写敏感)', rejected,
      `success=${setRes?.success} got=${JSON.stringify(actual)}`)
  })

  // ========== 5. Shortcuts 点键处理 ==========
  console.log('\n━━━ 5. Shortcuts 点键处理 ━━━')
  // shortcuts.chat.abort = 'Ctrl+Shift+T' (合法键, round-trip)
  await test('shortcuts.chat.abort = "Ctrl+Shift+T" (round-trip)', async () => {
    const origValue = getByPath(origSettings, 'shortcuts.chat.abort')
    const setRes = await setSetting('shortcuts.chat.abort', 'Ctrl+Shift+T')
    const after = await getSettings()
    const actual = getByPath(after, 'shortcuts.chat.abort')
    await setSetting('shortcuts.chat.abort', origValue) // 恢复
    const ok = isAccepted(setRes) && actual === 'Ctrl+Shift+T'
    record('shortcuts.chat.abort = "Ctrl+Shift+T" (round-trip)', ok,
      `set=${setRes?.success} expected="Ctrl+Shift+T" got=${JSON.stringify(actual)}`)
  })

  // shortcuts.send.message = 'Enter' (不存在的键, 应拒绝)
  await test('shortcuts.send.message = "Enter" (不存在键 → 拒绝)', async () => {
    const setRes = await setSetting('shortcuts.send.message', 'Enter')
    const after = await getSettings()
    // 'send.message' 不在 DEFAULT_SETTINGS.shortcuts 中, 应被拒绝
    const rejected = isRejected(setRes)
    record('shortcuts.send.message = "Enter" (不存在键 → 拒绝)', rejected,
      `success=${setRes?.success} error=${setRes?.error || setRes?.__error || ''}`)
  })

  // shortcuts.chat.new = '' (空值, 实际接受 — shortcuts 无空值校验)
  await test('shortcuts.chat.new = "" (空值 → 实际接受)', async () => {
    const origValue = getByPath(origSettings, 'shortcuts.chat.new')
    const setRes = await setSetting('shortcuts.chat.new', '')
    const after = await getSettings()
    const actual = getByPath(after, 'shortcuts.chat.new')
    await setSetting('shortcuts.chat.new', origValue) // 恢复
    const ok = isAccepted(setRes) && actual === ''
    record('shortcuts.chat.new = "" (空值 → 实际接受)', ok,
      `set=${setRes?.success} expected="" got=${JSON.stringify(actual)}`)
  })

  // shortcuts.chat.new = 超长值 (100000 字符, < 1M 限制, 接受)
  await test('shortcuts.chat.new = 超长值(100000字符) → 接受', async () => {
    const origValue = getByPath(origSettings, 'shortcuts.chat.new')
    const longVal = 'Ctrl+Shift+' + 'X'.repeat(100000)
    const setRes = await setSetting('shortcuts.chat.new', longVal)
    const after = await getSettings()
    const actual = getByPath(after, 'shortcuts.chat.new')
    await setSetting('shortcuts.chat.new', origValue) // 恢复
    const ok = isAccepted(setRes) && actual === longVal
    record('shortcuts.chat.new = 超长值(100000字符) → 接受', ok,
      `set=${setRes?.success} len=${actual ? actual.length : 0} expected=${longVal.length}`)
  })

  // shortcuts.nav.settings = 特殊字符 (接受)
  await test('shortcuts.nav.settings = 特殊字符 → 接受', async () => {
    const origValue = getByPath(origSettings, 'shortcuts.nav.settings')
    const specialVal = 'Ctrl+Shift+<>"&\\'
    const setRes = await setSetting('shortcuts.nav.settings', specialVal)
    const after = await getSettings()
    const actual = getByPath(after, 'shortcuts.nav.settings')
    await setSetting('shortcuts.nav.settings', origValue) // 恢复
    const ok = isAccepted(setRes) && actual === specialVal
    record('shortcuts.nav.settings = 特殊字符 → 接受', ok,
      `set=${setRes?.success} expected=${JSON.stringify(specialVal)} got=${JSON.stringify(actual)}`)
  })

  // ========== 6. 不存在路径 ==========
  console.log('\n━━━ 6. 不存在路径 ━━━')
  // Get 不存在路径 (settings.get() 返回全量, 提取不存在路径 → undefined, 不崩溃)
  await test('Get 不存在路径 → undefined (不崩溃)', async () => {
    const settings = await getSettings()
    const val = getByPath(settings, 'nonexistent.path')
    const ok = val === undefined
    record('Get 不存在路径 → undefined (不崩溃)', ok, `val=${JSON.stringify(val)}`)
  })

  // Get 嵌套不存在路径
  await test('Get 嵌套不存在路径 → undefined (不崩溃)', async () => {
    const settings = await getSettings()
    const val = getByPath(settings, 'general.nonexistent.deep')
    const ok = val === undefined
    record('Get 嵌套不存在路径 → undefined (不崩溃)', ok, `val=${JSON.stringify(val)}`)
  })

  // Set 不存在路径 (应拒绝 — dotPath 不在 DEFAULT_SETTINGS 中)
  await test('Set 不存在路径 → 拒绝', async () => {
    const setRes = await setSetting('nonexistent.path', 'test')
    const after = await getSettings()
    const hasPath = 'nonexistent' in after
    const rejected = isRejected(setRes)
    const notCreated = !hasPath
    record('Set 不存在路径 → 拒绝', rejected && notCreated,
      `success=${setRes?.success} created=${hasPath} error=${setRes?.error || setRes?.__error || ''}`)
  })

  // Set 空路径 (应拒绝)
  await test('Set 空路径 → 拒绝', async () => {
    const setRes = await setSetting('', 'test')
    const rejected = isRejected(setRes)
    record('Set 空路径 → 拒绝', rejected, `success=${setRes?.success} error=${setRes?.error || setRes?.__error || ''}`)
  })

  // Set 含空段的路径 (应拒绝)
  await test('Set 含空段路径 "general..theme" → 拒绝', async () => {
    const setRes = await setSetting('general..theme', 'dark')
    const rejected = isRejected(setRes)
    record('Set 含空段路径 "general..theme" → 拒绝', rejected, `success=${setRes?.success} error=${setRes?.error || setRes?.__error || ''}`)
  })

  // ========== 7. 并发设置 ==========
  console.log('\n━━━ 7. 并发设置 ━━━')
  // 并发写入不同枚举字段 (全部应成功)
  await test('并发写入不同枚举字段 (5 个)', async () => {
    const pathsAndValues = [
      ['general.theme', 'light'],
      ['general.language', 'en-US'],
      ['general.logLevel', 'warn'],
      ['chat.steeringMode', 'one-at-a-time'],
      ['chat.followUpMode', 'one-at-a-time'],
    ]
    const paths = pathsAndValues.map(([p]) => p)
    const origValues = paths.map((p) => getByPath(origSettings, p))
    try {
      const setResults = await Promise.all(pathsAndValues.map(([p, v]) => setSetting(p, v)))
      const allSuccess = setResults.every((r) => isAccepted(r))
      const after = await getSettings()
      const allMatch = pathsAndValues.every(([p, v]) => getByPath(after, p) === v)
      record('并发写入不同枚举字段 (5 个)', allSuccess && allMatch,
        `allSuccess=${allSuccess} allMatch=${allMatch} ` +
        pathsAndValues.map(([p, v]) => `${p}=${JSON.stringify(getByPath(after, p))}`).join(' '))
    } finally {
      // 恢复
      for (let i = 0; i < paths.length; i++) {
        await setSetting(paths[i], origValues[i])
      }
    }
  })

  // 并发写入同一字段 (last-write-wins, 最终值是候选之一)
  await test('并发写入同一字段 (last-write-wins)', async () => {
    const path = 'general.theme'
    const origValue = getByPath(origSettings, path)
    const candidates = ['dark', 'light', 'system']
    try {
      const setResults = await Promise.all(candidates.map((v) => setSetting(path, v)))
      const allSuccess = setResults.every((r) => isAccepted(r))
      const after = await getSettings()
      const finalVal = getByPath(after, path)
      const isOneOf = candidates.includes(finalVal)
      record('并发写入同一字段 (last-write-wins)', allSuccess && isOneOf,
        `allSuccess=${allSuccess} final=${JSON.stringify(finalVal)} isOneOfCandidates=${isOneOf}`)
    } finally {
      await setSetting(path, origValue) // 恢复
    }
  })

  // ========== 8. 状态恢复 ==========
  console.log('\n━━━ 8. 状态恢复验证 ━━━')
  await test('最终状态恢复一致', async () => {
    // 等待节流保存完成
    await sleep(500)
    const finalSettings = await getSettings()
    // 对比所有被测试修改过的关键字段
    const checkPaths = [
      'general.theme',
      'general.language',
      'general.logLevel',
      'chat.steeringMode',
      'chat.followUpMode',
      'shortcuts.chat.abort',
      'shortcuts.chat.new',
      'shortcuts.nav.settings',
    ]
    const mismatches = []
    for (const p of checkPaths) {
      const orig = getByPath(origSettings, p)
      const final = getByPath(finalSettings, p)
      if (orig !== final) {
        mismatches.push(`${p}: orig=${JSON.stringify(orig)} final=${JSON.stringify(final)}`)
      }
    }
    const allMatch = mismatches.length === 0
    record('最终状态恢复一致', allMatch,
      mismatches.length === 0 ? `所有 ${checkPaths.length} 个字段已恢复` : `不一致: ${mismatches.join('; ')}`)
  })

  // ========== 汇总 ==========
  console.log('\n========== 设置枚举深度测试汇总 ==========')
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
