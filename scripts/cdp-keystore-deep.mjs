// =============================================================
// Keystore 深度测试 — API Key 管理 IPC 处理器
// 通过 CDP 远程调试 (端口 9222) 调用渲染进程 IPC API
// 覆盖: API 存在性 / 列出 key / 增加 key / 获取 key / 删除 key /
//       边界值 (空名/空值/null/超长/空字节) / 重复覆盖 /
//       安全 (原始 key 不外泄 / __secret__ 不外露 / 返回不回显) /
//       持久性 (同会话多次读取一致)
// 设计: 优先选择未配置 key 的 provider 做 round-trip, 测试后清理还原
// 运行: node scripts/cdp-keystore-deep.mjs
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
  const test = (name, fn) =>
    fn().catch((err) =>
      record(name, false, `异常: ${String(err && err.message ? err.message : err).slice(0, 200)}`),
    )

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
  console.log('CDP connected, running keystore deep tests...\n')

  // ---------- IPC 封装 (统一 try/catch, 返回 {__error} 而非抛出) ----------
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

  const listProviders = () => callIpc(`return await api.ai.listProviders();`)
  const setApiKey = (provider, key) =>
    callIpc(`return await api.ai.setApiKey(${JSON.stringify(provider)}, ${JSON.stringify(key)});`)
  const deleteApiKey = (provider) =>
    callIpc(`return await api.ai.deleteApiKey(${JSON.stringify(provider)});`)
  const getSettings = () => callIpc(`return await api.settings.get();`)
  const setSetting = (path, value) =>
    callIpc(
      `return await api.settings.set(${JSON.stringify(path)}, ${JSON.stringify(value)});`,
    )

  const isOk = (r) => r && r.success === true && !r.__error
  const isRejected = (r) => (r && r.success === false) || !!r?.__error

  // ---------- 测试常量 ----------
  // 使用一个醒目且不可能是真实 key 的测试值, 便于在安全测试中扫描是否泄漏
  const TEST_KEY_A = 'sk-cdp-test-keystore-9f8e7d6c5b4a'
  const TEST_KEY_B = 'sk-cdp-test-keystore-OVERWRITE-22222'
  const TEST_KEY_LONG = 'K'.repeat(500) // 合法长度 (< 10000)

  // 跟踪本次测试设置过 key 的 provider, 用于最终清理
  const touchedProviders = new Set()

  // ========== 0. API 存在性 ==========
  console.log('━━━ 0. API 存在性 ━━━')
  await test('window.api 存在', async () => {
    const r = await evalInPage(`(function(){ const api = window.__EAA_API__ || window.api; return !!api; })()`)
    record('window.api 存在', r === true, `api=${r}`)
  })

  await test('api.ai.setApiKey 是函数', async () => {
    const r = await evalInPage(`(function(){ const api = window.__EAA_API__||window.api; return typeof (api&&api.ai&&api.ai.setApiKey) === 'function'; })()`)
    record('api.ai.setApiKey 是函数', r === true, `typeof=${r}`)
  })

  await test('api.ai.deleteApiKey 是函数', async () => {
    const r = await evalInPage(`(function(){ const api = window.__EAA_API__||window.api; return typeof (api&&api.ai&&api.ai.deleteApiKey) === 'function'; })()`)
    record('api.ai.deleteApiKey 是函数', r === true, `typeof=${r}`)
  })

  await test('api.ai.listProviders 是函数', async () => {
    const r = await evalInPage(`(function(){ const api = window.__EAA_API__||window.api; return typeof (api&&api.ai&&api.ai.listProviders) === 'function'; })()`)
    record('api.ai.listProviders 是函数', r === true, `typeof=${r}`)
  })

  await test('api.settings.get / set 是函数', async () => {
    const r = await evalInPage(`(function(){ const api = window.__EAA_API__||window.api; return typeof (api&&api.settings&&api.settings.get)==='function' && typeof (api&&api.settings&&api.settings.set)==='function'; })()`)
    record('api.settings.get / set 是函数', r === true, `typeof=${r}`)
  })

  // ========== 1. 列出 key — 初始状态 ==========
  console.log('\n━━━ 1. 列出 key — 初始状态 ━━━')
  let initialProviders = null
  await test('listProviders 返回数组', async () => {
    const r = await listProviders()
    if (r?.__error) { record('listProviders 返回数组', false, r.__error); return }
    initialProviders = Array.isArray(r) ? r : null
    record('listProviders 返回数组', Array.isArray(r), `type=${Array.isArray(r) ? 'array' : typeof r} len=${Array.isArray(r) ? r.length : 0}`)
  })

  await test('每个 provider 含必需字段 (id/name/hasApiKey)', async () => {
    if (!initialProviders) { record('每个 provider 含必需字段 (id/name/hasApiKey)', false, '无初始 provider 列表'); return }
    const allValid = initialProviders.every(
      (p) => typeof p === 'object' && p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.hasApiKey === 'boolean',
    )
    record('每个 provider 含必需字段 (id/name/hasApiKey)', allValid, `count=${initialProviders.length}`)
  })

  await test('listProviders 不返回原始 key 内容 (无 apiKey/key/secret 字段)', async () => {
    if (!initialProviders) { record('listProviders 不返回原始 key 内容 (无 apiKey/key/secret 字段)', false, '无列表'); return }
    const bad = []
    for (const p of initialProviders) {
      const keys = Object.keys(p)
      for (const k of keys) {
        if (/^apiKey$|^key$|secret/i.test(k)) bad.push(`${p.id}.${k}`)
      }
    }
    record('listProviders 不返回原始 key 内容 (无 apiKey/key/secret 字段)', bad.length === 0, bad.length ? `泄漏字段: ${bad.join(',')}` : '仅返回 hasApiKey 布尔')
  })

  // 初始 hasApiKey 快照 (用于最终还原校验)
  const initialHasKeyMap = new Map()
  if (initialProviders) {
    for (const p of initialProviders) initialHasKeyMap.set(p.id, p.hasApiKey)
  }

  // 选择一个初始未配置 key 的 provider 做 round-trip (避免破坏真实 key)
  const keylessProviders = initialProviders
    ? initialProviders.filter((p) => p.hasApiKey === false).map((p) => p.id)
    : []
  const TEST_PROVIDER = keylessProviders[0] || null
  const TEST_PROVIDER_2 = keylessProviders[1] || keylessProviders[0] || null

  console.log(
    `\n[info] 未配置 key 的 provider: [${keylessProviders.join(', ')}], 选用 TEST_PROVIDER=${TEST_PROVIDER}\n`,
  )

  // ========== 2. 增加 key ==========
  console.log('━━━ 2. 增加 key ━━━')
  await test('setApiKey(无 key provider, 测试 key) → success', async () => {
    if (!TEST_PROVIDER) { record('setApiKey(无 key provider, 测试 key) → success', false, '无可用未配置 provider'); return }
    const r = await setApiKey(TEST_PROVIDER, TEST_KEY_A)
    if (isOk(r)) touchedProviders.add(TEST_PROVIDER)
    record('setApiKey(无 key provider, 测试 key) → success', isOk(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('set 后 listProviders 该 provider hasApiKey=true', async () => {
    if (!TEST_PROVIDER) { record('set 后 listProviders 该 provider hasApiKey=true', false, '无 TEST_PROVIDER'); return }
    const list = await listProviders()
    const p = Array.isArray(list) ? list.find((x) => x.id === TEST_PROVIDER) : null
    record('set 后 listProviders 该 provider hasApiKey=true', !!p && p.hasApiKey === true, `hasApiKey=${p?.hasApiKey}`)
  })

  await test('setApiKey 返回结构为 {success:true} (不回显 key)', async () => {
    if (!TEST_PROVIDER_2) { record('setApiKey 返回结构为 {success:true} (不回显 key)', false, '无第二个未配置 provider'); return }
    const r = await setApiKey(TEST_PROVIDER_2, TEST_KEY_A)
    if (isOk(r)) touchedProviders.add(TEST_PROVIDER_2)
    const keys = r ? Object.keys(r) : []
    const noLeak = keys.every((k) => !/key|secret/i.test(k))
    record('setApiKey 返回结构为 {success:true} (不回显 key)', isOk(r) && noLeak, `keys=[${keys.join(',')}]`)
  })

  await test('两个 provider 同时配置 key 后均 hasApiKey=true (多 key 共存)', async () => {
    const list = await listProviders()
    if (!Array.isArray(list)) { record('两个 provider 同时配置 key 后均 hasApiKey=true (多 key 共存)', false, 'listProviders 失败'); return }
    const a = list.find((x) => x.id === TEST_PROVIDER)
    const b = list.find((x) => x.id === TEST_PROVIDER_2)
    const ok = !!a && !!b && a.hasApiKey === true && b.hasApiKey === true
    record('两个 provider 同时配置 key 后均 hasApiKey=true (多 key 共存)', ok, `${TEST_PROVIDER}=${a?.hasApiKey} ${TEST_PROVIDER_2}=${b?.hasApiKey}`)
  })

  await test('setApiKey 接受较长但合法的 key (500 字符)', async () => {
    // 用 TEST_PROVIDER 覆盖写入一个长 key
    const r = await setApiKey(TEST_PROVIDER, TEST_KEY_LONG)
    record('setApiKey 接受较长但合法的 key (500 字符)', isOk(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  // ========== 3. 获取 key (安全: 原始 key 不可读取) ==========
  console.log('\n━━━ 3. 获取 key (安全契约: 原始 key 不通过 IPC 暴露) ━━━')
  await test('api.ai 不存在 getApiKey 方法 (原始 key 不可读取)', async () => {
    const r = await evalInPage(`(function(){ const api = window.__EAA_API__||window.api; return typeof (api&&api.ai&&api.ai.getApiKey); })()`)
    // 期望 undefined: 没有读取原始 key 的 IPC
    record('api.ai 不存在 getApiKey 方法 (原始 key 不可读取)', r === 'undefined' || r === undefined, `typeof getApiKey=${JSON.stringify(r)}`)
  })

  await test('hasApiKey 仅为布尔值 (非 key 字符串)', async () => {
    const list = await listProviders()
    if (!Array.isArray(list)) { record('hasApiKey 仅为布尔值 (非 key 字符串)', false, 'list 失败'); return }
    const allBool = list.every((p) => p.hasApiKey === true || p.hasApiKey === false)
    record('hasApiKey 仅为布尔值 (非 key 字符串)', allBool, `nonBool=${list.filter((p) => typeof p.hasApiKey !== 'boolean').length}`)
  })

  await test('测试 key 字符串不出现在 listProviders 响应中 (不泄漏)', async () => {
    const list = await listProviders()
    const json = JSON.stringify(list || {})
    const leaked = json.includes(TEST_KEY_A) || json.includes(TEST_KEY_LONG)
    record('测试 key 字符串不出现在 listProviders 响应中 (不泄漏)', !leaked, leaked ? '原始 key 出现在响应!' : '响应中无原始 key')
  })

  await test('listProviders 不暴露 __secret__:* 内部条目', async () => {
    const list = await listProviders()
    if (!Array.isArray(list)) { record('listProviders 不暴露 __secret__:* 内部条目', false, 'list 失败'); return }
    const leaked = list.filter((p) => typeof p.id === 'string' && p.id.startsWith('__secret__:'))
    record('listProviders 不暴露 __secret__:* 内部条目', leaked.length === 0, leaked.length ? `泄漏: ${leaked.map((p) => p.id).join(',')}` : '无内部 secret 泄漏')
  })

  // ========== 4. 删除 key ==========
  console.log('\n━━━ 4. 删除 key ━━━')
  await test('deleteApiKey(已配置测试 key) → success', async () => {
    if (!TEST_PROVIDER) { record('deleteApiKey(已配置测试 key) → success', false, '无 TEST_PROVIDER'); return }
    const r = await deleteApiKey(TEST_PROVIDER)
    record('deleteApiKey(已配置测试 key) → success', isOk(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('delete 后 hasApiKey=false (恢复未配置)', async () => {
    if (!TEST_PROVIDER) { record('delete 后 hasApiKey=false (恢复未配置)', false, '无 TEST_PROVIDER'); return }
    const list = await listProviders()
    const p = Array.isArray(list) ? list.find((x) => x.id === TEST_PROVIDER) : null
    record('delete 后 hasApiKey=false (恢复未配置)', !!p && p.hasApiKey === false, `hasApiKey=${p?.hasApiKey}`)
  })

  await test('deleteApiKey 返回结构为 {success:true} (不回显已删 key)', async () => {
    if (!TEST_PROVIDER_2) { record('deleteApiKey 返回结构为 {success:true} (不回显已删 key)', false, '无 TEST_PROVIDER_2'); return }
    const r = await deleteApiKey(TEST_PROVIDER_2)
    const keys = r ? Object.keys(r) : []
    const noLeak = keys.every((k) => !/key|secret/i.test(k))
    record('deleteApiKey 返回结构为 {success:true} (不回显已删 key)', isOk(r) && noLeak, `success=${r?.success} keys=[${keys.join(',')}]`)
  })

  await test('deleteApiKey 对未配置 key 的 provider 幂等 → success', async () => {
    if (!TEST_PROVIDER) { record('deleteApiKey 对未配置 key 的 provider 幂等 → success', false, '无 TEST_PROVIDER'); return }
    // TEST_PROVIDER 已被上一轮删除, 现在再次删除
    const r = await deleteApiKey(TEST_PROVIDER)
    record('deleteApiKey 对未配置 key 的 provider 幂等 → success', isOk(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  // ========== 5. 边界值 — setApiKey 非法输入 (应拒绝) ==========
  console.log('\n━━━ 5. 边界值 — setApiKey 非法输入 (应拒绝) ━━━')
  await test('setApiKey("", key) → 拒绝 (空 providerId)', async () => {
    const r = await setApiKey('', TEST_KEY_A)
    record('setApiKey("", key) → 拒绝 (空 providerId)', isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('setApiKey(null, key) → 拒绝 (null providerId)', async () => {
    const r = await callIpc(`return await api.ai.setApiKey(null, ${JSON.stringify(TEST_KEY_A)});`)
    record('setApiKey(null, key) → 拒绝 (null providerId)', isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('setApiKey(undefined, key) → 拒绝', async () => {
    const r = await callIpc(`return await api.ai.setApiKey(undefined, ${JSON.stringify(TEST_KEY_A)});`)
    record('setApiKey(undefined, key) → 拒绝', isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('setApiKey(123, key) → 拒绝 (非字符串 providerId)', async () => {
    const r = await callIpc(`return await api.ai.setApiKey(123, ${JSON.stringify(TEST_KEY_A)});`)
    record('setApiKey(123, key) → 拒绝 (非字符串 providerId)', isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('setApiKey(provider, "") → 拒绝 (空 apiKey)', async () => {
    if (!TEST_PROVIDER) { record('setApiKey(provider, "") → 拒绝 (空 apiKey)', false, '无 TEST_PROVIDER'); return }
    const r = await setApiKey(TEST_PROVIDER, '')
    record('setApiKey(provider, "") → 拒绝 (空 apiKey)', isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('setApiKey(provider, null) → 拒绝 (null apiKey)', async () => {
    if (!TEST_PROVIDER) { record('setApiKey(provider, null) → 拒绝 (null apiKey)', false, '无 TEST_PROVIDER'); return }
    const r = await callIpc(`return await api.ai.setApiKey(${JSON.stringify(TEST_PROVIDER)}, null);`)
    record('setApiKey(provider, null) → 拒绝 (null apiKey)', isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('setApiKey(provider, 123) → 拒绝 (非字符串 apiKey)', async () => {
    if (!TEST_PROVIDER) { record('setApiKey(provider, 123) → 拒绝 (非字符串 apiKey)', false, '无 TEST_PROVIDER'); return }
    const r = await callIpc(`return await api.ai.setApiKey(${JSON.stringify(TEST_PROVIDER)}, 123);`)
    record('setApiKey(provider, 123) → 拒绝 (非字符串 apiKey)', isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('setApiKey(provider, "a\\0b") → 拒绝 (含空字节)', async () => {
    if (!TEST_PROVIDER) { record('setApiKey(provider, "a\\0b") → 拒绝 (含空字节)', false, '无 TEST_PROVIDER'); return }
    const r = await callIpc(`return await api.ai.setApiKey(${JSON.stringify(TEST_PROVIDER)}, "a\\u0000b");`)
    record('setApiKey(provider, "a\\0b") → 拒绝 (含空字节)', isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('setApiKey(超长 providerId 257 字符, key) → 拒绝', async () => {
    const longId = 'p'.repeat(257)
    const r = await setApiKey(longId, TEST_KEY_A)
    record('setApiKey(超长 providerId 257 字符, key) → 拒绝', isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('setApiKey(provider, 超长 apiKey 10001 字符) → 拒绝', async () => {
    if (!TEST_PROVIDER) { record('setApiKey(provider, 超长 apiKey 10001 字符) → 拒绝', false, '无 TEST_PROVIDER'); return }
    const longKey = 'K'.repeat(10001)
    const r = await setApiKey(TEST_PROVIDER, longKey)
    record('setApiKey(provider, 超长 apiKey 10001 字符) → 拒绝', isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  // ========== 5b. 边界值 — deleteApiKey 非法输入 (应拒绝) ==========
  console.log('\n━━━ 5b. 边界值 — deleteApiKey 非法输入 (应拒绝) ━━━')
  await test('deleteApiKey("") → 拒绝 (空 providerId)', async () => {
    const r = await deleteApiKey('')
    record('deleteApiKey("") → 拒绝 (空 providerId)', isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('deleteApiKey(null) → 拒绝', async () => {
    const r = await callIpc(`return await api.ai.deleteApiKey(null);`)
    record('deleteApiKey(null) → 拒绝', isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('deleteApiKey(123) → 拒绝 (非字符串)', async () => {
    const r = await callIpc(`return await api.ai.deleteApiKey(123);`)
    record('deleteApiKey(123) → 拒绝 (非字符串)', isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('deleteApiKey(超长 257 字符) → 拒绝', async () => {
    const r = await deleteApiKey('p'.repeat(257))
    record('deleteApiKey(超长 257 字符) → 拒绝', isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('deleteApiKey("a\\0b") → 拒绝 (含空字节)', async () => {
    const r = await callIpc(`return await api.ai.deleteApiKey("a\\u0000b");`)
    record('deleteApiKey("a\\0b") → 拒绝 (含空字节)', isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  // ========== 6. 重复 / 覆盖 key ==========
  console.log('\n━━━ 6. 重复 / 覆盖 key ━━━')
  await test('覆盖写入: set key-A 再 set key-B → 均 success, hasApiKey 持续 true', async () => {
    if (!TEST_PROVIDER) { record('覆盖写入: set key-A 再 set key-B → 均 success, hasApiKey 持续 true', false, '无 TEST_PROVIDER'); return }
    const r1 = await setApiKey(TEST_PROVIDER, TEST_KEY_A)
    if (isOk(r1)) touchedProviders.add(TEST_PROVIDER)
    const r2 = await setApiKey(TEST_PROVIDER, TEST_KEY_B)
    const list = await listProviders()
    const p = Array.isArray(list) ? list.find((x) => x.id === TEST_PROVIDER) : null
    const ok = isOk(r1) && isOk(r2) && !!p && p.hasApiKey === true
    record('覆盖写入: set key-A 再 set key-B → 均 success, hasApiKey 持续 true', ok, `r1=${r1?.success} r2=${r2?.success} hasApiKey=${p?.hasApiKey}`)
  })

  await test('覆盖后原始 key-A 不泄漏到 listProviders', async () => {
    const list = await listProviders()
    const json = JSON.stringify(list || {})
    const leaked = json.includes(TEST_KEY_A) || json.includes(TEST_KEY_B)
    record('覆盖后原始 key-A 不泄漏到 listProviders', !leaked, leaked ? 'key 泄漏!' : '无泄漏')
  })

  await test('幂等写入: 同一 key 连续 set 两次 → 均 success', async () => {
    if (!TEST_PROVIDER) { record('幂等写入: 同一 key 连续 set 两次 → 均 success', false, '无 TEST_PROVIDER'); return }
    const r1 = await setApiKey(TEST_PROVIDER, TEST_KEY_A)
    const r2 = await setApiKey(TEST_PROVIDER, TEST_KEY_A)
    record('幂等写入: 同一 key 连续 set 两次 → 均 success', isOk(r1) && isOk(r2), `r1=${r1?.success} r2=${r2?.success}`)
  })

  // ========== 7. 安全 ==========
  console.log('\n━━━ 7. 安全 ━━━')
  await test('listProviders 响应中不含任何已设置的测试 key 片段', async () => {
    const list = await listProviders()
    const json = JSON.stringify(list || {})
    const ok = !json.includes('sk-cdp-test-keystore')
    record('listProviders 响应中不含任何已设置的测试 key 片段', ok, ok ? '响应干净' : '检测到测试 key 片段泄漏')
  })

  await test('settings.get() 中 feishu.appSecret 不返回真实密钥 (占位符或空)', async () => {
    // 安全契约: 若 keystore 存了 feishu secret, settings.get 返回 '__keystore__' 占位符, 永不返回明文
    const s = await getSettings()
    if (s?.__error) { record('settings.get() 中 feishu.appSecret 不返回真实密钥 (占位符或空)', false, s.__error); return }
    const secret = s && s.feishu && s.feishu.appSecret
    // 合法值: undefined / 空串 / '__keystore__' 占位符; 不应是真实 secret
    const safe = secret === undefined || secret === '' || secret === '__keystore__'
    record('settings.get() 中 feishu.appSecret 不返回真实密钥 (占位符或空)', safe, `appSecret=${JSON.stringify(secret)}`)
  })

  await test('set feishu.appSecret = "__keystore__" → no-op success (不写明文)', async () => {
    // 占位符回写应被识别为"用户未修改", 直接 success 且不写入 keystore
    const r = await setSetting('feishu.appSecret', '__keystore__')
    record('set feishu.appSecret = "__keystore__" → no-op success (不写明文)', isOk(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('api 对象上不存在直接读取 keystore 原始 key 的方法', async () => {
    const r = await evalInPage(`(function(){
      const api = window.__EAA_API__||window.api;
      if(!api||!api.ai) return 'no-ai';
      const dangerous = ['getApiKey','getKey','listKeys','getAllKeys','exportKeys','dumpKeystore'].filter(k => typeof api.ai[k]==='function');
      return JSON.stringify(dangerous);
    })()`)
    let bad = []
    try { bad = JSON.parse(r) } catch (_) { /* 'no-ai' 等非 JSON 字符串 */ }
    record('api 对象上不存在直接读取 keystore 原始 key 的方法', Array.isArray(bad) && bad.length === 0, `dangerous methods=[${Array.isArray(bad) ? bad.join(',') : r}]`)
  })

  await test('set feishu.appSecret 占位符后 settings.get 仍返回占位符 (未破坏既有状态)', async () => {
    const s = await getSettings()
    const secret = s && s.feishu && s.feishu.appSecret
    const safe = secret === undefined || secret === '' || secret === '__keystore__'
    record('set feishu.appSecret 占位符后 settings.get 仍返回占位符 (未破坏既有状态)', safe, `appSecret=${JSON.stringify(secret)}`)
  })

  // ========== 8. 持久性 (同会话) ==========
  console.log('\n━━━ 8. 持久性 (同会话多次读取一致) ━━━')
  await test('set 后连续 3 次 listProviders, hasApiKey 始终 true', async () => {
    if (!TEST_PROVIDER) { record('set 后连续 3 次 listProviders, hasApiKey 始终 true', false, '无 TEST_PROVIDER'); return }
    // 当前 TEST_PROVIDER 应处于已配置状态 (上一轮幂等写入后未删除)
    const r = await setApiKey(TEST_PROVIDER, TEST_KEY_A)
    if (isOk(r)) touchedProviders.add(TEST_PROVIDER)
    const states = []
    for (let i = 0; i < 3; i++) {
      const list = await listProviders()
      const p = Array.isArray(list) ? list.find((x) => x.id === TEST_PROVIDER) : null
      states.push(p ? p.hasApiKey : 'missing')
      await sleep(50)
    }
    const allTrue = states.every((s) => s === true)
    record('set 后连续 3 次 listProviders, hasApiKey 始终 true', allTrue, `states=[${states.join(',')}]`)
  })

  await test('set → delete → set 状态正确流转', async () => {
    if (!TEST_PROVIDER) { record('set → delete → set 状态正确流转', false, '无 TEST_PROVIDER'); return }
    await setApiKey(TEST_PROVIDER, TEST_KEY_A)
    let list = await listProviders()
    let p = list.find((x) => x.id === TEST_PROVIDER)
    const afterSet1 = p ? p.hasApiKey : false
    await deleteApiKey(TEST_PROVIDER)
    list = await listProviders()
    p = list.find((x) => x.id === TEST_PROVIDER)
    const afterDelete = p ? p.hasApiKey : false
    await setApiKey(TEST_PROVIDER, TEST_KEY_A)
    if (afterSet1) touchedProviders.add(TEST_PROVIDER)
    list = await listProviders()
    p = list.find((x) => x.id === TEST_PROVIDER)
    const afterSet2 = p ? p.hasApiKey : false
    const ok = afterSet1 === true && afterDelete === false && afterSet2 === true
    record('set → delete → set 状态正确流转', ok, `set1=${afterSet1} delete=${afterDelete} set2=${afterSet2}`)
  })

  await test('多 provider 独立: 删一个不影响另一个', async () => {
    if (!TEST_PROVIDER || !TEST_PROVIDER_2 || TEST_PROVIDER === TEST_PROVIDER_2) {
      record('多 provider 独立: 删一个不影响另一个', false, '需要两个不同未配置 provider')
      return
    }
    await setApiKey(TEST_PROVIDER, TEST_KEY_A)
    await setApiKey(TEST_PROVIDER_2, TEST_KEY_A)
    touchedProviders.add(TEST_PROVIDER); touchedProviders.add(TEST_PROVIDER_2)
    await deleteApiKey(TEST_PROVIDER)
    const list = await listProviders()
    const a = list.find((x) => x.id === TEST_PROVIDER)
    const b = list.find((x) => x.id === TEST_PROVIDER_2)
    const ok = !!a && !!b && a.hasApiKey === false && b.hasApiKey === true
    record('多 provider 独立: 删一个不影响另一个', ok, `${TEST_PROVIDER}=${a?.hasApiKey} ${TEST_PROVIDER_2}=${b?.hasApiKey}`)
  })

  await test('删除后重新 set 同一 provider, key 恢复可见 (hasApiKey true)', async () => {
    if (!TEST_PROVIDER) { record('删除后重新 set 同一 provider, key 恢复可见 (hasApiKey true)', false, '无 TEST_PROVIDER'); return }
    // TEST_PROVIDER 上一轮被删, 现重新设置
    const r = await setApiKey(TEST_PROVIDER, TEST_KEY_A)
    if (isOk(r)) touchedProviders.add(TEST_PROVIDER)
    const list = await listProviders()
    const p = list.find((x) => x.id === TEST_PROVIDER)
    record('删除后重新 set 同一 provider, key 恢复可见 (hasApiKey true)', isOk(r) && !!p && p.hasApiKey === true, `success=${r?.success} hasApiKey=${p?.hasApiKey}`)
  })

  // ========== 9. 清理与还原 ==========
  console.log('\n━━━ 9. 清理与还原 ━━━')
  await test('清理所有测试设置的 key', async () => {
    if (touchedProviders.size === 0) { record('清理所有测试设置的 key', true, '无可清理项'); return }
    const cleanResults = []
    for (const pid of touchedProviders) {
      try { cleanResults.push(await deleteApiKey(pid)) } catch (e) { cleanResults.push({ __error: String(e) }) }
    }
    const allOk = cleanResults.every((r) => isOk(r))
    record('清理所有测试设置的 key', allOk, `cleaned=${touchedProviders.size} allSuccess=${allOk}`)
  })

  await test('最终 hasApiKey 与初始状态一致 (无残留)', async () => {
    await sleep(200) // 等待异步写盘与缓存失效收敛
    const list = await listProviders()
    if (!Array.isArray(list)) { record('最终 hasApiKey 与初始状态一致 (无残留)', false, 'list 失败'); return }
    const mismatches = []
    for (const p of list) {
      const before = initialHasKeyMap.get(p.id)
      if (before !== undefined && before !== p.hasApiKey) {
        mismatches.push(`${p.id}: ${before}→${p.hasApiKey}`)
      }
    }
    // 特别检查被测试的 provider 是否恢复为 false (它们初始均为 false)
    const testLeftover = [TEST_PROVIDER, TEST_PROVIDER_2]
      .filter(Boolean)
      .map((id) => list.find((x) => x.id === id))
      .filter((p) => p && p.hasApiKey === true)
    const ok = mismatches.length === 0 && testLeftover.length === 0
    record('最终 hasApiKey 与初始状态一致 (无残留)', ok,
      ok ? '全部恢复' : `不一致: ${mismatches.join('; ')}; 残留测试 key: ${testLeftover.map((p) => p.id).join(',')}`)
  })

  // ========== 汇总 ==========
  console.log('\n========== Keystore Deep Test ==========')
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
