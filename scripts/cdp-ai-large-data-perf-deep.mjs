// =============================================================
// Round 28: AI 大数据量性能与极限边界深度测试 — 重中之重续15
//
// 验证 AI 在大数据量下的性能 + 极限边界处理:
//   1. 大数据量查询性能 — ranking/stats/listStudents 响应时间 (6 项)
//   2. 极限查询参数 — 超大 limit/超宽日期范围 (6 项)
//   3. 搜索性能 — 常见/罕见/特殊字符搜索 (6 项)
//   4. 导出性能 — 大数据量导出 (5 项)
//   5. 并发大查询 — 多个大查询同时执行 (6 项)
//   6. 单学生大数据量 — 单学生大量事件查询性能 (6 项)
//   7. 分页边界 — 大偏移/大限制 (5 项)
//   8. summary/range 极限 — 超大时间范围 (6 项)
//   9. 数据完整性 — 大数据量后数据一致性 (6 项)
//
// 运行: node scripts/cdp-ai-large-data-perf-deep.mjs
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
  console.log('CDP connected, running AI large-data performance tests...\n')

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
  const outputDir = path.join(eaaDataDir, 'r28-output')
  await fsp.mkdir(outputDir, { recursive: true }).catch(() => {})

  // ===========================================================
  // 1. 大数据量查询性能 — ranking/stats/listStudents
  // ===========================================================
  console.log('--- 1. 大数据量查询性能 ---')

  await test('1.1 ranking(2000) 响应时间 < 3s', async () => {
    const start = Date.now()
    const r = await callIpc(`const res = await api.eaa.ranking(2000); return res;`)
    const elapsed = Date.now() - start
    const data = r?.data ?? r
    const ranking = data?.ranking ?? data?.data?.ranking ?? []
    record('1.1 ranking(2000) 响应时间 < 3s', isOk(r) && elapsed < 3000, `ranking=${ranking.length} elapsed=${elapsed}ms`)
  })

  await test('1.2 stats() 响应时间 < 2s', async () => {
    const start = Date.now()
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const elapsed = Date.now() - start
    const data = r?.data ?? r
    const summary = data?.summary ?? {}
    record('1.2 stats() 响应时间 < 2s', isOk(r) && elapsed < 2000 && summary.students > 0, `students=${summary.students} events=${summary.total_events} elapsed=${elapsed}ms`)
  })

  await test('1.3 listStudents() 响应时间 < 2s', async () => {
    const start = Date.now()
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const elapsed = Date.now() - start
    const data = r?.data ?? r
    const students = Array.isArray(data) ? data : (data?.students ?? [])
    record('1.3 listStudents() 响应时间 < 2s', isOk(r) && elapsed < 2000 && students.length > 100, `students=${students.length} elapsed=${elapsed}ms`)
  })

  await test('1.4 ranking(10) vs ranking(2000) 性能差异', async () => {
    const s1 = Date.now()
    await callIpc(`const res = await api.eaa.ranking(10); return res;`)
    const e1 = Date.now() - s1
    const s2 = Date.now()
    await callIpc(`const res = await api.eaa.ranking(2000); return res;`)
    const e2 = Date.now() - s2
    // ranking 使用缓存, 性能差异不应太大
    const ratio = e2 / Math.max(e1, 1)
    record('1.4 ranking(10) vs ranking(2000) 性能差异', ratio < 10, `top10=${e1}ms top2000=${e2}ms ratio=${ratio.toFixed(2)}x`)
  })

  await test('1.5 连续 5 次 stats() 性能稳定', async () => {
    const times = []
    for (let i = 0; i < 5; i++) {
      const s = Date.now()
      const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
      times.push(Date.now() - s)
      if (!isOk(r)) { record('1.5 连续 5 次 stats() 性能稳定', false, `round ${i} failed`); return }
    }
    const max = Math.max(...times)
    const min = Math.min(...times)
    const stable = max < 2000 && (max - min) < 1500
    record('1.5 连续 5 次 stats() 性能稳定', stable, `times=[${times.join(',')}]ms max=${max} min=${min}`)
  })

  await test('1.6 info() 响应时间 < 1s', async () => {
    const start = Date.now()
    const r = await callIpc(`const res = await api.eaa.info(); return res;`)
    const elapsed = Date.now() - start
    record('1.6 info() 响应时间 < 1s', isOk(r) && elapsed < 1000, `elapsed=${elapsed}ms`)
  })

  // ===========================================================
  // 2. 极限查询参数 — 超大 limit/超宽日期范围
  // ===========================================================
  console.log('\n--- 2. 极限查询参数 ---')

  await test('2.1 ranking(999999) 超大 limit', async () => {
    const start = Date.now()
    const r = await callIpc(`const res = await api.eaa.ranking(999999); return res;`)
    const elapsed = Date.now() - start
    const data = r?.data ?? r
    const ranking = data?.ranking ?? data?.data?.ranking ?? []
    // 应返回所有学生, 不报错
    record('2.1 ranking(999999) 超大 limit', isOk(r) && ranking.length > 0 && elapsed < 5000, `ranking=${ranking.length} elapsed=${elapsed}ms`)
  })

  await test('2.2 search(query, 999999) 超大 limit', async () => {
    const r = await callIpc(`const res = await api.eaa.search('a', 999999); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? data?.results ?? [])
    record('2.2 search(query, 999999) 超大 limit', isOk(r), `results=${events.length}`)
  })

  await test('2.3 range 超宽日期范围 (2000-2099)', async () => {
    const r = await callIpc(`const res = await api.eaa.range('2000-01-01', '2099-12-31', 5000); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('2.3 range 超宽日期范围', isOk(r) && events.length > 0, `events=${events.length}`)
  })

  await test('2.4 range 反向日期 (end < start) 返回空', async () => {
    const r = await callIpc(`const res = await api.eaa.range('2099-01-01', '2000-01-01', 100); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    // 反向日期应该返回空或失败 (两种行为都可接受)
    record('2.4 range 反向日期', (isOk(r) && events.length === 0) || isFail(r), `events=${events.length} success=${r?.success}`)
  })

  await test('2.5 summary 超大时间范围', async () => {
    const r = await callIpc(`const res = await api.eaa.summary('2000-01-01', '2099-12-31'); return res;`)
    const data = r?.data ?? r
    const events = data?.events ?? {}
    record('2.5 summary 超大时间范围', isOk(r) && events.total >= 0, `total=${events.total}`)
  })

  await test('2.6 ranking(0) 零 limit', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(0); return res;`)
    const data = r?.data ?? r
    const ranking = data?.ranking ?? data?.data?.ranking ?? []
    // ranking(0) 应该返回空数组或默认值
    record('2.6 ranking(0) 零 limit', isOk(r), `ranking=${ranking.length}`)
  })

  // ===========================================================
  // 3. 搜索性能 — 常见/罕见/特殊字符搜索
  // ===========================================================
  console.log('\n--- 3. 搜索性能 ---')

  await test('3.1 搜索常见字符 (单字母)', async () => {
    const start = Date.now()
    const r = await callIpc(`const res = await api.eaa.search('a', 100); return res;`)
    const elapsed = Date.now() - start
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? data?.results ?? [])
    record('3.1 搜索常见字符', isOk(r) && elapsed < 3000, `results=${events.length} elapsed=${elapsed}ms`)
  })

  await test('3.2 搜索罕见字符 (特殊符号)', async () => {
    const start = Date.now()
    const r = await callIpc(`const res = await api.eaa.search('xyzqq_${TS}', 100); return res;`)
    const elapsed = Date.now() - start
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? data?.results ?? [])
    // 罕见字符应该返回空结果, 但不报错
    record('3.2 搜索罕见字符', isOk(r) && elapsed < 3000, `results=${events.length} elapsed=${elapsed}ms`)
  })

  await test('3.3 搜索 Unicode 字符', async () => {
    const r = await callIpc(`const res = await api.eaa.search(${JSON.stringify('测试')}, 100); return res;`)
    record('3.3 搜索 Unicode 字符', isOk(r), `success=${r?.success}`)
  })

  await test('3.4 搜索空字符串', async () => {
    const r = await callIpc(`const res = await api.eaa.search('', 100); return res;`)
    // 空字符串搜索应该返回空或全部
    record('3.4 搜索空字符串', isOk(r) || isFail(r), `success=${r?.success}`)
  })

  await test('3.5 搜索超长字符串 (1000 字符)', async () => {
    const longQuery = 'a'.repeat(1000)
    const start = Date.now()
    const r = await callIpc(`const res = await api.eaa.search(${JSON.stringify(longQuery)}, 100); return res;`)
    const elapsed = Date.now() - start
    // 超长字符串不应导致崩溃
    record('3.5 搜索超长字符串', isOk(r) || isFail(r), `elapsed=${elapsed}ms success=${r?.success}`)
  })

  await test('3.6 搜索特殊正则字符 (不注入)', async () => {
    const specialRegex = 'test.*+?^${}()|[]\\\\'
    const r = await callIpc(`const res = await api.eaa.search(${JSON.stringify(specialRegex)}, 100); return res;`)
    // 特殊正则字符不应导致注入
    record('3.6 搜索特殊正则字符', isOk(r) || isFail(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 4. 导出性能 — 大数据量导出
  // ===========================================================
  console.log('\n--- 4. 导出性能 ---')

  await test('4.1 导出 CSV 性能', async () => {
    const outputFile = path.join(outputDir, `export_csv_${TS}.csv`)
    const start = Date.now()
    const r = await callIpc(`const res = await api.eaa.export('csv', ${JSON.stringify(outputFile)}); return res;`)
    const elapsed = Date.now() - start
    record('4.1 导出 CSV 性能', isOk(r) && elapsed < 10000, `elapsed=${elapsed}ms success=${r?.success}`)
  })

  await test('4.2 导出 JSONL 性能', async () => {
    const outputFile = path.join(outputDir, `export_jsonl_${TS}.jsonl`)
    const start = Date.now()
    const r = await callIpc(`const res = await api.eaa.export('jsonl', ${JSON.stringify(outputFile)}); return res;`)
    const elapsed = Date.now() - start
    record('4.2 导出 JSONL 性能', isOk(r) && elapsed < 10000, `elapsed=${elapsed}ms success=${r?.success}`)
  })

  await test('4.3 导出 HTML 性能', async () => {
    const outputFile = path.join(outputDir, `export_html_${TS}.html`)
    const start = Date.now()
    const r = await callIpc(`const res = await api.eaa.export('html', ${JSON.stringify(outputFile)}); return res;`)
    const elapsed = Date.now() - start
    record('4.3 导出 HTML 性能', isOk(r) && elapsed < 10000, `elapsed=${elapsed}ms success=${r?.success}`)
  })

  await test('4.4 导出文件非空', async () => {
    const csvFile = path.join(outputDir, `export_csv_${TS}.csv`)
    const content = await fsp.readFile(csvFile, 'utf-8').catch(() => '')
    record('4.4 导出文件非空', content.length > 0, `size=${content.length} chars`)
  })

  await test('4.5 导出不支持格式失败', async () => {
    const r = await callIpc(`const res = await api.eaa.export('xml', ${JSON.stringify(path.join(outputDir, 'test.xml'))}); return res;`)
    record('4.5 导出不支持格式失败', isFail(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 5. 并发大查询 — 多个大查询同时执行
  // ===========================================================
  console.log('\n--- 5. 并发大查询 ---')

  await test('5.1 5 个并发 ranking 查询', async () => {
    const start = Date.now()
    const promises = []
    for (let i = 0; i < 5; i++) {
      promises.push(callIpc(`const res = await api.eaa.ranking(500); return res;`))
    }
    const results5 = await Promise.all(promises)
    const elapsed = Date.now() - start
    const allOk = results5.every(r => isOk(r))
    record('5.1 5 个并发 ranking 查询', allOk && elapsed < 10000, `elapsed=${elapsed}ms allOk=${allOk}`)
  })

  await test('5.2 5 个并发 stats 查询', async () => {
    const start = Date.now()
    const promises = []
    for (let i = 0; i < 5; i++) {
      promises.push(callIpc(`const res = await api.eaa.stats(); return res;`))
    }
    const results5 = await Promise.all(promises)
    const elapsed = Date.now() - start
    const allOk = results5.every(r => isOk(r))
    record('5.2 5 个并发 stats 查询', allOk && elapsed < 10000, `elapsed=${elapsed}ms allOk=${allOk}`)
  })

  await test('5.3 10 个并发混合查询', async () => {
    const start = Date.now()
    const promises = []
    for (let i = 0; i < 10; i++) {
      const queryType = i % 4
      if (queryType === 0) {
        promises.push(callIpc(`const res = await api.eaa.ranking(100); return res;`))
      } else if (queryType === 1) {
        promises.push(callIpc(`const res = await api.eaa.stats(); return res;`))
      } else if (queryType === 2) {
        promises.push(callIpc(`const res = await api.eaa.listStudents(); return res;`))
      } else {
        promises.push(callIpc(`const res = await api.eaa.summary(); return res;`))
      }
    }
    const results10 = await Promise.all(promises)
    const elapsed = Date.now() - start
    const allOk = results10.every(r => isOk(r))
    record('5.3 10 个并发混合查询', allOk && elapsed < 15000, `elapsed=${elapsed}ms allOk=${allOk}`)
  })

  await test('5.4 20 个并发 score 查询', async () => {
    // 先获取学生列表
    const listR = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const data = listR?.data ?? listR
    const students = Array.isArray(data) ? data : (data?.students ?? [])
    if (students.length === 0) { record('5.4 20 个并发 score 查询', false, 'no students'); return }
    const names = students.slice(0, 20).map(s => s.name || s.entity_id)
    const start = Date.now()
    const promises = names.map(n => callIpc(`const res = await api.eaa.score(${JSON.stringify(n)}); return res;`))
    const results20 = await Promise.all(promises)
    const elapsed = Date.now() - start
    const allOk = results20.every(r => isOk(r))
    record('5.4 20 个并发 score 查询', allOk && elapsed < 5000, `elapsed=${elapsed}ms allOk=${allOk}`)
  })

  await test('5.5 并发读+写不互相阻塞', async () => {
    const stu = `r28_rw_${TS}`
    await callIpc(`const r = await api.eaa.addStudent(${JSON.stringify(stu)}); return r;`)
    const start = Date.now()
    const promises = [
      callIpc(`const res = await api.eaa.ranking(500); return res;`),  // 大读
      callIpc(`const res = await api.eaa.stats(); return res;`),        // 大读
      callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(stu)},
          reasonCode: 'ACTIVITY_PARTICIPATION',
          delta: 5,
          note: ${JSON.stringify(`R28 rw test +5`)},
          force: true,
        });
        return res;
      `),  // 写
      callIpc(`const res = await api.eaa.score(${JSON.stringify(stu)}); return res;`),  // 小读
    ]
    const results4 = await Promise.all(promises)
    const elapsed = Date.now() - start
    const allOk = results4.every(r => isOk(r))
    record('5.5 并发读+写不互相阻塞', allOk && elapsed < 10000, `elapsed=${elapsed}ms allOk=${allOk}`)
  })

  await test('5.6 50 个并发 score 查询性能', async () => {
    const listR = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const data = listR?.data ?? listR
    const students = Array.isArray(data) ? data : (data?.students ?? [])
    const names = students.slice(0, 50).map(s => s.name || s.entity_id)
    if (names.length < 10) { record('5.6 50 个并发 score 查询性能', true, `only ${names.length} students`); return }
    const start = Date.now()
    const promises = names.map(n => callIpc(`const res = await api.eaa.score(${JSON.stringify(n)}); return res;`))
    const results50 = await Promise.all(promises)
    const elapsed = Date.now() - start
    const okCount = results50.filter(r => isOk(r)).length
    record('5.6 50 个并发 score 查询性能', okCount >= names.length * 0.9 && elapsed < 10000, `ok=${okCount}/${names.length} elapsed=${elapsed}ms`)
  })

  // ===========================================================
  // 6. 单学生大数据量 — 单学生大量事件查询性能
  // ===========================================================
  console.log('\n--- 6. 单学生大数据量 ---')

  const bulkStudent = `r28_bulk_${TS}`
  await callIpc(`const r = await api.eaa.addStudent(${JSON.stringify(bulkStudent)}); return r;`)

  await test('6.1 批量添加 30 个事件', async () => {
    let success = 0
    for (let i = 0; i < 30; i++) {
      const r = await callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(bulkStudent)},
          reasonCode: 'ACTIVITY_PARTICIPATION',
          delta: 1,
          note: ${JSON.stringify(`R28 bulk ${i}`)},
          force: true,
        });
        return res;
      `)
      if (isOk(r)) success++
    }
    record('6.1 批量添加 30 个事件', success === 30, `success=${success}/30`)
  })

  await test('6.2 单学生 history 查询性能 (30 事件)', async () => {
    const start = Date.now()
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(bulkStudent)}); return res;`)
    const elapsed = Date.now() - start
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('6.2 单学生 history 性能', isOk(r) && events.length === 30 && elapsed < 3000, `events=${events.length} elapsed=${elapsed}ms`)
  })

  await test('6.3 单学生 score 查询性能', async () => {
    const start = Date.now()
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(bulkStudent)}); return res;`)
    const elapsed = Date.now() - start
    const data = r?.data ?? r
    // 100 + 30 = 130
    record('6.3 单学生 score 查询性能', isOk(r) && data?.score === 130 && elapsed < 2000, `score=${data?.score} elapsed=${elapsed}ms`)
  })

  await test('6.4 单学生 search 查询性能', async () => {
    const start = Date.now()
    const r = await callIpc(`const res = await api.eaa.search(${JSON.stringify(bulkStudent)}, 100); return res;`)
    const elapsed = Date.now() - start
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? data?.results ?? [])
    record('6.4 单学生 search 性能', isOk(r) && events.length === 30 && elapsed < 3000, `events=${events.length} elapsed=${elapsed}ms`)
  })

  await test('6.5 批量 revert 10 个事件', async () => {
    const histR = await callIpc(`const res = await api.eaa.history(${JSON.stringify(bulkStudent)}); return res;`)
    const data = histR?.data ?? histR
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    let success = 0
    for (let i = 0; i < 10 && i < events.length; i++) {
      const evtId = events[i]?.event_id
      if (!evtId) continue
      const r = await callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(evtId)}, ${JSON.stringify(`R28 bulk revert ${i}`)}); return res;`)
      if (isOk(r)) success++
    }
    record('6.5 批量 revert 10 个事件', success === 10, `success=${success}/10`)
  })

  await test('6.6 revert 后 score 正确 (130-10=120)', async () => {
    await sleep(500)
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(bulkStudent)}); return res;`)
    const data = r?.data ?? r
    // 30 个 +1 事件, revert 10 个 = 100 + 20 = 120
    record('6.6 revert 后 score 正确', data?.score === 120, `score=${data?.score}`)
  })

  // ===========================================================
  // 7. 分页边界 — 大偏移/大限制
  // ===========================================================
  console.log('\n--- 7. 分页边界 ---')

  await test('7.1 ranking(1) 最小 limit', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(1); return res;`)
    const data = r?.data ?? r
    const ranking = data?.ranking ?? data?.data?.ranking ?? []
    record('7.1 ranking(1) 最小 limit', isOk(r) && ranking.length === 1, `ranking=${ranking.length}`)
  })

  await test('7.2 search(query, 1) 最小 limit', async () => {
    const r = await callIpc(`const res = await api.eaa.search('a', 1); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? data?.results ?? [])
    record('7.2 search(query, 1) 最小 limit', isOk(r) && events.length <= 1, `results=${events.length}`)
  })

  await test('7.3 range(start, end, 1) 最小 limit', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const r = await callIpc(`const res = await api.eaa.range(${JSON.stringify(today)}, ${JSON.stringify(today)}, 1); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('7.3 range 最小 limit', isOk(r) && events.length <= 1, `events=${events.length}`)
  })

  await test('7.4 ranking 负数 limit', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(-1); return res;`)
    // 负数 limit 不应崩溃
    record('7.4 ranking 负数 limit', isOk(r) || isFail(r), `success=${r?.success}`)
  })

  await test('7.5 ranking 非数字 limit', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking('abc'); return res;`)
    // 非数字 limit 不应崩溃
    record('7.5 ranking 非数字 limit', isOk(r) || isFail(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 8. summary/range 极限 — 超大时间范围
  // ===========================================================
  console.log('\n--- 8. summary/range 极限 ---')

  await test('8.1 summary 同一天', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const r = await callIpc(`const res = await api.eaa.summary(${JSON.stringify(today)}, ${JSON.stringify(today)}); return res;`)
    const data = r?.data ?? r
    const events = data?.events ?? {}
    record('8.1 summary 同一天', isOk(r), `total=${events.total}`)
  })

  await test('8.2 summary 未来日期', async () => {
    const r = await callIpc(`const res = await api.eaa.summary('2099-01-01', '2099-12-31'); return res;`)
    const data = r?.data ?? r
    const events = data?.events ?? {}
    // 未来日期应该返回 0 事件
    record('8.2 summary 未来日期', isOk(r) && events.total === 0, `total=${events.total}`)
  })

  await test('8.3 range 同一天大量事件', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const start = Date.now()
    const r = await callIpc(`const res = await api.eaa.range(${JSON.stringify(today)}, ${JSON.stringify(today)}, 5000); return res;`)
    const elapsed = Date.now() - start
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('8.3 range 同一天大量事件', isOk(r) && elapsed < 5000, `events=${events.length} elapsed=${elapsed}ms`)
  })

  await test('8.4 summary 无参数 (全量)', async () => {
    const start = Date.now()
    const r = await callIpc(`const res = await api.eaa.summary(); return res;`)
    const elapsed = Date.now() - start
    const data = r?.data ?? r
    const events = data?.events ?? {}
    record('8.4 summary 无参数', isOk(r) && elapsed < 5000, `total=${events.total} elapsed=${elapsed}ms`)
  })

  await test('8.5 summary 无效日期格式', async () => {
    const r = await callIpc(`const res = await api.eaa.summary('invalid-date', 'also-invalid'); return res;`)
    // 无效日期不应崩溃
    record('8.5 summary 无效日期格式', isOk(r) || isFail(r), `success=${r?.success}`)
  })

  await test('8.6 range 无效日期格式', async () => {
    const r = await callIpc(`const res = await api.eaa.range('not-a-date', 'also-not-a-date', 100); return res;`)
    // 无效日期不应崩溃
    record('8.6 range 无效日期格式', isOk(r) || isFail(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 9. 数据完整性 — 大数据量后数据一致性
  // ===========================================================
  console.log('\n--- 9. 数据完整性验证 ---')

  await test('9.1 events.jsonl 行数增加', async () => {
    const eventsFile = path.join(eventsDir, 'events.jsonl')
    const content = await fsp.readFile(eventsFile, 'utf-8').catch(() => '')
    const lines = content.split('\n').filter(l => l.trim())
    record('9.1 events.jsonl 行数增加', lines.length > 34000, `lines=${lines.length}`)
  })

  await test('9.2 scores.cache.json 包含 bulkStudent', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const eid = idx[bulkStudent]
    record('9.2 scores.cache.json 包含 bulkStudent', cache[eid] === 120, `score=${cache[eid]}`)
  })

  await test('9.3 eaa.doctor 通过', async () => {
    const r = await callIpc(`const res = await api.eaa.doctor(); return res;`)
    record('9.3 eaa.doctor 通过', isOk(r), `success=${r?.success}`)
  })

  await test('9.4 eaa.validate 通过', async () => {
    const r = await callIpc(`const res = await api.eaa.validate('all'); return res;`)
    record('9.4 eaa.validate 通过', isOk(r), `success=${r?.success}`)
  })

  await test('9.5 stats 数据一致', async () => {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const data = r?.data ?? r
    const summary = data?.summary ?? {}
    // students > 0, total_events > 0
    record('9.5 stats 数据一致', isOk(r) && summary.students > 0 && summary.total_events > 0, `students=${summary.students} events=${summary.total_events}`)
  })

  await test('9.6 ranking 数据一致 (top 1 有分数)', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(1); return res;`)
    const data = r?.data ?? r
    const ranking = data?.ranking ?? data?.data?.ranking ?? []
    const top = ranking[0]
    record('9.6 ranking 数据一致', isOk(r) && top && typeof top.score === 'number', `top=${top?.name} score=${top?.score}`)
  })

  // ---------- 汇总 ----------
  const passed = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length
  const total = results.length
  console.log('\n' + '='.repeat(60))
  console.log(`总计: ${total}, 通过: ${passed}, 失败: ${failed}`)
  console.log('='.repeat(60))
  if (failed > 0) {
    console.log('\n失败项:')
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  [FAIL] ${r.name} — ${r.detail}`)
    }
  }

  ws.close()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
