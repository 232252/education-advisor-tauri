import http from 'node:http'
import WebSocket from 'ws'

const get = (u) => new Promise((r, j) => {
  http.get(u, (res) => {
    let d = ''
    res.on('data', (c) => (d += c))
    res.on('end', () => r(JSON.parse(d)))
  }).on('error', j)
})

const targets = (await get('http://127.0.0.1:9222/json')).filter((x) => x.type === 'page')
const target = targets[0]
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 1
const p = new Map()
ws.on('message', (r) => {
  const m = JSON.parse(r.toString())
  if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) }
})
const send = (method, params = {}) => new Promise((r) => {
  const i = id++; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params }))
})
const evalInPage = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) {
    const desc = r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'unknown'
    throw new Error(desc.substring(0, 500))
  }
  return r.result?.result?.value
}
await new Promise((r) => ws.on('open', r))

// Check current URL and page state
const url = await evalInPage(`location.href`)
console.log('URL:', url)

const bodyLen = await evalInPage(`document.body?.innerHTML?.length || 0`)
console.log('Body HTML length:', bodyLen)

const bodyText = await evalInPage(`document.body?.textContent?.substring(0, 500) || ''`)
console.log('Body text:', bodyText)

const btns = await evalInPage(`Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim().substring(0, 30)).slice(0, 20)`)
console.log('Buttons:', btns)

// Check for error overlay
const hasError = await evalInPage(`!!document.querySelector('vite-error-overlay, .vite-error-overlay')`)
console.log('Has Vite error overlay:', hasError)

const errorOverlay = await evalInPage(`document.querySelector('vite-error-overlay')?.shadowRoot?.textContent?.substring(0, 500) || ''`)
console.log('Error overlay text:', errorOverlay)

ws.close()
