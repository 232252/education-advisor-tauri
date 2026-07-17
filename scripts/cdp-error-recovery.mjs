// =============================================================
// CDP 错误恢复测试 — 异常输入/边界值/资源耗尽/注入防护
// 角度: 各种畸形/极端输入下应用不崩溃,且回复正常
// 运行: node scripts/cdp-error-recovery.mjs
// =============================================================
import http from 'node:http'
import WebSocket from 'ws'

const CDP_HOST = 'http://127.0.0.1:9222'

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
const callAI = (m, ...a) => callNS('ai', m, ...a)
const callChat = (m, ...a) => callNS('chat', m, ...a)
const callAgent = (m, ...a) => callNS('agent', m, ...a)
const callSettings = (m, ...a) => callNS('settings', m, ...a)
const callEAA = (m, ...a) => callNS('eaa', m, ...a)
const callProfile = (m, ...a) => callNS('profile', m, ...a)
const callSkill = (m, ...a) => callNS('skill', m, ...a)
const callCron = (m, ...a) => callNS('cron', m, ...a)
const callSys = (m, ...a) => callNS('sys', m, ...a)

const isOk = (r) => !!r && r.__error === undefined && r.success === true
const isErr = (r) => !!r && (r.__error !== undefined || r.success === false)
const errMsg = (r) => r.__error || r.error || r.message || 'unknown error'

// =============================================================
// 1. 特殊字符 — Unicode/emoji/控制字符在字符串字段
// =============================================================
async function testSpecialChars() {
  console.log('\n=== 1. 特殊字符 — Unicode/emoji/控制字符 ===')

  // 1.1 emoji 在 saveMessage content
  const r1 = await callChat('saveMessage', {
    sessionId: `emoji_${Date.now()}`,
    role: 'user',
    content: '你好世界 🌍🎉👨‍👩‍👧‍👦 中文测试',
  })
  record('saveMessage 含 emoji 不崩溃', typeof r1 === 'object',
    `success=${r1?.success}, id=${r1?.id}`)
  if (r1?.id >= 0) {
    // 清理
    await callChat('deleteSession', `emoji_${Date.now() - 0}`)
  }

  // 1.2 Unicode 多语言
  const r2 = await callChat('saveMessage', {
    sessionId: `uni_${Date.now()}`,
    role: 'user',
    content: '日本語テスト 한국어 테스트 العربية עברית Русский',
  })
  record('saveMessage 含多语言 Unicode 不崩溃', typeof r2 === 'object',
    `success=${r2?.success}, id=${r2?.id}`)

  // 1.3 特殊字符在自定义模型 name
  const r3 = await callAI('addCustomModel', {
    providerId: 'google',
    modelId: `__emoji_test_${Date.now().toString(36)}__`,
    name: '🤖 AI 模型 "引用" <script>alert(1)</script>',
    contextWindow: 8192,
  })
  record('addCustomModel name 含 emoji + HTML 不崩溃', typeof r3 === 'object',
    `type=${typeof r3}`)
  if (r3 && typeof r3 === 'object' && !r3.__error) {
    await callAI('deleteCustomModel', 'google', `__emoji_test_${Date.now().toString(36)}__`)
  }

  // 1.4 制表符/换行符
  const r4 = await callChat('saveMessage', {
    sessionId: `tab_${Date.now()}`,
    role: 'user',
    content: 'line1\nline2\ttabbed\r\nwindows',
  })
  record('saveMessage 含 \\n\\t\\r 不崩溃', typeof r4 === 'object',
    `success=${r4?.success}, id=${r4?.id}`)
}

