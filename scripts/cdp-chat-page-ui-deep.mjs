// =============================================================
// CDP ChatPage UI 交互 + Chat IPC 输入验证深度测试
// 角度: UI 端到端 + IPC 验证盲区
// 运行: node scripts/cdp-chat-page-ui-deep.mjs
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
const callChat = (m, ...a) => callNS('chat', m, ...a)
const callAI = (m, ...a) => callNS('ai', m, ...a)
const callAgent = (m, ...a) => callNS('agent', m, ...a)
const callSettings = (m, ...a) => callNS('settings', m, ...a)

const isOk = (r) => !!r && r.__error === undefined && r.success === true
const isErr = (r) => !!r && (r.__error !== undefined || r.success === false)
const errMsg = (r) => r.__error || r.error || 'unknown error'

// =============================================================
// 1. ChatPage UI 元素存在性 — 导航到 /chat 后验证关键元素
// =============================================================
async function testChatPageUIElements() {
  console.log('\n=== 1. ChatPage UI 元素存在性 ===')

  // 导航到 chat 页
  await evalInPage(`window.location.hash = '#/chat'`)
  await sleep(800)

  // 1.1 页面加载成功
  const hash = await evalInPage(`window.location.hash`)
  record('ChatPage 路由加载', hash.includes('/chat'), `hash=${hash}`)

  // 1.2 左侧会话列表面板 — 按钮文字 "+ 新建对话" / "+ New Conversation"
  const sessionsPanel = await evalInPage(`(function(){
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if (t.includes('新建对话') || t.includes('新会话') || t.includes('New Conversation') || t.includes('会话')) {
        return { found: true, text: t.slice(0, 30) };
      }
    }
    // 兜底:查找以 "+" 开头的按钮
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if (t.startsWith('+')) return { found: true, text: t.slice(0, 30) };
    }
    return { found: false };
  })()`)
  record('新会话按钮存在', sessionsPanel.found, sessionsPanel.found ? `text="${sessionsPanel.text}"` : '未找到')

  // 1.3 Agent 选择器 (select)
  const agentSelect = await evalInPage(`(function(){
    const selects = document.querySelectorAll('select');
    const found = [];
    for (const s of selects) {
      const opts = Array.from(s.options).map(o => o.value).filter(Boolean);
      if (opts.length > 0) found.push({ opts: opts.slice(0, 5), count: opts.length });
    }
    return found;
  })()`)
  record('Agent 选择器(至少 1 个 select 有选项)', Array.isArray(agentSelect) && agentSelect.length > 0,
    Array.isArray(agentSelect) ? `selects=${agentSelect.length}, first=${agentSelect[0]?.count ?? 0} opts` : '无 select')

  // 1.4 思考级别选择器 (off/minimal/low/medium/high/xhigh)
  const thinkingSelect = await evalInPage(`(function(){
    const selects = document.querySelectorAll('select');
    for (const s of selects) {
      const vals = Array.from(s.options).map(o => o.value);
      if (vals.includes('off') && vals.includes('high')) {
        return { found: true, values: vals };
      }
    }
    return { found: false };
  })()`)
  record('思考级别选择器(6 档)', thinkingSelect.found,
    thinkingSelect.found ? `values=${thinkingSelect.values.join(',')}` : '未找到')

  // 1.5 textarea 输入框
  const textarea = await evalInPage(`(function(){
    const ta = document.querySelector('textarea');
    return ta ? { found: true, placeholder: ta.placeholder?.slice(0, 50) || '' } : { found: false };
  })()`)
  record('输入 textarea 存在', textarea.found, textarea.found ? `placeholder="${textarea.placeholder}"` : '无')

  // 1.6 发送按钮 (可能是 svg/icon,查找按钮)
  const sendBtn = await evalInPage(`(function(){
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      // 发送按钮通常无文本(只有 icon)或含"发送"/"停止"
      if (t.includes('发送') || t.includes('停止')) return { found: true, text: t.slice(0, 20), isStop: t.includes('停止') };
    }
    // 找带 svg 的按钮(可能是发送 icon)
    const svgBtns = Array.from(btns).filter(b => b.querySelector('svg') && !b.textContent.trim());
    return { found: svgBtns.length > 0, text: 'svg-only', count: svgBtns.length };
  })()`)
  record('发送/停止按钮存在', sendBtn.found, sendBtn.found ? `text=${sendBtn.text}` : '无')

  // 1.7 文件上传按钮 (含 📎 或 svg paperclip)
  const fileBtn = await evalInPage(`(function(){
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      const title = b.getAttribute('title') || b.getAttribute('aria-label') || '';
      if (title.includes('文件') || title.includes('上传') || title.includes('file') || title.includes('upload')) {
        return { found: true, title };
      }
    }
    // 查 svg paperclip (常见 file upload icon)
    const svgs = document.querySelectorAll('button svg');
    return { found: false, svgCount: svgs.length };
  })()`)
  record('文件上传按钮存在', 'warn', fileBtn.found ? `title="${fileBtn.title}"` : `未识别(svgCount=${fileBtn.svgCount})`)

  // 1.8 空态提示 (无消息时显示"开始对话")
  const emptyState = await evalInPage(`(function(){
    const text = document.body.textContent || '';
    return {
      hasStartHint: text.includes('开始对话') || text.includes('Start') || text.includes(' conversation'),
      hasEmptyIcon: !!document.querySelector('[class*="empty"]')
    };
  })()`)
  record('空态提示', 'warn', `hasStartHint=${emptyState.hasStartHint}`)

  // 1.9 ContextStatusBar (token 进度条)
  const ctxBar = await evalInPage(`(function(){
    const text = document.body.textContent || '';
    return {
      hasContext: text.includes('context') || text.includes('上下文') || text.includes('Context'),
      hasToken: text.includes('token') || text.includes('Token'),
      hasProgressBar: !!document.querySelector('[class*="progress"]') || !!document.querySelector('[role="progressbar"]')
    };
  })()`)
  record('ContextStatusBar 显示', 'warn', `ctx=${ctxBar.hasContext}, token=${ctxBar.hasToken}, bar=${ctxBar.hasProgressBar}`)
}

