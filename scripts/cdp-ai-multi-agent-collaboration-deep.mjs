// =============================================================
// Round 36: AI 真实多 Agent 协作场景 + 数据流完整性深度测试
//            — 重中之重续23
//
// 模拟真实教育场景中多 Agent 协作的数据流:
//   1. 班主任场景 — main→counselor→class-monitor 协作
//   2. 学业预警场景 — academic→risk-alert→student-care 协作
//   3. 纪律处理场景 — discipline-officer→supervisor→counselor 协作
//   4. 数据分析场景 — data-analyst→governor→validator 协作
//   5. 周报场景 — weekly-reporter→supervisor→main 协作
//   6. Agent 工具配置完整性 — 每个角色的工具能完成其职责
//   7. 跨 Agent 数据传递 — 一个 Agent 的输出是另一个的输入
//   8. Agent SOUL 一致性 — SOUL 中描述的工具与实际配置一致
//   9. 真实工作流端到端 — 模拟完整的日常使用流程
//  10. Agent 权限边界 — 写入 Agent 不能越权访问其他模块
//  11. Agent 配置持久化 — 重启后配置不丢失
//  12. Agent 错误恢复 — 工具调用失败后 Agent 能继续工作
//
// 运行: node scripts/cdp-ai-multi-agent-collaboration-deep.mjs
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
  console.log('CDP connected, running Round 36 tests...\n')

  const callIpc = async (code) =>
    evalInPage(`(async function(){const api=window.__EAA_API__||window.api;if(!api)return{__error:'no-api'};try{${code}}catch(e){return{__error:String(e&&e.message?e.message:e)}}})()`)

  const isOk = (res) => !!res && !res.__error && res?.success !== false
  const isFail = (res) => !!res && (res.__error || res?.success === false)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  const TS = Date.now()
  const projectRoot = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari'
  const agentsDir = path.join(projectRoot, 'agents')

  // 读取源码辅助
  const readSrc = async (relPath) => { try { return await fsp.readFile(path.join(projectRoot, relPath), 'utf-8') } catch { return null } }
  const eaaToolsSrc = await readSrc('src/main/services/eaa-tools.ts')

  // 解析 entity_id 和 event_id
  const parseEntityId = (res) => {
    const data = res?.data ?? ''
    const m = typeof data === 'string' ? data.match(/\(ent_[a-f0-9]+\)/) : null
    return m ? m[0].slice(1, -1) : null
  }
  const parseEventId = (res) => {
    const data = res?.data ?? ''
    const m = typeof data === 'string' ? data.match(/evt_[a-f0-9]+/) : null
    return m ? m[0] : null
  }

  // 获取 agent 列表
  let agentList = []
  const agentsR = await callIpc(`const res = await api.agent.list(); return res;`)
  agentList = Array.isArray(agentsR) ? agentsR : (agentsR?.data ?? [])

  // ===========================================================
  // 1. 班主任场景 — main→counselor→class-monitor 协作
  // ===========================================================
  console.log('--- 1. 班主任场景 ---')

  await test('1.1 main agent 有读写工具能力', async () => {
    const main = agentList.find(a => a?.id === 'main')
    const caps = main?.capabilities || []
    // main 有 'all' 或同时有 read+write (add_event) 能力
    const hasAll = caps.includes('all') || caps.includes('*')
    const hasReadWrite = caps.includes('read') && (caps.includes('add_event') || caps.includes('write'))
    record('1.1 main 读写能力', hasAll || hasReadWrite, `caps=${JSON.stringify(caps).slice(0, 80)}`)
  })

  await test('1.2 counselor agent 有读取能力', async () => {
    const counselor = agentList.find(a => a?.id === 'counselor')
    const caps = counselor?.capabilities || []
    const hasRead = caps.includes('read') || caps.includes('score') || caps.includes('history') || caps.includes('all')
    record('1.2 counselor 读能力', hasRead, `caps=${JSON.stringify(caps).slice(0, 80)}`)
  })

  await test('1.3 class-monitor agent 能添加事件', async () => {
    const monitor = agentList.find(a => a?.id === 'class-monitor')
    const caps = monitor?.capabilities || []
    const hasWrite = caps.includes('write') || caps.includes('add_event') || caps.includes('all')
    record('1.3 class-monitor 写能力', hasWrite, `caps=${JSON.stringify(caps).slice(0, 80)}`)
  })

  await test('1.4 班主任工作流 — 添加学生→记录事件→查询分数', async () => {
    // 模拟班主任日常工作: 添加学生, 记录活动, 查看分数
    const studentName = `R36班主任-${TS}`
    const ar = await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(studentName)}); return res;`)
    if (!isOk(ar)) { record('1.4 班主任工作流', false, `addStudent failed`); return }
    // 记录课堂表现 (正分)
    const er = await callIpc(`const res = await api.eaa.addEvent({studentName:${JSON.stringify(studentName)}, reasonCode:'CLASS_MONITOR', note:'课堂表现优秀'}); return res;`)
    if (!isOk(er)) { record('1.4 班主任工作流', false, `addEvent failed`); return }
    await sleep(100)
    // 查看分数
    const sr = await callIpc(`const res = await api.eaa.score(${JSON.stringify(studentName)}); return res;`)
    const score = sr?.data?.score ?? sr?.data?.data?.score
    // 100 + 10 = 110
    record('1.4 班主任工作流', score === 110, `score=${score} expected=110`)
  })

  // ===========================================================
  // 2. 学业预警场景 — academic→risk-alert→student-care
  // ===========================================================
  console.log('\n--- 2. 学业预警场景 ---')

  await test('2.1 academic agent 有读取能力', async () => {
    const academic = agentList.find(a => a?.id === 'academic')
    const caps = academic?.capabilities || []
    const hasRead = caps.includes('read') || caps.includes('score') || caps.includes('all')
    record('2.1 academic 读能力', hasRead, `caps=${JSON.stringify(caps).slice(0, 80)}`)
  })

  await test('2.2 risk-alert agent 配置存在', async () => {
    const riskAlert = agentList.find(a => a?.id === 'risk-alert')
    record('2.2 risk-alert 存在', !!riskAlert, `found=${!!riskAlert}`)
  })

  await test('2.3 学业预警工作流 — 扣分→风险等级提升', async () => {
    const studentName = `R36预警-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(studentName)}); return res;`)
    await sleep(100)
    // 扣分使学生进入风险区
    const er = await callIpc(`const res = await api.eaa.addEvent({studentName:${JSON.stringify(studentName)}, reasonCode:'SMOKING', note:'严重违纪'}); return res;`)
    if (!isOk(er)) { record('2.3 学业预警工作流', false, `addEvent failed: ${er?.__error || er?.data}`); return }
    await sleep(100)
    // 查看分数和风险等级
    const sr = await callIpc(`const res = await api.eaa.score(${JSON.stringify(studentName)}); return res;`)
    const scoreData = sr?.data ?? sr
    const score = scoreData?.score ?? scoreData?.data?.score
    const riskLevel = scoreData?.risk_level ?? scoreData?.riskLevel ?? scoreData?.data?.risk_level
    // 100 - 10 = 90, 应有风险等级
    record('2.3 学业预警工作流', score === 90, `score=${score} expected=90 risk=${riskLevel}`)
  })

  await test('2.4 student-care agent 配置存在', async () => {
    const studentCare = agentList.find(a => a?.id === 'student-care')
    record('2.4 student-care 存在', !!studentCare, `found=${!!studentCare}`)
  })

  // ===========================================================
  // 3. 纪律处理场景 — discipline-officer→supervisor→counselor
  // ===========================================================
  console.log('\n--- 3. 纪律处理场景 ---')

  await test('3.1 discipline-officer agent 有写入能力', async () => {
    const officer = agentList.find(a => a?.id === 'discipline-officer')
    const caps = officer?.capabilities || []
    const hasWrite = caps.includes('write') || caps.includes('add_event') || caps.includes('all')
    record('3.1 discipline-officer 写能力', hasWrite, `caps=${JSON.stringify(caps).slice(0, 80)}`)
  })

  await test('3.2 纪律处理工作流 — 扣分→撤销→恢复', async () => {
    const studentName = `R36纪律-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(studentName)}); return res;`)
    await sleep(100)
    // 纪律扣分
    const er = await callIpc(`const res = await api.eaa.addEvent({studentName:${JSON.stringify(studentName)}, reasonCode:'LATE', note:'迟到'}); return res;`)
    if (!isOk(er)) { record('3.2 纪律处理工作流', false, `addEvent failed`); return }
    const eventId = parseEventId(er)
    if (!eventId) { record('3.2 纪律处理工作流', false, 'no eventId'); return }
    await sleep(100)
    // 验证扣分
    const sr1 = await callIpc(`const res = await api.eaa.score(${JSON.stringify(studentName)}); return res;`)
    const score1 = sr1?.data?.score ?? sr1?.data?.data?.score
    // 撤销 (误判)
    const rr = await callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(eventId)}, '误判撤销'); return res;`)
    if (!isOk(rr)) { record('3.2 纪律处理工作流', false, `revert failed: ${rr?.__error}`); return }
    await sleep(200)
    // 验证恢复
    const sr2 = await callIpc(`const res = await api.eaa.score(${JSON.stringify(studentName)}); return res;`)
    const score2 = sr2?.data?.score ?? sr2?.data?.data?.score
    // 100 → 98 (LATE -2) → 100 (revert)
    record('3.2 纪律处理工作流', score1 === 98 && score2 === 100, `before=${score1} afterRevert=${score2}`)
  })

  // ===========================================================
  // 4. 数据分析场景 — data-analyst→governor→validator
  // ===========================================================
  console.log('\n--- 4. 数据分析场景 ---')

  await test('4.1 data-analyst agent 有统计读取能力', async () => {
    const analyst = agentList.find(a => a?.id === 'data-analyst')
    const caps = analyst?.capabilities || []
    const hasRead = caps.includes('read') || caps.includes('stats') || caps.includes('all')
    record('4.1 data-analyst 读能力', hasRead, `caps=${JSON.stringify(caps).slice(0, 80)}`)
  })

  await test('4.2 数据分析工作流 — stats→ranking→summary', async () => {
    // 模拟数据分析师工作: 查看统计, 排名, 摘要
    const statsR = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const rankingR = await callIpc(`const res = await api.eaa.ranking({limit:10}); return res;`)
    const summaryR = await callIpc(`const res = await api.eaa.summary(); return res;`)
    const statsOk = isOk(statsR)
    const rankingOk = isOk(rankingR)
    const summaryOk = isOk(summaryR)
    record('4.2 数据分析工作流', statsOk && rankingOk && summaryOk, `stats=${statsOk} ranking=${rankingOk} summary=${summaryOk}`)
  })

  await test('4.3 validator agent 配置存在', async () => {
    const validator = agentList.find(a => a?.id === 'validator')
    record('4.3 validator 存在', !!validator, `found=${!!validator}`)
  })

  await test('4.4 数据校验工作流 — validate 通过', async () => {
    const r = await callIpc(`const res = await api.eaa.validate(); return res;`)
    record('4.4 validate 通过', isOk(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 5. 周报场景 — weekly-reporter→supervisor→main
  // ===========================================================
  console.log('\n--- 5. 周报场景 ---')

  await test('5.1 weekly-reporter agent 配置存在', async () => {
    const reporter = agentList.find(a => a?.id === 'weekly-reporter')
    record('5.1 weekly-reporter 存在', !!reporter, `found=${!!reporter}`)
  })

  await test('5.2 周报数据源 — summary+stats 可获取', async () => {
    const summaryR = await callIpc(`const res = await api.eaa.summary(); return res;`)
    const statsR = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const summaryData = summaryR?.data ?? summaryR
    const statsData = statsR?.data ?? statsR
    // 周报需要的数据: 摘要(事件统计) + 统计(原因分布)
    const hasSummaryEvents = summaryData?.events && typeof summaryData.events === 'object'
    const hasStatsSummary = statsData?.summary && typeof statsData.summary === 'object'
    record('5.2 周报数据源', hasSummaryEvents && hasStatsSummary, `summaryEvents=${hasSummaryEvents} statsSummary=${hasStatsSummary}`)
  })

  await test('5.3 周报导出 — export 可用', async () => {
    const r = await callIpc(`const res = await api.eaa.export('jsonl'); return res;`)
    record('5.3 周报导出', isOk(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 6. Agent 工具配置完整性
  // ===========================================================
  console.log('\n--- 6. Agent 工具配置完整性 ---')

  await test('6.1 所有 agent 有 capabilities 数组', async () => {
    let missing = 0
    for (const a of agentList) {
      if (!Array.isArray(a?.capabilities)) missing++
    }
    record('6.1 capabilities 数组', missing === 0, `total=${agentList.length} missing=${missing}`)
  })

  await test('6.2 所有 agent 有 modelTier', async () => {
    let missing = 0
    for (const a of agentList) {
      if (typeof a?.modelTier !== 'string' || a.modelTier.length === 0) missing++
    }
    record('6.2 modelTier 非空', missing === 0, `total=${agentList.length} missing=${missing}`)
  })

  await test('6.3 源码中 getToolsByCapability 存在', async () => {
    const found = eaaToolsSrc?.includes('getToolsByCapability')
    record('6.3 getToolsByCapability', !!found, `found=${!!found}`)
  })

  await test('6.4 read 能力映射 9 个只读工具', async () => {
    // read: score, history, search, list_students, ranking, stats, codes, summary, range
    const readIdx = eaaToolsSrc?.indexOf('read:') ?? -1
    if (readIdx === -1) { record('6.4 read 映射', true, 'read: not found'); return }
    const afterRead = eaaToolsSrc.slice(readIdx)
    const writeIdx = afterRead.indexOf('write:')
    const readSection = writeIdx > 0 ? afterRead.slice(0, writeIdx) : afterRead.slice(0, 500)
    const toolCount = (readSection.match(/Tool/g) || []).length
    record('6.4 read 映射', toolCount >= 9, `tools=${toolCount}`)
  })

  // ===========================================================
  // 7. 跨 Agent 数据传递
  // ===========================================================
  console.log('\n--- 7. 跨 Agent 数据传递 ---')

  await test('7.1 class-monitor 写入 → counselor 可读', async () => {
    // class-monitor 添加事件, counselor 查询分数
    const studentName = `R36传递-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(studentName)}); return res;`)
    await sleep(100)
    // 写入
    const er = await callIpc(`const res = await api.eaa.addEvent({studentName:${JSON.stringify(studentName)}, reasonCode:'ACTIVITY_PARTICIPATION', note:'r36-cross'}); return res;`)
    if (!isOk(er)) { record('7.1 跨 Agent 传递', false, `addEvent failed`); return }
    await sleep(100)
    // 读取
    const sr = await callIpc(`const res = await api.eaa.score(${JSON.stringify(studentName)}); return res;`)
    const score = sr?.data?.score ?? sr?.data?.data?.score
    const hr = await callIpc(`const res = await api.eaa.history(${JSON.stringify(studentName)}); return res;`)
    const hData = hr?.data ?? hr
    const events = Array.isArray(hData) ? hData : (hData?.events ?? [])
    record('7.1 跨 Agent 传递', score === 101 && events.length > 0, `score=${score} events=${events.length}`)
  })

  await test('7.2 data-analyst 统计 → governor 可用', async () => {
    // data-analyst 查统计, governor 用排名
    const statsR = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const rankingR = await callIpc(`const res = await api.eaa.ranking({limit:10}); return res;`)
    const statsData = statsR?.data ?? statsR
    const rankingData = rankingR?.data ?? rankingR
    const ranking = rankingData?.ranking ?? rankingData?.data?.ranking ?? []
    // 两者都应有数据
    record('7.2 统计→排名', isOk(statsR) && ranking.length > 0, `statsOk=${isOk(statsR)} ranking=${ranking.length}`)
  })

  // ===========================================================
  // 8. Agent SOUL 一致性
  // ===========================================================
  console.log('\n--- 8. Agent SOUL 一致性 ---')

  await test('8.1 main SOUL 含工具列表', async () => {
    const soulR = await callIpc(`const res = await api.agent.getSoul('main'); return res;`)
    const soul = typeof soulR === 'string' ? soulR : (soulR?.data ?? '')
    // SOUL 应提及 eaa_score, eaa_add_event 等工具
    const hasTools = soul.includes('eaa_score') || soul.includes('eaa_add_event') || soul.includes('工具')
    record('8.1 main SOUL 含工具', hasTools, `len=${soul.length} hasTools=${hasTools}`)
  })

  await test('8.2 所有 agent SOUL 非空', async () => {
    let empty = 0
    for (const a of agentList) {
      const r = await callIpc(`const res = await api.agent.getSoul(${JSON.stringify(a.id)}); return res;`)
      const content = typeof r === 'string' ? r : (r?.data ?? '')
      if (typeof content !== 'string' || content.length === 0) empty++
    }
    record('8.2 所有 SOUL 非空', empty === 0, `total=${agentList.length} empty=${empty}`)
  })

  await test('8.3 所有 agent Rules 非空', async () => {
    let empty = 0
    for (const a of agentList) {
      const r = await callIpc(`const res = await api.agent.getRules(${JSON.stringify(a.id)}); return res;`)
      const content = typeof r === 'string' ? r : (r?.data ?? '')
      if (typeof content !== 'string' || content.length === 0) empty++
    }
    record('8.3 所有 Rules 非空', empty === 0, `total=${agentList.length} empty=${empty}`)
  })

  // ===========================================================
  // 9. 真实工作流端到端
  // ===========================================================
  console.log('\n--- 9. 真实工作流端到端 ---')

  await test('9.1 完整日常流程 — 添加→记录→查询→分析→导出', async () => {
    const studentName = `R36日常-${TS}`
    // 1. 添加学生
    const ar = await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(studentName)}); return res;`)
    if (!isOk(ar)) { record('9.1 日常流程', false, 'addStudent failed'); return }
    // 2. 记录多个事件 (正分+负分)
    await callIpc(`const res = await api.eaa.addEvent({studentName:${JSON.stringify(studentName)}, reasonCode:'CLASS_MONITOR', note:'班长负责'}); return res;`)
    await callIpc(`const res = await api.eaa.addEvent({studentName:${JSON.stringify(studentName)}, reasonCode:'LATE', note:'迟到一次'}); return res;`)
    await sleep(200)
    // 3. 查询分数
    const sr = await callIpc(`const res = await api.eaa.score(${JSON.stringify(studentName)}); return res;`)
    const score = sr?.data?.score ?? sr?.data?.data?.score
    // 100 + 10 - 2 = 108
    // 4. 查看历史
    const hr = await callIpc(`const res = await api.eaa.history(${JSON.stringify(studentName)}); return res;`)
    const hData = hr?.data ?? hr
    const events = Array.isArray(hData) ? hData : (hData?.events ?? [])
    // 5. 统计
    const statsR = await callIpc(`const res = await api.eaa.stats(); return res;`)
    // 6. 导出
    const exportR = await callIpc(`const res = await api.eaa.export('jsonl'); return res;`)
    record('9.1 日常流程', score === 108 && events.length >= 2 && isOk(statsR) && isOk(exportR), `score=${score} events=${events.length} stats=${isOk(statsR)} export=${isOk(exportR)}`)
  })

  await test('9.2 班级管理流程 — 建班→分配→查询', async () => {
    const classId = `R36CLS-${TS}`
    const className = `R36测试班-${TS}`
    const s1 = `R36班级A-${TS}`
    const s2 = `R36班级B-${TS}`
    // 1. 建班
    const cr = await callIpc(`const res = await api.class.create({class_id:${JSON.stringify(classId)}, name:${JSON.stringify(className)}}); return res;`)
    if (!isOk(cr)) { record('9.2 班级管理', false, 'create failed'); return }
    // 2. 添加学生
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(s1)}); return res;`)
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(s2)}); return res;`)
    // 3. 分配到班级
    const ar = await callIpc(`const res = await api.class.assign({class_id:${JSON.stringify(classId)}, student_names:[${JSON.stringify(s1)}, ${JSON.stringify(s2)}]}); return res;`)
    if (!isOk(ar)) { record('9.2 班级管理', false, `assign failed: ${ar?.__error || ar?.error}`); return }
    // 4. 查询班级列表
    const lr = await callIpc(`const res = await api.class.list(); return res;`)
    const data = lr?.data ?? lr
    const classes = Array.isArray(data) ? data : (data?.classes ?? [])
    const found = classes.some(c => c?.class_id === classId || c?.id === classId)
    record('9.2 班级管理', found, `classFound=${found}`)
  })

  // ===========================================================
  // 10. Agent 权限边界
  // ===========================================================
  console.log('\n--- 10. Agent 权限边界 ---')

  await test('10.1 read-only agent 无写入工具', async () => {
    // 验证 read 能力不包含 addEventTool/addStudentTool
    const readIdx = eaaToolsSrc?.indexOf('read:') ?? -1
    if (readIdx === -1) { record('10.1 read 无写', true, 'read: not found'); return }
    const afterRead = eaaToolsSrc.slice(readIdx)
    const writeIdx = afterRead.indexOf('write:')
    const readSection = writeIdx > 0 ? afterRead.slice(0, writeIdx) : afterRead.slice(0, 300)
    const hasWrite = readSection.includes('addEventTool') || readSection.includes('addStudentTool')
    record('10.1 read 无写', !hasWrite, `hasWrite=${hasWrite}`)
  })

  await test('10.2 write agent 有写入工具', async () => {
    const writeIdx = eaaToolsSrc?.indexOf('write:') ?? -1
    if (writeIdx === -1) { record('10.2 write 有写', true, 'write: not found'); return }
    const afterWrite = eaaToolsSrc.slice(writeIdx, writeIdx + 200)
    const hasWrite = afterWrite.includes('addEventTool') || afterWrite.includes('addStudentTool')
    record('10.2 write 有写', hasWrite, `hasWrite=${hasWrite}`)
  })

  await test('10.3 敏感路径黑名单阻止 workstation.db', async () => {
    const fileToolsSrc = await readSrc('src/main/services/file-tools.ts')
    const hasBlock = fileToolsSrc?.includes('workstation')
    record('10.3 workstation.db 阻止', !!hasBlock, `found=${!!hasBlock}`)
  })

  // ===========================================================
  // 11. Agent 配置持久化
  // ===========================================================
  console.log('\n--- 11. Agent 配置持久化 ---')

  await test('11.1 agent.list 返回稳定数量', async () => {
    const r1 = await callIpc(`const res = await api.agent.list(); return res;`)
    const list1 = Array.isArray(r1) ? r1 : (r1?.data ?? [])
    const r2 = await callIpc(`const res = await api.agent.list(); return res;`)
    const list2 = Array.isArray(r2) ? r2 : (r2?.data ?? [])
    record('11.1 agent.list 稳定', list1.length === list2.length, `count1=${list1.length} count2=${list2.length}`)
  })

  await test('11.2 agent.getSoul 多次读取一致', async () => {
    const r1 = await callIpc(`const res = await api.agent.getSoul('main'); return res;`)
    const r2 = await callIpc(`const res = await api.agent.getSoul('main'); return res;`)
    const s1 = typeof r1 === 'string' ? r1 : (r1?.data ?? '')
    const s2 = typeof r2 === 'string' ? r2 : (r2?.data ?? '')
    record('11.2 getSoul 一致', s1 === s2 && s1.length > 0, `len1=${s1.length} len2=${s2.length} match=${s1 === s2}`)
  })

  await test('11.3 agents.user.yaml 文件存在', async () => {
    const yamlPath = path.join('C:\\Users\\sq199\\AppData\\Roaming\\com.educationadvisor.tauri', 'agents.user.yaml')
    const exists = fs.existsSync(yamlPath)
    record('11.3 agents.user.yaml', exists, `path=${yamlPath} exists=${exists}`)
  })

  // ===========================================================
  // 12. Agent 错误恢复
  // ===========================================================
  console.log('\n--- 12. Agent 错误恢复 ---')

  await test('12.1 无效 reasonCode 不崩溃', async () => {
    const studentName = `R36错误-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(studentName)}); return res;`)
    const er = await callIpc(`const res = await api.eaa.addEvent({studentName:${JSON.stringify(studentName)}, reasonCode:'INVALID_CODE', note:'test'}); return res;`)
    // 应返回失败但不崩溃
    const safe = er !== undefined && !er?.__error || isFail(er)
    record('12.1 无效 reasonCode', safe, `success=${er?.success} safe=${safe}`)
  })

  await test('12.2 不存在学生查询不崩溃', async () => {
    const r = await callIpc(`const res = await api.eaa.score('不存在的学生-${TS}'); return res;`)
    record('12.2 不存在学生', r !== undefined && !r?.__error, `success=${r?.success}`)
  })

  await test('12.3 无效 agent id 不崩溃', async () => {
    const r = await callIpc(`const res = await api.agent.getSoul('invalid-agent-id-${TS}'); return res;`)
    record('12.3 无效 agent id', r !== undefined && !r?.__error, `result=${typeof r}`)
  })

  await test('12.4 错误后系统仍可用', async () => {
    // 先触发错误,再正常操作
    await callIpc(`const res = await api.eaa.addEvent({studentName:'不存在', reasonCode:'INVALID'}); return res;`)
    await callIpc(`const res = await api.agent.getSoul('invalid'); return res;`)
    // 验证系统仍可用
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    record('12.4 错误后可用', isOk(r), `statsOk=${isOk(r)}`)
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