// =============================================================
// 2. 边界值 — 极长字符串
// =============================================================
async function testBoundaryLengths() {
  console.log('\n=== 2. 边界值 — 极长字符串 ===')

  // 2.1 content 接近 10MB 上限 (validateStringAllowEmpty maxLen = 10_000_000)
  const largeContent = 'x'.repeat(1_000_000) // 1MB
  const r1 = await callChat('saveMessage', {
    sessionId: `large_${Date.now()}`,
    role: 'user',
    content: largeContent,
  })
  record('saveMessage content 1MB 不崩溃', typeof r1 === 'object',
    `success=${r1?.success}, id=${r1?.id}`)

  // 2.2 content 超过 10MB — 应失败
  const hugeContent = 'x'.repeat(11_000_000) // 11MB
  const r2 = await callChat('saveMessage', {
    sessionId: `huge_${Date.now()}`,
    role: 'user',
    content: hugeContent,
  })
  record('saveMessage content 11MB 应失败', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 80)}` : '意外成功(可能未限制)')

  // 2.3 providerId 刚好 256 字符 — 应成功通过验证
  const r3 = await callAI('listModels', 'a'.repeat(256))
  record('listModels(providerId=256 字符) 不崩溃',
    Array.isArray(r3) || isErr(r3),
    Array.isArray(r3) ? `count=${r3.length}` : `error=${errMsg(r3).slice(0, 60)}`)

  // 2.4 providerId 257 字符 — 应失败
  const r4 = await callAI('listModels', 'a'.repeat(257))
  record('listModels(providerId=257 字符) 应失败', isErr(r4),
    isErr(r4) ? `error=${errMsg(r4).slice(0, 80)}` : '意外成功')

  // 2.5 saveMessage role 超过 64 字符 — 应失败
  const r5 = await callChat('saveMessage', {
    sessionId: 'test',
    role: 'x'.repeat(100),
    content: 'test',
  })
  record('saveMessage(role=100 字符) 应失败', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 80)}` : '意外成功')
}

// =============================================================
// 3. SQL 注入尝试 — 在学生名/会话 id 字段
// =============================================================
async function testSQLInjection() {
  console.log('\n=== 3. SQL 注入尝试 ===')

  // 3.1 经典 SQL 注入 payload 在 sessionId
  const sqlPayloads = [
    "'; DROP TABLE messages; --",
    "' OR '1'='1",
    "'; INSERT INTO users VALUES('admin','pass'); --",
    "' UNION SELECT * FROM messages --",
    "1'; EXEC xp_cmdshell('dir') --",
  ]

  for (let i = 0; i < sqlPayloads.length; i++) {
    const payload = sqlPayloads[i]
    const r = await callChat('saveMessage', {
      sessionId: payload,
      role: 'user',
      content: 'injection test',
    })
    record(`saveMessage(sessionId=SQL注入 #${i + 1}) 不崩溃`, typeof r === 'object',
      `success=${r?.success}, id=${r?.id}`)
  }

  // 3.2 验证 messages 表仍存在(没被 DROP)
  const afterCheck = await callChat('loadMessages', 'default')
  record('SQL 注入后 messages 表仍可查询', afterCheck && typeof afterCheck === 'object',
    `success=${afterCheck?.success}, msgCount=${afterCheck?.messages?.length ?? -1}`)
}

// =============================================================
// 4. 原型链污染尝试
// =============================================================
async function testProtoPollution() {
  console.log('\n=== 4. 原型链污染尝试 ===')

  // 4.1 __proto__ 在 params 中
  const r1 = await callAI('addCustomModel', {
    providerId: 'google',
    modelId: 'test',
    __proto__: { polluted: true },
  })
  record('addCustomModel(__proto__ 注入) 不崩溃', typeof r1 === 'object',
    `type=${typeof r1}`)

  // 4.2 constructor.prototype
  const r2 = await callAI('addCustomModel', {
    providerId: 'google',
    modelId: 'test2',
    constructor: { prototype: { polluted: true } },
  })
  record('addCustomModel(constructor 注入) 不崩溃', typeof r2 === 'object',
    `type=${typeof r2}`)

  // 4.3 验证 Object.prototype 未被污染
  const polluted = await evalInPage(`(function(){
    return { 
      hasPolluted: 'polluted' in {},
      hasConstructor: typeof {}.constructor,
    };
  })()`)
  record('Object.prototype 未被污染', !polluted.hasPolluted,
    `hasPolluted=${polluted.hasPolluted}`)
}

