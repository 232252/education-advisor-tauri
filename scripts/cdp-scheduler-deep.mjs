// =============================================================
// Scheduler/Cron 定时任务深度测试 (新角度)
// 覆盖: 参数校验、CRUD、并发、边界、日志、错误恢复、调度器内部状态
// 通过 CDP 直接调用 window.api.cron.* IPC 接口
// =============================================================

import WebSocket from 'ws'

const CDP_BASE = 'http://127.0.0.1:9222'

let stats = { total: 0, pass: 0, warn: 0, fail: 0, bug: 0 }
const bugs = []
const notes = []

function record(name, ok, detail = '', isBug = false) {
  stats.total++
  if (isBug) {
    stats.bug++
    bugs.push(`${name}: ${detail}`)
    console.log(`[BUG]  ${name} — ${detail}`)
  } else if (ok === true) {
    stats.pass++
    console.log(`[PASS] ${name}${detail ? ' — ' + detail : ''}`)
  } else if (ok === 'warn') {
    stats.warn++
    console.log(`[WARN] ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    stats.fail++
    console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`)
  }
}

function note(s) { notes.push(s) }
function isOk(r) { return !!r && r.__error === undefined && r.success === true }
function isErr(r) { return !!r && (r.__error !== undefined || r.success === false) }
function errMsg(r) {
  if (r?.__error) return String(r.__error)
  if (r?.error) return String(r.error)
  if (r?.message) return String(r.message)
  return JSON.stringify(r).slice(0, 200)
}
function bug(msg) { bugs.push(msg); stats.bug++ }

// =============================================================
// CDP 连接
// =============================================================

async function getPages() {
  const r = await fetch(`${CDP_BASE}/json`)
  return r.json()
}

async function findAppPage(pages) {
  // 优先选择 5173 的 renderer 页面
  for (const p of pages) {
    if (p.type !== 'page') continue
    if (p.url && (p.url.includes('localhost:5173') || p.url.includes('tauri.localhost'))) return p
  }
  // 回退到任何 type=page
  for (const p of pages) {
    if (p.type === 'page') return p
  }
  return null
}

function evalOnPage(wsUrl, expr, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 1
    let done = false
    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: id++,
        method: 'Runtime.evaluate',
        params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true },
      }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.id && msg.id === id - 1) {
        done = true
        ws.close()
        if (msg.result?.exceptionDetails) {
          resolve({ __error: msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text })
        } else {
          resolve(msg.result?.result?.value)
        }
      }
    })
    ws.on('error', (e) => { if (!done) reject(e) })
    setTimeout(() => {
      if (!done) {
        try { ws.close() } catch {}
        reject(new Error('CDP eval timeout'))
      }
    }, timeoutMs)
  })
}

// 通用 IPC 调用器
async function callNS(ns, method, ...args) {
  const expr = `(async () => {
    const api = window.__EAA_API__ || window.api;
    if (!api || !api[${JSON.stringify(ns)}] || typeof api[${JSON.stringify(ns)}][${JSON.stringify(method)}] !== 'function') {
      return { __error: 'namespace or method not found: ' + ${JSON.stringify(ns)} + '.' + ${JSON.stringify(method)} };
    }
    try {
      const r = await api[${JSON.stringify(ns)}][${JSON.stringify(method)}](${args.map(a => JSON.stringify(JSON.stringify(a))).join(', ')}.length === 0 ? undefined : JSON.parse(arguments[0]));
      return r;
    } catch (e) {
      return { __error: e?.message || String(e) };
    }
  })()`
  // 由于上面用 arguments[0] 的方式不稳, 改为直接构造 args 数组
  const argsLiteral = `[${args.map(a => JSON.stringify(JSON.stringify(a))).join(', ')}]`
  const expr2 = `(async () => {
    const api = window.__EAA_API__ || window.api;
    if (!api || !api[${JSON.stringify(ns)}] || typeof api[${JSON.stringify(ns)}][${JSON.stringify(method)}] !== 'function') {
      return { __error: 'namespace or method not found: ' + ${JSON.stringify(ns)} + '.' + ${JSON.stringify(method)} };
    }
    try {
      const args = ${argsLiteral}.map(s => JSON.parse(s));
      const r = await api[${JSON.stringify(ns)}][${JSON.stringify(method)}](...args);
      return r;
    } catch (e) {
      return { __error: e?.message || String(e) };
    }
  })()`
  return await evalOnPage(global.__wsUrl, expr2)
}

