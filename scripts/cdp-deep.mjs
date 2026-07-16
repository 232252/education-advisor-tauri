// =============================================================
// CDP 深层诊断 — 用正确的通道名和DOM检测,诊断每个页面的真实状态
// =============================================================

import { chromium } from 'playwright'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const REPORTS_DIR = resolve(ROOT, 'test-results', 'cdp-reports')
if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true })

async function nav(page, path) {
  await page.evaluate((p) => { window.location.hash = p }, path)
  await page.waitForTimeout(2500)
}

async function callIPC(page, channel, args = []) {
  return await page.evaluate(async ({ ch, ag }) => {
    try {
      if (window.__TAURI_INTERNALS__) {
        const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: ch, args: ag })
        return { ok: true, data: r }
      }
      return { ok: false, error: 'no __TAURI_INTERNALS__' }
    } catch (e) {
      return { ok: false, error: e.message || String(e) }
    }
  }, { ch: channel, ag: args })
}

async function getConsoleErrors(page, fn) {
  const errors = []
  const warnings = []
  const handler = (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
    else if (msg.type() === 'warning') warnings.push(msg.text())
  }
  const pageErrHandler = (err) => errors.push(`PAGE_ERROR: ${err.message}`)
  page.on('console', handler)
  page.on('pageerror', pageErrHandler)
  try {
    const result = await fn()
    await page.waitForTimeout(500)
    return { result, errors, warnings }
  } finally {
    page.off('console', handler)
    page.off('pageerror', pageErrHandler)
  }
}

