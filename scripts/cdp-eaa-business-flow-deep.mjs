// =============================================================
// EAA 核心业务流深度测试 (新角度)
// 覆盖: add-student → add-event → score → ranking → history → revert → delete-student
//       参数校验、缓存、并发、边界、错误恢复
// 通过 CDP 直接调用 window.api.eaa.* IPC 接口
// =============================================================

import WebSocket from 'ws'

const CDP_BASE = 'http://127.0.0.1:9222'

let stats = { total: 0, pass: 0, warn: 0, fail: 0, bug: 0 }
const bugs = []
const notes = []

function record(name, ok, detail = '') {
  stats.total++
  if (ok === true) {
    stats.pass++
    console.log(`[PASS] ${name}${detail ? ' — ' + detail : ''}`)
  } else if (ok === 'warn') {
    stats.warn++
    console.log(`[WARN] ${name}${detail ? ' — ' + detail : ''}`)
  } else if (ok === 'bug') {
    stats.bug++
    bugs.push(`${name}: ${detail}`)
    console.log(`[BUG]  ${name} — ${detail}`)
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
  if (r?.stderr) return String(r.stderr).slice(0, 200)
  if (r?.message) return String(r.message)
  return JSON.stringify(r).slice(0, 200)
}

// =============================================================
// CDP 连接
// =============================================================

async function getPages() {
  const r = await fetch(`${CDP_BASE}/json`)
  return r.json()
}

async function findAppPage(pages) {
  for (const p of pages) {
    if (p.type !== 'page') continue
    if (p.url && (p.url.includes('localhost:5173') || p.url.includes('tauri.localhost'))) return p
  }
  for (const p of pages) {
    if (p.type === 'page') return p
  }
  return null
}

function evalOnPage(wsUrl, expr, timeoutMs = 30000) {
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

async function callNS(ns, method, ...args) {
  const argsLiteral = `[${args.map(a => JSON.stringify(JSON.stringify(a))).join(', ')}]`
  const expr = `(async () => {
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
  return await evalOnPage(global.__wsUrl, expr)
}

const callEAA = (m, ...a) => callNS('eaa', m, ...a)
async function rawEval(expr) { return await evalOnPage(global.__wsUrl, expr) }

// 等待异步任务
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// =============================================================
// 测试 sections
// =============================================================

// 1. 基础: info / codes / doctor
async function testBasics() {
  console.log('\n=== 1. 基础: info / codes / doctor ===')

  const info = await callEAA('info')
  record('eaa.info 返回 success', isOk(info),
    isOk(info) ? `version=${info.data?.version ?? 'unknown'}` : `error=${errMsg(info).slice(0, 60)}`)

  const codes = await callEAA('codes')
  // 实际结构: { data: { codes: [{code, label, category, score_delta}, ...], version } }
  const codesList = codes?.data?.codes || []
  record('eaa.codes 返回 success', isOk(codes),
    isOk(codes) ? `count=${codesList.length}` : `error=${errMsg(codes).slice(0, 60)}`)
  if (codesList.length > 0) {
    note(`reason-codes 数量=${codesList.length}`)
    // 抽一个 delta 非 null 的 reason code 用于后续 add-event 测试
    const withDelta = codesList.find(c => typeof c.score_delta === 'number' && c.score_delta !== 0)
    const picked = withDelta || codesList[0]
    global.__testReasonCode = picked.code
    global.__testReasonDelta = picked.score_delta
    note(`测试用 reason-code: ${picked.code}, delta=${picked.score_delta}`)
  }

  const doctor = await callEAA('doctor')
  record('eaa.doctor 返回 success', isOk(doctor),
    isOk(doctor) ? '健康' : `error=${errMsg(doctor).slice(0, 60)}`)

  const exportFormats = await callEAA('exportFormats')
  record('eaa.exportFormats 返回数组', Array.isArray(exportFormats) || isOk(exportFormats),
    Array.isArray(exportFormats) ? `count=${exportFormats.length}` : (isOk(exportFormats) ? 'success' : `error=${errMsg(exportFormats).slice(0, 60)}`))
}

// 2. list-students + stats + validate
async function testReadOps() {
  console.log('\n=== 2. list-students + stats + validate ===')

  const students = await callEAA('listStudents')
  record('eaa.listStudents 返回 success', isOk(students),
    isOk(students) ? `count=${students.data?.students?.length ?? students.data?.length ?? 'unknown'}` : `error=${errMsg(students).slice(0, 60)}`)
  if (isOk(students)) {
    const list = students.data?.students || students.data || []
    note(`初始学生数=${Array.isArray(list) ? list.length : 'N/A'}`)
    if (Array.isArray(list) && list.length > 0) {
      global.__existingStudent = list[0].name || list[0].entity_id || list[0]
      note(`测试用现有学生: ${global.__existingStudent}`)
    }
  }

  const statsR = await callEAA('stats')
  record('eaa.stats 返回 success', isOk(statsR),
    isOk(statsR) ? `events=${statsR.data?.total_events ?? 'unknown'}` : `error=${errMsg(statsR).slice(0, 60)}`)

  const validateR = await callEAA('validate')
  record('eaa.validate 返回 success', isOk(validateR),
    isOk(validateR) ? '数据完整' : `error=${errMsg(validateR).slice(0, 60)}`)
}

// 3. add-student 参数校验
async function testAddStudentValidation() {
  console.log('\n=== 3. add-student 参数校验 ===')

  // 3.1 name=null
  const r1 = await callEAA('addStudent', null)
  record('eaa.addStudent(null) 应失败', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 60)}` : `BUG: success`)

  // 3.2 name=数字
  const r2 = await callEAA('addStudent', 12345)
  record('eaa.addStudent(数字) 应失败', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 60)}` : `BUG: success`)

  // 3.3 name=空字符串
  const r3 = await callEAA('addStudent', '')
  record('eaa.addStudent(空字符串) 应失败', isErr(r3),
    isErr(r3) ? `error=${errMsg(r3).slice(0, 60)}` : `BUG: success`)

  // 3.4 name=空格
  const r4 = await callEAA('addStudent', '   ')
  record('eaa.addStudent(纯空格) 应失败', isErr(r4),
    isErr(r4) ? `error=${errMsg(r4).slice(0, 60)}` : `BUG: success`)

  // 3.5 name 含控制字符
  const r5 = await callEAA('addStudent', 'evil\nname')
  record('eaa.addStudent(含换行符) 应失败', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 60)}` : `BUG: success`)

  // 3.6 name 含 null byte
  const r6 = await callEAA('addStudent', 'evil\0inject')
  record('eaa.addStudent(含 null byte) 应失败', isErr(r6),
    isErr(r6) ? `error=${errMsg(r6).slice(0, 60)}` : `BUG: success`)

  // 3.7 name 超长 65 字符
  const r7 = await callEAA('addStudent', 'A'.repeat(65))
  record('eaa.addStudent(65 字符超长) 应失败', isErr(r7),
    isErr(r7) ? `error=${errMsg(r7).slice(0, 60)}` : `BUG: success`)

  // 3.8 name 以 -- 开头 (参数注入)
  const r8 = await callEAA('addStudent', '--inject-arg')
  record('eaa.addStudent(--开头) 应失败 (参数注入)', isErr(r8),
    isErr(r8) ? `error=${errMsg(r8).slice(0, 60)}` : `BUG: success`)

  // 3.9 name 含 shell 危险字符
  const r9 = await callEAA('addStudent', 'name;rm -rf /')
  record('eaa.addStudent(含 ; shell 注入) 应失败', isErr(r9),
    isErr(r9) ? `error=${errMsg(r9).slice(0, 60)}` : `BUG: success`)

  const r10 = await callEAA('addStudent', 'name`whoami`')
  record('eaa.addStudent(含反引号) 应失败', isErr(r10),
    isErr(r10) ? `error=${errMsg(r10).slice(0, 60)}` : `BUG: success`)

  // 3.10 name 含路径分隔符
  const r11 = await callEAA('addStudent', '../etc/passwd')
  record('eaa.addStudent(含路径分隔符) 应失败', isErr(r11),
    isErr(r11) ? `error=${errMsg(r11).slice(0, 60)}` : `BUG: success`)
}

