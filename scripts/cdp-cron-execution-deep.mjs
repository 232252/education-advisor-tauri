// =============================================================
// CDP 深度测试 — Cron 定时任务执行系统 (执行/日志/调度边界/错误处理)
//
// 连接到运行中的 Tauri 2 应用 (WebView2 CDP 9222),
// 通过 window.__EAA_API__.cron / window.api.cron 调用 IPC,
// 深度覆盖 12 类场景: 日志基线/执行生命周期/表达式边界/字段校验/
//                   更新边界/启停边界/删除边界/订阅/并发/批量/清理。
// 测试完成后清理所有测试任务。
//
// 运行: node scripts/cdp-cron-execution-deep.mjs
//
// 实测得到的 API 契约 (来自 src/main/ipc/cron-handlers.ts + cron-service.ts):
//   cron.list()                 -> CronTask[]                      (直接返回数组)
//   cron.add(task)              -> {success:true, id} | {success:false, error} | throw(空 name/空/非法 expression)
//      (不校验 modelTier / prompt / agentId — 仅校验 name 非空 + expression 非空 + 合法)
//   cron.update(id, patch)       -> {success:true} | {success:false, error:'Task not found'} | throw(非法 expression)
//      (update 不校验 name 空值; expression 非空时才校验)
//   cron.remove(id)             -> {success:true} | throw(空/null id)   (幂等, 不存在 id 返回 success:true; 空/null id 抛错)
//   cron.toggle(id, enabled)    -> {success:true} | {success:false, error:'Task not found'} | throw(空 id / 非 boolean enabled)
//   cron.runNow(id)             -> {success, message}
//      (存在则执行; executeTask 不检查 enabled — 禁用任务仍会执行)
//      (不存在 -> {success:false, message:'Task not found: ...'})
//   cron.getLogs(taskId?)       -> CronLogEntry[]                   (preload 仅转发 1 个参数, limit 被静默丢弃)
//   cron.onStatusUpdate(cb)     -> unsub 函数 (同步返回; 函数无法跨 returnByValue 序列化, 需在页内判定)
//
// CronTask 字段: id, name, agentId, expression, prompt, enabled, modelTier,
//                lastRunAt?, lastStatus?, nextRunAt?
// CronLogEntry 字段: taskId, agentId, timestamp, durationMs, status('success'|'error'|'timeout'), error?
//
// 关键实际行为 (与"理想预期"不同处, 测试按实际行为断言):
//   - getLogs(undefined, 5): limit 参数被 preload 丢弃, 返回全部日志 (不崩溃)
//   - add 空 prompt / 非法 modelTier: 接受 (无运行时校验)
//   - update 空 name: 接受 (update 不校验 name)
//   - toggle(id, 'true'): 拒绝 (类型校验, 抛 "enabled must be a boolean")
//   - remove('') / remove(null): 拒绝 (id 校验, 抛 "id must be a non-empty string")
//   - runNow 在 disabled 任务上仍执行 (executeTask 无 enabled 检查)
//   - runNow 对不存在 agentId 会触发 agentRunner 抛错, 被 executeTask 捕获后仍写入 error 日志
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
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error(`JSON parse fail: ${e.message}`))
        }
      })
    }).on('error', reject)
  })
}