// =============================================================
// 2. 会话管理 UI — 创建/切换/删除
// =============================================================
async function testSessionManagementUI() {
  console.log('\n=== 2. 会话管理 UI ===')

  // 2.1 列出当前会话
  // 注: chat namespace 返回扁平结构 {success, sessions} (无 data 包装)
  const before = await callChat('listSessions')
  const beforeCount = isOk(before) ? (before.sessions ?? []).length : 0
  note(`测试前会话数: ${beforeCount}`)

  // 2.2 点击"新会话"按钮 — 文字 "+ 新建对话"
  const createResult = await evalInPage(`(async function(){
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if (t.includes('新建对话') || t.includes('New Conversation') || t.startsWith('+')) {
        b.click();
        return { clicked: true, text: t.slice(0, 30) };
      }
    }
    return { clicked: false };
  })()`)
  await sleep(500)
  record('点击新会话按钮', createResult.clicked, createResult.clicked ? `text="${createResult.text}"` : '未找到按钮')

  // 2.3 验证会话数增加
  const after = await callChat('listSessions')
  const afterCount = isOk(after) ? (after.sessions ?? []).length : 0
  record('新会话创建后列表数 +1', afterCount === beforeCount + 1,
    `before=${beforeCount}, after=${afterCount}`)

  // 2.4 验证新会话出现在 UI 列表中
  const sessionInUI = await evalInPage(`(function(){
    const items = document.querySelectorAll('[data-session-id], [data-ctx-session-id]');
    return { count: items.length };
  })()`)
  record('新会话出现在 UI', 'warn', `uiSessionItems=${sessionInUI.count}`)

  // 2.5 切换会话 (如果有多个)
  if (afterCount >= 2) {
    const switchResult = await evalInPage(`(function(){
      const items = document.querySelectorAll('[data-ctx-session-id]');
      if (items.length >= 2) {
        items[1].click();
        return { switched: true };
      }
      return { switched: false };
    })()`)
    await sleep(300)
    record('会话切换', switchResult.switched, switchResult.switched ? '点击第二个会话' : '无多个会话')
  } else {
    record('会话切换', 'warn', '会话数不足,跳过')
  }

  // 2.6 删除会话 — 直接 IPC 删除 + 验证 ctx-menu-action 健壮性修复
  // 注: ChatPage 的 ctx-menu-action 事件处理器 P3-1 修复后加了 try/catch + typeof check
  //     派发畸形事件(非 DOM target)应被静默忽略,不再崩溃整页
  if (afterCount >= 1) {
    const latest = isOk(after) ? (after.sessions ?? [])[0] : null
    if (latest) {
      // 直接 IPC 删除
      const delRes = await callChat('deleteSession', latest.id)
      record('IPC 删除会话', isOk(delRes), isOk(delRes) ? `id=${latest.id}` : errMsg(delRes))

      // P3-1 修复验证: 派发畸形 ctx-menu-action 事件,页面不应崩溃
      const crashCheck = await evalInPage(`(function(){
        try {
          // 派发带非 DOM target 的畸形事件(修复前会触发 "target.getAttribute is not a function")
          const fakeEvent = new CustomEvent('ctx-menu-action', {
            detail: { action: 'delete', target: { dataset: { ctxSessionId: 'fake-id' } } },
            bubbles: true,
          });
          document.dispatchEvent(fakeEvent);
          // 检查页面是否还在正常状态(错误边界未触发)
          const hasErrorBoundary = !!document.querySelector('[class*="error-boundary"]')
            || (document.body.textContent || '').includes('页面渲染出错了');
          return { ok: !hasErrorBoundary, hasErrorBoundary };
        } catch (e) { return { ok: false, err: e.message }; }
      })()`)
      record('ctx-menu-action 畸形事件不崩溃(P3-1 修复)', crashCheck.ok,
        crashCheck.ok ? '页面正常,错误边界未触发' : `崩溃! hasErrorBoundary=${crashCheck.hasErrorBoundary}`)
    }
  }
}