// =============================================================
// 5. 无效路由 — 访问不存在的路由
// =============================================================
async function testInvalidRoutes() {
  console.log('\n=== 5. 无效路由 ===')

  // 5.1 不存在的路由
  await evalInPage(`window.location.hash = '#/non-existent-route-xxx'`)
  await sleep(800)

  const r1 = await evalInPage(`(function(){
    const root = document.getElementById('root');
    return {
      hasContent: !!(root && root.children.length > 0),
      hasErrorBoundary: !!document.querySelector('[class*="error"]'),
      bodyText: (document.body.textContent || '').slice(0, 200),
    };
  })()`)
  record('访问无效路由不崩溃', r1.hasContent,
    `hasContent=${r1.hasContent}, bodyText="${r1.bodyText.slice(0, 80)}"`)

  // 5.2 路由带特殊字符
  await evalInPage(`window.location.hash = '#/<script>alert(1)</script>'`)
  await sleep(500)
  const r2 = await evalInPage(`(function(){
    const root = document.getElementById('root');
    return { hasContent: !!(root && root.children.length > 0) };
  })()`)
  record('路由含 <script> 不崩溃', r2.hasContent, '')

  // 5.3 极长路由
  await evalInPage(`window.location.hash = '#/${'x'.repeat(1000)}'`)
  await sleep(500)
  const r3 = await evalInPage(`(function(){
    const root = document.getElementById('root');
    return { hasContent: !!(root && root.children.length > 0) };
  })()`)
  record('极长路由不崩溃', r3.hasContent, '')

  // 5.4 回到正常路由
  await evalInPage(`window.location.hash = '#/dashboard'`)
  await sleep(800)
  const r4 = await evalInPage(`(function(){
    const root = document.getElementById('root');
    return { hasContent: !!(root && root.children.length > 0) };
  })()`)
  record('回到正常路由应用正常', r4.hasContent, '')
}

// =============================================================
// 6. 异常类型 — 传错类型给期望特定类型的 IPC
// =============================================================
async function testTypeMismatch() {
  console.log('\n=== 6. 异常类型 — 传错类型 ===')

  // 6.1 agent.toggle(id='main', enabled='not-bool')
  const r1 = await callAgent('toggle', 'main', 'yes')
  record('agent.toggle(enabled=字符串) 应失败', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 80)}` : '意外成功')

  // 6.2 agent.toggle(id=数字)
  const r2 = await callAgent('toggle', 123, true)
  record('agent.toggle(id=数字) 应失败', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 80)}` : '意外成功')

  // 6.3 agent.update(id, patch=字符串)
  const r3 = await callAgent('update', 'main', 'not-an-object')
  record('agent.update(patch=字符串) 应失败', isErr(r3),
    isErr(r3) ? `error=${errMsg(r3).slice(0, 80)}` : '意外成功')

  // 6.4 settings.set(path=数字, value=任何)
  const r4 = await callSettings('set', 12345, 'value')
  record('settings.set(path=数字) 不崩溃', typeof r4 === 'object',
    `success=${r4?.success}`)

  // 6.5 settings.set(path=对象)
  const r5 = await callSettings('set', { foo: 'bar' }, 'value')
  record('settings.set(path=对象) 不崩溃', typeof r5 === 'object',
    `success=${r5?.success}`)

  // 6.6 eaa.score(name=数字)
  const r6 = await callEAA('score', 12345)
  record('eaa.score(name=数字) 不崩溃', typeof r6 === 'object',
    `type=${typeof r6}`)

  // 6.7 eaa.search(query=null)
  const r7 = await callEAA('search', null)
  record('eaa.search(query=null) 不崩溃', typeof r7 === 'object',
    `type=${typeof r7}`)

  // 6.8 cron.add(task=字符串)
  const r8 = await callCron('add', 'not-an-object')
  record('cron.add(task=字符串) 不崩溃', typeof r8 === 'object',
    `success=${r8?.success}`)
}

