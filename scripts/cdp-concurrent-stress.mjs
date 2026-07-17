// =============================================================
// CDP 并发压力测试 — 多 IPC 调用竞态检测
// 角度: 同时发起多个 IPC 调用,验证缓存/写文件/SQLite 并发安全
// 运行: node scripts/cdp-concurrent-stress.mjs
// =============================================================
import http from 'node:http'
import WebSocket from 'ws'

const CDP_HOST = 'http://127.0.0.1:9222'

let ws, send, evalInPage
let passCount = 0, failCount = 0, warnCount = 0
const notes = [], bugs = []

function record(name, ok, detail = '') {
  if (ok === true) passCount++
  else if (ok === 'warn') warnCount++
  else failCount++
  const mark = ok === true ? 'PASS' : ok === 'warn' ? 'WARN' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ' — ' + detail : ''}`)
}
const note = (m) => notes.push(m)
const bug = (m) => { bugs.push(m); console.log(`  🐛 ${m}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const httpGet = (u) =>
  new Promise((r, j) => {
    http.get(u, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => { try { r(JSON.parse(d)) } catch (e) { j(e) } })
    }).on('error', j)
  })

async function connect() {
  const targets = (await httpGet(`${CDP_HOST}/json`)).filter((x) => x.type === 'page')
  if (!targets.length) { console.error('❌ 无 CDP target'); process.exit(1) }
  ws = new WebSocket(targets[0].webSocketDebuggerUrl)
  let _id = 1
  const pending = new Map()
  ws.on('message', (r) => {
    const m = JSON.parse(r.toString())
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  send = (method, params = {}) =>
    new Promise((r) => { const i = _id++; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  evalInPage = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) {
      throw new Error((r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'unknown').substring(0, 800))
    }
    return r.result?.result?.value
  }
  await new Promise((r) => ws.on('open', r))
}

// 通用 IPC 调用
async function callNS(ns, method, ...args) {
  const argsLiteral = JSON.stringify(JSON.stringify(args))
  const expr = `(async function(){
    try {
      const api = window.__EAA_API__ || window.api;
      const obj = api && api[${JSON.stringify(ns)}];
      if (!obj || typeof obj[${JSON.stringify(method)}] !== 'function') {
        return JSON.stringify({ __error: 'method not available: ' + ${JSON.stringify(ns)} + '.' + ${JSON.stringify(method)} });
      }
      const args = JSON.parse(${argsLiteral});
      const res = await obj[${JSON.stringify(method)}].apply(obj, args);
      return JSON.stringify({ __ok: true, res });
    } catch (e) { return JSON.stringify({ __error: (e && e.message) ? e.message : String(e) }); }
  })()`
  const raw = await evalInPage(expr)
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { __error: 'non-json: ' + String(raw).slice(0, 200) } }
  if (parsed.__error) return { __error: parsed.__error }
  return parsed.res
}
const callAI = (m, ...a) => callNS('ai', m, ...a)
const callChat = (m, ...a) => callNS('chat', m, ...a)
const callAgent = (m, ...a) => callNS('agent', m, ...a)
const callSettings = (m, ...a) => callNS('settings', m, ...a)
const callEAA = (m, ...a) => callNS('eaa', m, ...a)

const isOk = (r) => !!r && r.__error === undefined && r.success === true
const isErr = (r) => !!r && (r.__error !== undefined || r.success === false)
const errMsg = (r) => r.__error || r.error || r.message || 'unknown error'

// =============================================================
// 1. providersCache 并发读 — 10 个并发 listProviders
// =============================================================
async function testConcurrentListProviders() {
  console.log('\n=== 1. providersCache 并发读 (10 个并发 listProviders) ===')

  const t0 = Date.now()
  const promises = []
  for (let i = 0; i < 10; i++) {
    promises.push(callAI('listProviders'))
  }
  const results = await Promise.all(promises)
  const elapsed = Date.now() - t0

  record('10 个并发 listProviders 全部返回数组',
    results.every(r => Array.isArray(r)),
    `elapsed=${elapsed}ms, lengths=${results.map(r => Array.isArray(r) ? r.length : -1).join(',')}`)

  // 验证所有返回的数组长度一致(缓存命中或并发查询应一致)
  const lengths = results.map(r => Array.isArray(r) ? r.length : -1)
  const allSame = lengths.every(l => l === lengths[0])
  record('所有返回的 provider 数量一致', allSame,
    allSame ? `count=${lengths[0]}` : `不一致: ${lengths.join(',')}`)

  // 验证第一个 provider id 一致(顺序应稳定)
  const firstIds = results.map(r => Array.isArray(r) && r[0]?.id ? r[0].id : null)
  const allSameFirstId = firstIds.every(id => id === firstIds[0])
  record('所有返回的第一个 provider id 一致', allSameFirstId,
    allSameFirstId ? `id=${firstIds[0]}` : `不一致: ${firstIds.join(',')}`)

  note(`并发 10 listProviders 总耗时 ${elapsed}ms,平均 ${Math.round(elapsed/10)}ms/次`)
}

// =============================================================
// 2. listModels 并发读 — 10 个并发到同一 providerId
// =============================================================
async function testConcurrentListModels() {
  console.log('\n=== 2. listModels 并发读 (10 个并发到 google) ===')

  const t0 = Date.now()
  const promises = []
  for (let i = 0; i < 10; i++) {
    promises.push(callAI('listModels', 'google'))
  }
  const results = await Promise.all(promises)
  const elapsed = Date.now() - t0

  record('10 个并发 listModels(google) 全部返回数组',
    results.every(r => Array.isArray(r)),
    `elapsed=${elapsed}ms`)

  const lengths = results.map(r => Array.isArray(r) ? r.length : -1)
  const allSame = lengths.every(l => l === lengths[0])
  record('所有返回的 model 数量一致', allSame,
    allSame ? `count=${lengths[0]}` : `不一致: ${lengths.join(',')}`)

  // 验证模型 id 集合一致(顺序可能不同但集合应相同)
  const idSets = results.map(r => Array.isArray(r) ? new Set(r.map(m => m.id)) : new Set())
  const firstSet = idSets[0]
  const allSameSet = idSets.every(s => s.size === firstSet.size && [...s].every(id => firstSet.has(id)))
  record('所有返回的模型 id 集合一致', allSameSet,
    allSameSet ? `uniqueIds=${firstSet.size}` : '集合不一致')

  note(`并发 10 listModels(google) 总耗时 ${elapsed}ms,平均 ${Math.round(elapsed/10)}ms/次`)
}

// =============================================================
// 3. 自定义模型并发写 — 5 个并发 addCustomModel 到同一 providerId
// =============================================================
async function testConcurrentAddCustomModel() {
  console.log('\n=== 3. 自定义模型并发写 (5 个并发 addCustomModel 到 google) ===')

  const modelIds = []
  for (let i = 0; i < 5; i++) {
    modelIds.push(`__cdp_stress_${Date.now().toString(36)}_${i}__`)
  }

  const t0 = Date.now()
  const promises = modelIds.map((id, i) => callAI('addCustomModel', {
    providerId: 'google',
    modelId: id,
    name: `并发测试_${i}_${id}`,
    contextWindow: 4096 + i * 1024,
    maxOutputTokens: 2048,
  }))
  const results = await Promise.all(promises)
  const elapsed = Date.now() - t0

  record('5 个并发 addCustomModel 全部返回对象',
    results.every(r => r && typeof r === 'object'),
    `elapsed=${elapsed}ms`)

  // 验证所有模型都被持久化
  await sleep(300)
  const list = await callAI('listModels', 'google')
  const foundIds = Array.isArray(list) ? list.map(m => m.id) : []
  const allAdded = modelIds.every(id => foundIds.includes(id))
  record('所有 5 个并发添加的模型都被持久化', allAdded,
    allAdded ? `全部存在` : `缺失: ${modelIds.filter(id => !foundIds.includes(id)).join(',')}`)

  // 清理
  for (const id of modelIds) {
    await callAI('deleteCustomModel', 'google', id)
  }
  await sleep(200)
  const afterClean = await callAI('listModels', 'google')
  const afterCleanIds = Array.isArray(afterClean) ? afterClean.map(m => m.id) : []
  const allCleaned = modelIds.every(id => !afterCleanIds.includes(id))
  record('并发写入的模型全部清理', allCleaned,
    allCleaned ? '已全部删除' : `残留: ${modelIds.filter(id => afterCleanIds.includes(id)).join(',')}`)

  note(`并发 5 addCustomModel 总耗时 ${elapsed}ms`)
}

// =============================================================
// 4. 自定义模型并发更新 — 5 个并发 updateCustomModel 到同一模型
// =============================================================
async function testConcurrentUpdateSameModel() {
  console.log('\n=== 4. 并发更新同一模型 (5 个并发 updateCustomModel) ===')

  const modelId = `__cdp_update_stress_${Date.now().toString(36)}__`
  // 先创建
  await callAI('addCustomModel', {
    providerId: 'google', modelId, name: '初始', contextWindow: 8192,
  })
  await sleep(200)

  // 并发更新不同字段
  const t0 = Date.now()
  const promises = [
    callAI('updateCustomModel', { providerId: 'google', modelId, name: '更新1' }),
    callAI('updateCustomModel', { providerId: 'google', modelId, contextWindow: 16384 }),
    callAI('updateCustomModel', { providerId: 'google', modelId, maxOutputTokens: 4096 }),
    callAI('updateCustomModel', { providerId: 'google', modelId, supportsReasoning: true }),
    callAI('updateCustomModel', { providerId: 'google', modelId, api: 'openai-completions' }),
  ]
  const results = await Promise.all(promises)
  const elapsed = Date.now() - t0

  record('5 个并发 updateCustomModel 全部返回对象',
    results.every(r => r && typeof r === 'object'),
    `elapsed=${elapsed}ms, successes=${results.filter(r => r?.success === true).length}`)

  // 验证模型仍存在(并发更新不应导致丢失)
  await sleep(300)
  const list = await callAI('listModels', 'google')
  const found = Array.isArray(list) ? list.find(m => m.id === modelId) : null
  record('并发更新后模型仍存在', !!found,
    found ? `name=${found.name}, ctx=${found.contextWindow}, maxOut=${found.maxOutputTokens}` : '模型丢失!')

  if (found) {
    // 并发更新可能导致最后一次写入获胜,但至少应有部分字段被更新
    const hasNameUpdate = found.name === '更新1'
    const hasCtxUpdate = found.contextWindow === 16384
    const hasMaxOutUpdate = found.maxOutputTokens === 4096
    const hasReasoningUpdate = found.supportsReasoning === true
    const hasApiUpdate = found.api === 'openai-completions'
    const updatedCount = [hasNameUpdate, hasCtxUpdate, hasMaxOutUpdate, hasReasoningUpdate, hasApiUpdate].filter(Boolean).length
    record('至少部分字段被更新', updatedCount > 0,
      `updated=${updatedCount}/5 (name=${hasNameUpdate}, ctx=${hasCtxUpdate}, maxOut=${hasMaxOutUpdate}, reasoning=${hasReasoningUpdate}, api=${hasApiUpdate})`)
    note(`并发更新结果: 字段更新数=${updatedCount}/5 (注意: 并发写入同一记录可能导致 last-write-wins,但所有字段应至少有一个生效)`)
  }

  // 清理
  await callAI('deleteCustomModel', 'google', modelId)
}

// =============================================================
// 5. SQLite chat 消息并发写 — 20 个并发 saveMessage
// =============================================================
async function testConcurrentChatSave() {
  console.log('\n=== 5. SQLite chat 消息并发写 (20 个并发 saveMessage 到同一 sessionId) ===')

  const sessionId = `stress_${Date.now().toString(36)}`
  const t0 = Date.now()
  const promises = []
  for (let i = 0; i < 20; i++) {
    promises.push(callChat('saveMessage', {
      sessionId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `并发消息 ${i} - ${Date.now()}`,
      timestamp: Date.now() + i,
    }))
  }
  const results = await Promise.all(promises)
  const elapsed = Date.now() - t0

  record('20 个并发 saveMessage 全部返回对象',
    results.every(r => r && typeof r === 'object'),
    `elapsed=${elapsed}ms`)

  // 验证所有消息都被分配了 id (id >= 0 表示成功)
  const successIds = results.filter(r => r?.id >= 0).map(r => r.id)
  record('所有 20 条消息都成功保存 (id >= 0)', successIds.length === 20,
    `successCount=${successIds.length}/20`)

  // 验证 id 唯一(并发插入不应产生重复 id)
  const uniqueIds = new Set(successIds)
  record('所有保存的消息 id 唯一', uniqueIds.size === successIds.length,
    `uniqueIds=${uniqueIds.size}, totalIds=${successIds.length}`)

  // 读取验证
  await sleep(200)
  const loaded = await callChat('loadMessages', sessionId)
  const loadedCount = Array.isArray(loaded?.messages) ? loaded.messages.length : 0
  record('loadMessages 返回的消息数与写入一致', loadedCount === 20,
    `loaded=${loadedCount}/20`)

  // 清理
  await callChat('deleteSession', sessionId)
  note(`并发 20 saveMessage 总耗时 ${elapsed}ms,平均 ${Math.round(elapsed/20)}ms/次`)
}

// =============================================================
// 6. 混合并发 — listModels + addCustomModel + listProviders 同时
// =============================================================
async function testMixedConcurrent() {
  console.log('\n=== 6. 混合并发 (listModels + addCustomModel + listProviders) ===')

  const testModelId = `__cdp_mixed_${Date.now().toString(36)}__`

  const t0 = Date.now()
  const promises = [
    callAI('listProviders'),
    callAI('listModels', 'google'),
    callAI('listModels', 'google'),
    callAI('addCustomModel', {
      providerId: 'google', modelId: testModelId, name: '混合测试', contextWindow: 8192,
    }),
    callAI('listProviders'),
    callAI('listModels', 'google'),
    callAI('listModels', 'openai'),
    callAI('listProviders'),
  ]
  const results = await Promise.all(promises)
  const elapsed = Date.now() - t0

  record('8 个混合并发 IPC 全部返回对象',
    results.every(r => r && typeof r === 'object' || Array.isArray(r)),
    `elapsed=${elapsed}ms`)

  // 验证 addCustomModel 后 listModels 能看到新模型(最终一致性)
  await sleep(300)
  const finalList = await callAI('listModels', 'google')
  const found = Array.isArray(finalList) ? finalList.find(m => m.id === testModelId) : null
  record('混合并发后新添加的模型可见', !!found,
    found ? `name=${found.name}` : '未找到')

  // 清理
  await callAI('deleteCustomModel', 'google', testModelId)
  note(`混合并发 8 IPCs 总耗时 ${elapsed}ms`)
}

// =============================================================
// 7. 高频 IPC 调用 — 50 次连续 listProviders
// =============================================================
async function testHighFrequencyCalls() {
  console.log('\n=== 7. 高频 IPC 调用 (50 次连续 listProviders) ===')

  const latencies = []
  let errorCount = 0
  for (let i = 0; i < 50; i++) {
    const t0 = Date.now()
    try {
      const r = await callAI('listProviders')
      if (!Array.isArray(r)) errorCount++
    } catch {
      errorCount++
    }
    latencies.push(Date.now() - t0)
  }

  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length
  const max = Math.max(...latencies)
  const min = Math.min(...latencies)
  const p95 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)]

  record('50 次连续 listProviders 全部成功', errorCount === 0,
    `errors=${errorCount}`)

  record('平均延迟 < 200ms', avg < 200,
    `avg=${avg.toFixed(1)}ms, min=${min}ms, max=${max}ms, p95=${p95}ms`)

  record('最大延迟 < 2000ms (无超长卡顿)', max < 2000,
    `max=${max}ms`)

  note(`50 次 listProviders: avg=${avg.toFixed(1)}ms, p95=${p95}ms, max=${max}ms`)
}