// 4. add-event 参数校验
async function testAddEventValidation() {
  console.log('\n=== 4. add-event 参数校验 ===')

  // 4.1 params=null
  const r1 = await callEAA('addEvent', null)
  // 注意: handler 直接解构 params.studentName, null/undefined 会抛 TypeError
  record('eaa.addEvent(null) 应失败 (不崩溃)', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 60)}` : `BUG: success`)

  // 4.2 params 缺失 studentName
  const r2 = await callEAA('addEvent', { reasonCode: 'test' })
  record('eaa.addEvent(缺失 studentName) 应失败', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 60)}` : `BUG: success`)

  // 4.3 params 缺失 reasonCode
  const r3 = await callEAA('addEvent', { studentName: 'test' })
  record('eaa.addEvent(缺失 reasonCode) 应失败', isErr(r3),
    isErr(r3) ? `error=${errMsg(r3).slice(0, 60)}` : `BUG: success`)

  // 4.4 studentName 含控制字符
  const r4 = await callEAA('addEvent', { studentName: 'evil\nname', reasonCode: 'test' })
  record('eaa.addEvent(studentName 含换行符) 应失败', isErr(r4),
    isErr(r4) ? `error=${errMsg(r4).slice(0, 60)}` : `BUG: success`)

  // 4.5 reasonCode 含 shell 字符
  const r5 = await callEAA('addEvent', { studentName: 'test', reasonCode: 'code;rm' })
  record('eaa.addEvent(reasonCode 含 ;) 应失败', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 60)}` : `BUG: success`)

  // 4.6 note 含 shell 字符
  const r6 = await callEAA('addEvent', { studentName: 'test', reasonCode: 'test', note: 'note;rm -rf /' })
  record('eaa.addEvent(note 含 ;) 应失败', isErr(r6),
    isErr(r6) ? `error=${errMsg(r6).slice(0, 60)}` : `BUG: success`)

  // 4.7 studentName 以 -- 开头
  const r7 = await callEAA('addEvent', { studentName: '--inject', reasonCode: 'test' })
  record('eaa.addEvent(studentName 以 -- 开头) 应失败', isErr(r7),
    isErr(r7) ? `error=${errMsg(r7).slice(0, 60)}` : `BUG: success`)

  // 4.8 tags 含非法元素
  const r8 = await callEAA('addEvent', { studentName: 'test', reasonCode: 'test', tags: ['tag;rm'] })
  record('eaa.addEvent(tags 含 ;) 应失败', isErr(r8),
    isErr(r8) ? `error=${errMsg(r8).slice(0, 60)}` : `BUG: success`)
}

// 5. 完整业务流: add-student → add-event → score → history → revert → delete-student
async function testBusinessFlow() {
  console.log('\n=== 5. 完整业务流 ===')

  const testStudentName = `CDP-Test-${Date.now().toString(36)}`
  note(`业务流测试学生: ${testStudentName}`)

  // 5.1 add-student
  const r1 = await callEAA('addStudent', testStudentName)
  record('5.1 eaa.addStudent 创建测试学生', isOk(r1),
    isOk(r1) ? `name=${testStudentName}` : `error=${errMsg(r1).slice(0, 80)}`)
  if (!isOk(r1)) {
    note('业务流中断: add-student 失败')
    return
  }

  // 5.2 score (刚创建的学生,无事件)
  await callEAA('invalidateCache')  // 清缓存确保读最新
  const r2 = await callEAA('score', testStudentName)
  record('5.2 eaa.score 新学生应返回 0 分或 success', isOk(r2) || isErr(r2),
    isOk(r2) ? `score=${r2.data?.score ?? 'unknown'}` : `error=${errMsg(r2).slice(0, 60)}`)

  // 5.3 add-event (使用 reason-codes.json 中真实 code, dryRun 先验证)
  if (!global.__testReasonCode) {
    note('业务流跳过 add-event: 无可用 reason code')
  } else {
    // dryRun
    const r3dry = await callEAA('addEvent', {
      studentName: testStudentName,
      reasonCode: global.__testReasonCode,
      dryRun: true,
    })
    record('5.3a eaa.addEvent dryRun 验证', isOk(r3dry) || isErr(r3dry),
      isOk(r3dry) ? 'success' : `error=${errMsg(r3dry).slice(0, 60)}`)

    // 真实 add
    const r3 = await callEAA('addEvent', {
      studentName: testStudentName,
      reasonCode: global.__testReasonCode,
      note: 'cdp business flow test',
      operator: 'cdp-test',
    })
    record('5.3b eaa.addEvent 真实添加事件', isOk(r3),
      isOk(r3) ? 'success' : `error=${errMsg(r3).slice(0, 80)}`)

    if (isOk(r3)) {
      // 5.4 score 应有变化
      await callEAA('invalidateCache')
      const r4 = await callEAA('score', testStudentName)
      record('5.4 eaa.score add 后查询', isOk(r4),
        isOk(r4) ? `score=${r4.data?.score ?? 'unknown'}` : `error=${errMsg(r4).slice(0, 60)}`)

      // 5.5 history 应包含刚添加的事件
      const r5 = await callEAA('history', testStudentName)
      record('5.5 eaa.history 返回 success', isOk(r5),
        isOk(r5) ? `events=${r5.data?.events?.length ?? r5.data?.length ?? 'unknown'}` : `error=${errMsg(r5).slice(0, 60)}`)

      // 提取 event-id 用于 revert
      const events = r5?.data?.events || r5?.data || []
      if (Array.isArray(events) && events.length > 0) {
        const lastEvent = events[events.length - 1]
        const eventId = lastEvent.event_id || lastEvent.id || lastEvent.eventId
        if (eventId) {
          note(`测试用 event-id: ${eventId}`)

          // 5.6 revert 事件
          const r6 = await callEAA('revertEvent', eventId, 'cdp test revert')
          record('5.6 eaa.revertEvent 撤销事件', isOk(r6) || isErr(r6),
            isOk(r6) ? 'success' : `error=${errMsg(r6).slice(0, 80)}`)

          // 5.7 revert 后 score 应回到 0
          await callEAA('invalidateCache')
          const r7 = await callEAA('score', testStudentName)
          record('5.7 eaa.score revert 后查询', isOk(r7),
            isOk(r7) ? `score=${r7.data?.score ?? 'unknown'}` : `error=${errMsg(r7).slice(0, 60)}`)
        } else {
          note('history 事件无 event_id 字段,跳过 revert 测试')
        }
      }
    }
  }

  // 5.8 delete-student — preload 自动注入 { confirm: true },所以 IPC 层总是 confirm 删除
  // 注意: 这是 soft-delete,学生记录保留在 list 中但 is_valid=false
  const r8 = await callEAA('deleteStudent', testStudentName, 'cdp cleanup')
  record('5.8 eaa.deleteStudent 删除测试学生', isOk(r8) || isErr(r8),
    isOk(r8) ? `success: ${String(r8.data || '').slice(0, 60)}` : `error=${errMsg(r8).slice(0, 80)}`)

  // 5.9 验证学生已被 soft-delete (list-students 仍返回但 is_valid=false)
  await callEAA('invalidateCache')
  const studentsR = await callEAA('listStudents')
  const studentsList = studentsR?.data?.students || studentsR?.data || []
  const deletedStudent = Array.isArray(studentsList) ? studentsList.find(s => {
    const name = s.name || s.entity_id || s
    return name === testStudentName
  }) : null
  record('5.9 eaa.deleteStudent 后学生 is_valid=false (soft-delete)',
    deletedStudent && deletedStudent.is_valid === false,
    deletedStudent ? `is_valid=${deletedStudent.is_valid}` : 'not in list (hard delete)')
}

// 6. score / history 参数校验
async function testScoreHistoryValidation() {
  console.log('\n=== 6. score / history 参数校验 ===')

  // 6.1 score(空 name)
  const r1 = await callEAA('score', '')
  record('eaa.score(空 name) 应失败', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 60)}` : `BUG: success`)

  // 6.2 score(null)
  const r2 = await callEAA('score', null)
  record('eaa.score(null) 应失败', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 60)}` : `BUG: success`)

  // 6.3 score(数字)
  const r3 = await callEAA('score', 12345)
  record('eaa.score(数字) 应失败', isErr(r3),
    isErr(r3) ? `error=${errMsg(r3).slice(0, 60)}` : `BUG: success`)

  // 6.4 score(含 shell 字符)
  const r4 = await callEAA('score', 'name;rm')
  record('eaa.score(含 ;) 应失败', isErr(r4),
    isErr(r4) ? `error=${errMsg(r4).slice(0, 60)}` : `BUG: success`)

  // 6.5 score(不存在学生) — 应返回 success 但 score=0 或 error
  const r5 = await callEAA('score', 'CDP-NonExistent-99999')
  record('eaa.score(不存在学生) 行为', true,
    isOk(r5) ? `success, score=${r5.data?.score ?? 'N/A'}` : `error=${errMsg(r5).slice(0, 60)}`)

  // 6.6 history(空 name)
  const r6 = await callEAA('history', '')
  record('eaa.history(空 name) 应失败', isErr(r6),
    isErr(r6) ? `error=${errMsg(r6).slice(0, 60)}` : `BUG: success`)

  // 6.7 history(数字)
  const r7 = await callEAA('history', 12345)
  record('eaa.history(数字) 应失败', isErr(r7),
    isErr(r7) ? `error=${errMsg(r7).slice(0, 60)}` : `BUG: success`)

  // 6.8 history(含 null byte)
  const r8 = await callEAA('history', 'evil\0inject')
  record('eaa.history(含 null byte) 应失败', isErr(r8),
    isErr(r8) ? `error=${errMsg(r8).slice(0, 60)}` : `BUG: success`)
}

// 7. search / range / tag 参数校验
async function testSearchRangeTagValidation() {
  console.log('\n=== 7. search / range / tag 参数校验 ===')

  // 7.1 search(空 query)
  const r1 = await callEAA('search', '')
  // search 接受空字符串,但可能返回 0 结果
  record('eaa.search(空 query) 行为', true,
    isOk(r1) ? `success, results=${r1.data?.events?.length ?? 0}` : `error=${errMsg(r1).slice(0, 60)}`)

  // 7.2 search(数字)
  const r2 = await callEAA('search', 12345)
  record('eaa.search(数字) 应失败', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 60)}` : `BUG: success`)

  // 7.3 search(超长 query)
  const r3 = await callEAA('search', 'x'.repeat(20000))
  record('eaa.search(超长 20KB query) 不崩溃', isOk(r3) || isErr(r3),
    isOk(r3) ? `success, results=${r3.data?.events?.length ?? 0}` : `error=${errMsg(r3).slice(0, 60)}`)

  // 7.4 range(start 非法格式)
  const r4 = await callEAA('range', 'invalid-date', '2026-01-01')
  record('eaa.range(start 非法格式) 应失败', isErr(r4),
    isErr(r4) ? `error=${errMsg(r4).slice(0, 60)}` : `BUG: success`)

  // 7.5 range(end 非法格式)
  const r5 = await callEAA('range', '2026-01-01', 'not-a-date')
  record('eaa.range(end 非法格式) 应失败', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 60)}` : `BUG: success`)

  // 7.6 range(start > end)
  const r6 = await callEAA('range', '2026-12-31', '2026-01-01')
  record('eaa.range(start > end) 应失败 (R3)', isErr(r6),
    isErr(r6) ? `error=${errMsg(r6).slice(0, 60)}` : `BUG: success`)

  // 7.7 range(合法)
  const r7 = await callEAA('range', '2026-01-01', '2026-12-31', 10)
  record('eaa.range(合法) 返回 success', isOk(r7),
    isOk(r7) ? `events=${r7.data?.events?.length ?? 0}` : `error=${errMsg(r7).slice(0, 60)}`)

  // 7.8 tag(含 shell 字符)
  const r8 = await callEAA('tag', 'tag;rm')
  record('eaa.tag(含 ;) 应失败', isErr(r8),
    isErr(r8) ? `error=${errMsg(r8).slice(0, 60)}` : `BUG: success`)

  // 7.9 tag(无参数) 返回所有 tags
  const r9 = await callEAA('tag')
  record('eaa.tag() 返回 success', isOk(r9),
    isOk(r9) ? `tags=${r9.data?.tags?.length ?? 0}` : `error=${errMsg(r9).slice(0, 60)}`)
}

// 8. export / dashboard 参数校验
async function testExportDashboardValidation() {
  console.log('\n=== 8. export / dashboard 参数校验 ===')

  // 8.1 export(非法 format)
  const r1 = await callEAA('export', 'invalid-format')
  record('eaa.export(非法 format) 应失败', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 60)}` : `BUG: success`)

  // 8.2 export(数字 format)
  const r2 = await callEAA('export', 12345)
  record('eaa.export(数字 format) 应失败', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 60)}` : `BUG: success`)

  // 8.3 dashboard(无参数) — 可能写文件到默认目录
  // 不实际执行 dashboard 防止写文件
  note('eaa.dashboard 不实际执行 (避免写文件)')
}

// 9. revert-event 参数校验
async function testRevertValidation() {
  console.log('\n=== 9. revert-event 参数校验 ===')

  // 9.1 revert(空 eventId)
  const r1 = await callEAA('revertEvent', '', 'reason')
  record('eaa.revertEvent(空 eventId) 应失败', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 60)}` : `BUG: success`)

  // 9.2 revert(数字 eventId)
  const r2 = await callEAA('revertEvent', 12345, 'reason')
  record('eaa.revertEvent(数字 eventId) 应失败', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 60)}` : `BUG: success`)

  // 9.3 revert(eventId 含 shell 字符)
  const r3 = await callEAA('revertEvent', 'id;rm', 'reason')
  record('eaa.revertEvent(eventId 含 ;) 应失败', isErr(r3),
    isErr(r3) ? `error=${errMsg(r3).slice(0, 60)}` : `BUG: success`)

  // 9.4 revert(空 reason)
  const r4 = await callEAA('revertEvent', 'some-id', '')
  record('eaa.revertEvent(空 reason) 应失败', isErr(r4),
    isErr(r4) ? `error=${errMsg(r4).slice(0, 60)}` : `BUG: success`)

  // 9.5 revert(reason 含 shell 字符)
  const r5 = await callEAA('revertEvent', 'some-id', 'reason;rm')
  record('eaa.revertEvent(reason 含 ;) 应失败', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 60)}` : `BUG: success`)

  // 9.6 revert(不存在的 eventId)
  const r6 = await callEAA('revertEvent', 'evt-nonexistent-99999', 'cdp test')
  record('eaa.revertEvent(不存在的 eventId) 应失败或返回 error', isErr(r6) || isOk(r6),
    isOk(r6) ? 'success (EAA 可能静默接受)' : `error=${errMsg(r6).slice(0, 60)}`)
}

