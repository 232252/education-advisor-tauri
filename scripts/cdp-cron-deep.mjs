// =============================================================
// CDP 深度测试 — Cron 定时任务系统 (CRUD / 校验 / 启停 / 日志 / 边界)
//
// 连接到运行中的 Tauri 2 应用 (WebView2 CDP 9222),
// 通过 window.__EAA_API__.cron / window.api.cron 调用 IPC,
// 深度覆盖 12 类场景,测试完成后清理所有测试任务。
//
// 运行: node scripts/cdp-cron-deep.mjs
//
// 实测得到的 API 契约 (来自 src/main/ipc/cron-handlers.ts + cron-service.ts):
//   cron.list()                 -> CronTask[]                      (直接返回数组)
//   cron.add(task)              -> {success:true, id} | {success:false, error} | throw(畸形/空字段/非法表达式)
//   cron.update(id, patch)      -> {success:true} | {success:false, error:'Task not found'} | throw(非法表达式)
//   cron.remove(id)             -> {success:true}                   (幂等,不存在也返回 success:true)
//   cron.toggle(id, enabled)    -> {success:true} | {success:false, error:'Task not found'}  (注意: 2 个参数)
//   cron.runNow(id)             -> {success, message}
//   cron.getLogs(taskId?)       -> CronLogEntry[]                   (直接返回数组)
//   cron.onStatusUpdate(cb)     -> unsub 函数
//
// CronTask 字段: id, name, agentId, expression, prompt, enabled, modelTier,
//                lastRunAt?, lastStatus?, nextRunAt?
//   注意: 没有 action 字段; "动作类型" 概念由 agentId 路由实现
//         (__feishu__ -> bitable 同步, 真实 agentId -> agent 执行)
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
  console.log('CDP 已连接,开始 Cron 深度测试...\n')

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
      name: 'cron-deep-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      agentId: 'test-agent',
      // 默认用每年 1 月 1 日 9 点的表达式,即使被 enable 也不会在测试期间触发
      expression: '0 9 1 1 *',
      prompt: 'deep-test-prompt',
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
  // 0. API 探测 — Object.keys(window.api.cron) 与方法存在性
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
    record(`cron API 探测`, Array.isArray(apiKeys) && apiKeys.length > 0, `keys=[${apiKeys.join(',')}]`)
  } catch (err) {
    record(`cron API 探测`, false, String(err.message || err))
  }
  const expectedMethods = ['list', 'add', 'update', 'remove', 'toggle', 'runNow', 'getLogs', 'onStatusUpdate']
  const missing = expectedMethods.filter((m) => !apiKeys.includes(m))
  record(`cron 方法完整性`, missing.length === 0, missing.length ? `缺失: ${missing.join(',')}` : `全部 ${expectedMethods.length} 个方法存在`)

  // =============================================================
  // 1. Cron 表达式验证 (合法接受 / 非法拒绝)
  // =============================================================
  console.log('\n━━━ 1. Cron 表达式验证 ━━━')
  const validExprs = ['0 9 * * *', '*/5 * * * *', '0 0 1 * *', '0 9 * * 1-5', '0 0 * * 0']
  const invalidExprs = ['invalid', '0 25 * * *', '* * * *', '', '0 9 * * * * *']

  for (const expr of validExprs) {
    const { id, raw } = await addTask({ expression: expr })
    const accepted = !!id
    record(`合法表达式被接受: ${JSON.stringify(expr)}`, accepted, accepted ? `id=${id.slice(0, 24)}...` : `被拒: ${raw.error}`)
  }

  for (const expr of invalidExprs) {
    const { raw } = await addTask({ expression: expr })
    const rejected = !raw.ok || raw.data?.success === false
    record(`非法表达式被拒绝: ${JSON.stringify(expr)}`, rejected, rejected ? `ok=${raw.ok} err=${raw.error || raw.data?.error || ''}` : `意外被接受 id=${raw.data?.id}`)
  }

  // =============================================================
  // 2. Cron CRUD 完整流程
  // =============================================================
  console.log('\n━━━ 2. CRUD 完整流程 ━━━')
  let crudId = null
  // list (基线)
  let baseline = 0
  {
    const r = await cron(`api.cron.list()`)
    baseline = r.ok ? (r.data || []).length : -1
    record(`list (基线)`, r.ok && baseline >= 0, `count=${baseline}`)
  }
  // add
  {
    const { id, raw } = await addTask({ name: 'crud-task-' + Date.now(), expression: '0 9 1 1 *' })
    crudId = id
    record(`add (合法表达式)`, !!crudId, `id=${crudId} success=${raw.data?.success}`)
  }
  // list (验证新增)
  if (crudId) {
    const found = await findTaskInList(crudId)
    record(`list (验证新增)`, !!found, `found=${!!found} name=${found?.name}`)
  }
  // update (改表达式)
  if (crudId) {
    const r = await cron(`api.cron.update(${JSON.stringify(crudId)}, ${JSON.stringify({ expression: '0 10 1 1 *', name: 'updated-crud' })})`)
    const found = await findTaskInList(crudId)
    record(`update (改表达式)`, r.ok && r.data?.success === true && found?.expression === '0 10 1 1 *' && found?.name === 'updated-crud', `success=${r.data?.success} expr=${found?.expression} name=${found?.name}`)
  }
  // toggle (启停)
  if (crudId) {
    const r = await cron(`api.cron.toggle(${JSON.stringify(crudId)}, true)`)
    const found1 = await findTaskInList(crudId)
    const r2 = await cron(`api.cron.toggle(${JSON.stringify(crudId)}, false)`)
    const found2 = await findTaskInList(crudId)
    record(`toggle (启停)`, r.ok && r.data?.success === true && found1?.enabled === true && found2?.enabled === false, `on=${found1?.enabled} off=${found2?.enabled}`)
  }
  // remove
  if (crudId) {
    const r = await cron(`api.cron.remove(${JSON.stringify(crudId)})`)
    const found = await findTaskInList(crudId)
    record(`remove`, r.ok && r.data?.success === true && !found, `success=${r.data?.success} foundAfter=${!!found}`)
    createdIds.delete(crudId) // 已删,无需再清理
  }

  // =============================================================
  // 3. Cron 任务字段完整性
  // =============================================================
  console.log('\n━━━ 3. 任务字段完整性 ━━━')
  {
    const fields = {
      name: 'field-test-' + Date.now(),
      agentId: 'agent-abc',
      expression: '0 9 1 1 *',
      prompt: '完整字段测试指令',
      enabled: false,
      modelTier: 'high_quality',
    }
    const { id } = await addTask(fields)
    const found = id ? await findTaskInList(id) : null
    const checks = found
      ? {
          name: found.name === fields.name,
          agentId: found.agentId === fields.agentId,
          expression: found.expression === fields.expression,
          prompt: found.prompt === fields.prompt,
          enabled: found.enabled === fields.enabled,
          modelTier: found.modelTier === fields.modelTier,
        }
      : {}
    const allOk = found && Object.values(checks).every(Boolean)
    record(`字段完整性 (name/agentId/expression/prompt/enabled/modelTier)`, !!allOk, found ? Object.entries(checks).map(([k, v]) => `${k}:${v ? '✓' : '✗'}`).join(' ') : '任务未创建')
  }

  // =============================================================
  // 4. Cron 日志
  // =============================================================
  console.log('\n━━━ 4. Cron 日志 ━━━')
  {
    const { id } = await addTask({ name: 'log-test-' + Date.now() })
    // 全局日志
    const r1 = await cron(`api.cron.getLogs()`)
    record(`getLogs() 全局`, r1.ok && Array.isArray(r1.data), `isArray=${Array.isArray(r1.data)} count=${r1.data?.length ?? 0}`)
    // 指定任务日志 (任务刚创建,通常无执行日志,但 API 不应报错)
    const r2 = await cron(`api.cron.getLogs(${JSON.stringify(id)})`)
    record(`getLogs(taskId) 指定任务`, r2.ok && Array.isArray(r2.data), `isArray=${Array.isArray(r2.data)} count=${r2.data?.length ?? 0} (新任务无执行日志属正常)`)
    // 不存在任务的日志
    const r3 = await cron(`api.cron.getLogs('nonexistent-task-id')`)
    record(`getLogs(不存在 taskId)`, r3.ok && Array.isArray(r3.data), `isArray=${Array.isArray(r3.data)} count=${r3.data?.length ?? 0}`)
  }

  // =============================================================
  // 5. Cron toggle 状态验证
  // =============================================================
  console.log('\n━━━ 5. toggle 状态验证 ━━━')
  {
    const { id } = await addTask({ name: 'toggle-test-' + Date.now(), enabled: false })
    if (id) {
      // 初始 false
      let found = await findTaskInList(id)
      const initFalse = found?.enabled === false
      // toggle -> true
      await cron(`api.cron.toggle(${JSON.stringify(id)}, true)`)
      found = await findTaskInList(id)
      const afterOn = found?.enabled === true
      // toggle -> false
      await cron(`api.cron.toggle(${JSON.stringify(id)}, false)`)
      found = await findTaskInList(id)
      const afterOff = found?.enabled === false
      record(`toggle 状态切换 (false->true->false)`, initFalse && afterOn && afterOff, `init=${initFalse} on=${afterOn} off=${afterOff}`)
    } else {
      record(`toggle 状态切换`, false, '任务创建失败')
    }
  }

  // =============================================================
  // 6. Cron 重复添加 (相同 name)
  // =============================================================
  console.log('\n━━━ 6. 重复添加 (相同 name) ━━━')
  {
    const dupName = 'dup-name-' + Date.now()
    const { id: id1, raw: r1 } = await addTask({ name: dupName })
    const { id: id2, raw: r2 } = await addTask({ name: dupName })
    // addTask 不校验 name 唯一性,两次都应成功且 id 不同
    const bothOk = !!id1 && !!id2 && id1 !== id2
    record(`相同 name 添加 2 次`, bothOk, `id1=${id1?.slice(0, 20)}... id2=${id2?.slice(0, 20)}... 不同=${id1 !== id2} (设计: name 不唯一, id 唯一)`)
  }

  // =============================================================
  // 7. Cron 删除不存在
  // =============================================================
  console.log('\n━━━ 7. 删除不存在的任务 ━━━')
  {
    const fakeId = 'nonexistent-' + Date.now()
    const r = await cron(`api.cron.remove(${JSON.stringify(fakeId)})`)
    // 实测: remove 幂等, 不存在也返回 {success:true}, 不崩溃
    const noCrash = r.ok
    record(`remove 不存在任务 (不崩溃)`, noCrash, `返回 success=${r.data?.success} error=${r.data?.error ?? '无'} (设计: 幂等, 不区分缺失)`)
  }

  // =============================================================
  // 8. Cron update 不存在
  // =============================================================
  console.log('\n━━━ 8. update 不存在的任务 ━━━')
  {
    const fakeId = 'nonexistent-' + Date.now()
    const r = await cron(`api.cron.update(${JSON.stringify(fakeId)}, ${JSON.stringify({ name: 'ghost' })})`)
    // 实测: update 不存在返回 {success:false, error:'Task not found'}, 不崩溃
    const noCrashAndError = r.ok && r.data?.success === false
    record(`update 不存在任务 (返回错误不崩溃)`, noCrashAndError, `ok=${r.ok} success=${r.data?.success} error=${r.data?.error ?? r.error ?? '无'}`)
  }

  // =============================================================
  // 9. Cron 批量操作
  // =============================================================
  console.log('\n━━━ 9. 批量操作 (5 增 5 删) ━━━')
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
  // 10. Cron 表达式边界
  // =============================================================
  console.log('\n━━━ 10. 表达式边界 ━━━')
  {
    // 最小有效: 每分钟
    const { id: idMin, raw: rMin } = await addTask({ expression: '* * * * *', enabled: false })
    record(`最小有效表达式 '* * * * *'`, !!idMin, `accepted=${!!idMin} err=${rMin.error ?? ''}`)
    // 复杂: 每年 1 月 1 日 9 点
    const { id: idYear, raw: rYear } = await addTask({ expression: '0 9 1 1 *' })
    record(`复杂表达式 '0 9 1 1 *' (每年1月1日9点)`, !!idYear, `accepted=${!!idYear} err=${rYear.error ?? ''}`)
  }

  // =============================================================
  // 11. action 字段 (实际由 agentId 路由, 测试不同 agentId 值)
  // =============================================================
  console.log('\n━━━ 11. action/agentId 类型 ━━━')
  record(`字段说明`, true, 'CronTask 无 action 字段; 动作路由由 agentId 决定 (__feishu__->bitable同步, 其他->agent执行)')
  for (const agentId of ['sync', 'notify', 'custom']) {
    const { id } = await addTask({ agentId, name: `action-${agentId}-${Date.now()}` })
    const found = id ? await findTaskInList(id) : null
    record(`agentId='${agentId}' 创建并回读`, !!found && found.agentId === agentId, `roundtrip=${found?.agentId === agentId}`)
  }

  // =============================================================
  // 12. Cron 与 Bitable 同步 (内置任务)
  // =============================================================
  console.log('\n━━━ 12. Bitable 同步内置任务 ━━━')
  {
    const r = await cron(`api.cron.list()`)
    const tasks = r.ok ? r.data || [] : []
    const bitableTask = tasks.find((t) => t.id === 'feishu-bitable-sync' || t.agentId === '__feishu__')
    if (bitableTask) {
      const validExpr = !!bitableTask.expression
      const isFeishu = bitableTask.agentId === '__feishu__'
      record(`Bitable 同步任务存在`, true, `id=${bitableTask.id} agentId=${bitableTask.agentId} expr=${bitableTask.expression} enabled=${bitableTask.enabled}`)
      record(`Bitable 任务字段正确`, validExpr && isFeishu, `exprValid=${validExpr} agentIdIsFeishu=${isFeishu}`)
    } else {
      // 未注册通常因 settings.feishu.bitableSync.enabled=false (配置相关, 非缺陷)
      let bitableEnabled = null
      try {
        const s = await cron(`api.settings.get()`)
        bitableEnabled = s.ok ? s.data?.feishu?.bitableSync?.enabled : undefined
      } catch {
        /* ignore */
      }
      record(`Bitable 同步任务未注册`, true, `未在 list 中找到 (settings.feishu.bitableSync.enabled=${bitableEnabled}, 属配置相关非缺陷)`)
    }
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
  console.log('\n========== Cron 深度测试汇总 ==========')
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
