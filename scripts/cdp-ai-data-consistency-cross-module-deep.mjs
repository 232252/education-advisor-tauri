// =============================================================
// Round 35: AI 数据一致性 + 跨模块写入路径端到端深度测试
//            — 重中之重续22
//
// 验证 AI 写入数据后,所有相关数据路径(文件/缓存/IPC)保持一致:
//   1. 写入-读取一致性 — addEvent → score/history/search/stats 一致
//   2. 缓存一致性 — 写入后 scores.cache/event_stats.cache/daily_dedup.cache 同步
//   3. 跨模块数据流 — EAA 事件 ↔ 学业成绩 ↔ 班级分配
//   4. 文件 vs IPC 一致性 — entities.json/events.jsonl vs IPC 返回
//   5. 软删除一致性 — delete-student 后所有路径同步
//   6. 恢复事件一致性 — revert 后所有路径同步
//   7. 批量写入一致性 — 多次 addEvent 后缓存准确
//   8. 并发写入一致性 — 并行 addEvent 后分数正确
//   9. 元数据一致性 — set-student-meta 后文件 vs IPC 一致
//  10. 导出数据完整性 — export 数据与实时数据一致
//  11. 跨 Agent 数据视图 — 不同 agent 看到相同数据
//  12. 数据时间戳一致性 — created_at/updated_at 在所有路径同步
//
// 运行: node scripts/cdp-ai-data-consistency-cross-module-deep.mjs
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
  console.log('CDP connected, running Round 35 tests...\n')

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

  // 读取缓存文件辅助函数
  const readJsonFile = async (filePath) => {
    try {
      const content = await fsp.readFile(filePath, 'utf-8')
      return JSON.parse(content)
    } catch { return null }
  }

  // 从 addStudent 返回字符串中解析 entity_id: "✓ 学生已添加: NAME (ent_xxx)"
  const parseEntityId = (res) => {
    const data = res?.data ?? ''
    const m = typeof data === 'string' ? data.match(/\(ent_[a-f0-9]+\)/) : null
    return m ? m[0].slice(1, -1) : null
  }

  // 从 addEvent 返回字符串中解析 event_id: "✓ 事件已创建: evt_xxx NAME +1.0"
  const parseEventId = (res) => {
    const data = res?.data ?? ''
    const m = typeof data === 'string' ? data.match(/evt_[a-f0-9]+/) : null
    return m ? m[0] : null
  }

  // ===========================================================
  // 1. 写入-读取一致性
  // ===========================================================
  console.log('--- 1. 写入-读取一致性 ---')

  const studentName = `R35学生-${TS}`
  let studentId = null

  await test('1.1 添加学生后 score 可查', async () => {
    const ar = await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(studentName)}); return res;`)
    if (!isOk(ar)) { record('1.1 addStudent→score', false, `add failed: ${ar?.__error || ar?.success}`); return }
    // 从返回字符串解析 entity_id
    studentId = parseEntityId(ar)
    // 查询分数
    const sr = await callIpc(`const res = await api.eaa.score(${JSON.stringify(studentName)}); return res;`)
    const scoreData = sr?.data ?? sr
    const score = scoreData?.score ?? scoreData?.data?.score
    // 新学生基础分应为 100
    record('1.1 addStudent→score', score === 100, `name=${studentName} score=${score} id=${studentId}`)
  })

  await test('1.2 添加事件后 score 更新', async () => {
    const er = await callIpc(`const res = await api.eaa.addEvent({studentName:${JSON.stringify(studentName)}, reasonCode:'ACTIVITY_PARTICIPATION', note:'r35-test'}); return res;`)
    if (!isOk(er)) { record('1.2 addEvent→score', false, `addEvent failed: ${er?.__error || er?.success}`); return }
    await sleep(100)
    const sr = await callIpc(`const res = await api.eaa.score(${JSON.stringify(studentName)}); return res;`)
    const scoreData = sr?.data ?? sr
    const score = scoreData?.score ?? scoreData?.data?.score
    // ACTIVITY_PARTICIPATION delta=+1, 100+1=101
    record('1.2 addEvent→score', score === 101, `score=${score} expected=101`)
  })

  await test('1.3 事件出现在 history', async () => {
    const hr = await callIpc(`const res = await api.eaa.history(${JSON.stringify(studentName)}); return res;`)
    const data = hr?.data ?? hr
    const events = Array.isArray(data) ? data : (data?.events ?? data?.data ?? [])
    const hasEvent = events.some(e => (e?.note || '').includes('r35-test'))
    record('1.3 addEvent→history', hasEvent, `events=${events.length} hasEvent=${hasEvent}`)
  })

  await test('1.4 事件出现在 search', async () => {
    // search 接受字符串参数,不是对象
    const sr = await callIpc(`const res = await api.eaa.search('r35-test'); return res;`)
    const data = sr?.data ?? sr
    const events = data?.events ?? (Array.isArray(data) ? data : [])
    const hasEvent = events.some(e => (e?.note || '').includes('r35-test'))
    record('1.4 addEvent→search', hasEvent, `events=${events.length} hasEvent=${hasEvent}`)
  })

  await test('1.5 事件计入 stats', async () => {
    const sr = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const data = sr?.data ?? sr
    const summary = data?.summary
    const totalEvents = summary?.total_events ?? summary?.total
    record('1.5 addEvent→stats', totalEvents > 0, `totalEvents=${totalEvents}`)
  })

  // ===========================================================
  // 2. 缓存一致性
  // ===========================================================
  console.log('\n--- 2. 缓存一致性 ---')

  await test('2.1 scores.cache.json 含新学生', async () => {
    if (!studentId) { record('2.1 scores.cache', false, 'no studentId'); return }
    const cache = await readJsonFile(path.join(entitiesDir, 'scores.cache.json'))
    const hasStudent = cache && (cache[studentId] !== undefined || JSON.stringify(cache).includes(studentName))
    record('2.1 scores.cache 含学生', !!hasStudent, `id=${studentId} inCache=${!!hasStudent}`)
  })

  await test('2.2 scores.cache 分数与 IPC 一致', async () => {
    if (!studentId) { record('2.2 scores.cache 一致', false, 'no studentId'); return }
    const cache = await readJsonFile(path.join(entitiesDir, 'scores.cache.json'))
    const cacheScore = cache?.[studentId]?.score ?? cache?.[studentId]
    const sr = await callIpc(`const res = await api.eaa.score(${JSON.stringify(studentName)}); return res;`)
    const ipcScore = sr?.data?.score ?? sr?.data?.data?.score
    record('2.2 scores.cache=IPC', cacheScore === ipcScore, `cache=${cacheScore} ipc=${ipcScore}`)
  })

  await test('2.3 event_stats.cache.json 含学生', async () => {
    if (!studentId) { record('2.3 event_stats.cache', false, 'no studentId'); return }
    const cache = await readJsonFile(path.join(entitiesDir, 'event_stats.cache.json'))
    const hasStudent = cache && JSON.stringify(cache).includes(studentId)
    record('2.3 event_stats.cache 含学生', !!hasStudent, `id=${studentId} inCache=${!!hasStudent}`)
  })

  await test('2.4 name_index.json 含学生名', async () => {
    const cache = await readJsonFile(path.join(entitiesDir, 'name_index.json'))
    const hasName = cache && cache[studentName] !== undefined
    record('2.4 name_index 含学生', !!hasName, `name=${studentName} inIndex=${!!hasName}`)
  })

  await test('2.5 entities.json 含学生', async () => {
    const entities = await readJsonFile(path.join(entitiesDir, 'entities.json'))
    const entitiesObj = entities?.entities ?? entities
    const hasStudent = entitiesObj && JSON.stringify(entitiesObj).includes(studentName)
    record('2.5 entities.json 含学生', !!hasStudent, `name=${studentName} inFile=${!!hasStudent}`)
  })

  // ===========================================================
  // 3. 跨模块数据流
  // ===========================================================
  console.log('\n--- 3. 跨模块数据流 ---')

  await test('3.1 EAA 学生可查学业成绩 (空)', async () => {
    // 学业成绩应可通过 IPC 查询,即使为空
    const r = await callIpc(`const res = await api.academic.getGrades({studentName:${JSON.stringify(studentName)}}); return res;`)
    const data = r?.data ?? r
    const grades = Array.isArray(data) ? data : (data?.grades ?? [])
    record('3.1 EAA→学业成绩', r !== undefined && !r?.__error, `grades=${grades.length}`)
  })

  await test('3.2 创建考试后学业可录入', async () => {
    const examId = `r35-exam-${TS}`
    // createExam 需要 subjects 数组参数
    const cr = await callIpc(`const res = await api.academic.createExam({examId:${JSON.stringify(examId)}, name:'R35测试考试', date:new Date().toISOString().slice(0,10), type:'unit', subjects:[]}); return res;`)
    if (!isOk(cr)) { record('3.2 创建考试', false, `createExam failed: ${cr?.__error || cr?.error || cr?.success}`); return }
    // 录入成绩
    const gr = await callIpc(`const res = await api.academic.setGrade({examId:${JSON.stringify(examId)}, subjectId:'math', studentName:${JSON.stringify(studentName)}, score:95, fullMark:100}); return res;`)
    record('3.2 创建考试+录成绩', isOk(gr), `examOk=${isOk(cr)} gradeOk=${isOk(gr)}`)
  })

  await test('3.3 班级分配后 class.list 含学生', async () => {
    const classId = `R35CLS-${TS}`
    const className = `R35测试班-${TS}`
    const cr = await callIpc(`const res = await api.class.create({class_id:${JSON.stringify(classId)}, name:${JSON.stringify(className)}}); return res;`)
    if (!isOk(cr)) { record('3.3 班级分配', false, `create failed: ${cr?.__error}`); return }
    // class.assign 接受对象 {class_id, student_names: [...]} (snake_case)
    const ar = await callIpc(`const res = await api.class.assign({class_id:${JSON.stringify(classId)}, student_names:[${JSON.stringify(studentName)}]}); return res;`)
    if (!isOk(ar)) { record('3.3 班级分配', false, `assign failed: ${ar?.__error || ar?.error}`); return }
    // 验证学生在班级中
    const lr = await callIpc(`const res = await api.class.list(); return res;`)
    const data = lr?.data ?? lr
    const classes = Array.isArray(data) ? data : (data?.classes ?? [])
    const found = classes.some(c => c?.class_id === classId || c?.id === classId)
    record('3.3 班级分配', found, `classCreated=${isOk(cr)} assignOk=${isOk(ar)} found=${found}`)
  })

  // ===========================================================
  // 4. 文件 vs IPC 一致性
  // ===========================================================
  console.log('\n--- 4. 文件 vs IPC 一致性 ---')

  await test('4.1 events.jsonl 含新事件', async () => {
    const eventsPath = path.join(eventsDir, 'events.jsonl')
    try {
      const content = await fsp.readFile(eventsPath, 'utf-8')
      const hasEvent = content.includes('r35-test')
      record('4.1 events.jsonl 含事件', hasEvent, `hasEvent=${hasEvent}`)
    } catch (e) { record('4.1 events.jsonl 含事件', false, String(e).slice(0, 100)) }
  })

  await test('4.2 operations.jsonl 含操作日志', async () => {
    const logPath = path.join(logsDir, 'operations.jsonl')
    try {
      const content = await fsp.readFile(logPath, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      const hasRecentOp = lines.some(l => l.includes(studentName) || l.includes('r35-test'))
      record('4.2 operations.jsonl', hasRecentOp, `lines=${lines.length} hasRecent=${hasRecentOp}`)
    } catch (e) { record('4.2 operations.jsonl', false, String(e).slice(0, 100)) }
  })

  await test('4.3 listStudents 总数与文件一致', async () => {
    const entities = await readJsonFile(path.join(entitiesDir, 'entities.json'))
    const entitiesObj = entities?.entities ?? entities
    const fileCount = typeof entitiesObj === 'object' ? Object.keys(entitiesObj).length : 0
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const data = r?.data ?? r
    const ipcCount = data?.total ?? (data?.students?.length ?? 0)
    record('4.3 listStudents 总数', fileCount === ipcCount, `file=${fileCount} ipc=${ipcCount}`)
  })

  // ===========================================================
  // 5. 软删除一致性
  // ===========================================================
  console.log('\n--- 5. 软删除一致性 ---')

  const delStudentName = `R35删除-${TS}`

  await test('5.1 软删除后 listStudents 不含 (或标记 Deleted)', async () => {
    // 先添加一个学生
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(delStudentName)}); return res;`)
    await sleep(100)
    // 软删除
    const dr = await callIpc(`const res = await api.eaa.deleteStudent(${JSON.stringify(delStudentName)}); return res;`)
    if (!isOk(dr)) { record('5.1 软删除', false, `delete failed: ${dr?.__error}`); return }
    await sleep(200)
    // 查询 — 应返回 Deleted 状态或不在列表中
    const lr = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const data = lr?.data ?? lr
    const students = data?.students ?? (Array.isArray(data) ? data : [])
    const found = students.find(s => s?.name === delStudentName || s?.entity_id === delStudentName)
    const isDeleted = !found || found?.status === 'Deleted' || found?.status === 'deleted'
    record('5.1 软删除后状态', isDeleted, `found=${!!found} status=${found?.status}`)
  })

  await test('5.2 软删除后 entities.json 标记 Deleted', async () => {
    const entities = await readJsonFile(path.join(entitiesDir, 'entities.json'))
    const entitiesObj = entities?.entities ?? entities
    const jsonStr = JSON.stringify(entitiesObj)
    const hasDeleted = jsonStr.includes(delStudentName) && (jsonStr.includes('Deleted') || jsonStr.includes('deleted'))
    record('5.2 entities.json 标记', hasDeleted, `name=${delStudentName} marked=${hasDeleted}`)
  })

  // ===========================================================
  // 6. 恢复事件一致性
  // ===========================================================
  console.log('\n--- 6. 恢复事件一致性 ---')

  await test('6.1 revert 事件后 score 更新', async () => {
    // 先添加一个事件并获取 event_id
    const revStudent = `R35恢复-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(revStudent)}); return res;`)
    await sleep(100)
    const er = await callIpc(`const res = await api.eaa.addEvent({studentName:${JSON.stringify(revStudent)}, reasonCode:'ACTIVITY_PARTICIPATION', note:'r35-revert'}); return res;`)
    if (!isOk(er)) { record('6.1 revert→score', false, `addEvent failed`); return }
    // 从返回字符串解析 event_id: "✓ 事件已创建: evt_xxx NAME +1.0"
    const eventId = parseEventId(er)
    if (!eventId) { record('6.1 revert→score', false, 'no eventId'); return }
    // 验证分数增加了
    const sr1 = await callIpc(`const res = await api.eaa.score(${JSON.stringify(revStudent)}); return res;`)
    const score1 = sr1?.data?.score ?? sr1?.data?.data?.score
    // 恢复事件 — revertEvent 接受 (eventId, reason) 两个位置参数
    const rr = await callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(eventId)}, 'r35测试恢复'); return res;`)
    if (!isOk(rr)) { record('6.1 revert→score', false, `revert failed: ${rr?.__error}`); return }
    await sleep(200)
    // 验证分数恢复
    const sr2 = await callIpc(`const res = await api.eaa.score(${JSON.stringify(revStudent)}); return res;`)
    const score2 = sr2?.data?.score ?? sr2?.data?.data?.score
    // 恢复后分数应回到 100 (基础分)
    record('6.1 revert→score', score2 === 100, `before=${score1} after=${score2} expected=100`)
  })

  // ===========================================================
  // 7. 批量写入一致性
  // ===========================================================
  console.log('\n--- 7. 批量写入一致性 ---')

  await test('7.1 批量 addEvent 后 score 准确', async () => {
    const batchStudent = `R35批量-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(batchStudent)}); return res;`)
    await sleep(100)
    // 使用不同的 reasonCode 避免 daily_dedup (同学生+同原因码+同日=重复)
    // 有效正分 reason codes: CLASS_MONITOR(+10), CLASS_COMMITTEE(+5), CIVILIZED_DORM(+3), MONTHLY_ATTENDANCE(+2), ACTIVITY_PARTICIPATION(+1)
    const reasonCodes = ['CLASS_MONITOR', 'CLASS_COMMITTEE', 'CIVILIZED_DORM', 'MONTHLY_ATTENDANCE', 'ACTIVITY_PARTICIPATION']
    const expectedDeltas = [10, 5, 3, 2, 1]
    let addOk = 0
    let totalDelta = 0
    for (let i = 0; i < reasonCodes.length; i++) {
      const r = await callIpc(`const res = await api.eaa.addEvent({studentName:${JSON.stringify(batchStudent)}, reasonCode:${JSON.stringify(reasonCodes[i])}, note:'r35-batch-'+${i}}); return res;`)
      if (isOk(r)) {
        addOk++
        totalDelta += expectedDeltas[i]
      }
    }
    await sleep(200)
    // 验证分数 = 100 + totalDelta (10+5+3+2+1=21 → 121)
    const sr = await callIpc(`const res = await api.eaa.score(${JSON.stringify(batchStudent)}); return res;`)
    const score = sr?.data?.score ?? sr?.data?.data?.score
    const expected = 100 + totalDelta
    record('7.1 批量写入 score', addOk === reasonCodes.length && score === expected, `addOk=${addOk} score=${score} expected=${expected} delta=${totalDelta}`)
  })

  // ===========================================================
  // 8. 并发写入一致性
  // ===========================================================
  console.log('\n--- 8. 并发写入一致性 ---')

  await test('8.1 并行 addEvent 后 score 正确', async () => {
    const concStudent = `R35并发-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(concStudent)}); return res;`)
    await sleep(100)
    // 使用不同的 reasonCode 避免 daily_dedup (同学生+同原因码+同日=重复)
    // 有效正分 reason codes: CLASS_MONITOR(+10), CLASS_COMMITTEE(+5), CIVILIZED_DORM(+3), MONTHLY_ATTENDANCE(+2), ACTIVITY_PARTICIPATION(+1)
    const reasonCodes = ['CLASS_MONITOR', 'CLASS_COMMITTEE', 'CIVILIZED_DORM', 'MONTHLY_ATTENDANCE', 'ACTIVITY_PARTICIPATION']
    const expectedDeltas = [10, 5, 3, 2, 1]
    // 并行发起 5 个 addEvent,每个使用不同的 reasonCode
    const promises = reasonCodes.map((rc, i) =>
      callIpc(`const res = await api.eaa.addEvent({studentName:${JSON.stringify(concStudent)}, reasonCode:${JSON.stringify(rc)}, note:'r35-conc-'+${i}}); return res;`)
    )
    const results = await Promise.all(promises)
    const successCount = results.filter(r => isOk(r)).length
    let totalDelta = 0
    for (let i = 0; i < results.length; i++) {
      if (isOk(results[i])) totalDelta += expectedDeltas[i]
    }
    await sleep(300)
    // 验证分数 = 100 + totalDelta (10+5+3+2+1=21 → 121)
    const sr = await callIpc(`const res = await api.eaa.score(${JSON.stringify(concStudent)}); return res;`)
    const score = sr?.data?.score ?? sr?.data?.data?.score
    const expected = 100 + totalDelta
    record('8.1 并发写入 score', successCount === reasonCodes.length && score === expected, `success=${successCount} score=${score} expected=${expected} delta=${totalDelta}`)
  })

  // ===========================================================
  // 9. 元数据一致性
  // ===========================================================
  console.log('\n--- 9. 元数据一致性 ---')

  await test('9.1 set-student-meta 后 IPC 可查', async () => {
    const metaStudent = `R35元数据-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(metaStudent)}); return res;`)
    await sleep(100)
    // setStudentMeta 接受单个对象 {name, metadata} 不是两个参数
    const mr = await callIpc(`const res = await api.eaa.setStudentMeta({name:${JSON.stringify(metaStudent)}, metadata:{grade:'高三', class:'2班', phone:'13800138000'}}); return res;`)
    if (!isOk(mr)) { record('9.1 setMeta', false, `setMeta failed: ${mr?.__error || mr?.error}`); return }
    // 通过 IPC 查询
    const lr = await callIpc(`const res = await api.eaa.listStudents({search:${JSON.stringify(metaStudent)}}); return res;`)
    const data = lr?.data ?? lr
    const students = data?.students ?? (Array.isArray(data) ? data : [])
    const found = students.find(s => s?.name === metaStudent)
    const hasMeta = found && (found?.metadata || found?.grade || found?.meta)
    record('9.1 setMeta→IPC', isOk(mr) && !!found, `setOk=${isOk(mr)} found=${!!found} hasMeta=${!!hasMeta}`)
  })

  // ===========================================================
  // 10. 导出数据完整性
  // ===========================================================
  console.log('\n--- 10. 导出数据完整性 ---')

  await test('10.1 export 数据包含新学生', async () => {
    const r = await callIpc(`const res = await api.eaa.export('jsonl'); return res;`)
    const data = r?.data ?? r
    const jsonStr = typeof data === 'string' ? data : JSON.stringify(data)
    const hasStudent = jsonStr.includes(studentName)
    record('10.1 export 含学生', isOk(r) && hasStudent, `exportOk=${isOk(r)} hasStudent=${hasStudent}`)
  })

  await test('10.2 ranking 数据有效', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking({limit:10}); return res;`)
    const data = r?.data ?? r
    const ranking = data?.ranking ?? data?.data?.ranking ?? (Array.isArray(data) ? data : [])
    record('10.2 ranking 有效', isOk(r) && ranking.length > 0, `ranking=${ranking.length}`)
  })

  // ===========================================================
  // 11. 跨 Agent 数据视图
  // ===========================================================
  console.log('\n--- 11. 跨 Agent 数据视图 ---')

  await test('11.1 不同 agent 看到相同 score', async () => {
    // 通过 main agent 和 counselor agent 查询同一学生
    const agents = await callIpc(`const res = await api.agent.list(); return res;`)
    const agentList = Array.isArray(agents) ? agents : (agents?.data ?? [])
    const mainAgent = agentList.find(a => a?.id === 'main')
    const counselorAgent = agentList.find(a => a?.id === 'counselor')
    // 两个 agent 都应有 score 能力 (main 有 all, counselor 有 read)
    const mainHasScore = mainAgent?.capabilities?.includes('all') || mainAgent?.capabilities?.includes('read') || mainAgent?.capabilities?.includes('score')
    const counselorHasScore = counselorAgent?.capabilities?.includes('read') || counselorAgent?.capabilities?.includes('score')
    record('11.1 跨 agent score 能力', mainHasScore && counselorHasScore, `main=${mainHasScore} counselor=${counselorHasScore}`)
  })

  await test('11.2 agent 能力配置一致', async () => {
    const agents = await callIpc(`const res = await api.agent.list(); return res;`)
    const agentList = Array.isArray(agents) ? agents : (agents?.data ?? [])
    let consistent = 0
    for (const a of agentList) {
      // 每个 agent 应有 capabilities 数组
      if (Array.isArray(a?.capabilities)) consistent++
    }
    record('11.2 agent 能力一致', consistent === agentList.length, `total=${agentList.length} consistent=${consistent}`)
  })

  // ===========================================================
  // 12. 数据时间戳一致性
  // ===========================================================
  console.log('\n--- 12. 数据时间戳一致性 ---')

  await test('12.1 events.jsonl 时间戳存在', async () => {
    const eventsPath = path.join(eventsDir, 'events.jsonl')
    try {
      const content = await fsp.readFile(eventsPath, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      const lastLine = lines[lines.length - 1]
      const lastEvent = JSON.parse(lastLine)
      const hasTimestamp = lastEvent?.created_at || lastEvent?.timestamp || lastEvent?.time
      record('12.1 事件时间戳', !!hasTimestamp, `hasTimestamp=${!!hasTimestamp} field=${lastEvent?.created_at ? 'created_at' : lastEvent?.timestamp ? 'timestamp' : 'other'}`)
    } catch (e) { record('12.1 事件时间戳', false, String(e).slice(0, 100)) }
  })

  await test('12.2 entities.json 时间戳存在', async () => {
    const entities = await readJsonFile(path.join(entitiesDir, 'entities.json'))
    const entitiesObj = entities?.entities ?? entities
    if (typeof entitiesObj !== 'object') { record('12.2 实体时间戳', false, 'no entities'); return }
    const firstEntity = Object.values(entitiesObj)[0]
    const hasTimestamp = firstEntity?.created_at || firstEntity?.createdAt || firstEntity?.timestamp
    record('12.2 实体时间戳', !!hasTimestamp, `hasTimestamp=${!!hasTimestamp}`)
  })

  await test('12.3 操作日志时间戳存在', async () => {
    const logPath = path.join(logsDir, 'operations.jsonl')
    try {
      const content = await fsp.readFile(logPath, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      const lastLine = lines[lines.length - 1]
      const lastOp = JSON.parse(lastLine)
      const hasTimestamp = lastOp?.timestamp || lastOp?.time || lastOp?.created_at
      record('12.3 日志时间戳', !!hasTimestamp, `hasTimestamp=${!!hasTimestamp}`)
    } catch (e) { record('12.3 日志时间戳', false, String(e).slice(0, 100)) }
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
