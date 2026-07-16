// =============================================================
// CDP Deep Test — AI Chat Persistence & Conversation Management
//
// Connects to a running Tauri 2 app (WebView2 CDP on port 9222)
// and exercises the chat persistence IPC handlers via
// window.__EAA_API__ || window.api.
//
// Coverage (10 sections, ~46 cases):
//   0. API existence            — api.chat / api.ai namespaces + methods
//   1. Create conversation      — saveMessage implicitly creates a session
//   2. List conversations       — listSessions shape + fields
//   3. Send message             — user/assistant/system + full metadata
//   4. Get messages             — loadMessages ordering + count
//   5. Delete conversation      — deleteSession + cascade + idempotency
//   6. Edge cases               — null/non-object msg, empty/invalid role,
//                                  null byte, missing timestamp, bad enum
//   7. Message metadata         — role/content/timestamp + optional fields
//   8. Conversation metadata    — id/title/createdAt/messageCount integrity
//   9. ai.chat IPC smoke        — fire-and-forget returns sessionId, no crash
//  10. Cleanup                  — delete all test sessions
//
// API contract (from src/main/ipc/ai-handlers.ts + db-service.ts):
//   api.chat.saveMessage(msg)     -> {success:boolean, id?:number, error?:string}
//      msg: {sessionId?, role, content, thinking?, toolCalls?, timestamp?,
//            provider?, model?, tokenInput?, tokenOutput?, cost?}
//      - role: non-empty string ≤64 chars (validated)
//      - content: string ≤10MB, empty allowed (validated)
//      - sessionId: optional string ≤256 chars
//      - timestamp: auto-filled with Date.now() if absent
//      - DB CHECK: role IN ('user','assistant','system','tool')
//        invalid enum -> dbService returns -1 -> {success:false, id:-1}
//   api.chat.loadMessages(sid?)   -> {success:boolean, messages:Array, error?}
//      - messages are RAW DB rows (snake_case): id, session_id, role, content,
//        thinking, tool_calls, timestamp, provider, model,
//        token_input, token_output, cost
//      - ordered by timestamp ASC
//      - undefined sid loads 'default' session
//   api.chat.deleteSession(sid)   -> {success:boolean, error?}
//      - idempotent: non-existent sid still returns success:true
//   api.chat.listSessions()       -> {success:boolean, sessions:Array, error?}
//      - sessions are camelCase: {id, title, createdAt, messageCount}
//      - ordered by updated_at DESC
//   api.ai.chat(params)           -> {success:true, message, sessionId}
//      - fire-and-forget: validation errors go to stream channel, not return
//   api.ai.abortChat()            -> {success:boolean, activeChats:number, error?}
// =============================================================
import http from 'node:http'

const CDP_PORT = 9222
const BASE = `http://127.0.0.1:${CDP_PORT}`

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error(`JSON parse fail: ${e.message}`))
        }
      })
    }).on('error', reject)
  })
}

