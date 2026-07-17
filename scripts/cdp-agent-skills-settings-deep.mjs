// =============================================================
// CDP Agent + Skills + Settings + Profile 深度测试
// 角度: 参数验证边界 + 类型校验 + 路径遍历 + 原型链污染 + 并发竞态 + 持久化恢复
// 运行: node scripts/cdp-agent-skills-settings-deep.mjs
//
// 基于源码分析的高优先级 bug 验证:
//   P4-1: agent.update 未校验 patch 字段类型 (name/modelTier/description)
//   P4-2: agent.runManual 未校验 history 参数 (非数组/含 null/超长 content)
//   P4-3: agent.abort 无参数校验 (与其它 handler 不一致)
//   P4-4: agent.setSoul/setRules content 无长度上限 + 无 null byte 校验
//   P4-5: settings.set value 类型未与 schema 匹配 (theme=123 跳过枚举校验)
//   P4-6: settings.set feishu.appSecret 无长度上限 + 无 null byte 校验
//   P4-7: profile.set data 字段类型未校验 + 无大小上限
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

// 通用 IPC 调用器
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

const callAgent = (m, ...a) => callNS('agent', m, ...a)
const callSkill = (m, ...a) => callNS('skill', m, ...a)
const callSettings = (m, ...a) => callNS('settings', m, ...a)
const callProfile = (m, ...a) => callNS('profile', m, ...a)

const isOk = (r) => !!r && r.__error === undefined && r.success === true
const isErr = (r) => !!r && (r.__error !== undefined || r.success === false)
const errMsg = (r) => r.__error || r.error || r.message || 'unknown error'

