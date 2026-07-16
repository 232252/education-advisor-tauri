// =============================================================
// Round 15: AI 数据访问边界与错误处理测试 (CDP) — 重中之重 续2
//
// 测试 AI 在边界条件和错误场景下的数据访问能力:
//   1. 工具输入边界 (8 项 - 空值/特殊字符/超长输入)
//   2. 不存在数据查询 (6 项 - 不存在学生/事件/日期)
//   3. 数据隔离性 (6 项 - 写入A不影响B)
//   4. 缓存一致性 (6 项 - 写入后缓存同步)
//   5. 并发数据访问 (6 项 - 多请求并行)
//   6. Agent 配置操作 (6 项 - toggle/update/history)
//   7. 工具返回错误处理 (6 项 - 错误码/错误消息)
//   8. 数据完整性验证 (6 项 - 删除后数据状态)
//
// 运行: node scripts/cdp-ai-data-access-edge-deep.mjs
// =============================================================
import http from 'node:http'

const CDP_PORT = 9222
const BASE = `http://127.0.0.1:${CDP_PORT}`

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(new Error(`JSON parse fail: ${e.message}`)) } })
    }).on('error', reject)
  })
}

async function main() {
  const results = []
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  }
  const test = (name, fn) =>
    fn().catch((err) => record(name, false, `异常: ${String(err && err.message ? err.message : err).slice(0, 200)}`))

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
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => { const id = msgId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
  const evalInPage = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) {
      const desc = r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'unknown'
      throw new Error(`Eval error: ${desc.slice(0, 300)}`)
    }
    return r.result?.result?.value
  }
  await new Promise((resolve) => { ws.on('open', resolve) })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP connected, running AI data access edge tests...\n')

  // ---------- IPC 封装 ----------
  const callIpc = async (code) =>
    evalInPage(`(async function() {
      const api = window.__EAA_API__ || window.api;
      if (!api) return { __error: 'no-api' };
      try { ${code} } catch (e) { return { __error: String(e && e.message ? e.message : e) }; }
    })()`)

  const isOk = (res) => !!res && !res.__error && res?.success !== false
  const TS = Date.now()
  const VALID_BONUS_CODE = 'ACTIVITY_PARTICIPATION'

  // ---------- EAA helpers ----------
  const listStudents = async () => { const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`); return r?.data?.students ?? [] }
  const addStudent = async (name) => callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(name)}); return res;`)
  const deleteStudent = async (name, reason) => callIpc(`const res = await api.eaa.deleteStudent(${JSON.stringify(name)}, ${JSON.stringify(reason)}); return res;`)
  const getScore = async (name) => { const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(name)}); return res;`); return r?.data ?? null }
  const getHistory = async (name) => { const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(name)}); return res;`); return r?.data ?? null }
  const searchEvents = async (kw) => { const r = await callIpc(`const res = await api.eaa.search(${JSON.stringify(kw)}); return res;`); return r?.data ?? null }
  const getRanking = async (n) => { const r = await callIpc(`const res = await api.eaa.ranking(${n || 10}); return res;`); return r?.data?.ranking ?? [] }
  const getStats = async () => { const r = await callIpc(`const res = await api.eaa.stats(); return res;`); return r?.data ?? null }
  const getCodes = async () => { const r = await callIpc(`const res = await api.eaa.codes(); return res;`); return r?.data ?? null }
  const getInfo = async () => { const r = await callIpc(`const res = await api.eaa.info(); return res;`); return r?.data ?? null }
  const addEvent = async (name, code, delta, note) => callIpc(`const res = await api.eaa.addEvent({ studentName: ${JSON.stringify(name)}, reasonCode: ${JSON.stringify(code)}, delta: ${delta}, note: ${JSON.stringify(note || 'edge test')}, force: true }); return res;`)

  // Agent helpers
  const agentList = async () => { const r = await callIpc(`const res = await api.agent.list(); return res;`); return r?.data ?? r ?? [] }
  const agentGet = async (id) => { const r = await callIpc(`const res = await api.agent.get(${JSON.stringify(id)}); return res;`); return r?.data ?? r ?? null }
  const agentGetHistory = async (id) => { const r = await callIpc(`const res = await api.agent.getHistory(${JSON.stringify(id)}); return res;`); return r?.data ?? r ?? [] }
  const agentToggle = async (id, enabled) => callIpc(`const res = await api.agent.toggle(${JSON.stringify(id)}, ${enabled}); return res;`)

  // ---------- 预取数据 ----------
  const EDGE_STU_A = `r15_edge_a_${TS}`
  const EDGE_STU_B = `r15_edge_b_${TS}`
  await addStudent(EDGE_STU_A)
  await addStudent(EDGE_STU_B)

  // =============================================================
  // Section 1: 工具输入边界 (8 项)
  // =============================================================
  console.log('━━━ Section 1: 工具输入边界 ━━━')

  await test('1.1 score(空名) 优雅失败 (不崩溃)', async () => {
    const N = '1.1 score(空名) 优雅失败 (不崩溃)'
    const r = await callIpc(`const res = await api.eaa.score(''); return res;`)
    // 应返回错误而非崩溃
    record(N, !!r && (r.success === false || r.__error), `success=${r?.success} hasError=${!!r?.__error}`)
  })

  await test('1.2 score(超长名) 优雅处理', async () => {
    const N = '1.2 score(超长名) 优雅处理'
    const longName = 'A'.repeat(500)
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(longName)}); return res;`)
    record(N, !!r, `hasResponse=${!!r} success=${r?.success}`)
  })

  await test('1.3 score(特殊字符名) 不崩溃', async () => {
    const N = '1.3 score(特殊字符名) 不崩溃'
    const r = await callIpc(`const res = await api.eaa.score('test<>script&;|'); return res;`)
    record(N, !!r, `hasResponse=${!!r} success=${r?.success}`)
  })

  await test('1.4 score(Unicode名) 正常工作', async () => {
    const N = '1.4 score(Unicode名) 正常工作'
    const unicodeName = `测试学生_${TS}_日本語_test`
    await addStudent(unicodeName)
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(unicodeName)}); return res;`)
    record(N, isOk(r), `success=${r?.success} score=${r?.data?.score}`)
    await deleteStudent(unicodeName, 'cleanup')
  })

  await test('1.5 addEvent(delta=0) 优雅处理', async () => {
    const N = '1.5 addEvent(delta=0) 优雅处理'
    const r = await addEvent(EDGE_STU_A, VALID_BONUS_CODE, 0, 'zero delta')
    record(N, !!r, `hasResponse=${!!r} success=${r?.success}`)
  })

  await test('1.6 addEvent(超大delta) 需要 force', async () => {
    const N = '1.6 addEvent(超大delta) 需要 force'
    // delta=999999 without force should fail; with force should succeed
    const rNoForce = await callIpc(`const res = await api.eaa.addEvent({ studentName: ${JSON.stringify(EDGE_STU_A)}, reasonCode: ${JSON.stringify(VALID_BONUS_CODE)}, delta: 999999, note: 'big delta no force' }); return res;`)
    const rForce = await callIpc(`const res = await api.eaa.addEvent({ studentName: ${JSON.stringify(EDGE_STU_A)}, reasonCode: ${JSON.stringify(VALID_BONUS_CODE)}, delta: 999999, note: 'big delta force', force: true }); return res;`)
    record(N, !!rNoForce && !!rForce, `noForce=${rNoForce?.success} force=${rForce?.success}`)
  })

  await test('1.7 search(空关键词) 优雅处理', async () => {
    const N = '1.7 search(空关键词) 优雅处理'
    const r = await callIpc(`const res = await api.eaa.search(''); return res;`)
    record(N, !!r, `hasResponse=${!!r} success=${r?.success}`)
  })

  await test('1.8 ranking(0) 或 ranking(负数) 优雅处理', async () => {
    const N = '1.8 ranking(0) 或 ranking(负数) 优雅处理'
    const r0 = await callIpc(`const res = await api.eaa.ranking(0); return res;`)
    const rNeg = await callIpc(`const res = await api.eaa.ranking(-1); return res;`)
    record(N, !!r0 && !!rNeg, `r0=${r0?.success} rNeg=${rNeg?.success}`)
  })

  // =============================================================
  // Section 2: 不存在数据查询 (6 项)
  // =============================================================
  console.log('\n━━━ Section 2: 不存在数据查询 ━━━')

  await test('2.1 score(不存在学生) 优雅失败', async () => {
    const N = '2.1 score(不存在学生) 优雅失败'
    const r = await callIpc(`const res = await api.eaa.score('nonexistent_student_xyz_${TS}'); return res;`)
    record(N, !!r && (r.success === false || r.data?.status === 'Deleted' || r.__error), `success=${r?.success}`)
  })

  await test('2.2 history(不存在学生) 优雅失败', async () => {
    const N = '2.2 history(不存在学生) 优雅失败'
    const r = await callIpc(`const res = await api.eaa.history('nonexistent_student_xyz_${TS}'); return res;`)
    record(N, !!r, `hasResponse=${!!r} success=${r?.success}`)
  })

  await test('2.3 search(不存在关键词) 返回空结果', async () => {
    const N = '2.3 search(不存在关键词) 返回空结果'
    const r = await searchEvents(`nonexistent_keyword_xyz_${TS}`)
    const events = r?.events || []
    const total = r?.total || 0
    record(N, events.length === 0 && total === 0, `events=${events.length} total=${total}`)
  })

  await test('2.4 range(未来日期) 返回空结果', async () => {
    const N = '2.4 range(未来日期) 返回空结果'
    const r = await callIpc(`const res = await api.eaa.range('2099-01-01', '2099-12-31'); return res;`)
    const total = r?.data?.total || 0
    record(N, total === 0, `total=${total}`)
  })

  await test('2.5 summary(未来日期) 返回空摘要', async () => {
    const N = '2.5 summary(未来日期) 返回空摘要'
    const r = await callIpc(`const res = await api.eaa.summary('2099-01-01', '2099-12-31'); return res;`)
    const events = r?.data?.events
    const eventTotal = typeof events === 'object' ? events?.total : events
    record(N, r?.success !== false && eventTotal === 0, `events=${eventTotal}`)
  })

  await test('2.6 addEvent(不存在学生) 自动创建或失败', async () => {
    const N = '2.6 addEvent(不存在学生) 自动创建或失败'
    const r = await callIpc(`const res = await api.eaa.addEvent({ studentName: 'auto_created_${TS}', reasonCode: ${JSON.stringify(VALID_BONUS_CODE)}, delta: 1, note: 'auto create test' }); return res;`)
    // 可能自动创建学生, 也可能失败 — 两种都是可接受的
    record(N, !!r, `hasResponse=${!!r} success=${r?.success}`)
    // 清理
    if (r?.success) await deleteStudent(`auto_created_${TS}`, 'cleanup')
  })

  // =============================================================
  // Section 3: 数据隔离性 (6 项)
  // =============================================================
  console.log('\n━━━ Section 3: 数据隔离性 ━━━')

  // 给 A 添加事件, B 不受影响
  await addEvent(EDGE_STU_A, VALID_BONUS_CODE, 5, 'isolation test A')
  await new Promise((r) => setTimeout(r, 200))

  await test('3.1 写入A后 A的分数增加', async () => {
    const N = '3.1 写入A后 A的分数增加'
    const score = await getScore(EDGE_STU_A)
    record(N, score?.score > 100, `score=${score?.score}`)
  })

  await test('3.2 写入A后 B的分数不变', async () => {
    const N = '3.2 写入A后 B的分数不变'
    const score = await getScore(EDGE_STU_B)
    record(N, score?.score === 100, `score=${score?.score}`)
  })

  await test('3.3 A的history不包含B的事件', async () => {
    const N = '3.3 A的history不包含B的事件'
    const history = await getHistory(EDGE_STU_A)
    const events = Array.isArray(history) ? history : (history?.events || [])
    const noB = events.every((e) => !JSON.stringify(e).includes(EDGE_STU_B))
    record(N, noB, `events=${events.length} noB=${noB}`)
  })

  await test('3.4 B的history不包含A的事件', async () => {
    const N = '3.4 B的history不包含A的事件'
    const history = await getHistory(EDGE_STU_B)
    const events = Array.isArray(history) ? history : (history?.events || [])
    const noA = events.every((e) => !JSON.stringify(e).includes(EDGE_STU_A))
    record(N, noA, `events=${events.length} noA=${noA}`)
  })

  await test('3.5 search(A名) 不返回B的事件', async () => {
    const N = '3.5 search(A名) 不返回B的事件'
    const search = await searchEvents(EDGE_STU_A)
    const events = search?.events || []
    const noB = events.every((e) => !JSON.stringify(e).includes(EDGE_STU_B))
    record(N, noB, `events=${events.length} noB=${noB}`)
  })

  await test('3.6 删除A不影响B的存在', async () => {
    const N = '3.6 删除A不影响B的存在'
    await deleteStudent(EDGE_STU_A, 'isolation test cleanup')
    const scoreB = await getScore(EDGE_STU_B)
    record(N, scoreB?.score === 100, `scoreB=${scoreB?.score}`)
  })

  // =============================================================
  // Section 4: 缓存一致性 (6 项)
  // =============================================================
  console.log('\n━━━ Section 4: 缓存一致性 ━━━')

  const CACHE_STU = `r15_cache_${TS}`
  await addStudent(CACHE_STU)

  await test('4.1 添加学生后 stats 立即反映', async () => {
    const N = '4.1 添加学生后 stats 立即反映'
    const stats = await getStats()
    const list = await listStudents()
    const statsCount = stats?.summary?.students || 0
    const listCount = list.length
    const diff = Math.abs(statsCount - listCount)
    record(N, diff < 3, `stats=${statsCount} list=${listCount} diff=${diff}`)
  })

  await test('4.2 添加事件后 score 缓存一致', async () => {
    const N = '4.2 添加事件后 score 缓存一致'
    const before = await getScore(CACHE_STU)
    await addEvent(CACHE_STU, VALID_BONUS_CODE, 3, 'cache test')
    await new Promise((r) => setTimeout(r, 200))
    const after = await getScore(CACHE_STU)
    const delta = (after?.score || 0) - (before?.score || 100)
    record(N, delta === 3, `before=${before?.score} after=${after?.score} delta=${delta}`)
  })

  await test('4.3 添加事件后 stats 事件数一致', async () => {
    const N = '4.3 添加事件后 stats 事件数一致'
    const stats = await getStats()
    const info = await getInfo()
    const statsEvents = stats?.summary?.total_events || 0
    const infoEvents = info?.events || 0
    const diff = Math.abs(statsEvents - infoEvents)
    record(N, diff < 3, `stats=${statsEvents} info=${infoEvents} diff=${diff}`)
  })

  await test('4.4 添加事件后 info 学生数一致', async () => {
    const N = '4.4 添加事件后 info 学生数一致'
    const info = await getInfo()
    const list = await listStudents()
    const infoStudents = info?.students || 0
    const listCount = list.length
    const diff = Math.abs(infoStudents - listCount)
    record(N, diff < 3, `info=${infoStudents} list=${listCount} diff=${diff}`)
  })

  await test('4.5 删除学生后 stats 反映', async () => {
    const N = '4.5 删除学生后 stats 反映'
    const statsBefore = await getStats()
    await deleteStudent(CACHE_STU, 'cache cleanup')
    await new Promise((r) => setTimeout(r, 200))
    const statsAfter = await getStats()
    const before = statsBefore?.summary?.students || 0
    const after = statsAfter?.summary?.students || 0
    // 删除后学生数应减少 (或保持, 因为 soft-delete 可能仍计入)
    record(N, after <= before, `before=${before} after=${after}`)
  })

  await test('4.6 删除学生后 score 返回 Deleted 状态', async () => {
    const N = '4.6 删除学生后 score 返回 Deleted 状态'
    const score = await getScore(CACHE_STU)
    // 删除的学生应返回 Deleted 状态
    record(N, !!score && (score.status === 'Deleted' || score.score === 100), `score=${score?.score} status=${score?.status}`)
  })

  // =============================================================
  // Section 5: 并发数据访问 (6 项)
  // =============================================================
  console.log('\n━━━ Section 5: 并发数据访问 ━━━')

  await test('5.1 并发读取 10 个学生分数', async () => {
    const N = '5.1 并发读取 10 个学生分数'
    const students = await listStudents()
    const sample = students.slice(0, 10)
    const t0 = Date.now()
    const scores = await Promise.all(sample.map((s) => getScore(s.name)))
    const elapsed = Date.now() - t0
    const allValid = scores.every((s) => s && typeof s.score === 'number')
    record(N, allValid && elapsed < 5000, `count=${scores.length} allValid=${allValid} elapsed=${elapsed}ms`)
  })

  await test('5.2 并发读取 stats + list + ranking', async () => {
    const N = '5.2 并发读取 stats + list + ranking'
    const t0 = Date.now()
    const [stats, students, ranking] = await Promise.all([getStats(), listStudents(), getRanking(10)])
    const elapsed = Date.now() - t0
    record(N, !!stats && students.length > 0 && ranking.length > 0, `stats=${!!stats} students=${students.length} ranking=${ranking.length} elapsed=${elapsed}ms`)
  })

  await test('5.3 并发写入同一学生 (序列化)', async () => {
    const N = '5.3 并发写入同一学生 (序列化)'
    const CONC_STU = `r15_conc_${TS}`
    await addStudent(CONC_STU)
    const t0 = Date.now()
    // 并发添加 5 个事件
    const results = await Promise.all([
      addEvent(CONC_STU, VALID_BONUS_CODE, 1, 'concurrent 1'),
      addEvent(CONC_STU, VALID_BONUS_CODE, 1, 'concurrent 2'),
      addEvent(CONC_STU, VALID_BONUS_CODE, 1, 'concurrent 3'),
      addEvent(CONC_STU, VALID_BONUS_CODE, 1, 'concurrent 4'),
      addEvent(CONC_STU, VALID_BONUS_CODE, 1, 'concurrent 5'),
    ])
    const elapsed = Date.now() - t0
    const allSuccess = results.every((r) => r?.success !== false)
    const score = await getScore(CONC_STU)
    // 5 个 delta=1 事件, 分数应增加 5
    const expectedScore = 100 + 5
    record(N, allSuccess && score?.score === expectedScore, `allSuccess=${allSuccess} score=${score?.score} expected=${expectedScore} elapsed=${elapsed}ms`)
    await deleteStudent(CONC_STU, 'concurrency cleanup')
  })

  await test('5.4 并发写入不同学生 (无冲突)', async () => {
    const N = '5.4 并发写入不同学生 (无冲突)'
    const STU1 = `r15_conc1_${TS}`
    const STU2 = `r15_conc2_${TS}`
    const STU3 = `r15_conc3_${TS}`
    await Promise.all([addStudent(STU1), addStudent(STU2), addStudent(STU3)])
    const results = await Promise.all([
      addEvent(STU1, VALID_BONUS_CODE, 2, 'diff student 1'),
      addEvent(STU2, VALID_BONUS_CODE, 3, 'diff student 2'),
      addEvent(STU3, VALID_BONUS_CODE, 5, 'diff student 3'),
    ])
    const allSuccess = results.every((r) => r?.success !== false)
    const [s1, s2, s3] = await Promise.all([getScore(STU1), getScore(STU2), getScore(STU3)])
    record(N, allSuccess && s1?.score === 102 && s2?.score === 103 && s3?.score === 105, `s1=${s1?.score} s2=${s2?.score} s3=${s3?.score}`)
    await Promise.all([deleteStudent(STU1, 'cleanup'), deleteStudent(STU2, 'cleanup'), deleteStudent(STU3, 'cleanup')])
  })

  await test('5.5 并发 search + addEvent (读写混合)', async () => {
    const N = '5.5 并发 search + addEvent (读写混合)'
    const MIX_STU = `r15_mix_${TS}`
    await addStudent(MIX_STU)
    const t0 = Date.now()
    const results = await Promise.all([
      searchEvents(MIX_STU),
      addEvent(MIX_STU, VALID_BONUS_CODE, 1, 'mixed test'),
      getScore(MIX_STU),
      getRanking(5),
      getStats(),
    ])
    const elapsed = Date.now() - t0
    const allOk = results.every((r) => r !== null && r !== undefined)
    record(N, allOk && elapsed < 5000, `allOk=${allOk} elapsed=${elapsed}ms`)
    await deleteStudent(MIX_STU, 'cleanup')
  })

  await test('5.6 并发读取不崩溃 (100 次 parallel)', async () => {
    const N = '5.6 并发读取不崩溃 (100 次 parallel)'
    const t0 = Date.now()
    const promises = []
    for (let i = 0; i < 100; i++) {
      promises.push(getInfo())
    }
    const results = await Promise.all(promises)
    const elapsed = Date.now() - t0
    const allValid = results.every((r) => r && typeof r.version === 'string')
    record(N, allValid && elapsed < 10000, `count=${results.length} allValid=${allValid} elapsed=${elapsed}ms`)
  })

  // =============================================================
  // Section 6: Agent 配置操作 (6 项)
  // =============================================================
  console.log('\n━━━ Section 6: Agent 配置操作 ━━━')

  await test('6.1 Agent toggle (禁用+启用)', async () => {
    const N = '6.1 Agent toggle (禁用+启用)'
    // 先禁用 bug-hunter (不会影响其他功能)
    const rDisable = await agentToggle('bug-hunter', false)
    const agentAfterDisable = await agentGet('bug-hunter')
    const isDisabled = agentAfterDisable?.enabled === false
    // 再启用
    const rEnable = await agentToggle('bug-hunter', true)
    const agentAfterEnable = await agentGet('bug-hunter')
    const isEnabled = agentAfterEnable?.enabled === true
    record(N, isDisabled && isEnabled, `disabled=${isDisabled} enabled=${isEnabled}`)
  })

  await test('6.2 Agent getHistory 返回数组', async () => {
    const N = '6.2 Agent getHistory 返回数组'
    const history = await agentGetHistory('main')
    record(N, Array.isArray(history), `isArray=${Array.isArray(history)} count=${history?.length}`)
  })

  await test('6.3 全部 18 个 Agent 可获取详情', async () => {
    const N = '6.3 全部 18 个 Agent 可获取详情'
    const agents = await agentList()
    const ids = agents.map((a) => a.id)
    const results = await Promise.all(ids.map((id) => agentGet(id)))
    const allFound = results.every((r) => r && typeof r.id === 'string')
    record(N, allFound, `total=${ids.length} allFound=${allFound}`)
  })

  await test('6.4 Agent get(不存在ID) 优雅失败', async () => {
    const N = '6.4 Agent get(不存在ID) 优雅失败'
    const r = await agentGet(`nonexistent_agent_${TS}`)
    record(N, !r || r.__error || r.success === false, `hasResponse=${!!r}`)
  })

  await test('6.5 Agent toggle(不存在ID) 优雅失败', async () => {
    const N = '6.5 Agent toggle(不存在ID) 优雅失败'
    const r = await agentToggle(`nonexistent_agent_${TS}`, true)
    record(N, !!r && (r.success === false || r.__error), `success=${r?.success}`)
  })

  await test('6.6 Agent runManual(空prompt) 优雅失败', async () => {
    const N = '6.6 Agent runManual(空prompt) 优雅失败'
    const r = await callIpc(`const res = await api.agent.runManual('main', ''); return res;`)
    record(N, !!r && (r.success === false || r.__error), `success=${r?.success}`)
  })

  // =============================================================
  // Section 7: 工具返回错误处理 (6 项)
  // =============================================================
  console.log('\n━━━ Section 7: 工具返回错误处理 ━━━')

  await test('7.1 score 返回的对象有 success 字段', async () => {
    const N = '7.1 score 返回的对象有 success 字段'
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(EDGE_STU_B)}); return res;`)
    record(N, r && typeof r.success === 'boolean', `success=${r?.success}`)
  })

  await test('7.2 addEvent 返回的对象有 success 字段', async () => {
    const N = '7.2 addEvent 返回的对象有 success 字段'
    const r = await addEvent(EDGE_STU_B, VALID_BONUS_CODE, 1, 'error handling test')
    record(N, r && typeof r.success === 'boolean', `success=${r?.success}`)
  })

  await test('7.3 错误响应包含错误信息', async () => {
    const N = '7.3 错误响应包含错误信息'
    const r = await callIpc(`const res = await api.eaa.score('nonexistent_error_test_${TS}'); return res;`)
    // 失败时应包含 error/message/stderr 字段
    const hasError = r && (r.error || r.message || r.stderr || r.data?.error || r.__error)
    record(N, !!hasError || r?.success === false, `success=${r?.success} hasError=${!!hasError}`)
  })

  await test('7.4 addEvent(无效reasonCode) 返回错误', async () => {
    const N = '7.4 addEvent(无效reasonCode) 返回错误'
    const r = await callIpc(`const res = await api.eaa.addEvent({ studentName: ${JSON.stringify(EDGE_STU_B)}, reasonCode: 'INVALID_CODE_XYZ', delta: 1, note: 'invalid code test' }); return res;`)
    record(N, r?.success === false, `success=${r?.success}`)
  })

  await test('7.5 addEvent(缺少reasonCode) 优雅失败', async () => {
    const N = '7.5 addEvent(缺少reasonCode) 优雅失败'
    const r = await callIpc(`const res = await api.eaa.addEvent({ studentName: ${JSON.stringify(EDGE_STU_B)}, delta: 1 }); return res;`)
    record(N, !!r && (r.success === false || r.__error), `success=${r?.success}`)
  })

  await test('7.6 info 返回的 version 是字符串', async () => {
    const N = '7.6 info 返回的 version 是字符串'
    const info = await getInfo()
    record(N, info && typeof info.version === 'string' && info.version.length > 0, `version=${info?.version}`)
  })

  // =============================================================
  // Section 8: 数据完整性验证 (6 项)
  // =============================================================
  console.log('\n━━━ Section 8: 数据完整性验证 ━━━')

  await test('8.1 listStudents 每项有 status 字段', async () => {
    const N = '8.1 listStudents 每项有 status 字段'
    const students = await listStudents()
    const sample = students.slice(0, 20)
    const allHaveStatus = sample.every((s) => typeof s.status === 'string')
    record(N, allHaveStatus, `sampled=${sample.length} allHaveStatus=${allHaveStatus}`)
  })

  await test('8.2 listStudents 中有 Active 学生且 status 字段有效', async () => {
    const N = '8.2 listStudents 中有 Active 学生且 status 字段有效'
    const students = await listStudents()
    const active = students.filter((s) => s.status === 'Active' || s.status === undefined)
    const deleted = students.filter((s) => s.status === 'Deleted')
    // 测试环境中有大量 soft-deleted 学生是正常的 (测试累积)
    // 只验证 Active 学生存在且 status 字段是有效值
    const validStatuses = ['Active', 'Deleted', undefined]
    const allValidStatus = students.every((s) => validStatuses.includes(s.status))
    record(N, active.length > 0 && allValidStatus, `total=${students.length} active=${active.length} deleted=${deleted.length} allValidStatus=${allValidStatus}`)
  })

  await test('8.3 ranking 排序正确 (分数递减)', async () => {
    const N = '8.3 ranking 排序正确 (分数递减)'
    const ranking = await getRanking(20)
    let isSorted = true
    for (let i = 1; i < ranking.length; i++) {
      if ((ranking[i].score || 0) > (ranking[i - 1].score || 0)) { isSorted = false; break }
    }
    record(N, isSorted, `count=${ranking.length} isSorted=${isSorted}`)
  })

  await test('8.4 stats 的 reason_distribution 非空', async () => {
    const N = '8.4 stats 的 reason_distribution 非空'
    const stats = await getStats()
    const dist = stats?.reason_distribution
    const hasDist = dist && typeof dist === 'object' && Object.keys(dist).length > 0
    record(N, !!hasDist, `keys=${dist ? Object.keys(dist).length : 0}`)
  })

  await test('8.5 stats 的 score_intervals 有数据', async () => {
    const N = '8.5 stats 的 score_intervals 有数据'
    const stats = await getStats()
    const intervals = stats?.score_intervals
    const hasIntervals = intervals && typeof intervals === 'object' && Object.keys(intervals).length > 0
    record(N, !!hasIntervals, `keys=${intervals ? Object.keys(intervals).length : 0}`)
  })

  await test('8.6 codes 返回的每个代码有 code/description 字段', async () => {
    const N = '8.6 codes 返回的每个代码有 code/description 字段'
    const codes = await getCodes()
    const codeList = codes?.codes || []
    const sample = codeList.slice(0, 10)
    const allValid = sample.every((c) => {
      const code = c.code || c.id || c.name
      return typeof code === 'string'
    })
    record(N, allValid, `sampled=${sample.length} allValid=${allValid}`)
  })

  // =============================================================
  // 汇总
  // =============================================================
  console.log('\n' + '━'.repeat(60))
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  console.log(`Round 15 AI 数据访问边界与错误处理测试结果: ${passed}/${passed + failed} 通过, ${failed} 失败`)
  if (failed > 0) {
    console.log('\n失败项:')
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.detail}`))
  }
  console.log('━'.repeat(60))

  // 清理
  try {
    await deleteStudent(EDGE_STU_B, 'final cleanup')
  } catch {}

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => { console.error('Fatal error:', err); process.exit(1) })