async function main() {
  const results = []
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  }
  // Wrap each test: catch unexpected exceptions so subsequent tests still run
  const test = (name, fn) =>
    fn().catch((err) =>
      record(name, false, `异常: ${String(err && err.message ? err.message : err).slice(0, 160)}`),
    )

  // ---------- CDP connection ----------
  const targets = (await fetchJson(`${BASE}/json`)).filter((t) => t.type === 'page')
  if (targets.length === 0) {
    console.log('FAIL: No CDP targets (is the app running with --remote-debugging-port=9222?)')
    process.exit(1)
  }
  const target = targets[0]
  console.log(`Target: ${target.title} (${target.url})\n`)

  const { default: WebSocket } = await import('ws')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let msgId = 1
  const pending = new Map()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = msgId++
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evalInPage = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.result?.exceptionDetails) {
      throw new Error(`Eval error: ${r.result.exceptionDetails.text}`)
    }
    return r.result?.result?.value
  }

  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP connected, running AI chat persistence deep tests...\n')

  // ---------- IPC wrapper ----------
  // callIpc injects `code` into an IIFE that resolves to the IPC return value.
  // On exception returns {__error: '...'} so the test never throws.
  const callIpc = async (code) =>
    evalInPage(`
      (async function() {
        const api = window.__EAA_API__ || window.api;
        if (!api) return { __error: 'no-api' };
        try {
          ${code}
        } catch (e) {
          return { __error: String(e && e.message ? e.message : e) };
        }
      })()
    `)

  // ---------- chat helpers ----------
  const saveMessage = (msg) =>
    callIpc(`const res = await api.chat.saveMessage(${JSON.stringify(msg)}); return res;`)
  const loadMessages = (sid) =>
    callIpc(`const res = await api.chat.loadMessages(${JSON.stringify(sid)}); return res;`)
  const loadMessagesDefault = () =>
    callIpc(`const res = await api.chat.loadMessages(); return res;`)
  const deleteSession = (sid) =>
    callIpc(`const res = await api.chat.deleteSession(${JSON.stringify(sid)}); return res;`)
  const listSessions = () => callIpc(`const res = await api.chat.listSessions(); return res;`)

  // ---------- assertion helpers ----------
  const isSuccess = (r) => !!r && !r.__error && r.success === true
  const isRejected = (r) => !!r && (r.__error || r.success === false)
  const notCrash = (r) =>
    r != null && (r.success === true || r.success === false || !!r.__error)

  // ---------- test data tracking ----------
  const TS = Date.now()
  const createdSessionIds = new Set()

  // =============================================================
  // 0. API existence
  // =============================================================
  console.log('━━━ 0. API existence ━━━')

  await test('0.1 window.api object exists', async () => {
    const r = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        return { ok: !!api, keys: api ? Object.keys(api).slice(0, 20) : [] };
      })()
    `)
    record('0.1 window.api object exists', !!r?.ok, `keys=[${r?.keys?.join(',') ?? ''}]`)
  })

  await test('0.2 api.chat namespace exists', async () => {
    const r = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        return { ok: !!api && !!api.chat, keys: api && api.chat ? Object.keys(api.chat) : [] };
      })()
    `)
    record('0.2 api.chat namespace exists', !!r?.ok, `keys=[${r?.keys?.join(',') ?? ''}]`)
  })

  await test('0.3 api.chat has expected methods (saveMessage/loadMessages/deleteSession/listSessions)', async () => {
    const r = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        if (!api || !api.chat) return { ok: false, missing: ['chat'] };
        const expected = ['saveMessage', 'loadMessages', 'deleteSession', 'listSessions'];
        const missing = expected.filter((m) => typeof api.chat[m] !== 'function');
        return { ok: missing.length === 0, missing: missing };
      })()
    `)
    record(
      '0.3 api.chat has expected methods (saveMessage/loadMessages/deleteSession/listSessions)',
      !!r?.ok,
      `missing=[${r?.missing?.join(',') ?? ''}]`,
    )
  })

  await test('0.4 api.ai namespace exists with chat + abortChat methods', async () => {
    const r = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        if (!api || !api.ai) return { ok: false, missing: ['ai'] };
        const expected = ['chat', 'abortChat'];
        const missing = expected.filter((m) => typeof api.ai[m] !== 'function');
        return { ok: missing.length === 0, missing: missing };
      })()
    `)
    record('0.4 api.ai namespace exists with chat + abortChat methods', !!r?.ok, `missing=[${r?.missing?.join(',') ?? ''}]`)
  })

  await test('0.5 api.ai.onStream subscription method exists', async () => {
    const r = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        return { ok: !!api && !!api.ai && typeof api.ai.onStream === 'function' };
      })()
    `)
    record('0.5 api.ai.onStream subscription method exists', !!r?.ok, `ok=${r?.ok}`)
  })

  // =============================================================
  // 1. Create conversation
  // =============================================================
  console.log('\n━━━ 1. Create conversation ━━━')

  const SID_A = `cdp-chat-A-${TS}`
  let firstMsgId = null

  await test('1.1 saveMessage (user) implicitly creates a session', async () => {
    const r = await saveMessage({
      sessionId: SID_A,
      role: 'user',
      content: `Hello from CDP test ${TS}`,
      timestamp: TS,
    })
    if (isSuccess(r)) {
      firstMsgId = r.id
      createdSessionIds.add(SID_A)
    }
    record(
      '1.1 saveMessage (user) implicitly creates a session',
      isSuccess(r) && typeof r.id === 'number' && r.id > 0,
      `success=${r?.success} id=${r?.id} err=${r?.error ?? r?.__error ?? ''}`,
    )
  })

  await test('1.2 saveMessage returns numeric id > 0', async () => {
    record(
      '1.2 saveMessage returns numeric id > 0',
      typeof firstMsgId === 'number' && firstMsgId > 0,
      `id=${firstMsgId}`,
    )
  })

  await test('1.3 New session appears in listSessions', async () => {
    const r = await listSessions()
    const sessions = r?.sessions ?? []
    const found = sessions.find((s) => s.id === SID_A)
    record(
      '1.3 New session appears in listSessions',
      isSuccess(r) && !!found,
      `total=${sessions.length} found=${!!found} id=${found?.id ?? ''}`,
    )
  })

  // =============================================================
  // 2. List conversations
  // =============================================================
  console.log('\n━━━ 2. List conversations ━━━')

  await test('2.1 listSessions returns success + sessions array', async () => {
    const r = await listSessions()
    record(
      '2.1 listSessions returns success + sessions array',
      isSuccess(r) && Array.isArray(r.sessions),
      `success=${r?.success} isArray=${Array.isArray(r?.sessions)} len=${r?.sessions?.length ?? -1}`,
    )
  })

  await test('2.2 Each session has camelCase fields (id/title/createdAt/messageCount)', async () => {
    const r = await listSessions()
    const sessions = r?.sessions ?? []
    const target = sessions.find((s) => s.id === SID_A)
    const hasFields =
      !!target &&
      'id' in target &&
      'title' in target &&
      'createdAt' in target &&
      'messageCount' in target
    record(
      '2.2 Each session has camelCase fields (id/title/createdAt/messageCount)',
      !!hasFields,
      `id=${target?.id ?? ''} title=${typeof target?.title} createdAt=${typeof target?.createdAt} messageCount=${target?.messageCount}`,
    )
  })

  await test('2.3 Test session messageCount === 1 after first save', async () => {
    const r = await listSessions()
    const target = (r?.sessions ?? []).find((s) => s.id === SID_A)
    record(
      '2.3 Test session messageCount === 1 after first save',
      !!target && target.messageCount === 1,
      `messageCount=${target?.messageCount ?? -1}`,
    )
  })

  await test('2.4 Test session title is a non-empty string', async () => {
    const r = await listSessions()
    const target = (r?.sessions ?? []).find((s) => s.id === SID_A)
    const okTitle =
      !!target && typeof target.title === 'string' && target.title.length > 0
    record(
      '2.4 Test session title is a non-empty string',
      okTitle,
      `title="${target?.title ?? ''}"`,
    )
  })

  // =============================================================
  // 3. Send message (multiple roles + full metadata)
  // =============================================================
  console.log('\n━━━ 3. Send message ━━━')

  await test('3.1 Save additional user message to existing session', async () => {
    const r = await saveMessage({
      sessionId: SID_A,
      role: 'user',
      content: `Second user message ${TS}`,
      timestamp: TS + 1000,
    })
    record(
      '3.1 Save additional user message to existing session',
      isSuccess(r) && r.id > firstMsgId,
      `success=${r?.success} id=${r?.id} (prev=${firstMsgId})`,
    )
  })

  await test('3.2 Save assistant message with thinking + toolCalls', async () => {
    const r = await saveMessage({
      sessionId: SID_A,
      role: 'assistant',
      content: `Assistant reply ${TS}`,
      thinking: 'internal reasoning',
      toolCalls: JSON.stringify([{ name: 'search', args: { q: 'test' } }]),
      timestamp: TS + 2000,
    })
    record(
      '3.2 Save assistant message with thinking + toolCalls',
      isSuccess(r),
      `success=${r?.success} id=${r?.id} err=${r?.error ?? ''}`,
    )
  })

  await test('3.3 Save message with full metadata (provider/model/tokens/cost)', async () => {
    const r = await saveMessage({
      sessionId: SID_A,
      role: 'assistant',
      content: `Full metadata message ${TS}`,
      provider: 'openai',
      model: 'gpt-4-test',
      tokenInput: 120,
      tokenOutput: 45,
      cost: 0.0021,
      timestamp: TS + 3000,
    })
    record(
      '3.3 Save message with full metadata (provider/model/tokens/cost)',
      isSuccess(r),
      `success=${r?.success} id=${r?.id} err=${r?.error ?? ''}`,
    )
  })

  await test('3.4 messageCount increments to 4 after 4 saves', async () => {
    const r = await listSessions()
    const target = (r?.sessions ?? []).find((s) => s.id === SID_A)
    record(
      '3.4 messageCount increments to 4 after 4 saves',
      !!target && target.messageCount === 4,
      `messageCount=${target?.messageCount ?? -1} (expected 4)`,
    )
  })

  await test('3.5 Save system message (allowed role enum)', async () => {
    const r = await saveMessage({
      sessionId: SID_A,
      role: 'system',
      content: 'System prompt for test session',
      timestamp: TS + 4000,
    })
    record(
      '3.5 Save system message (allowed role enum)',
      isSuccess(r),
      `success=${r?.success} id=${r?.id} err=${r?.error ?? ''}`,
    )
  })

  // =============================================================
  // 4. Get messages
  // =============================================================
  console.log('\n━━━ 4. Get messages ━━━')

  await test('4.1 loadMessages(sessionId) returns success + messages array', async () => {
    const r = await loadMessages(SID_A)
    record(
      '4.1 loadMessages(sessionId) returns success + messages array',
      isSuccess(r) && Array.isArray(r.messages),
      `success=${r?.success} isArray=${Array.isArray(r?.messages)} len=${r?.messages?.length ?? -1}`,
    )
  })

  await test('4.2 Messages count matches saves (5 messages)', async () => {
    const r = await loadMessages(SID_A)
    const count = r?.messages?.length ?? -1
    record(
      '4.2 Messages count matches saves (5 messages)',
      count === 5,
      `count=${count} (expected 5)`,
    )
  })

  await test('4.3 Messages ordered by timestamp ASC', async () => {
    const r = await loadMessages(SID_A)
    const msgs = r?.messages ?? []
    let ordered = true
    for (let i = 1; i < msgs.length; i++) {
      if (msgs[i].timestamp < msgs[i - 1].timestamp) {
        ordered = false
        break
      }
    }
    record(
      '4.3 Messages ordered by timestamp ASC',
      ordered && msgs.length > 1,
      `ordered=${ordered} count=${msgs.length} first=${msgs[0]?.timestamp} last=${msgs[msgs.length - 1]?.timestamp}`,
    )
  })

  await test('4.4 loadMessages() without sessionId loads default session (no crash)', async () => {
    const r = await loadMessagesDefault()
    record(
      '4.4 loadMessages() without sessionId loads default session (no crash)',
      isSuccess(r) && Array.isArray(r.messages),
      `success=${r?.success} isArray=${Array.isArray(r?.messages)} defaultLen=${r?.messages?.length ?? -1}`,
    )
  })

  // =============================================================
  // 5. Delete conversation
  // =============================================================
  console.log('\n━━━ 5. Delete conversation ━━━')

  // Use a separate session for delete tests so SID_A metadata assertions stay valid
  const SID_DEL = `cdp-chat-DEL-${TS}`
  await test('5.0 Setup: create session for deletion test', async () => {
    const r = await saveMessage({
      sessionId: SID_DEL,
      role: 'user',
      content: 'to be deleted',
      timestamp: TS,
    })
    if (isSuccess(r)) createdSessionIds.add(SID_DEL)
    record('5.0 Setup: create session for deletion test', isSuccess(r), `success=${r?.success}`)
  })

  await test('5.1 deleteSession(sessionId) returns success:true', async () => {
    const r = await deleteSession(SID_DEL)
    record(
      '5.1 deleteSession(sessionId) returns success:true',
      isSuccess(r),
      `success=${r?.success} err=${r?.error ?? ''}`,
    )
  })

  await test('5.2 Session disappears from listSessions after deletion', async () => {
    const r = await listSessions()
    const gone = !(r?.sessions ?? []).some((s) => s.id === SID_DEL)
    record(
      '5.2 Session disappears from listSessions after deletion',
      isSuccess(r) && gone,
      `gone=${gone} (sessions checked=${r?.sessions?.length ?? 0})`,
    )
  })

  await test('5.3 Messages for deleted session are gone (loadMessages returns empty)', async () => {
    const r = await loadMessages(SID_DEL)
    record(
      '5.3 Messages for deleted session are gone (loadMessages returns empty)',
      isSuccess(r) && Array.isArray(r.messages) && r.messages.length === 0,
      `success=${r?.success} len=${r?.messages?.length ?? -1}`,
    )
  })

  await test('5.4 deleteSession on already-deleted session is idempotent (no crash)', async () => {
    const r = await deleteSession(SID_DEL)
    record(
      '5.4 deleteSession on already-deleted session is idempotent (no crash)',
      notCrash(r),
      `success=${r?.success} err=${r?.error ?? r?.__error ?? ''}`,
    )
  })

  // =============================================================
  // 6. Edge cases
  // =============================================================
  console.log('\n━━━ 6. Edge cases ━━━')

  await test('6.1 loadMessages with non-existent sessionId returns empty array', async () => {
    const r = await loadMessages(`nonexistent-sid-${TS}`)
    record(
      '6.1 loadMessages with non-existent sessionId returns empty array',
      isSuccess(r) && Array.isArray(r.messages) && r.messages.length === 0,
      `success=${r?.success} len=${r?.messages?.length ?? -1}`,
    )
  })

  await test('6.2 deleteSession with non-existent sessionId returns success:true (idempotent)', async () => {
    const r = await deleteSession(`nonexistent-sid-${TS}`)
    record(
      '6.2 deleteSession with non-existent sessionId returns success:true (idempotent)',
      isSuccess(r),
      `success=${r?.success} err=${r?.error ?? ''}`,
    )
  })

  await test('6.3 saveMessage with null msg returns {success:false}', async () => {
    const r = await callIpc(`const res = await api.chat.saveMessage(null); return res;`)
    record(
      '6.3 saveMessage with null msg returns {success:false}',
      isRejected(r),
      `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 80)}`,
    )
  })

  await test('6.4 saveMessage with non-object msg (string) returns {success:false}', async () => {
    const r = await callIpc(`const res = await api.chat.saveMessage("hello"); return res;`)
    record(
      '6.4 saveMessage with non-object msg (string) returns {success:false}',
      isRejected(r),
      `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 80)}`,
    )
  })

  await test('6.5 saveMessage with empty content (allowed) succeeds', async () => {
    const SID_EMPTY = `cdp-chat-EMPTY-${TS}`
    const r = await saveMessage({
      sessionId: SID_EMPTY,
      role: 'assistant',
      content: '',
      timestamp: TS,
    })
    if (isSuccess(r)) createdSessionIds.add(SID_EMPTY)
    record(
      '6.5 saveMessage with empty content (allowed) succeeds',
      isSuccess(r),
      `success=${r?.success} id=${r?.id} err=${r?.error ?? ''}`,
    )
  })

  await test('6.6 saveMessage with empty role returns {success:false}', async () => {
    const r = await saveMessage({
      sessionId: `cdp-chat-BADROLE-${TS}`,
      role: '',
      content: 'x',
      timestamp: TS,
    })
    record(
      '6.6 saveMessage with empty role returns {success:false}',
      isRejected(r),
      `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 80)}`,
    )
  })

  await test('6.7 saveMessage with non-string role returns {success:false}', async () => {
    const r = await callIpc(`
      const res = await api.chat.saveMessage({ role: 123, content: 'x', timestamp: ${TS} });
      return res;
    `)
    record(
      '6.7 saveMessage with non-string role returns {success:false}',
      isRejected(r),
      `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 80)}`,
    )
  })

  await test('6.8 saveMessage with null byte in content returns {success:false}', async () => {
    const r = await callIpc(`
      const res = await api.chat.saveMessage({ sessionId: 'cdp-chat-NULL-${TS}', role: 'user', content: 'a\\u0000b', timestamp: ${TS} });
      return res;
    `)
    record(
      '6.8 saveMessage with null byte in content returns {success:false}',
      isRejected(r),
      `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 80)}`,
    )
  })

  await test('6.9 saveMessage without timestamp auto-fills Date.now() and succeeds', async () => {
    const SID_NOTS = `cdp-chat-NOTS-${TS}`
    const before = Date.now()
    const r = await callIpc(`
      const res = await api.chat.saveMessage({ sessionId: ${JSON.stringify(SID_NOTS)}, role: 'user', content: 'no ts' });
      return res;
    `)
    if (isSuccess(r)) createdSessionIds.add(SID_NOTS)
    // Verify the auto-filled timestamp landed in the DB
    const loaded = await loadMessages(SID_NOTS)
    const msgs = loaded?.messages ?? []
    const autoTs = msgs.length > 0 ? msgs[0].timestamp : null
    const tsOk =
      typeof autoTs === 'number' && autoTs >= before && autoTs <= Date.now() + 1000
    record(
      '6.9 saveMessage without timestamp auto-fills Date.now() and succeeds',
      isSuccess(r) && tsOk,
      `success=${r?.success} autoTs=${autoTs} before=${before}`,
    )
  })

  await test('6.10 saveMessage with invalid enum role returns {success:false, id:-1}', async () => {
    // 'admin' is a valid string but not in DB CHECK(role IN ('user','assistant','system','tool'))
    // -> validateString passes, dbService.insertChatMessage fails, returns -1
    const r = await saveMessage({
      sessionId: `cdp-chat-BADENUM-${TS}`,
      role: 'admin',
      content: 'invalid enum',
      timestamp: TS,
    })
    const ok = !!r && !r.__error && r.success === false && r.id === -1
    record(
      '6.10 saveMessage with invalid enum role returns {success:false, id:-1}',
      ok,
      `success=${r?.success} id=${r?.id} err=${r?.error ?? 'none (DB-level rejection)'}`,
    )
  })

  // =============================================================
  // 7. Message metadata
  // =============================================================
  console.log('\n━━━ 7. Message metadata ━━━')

  // Reload messages for SID_A and verify field integrity
  const sidAMsgs = (await loadMessages(SID_A))?.messages ?? []
  const firstMsg = sidAMsgs.find((m) => m.id === firstMsgId)

  await test('7.1 Saved message has correct role field', async () => {
    record(
      '7.1 Saved message has correct role field',
      !!firstMsg && firstMsg.role === 'user',
      `role=${firstMsg?.role ?? ''} (expected user)`,
    )
  })

  await test('7.2 Saved message has correct content field', async () => {
    const expected = `Hello from CDP test ${TS}`
    record(
      '7.2 Saved message has correct content field',
      !!firstMsg && firstMsg.content === expected,
      `content="${String(firstMsg?.content ?? '').slice(0, 60)}"`,
    )
  })

  await test('7.3 Saved message has numeric timestamp field', async () => {
    record(
      '7.3 Saved message has numeric timestamp field',
      !!firstMsg && typeof firstMsg.timestamp === 'number' && firstMsg.timestamp === TS,
      `timestamp=${firstMsg?.timestamp ?? ''} (expected ${TS})`,
    )
  })

  await test('7.4 Saved message preserves snake_case optional fields (thinking/tool_calls/provider/model/token_input/token_output/cost)', async () => {
    // Find the assistant message saved in 3.3 with full metadata
    const full = sidAMsgs.find(
      (m) => m.role === 'assistant' && m.model === 'gpt-4-test',
    )
    const ok =
      !!full &&
      full.provider === 'openai' &&
      full.model === 'gpt-4-test' &&
      full.token_input === 120 &&
      full.token_output === 45 &&
      full.cost === 0.0021
    record(
      '7.4 Saved message preserves snake_case optional fields (thinking/tool_calls/provider/model/token_input/token_output/cost)',
      ok,
      `provider=${full?.provider} model=${full?.model} token_input=${full?.token_input} token_output=${full?.token_output} cost=${full?.cost}`,
    )
  })

  await test('7.5 Saved assistant message preserves thinking + tool_calls fields', async () => {
    // Find the assistant message saved in 3.2 with thinking/toolCalls
    const asst = sidAMsgs.find((m) => m.role === 'assistant' && m.thinking === 'internal reasoning')
    const ok =
      !!asst &&
      asst.thinking === 'internal reasoning' &&
      typeof asst.tool_calls === 'string' &&
      asst.tool_calls.includes('search')
    record(
      '7.5 Saved assistant message preserves thinking + tool_calls fields',
      ok,
      `thinking="${asst?.thinking ?? ''}" tool_calls_len=${asst?.tool_calls?.length ?? -1}`,
    )
  })

  await test('7.6 All saved messages have session_id matching the test session', async () => {
    const allMatch = sidAMsgs.every((m) => m.session_id === SID_A)
    record(
      '7.6 All saved messages have session_id matching the test session',
      sidAMsgs.length > 0 && allMatch,
      `count=${sidAMsgs.length} allMatch=${allMatch}`,
    )
  })

  // =============================================================
  // 8. Conversation metadata
  // =============================================================
  console.log('\n━━━ 8. Conversation metadata ━━━')

  await test('8.1 Session id field matches sessionId used in saveMessage', async () => {
    const r = await listSessions()
    const target = (r?.sessions ?? []).find((s) => s.id === SID_A)
    record(
      '8.1 Session id field matches sessionId used in saveMessage',
      !!target && target.id === SID_A,
      `session.id=${target?.id ?? ''}`,
    )
  })

  await test('8.2 Session title is auto-generated non-empty string', async () => {
    const r = await listSessions()
    const target = (r?.sessions ?? []).find((s) => s.id === SID_A)
    const okTitle =
      !!target && typeof target.title === 'string' && target.title.trim().length > 0
    record(
      '8.2 Session title is auto-generated non-empty string',
      okTitle,
      `title="${target?.title ?? ''}"`,
    )
  })

  await test('8.3 Session createdAt is a positive number', async () => {
    const r = await listSessions()
    const target = (r?.sessions ?? []).find((s) => s.id === SID_A)
    record(
      '8.3 Session createdAt is a positive number',
      !!target && typeof target.createdAt === 'number' && target.createdAt > 0,
      `createdAt=${target?.createdAt ?? ''}`,
    )
  })

  await test('8.4 Session messageCount equals actual message count from loadMessages', async () => {
    const lr = await loadMessages(SID_A)
    const ls = await listSessions()
    const target = (ls?.sessions ?? []).find((s) => s.id === SID_A)
    const actualCount = lr?.messages?.length ?? -1
    const ok = !!target && target.messageCount === actualCount && actualCount === 5
    record(
      '8.4 Session messageCount equals actual message count from loadMessages',
      ok,
      `session.messageCount=${target?.messageCount ?? -1} actual=${actualCount} (expected 5)`,
    )
  })

  await test('8.5 listSessions does not include snake_case fields (no created_at / message_count)', async () => {
    const r = await listSessions()
    const target = (r?.sessions ?? []).find((s) => s.id === SID_A)
    const noSnake =
      !!target && !('created_at' in target) && !('message_count' in target) && !('updated_at' in target)
    record(
      '8.5 listSessions does not include snake_case fields (no created_at / message_count)',
      noSnake,
      `has_created_at=${target && 'created_at' in target} has_message_count=${target && 'message_count' in target}`,
    )
  })

  // =============================================================
  // 9. ai.chat IPC smoke test (fire-and-forget, no LLM call)
  // =============================================================
  console.log('\n━━━ 9. ai.chat IPC smoke test ━━━')

  await test('9.1 ai.chat({}) returns success:true + sessionId (fire-and-forget, no crash)', async () => {
    // Empty params: validation runs INSIDE the IIFE, so the IPC call itself
    // still returns {success:true, sessionId} immediately. The validation
    // error is sent to the stream channel asynchronously.
    const r = await callIpc(`const res = await api.ai.chat({}); return res;`)
    const ok =
      !!r &&
      !r.__error &&
      r.success === true &&
      typeof r.sessionId === 'string' &&
      r.sessionId.length > 0
    record(
      '9.1 ai.chat({}) returns success:true + sessionId (fire-and-forget, no crash)',
      ok,
      `success=${r?.success} sessionId=${r?.sessionId ?? ''} err=${r?.__error ?? ''}`,
    )
  })

  await test('9.2 ai.abortChat() returns object with success + activeChats fields', async () => {
    const r = await callIpc(`const res = await api.ai.abortChat(); return res;`)
    const ok =
      !!r &&
      !r.__error &&
      typeof r === 'object' &&
      'success' in r &&
      'activeChats' in r &&
      typeof r.activeChats === 'number'
    record(
      '9.2 ai.abortChat() returns object with success + activeChats fields',
      ok,
      `success=${r?.success} activeChats=${r?.activeChats ?? ''} err=${r?.__error ?? ''}`,
    )
  })

  await test('9.3 ai.chat with non-object params does not crash IPC (returns sessionId)', async () => {
    const r = await callIpc(`const res = await api.ai.chat(null); return res;`)
    // null params -> IIFE throws TypeError on params.providerId -> caught -> sent to stream
    // IPC returns {success:true, sessionId} regardless
    const noCrash = !!r && !r.__error && r.success === true
    record(
      '9.3 ai.chat with non-object params does not crash IPC (returns sessionId)',
      noCrash,
      `success=${r?.success} sessionId=${r?.sessionId ?? ''} err=${r?.__error ?? ''}`,
    )
  })

  // =============================================================
  // 10. Cleanup — delete all test sessions
  // =============================================================
  console.log('\n━━━ 10. Cleanup test data ━━━')

  await test('10.1 Delete all test sessions created during the run', async () => {
    let okCount = 0
    let total = 0
    for (const sid of Array.from(createdSessionIds)) {
      total++
      try {
        const r = await deleteSession(sid)
        if (isSuccess(r)) okCount++
      } catch (e) {}
    }
    record(
      '10.1 Delete all test sessions created during the run',
      okCount === total && total > 0,
      `${okCount}/${total} deleted`,
    )
  })

  await test('10.2 Verify no test sessions remain in listSessions', async () => {
    const r = await listSessions()
    const remaining = (r?.sessions ?? []).filter((s) =>
      String(s.id).startsWith('cdp-chat-'),
    )
    record(
      '10.2 Verify no test sessions remain in listSessions',
      remaining.length === 0,
      `remaining=${remaining.length} ids=[${remaining.map((s) => s.id).join(',')}]`,
    )
  })

  // =============================================================
  // Summary
  // =============================================================
  console.log('\n========== AI Chat Persistence & Conversation Management Deep Test ==========')
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  console.log(`总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`)
  if (failed > 0) {
    console.log('\n失败项:')
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  - ${r.name}: ${r.detail}`)
    }
  }

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
