// 诊断: 点击学生行 → 档案出现的实际耗时
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
const evalInPage = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
  return r.result?.result?.value
}

await new Promise((r) => ws.on('open', r))

// 先确保在学生页面
await evalInPage(`
  (async function() {
    if (!location.hash.includes('/students')) {
      location.hash = '#/students';
      await new Promise(r => setTimeout(r, 1000));
    }
  })()
`)
await new Promise((r) => setTimeout(r, 500))

// 检查当前状态
const stateBefore = await evalInPage(`
  (function() {
    const rows = document.querySelectorAll('table tbody tr');
    const profileSidebar = document.querySelector('[class*="w-[45%]"]') || document.querySelector('aside');
    return {
      rowCount: rows.length,
      hasProfile: !!document.querySelector('[class*="档案"]') || !!document.querySelector('h2'),
      bodyText: document.body.innerText.substring(0, 200),
    };
  })()
`)
console.log('Before click:', JSON.stringify(stateBefore, null, 2))

// 注入性能标记,点击第一行,然后高频率检查档案是否出现
const result = await evalInPage(`
  (async function() {
    const rows = document.querySelectorAll('table tbody tr');
    if (rows.length === 0) return { error: 'no rows' };

    const t0 = performance.now();
    rows[0].click();

    // 高频检查: 每 16ms 检查一次, 最多 5 秒
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 16));
      // 用更精确的选择器: 档案区域的 tab 按钮
      // StudentProfile 的 tabs 有固定文本: 概览, 档案, 事件, 学业, AI分析
      const allBtns = document.querySelectorAll('button');
      let foundAcademic = false;
      let foundOverview = false;
      for (const b of allBtns) {
        const txt = b.textContent.trim();
        if (txt === '学业') foundAcademic = true;
        if (txt === '概览') foundOverview = true;
        if (foundAcademic && foundOverview) break;
      }
      if (foundAcademic && foundOverview) {
        const t1 = performance.now();
        return { ok: true, durationMs: Math.round(t1 - t0), iterations: i + 1 };
      }
    }
    const t1 = performance.now();
    return { ok: false, durationMs: Math.round(t1 - t0) };
  })()
`)
console.log('Click to profile appearance:', JSON.stringify(result, null, 2))

// 检查点击后的状态
const stateAfter = await evalInPage(`
  (function() {
    const profileContainer = document.querySelector('[class*="w-[45%]"] + div') || document.querySelector('div.flex-1');
    const h2 = document.querySelector('h2');
    const tabBtns = Array.from(document.querySelectorAll('button')).filter(b => {
      const t = b.textContent.trim();
      return ['概览', '档案', '事件', '学业', 'AI分析'].includes(t);
    });
    return {
      hasH2: !!h2,
      h2Text: h2?.textContent?.trim()?.substring(0, 50),
      tabCount: tabBtns.length,
      tabTexts: tabBtns.map(b => b.textContent.trim()),
    };
  })()
`)
console.log('After click:', JSON.stringify(stateAfter, null, 2))

// 测量第二次点击性能 (切换到另一个学生)
const result2 = await evalInPage(`
  (async function() {
    const rows = document.querySelectorAll('table tbody tr');
    if (rows.length < 2) return { error: 'need 2+ rows' };

    const t0 = performance.now();
    rows[1].click();

    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 16));
      // 检查 h2 文本是否变化 (学生名字变了说明切换成功)
      const h2 = document.querySelector('h2');
      if (h2 && h2.textContent.trim() !== rows[0].querySelector('td')?.textContent?.trim()) {
        const t1 = performance.now();
        return { ok: true, durationMs: Math.round(t1 - t0) };
      }
    }
    return { ok: false, durationMs: 5000 };
  })()
`)
console.log('Switch student performance:', JSON.stringify(result2, null, 2))

// 测量第三次: 点击学业 tab
const result3 = await evalInPage(`
  (async function() {
    const btns = Array.from(document.querySelectorAll('button'));
    const academicBtn = btns.find(b => b.textContent.trim() === '学业');
    if (!academicBtn) return { error: 'no 学业 button' };

    const t0 = performance.now();
    academicBtn.click();

    // 等待学业 tab 内容渲染
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 16));
      // 检查是否有学业相关内容出现 (成绩卡片、图表、考试名称)
      const text = document.body.innerText;
      const hasAcademicContent = /考试|成绩|分数|语文|数学|英语|科目/.test(text);
      const hasChart = document.querySelectorAll('canvas, svg, [class*="echarts"]').length > 0;
      if (hasAcademicContent || hasChart) {
        const t1 = performance.now();
        return { ok: true, durationMs: Math.round(t1 - t0), hasAcademicContent, hasChart };
      }
    }
    return { ok: false, durationMs: 1600 };
  })()
`)
console.log('Click 学业 tab performance:', JSON.stringify(result3, null, 2))

ws.close()