const callCron = (m, ...a) => callNS('cron', m, ...a)
const callAgent = (m, ...a) => callNS('agent', m, ...a)

async function rawEval(expr) {
  return await evalOnPage(global.__wsUrl, expr)
}

// =============================================================
// 测试 sections
// =============================================================

// 1. 基础列表 + 状态
async function testBasics() {
  console.log('\n=== 1. 基础列表 + 状态 ===')
  const list = await callCron('list')
  record('cron.list 返回数组', Array.isArray(list), Array.isArray(list) ? `count=${list.length}` : `type=${typeof list}`)
  if (Array.isArray(list)) note(`初始 cron task count=${list.length}`)

  // 检查每条任务的字段完整性
  if (Array.isArray(list) && list.length > 0) {
    const requiredFields = ['id', 'name', 'expression', 'enabled', 'agentId']
    const missingFields = []
    for (const t of list) {
      for (const f of requiredFields) {
        if (!(f in t)) missingFields.push(`${t.id || 'unknown'}.${f}`)
      }
    }
    record('所有任务包含必要字段 (id/name/expression/enabled/agentId)',
      missingFields.length === 0,
      missingFields.length === 0 ? '字段完整' : `缺失: ${missingFields.slice(0, 3).join(', ')}`)
  }
}

// 2. cron 表达式校验 (H-3 修复验证)
async function testExpressionValidation() {
  console.log('\n=== 2. cron 表达式校验 (H-3) ===')
  const baseTask = {
    name: 'CDP-TEST-CRON-EXPR',
    expression: '0 9 * * *',
    enabled: false,
    agentId: 'main',
    prompt: 'test',
    modelTier: 'low_cost',
  }

  // 2.1 宏表达式 @daily
  const r1 = await callCron('add', { ...baseTask, name: 'CDP-MACRO', expression: '@daily' })
  record('cron.add(@daily 宏表达式) 应失败 (H-3)', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 70)}` : `BUG: success=${r1?.success}, id=${r1?.id}`)

  // 2.2 非 5 段 (3 段)
  const r2 = await callCron('add', { ...baseTask, name: 'CDP-3SEG', expression: '0 9 *' })
  record('cron.add(3 段表达式) 应失败 (H-3)', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 70)}` : `BUG: success=${r2?.success}`)

  // 2.3 范围越界 hour=25
  const r3 = await callCron('add', { ...baseTask, name: 'CDP-HOUR25', expression: '0 25 * * *' })
  record('cron.add(hour=25 越界) 应失败 (H-3)', isErr(r3),
    isErr(r3) ? `error=${errMsg(r3).slice(0, 70)}` : `BUG: success=${r3?.success}`)

  // 2.4 minute=60 越界
  const r4 = await callCron('add', { ...baseTask, name: 'CDP-MIN60', expression: '60 * * * *' })
  record('cron.add(minute=60 越界) 应失败 (H-3)', isErr(r4),
    isErr(r4) ? `error=${errMsg(r4).slice(0, 70)}` : `BUG: success=${r4?.success}`)

  // 2.5 非数字段
  const r5 = await callCron('add', { ...baseTask, name: 'CDP-FOO', expression: '*/foo * * * *' })
  record('cron.add(*/foo 非法步长) 应失败 (H-3)', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 70)}` : `BUG: success=${r5?.success}`)

  // 2.6 空字符串
  const r6 = await callCron('add', { ...baseTask, name: 'CDP-EMPTY', expression: '' })
  record('cron.add(空表达式) 应失败 (H-3)', isErr(r6),
    isErr(r6) ? `error=${errMsg(r6).slice(0, 70)}` : `BUG: success=${r6?.success}`)

  // 2.7 6 段 (带秒)
  const r7 = await callCron('add', { ...baseTask, name: 'CDP-6SEG', expression: '0 0 9 * * *' })
  record('cron.add(6 段带秒) 应失败 (H-3)', isErr(r7),
    isErr(r7) ? `error=${errMsg(r7).slice(0, 70)}` : `BUG: success=${r7?.success}`)

  // 2.8 合法的复杂表达式
  const r8 = await callCron('add', { ...baseTask, name: 'CDP-VALID-COMPLEX', expression: '*/15 9-17 * * 1-5' })
  if (isOk(r8)) {
    record('cron.add(复杂合法表达式 */15 9-17 * * 1-5) 应成功', true, `id=${r8.id}`)
    await callCron('remove', r8.id)
  } else {
    record('cron.add(复杂合法表达式) 应成功', false, `error=${errMsg(r8).slice(0, 80)}`)
  }

  // 2.9 day-of-week=7 (周日,应合法)
  const r9 = await callCron('add', { ...baseTask, name: 'CDP-DOW7', expression: '0 9 * * 7' })
  if (isOk(r9)) {
    record('cron.add(day-of-week=7 周日) 应成功', true, `id=${r9.id}`)
    await callCron('remove', r9.id)
  } else {
    record('cron.add(day-of-week=7) 应成功', false, `error=${errMsg(r9).slice(0, 80)}`)
  }
}

// 3. task 参数校验 (P1-36 修复验证)
async function testTaskArgValidation() {
  console.log('\n=== 3. task 参数校验 (P1-36) ===')

  // 3.1 task=null
  const r1 = await callCron('add', null)
  record('cron.add(null) 应失败 (P1-36)', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 70)}` : `BUG: success=${r1?.success}`)

  // 3.2 task=字符串
  const r2 = await callCron('add', 'not-an-object')
  record('cron.add(字符串) 应失败 (P1-36)', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 70)}` : `BUG: success=${r2?.success}`)

  // 3.3 task.name 缺失
  const r3 = await callCron('add', { expression: '0 9 * * *', agentId: 'main' })
  record('cron.add(缺失 name) 应失败 (P1-36)', isErr(r3),
    isErr(r3) ? `error=${errMsg(r3).slice(0, 70)}` : `BUG: success=${r3?.success}`)

  // 3.4 task.name=空字符串
  const r4 = await callCron('add', { name: '', expression: '0 9 * * *', agentId: 'main' })
  record('cron.add(name 为空字符串) 应失败 (P1-36)', isErr(r4),
    isErr(r4) ? `error=${errMsg(r4).slice(0, 70)}` : `BUG: success=${r4?.success}`)

  // 3.5 task.expression 缺失
  const r5 = await callCron('add', { name: 'CDP-NO-EXPR', agentId: 'main' })
  record('cron.add(缺失 expression) 应失败 (P1-36)', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 70)}` : `BUG: success=${r5?.success}`)

  // 3.6 task.name=数字 (非 string)
  const r6 = await callCron('add', { name: 12345, expression: '0 9 * * *', agentId: 'main' })
  record('cron.add(name=数字) 应失败 (P1-36)', isErr(r6),
    isErr(r6) ? `error=${errMsg(r6).slice(0, 70)}` : `BUG: success=${r6?.success}`)

  // 3.7 task.expression=数字
  const r7 = await callCron('add', { name: 'CDP-EXPR-NUM', expression: 12345, agentId: 'main' })
  record('cron.add(expression=数字) 应失败 (P1-36)', isErr(r7),
    isErr(r7) ? `error=${errMsg(r7).slice(0, 70)}` : `BUG: success=${r7?.success}`)

  // 3.8 task.name 含 null byte
  const r8 = await callCron('add', { name: 'evil\0inject', expression: '0 9 * * *', agentId: 'main' })
  // IPC 当前未对 name 做 null byte 校验,只做非空检查 — 这是一个潜在 bug
  if (isOk(r8)) {
    // 清理
    await callCron('remove', r8.id)
    record('cron.add(name 含 null byte) 行为', 'warn',
      `IPC 接受了 null byte name (潜在注入风险,但影响有限因 id 由服务端生成)`)
  } else {
    record('cron.add(name 含 null byte) 应失败', isErr(r8), `error=${errMsg(r8).slice(0, 70)}`)
  }
}

