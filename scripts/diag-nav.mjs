// 一次性诊断脚本: 检查导航栏结构
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
console.log('Target:', target.title, target.url)

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 1
const p = new Map()
ws.on('message', (r) => {
  const m = JSON.parse(r.toString())
  if (m.id && p.has(m.id)) {
    p.get(m.id)(m)
    p.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = id++
    p.set(i, r)
    ws.send(JSON.stringify({ id: i, method, params }))
  })

await new Promise((r) => ws.on('open', r))

const expr = `
(function() {
  const nav = document.querySelector('nav');
  if (!nav) return { error: 'no nav' };
  const links = Array.from(nav.querySelectorAll('a'));
  const items = Array.from(nav.children);
  return {
    url: location.href,
    linkCount: links.length,
    linkHrefs: links.map(a => a.getAttribute('href')),
    linkTexts: links.map(a => a.textContent.trim()),
    childCount: items.length,
    childClasses: items.map(c => c.className || c.tagName),
  };
})()
`

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
console.log(JSON.stringify(r.result.result.value, null, 2))
ws.close()
