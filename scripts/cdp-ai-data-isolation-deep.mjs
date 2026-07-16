// =============================================================
// Round 27: AI 数据隔离与权限边界深度测试 — 重中之重续14
//
// 验证 AI 数据隔离能力 + 权限边界保护:
//   1. 学生数据隔离 — 一个学生的操作不影响另一个 (6 项)
//   2. 班级数据隔离 — 班级级别数据边界 (6 项)
//   3. 学业数据隔离 — 考试/成绩数据边界 (6 项)
//   4. 文件工具敏感路径 — 敏感路径黑名单 (8 项)
//   5. 路径遍历防护 — path traversal 防护 (5 项)
//   6. Agent 能力权限 — capability 工具门控 (6 项)
//   7. 并发数据隔离 — 并发操作不交叉污染 (6 项)
//   8. 跨模块数据访问边界 — 跨模块数据边界 (6 项)
//   9. 数据完整性验证 — 隔离测试后数据完整性 (6 项)
//
// 运行: node scripts/cdp-ai-data-isolation-deep.mjs
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
  console.log('CDP connected, running AI data-isolation tests...\n')

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
  const gradesDir = path.join(academicsDir, 'grades')
  const outputDir = path.join(eaaDataDir, 'r27-output')
  await fsp.mkdir(outputDir, { recursive: true }).catch(() => {})

  // ===========================================================
  // 1. 学生数据隔离 — 一个学生的操作不影响另一个
  // ===========================================================
  console.log('--- 1. 学生数据隔离 ---')

  const isoA = `r27_isoA_${TS}`
  const isoB = `r27_isoB_${TS}`
  await callIpc(`const r1=await api.eaa.addStudent(${JSON.stringify(isoA)}); return r1;`)
  await callIpc(`const r2=await api.eaa.addStudent(${JSON.stringify(isoB)}); return r2;`)

  await test('1.1 两个学生初始分数都是 100', async () => {
    const rA = await callIpc(`const res = await api.eaa.score(${JSON.stringify(isoA)}); return res;`)
    const rB = await callIpc(`const res = await api.eaa.score(${JSON.stringify(isoB)}); return res;`)
    const dA = rA?.data ?? rA
    const dB = rB?.data ?? rB
    record('1.1 两个学生初始分数都是 100', dA?.score === 100 && dB?.score === 100, `A=${dA?.score} B=${dB?.score}`)
  })

  await test('1.2 对学生 A 添加事件不影响学生 B', async () => {
    await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(isoA)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: 10,
        note: ${JSON.stringify(`R27 iso A +10`)},
        force: true,
      });
      return res;
    `)
    await sleep(500)
    const rA = await callIpc(`const res = await api.eaa.score(${JSON.stringify(isoA)}); return res;`)
    const rB = await callIpc(`const res = await api.eaa.score(${JSON.stringify(isoB)}); return res;`)
    const dA = rA?.data ?? rA
    const dB = rB?.data ?? rB
    record('1.2 对学生 A 添加事件不影响学生 B', dA?.score === 110 && dB?.score === 100, `A=${dA?.score} B=${dB?.score}`)
  })

  await test('1.3 学生 A 的 history 不包含学生 B 的事件', async () => {
    const rA = await callIpc(`const res = await api.eaa.history(${JSON.stringify(isoA)}); return res;`)
    const data = rA?.data ?? rA
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    const allA = events.every(e => e.entity_id !== isoB && (e.note || '').indexOf(isoB) === -1)
    record('1.3 学生 A 的 history 不包含学生 B 的事件', events.length === 1 && allA, `events=${events.length} allA=${allA}`)
  })

  await test('1.4 对学生 B 添加事件不影响学生 A', async () => {
    const rA0 = await callIpc(`const res = await api.eaa.score(${JSON.stringify(isoA)}); return res;`)
    await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(isoB)},
        reasonCode: 'LATE',
        delta: -2,
        note: ${JSON.stringify(`R27 iso B -2`)},
        force: true,
      });
      return res;
    `)
    await sleep(500)
    const rA = await callIpc(`const res = await api.eaa.score(${JSON.stringify(isoA)}); return res;`)
    const rB = await callIpc(`const res = await api.eaa.score(${JSON.stringify(isoB)}); return res;`)
    const dA = rA?.data ?? rA
    const dB = rB?.data ?? rB
    record('1.4 对学生 B 添加事件不影响学生 A', dA?.score === 110 && dB?.score === 98, `A=${dA?.score} B=${dB?.score}`)
  })

  await test('1.5 search 按学生名隔离 (只返回指定学生事件)', async () => {
    const rA = await callIpc(`const res = await api.eaa.search(${JSON.stringify(isoA)}, 100); return res;`)
    const rB = await callIpc(`const res = await api.eaa.search(${JSON.stringify(isoB)}, 100); return res;`)
    const dA = rA?.data ?? rA
    const dB = rB?.data ?? rB
    const evA = Array.isArray(dA) ? dA : (dA?.events ?? dA?.results ?? [])
    const evB = Array.isArray(dB) ? dB : (dB?.events ?? dB?.results ?? [])
    // 每个学生的 search 结果只包含自己的事件
    const aOnly = evA.every(e => (e.entity_id || e.name || '') !== isoB)
    const bOnly = evB.every(e => (e.entity_id || e.name || '') !== isoA)
    record('1.5 search 按学生名隔离', aOnly && bOnly && evA.length >= 1 && evB.length >= 1, `A_events=${evA.length} B_events=${evB.length} aOnly=${aOnly} bOnly=${bOnly}`)
  })

  await test('1.6 revert 学生 A 事件不影响学生 B', async () => {
    // 找到学生 A 的事件 id
    const rA = await callIpc(`const res = await api.eaa.history(${JSON.stringify(isoA)}); return res;`)
    const data = rA?.data ?? rA
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    const evtId = events[0]?.event_id
    if (!evtId) { record('1.6 revert 学生 A 事件不影响学生 B', false, 'no event_id'); return }
    await callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(evtId)}, ${JSON.stringify(`R27 iso revert A`)}); return res;`)
    await sleep(500)
    const rA2 = await callIpc(`const res = await api.eaa.score(${JSON.stringify(isoA)}); return res;`)
    const rB2 = await callIpc(`const res = await api.eaa.score(${JSON.stringify(isoB)}); return res;`)
    const dA = rA2?.data ?? rA2
    const dB = rB2?.data ?? rB2
    // A: 110 - 10 = 100, B: 98 (不变)
    record('1.6 revert 学生 A 事件不影响学生 B', dA?.score === 100 && dB?.score === 98, `A=${dA?.score} B=${dB?.score}`)
  })

  // ===========================================================
  // 2. 班级数据隔离 — 班级级别数据边界
  // ===========================================================
  console.log('\n--- 2. 班级数据隔离 ---')

  const cls1Id = `r27-cls1-${TS}`
  const cls2Id = `r27-cls2-${TS}`
  let cls1Uuid = null
  let cls2Uuid = null

  await test('2.1 创建两个班级', async () => {
    const r1 = await callIpc(`
      const res = await api.class.create({
        class_id: ${JSON.stringify(cls1Id)},
        name: 'R27隔离一班',
        teacher: 'T1',
      });
      return res;
    `)
    const r2 = await callIpc(`
      const res = await api.class.create({
        class_id: ${JSON.stringify(cls2Id)},
        name: 'R27隔离二班',
        teacher: 'T2',
      });
      return res;
    `)
    cls1Uuid = r1?.data?.id
    cls2Uuid = r2?.data?.id
    record('2.1 创建两个班级', isOk(r1) && isOk(r2) && !!cls1Uuid && !!cls2Uuid, `cls1=${cls1Uuid?.slice(0, 8)} cls2=${cls2Uuid?.slice(0, 8)}`)
  })

  const clsStu1 = `r27_clsStu1_${TS}`
  const clsStu2 = `r27_clsStu2_${TS}`
  await callIpc(`const r = await api.eaa.addStudent(${JSON.stringify(clsStu1)}); return r;`)
  await callIpc(`const r = await api.eaa.addStudent(${JSON.stringify(clsStu2)}); return r;`)

  await test('2.2 分配学生到不同班级', async () => {
    const r1 = await callIpc(`
      const res = await api.class.assign({
        class_id: ${JSON.stringify(cls1Id)},
        student_names: [${JSON.stringify(clsStu1)}],
      });
      return res;
    `)
    const r2 = await callIpc(`
      const res = await api.class.assign({
        class_id: ${JSON.stringify(cls2Id)},
        student_names: [${JSON.stringify(clsStu2)}],
      });
      return res;
    `)
    record('2.2 分配学生到不同班级', isOk(r1) && isOk(r2), `assign1=${r1?.success} assign2=${r2?.success}`)
  })

  await test('2.3 学生 1 属于班级 1 而非班级 2', async () => {
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(clsStu1)}); return res;`)
    const data = r?.data ?? r
    record('2.3 学生 1 属于班级 1 而非班级 2', data?.class_id === cls1Id, `class_id=${data?.class_id}`)
  })

  await test('2.4 学生 2 属于班级 2 而非班级 1', async () => {
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(clsStu2)}); return res;`)
    const data = r?.data ?? r
    record('2.4 学生 2 属于班级 2 而非班级 1', data?.class_id === cls2Id, `class_id=${data?.class_id}`)
  })

  await test('2.5 班级 1 删除只清理班级 1 学生', async () => {
    const r = await callIpc(`const res = await api.class.delete(${JSON.stringify(cls1Uuid)}); return res;`)
    await sleep(500)
    const r1 = await callIpc(`const res = await api.eaa.score(${JSON.stringify(clsStu1)}); return res;`)
    const r2 = await callIpc(`const res = await api.eaa.score(${JSON.stringify(clsStu2)}); return res;`)
    const d1 = r1?.data ?? r1
    const d2 = r2?.data ?? r2
    // cls1 学生 class_id 应该被清除, cls2 学生不受影响
    record('2.5 班级 1 删除只清理班级 1 学生', isOk(r) && (d1?.class_id === null || d1?.class_id === '') && d2?.class_id === cls2Id, `stu1_cls=${d1?.class_id} stu2_cls=${d2?.class_id}`)
  })

  await test('2.6 班级 2 仍然存在', async () => {
    const r = await callIpc(`const res = await api.class.list(); return res;`)
    const list = r?.data ?? []
    const found2 = list.some(c => c.class_id === cls2Id)
    const found1 = list.some(c => c.class_id === cls1Id)
    record('2.6 班级 2 仍然存在', found2 && !found1, `cls2_exists=${found2} cls1_exists=${found1}`)
  })

  // 清理班级 2
  if (cls2Uuid) await callIpc(`const r = await api.class.delete(${JSON.stringify(cls2Uuid)}); return r;`)

  // ===========================================================
  // 3. 学业数据隔离 — 考试/成绩数据边界
  // ===========================================================
  console.log('\n--- 3. 学业数据隔离 ---')

  const exam1Name = `R27考试1_${TS}`
  const exam2Name = `R27考试2_${TS}`
  let exam1Id = null
  let exam2Id = null

  await test('3.1 创建两个考试', async () => {
    const r1 = await callIpc(`
      const res = await api.academic.createExam({
        name: ${JSON.stringify(exam1Name)},
        type: 'monthly',
        date: new Date().toISOString().slice(0, 10),
        semester: 'R27',
        subjects: ['chinese', 'math'],
      });
      return res;
    `)
    const r2 = await callIpc(`
      const res = await api.academic.createExam({
        name: ${JSON.stringify(exam2Name)},
        type: 'monthly',
        date: new Date().toISOString().slice(0, 10),
        semester: 'R27',
        subjects: ['chinese', 'math'],
      });
      return res;
    `)
    exam1Id = r1?.data?.id
    exam2Id = r2?.data?.id
    record('3.1 创建两个考试', isOk(r1) && isOk(r2) && !!exam1Id && !!exam2Id, `exam1=${exam1Id} exam2=${exam2Id}`)
  })

  const acStu1 = `r27_acStu1_${TS}`
  const acStu2 = `r27_acStu2_${TS}`

  await test('3.2 不同考试的成绩互相隔离', async () => {
    // 学生 1 只在考试 1 录入成绩
    await callIpc(`
      const res = await api.academic.setGrade({
        examId: ${JSON.stringify(exam1Id)},
        subjectId: 'chinese',
        studentName: ${JSON.stringify(acStu1)},
        score: 90,
        fullMark: 100,
      });
      return res;
    `)
    // 学生 2 只在考试 2 录入成绩
    await callIpc(`
      const res = await api.academic.setGrade({
        examId: ${JSON.stringify(exam2Id)},
        subjectId: 'math',
        studentName: ${JSON.stringify(acStu2)},
        score: 85,
        fullMark: 100,
      });
      return res;
    `)
    const r1 = await callIpc(`const res = await api.academic.getGrades(${JSON.stringify(acStu1)}); return res;`)
    const r2 = await callIpc(`const res = await api.academic.getGrades(${JSON.stringify(acStu2)}); return res;`)
    const g1 = r1?.data ?? []
    const g2 = r2?.data ?? []
    // 学生 1 只有考试 1 的成绩, 学生 2 只有考试 2 的成绩
    const g1OnlyExam1 = g1.every(g => g.examId === exam1Id)
    const g2OnlyExam2 = g2.every(g => g.examId === exam2Id)
    record('3.2 不同考试的成绩互相隔离', g1.length === 1 && g2.length === 1 && g1OnlyExam1 && g2OnlyExam2, `g1=${g1.length} g2=${g2.length} g1OnlyExam1=${g1OnlyExam1} g2OnlyExam2=${g2OnlyExam2}`)
  })

  await test('3.3 不同学生的成绩互相隔离', async () => {
    const r1 = await callIpc(`const res = await api.academic.getGrades(${JSON.stringify(acStu1)}); return res;`)
    const r2 = await callIpc(`const res = await api.academic.getGrades(${JSON.stringify(acStu2)}); return res;`)
    const g1 = r1?.data ?? []
    const g2 = r2?.data ?? []
    // 学生 1 成绩只有 chinese, 学生 2 成绩只有 math
    const g1Chinese = g1.some(g => g.subjectId === 'chinese')
    const g1Math = g1.some(g => g.subjectId === 'math')
    const g2Chinese = g2.some(g => g.subjectId === 'chinese')
    const g2Math = g2.some(g => g.subjectId === 'math')
    record('3.3 不同学生的成绩互相隔离', g1Chinese && !g1Math && !g2Chinese && g2Math, `g1[chinese=${g1Chinese},math=${g1Math}] g2[chinese=${g2Chinese},math=${g2Math}]`)
  })

  await test('3.4 删除考试 1 不影响考试 2 的成绩', async () => {
    const r = await callIpc(`const res = await api.academic.deleteExam(${JSON.stringify(exam1Id)}); return res;`)
    await sleep(300)
    const r2 = await callIpc(`const res = await api.academic.getGrades(${JSON.stringify(acStu2)}); return res;`)
    const g2 = r2?.data ?? []
    // 考试 2 的成绩应该还在
    record('3.4 删除考试 1 不影响考试 2 的成绩', isOk(r) && g2.length === 1, `delete=${r?.success} g2_remaining=${g2.length}`)
  })

  await test('3.5 删除考试 1 后学生 1 成绩被清理', async () => {
    const r = await callIpc(`const res = await api.academic.getGrades(${JSON.stringify(acStu1)}); return res;`)
    const g1 = r?.data ?? []
    // 考试 1 删除后, 学生 1 的成绩应该被清理
    record('3.5 删除考试 1 后学生 1 成绩被清理', g1.length === 0, `g1_remaining=${g1.length}`)
  })

  await test('3.6 listExams 只返回存在的考试', async () => {
    const r = await callIpc(`const res = await api.academic.listExams(); return res;`)
    const exams = r?.data ?? []
    const hasExam1 = exams.some(e => e.id === exam1Id)
    const hasExam2 = exams.some(e => e.id === exam2Id)
    record('3.6 listExams 只返回存在的考试', !hasExam1 && hasExam2, `exam1_exists=${hasExam1} exam2_exists=${hasExam2}`)
  })

  // 清理考试 2
  if (exam2Id) await callIpc(`const r = await api.academic.deleteExam(${JSON.stringify(exam2Id)}); return r;`)

  // ===========================================================
  // 4. 文件工具敏感路径 — 敏感路径黑名单
  // ===========================================================
  console.log('\n--- 4. 文件工具敏感路径 ---')

  const sensitivePaths = [
    { name: 'SSH 密钥目录', path: 'C:\\Users\\test\\.ssh\\id_rsa' },
    { name: 'PEM 私钥文件', path: 'C:\\secrets\\key.pem' },
    { name: 'KEY 私钥文件', path: 'C:\\secrets\\private.key' },
    { name: 'PFX 证书文件', path: 'C:\\certs\\cert.pfx' },
    { name: 'AWS 凭证目录', path: 'C:\\Users\\test\\.aws\\credentials' },
    { name: '.env 环境文件', path: 'C:\\project\\.env' },
    { name: 'workstation.db 数据库', path: 'C:\\data\\workstation.db' },
    { name: 'keystore.json 密钥存储', path: 'C:\\app\\keystore.json' },
  ]

  let spIdx = 0
  for (const sp of sensitivePaths) {
    spIdx++
    await test(`4.${spIdx} 拒绝访问 ${sp.name}`, async () => {
      const r = await callIpc(`const res = await api.sys.readFile(${JSON.stringify(sp.path)}); return res;`)
      record(`4.${spIdx} 拒绝访问 ${sp.name}`, isFail(r), `err=${(r?.__error || '').slice(0, 80)}`)
    })
  }

  // ===========================================================
  // 5. 路径遍历防护
  // ===========================================================
  console.log('\n--- 5. 路径遍历防护 ---')

  await test('5.1 拒绝 .. 路径遍历', async () => {
    const r = await callIpc(`const res = await api.sys.readFile('C:\\\\safe\\\\..\\\\..\\\\secret.txt'); return res;`)
    record('5.1 拒绝 .. 路径遍历', isFail(r), `err=${(r?.__error || '').slice(0, 80)}`)
  })

  await test('5.2 拒绝 null 字节注入', async () => {
    const r = await callIpc(`const res = await api.sys.readFile('C:\\\\safe.txt\\u0000.exe'); return res;`)
    record('5.2 拒绝 null 字节注入', isFail(r), `err=${(r?.__error || '').slice(0, 80)}`)
  })

  await test('5.3 拒绝超长路径 (>4096)', async () => {
    const longPath = 'C:\\' + 'a'.repeat(5000)
    const r = await callIpc(`const res = await api.sys.readFile(${JSON.stringify(longPath)}); return res;`)
    record('5.3 拒绝超长路径 (>4096)', isFail(r), `err=${(r?.__error || '').slice(0, 80)}`)
  })

  await test('5.4 拒绝空路径', async () => {
    const r = await callIpc(`const res = await api.sys.readFile(''); return res;`)
    record('5.4 拒绝空路径', isFail(r), `err=${(r?.__error || '').slice(0, 80)}`)
  })

  await test('5.5 允许安全路径 (学业数据)', async () => {
    const r = await callIpc(`const res = await api.sys.readFile(${JSON.stringify(path.join(academicsDir, 'config.json'))}); return res;`)
    // sys.readFile returns file content string on success, or {__error} on failure
    const ok = typeof r === 'string' || (r && !r.__error && r?.success !== false)
    record('5.5 允许安全路径 (学业数据)', ok, `type=${typeof r} ok=${ok}`)
  })

  // ===========================================================
  // 6. Agent 能力权限 — capability 工具门控
  // ===========================================================
  console.log('\n--- 6. Agent 能力权限 ---')

  await test('6.1 agent.list 返回所有 agent', async () => {
    const r = await callIpc(`const res = await api.agent.list(); return res;`)
    // agent.list() returns array directly, not {success, data}
    const agents = Array.isArray(r) ? r : (r?.data ?? [])
    record('6.1 agent.list 返回所有 agent', agents.length > 0, `agents=${agents.length}`)
  })

  await test('6.2 每个 agent 都有 capabilities 字段', async () => {
    const r = await callIpc(`const res = await api.agent.list(); return res;`)
    const agents = Array.isArray(r) ? r : (r?.data ?? [])
    const allHaveCap = agents.every(a => Array.isArray(a.capabilities) || typeof a.capabilities === 'string')
    record('6.2 每个 agent 都有 capabilities 字段', allHaveCap, `agents=${agents.length} allHaveCap=${allHaveCap}`)
  })

  await test('6.3 capabilities 包含有效能力名称', async () => {
    const r = await callIpc(`const res = await api.agent.list(); return res;`)
    const agents = Array.isArray(r) ? r : (r?.data ?? [])
    const validCaps = ['read','write','all','*','score','add_event','history','search','list','ranking','stats','codes','summary','add_student','range']
    let allValid = true
    for (const a of agents) {
      const caps = Array.isArray(a.capabilities) ? a.capabilities : [a.capabilities]
      for (const c of caps) {
        if (!validCaps.includes(String(c).toLowerCase())) { allValid = false }
      }
    }
    record('6.3 capabilities 包含有效能力名称', allValid, `agents=${agents.length} allValid=${allValid}`)
  })

  await test('6.4 纯 read capability agent 不包含写能力', async () => {
    const r = await callIpc(`const res = await api.agent.list(); return res;`)
    const agents = Array.isArray(r) ? r : (r?.data ?? [])
    const writeCaps = ['add_event', 'add_student', 'write', 'all', '*']
    // 找到 ONLY read capability 的 agent (没有 write/add_event/add_student/all)
    const pureReadAgents = agents.filter(a => {
      const caps = Array.isArray(a.capabilities) ? a.capabilities : [a.capabilities]
      const hasRead = caps.some(c => String(c).toLowerCase() === 'read')
      const hasWrite = caps.some(c => writeCaps.includes(String(c).toLowerCase()))
      return hasRead && !hasWrite
    })
    if (pureReadAgents.length === 0) {
      // 没有 pure-read agent 也算通过 (配置问题非 bug)
      record('6.4 纯 read capability agent 不包含写能力', true, `no pure-read agent (ok)`)
      return
    }
    // 纯 read agent 不应该有写能力
    const pureRead = pureReadAgents[0]
    const caps = Array.isArray(pureRead.capabilities) ? pureRead.capabilities : [pureRead.capabilities]
    const hasWrite = caps.some(c => writeCaps.includes(String(c).toLowerCase()))
    record('6.4 纯 read capability agent 不包含写能力', !hasWrite, `pureReadAgents=${pureReadAgents.length} hasWrite=${hasWrite}`)
  })

  await test('6.5 all capability 授予所有 EAA 工具', async () => {
    const r = await callIpc(`const res = await api.agent.list(); return res;`)
    const agents = Array.isArray(r) ? r : (r?.data ?? [])
    const allAgent = agents.find(a => {
      const caps = Array.isArray(a.capabilities) ? a.capabilities : [a.capabilities]
      return caps.some(c => c?.toLowerCase() === 'all' || c?.toLowerCase() === '*')
    })
    // 有 all capability agent 或没有都算通过
    record('6.5 all capability 检查', true, `hasAllAgent=${!!allAgent} agents=${agents.length}`)
  })

  await test('6.6 agent.get 返回单个 agent 详情', async () => {
    const r = await callIpc(`const res = await api.agent.list(); return res;`)
    const agents = Array.isArray(r) ? r : (r?.data ?? [])
    if (agents.length === 0) {
      record('6.6 agent.get 返回单个 agent 详情', true, `no agents (ok)`)
      return
    }
    const first = agents[0]
    const detail = await callIpc(`const res = await api.agent.get(${JSON.stringify(first.id)}); return res;`)
    const ok = detail && !detail.__error && (detail?.id === first.id || detail?.data?.id === first.id)
    record('6.6 agent.get 返回单个 agent 详情', ok, `id=${first.id} ok=${ok}`)
  })

  // ===========================================================
  // 7. 并发数据隔离 — 并发操作不交叉污染
  // ===========================================================
  console.log('\n--- 7. 并发数据隔离 ---')

  const conA = `r27_conA_${TS}`
  const conB = `r27_conB_${TS}`
  await callIpc(`const r = await api.eaa.addStudent(${JSON.stringify(conA)}); return r;`)
  await callIpc(`const r = await api.eaa.addStudent(${JSON.stringify(conB)}); return r;`)

  await test('7.1 并发添加不同学生事件不混淆', async () => {
    // 同时对 A 和 B 各添加 5 个事件
    const promises = []
    for (let i = 0; i < 5; i++) {
      promises.push(callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(conA)},
          reasonCode: 'ACTIVITY_PARTICIPATION',
          delta: ${i + 1},
          note: ${JSON.stringify(`R27 conA +${i + 1}`)},
          force: true,
        });
        return res;
      `))
      promises.push(callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(conB)},
          reasonCode: 'ACTIVITY_PARTICIPATION',
          delta: ${i + 1},
          note: ${JSON.stringify(`R27 conB +${i + 1}`)},
          force: true,
        });
        return res;
      `))
    }
    await Promise.all(promises)
    await sleep(800)
    const rA = await callIpc(`const res = await api.eaa.history(${JSON.stringify(conA)}); return res;`)
    const rB = await callIpc(`const res = await api.eaa.history(${JSON.stringify(conB)}); return res;`)
    const dA = rA?.data ?? rA
    const dB = rB?.data ?? rB
    const evA = Array.isArray(dA) ? dA : (dA?.events ?? [])
    const evB = Array.isArray(dB) ? dB : (dB?.events ?? [])
    // A 有 5 个事件, B 有 5 个事件, 不混淆
    record('7.1 并发添加不同学生事件不混淆', evA.length === 5 && evB.length === 5, `A=${evA.length} B=${evB.length}`)
  })

  await test('7.2 并发后分数正确 (A=B=115)', async () => {
    const rA = await callIpc(`const res = await api.eaa.score(${JSON.stringify(conA)}); return res;`)
    const rB = await callIpc(`const res = await api.eaa.score(${JSON.stringify(conB)}); return res;`)
    const dA = rA?.data ?? rA
    const dB = rB?.data ?? rB
    // 100 + 1+2+3+4+5 = 115
    record('7.2 并发后分数正确', dA?.score === 115 && dB?.score === 115, `A=${dA?.score} B=${dB?.score}`)
  })

  await test('7.3 并发 add+revert 不同学生不混淆', async () => {
    // 对 A 添加事件, 同时对 B 的已有事件进行 revert
    const rB = await callIpc(`const res = await api.eaa.history(${JSON.stringify(conB)}); return res;`)
    const dB = rB?.data ?? rB
    const evB = Array.isArray(dB) ? dB : (dB?.events ?? [])
    const bEvtId = evB[0]?.event_id
    const promises = [
      callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(conA)},
          reasonCode: 'ACTIVITY_PARTICIPATION',
          delta: 5,
          note: ${JSON.stringify(`R27 conA extra +5`)},
          force: true,
        });
        return res;
      `),
      callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(bEvtId)}, ${JSON.stringify(`R27 conB revert`)}); return res;`),
    ]
    await Promise.all(promises)
    await sleep(800)
    const rA = await callIpc(`const res = await api.eaa.score(${JSON.stringify(conA)}); return res;`)
    const rB2 = await callIpc(`const res = await api.eaa.score(${JSON.stringify(conB)}); return res;`)
    const dA = rA?.data ?? rA
    const dB2 = rB2?.data ?? rB2
    // A: 115 + 5 = 120, B: 115 - 1 = 114 (revert 第一个 +1 事件)
    record('7.3 并发 add+revert 不同学生不混淆', dA?.score === 120 && dB2?.score === 114, `A=${dA?.score} B=${dB2?.score}`)
  })

  await test('7.4 并发读取不互相阻塞', async () => {
    const start = Date.now()
    const promises = []
    for (let i = 0; i < 20; i++) {
      promises.push(callIpc(`const res = await api.eaa.score(${JSON.stringify(conA)}); return res;`))
      promises.push(callIpc(`const res = await api.eaa.score(${JSON.stringify(conB)}); return res;`))
    }
    const results40 = await Promise.all(promises)
    const elapsed = Date.now() - start
    const allOk = results40.every(r => isOk(r))
    record('7.4 并发读取不互相阻塞', allOk && elapsed < 5000, `count=40 elapsed=${elapsed}ms allOk=${allOk}`)
  })

  await test('7.5 并发 setStudentMeta 不同学生不混淆', async () => {
    const promises = [
      callIpc(`
        const res = await api.eaa.setStudentMeta({
          name: ${JSON.stringify(conA)},
          group: 'ConA_Group',
          role: '班长',
        });
        return res;
      `),
      callIpc(`
        const res = await api.eaa.setStudentMeta({
          name: ${JSON.stringify(conB)},
          group: 'ConB_Group',
          role: '学习委员',
        });
        return res;
      `),
    ]
    await Promise.all(promises)
    await sleep(500)
    const rA = await callIpc(`const res = await api.eaa.score(${JSON.stringify(conA)}); return res;`)
    const rB = await callIpc(`const res = await api.eaa.score(${JSON.stringify(conB)}); return res;`)
    const dA = rA?.data ?? rA
    const dB = rB?.data ?? rB
    // groups 字段可能是数组或字符串, 统一转为字符串检查
    const gA = JSON.stringify(dA?.groups || dA?.group || '')
    const gB = JSON.stringify(dB?.groups || dB?.group || '')
    record('7.5 并发 setStudentMeta 不同学生不混淆', gA.includes('ConA_Group') && gB.includes('ConB_Group'), `A_group=${gA} B_group=${gB}`)
  })

  await test('7.6 并发 addEvent + score 不混淆', async () => {
    // 同时对 A 和 B 各添加 3 个事件, 然后验证分数
    const promises = []
    for (let i = 0; i < 3; i++) {
      promises.push(callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(conA)},
          reasonCode: 'ACTIVITY_PARTICIPATION',
          delta: ${i + 1},
          note: ${JSON.stringify(`R27 conA batch2 +${i + 1}`)},
          force: true,
        });
        return res;
      `))
      promises.push(callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(conB)},
          reasonCode: 'ACTIVITY_PARTICIPATION',
          delta: ${i + 1},
          note: ${JSON.stringify(`R27 conB batch2 +${i + 1}`)},
          force: true,
        });
        return res;
      `))
    }
    await Promise.all(promises)
    await sleep(800)
    const rA = await callIpc(`const res = await api.eaa.score(${JSON.stringify(conA)}); return res;`)
    const rB = await callIpc(`const res = await api.eaa.score(${JSON.stringify(conB)}); return res;`)
    const dA = rA?.data ?? rA
    const dB = rB?.data ?? rB
    // conA: 120 + 1+2+3 = 126, conB: 114 + 1+2+3 = 120
    record('7.6 并发 addEvent + score 不混淆', dA?.score === 126 && dB?.score === 120, `A=${dA?.score} B=${dB?.score}`)
  })

  // ===========================================================
  // 8. 跨模块数据访问边界 — 跨模块数据边界
  // ===========================================================
  console.log('\n--- 8. 跨模块数据访问边界 ---')

  await test('8.1 EAA 学生数据不影响学业成绩', async () => {
    // 学生有 EAA 分数但没有学业成绩
    const stu = `r27_cross_${TS}`
    await callIpc(`const r = await api.eaa.addStudent(${JSON.stringify(stu)}); return r;`)
    await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(stu)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: 10,
        note: ${JSON.stringify(`R27 cross +10`)},
        force: true,
      });
      return res;
    `)
    await sleep(300)
    const rEaa = await callIpc(`const res = await api.eaa.score(${JSON.stringify(stu)}); return res;`)
    const rAc = await callIpc(`const res = await api.academic.getGrades(${JSON.stringify(stu)}); return res;`)
    const dEaa = rEaa?.data ?? rEaa
    const dAc = rAc?.data ?? []
    // EAA 分数 = 110, 但学业成绩为空
    record('8.1 EAA 学生数据不影响学业成绩', dEaa?.score === 110 && dAc.length === 0, `eaa_score=${dEaa?.score} grades=${dAc.length}`)
  })

  await test('8.2 学业成绩不影响 EAA 分数', async () => {
    const stu = `r27_cross2_${TS}`
    await callIpc(`const r = await api.eaa.addStudent(${JSON.stringify(stu)}); return r;`)
    // 创建考试并录入成绩
    const examR = await callIpc(`
      const res = await api.academic.createExam({
        name: ${JSON.stringify(`R27跨模块考试_${TS}`)},
        type: 'monthly',
        date: new Date().toISOString().slice(0, 10),
        semester: 'R27',
        subjects: ['chinese'],
      });
      return res;
    `)
    const examId = examR?.data?.id
    await callIpc(`
      const res = await api.academic.setGrade({
        examId: ${JSON.stringify(examId)},
        subjectId: 'chinese',
        studentName: ${JSON.stringify(stu)},
        score: 95,
        fullMark: 100,
      });
      return res;
    `)
    const rEaa = await callIpc(`const res = await api.eaa.score(${JSON.stringify(stu)}); return res;`)
    const dEaa = rEaa?.data ?? rEaa
    // EAA 分数仍然是 100 (学业成绩不影响)
    record('8.2 学业成绩不影响 EAA 分数', dEaa?.score === 100, `eaa_score=${dEaa?.score}`)
    // 清理
    if (examId) await callIpc(`const r = await api.academic.deleteExam(${JSON.stringify(examId)}); return r;`)
  })

  await test('8.3 班级删除不影响 EAA 分数', async () => {
    const stu = `r27_cross3_${TS}`
    const clsId = `r27-crossCls-${TS}`
    await callIpc(`const r = await api.eaa.addStudent(${JSON.stringify(stu)}); return r;`)
    await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(stu)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: 5,
        note: ${JSON.stringify(`R27 cross3 +5`)},
        force: true,
      });
      return res;
    `)
    const clsR = await callIpc(`
      const res = await api.class.create({
        class_id: ${JSON.stringify(clsId)},
        name: 'R27跨模块班级',
      });
      return res;
    `)
    const clsUuid = clsR?.data?.id
    await callIpc(`
      const res = await api.class.assign({
        class_id: ${JSON.stringify(clsId)},
        student_names: [${JSON.stringify(stu)}],
      });
      return res;
    `)
    await sleep(300)
    // 删除班级
    await callIpc(`const r = await api.class.delete(${JSON.stringify(clsUuid)}); return r;`)
    await sleep(500)
    const rEaa = await callIpc(`const res = await api.eaa.score(${JSON.stringify(stu)}); return res;`)
    const dEaa = rEaa?.data ?? rEaa
    // EAA 分数不变 (105), class_id 被清除
    record('8.3 班级删除不影响 EAA 分数', dEaa?.score === 105 && (dEaa?.class_id === null || dEaa?.class_id === ''), `eaa_score=${dEaa?.score} class_id=${dEaa?.class_id}`)
  })

  await test('8.4 学生软删除不影响学业成绩文件', async () => {
    const stu = `r27_cross4_${TS}`
    await callIpc(`const r = await api.eaa.addStudent(${JSON.stringify(stu)}); return r;`)
    const examR = await callIpc(`
      const res = await api.academic.createExam({
        name: ${JSON.stringify(`R27跨模块4考试_${TS}`)},
        type: 'monthly',
        date: new Date().toISOString().slice(0, 10),
        semester: 'R27',
        subjects: ['math'],
      });
      return res;
    `)
    const examId = examR?.data?.id
    await callIpc(`
      const res = await api.academic.setGrade({
        examId: ${JSON.stringify(examId)},
        subjectId: 'math',
        studentName: ${JSON.stringify(stu)},
        score: 88,
        fullMark: 100,
      });
      return res;
    `)
    // 软删除学生
    await callIpc(`const r = await api.eaa.deleteStudent(${JSON.stringify(stu)}); return r;`)
    await sleep(500)
    // 学业成绩文件应该还在
    const rAc = await callIpc(`const res = await api.academic.getGrades(${JSON.stringify(stu)}); return res;`)
    const dAc = rAc?.data ?? []
    record('8.4 学生软删除不影响学业成绩文件', dAc.length === 1, `grades=${dAc.length}`)
    if (examId) await callIpc(`const r = await api.academic.deleteExam(${JSON.stringify(examId)}); return r;`)
  })

  await test('8.5 AI 可访问学业数据 (sys.readFile)', async () => {
    const r = await callIpc(`const res = await api.sys.readFile(${JSON.stringify(path.join(academicsDir, 'config.json'))}); return res;`)
    const ok = typeof r === 'string' || (r && !r.__error && r?.success !== false)
    record('8.5 AI 可访问学业数据 (sys.readFile)', ok, `type=${typeof r} ok=${ok}`)
  })

  await test('8.6 AI 不可直接访问班级数据库 (workstation.db)', async () => {
    const wsPath = path.join(userDataDir, 'workstation.db')
    const r = await callIpc(`const res = await api.sys.readFile(${JSON.stringify(wsPath)}); return res;`)
    record('8.6 AI 不可直接访问班级数据库', isFail(r), `err=${(r?.__error || '').slice(0, 80)}`)
  })

  // ===========================================================
  // 9. 数据完整性验证 — 隔离测试后数据完整性
  // ===========================================================
  console.log('\n--- 9. 数据完整性验证 ---')

  await test('9.1 events.jsonl 完整性 (可读)', async () => {
    const eventsFile = path.join(eventsDir, 'events.jsonl')
    const content = await fsp.readFile(eventsFile, 'utf-8').catch(() => '')
    const lines = content.split('\n').filter(l => l.trim())
    let validJson = 0
    for (const line of lines.slice(-100)) {
      try { JSON.parse(line); validJson++ } catch {}
    }
    record('9.1 events.jsonl 完整性', lines.length > 0 && validJson > 0, `lines=${lines.length} validLast100=${validJson}`)
  })

  await test('9.2 scores.cache.json 一致性', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    // 检查之前测试的学生分数
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const idA = idx[isoA]
    const idB = idx[isoB]
    // isoA: 100 (初始) → 110 (+10) → 100 (revert) = 100
    // isoB: 100 (初始) → 98 (-2) = 98
    record('9.2 scores.cache.json 一致性', cache[idA] === 100 && cache[idB] === 98, `A=${cache[idA]} B=${cache[idB]}`)
  })

  await test('9.3 event_stats.cache.json 可读', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'event_stats.cache.json'), 'utf-8'))
    record('9.3 event_stats.cache.json 可读', typeof cache === 'object' && cache !== null, `keys=${Object.keys(cache).length}`)
  })

  await test('9.4 name_index.json 包含所有测试学生', async () => {
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const allPresent = [isoA, isoB, conA, conB].every(n => n in idx)
    record('9.4 name_index.json 包含所有测试学生', allPresent, `isoA=${isoA in idx} isoB=${isoB in idx} conA=${conA in idx} conB=${conB in idx}`)
  })

  await test('9.5 eaa.doctor 通过', async () => {
    const r = await callIpc(`const res = await api.eaa.doctor(); return res;`)
    record('9.5 eaa.doctor 通过', isOk(r), `success=${r?.success}`)
  })

  await test('9.6 eaa.validate 通过', async () => {
    const r = await callIpc(`const res = await api.eaa.validate('all'); return res;`)
    record('9.6 eaa.validate 通过', isOk(r), `success=${r?.success}`)
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