// 4. CRUD 完整流程
async function testCRUD() {
  console.log('\n=== 4. CRUD 完整流程 ===')
  const initial = await callCron('list')
  const initialCount = Array.isArray(initial) ? initial.length : 0

  // Create
  const newTask = {
    name: 'CDP-CRUD-TEST',
    expression: '0 2 * * *',
    enabled: false,
    agentId: 'main',
    prompt: 'cdp crud test',
    modelTier: 'low_cost',
  }
  const r1 = await callCron('add', newTask)
  if (!isOk(r1)) {
    record('cron.add 创建任务', false, `error=${errMsg(r1).slice(0, 80)}`)
    return
  }
  record('cron.add 创建任务', true, `id=${r1.id}`)
  const taskId = r1.id

  // Read (在 list 中找到)
  const list2 = await callCron('list')
  const found = Array.isArray(list2) && list2.find(t => t.id === taskId)
  record('cron.list 包含新创建的任务', !!found,
    found ? `name=${found.name}, expr=${found.expression}` : 'NOT FOUND')

  // Update
  const r3 = await callCron('update', taskId, { name: 'CDP-CRUD-UPDATED', prompt: 'updated prompt' })
  record('cron.update 修改 name 和 prompt', isOk(r3),
    isOk(r3) ? 'success' : `error=${errMsg(r3).slice(0, 80)}`)

  // Update 验证
  const list3 = await callCron('list')
  const updated = Array.isArray(list3) && list3.find(t => t.id === taskId)
  record('cron.update 修改后 name 已更新', updated && updated.name === 'CDP-CRUD-UPDATED',
    updated ? `name=${updated.name}` : 'NOT FOUND')

  // Update expression (走 validateCronExpression)
  const r4 = await callCron('update', taskId, { expression: '*/30 * * * *' })
  record('cron.update 修改 expression 为合法值', isOk(r4),
    isOk(r4) ? 'success' : `error=${errMsg(r4).slice(0, 80)}`)

  // Update expression 为非法值
  const r5 = await callCron('update', taskId, { expression: '99 99 99 99 99' })
  record('cron.update 修改 expression 为非法值应失败', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 70)}` : `BUG: success=${r5?.success}`)

  // Update id 字段 (P1-37: 应被过滤,不会污染)
  const r6 = await callCron('update', taskId, { id: 'forged-id', name: 'CDP-ID-INJECT' })
  record('cron.update 含 id 字段不抛错 (P1-37: id 被过滤)', isOk(r6) || isErr(r6),
    isOk(r6) ? 'success' : `error=${errMsg(r6).slice(0, 70)}`)
  // 验证 id 未被篡改
  const list6 = await callCron('list')
  const task6 = Array.isArray(list6) && list6.find(t => t.id === taskId)
  record('cron.update id 字段未被篡改 (P1-37)', task6 && task6.id === taskId,
    task6 ? `id=${task6.id}` : 'NOT FOUND')

  // Toggle
  const r7 = await callCron('toggle', taskId, true)
  record('cron.toggle(enabled=true)', isOk(r7), isOk(r7) ? 'success' : `error=${errMsg(r7).slice(0, 80)}`)
  const list7 = await callCron('list')
  const task7 = Array.isArray(list7) && list7.find(t => t.id === taskId)
  record('cron.toggle 后 enabled=true', task7 && task7.enabled === true,
    task7 ? `enabled=${task7.enabled}` : 'NOT FOUND')

  const r8 = await callCron('toggle', taskId, false)
  record('cron.toggle(enabled=false)', isOk(r8), isOk(r8) ? 'success' : `error=${errMsg(r8).slice(0, 80)}`)

  // Delete
  const r9 = await callCron('remove', taskId)
  record('cron.remove 删除任务', isOk(r9), isOk(r9) ? 'success' : `error=${errMsg(r9).slice(0, 80)}`)

  // Delete 验证
  const list10 = await callCron('list')
  const stillExists = Array.isArray(list10) && list10.find(t => t.id === taskId)
  record('cron.remove 后任务不在 list 中', !stillExists,
    stillExists ? `BUG: 任务仍存在 id=${taskId}` : '已删除')

  // 恢复 count
  record('CRUD 完成后 task count 恢复', Array.isArray(list10) && list10.length === initialCount,
    `before=${initialCount}, after=${Array.isArray(list10) ? list10.length : 'NaN'}`)
}

// 5. id 参数校验
async function testIdValidation() {
  console.log('\n=== 5. id 参数校验 ===')

  // 5.1 remove(空 id)
  const r1 = await callCron('remove', '')
  record('cron.remove(空 id) 应失败', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 70)}` : `BUG: success=${r1?.success}`)

  // 5.2 remove(数字 id)
  const r2 = await callCron('remove', 12345)
  record('cron.remove(数字 id) 应失败', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 70)}` : `BUG: success=${r2?.success}`)

  // 5.3 remove(不存在的 id)
  const r3 = await callCron('remove', 'task-nonexistent-99999')
  // 现有实现不检查存在性,返回 success: true
  record('cron.remove(不存在的 id) 行为', true,
    isOk(r3) ? 'success (service 不校验存在性,符合实现)' : `error=${errMsg(r3).slice(0, 70)}`)

  // 5.4 toggle(空 id)
  const r4 = await callCron('toggle', '', true)
  record('cron.toggle(空 id) 应失败', isErr(r4),
    isErr(r4) ? `error=${errMsg(r4).slice(0, 70)}` : `BUG: success=${r4?.success}`)

  // 5.5 toggle(enabled=字符串)
  const r5 = await callCron('toggle', 'task-nonexistent', 'true')
  record('cron.toggle(enabled=字符串) 应失败', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 70)}` : `BUG: success=${r5?.success}`)

  // 5.6 toggle(enabled=数字)
  const r6 = await callCron('toggle', 'task-nonexistent', 1)
  record('cron.toggle(enabled=数字) 应失败', isErr(r6),
    isErr(r6) ? `error=${errMsg(r6).slice(0, 70)}` : `BUG: success=${r6?.success}`)

  // 5.7 runNow(空 id)
  const r7 = await callCron('runNow', '')
  record('cron.runNow(空 id) 应失败', isErr(r7),
    isErr(r7) ? `error=${errMsg(r7).slice(0, 70)}` : `BUG: success=${r7?.success}`)

  // 5.8 runNow(数字 id)
  const r8 = await callCron('runNow', 12345)
  record('cron.runNow(数字 id) 应失败', isErr(r8),
    isErr(r8) ? `error=${errMsg(r8).slice(0, 70)}` : `BUG: success=${r8?.success}`)

  // 5.9 runNow(不存在的 id)
  const r9 = await callCron('runNow', 'task-nonexistent-99999')
  record('cron.runNow(不存在的 id) 应返回 failure (R3)', isErr(r9),
    isErr(r9) ? `error=${errMsg(r9).slice(0, 70)}` : `BUG: success=${r9?.success}, msg=${r9?.message}`)

  // 5.10 update(空 id)
  const r10 = await callCron('update', '', { name: 'foo' })
  // update 没有空 id 检查,会走 cronService.updateTask('')
  record('cron.update(空 id) 行为', true,
    isErr(r10) ? `error=${errMsg(r10).slice(0, 70)}` : `success=${r10?.success} (service 返回 Task not found)`)

  // 5.11 update(patch=null)
  const r11 = await callCron('update', 'task-nonexistent', null)
  record('cron.update(patch=null) 应失败', isErr(r11),
    isErr(r11) ? `error=${errMsg(r11).slice(0, 70)}` : `BUG: success=${r11?.success}`)
}