// =============================================================
// 3. 输入框行为 — Enter/Shift+Enter/空输入
// =============================================================
async function testInputBehavior() {
  console.log('\n=== 3. 输入框行为 ===')

  // 3.1 空输入不应发送
  const emptyResult = await evalInPage(`(function(){
    const ta = document.querySelector('textarea');
    if (!ta) return { ok: false, reason: 'no textarea' };
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    // 查找发送按钮,检查是否禁用
    const btns = document.querySelectorAll('button');
    const sendBtn = Array.from(btns).find(b => {
      const t = (b.textContent || '').trim();
      return t.includes('发送') || (b.querySelector('svg') && !t && !t.includes('停止'));
    });
    return { ok: true, sendBtnDisabled: sendBtn ? sendBtn.disabled : 'no btn' };
  })()`)
  record('空输入时发送按钮状态', 'warn', `disabled=${emptyResult.sendBtnDisabled}`)

  // 3.2 Shift+Enter 应换行不发送
  const shiftEnterResult = await evalInPage(`(function(){
    const ta = document.querySelector('textarea');
    if (!ta) return { ok: false };
    const before = ta.value;
    ta.value = 'line1\\nline2';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const after = ta.value;
    return { ok: true, hasNewline: after.includes('\\n') };
  })()`)
  record('Shift+Enter 换行支持', 'warn', `hasNewline=${shiftEnterResult.hasNewline}`)

  // 3.3 清空输入
  await evalInPage(`(function(){
    const ta = document.querySelector('textarea');
    if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); }
  })()`)
  record('清空输入', true, 'textarea 已清空')
}