// =============================================================
// 8. EAA 数据读取并发 — 5 个并发 stats + 5 个并发 listStudents
// =============================================================
async function testEAAConcurrentRead() {
  console.log('\n=== 8. EAA 数据读取并发 (5 stats + 5 listStudents) ===')

  const t0 = Date.now()
  const promises = [
    ...Array(5).fill(0).map(() => callEAA('stats')),
    ...Array(5).fill(0).map(() => callEAA('listStudents')),
  ]
  const results = await Promise.all(promises)
  const elapsed = Date.now() - t0

  record('10 个并发 EAA 读取全部返回对象',
    results.every(r => r && typeof r === 'object'),
    `elapsed=${elapsed}ms`)

  // 验证 stats 结果一致
  const statsResults = results.slice(0, 5)
  const allStatsConsistent = statsResults.every(r => JSON.stringify(r) === JSON.stringify(statsResults[0]))
  record('5 个并发 stats 结果一致', allStatsConsistent,
    allStatsConsistent ? '一致' : '不一致(可能读缓存 vs 实时)')

  // 验证 listStudents 结果一致 (返回 {success, data: {students: [...]}} 对象)
  const listResults = results.slice(5)
  // 检查每个返回都是对象且含 data.students 数组
  const allHaveStudents = listResults.every(r => r && typeof r === 'object' && r.data && Array.isArray(r.data.students))
  record('5 个并发 listStudents 都返回 {success, data:{students:[]}}',
    allHaveStudents,
    allHaveStudents ? '结构正确' : `结构异常: ${listResults.map(r => r ? Object.keys(r).join(',') : 'null').join(' | ')}`)

  // 比较学生数量
  const lengths = listResults.map(r => r?.data?.students?.length ?? -1)
  const allListConsistent = lengths.every(l => l === lengths[0])
  record('5 个并发 listStudents 学生数量一致', allListConsistent,
    allListConsistent ? `count=${lengths[0]}` : `不一致: ${lengths.join(',')}`)

  note(`10 并发 EAA 读取总耗时 ${elapsed}ms`)
}