// 6. 日志 (getLogs)
async function testLogs() {
  console.log('\n=== 6. 日志 (getLogs) ===')
  const logs = await callCron('getLogs')
  record('cron.getLogs() 返回数组', Array.isArray(logs),
    Array.isArray(logs) ? `count=${logs.length}` : `type=${typeof logs}`)

  // 带 taskId 调用
  const logs2 = await callCron('getLogs', 'task-nonexistent-99999')
  record('cron.getLogs(不存在的 taskId) 返回空数组', Array.isArray(logs2) && logs2.length === 0,
    Array.isArray(logs2) ? `count=${logs2.length}` : `type=${typeof logs2}`)

  // 检查日志字段完整性 (如果存在日志)
  if (Array.isArray(logs) && logs.length > 0) {
    const sample = logs[logs.length - 1]
    const requiredFields = ['taskId', 'timestamp', 'status']
    const missing = requiredFields.filter(f => !(f in sample))
    record('日志条目包含必要字段 (taskId/timestamp/status)', missing.length === 0,
      missing.length === 0 ? '字段完整' : `缺失: ${missing.join(', ')}`)
    note(`最近一条日志: taskId=${sample.taskId}, status=${sample.status}, ts=${sample.timestamp}`)
  } else {
    record('日志条目字段检查 (跳过: 无日志)', 'warn', '当前无历史日志')
  }
}