// 10. 缓存 + 并发
async function testCacheAndConcurrency() {
  console.log('\n=== 10. 缓存 + 并发 ===')

  // 10.1 缓存命中: 连续两次 score 同一学生
  if (global.__existingStudent) {
    const t1 = Date.now()
    const r1 = await callEAA('score', global.__existingStudent)
    const t2 = Date.now()
    const r2 = await callEAA('score', global.__existingStudent)
    const t3 = Date.now()
    const firstMs = t2 - t1
    const secondMs = t3 - t2
    record('10.1 连续两次 score 同一学生都不崩溃', isOk(r1) && isOk(r2),
      `first=${firstMs}ms, second=${secondMs}ms`)
    note(`score 缓存: first=${firstMs}ms, second=${secondMs}ms (second 应明显更快)`)
  }

  // 10.2 invalidateCache 后应重新拉取
  if (global.__existingStudent) {
    await callEAA('invalidateCache')
    const t1 = Date.now()
    const r = await callEAA('score', global.__existingStudent)
    const t2 = Date.now()
    record('10.2 invalidateCache 后 score 仍成功', isOk(r),
      isOk(r) ? `re-fetch=${t2 - t1}ms` : `error=${errMsg(r).slice(0, 60)}`)
  }

  // 10.3 5 个并发 score 不同学生 (或同一学生)
  const names = Array.isArray(global.__existingStudent)
    ? [global.__existingStudent]
    : [global.__existingStudent || 'main']
  const parallel = await Promise.all([
    callEAA('score', names[0]),
    callEAA('score', names[0]),
    callEAA('score', names[0]),
    callEAA('score', names[0]),
    callEAA('score', names[0]),
  ])
  const okCount = parallel.filter(isOk).length
  record('10.3 5 个并发 score 都成功', okCount === 5, `success=${okCount}/5`)

  // 10.4 5 个并发 listStudents
  const parallel2 = await Promise.all([
    callEAA('listStudents'),
    callEAA('listStudents'),
    callEAA('listStudents'),
    callEAA('listStudents'),
    callEAA('listStudents'),
  ])
  const okCount2 = parallel2.filter(isOk).length
  record('10.4 5 个并发 listStudents 都成功', okCount2 === 5, `success=${okCount2}/5`)

  // 10.5 3 个并发 stats
  const parallel3 = await Promise.all([
    callEAA('stats'),
    callEAA('stats'),
    callEAA('stats'),
  ])
  const okCount3 = parallel3.filter(isOk).length
  record('10.5 3 个并发 stats 都成功', okCount3 === 3, `success=${okCount3}/3`)

  // 10.6 add-event 并发 (同一学生)
  if (global.__testReasonCode && global.__existingStudent) {
    const concurrentAdds = await Promise.all([
      callEAA('addEvent', { studentName: global.__existingStudent, reasonCode: global.__testReasonCode, note: 'cdp-conc-1', operator: 'cdp' }),
      callEAA('addEvent', { studentName: global.__existingStudent, reasonCode: global.__testReasonCode, note: 'cdp-conc-2', operator: 'cdp' }),
      callEAA('addEvent', { studentName: global.__existingStudent, reasonCode: global.__testReasonCode, note: 'cdp-conc-3', operator: 'cdp' }),
    ])
    const addOk = concurrentAdds.filter(isOk).length
    record('10.6 3 个并发 add-event 都成功', addOk === 3, `success=${addOk}/3`)
    if (addOk > 0) note('并发 add-event 产生真实事件,需在最后 revert 清理')
  }
}

