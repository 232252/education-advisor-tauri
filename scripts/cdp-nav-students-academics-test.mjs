// =============================================================
// 综合 UI 验证: 导航栏重组 + 学生列表性能 + 学业页面集成
// 使用 CDP (port 9222) 直接驱动 Tauri WebView2
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
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error(`JSON parse fail: ${e.message}`)) }
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

  const targets = (await fetchJson(`${BASE}/json`)).filter((t) => t.type === 'page')
  if (targets.length === 0) { console.log('FAIL: No CDP targets'); process.exit(1) }
  const target = targets[0]
  console.log(`Target: ${target.title} (${target.url})`)

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
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = msgId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evalInPage = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) {
      throw new Error(`Eval error: ${r.result.exceptionDetails.text}`)
    }
    return r.result?.result?.value
  }

  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP connected, running tests...\n')

  // 辅助: 导航到指定路径 (hash router)
  const navigateTo = async (path) => {
    await evalInPage(`
      (async function() {
        location.hash = '#${path}';
        await new Promise(r => setTimeout(r, 1000));
      })()
    `)
  }

  // 辅助: 查找包含指定文本的按钮
  const findButtonByText = async (text) => evalInPage(`
    (function() {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.some(b => b.textContent.includes('${text}'));
    })()
  `)

  // ===== 测试 1: 导航栏有 dividers =====
  try {
    const dividerCount = await evalInPage(`
      (function() {
        const nav = document.querySelector('nav');
        if (!nav) return -1;
        return nav.querySelectorAll('div[class*="border-t"]').length;
      })()
    `)
    record('导航栏包含分割线 (>=4)', dividerCount >= 4, `${dividerCount} 个`)
  } catch (e) { record('导航栏包含分割线', false, e.message) }

  // ===== 测试 2: 导航栏包含所有关键链接 (hash router) =====
  try {
    const navInfo = await evalInPage(`
      (function() {
        const links = Array.from(document.querySelectorAll('nav a'));
        return links.map(a => a.getAttribute('href'));
      })()
    `)
    const required = ['#/dashboard', '#/students', '#/academics', '#/classes', '#/chat', '#/settings']
    const missing = required.filter((p) => !navInfo.includes(p))
    record('导航栏包含所有关键路径', missing.length === 0, `缺失: ${missing.join(',') || '无'}`)
  } catch (e) { record('导航栏包含所有关键路径', false, e.message) }

  // ===== 测试 3: 学业和学生之间有分隔线 =====
  try {
    const separated = await evalInPage(`
      (function() {
        const nav = document.querySelector('nav');
        if (!nav) return false;
        const items = Array.from(nav.children);
        let studentsIdx = -1, academicsIdx = -1;
        for (let i = 0; i < items.length; i++) {
          // NavLink 渲染为 <a>, 直接检查 tagName
          if (items[i].tagName === 'A') {
            const href = items[i].getAttribute('href');
            if (href === '#/students') studentsIdx = i;
            if (href === '#/academics') academicsIdx = i;
          }
        }
        if (studentsIdx === -1 || academicsIdx === -1) return false;
        // 检查 students 和 academics 之间是否有 divider
        for (let i = studentsIdx + 1; i < academicsIdx; i++) {
          if ((items[i].className || '').includes('border-t')) return true;
        }
        return false;
      })()
    `)
    record('学业与学生之间有分割线 (用户要求分离)', separated)
  } catch (e) { record('学业与学生之间有分割线', false, e.message) }

  // ===== 测试 4: 导航到学生页面 =====
  try {
    await navigateTo('/students')
    const hasTable = await evalInPage(`!!document.querySelector('table')`)
    record('导航到学生页面成功', hasTable)
  } catch (e) { record('导航到学生页面成功', false, e.message) }

  // ===== 测试 5: 学生列表渲染且包含数据 =====
  try {
    const rowCount = await evalInPage(`document.querySelectorAll('table tbody tr').length`)
    record('学生列表有数据行', rowCount > 0, `${rowCount} 行`)
  } catch (e) { record('学生列表有数据行', false, e.message) }

  // ===== 测试 6: 点击学生行打开档案 (性能 < 1000ms) =====
  try {
    const perf = await evalInPage(`
      (async function() {
        const rows = document.querySelectorAll('table tbody tr');
        if (rows.length === 0) return { ok: false, reason: 'no rows' };
        const t0 = performance.now();
        rows[0].click();
        // 用更精确的选择器: 档案区域的 tab 按钮包含 emoji+文字
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 16));
          // 检查是否有 tab 按钮包含"学业"文字 (tab 按钮文本是 "📚学业")
          const btns = document.querySelectorAll('button');
          let found = false;
          for (const b of btns) {
            if (b.textContent.includes('学业') && b.textContent.includes('📚')) { found = true; break; }
          }
          if (found) {
            const t1 = performance.now();
            return { ok: true, durationMs: Math.round(t1 - t0) };
          }
        }
        return { ok: false, durationMs: 1000, reason: 'timeout' };
      })()
    `)
    record('点击学生行打开档案 (< 1000ms)', perf.ok && perf.durationMs < 1000, `${perf.durationMs}ms`)
  } catch (e) { record('点击学生行打开档案', false, e.message) }

  // ===== 测试 7: 学生档案中有"学业"tab =====
  try {
    const hasTab = await findButtonByText('学业')
    record('学生档案含"学业"选项卡', hasTab)
  } catch (e) { record('学生档案含"学业"选项卡', false, e.message) }

  // ===== 测试 8: 点击学业tab后显示考试数据(联动) =====
  try {
    const result = await evalInPage(`
      (async function() {
        const btns = Array.from(document.querySelectorAll('button'));
        const academicBtn = btns.find(b => b.textContent.includes('学业') && b.textContent.includes('📚'));
        if (!academicBtn) return { ok: false, reason: 'no 学业 tab' };
        academicBtn.click();
        await new Promise(r => setTimeout(r, 1000));
        const text = document.body.innerText;
        const hasExam = /考试|月考|期中|期末|模拟|测验/.test(text);
        const hasScore = /\\d+(\\.\\d+)?\\s*分/.test(text) || /成绩|分数/.test(text);
        const hasChart = document.querySelectorAll('canvas, svg, [class*="echarts"]').length > 0;
        const hasEmpty = /暂无|还没有|未录入/.test(text);
        return { ok: hasExam || hasScore || hasChart || hasEmpty, hasExam, hasScore, hasChart, hasEmpty };
      })()
    `)
    record('学生档案学业tab展示数据(或空状态)', result.ok,
      `考试=${result.hasExam} 分数=${result.hasScore} 图表=${result.hasChart} 空状态=${result.hasEmpty}`)
  } catch (e) { record('学生档案学业tab展示数据', false, e.message) }

  // ===== 测试 9: 导航到学业页面 =====
  try {
    await navigateTo('/academics')
    const hasPage = await evalInPage(`
      document.body.innerText.includes('学生列表') || document.body.innerText.includes('成绩') || document.body.innerText.includes('考试')
    `)
    record('导航到学业页面成功', hasPage)
  } catch (e) { record('导航到学业页面成功', false, e.message) }

  // ===== 测试 10: 学业页面有班级筛选 =====
  try {
    const hasFilter = await evalInPage(`
      (function() {
        const selects = Array.from(document.querySelectorAll('select'));
        return selects.some(s => {
          const opts = Array.from(s.options).map(o => o.textContent.trim());
          return opts.includes('全部班级') || opts.includes('未分班');
        });
      })()
    `)
    record('学业页面有班级筛选下拉框', hasFilter)
  } catch (e) { record('学业页面有班级筛选下拉框', false, e.message) }

  // ===== 测试 11: 学业页面有搜索框 =====
  try {
    const hasSearch = await evalInPage(`
      (function() {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
        return inputs.some(i => (i.placeholder || '').includes('搜索') || (i.placeholder || '').includes('学生'));
      })()
    `)
    record('学业页面有搜索框', hasSearch)
  } catch (e) { record('学业页面有搜索框', false, e.message) }

  // ===== 测试 12: 切换到成绩录入tab,检查快速建考试功能 =====
  try {
    const result = await evalInPage(`
      (async function() {
        const btns = Array.from(document.querySelectorAll('button'));
        const entryBtn = btns.find(b => b.textContent.includes('成绩录入'));
        if (!entryBtn) return { ok: false, reason: 'no 成绩录入 tab' };
        entryBtn.click();
        await new Promise(r => setTimeout(r, 600));
        const text = document.body.innerText;
        const hasQuickCreate = /快速|新建|创建.*考试/.test(text);
        const hasExamSelect = document.querySelectorAll('select').length > 0;
        const hasPlusBtn = btns.some(b => b.textContent.trim() === '+' || b.textContent.includes('✏️'));
        return { ok: hasQuickCreate || hasExamSelect || hasPlusBtn, hasQuickCreate, hasExamSelect, hasPlusBtn };
      })()
    `)
    record('成绩录入tab有快速建考试/考试选择器', result.ok,
      `快速建考=${result.hasQuickCreate} 考试选择器=${result.hasExamSelect} 加号按钮=${result.hasPlusBtn}`)
  } catch (e) { record('成绩录入tab有快速建考试/考试选择器', false, e.message) }

  // ===== 测试 13: 学生行切换性能 (第二次 < 500ms) =====
  try {
    await navigateTo('/students')
    const perf = await evalInPage(`
      (async function() {
        const rows = document.querySelectorAll('table tbody tr');
        if (rows.length < 2) return { ok: false, reason: 'need 2+ rows' };
        const firstName = rows[0].querySelector('td')?.textContent?.trim();
        const t0 = performance.now();
        rows[0].click();
        await new Promise(r => setTimeout(r, 300));
        const t1 = performance.now();
        rows[1].click();
        // 等待 h2 变化
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 16));
          const h2 = document.querySelector('h2');
          if (h2 && h2.textContent.trim() !== firstName) {
            const t2 = performance.now();
            return { ok: true, firstClickMs: Math.round(t1 - t0), secondClickMs: Math.round(t2 - t1) };
          }
        }
        return { ok: false, firstClickMs: Math.round(t1 - t0), secondClickMs: 1000 };
      })()
    `)
    record('学生行切换性能 (第二次 < 500ms)',
      perf.ok && perf.secondClickMs < 500,
      `首次=${perf.firstClickMs}ms 第二次=${perf.secondClickMs}ms`)
  } catch (e) { record('学生行切换性能', false, e.message) }

  // ===== 测试 14: 控制台无严重错误 =====
  try {
    const errors = []
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
        // 忽略已知 benign 错误
        if (!/favicon|404.*png|net::ERR/.test(text)) errors.push(text)
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(`Exception: ${msg.params.exceptionDetails.text}`)
      }
    }
    ws.on('message', handler)
    await navigateTo('/dashboard')
    await navigateTo('/students')
    await navigateTo('/academics')
    await navigateTo('/chat')
    await navigateTo('/students')
    await new Promise((r) => setTimeout(r, 1500))
    ws.removeListener('message', handler)
    record('控制台无严重错误', errors.length === 0, errors.length > 0 ? errors.slice(0, 3).join(' | ') : '')
  } catch (e) { record('控制台无严重错误', false, e.message) }

  ws.close()

  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  console.log(`\n========== 测试汇总 ==========`)
  console.log(`总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`)
  if (failed > 0) {
    console.log('\n失败项:')
    results.filter((r) => !r.ok).forEach((r) => console.log(`  ✗ ${r.name} — ${r.detail}`))
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => { console.error('Test runner failed:', err); process.exit(2) })