// =============================================================
// 9. Agent list 并发 — 10 个并发 agent.list
// =============================================================
async function testAgentListConcurrent() {
  console.log('\n=== 9. Agent list 并发 (10 个并发 agent.list) ===')

  const t0 = Date.now()
  const promises = []
  for (let i = 0; i < 10; i++) {
    promises.push(callAgent('list'))
  }
  const results = await Promise.all(promises)
  const elapsed = Date.now() - t0

  record('10 个并发 agent.list 全部返回数组',
    results.every(r => Array.isArray(r)),
    `elapsed=${elapsed}ms`)

  const lengths = results.map(r => Array.isArray(r) ? r.length : -1)
  const allSame = lengths.every(l => l === lengths[0])
  record('所有返回的 agent 数量一致', allSame,
    allSame ? `count=${lengths[0]}` : `不一致: ${lengths.join(',')}`)

  note(`并发 10 agent.list 总耗时 ${elapsed}ms`)
}

// =============================================================
// 10. 并发后的应用状态一致性
// =============================================================
async function testStateConsistency() {
  console.log('\n=== 10. 并发后应用状态一致性 ===')

  // 验证 window.api 仍可用
  const apiOk = await evalInPage(`(function(){
    const api = window.__EAA_API__ || window.api;
    return !!(api && api.ai && typeof api.ai.listProviders === 'function');
  })()`)
  record('并发测试后 window.api 仍可用', apiOk, '')

  // 验证应用未崩溃
  const notCrashed = await evalInPage(`(function(){
    const root = document.getElementById('root');
    return !!(root && root.children.length > 0);
  })()`)
  record('并发测试后应用未崩溃(root 仍有内容)', notCrashed, '')

  // 验证仍能正常调用 IPC
  const finalCheck = await callAI('listProviders')
  record('并发测试后 listProviders 仍可调用', Array.isArray(finalCheck),
    Array.isArray(finalCheck) ? `count=${finalCheck.length}` : `type=${typeof finalCheck}`)

  // 验证无未捕获的 promise rejection
  const unhandledRejections = await evalInPage(`(function(){
    if (!window.__unhandledRejections) {
      window.__unhandledRejections = [];
      window.addEventListener('unhandledrejection', e => {
        window.__unhandledRejections.push(e.reason?.message || String(e.reason));
      });
    }
    return window.__unhandledRejections.length;
  })()`)
  record('无未捕获的 promise rejection', unhandledRejections === 0,
    unhandledRejections > 0 ? `count=${unhandledRejections}` : '0')
}

