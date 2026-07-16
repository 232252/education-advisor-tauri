import http from 'node:http'

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
  const targets = await fetchJson(`${BASE}/json`)
  const page = targets.find((t) => t.type === 'page')
  if (!page) { console.log('No page target'); process.exit(1) }

  const { default: WebSocket } = await import('ws')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let msgId = 1
  const pending = new Map()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  })
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = msgId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })

  // Test eaa.info with 5s timeout
  const expr = `(async () => {
    const api = window.__EAA_API__ || window.api;
    if (!api) return 'no-api';
    try {
      const r = await Promise.race([
        api.eaa.info(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 5s')), 5000))
      ]);
      return JSON.stringify(r).slice(0, 300);
    } catch (e) {
      return 'ERR: ' + (e.message || String(e));
    }
  })()`

  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) {
    console.log('Eval error:', r.result.exceptionDetails.text)
  } else {
    console.log('eaa.info result:', r.result?.result?.value)
  }

  // Also test agent.list (should work since agent-soul test passed)
  const expr2 = `(async () => {
    const api = window.__EAA_API__ || window.api;
    try {
      const r = await api.agent.list();
      return 'agent.list ok, count=' + (Array.isArray(r) ? r.length : 'non-array');
    } catch (e) {
      return 'ERR: ' + (e.message || String(e));
    }
  })()`
  const r2 = await send('Runtime.evaluate', { expression: expr2, awaitPromise: true, returnByValue: true })
  console.log('agent.list:', r2.result?.result?.value)

  ws.close()
  process.exit(0)
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