async function main() {
  console.log('━━━ CDP 深层诊断 ━━━\n')
  console.log(`时间: ${new Date().toISOString()}\n`)

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const context = browser.contexts()[0]
  const page = context.pages()[0]

  const report = { timestamp: new Date().toISOString(), pages: [] }

  // ===== 1. 仪表盘 =====
  console.log('\n━━━ 1. 仪表盘 (/dashboard) ━━━')
  {
    const { errors, warnings } = await getConsoleErrors(page, async () => await nav(page, '/dashboard'))
    const dom = await page.evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 1000),
      totalElements: document.querySelectorAll('*').length,
      canvasCount: document.querySelectorAll('canvas').length,
      svgCount: document.querySelectorAll('svg').length,
      buttonCount: document.querySelectorAll('button').length,
      h1h2: Array.from(document.querySelectorAll('h1,h2,h3')).map((e) => e.innerText),
    }))
    console.log(`  DOM: ${dom.totalElements} 元素, canvas=${dom.canvasCount}, svg=${dom.svgCount}`)
    console.log(`  H1/H2/H3: ${JSON.stringify(dom.h1h2)}`)
    console.log(`  bodyText: ${dom.bodyText.slice(0, 200)}...`)
    if (errors.length) { console.log(`  错误: ${errors.length}`); errors.slice(0, 3).forEach((e) => console.log(`    ! ${e.slice(0, 150)}`)) }
    report.pages.push({ page: 'dashboard', dom, errors, warnings })
  }

  // ===== 2. AI对话 =====
  console.log('\n━━━ 2. AI对话 (/chat) ━━━')
  {
    const { errors, warnings } = await getConsoleErrors(page, async () => await nav(page, '/chat'))
    const dom = await page.evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 1000),
      textarea: document.querySelectorAll('textarea').length,
      buttons: Array.from(document.querySelectorAll('button')).map((b) => b.innerText?.slice(0, 30)).filter(Boolean),
      h1h2: Array.from(document.querySelectorAll('h1,h2,h3')).map((e) => e.innerText),
    }))
    console.log(`  textarea=${dom.textarea}, buttons=${JSON.stringify(dom.buttons)}`)
    console.log(`  H1/H2/H3: ${JSON.stringify(dom.h1h2)}`)
    console.log(`  bodyText: ${dom.bodyText.slice(0, 200)}...`)
    if (errors.length) { console.log(`  错误: ${errors.length}`); errors.slice(0, 3).forEach((e) => console.log(`    ! ${e.slice(0, 150)}`)) }
    report.pages.push({ page: 'chat', dom, errors, warnings })
  }

  // ===== 3. 学生管理 =====
  console.log('\n━━━ 3. 学生管理 (/students) ━━━')
  {
    // 用正确的通道名测试
    const ipcResult = await callIPC(page, 'eaa:list-students', [])
    console.log(`  IPC eaa:list-students: ok=${ipcResult.ok}`)
    if (ipcResult.ok) {
      const data = ipcResult.data
      const students = data?.data?.students || data?.students || []
      console.log(`  返回数据: success=${data?.success}, students count=${Array.isArray(students) ? students.length : 'N/A'}, raw=${JSON.stringify(data).slice(0, 200)}`)
    } else {
      console.log(`  IPC 错误: ${ipcResult.error}`)
    }

    const { errors, warnings } = await getConsoleErrors(page, async () => await nav(page, '/students'))
    await page.waitForTimeout(2000)
    const dom = await page.evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 1000),
      tableRows: document.querySelectorAll('tr').length,
      tableDataRows: document.querySelectorAll('tbody tr').length,
      buttons: Array.from(document.querySelectorAll('button')).map((b) => b.innerText?.slice(0, 30)).filter(Boolean),
      h1h2: Array.from(document.querySelectorAll('h1,h2,h3')).map((e) => e.innerText),
      emptyState: document.querySelector('[class*="empty"], [class*="Empty"]')?.innerText || '',
    }))
    console.log(`  tableRows=${dom.tableRows}, tableDataRows=${dom.tableDataRows}`)
    console.log(`  buttons=${JSON.stringify(dom.buttons)}`)
    console.log(`  H1/H2/H3: ${JSON.stringify(dom.h1h2)}`)
    console.log(`  bodyText: ${dom.bodyText.slice(0, 300)}...`)
    if (dom.emptyState) console.log(`  空状态: ${dom.emptyState}`)
    if (errors.length) { console.log(`  错误: ${errors.length}`); errors.slice(0, 5).forEach((e) => console.log(`    ! ${e.slice(0, 200)}`)) }
    report.pages.push({ page: 'students', ipc: ipcResult, dom, errors, warnings })
  }

  // ===== 4. 班级管理 =====
  console.log('\n━━━ 4. 班级管理 (/classes) ━━━')
  {
    const ipcResult = await callIPC(page, 'class:list', [])
    console.log(`  IPC class:list: ${JSON.stringify(ipcResult.data).slice(0, 200)}`)

    const { errors, warnings } = await getConsoleErrors(page, async () => await nav(page, '/classes'))
    const dom = await page.evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 1000),
      tableRows: document.querySelectorAll('tr').length,
      buttons: Array.from(document.querySelectorAll('button')).map((b) => b.innerText?.slice(0, 30)).filter(Boolean),
      h1h2: Array.from(document.querySelectorAll('h1,h2,h3')).map((e) => e.innerText),
    }))
    console.log(`  tableRows=${dom.tableRows}`)
    console.log(`  buttons=${JSON.stringify(dom.buttons)}`)
    console.log(`  H1/H2/H3: ${JSON.stringify(dom.h1h2)}`)
    console.log(`  bodyText: ${dom.bodyText.slice(0, 300)}...`)
    if (errors.length) { console.log(`  错误: ${errors.length}`); errors.slice(0, 5).forEach((e) => console.log(`    ! ${e.slice(0, 200)}`)) }
    report.pages.push({ page: 'classes', ipc: ipcResult, dom, errors, warnings })
  }

  // ===== 5. 智能体 =====
  console.log('\n━━━ 5. 智能体 (/agents) ━━━')
  {
    const ipcResult = await callIPC(page, 'agent:list', [])
    const agentCount = Array.isArray(ipcResult.data) ? ipcResult.data.length : '?'
    console.log(`  IPC agent:list: ok=${ipcResult.ok}, count=${agentCount}`)

    const { errors, warnings } = await getConsoleErrors(page, async () => await nav(page, '/agents'))
    const dom = await page.evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 2000),
      totalElements: document.querySelectorAll('*').length,
      switches: document.querySelectorAll('[role="switch"], input[type="checkbox"]').length,
      cards: document.querySelectorAll('[class*="rounded"]').length,
      agentNames: Array.from(document.querySelectorAll('[class*="font-medium"], [class*="font-semibold"], strong, b')).map((e) => e.innerText?.slice(0, 40)).filter(Boolean).slice(0, 20),
      h1h2: Array.from(document.querySelectorAll('h1,h2,h3')).map((e) => e.innerText),
    }))
    console.log(`  totalElements=${dom.totalElements}, switches=${dom.switches}, cards=${dom.cards}`)
    console.log(`  agentNames: ${JSON.stringify(dom.agentNames.slice(0, 10))}`)
    console.log(`  H1/H2/H3: ${JSON.stringify(dom.h1h2)}`)
    console.log(`  bodyText(前300): ${dom.bodyText.slice(0, 300)}...`)
    if (errors.length) { console.log(`  错误: ${errors.length}`); errors.slice(0, 5).forEach((e) => console.log(`    ! ${e.slice(0, 200)}`)) }
    report.pages.push({ page: 'agents', ipc: { ok: ipcResult.ok, count: agentCount }, dom, errors, warnings })
  }

  // ===== 6. 模型配置 =====
  console.log('\n━━━ 6. 模型配置 (/models) ━━━')
  {
    const ipcResult = await callIPC(page, 'ai:list-providers', [])
    const providerCount = Array.isArray(ipcResult.data) ? ipcResult.data.length : '?'
    console.log(`  IPC ai:list-providers: ok=${ipcResult.ok}, count=${providerCount}`)
    if (ipcResult.ok && Array.isArray(ipcResult.data)) {
      console.log(`  Providers: ${ipcResult.data.map((p) => `${p.id}(hidden=${p.hidden},hasKey=${p.hasApiKey})`).join(', ')}`)
    }

    const { errors, warnings } = await getConsoleErrors(page, async () => await nav(page, '/models'))
    const dom = await page.evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 2000),
      totalElements: document.querySelectorAll('*').length,
      inputs: document.querySelectorAll('input').length,
      buttons: document.querySelectorAll('button').length,
      providerTexts: Array.from(document.querySelectorAll('h3,h4,h5,[class*="font"],strong,b')).map((e) => e.innerText?.slice(0, 50)).filter(Boolean).slice(0, 20),
      h1h2: Array.from(document.querySelectorAll('h1,h2,h3')).map((e) => e.innerText),
    }))
    console.log(`  totalElements=${dom.totalElements}, inputs=${dom.inputs}, buttons=${dom.buttons}`)
    console.log(`  providerTexts: ${JSON.stringify(dom.providerTexts.slice(0, 10))}`)
    console.log(`  H1/H2/H3: ${JSON.stringify(dom.h1h2)}`)
    console.log(`  bodyText(前300): ${dom.bodyText.slice(0, 300)}...`)
    if (errors.length) { console.log(`  错误: ${errors.length}`); errors.slice(0, 5).forEach((e) => console.log(`    ! ${e.slice(0, 200)}`)) }
    report.pages.push({ page: 'models', ipc: { ok: ipcResult.ok, count: providerCount }, dom, errors, warnings })
  }

  // ===== 7. 技能 =====
  console.log('\n━━━ 7. 技能 (/skills) ━━━')
  {
    const ipcResult = await callIPC(page, 'skill:list', [])
    const skillCount = Array.isArray(ipcResult.data) ? ipcResult.data.length : '?'
    console.log(`  IPC skill:list: ok=${ipcResult.ok}, count=${skillCount}`)
    if (ipcResult.ok) console.log(`  数据: ${JSON.stringify(ipcResult.data).slice(0, 200)}`)

    const { errors, warnings } = await getConsoleErrors(page, async () => await nav(page, '/skills'))
    const dom = await page.evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 2000),
      totalElements: document.querySelectorAll('*').length,
      buttons: document.querySelectorAll('button').length,
      h1h2: Array.from(document.querySelectorAll('h1,h2,h3')).map((e) => e.innerText),
    }))
    console.log(`  totalElements=${dom.totalElements}, buttons=${dom.buttons}`)
    console.log(`  H1/H2/H3: ${JSON.stringify(dom.h1h2)}`)
    console.log(`  bodyText(前300): ${dom.bodyText.slice(0, 300)}...`)
    if (errors.length) { console.log(`  错误: ${errors.length}`); errors.slice(0, 5).forEach((e) => console.log(`    ! ${e.slice(0, 200)}`)) }
    report.pages.push({ page: 'skills', ipc: { ok: ipcResult.ok, count: skillCount }, dom, errors, warnings })
  }

  // ===== 8. 定时任务 =====
  console.log('\n━━━ 8. 定时任务 (/scheduler) ━━━')
  {
    const ipcResult = await callIPC(page, 'cron:list', [])
    const taskCount = Array.isArray(ipcResult.data) ? ipcResult.data.length : '?'
    console.log(`  IPC cron:list: ok=${ipcResult.ok}, count=${taskCount}`)

    const { errors, warnings } = await getConsoleErrors(page, async () => await nav(page, '/scheduler'))
    const dom = await page.evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 2000),
      totalElements: document.querySelectorAll('*').length,
      buttons: document.querySelectorAll('button').length,
      switches: document.querySelectorAll('[role="switch"], input[type="checkbox"]').length,
      taskTexts: Array.from(document.querySelectorAll('h3,h4,h5,[class*="font"],strong,b,td')).map((e) => e.innerText?.slice(0, 50)).filter(Boolean).slice(0, 20),
      h1h2: Array.from(document.querySelectorAll('h1,h2,h3')).map((e) => e.innerText),
    }))
    console.log(`  totalElements=${dom.totalElements}, buttons=${dom.buttons}, switches=${dom.switches}`)
    console.log(`  taskTexts: ${JSON.stringify(dom.taskTexts.slice(0, 10))}`)
    console.log(`  H1/H2/H3: ${JSON.stringify(dom.h1h2)}`)
    console.log(`  bodyText(前300): ${dom.bodyText.slice(0, 300)}...`)
    if (errors.length) { console.log(`  错误: ${errors.length}`); errors.slice(0, 5).forEach((e) => console.log(`    ! ${e.slice(0, 200)}`)) }
    report.pages.push({ page: 'scheduler', ipc: { ok: ipcResult.ok, count: taskCount }, dom, errors, warnings })
  }

  // ===== 9. 隐私引擎 =====
  console.log('\n━━━ 9. 隐私引擎 (/privacy) ━━━')
  {
    const ipcResult = await callIPC(page, 'privacy:status', [])
    console.log(`  IPC privacy:status: ${JSON.stringify(ipcResult.data).slice(0, 200)}`)

    const { errors, warnings } = await getConsoleErrors(page, async () => await nav(page, '/privacy'))
    const dom = await page.evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 2000),
      totalElements: document.querySelectorAll('*').length,
      inputs: document.querySelectorAll('input').length,
      buttons: document.querySelectorAll('button').length,
      h1h2: Array.from(document.querySelectorAll('h1,h2,h3')).map((e) => e.innerText),
    }))
    console.log(`  totalElements=${dom.totalElements}, inputs=${dom.inputs}, buttons=${dom.buttons}`)
    console.log(`  H1/H2/H3: ${JSON.stringify(dom.h1h2)}`)
    console.log(`  bodyText(前300): ${dom.bodyText.slice(0, 300)}...`)
    if (errors.length) { console.log(`  错误: ${errors.length}`); errors.slice(0, 5).forEach((e) => console.log(`    ! ${e.slice(0, 200)}`)) }
    report.pages.push({ page: 'privacy', ipc: ipcResult, dom, errors, warnings })
  }

  // ===== 10. 设置 =====
  console.log('\n━━━ 10. 设置 (/settings) ━━━')
  {
    const ipcResult = await callIPC(page, 'settings:get', [])
    console.log(`  IPC settings:get: ok=${ipcResult.ok}`)

    const { errors, warnings } = await getConsoleErrors(page, async () => await nav(page, '/settings'))
    const dom = await page.evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 2000),
      totalElements: document.querySelectorAll('*').length,
      inputs: document.querySelectorAll('input,select,textarea').length,
      buttons: document.querySelectorAll('button').length,
      h1h2: Array.from(document.querySelectorAll('h1,h2,h3')).map((e) => e.innerText),
    }))
    console.log(`  totalElements=${dom.totalElements}, inputs=${dom.inputs}, buttons=${dom.buttons}`)
    console.log(`  H1/H2/H3: ${JSON.stringify(dom.h1h2)}`)
    console.log(`  bodyText(前300): ${dom.bodyText.slice(0, 300)}...`)
    if (errors.length) { console.log(`  错误: ${errors.length}`); errors.slice(0, 5).forEach((e) => console.log(`    ! ${e.slice(0, 200)}`)) }
    report.pages.push({ page: 'settings', ipc: ipcResult, dom, errors, warnings })
  }

  // 总结
  console.log('\n━━━ 诊断总结 ━━━')
  let totalErrors = 0
  for (const p of report.pages) {
    const errCount = p.errors?.length || 0
    totalErrors += errCount
    console.log(`${errCount > 0 ? '✗' : '✓'} ${p.page}: ${errCount} 个错误`)
  }
  console.log(`总错误数: ${totalErrors}`)

  const reportPath = resolve(REPORTS_DIR, `cdp-deep-${Date.now()}.json`)
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`报告: ${reportPath}`)

  await browser.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(2)
})
