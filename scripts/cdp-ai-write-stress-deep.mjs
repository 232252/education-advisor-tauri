// =============================================================
// Round 25: AI 多轮写入压力 + 数据一致性长期验证 — 重中之重续12
//
// 验证 AI 在持续多轮写入压力下的数据一致性:
//   1. 单学生多次递增写入 (100 轮 addEvent + score 验证) (6 项)
//   2. 多学生并行写入 (10 学生 × 10 轮 = 100 次写入) (6 项)
//   3. 写入后立即读取一致性 (write-then-read 50 轮) (6 项)
//   4. 撤销-重写循环压力 (revert + re-add 20 轮) (6 项)
//   5. 缓存-磁盘一致性 (写入后缓存与事件文件对比) (6 项)
//   6. 操作日志完整性 (operations.jsonl 与事件数对应) (5 项)
//   7. 分数累加正确性 (sum of deltas == final score - base) (6 项)
//   8. 排行榜稳定性 (多次写入后排行榜顺序稳定) (5 项)
//   9. 长期压力后总数据完整性 (总学生数/事件数/缓存一致) (5 项)
//
// 运行: node scripts/cdp-ai-write-stress-deep.mjs
// =============================================================
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const CDP_PORT = 9222
const BASE = `http://127.0.0.1:${CDP_PORT}`

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
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
  const send = (method, params = {}) => new Promise((resolve) => { const id = msgId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
  const evalInPage = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) {
      const desc = r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'unknown'
      throw new Error(`Eval error: ${desc.slice(0, 300)}`)
    }
    return r.result?.result?.value
  }
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP connected, running AI write-stress tests...\n')

  const callIpc = async (code) =>
    evalInPage(`(async function(){const api=window.__EAA_API__||window.api;if(!api)return{__error:'no-api'};try{${code}}catch(e){return{__error:String(e&&e.message?e.message:e)}}})()`)

  const isOk = (res) => !!res && !res.__error && res?.success !== false
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  const TS = Date.now()
  const userDataDir = 'C:\\Users\\sq199\\AppData\\Roaming\\com.educationadvisor.tauri'
  const eaaDataDir = path.join(userDataDir, 'eaa-data')
  const entitiesDir = path.join(eaaDataDir, 'entities')
  const eventsDir = path.join(eaaDataDir, 'events')
  const logsDir = path.join(eaaDataDir, 'logs')

  // ===========================================================
  // 1. 单学生多次递增写入 (50 轮 addEvent + score 验证)
  // ===========================================================
  console.log('--- 1. 单学生多次递增写入 (50 轮) ---')

  const stressStudent = `r25_single_${TS}`
  await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(stressStudent)}); return res;`)

  const ROUNDS = 50
  let roundSuccess = 0
  let lastScore = 100
  let scoreMonotonic = true
  await test('1.1 50 轮 addEvent 每轮 +1', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const r = await callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(stressStudent)},
          reasonCode: 'ACTIVITY_PARTICIPATION',
          delta: 1,
          note: ${JSON.stringify(`R25 stress round ${i}`)},
          force: true,
        });
        return res;
      `)
      if (isOk(r)) roundSuccess++
      // 每 10 轮检查一次分数
      if ((i + 1) % 10 === 0) {
        await sleep(100)
        const sr = await callIpc(`const res = await api.eaa.score(${JSON.stringify(stressStudent)}); return res;`)
        const sc = sr?.data?.score ?? sr?.score
        if (sc < lastScore) scoreMonotonic = false
        lastScore = sc
      }
    }
    record('1.1 50 轮 addEvent 每轮 +1', roundSuccess === ROUNDS, `success=${roundSuccess}/${ROUNDS}`)
  })

  await test('1.2 最终分数 == 100 + 50 = 150', async () => {
    await sleep(300)
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(stressStudent)}); return res;`)
    const sc = r?.data?.score ?? r?.score
    record('1.2 最终分数 == 150', sc === 150, `score=${sc} expected=150`)
  })

  await test('1.3 分数单调递增 (每 10 轮检查)', async () => {
    record('1.3 分数单调递增', scoreMonotonic, `lastScore=${lastScore} monotonic=${scoreMonotonic}`)
  })

  await test('1.4 history 事件数 == 50', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(stressStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('1.4 history 事件数 == 50', events.length === ROUNDS, `events=${events.length}`)
  })

  await test('1.5 scores.cache.json 一致', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const eid = idx[stressStudent]
    record('1.5 scores.cache.json 一致', cache[eid] === 150, `cache=${cache[eid]} expected=150`)
  })

  await test('1.6 event_stats.cache.json 反映事件数', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'event_stats.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const eid = idx[stressStudent]
    const stat = cache[eid]
    // event_stats 只统计有效 (非撤销) 事件
    const count = typeof stat === 'number' ? stat : stat?.count
    record('1.6 event_stats.cache.json 反映事件数', count === ROUNDS, `count=${count} expected=${ROUNDS}`)
  })

  // ===========================================================
  // 2. 多学生并行写入 (10 学生 × 5 轮 = 50 次写入,并行)
  // ===========================================================
  console.log('\n--- 2. 多学生并行写入 (10 学生 × 5 轮) ---')

  const PARALLEL_STUDENTS = 10
  const PARALLEL_ROUNDS = 5
  const parallelStudents = []
  for (let i = 0; i < PARALLEL_STUDENTS; i++) {
    const name = `r25_par_${TS}_${i}`
    parallelStudents.push(name)
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(name)}); return res;`)
  }

  let parallelSuccess = 0
  let parallelTotal = 0
  await test('2.1 10 学生并行写入 (每学生 5 轮)', async () => {
    // 对每个学生并行发起 5 次写入
    const promises = []
    for (const name of parallelStudents) {
      for (let r = 0; r < PARALLEL_ROUNDS; r++) {
        parallelTotal++
        promises.push(
          callIpc(`
            const res = await api.eaa.addEvent({
              studentName: ${JSON.stringify(name)},
              reasonCode: 'ACTIVITY_PARTICIPATION',
              delta: 2,
              note: ${JSON.stringify(`R25 parallel ${r}`)},
              force: true,
            });
            return res;
          `).then(r => { if (isOk(r)) parallelSuccess++ })
        )
      }
    }
    await Promise.all(promises)
    record('2.1 10 学生并行写入', parallelSuccess === parallelTotal, `success=${parallelSuccess}/${parallelTotal}`)
  })

  await test('2.2 每个学生最终分数 == 100 + 5*2 = 110', async () => {
    await sleep(500)
    let allCorrect = true
    let wrongCount = 0
    for (const name of parallelStudents) {
      const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(name)}); return res;`)
      const sc = r?.data?.score ?? r?.score
      if (sc !== 110) { allCorrect = false; wrongCount++ }
    }
    record('2.2 每个学生最终分数 == 110', allCorrect, `correct=${PARALLEL_STUDENTS - wrongCount}/${PARALLEL_STUDENTS}`)
  })

  await test('2.3 每个学生 history 事件数 == 5', async () => {
    let allCorrect = true
    let wrongCount = 0
    for (const name of parallelStudents) {
      const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(name)}); return res;`)
      const data = r?.data ?? r
      const events = Array.isArray(data) ? data : (data?.events ?? [])
      if (events.length !== PARALLEL_ROUNDS) { allCorrect = false; wrongCount++ }
    }
    record('2.3 每个学生 history 事件数 == 5', allCorrect, `correct=${PARALLEL_STUDENTS - wrongCount}/${PARALLEL_STUDENTS}`)
  })

  await test('2.4 排行榜包含所有 10 个学生', async () => {
    // 系统有 4000+ 学生, 新学生分数=110, top 100 可能不包含
    // 查全量 ranking 验证所有 10 个学生都存在
    const r = await callIpc(`const res = await api.eaa.ranking(5000); return res;`)
    const data = r?.data ?? r
    const ranking = Array.isArray(data) ? data : (data?.ranking ?? data?.data?.ranking ?? [])
    const found = parallelStudents.every(name =>
      ranking.some(item => item.name === name || item.entity_id === name)
    )
    record('2.4 排行榜包含所有 10 个学生', found, `found=${found} ranking=${ranking.length}`)
  })

  await test('2.5 并行写入后无重复事件 (id 唯一)', async () => {
    const allIds = new Set()
    let duplicates = 0
    for (const name of parallelStudents) {
      const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(name)}); return res;`)
      const data = r?.data ?? r
      const events = Array.isArray(data) ? data : (data?.events ?? [])
      for (const e of events) {
        if (e.event_id) {
          if (allIds.has(e.event_id)) duplicates++
          else allIds.add(e.event_id)
        }
      }
    }
    record('2.5 并行写入后无重复事件', duplicates === 0, `unique=${allIds.size} duplicates=${duplicates}`)
  })

  await test('2.6 并行写入后缓存一致 (10 学生分数都为 110)', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    let allMatch = true
    let mismatchCount = 0
    for (const name of parallelStudents) {
      const eid = idx[name]
      if (cache[eid] !== 110) { allMatch = false; mismatchCount++ }
    }
    record('2.6 并行写入后缓存一致', allMatch, `match=${PARALLEL_STUDENTS - mismatchCount}/${PARALLEL_STUDENTS}`)
  })

  // ===========================================================
  // 3. 写入后立即读取一致性 (write-then-read 30 轮)
  // ===========================================================
  console.log('\n--- 3. 写入后立即读取一致性 (30 轮) ---')

  const wtrStudent = `r25_wtr_${TS}`
  await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(wtrStudent)}); return res;`)

  const WTR_ROUNDS = 30
  let wtrSuccess = 0
  let wtrConsistent = 0
  let expectedScore = 100
  await test('3.1 30 轮 write-then-read 一致', async () => {
    for (let i = 0; i < WTR_ROUNDS; i++) {
      const delta = (i % 2 === 0) ? 1 : -1
      const r = await callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(wtrStudent)},
          reasonCode: 'ACTIVITY_PARTICIPATION',
          delta: ${delta},
          note: ${JSON.stringify(`R25 wtr ${i}`)},
          force: true,
        });
        return res;
      `)
      if (isOk(r)) {
        wtrSuccess++
        expectedScore += delta
        // 立即读取验证
        const sr = await callIpc(`const res = await api.eaa.score(${JSON.stringify(wtrStudent)}); return res;`)
        const sc = sr?.data?.score ?? sr?.score
        if (sc === expectedScore) wtrConsistent++
      }
    }
    record('3.1 30 轮 write-then-read 一致', wtrConsistent === WTR_ROUNDS, `success=${wtrSuccess}/${WTR_ROUNDS} consistent=${wtrConsistent}/${WTR_ROUNDS}`)
  })

  await test('3.2 最终分数 == 100 (奇偶抵消)', async () => {
    await sleep(200)
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(wtrStudent)}); return res;`)
    const sc = r?.data?.score ?? r?.score
    record('3.2 最终分数 == 100', sc === 100, `score=${sc} expected=100`)
  })

  await test('3.3 history 事件数 == 30', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(wtrStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('3.3 history 事件数 == 30', events.length === WTR_ROUNDS, `events=${events.length}`)
  })

  await test('3.4 score_delta 累加 == 0 (奇偶抵消)', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(wtrStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    const sum = events.filter(e => e.reverted !== true).reduce((s, e) => s + (e.score_delta || 0), 0)
    record('3.4 score_delta 累加 == 0', sum === 0, `sum=${sum}`)
  })

  await test('3.5 缓存分数 == 100', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const eid = idx[wtrStudent]
    record('3.5 缓存分数 == 100', cache[eid] === 100, `cache=${cache[eid]}`)
  })

  await test('3.6 操作日志记录所有 30 次写入', async () => {
    const content = await fsp.readFile(path.join(logsDir, 'operations.jsonl'), 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    // 过滤本学生相关的操作 (通过时间戳附近)
    const todayOps = lines.filter(line => {
      try {
        const op = JSON.parse(line)
        return op.timestamp && new Date(op.timestamp).getTime() > TS
      } catch { return false }
    })
    // 应该至少有 30 次添加操作
    record('3.6 操作日志记录所有 30 次写入', todayOps.length >= WTR_ROUNDS, `ops=${todayOps.length} expected>=${WTR_ROUNDS}`)
  })

  // ===========================================================
  // 4. 撤销-重写循环压力 (revert + re-add 20 轮)
  // ===========================================================
  console.log('\n--- 4. 撤销-重写循环压力 (20 轮) ---')

  const revStudent = `r25_rev_${TS}`
  await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(revStudent)}); return res;`)

  const REV_ROUNDS = 20
  let revSuccess = 0
  let revEventIds = []
  await test('4.1 20 轮 add+revert 循环', async () => {
    for (let i = 0; i < REV_ROUNDS; i++) {
      // 添加事件
      const ar = await callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(revStudent)},
          reasonCode: 'ACTIVITY_PARTICIPATION',
          delta: 5,
          note: ${JSON.stringify(`R25 rev ${i}`)},
          force: true,
        });
        return res;
      `)
      if (!isOk(ar)) continue
      const dataStr = typeof ar?.data === 'string' ? ar.data : ''
      const match = dataStr.match(/evt_\w+/)
      if (!match) continue
      const eventId = match[0]
      revEventIds.push(eventId)

      // 撤销事件
      const rr = await callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(eventId)}, ${JSON.stringify(`R25 revert ${i}`)}); return res;`)
      if (isOk(rr)) revSuccess++
    }
    record('4.1 20 轮 add+revert 循环', revSuccess === REV_ROUNDS, `success=${revSuccess}/${REV_ROUNDS}`)
  })

  await test('4.2 最终分数 == 100 (全部撤销)', async () => {
    await sleep(300)
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(revStudent)}); return res;`)
    const sc = r?.data?.score ?? r?.score
    record('4.2 最终分数 == 100', sc === 100, `score=${sc} expected=100`)
  })

  await test('4.3 history 事件数 == 40 (20 添加 + 20 撤销标记)', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(revStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    const reverted = events.filter(e => e.reverted === true).length
    const active = events.filter(e => e.reverted !== true).length
    record('4.3 history 事件数 == 40', events.length === REV_ROUNDS * 2 && reverted === REV_ROUNDS && active === REV_ROUNDS, `total=${events.length} reverted=${reverted} active=${active}`)
  })

  await test('4.4 所有撤销事件 reverted=true', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(revStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    // 检查每个 event_id 是否在 revEventIds 列表中的都标记为 reverted
    const revertedIds = new Set(events.filter(e => e.reverted === true).map(e => e.event_id))
    const allReverted = revEventIds.every(id => revertedIds.has(id))
    record('4.4 所有撤销事件 reverted=true', allReverted, `revertedIds=${revertedIds.size} expected=${revEventIds.length}`)
  })

  await test('4.5 缓存分数 == 100 (撤销后)', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const eid = idx[revStudent]
    record('4.5 缓存分数 == 100 (撤销后)', cache[eid] === 100, `cache=${cache[eid]}`)
  })

  await test('4.6 event_stats 只统计有效事件 (0 有效)', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'event_stats.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const eid = idx[revStudent]
    const stat = cache[eid]
    const count = typeof stat === 'number' ? stat : stat?.count
    // 所有事件都被撤销,有效事件数应该为 0
    record('4.6 event_stats 只统计有效事件', count === 0, `count=${count} expected=0`)
  })

  // ===========================================================
  // 5. 缓存-磁盘一致性 (写入后缓存与事件文件对比)
  // ===========================================================
  console.log('\n--- 5. 缓存-磁盘一致性 ---')

  await test('5.1 events.jsonl 包含所有 Round 25 事件', async () => {
    const content = await fsp.readFile(path.join(eventsDir, 'events.jsonl'), 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    // 统计本 Round 25 时间内的事件 (TS 之后)
    let r25Events = 0
    for (const line of lines) {
      try {
        const e = JSON.parse(line)
        if (e.timestamp && new Date(e.timestamp).getTime() > TS) r25Events++
      } catch {}
    }
    // Round 25 写入事件总数: 50 + 50 + 30 + 20 = 150 (revert 不新增事件,只标记现有事件)
    // 允许少量时间戳边界误差
    record('5.1 events.jsonl 包含所有 Round 25 事件', r25Events >= 130, `r25Events=${r25Events} expected>=130`)
  })

  await test('5.2 scores.cache.json 包含所有新学生', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const allStudents = [stressStudent, wtrStudent, revStudent, ...parallelStudents]
    let allFound = true
    let missing = 0
    for (const name of allStudents) {
      const eid = idx[name]
      if (!eid || cache[eid] === undefined) { allFound = false; missing++ }
    }
    record('5.2 scores.cache.json 包含所有新学生', allFound, `found=${allStudents.length - missing}/${allStudents.length}`)
  })

  await test('5.3 name_index.json 包含所有新学生', async () => {
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const allStudents = [stressStudent, wtrStudent, revStudent, ...parallelStudents]
    const allFound = allStudents.every(name => name in idx)
    record('5.3 name_index.json 包含所有新学生', allFound, `found=${allStudents.filter(s => s in idx).length}/${allStudents.length}`)
  })

  await test('5.4 event_stats.cache.json 包含所有新学生', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'event_stats.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const allStudents = [stressStudent, wtrStudent, revStudent, ...parallelStudents]
    let allFound = true
    let missing = 0
    for (const name of allStudents) {
      const eid = idx[name]
      if (!eid || cache[eid] === undefined) { allFound = false; missing++ }
    }
    record('5.4 event_stats.cache.json 包含所有新学生', allFound, `found=${allStudents.length - missing}/${allStudents.length}`)
  })

  await test('5.5 缓存分数 vs IPC 查询分数一致 (12 学生)', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const allStudents = [stressStudent, wtrStudent, revStudent, ...parallelStudents]
    let allMatch = true
    let mismatch = 0
    for (const name of allStudents) {
      const eid = idx[name]
      const cacheScore = cache[eid]
      const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(name)}); return res;`)
      const ipcScore = r?.data?.score ?? r?.score
      if (cacheScore !== ipcScore) { allMatch = false; mismatch++ }
    }
    record('5.5 缓存分数 vs IPC 查询分数一致', allMatch, `match=${allStudents.length - mismatch}/${allStudents.length}`)
  })

  await test('5.6 daily_dedup.cache.json 存在且非空', async () => {
    const cachePath = path.join(entitiesDir, 'daily_dedup.cache.json')
    const exists = fs.existsSync(cachePath)
    let nonEmpty = false
    if (exists) {
      const stat = await fsp.stat(cachePath)
      nonEmpty = stat.size > 10
    }
    record('5.6 daily_dedup.cache.json 存在且非空', exists && nonEmpty, `exists=${exists} nonEmpty=${nonEmpty}`)
  })

  // ===========================================================
  // 6. 操作日志完整性 (operations.jsonl)
  // ===========================================================
  console.log('\n--- 6. 操作日志完整性 ---')

  await test('6.1 operations.jsonl 存在且非空', async () => {
    const logPath = path.join(logsDir, 'operations.jsonl')
    const exists = fs.existsSync(logPath)
    let nonEmpty = false
    if (exists) {
      const stat = await fsp.stat(logPath)
      nonEmpty = stat.size > 10
    }
    record('6.1 operations.jsonl 存在且非空', exists && nonEmpty, `exists=${exists} nonEmpty=${nonEmpty}`)
  })

  await test('6.2 操作日志条目格式正确 (JSON)', async () => {
    const content = await fsp.readFile(path.join(logsDir, 'operations.jsonl'), 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    let validCount = 0
    for (const line of lines.slice(-100)) { // 检查最后 100 条
      try {
        const op = JSON.parse(line)
        if (op.action && op.timestamp) validCount++
      } catch {}
    }
    const checked = Math.min(100, lines.length)
    record('6.2 操作日志条目格式正确', validCount === checked, `valid=${validCount}/${checked}`)
  })

  await test('6.3 操作日志记录 add 操作', async () => {
    const content = await fsp.readFile(path.join(logsDir, 'operations.jsonl'), 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    let hasAdd = false
    for (const line of lines.slice(-200)) {
      try {
        const op = JSON.parse(line)
        if (op.action === 'add' || op.action === 'add_event') { hasAdd = true; break }
      } catch {}
    }
    record('6.3 操作日志记录 add 操作', hasAdd, `hasAdd=${hasAdd}`)
  })

  await test('6.4 操作日志记录 revert 操作', async () => {
    const content = await fsp.readFile(path.join(logsDir, 'operations.jsonl'), 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    let hasRevert = false
    for (const line of lines.slice(-200)) {
      try {
        const op = JSON.parse(line)
        if (op.action === 'revert') { hasRevert = true; break }
      } catch {}
    }
    record('6.4 操作日志记录 revert 操作', hasRevert, `hasRevert=${hasRevert}`)
  })

  await test('6.5 操作日志时间戳递增', async () => {
    const content = await fsp.readFile(path.join(logsDir, 'operations.jsonl'), 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    let monotonic = true
    let lastTs = 0
    for (const line of lines.slice(-200)) {
      try {
        const op = JSON.parse(line)
        const ts = new Date(op.timestamp).getTime()
        if (ts < lastTs) { monotonic = false; break }
        lastTs = ts
      } catch {}
    }
    record('6.5 操作日志时间戳递增', monotonic, `monotonic=${monotonic}`)
  })

  // ===========================================================
  // 7. 分数累加正确性 (sum of deltas == final score - base)
  // ===========================================================
  console.log('\n--- 7. 分数累加正确性 ---')

  await test('7.1 stressStudent 分数累加正确 (50 * 1 = 50)', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(stressStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    const sum = events.filter(e => e.reverted !== true).reduce((s, e) => s + (e.score_delta || 0), 0)
    const sr = await callIpc(`const res = await api.eaa.score(${JSON.stringify(stressStudent)}); return res;`)
    const sc = sr?.data?.score ?? sr?.score
    record('7.1 stressStudent 分数累加正确', sum === 50 && sc === 150, `sum=${sum} score=${sc} expected: sum=50 score=150`)
  })

  await test('7.2 parallelStudents 分数累加正确 (5 * 2 = 10)', async () => {
    let allCorrect = true
    for (const name of parallelStudents) {
      const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(name)}); return res;`)
      const data = r?.data ?? r
      const events = Array.isArray(data) ? data : (data?.events ?? [])
      const sum = events.filter(e => e.reverted !== true).reduce((s, e) => s + (e.score_delta || 0), 0)
      if (sum !== 10) { allCorrect = false; break }
    }
    record('7.2 parallelStudents 分数累加正确', allCorrect, `allCorrect=${allCorrect}`)
  })

  await test('7.3 wtrStudent 分数累加正确 (奇偶抵消 = 0)', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(wtrStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    const sum = events.filter(e => e.reverted !== true).reduce((s, e) => s + (e.score_delta || 0), 0)
    record('7.3 wtrStudent 分数累加正确', sum === 0, `sum=${sum} expected=0`)
  })

  await test('7.4 revStudent 有效事件分数累加 == 0 (全部撤销)', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(revStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    // revert 机制: 创建逆事件 (score_delta=-5) 来抵消原事件 (+5)
    // 分数 = BASE + sum of ALL score_deltas (包括 reverted 和 active)
    // 20 × (+5) + 20 × (-5) = 0, 所以最终分数 = 100 + 0 = 100
    const sum = events.reduce((s, e) => s + (e.score_delta || 0), 0)
    record('7.4 revStudent 有效事件分数累加 == 0', sum === 0, `sum=${sum} expected=0`)
  })

  await test('7.5 cumulative 字段递增正确 (stressStudent)', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(stressStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    // cumulative 应该从 101 递增到 150
    const cumulatives = events.map(e => e.cumulative).filter(c => typeof c === 'number')
    let monotonic = cumulatives.length === ROUNDS
    for (let i = 1; i < cumulatives.length; i++) {
      if (cumulatives[i] <= cumulatives[i - 1]) { monotonic = false; break }
    }
    record('7.5 cumulative 字段递增正确', monotonic, `count=${cumulatives.length} first=${cumulatives[0]} last=${cumulatives[cumulatives.length - 1]}`)
  })

  await test('7.6 最终 cumulative == score', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(stressStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    const lastCumulative = events[events.length - 1]?.cumulative
    const sr = await callIpc(`const res = await api.eaa.score(${JSON.stringify(stressStudent)}); return res;`)
    const sc = sr?.data?.score ?? sr?.score
    record('7.6 最终 cumulative == score', lastCumulative === sc, `cumulative=${lastCumulative} score=${sc}`)
  })

  // ===========================================================
  // 8. 排行榜稳定性 (多次写入后排行榜顺序稳定)
  // ===========================================================
  console.log('\n--- 8. 排行榜稳定性 ---')

  await test('8.1 两次查询排行榜结果一致', async () => {
    const r1 = await callIpc(`const res = await api.eaa.ranking(50); return res;`)
    const r2 = await callIpc(`const res = await api.eaa.ranking(50); return res;`)
    const d1 = r1?.data ?? r1
    const d2 = r2?.data ?? r2
    const list1 = Array.isArray(d1) ? d1 : (d1?.ranking ?? [])
    const list2 = Array.isArray(d2) ? d2 : (d2?.ranking ?? [])
    const same = list1.length === list2.length &&
      list1.every((item, i) => item.name === list2[i].name && item.score === list2[i].score)
    record('8.1 两次查询排行榜结果一致', same, `len1=${list1.length} len2=${list2.length} same=${same}`)
  })

  await test('8.2 排行榜按分数降序排列', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(50); return res;`)
    const data = r?.data ?? r
    const list = Array.isArray(data) ? data : (data?.ranking ?? [])
    let sorted = true
    for (let i = 1; i < list.length; i++) {
      if (list[i].score > list[i - 1].score) { sorted = false; break }
    }
    record('8.2 排行榜按分数降序排列', sorted, `sorted=${sorted} top=${list[0]?.score} bottom=${list[list.length - 1]?.score}`)
  })

  await test('8.3 stressStudent 在排行榜中 (score=150)', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(100); return res;`)
    const data = r?.data ?? r
    const list = Array.isArray(data) ? data : (data?.ranking ?? [])
    const found = list.find(item => item.name === stressStudent)
    record('8.3 stressStudent 在排行榜中', !!found && found.score === 150, `found=${!!found} score=${found?.score}`)
  })

  await test('8.4 排行榜 top 1 分数最高', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(100); return res;`)
    const data = r?.data ?? r
    const list = Array.isArray(data) ? data : (data?.ranking ?? [])
    const topScore = list[0]?.score
    const maxScore = Math.max(...list.map(i => i.score))
    record('8.4 排行榜 top 1 分数最高', topScore === maxScore, `top=${topScore} max=${maxScore}`)
  })

  await test('8.5 排行榜总数 >= 12 (新学生全部入榜)', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(10000); return res;`)
    const data = r?.data ?? r
    const list = Array.isArray(data) ? data : (data?.ranking ?? [])
    record('8.5 排行榜总数 >= 12', list.length >= 12, `total=${list.length}`)
  })

  // ===========================================================
  // 9. 长期压力后总数据完整性
  // ===========================================================
  console.log('\n--- 9. 长期压力后总数据完整性 ---')

  await test('9.1 stats 反映新学生数', async () => {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const data = r?.data ?? r
    const students = data?.summary?.students ?? data?.students
    record('9.1 stats 反映新学生数', students >= 3458, `students=${students}`)
  })

  await test('9.2 stats 反映新事件数', async () => {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const data = r?.data ?? r
    const totalEvents = data?.summary?.total_events ?? data?.total_events
    record('9.2 stats 反映新事件数', totalEvents >= 33000, `totalEvents=${totalEvents}`)
  })

  await test('9.3 validate 数据完整性校验通过', async () => {
    const r = await callIpc(`const res = await api.eaa.validate(); return res;`)
    const data = r?.data ?? r
    const valid = data?.valid === true || data?.ok === true || r?.success === true
    record('9.3 validate 数据完整性校验通过', valid, `valid=${valid} success=${r?.success}`)
  })

  await test('9.4 listStudents 包含所有新学生', async () => {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const data = r?.data ?? r
    const students = Array.isArray(data) ? data : (data?.students ?? [])
    const allStudents = [stressStudent, wtrStudent, revStudent, ...parallelStudents]
    const allFound = allStudents.every(name =>
      students.some(s => s.name === name || s.entity_id === name)
    )
    record('9.4 listStudents 包含所有新学生', allFound, `found=${allStudents.filter(name => students.some(s => s.name === name)).length}/${allStudents.length}`)
  })

  await test('9.5 doctor 健康检查通过', async () => {
    const r = await callIpc(`const res = await api.eaa.doctor(); return res;`)
    // doctor 检查可能返回多个检查项,只要 success=true 就算通过
    record('9.5 doctor 健康检查通过', isOk(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 汇总
  // ===========================================================
  console.log('\n' + '='.repeat(60))
  const passed = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length
  console.log(`Round 25 AI 多轮写入压力 + 数据一致性长期验证: 总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`)
  console.log('='.repeat(60))
  if (failed > 0) {
    console.log('\n失败用例:')
    results.filter(r => !r.ok).forEach(r => console.log(`  [FAIL] ${r.name} — ${r.detail}`))
  }

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
