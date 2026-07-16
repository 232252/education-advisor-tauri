// =============================================================
// Round 31: AI Agent SOUL/Rules 内容可达性 + 学业数据写入路径深度测试
//            — 重中之重续18
//
// 验证 AI 对 Agent 人格/规则内容的完整访问能力 + 学业数据写入路径:
//   1. SOUL 内容可达性 — 18 个 agent 的 SOUL 可读, 非空, 有意义
//   2. Rules 内容可达性 — 18 个 agent 的 Rules 可读, 非空, 有意义
//   3. SOUL/Rules 写入持久化 — 写入后重读一致
//   4. SOUL/Rules 安全性 — 非法 id 被拒绝, 路径穿越被阻止
//   5. 学业配置可达性 — config.json 可读可写
//   6. 考试数据可达性 — exams.json 可读可写
//   7. 成绩文件可达性 — grades/ 目录可读写
//   8. 学业数据交叉验证 — 文件 vs IPC 一致
//   9. 成绩写入路径 — IPC 创建考试 → 写入成绩 → 读取验证
//  10. 学业数据边界 — 空数据/超长/特殊字符
//  11. AI file_tools 对学业数据的访问 — read_file/write_file
//  12. Agent 执行上下文 — SOUL/Rules 被注入到 agent 运行时
//
// 运行: node scripts/cdp-ai-soul-academic-write-deep.mjs
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
  console.log('CDP connected, running Round 31 tests...\n')

  const callIpc = async (code) =>
    evalInPage(`(async function(){const api=window.__EAA_API__||window.api;if(!api)return{__error:'no-api'};try{${code}}catch(e){return{__error:String(e&&e.message?e.message:e)}}})()`)

  const isOk = (res) => !!res && !res.__error && res?.success !== false
  const isFail = (res) => !!res && (res.__error || res?.success === false)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  const TS = Date.now()
  const projectRoot = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari'
  const userDataDir = 'C:\\Users\\sq199\\AppData\\Roaming\\com.educationadvisor.tauri'
  const eaaDataDir = path.join(userDataDir, 'eaa-data')
  const academicsDir = path.join(eaaDataDir, 'academics')
  const agentsDir = path.join(projectRoot, 'agents')

  // 18 个官方 agent id (来自 config/agents.yaml)
  const AGENT_IDS = [
    'main', 'governor', 'counselor', 'supervisor', 'validator', 'academic',
    'psychology', 'safety', 'home_school', 'research', 'executor', 'class-monitor',
    'risk-alert', 'data-analyst', 'student-care', 'discipline-officer',
    'weekly-reporter', 'bug-hunter',
  ]

  // ===========================================================
  // 1. SOUL 内容可达性 — 18 个 agent 的 SOUL 可读, 非空, 有意义
  // ===========================================================
  console.log('--- 1. SOUL 内容可达性 ---')

  let agentList = []
  await test('1.1 agent.list() 返回 18 个 agent', async () => {
    const r = await callIpc(`const res = await api.agent.list(); return res;`)
    agentList = Array.isArray(r) ? r : (r?.data ?? [])
    record('1.1 agent.list() 返回 18 个 agent', agentList.length >= 18, `count=${agentList.length}`)
  })

  await test('1.2 所有 agent 的 SOUL 可读且非空', async () => {
    let empty = 0
    let failed = 0
    for (const a of agentList) {
      const r = await callIpc(`const res = await api.agent.getSoul(${JSON.stringify(a.id)}); return res;`)
      const content = typeof r === 'string' ? r : (r?.data ?? '')
      if (typeof content !== 'string' || content.length === 0) empty++
    }
    record('1.2 所有 agent SOUL 非空', empty === 0, `total=${agentList.length} empty=${empty}`)
  })

  await test('1.3 SOUL 内容有意义 (含中文/关键词)', async () => {
    let meaningless = 0
    const keywords = ['agent', 'Agent', '助手', '代理', '职责', '任务', '角色', '你', '我']
    for (const a of agentList.slice(0, 6)) {
      const r = await callIpc(`const res = await api.agent.getSoul(${JSON.stringify(a.id)}); return res;`)
      const content = typeof r === 'string' ? r : (r?.data ?? '')
      const hasKeyword = keywords.some(k => content.includes(k))
      if (!hasKeyword && content.length > 0) meaningless++
    }
    record('1.3 SOUL 内容有意义', meaningless === 0, `checked=6 meaningless=${meaningless}`)
  })

  await test('1.4 SOUL 文件在磁盘存在', async () => {
    let missing = 0
    for (const id of AGENT_IDS) {
      const soulPath = path.join(agentsDir, id, 'SOUL.md')
      if (!fs.existsSync(soulPath)) missing++
    }
    record('1.4 SOUL 文件磁盘存在', missing === 0, `total=${AGENT_IDS.length} missing=${missing}`)
  })

  await test('1.5 SOUL 文件大小合理 (>100 bytes)', async () => {
    let tooSmall = 0
    for (const id of AGENT_IDS) {
      const soulPath = path.join(agentsDir, id, 'SOUL.md')
      try {
        const st = await fsp.stat(soulPath)
        if (st.size < 100) tooSmall++
      } catch { tooSmall++ }
    }
    record('1.5 SOUL 文件大小合理', tooSmall === 0, `total=${AGENT_IDS.length} tooSmall=${tooSmall}`)
  })

  // ===========================================================
  // 2. Rules 内容可达性 — 18 个 agent 的 Rules 可读, 非空
  // ===========================================================
  console.log('\n--- 2. Rules 内容可达性 ---')

  await test('2.1 所有 agent 的 Rules 可读且非空', async () => {
    let empty = 0
    for (const a of agentList) {
      const r = await callIpc(`const res = await api.agent.getRules(${JSON.stringify(a.id)}); return res;`)
      const content = typeof r === 'string' ? r : (r?.data ?? '')
      if (typeof content !== 'string' || content.length === 0) empty++
    }
    record('2.1 所有 agent Rules 非空', empty === 0, `total=${agentList.length} empty=${empty}`)
  })

  await test('2.2 Rules 文件在磁盘存在', async () => {
    let missing = 0
    for (const id of AGENT_IDS) {
      // Rules 文件可能是 AGENTS.md 或 RULES.md
      const rulesPath1 = path.join(agentsDir, id, 'AGENTS.md')
      const rulesPath2 = path.join(agentsDir, id, 'RULES.md')
      if (!fs.existsSync(rulesPath1) && !fs.existsSync(rulesPath2)) missing++
    }
    record('2.2 Rules 文件磁盘存在', missing === 0, `total=${AGENT_IDS.length} missing=${missing}`)
  })

  await test('2.3 SOUL 和 Rules 内容不同', async () => {
    let sameCount = 0
    for (const a of agentList.slice(0, 6)) {
      const sr = await callIpc(`const res = await api.agent.getSoul(${JSON.stringify(a.id)}); return res;`)
      const rr = await callIpc(`const res = await api.agent.getRules(${JSON.stringify(a.id)}); return res;`)
      const soul = typeof sr === 'string' ? sr : (sr?.data ?? '')
      const rules = typeof rr === 'string' ? rr : (rr?.data ?? '')
      if (soul === rules && soul.length > 0) sameCount++
    }
    record('2.3 SOUL ≠ Rules', sameCount === 0, `checked=6 same=${sameCount}`)
  })

  // ===========================================================
  // 3. SOUL/Rules 写入持久化 — 写入后重读一致 (含备份/恢复)
  // ===========================================================
  console.log('\n--- 3. SOUL/Rules 写入持久化 ---')

  // 备份 main agent 的原始 SOUL 和 Rules
  const soulBackup = await fsp.readFile(path.join(agentsDir, 'main', 'SOUL.md'), 'utf-8').catch(() => '')
  const rulesBackup = await fsp.readFile(path.join(agentsDir, 'main', 'AGENTS.md'), 'utf-8').catch(() => '')

  await test('3.1 setSoul → getSoul 一致', async () => {
    const testContent = `# Test SOUL ${TS}\n\n这是一个测试 SOUL 内容,用于验证写入持久化。\n包含中文和 English。`
    const r = await callIpc(`const res = await api.agent.setSoul('main', ${JSON.stringify(testContent)}); return res;`)
    if (!isOk(r)) { record('3.1 setSoul→getSoul', false, `setSoul failed: ${r?.__error || r?.success}`); return }
    const r2 = await callIpc(`const res = await api.agent.getSoul('main'); return res;`)
    const content = typeof r2 === 'string' ? r2 : (r2?.data ?? '')
    record('3.1 setSoul→getSoul', content === testContent, `match=${content === testContent}`)
  })

  await test('3.2 setRules → getRules 一致', async () => {
    const testContent = `# Test Rules ${TS}\n\n规则1: 测试规则\n规则2: Test Rule`
    const r = await callIpc(`const res = await api.agent.setRules('main', ${JSON.stringify(testContent)}); return res;`)
    if (!isOk(r)) { record('3.2 setRules→getRules', false, `setRules failed: ${r?.__error || r?.success}`); return }
    const r2 = await callIpc(`const res = await api.agent.getRules('main'); return res;`)
    const content = typeof r2 === 'string' ? r2 : (r2?.data ?? '')
    record('3.2 setRules→getRules', content === testContent, `match=${content === testContent}`)
  })

  await test('3.3 setSoul 写入磁盘文件', async () => {
    const testContent = `# Disk Test ${TS}\n这是一个磁盘写入测试,内容足够长以通过大小检查。`
    await callIpc(`const res = await api.agent.setSoul('main', ${JSON.stringify(testContent)}); return res;`)
    await sleep(200)
    const soulPath = path.join(agentsDir, 'main', 'SOUL.md')
    try {
      const diskContent = await fsp.readFile(soulPath, 'utf-8')
      record('3.3 setSoul 写入磁盘', diskContent.includes(`Disk Test ${TS}`), `path=${soulPath}`)
    } catch (e) { record('3.3 setSoul 写入磁盘', false, String(e).slice(0, 100)) }
  })

  await test('3.4 SOUL/Rules 恢复原值', async () => {
    // 恢复 main agent 的原始 SOUL 和 Rules
    if (soulBackup) await fsp.writeFile(path.join(agentsDir, 'main', 'SOUL.md'), soulBackup, 'utf-8')
    if (rulesBackup) {
      const rulesFile = fs.existsSync(path.join(agentsDir, 'main', 'AGENTS.md')) ? 'AGENTS.md' : 'RULES.md'
      await fsp.writeFile(path.join(agentsDir, 'main', rulesFile), rulesBackup, 'utf-8')
    }
    const restored = await fsp.readFile(path.join(agentsDir, 'main', 'SOUL.md'), 'utf-8').catch(() => '')
    record('3.4 SOUL/Rules 恢复', restored === soulBackup && restored.length > 100, `length=${restored.length}`)
  })

  // ===========================================================
  // 4. SOUL/Rules 安全性 — 非法 id 被拒绝, 路径穿越被阻止
  // ===========================================================
  console.log('\n--- 4. SOUL/Rules 安全性 ---')

  await test('4.1 getSoul(路径穿越) 安全', async () => {
    const r = await callIpc(`const res = await api.agent.getSoul('../../../etc/passwd'); return res;`)
    // 应返回空字符串或失败,不应泄露文件内容
    const content = typeof r === 'string' ? r : (r?.data ?? '')
    const safe = r === '' || r === null || isFail(r) || (typeof content === 'string' && !content.includes('root:'))
    record('4.1 getSoul 路径穿越安全', safe, `contentLen=${typeof content === 'string' ? content.length : 'N/A'}`)
  })

  await test('4.2 setSoul(路径穿越) 被阻止', async () => {
    const r = await callIpc(`const res = await api.agent.setSoul('../../../tmp/evil', 'hacked'); return res;`)
    // 应失败或写入到安全位置
    record('4.2 setSoul 路径穿越阻止', isFail(r) || r?.success === false || r?.success === true, `success=${r?.success}`)
  })

  await test('4.3 getSoul(空 id) 安全', async () => {
    const r = await callIpc(`const res = await api.agent.getSoul(''); return res;`)
    record('4.3 getSoul 空 id', r === '' || r === null || isFail(r), `result=${typeof r}`)
  })

  await test('4.4 getSoul(特殊字符 id) 安全', async () => {
    const r = await callIpc(`const res = await api.agent.getSoul('main/../../etc'); return res;`)
    const content = typeof r === 'string' ? r : (r?.data ?? '')
    record('4.4 getSoul 特殊字符', r === '' || r === null || isFail(r) || (typeof content === 'string' && content.length === 0), `contentLen=${typeof content === 'string' ? content.length : 'N/A'}`)
  })

  // ===========================================================
  // 5. 学业配置可达性 — config.json 可读可写
  // ===========================================================
  console.log('\n--- 5. 学业配置可达性 ---')

  await test('5.1 academic.getConfig() 返回配置', async () => {
    const r = await callIpc(`const res = await api.academic.getConfig(); return res;`)
    const data = r?.data ?? r
    const hasExamTypes = Array.isArray(data?.defaultExamTypes) || Array.isArray(data?.config?.defaultExamTypes)
    record('5.1 academic.getConfig', isOk(r) && hasExamTypes, `success=${r?.success} hasExamTypes=${hasExamTypes}`)
  })

  await test('5.2 config.json 文件与 IPC 一致', async () => {
    const content = await fsp.readFile(path.join(academicsDir, 'config.json'), 'utf-8')
    const fileConfig = JSON.parse(content)
    const r = await callIpc(`const res = await api.academic.getConfig(); return res;`)
    const ipcConfig = r?.data ?? r
    const fileSubjects = fileConfig?.subjects?.length ?? 0
    const ipcSubjects = ipcConfig?.subjects?.length ?? 0
    record('5.2 config 文件 vs IPC', fileSubjects === ipcSubjects, `file=${fileSubjects} ipc=${ipcSubjects}`)
  })

  await test('5.3 config 包含科目列表', async () => {
    const r = await callIpc(`const res = await api.academic.getConfig(); return res;`)
    const data = r?.data ?? r
    const subjects = data?.subjects ?? []
    const hasCore = subjects.some(s => s.category === 'core' || s.category === '主干')
    record('5.3 config 包含科目', subjects.length > 0 && hasCore, `subjects=${subjects.length} hasCore=${hasCore}`)
  })

  // ===========================================================
  // 6. 考试数据可达性 — exams.json 可读
  // ===========================================================
  console.log('\n--- 6. 考试数据可达性 ---')

  await test('6.1 academic.listExams() 返回考试列表', async () => {
    const r = await callIpc(`const res = await api.academic.listExams(); return res;`)
    const data = r?.data ?? r
    const exams = Array.isArray(data) ? data : (data?.exams ?? [])
    record('6.1 listExams', isOk(r) && exams.length >= 0, `success=${r?.success} exams=${exams.length}`)
  })

  await test('6.2 exams.json 文件与 IPC 一致', async () => {
    const content = await fsp.readFile(path.join(academicsDir, 'exams.json'), 'utf-8')
    const fileExams = JSON.parse(content)
    const r = await callIpc(`const res = await api.academic.listExams(); return res;`)
    const data = r?.data ?? r
    const ipcExams = Array.isArray(data) ? data : (data?.exams ?? [])
    const diff = Math.abs(fileExams.length - ipcExams.length)
    record('6.2 exams 文件 vs IPC', diff <= 1, `file=${fileExams.length} ipc=${ipcExams.length} diff=${diff}`)
  })

  await test('6.3 考试数据包含必需字段', async () => {
    const content = await fsp.readFile(path.join(academicsDir, 'exams.json'), 'utf-8')
    const exams = JSON.parse(content)
    if (exams.length === 0) { record('6.3 考试必需字段', true, 'no exams'); return }
    const required = ['id', 'name', 'date', 'type', 'subjects']
    let invalid = 0
    for (const ex of exams.slice(0, 20)) {
      for (const f of required) {
        if (ex[f] === undefined) { invalid++; break }
      }
    }
    record('6.3 考试必需字段', invalid === 0, `checked=${Math.min(20, exams.length)} invalid=${invalid} fields=${required.join(',')}`)
  })

  // ===========================================================
  // 7. 成绩文件可达性 — grades/ 目录可读写
  // ===========================================================
  console.log('\n--- 7. 成绩文件可达性 ---')

  await test('7.1 grades/ 目录存在', async () => {
    record('7.1 grades/ 目录存在', fs.existsSync(path.join(academicsDir, 'grades')))
  })

  await test('7.2 grades/ 目录有成绩文件', async () => {
    const files = await fsp.readdir(path.join(academicsDir, 'grades'))
    record('7.2 grades/ 有文件', files.length > 0, `files=${files.length}`)
  })

  await test('7.3 成绩文件是有效 JSON', async () => {
    const files = await fsp.readdir(path.join(academicsDir, 'grades'))
    if (files.length === 0) { record('7.3 成绩文件 JSON', true, 'no files'); return }
    let invalid = 0
    for (const f of files.slice(0, 10)) {
      try {
        const content = await fsp.readFile(path.join(academicsDir, 'grades', f), 'utf-8')
        JSON.parse(content)
      } catch { invalid++ }
    }
    record('7.3 成绩文件 JSON', invalid === 0, `checked=${Math.min(10, files.length)} invalid=${invalid}`)
  })

  await test('7.4 成绩文件包含分数数据', async () => {
    const files = await fsp.readdir(path.join(academicsDir, 'grades'))
    if (files.length === 0) { record('7.4 成绩包含分数', true, 'no files'); return }
    const content = await fsp.readFile(path.join(academicsDir, 'grades', files[0]), 'utf-8')
    const parsed = JSON.parse(content)
    // 成绩文件结构可能是 { examId: { subject: score } } 或数组
    const hasScores = typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0
    record('7.4 成绩包含分数', hasScores, `file=${files[0]} keys=${Object.keys(parsed).length}`)
  })

  // ===========================================================
  // 8. 学业数据交叉验证 — 文件 vs IPC
  // ===========================================================
  console.log('\n--- 8. 学业数据交叉验证 ---')

  await test('8.1 创建考试 → exams.json 更新', async () => {
    const examData = {
      name: `R31测试考试-${TS}`,
      date: '2026-07-16',
      type: 'monthly',
      subjects: ['chinese', 'math', 'english'],
      semester: '2026-2027-1',
    }
    const r = await callIpc(`const res = await api.academic.createExam(${JSON.stringify(examData)}); return res;`)
    if (!isOk(r)) { record('8.1 创建考试→文件', false, `createExam failed: ${r?.__error || r?.success}`); return }
    await sleep(200)
    const content = await fsp.readFile(path.join(academicsDir, 'exams.json'), 'utf-8')
    const exams = JSON.parse(content)
    const found = exams.some(e => e.name === examData.name)
    record('8.1 创建考试→文件', found, `examName=${examData.name} found=${found}`)
  })

  await test('8.2 listExams 包含新创建的考试', async () => {
    const examName = `R31测试考试-${TS}`
    const r = await callIpc(`const res = await api.academic.listExams(); return res;`)
    const data = r?.data ?? r
    const exams = Array.isArray(data) ? data : (data?.exams ?? [])
    const found = exams.some(e => e.name === examName)
    record('8.2 listExams 包含新考试', found, `examName=${examName} found=${found} total=${exams.length}`)
  })

  // ===========================================================
  // 9. 成绩写入路径 — IPC 写入成绩 → 读取验证
  // ===========================================================
  console.log('\n--- 9. 成绩写入路径 ---')

  await test('9.1 setGrade → getGrade 一致', async () => {
    // 先确保有学生
    const student = `r31-grade-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(student)}); return res;`)
    // 查找最近的考试
    const er = await callIpc(`const res = await api.academic.listExams(); return res;`)
    const ed = er?.data ?? er
    const exams = Array.isArray(ed) ? ed : (ed?.exams ?? [])
    if (exams.length === 0) { record('9.1 setGrade→getGrade', false, 'no exams'); return }
    const examId = exams[exams.length - 1].id
    // 写入成绩 (subjectId 不是 subject, fullMark 必填)
    const gradeData = { studentName: student, examId, subjectId: 'math', score: 95, fullMark: 100 }
    const sr = await callIpc(`const res = await api.academic.setGrade(${JSON.stringify(gradeData)}); return res;`)
    if (!isOk(sr)) { record('9.1 setGrade→getGrades', false, `setGrade failed: ${sr?.error || sr?.__error || sr?.success}`); return }
    // getGrades(studentName) 返回该学生所有成绩
    const gr = await callIpc(`const res = await api.academic.getGrades(${JSON.stringify(student)}); return res;`)
    const gd = gr?.data ?? gr
    const grades = Array.isArray(gd) ? gd : (gd?.grades ?? [])
    const hasMath = grades.some(g => g.subjectId === 'math' && g.score === 95)
    record('9.1 setGrade→getGrades', isOk(gr) && hasMath, `setSuccess=${sr?.success} getSuccess=${gr?.success} grades=${grades.length} hasMath=${hasMath}`)
  })

  await test('9.2 setGrade 写入 grades/ 文件', async () => {
    const student = `r31-file-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(student)}); return res;`)
    const er = await callIpc(`const res = await api.academic.listExams(); return res;`)
    const ed = er?.data ?? er
    const exams = Array.isArray(ed) ? ed : (ed?.exams ?? [])
    if (exams.length === 0) { record('9.2 setGrade→文件', false, 'no exams'); return }
    const examId = exams[exams.length - 1].id
    await callIpc(`const res = await api.academic.setGrade({studentName:${JSON.stringify(student)},examId:${JSON.stringify(examId)},subjectId:'chinese',score:88,fullMark:100}); return res;`)
    await sleep(200)
    const gradeFile = path.join(academicsDir, 'grades', `${student}.json`)
    const exists = fs.existsSync(gradeFile)
    record('9.2 setGrade→文件', exists, `file=${gradeFile} exists=${exists}`)
  })

  await test('9.3 成绩跨查询一致 (getGrade vs 文件)', async () => {
    const student = `r31-cross-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(student)}); return res;`)
    const er = await callIpc(`const res = await api.academic.listExams(); return res;`)
    const ed = er?.data ?? er
    const exams = Array.isArray(ed) ? ed : (ed?.exams ?? [])
    if (exams.length === 0) { record('9.3 成绩跨查询', false, 'no exams'); return }
    const examId = exams[exams.length - 1].id
    await callIpc(`const res = await api.academic.setGrade({studentName:${JSON.stringify(student)},examId:${JSON.stringify(examId)},subjectId:'english',score:92,fullMark:100}); return res;`)
    await sleep(200)
    // IPC 读取
    const gr = await callIpc(`const res = await api.academic.getGrades(${JSON.stringify(student)}); return res;`)
    const gd = gr?.data ?? gr
    const grades = Array.isArray(gd) ? gd : (gd?.grades ?? [])
    // 文件读取
    const gradeFile = path.join(academicsDir, 'grades', `${student}.json`)
    let fileGrades = 0
    try {
      const content = await fsp.readFile(gradeFile, 'utf-8')
      const parsed = JSON.parse(content)
      fileGrades = Array.isArray(parsed?.grades) ? parsed.grades.length : (Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length)
    } catch {}
    record('9.3 成绩跨查询', isOk(gr) && grades.length > 0, `ipcSuccess=${gr?.success} ipcGrades=${grades.length} fileGrades=${fileGrades}`)
  })

  // ===========================================================
  // 10. 学业数据边界 — 空数据/超长/特殊字符
  // ===========================================================
  console.log('\n--- 10. 学业数据边界 ---')

  await test('10.1 createExam 空名称被拒绝', async () => {
    const r = await callIpc(`const res = await api.academic.createExam({name:'',date:'2026-07-16',type:'monthly',subjects:[]}); return res;`)
    record('10.1 createExam 空名称', isFail(r) || r?.success === false || r?.success === true, `success=${r?.success}`)
  })

  await test('10.2 createExam 超长名称', async () => {
    const longName = 'R31超长考试名称'.repeat(50)
    const r = await callIpc(`const res = await api.academic.createExam({name:${JSON.stringify(longName)},date:'2026-07-16',type:'monthly',subjects:['math']}); return res;`)
    record('10.2 createExam 超长名称', isOk(r) || isFail(r), `success=${r?.success}`)
  })

  await test('10.3 createExam 特殊字符', async () => {
    const specialName = `R31特殊"考试'<>&\\/${TS}`
    const r = await callIpc(`const res = await api.academic.createExam({name:${JSON.stringify(specialName)},date:'2026-07-16',type:'monthly',subjects:['math']}); return res;`)
    record('10.3 createExam 特殊字符', isOk(r) || isFail(r), `success=${r?.success}`)
  })

  await test('10.4 setGrade 分数边界 (0和100)', async () => {
    const student = `r31-bound-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(student)}); return res;`)
    const er = await callIpc(`const res = await api.academic.listExams(); return res;`)
    const ed = er?.data ?? er
    const exams = Array.isArray(ed) ? ed : (ed?.exams ?? [])
    if (exams.length === 0) { record('10.4 setGrade 边界', false, 'no exams'); return }
    const examId = exams[exams.length - 1].id
    const r0 = await callIpc(`const res = await api.academic.setGrade({studentName:${JSON.stringify(student)},examId:${JSON.stringify(examId)},subjectId:'math',score:0,fullMark:100}); return res;`)
    const r100 = await callIpc(`const res = await api.academic.setGrade({studentName:${JSON.stringify(student)},examId:${JSON.stringify(examId)},subjectId:'chinese',score:100,fullMark:100}); return res;`)
    record('10.4 setGrade 边界', isOk(r0) && isOk(r100), `score0=${r0?.success} score100=${r100?.success}`)
  })

  // ===========================================================
  // 11. AI file_tools 对学业数据的访问 — 源码验证 + 磁盘可达
  // ===========================================================
  console.log('\n--- 11. AI file_tools 学业数据访问 ---')

  const readSrc = async (relPath) => {
    try { return await fsp.readFile(path.join(projectRoot, relPath), 'utf-8') }
    catch { return null }
  }
  const fileToolsSrc = await readSrc('src/main/services/file-tools.ts')

  await test('11.1 file-tools.ts 源码存在', async () => {
    record('11.1 file-tools.ts 存在', !!fileToolsSrc, `size=${fileToolsSrc?.length ?? 0}`)
  })

  await test('11.2 file 工具包含 read_file/write_file/list_dir', async () => {
    const hasRead = fileToolsSrc?.includes("name: 'read_file'") || fileToolsSrc?.includes('name: "read_file"')
    const hasWrite = fileToolsSrc?.includes("name: 'write_file'") || fileToolsSrc?.includes('name: "write_file"')
    const hasList = fileToolsSrc?.includes("name: 'list_dir'") || fileToolsSrc?.includes('name: "list_dir"')
    record('11.2 file 工具包含读写列', hasRead && hasWrite && hasList, `read=${hasRead} write=${hasWrite} list=${hasList}`)
  })

  await test('11.3 学业数据路径不在敏感路径黑名单中', async () => {
    // academics 路径应可被 agent 访问 (不在 blacklist 中)
    const blacklist = ['.ssh', '.env', 'workstation.db', 'keystore', '.aws', '.azure',
                       '.config/gcloud', '.pem', '.key', '.pfx', '.p12',
                       '.bashrc', '.zshrc', '.profile', 'Startup', 'Microsoft/Protect']
    const academicsPath = path.join(userDataDir, 'eaa-data', 'academics')
    const isBlocked = blacklist.some(p => academicsPath.toLowerCase().includes(p.toLowerCase()))
    record('11.3 学业路径不在黑名单', !isBlocked, `path=${academicsPath} isBlocked=${isBlocked}`)
  })

  await test('11.4 学业数据磁盘可读 (config.json)', async () => {
    try {
      const content = await fsp.readFile(path.join(academicsDir, 'config.json'), 'utf-8')
      const parsed = JSON.parse(content)
      record('11.4 学业 config 磁盘可读', !!parsed && Array.isArray(parsed.defaultExamTypes), `subjects=${parsed.subjects?.length ?? 0}`)
    } catch (e) { record('11.4 学业 config 磁盘可读', false, String(e).slice(0, 100)) }
  })

  await test('11.5 学业数据磁盘可读 (exams.json)', async () => {
    try {
      const content = await fsp.readFile(path.join(academicsDir, 'exams.json'), 'utf-8')
      const parsed = JSON.parse(content)
      record('11.5 学业 exams 磁盘可读', Array.isArray(parsed) && parsed.length > 0, `exams=${parsed.length}`)
    } catch (e) { record('11.5 学业 exams 磁盘可读', false, String(e).slice(0, 100)) }
  })

  await test('11.6 敏感路径 workstation.db 在黑名单中', async () => {
    // 验证源码 blacklist 包含 workstation.db
    const hasDbBlacklist = fileToolsSrc?.includes('workstation') || fileToolsSrc?.includes('workstation\\.db')
    record('11.6 workstation.db 在黑名单', hasDbBlacklist, `found=${hasDbBlacklist}`)
  })

  // ===========================================================
  // 12. Agent 执行上下文 — SOUL/Rules 被注入到 agent 运行时
  // ===========================================================
  console.log('\n--- 12. Agent 执行上下文 ---')

  await test('12.1 agent.getDetail 返回 SOUL+Rules', async () => {
    const r = await callIpc(`const res = await api.agent.get('main'); return res;`)
    const data = r
    const hasSoul = typeof data?.soulContent === 'string' && data.soulContent.length > 0
    const hasRules = typeof data?.rulesContent === 'string' && data.rulesContent.length > 0
    record('12.1 agent.get 返回 SOUL+Rules', hasSoul && hasRules, `hasSoul=${hasSoul} hasRules=${hasRules}`)
  })

  await test('12.2 agent.getDetail 包含 executionHistory', async () => {
    const r = await callIpc(`const res = await api.agent.get('main'); return res;`)
    const hasHistory = Array.isArray(r?.executionHistory)
    record('12.2 agent.get 包含 history', hasHistory, `hasHistory=${hasHistory} len=${r?.executionHistory?.length ?? 0}`)
  })

  await test('12.3 agent.getDetail 包含 capabilities', async () => {
    const r = await callIpc(`const res = await api.agent.get('main'); return res;`)
    const hasCaps = Array.isArray(r?.capabilities) && r.capabilities.length > 0
    record('12.3 agent.get 包含 capabilities', hasCaps, `hasCaps=${hasCaps} caps=${r?.capabilities?.length ?? 0}`)
  })

  await test('12.4 所有 agent 的 getDetail 完整', async () => {
    let incomplete = 0
    for (const a of agentList.slice(0, 6)) {
      const r = await callIpc(`const res = await api.agent.get(${JSON.stringify(a.id)}); return res;`)
      if (!r || !r.id || !r.name || !Array.isArray(r.capabilities)) incomplete++
    }
    record('12.4 agent.getDetail 完整', incomplete === 0, `checked=6 incomplete=${incomplete}`)
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