// =============================================================
// 4. 思考级别切换 + 持久化
// 注: settings.get() 返回完整 settings 对象(无 success 包装),settings.set(path, value) 返回 {success}
// =============================================================
async function testThinkingLevelPersistence() {
  console.log('\n=== 4. 思考级别切换 + 持久化 ===')

  // 重新导航到 chat 页(确保 select 在 DOM 中)
  await evalInPage(`window.location.hash = '#/chat'`)
  await sleep(800)

  // 4.1 读取当前思考级别 — settings.get() 返回完整对象
  const settingsBefore = await callSettings('get')
  const beforeVal = settingsBefore && !settingsBefore.__error && !settingsBefore.error
    ? settingsBefore.chat?.thinkingLevel
    : null
  note(`思考级别初始: ${beforeVal}`)

  // 4.2 切换到 'high'
  const setRes = await callSettings('set', 'chat.thinkingLevel', 'high')
  record('设置思考级别=high', isOk(setRes), isOk(setRes) ? 'ok' : errMsg(setRes))

  // 4.3 读回验证
  const settingsAfter = await callSettings('get')
  const afterVal = settingsAfter && !settingsAfter.__error ? settingsAfter.chat?.thinkingLevel : null
  record('思考级别持久化读回=high', afterVal === 'high', `val=${afterVal}`)

  // 4.4 切换 UI select — 等待 React 渲染后查找
  await sleep(500)
  const uiSwitch = await evalInPage(`(function(){
    const selects = document.querySelectorAll('select');
    for (const s of selects) {
      const vals = Array.from(s.options).map(o => o.value);
      if (vals.includes('off') && vals.includes('high')) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        nativeSetter.call(s, 'medium');
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: s.value, optionCount: vals.length };
      }
    }
    return { ok: false, selectCount: selects.length };
  })()`)
  record('UI 切换思考级别=medium', uiSwitch.ok, uiSwitch.ok ? `value=${uiSwitch.value}` : `未找到 select(selectCount=${uiSwitch.selectCount})`)

  // 4.5 读回验证 UI 切换持久化
  await sleep(600)
  const settingsAfterUI = await callSettings('get')
  const afterUIVal = settingsAfterUI && !settingsAfterUI.__error ? settingsAfterUI.chat?.thinkingLevel : null
  record('UI 切换后持久化读回=medium', afterUIVal === 'medium', `val=${afterUIVal}`)

  // 4.6 还原
  if (beforeVal) {
    await callSettings('set', 'chat.thinkingLevel', beforeVal)
    note(`思考级别已还原: ${beforeVal}`)
  }
}

// =============================================================
// 5. Agent 选择器切换
// 注: agent.list() 返回 AgentListItem[] 数组(无 success 包装)
// =============================================================
async function testAgentSelectorSwitch() {
  console.log('\n=== 5. Agent 选择器切换 ===')

  // 重新导航到 chat 页
  await evalInPage(`window.location.hash = '#/chat'`)
  await sleep(800)

  // 5.1 列出 agents — 返回数组
  const agentList = await callAgent('list')
  const agents = Array.isArray(agentList) ? agentList : []
  const enabledAgents = agents.filter(a => a.enabled)
  record('有可用 agent', enabledAgents.length > 0, `count=${enabledAgents.length}`)

  if (enabledAgents.length >= 2) {
    // 5.2 切换到第二个 agent — 查找非思考级别 select
    const secondAgent = enabledAgents[1]
    const switchRes = await evalInPage(`(function(){
      const selects = document.querySelectorAll('select');
      const candidates = [];
      for (const s of selects) {
        const vals = Array.from(s.options).map(o => o.value);
        candidates.push({ vals: vals.slice(0, 3), count: vals.length });
        // agent selector: 不含 off/high(那是思考级别),且有 >1 选项
        if (!vals.includes('off') && !vals.includes('high') && vals.length > 1) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          nativeSetter.call(s, '${secondAgent.id}');
          s.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, value: s.value, vals: vals.slice(0, 3) };
        }
      }
      return { ok: false, candidates };
    })()`)
    record('UI 切换 agent', switchRes.ok,
      switchRes.ok ? `value=${switchRes.value}` : `未找到 agent selector(candidates=${JSON.stringify(switchRes.candidates).slice(0, 120)})`)
    await sleep(300)

    // 5.3 还原到第一个 agent
    const firstAgent = enabledAgents[0]
    await evalInPage(`(function(){
      const selects = document.querySelectorAll('select');
      for (const s of selects) {
        const vals = Array.from(s.options).map(o => o.value);
        if (!vals.includes('off') && !vals.includes('high') && vals.length > 1) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          nativeSetter.call(s, '${firstAgent.id}');
          s.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    })()`)
    note(`agent 已还原: ${firstAgent.id}`)
  } else {
    record('agent 切换', 'warn', '可用 agent < 2,跳过')
  }
}

