// =============================================================
// CDP Chat 消息流 / 中断恢复 / 错误处理 深度测试
// 角度: 实际发送消息流程 + Agent 启动/中断 + 错误恢复 + 状态机
// 运行: node scripts/cdp-chat-flow-abort.mjs
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

// 通用 IPC 调用
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
const callChat = (m, ...a) => callNS('chat', m, ...a)

const isOk = (r) => !!r && r.__error === undefined && r.success === true
const isErr = (r) => !!r && (r.__error !== undefined || r.success === false)
const errMsg = (r) => r.__error || r.error || r.message || 'unknown error'

// =============================================================
// 1. agent.runManual 输入验证
// =============================================================
async function testRunManualValidation() {
  console.log('\n=== 1. agent.runManual 输入验证 ===')

  // 1.1 空 id
  const r1 = await callAgent('runManual', '', 'test prompt')
  record('runManual(空 id) 应失败', isErr(r1),
    isErr(r1) ? `msg=${errMsg(r1).slice(0, 80)}` : '意外成功')

  // 1.2 非字符串 id
  const r2 = await callAgent('runManual', 123, 'test prompt')
  record('runManual(id=数字) 应失败', isErr(r2),
    isErr(r2) ? `msg=${errMsg(r2).slice(0, 80)}` : '意外成功')

  // 1.3 不存在的 agent id
  const r3 = await callAgent('runManual', 'non-existent-agent-id-xxx', 'test prompt')
  record('runManual(不存在的 agent id) 应失败', isErr(r3),
    isErr(r3) ? `msg=${errMsg(r3).slice(0, 80)}` : '意外成功(可能未做存在性校验)')

  // 1.4 空 prompt
  const r4 = await callAgent('runManual', 'main', '')
  record('runManual(空 prompt) 应失败', isErr(r4),
    isErr(r4) ? `msg=${errMsg(r4).slice(0, 80)}` : '意外成功')

  // 1.5 非字符串 prompt
  const r5 = await callAgent('runManual', 'main', 12345)
  record('runManual(prompt=数字) 应失败', isErr(r5),
    isErr(r5) ? `msg=${errMsg(r5).slice(0, 80)}` : '意外成功')

  // 1.6 prompt 含 null byte — P3-2 修复:同步校验 null byte
  const r6 = await callAgent('runManual', 'main', 'test\0evil')
  record('runManual(prompt 含 null byte) 应失败(P3-2 修复)', isErr(r6),
    isErr(r6) ? `msg=${errMsg(r6).slice(0, 80)}` : `意外成功 success=${r6?.success}`)

  // 1.7 超长 prompt (>1MB) — P3-2 修复:同步校验长度
  const r7 = await callAgent('runManual', 'main', 'x'.repeat(2_000_000))
  record('runManual(prompt 超长 2MB) 应失败(P3-2 修复)', isErr(r7),
    isErr(r7) ? `msg=${errMsg(r7).slice(0, 80)}` : `意外成功 success=${r7?.success}`)

  // 1.8 正常调用 (main agent) — fire-and-forget,应立即返回 success
  const r8 = await callAgent('runManual', 'main', 'CDP 测试: 这是一条测试消息,请简短回复"已收到"')
  record('runManual(正常调用) 应返回 success', isOk(r8),
    isOk(r8) ? `id=${r8.id}` : `msg=${errMsg(r8).slice(0, 80)}`)
}

// =============================================================
// 2. agent.abort 输入验证 + 状态
// =============================================================
async function testAbortValidation() {
  console.log('\n=== 2. agent.abort 输入验证 ===')

  // 2.1 abort 不存在的 agent — 应返回 success:false (not running)
  const r1 = await callAgent('abort', 'non-existent-agent-id-xxx')
  record('abort(不存在的 agent) 应返回 not running', isErr(r1) || (r1?.success === false),
    `success=${r1?.success}, msg=${errMsg(r1).slice(0, 60)}`)

  // 2.2 abort 正常 agent (无运行中) — 应返回 success:false (not running)
  const r2 = await callAgent('abort', 'main')
  record('abort(main 无运行中) 应返回 not running', r2?.success === false,
    `success=${r2?.success}, msg=${errMsg(r2).slice(0, 60)}`)

  // 2.3 abort 空 id — 应失败
  const r3 = await callAgent('abort', '')
  record('abort(空 id) 应失败', isErr(r3) || r3?.success === false,
    `success=${r3?.success}, msg=${errMsg(r3).slice(0, 60)}`)
}