// =============================================================
// 11. 极端并发 — 30 个混合 IPC 同时
// =============================================================
async function testExtremeConcurrent() {
  console.log('\n=== 11. 极端并发 (30 个混合 IPC 同时) ===')

  const t0 = Date.now()
  const promises = []
  for (let i = 0; i < 30; i++) {
    switch (i % 5) {
      case 0: promises.push(callAI('listProviders')); break
      case 1: promises.push(callAI('listModels', 'google')); break
      case 2: promises.push(callAgent('list')); break
      case 3: promises.push(callSettings('get')); break
      case 4: promises.push(callEAA('stats')); break
    }
  }
  const results = await Promise.all(promises)
  const elapsed = Date.now() - t0

  const successCount = results.filter(r => r !== null && r !== undefined && !r.__error).length
  record('30 个极端并发 IPC 全部成功', successCount === 30,
    `success=${successCount}/30, elapsed=${elapsed}ms`)

  // 验证响应时间合理
  record('30 个极端并发总耗时 < 10s', elapsed < 10000,
    `elapsed=${elapsed}ms`)

  note(`30 极端并发: success=${successCount}/30, elapsed=${elapsed}ms, avg=${Math.round(elapsed/30)}ms/次`)
}

// =============================================================
// 12. 内存泄漏粗检 — 大量 IPC 后内存增长
// =============================================================
async function testMemoryLeak() {
  console.log('\n=== 12. 内存泄漏粗检 ===')

  // 记录初始内存
  const memBefore = await evalInPage(`(function(){
    if (performance.memory) {
      return {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
      };
    }
    return null;
  })()`)

  if (!memBefore) {
    record('performance.memory 不可用 (非 Chromium)', 'warn', '跳过内存检查')
    return
  }

  // 发起 200 次 IPC 调用
  for (let i = 0; i < 200; i++) {
    await callAI('listProviders')
  }

  // 等待 GC
  await sleep(1000)

  const memAfter = await evalInPage(`(function(){
    if (performance.memory) {
      return {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
      };
    }
    return null;
  })()`)

  const deltaKB = (memAfter.usedJSHeapSize - memBefore.usedJSHeapSize) / 1024
  record('200 次 IPC 后堆内存增长 < 5MB', deltaKB < 5 * 1024,
    `before=${(memBefore.usedJSHeapSize/1024/1024).toFixed(2)}MB, after=${(memAfter.usedJSHeapSize/1024/1024).toFixed(2)}MB, delta=${deltaKB.toFixed(0)}KB`)

  note(`内存: before=${(memBefore.usedJSHeapSize/1024/1024).toFixed(2)}MB, after=${(memAfter.usedJSHeapSize/1024/1024).toFixed(2)}MB, delta=${deltaKB.toFixed(0)}KB`)
}