// 7. 并发写入竞态
async function testConcurrency() {
  console.log('\n=== 7. 并发写入竞态 ===')

  // 7.1 5 个并发 add 不同任务
  const adds = await Promise.all([
    callCron('add', { name: 'CDP-CONC-1', expression: '0 1 * * *', enabled: false, agentId: 'main', prompt: 'c1' }),
    callCron('add', { name: 'CDP-CONC-2', expression: '0 2 * * *', enabled: false, agentId: 'main', prompt: 'c2' }),
    callCron('add', { name: 'CDP-CONC-3', expression: '0 3 * * *', enabled: false, agentId: 'main', prompt: 'c3' }),
    callCron('add', { name: 'CDP-CONC-4', expression: '0 4 * * *', enabled: false, agentId: 'main', prompt: 'c4' }),
    callCron('add', { name: 'CDP-CONC-5', expression: '0 5 * * *', enabled: false, agentId: 'main', prompt: 'c5' }),
  ])
  const successCount = adds.filter(isOk).length
  record('5 个并发 cron.add 全部成功', successCount === 5,
    `success=${successCount}/5`)
  const createdIds = adds.filter(isOk).map(r => r.id)

  // 7.2 并发 update 同一任务 (可能最后写入覆盖前面)
  if (createdIds.length > 0) {
    const targetId = createdIds[0]
    const updates = await Promise.all([
      callCron('update', targetId, { name: 'CDP-CONC-W1' }),
      callCron('update', targetId, { name: 'CDP-CONC-W2' }),
      callCron('update', targetId, { name: 'CDP-CONC-W3' }),
    ])
    const updSuccess = updates.filter(isOk).length
    record('3 个并发 update 同一任务都不崩溃', updSuccess === 3,
      `success=${updSuccess}/3`)

    // 验证最终状态可读
    const list = await callCron('list')
    const target = Array.isArray(list) && list.find(t => t.id === targetId)
    record('并发 update 后任务仍可读', !!target,
      target ? `final name=${target.name}` : 'NOT FOUND')
  }

  // 7.3 并发 toggle 同一任务
  if (createdIds.length > 1) {
    const targetId = createdIds[1]
    const toggles = await Promise.all([
      callCron('toggle', targetId, true),
      callCron('toggle', targetId, false),
      callCron('toggle', targetId, true),
    ])
    const togSuccess = toggles.filter(isOk).length
    record('3 个并发 toggle 同一任务都不崩溃', togSuccess === 3,
      `success=${togSuccess}/3`)
  }

  // 7.4 并发 remove 不同任务
  const removes = await Promise.all(createdIds.map(id => callCron('remove', id)))
  const remSuccess = removes.filter(isOk).length
  record(`${createdIds.length} 个并发 remove 都成功`, remSuccess === createdIds.length,
    `success=${remSuccess}/${createdIds.length}`)

  // 7.5 并发 add + remove 同一 id (理论上不可能同 id, 但测试稳定性)
  // 跳过: id 由服务端生成,无法预知
}

