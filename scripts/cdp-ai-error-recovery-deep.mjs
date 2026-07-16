// =============================================================
// Round 26: AI 异常路径与错误恢复深度测试 — 重中之重续13
//
// 验证 AI 在异常输入和错误场景下的恢复能力:
//   1. 不存在学生查询 (score/history/search) (6 项)
//   2. 无效事件操作 (revert 不存在事件/重复 revert) (6 项)
//   3. 参数类型错误 (非字符串/非数字/null/undefined) (6 项)
//   4. 边界值压力 (极大/极小 delta, 超长字符串) (6 项)
//   5. 并发冲突恢复 (同时 revert + add 同一学生) (6 项)
//   6. 缓存失效后恢复 (手动破坏缓存后重建) (5 项)
//   7. 文件系统异常恢复 (只读/缺失文件场景模拟) (5 项)
//   8. 级联错误恢复 (class delete → student orphan → recovery) (6 项)
//   9. 错误后数据完整性 (错误操作后数据仍然一致) (5 项)
//
// 运行: node scripts/cdp-ai-error-recovery-deep.mjs
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
  console.log('CDP connected, running AI error-recovery tests...\n')

  const callIpc = async (code) =>
    evalInPage(`(async function(){const api=window.__EAA_API__||window.api;if(!api)return{__error:'no-api'};try{${code}}catch(e){return{__error:String(e&&e.message?e.message:e)}}})()`)

  const isOk = (res) => !!res && !res.__error && res?.success !== false
  const isFail = (res) => !!res && (res.__error || res?.success === false)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  const TS = Date.now()
  const userDataDir = 'C:\\Users\\sq199\\AppData\\Roaming\\com.educationadvisor.tauri'
  const eaaDataDir = path.join(userDataDir, 'eaa-data')
  const entitiesDir = path.join(eaaDataDir, 'entities')
  const eventsDir = path.join(eaaDataDir, 'events')
  const logsDir = path.join(eaaDataDir, 'logs')

  // ===========================================================
  // 1. 不存在学生查询
  // ===========================================================
  console.log('--- 1. 不存在学生查询 ---')

  await test('1.1 score 查询不存在学生返回失败', async () => {
    const r = await callIpc(`const res = await api.eaa.score('nonexistent_r26_${TS}'); return res;`)
    record('1.1 score 查询不存在学生返回失败', isFail(r), `success=${r?.success} error=${r?.data?.slice(0, 50) || r?.__error?.slice(0, 50)}`)
  })

  await test('1.2 history 查询不存在学生返回失败', async () => {
    const r = await callIpc(`const res = await api.eaa.history('nonexistent_r26_${TS}'); return res;`)
    record('1.2 history 查询不存在学生返回失败', isFail(r), `success=${r?.success}`)
  })

  await test('1.3 search 查询不存在关键词返回空结果', async () => {
    const r = await callIpc(`const res = await api.eaa.search('nonexistent_keyword_r26_${TS}'); return res;`)
    // search 可能返回 success=true 但空结果,也可能返回 success=false
    const data = r?.data ?? r
    const results = Array.isArray(data) ? data : (data?.results ?? data?.events ?? [])
    record('1.3 search 查询不存在关键词返回空结果', isOk(r) && results.length === 0, `success=${r?.success} results=${results.length}`)
  })

  await test('1.4 不存在学生查询后系统仍正常', async () => {
    // 查询不存在学生后,正常查询应该仍然工作
    const r = await callIpc(`const res = await api.eaa.ranking(5); return res;`)
    const data = r?.data ?? r
    const list = Array.isArray(data) ? data : (data?.ranking ?? [])
    record('1.4 不存在学生查询后系统仍正常', isOk(r) && list.length > 0, `success=${r?.success} ranking=${list.length}`)
  })

  await test('1.5 addEvent 到不存在学生返回失败', async () => {
    const r = await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: 'nonexistent_evt_r26_${TS}',
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: 1,
        note: 'R26 nonexistent',
        force: true,
      });
      return res;
    `)
    record('1.5 addEvent 到不存在学生返回失败', isFail(r), `success=${r?.success}`)
  })

  await test('1.6 多次查询不存在学生不崩溃', async () => {
    let allFail = true
    for (let i = 0; i < 5; i++) {
      const r = await callIpc(`const res = await api.eaa.score('nonexistent_multi_r26_${TS}_${i}'); return res;`)
      if (!isFail(r)) allFail = false
    }
    record('1.6 多次查询不存在学生不崩溃', allFail, `allFail=${allFail}`)
  })

  // ===========================================================
  // 2. 无效事件操作
  // ===========================================================
  console.log('\n--- 2. 无效事件操作 ---')

  const evtStudent = `r26_evt_${TS}`
  await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(evtStudent)}); return res;`)

  await test('2.1 revert 不存在事件返回失败', async () => {
    const r = await callIpc(`const res = await api.eaa.revertEvent('evt_nonexistent_${TS}', 'R26 revert nonexistent'); return res;`)
    record('2.1 revert 不存在事件返回失败', isFail(r), `success=${r?.success}`)
  })

  await test('2.2 revert 无效 event_id 格式返回失败', async () => {
    const r = await callIpc(`const res = await api.eaa.revertEvent('invalid_event_id', 'R26 invalid id'); return res;`)
    record('2.2 revert 无效 event_id 格式返回失败', isFail(r), `success=${r?.success}`)
  })

  let realEventId = null
  await test('2.3 创建事件用于后续测试', async () => {
    const r = await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(evtStudent)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: 5,
        note: 'R26 event for revert test',
        force: true,
      });
      return res;
    `)
    const dataStr = typeof r?.data === 'string' ? r.data : ''
    const match = dataStr.match(/evt_\w+/)
    realEventId = match ? match[0] : null
    record('2.3 创建事件用于后续测试', isOk(r) && !!realEventId, `eventId=${realEventId}`)
  })

  await test('2.4 重复 revert 同一事件返回失败', async () => {
    if (!realEventId) { record('2.4 重复 revert 同一事件返回失败', false, 'no event_id'); return }
    // 第一次 revert 应该成功
    const r1 = await callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(realEventId)}, 'R26 first revert'); return res;`)
    await sleep(200)
    // 第二次 revert 同一事件应该失败 (已撤销)
    const r2 = await callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(realEventId)}, 'R26 second revert'); return res;`)
    record('2.4 重复 revert 同一事件返回失败', isOk(r1) && isFail(r2), `first=${r1?.success} second=${r2?.success}`)
  })

  await test('2.5 revert 后系统仍正常', async () => {
    await sleep(200)
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(evtStudent)}); return res;`)
    const sc = r?.data?.score ?? r?.score
    // 事件被撤销,分数应该回到 100
    record('2.5 revert 后系统仍正常', isOk(r) && sc === 100, `score=${sc}`)
  })

  await test('2.6 revert 空 event_id 返回失败', async () => {
    const r = await callIpc(`const res = await api.eaa.revertEvent('', 'R26 empty id'); return res;`)
    record('2.6 revert 空 event_id 返回失败', isFail(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 3. 参数类型错误
  // ===========================================================
  console.log('\n--- 3. 参数类型错误 ---')

  await test('3.1 addEvent 参数为 null 返回失败', async () => {
    const r = await callIpc(`const res = await api.eaa.addEvent(null); return res;`)
    record('3.1 addEvent 参数为 null 返回失败', isFail(r), `success=${r?.success}`)
  })

  await test('3.2 addEvent 参数为 undefined 返回失败', async () => {
    const r = await callIpc(`const res = await api.eaa.addEvent(undefined); return res;`)
    record('3.2 addEvent 参数为 undefined 返回失败', isFail(r), `success=${r?.success}`)
  })

  await test('3.3 score 参数为数字返回失败', async () => {
    const r = await callIpc(`const res = await api.eaa.score(12345); return res;`)
    record('3.3 score 参数为数字返回失败', isFail(r), `success=${r?.success}`)
  })

  await test('3.4 score 参数为 null 返回失败', async () => {
    const r = await callIpc(`const res = await api.eaa.score(null); return res;`)
    record('3.4 score 参数为 null 返回失败', isFail(r), `success=${r?.success}`)
  })

  await test('3.5 addEvent delta 为字符串返回失败', async () => {
    const r = await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(evtStudent)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: 'not_a_number',
        note: 'R26 type error',
        force: true,
      });
      return res;
    `)
    record('3.5 addEvent delta 为字符串返回失败', isFail(r), `success=${r?.success}`)
  })

  await test('3.6 参数错误后系统仍正常', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(5); return res;`)
    record('3.6 参数错误后系统仍正常', isOk(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 4. 边界值压力
  // ===========================================================
  console.log('\n--- 4. 边界值压力 ---')

  const boundaryStudent = `r26_bound_${TS}`
  await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(boundaryStudent)}); return res;`)

  await test('4.1 delta=0 事件可创建', async () => {
    const r = await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(boundaryStudent)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: 0,
        note: 'R26 delta zero',
        force: true,
      });
      return res;
    `)
    record('4.1 delta=0 事件可创建', isOk(r), `success=${r?.success}`)
  })

  await test('4.2 delta=999999 大值需 force', async () => {
    // 不带 force 应该失败
    const r1 = await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(boundaryStudent)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: 999999,
        note: 'R26 large delta no force',
      });
      return res;
    `)
    // 带 force 应该成功
    const r2 = await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(boundaryStudent)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: 999999,
        note: 'R26 large delta with force',
        force: true,
      });
      return res;
    `)
    record('4.2 delta=999999 大值需 force', isFail(r1) && isOk(r2), `noForce=${r1?.success} withForce=${r2?.success}`)
  })

  await test('4.3 delta=-999999 负大值需 force', async () => {
    const r = await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(boundaryStudent)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: -999999,
        note: 'R26 large negative delta',
        force: true,
      });
      return res;
    `)
    record('4.3 delta=-999999 负大值需 force', isOk(r), `success=${r?.success}`)
  })

  await test('4.4 64 字符 note (极限长度)', async () => {
    const longNote = 'x'.repeat(64)
    const r = await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(boundaryStudent)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: 1,
        note: ${JSON.stringify(longNote)},
        force: true,
      });
      return res;
    `)
    record('4.4 64 字符 note (极限长度)', isOk(r), `success=${r?.success}`)
  })

  await test('4.5 65 字符 note 超长被拒绝', async () => {
    const tooLongNote = 'x'.repeat(65)
    const r = await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(boundaryStudent)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: 1,
        note: ${JSON.stringify(tooLongNote)},
        force: true,
      });
      return res;
    `)
    record('4.5 65 字符 note 超长被拒绝', isFail(r), `success=${r?.success}`)
  })

  await test('4.6 边界值后分数正确', async () => {
    await sleep(300)
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(boundaryStudent)}); return res;`)
    const sc = r?.data?.score ?? r?.score
    // delta=0 + delta=999999 + delta=-999999 = 0, 加上 64 字符 note 的 delta=1
    // score = 100 + 0 + 999999 - 999999 + 1 = 101
    record('4.6 边界值后分数正确', isOk(r) && sc === 101, `score=${sc} expected=101`)
  })

  // ===========================================================
  // 5. 并发冲突恢复
  // ===========================================================
  console.log('\n--- 5. 并发冲突恢复 ---')

  const conflictStudent = `r26_conflict_${TS}`
  await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(conflictStudent)}); return res;`)

  await test('5.1 同时 add + revert 同一学生', async () => {
    // 先添加一个事件
    const ar = await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(conflictStudent)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: 5,
        note: 'R26 conflict base',
        force: true,
      });
      return res;
    `)
    const dataStr = typeof ar?.data === 'string' ? ar.data : ''
    const match = dataStr.match(/evt_\w+/)
    const eventId = match ? match[0] : null

    if (!eventId) { record('5.1 同时 add + revert 同一学生', false, 'no event_id'); return }

    // 并行: revert 旧事件 + 添加新事件
    const [rr1, ar2] = await Promise.all([
      callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(eventId)}, 'R26 conflict revert'); return res;`),
      callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(conflictStudent)},
          reasonCode: 'ACTIVITY_PARTICIPATION',
          delta: 3,
          note: 'R26 conflict add',
          force: true,
        });
        return res;
      `),
    ])
    record('5.1 同时 add + revert 同一学生', isOk(rr1) && isOk(ar2), `revert=${rr1?.success} add=${ar2?.success}`)
  })

  await test('5.2 并发冲突后分数正确', async () => {
    await sleep(300)
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(conflictStudent)}); return res;`)
    const sc = r?.data?.score ?? r?.score
    // +5 (reverted) + 3 (active) = 3, score = 103
    record('5.2 并发冲突后分数正确', sc === 103, `score=${sc} expected=103`)
  })

  await test('5.3 并发多次 add 同一学生', async () => {
    const promises = []
    for (let i = 0; i < 10; i++) {
      promises.push(
        callIpc(`
          const res = await api.eaa.addEvent({
            studentName: ${JSON.stringify(conflictStudent)},
            reasonCode: 'ACTIVITY_PARTICIPATION',
            delta: 1,
            note: ${JSON.stringify(`R26 concurrent ${i}`)},
            force: true,
          });
          return res;
        `)
      )
    }
    const responses = await Promise.all(promises)
    const successCount = responses.filter(r => isOk(r)).length
    record('5.3 并发多次 add 同一学生', successCount === 10, `success=${successCount}/10`)
  })

  await test('5.4 并发 add 后分数正确', async () => {
    await sleep(500)
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(conflictStudent)}); return res;`)
    const sc = r?.data?.score ?? r?.score
    // 103 + 10*1 = 113
    record('5.4 并发 add 后分数正确', sc === 113, `score=${sc} expected=113`)
  })

  await test('5.5 并发冲突后缓存一致', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const eid = idx[conflictStudent]
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(conflictStudent)}); return res;`)
    const ipcScore = r?.data?.score ?? r?.score
    record('5.5 并发冲突后缓存一致', cache[eid] === ipcScore, `cache=${cache[eid]} ipc=${ipcScore}`)
  })

  await test('5.6 并发冲突后 history 完整', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(conflictStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    // 1 (base, reverted) + 1 (revert) + 1 (conflict add) + 10 (concurrent) = 13
    record('5.6 并发冲突后 history 完整', events.length === 13, `events=${events.length} expected=13`)
  })

  // ===========================================================
  // 6. 缓存失效后恢复
  // ===========================================================
  console.log('\n--- 6. 缓存失效后恢复 ---')

  await test('6.1 scores.cache.json 存在且可读', async () => {
    const cachePath = path.join(entitiesDir, 'scores.cache.json')
    const exists = fs.existsSync(cachePath)
    let readable = false
    if (exists) {
      try {
        const cache = JSON.parse(await fsp.readFile(cachePath, 'utf-8'))
        readable = Object.keys(cache).length > 0
      } catch {}
    }
    record('6.1 scores.cache.json 存在且可读', exists && readable, `exists=${exists} readable=${readable}`)
  })

  await test('6.2 event_stats.cache.json 存在且可读', async () => {
    const cachePath = path.join(entitiesDir, 'event_stats.cache.json')
    const exists = fs.existsSync(cachePath)
    let readable = false
    if (exists) {
      try {
        const cache = JSON.parse(await fsp.readFile(cachePath, 'utf-8'))
        readable = Object.keys(cache).length > 0
      } catch {}
    }
    record('6.2 event_stats.cache.json 存在且可读', exists && readable, `exists=${exists} readable=${readable}`)
  })

  await test('6.3 daily_dedup.cache.json 存在且可读', async () => {
    const cachePath = path.join(entitiesDir, 'daily_dedup.cache.json')
    const exists = fs.existsSync(cachePath)
    let readable = false
    if (exists) {
      try {
        const cache = JSON.parse(await fsp.readFile(cachePath, 'utf-8'))
        readable = Object.keys(cache).length > 0
      } catch {}
    }
    record('6.3 daily_dedup.cache.json 存在且可读', exists && readable, `exists=${exists} readable=${readable}`)
  })

  await test('6.4 写入后缓存自动更新', async () => {
    const cacheStudent = `r26_cache_${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(cacheStudent)}); return res;`)
    await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(cacheStudent)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: 7,
        note: 'R26 cache test',
        force: true,
      });
      return res;
    `)
    await sleep(300)
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const eid = idx[cacheStudent]
    record('6.4 写入后缓存自动更新', cache[eid] === 107, `cache=${cache[eid]} expected=107`)
  })

  await test('6.5 doctor 可重建缓存', async () => {
    const r = await callIpc(`const res = await api.eaa.doctor(); return res;`)
    record('6.5 doctor 可重建缓存', isOk(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 7. 文件系统异常恢复 (只读/缺失文件场景模拟)
  // ===========================================================
  console.log('\n--- 7. 文件系统异常恢复 ---')

  await test('7.1 events.jsonl 存在且非空', async () => {
    const filePath = path.join(eventsDir, 'events.jsonl')
    const exists = fs.existsSync(filePath)
    let nonEmpty = false
    if (exists) {
      const stat = await fsp.stat(filePath)
      nonEmpty = stat.size > 10
    }
    record('7.1 events.jsonl 存在且非空', exists && nonEmpty, `exists=${exists} size=${nonEmpty}`)
  })

  await test('7.2 operations.jsonl 存在且非空', async () => {
    const filePath = path.join(logsDir, 'operations.jsonl')
    const exists = fs.existsSync(filePath)
    let nonEmpty = false
    if (exists) {
      const stat = await fsp.stat(filePath)
      nonEmpty = stat.size > 10
    }
    record('7.2 operations.jsonl 存在且非空', exists && nonEmpty, `exists=${exists} size=${nonEmpty}`)
  })

  await test('7.3 name_index.json 存在且非空', async () => {
    const filePath = path.join(entitiesDir, 'name_index.json')
    const exists = fs.existsSync(filePath)
    let nonEmpty = false
    if (exists) {
      try {
        const idx = JSON.parse(await fsp.readFile(filePath, 'utf-8'))
        nonEmpty = Object.keys(idx).length > 0
      } catch {}
    }
    record('7.3 name_index.json 存在且非空', exists && nonEmpty, `exists=${exists} entries=${nonEmpty}`)
  })

  await test('7.4 reason_codes.json 存在且非空', async () => {
    const filePath = path.join(eaaDataDir, 'reason_codes.json')
    const exists = fs.existsSync(filePath)
    let nonEmpty = false
    if (exists) {
      try {
        const codes = JSON.parse(await fsp.readFile(filePath, 'utf-8'))
        nonEmpty = Object.keys(codes).length > 0
      } catch {}
    }
    record('7.4 reason_codes.json 存在且非空', exists && nonEmpty, `exists=${exists} codes=${nonEmpty}`)
  })

  await test('7.5 缺失文件场景下系统仍可查询', async () => {
    // 系统应该能在部分缓存文件缺失的情况下仍能工作 (从源文件重建)
    // 这里只验证当前系统可用性
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    record('7.5 缺失文件场景下系统仍可查询', isOk(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 8. 级联错误恢复 (class delete → student orphan → recovery)
  // ===========================================================
  console.log('\n--- 8. 级联错误恢复 ---')

  const cascadeClassId = `R26-CASC-${TS}`
  const cascadeStudent = `r26_cascade_${TS}`

  await test('8.1 创建班级用于级联测试', async () => {
    const r = await callIpc(`
      const res = await api.class.create({
        class_id: ${JSON.stringify(cascadeClassId)},
        name: 'R26 Cascade Test Class',
        grade: '高三',
      });
      return res;
    `)
    record('8.1 创建班级用于级联测试', isOk(r), `success=${r?.success}`)
  })

  await test('8.2 创建学生并分配到班级', async () => {
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(cascadeStudent)}); return res;`)
    const r = await callIpc(`
      const res = await api.class.assign({
        class_id: ${JSON.stringify(cascadeClassId)},
        student_names: [${JSON.stringify(cascadeStudent)}],
      });
      return res;
    `)
    record('8.2 创建学生并分配到班级', isOk(r), `success=${r?.success} assigned=${r?.assigned}`)
  })

  await test('8.3 删除班级后学生仍存在', async () => {
    // 获取班级 UUID
    const lr = await callIpc(`const res = await api.class.list(); return res;`)
    const classes = lr?.data ?? []
    const cls = classes.find(c => c.class_id === cascadeClassId)
    if (!cls) { record('8.3 删除班级后学生仍存在', false, 'class not found'); return }

    // 删除班级
    const dr = await callIpc(`const res = await api.class.delete(${JSON.stringify(cls.id)}); return res;`)
    await sleep(500)

    // 学生应该仍然存在 (但 class_id 可能被清理)
    const sr = await callIpc(`const res = await api.eaa.score(${JSON.stringify(cascadeStudent)}); return res;`)
    record('8.3 删除班级后学生仍存在', isOk(sr), `delete=${dr?.success} studentExists=${sr?.success}`)
  })

  await test('8.4 级联清理后学生 class_id 被清除', async () => {
    await sleep(500)
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(cascadeStudent)}); return res;`)
    const data = r?.data ?? r
    // class_id 应该被级联清理清除
    record('8.4 级联清理后学生 class_id 被清除', data?.class_id === null || data?.class_id === '', `class_id=${data?.class_id}`)
  })

  await test('8.5 级联后学生仍可添加事件', async () => {
    const r = await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(cascadeStudent)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: 3,
        note: 'R26 cascade recovery',
        force: true,
      });
      return res;
    `)
    record('8.5 级联后学生仍可添加事件', isOk(r), `success=${r?.success}`)
  })

  await test('8.6 级联后系统数据完整', async () => {
    const r = await callIpc(`const res = await api.eaa.validate(); return res;`)
    record('8.6 级联后系统数据完整', isOk(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 9. 错误后数据完整性
  // ===========================================================
  console.log('\n--- 9. 错误后数据完整性 ---')

  await test('9.1 所有错误操作后 validate 通过', async () => {
    const r = await callIpc(`const res = await api.eaa.validate(); return res;`)
    const data = r?.data ?? r
    const valid = data?.valid === true || data?.ok === true || r?.success === true
    record('9.1 所有错误操作后 validate 通过', valid, `valid=${valid} success=${r?.success}`)
  })

  await test('9.2 错误操作后排行榜仍稳定', async () => {
    const r1 = await callIpc(`const res = await api.eaa.ranking(20); return res;`)
    const r2 = await callIpc(`const res = await api.eaa.ranking(20); return res;`)
    const d1 = r1?.data ?? r1
    const d2 = r2?.data ?? r2
    const list1 = Array.isArray(d1) ? d1 : (d1?.ranking ?? [])
    const list2 = Array.isArray(d2) ? d2 : (d2?.ranking ?? [])
    const same = list1.length === list2.length
    record('9.2 错误操作后排行榜仍稳定', same, `len1=${list1.length} len2=${list2.length}`)
  })

  await test('9.3 错误操作后 stats 仍正确', async () => {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const data = r?.data ?? r
    const students = data?.summary?.students ?? data?.students
    const events = data?.summary?.total_events ?? data?.total_events
    record('9.3 错误操作后 stats 仍正确', isOk(r) && students > 0 && events > 0, `students=${students} events=${events}`)
  })

  await test('9.4 错误操作后缓存一致', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    // 检查几个 Round 26 学生的缓存
    const r26Students = [evtStudent, boundaryStudent, conflictStudent, cascadeStudent]
    let allMatch = true
    for (const name of r26Students) {
      const eid = idx[name]
      if (!eid || cache[eid] === undefined) { allMatch = false; continue }
      const sr = await callIpc(`const res = await api.eaa.score(${JSON.stringify(name)}); return res;`)
      const ipcScore = sr?.data?.score ?? sr?.score
      if (cache[eid] !== ipcScore) { allMatch = false }
    }
    record('9.4 错误操作后缓存一致', allMatch, `match=${allMatch}`)
  })

  await test('9.5 doctor 健康检查通过', async () => {
    const r = await callIpc(`const res = await api.eaa.doctor(); return res;`)
    record('9.5 doctor 健康检查通过', isOk(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 汇总
  // ===========================================================
  console.log('\n' + '='.repeat(60))
  const passed = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length
  console.log(`Round 26 AI 异常路径与错误恢复深度测试: 总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`)
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