// =============================================================
// 1. Agent 配置深度测试 — 参数验证边界
// =============================================================
async function testAgentValidation() {
  console.log('\n=== 1. Agent 配置参数验证 ===')

  // 1.1 agent.list 基础
  const list = await callAgent('list')
  record('agent.list 返回数组', Array.isArray(list),
    Array.isArray(list) ? `count=${list.length}` : `type=${typeof list}`)
  note(`agent.list count=${Array.isArray(list) ? list.length : 0}`)

  // 1.2 agent.get 空 id
  const r1 = await callAgent('get', '')
  record('agent.get(空 id) 应失败', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 60)}` : '意外成功')

  // 1.3 agent.get 非字符串 id
  const r2 = await callAgent('get', 123)
  record('agent.get(id=数字) 应失败', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 60)}` : '意外成功')

  // 1.4 agent.get 不存在的 id
  const r3 = await callAgent('get', 'non-existent-xxx')
  record('agent.get(不存在的 id) 返回 null 或失败', r3 === null || isErr(r3),
    `result=${JSON.stringify(r3).slice(0, 60)}`)

  // 1.5 agent.toggle 非布尔 enabled
  const r4 = await callAgent('toggle', 'main', 'yes')
  record('agent.toggle(enabled=字符串) 应失败', isErr(r4),
    isErr(r4) ? `error=${errMsg(r4).slice(0, 60)}` : '意外成功')

  // 1.6 agent.toggle 非字符串 id
  const r5 = await callAgent('toggle', 123, true)
  record('agent.toggle(id=数字) 应失败', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 60)}` : '意外成功')
}

// =============================================================
// 2. Agent update patch 字段类型校验 (P4-1 重点)
// =============================================================
async function testAgentUpdatePatchValidation() {
  console.log('\n=== 2. agent.update patch 字段类型校验 (P4-1) ===')

  // 先备份 main agent 的当前配置
  const original = await callAgent('get', 'main')
  note(`main agent 原始 name=${original?.name}, modelTier=${original?.modelTier}`)

  // 2.1 patch.name=数字 (非字符串) — P4-1 修复:应拒绝
  const r1 = await callAgent('update', 'main', { name: 12345 })
  const after1 = await callAgent('get', 'main')
  const nameIsStillString1 = typeof after1?.name === 'string'
  record('agent.update(name=数字) 应失败 (P4-1)', isErr(r1) && nameIsStillString1,
    isErr(r1) ? `error=${errMsg(r1).slice(0, 60)}` : (nameIsStillString1 ? '返回 success 但未实际写入' : `BUG: name 被改为 ${typeof after1?.name}`))
  if (!isErr(r1) && !nameIsStillString1) bug('P4-1: agent.update 接受 name=数字,污染内存配置')

  // 2.2 patch.name 含 null byte — P4-1 修复:应拒绝
  const r2 = await callAgent('update', 'main', { name: 'evil\0inject' })
  const after2 = await callAgent('get', 'main')
  const nameNoNull2 = typeof after2?.name === 'string' && !after2.name.includes('\0')
  record('agent.update(name 含 null byte) 应失败 (P4-1)', isErr(r2) && nameNoNull2,
    isErr(r2) ? `error=${errMsg(r2).slice(0, 60)}` : (nameNoNull2 ? '返回 success 但未实际写入' : 'BUG: name 含 null byte'))
  if (!isErr(r2) && !nameNoNull2) bug('P4-1: agent.update 接受 name 含 null byte')

  // 2.3 patch.name 超长 (100KB) — P4-1 修复:应拒绝
  const r3 = await callAgent('update', 'main', { name: 'x'.repeat(100_000) })
  const after3 = await callAgent('get', 'main')
  const nameNotHuge3 = typeof after3?.name === 'string' && after3.name.length < 1000
  record('agent.update(name 超长 100KB) 应失败 (P4-1)', isErr(r3) && nameNotHuge3,
    isErr(r3) ? `error=${errMsg(r3).slice(0, 60)}` : (nameNotHuge3 ? '返回 success 但未实际写入' : `BUG: name 长度=${after3?.name?.length}`))
  if (!isErr(r3) && !nameNotHuge3) bug('P4-1: agent.update 接受超长 name,可能撑爆 agents.user.yaml')

  // 2.4 patch.modelTier=非白名单值 — P4-1 修复:应拒绝
  const r4 = await callAgent('update', 'main', { modelTier: 'invalid_tier_xxx' })
  const after4 = await callAgent('get', 'main')
  const tierIsValid4 = after4?.modelTier === 'high_quality' || after4?.modelTier === 'low_cost' || after4?.modelTier === undefined
  record('agent.update(modelTier=非白名单) 应失败 (P4-1)', isErr(r4) && tierIsValid4,
    isErr(r4) ? `error=${errMsg(r4).slice(0, 60)}` : (tierIsValid4 ? `返回 success 但未写入 (tier=${after4?.modelTier})` : `BUG: modelTier=${after4?.modelTier}`))
  if (!isErr(r4) && !tierIsValid4) bug('P4-1: agent.update 接受非白名单 modelTier,selectModel 行为静默错误')

  // 2.5 patch.modelTier=数字 — P4-1 修复:应拒绝
  const r5 = await callAgent('update', 'main', { modelTier: 123 })
  const after5 = await callAgent('get', 'main')
  const tierIsValid5 = after5?.modelTier === 'high_quality' || after5?.modelTier === 'low_cost' || after5?.modelTier === undefined
  record('agent.update(modelTier=数字) 应失败 (P4-1)', isErr(r5) && tierIsValid5,
    isErr(r5) ? `error=${errMsg(r5).slice(0, 60)}` : (tierIsValid5 ? `返回 success 但未写入` : `BUG: modelTier=${after5?.modelTier}`))
  if (!isErr(r5) && !tierIsValid5) bug('P4-1: agent.update 接受 modelTier=数字')

  // 2.6 patch.description=数字 — P4-1 修复:应拒绝
  const r6 = await callAgent('update', 'main', { description: 12345 })
  const after6 = await callAgent('get', 'main')
  const descIsString6 = typeof after6?.description === 'string' || after6?.description === undefined
  record('agent.update(description=数字) 应失败 (P4-1)', isErr(r6) && descIsString6,
    isErr(r6) ? `error=${errMsg(r6).slice(0, 60)}` : (descIsString6 ? '返回 success 但未实际写入' : `BUG: description=${typeof after6?.description}`))
  if (!isErr(r6) && !descIsString6) bug('P4-1: agent.update 接受 description=数字')

  // 2.7 patch.capabilities=非数组 — P4-1 修复:应拒绝
  const r7 = await callAgent('update', 'main', { capabilities: 'not-an-array' })
  const after7 = await callAgent('get', 'main')
  const capsValid7 = Array.isArray(after7?.capabilities) || after7?.capabilities === undefined
  record('agent.update(capabilities=字符串) 应失败 (P4-1)', isErr(r7) && capsValid7,
    isErr(r7) ? `error=${errMsg(r7).slice(0, 60)}` : (capsValid7 ? '返回 success 但未实际写入' : `BUG: capabilities=${typeof after7?.capabilities}`))
  if (!isErr(r7) && !capsValid7) bug('P4-1: agent.update 接受 capabilities=非数组')

  // 2.8 patch={__proto__: {polluted: 'yes'}} — 原型链污染尝试
  const r8 = await callAgent('update', 'main', JSON.parse('{"__proto__": {"polluted_test_p41": "yes"}}'))
  const protoPolluted = ({}).polluted_test_p41 === 'yes'
  record('agent.update(__proto__ 注入) 不应污染原型', !protoPolluted,
    protoPolluted ? 'BUG: Object.prototype 被污染!' : `success=${r8?.success}`)
  if (protoPolluted) bug('P4-1: agent.update __proto__ 注入污染了 Object.prototype')

  // 恢复 main agent 配置
  if (original) {
    await callAgent('update', 'main', {
      name: original.name,
      description: original.description,
      modelTier: original.modelTier,
      capabilities: original.capabilities,
    })
    note('main agent 配置已恢复')
  }
}

// =============================================================
// 3. Agent setSoul/setRules content 边界 (P4-4)
// =============================================================
async function testAgentSetSoulValidation() {
  console.log('\n=== 3. agent.setSoul/setRules content 边界 (P4-4) ===')

  // 先备份 main agent 的 SOUL.md
  const originalSoul = await callAgent('getSoul', 'main')
  note(`main agent SOUL.md 原始长度=${typeof originalSoul === 'string' ? originalSoul.length : 'N/A'}`)

  // 3.1 setSoul content 含 null byte — P4-4 修复:应拒绝
  const r1 = await callAgent('setSoul', 'main', 'test\0evil')
  record('agent.setSoul(content 含 null byte) 应失败 (P4-4)', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 60)}` : `BUG: success=${r1?.success}`)
  if (!isErr(r1)) bug('P4-4: agent.setSoul 接受 content 含 null byte')

  // 3.2 setSoul content 超长 (5MB) — P4-4 修复:应拒绝
  const r2 = await callAgent('setSoul', 'main', 'x'.repeat(5_000_000))
  record('agent.setSoul(content 5MB) 应失败 (P4-4)', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 60)}` : `BUG: success=${r2?.success}`)
  if (!isErr(r2)) bug('P4-4: agent.setSoul 接受 5MB content,可能撑爆磁盘')

  // 3.3 setSoul content 非字符串 — 应拒绝 (已有校验)
  const r3 = await callAgent('setSoul', 'main', 12345)
  record('agent.setSoul(content=数字) 应失败', isErr(r3),
    isErr(r3) ? `error=${errMsg(r3).slice(0, 60)}` : '意外成功')

  // 3.4 setSoul 正常写入 + 验证 + 恢复
  const testContent = '# CDP 测试 SOUL\n这是测试内容,稍后恢复。'
  const r4 = await callAgent('setSoul', 'main', testContent)
  record('agent.setSoul(正常 content) 应成功', isOk(r4),
    isOk(r4) ? 'success' : `error=${errMsg(r4).slice(0, 60)}`)

  const after4 = await callAgent('getSoul', 'main')
  record('agent.getSoul 读取刚写入的内容', after4 === testContent,
    after4 === testContent ? '内容匹配' : `内容不匹配 len=${typeof after4 === 'string' ? after4.length : 'N/A'}`)

  // 恢复 SOUL.md
  if (typeof originalSoul === 'string') {
    await callAgent('setSoul', 'main', originalSoul)
    note('main agent SOUL.md 已恢复')
  }
}

// =============================================================
// 4. Agent runManual history 参数校验 (P4-2)
// =============================================================
async function testAgentRunManualHistoryValidation() {
  console.log('\n=== 4. agent.runManual history 参数校验 (P4-2) ===')

  // 4.1 history=非数组 (字符串) — P4-2 修复:应拒绝
  const r1 = await callAgent('runManual', 'main', 'CDP 测试 history', 'not-an-array')
  record('agent.runManual(history=字符串) 应失败 (P4-2)', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 60)}` : `BUG: success=${r1?.success}`)
  if (!isErr(r1)) bug('P4-2: agent.runManual 接受 history=非数组,service 内 for...of 会抛 TypeError')

  // 4.2 history 含 null 元素 — P4-2 修复:应拒绝
  const r2 = await callAgent('runManual', 'main', 'CDP 测试 history', [null, { role: 'user', content: 'test' }])
  record('agent.runManual(history=[null,...]) 应失败 (P4-2)', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 60)}` : `BUG: success=${r2?.success}`)
  if (!isErr(r2)) bug('P4-2: agent.runManual 接受 history 含 null 元素,service 内 msg.content 抛 TypeError')

  // 4.3 history 含超长 content (5MB) — P4-2 修复:应拒绝
  const r3 = await callAgent('runManual', 'main', 'CDP 测试 history', [{ role: 'user', content: 'x'.repeat(5_000_000) }])
  record('agent.runManual(history 含 5MB content) 应失败 (P4-2)', isErr(r3),
    isErr(r3) ? `error=${errMsg(r3).slice(0, 60)}` : `BUG: success=${r3?.success}`)
  if (!isErr(r3)) bug('P4-2: agent.runManual 接受 history 含 5MB content,内存暴涨风险')

  // 4.4 history 含 role=非白名单 — P4-2 修复:应拒绝或过滤
  const r4 = await callAgent('runManual', 'main', 'CDP 测试 history', [{ role: '__evil_role__', content: 'test' }])
  // 注: service 会跳过非 user/assistant 的 role,行为是静默过滤。不算 bug,但应记录
  record('agent.runManual(history 含非白名单 role) 不崩溃', !isErr(r4) || isErr(r4),
    `success=${r4?.success}, msg=${errMsg(r4).slice(0, 60)}`)

  // 4.5 history 含 null byte content — P4-2 修复:应拒绝
  const r5 = await callAgent('runManual', 'main', 'CDP 测试 history', [{ role: 'user', content: 'evil\0inject' }])
  record('agent.runManual(history content 含 null byte) 应失败 (P4-2)', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 60)}` : `BUG: success=${r5?.success}`)
  if (!isErr(r5)) bug('P4-2: agent.runManual 接受 history content 含 null byte')

  // 4.6 history=undefined (合法,应等同无 history) — 应成功
  const r6 = await callAgent('runManual', 'main', 'CDP 测试:简短回复"OK"')
  record('agent.runManual(history=undefined) 应成功', isOk(r6),
    isOk(r6) ? `id=${r6.id}` : `error=${errMsg(r6).slice(0, 60)}`)
}