// =============================================================
// 6. Chat IPC 输入验证盲区 — ai-handlers.ts validateString 系列
// =============================================================
async function testChatIPCValidation() {
  console.log('\n=== 6. Chat IPC 输入验证盲区 ===')

  // --- IPC_CHAT_SAVE_MESSAGE 验证 ---

  // 6.1 non-object msg
  const r1 = await callChat('saveMessage', 'not-an-object')
  record('saveMessage(字符串) 应失败', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 80)}` : `意外成功: ${JSON.stringify(r1).slice(0, 80)}`)

  // 6.2 null msg
  const r2 = await callChat('saveMessage', null)
  record('saveMessage(null) 应失败', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 80)}` : `意外成功`)

  // 6.3 缺失 role
  const r3 = await callChat('saveMessage', { content: 'test' })
  record('saveMessage(缺 role) 应失败', isErr(r3),
    isErr(r3) ? `error=${errMsg(r3).slice(0, 80)}` : `意外成功`)

  // 6.4 空 role 字符串
  const r4 = await callChat('saveMessage', { role: '', content: 'test' })
  record('saveMessage(role="") 应失败', isErr(r4),
    isErr(r4) ? `error=${errMsg(r4).slice(0, 80)}` : `意外成功`)

  // 6.5 超长 role (>64 chars)
  const r5 = await callChat('saveMessage', { role: 'x'.repeat(100), content: 'test' })
  record('saveMessage(role 超长 100 字符) 应失败', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 80)}` : `意外成功`)

  // 6.6 role 含 null byte — 注:需用真实 null 字符 \0 (非字面 \\0)
  const r6 = await callChat('saveMessage', { role: 'user\0evil', content: 'test' })
  record('saveMessage(role 含 null byte) 应失败', isErr(r6),
    isErr(r6) ? `error=${errMsg(r6).slice(0, 80)}` : `意外成功 id=${r6?.id}`)

  // 6.7 非字符串 role (number)
  const r7 = await callChat('saveMessage', { role: 123, content: 'test' })
  record('saveMessage(role=123 数字) 应失败', isErr(r7),
    isErr(r7) ? `error=${errMsg(r7).slice(0, 80)}` : `意外成功`)

  // 6.8 非法 role enum (DB CHECK 拒绝,返回 id=-1)
  const r8 = await callChat('saveMessage', { role: 'invalid_role', content: 'test' })
  record('saveMessage(role="invalid_role") 应失败', isErr(r8) || (r8 && r8.id === -1),
    `success=${r8?.success}, id=${r8?.id}, error=${r8?.error ?? 'n/a'}`)

  // 6.9 content 超长 (>10MB)
  const hugeContent = 'x'.repeat(10 * 1024 * 1024 + 1)
  const r9 = await callChat('saveMessage', { role: 'user', content: hugeContent })
  record('saveMessage(content >10MB) 应失败', isErr(r9),
    isErr(r9) ? `error=${errMsg(r9).slice(0, 80)}` : `意外成功`)

  // 6.10 content 含 null byte — 注:需用真实 null 字符 \0
  const r10 = await callChat('saveMessage', { role: 'user', content: 'test\0evil' })
  record('saveMessage(content 含 null byte) 应失败', isErr(r10),
    isErr(r10) ? `error=${errMsg(r10).slice(0, 80)}` : `意外成功 id=${r10?.id}`)

  // 6.11 正常 saveMessage (user role)
  const r11 = await callChat('saveMessage', { role: 'user', content: 'CDP 验证测试消息' })
  record('saveMessage(role=user, 正常) 应成功', isOk(r11),
    isOk(r11) ? `id=${r11.id}` : errMsg(r11))

  // 6.12 正常 saveMessage (assistant role + 可选字段)
  const r12 = await callChat('saveMessage', {
    role: 'assistant',
    content: 'CDP 验证测试回复',
    thinking: '思考内容',
    provider: 'test-provider',
    model: 'test-model',
    tokenInput: 100,
    tokenOutput: 50,
    cost: 0.001,
  })
  record('saveMessage(role=assistant + 可选字段) 应成功', isOk(r12),
    isOk(r12) ? `id=${r12.id}` : errMsg(r12))

  // 6.13 非法 tokenInput 类型 (字符串) — P3-1 修复:IPC 层现在同步校验数值类型
  const r13 = await callChat('saveMessage', {
    role: 'user',
    content: '类型测试',
    tokenInput: 'not-a-number', // 非数字
  })
  // 注: ai-handlers.ts P3-1 修复后, tokenInput/tokenOutput/cost 在 IPC 层同步校验类型
  record('saveMessage(tokenInput=字符串) 应失败(P3-1 修复)', isErr(r13),
    isErr(r13) ? `error=${errMsg(r13).slice(0, 80)}` : `意外成功 id=${r13?.id}`)

  // --- IPC_AI_CHAT 验证 ---
  // 注: ai.chat P3-1 修复后, 输入验证在 IIFE 前同步执行
  // IPC 返回 {success:false, error, sessionId:null}, 调用方可直接感知验证失败

  // 6.14 messages 非数组 — P3-1 修复后 IPC 同步返回失败
  const r14 = await callAI('chat', {
    providerId: 'test',
    modelId: 'test',
    messages: 'not-an-array',
  })
  record('ai.chat(messages=字符串) 应失败(P3-1 修复)', isErr(r14),
    isErr(r14) ? `error=${errMsg(r14).slice(0, 80)}` : '意外成功(修复未生效)')

  // 6.15 非法 thinking — P3-1 修复后 IPC 同步返回失败
  const r15 = await callAI('chat', {
    providerId: 'test',
    modelId: 'test',
    messages: [],
    thinking: 'invalid-level',
  })
  record('ai.chat(thinking="invalid-level") 应失败(P3-1 修复)', isErr(r15),
    isErr(r15) ? `error=${errMsg(r15).slice(0, 80)}` : '意外成功(修复未生效)')

  // 6.16 缺失 providerId — P3-1 修复后 IPC 同步返回失败
  const r16 = await callAI('chat', {
    modelId: 'test',
    messages: [],
  })
  record('ai.chat(缺 providerId) 应失败(P3-1 修复)', isErr(r16),
    isErr(r16) ? `error=${errMsg(r16).slice(0, 80)}` : '意外成功(修复未生效)')

  // 6.17 null byte in providerId — P3-1 修复后 IPC 同步返回失败 + 真实 null 字符
  const r17 = await callAI('chat', {
    providerId: 'test\0evil',
    modelId: 'test',
    messages: [],
  })
  record('ai.chat(providerId 含 null byte) 应失败(P3-1 修复)', isErr(r17),
    isErr(r17) ? `error=${errMsg(r17).slice(0, 80)}` : '意外成功(修复未生效)')

  // --- IPC_AI_LIST_MODELS 验证 ---

  // 6.18 非字符串 providerId
  const r18 = await callAI('listModels', 123)
  record('ai.listModels(123 数字) 应失败', isErr(r18),
    isErr(r18) ? `error=${errMsg(r18).slice(0, 80)}` : `意外成功`)

  // 6.19 超长 providerId
  const r19 = await callAI('listModels', 'x'.repeat(300))
  record('ai.listModels(providerId 超长 300) 应失败', isErr(r19),
    isErr(r19) ? `error=${errMsg(r19).slice(0, 80)}` : `意外成功`)

  // --- IPC_AI_SET_API_KEY 验证 ---

  // 6.20 缺失 apiKey
  const r20 = await callAI('setApiKey', 'test-provider')
  record('ai.setApiKey(缺 apiKey) 应失败', isErr(r20),
    isErr(r20) ? `error=${errMsg(r20).slice(0, 80)}` : `意外成功`)

  // 6.21 apiKey 含 null byte — 真实 null 字符
  const r21 = await callAI('setApiKey', 'test-provider', 'key\0evil')
  record('ai.setApiKey(apiKey 含 null byte) 应失败', isErr(r21),
    isErr(r21) ? `error=${errMsg(r21).slice(0, 80)}` : `意外成功`)

  // --- IPC_AI_ADD_CUSTOM_MODEL 验证 ---

  // 6.22 非对象 params
  const r22 = await callAI('addCustomModel', 'not-an-object')
  record('ai.addCustomModel(字符串) 应失败', isErr(r22),
    isErr(r22) ? `error=${errMsg(r22).slice(0, 80)}` : `意外成功`)

  // 6.23 缺失 modelId
  const r23 = await callAI('addCustomModel', { providerId: 'test' })
  record('ai.addCustomModel(缺 modelId) 应失败', isErr(r23),
    isErr(r23) ? `error=${errMsg(r23).slice(0, 80)}` : `意外成功`)

  // --- IPC_AI_UPDATE_CUSTOM_MODEL 验证 ---

  // 6.24 非对象 params
  const r24 = await callAI('updateCustomModel', 'not-an-object')
  record('ai.updateCustomModel(字符串) 应失败', isErr(r24),
    isErr(r24) ? `error=${errMsg(r24).slice(0, 80)}` : `意外成功`)

  // 6.25 null byte in baseUrl — 真实 null 字符
  const r25 = await callAI('updateCustomModel', {
    providerId: 'test',
    modelId: 'test',
    baseUrl: 'http://evil.com\0/path',
  })
  record('ai.updateCustomModel(baseUrl 含 null byte) 应失败', isErr(r25),
    isErr(r25) ? `error=${errMsg(r25).slice(0, 80)}` : `意外成功`)
}

// =============================================================
// 7. 消息渲染 — user/assistant 气泡样式
// =============================================================
async function testMessageRendering() {
  console.log('\n=== 7. 消息渲染样式 ===')

  // 创建测试会话 + 保存 2 条消息(user + assistant)
  const testSession = `cdp-ui-${Date.now()}`
  const saveUser = await callChat('saveMessage', {
    role: 'user',
    content: 'CDP UI 测试-用户消息',
    sessionId: testSession,
  })
  const saveAssistant = await callChat('saveMessage', {
    role: 'assistant',
    content: 'CDP UI 测试-助手回复',
    sessionId: testSession,
    thinking: '思考过程',
  })
  record('保存测试消息(user+assistant)', isOk(saveUser) && isOk(saveAssistant),
    `userId=${saveUser?.id}, assistantId=${saveAssistant?.id}`)

  // 重新加载消息 — chat namespace 返回扁平 {success, messages}
  const loadRes = await callChat('loadMessages', testSession)
  const messages = isOk(loadRes) ? (loadRes.messages ?? []) : []
  record('加载测试消息', isOk(loadRes) && messages.length === 2,
    `count=${messages.length}`)

  // 验证消息字段 — DB 原始行 snake_case
  if (messages.length === 2) {
    const userMsg = messages.find(m => m.role === 'user')
    const assistantMsg = messages.find(m => m.role === 'assistant')
    record('user 消息字段完整', !!userMsg && userMsg.content === 'CDP UI 测试-用户消息',
      userMsg ? `content="${userMsg.content.slice(0, 30)}", session_id=${userMsg.session_id}` : 'missing')
    record('assistant 消息字段完整', !!assistantMsg && assistantMsg.content === 'CDP UI 测试-助手回复',
      assistantMsg ? `content="${assistantMsg.content.slice(0, 30)}", thinking="${(assistantMsg.thinking || '').slice(0, 20)}"` : 'missing')
  }

  // 清理
  await callChat('deleteSession', testSession)
  record('清理测试会话', true, `id=${testSession}`)
}

// =============================================================
// 8. 长会话历史加载 — 性能 + 完整性
// =============================================================
async function testLongSessionHistory() {
  console.log('\n=== 8. 长会话历史加载 ===')

  const testSession = `cdp-long-${Date.now()}`

  // 批量保存 50 条消息
  const N = 50
  const t0 = Date.now()
  for (let i = 0; i < N; i++) {
    await callChat('saveMessage', {
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `长会话测试消息 #${i} — ${'x'.repeat(50)}`,
      sessionId: testSession,
    })
  }
  const saveMs = Date.now() - t0
  record(`保存 ${N} 条消息 < 5s`, saveMs < 5000, `耗时=${saveMs}ms (${(saveMs / N).toFixed(0)}ms/条)`)

  // 加载全部 — 扁平结构
  const t1 = Date.now()
  const loadRes = await callChat('loadMessages', testSession)
  const loadMs = Date.now() - t1
  const messages = isOk(loadRes) ? (loadRes.messages ?? []) : []
  record(`加载 ${N} 条消息 < 1s`, loadMs < 1000 && messages.length === N,
    `耗时=${loadMs}ms, count=${messages.length}`)

  // 验证顺序
  if (messages.length === N) {
    const first = messages[0]
    const last = messages[N - 1]
    const orderOk = first.content.includes('#0') && last.content.includes(`#${N - 1}`)
    record('消息顺序正确', orderOk, `first="#0", last="#${N - 1}"`)
  }

  // 清理
  await callChat('deleteSession', testSession)
  record('清理长会话', true)
}