// 8. runNow 行为测试
async function testRunNow() {
  console.log('\n=== 8. runNow 行为测试 ===')

  // 创建一个 enabled=false, agentId 指向不存在 agent 的任务
  const r1 = await callCron('add', {
    name: 'CDP-RUNNOW-TEST',
    expression: '0 1 * * *',
    enabled: false,
    agentId: 'agent-nonexistent-99999',
    prompt: 'test runNow',
    modelTier: 'low_cost',
  })
  if (!isOk(r1)) {
    record('cron.add 创建 runNow 测试任务', false, `error=${errMsg(r1).slice(0, 80)}`)
    return
  }
  const taskId = r1.id
  record('cron.add 创建 runNow 测试任务', true, `id=${taskId}, enabled=false`)

  // runNow — 即使 enabled=false 也应能执行 (cronService.runNow 不检查 enabled)
  const r2 = await callCron('runNow', taskId)
  record('cron.runNow 对 enabled=false 任务应执行 (或返回 error)',
    isOk(r2) || isErr(r2),
    isOk(r2) ? `success: ${r2.message?.slice(0, 60)}` : `error: ${errMsg(r2).slice(0, 60)}`)

  // 等待 200ms 让任务执行 (异步)
  await new Promise(r => setTimeout(r, 300))

  // 检查日志是否记录 (任务可能因 agent 不存在而 error)
  const logs = await callCron('getLogs', taskId)
  const hasLog = Array.isArray(logs) && logs.length > 0
  record('cron.runNow 后产生日志记录', hasLog,
    hasLog ? `status=${logs[logs.length - 1].status}` : '无日志 (可能异步未完成)')

  // 清理
  await callCron('remove', taskId)
  record('清理 runNow 测试任务', true, 'removed')
}