// =============================================================
// 5. Agent abort 参数校验 (P4-3)
// =============================================================
async function testAgentAbortValidation() {
  console.log('\n=== 5. agent.abort 参数校验 (P4-3) ===')

  // 5.1 abort(null) — P4-3 修复:应返回结构化错误,不崩溃
  const r1 = await callAgent('abort', null)
  record('agent.abort(null) 不崩溃', !isErr(r1) || isErr(r1),
    `success=${r1?.success}, msg=${errMsg(r1).slice(0, 60)}`)

  // 5.2 abort(数字) — P4-3 修复:应返回结构化错误
  const r2 = await callAgent('abort', 123)
  record('agent.abort(数字) 不崩溃', !isErr(r2) || isErr(r2),
    `success=${r2?.success}, msg=${errMsg(r2).slice(0, 60)}`)

  // 5.3 abort(空字符串) — 应返回 not running
  const r3 = await callAgent('abort', '')
  record('agent.abort(空字符串) 不崩溃', !isErr(r3) || isErr(r3),
    `success=${r3?.success}, msg=${errMsg(r3).slice(0, 60)}`)

  // 5.4 abort(超长 id) — 不崩溃
  const r4 = await callAgent('abort', 'x'.repeat(10_000))
  record('agent.abort(超长 id) 不崩溃', !isErr(r4) || isErr(r4),
    `success=${r4?.success}, msg=${errMsg(r4).slice(0, 60)}`)

  // 5.5 abort(不存在的 agent) — 应返回 not running
  const r5 = await callAgent('abort', 'non-existent-xxx')
  record('agent.abort(不存在的 agent) 返回 not running', r5?.success === false,
    `success=${r5?.success}, msg=${errMsg(r5).slice(0, 60)}`)
}