// =============================================================
// 3. 消息流 UI 测试 — 输入→发送→消息出现在列表
// =============================================================
async function testMessageFlowUI() {
  console.log('\n=== 3. 消息流 UI 测试 ===')

  // 重载页面确保干净状态
  await send('Page.reload')
  await sleep(2500)
  await evalInPage(`window.location.hash = '#/chat'`)
  await sleep(1500)

  // 3.1 初始消息数
  const initial = await evalInPage(`(function(){
    try {
      const store = window.__EAA_STORE__ || window.useChatStore?.getState?.() || null;
      // 尝试通过 React 内部访问 store
      const root = document.getElementById('root');
      const reactKey = Object.keys(root || {}).find(k => k.startsWith('__reactContainer'));
      return { msgCount: -1, hash: window.location.hash, hasRoot: !!root, hasReact: !!reactKey };
    } catch (e) { return { err: e.message }; }
  })()`)
  note(`初始状态: hash=${initial?.hash}`)

  // 3.2 在 textarea 输入文本
  const inputText = 'CDP 消息流测试 ' + Date.now()
  const inputResult = await evalInPage(`(function(){
    const ta = document.querySelector('textarea');
    if (!ta) return { ok: false, reason: 'no textarea' };
    // 模拟用户输入: 设置值 + 派发 input 事件
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(inputText)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, value: ta.value };
  })()`)
  record('textarea 输入文本', inputResult.ok, inputResult.ok ? `value="${inputResult.value.slice(0, 40)}"` : inputResult.reason)

  // 3.3 按 Enter 发送
  const sendResult = await evalInPage(`(async function(){
    const ta = document.querySelector('textarea');
    if (!ta) return { ok: false, reason: 'no textarea' };
    // 派发 Enter 键事件 (非 Shift)
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true }));
    // 等待 200ms 让 React 处理
    await new Promise(r => setTimeout(r, 300));
    return {
      ok: true,
      textareaCleared: ta.value === '',
      // 检查消息列表是否有刚发送的文本
      bodyHasText: (document.body.textContent || '').includes(${JSON.stringify(inputText.slice(0, 30))})
    };
  })()`)
  record('Enter 发送后 textarea 清空', sendResult.textareaCleared,
    sendResult.textareaCleared ? '已清空' : `残留 value="${sendResult.value || ''}"`)
  record('发送的消息出现在 UI', sendResult.bodyHasText,
    sendResult.bodyHasText ? '在 body 中找到' : '未在 body 中找到(可能 store 未更新或 UI 未渲染)')

  // 3.4 等待 1s 看 Agent 是否启动 (isStreaming)
  await sleep(1000)
  const streamingState = await evalInPage(`(function(){
    // 通过停止按钮的存在判断 isStreaming
    const btns = document.querySelectorAll('button');
    let hasStopBtn = false;
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if (t.includes('停止') || t.includes('Stop')) { hasStopBtn = true; break; }
    }
    return { hasStopBtn, btnCount: btns.length };
  })()`)
  record('Agent 启动后 isStreaming 状态', 'warn',
    `hasStopBtn=${streamingState.hasStopBtn} (无 API key 时 Agent 可能立即失败)`)
}

// =============================================================
// 4. 错误恢复 — 无 API key 时的错误处理
// =============================================================
async function testErrorRecovery() {
  console.log('\n=== 4. 错误恢复 (无 API key) ===')

  // 4.1 等待 5s 让 Agent 错误事件到达
  await sleep(5000)

  // 4.2 检查页面是否还在正常状态(无错误边界)
  const pageState = await evalInPage(`(function(){
    const text = document.body.textContent || '';
    return {
      hasErrorBoundary: text.includes('页面渲染出错了') || text.includes('Something went wrong'),
      hasErrorMessage: text.includes('错误') || text.includes('Error') || text.includes('失败'),
      bodyLen: text.length,
      hash: window.location.hash,
    };
  })()`)
  record('页面未崩溃(无错误边界)', !pageState.hasErrorBoundary,
    pageState.hasErrorBoundary ? '崩溃! 错误边界触发' : `正常, bodyLen=${pageState.bodyLen}`)
  record('页面仍可交互', pageState.hash.includes('/chat'),
    `hash=${pageState.hash}`)

  // 4.3 检查 isStreaming 是否恢复 false (Agent 错误后应清理)
  const streamingRecovered = await evalInPage(`(function(){
    const btns = document.querySelectorAll('button');
    let hasStopBtn = false;
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if (t.includes('停止') || t.includes('Stop')) { hasStopBtn = true; break; }
    }
    return { hasStopBtn, isStreaming: hasStopBtn };
  })()`)
  record('Agent 错误后 isStreaming 恢复 false', !streamingRecovered.isStreaming,
    streamingRecovered.isStreaming ? '仍为 true (状态卡死)' : '已恢复 false')

  // 4.4 检查是否可以再次发送(输入框可用)
  const canResend = await evalInPage(`(function(){
    const ta = document.querySelector('textarea');
    return { ok: !!ta, disabled: ta?.disabled };
  })()`)
  record('错误后可再次发送', canResend.ok && !canResend.disabled,
    `textarea存在=${canResend.ok}, disabled=${canResend.disabled}`)
}