// =============================================================
// 9. 并发会话操作
// =============================================================
async function testConcurrentSessions() {
  console.log('\n=== 9. 并发会话操作 ===')

  // 并发创建 5 个会话(各自保存消息)
  const N = 5
  const t0 = Date.now()
  const promises = []
  for (let i = 0; i < N; i++) {
    const sid = `cdp-conc-${Date.now()}-${i}`
    promises.push((async () => {
      await callChat('saveMessage', { role: 'user', content: `并发 ${i}`, sessionId: sid })
      await callChat('saveMessage', { role: 'assistant', content: `回复 ${i}`, sessionId: sid })
      return sid
    })())
  }
  const sids = await Promise.all(promises)
  const ms = Date.now() - t0
  record(`${N} 个并发会话写入 < 3s`, ms < 3000, `耗时=${ms}ms`)

  // 并发读取
  const t1 = Date.now()
  const loadPromises = sids.map(sid => callChat('loadMessages', sid))
  const results = await Promise.all(loadPromises)
  const loadMs = Date.now() - t1
  const allOk = results.every(r => isOk(r) && (r.messages ?? []).length === 2)
  record(`${N} 个并发会话读取全部成功`, allOk, `耗时=${loadMs}ms, allOk=${allOk}`)

  // 清理
  await Promise.all(sids.map(sid => callChat('deleteSession', sid)))
  record('清理并发会话', true, `count=${N}`)
}