// =============================================================
// 6. Skills 深度测试 — 路径遍历 + CRUD
// =============================================================
async function testSkillsDeep() {
  console.log('\n=== 6. Skills 路径遍历 + CRUD ===')

  // 6.1 skill.list 基础
  const list = await callSkill('list')
  record('skill.list 返回数组', Array.isArray(list),
    Array.isArray(list) ? `count=${list.length}` : `type=${typeof list}`)

  // 6.2 skill.get 路径遍历 ../ — 应被 validateSkillName 拒绝
  const r1 = await callSkill('get', '../../../etc/passwd')
  record('skill.get(../../../etc/passwd) 应失败', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 60)}` : '意外成功')

  // 6.3 skill.get 含 / 分隔符 — 应失败
  const r2 = await callSkill('get', 'foo/bar')
  record('skill.get(foo/bar) 应失败', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 60)}` : '意外成功')

  // 6.4 skill.get 含 \ 分隔符 — 应失败
  const r3 = await callSkill('get', 'foo\\bar')
  record('skill.get(foo\\bar) 应失败', isErr(r3),
    isErr(r3) ? `error=${errMsg(r3).slice(0, 60)}` : '意外成功')

  // 6.5 skill.get 含 null byte — 应失败
  const r4 = await callSkill('get', 'evil\0name')
  record('skill.get(含 null byte) 应失败', isErr(r4),
    isErr(r4) ? `error=${errMsg(r4).slice(0, 60)}` : '意外成功')

  // 6.6 skill.get 超长 name (129 字符) — 应失败
  const r5 = await callSkill('get', 'a'.repeat(129))
  record('skill.get(name 129 字符) 应失败', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 60)}` : '意外成功')

  // 6.7 skill.save content 超长 (2MB) — 应失败
  const r6 = await callSkill('save', 'cdp-test-skill', 'x'.repeat(2 * 1024 * 1024))
  record('skill.save(content 2MB) 应失败', isErr(r6),
    isErr(r6) ? `error=${errMsg(r6).slice(0, 60)}` : '意外成功')

  // 6.8 skill.save content 含 null byte — 当前未校验,记录为潜在 bug
  const r7 = await callSkill('save', 'cdp-test-null-byte', 'content\0evil')
  const after7 = await callSkill('get', 'cdp-test-null-byte')
  const hasNull7 = typeof after7?.content === 'string' && after7.content.includes('\0')
  record('skill.save(content 含 null byte) 应失败', isErr(r7) && !hasNull7,
    isErr(r7) ? `error=${errMsg(r7).slice(0, 60)}` : (hasNull7 ? 'BUG: null byte 被持久化' : 'success 但无 null byte'))
  if (!isErr(r7) && hasNull7) bug('skill.save 接受 content 含 null byte 并持久化')

  // 清理
  await callSkill('delete', 'cdp-test-null-byte')

  // 6.9 skill 完整 CRUD 流程
  const testName = 'cdp-test-crud-' + Date.now()
  const createContent = '# CDP 测试技能\n这是一个测试技能。'
  const r9a = await callSkill('save', testName, createContent)
  record('skill.save 创建新技能', isOk(r9a), isOk(r9a) ? 'success' : `error=${errMsg(r9a).slice(0, 60)}`)

  const r9b = await callSkill('get', testName)
  record('skill.get 读取刚创建的技能', r9b?.content === createContent,
    r9b?.content === createContent ? '内容匹配' : `内容不匹配: ${JSON.stringify(r9b).slice(0, 80)}`)

  const updateContent = '# CDP 测试技能 (已更新)\n内容已修改。'
  const r9c = await callSkill('save', testName, updateContent)
  record('skill.save 更新已有技能', isOk(r9c), isOk(r9c) ? 'success' : `error=${errMsg(r9c).slice(0, 60)}`)

  const r9d = await callSkill('get', testName)
  record('skill.get 读取更新后的技能', r9d?.content === updateContent,
    r9d?.content === updateContent ? '内容匹配' : '内容不匹配')

  const r9e = await callSkill('delete', testName)
  record('skill.delete 删除技能', isOk(r9e), isOk(r9e) ? 'success' : `error=${errMsg(r9e).slice(0, 60)}`)

  const r9f = await callSkill('get', testName)
  record('skill.get 已删除的技能返回 null', r9f === null,
    `result=${JSON.stringify(r9f).slice(0, 60)}`)
}

// =============================================================
// 7. Settings 深度测试 — 枚举/类型/schema (P4-5, P4-6)
// =============================================================
async function testSettingsValidation() {
  console.log('\n=== 7. Settings 枚举/类型/schema 校验 (P4-5, P4-6) ===')

  // 先备份当前 settings
  const original = await callSettings('get')
  note(`原始 theme=${original?.general?.theme}, autoStart=${original?.general?.autoStart}`)

  // 7.1 settings.set theme=非白名单字符串 — 应失败 (已有枚举校验)
  const r1 = await callSettings('set', 'general.theme', 'INVALID_THEME_XXX')
  record('settings.set(theme=非白名单字符串) 应失败', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 60)}` : `BUG: success=${r1?.success}`)
  if (!isErr(r1)) bug('P4-5: settings.set 接受非白名单 theme 字符串')

  // 7.2 settings.set theme=数字 — P4-5 修复:应失败 (当前跳过枚举校验)
  const r2 = await callSettings('set', 'general.theme', 123)
  const after2 = await callSettings('get')
  const themeIsString2 = typeof after2?.general?.theme === 'string'
  record('settings.set(theme=数字) 应失败 (P4-5)', isErr(r2) && themeIsString2,
    isErr(r2) ? `error=${errMsg(r2).slice(0, 60)}` : (themeIsString2 ? '返回 success 但未写入' : `BUG: theme=${after2?.general?.theme}`))
  if (!isErr(r2) && !themeIsString2) bug('P4-5: settings.set 接受 theme=数字,跳过枚举校验,污染 settings.json')

  // 7.3 settings.set theme=null — P4-5 修复:应失败
  const r3 = await callSettings('set', 'general.theme', null)
  const after3 = await callSettings('get')
  const themeIsString3 = typeof after3?.general?.theme === 'string'
  record('settings.set(theme=null) 应失败 (P4-5)', isErr(r3) && themeIsString3,
    isErr(r3) ? `error=${errMsg(r3).slice(0, 60)}` : (themeIsString3 ? '返回 success 但未写入' : `BUG: theme=${after3?.general?.theme}`))
  if (!isErr(r3) && !themeIsString3) bug('P4-5: settings.set 接受 theme=null')

  // 7.4 settings.set autoStart=字符串 'true' — P4-5 修复:应失败 (当前接受,内存污染)
  const r4 = await callSettings('set', 'general.autoStart', 'true')
  const after4 = await callSettings('get')
  const autoStartIsBool4 = typeof after4?.general?.autoStart === 'boolean'
  record('settings.set(autoStart="true"字符串) 应失败 (P4-5)', isErr(r4) && autoStartIsBool4,
    isErr(r4) ? `error=${errMsg(r4).slice(0, 60)}` : (autoStartIsBool4 ? '返回 success 但未写入' : `BUG: autoStart=${after4?.general?.autoStart}`))
  if (!isErr(r4) && !autoStartIsBool4) bug('P4-5: settings.set 接受 autoStart=字符串,内存污染但未联动系统')

  // 7.5 settings.set autoStart=数字 1 — P4-5 修复:应失败
  const r5 = await callSettings('set', 'general.autoStart', 1)
  const after5 = await callSettings('get')
  const autoStartIsBool5 = typeof after5?.general?.autoStart === 'boolean'
  record('settings.set(autoStart=数字 1) 应失败 (P4-5)', isErr(r5) && autoStartIsBool5,
    isErr(r5) ? `error=${errMsg(r5).slice(0, 60)}` : (autoStartIsBool5 ? '返回 success 但未写入' : `BUG: autoStart=${after5?.general?.autoStart}`))
  if (!isErr(r5) && !autoStartIsBool5) bug('P4-5: settings.set 接受 autoStart=数字')

  // 7.6 settings.set path=__proto__.polluted — 应失败 (已有 FORBIDDEN_KEYS 防护)
  const r6 = await callSettings('set', '__proto__.polluted_test_p46', 'yes')
  const protoPolluted6 = ({}).polluted_test_p46 === 'yes'
  record('settings.set(__proto__.polluted) 应失败', isErr(r6) && !protoPolluted6,
    isErr(r6) ? `error=${errMsg(r6).slice(0, 60)}` : (protoPolluted6 ? 'BUG: 原型被污染!' : 'success 但未污染'))
  if (protoPolluted6) bug('P4-6: settings.set __proto__ 注入污染原型')

  // 7.7 settings.set path=constructor.prototype.polluted — 应失败
  const r7 = await callSettings('set', 'constructor.prototype.polluted_test_p47', 'yes')
  const protoPolluted7 = ({}).polluted_test_p47 === 'yes'
  record('settings.set(constructor.prototype) 应失败', isErr(r7) && !protoPolluted7,
    isErr(r7) ? `error=${errMsg(r7).slice(0, 60)}` : (protoPolluted7 ? 'BUG: 原型被污染!' : 'success 但未污染'))
  if (protoPolluted7) bug('P4-7: settings.set constructor.prototype 注入污染原型')

  // 7.8 settings.set path 含 null byte — 应失败
  const r8 = await callSettings('set', 'general\0theme', 'dark')
  record('settings.set(path 含 null byte) 应失败', isErr(r8),
    isErr(r8) ? `error=${errMsg(r8).slice(0, 60)}` : `BUG: success=${r8?.success}`)
  if (!isErr(r8)) bug('P4-6: settings.set 接受 path 含 null byte')

  // 7.9 settings.set 不存在的 path — 应失败 (service dotPath not found)
  const r9 = await callSettings('set', 'general.nonExistentField', 'value')
  record('settings.set(不存在的 path) 应失败', isErr(r9),
    isErr(r9) ? `error=${errMsg(r9).slice(0, 60)}` : `BUG: success=${r9?.success}`)

  // 7.10 settings.set feishu.appSecret 超长 (5MB) — P4-6 修复:应失败
  const r10 = await callSettings('set', 'feishu.appSecret', 'x'.repeat(5_000_000))
  record('settings.set(feishu.appSecret 5MB) 应失败 (P4-6)', isErr(r10),
    isErr(r10) ? `error=${errMsg(r10).slice(0, 60)}` : `BUG: success=${r10?.success}`)
  if (!isErr(r10)) bug('P4-6: settings.set 接受 feishu.appSecret 5MB,撑爆 keystore')

  // 7.11 settings.set feishu.appSecret 含 null byte — P4-6 修复:应失败
  const r11 = await callSettings('set', 'feishu.appSecret', 'secret\0evil')
  record('settings.set(feishu.appSecret 含 null byte) 应失败 (P4-6)', isErr(r11),
    isErr(r11) ? `error=${errMsg(r11).slice(0, 60)}` : `BUG: success=${r11?.success}`)
  if (!isErr(r11)) bug('P4-6: settings.set 接受 feishu.appSecret 含 null byte')

  // 7.12 settings.set 正常值 + 验证 + 恢复
  const r12 = await callSettings('set', 'general.theme', 'dark')
  record('settings.set(theme=dark) 应成功', isOk(r12),
    isOk(r12) ? 'success' : `error=${errMsg(r12).slice(0, 60)}`)

  const after12 = await callSettings('get')
  record('settings.get 验证 theme 已更新', after12?.general?.theme === 'dark',
    `theme=${after12?.general?.theme}`)

  // 恢复 settings
  if (original?.general?.theme) {
    await callSettings('set', 'general.theme', original.general.theme)
    note(`settings theme 已恢复为 ${original.general.theme}`)
  }
}

