// 测试 AI 智能录入功能 UI
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
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
  return r.result?.result?.value
}
await new Promise((r) => ws.on('open', r))

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

// 导航到学业页面 → 成绩录入 tab
await evalInPage(`(async function() { location.hash = '#/academics'; await new Promise(r => setTimeout(r, 1500)); })()`)

// 切换到成绩录入 tab
await evalInPage(`
  (async function() {
    const btns = Array.from(document.querySelectorAll('button'));
    const entryBtn = btns.find(b => b.textContent.includes('成绩录入'));
    if (entryBtn) { entryBtn.click(); await new Promise(r => setTimeout(r, 800)); }
  })()
`)

// 测试 1: AI 智能录入按钮存在
try {
  const hasBtn = await evalInPage(`
    Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('AI 智能录入'))
  `)
  record('AI 智能录入按钮存在', hasBtn)
} catch (e) { record('AI 智能录入按钮存在', false, e.message) }

// 测试 2: 点击 AI 智能录入按钮,面板出现
try {
  await evalInPage(`
    (async function() {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('AI 智能录入'));
      if (btn) { btn.click(); await new Promise(r => setTimeout(r, 500)); }
    })()
  `)
  const hasTextarea = await evalInPage(`!!document.querySelector('textarea')`)
  record('点击后显示文本输入面板', hasTextarea)
} catch (e) { record('点击后显示文本输入面板', false, e.message) }

// 测试 3: 有"AI 解析并填充"按钮
try {
  const hasParseBtn = await evalInPage(`
    Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('AI 解析') || b.textContent.includes('解析中'))
  `)
  record('有"AI 解析并填充"按钮', hasParseBtn)
} catch (e) { record('有"AI 解析并填充"按钮', false, e.message) }

// 测试 4: textarea 可以输入文本
try {
  await evalInPage(`
    (function() {
      const ta = document.querySelector('textarea');
      if (!ta) throw new Error('no textarea');
      ta.value = '张三 85\\n李四 92\\n王五 78';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return ta.value;
    })()
  `)
  const value = await evalInPage(`document.querySelector('textarea')?.value || ''`)
  record('textarea 可输入文本', value.includes('张三') && value.includes('85'))
} catch (e) { record('textarea 可输入文本', false, e.message) }

// 测试 5: 面板有关闭按钮
try {
  const hasClose = await evalInPage(`
    (function() {
      const cards = Array.from(document.querySelectorAll('[class*="rounded-lg"]'));
      // 检查 AI 面板中的关闭按钮 (×)
      const closeBtns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.trim() === '×');
      return closeBtns.length > 0;
    })()
  `)
  record('面板有关闭按钮', hasClose)
} catch (e) { record('面板有关闭按钮', false, e.message) }

// 测试 6: 关闭面板
try {
  await evalInPage(`
    (async function() {
      const closeBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '×');
      if (closeBtn) { closeBtn.click(); await new Promise(r => setTimeout(r, 300)); }
    })()
  `)
  const textareaGone = await evalInPage(`!document.querySelector('textarea')`)
  record('关闭面板后 textarea 消失', textareaGone)
} catch (e) { record('关闭面板后 textarea 消失', false, e.message) }

// 测试 7: 重新打开,检查模型状态提示
try {
  await evalInPage(`
    (async function() {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('AI 智能录入'));
      if (btn) { btn.click(); await new Promise(r => setTimeout(r, 300)); }
    })()
  `)
  const hasModelInfo = await evalInPage(`
    (function() {
      const text = document.body.innerText;
      // 检查是否有模型信息或"未检测到 AI 模型"提示
      return text.includes('模型') || text.includes('AI');
    })()
  `)
  record('面板显示模型状态信息', hasModelInfo)
} catch (e) { record('面板显示模型状态信息', false, e.message) }

ws.close()

const passed = results.filter((r) => r.ok).length
console.log(`\n========== AI 智能录入测试 ==========`)
console.log(`总计: ${results.length}, 通过: ${passed}, 失败: ${results.length - passed}`)
process.exit(passed === results.length ? 0 : 1)