// 等待工具
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  console.log('CDP 已连接,开始 Cron 执行深度测试...\n')

  // ---------- IPC 调用封装 ----------
  // 返回 { ok, data, error }: ok=true 表示 IPC 调用未抛出, data 为返回值
  const callCron = async (code) => {
    return await evalInPage(`
      (async function() {
        const api = window.__EAA_API__ || window.api;
        if (!api) return { __error: 'no-api' };
        if (!api.cron) return { __error: 'no-cron-api' };
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
  const cron = async (code) => {
    const r = await callCron(code)
    if (!r) return { ok: false, data: null, error: 'null-result' }
    if (r.__error) return { ok: false, data: null, error: r.__error }
    return { ok: true, data: r.data ?? null, error: null }
  }

  // ---------- 清理追踪 ----------
  const createdIds = new Set()
  const addTask = async (overrides = {}) => {
    const task = {
      name: 'CDP_CronExec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      agentId: 'test-agent',
      // 默认每年 1 月 1 日 9 点,即使被 enable 也不会在测试期间触发
      expression: '0 9 1 1 *',
      prompt: 'exec-deep-test-prompt',
      enabled: false,
      modelTier: 'low_cost',
      ...overrides,
    }
    const r = await cron(`api.cron.add(${JSON.stringify(task)})`)
    const id = r.ok && r.data && r.data.success ? r.data.id : null
    if (id) createdIds.add(id)
    return { id, raw: r, task }
  }

  const findTaskInList = async (id) => {
    const r = await cron(`api.cron.list()`)
    if (!r.ok) return null
    return (r.data || []).find((t) => t.id === id) || null
  }

  // =============================================================
  // 0. API 探测 — 方法存在性
  // =============================================================
  console.log('━━━ 0. API 探测 ━━━')
  let apiKeys = []
  try {
    apiKeys = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        if (!api || !api.cron) return [];
        return Object.keys(api.cron).filter(k => typeof api.cron[k] === 'function');
      })()
    `)
  } catch (err) {
    record(`cron API 探测`, false, String(err.message || err))
  }
  record(`cron API 探测`, Array.isArray(apiKeys) && apiKeys.length > 0, `keys=[${apiKeys.join(',')}]`)
  const expectedMethods = ['list', 'add', 'update', 'remove', 'toggle', 'runNow', 'getLogs', 'onStatusUpdate']
  const missing = expectedMethods.filter((m) => !apiKeys.includes(m))
  record(`cron 方法完整性`, missing.length === 0, missing.length ? `缺失: ${missing.join(',')}` : `全部 ${expectedMethods.length} 个方法存在`)

  // =============================================================
  // 1. getLogs 基线
  // =============================================================
  console.log('\n━━━ 1. getLogs 基线 ━━━')
  {
    // 无参 — 全局日志
    const r1 = await cron(`api.cron.getLogs()`)
    record(`getLogs() 全局日志`, r1.ok && Array.isArray(r1.data), `isArray=${Array.isArray(r1.data)} count=${r1.data?.length ?? 0}`)

    // 不存在 taskId — 返回空数组, 不崩溃
    const r2 = await cron(`api.cron.getLogs('nonexistent-id-${Date.now()}')`)
    record(`getLogs(不存在 taskId)`, r2.ok && Array.isArray(r2.data) && r2.data.length === 0, `isArray=${Array.isArray(r2.data)} count=${r2.data?.length ?? 0} (应为空)`)

    // 边界 limit=0 — preload 仅转发 1 个参数, limit 被丢弃, 返回全部 (不崩溃)
    const r3 = await cron(`api.cron.getLogs(undefined, 0)`)
    record(`getLogs(undefined, 0) 边界 limit`, r3.ok && Array.isArray(r3.data), `isArray=${Array.isArray(r3.data)} count=${r3.data?.length ?? 0} (limit 被丢弃, 返回全部)`)

    // limit=5 — 同上, limit 被丢弃
    const r4 = await cron(`api.cron.getLogs(undefined, 5)`)
    record(`getLogs(undefined, 5) 带 limit`, r4.ok && Array.isArray(r4.data), `isArray=${Array.isArray(r4.data)} count=${r4.data?.length ?? 0} (limit 被丢弃, 返回全部)`)

    // 日志条目字段完整性 (若存在日志)
    if (r1.ok && Array.isArray(r1.data) && r1.data.length > 0) {
      const entry = r1.data[r1.data.length - 1]
      const hasFields =
        entry &&
        typeof entry.taskId === 'string' &&
        typeof entry.agentId === 'string' &&
        typeof entry.timestamp === 'number' &&
        typeof entry.durationMs === 'number' &&
        typeof entry.status === 'string'
      record(`日志条目字段完整 (taskId/agentId/timestamp/durationMs/status)`, !!hasFields, `status=${entry?.status} fields=[${Object.keys(entry || {}).join(',')}]`)
    } else {
      record(`日志条目字段完整`, true, `全局日志为空, 跳过字段校验`)
    }
  }

  // =============================================================
  // 2. 任务生命周期 + 立即执行
  // =============================================================
  console.log('\n━━━ 2. 任务生命周期 + 立即执行 ━━━')
  let execId = null
  {
    // 创建 (合法表达式 + 真实可触发表达式 0 9 * * *)
    const { id, raw } = await addTask({ agentId: 'test-agent', expression: '0 9 * * *', enabled: true, prompt: '生命周期执行测试' })
    execId = id
    record(`创建执行测试任务`, !!execId, `id=${execId ? execId.slice(0, 24) + '...' : 'null'} success=${raw.data?.success}`)
  }
  if (execId) {
    // 出现在 list
    const found = await findTaskInList(execId)
    record(`执行任务出现在 list`, !!found, `found=${!!found} name=${found?.name} enabled=${found?.enabled}`)

    // 执行前日志基线
    const before = await cron(`api.cron.getLogs(${JSON.stringify(execId)})`)
    const beforeCount = before.ok ? (before.data || []).length : 0

    // runNow — 立即执行
    const run = await cron(`api.cron.runNow(${JSON.stringify(execId)})`)
    record(`runNow 返回 success`, run.ok && run.data?.success === true, `success=${run.data?.success} msg=${run.data?.message} (agentId=test-agent 不存在, agentRunner 抛错被捕获)`)

    // 等待日志写入 (executeTask 同步 push 到内存, 留少量缓冲)
    await sleep(500)
    const after = await cron(`api.cron.getLogs(${JSON.stringify(execId)})`)
    const afterCount = after.ok ? (after.data || []).length : 0
    record(`runNow 产生执行日志`, afterCount > beforeCount, `before=${beforeCount} after=${afterCount} (即使执行失败也应写入日志)`)

    // 验证日志条目字段 + status
    if (afterCount > 0) {
      const entry = (after.data || []).reverse().find((e) => e.taskId === execId)
      const okFields =
        entry &&
        entry.taskId === execId &&
        typeof entry.timestamp === 'number' &&
        typeof entry.durationMs === 'number' &&
        (entry.status === 'success' || entry.status === 'error')
      record(`执行日志字段 + status 正确`, !!okFields, `status=${entry?.status} durationMs=${entry?.durationMs} error=${entry?.error ?? '无'}`)
    } else {
      record(`执行日志字段 + status 正确`, false, `无执行日志`)
    }

    // 禁用后 runNow — executeTask 无 enabled 检查, 实际仍执行
    await cron(`api.cron.toggle(${JSON.stringify(execId)}, false)`)
    const foundDisabled = await findTaskInList(execId)
    const runDisabled = await cron(`api.cron.runNow(${JSON.stringify(execId)})`)
    record(`disabled 任务 runNow 仍执行 (无 enabled 检查)`, runDisabled.ok && runDisabled.data?.success === true, `enabled=${foundDisabled?.enabled} success=${runDisabled.data?.success} (实际: executeTask 不检查 enabled)`)

    // 重新启用
    const tBack = await cron(`api.cron.toggle(${JSON.stringify(execId)}, true)`)
    const foundReOn = await findTaskInList(execId)
    record(`重新启用任务`, tBack.ok && tBack.data?.success === true && foundReOn?.enabled === true, `success=${tBack.data?.success} enabled=${foundReOn?.enabled}`)
  }

  // =============================================================
  // 3. 表达式 (宏 + 标准)
  // =============================================================
  console.log('\n━━━ 3. 表达式 (宏 + 标准) ━━━')
  // 宏 — node-cron 不支持宏表达式 (@daily/@hourly 等),
  // strictValidateCron 直接拒绝 @ 开头的表达式, 避免误导用户。
  const macros = ['@daily', '@hourly', '@weekly', '@monthly', '@yearly']
  for (const m of macros) {
    const { id, raw } = await addTask({ expression: m })
    const rejected = !id && (!raw.ok || raw.data?.success === false)
    record(`宏表达式被拒绝: ${m} (node-cron 不支持宏)`, rejected, `accepted=${!!id} err=${(raw.error || raw.data?.error || '').slice(0, 80)}`)
  }
  // 标准有效表达式 — 批量校验
  const stdValid = [
    '*/15 * * * *', // 每 15 分钟
    '0 0 * * 0', // 每周日 0 点
    '0 0 1 1 *', // 每年 1 月 1 日
    '30 14 15 * *', // 每月 15 日 14:30
    '0 9 * * 1-5', // 工作日 9 点
    '0 0,12 * * *', // 每天 0 点和 12 点
    '0 9 1,15 * *', // 每月 1 日和 15 日 9 点
  ]
  const stdResults = []
  for (const expr of stdValid) {
    const { id } = await addTask({ expression: expr })
    stdResults.push({ expr, accepted: !!id })
  }
  const allAccepted = stdResults.every((r) => r.accepted)
  record(`标准有效表达式 (7 种) 全部被接受`, allAccepted, stdResults.map((r) => `${r.expr}:${r.accepted ? '✓' : '✗'}`).join(' '))

  // =============================================================
  // 4. 非法表达式 (应被拒绝)
  // =============================================================
  console.log('\n━━━ 4. 非法表达式 (应被拒绝) ━━━')
  const invalidExprs = [
    { expr: '60 * * * *', label: 'minute=60 越界' },
    { expr: '* 24 * * *', label: 'hour=24 越界' },
    { expr: '* * 32 * *', label: 'day=32 越界' },
    { expr: '* * * 13 *', label: 'month=13 越界' },
    { expr: '* * * * 8', label: 'dow=8 越界(0-7)' },
    { expr: '0 9 * * * *', label: '6 段 (应为 5 段)' },
    { expr: '@nonexistent', label: '未知宏' },
    { expr: '', label: '空字符串' },
    { expr: null, label: 'null' },
    { expr: 123, label: '数字类型' },
  ]
  for (const { expr, label } of invalidExprs) {
    const { raw } = await addTask({ expression: expr })
    const rejected = !raw.ok || raw.data?.success === false
    record(`非法表达式被拒绝: ${label} (${JSON.stringify(expr)})`, rejected, rejected ? `ok=${raw.ok} err=${(raw.error || raw.data?.error || '').slice(0, 60)}` : `意外被接受 id=${raw.data?.id}`)
  }

  // =============================================================
  // 5. 任务字段校验
  // =============================================================
  console.log('\n━━━ 5. 任务字段校验 ━━━')
  {
    // 空 name — 应拒绝
    const { raw } = await addTask({ name: '' })
    record(`空 name 被拒绝`, !raw.ok || raw.data?.success === false, `ok=${raw.ok} err=${(raw.error || raw.data?.error || '').slice(0, 60)}`)

    // 空 prompt — 实际接受 (无校验)
    const { id: emptyPromptId } = await addTask({ prompt: '' })
    const fep = emptyPromptId ? await findTaskInList(emptyPromptId) : null
    record(`空 prompt 被接受 (无运行时校验)`, !!emptyPromptId && fep?.prompt === '', `accepted=${!!emptyPromptId} prompt=${JSON.stringify(fep?.prompt)}`)

    // 非法 agentId — 接受 (仅字符串)
    const badAgentIdVal = 'not-a-real-agent-_xyz-!@#'
    const { id: badAgentId } = await addTask({ agentId: badAgentIdVal })
    const fba = badAgentId ? await findTaskInList(badAgentId) : null
    record(`非法 agentId 被接受 (仅字符串路由)`, !!badAgentId && fba?.agentId === badAgentIdVal, `agentId=${fba?.agentId}`)

    // 非法 modelTier — 实际接受 (无运行时枚举校验)
    const { id: badTierId } = await addTask({ modelTier: 'invalid_tier' })
    const fbt = badTierId ? await findTaskInList(badTierId) : null
    record(`非法 modelTier 被接受 (无运行时枚举校验)`, !!badTierId && fbt?.modelTier === 'invalid_tier', `modelTier=${fbt?.modelTier} (TS 类型仅编译期)`)

    // 超长 name (>100 字符) — 接受
    const longName = 'L'.repeat(150)
    const { id: longId } = await addTask({ name: longName })
    const fln = longId ? await findTaskInList(longId) : null
    record(`超长 name (150 字符) 被接受`, !!longId && fln?.name?.length === 150, `len=${fln?.name?.length}`)

    // 特殊字符 name — 接受
    const specialName = 'special<script>alert(1)</script>&name="引号"\\'
    const { id: specialId } = await addTask({ name: specialName })
    const fsn = specialId ? await findTaskInList(specialId) : null
    record(`特殊字符 name 被接受`, !!specialId && fsn?.name === specialName, `roundtripOk=${fsn?.name === specialName}`)

    // Unicode / emoji prompt — 接受
    const emojiPrompt = '执行 🚀 任务 — 测试 日本語 ñ ünïcödé ✓'
    const { id: emojiId } = await addTask({ prompt: emojiPrompt })
    const fen = emojiId ? await findTaskInList(emojiId) : null
    record(`Unicode/emoji prompt 被接受`, !!emojiId && fen?.prompt === emojiPrompt, `roundtripOk=${fen?.prompt === emojiPrompt}`)
  }

  // =============================================================
  // 6. update 边界
  // =============================================================
  console.log('\n━━━ 6. update 边界 ━━━')
  {
    const { id } = await addTask({ name: 'upd-' + Date.now(), expression: '0 9 1 1 *' })

    // 合法新表达式
    const r1 = await cron(`api.cron.update(${JSON.stringify(id)}, ${JSON.stringify({ expression: '0 10 * * *' })})`)
    const f1 = await findTaskInList(id)
    record(`update 合法新表达式`, r1.ok && r1.data?.success === true && f1?.expression === '0 10 * * *', `success=${r1.data?.success} expr=${f1?.expression}`)

    // 非法新表达式 — 应拒绝, 保留旧值
    const r2 = await cron(`api.cron.update(${JSON.stringify(id)}, ${JSON.stringify({ expression: '0 99 * * *' })})`)
    const f2 = await findTaskInList(id)
    const rejected = !r2.ok || r2.data?.success === false
    record(`update 非法新表达式被拒绝 (保留旧值)`, rejected && f2?.expression === '0 10 * * *', `rejected=${rejected} keptExpr=${f2?.expression} err=${(r2.error || r2.data?.error || '').slice(0, 50)}`)

    // 空 name — 实际接受 (update 不校验 name)
    const r3 = await cron(`api.cron.update(${JSON.stringify(id)}, ${JSON.stringify({ name: '' })})`)
    const f3 = await findTaskInList(id)
    record(`update 空 name 被接受 (update 不校验 name)`, r3.ok && r3.data?.success === true && f3?.name === '', `success=${r3.data?.success} name=${JSON.stringify(f3?.name)}`)

    // 不存在 id — 应失败
    const fakeId = 'nonexistent-' + Date.now()
    const r4 = await cron(`api.cron.update(${JSON.stringify(fakeId)}, ${JSON.stringify({ name: 'ghost' })})`)
    record(`update 不存在任务返回失败`, r4.ok && r4.data?.success === false, `success=${r4.data?.success} error=${r4.data?.error ?? r4.error ?? '无'}`)

    // 多字段同时更新
    const r5 = await cron(`api.cron.update(${JSON.stringify(id)}, ${JSON.stringify({ name: 'multi-upd', prompt: 'new-prompt', enabled: true, modelTier: 'high_quality' })})`)
    const f5 = await findTaskInList(id)
    record(`update 多字段同时更新`, r5.ok && r5.data?.success === true && f5?.name === 'multi-upd' && f5?.prompt === 'new-prompt' && f5?.enabled === true && f5?.modelTier === 'high_quality', `name=${f5?.name} prompt=${f5?.prompt} enabled=${f5?.enabled} tier=${f5?.modelTier}`)
  }

  // =============================================================
  // 7. toggle 边界
  // =============================================================
  console.log('\n━━━ 7. toggle 边界 ━━━')
  {
    // 不存在任务 — 应失败
    const fakeId = 'nonexistent-' + Date.now()
    const r = await cron(`api.cron.toggle(${JSON.stringify(fakeId)}, true)`)
    record(`toggle 不存在任务返回失败`, r.ok && r.data?.success === false, `success=${r.data?.success} error=${r.data?.error ?? '无'}`)
  }
  {
    const { id } = await addTask({ enabled: false })
    // 非法 enabled (字符串 'true') — 现在校验类型, 应拒绝
    const r = await cron(`api.cron.toggle(${JSON.stringify(id)}, 'true')`)
    record(`toggle 字符串 enabled 被拒绝 (类型校验)`, !r.ok && r.error?.includes('must be a boolean'), `ok=${r.ok} error=${(r.error ?? '').slice(0, 80)}`)
    // 复位为布尔 false, 避免污染后续
    await cron(`api.cron.toggle(${JSON.stringify(id)}, false)`)
  }
  {
    const { id } = await addTask({ enabled: false })
    // 同值多次切换 (幂等)
    const a = await cron(`api.cron.toggle(${JSON.stringify(id)}, true)`)
    const b = await cron(`api.cron.toggle(${JSON.stringify(id)}, true)`)
    const c = await cron(`api.cron.toggle(${JSON.stringify(id)}, true)`)
    const f = await findTaskInList(id)
    record(`toggle 同值多次 (幂等)`, a.ok && b.ok && c.ok && a.data?.success && b.data?.success && c.data?.success && f?.enabled === true, `a=${a.data?.success} b=${b.data?.success} c=${c.data?.success} enabled=${f?.enabled}`)
  }

  // =============================================================
  // 8. remove 边界
  // =============================================================
  console.log('\n━━━ 8. remove 边界 ━━━')
  {
    // 不存在任务 — 幂等成功
    const fakeId = 'nonexistent-' + Date.now()
    const r1 = await cron(`api.cron.remove(${JSON.stringify(fakeId)})`)
    record(`remove 不存在任务 (幂等成功)`, r1.ok && r1.data?.success === true, `success=${r1.data?.success}`)

    // 已删除任务再删 — 幂等成功
    const { id } = await addTask({})
    await cron(`api.cron.remove(${JSON.stringify(id)})`)
    createdIds.delete(id)
    const r2 = await cron(`api.cron.remove(${JSON.stringify(id)})`)
    record(`remove 已删除任务 (幂等成功)`, r2.ok && r2.data?.success === true, `success=${r2.data?.success}`)

    // 空 id — 现在校验, 应拒绝
    const r3 = await cron(`api.cron.remove('')`)
    record(`remove 空 id 被拒绝 (id 校验)`, !r3.ok && r3.error?.includes('non-empty string'), `ok=${r3.ok} error=${(r3.error ?? '').slice(0, 80)}`)

    // null id — 现在校验, 应拒绝
    const r4 = await cron(`api.cron.remove(null)`)
    record(`remove null id 被拒绝 (id 校验)`, !r4.ok && r4.error?.includes('non-empty string'), `ok=${r4.ok} error=${(r4.error ?? '').slice(0, 80)}`)
  }

  // =============================================================
  // 9. onStatusUpdate 订阅
  // =============================================================
  console.log('\n━━━ 9. onStatusUpdate 订阅 ━━━')
  {
    // 在页内完成: 订阅返回函数 / 调用 unsub / 多次订阅 / 立即取消
    // (unsub 是函数, 无法跨 returnByValue 序列化, 故在页内判定后返回布尔)
    const r = await evalInPage(`
      (async function() {
        const api = window.__EAA_API__ || window.api;
        if (!api || !api.cron) return { __error: 'no-cron-api' };
        try {
          // 1. 订阅返回函数
          let calls = 0;
          const unsub1 = api.cron.onStatusUpdate(function(){ calls++; });
          const isFunc1 = typeof unsub1 === 'function';
          // 2. 调用 unsub 不崩溃
          let unsubCallOk = false;
          try { unsub1(); unsubCallOk = true; } catch(e) { unsubCallOk = false; }
          // 3. 多次订阅
          const unsub2 = api.cron.onStatusUpdate(function(){});
          const unsub3 = api.cron.onStatusUpdate(function(){});
          const multiOk = typeof unsub2 === 'function' && typeof unsub3 === 'function';
          // 4. 订阅后立即取消
          const unsub4 = api.cron.onStatusUpdate(function(){});
          let immediateOk = false;
          try { unsub4(); immediateOk = true; } catch(e) { immediateOk = false; }
          // cleanup
          try { unsub2(); unsub3(); } catch(e) {}
          return { __ok: true, data: { isFunc1: isFunc1, unsubCallOk: unsubCallOk, multiOk: multiOk, immediateOk: immediateOk } };
        } catch(e) {
          return { __error: String(e && e.message ? e.message : e) };
        }
      })()
    `)
    if (r && r.__error) {
      record(`onStatusUpdate 订阅返回函数`, false, `err=${r.__error}`)
      record(`调用 unsub 不崩溃`, false, `err=${r.__error}`)
      record(`多次订阅`, false, `err=${r.__error}`)
      record(`订阅后立即取消`, false, `err=${r.__error}`)
    } else {
      const d = (r && r.data) || {}
      record(`onStatusUpdate 订阅返回函数`, !!d.isFunc1, `isFunc=${d.isFunc1}`)
      record(`调用 unsub 不崩溃`, !!d.unsubCallOk, `unsubCallOk=${d.unsubCallOk}`)
      record(`多次订阅`, !!d.multiOk, `multiOk=${d.multiOk}`)
      record(`订阅后立即取消`, !!d.immediateOk, `immediateOk=${d.immediateOk}`)
    }
  }

  // =============================================================
  // 10. 并发操作
  // =============================================================
  console.log('\n━━━ 10. 并发操作 ━━━')
  {
    // 并发 add 5 个
    const baseList = await cron(`api.cron.list()`)
    const baseCount = baseList.ok ? (baseList.data || []).length : -1
    const addResults = await Promise.all(
      Array.from({ length: 5 }, (_, i) => addTask({ name: `conc-add-${i}-${Date.now()}` })),
    )
    const allAdded = addResults.every((x) => !!x.id)
    const distinctIds = new Set(addResults.map((x) => x.id))
    record(`并发 add 5 个任务`, allAdded && distinctIds.size === 5, `added=${addResults.filter((x) => !!x.id).length} distinct=${distinctIds.size}`)

    // 并发 toggle 不同任务
    const toggleTargets = addResults.slice(0, 3).map((x) => x.id)
    const toggleRes = await Promise.all(
      toggleTargets.map((id) => cron(`api.cron.toggle(${JSON.stringify(id)}, true)`)),
    )
    record(`并发 toggle 3 个任务`, toggleRes.every((r) => r.ok && r.data?.success === true), `ok=${toggleRes.filter((r) => r.ok && r.data?.success).length}/3`)

    // 并发 getLogs 不同任务
    const logsTargets = addResults.slice(0, 2).map((x) => x.id)
    const logsRes = await Promise.all(
      logsTargets.map((id) => cron(`api.cron.getLogs(${JSON.stringify(id)})`)),
    )
    record(`并发 getLogs 2 个任务`, logsRes.every((r) => r.ok && Array.isArray(r.data)), `ok=${logsRes.filter((r) => r.ok && Array.isArray(r.data)).length}/2`)

    // 并发 remove 不同任务 (剩余 5 个中的 2 个)
    const removeTargets = addResults.slice(3, 5).map((x) => x.id)
    const removeRes = await Promise.all(
      removeTargets.map((id) => cron(`api.cron.remove(${JSON.stringify(id)})`)),
    )
    const removedOk = removeRes.every((r) => r.ok && r.data?.success === true)
    removeTargets.forEach((id) => createdIds.delete(id))
    record(`并发 remove 2 个任务`, removedOk, `ok=${removeRes.filter((r) => r.ok && r.data?.success).length}/2`)
  }

  // =============================================================
  // 11. 批量操作
  // =============================================================
  console.log('\n━━━ 11. 批量操作 (5 增 5 删) ━━━')
  {
    const before = await cron(`api.cron.list()`)
    const beforeCount = before.ok ? (before.data || []).length : -1
    const batchIds = []
    for (let i = 0; i < 5; i++) {
      const { id } = await addTask({ name: `batch-${i}-${Date.now()}` })
      if (id) batchIds.push(id)
    }
    const mid = await cron(`api.cron.list()`)
    const midCount = mid.ok ? (mid.data || []).length : -1
    record(`批量 add 5 个`, batchIds.length === 5 && midCount === beforeCount + 5, `added=${batchIds.length} before=${beforeCount} mid=${midCount} Δ=${midCount - beforeCount}`)

    // 全部出现在 list
    const listAll = await cron(`api.cron.list()`)
    const allInList = listAll.ok ? batchIds.every((id) => (listAll.data || []).some((t) => t.id === id)) : false
    record(`批量任务全部出现在 list`, allInList, `allInList=${allInList}`)

    // 批量 remove
    let removed = 0
    for (const id of batchIds) {
      const r = await cron(`api.cron.remove(${JSON.stringify(id)})`)
      if (r.ok && r.data?.success) {
        removed++
        createdIds.delete(id)
      }
    }
    const after = await cron(`api.cron.list()`)
    const afterCount = after.ok ? (after.data || []).length : -1
    record(`批量 remove 5 个`, removed === 5 && afterCount === beforeCount, `removed=${removed} after=${afterCount} Δ=${afterCount - beforeCount}`)
  }

  // =============================================================
  // 清理: 删除所有测试创建的任务
  // =============================================================
  console.log('\n━━━ 清理测试任务 ━━━')
  let cleaned = 0
  let cleanupErrors = 0
  for (const id of createdIds) {
    const r = await cron(`api.cron.remove(${JSON.stringify(id)})`)
    if (r.ok) cleaned++
    else cleanupErrors++
  }
  record(`清理测试任务`, createdIds.size === 0 || cleaned === createdIds.size, `待清理=${createdIds.size} 已清理=${cleaned} 错误=${cleanupErrors}`)

  // 验证清理后无残留
  {
    const r = await cron(`api.cron.list()`)
    const remaining = (r.data || []).filter((t) => createdIds.has(t.id))
    record(`清理后无测试残留`, remaining.length === 0, `残留=${remaining.length} ${remaining.map((t) => t.id).join(',')}`)
  }

  // =============================================================
  // 汇总
  // =============================================================
  console.log('\n========== Cron 执行深度测试汇总 ==========')
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
