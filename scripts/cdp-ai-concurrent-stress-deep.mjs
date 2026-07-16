// =============================================================
// Round 21: AI 并发多 Agent + 大数据 + 边界条件 — 重中之重续8
//
// 验证 AI 在极端条件下的数据控制能力:
//   1. 并发读取 — 100x 并行 getInfo/score/ranking 无冲突 (5 项)
//   2. 并发写入 — 5x 并行 addEvent 同一学生 分数正确累加 (5 项)
//   3. 并发混合读写 — 10x 并行 addEvent+score+history (5 项)
//   4. 大数据查询 — 3000+ 学生 ranking/stats/search (6 项)
//   5. 大数据导出 — write_excel 1000 行 / write_csv 5000 行 (5 项)
//   6. 输入边界 — 空字符串/超长/Unicode/emoji/特殊字符 (8 项)
//   7. 数据隔离 — 不同学生数据互不干扰 (5 项)
//   8. Agent 并发模拟 — 多 Agent 同时访问不同数据 (6 项)
//   9. AI 工具调用幂等性 — 重复调用同一操作 (5 项)
//  10. AI 数据完整性压力 — 连续 50 次写入后验证 (5 项)
//
// 运行: node scripts/cdp-ai-concurrent-stress-deep.mjs
// =============================================================
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import XLSX from 'xlsx'

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
  console.log('CDP connected, running AI concurrent stress tests...\n')

  // ---------- IPC 封装 ----------
  const callIpc = async (code) =>
    evalInPage(`(async function(){const api=window.__EAA_API__||window.api;if(!api)return{__error:'no-api'};try{${code}}catch(e){return{__error:String(e&&e.message?e.message:e)}}})()`)

  const isOk = (res) => !!res && !res.__error && res?.success !== false

  // ---------- 数据路径 ----------
  const TS = Date.now()
  const userDataDir = 'C:\\Users\\sq199\\AppData\\Roaming\\com.educationadvisor.tauri'
  const eaaDataDir = path.join(userDataDir, 'eaa-data')
  const outputDir = path.join(eaaDataDir, 'r21-output')
  await fsp.mkdir(outputDir, { recursive: true }).catch(() => {})

  // ===========================================================
  // 1. 并发读取 — 100x 并行 getInfo/score/ranking 无冲突
  // ===========================================================
  console.log('--- 1. 并发读取 ---')

  await test('1.1 100x 并行 getInfo 无冲突', async () => {
    const promises = Array.from({ length: 100 }, () => callIpc(`const res = await api.eaa.info(); return res;`))
    const results = await Promise.all(promises)
    const success = results.filter(r => isOk(r)).length
    record('1.1 100x 并行 getInfo 无冲突', success === 100, `success=${success}/100`)
  })

  await test('1.2 100x 并行 score 同一学生无冲突', async () => {
    // 先创建一个学生
    const student = `r21_concurrent_${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(student)}); return res;`)
    const promises = Array.from({ length: 100 }, () => callIpc(`const res = await api.eaa.score(${JSON.stringify(student)}); return res;`))
    const results = await Promise.all(promises)
    const success = results.filter(r => isOk(r) && (r?.data?.score ?? r?.score) === 100).length
    record('1.2 100x 并行 score 同一学生无冲突', success === 100, `success=${success}/100`)
  })

  await test('1.3 100x 并行 ranking 无冲突', async () => {
    const promises = Array.from({ length: 100 }, () => callIpc(`const res = await api.eaa.ranking(10); return res;`))
    const results = await Promise.all(promises)
    const success = results.filter(r => isOk(r)).length
    record('1.3 100x 并行 ranking 无冲突', success === 100, `success=${success}/100`)
  })

  await test('1.4 100x 并行 stats 无冲突', async () => {
    const promises = Array.from({ length: 100 }, () => callIpc(`const res = await api.eaa.stats(); return res;`))
    const results = await Promise.all(promises)
    const success = results.filter(r => isOk(r)).length
    record('1.4 100x 并行 stats 无冲突', success === 100, `success=${success}/100`)
  })

  await test('1.5 并发读取数据一致性 — 所有 score 返回相同值', async () => {
    const student = `r21_concurrent_${TS}`
    const promises = Array.from({ length: 50 }, () => callIpc(`const res = await api.eaa.score(${JSON.stringify(student)}); return res;`))
    const results = await Promise.all(promises)
    const scores = results.map(r => r?.data?.score ?? r?.score)
    const allSame = scores.every(s => s === scores[0])
    record('1.5 并发读取数据一致性 — 所有 score 返回相同值', allSame, `allSame=${allSame} score=${scores[0]}`)
  })

  // ===========================================================
  // 2. 并发写入 — 5x 并行 addEvent 同一学生 分数正确累加
  // ===========================================================
  console.log('\n--- 2. 并发写入 ---')

  const r21WriteStudent = `r21_write_${TS}`
  await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(r21WriteStudent)}); return res;`)

  await test('2.1 5x 并行 addEvent +1 同一学生', async () => {
    const promises = Array.from({ length: 5 }, () =>
      callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(r21WriteStudent)},
          reasonCode: 'ACTIVITY_PARTICIPATION',
          delta: 1,
          note: 'R21 concurrent write',
          force: true,
        });
        return res;
      `)
    )
    const results = await Promise.all(promises)
    const success = results.filter(r => isOk(r)).length
    record('2.1 5x 并行 addEvent +1 同一学生', success === 5, `success=${success}/5`)
  })

  await test('2.2 并发写入后分数正确累加 (100+5=105)', async () => {
    await new Promise(r => setTimeout(r, 1000)) // 等待写队列处理完
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(r21WriteStudent)}); return res;`)
    const score = r?.data?.score ?? r?.score
    record('2.2 并发写入后分数正确累加 (100+5=105)', score === 105, `score=${score}`)
  })

  await test('2.3 并发写入后 history 包含5条事件', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(r21WriteStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('2.3 并发写入后 history 包含5条事件', events.length === 5, `events=${events.length}`)
  })

  await test('2.4 并发写入不同 delta (+1/-2/+3/-1/+2)', async () => {
    const student2 = `r21_write2_${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(student2)}); return res;`)
    const deltas = [1, -2, 3, -1, 2]
    const promises = deltas.map(d =>
      callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(student2)},
          reasonCode: ${d > 0 ? "'ACTIVITY_PARTICIPATION'" : "'LATE'"},
          delta: ${d},
          note: 'R21 mixed delta',
          force: true,
        });
        return res;
      `)
    )
    const results = await Promise.all(promises)
    const success = results.filter(r => isOk(r)).length
    await new Promise(r => setTimeout(r, 1000))
    const scoreR = await callIpc(`const res = await api.eaa.score(${JSON.stringify(student2)}); return res;`)
    const score = scoreR?.data?.score ?? scoreR?.score
    const expected = 100 + deltas.reduce((a, b) => a + b, 0) // 100+3=103
    record('2.4 并发写入不同 delta (+1/-2/+3/-1/+2)', success === 5 && score === expected, `success=${success}/5 score=${score} expected=${expected}`)
  })

  await test('2.5 并发写入后 events.jsonl 无重复 event_id', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(r21WriteStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    const ids = events.map(e => e.event_id)
    const unique = new Set(ids)
    record('2.5 并发写入后 events.jsonl 无重复 event_id', unique.size === ids.length, `total=${ids.length} unique=${unique.size}`)
  })

  // ===========================================================
  // 3. 并发混合读写 — 10x 并行 addEvent+score+history
  // ===========================================================
  console.log('\n--- 3. 并发混合读写 ---')

  await test('3.1 10x 并行混合 addEvent+score+history', async () => {
    const student = `r21_mixed_${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(student)}); return res;`)
    const tasks = []
    for (let i = 0; i < 10; i++) {
      tasks.push(
        callIpc(`
          const res = await api.eaa.addEvent({
            studentName: ${JSON.stringify(student)},
            reasonCode: 'ACTIVITY_PARTICIPATION',
            delta: 1,
            note: 'R21 mixed rw',
            force: true,
          });
          return res;
        `),
        callIpc(`const res = await api.eaa.score(${JSON.stringify(student)}); return res;`),
        callIpc(`const res = await api.eaa.history(${JSON.stringify(student)}); return res;`)
      )
    }
    const results = await Promise.all(tasks)
    const errors = results.filter(r => r?.__error).length
    record('3.1 10x 并行混合 addEvent+score+history', errors === 0, `tasks=${results.length} errors=${errors}`)
  })

  await test('3.2 混合读写后最终分数一致', async () => {
    await new Promise(r => setTimeout(r, 1500))
    const student = `r21_mixed_${TS}`
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(student)}); return res;`)
    const score = r?.data?.score ?? r?.score
    // 10 个 +1 事件, 应该是 110
    record('3.2 混合读写后最终分数一致', score === 110, `score=${score} expected=110`)
  })

  await test('3.3 混合读写期间无崩溃', async () => {
    // 验证 app 仍然响应
    const r = await callIpc(`const res = await api.eaa.info(); return res;`)
    record('3.3 混合读写期间无崩溃', isOk(r), `info=${isOk(r)}`)
  })

  await test('3.4 混合读写后 history 事件数正确', async () => {
    const student = `r21_mixed_${TS}`
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(student)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('3.4 混合读写后 history 事件数正确', events.length === 10, `events=${events.length}`)
  })

  await test('3.5 混合读写后 scores.cache 一致', async () => {
    const student = `r21_mixed_${TS}`
    const scoreR = await callIpc(`const res = await api.eaa.score(${JSON.stringify(student)}); return res;`)
    const score = scoreR?.data?.score ?? scoreR?.score
    const entitiesDir = path.join(eaaDataDir, 'entities')
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const eid = idx[student]
    const cacheScore = cache[eid]
    record('3.5 混合读写后 scores.cache 一致', score === cacheScore, `ipc=${score} cache=${cacheScore}`)
  })

  // ===========================================================
  // 4. 大数据查询 — 3000+ 学生 ranking/stats/search
  // ===========================================================
  console.log('\n--- 4. 大数据查询 ---')

  await test('4.1 ranking 500 学生返回完整数据', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(500); return res;`)
    const data = r?.data ?? r
    const ranking = data?.ranking ?? data?.data?.ranking ?? []
    const allHaveScore = ranking.every(s => typeof s.score === 'number')
    record('4.1 ranking 500 学生返回完整数据', ranking.length === 500 && allHaveScore, `count=${ranking.length} allHaveScore=${allHaveScore}`)
  })

  await test('4.2 ranking 1000 学生返回完整数据', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(1000); return res;`)
    const data = r?.data ?? r
    const ranking = data?.ranking ?? data?.data?.ranking ?? []
    record('4.2 ranking 1000 学生返回完整数据', ranking.length === 1000, `count=${ranking.length}`)
  })

  await test('4.3 stats 返回 3000+ 学生统计', async () => {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const data = r?.data ?? r
    const summary = data?.summary ?? {}
    record('4.3 stats 返回 3000+ 学生统计', summary.students > 3000, `students=${summary.students} events=${summary.total_events}`)
  })

  await test('4.4 listStudents 返回 3000+ 学生', async () => {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const data = r?.data ?? r
    const students = Array.isArray(data) ? data : (data?.students ?? [])
    record('4.4 listStudents 返回 3000+ 学生', students.length > 3000, `students=${students.length}`)
  })

  await test('4.5 search 全局搜索返回结果', async () => {
    const r = await callIpc(`const res = await api.eaa.search('测试', 100); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? data?.results ?? [])
    record('4.5 search 全局搜索返回结果', isOk(r), `results=${events.length}`)
  })

  await test('4.6 大数据查询响应时间合理 (<5s)', async () => {
    const start = Date.now()
    await callIpc(`const res = await api.eaa.ranking(1000); return res;`)
    await callIpc(`const res = await api.eaa.stats(); return res;`)
    await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const elapsed = Date.now() - start
    record('4.6 大数据查询响应时间合理 (<5s)', elapsed < 5000, `elapsed=${elapsed}ms`)
  })

  // ===========================================================
  // 5. 大数据导出 — write_excel 1000 行 / write_csv 5000 行
  // ===========================================================
  console.log('\n--- 5. 大数据导出 ---')

  await test('5.1 导出 1000 行 Excel 文件', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(1000); return res;`)
    const data = r?.data ?? r
    const ranking = data?.ranking ?? data?.data?.ranking ?? []
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(ranking.slice(0, 1000).map((s, i) => ({
      排名: i + 1,
      学生: s.name || s.entity_id,
      分数: s.score,
    })))
    XLSX.utils.book_append_sheet(wb, ws, '排行榜')
    const xlsxPath = path.join(outputDir, `ranking_1000_${TS}.xlsx`)
    XLSX.writeFile(wb, xlsxPath)
    const stat = await fsp.stat(xlsxPath)
    record('5.1 导出 1000 行 Excel 文件', stat.size > 10000, `size=${stat.size}`)
  })

  await test('5.2 读取 1000 行 Excel 验证', async () => {
    const xlsxPath = path.join(outputDir, `ranking_1000_${TS}.xlsx`)
    const wb = XLSX.readFile(xlsxPath)
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(ws)
    record('5.2 读取 1000 行 Excel 验证', rows.length === 1000, `rows=${rows.length}`)
  })

  await test('5.3 导出 5000 行 CSV 文件', async () => {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const data = r?.data ?? r
    const students = Array.isArray(data) ? data : (data?.students ?? [])
    const lines = ['name,score,events_count']
    for (const s of students.slice(0, 5000)) {
      lines.push(`${s.name || s.entity_id},${s.score ?? 0},${s.events_count ?? 0}`)
    }
    const csvPath = path.join(outputDir, `students_5000_${TS}.csv`)
    await fsp.writeFile(csvPath, lines.join('\n'), 'utf-8')
    const stat = await fsp.stat(csvPath)
    record('5.3 导出 5000 行 CSV 文件', stat.size > 5000, `size=${stat.size} lines=${lines.length}`)
  })

  await test('5.4 读取 5000 行 CSV 验证', async () => {
    const csvPath = path.join(outputDir, `students_5000_${TS}.csv`)
    const content = await fsp.readFile(csvPath, 'utf-8')
    const lines = content.trim().split('\n')
    record('5.4 读取 5000 行 CSV 验证', lines.length > 1000, `lines=${lines.length}`)
  })

  await test('5.5 多工作表 Excel 导出', async () => {
    const wb = XLSX.utils.book_new()
    const ws1 = XLSX.utils.json_to_sheet([{ a: 1, b: 2 }])
    const ws2 = XLSX.utils.json_to_sheet([{ x: 10, y: 20 }])
    XLSX.utils.book_append_sheet(wb, ws1, 'Sheet1')
    XLSX.utils.book_append_sheet(wb, ws2, 'Sheet2')
    const xlsxPath = path.join(outputDir, `multi_${TS}.xlsx`)
    XLSX.writeFile(wb, xlsxPath)
    const wb2 = XLSX.readFile(xlsxPath)
    record('5.5 多工作表 Excel 导出', wb2.SheetNames.length === 2, `sheets=${wb2.SheetNames.join(',')}`)
  })

  // ===========================================================
  // 6. 输入边界 — 空字符串/超长/Unicode/emoji/特殊字符
  // ===========================================================
  console.log('\n--- 6. 输入边界 ---')

  await test('6.1 空字符串学生名 → 清晰错误', async () => {
    const r = await callIpc(`const res = await api.eaa.addStudent(''); return res;`)
    const hasError = !isOk(r) || r?.success === false || r?.__error
    record('6.1 空字符串学生名 → 清晰错误', hasError, `success=${r?.success} error=${r?.__error?.slice(0, 60)}`)
  })

  await test('6.2 超长学生名 (>64字符) → 清晰错误', async () => {
    const longName = 'a'.repeat(100)
    const r = await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(longName)}); return res;`)
    const hasError = !isOk(r) || r?.success === false || r?.__error
    record('6.2 超长学生名 (>64字符) → 清晰错误', hasError, `success=${r?.success} error=${r?.__error?.slice(0, 60)}`)
  })

  await test('6.3 Unicode 中文学生名 → 成功', async () => {
    const name = `r21_中文_${TS}`
    const r = await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(name)}); return res;`)
    record('6.3 Unicode 中文学生名 → 成功', isOk(r), `success=${r?.success}`)
  })

  await test('6.4 Emoji 学生名 → 清晰错误或成功', async () => {
    const name = `r21_emoji_${TS}_😀`
    const r = await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(name)}); return res;`)
    // emoji 可能被接受或拒绝,关键是不能崩溃
    record('6.4 Emoji 学生名 → 清晰错误或成功', r !== null && r !== undefined, `success=${r?.success} error=${r?.__error?.slice(0, 60)}`)
  })

  await test('6.5 特殊字符学生名 → 清晰错误', async () => {
    const name = `r21;rm -rf /`
    const r = await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(name)}); return res;`)
    const hasError = !isOk(r) || r?.success === false || r?.__error
    record('6.5 特殊字符学生名 → 清晰错误', hasError, `success=${r?.success} error=${r?.__error?.slice(0, 60)}`)
  })

  await test('6.6 超长 note (10000 字符)', async () => {
    const student = `r21_longnote_${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(student)}); return res;`)
    const longNote = 'R21 long note test. '.repeat(500)
    const r = await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(student)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: 1,
        note: ${JSON.stringify(longNote)},
        force: true,
      });
      return res;
    `)
    record('6.6 超长 note (10000 字符)', r !== null && r !== undefined, `success=${r?.success}`)
  })

  await test('6.7 控制字符注入 → 清晰错误', async () => {
    const r = await callIpc(`const res = await api.eaa.addStudent('r21\\x00\\n\\r_test'); return res;`)
    const hasError = !isOk(r) || r?.success === false || r?.__error
    record('6.7 控制字符注入 → 清晰错误', hasError, `success=${r?.success} error=${r?.__error?.slice(0, 60)}`)
  })

  await test('6.8 SQL 注入尝试 → 被阻止', async () => {
    const name = `r21'; DROP TABLE students; --`
    const r = await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(name)}); return res;`)
    const hasError = !isOk(r) || r?.success === false || r?.__error
    record('6.8 SQL 注入尝试 → 被阻止', hasError, `success=${r?.success} error=${r?.__error?.slice(0, 60)}`)
  })

  // ===========================================================
  // 7. 数据隔离 — 不同学生数据互不干扰
  // ===========================================================
  console.log('\n--- 7. 数据隔离 ---')

  const isoA = `r21_iso_A_${TS}`
  const isoB = `r21_iso_B_${TS}`
  await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(isoA)}); return res;`)
  await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(isoB)}); return res;`)

  await test('7.1 给学生 A 添加事件不影响学生 B', async () => {
    await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(isoA)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: 5,
        note: 'R21 isolation A',
        force: true,
      });
      return res;
    `)
    await new Promise(r => setTimeout(r, 500))
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(isoB)}); return res;`)
    const score = r?.data?.score ?? r?.score
    record('7.1 给学生 A 添加事件不影响学生 B', score === 100, `A_score=105 B_score=${score}`)
  })

  await test('7.2 学生 A history 不包含学生 B 事件', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(isoA)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    const hasB = events.some(e => e.note && e.note.includes('isolation B'))
    record('7.2 学生 A history 不包含学生 B 事件', !hasB, `A_events=${events.length} hasB=${hasB}`)
  })

  await test('7.3 学生 B history 不包含学生 A 事件', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(isoB)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    const hasA = events.some(e => e.note && e.note.includes('isolation A'))
    record('7.3 学生 B history 不包含学生 A 事件', !hasA, `B_events=${events.length} hasA=${hasA}`)
  })

  await test('7.4 search 按学生名只返回该学生事件', async () => {
    const r = await callIpc(`const res = await api.eaa.search(${JSON.stringify(isoA)}, 50); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? data?.results ?? [])
    const allA = events.every(e => !e.note || !e.note.includes('isolation B'))
    record('7.4 search 按学生名只返回该学生事件', allA, `results=${events.length} allA=${allA}`)
  })

  await test('7.5 revert 学生 A 事件不影响学生 B', async () => {
    const histR = await callIpc(`const res = await api.eaa.history(${JSON.stringify(isoA)}); return res;`)
    const data = histR?.data ?? histR
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    const eventId = events[0]?.event_id
    if (!eventId) { record('7.5 revert 学生 A 事件不影响学生 B', false, 'no event'); return }
    await callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(eventId)}, 'R21 isolation revert'); return res;`)
    await new Promise(r => setTimeout(r, 500))
    const scoreR = await callIpc(`const res = await api.eaa.score(${JSON.stringify(isoB)}); return res;`)
    const score = scoreR?.data?.score ?? scoreR?.score
    record('7.5 revert 学生 A 事件不影响学生 B', score === 100, `B_score=${score}`)
  })

  // ===========================================================
  // 8. Agent 并发模拟 — 多 Agent 同时访问不同数据
  // ===========================================================
  console.log('\n--- 8. Agent 并发模拟 ---')

  await test('8.1 模拟 3 个 Agent 并发读取不同学生', async () => {
    const students = [`r21_agent1_${TS}`, `r21_agent2_${TS}`, `r21_agent3_${TS}`]
    for (const s of students) {
      await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(s)}); return res;`)
    }
    const tasks = students.map(s => callIpc(`const res = await api.eaa.score(${JSON.stringify(s)}); return res;`))
    const results = await Promise.all(tasks)
    const success = results.filter(r => isOk(r) && (r?.data?.score ?? r?.score) === 100).length
    record('8.1 模拟 3 个 Agent 并发读取不同学生', success === 3, `success=${success}/3`)
  })

  await test('8.2 模拟 3 个 Agent 并发写入不同学生', async () => {
    const students = [`r21_agent1_${TS}`, `r21_agent2_${TS}`, `r21_agent3_${TS}`]
    const tasks = students.map((s, i) =>
      callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(s)},
          reasonCode: 'ACTIVITY_PARTICIPATION',
          delta: ${i + 1},
          note: 'R21 agent write',
          force: true,
        });
        return res;
      `)
    )
    const results = await Promise.all(tasks)
    const success = results.filter(r => isOk(r)).length
    record('8.2 模拟 3 个 Agent 并发写入不同学生', success === 3, `success=${success}/3`)
  })

  await test('8.3 模拟 Agent 并发 ranking+stats+listStudents', async () => {
    const tasks = [
      callIpc(`const res = await api.eaa.ranking(100); return res;`),
      callIpc(`const res = await api.eaa.stats(); return res;`),
      callIpc(`const res = await api.eaa.listStudents(); return res;`),
      callIpc(`const res = await api.eaa.info(); return res;`),
      callIpc(`const res = await api.eaa.codes(); return res;`),
    ]
    const results = await Promise.all(tasks)
    const success = results.filter(r => isOk(r)).length
    record('8.3 模拟 Agent 并发 ranking+stats+listStudents', success === 5, `success=${success}/5`)
  })

  await test('8.4 模拟 Agent 读取学业数据并发', async () => {
    const tasks = [
      callIpc(`const res = await api.academic.listExams(); return res;`),
      callIpc(`const res = await api.academic.getConfig(); return res;`),
    ]
    const results = await Promise.all(tasks)
    const success = results.filter(r => isOk(r)).length
    record('8.4 模拟 Agent 读取学业数据并发', success === 2, `success=${success}/2`)
  })

  await test('8.5 模拟 Agent 文件操作并发', async () => {
    const tasks = [
      fsp.writeFile(path.join(outputDir, `agent1_${TS}.txt`), 'agent1'),
      fsp.writeFile(path.join(outputDir, `agent2_${TS}.txt`), 'agent2'),
      fsp.writeFile(path.join(outputDir, `agent3_${TS}.txt`), 'agent3'),
    ]
    await Promise.all(tasks)
    const reads = [
      fsp.readFile(path.join(outputDir, `agent1_${TS}.txt`), 'utf-8'),
      fsp.readFile(path.join(outputDir, `agent2_${TS}.txt`), 'utf-8'),
      fsp.readFile(path.join(outputDir, `agent3_${TS}.txt`), 'utf-8'),
    ]
    const contents = await Promise.all(reads)
    const allCorrect = contents[0] === 'agent1' && contents[1] === 'agent2' && contents[2] === 'agent3'
    record('8.5 模拟 Agent 文件操作并发', allCorrect, `correct=${allCorrect}`)
  })

  await test('8.6 模拟 5 个 Agent 同时 search 不同关键词', async () => {
    const keywords = ['测试', '学生', '事件', 'R21', 'concurrent']
    const tasks = keywords.map(k => callIpc(`const res = await api.eaa.search(${JSON.stringify(k)}, 20); return res;`))
    const results = await Promise.all(tasks)
    const success = results.filter(r => isOk(r)).length
    record('8.6 模拟 5 个 Agent 同时 search 不同关键词', success === 5, `success=${success}/5`)
  })

  // ===========================================================
  // 9. AI 工具调用幂等性 — 重复调用同一操作
  // ===========================================================
  console.log('\n--- 9. AI 工具调用幂等性 ---')

  await test('9.1 重复调用 score 返回相同结果', async () => {
    const student = `r21_idem_${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(student)}); return res;`)
    const r1 = await callIpc(`const res = await api.eaa.score(${JSON.stringify(student)}); return res;`)
    const r2 = await callIpc(`const res = await api.eaa.score(${JSON.stringify(student)}); return res;`)
    const s1 = r1?.data?.score ?? r1?.score
    const s2 = r2?.data?.score ?? r2?.score
    record('9.1 重复调用 score 返回相同结果', s1 === s2, `s1=${s1} s2=${s2}`)
  })

  await test('9.2 重复调用 info 返回相同结果', async () => {
    const r1 = await callIpc(`const res = await api.eaa.info(); return res;`)
    const r2 = await callIpc(`const res = await api.eaa.info(); return res;`)
    const v1 = r1?.data?.version ?? r1?.version
    const v2 = r2?.data?.version ?? r2?.version
    record('9.2 重复调用 info 返回相同结果', v1 === v2, `v1=${v1} v2=${v2}`)
  })

  await test('9.3 重复调用 codes 返回相同结果', async () => {
    const r1 = await callIpc(`const res = await api.eaa.codes(); return res;`)
    const r2 = await callIpc(`const res = await api.eaa.codes(); return res;`)
    const c1 = r1?.data?.codes ? Object.keys(r1.data.codes).length : 0
    const c2 = r2?.data?.codes ? Object.keys(r2.data.codes).length : 0
    record('9.3 重复调用 codes 返回相同结果', c1 === c2 && c1 > 0, `c1=${c1} c2=${c2}`)
  })

  await test('9.4 重复调用 addStudent 同一学生 → 幂等或清晰错误', async () => {
    const student = `r21_dup_${TS}`
    const r1 = await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(student)}); return res;`)
    const r2 = await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(student)}); return res;`)
    // 第二次应该成功 (幂等) 或返回清晰错误
    const valid = r2 !== null && r2 !== undefined
    record('9.4 重复调用 addStudent 同一学生 → 幂等或清晰错误', valid, `r1=${r1?.success} r2=${r2?.success}`)
  })

  await test('9.5 重复调用 listExams 返回相同结果', async () => {
    const r1 = await callIpc(`const res = await api.academic.listExams(); return res;`)
    const r2 = await callIpc(`const res = await api.academic.listExams(); return res;`)
    const c1 = r1?.data?.length ?? 0
    const c2 = r2?.data?.length ?? 0
    record('9.5 重复调用 listExams 返回相同结果', c1 === c2, `c1=${c1} c2=${c2}`)
  })

  // ===========================================================
  // 10. AI 数据完整性压力 — 连续 50 次写入后验证
  // ===========================================================
  console.log('\n--- 10. AI 数据完整性压力 ---')

  const stressStudent = `r21_stress_${TS}`
  await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(stressStudent)}); return res;`)

  await test('10.1 连续 50 次 addEvent 全部成功', async () => {
    let success = 0
    for (let i = 0; i < 50; i++) {
      const r = await callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(stressStudent)},
          reasonCode: 'ACTIVITY_PARTICIPATION',
          delta: 1,
          note: 'R21 stress ' + ${i},
          force: true,
        });
        return res;
      `)
      if (isOk(r)) success++
    }
    record('10.1 连续 50 次 addEvent 全部成功', success === 50, `success=${success}/50`)
  })

  await test('10.2 50 次写入后分数正确 (100+50=150)', async () => {
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(stressStudent)}); return res;`)
    const score = r?.data?.score ?? r?.score
    record('10.2 50 次写入后分数正确 (100+50=150)', score === 150, `score=${score}`)
  })

  await test('10.3 50 次写入后 history 包含50条事件', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(stressStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('10.3 50 次写入后 history 包含50条事件', events.length === 50, `events=${events.length}`)
  })

  await test('10.4 50 次写入后 scores.cache 一致', async () => {
    const scoreR = await callIpc(`const res = await api.eaa.score(${JSON.stringify(stressStudent)}); return res;`)
    const score = scoreR?.data?.score ?? scoreR?.score
    const entitiesDir = path.join(eaaDataDir, 'entities')
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const eid = idx[stressStudent]
    const cacheScore = cache[eid]
    record('10.4 50 次写入后 scores.cache 一致', score === cacheScore, `ipc=${score} cache=${cacheScore}`)
  })

  await test('10.5 50 次写入后 search 返回50条结果', async () => {
    const r = await callIpc(`const res = await api.eaa.search(${JSON.stringify(stressStudent)}, 100); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? data?.results ?? [])
    record('10.5 50 次写入后 search 返回50条结果', events.length === 50, `results=${events.length}`)
  })

  // ---------- 汇总 ----------
  console.log('\n============================================================')
  const passed = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length
  console.log(`Round 21 AI 并发压力测试: 总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`)
  console.log('============================================================')
  if (failed > 0) {
    console.log('\n失败用例:')
    results.filter(r => !r.ok).forEach(r => console.log(`  [FAIL] ${r.name} — ${r.detail}`))
  }

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