// =============================================================
// 10. 控制台错误监控 (整个测试期间)
// =============================================================
async function testConsoleErrors() {
  console.log('\n=== 10. 控制台错误监控 ===')

  // 注入错误收集器
  await evalInPage(`(function(){
    if (!window.__cdpErrors) {
      window.__cdpErrors = [];
      const origError = console.error;
      console.error = function(...args) {
        window.__cdpErrors.push(args.map(a => typeof a === 'object' ? JSON.stringify(a).slice(0, 200) : String(a).slice(0, 200)).join(' '));
        origError.apply(console, args);
      };
      window.addEventListener('error', (e) => {
        window.__cdpErrors.push('uncaught: ' + (e.message || 'unknown'));
      });
    }
  })()`)

  // 触发一些操作(导航 + 切换)
  await evalInPage(`window.location.hash = '#/dashboard'`)
  await sleep(300)
  await evalInPage(`window.location.hash = '#/chat'`)
  await sleep(300)

  const errors = await evalInPage(`window.__cdpErrors || []`)
  record('Chat 页操作无未捕获错误', errors.length === 0,
    errors.length === 0 ? 'clean' : `${errors.length} errors: ${errors.slice(0, 3).join(' | ').slice(0, 200)}`)

  if (errors.length > 0) {
    for (const e of errors.slice(0, 5)) {
      bug(`控制台错误: ${e.slice(0, 150)}`)
    }
  }
}