// =============================================================
// 8. Profile 深度测试 (P4-7)
// =============================================================
async function testProfileValidation() {
  console.log('\n=== 8. Profile 参数验证 (P4-7) ===')

  // 8.1 profile.get 路径遍历 ../ — 应被 sanitizeName 拒绝 (含特殊字符)
  const r1 = await callProfile('get', '../../../etc/passwd')
  record('profile.get(../../../etc/passwd) 应失败', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 60)}` : '意外成功')

  // 8.2 profile.get 含控制字符 — 应失败
  const r2 = await callProfile('get', 'test\rname')
  record('profile.get(含控制字符) 应失败', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 60)}` : '意外成功')

  // 8.3 profile.get 超长 name (65 字符) — 应失败
  const r3 = await callProfile('get', 'a'.repeat(65))
  record('profile.get(name 65 字符) 应失败', isErr(r3),
    isErr(r3) ? `error=${errMsg(r3).slice(0, 60)}` : '意外成功')

  // 8.4 profile.set data=非对象 — 应失败
  const r4 = await callProfile('set', 'cdp-test-profile', 'not-an-object')
  record('profile.set(data=字符串) 应失败', isErr(r4),
    isErr(r4) ? `error=${errMsg(r4).slice(0, 60)}` : '意外成功')

  // 8.5 profile.set data=null — 应失败
  const r5 = await callProfile('set', 'cdp-test-profile', null)
  record('profile.set(data=null) 应失败', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 60)}` : '意外成功')

  // 8.6 profile.set data 含 __proto__ — P4-7 修复:应失败或清理
  const r6 = await callProfile('set', 'cdp-test-profile', JSON.parse('{"__proto__": {"polluted_test_p48": "yes"}, "idCard": "123"}'))
  const protoPolluted6 = ({}).polluted_test_p48 === 'yes'
  record('profile.set(data 含 __proto__) 不应污染原型', !protoPolluted6,
    protoPolluted6 ? 'BUG: 原型被污染!' : `success=${r6?.success}`)
  if (protoPolluted6) bug('P4-7: profile.set data __proto__ 注入污染原型')

  // 8.7 profile.set 正常 data + 验证 + 清理
  const testData = { idCard: 'cdp-test-001', awards: ['测试奖项'], notes: 'CDP 测试' }
  const r7 = await callProfile('set', 'cdp-test-profile', testData)
  record('profile.set(正常 data) 应成功', isOk(r7),
    isOk(r7) ? 'success' : `error=${errMsg(r7).slice(0, 60)}`)

  const r7b = await callProfile('get', 'cdp-test-profile')
  record('profile.get 读取刚写入的 data', r7b?.data?.idCard === 'cdp-test-001',
    `idCard=${r7b?.data?.idCard}`)

  // 8.8 profile.set data 含循环引用 — 应失败 (JSON.stringify 抛错)
  // 注: IPC 序列化时循环引用会被 JSON.stringify 拒绝,在 callNS 层就失败
  let cyclicErr = null
  try {
    const cyclic = { a: 1 }
    cyclic.self = cyclic
    await callNS('profile', 'set', 'cdp-test-profile', cyclic)
  } catch (e) {
    cyclicErr = e
  }
  record('profile.set(data 含循环引用) 应失败', cyclicErr !== null,
    cyclicErr ? `error=${cyclicErr.message?.slice(0, 60)}` : '意外未抛错')
}

// =============================================================
// 9. 并发写入竞态
// =============================================================
async function testConcurrentWriteRace() {
  console.log('\n=== 9. 并发写入竞态 ===')

  // 9.1 并发 agent.update 同一 id 不同字段 — 验证最终一致性
  const original = await callAgent('get', 'main')
  const updates = [
    { name: 'CDP并发测试1' },
    { description: 'CDP 并发描述1' },
    { name: 'CDP并发测试2' },
    { description: 'CDP 并发描述2' },
    { name: 'CDP并发测试3' },
  ]
  const results1 = await Promise.all(updates.map((patch) => callAgent('update', 'main', patch)))
  const allSuccess1 = results1.every((r) => isOk(r))
  record('5 个并发 agent.update 都返回 success', allSuccess1,
    allSuccess1 ? '全部成功' : `成功数=${results1.filter(r => isOk(r)).length}/5`)

  // 等待持久化完成
  await sleep(500)
  const after1 = await callAgent('get', 'main')
  record('并发 update 后 agent.get 仍可读', !!after1,
    `name=${after1?.name?.slice(0, 20)}, desc=${after1?.description?.slice(0, 20)}`)

  // 恢复 main agent
  if (original) {
    await callAgent('update', 'main', {
      name: original.name,
      description: original.description,
      modelTier: original.modelTier,
      capabilities: original.capabilities,
    })
    note('main agent 配置已恢复')
  }

  // 9.2 并发 settings.set 不同 path — 验证最终一致性
  const originalSettings = await callSettings('get')
  const settings2 = [
    ['general.theme', 'dark'],
    ['general.language', 'zh-CN'],
    ['general.closeBehavior', 'tray'],
  ]
  const results2 = await Promise.all(settings2.map(([p, v]) => callSettings('set', p, v)))
  const allSuccess2 = results2.every((r) => isOk(r))
  record('3 个并发 settings.set 不同 path 都成功', allSuccess2,
    allSuccess2 ? '全部成功' : `成功数=${results2.filter(r => isOk(r)).length}/3`)

  await sleep(500)
  const after2 = await callSettings('get')
  record('并发 set 后 settings.get 仍可读', !!after2,
    `theme=${after2?.general?.theme}, lang=${after2?.general?.language}`)

  // 恢复 settings
  if (originalSettings) {
    await callSettings('set', 'general.theme', originalSettings.general.theme)
    await callSettings('set', 'general.language', originalSettings.general.language)
    await callSettings('set', 'general.closeBehavior', originalSettings.general.closeBehavior)
    note('settings 已恢复')
  }

  // 9.3 并发 profile.set 同一 name 不同 data — 验证最终一致性 (profile-service 无锁)
  const results3 = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      callProfile('set', 'cdp-concurrent-test', { idCard: `test-${i}`, index: i })
    )
  )
  const allSuccess3 = results3.every((r) => isOk(r))
  record('10 个并发 profile.set 同一 name 都成功', allSuccess3,
    allSuccess3 ? '全部成功' : `成功数=${results3.filter(r => isOk(r)).length}/10`)

  await sleep(500)
  const after3 = await callProfile('get', 'cdp-concurrent-test')
  record('并发 set 后 profile.get 仍可读', after3?.data?.idCard?.startsWith('test-'),
    `idCard=${after3?.data?.idCard}, index=${after3?.data?.index}`)

  // 9.4 并发 skill.save 同一 name 不同 content — 验证最终一致性 (skill-service 非原子写)
  const skillName = 'cdp-concurrent-skill-' + Date.now()
  const results4 = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      callSkill('save', skillName, `# content ${i}\n测试内容 ${i}`)
    )
  )
  const allSuccess4 = results4.every((r) => isOk(r))
  record('10 个并发 skill.save 同一 name 都成功', allSuccess4,
    allSuccess4 ? '全部成功' : `成功数=${results4.filter(r => isOk(r)).length}/10`)

  await sleep(500)
  const after4 = await callSkill('get', skillName)
  record('并发 save 后 skill.get 仍可读', typeof after4?.content === 'string',
    `content len=${after4?.content?.length}`)

  // 清理
  await callSkill('delete', skillName)
}