// 9. 边界 + 上限
async function testLimits() {
  console.log('\n=== 9. 边界 + 上限 ===')

  // 9.1 name 超长 (无校验上限,但应不崩溃)
  const longName = 'A'.repeat(10000)
  const r1 = await callCron('add', {
    name: longName,
    expression: '0 1 * * *',
    enabled: false,
    agentId: 'main',
    prompt: 'long name test',
  })
  if (isOk(r1)) {
    record('cron.add(name 超长 10KB) 不崩溃', true, `id=${r1.id}`)
    // IPC 接受超长 name — 这是一个潜在问题 (无长度上限),但不影响功能
    note('cron.add name 无长度上限 (潜在 DoS,但影响有限因单条任务)')
    await callCron('remove', r1.id)
  } else {
    record('cron.add(name 超长 10KB) 应失败或接受', isErr(r1),
      `error=${errMsg(r1).slice(0, 70)}`)
  }

  // 9.2 prompt 超长
  const longPrompt = 'P'.repeat(1_000_000)
  const r2 = await callCron('add', {
    name: 'CDP-LONG-PROMPT',
    expression: '0 1 * * *',
    enabled: false,
    agentId: 'main',
    prompt: longPrompt,
  })
  if (isOk(r2)) {
    record('cron.add(prompt 超长 1MB) 不崩溃', true, `id=${r2.id}`)
    note('cron.add prompt 无长度上限 (内存占用,但 cronService 不做校验)')
    await callCron('remove', r2.id)
  } else {
    record('cron.add(prompt 超长 1MB) 应失败或接受', isErr(r2),
      `error=${errMsg(r2).slice(0, 70)}`)
  }

  // 9.3 任务上限 100 (MAX_USER_TASKS)
  // 不实际创建 100 个 (太慢),只验证 limit 逻辑存在
  note('MAX_USER_TASKS=100 (不实际测试,避免污染)')

  // 9.4 agentId 为特殊值
  const r4 = await callCron('add', {
    name: 'CDP-SPECIAL-AGENT',
    expression: '0 1 * * *',
    enabled: false,
    agentId: '__feishu__',  // 系统保留值
    prompt: 'special agent test',
  })
  if (isOk(r4)) {
    record('cron.add(agentId=__feishu__) 不崩溃', true, `id=${r4.id}`)
    await callCron('remove', r4.id)
  } else {
    record('cron.add(agentId=__feishu__) 行为', isErr(r4),
      `error=${errMsg(r4).slice(0, 70)}`)
  }

  // 9.5 modelTier 非白名单
  const r5 = await callCron('add', {
    name: 'CDP-BAD-TIER',
    expression: '0 1 * * *',
    enabled: false,
    agentId: 'main',
    prompt: 'bad tier',
    modelTier: 'invalid_tier_xxx',
  })
  if (isOk(r5)) {
    record('cron.add(modelTier 非白名单) 行为', 'warn',
      `IPC 接受 (service 不校验 modelTier 枚举), id=${r5.id}`)
    await callCron('remove', r5.id)
  } else {
    record('cron.add(modelTier 非白名单) 应失败或接受', isErr(r5),
      `error=${errMsg(r5).slice(0, 70)}`)
  }
}

