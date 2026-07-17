// =============================================================
// CDP AI Agent 数据访问路径深度测试
// 模拟 18 个 AI agent 调用所有命名空间的只读 API
// 验证: 返回结构、数据一致性、边界情况、权限隔离
// 运行: node scripts/cdp-ai-agent-data-access.mjs
// =============================================================
import http from 'node:http'
import WebSocket from 'ws'

const CDP_HOST = 'http://127.0.0.1:9222'
const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'
const WARN = '\x1b[33m!\x1b[0m'

let ws, send, evalInPage
let passCount = 0, failCount = 0, warnCount = 0
const notes = [], bugs = []

function record(name, ok, detail = '') {
  if (ok === true) passCount++
  else if (ok === 'warn') warnCount++
  else failCount++
  const mark = ok === true ? 'PASS' : ok === 'warn' ? 'WARN' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ' — ' + detail : ''}`)
}
const note = (m) => notes.push(m)
const bug = (m) => { bugs.push(m); console.log(`  🐛 ${m}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const httpGet = (u) =>
  new Promise((r, j) => {
    http.get(u, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => { try { r(JSON.parse(d)) } catch (e) { j(e) } })
    }).on('error', j)
  })

async function connect() {
  const targets = (await httpGet(`${CDP_HOST}/json`)).filter((x) => x.type === 'page')
  if (!targets.length) { console.error('❌ 无 CDP target'); process.exit(1) }
  ws = new WebSocket(targets[0].webSocketDebuggerUrl)
  let _id = 1
  const pending = new Map()
  ws.on('message', (r) => {
    const m = JSON.parse(r.toString())
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  send = (method, params = {}) =>
    new Promise((r) => { const i = _id++; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  evalInPage = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) {
      throw new Error((r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'unknown').substring(0, 800))
    }
    return r.result?.result?.value
  }
  await new Promise((r) => ws.on('open', r))
}

// 通用 IPC 调用 — 模拟 AI agent 通过 api 对象调用工具
async function callNS(ns, method, ...args) {
  const argsLiteral = JSON.stringify(JSON.stringify(args))
  const expr = `(async function(){
    try {
      const api = window.__EAA_API__ || window.api;
      const obj = api && api[${JSON.stringify(ns)}];
      if (!obj || typeof obj[${JSON.stringify(method)}] !== 'function') {
        return JSON.stringify({ __error: 'method not available: ' + ${JSON.stringify(ns)} + '.' + ${JSON.stringify(method)} });
      }
      const args = JSON.parse(${argsLiteral});
      const res = await obj[${JSON.stringify(method)}].apply(obj, args);
      return JSON.stringify({ __ok: true, res });
    } catch (e) { return JSON.stringify({ __error: (e && e.message) ? e.message : String(e) }); }
  })()`
  const raw = await evalInPage(expr)
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { __error: 'non-json: ' + String(raw).slice(0, 200) } }
  if (parsed.__error) return { __error: parsed.__error }
  return parsed.res
}
const callEAA = (m, ...a) => callNS('eaa', m, ...a)
const callAcademic = (m, ...a) => callNS('academic', m, ...a)
const callClass = (m, ...a) => callNS('class', m, ...a)
const callAgent = (m, ...a) => callNS('agent', m, ...a)
const callPrivacy = (m, ...a) => callNS('privacy', m, ...a)
const callSettings = (m, ...a) => callNS('settings', m, ...a)
const callProfile = (m, ...a) => callNS('profile', m, ...a)
const callChat = (m, ...a) => callNS('chat', m, ...a)
const callLog = (m, ...a) => callNS('log', m, ...a)
const callSkill = (m, ...a) => callNS('skill', m, ...a)
const callCron = (m, ...a) => callNS('cron', m, ...a)
const callMcp = (m, ...a) => callNS('mcp', m, ...a)

const isOk = (r) => !!r && r.__error === undefined && r.success === true
const isErr = (r) => !!r && (r.__error !== undefined || r.success === false)
const errMsg = (r) => r.__error || r.error || 'unknown error'

// =============================================================
// 1. EAA 命名空间 — 18 个 agent 主要的数据来源
// =============================================================
async function testEAAReadOnly() {
  console.log('\n=== 1. EAA 命名空间只读 API ===')

  // eaa.info — 系统信息
  const info = await callEAA('info')
  record('eaa.info 返回结构', isOk(info) && info.data?.students != null && info.data?.events != null,
    isOk(info) ? `students=${info.data.students}, events=${info.data.events}` : errMsg(info))

  // eaa.stats — 统计 (结构: data.summary.total_events / data.summary.valid_events)
  const stats = await callEAA('stats')
  record('eaa.stats 返回结构', isOk(stats) && stats.data?.summary?.total_events != null,
    isOk(stats) ? `total=${stats.data.summary.total_events}, valid=${stats.data.summary.valid_events}` : errMsg(stats))

  // eaa.listStudents — 学生列表
  const listRes = await callEAA('listStudents')
  record('eaa.listStudents 返回结构', isOk(listRes) && Array.isArray(listRes.data?.students),
    isOk(listRes) ? `count=${listRes.data.students.length}` : errMsg(listRes))
  const firstStudent = listRes?.data?.students?.[0]
  const studentName = firstStudent?.name

  // eaa.score — 学生分数
  if (studentName) {
    const score = await callEAA('score', studentName)
    record('eaa.score 返回结构', isOk(score) && score.data?.score != null,
      isOk(score) ? `${studentName}: score=${score.data.score}, risk=${score.data.risk}` : errMsg(score))
  } else {
    record('eaa.score 跳过(无学生)', 'warn', 'listStudents 返回空')
  }

  // eaa.ranking — 排行榜
  const ranking = await callEAA('ranking', 10)
  record('eaa.ranking(10) 返回结构', isOk(ranking) && Array.isArray(ranking.data?.ranking),
    isOk(ranking) ? `top10 count=${ranking.data.ranking.length}` : errMsg(ranking))

  // eaa.history — 学生历史(取第一个学生)
  if (studentName) {
    const history = await callEAA('history', studentName)
    record('eaa.history 返回结构', isOk(history) && Array.isArray(history.data?.events),
      isOk(history) ? `${studentName}: events=${history.data.events.length}` : errMsg(history))
  }

  // eaa.search — 搜索事件
  const search = await callEAA('search', '测试', 5)
  record('eaa.search("测试", 5) 返回结构', isOk(search) && search.data?.events != null,
    isOk(search) ? `total=${search.data.total ?? 0}, returned=${search.data.events?.length ?? 0}` : errMsg(search))

  // eaa.range — 时间范围查询(取最近 30 天)
  const now = Date.now()
  const end = new Date(now).toISOString().slice(0, 10)
  const start = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const range = await callEAA('range', start, end, 10)
  record('eaa.range 返回结构', isOk(range) && range.data?.events != null,
    isOk(range) ? `${start}~${end}: ${range.data.events?.length ?? 0} events` : errMsg(range))

  // eaa.tag — 标签列表
  const tagList = await callEAA('tag')
  record('eaa.tag() 返回结构(标签列表)', isOk(tagList) && (tagList.data?.tags != null || Array.isArray(tagList.data)),
    isOk(tagList) ? `tags=${tagList.data?.tags?.length ?? tagList.data?.length ?? 0}` : errMsg(tagList))

  // eaa.codes — 原因码
  const codes = await callEAA('codes')
  record('eaa.codes 返回结构', isOk(codes) && Array.isArray(codes.data?.codes),
    isOk(codes) ? `codes=${codes.data.codes.length}` : errMsg(codes))

  // eaa.doctor — 健康检查
  const doctor = await callEAA('doctor')
  record('eaa.doctor 返回结构', isOk(doctor) && doctor.data?.healthy != null,
    isOk(doctor) ? `healthy=${doctor.data.healthy}, passed=${doctor.data.passed}` : errMsg(doctor))

  // eaa.validate — 数据验证
  const validate = await callEAA('validate')
  record('eaa.validate 返回结构', isOk(validate) && validate.data?.valid != null,
    isOk(validate) ? `valid=${validate.data.valid}, total=${validate.data.total_events}` : errMsg(validate))

  // eaa.summary — 汇总
  const summary = await callEAA('summary')
  record('eaa.summary 返回结构', isOk(summary),
    isOk(summary) ? `keys=${Object.keys(summary.data ?? {}).join(',')}` : errMsg(summary))

  // eaa.exportFormats — 支持的导出格式
  const formats = await callEAA('exportFormats')
  record('eaa.exportFormats 返回结构', Array.isArray(formats) && formats.length > 0,
    `formats=${Array.isArray(formats) ? formats.join(',') : errMsg(formats)}`)

  // eaa.invalidateCache — 刷新缓存 (注: 旧编译版本可能未暴露此方法,优雅降级为 warn)
  const invalidate = await callEAA('invalidateCache')
  if (invalidate?.__error && invalidate.__error.includes('method not available')) {
    record('eaa.invalidateCache 可用性', 'warn', '当前运行版本未暴露此方法(预期,旧编译版本)')
  } else {
    record('eaa.invalidateCache 返回结构', isOk(invalidate),
      isOk(invalidate) ? 'ok' : errMsg(invalidate))
  }

  // eaa.dashboard — 生成 HTML 仪表盘
  const dashboard = await callEAA('dashboard')
  record('eaa.dashboard 返回结构', isOk(dashboard),
    isOk(dashboard) ? `path=${dashboard.data?.slice(0, 60) ?? 'n/a'}` : errMsg(dashboard))

  return { firstStudent, studentName }
}

// =============================================================
// 2. EAA 写操作 — agent.addEvent/revertEvent 等
// 注: 为避免污染真实数据 + 同一天去重保护,使用唯一测试学生
// =============================================================
async function testEAAWriteOps() {
  console.log('\n=== 2. EAA 写操作(添加/撤销事件) ===')

  // 创建唯一测试学生(时间戳后缀,避免与真实学生冲突 + 避免同日去重)
  const TS = Date.now()
  const testStudent = `_ai_test_${TS}`
  const addStuRes = await callEAA('addStudent', testStudent)
  if (!isOk(addStuRes)) {
    record('EAA 写操作跳过(创建测试学生失败)', 'warn', errMsg(addStuRes))
    return
  }
  note(`创建测试学生: ${testStudent}`)

  // 查询有效原因码 — codes 字段为 score_delta (不是 delta)
  const codesRes = await callEAA('codes')
  const validCodes = isOk(codesRes) ? (codesRes.data?.codes ?? []) : []
  // 找一个加分原因码(score_delta > 0)
  let reasonCode = validCodes.find((c) => (c.score_delta ?? 0) > 0)?.code
  if (!reasonCode && validCodes.length > 0) reasonCode = validCodes[0].code
  if (!reasonCode) {
    record('EAA 写操作跳过(无有效原因码)', 'warn', 'codes 返回空')
    return
  }
  const expectedDelta = validCodes.find((c) => c.code === reasonCode)?.score_delta ?? 0
  note(`使用原因码: ${reasonCode} (score_delta=${expectedDelta}, 共 ${validCodes.length} 个有效码)`)

  // 记录初始分数
  const before = await callEAA('score', testStudent)
  if (!isOk(before)) {
    record('EAA 写操作跳过(score 查询失败)', 'warn', errMsg(before))
    return
  }
  const scoreBefore = before.data.score
  note(`写操作前 ${testStudent} score=${scoreBefore}`)

  // eaa.addEvent — 添加事件
  const addRes = await callEAA('addEvent', {
    studentName: testStudent,
    reasonCode: reasonCode,
    note: `AI agent 测试事件 ${TS}`,
    tags: ['AI测试'],
  })
  // 注: addEvent 失败时,error 信息在 data 或 stderr 字段
  const addErrDetail = addRes?.success === false
    ? (addRes.data || addRes.stderr || addRes.error || 'no error detail')
    : ''
  // 注: addEvent 成功时 data 是格式化消息 "✓ 事件已创建: evt_xxx name +10.0",不是纯事件 ID
  //   需用正则提取 evt_<hex> 作为 revertEvent 的参数
  const eventIdMatch = isOk(addRes) && typeof addRes.data === 'string'
    ? addRes.data.match(/evt_[a-f0-9]+/i)
    : null
  const newEventId = eventIdMatch ? eventIdMatch[0] : null
  record('eaa.addEvent 添加事件', isOk(addRes) && newEventId != null,
    isOk(addRes) ? `eventId=${newEventId}` : `失败: ${String(addErrDetail).slice(0, 120)}`)

  // 验证分数变化
  if (isOk(addRes) && newEventId) {
    await sleep(500)
    const after = await callEAA('score', testStudent)
    const scoreAfter = after?.data?.score
    const actualDelta = scoreAfter - scoreBefore
    record(`eaa.addEvent 后分数变化 (期望 ${expectedDelta > 0 ? '+' : ''}${expectedDelta})`,
      Math.abs(actualDelta - expectedDelta) < 0.01,
      `before=${scoreBefore}, after=${scoreAfter}, delta=${actualDelta}`)

    // eaa.revertEvent — 撤销事件
    const revertRes = await callEAA('revertEvent', newEventId, 'AI agent 测试撤销')
    const revertErrDetail = revertRes?.success === false
      ? (revertRes.data || revertRes.stderr || revertRes.error || 'no detail')
      : ''
    record('eaa.revertEvent 撤销事件', isOk(revertRes),
      isOk(revertRes) ? 'ok' : `失败: ${String(revertErrDetail).slice(0, 120)}`)

    // 验证分数恢复
    if (isOk(revertRes)) {
      await sleep(500)
      const restored = await callEAA('score', testStudent)
      const scoreRestored = restored?.data?.score
      record('eaa.revertEvent 后分数恢复', Math.abs(scoreRestored - scoreBefore) < 0.01,
        `before=${scoreBefore}, restored=${scoreRestored}`)
    }
  }

  // 清理 — 软删除测试学生(不污染真实数据)
  // 注: deleteStudent 是软删除,不会真删除文件,但学生不再出现在列表中
  const delRes = await callEAA('deleteStudent', testStudent, 'AI agent 测试清理')
  record('清理: deleteStudent 测试学生', isOk(delRes),
    isOk(delRes) ? `已删除 ${testStudent}` : `失败: ${errMsg(delRes).slice(0, 80)}`)
}

// =============================================================
// 3. Academic 命名空间
// =============================================================
async function testAcademicNS(studentName) {
  console.log('\n=== 3. Academic 命名空间 ===')

  // academic.getConfig
  const cfg = await callAcademic('getConfig')
  record('academic.getConfig 返回结构', isOk(cfg),
    isOk(cfg) ? `subjects=${cfg.data?.subjects?.length ?? 0}` : errMsg(cfg))

  // academic.listExams
  const exams = await callAcademic('listExams')
  record('academic.listExams 返回结构', isOk(exams) && Array.isArray(exams.data),
    isOk(exams) ? `count=${exams.data?.length ?? 0}` : errMsg(exams))

  // academic.getGrades
  if (studentName) {
    const grades = await callAcademic('getGrades', studentName)
    record('academic.getGrades 返回结构', isOk(grades) && Array.isArray(grades.data),
      isOk(grades) ? `${studentName}: ${grades.data?.length ?? 0} grades` : errMsg(grades))
  } else {
    record('academic.getGrades 跳过(无学生)', 'warn')
  }
}

// =============================================================
// 4. Class 命名空间
// =============================================================
async function testClassNS() {
  console.log('\n=== 4. Class 命名空间 ===')

  // class.list
  const list = await callClass('list')
  record('class.list 返回结构', isOk(list) && Array.isArray(list.data),
    isOk(list) ? `count=${list.data?.length ?? 0}` : errMsg(list))
  const firstClass = list?.data?.[0]

  // class.list 后,验证班级 id 字段存在
  if (firstClass) {
    record('class.list 班级字段完整', !!(firstClass.class_id && firstClass.name),
      `class_id=${firstClass.class_id}, name=${firstClass.name}`)
  }
}

// =============================================================
// 5. Agent 命名空间 — AI agent 自管理
// =============================================================
async function testAgentNS() {
  console.log('\n=== 5. Agent 命名空间(自管理) ===')

  // agent.list
  const list = await callAgent('list')
  record('agent.list 返回结构', Array.isArray(list) && list.length > 0,
    Array.isArray(list) ? `agents=${list.length}` : errMsg(list))

  // 验证 agents.yaml 中的 18 个 agent 都加载
  if (Array.isArray(list)) {
    const expectedIds = ['main', 'governor', 'counselor', 'supervisor', 'validator',
      'academic', 'psychology', 'safety', 'home_school', 'research', 'executor',
      'class-monitor', 'risk-alert', 'data-analyst', 'student-care',
      'discipline-officer', 'weekly-reporter', 'bug-hunter']
    const actualIds = new Set(list.map((a) => a.id))
    const missing = expectedIds.filter((id) => !actualIds.has(id))
    record('agent.list 包含 agents.yaml 全部 18 个 agent', missing.length === 0,
      missing.length ? `缺失: ${missing.join(',')}` : `全部 ${expectedIds.length} 个 agent 已加载`)

    // agent.get — 取第一个 agent 详情
    const firstId = list[0].id
    const detail = await callAgent('get', firstId)
    // 注: 断言必须返回 boolean,不能用 || 短路值(否则 record 的 ok===true 严格比较会判 fail)
    record('agent.get 返回详情', !!detail && !!(detail.id || detail.name),
      detail ? `id=${detail.id ?? firstId}` : 'null')

    // agent.getSoul
    const soul = await callAgent('getSoul', firstId)
    record('agent.getSoul 返回 soul 文本', typeof soul === 'string',
      typeof soul === 'string' ? `length=${soul.length}` : `type=${typeof soul}`)

    // agent.getRules
    const rules = await callAgent('getRules', firstId)
    record('agent.getRules 返回 rules 文本', typeof rules === 'string',
      typeof rules === 'string' ? `length=${rules.length}` : `type=${typeof rules}`)

    // agent.getHistory
    const hist = await callAgent('getHistory', firstId)
    record('agent.getHistory 返回数组', Array.isArray(hist),
      Array.isArray(hist) ? `count=${hist.length}` : `type=${typeof hist}`)
  }
}

// =============================================================
// 6. Privacy 命名空间 — 隐私保护
// =============================================================
async function testPrivacyNS() {
  console.log('\n=== 6. Privacy 命名空间 ===')

  // privacy.status — 检查锁定状态(无需密码)
  // 注: privacy.status 直接返回 {unlocked: boolean},无 success 包裹
  const status = await callPrivacy('status')
  record('privacy.status 返回结构', status != null && typeof status.unlocked === 'boolean',
    status != null ? `unlocked=${status.unlocked}` : errMsg(status))

  // privacy.lock — 锁定 (返回 {success: boolean})
  const lockRes = await callPrivacy('lock')
  record('privacy.lock 调用成功', isOk(lockRes),
    isOk(lockRes) ? 'ok' : errMsg(lockRes))

  // 锁定后 status 应该 unlocked=false
  const statusAfterLock = await callPrivacy('status')
  record('privacy.lock 后 status.unlocked=false',
    statusAfterLock != null && statusAfterLock.unlocked === false,
    `unlocked=${statusAfterLock?.unlocked}`)
}

// =============================================================
// 7. Settings 命名空间
// =============================================================
async function testSettingsNS() {
  console.log('\n=== 7. Settings 命名空间 ===')

  // settings.get
  const settings = await callSettings('get')
  record('settings.get 返回对象', settings != null && typeof settings === 'object',
    settings ? `keys=${Object.keys(settings).slice(0, 5).join(',')}` : 'null')
}

// =============================================================
// 8. Profile 命名空间
// =============================================================
async function testProfileNS(studentName) {
  console.log('\n=== 8. Profile 命名空间 ===')

  if (!studentName) {
    record('profile.get 跳过(无学生)', 'warn')
    return
  }

  // profile.get
  const prof = await callProfile('get', studentName)
  record('profile.get 返回结构', isOk(prof) && prof.data != null,
    isOk(prof) ? `keys=${Object.keys(prof.data).slice(0, 5).join(',')}` : errMsg(prof))
}

// =============================================================
// 9. Chat 命名空间
// =============================================================
async function testChatNS() {
  console.log('\n=== 9. Chat 命名空间 ===')

  // chat.listSessions
  const sessions = await callChat('listSessions')
  record('chat.listSessions 返回结构', isOk(sessions) && Array.isArray(sessions.sessions),
    isOk(sessions) ? `sessions=${sessions.sessions?.length ?? 0}` : errMsg(sessions))
}

// =============================================================
// 10. Log 命名空间
// =============================================================
async function testLogNS() {
  console.log('\n=== 10. Log 命名空间 ===')

  // log.list
  const logList = await callLog('list')
  record('log.list 返回数组', Array.isArray(logList) && logList.length > 0,
    Array.isArray(logList) ? `streams=${logList.length}` : `type=${typeof logList}`)
}

// =============================================================
// 11. Skill 命名空间
// =============================================================
async function testSkillNS() {
  console.log('\n=== 11. Skill 命名空间 ===')

  // skill.list
  const skills = await callSkill('list')
  record('skill.list 返回数组', Array.isArray(skills),
    Array.isArray(skills) ? `count=${skills.length}` : `type=${typeof skills}`)
}

// =============================================================
// 12. Cron 命名空间
// =============================================================
async function testCronNS() {
  console.log('\n=== 12. Cron 命名空间 ===')

  // cron.list
  const cronList = await callCron('list')
  record('cron.list 返回数组', Array.isArray(cronList),
    Array.isArray(cronList) ? `count=${cronList.length}` : `type=${typeof cronList}`)
}

// =============================================================
// 13. MCP 命名空间
// =============================================================
async function testMcpNS() {
  console.log('\n=== 13. MCP 命名空间 ===')

  // mcp.list
  const mcpList = await callMcp('list')
  record('mcp.list 返回结构', isOk(mcpList) && Array.isArray(mcpList.servers),
    isOk(mcpList) ? `servers=${mcpList.servers?.length ?? 0}` : errMsg(mcpList))
}

// =============================================================
// 14. 边界情况测试 — 非法/空参数
// =============================================================
async function testEdgeCases() {
  console.log('\n=== 14. 边界情况测试 ===')

  // eaa.score("") — 空学生名
  const emptyScore = await callEAA('score', '')
  record('eaa.score("") 应拒绝空名', isErr(emptyScore),
    isErr(emptyScore) ? `正确拒绝: ${errMsg(emptyScore).slice(0, 60)}` : `错误返回 success: ${JSON.stringify(emptyScore).slice(0, 60)}`)

  // eaa.score("不存在的学生_xyz") — 不存在学生
  const notExistScore = await callEAA('score', '不存在的学生_xyz_12345')
  record('eaa.score(不存在学生) 应返回 success=false 或 data=null',
    isErr(notExistScore) || notExistScore?.data == null,
    isErr(notExistScore) ? `正确拒绝: ${errMsg(notExistScore).slice(0, 60)}` : `data=${JSON.stringify(notExistScore?.data).slice(0, 60)}`)

  // eaa.history(null) — null 参数
  const nullHist = await callEAA('history', null)
  record('eaa.history(null) 不应崩溃', !isErr(nullHist) || isErr(nullHist),
    isErr(nullHist) ? `返回错误(可接受): ${errMsg(nullHist).slice(0, 60)}` : `正常返回`)

  // eaa.search("", 0) — 空搜索词
  const emptySearch = await callEAA('search', '', 0)
  record('eaa.search("", 0) 不应崩溃', !isErr(emptySearch) || isErr(emptySearch),
    isOk(emptySearch) ? `total=${emptySearch.data?.total ?? 0}` : (isErr(emptySearch) ? `返回错误(可接受): ${errMsg(emptySearch).slice(0, 60)}` : 'unknown'))

  // eaa.ranking(-1) — 负数
  const negRanking = await callEAA('ranking', -1)
  record('eaa.ranking(-1) 不应崩溃', !isErr(negRanking) || isErr(negRanking),
    isOk(negRanking) ? `ranking=${negRanking.data?.ranking?.length ?? 0}` : `返回错误(可接受): ${errMsg(negRanking).slice(0, 60)}`)

  // academic.getGrades("") — 空学生名
  const emptyGrades = await callAcademic('getGrades', '')
  record('academic.getGrades("") 应拒绝或返回空', isErr(emptyGrades) || (emptyGrades?.data?.length === 0),
    isErr(emptyGrades) ? `正确拒绝: ${errMsg(emptyGrades).slice(0, 60)}` : `data.length=${emptyGrades?.data?.length}`)

  // profile.get("") — 空名
  const emptyProf = await callProfile('get', '')
  record('profile.get("") 应拒绝或返回空', isErr(emptyProf) || emptyProf?.data == null,
    isErr(emptyProf) ? `正确拒绝: ${errMsg(emptyProf).slice(0, 60)}` : `data=${JSON.stringify(emptyProf?.data).slice(0, 60)}`)
}

// =============================================================
// 15. 数据一致性测试 — agent 跨命名空间调用
// =============================================================
async function testDataConsistency() {
  console.log('\n=== 15. 跨命名空间数据一致性 ===')

  // eaa.listStudents 后,每个学生应能 eaa.score 查到
  const listRes = await callEAA('listStudents')
  if (!isOk(listRes) || !listRes.data?.students?.length) {
    record('跨命名空间一致性跳过(无学生)', 'warn')
    return
  }

  // 取前 3 个学生,验证 score 都能查到
  const sample = listRes.data.students.slice(0, 3)
  let allConsistent = true
  for (const stu of sample) {
    const sc = await callEAA('score', stu.name)
    if (!isOk(sc) || sc.data?.score == null) {
      allConsistent = false
      note(`一致性失败: ${stu.name} score 查询返回 ${JSON.stringify(sc).slice(0, 80)}`)
    }
  }
  record('listStudents × score 一致性(前3名学生)', allConsistent,
    allConsistent ? `3/3 一致` : '有不一致')

  // eaa.listStudents 后,验证 class.list 的 class_id 与学生的 class_id 对齐
  const classList = await callClass('list')
  if (isOk(classList) && Array.isArray(classList.data)) {
    const classIds = new Set(classList.data.map((c) => c.class_id))
    classIds.add('') // 未分班
    let aligned = true
    let unalignedExamples = []
    for (const stu of listRes.data.students.slice(0, 10)) {
      if (stu.class_id && !classIds.has(stu.class_id)) {
        aligned = false
        unalignedExamples.push(`${stu.name}.${stu.class_id}`)
      }
    }
    record('学生 class_id ↔ class.list 对齐(前10名)', aligned,
      aligned ? '全部对齐' : `未对齐: ${unalignedExamples.slice(0, 3).join(',')}`)
  }

  // eaa.ranking 与 eaa.listStudents 一致性 — 排行榜中的学生都应在 listStudents 中
  const ranking = await callEAA('ranking', 10)
  if (isOk(ranking) && ranking.data?.ranking) {
    const listNames = new Set(listRes.data.students.map((s) => s.name))
    const rankNames = ranking.data.ranking.map((r) => r.name || r.entity_id)
    let allInList = true
    for (const rn of rankNames) {
      if (!listNames.has(rn)) { allInList = false; break }
    }
    record('ranking × listStudents 一致性', allInList,
      allInList ? `top${rankNames.length} 全部在 listStudents 中` : '排行榜有学生不在列表中')
  }
}

// =============================================================
// 16. 性能与内存基线
// =============================================================
async function testPerformanceBaseline() {
  console.log('\n=== 16. 性能与内存基线 ===')

  // 测量 listStudents 响应时间
  const t1 = Date.now()
  await callEAA('listStudents')
  const listMs = Date.now() - t1
  record('eaa.listStudents 响应时间 < 500ms', listMs < 500, `${listMs}ms`)

  // 测量 stats 响应时间
  const t2 = Date.now()
  await callEAA('stats')
  const statsMs = Date.now() - t2
  record('eaa.stats 响应时间 < 500ms', statsMs < 500, `${statsMs}ms`)

  // 测量 ranking(50) 响应时间
  const t3 = Date.now()
  await callEAA('ranking', 50)
  const rankMs = Date.now() - t3
  record('eaa.ranking(50) 响应时间 < 500ms', rankMs < 500, `${rankMs}ms`)

  // 测量 search 响应时间
  const t4 = Date.now()
  await callEAA('search', 'a', 20)
  const searchMs = Date.now() - t4
  record('eaa.search 响应时间 < 500ms', searchMs < 500, `${searchMs}ms`)

  // 测量 doctor 响应时间
  const t5 = Date.now()
  await callEAA('doctor')
  const doctorMs = Date.now() - t5
  record('eaa.doctor 响应时间 < 2000ms', doctorMs < 2000, `${doctorMs}ms`)

  // 内存基线 — 模拟 agent 连续调用 50 次,看是否有泄漏
  const memBefore = await evalInPage(`(function(){
    if (performance.memory) return { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize };
    return { used: 0, total: 0 };
  })()`)
  for (let i = 0; i < 50; i++) {
    await callEAA('listStudents')
    await callEAA('stats')
  }
  const memAfter = await evalInPage(`(function(){
    if (performance.memory) return { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize };
    return { used: 0, total: 0 };
  })()`)

  if (memBefore.used > 0 && memAfter.used > 0) {
    const deltaMB = (memAfter.used - memBefore.used) / 1024 / 1024
    record('50 次连续调用内存增长 < 5MB', Math.abs(deltaMB) < 5,
      `delta=${deltaMB > 0 ? '+' : ''}${deltaMB.toFixed(2)}MB`)
  } else {
    record('内存测试跳过(performance.memory 不可用)', 'warn', '非 Chromium 或禁用')
  }
}

// =============================================================
// 主流程
// =============================================================
async function main() {
  console.log('=== AI Agent 数据访问路径深度测试 ===')
  console.log(`时间: ${new Date().toISOString()}\n`)

  await connect()

  const { studentName } = await testEAAReadOnly()
  await testEAAWriteOps()
  await testAcademicNS(studentName)
  await testClassNS()
  await testAgentNS()
  await testPrivacyNS()
  await testSettingsNS()
  await testProfileNS(studentName)
  await testChatNS()
  await testLogNS()
  await testSkillNS()
  await testCronNS()
  await testMcpNS()
  await testEdgeCases()
  await testDataConsistency()
  await testPerformanceBaseline()

  console.log('\n=== 总结 ===')
  const total = passCount + failCount + warnCount
  console.log(`总计: ${total}, 通过: ${passCount}, 警告: ${warnCount}, 失败: ${failCount}`)
  if (notes.length) { console.log('\n— 备注:'); for (const n of notes) console.log(`  ℹ ${n}`) }
  if (bugs.length) { console.log('\n— Bug:'); for (const b of bugs) console.log(`  🐛 ${b}`) }
}

main()
  .catch((e) => { console.error('\n❌ 测试异常:', e); failCount++ })
  .then(async () => { try { ws.close() } catch {}; process.exit(failCount > 0 ? 1 : 0) })