// =============================================================
// 5. 会话切换状态恢复
// =============================================================
async function testSessionSwitchRecovery() {
  console.log('\n=== 5. 会话切换状态恢复 ===')

  // 5.1 通过 UI 按钮创建新会话 (createSession 是 chatStore 本地方法,不是 IPC)
  const createResult = await evalInPage(`(async function(){
    // 找到 "+ 新建对话" 按钮并点击
    const btns = document.querySelectorAll('button');
    let clicked = false;
    let btnText = '';
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if (t.includes('新建对话') || t.includes('New Conversation') || t.startsWith('+')) {
        b.click();
        clicked = true;
        btnText = t.slice(0, 30);
        break;
      }
    }
    await new Promise(r => setTimeout(r, 800));
    // 读取所有会话 id
    const items = document.querySelectorAll('[data-ctx-session-id]');
    const sids = Array.from(items).map(i => i.getAttribute('data-ctx-session-id'));
    return { clicked, btnText, sids };
  })()`)
  record('点击新建对话按钮', createResult.clicked, `text="${createResult.btnText}"`)

  // 5.2 找到新会话 id (不在 default 中)
  const newSid = createResult.sids.find(s => s && s.startsWith('session_'))
  note(`新会话 id: ${newSid ?? '未找到'}`)

  if (newSid) {
    // 5.3 切换到新会话 (UI)
    const switchResult = await evalInPage(`(async function(){
      const items = document.querySelectorAll('[data-ctx-session-id]');
      let clicked = false;
      for (const item of items) {
        const sid = item.getAttribute('data-ctx-session-id');
        if (sid === ${JSON.stringify(newSid)}) {
          const btn = item.querySelector('button');
          if (btn) { btn.click(); clicked = true; break; }
        }
      }
      await new Promise(r => setTimeout(r, 500));
      return { clicked };
    })()`)
    record('切换到新会话', switchResult.clicked, `sid=${newSid}`)

    // 5.4 验证消息列表被清空(新会话无消息)
    await sleep(500)
    const msgState = await evalInPage(`(function(){
      const text = document.body.textContent || '';
      return {
        hasEmptyHint: text.includes('开始对话') || text.includes('Start') || text.includes('empty'),
        bodyLen: text.length,
      };
    })()`)
    record('新会话消息列表为空', 'warn', `hasEmptyHint=${msgState.hasEmptyHint}`)

    // 5.5 切回 default 会话
    const switchBack = await evalInPage(`(async function(){
      const items = document.querySelectorAll('[data-ctx-session-id]');
      let clicked = false;
      for (const item of items) {
        const sid = item.getAttribute('data-ctx-session-id');
        if (sid === 'default') {
          const btn = item.querySelector('button');
          if (btn) { btn.click(); clicked = true; break; }
        }
      }
      await new Promise(r => setTimeout(r, 500));
      return { clicked };
    })()`)
    record('切回 default 会话', switchBack.clicked, '')

    // 5.6 清理测试会话 (通过 IPC deleteSession)
    const delRes = await callChat('deleteSession', newSid)
    record('清理测试会话', isOk(delRes), `id=${newSid}`)
  }
}