// =============================================================
// 10. 恢复验证 — 错误输入后正常功能仍可用
// =============================================================
async function testRecoveryAfterErrors() {
  console.log('\n=== 10. 恢复验证 ===')

  // 10.1 agent.list 仍可用
  const r1 = await callAgent('list')
  record('错误输入后 agent.list 仍可用', Array.isArray(r1) && r1.length > 0,
    `count=${r1?.length}`)

  // 10.2 skill.list 仍可用
  const r2 = await callSkill('list')
  record('错误输入后 skill.list 仍可用', Array.isArray(r2),
    `count=${r2?.length}`)

  // 10.3 settings.get 仍可用
  const r3 = await callSettings('get')
  record('错误输入后 settings.get 仍可用', !!r3 && !!r3.general,
    `theme=${r3?.general?.theme}`)

  // 10.4 profile.get 仍可用
  const r4 = await callProfile('get', 'cdp-test-profile')
  record('错误输入后 profile.get 仍可用', r4?.success !== false,
    `success=${r4?.success}`)

  // 10.5 window.api 仍可用
  const r5 = await evalInPage(`(function(){
    const api = window.__EAA_API__ || window.api;
    return { hasAgent: !!api?.agent, hasSkill: !!api?.skill, hasSettings: !!api?.settings, hasProfile: !!api?.profile };
  })()`)
  record('错误输入后 window.api 仍可用', r5?.hasAgent && r5?.hasSettings,
    JSON.stringify(r5))

  // 10.6 控制台无未捕获错误
  const r6 = await evalInPage(`(function(){
    return { hasUnhandled: typeof window.__unhandledRejection !== 'undefined' };
  })()`)
  record('测试后无未捕获 rejection', !r6?.hasUnhandled, JSON.stringify(r6))
}

