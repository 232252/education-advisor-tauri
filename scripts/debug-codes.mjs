import http from 'node:http'
import WebSocket from 'ws'

http.get('http://127.0.0.1:9222/json', (res) => {
  let data = ''
  res.on('data', c => data += c)
  res.on('end', async () => {
    const targets = JSON.parse(data).filter(t => t.type === 'page')
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
    let id = 1
    const pending = new Map()
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString())
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    })
    await new Promise(r => ws.on('open', r))
    const send = (method, params = {}) => new Promise(r => { const i = id++; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    const evalP = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      return r.result?.result?.value
    }
    const codes = await evalP(`(async function(){
      const api = window.__EAA_API__ || window.api;
      const r = await api.eaa.codes();
      return r.data.codes.map(c => c.code + ' | ' + c.category + ' | delta=' + (c.score_delta === null ? 'null' : c.score_delta) + ' | ' + c.label);
    })()`)
    console.log('Reason codes:')
    for (const c of codes) console.log('  ' + c)

    // Also check doctor issues
    const doctor = await evalP(`(async function(){
      const api = window.__EAA_API__ || window.api;
      const r = await api.eaa.doctor();
      return r.data;
    })()`)
    console.log('\nDoctor issues:')
    console.log(JSON.stringify(doctor, null, 2))

    ws.close()
    process.exit(0)
  })
})