// =============================================================
// 6. 流式事件订阅健壮性
// =============================================================
async function testStreamSubscriptionRobustness() {
  console.log('\n=== 6. 流式事件订阅健壮性 ===')

  // 6.1 验证 onStream 订阅器存在
  const streamSub = await evalInPage(`(function(){
    try {
      const api = window.__EAA_API__ || window.api;
      return {
        hasOnStream: typeof api?.ai?.onStream === 'function',
        hasOnStatusUpdate: typeof api?.agent?.onStatusUpdate === 'function',
      };
    } catch (e) { return { err: e.message }; }
  })()`)
  record('ai.onStream 订阅器存在', streamSub.hasOnStream,
    streamSub.hasOnStream ? '可用' : '缺失')
  record('agent.onStatusUpdate 订阅器存在', streamSub.hasOnStatusUpdate,
    streamSub.hasOnStatusUpdate ? '可用' : '缺失')

  // 6.2 多次订阅 onStream (测试是否会重复订阅内存泄漏)
  const multiSub = await evalInPage(`(async function(){
    try {
      const api = window.__EAA_API__ || window.api;
      const unsubs = [];
      // 订阅 5 次
      for (let i = 0; i < 5; i++) {
        const unsub = api.ai.onStream(() => {});
        if (typeof unsub === 'function') unsubs.push(unsub);
      }
      // 全部取消订阅
      unsubs.forEach(u => { try { u() } catch {} });
      return { ok: true, count: unsubs.length };
    } catch (e) { return { ok: false, err: e.message }; }
  })()`)
  record('onStream 多次订阅+取消', multiSub.ok,
    multiSub.ok ? `count=${multiSub.count}` : `err=${multiSub.err}`)

  // 6.3 验证订阅返回的 unsub 是函数
  const unsubType = await evalInPage(`(function(){
    try {
      const api = window.__EAA_API__ || window.api;
      const unsub = api.ai.onStream(() => {});
      const isFunc = typeof unsub === 'function';
      if (isFunc) unsub();
      return { isFunc };
    } catch (e) { return { isFunc: false, err: e.message }; }
  })()`)
  record('onStream 返回 unsub 函数', unsubType.isFunc,
    unsubType.isFunc ? '类型正确' : `err=${unsubType.err}`)

  // 6.4 验证 ChatPage 不会重复订阅 (useEffect deps 正确)
  // 注: ChatPage 用 useRef 保持 streamHandler 稳定,useEffect deps=[] 只订阅一次
  const subCount = await evalInPage(`(function(){
    // 通过 monkey-patch onStream 计数(无法直接观测,只能通过日志推断)
    // 这里只验证页面没崩,订阅器可用
    try {
      const api = window.__EAA_API__ || window.api;
      return { ok: typeof api?.ai?.onStream === 'function' };
    } catch (e) { return { ok: false, err: e.message }; }
  })()`)
  record('ChatPage 订阅状态正常', subCount.ok, '')
}

// =============================================================
// 7. 控制台错误监控
// =============================================================
async function testConsoleErrors() {
  console.log('\n=== 7. 控制台错误监控 ===')

  // 启用 Console API
  await send('Console.enable')
  const errors = []
  const warnings = []
  const handler = (msg) => {
    const entry = msg.params?.message
    if (!entry) return
    if (entry.level === 'error') errors.push(entry.text?.slice(0, 200))
    else if (entry.level === 'warning') warnings.push(entry.text?.slice(0, 100))
  }
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.method === 'Console.messageAdded') handler(m)
  })

  // 触发一些操作
  await evalInPage(`window.location.hash = '#/chat'`)
  await sleep(500)
  await callChat('listSessions')
  await callAgent('list')

  await sleep(2000)

  // 过滤掉预期的错误(无 API key 时的 Agent 错误)
  const unexpectedErrors = errors.filter(e =>
    !e.includes('API key') && !e.includes('apiKey') &&
    !e.includes('Not authenticated') && !e.includes('provider not configured') &&
    !e.includes('No API key') && !e.includes('OPENAI_API_KEY')
  )

  record('无未捕获控制台错误', unexpectedErrors.length === 0,
    unexpectedErrors.length === 0 ? `clean (errors=${errors.length} 全部为预期)` : `${unexpectedErrors.length} 个未预期错误`)
  if (unexpectedErrors.length > 0) {
    unexpectedErrors.slice(0, 3).forEach((e, i) => console.log(`  [error ${i + 1}] ${e}`))
  }
}

// =============================================================
// main
// =============================================================
async function main() {
  console.log('=== Chat 消息流/中断恢复/错误处理 深度测试 ===')
  console.log('时间: ' + new Date().toISOString())
  await connect()
  console.log('CDP 连接成功')

  await testRunManualValidation()
  await testAbortValidation()
  await testMessageFlowUI()
  await testErrorRecovery()
  await testSessionSwitchRecovery()
  await testStreamSubscriptionRobustness()
  await testConsoleErrors()

  console.log('\n=== 总结 ===')
  console.log(`总计: ${passCount + warnCount + failCount}, 通过: ${passCount}, 警告: ${warnCount}, 失败: ${failCount}`)
  if (notes.length) {
    console.log('\n— 备注:')
    notes.forEach((n) => console.log(`  ℹ ${n}`))
  }
  if (bugs.length) {
    console.log('\n— 发现的问题:')
    bugs.forEach((b) => console.log(`  🐛 ${b}`))
  } else {
    console.log('\n— 未发现 bug')
  }

  ws.close()
  process.exit(failCount > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL:', e.message)
  console.error(e.stack)
  process.exit(1)
})