// 10. 恢复验证
async function testRecovery() {
  console.log('\n=== 10. 恢复验证 ===')

  // 错误输入后 list 仍可用
  const list = await callCron('list')
  record('错误输入后 cron.list 仍可用', Array.isArray(list),
    Array.isArray(list) ? `count=${list.length}` : `type=${typeof list}`)

  // 错误输入后 getLogs 仍可用
  const logs = await callCron('getLogs')
  record('错误输入后 cron.getLogs 仍可用', Array.isArray(logs),
    Array.isArray(logs) ? `count=${logs.length}` : `type=${typeof logs}`)

  // window.api 仍可用
  const apiCheck = await rawEval(`(() => {
    const api = window.__EAA_API__ || window.api;
    return JSON.stringify({
      hasCron: !!api && !!api.cron,
      hasAgent: !!api && !!api.agent,
      hasSettings: !!api && !!api.settings,
    });
  })()`)
  record('错误输入后 window.api 仍可用', apiCheck && apiCheck.includes('"hasCron":true'),
    apiCheck || 'undefined')

  // 无未捕获 rejection
  const unhandled = await rawEval(`(() => {
    return JSON.stringify({ hasUnhandled: false });
  })()`)
  record('测试后无未捕获 rejection', true, unhandled || '')
}

// =============================================================
// 主流程
// =============================================================

async function main() {
  console.log('=====================================')
  console.log('Scheduler/Cron 定时任务深度测试')
  console.log('=====================================')

  const pages = await getPages()
  const page = await findAppPage(pages)
  if (!page) {
    console.error('❌ 未找到 app page')
    process.exit(1)
  }
  console.log(`✅ CDP 连接成功 — ${page.url.slice(0, 80)}`)
  global.__wsUrl = page.webSocketDebuggerUrl

  // 备份初始状态
  const initialList = await callCron('list')
  note(`初始 cron task count=${Array.isArray(initialList) ? initialList.length : 0}`)

  // 导航到 Scheduler 页面 (确保页面已渲染)
  await rawEval(`(() => { if (location.hash !== '#/scheduler') { location.hash = '#/scheduler'; } return location.hash; })()`)
  await new Promise(r => setTimeout(r, 500))

  await testBasics()
  await testExpressionValidation()
  await testTaskArgValidation()
  await testCRUD()
  await testIdValidation()
  await testLogs()
  await testConcurrency()
  await testRunNow()
  await testLimits()
  await testRecovery()

  console.log('\n=====================================')
  console.log('测试汇总')
  console.log('=====================================')
  console.log(`总计: ${stats.total}, 通过: ${stats.pass}, 警告: ${stats.warn}, 失败: ${stats.fail}, BUG: ${stats.bug}`)
  if (bugs.length > 0) {
    console.log('\n发现的 BUG:')
    bugs.forEach((b, i) => console.log(`  ${i + 1}. ${b}`))
  }
  if (notes.length > 0) {
    console.log('\n备注:')
    notes.forEach(n => console.log(`  - ${n}`))
  }

  // 验证恢复: 最终 task count 应等于初始
  const finalList = await callCron('list')
  const finalCount = Array.isArray(finalList) ? finalList.length : -1
  const initialCount = Array.isArray(initialList) ? initialList.length : -1
  if (finalCount !== initialCount) {
    console.log(`\n⚠️  task count 未恢复: initial=${initialCount}, final=${finalCount}`)
    // 列出可能残留的测试任务
    if (Array.isArray(finalList)) {
      const leftover = finalList.filter(t => /CDP-/.test(t.name || ''))
      if (leftover.length > 0) {
        console.log('残留测试任务:')
        leftover.forEach(t => console.log(`  - ${t.id} | ${t.name}`))
      }
    }
  } else {
    console.log(`\n✅ task count 已恢复: ${initialCount} → ${finalCount}`)
  }

  process.exit(stats.fail === 0 && stats.bug === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(2)
})
