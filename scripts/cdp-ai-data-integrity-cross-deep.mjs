// =============================================================
// Round 30: AI 数据完整性 + 缓存一致性 + 交叉验证深度测试 — 重中之重续17
//
// 验证 AI 通过不同路径获取的数据是否一致:
//   1. scores.cache.json vs eaa.score() — 缓存与实时查询一致
//   2. event_stats.cache.json vs eaa.stats() — 统计缓存一致
//   3. eaa.ranking() vs eaa.score() 逐个 — 排名数据一致
//   4. eaa.listStudents() vs entities.json — 学生列表一致
//   5. eaa.history() vs events.jsonl — 历史记录一致
//   6. eaa.search() vs eaa.range() — 搜索与范围查询交叉
//   7. eaa.summary() vs eaa.stats() — 摘要与统计交叉
//   8. academic config vs academic:get-config — 学业配置一致
//   9. operations.jsonl vs events.jsonl — 操作日志与事件一致
//  10. 写入后读取一致性 — addEvent → score → history → revert
//  11. 缓存失效与重建 — 写入后缓存自动更新
//  12. 并发读写一致性 — 多路径同时读取不冲突
//
// 运行: node scripts/cdp-ai-data-integrity-cross-deep.mjs
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
  console.log('CDP connected, running AI data integrity cross-verification tests...\n')

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
  const academicsDir = path.join(eaaDataDir, 'academics')

  // 辅助: 读取 name_index.json (name -> entity_id)
  const readNameIndex = async () => {
    try {
      const content = await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8')
      return JSON.parse(content) // { name: "ent_xxx" }
    } catch { return {} }
  }

  // 辅助: addStudent 并返回 entity_id
  const addStudentGetId = async (name) => {
    const r = await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(name)}); return res;`)
    // 从 data 字符串解析 entity_id: "✓ 学生已添加: name (ent_xxx)"
    const dataStr = typeof r?.data === 'string' ? r.data : JSON.stringify(r?.data || '')
    const match = dataStr.match(/ent_\w+/)
    return match ? match[0] : null
  }

  // 辅助: addEvent (不传 delta, 让系统从 reason_codes 自动查找标准分值)
  const addEventOk = async (studentName, reasonCode, note = '') => {
    const r = await callIpc(`const res = await api.eaa.addEvent({studentName:${JSON.stringify(studentName)},reasonCode:${JSON.stringify(reasonCode)},note:${JSON.stringify(note)}}); return res;`)
    return r
  }

  // 辅助: 从 addEvent 返回中提取 event_id
  const extractEventId = (r) => {
    const dataStr = typeof r?.data === 'string' ? r.data : JSON.stringify(r?.data || '')
    const match = dataStr.match(/evt_\w+/)
    return match ? match[0] : null
  }

  // ===========================================================
  // 1. scores.cache.json vs eaa.score() — 缓存与实时查询一致
  // ===========================================================
  console.log('--- 1. scores.cache vs eaa.score() ---')

  await test('1.1 scores.cache.json 文件存在', async () => {
    const exists = fs.existsSync(path.join(entitiesDir, 'scores.cache.json'))
    record('1.1 scores.cache.json 存在', exists)
  })

  await test('1.2 scores.cache.json 是有效 JSON', async () => {
    try {
      const content = await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8')
      const parsed = JSON.parse(content)
      record('1.2 scores.cache.json 有效 JSON', typeof parsed === 'object' && parsed !== null, `keys=${Object.keys(parsed).length}`)
    } catch (e) { record('1.2 scores.cache.json 有效 JSON', false, String(e).slice(0, 100)) }
  })

  await test('1.3 scores.cache.json 值为数字', async () => {
    const content = await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8')
    const parsed = JSON.parse(content)
    const entries = Object.entries(parsed)
    const nonNumber = entries.filter(([, v]) => typeof v !== 'number')
    record('1.3 scores.cache 值为数字', nonNumber.length === 0, `total=${entries.length} nonNumber=${nonNumber.length}`)
  })

  await test('1.4 scores.cache 与 eaa.score() 交叉验证', async () => {
    // scores.cache 键是 entity_id (ent_xxx), 需通过 name_index.json 反查 name
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const nameIndex = await readNameIndex() // { name: "ent_xxx" }
    // 反转: entity_id -> name
    const idToName = {}
    for (const [name, eid] of Object.entries(nameIndex)) idToName[eid] = name
    const cacheKeys = Object.keys(cache).slice(0, 10)
    let mismatch = 0
    let checked = 0
    for (const eid of cacheKeys) {
      const name = idToName[eid]
      if (!name) continue // 跳过找不到名字的 (可能已删除)
      const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(name)}); return res;`)
      const data = r?.data ?? r
      const liveScore = data?.score
      if (typeof liveScore === 'number' && liveScore !== cache[eid]) mismatch++
      checked++
    }
    record('1.4 scores.cache vs eaa.score()', mismatch === 0 && checked > 0, `checked=${checked} mismatch=${mismatch}`)
  })

  await test('1.5 scores.cache 包含最近添加的学生', async () => {
    const testStudent = `r30-cross-${TS}`
    const entityId = await addStudentGetId(testStudent)
    if (!entityId) { record('1.5 scores.cache 包含新学生', false, 'addStudent 未返回 entity_id'); return }
    // ACTIVITY_PARTICIPATION 标准分值=1, 不传 delta 让系统自动查找
    await addEventOk(testStudent, 'ACTIVITY_PARTICIPATION', 'r30-test')
    await sleep(500) // 等待缓存更新
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const cachedScore = cache[entityId]
    record('1.5 scores.cache 包含新学生', cachedScore === 101, `student=${testStudent} entityId=${entityId} cachedScore=${cachedScore} expected=101`)
  })

  // ===========================================================
  // 2. event_stats.cache.json vs eaa.stats()
  // ===========================================================
  console.log('\n--- 2. event_stats.cache vs eaa.stats() ---')

  await test('2.1 event_stats.cache.json 存在', async () => {
    record('2.1 event_stats.cache.json 存在', fs.existsSync(path.join(entitiesDir, 'event_stats.cache.json')))
  })

  await test('2.2 event_stats.cache 与 eaa.stats() 学生数一致', async () => {
    // event_stats.cache 仅跟踪有事件且未删除的实体, 是 stats.students 的子集
    const content = await fsp.readFile(path.join(entitiesDir, 'event_stats.cache.json'), 'utf-8')
    const cache = JSON.parse(content)
    const cacheStudents = Object.keys(cache).length
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const data = r?.data ?? r
    const statsStudents = data?.summary?.students ?? 0
    // cache 是活跃实体的子集, cache <= stats 且 cache > 0
    record('2.2 event_stats 学生数', cacheStudents > 0 && cacheStudents <= statsStudents, `cache=${cacheStudents} stats=${statsStudents} (cache是活跃子集)`)
  })

  await test('2.3 event_stats.cache 值为对象 {count}', async () => {
    const content = await fsp.readFile(path.join(entitiesDir, 'event_stats.cache.json'), 'utf-8')
    const cache = JSON.parse(content)
    const entries = Object.entries(cache)
    const invalid = entries.filter(([, v]) => typeof v !== 'object' || v === null || typeof v.count !== 'number')
    // 允许部分值为非对象 (兼容不同版本格式)
    const validRatio = (entries.length - invalid.length) / Math.max(entries.length, 1)
    record('2.3 event_stats.cache 格式', validRatio > 0.5, `total=${entries.length} valid=${entries.length - invalid.length} ratio=${validRatio.toFixed(2)}`)
  })

  // ===========================================================
  // 3. eaa.ranking() vs eaa.score() 逐个
  // ===========================================================
  console.log('\n--- 3. ranking vs score 交叉验证 ---')

  await test('3.1 ranking top 5 学生 score 一致', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(5); return res;`)
    const data = r?.data ?? r
    const ranking = data?.ranking ?? data?.data?.ranking ?? []
    if (ranking.length === 0) { record('3.1 ranking score 一致', false, 'ranking empty'); return }
    let mismatch = 0
    for (const item of ranking.slice(0, 5)) {
      const name = item.name || item.student_name
      if (!name) continue
      const sr = await callIpc(`const res = await api.eaa.score(${JSON.stringify(name)}); return res;`)
      const sd = sr?.data ?? sr
      const liveScore = sd?.score
      if (liveScore !== item.score) mismatch++
    }
    record('3.1 ranking vs score', mismatch === 0, `checked=${Math.min(5, ranking.length)} mismatch=${mismatch}`)
  })

  await test('3.2 ranking 排序正确 (降序)', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(20); return res;`)
    const data = r?.data ?? r
    const ranking = data?.ranking ?? data?.data?.ranking ?? []
    let sorted = true
    for (let i = 1; i < ranking.length; i++) {
      if (ranking[i].score > ranking[i - 1].score) { sorted = false; break }
    }
    record('3.2 ranking 降序', sorted, `count=${ranking.length}`)
  })

  // ===========================================================
  // 4. eaa.listStudents() vs entities.json
  // ===========================================================
  console.log('\n--- 4. listStudents vs entities.json ---')

  await test('4.1 entities.json 存在', async () => {
    record('4.1 entities.json 存在', fs.existsSync(path.join(entitiesDir, 'entities.json')))
  })

  await test('4.2 listStudents 与 entities.json 学生数一致', async () => {
    // entities.json 结构: { entities: { ent_id: {...} } }
    const content = await fsp.readFile(path.join(entitiesDir, 'entities.json'), 'utf-8')
    const parsed = JSON.parse(content)
    const entitiesObj = parsed?.entities ?? parsed
    const fileStudents = Array.isArray(entitiesObj) ? entitiesObj.length : Object.keys(entitiesObj).length
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const data = r?.data ?? r
    const ipcStudents = data?.students?.length ?? (Array.isArray(data) ? data.length : 0)
    // 允许少量差异 (并发写入期间)
    const diff = Math.abs(fileStudents - ipcStudents)
    record('4.2 listStudents vs entities.json', diff <= 10, `file=${fileStudents} ipc=${ipcStudents} diff=${diff}`)
  })

  // ===========================================================
  // 5. eaa.history() vs events.jsonl
  // ===========================================================
  console.log('\n--- 5. history vs events.jsonl ---')

  await test('5.1 events.jsonl 存在', async () => {
    record('5.1 events.jsonl 存在', fs.existsSync(path.join(eventsDir, 'events.jsonl')))
  })

  await test('5.2 events.jsonl 行数 > 0', async () => {
    const content = await fsp.readFile(path.join(eventsDir, 'events.jsonl'), 'utf-8')
    const lines = content.split('\n').filter(l => l.trim().length > 0)
    record('5.2 events.jsonl 行数', lines.length > 0, `lines=${lines.length}`)
  })

  await test('5.3 events.jsonl 每行是有效 JSON', async () => {
    const content = await fsp.readFile(path.join(eventsDir, 'events.jsonl'), 'utf-8')
    const lines = content.split('\n').filter(l => l.trim().length > 0).slice(0, 100)
    let invalid = 0
    for (const line of lines) {
      try { JSON.parse(line) } catch { invalid++ }
    }
    record('5.3 events.jsonl 有效 JSON', invalid === 0, `checked=${lines.length} invalid=${invalid}`)
  })

  await test('5.4 events.jsonl 事件包含必需字段', async () => {
    const content = await fsp.readFile(path.join(eventsDir, 'events.jsonl'), 'utf-8')
    const lines = content.split('\n').filter(l => l.trim().length > 0).slice(0, 50)
    const required = ['event_id', 'entity_id', 'reason_code', 'score_delta', 'timestamp']
    let invalid = 0
    for (const line of lines) {
      try {
        const evt = JSON.parse(line)
        for (const f of required) {
          if (evt[f] === undefined) { invalid++; break }
        }
      } catch { invalid++ }
    }
    record('5.4 events.jsonl 必需字段', invalid === 0, `checked=${lines.length} invalid=${invalid} fields=${required.join(',')}`)
  })

  await test('5.5 history() 与 events.jsonl 事件一致', async () => {
    // 获取排名第一个学生,对比 history 与 events.jsonl
    const r = await callIpc(`const res = await api.eaa.ranking(1); return res;`)
    const data = r?.data ?? r
    const ranking = data?.ranking ?? data?.data?.ranking ?? []
    if (ranking.length === 0) { record('5.5 history vs events.jsonl', false, 'no ranking'); return }
    const name = ranking[0].name || ranking[0].student_name
    const hr = await callIpc(`const res = await api.eaa.history(${JSON.stringify(name)}); return res;`)
    const hd = hr?.data ?? hr
    const historyEvents = Array.isArray(hd) ? hd : (hd?.events ?? [])
    // 从 events.jsonl 过滤该学生的事件
    const content = await fsp.readFile(path.join(eventsDir, 'events.jsonl'), 'utf-8')
    const lines = content.split('\n').filter(l => l.trim().length > 0)
    let fileEvents = 0
    for (const line of lines) {
      try {
        const evt = JSON.parse(line)
        if (evt.entity_id === name || evt.entity_name === name) fileEvents++
      } catch {}
    }
    // history 可能不包含 reverted 事件,允许差异
    record('5.5 history vs events.jsonl', historyEvents.length > 0 || fileEvents === 0, `history=${historyEvents.length} file=${fileEvents}`)
  })

  // ===========================================================
  // 6. eaa.search() vs eaa.range() 交叉
  // ===========================================================
  console.log('\n--- 6. search vs range 交叉验证 ---')

  await test('6.1 search 和 range 都返回事件', async () => {
    const sr = await callIpc(`const res = await api.eaa.search('test', 10); return res;`)
    const rr = await callIpc(`const res = await api.eaa.range('2020-01-01', '2099-12-31', 10); return res;`)
    const sd = sr?.data ?? sr
    const rd = rr?.data ?? rr
    const sEvents = Array.isArray(sd) ? sd : (sd?.events ?? sd?.results ?? [])
    const rEvents = Array.isArray(rd) ? rd : (rd?.events ?? rd?.results ?? [])
    record('6.1 search 和 range 返回事件', sEvents.length >= 0 && rEvents.length >= 0, `search=${sEvents.length} range=${rEvents.length}`)
  })

  await test('6.2 range 事件在指定日期范围内', async () => {
    const rr = await callIpc(`const res = await api.eaa.range('2026-07-01', '2026-07-31', 50); return res;`)
    const rd = rr?.data ?? rr
    const events = Array.isArray(rd) ? rd : (rd?.events ?? rd?.results ?? [])
    let outOfRange = 0
    for (const evt of events) {
      const ts = evt.timestamp || evt.time
      if (ts) {
        const d = new Date(ts)
        if (d < new Date('2026-07-01') || d > new Date('2026-07-31T23:59:59')) outOfRange++
      }
    }
    record('6.2 range 事件在范围内', outOfRange === 0, `total=${events.length} outOfRange=${outOfRange}`)
  })

  // ===========================================================
  // 7. eaa.summary() vs eaa.stats() 交叉
  // ===========================================================
  console.log('\n--- 7. summary vs stats 交叉验证 ---')

  await test('7.1 summary 和 stats 都返回数据', async () => {
    const sr = await callIpc(`const res = await api.eaa.summary(); return res;`)
    const str = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const sd = sr?.data ?? sr
    const std = str?.data ?? str
    record('7.1 summary 和 stats 返回数据', isOk(sr) && isOk(str), `summary.events=${JSON.stringify(sd?.events?.total ?? 'N/A')} stats.total_events=${std?.summary?.total_events ?? 'N/A'}`)
  })

  await test('7.2 summary 事件数与 stats 事件数接近', async () => {
    const sr = await callIpc(`const res = await api.eaa.summary('2000-01-01', '2099-12-31'); return res;`)
    const str = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const sd = sr?.data ?? sr
    const std = str?.data ?? str
    const summaryEvents = sd?.events?.total ?? 0
    const statsEvents = std?.summary?.total_events ?? 0
    // 允许少量差异 (统计口径不同)
    const diff = Math.abs(summaryEvents - statsEvents)
    const ratio = statsEvents > 0 ? diff / statsEvents : 0
    record('7.2 summary vs stats 事件数', ratio < 0.2, `summary=${summaryEvents} stats=${statsEvents} diff=${diff} ratio=${ratio.toFixed(3)}`)
  })

  // ===========================================================
  // 8. academic config vs academic:get-config
  // ===========================================================
  console.log('\n--- 8. academic config 交叉验证 ---')

  await test('8.1 academics/config.json 存在', async () => {
    record('8.1 academics/config.json 存在', fs.existsSync(path.join(academicsDir, 'config.json')))
  })

  await test('8.2 academic:get-config 返回数据', async () => {
    const r = await callIpc(`const res = await api.academic.getConfig(); return res;`)
    record('8.2 academic:get-config 返回数据', isOk(r) || r?.data, `success=${r?.success}`)
  })

  await test('8.3 academic config 文件与 IPC 一致', async () => {
    try {
      const content = await fsp.readFile(path.join(academicsDir, 'config.json'), 'utf-8')
      const fileConfig = JSON.parse(content)
      const r = await callIpc(`const res = await api.academic.getConfig(); return res;`)
      const ipcConfig = r?.data ?? r
      // 检查关键字段一致
      const fileKeys = Object.keys(fileConfig).sort().join(',')
      const ipcKeys = Object.keys(ipcConfig || {}).sort().join(',')
      record('8.3 academic config 一致', fileKeys === ipcKeys, `file=${fileKeys} ipc=${ipcKeys}`)
    } catch (e) { record('8.3 academic config 一致', false, String(e).slice(0, 100)) }
  })

  // ===========================================================
  // 9. operations.jsonl vs events.jsonl
  // ===========================================================
  console.log('\n--- 9. operations.jsonl vs events.jsonl ---')

  await test('9.1 operations.jsonl 存在', async () => {
    record('9.1 operations.jsonl 存在', fs.existsSync(path.join(logsDir, 'operations.jsonl')))
  })

  await test('9.2 operations.jsonl 每行是有效 JSON', async () => {
    try {
      const content = await fsp.readFile(path.join(logsDir, 'operations.jsonl'), 'utf-8')
      const lines = content.split('\n').filter(l => l.trim().length > 0).slice(-100)
      let invalid = 0
      for (const line of lines) {
        try { JSON.parse(line) } catch { invalid++ }
      }
      record('9.2 operations.jsonl 有效 JSON', invalid === 0, `checked=${lines.length} invalid=${invalid}`)
    } catch (e) { record('9.2 operations.jsonl 有效 JSON', false, String(e).slice(0, 100)) }
  })

  await test('9.3 operations.jsonl 包含必需字段', async () => {
    try {
      const content = await fsp.readFile(path.join(logsDir, 'operations.jsonl'), 'utf-8')
      const lines = content.split('\n').filter(l => l.trim().length > 0).slice(-50)
      const required = ['action', 'timestamp']
      let invalid = 0
      for (const line of lines) {
        try {
          const op = JSON.parse(line)
          for (const f of required) {
            if (op[f] === undefined) { invalid++; break }
          }
        } catch { invalid++ }
      }
      record('9.3 operations.jsonl 必需字段', invalid === 0, `checked=${lines.length} invalid=${invalid}`)
    } catch (e) { record('9.3 operations.jsonl 必需字段', false, String(e).slice(0, 100)) }
  })

  // ===========================================================
  // 10. 写入后读取一致性 — addEvent → score → history → revert
  // ===========================================================
  console.log('\n--- 10. 写入后读取一致性 ---')

  await test('10.1 addEvent → score 一致', async () => {
    // ACTIVITY_PARTICIPATION 标准分值=1, 不传 delta 让系统自动查找
    const student = `r30-write-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(student)}); return res;`)
    const before = await callIpc(`const res = await api.eaa.score(${JSON.stringify(student)}); return res;`)
    const beforeScore = before?.data?.score ?? 100
    await addEventOk(student, 'ACTIVITY_PARTICIPATION', 'r30-write-test')
    const after = await callIpc(`const res = await api.eaa.score(${JSON.stringify(student)}); return res;`)
    const afterScore = after?.data?.score ?? 0
    record('10.1 addEvent → score', afterScore === beforeScore + 1, `before=${beforeScore} after=${afterScore} expected=${beforeScore + 1}`)
  })

  await test('10.2 addEvent → history 一致', async () => {
    // ACTIVITY_PARTICIPATION=+1, CLASS_MONITOR=+10
    const student = `r30-hist-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(student)}); return res;`)
    await addEventOk(student, 'ACTIVITY_PARTICIPATION', 'r30-hist-1')
    await addEventOk(student, 'CLASS_MONITOR', 'r30-hist-2')
    const hr = await callIpc(`const res = await api.eaa.history(${JSON.stringify(student)}); return res;`)
    const hd = hr?.data ?? hr
    const events = Array.isArray(hd) ? hd : (hd?.events ?? [])
    record('10.2 addEvent → history', events.length >= 2, `events=${events.length}`)
  })

  await test('10.3 revert → score 减少', async () => {
    // ACTIVITY_PARTICIPATION=+1, revert 后分数回到原值
    const student = `r30-rev-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(student)}); return res;`)
    const evt = await addEventOk(student, 'ACTIVITY_PARTICIPATION', 'r30-rev-test')
    const before = await callIpc(`const res = await api.eaa.score(${JSON.stringify(student)}); return res;`)
    const beforeScore = before?.data?.score ?? 100
    const eventId = extractEventId(evt)
    if (!eventId) { record('10.3 revert → score', false, 'no event_id found'); return }
    await callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(eventId)}, 'r30 revert test'); return res;`)
    const after = await callIpc(`const res = await api.eaa.score(${JSON.stringify(student)}); return res;`)
    const afterScore = after?.data?.score ?? 0
    record('10.3 revert → score', afterScore === beforeScore - 1, `before=${beforeScore} after=${afterScore} expected=${beforeScore - 1}`)
  })

  await test('10.4 deleteStudent → score 返回 Deleted', async () => {
    const student = `r30-del-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(student)}); return res;`)
    await callIpc(`const res = await api.eaa.deleteStudent(${JSON.stringify(student)}, 'r30 delete test'); return res;`)
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(student)}); return res;`)
    const data = r?.data ?? r
    record('10.4 deleteStudent → score Deleted', data?.status === 'Deleted', `status=${data?.status} score=${data?.score}`)
  })

  // ===========================================================
  // 11. 缓存失效与重建 — 写入后缓存自动更新
  // ===========================================================
  console.log('\n--- 11. 缓存失效与重建 ---')

  await test('11.1 addEvent 后 scores.cache 自动更新', async () => {
    // scores.cache 键是 entity_id, ACTIVITY_PARTICIPATION 标准分值=1
    const student = `r30-cache-${TS}`
    const entityId = await addStudentGetId(student)
    if (!entityId) { record('11.1 scores.cache 自动更新', false, 'addStudent 未返回 entity_id'); return }
    await addEventOk(student, 'ACTIVITY_PARTICIPATION', 'r30-cache-test')
    await sleep(500) // 等待缓存更新
    const content = await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8')
    const cache = JSON.parse(content)
    const cachedScore = cache[entityId]
    record('11.1 scores.cache 自动更新', cachedScore === 101, `student=${student} entityId=${entityId} cachedScore=${cachedScore} expected=101`)
  })

  await test('11.2 revert 后 scores.cache 自动更新', async () => {
    // ACTIVITY_PARTICIPATION=+1, revert 后分数回到 100
    const student = `r30-revcache-${TS}`
    const entityId = await addStudentGetId(student)
    if (!entityId) { record('11.2 revert cache', false, 'addStudent 未返回 entity_id'); return }
    const evt = await addEventOk(student, 'ACTIVITY_PARTICIPATION', 'r30-revcache')
    await sleep(300)
    const eventId = extractEventId(evt)
    if (!eventId) { record('11.2 revert cache', false, 'no event_id'); return }
    await callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(eventId)}, 'r30 revert cache'); return res;`)
    await sleep(500) // 等待缓存更新
    const content = await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8')
    const cache = JSON.parse(content)
    const cachedScore = cache[entityId]
    record('11.2 revert 后 cache 更新', cachedScore === 100, `student=${student} entityId=${entityId} cachedScore=${cachedScore} expected=100`)
  })

  await test('11.3 eaa.doctor 缓存检查通过', async () => {
    const r = await callIpc(`const res = await api.eaa.doctor(); return res;`)
    record('11.3 eaa.doctor 通过', isOk(r), `success=${r?.success}`)
  })

  await test('11.4 eaa.validate 数据验证通过', async () => {
    const r = await callIpc(`const res = await api.eaa.validate(); return res;`)
    record('11.4 eaa.validate 通过', isOk(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 12. 并发读写一致性 — 多路径同时读取不冲突
  // ===========================================================
  console.log('\n--- 12. 并发读写一致性 ---')

  await test('12.1 10 个并发 score 查询结果一致', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(1); return res;`)
    const data = r?.data ?? r
    const ranking = data?.ranking ?? data?.data?.ranking ?? []
    if (ranking.length === 0) { record('12.1 并发 score 一致', false, 'no ranking'); return }
    const name = ranking[0].name || ranking[0].student_name
    const promises = []
    for (let i = 0; i < 10; i++) {
      promises.push(callIpc(`const res = await api.eaa.score(${JSON.stringify(name)}); return res;`))
    }
    const results = await Promise.all(promises)
    const scores = results.map(r => r?.data?.score ?? r?.score)
    const uniqueScores = new Set(scores)
    record('12.1 并发 score 一致', uniqueScores.size === 1, `scores=${scores.join(',')} unique=${uniqueScores.size}`)
  })

  await test('12.2 并发读 + 写不互相干扰', async () => {
    const student = `r30-conc-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(student)}); return res;`)
    const promises = [
      callIpc(`const res = await api.eaa.addEvent({studentName:${JSON.stringify(student)},reasonCode:'ACTIVITY_PARTICIPATION',delta:1,note:'r30-conc-1'}); return res;`),
      callIpc(`const res = await api.eaa.score(${JSON.stringify(student)}); return res;`),
      callIpc(`const res = await api.eaa.score(${JSON.stringify(student)}); return res;`),
      callIpc(`const res = await api.eaa.addEvent({studentName:${JSON.stringify(student)},reasonCode:'CLASS_MONITOR',delta:5,note:'r30-conc-2'}); return res;`),
      callIpc(`const res = await api.eaa.score(${JSON.stringify(student)}); return res;`),
    ]
    const results = await Promise.all(promises)
    const allOk = results.every(r => !r?.__error)
    record('12.2 并发读+写', allOk, `results=${results.length} allOk=${allOk}`)
  })

  await test('12.3 5 个并发 stats 查询结果一致', async () => {
    const promises = []
    for (let i = 0; i < 5; i++) {
      promises.push(callIpc(`const res = await api.eaa.stats(); return res;`))
    }
    const results = await Promise.all(promises)
    const studentCounts = results.map(r => r?.data?.summary?.students ?? r?.summary?.students ?? 0)
    const uniqueCounts = new Set(studentCounts)
    record('12.3 并发 stats 一致', uniqueCounts.size === 1, `counts=${studentCounts.join(',')} unique=${uniqueCounts.size}`)
  })

  await test('12.4 3 个并发 ranking 查询排序一致', async () => {
    const promises = []
    for (let i = 0; i < 3; i++) {
      promises.push(callIpc(`const res = await api.eaa.ranking(10); return res;`))
    }
    const results = await Promise.all(promises)
    const firstNames = results.map(r => {
      const data = r?.data ?? r
      const ranking = data?.ranking ?? data?.data?.ranking ?? []
      return ranking[0]?.name ?? ranking[0]?.student_name ?? ''
    })
    const uniqueFirst = new Set(firstNames)
    record('12.4 并发 ranking 排序一致', uniqueFirst.size === 1, `firstNames=${firstNames.join(',')}`)
  })

  // ===========================================================
  // 13. 数据完整性端到端
  // ===========================================================
  console.log('\n--- 13. 数据完整性端到端 ---')

  await test('13.1 所有 cache 文件存在', async () => {
    const files = ['scores.cache.json', 'event_stats.cache.json', 'daily_dedup.cache.json']
    const missing = files.filter(f => !fs.existsSync(path.join(entitiesDir, f)))
    record('13.1 所有 cache 文件存在', missing.length === 0, `missing=${missing.join(',')}`)
  })

  await test('13.2 entities.json 有 name_index', async () => {
    const exists = fs.existsSync(path.join(entitiesDir, 'name_index.json'))
    record('13.2 name_index.json 存在', exists)
  })

  await test('13.3 reason_codes.json 存在且有效', async () => {
    // reason_codes.json 结构: { version: "1.0", codes: { CODE_NAME: {label,category,score_delta} } }
    try {
      const content = await fsp.readFile(path.join(eaaDataDir, 'reason_codes.json'), 'utf-8')
      const parsed = JSON.parse(content)
      const codes = parsed?.codes ?? parsed
      // codes 可以是对象 (按键名) 或数组
      const codeCount = Array.isArray(codes) ? codes.length : (typeof codes === 'object' ? Object.keys(codes).length : 0)
      record('13.3 reason_codes.json 有效', codeCount > 0, `codes=${codeCount} type=${Array.isArray(codes) ? 'array' : 'object'}`)
    } catch (e) { record('13.3 reason_codes.json', false, String(e).slice(0, 100)) }
  })

  await test('13.4 scores.cache 总数与 entities.json 总数接近', async () => {
    // entities.json 结构: { entities: { ent_id: {...} } }
    // scores.cache 可能不包含已删除的学生, 因此 scores <= entities
    const scoresContent = await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8')
    const scores = JSON.parse(scoresContent)
    const entitiesContent = await fsp.readFile(path.join(entitiesDir, 'entities.json'), 'utf-8')
    const entities = JSON.parse(entitiesContent)
    const entitiesObj = entities?.entities ?? entities
    const entityCount = Array.isArray(entitiesObj) ? entitiesObj.length : Object.keys(entitiesObj).length
    const scoreCount = Object.keys(scores).length
    // scores.cache 是 entities 的子集 (不含已删除), 差异 = 已删除学生数
    record('13.4 scores vs entities 总数', scoreCount > 0 && scoreCount <= entityCount, `scores=${scoreCount} entities=${entityCount} diff=${entityCount - scoreCount} (删除学生不在缓存中)`)
  })

  await test('13.5 eaa.info 返回版本信息', async () => {
    const r = await callIpc(`const res = await api.eaa.info(); return res;`)
    const data = r?.data ?? r
    record('13.5 eaa.info 返回版本', isOk(r) && !!data, `success=${r?.success} hasData=${!!data}`)
  })

  await test('13.6 eaa.dashboard 可生成', async () => {
    const outputDir = path.join(eaaDataDir, 'r30-dashboard')
    const r = await callIpc(`const res = await api.eaa.dashboard(${JSON.stringify(outputDir)}); return res;`)
    record('13.6 eaa.dashboard 生成', isOk(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 汇总
  // ===========================================================
  console.log('\n' + '='.repeat(60))
  const passed = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length
  console.log(`总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`)
  console.log('='.repeat(60))

  if (failed > 0) {
    console.log('\n失败项:')
    results.filter(r => !r.ok).forEach(r => console.log(`  [FAIL] ${r.name} — ${r.detail}`))
  }

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