// =============================================================
// 主函数
// =============================================================
async function main() {
  console.log('=====================================')
  console.log('并发压力测试 — 多 IPC 调用竞态检测')
  console.log('=====================================')

  await connect()
  console.log('✅ CDP 连接成功')

  // 导航到 dashboard
  await evalInPage(`window.location.hash = '#/dashboard'`)
  await sleep(1000)

  await testConcurrentListProviders()
  await testConcurrentListModels()
  await testConcurrentAddCustomModel()
  await testConcurrentUpdateSameModel()
  await testConcurrentChatSave()
  await testMixedConcurrent()
  await testHighFrequencyCalls()
  await testEAAConcurrentRead()
  await testAgentListConcurrent()
  await testStateConsistency()
  await testExtremeConcurrent()
  await testMemoryLeak()

  // 汇总
  console.log('\n=====================================')
  console.log('测试汇总')
  console.log('=====================================')
  const total = passCount + failCount + warnCount
  console.log(`总计: ${total}, 通过: ${passCount}, 警告: ${warnCount}, 失败: ${failCount}, BUG: ${bugs.length}`)
  if (bugs.length > 0) {
    console.log('\n🐛 发现的 BUG:')
    bugs.forEach((b, i) => console.log(`  ${i + 1}. ${b}`))
  }
  if (notes.length > 0) {
    console.log('\n备注:')
    notes.forEach((n) => console.log(`  - ${n}`))
  }

  process.exit(failCount > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('未捕获异常:', e)
  process.exit(2)
})
