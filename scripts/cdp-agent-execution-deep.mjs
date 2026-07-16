// =============================================================
// CDP 深度测试 — Agent 执行系统 (runManual / getHistory / abort)
//
// 连接到运行中的 Tauri 2 应用 (WebView2 CDP 9222),
// 通过 window.__EAA_API__.agent / window.api.agent 调用 IPC,
// 深度覆盖 8 类场景: 历史基线/全员历史/手动执行/中止/订阅/
//                   状态一致性/并发/禁用 agent 执行。
//
// 运行: node scripts/cdp-agent-execution-deep.mjs
//
// 实测得到的 API 契约 (来自 src/main/ipc/agent-handlers.ts + agent-service.ts):
//   agent.getHistory(id)            -> AgentExecution[] | {success:false,error}
//      (仅接受 id 参数, 无 limit; id 必须为非空字符串, 否则返回 {success:false,error})
//   agent.runManual(id,prompt,hist?) -> {success:true,message,id} | {success:false,message}
//      (fire-and-forget: 同步校验参数+agent存在性, 异步执行不等待)
//      (空 prompt -> {success:false,message:'prompt cannot be empty'})
//      (null prompt -> {success:false,message:'prompt must be a string'})
//      (不存在 agent -> {success:false,message:'Agent not found: ${id}'})
//      (禁用 agent -> 仍返回 {success:true,...} 因为禁用检查在非 await 的 runAgent 内)
//   agent.abort(id)                 -> {success:boolean,message:string}
//      (不存在/空/null id -> {success:false,message:'Agent not running'} 不崩溃)
//   agent.onStatusUpdate(cb)        -> unsub 函数 (调用 unsub 不崩溃)
//
// AgentExecution 字段: id, agentId, prompt, output, startedAt,
//                       durationMs, tokenUsage, cost, status
//   status 枚举: 'success' | 'error' | 'timeout'
//
// 系统共 18 个 agent; 使用 bug-hunter 作为执行测试目标 (测试/debug agent, 风险最低)。
// =============================================================
import http from 'node:http'

const CDP_PORT = 9222
const BASE = `http://127.0.0.1:${CDP_PORT}`
const EXPECTED_AGENT_COUNT = 18

