// 测试学业直接录入功能 — 无需先建考试
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
    throw new Error(desc.substring(0, 200))
  }
  return r.result?.result?.value
}
await new Promise((r) => ws.on('open', r))

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

// 导航到学业页面
await evalInPage(`(async function() { location.hash = '#/academics'; await new Promise(r => setTimeout(r, 1500)); })()`)

// 切换到成绩录入 tab
await evalInPage(`
  (async function() {
    const btns = Array.from(document.querySelectorAll('button'));
    const entryBtn = btns.find(b => b.textContent.includes('成绩录入'));
    if (entryBtn) { entryBtn.click(); await new Promise(r => setTimeout(r, 800)); }
  })()
`)

// 测试 1: 不应出现"暂无考试"强制创建界面
try {
  const hasForceCreate = await evalInPage(`
    (function() {
      // 检查是否有"暂无考试"标题的 EmptyState
      const emptyStates = Array.from(document.querySelectorAll('div'));
      const hasNoExamText = emptyStates.some(e => e.textContent.includes('暂无考试') && e.textContent.length < 50);
      return hasNoExamText;
    })()
  `)
  record('不显示"暂无考试"强制创建界面', !hasForceCreate)
} catch (e) { record('不显示"暂无考试"强制创建界面', false, e.message) }

// 测试 2: 成绩录入表单直接显示(不要求先选考试)
try {
  // 切换到单科录入模式
  await evalInPage(`
    (async function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const singleBtn = btns.find(b => b.textContent.includes('单科录入'));
      if (singleBtn) { singleBtn.click(); await new Promise(r => setTimeout(r, 500)); }
    })()
  `)
  // 检查是否有模式切换按钮(说明表单已显示)
  const hasModeSelector = await evalInPage(`
    Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('单科录入') || b.textContent.includes('全科录入'))
  `)
  record('成绩录入表单直接显示(不阻断)', hasModeSelector)
} catch (e) { record('成绩录入表单直接显示(不阻断)', false, e.message) }

// 测试 3: 考试选择器标签显示"可选"而非必填*
try {
  const examLabelOptional = await evalInPage(`
    (function() {
      const labels = Array.from(document.querySelectorAll('label'));
      const examLabel = labels.find(l => l.textContent.includes('考试'));
      if (!examLabel) return false;
      // 应包含"可选"字样,不应有红色*必填标记
      return examLabel.textContent.includes('可选') || !examLabel.textContent.includes('*');
    })()
  `)
  record('考试字段标记为可选(非必填)', examLabelOptional)
} catch (e) { record('考试字段标记为可选(非必填)', false, e.message) }

// 测试 4: 考试选择器有"不选,直接录入"选项
try {
  const hasDirectOption = await evalInPage(`
    (function() {
      const selects = Array.from(document.querySelectorAll('select'));
      const examSelect = selects.find(s => {
        const opts = Array.from(s.options).map(o => o.textContent);
        return opts.some(t => t.includes('考试') || t.includes('不选'));
      });
      if (!examSelect) return false;
      const opts = Array.from(examSelect.options).map(o => o.textContent);
      return opts.some(t => t.includes('不选') || t.includes('直接录入'));
    })()
  `)
  record('考试选择器有"不选,直接录入"选项', hasDirectOption)
} catch (e) { record('考试选择器有"不选,直接录入"选项', false, e.message) }

// 测试 5: 选择科目后成绩表显示(不要求先选考试)
try {
  await evalInPage(`
    (async function() {
      // 选择科目
      const selects = Array.from(document.querySelectorAll('select'));
      for (const s of selects) {
        const opts = Array.from(s.options).map(o => o.textContent);
        if (opts.some(t => t.includes('语文') || t.includes('数学') || t.includes('请选择科目'))) {
          // 选择第一个科目(跳过"请选择"占位)
          if (s.options.length > 1) {
            s.selectedIndex = 1;
            s.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(r => setTimeout(r, 600));
            break;
          }
        }
      }
    })()
  `)
  const hasScoreTable = await evalInPage(`
    (function() {
      const tables = Array.from(document.querySelectorAll('table'));
      return tables.some(t => {
        const headers = Array.from(t.querySelectorAll('th')).map(h => h.textContent);
        return headers.some(h => h.includes('成绩') || h.includes('分数'));
      });
    })()
  `)
  record('选科目后成绩表显示(无需先选考试)', hasScoreTable)
} catch (e) { record('选科目后成绩表显示(无需先选考试)', false, e.message) }

// 测试 6: 成绩表有保存按钮
try {
  const hasSaveBtn = await evalInPage(`
    Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('保存成绩'))
  `)
  record('成绩表有保存按钮', hasSaveBtn)
} catch (e) { record('成绩表有保存按钮', false, e.message) }

// 测试 7: 全科录入模式也不阻断
try {
  await evalInPage(`
    (async function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const allBtn = btns.find(b => b.textContent.includes('全科录入'));
      if (allBtn) { allBtn.click(); await new Promise(r => setTimeout(r, 500)); }
    })()
  `)
  const hasStudentSelector = await evalInPage(`
    (function() {
      const selects = Array.from(document.querySelectorAll('select'));
      return selects.some(s => {
        const opts = Array.from(s.options).map(o => o.textContent);
        return opts.some(t => t.includes('学生'));
      });
    })()
  `)
  record('全科录入模式可切换(不阻断)', hasStudentSelector)
} catch (e) { record('全科录入模式可切换(不阻断)', false, e.message) }

// 测试 8: AI 智能录入按钮仍存在
try {
  const hasAIBtn = await evalInPage(`
    Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('AI 智能录入'))
  `)
  record('AI 智能录入按钮仍存在', hasAIBtn)
} catch (e) { record('AI 智能录入按钮仍存在', false, e.message) }

// 测试 9: 无控制台错误
try {
  const hasErrors = await evalInPage(`
    (function() {
      // 检查页面上是否有错误提示
      const errorElements = document.querySelectorAll('[class*="error"], [class*="Error"]');
      const visibleErrors = Array.from(errorElements).filter(e => e.offsetParent !== null && e.textContent.trim().length > 0);
      return visibleErrors.length === 0;
    })()
  `)
  record('无可见错误提示', hasErrors)
} catch (e) { record('无可见错误提示', false, e.message) }

// 总结
console.log('\n========== 直接录入测试 ==========')
const pass = results.filter(r => r.ok).length
console.log(`总计: ${results.length}, 通过: ${pass}, 失败: ${results.length - pass}`)
if (pass < results.length) {
  console.log('\n失败项:')
  results.filter(r => !r.ok).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`))
}

ws.close()
process.exit(pass === results.length ? 0 : 1)