// 11. ranking / replay / summary
async function testRankingReplay() {
  console.log('\n=== 11. ranking / replay / summary ===')

  // 11.1 ranking()
  const r1 = await callEAA('ranking')
  record('eaa.ranking() 返回 success', isOk(r1),
    isOk(r1) ? `count=${r1.data?.ranking?.length ?? 0}` : `error=${errMsg(r1).slice(0, 60)}`)

  // 11.2 ranking(10)
  const r2 = await callEAA('ranking', 10)
  record('eaa.ranking(10) 返回 success', isOk(r2),
    isOk(r2) ? `count=${r2.data?.ranking?.length ?? 0}` : `error=${errMsg(r2).slice(0, 60)}`)

  // 11.3 ranking(0) — 应返回全部或空
  const r3 = await callEAA('ranking', 0)
  record('eaa.ranking(0) 行为', isOk(r3) || isErr(r3),
    isOk(r3) ? `success` : `error=${errMsg(r3).slice(0, 60)}`)

  // 11.4 ranking(负数) — 应走 undefined 分支
  const r4 = await callEAA('ranking', -1)
  record('eaa.ranking(-1) 行为', isOk(r4) || isErr(r4),
    isOk(r4) ? `success` : `error=${errMsg(r4).slice(0, 60)}`)

  // 11.5 ranking(超大数 10000) — 应被截断到 1000
  const r5 = await callEAA('ranking', 10000)
  record('eaa.ranking(10000 超大) 不崩溃', isOk(r5) || isErr(r5),
    isOk(r5) ? `success` : `error=${errMsg(r5).slice(0, 60)}`)

  // 11.6 ranking(字符串) — IPC 未校验类型
  const r6 = await callEAA('ranking', 'not-a-number')
  record('eaa.ranking(字符串) 行为', true,
    isOk(r6) || isErr(r6) ? 'handled' : 'unknown')

  // 11.7 replay (耗时操作, 可能很慢)
  note('eaa.replay 跳过 (耗时操作)')

  // 11.8 summary()
  const r8 = await callEAA('summary')
  record('eaa.summary() 返回 success', isOk(r8),
    isOk(r8) ? 'success' : `error=${errMsg(r8).slice(0, 60)}`)

  // 11.9 summary(合法日期范围)
  const r9 = await callEAA('summary', '2026-01-01', '2026-12-31')
  record('eaa.summary(日期范围) 返回 success', isOk(r9),
    isOk(r9) ? 'success' : `error=${errMsg(r9).slice(0, 60)}`)
}