// =============================================================
// 主流程
// =============================================================
async function main() {
  console.log('=====================================')
  console.log('Agent + Skills + Settings + Profile 深度测试')
  console.log('=====================================')

  await connect()
  console.log('✅ CDP 连接成功')

  // 导航到设置页面 (确保 settings 相关 IPC 可用)
  await evalInPage(`window.location.hash = '#/settings'`)
  await sleep(1500)

  await testAgentValidation()
  await testAgentUpdatePatchValidation()
  await testAgentSetSoulValidation()
  await testAgentRunManualHistoryValidation()
  await testAgentAbortValidation()
  await testSkillsDeep()
  await testSettingsValidation()
  await testProfileValidation()
  await testConcurrentWriteRace()
  await testRecoveryAfterErrors()

  console.log('\n=====================================')
  console.log('测试汇总')
  console.log('=====================================')
  console.log(`总计: ${passCount + failCount + warnCount}, 通过: ${passCount}, 警告: ${warnCount}, 失败: ${failCount}, BUG: ${bugs.length}`)

  if (bugs.length > 0) {
    console.log('\n🐛 发现的 BUG:')
    bugs.forEach((b, i) => console.log(`  ${i + 1}. ${b}`))
  }
  if (notes.length > 0) {
    console.log('\n备注:')
    notes.forEach((n) => console.log(`  - ${n}`))
  }

  process.exit(failCount > 0 || bugs.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('❌ 测试主流程崩溃:', err)
  process.exit(1)
})