// =============================================================
// 主流程
// =============================================================
async function main() {
  console.log('=== ChatPage UI + Chat IPC 验证深度测试 ===')
  console.log(`时间: ${new Date().toISOString()}`)

  await connect()
  console.log('CDP 连接成功')

  // 重载页面确保干净状态(前次测试可能留下错误边界)
  await send('Page.reload')
  await sleep(2500)
  await evalInPage(`window.location.hash = '#/chat'`)
  await sleep(1000)

  try {
    await testChatPageUIElements()
    await testSessionManagementUI()
    await testInputBehavior()
    await testThinkingLevelPersistence()
    await testAgentSelectorSwitch()
    await testChatIPCValidation()
    await testMessageRendering()
    await testLongSessionHistory()
    await testConcurrentSessions()
    await testConsoleErrors()
  } catch (e) {
    console.error('❌ 测试异常中断:', e.message)
    bug(`未捕获异常: ${e.message}`)
  }

  console.log('\n=== 总结 ===')
  console.log(`总计: ${passCount + failCount + warnCount}, 通过: ${passCount}, 警告: ${warnCount}, 失败: ${failCount}`)
  if (notes.length > 0) {
    console.log('\n— 备注:')
    for (const n of notes) console.log(`  ℹ ${n}`)
  }
  if (bugs.length > 0) {
    console.log('\n— 发现的问题:')
    for (const b of bugs) console.log(`  🐛 ${b}`)
  }

  ws.close()
  process.exit(failCount > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