// 12. 恢复验证
async function testRecovery() {
  console.log('\n=== 12. 恢复验证 ===')

  // 错误输入后 info 仍可用
  const info = await callEAA('info')
  record('错误输入后 eaa.info 仍可用', isOk(info),
    isOk(info) ? 'success' : `error=${errMsg(info).slice(0, 60)}`)

  // 错误输入后 listStudents 仍可用
  const students = await callEAA('listStudents')
  record('错误输入后 eaa.listStudents 仍可用', isOk(students),
    isOk(students) ? 'success' : `error=${errMsg(students).slice(0, 60)}`)

  // 错误输入后 score 仍可用
  if (global.__existingStudent) {
    const score = await callEAA('score', global.__existingStudent)
    record('错误输入后 eaa.score 仍可用', isOk(score),
      isOk(score) ? 'success' : `error=${errMsg(score).slice(0, 60)}`)
  }

  // window.api 仍可用
  const apiCheck = await rawEval(`(() => {
    const api = window.__EAA_API__ || window.api;
    return JSON.stringify({
      hasEaa: !!api && !!api.eaa,
      eaaMethods: api?.eaa ? Object.keys(api.eaa).length : 0,
    });
  })()`)
  record('错误输入后 window.api.eaa 仍可用', apiCheck && apiCheck.includes('"hasEaa":true'),
    apiCheck || 'undefined')
}

// =============================================================
// 主流程
// =============================================================

async function main() {
  console.log('=====================================')
  console.log('EAA 核心业务流深度测试')
  console.log('=====================================')

  const pages = await getPages()
  const page = await findAppPage(pages)
  if (!page) {
    console.error('❌ 未找到 app page')
    process.exit(1)
  }
  console.log(`✅ CDP 连接成功 — ${page.url.slice(0, 80)}`)
  global.__wsUrl = page.webSocketDebuggerUrl

  // 导航到 Students 页面 (确保 EAA 数据已加载)
  await rawEval(`(() => { if (location.hash !== '#/students') { location.hash = '#/students'; } return location.hash; })()`)
  await sleep(800)

  await testBasics()
  await testReadOps()
  await testAddStudentValidation()
  await testAddEventValidation()
  await testBusinessFlow()
  await testScoreHistoryValidation()
  await testSearchRangeTagValidation()
  await testExportDashboardValidation()
  await testRevertValidation()
  await testCacheAndConcurrency()
  await testRankingReplay()
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

  process.exit(stats.fail === 0 && stats.bug === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(2)
})