// =============================================================
// 7. 大 payload — 大量数据传输
// =============================================================
async function testLargePayload() {
  console.log('\n=== 7. 大 payload — 大量数据传输 ===')

  // 7.1 chat.saveMessage content 5MB (在 10MB 上限内)
  const content5MB = 'A'.repeat(5 * 1024 * 1024)
  const t0 = Date.now()
  const r1 = await callChat('saveMessage', {
    sessionId: `big5mb_${Date.now()}`,
    role: 'user',
    content: content5MB,
  })
  const elapsed1 = Date.now() - t0
  record('saveMessage 5MB content 不崩溃', typeof r1 === 'object',
    `success=${r1?.success}, id=${r1?.id}, elapsed=${elapsed1}ms`)

  // 7.2 messages 数组 1000 条 (用于 ai.chat)
  const messages = []
  for (let i = 0; i < 1000; i++) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` })
  }
  const r2 = await callAI('chat', {
    providerId: 'test',
    modelId: 'test',
    messages,
  })
  record('ai.chat 1000 条 messages 不崩溃', typeof r2 === 'object',
    `success=${r2?.success}`)

  // 7.3 agent.runManual history 1000 条
  const history = []
  for (let i = 0; i < 1000; i++) {
    history.push({ role: 'user', content: `history ${i}` })
  }
  const r3 = await callAgent('runManual', 'main', 'test prompt', history)
  record('agent.runManual 1000 条 history 不崩溃', typeof r3 === 'object',
    `success=${r3?.success}`)
}

// =============================================================
// 8. 空值/undefined 边界
// =============================================================
async function testNullUndefined() {
  console.log('\n=== 8. 空值/undefined 边界 ===')

  // 8.1 agent.get(undefined)
  const r1 = await callAgent('get', undefined)
  record('agent.get(undefined) 不崩溃', typeof r1 === 'object',
    `success=${r1?.success}`)

  // 8.2 agent.get(null)
  const r2 = await callAgent('get', null)
  record('agent.get(null) 不崩溃', typeof r2 === 'object',
    `success=${r2?.success}`)

  // 8.3 chat.saveMessage(msg=undefined)
  const r3 = await callChat('saveMessage', undefined)
  record('chat.saveMessage(undefined) 不崩溃', typeof r3 === 'object',
    `success=${r3?.success}`)

  // 8.4 chat.saveMessage(msg=null)
  const r4 = await callChat('saveMessage', null)
  record('chat.saveMessage(null) 不崩溃', typeof r4 === 'object',
    `success=${r4?.success}`)

  // 8.5 chat.saveMessage(msg={}) - 缺必填字段
  const r5 = await callChat('saveMessage', {})
  record('chat.saveMessage(空对象) 不崩溃', typeof r5 === 'object',
    `success=${r5?.success}`)

  // 8.6 skill.get(undefined)
  const r6 = await callSkill('get', undefined)
  record('skill.get(undefined) 不崩溃', typeof r6 === 'object',
    `type=${typeof r6}`)

  // 8.7 profile.get(undefined)
  const r7 = await callProfile('get', undefined)
  record('profile.get(undefined) 不崩溃', typeof r7 === 'object',
    `type=${typeof r7}`)
}

// =============================================================
// 9. 快速连续操作 — 状态机压力
// =============================================================
async function testRapidStateChanges() {
  console.log('\n=== 9. 快速连续操作 — 状态机压力 ===')

  // 9.1 快速连续 addCustomModel + deleteCustomModel 同一 id
  const modelId = `__rapid_${Date.now().toString(36)}__`
  const operations = []
  for (let i = 0; i < 20; i++) {
    if (i % 2 === 0) {
      operations.push(callAI('addCustomModel', {
        providerId: 'google', modelId, name: `rapid ${i}`, contextWindow: 8192,
      }))
    } else {
      operations.push(callAI('deleteCustomModel', 'google', modelId))
    }
  }
  const results = await Promise.all(operations)
  record('20 个快速 add/delete 不崩溃',
    results.every(r => r && typeof r === 'object'),
    `types=${[...new Set(results.map(r => typeof r))].join(',')}`)

  // 清理可能残留
  await callAI('deleteCustomModel', 'google', modelId)
  await sleep(200)

  // 9.2 快速连续 chat saveMessage + deleteSession
  const sessionId = `rapid_session_${Date.now().toString(36)}`
  const chatOps = []
  for (let i = 0; i < 10; i++) {
    chatOps.push(callChat('saveMessage', {
      sessionId, role: 'user', content: `rapid ${i}`,
    }))
  }
  const chatResults = await Promise.all(chatOps)
  record('10 个快速 saveMessage 不崩溃',
    chatResults.every(r => r && typeof r === 'object'),
    `successCount=${chatResults.filter(r => r?.id >= 0).length}`)

  await callChat('deleteSession', sessionId)
}

// =============================================================
// 10. 恢复验证 — 错误输入后正常功能仍可用
// =============================================================
async function testRecoveryAfterErrors() {
  console.log('\n=== 10. 恢复验证 — 错误输入后正常功能仍可用 ===')

  // 先发起一堆错误调用
  for (let i = 0; i < 10; i++) {
    await callAI('listModels', '') // 空字符串错误
    await callChat('saveMessage', null) // null 错误
  }

  // 验证正常调用仍工作
  const r1 = await callAI('listProviders')
  record('错误输入后 listProviders 仍可用', Array.isArray(r1),
    `count=${Array.isArray(r1) ? r1.length : 'N/A'}`)

  const r2 = await callAgent('list')
  record('错误输入后 agent.list 仍可用', Array.isArray(r2),
    `count=${Array.isArray(r2) ? r2.length : 'N/A'}`)

  const r3 = await callAI('listModels', 'google')
  record('错误输入后 listModels(google) 仍可用', Array.isArray(r3),
    `count=${Array.isArray(r3) ? r3.length : 'N/A'}`)

  const r4 = await callChat('listSessions')
  record('错误输入后 chat.listSessions 仍可用', r4 && typeof r4 === 'object',
    `success=${r4?.success}`)

  const r5 = await callSettings('get')
  record('错误输入后 settings.get 仍可用', r5 && typeof r5 === 'object',
    `hasModels=${!!r5?.models}`)

  // 应用未崩溃
  const notCrashed = await evalInPage(`(function(){
    const root = document.getElementById('root');
    return !!(root && root.children.length > 0);
  })()`)
  record('错误输入后应用未崩溃', notCrashed, '')
}

// =============================================================
// 11. 路径遍历尝试
// =============================================================
async function testPathTraversal() {
  console.log('\n=== 11. 路径遍历尝试 ===')

  // 11.1 sys.openExternal 路径遍历
  const r1 = await callSys('openExternal', '../../../etc/passwd')
  record('sys.openExternal(路径遍历) 不崩溃', typeof r1 === 'object',
    `success=${r1?.success}`)

  // 11.2 sys.openExternal file:// 协议
  const r2 = await callSys('openExternal', 'file:///etc/passwd')
  record('sys.openExternal(file://) 不崩溃', typeof r2 === 'object',
    `success=${r2?.success}`)

  // 11.3 sys.openExternal javascript:
  const r3 = await callSys('openExternal', 'javascript:alert(1)')
  record('sys.openExternal(javascript:) 不崩溃', typeof r3 === 'object',
    `success=${r3?.success}`)

  // 11.4 sys.getPath 路径遍历
  const r4 = await callSys('getPath', '../../../etc/passwd')
  record('sys.getPath(路径遍历) 不崩溃', typeof r4 === 'object',
    `type=${typeof r4}`)
}

// =============================================================
// 12. 极端并发错误 — 100 个并发错误请求
// =============================================================
async function testExtremeErrorConcurrency() {
  console.log('\n=== 12. 极端并发错误 (100 个并发错误请求) ===')

  const t0 = Date.now()
  const promises = []
  for (let i = 0; i < 100; i++) {
    // 交替发送错误请求
    if (i % 3 === 0) promises.push(callAI('listModels', ''))
    else if (i % 3 === 1) promises.push(callChat('saveMessage', null))
    else promises.push(callAgent('get', ''))
  }
  const results = await Promise.all(promises)
  const elapsed = Date.now() - t0

  record('100 个并发错误请求全部不崩溃',
    results.every(r => r && typeof r === 'object'),
    `elapsed=${elapsed}ms`)

  // 验证大部分返回错误(而非成功)
  const errorCount = results.filter(r => r.__error || r.success === false).length
  record('大部分错误请求返回错误响应', errorCount >= 90,
    `errorCount=${errorCount}/100`)

  note(`100 并发错误请求总耗时 ${elapsed}ms`)
}

// =============================================================
// 13. 控制台错误监控 — 整个测试期间
// =============================================================
async function testConsoleErrorsDuringTest() {
  console.log('\n=== 13. 控制台错误监控 ===')

  // 启用监听
  await send('Runtime.enable')
  const errors = []
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString())
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        const args = m.params.args.map(a => a.value || a.description || '').join(' ')
        errors.push(args)
      }
    } catch {}
  })

  // 触发一些操作
  await evalInPage(`window.location.hash = '#/dashboard'`)
  await sleep(1000)
  await callAI('listProviders')

  await sleep(500)

  // 不要求 0 错误(因为错误注入测试本身可能触发主进程 console.error),
  // 但要求应用未崩溃
  const notCrashed = await evalInPage(`(function(){
    const root = document.getElementById('root');
    return !!(root && root.children.length > 0);
  })()`)

  record('测试后应用未崩溃', notCrashed, `consoleErrors=${errors.length}`)

  if (errors.length > 0) {
    note(`控制台错误数: ${errors.length}, 前3个: ${errors.slice(0, 3).map(e => e.slice(0, 100)).join(' | ')}`)
  }
}

// =============================================================
// 主函数
// =============================================================
async function main() {
  console.log('=====================================')
  console.log('错误恢复测试 — 异常输入/边界值/资源耗尽')
  console.log('=====================================')

  await connect()
  console.log('✅ CDP 连接成功')

  await testSpecialChars()
  await testBoundaryLengths()
  await testSQLInjection()
  await testProtoPollution()
  await testInvalidRoutes()
  await testTypeMismatch()
  await testLargePayload()
  await testNullUndefined()
  await testRapidStateChanges()
  await testRecoveryAfterErrors()
  await testPathTraversal()
  await testExtremeErrorConcurrency()
  await testConsoleErrorsDuringTest()

  // 汇总
  console.log('\n=====================================')
  console.log('测试汇总')
  console.log('=====================================')
  const total = passCount + failCount + warnCount
  console.log(`总计: ${total}, 通过: ${passCount}, 警告: ${warnCount}, 失败: ${failCount}, BUG: ${bugs.length}`)
  if (bugs.length > 0) {
    console.log('\n🐛 发现的 BUG:')
    bugs.forEach((b, i) => console.log(`  ${i + 1}. ${b}`))
  }
  if (notes.length > 0) {
    console.log('\n备注:')
    notes.forEach((n) => console.log(`  - ${n}`))
  }

  process.exit(failCount > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('未捕获异常:', e)
  process.exit(2)
})