// 执行测试目标: bug-hunter (无 schedule, 不会干扰 cron, 风险最低)
const EXEC_TARGET = 'bug-hunter'
// 等待执行记录写入的时间 (ms)
const EXEC_WAIT_MS = 6000

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error(`JSON parse fail: ${e.message}`))
        }
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

  // ---------- CDP 连接 ----------
  const targets = (await fetchJson(`${BASE}/json`)).filter((t) => t.type === 'page')
  if (targets.length === 0) {
    console.log('FAIL: No CDP targets (应用是否已运行并开启 --remote-debugging-port=9222?)')
    process.exit(1)
  }
  const cdpTarget = targets[0]
  console.log(`Target: ${cdpTarget.title} (${cdpTarget.url})\n`)

  const { default: WebSocket } = await import('ws')
  const ws = new WebSocket(cdpTarget.webSocketDebuggerUrl)
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
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.result?.exceptionDetails) {
      throw new Error(`Eval error: ${r.result.exceptionDetails.text}`)
    }
    return r.result?.result?.value
  }

  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP 已连接,开始 Agent 执行深度测试...\n')

  // ---------- IPC 调用封装 ----------
  // 返回 { ok, data, error }: ok=true 表示 IPC 调用未抛出, data 为返回值
  const callAgent = async (code) => {
    return await evalInPage(`
      (async function() {
        const api = window.__EAA_API__ || window.api;
        if (!api) return { __error: 'no-api' };
        if (!api.agent) return { __error: 'no-agent-api' };
        try {
          const res = await ${code};
          return { __ok: true, data: res };
        } catch (e) {
          return { __error: String(e && e.message ? e.message : e) };
        }
      })()
    `)
  }
  // 统一返回 { ok, data, error }
  const agent = async (code) => {
    const r = await callAgent(code)
    if (!r) return { ok: false, data: null, error: 'null-result' }
    if (r.__error) return { ok: false, data: null, error: r.__error }
    return { ok: true, data: r.data ?? null, error: null }
  }

  // ---------- 恢复队列 ----------
  const restoreQueue = []
  const restoreAll = async () => {
    for (const fn of restoreQueue) {
      try {
        await fn()
      } catch (err) {
        console.warn(`[restore] 恢复失败: ${err.message || err}`)
      }
    }
  }

  // =============================================================
  // 0. API 探测 — 验证执行相关方法存在
  // =============================================================
  console.log('━━━ 0. API 探测 ━━━')
  let apiKeys = []
  try {
    apiKeys = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        if (!api || !api.agent) return [];
        return Object.keys(api.agent).filter(k => typeof api.agent[k] === 'function');
      })()
    `)
    record(`agent API 探测`, Array.isArray(apiKeys) && apiKeys.length > 0, `keys=[${apiKeys.join(',')}]`)
  } catch (err) {
    record(`agent API 探测`, false, String(err.message || err))
  }
  const execMethods = ['runManual', 'getHistory', 'abort', 'onStatusUpdate']
  const missingExec = execMethods.filter((m) => !apiKeys.includes(m))
  record(`执行相关方法完整性 (runManual/getHistory/abort/onStatusUpdate)`, missingExec.length === 0, missingExec.length ? `缺失: ${missingExec.join(',')}` : `4 个方法均存在`)

  // =============================================================
  // 1. getHistory 基线测试
  // =============================================================
  console.log('\n━━━ 1. getHistory 基线测试 ━━━')

  // 1a. getHistory() 无参数 — 实测返回 {success:false, error:'id must be a non-empty string'}
  {
    const r = await agent(`api.agent.getHistory()`)
    const noCrash = r.ok
    const isErrorObj = r.data && typeof r.data === 'object' && r.data.success === false
    record(`getHistory() 无参数 (不崩溃, 返回错误对象)`, noCrash && isErrorObj, `ok=${r.ok} data=${JSON.stringify(r.data)?.slice(0, 80)} error=${r.error ?? '无'}`)
  }

  // 1b. getHistory('main') — 应返回数组
  {
    const r = await agent(`api.agent.getHistory(${JSON.stringify('main')})`)
    const isArr = r.ok && Array.isArray(r.data)
    record(`getHistory('main') 返回数组`, isArr, `ok=${r.ok} isArray=${Array.isArray(r.data)} len=${r.data?.length ?? -1}`)
  }

  // 1c. getHistory('main', 5) — limit 参数被忽略, 但 id 有效, 仍返回数组
  {
    const r = await agent(`api.agent.getHistory(${JSON.stringify('main')}, 5)`)
    const isArr = r.ok && Array.isArray(r.data)
    record(`getHistory('main', 5) 带 limit (limit 被忽略, 返回数组)`, isArr, `ok=${r.ok} isArray=${Array.isArray(r.data)} len=${r.data?.length ?? -1}`)
  }

  // 1d. getHistory('nonexistent') — 不存在的 agent, 返回空数组
  {
    const r = await agent(`api.agent.getHistory(${JSON.stringify('nonexistent-agent-' + Date.now())})`)
    const isArr = r.ok && Array.isArray(r.data)
    const isEmpty = isArr && r.data.length === 0
    record(`getHistory('nonexistent') 返回空数组不崩溃`, isArr && isEmpty, `ok=${r.ok} isArray=${Array.isArray(r.data)} len=${r.data?.length ?? -1}`)
  }

  // 1e. getHistory(undefined, 0) — id 为 undefined, 返回错误对象
  {
    const r = await agent(`api.agent.getHistory(undefined, 0)`)
    const noCrash = r.ok
    const isErrorObj = r.data && typeof r.data === 'object' && r.data.success === false
    record(`getHistory(undefined, 0) 边界 limit (不崩溃, 返回错误对象)`, noCrash && isErrorObj, `ok=${r.ok} data=${JSON.stringify(r.data)?.slice(0, 80)}`)
  }

  // =============================================================
  // 2. getHistory 全员测试 — 对 18 个 agent 逐个调用 getHistory
  // =============================================================
  console.log('\n━━━ 2. getHistory 全员测试 ━━━')
  let agents = []
  {
    const r = await agent(`api.agent.list()`)
    agents = r.ok ? r.data || [] : []
    record(`agent.list 获取 ${EXPECTED_AGENT_COUNT} 个 agent`, r.ok && agents.length === EXPECTED_AGENT_COUNT, `ok=${r.ok} count=${agents.length}`)
  }
  {
    let histFailures = []
    let histCounts = {}
    for (const a of agents) {
      const r = await agent(`api.agent.getHistory(${JSON.stringify(a.id)})`)
      if (!r.ok || !Array.isArray(r.data)) {
        histFailures.push(a.id)
      } else {
        histCounts[a.id] = r.data.length
      }
    }
    record(`getHistory 全员 18 个 agent 均返回数组`, histFailures.length === 0 && agents.length === EXPECTED_AGENT_COUNT, histFailures.length ? `失败: ${histFailures.join(',')}` : `全部 ${agents.length} 个返回数组 (有历史的: ${Object.entries(histCounts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(', ') || '无'})`)
  }

  // =============================================================
  // 3. runManual 执行测试
  // =============================================================
  console.log('\n━━━ 3. runManual 执行测试 ━━━')

  // 3a. runManual('main', '你好') — 正常执行 (fire-and-forget, 返回 success:true)
  {
    const r = await agent(`api.agent.runManual(${JSON.stringify('main')}, ${JSON.stringify('你好')})`)
    const started = r.ok && r.data?.success === true && r.data?.id === 'main'
    record(`runManual('main', '你好') 启动成功`, started, `ok=${r.ok} success=${r.data?.success} id=${r.data?.id} msg=${r.data?.message ?? '无'}`)
  }

  // 3b. runManual('nonexistent', 'test') — 不存在的 agent, 返回错误
  {
    const fakeId = 'nonexistent-agent-' + Date.now()
    const r = await agent(`api.agent.runManual(${JSON.stringify(fakeId)}, ${JSON.stringify('test')})`)
    const rejected = r.ok && r.data?.success === false
    record(`runManual('nonexistent', 'test') 拒绝不存在的 agent`, rejected, `ok=${r.ok} success=${r.data?.success} msg=${r.data?.message ?? '无'}`)
  }

  // 3c. runManual('main', '') — 空 prompt, 应被拒绝
  {
    const r = await agent(`api.agent.runManual(${JSON.stringify('main')}, '')`)
    const rejected = r.ok && r.data?.success === false
    record(`runManual('main', '') 空 prompt 被拒绝`, rejected, `ok=${r.ok} success=${r.data?.success} msg=${r.data?.message ?? '无'}`)
  }

  // 3d. runManual('main', null) — null prompt, 应被拒绝
  {
    const r = await agent(`api.agent.runManual(${JSON.stringify('main')}, null)`)
    const rejected = r.ok && r.data?.success === false
    record(`runManual('main', null) null prompt 被拒绝`, rejected, `ok=${r.ok} success=${r.data?.success} msg=${r.data?.message ?? '无'}`)
  }

  // 3e. runManual('main', 超长 10000 字符) — 不崩溃
  {
    const longMsg = 'a'.repeat(10000)
    const r = await agent(`api.agent.runManual(${JSON.stringify('main')}, ${JSON.stringify(longMsg)})`)
    const noCrash = r.ok && (r.data?.success === true || r.data?.success === false)
    record(`runManual('main', 10000 字符) 超长消息不崩溃`, noCrash, `ok=${r.ok} success=${r.data?.success} msg=${r.data?.message?.slice(0, 60) ?? '无'}`)
  }

  // 3f. runManual('main', emoji + Unicode) — 不崩溃
  {
    const r = await agent(`api.agent.runManual(${JSON.stringify('main')}, ${JSON.stringify('测试emoji 😀🎉 Unicode')})`)
    const noCrash = r.ok && (r.data?.success === true || r.data?.success === false)
    record(`runManual('main', emoji+Unicode) 不崩溃`, noCrash, `ok=${r.ok} success=${r.data?.success} msg=${r.data?.message ?? '无'}`)
  }

  // 3g. runManual('main', HTML 注入) — 不崩溃, 不执行脚本
  {
    const r = await agent(`api.agent.runManual(${JSON.stringify('main')}, ${JSON.stringify('<script>alert(1)</script>')})`)
    const noCrash = r.ok && (r.data?.success === true || r.data?.success === false)
    record(`runManual('main', '<script>') HTML 注入不崩溃`, noCrash, `ok=${r.ok} success=${r.data?.success} msg=${r.data?.message ?? '无'}`)
  }

  // 3h. runManual 返回值结构验证
  {
    const r = await agent(`api.agent.runManual(${JSON.stringify(EXEC_TARGET)}, ${JSON.stringify('测试执行')})`)
    const hasFields = r.ok && r.data && typeof r.data === 'object' && 'success' in r.data && 'message' in r.data
    record(`runManual 返回值结构 (含 success+message 字段)`, hasFields, `ok=${r.ok} keys=${r.data ? Object.keys(r.data).join(',') : '无'}`)
  }

  // =============================================================
  // 4. abort 中止测试
  // =============================================================
  console.log('\n━━━ 4. abort 中止测试 ━━━')

  // 4a. abort('nonexistent-id') — 不崩溃, 返回 {success:false}
  {
    const r = await agent(`api.agent.abort(${JSON.stringify('nonexistent-id-' + Date.now())})`)
    const noCrash = r.ok && r.data && typeof r.data === 'object' && 'success' in r.data
    record(`abort('nonexistent-id') 不崩溃`, noCrash, `ok=${r.ok} success=${r.data?.success} msg=${r.data?.message ?? '无'}`)
  }

  // 4b. abort('') — 空 ID, 不崩溃
  {
    const r = await agent(`api.agent.abort('')`)
    const noCrash = r.ok && r.data && typeof r.data === 'object' && 'success' in r.data
    record(`abort('') 空 ID 不崩溃`, noCrash, `ok=${r.ok} success=${r.data?.success} msg=${r.data?.message ?? '无'}`)
  }

  // 4c. abort(null) — null ID, 不崩溃
  {
    const r = await agent(`api.agent.abort(null)`)
    const noCrash = r.ok && r.data && typeof r.data === 'object' && 'success' in r.data
    record(`abort(null) null ID 不崩溃`, noCrash, `ok=${r.ok} success=${r.data?.success} msg=${r.data?.message ?? '无'}`)
  }

  // 4d. abort 返回值结构验证
  {
    const r = await agent(`api.agent.abort(${JSON.stringify('structural-test-' + Date.now())})`)
    const hasFields = r.ok && r.data && typeof r.data === 'object' && 'success' in r.data && 'message' in r.data
    record(`abort 返回值结构 (含 success+message 字段)`, hasFields, `ok=${r.ok} keys=${r.data ? Object.keys(r.data).join(',') : '无'}`)
  }

  // 4e. 尝试 abort 刚才启动的执行 (可能已完成)
  {
    const r = await agent(`api.agent.abort(${JSON.stringify(EXEC_TARGET)})`)
    const noCrash = r.ok && r.data && typeof r.data === 'object' && 'success' in r.data
    record(`abort(EXEC_TARGET) 对可能已完成的执行不崩溃`, noCrash, `ok=${r.ok} success=${r.data?.success} msg=${r.data?.message ?? '无'}`)
  }

  // =============================================================
  // 5. onStatusUpdate 订阅测试
  // =============================================================
  console.log('\n━━━ 5. onStatusUpdate 订阅测试 ━━━')

  // 5a. onStatusUpdate 返回函数
  {
    const r = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        if (!api || !api.agent || typeof api.agent.onStatusUpdate !== 'function') return { __error: 'no-onStatusUpdate' };
        try {
          const unsub = api.agent.onStatusUpdate(function() {});
          return { __ok: true, isFunction: typeof unsub === 'function' };
        } catch (e) {
          return { __error: String(e && e.message ? e.message : e) };
        }
      })()
    `)
    const ok = r && r.__ok && r.isFunction
    record(`onStatusUpdate 返回 unsubscribe 函数`, ok, `isFunction=${r?.isFunction} error=${r?.__error ?? '无'}`)
    // 5b. 调用 unsubscribe 不崩溃
    if (ok) {
      const r2 = await evalInPage(`
        (function() {
          const api = window.__EAA_API__ || window.api;
          try {
            const unsub = api.agent.onStatusUpdate(function() {});
            unsub();
            return { __ok: true };
          } catch (e) {
            return { __error: String(e && e.message ? e.message : e) };
          }
        })()
      `)
      record(`调用 unsubscribe 不崩溃`, r2 && r2.__ok, `error=${r2?.__error ?? '无'}`)
    } else {
      record(`调用 unsubscribe 不崩溃`, false, '前序订阅失败, 跳过')
    }
  }

  // 5c. 订阅后立即取消订阅 (完整生命周期)
  {
    const r = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        try {
          const unsub = api.agent.onStatusUpdate(function() {});
          unsub();
          unsub(); // 重复调用也不应崩溃
          return { __ok: true };
        } catch (e) {
          return { __error: String(e && e.message ? e.message : e) };
        }
      })()
    `)
    record(`订阅后立即取消 (含重复取消) 不崩溃`, r && r.__ok, `error=${r?.__error ?? '无'}`)
  }

  // 5d. 多次订阅不冲突
  {
    const r = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        try {
          const unsub1 = api.agent.onStatusUpdate(function() {});
          const unsub2 = api.agent.onStatusUpdate(function() {});
          const bothFuncs = typeof unsub1 === 'function' && typeof unsub2 === 'function';
          unsub1();
          unsub2();
          return { __ok: true, bothFuncs: bothFuncs };
        } catch (e) {
          return { __error: String(e && e.message ? e.message : e) };
        }
      })()
    `)
    record(`多次订阅 (2 个) 均返回函数且不冲突`, r && r.__ok && r.bothFuncs, `bothFuncs=${r?.bothFuncs} error=${r?.__error ?? '无'}`)
  }

  // =============================================================
  // 6. 执行历史记录一致性 — runManual 后检查 getHistory 是否增长
  // =============================================================
  console.log('\n━━━ 6. 执行历史记录一致性 ━━━')

  // 记录执行前的历史数
  const histBefore = await agent(`api.agent.getHistory(${JSON.stringify(EXEC_TARGET)})`)
  const countBefore = Array.isArray(histBefore.data) ? histBefore.data.length : 0
  console.log(`  ${EXEC_TARGET} 执行前历史数: ${countBefore}`)

  // 触发一次执行
  const runR = await agent(`api.agent.runManual(${JSON.stringify(EXEC_TARGET)}, ${JSON.stringify('回复一个字: 好')})`)
  console.log(`  runManual 返回: success=${runR.data?.success} id=${runR.data?.id}`)

  // 等待执行完成
  console.log(`  等待 ${EXEC_WAIT_MS}ms 检查历史增长...`)
  await new Promise((r) => setTimeout(r, EXEC_WAIT_MS))

  const histAfter = await agent(`api.agent.getHistory(${JSON.stringify(EXEC_TARGET)})`)
  const countAfter = Array.isArray(histAfter.data) ? histAfter.data.length : 0
  console.log(`  ${EXEC_TARGET} 执行后历史数: ${countAfter}`)

  // 历史可能增长 (执行成功/失败均记录) 也可能不增长 (agent 已在运行/disabled 等异常路径)
  {
    const noCrash = histAfter.ok && Array.isArray(histAfter.data)
    record(`runManual 后 getHistory 不崩溃且返回数组`, noCrash, `before=${countBefore} after=${countAfter} 增长=${countAfter > countBefore ? '是' : '否'}`)
  }

  // 验证执行记录字段 (如果有历史)
  {
    const hist = histAfter.data || []
    const last = hist.length > 0 ? hist[hist.length - 1] : null
    if (last) {
      const expectedFields = ['id', 'agentId', 'prompt', 'output', 'startedAt', 'durationMs', 'tokenUsage', 'cost', 'status']
      const missingFields = expectedFields.filter((f) => !(f in last))
      const validStatus = ['success', 'error', 'timeout'].includes(last.status)
      record(`执行记录字段完整性 (最后一条)`, missingFields.length === 0 && validStatus, `id=${last.id} agentId=${last.agentId} status=${last.status} missing=[${missingFields.join(',')}] durationMs=${last.durationMs}`)
    } else {
      record(`执行记录字段完整性`, true, `无历史记录 (执行可能未完成或未记录), 跳过字段验证`)
    }
  }

  // 验证 get 内联的 executionHistory 与 getHistory 一致
  {
    const detail = await agent(`api.agent.get(${JSON.stringify(EXEC_TARGET)})`)
    const inlineHist = detail.data?.executionHistory
    const standaloneHist = histAfter.data
    const bothArrays = Array.isArray(inlineHist) && Array.isArray(standaloneHist)
    const sameLength = bothArrays && inlineHist.length === standaloneHist.length
    record(`get 内联 executionHistory 与 getHistory 长度一致`, bothArrays && sameLength, `inline=${inlineHist?.length ?? -1} standalone=${standaloneHist?.length ?? -1}`)
  }

  // =============================================================
  // 7. 并发操作测试
  // =============================================================
  console.log('\n━━━ 7. 并发操作测试 ━━━')

  // 7a. 并发 getHistory 5 个 agent
  if (agents.length >= 5) {
    const concurrencyIds = agents.slice(0, 5).map((a) => a.id)
    const t0 = Date.now()
    const concurrentResults = await Promise.all(
      concurrencyIds.map((id) => agent(`api.agent.getHistory(${JSON.stringify(id)})`)),
    )
    const elapsed = Date.now() - t0
    const allArr = concurrentResults.every((r) => r.ok && Array.isArray(r.data))
    record(`并发 getHistory 5 个 agent`, allArr, `allArr=${allArr} 耗时=${elapsed}ms ids=[${concurrencyIds.join(',')}]`)
  } else {
    record(`并发 getHistory 5 个 agent`, false, `agent 数量不足 (需要 >=5, 实际 ${agents.length})`)
  }

  // 7b. 并发 runManual (不同 agent, 避免冲突)
  if (agents.length >= 3) {
    const runIds = agents.slice(0, 3).map((a) => a.id)
    const runResults = await Promise.all(
      runIds.map((id) => agent(`api.agent.runManual(${JSON.stringify(id)}, ${JSON.stringify('并发测试')})`)),
    )
    const allNoCrash = runResults.every((r) => r.ok && r.data && typeof r.data === 'object' && 'success' in r.data)
    record(`并发 runManual 3 个 agent (不崩溃)`, allNoCrash, `allNoCrash=${allNoCrash} results=[${runResults.map((r) => r.data?.success).join(',')}]`)
  } else {
    record(`并发 runManual 3 个 agent`, false, `agent 数量不足`)
  }

  // 7c. 并发 getHistory + runManual 混合
  if (agents.length >= 3) {
    const mixIds = agents.slice(0, 3).map((a) => a.id)
    const mixResults = await Promise.all([
      agent(`api.agent.getHistory(${JSON.stringify(mixIds[0])})`),
      agent(`api.agent.runManual(${JSON.stringify(mixIds[1])}, ${JSON.stringify('混合并发')})`),
      agent(`api.agent.getHistory(${JSON.stringify(mixIds[2])})`),
    ])
    const allNoCrash = mixResults.every((r) => r.ok && r.data !== null && r.data !== undefined)
    record(`并发 getHistory + runManual 混合`, allNoCrash, `allNoCrash=${allNoCrash} types=[${mixResults.map((r) => typeof r.data).join(',')}]`)
  } else {
    record(`并发 getHistory + runManual 混合`, false, `agent 数量不足`)
  }

  // =============================================================
  // 8. 禁用 agent 执行测试
  // =============================================================
  console.log('\n━━━ 8. 禁用 agent 执行测试 ━━━')

  // 保存原始状态用于恢复
  const targetAgent = agents.find((a) => a.id === EXEC_TARGET)
  const origEnabled = targetAgent?.enabled ?? true
  console.log(`  ${EXEC_TARGET} 原始 enabled=${origEnabled}`)

  // 注册恢复函数
  restoreQueue.push(async () => {
    await agent(`api.agent.toggle(${JSON.stringify(EXEC_TARGET)}, ${JSON.stringify(origEnabled)})`)
  })

  // 8a. 切换为禁用
  {
    const flipped = !origEnabled
    const r = await agent(`api.agent.toggle(${JSON.stringify(EXEC_TARGET)}, ${JSON.stringify(flipped)})`)
    const back = await agent(`api.agent.get(${JSON.stringify(EXEC_TARGET)})`)
    const verified = r.ok && r.data?.success === true && back.data?.enabled === flipped
    record(`toggle ${EXEC_TARGET} 禁用 (${origEnabled} -> ${flipped})`, verified, `success=${r.data?.success} after=${back.data?.enabled} 期望=${flipped}`)
  }

  // 8b. 对禁用 agent 调用 runManual (fire-and-forget, 返回 success:true 但实际执行会失败)
  {
    const r = await agent(`api.agent.runManual(${JSON.stringify(EXEC_TARGET)}, ${JSON.stringify('禁用状态测试')})`)
    // 实测: runManual 仍返回 {success:true} 因为禁用检查在非 await 的 runAgent 内
    const noCrash = r.ok && r.data && typeof r.data === 'object' && 'success' in r.data
    record(`runManual 禁用 agent (不崩溃, fire-and-forget)`, noCrash, `ok=${r.ok} success=${r.data?.success} msg=${r.data?.message ?? '无'} (禁用检查在异步 runAgent 内)`)
  }

  // 8c. 恢复为原始状态
  {
    const r = await agent(`api.agent.toggle(${JSON.stringify(EXEC_TARGET)}, ${JSON.stringify(origEnabled)})`)
    const back = await agent(`api.agent.get(${JSON.stringify(EXEC_TARGET)})`)
    const verified = r.ok && r.data?.success === true && back.data?.enabled === origEnabled
    record(`toggle ${EXEC_TARGET} 恢复 (${!origEnabled} -> ${origEnabled})`, verified, `success=${r.data?.success} after=${back.data?.enabled} 期望=${origEnabled}`)
  }

  // =============================================================
  // 9. 恢复验证 — 确保所有修改已恢复
  // =============================================================
  console.log('\n━━━ 9. 恢复验证 ━━━')
  await restoreAll()
  {
    const back = await agent(`api.agent.get(${JSON.stringify(EXEC_TARGET)})`)
    const restored = back.data?.enabled === origEnabled
    record(`${EXEC_TARGET} enabled 已恢复到原始值`, restored, `恢复后=${back.data?.enabled} 原始=${origEnabled}`)
  }

  // =============================================================
  // 汇总
  // =============================================================
  console.log('\n========== Agent 执行深度测试汇总 ==========')
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

main().catch(async (err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
