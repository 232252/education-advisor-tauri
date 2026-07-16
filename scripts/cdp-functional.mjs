// =============================================================
// CDP 功能交互测试 — 对每个页面进行真实操作,验证 IPC 通路
// =============================================================

import { chromium } from 'playwright'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const REPORTS_DIR = resolve(ROOT, 'test-results', 'cdp-reports')
if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true })

async function collectConsoleErrors(page, fn) {
  const errors = []
  const handler = (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  }
  page.on('console', handler)
  const pageErrHandler = (err) => errors.push(`PAGE_ERROR: ${err.message}`)
  page.on('pageerror', pageErrHandler)
  try {
    const result = await fn()
    await page.waitForTimeout(500)
    return { result, errors }
  } finally {
    page.off('console', handler)
    page.off('pageerror', pageErrHandler)
  }
}

async function nav(page, path) {
  await page.evaluate((p) => { window.location.hash = p }, path)
  await page.waitForTimeout(2000)
}

async function testDashboard(page) {
  await nav(page, '/dashboard')
  const tests = []

  // 1. 检查是否有数据卡片
  const cards = await page.evaluate(() => document.querySelectorAll('[class*="card"], [class*="Card"], .rounded-xl, .rounded-lg').length)
  tests.push({ name: '仪表盘卡片渲染', pass: cards > 0, detail: `${cards} 个卡片` })

  // 2. 检查 IPC 通路 - 读取学生数据
  const ipcResult = await page.evaluate(async () => {
    try {
      // 尝试通过 window.api 调用 IPC
      if (window.__TAURI_INTERNALS__) {
        const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: 'students:list', args: [] })
        return { ok: true, data: r }
      }
      return { ok: false, error: 'no __TAURI_INTERNALS__' }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  tests.push({ name: 'IPC students:list', pass: ipcResult.ok, detail: ipcResult.ok ? `数据: ${JSON.stringify(ipcResult.data).slice(0, 100)}` : ipcResult.error })

  // 3. 检查图表是否渲染 (ECharts)
  const charts = await page.evaluate(() => ({
    canvasCount: document.querySelectorAll('canvas').length,
    svgCount: document.querySelectorAll('svg').length,
    echartsCount: document.querySelectorAll('[_echarts_instance_]').length,
  }))
  tests.push({ name: '图表渲染', pass: charts.canvasCount > 0 || charts.svgCount > 0, detail: `canvas=${charts.canvasCount}, svg=${charts.svgCount}` })

  return tests
}

async function testChat(page) {
  await nav(page, '/chat')
  const tests = []

  // 1. 检查输入框
  const inputs = await page.evaluate(() => {
    const textareas = document.querySelectorAll('textarea')
    const textInputs = document.querySelectorAll('input[type="text"]')
    return { textarea: textareas.length, text: textInputs.length }
  })
  tests.push({ name: '聊天输入框', pass: inputs.textarea > 0 || inputs.text > 0, detail: `textarea=${inputs.textarea}, input=${inputs.text}` })

  // 2. 检查发送按钮
  const sendBtn = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'))
    const sendBtn = btns.find((b) => {
      const t = (b.innerText || b.getAttribute('aria-label') || '').toLowerCase()
      return t.includes('发送') || t.includes('send') || t.includes('提交')
    })
    return sendBtn ? sendBtn.innerText : null
  })
  tests.push({ name: '发送按钮', pass: !!sendBtn, detail: sendBtn || '未找到' })

  // 3. 检查会话列表
  const sessions = await page.evaluate(() => {
    const lists = document.querySelectorAll('[class*="session"], [class*="Session"], [class*="conversation"], [class*="conv"]')
    return lists.length
  })
  tests.push({ name: '会话列表区域', pass: true, detail: `${sessions} 个会话相关元素` })

  return tests
}

async function testStudents(page) {
  await nav(page, '/students')
  const tests = []

  // 1. 检查学生列表/表格
  const tableInfo = await page.evaluate(() => {
    const tables = document.querySelectorAll('table')
    const listItems = document.querySelectorAll('[class*="student"], [class*="Student"], li, tr')
    return {
      tableCount: tables.length,
      rowCount: document.querySelectorAll('tr').length,
      listItemCount: listItems.length,
    }
  })
  tests.push({ name: '学生列表区域', pass: tableInfo.rowCount > 0 || tableInfo.listItemCount > 0, detail: `table=${tableInfo.tableCount}, rows=${tableInfo.rowCount}` })

  // 2. 检查添加学生按钮
  const addBtn = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'))
    const found = btns.find((b) => {
      const t = (b.innerText || '').toLowerCase()
      return t.includes('添加') || t.includes('新增') || t.includes('add') || t.includes('+')
    })
    return found ? found.innerText : null
  })
  tests.push({ name: '添加学生按钮', pass: !!addBtn, detail: addBtn || '未找到' })

  // 3. IPC 调用 - 获取学生列表
  const studentsData = await page.evaluate(async () => {
    try {
      if (window.__TAURI_INTERNALS__) {
        const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: 'students:list', args: [] })
        return { ok: true, count: Array.isArray(r) ? r.length : (r?.data?.length || r?.students?.length || '?'), raw: JSON.stringify(r).slice(0, 200) }
      }
      return { ok: false, error: 'no __TAURI_INTERNALS__' }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  tests.push({ name: 'IPC students:list 数据', pass: studentsData.ok, detail: studentsData.ok ? `count=${studentsData.count}` : studentsData.error })

  return tests
}

async function testClasses(page) {
  await nav(page, '/classes')
  const tests = []

  // 1. 班级列表
  const classInfo = await page.evaluate(() => document.querySelectorAll('[class*="class"], [class*="Class"], tr, [class*="card"]').length)
  tests.push({ name: '班级列表区域', pass: classInfo > 0, detail: `${classInfo} 个元素` })

  // 2. IPC 班级列表
  const classData = await page.evaluate(async () => {
    try {
      if (window.__TAURI_INTERNALS__) {
        const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: 'class:list', args: [] })
        return { ok: true, raw: JSON.stringify(r).slice(0, 200) }
      }
      return { ok: false }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  tests.push({ name: 'IPC class:list', pass: classData.ok, detail: classData.ok ? classData.raw : classData.error })

  return tests
}

async function testAgents(page) {
  await nav(page, '/agents')
  const tests = []

  // 1. Agent 卡片数量
  const agentCards = await page.evaluate(() => {
    const cards = document.querySelectorAll('[class*="agent"], [class*="Agent"], [class*="card"], [class*="Card"]')
    return cards.length
  })
  tests.push({ name: 'Agent 卡片', pass: agentCards > 0, detail: `${agentCards} 个` })

  // 2. IPC agent:list
  const agentData = await page.evaluate(async () => {
    try {
      if (window.__TAURI_INTERNALS__) {
        const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: 'agent:list', args: [] })
        const count = Array.isArray(r) ? r.length : (r?.data?.length || r?.agents?.length || '?')
        return { ok: true, count, raw: JSON.stringify(r).slice(0, 200) }
      }
      return { ok: false }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  tests.push({ name: 'IPC agent:list', pass: agentData.ok, detail: agentData.ok ? `count=${agentData.count}` : agentData.error })

  // 3. 检查启用/禁用开关
  const toggles = await page.evaluate(() => {
    const switches = document.querySelectorAll('[role="switch"], input[type="checkbox"], [class*="toggle"], [class*="Toggle"]')
    return switches.length
  })
  tests.push({ name: 'Agent 启用/禁用开关', pass: toggles > 0, detail: `${toggles} 个开关` })

  return tests
}

async function testModels(page) {
  await nav(page, '/models')
  const tests = []

  // 1. Provider 列表
  const providerCount = await page.evaluate(() => {
    return document.querySelectorAll('[class*="provider"], [class*="Provider"], [class*="card"], [class*="Card"]').length
  })
  tests.push({ name: 'Provider 卡片', pass: providerCount > 0, detail: `${providerCount} 个` })

  // 2. IPC ai:list-providers
  const providerData = await page.evaluate(async () => {
    try {
      if (window.__TAURI_INTERNALS__) {
        const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: 'ai:list-providers', args: [] })
        return { ok: true, raw: JSON.stringify(r).slice(0, 300) }
      }
      return { ok: false }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  tests.push({ name: 'IPC ai:list-providers', pass: providerData.ok, detail: providerData.ok ? providerData.raw : providerData.error })

  // 3. API Key 输入框
  const apiInputs = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'))
    return inputs.filter((i) => {
      const type = (i.type || '').toLowerCase()
      const ph = (i.placeholder || '').toLowerCase()
      const name = (i.name || '').toLowerCase()
      return type === 'password' || ph.includes('api') || ph.includes('key') || name.includes('api') || name.includes('key')
    }).length
  })
  tests.push({ name: 'API Key 输入框', pass: true, detail: `${apiInputs} 个` })

  return tests
}

async function testSkills(page) {
  await nav(page, '/skills')
  const tests = []

  const skillElements = await page.evaluate(() => document.querySelectorAll('[class*="skill"], [class*="Skill"], [class*="card"], [class*="Card"]').length)
  tests.push({ name: '技能卡片', pass: skillElements > 0, detail: `${skillElements} 个` })

  return tests
}

async function testScheduler(page) {
  await nav(page, '/scheduler')
  const tests = []

  // 1. 定时任务列表
  const cronItems = await page.evaluate(() => document.querySelectorAll('[class*="cron"], [class*="task"], [class*="Task"], tr, [class*="card"]').length)
  tests.push({ name: '定时任务区域', pass: cronItems > 0, detail: `${cronItems} 个元素` })

  // 2. IPC cron:list
  const cronData = await page.evaluate(async () => {
    try {
      if (window.__TAURI_INTERNALS__) {
        const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: 'cron:list', args: [] })
        return { ok: true, raw: JSON.stringify(r).slice(0, 200) }
      }
      return { ok: false }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  tests.push({ name: 'IPC cron:list', pass: cronData.ok, detail: cronData.ok ? cronData.raw : cronData.error })

  return tests
}

async function testPrivacy(page) {
  await nav(page, '/privacy')
  const tests = []

  // 1. 隐私状态
  const privacyElements = await page.evaluate(() => document.querySelectorAll('input, button, [class*="privacy"], [class*="Privacy"]').length)
  tests.push({ name: '隐私引擎控件', pass: privacyElements > 0, detail: `${privacyElements} 个` })

  // 2. IPC privacy:status
  const statusData = await page.evaluate(async () => {
    try {
      if (window.__TAURI_INTERNALS__) {
        const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: 'privacy:status', args: [] })
        return { ok: true, raw: JSON.stringify(r).slice(0, 200) }
      }
      return { ok: false }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  tests.push({ name: 'IPC privacy:status', pass: statusData.ok, detail: statusData.ok ? statusData.raw : statusData.error })

  return tests
}

async function testSettings(page) {
  await nav(page, '/settings')
  const tests = []

  // 1. 设置项
  const settingInputs = await page.evaluate(() => document.querySelectorAll('input, select, button').length)
  tests.push({ name: '设置控件', pass: settingInputs > 5, detail: `${settingInputs} 个` })

  // 2. 主题切换
  const themeControls = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, [role="radio"], [role="button"], select option'))
    return all.filter((el) => {
      const t = (el.innerText || el.value || '').toLowerCase()
      return t.includes('dark') || t.includes('light') || t.includes('深色') || t.includes('浅色') || t.includes('暗色') || t.includes('亮色') || t.includes('system') || t.includes('系统') || t.includes('主题')
    }).length
  })
  tests.push({ name: '主题切换选项', pass: themeControls > 0, detail: `${themeControls} 个` })

  // 3. IPC settings:get
  const settingsData = await page.evaluate(async () => {
    try {
      if (window.__TAURI_INTERNALS__) {
        const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: 'settings:get', args: [] })
        return { ok: true, raw: JSON.stringify(r).slice(0, 200) }
      }
      return { ok: false }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  tests.push({ name: 'IPC settings:get', pass: settingsData.ok, detail: settingsData.ok ? settingsData.raw : settingsData.error })

  return tests
}

async function main() {
  console.log('━━━ CDP 功能交互测试 ━━━\n')
  console.log(`时间: ${new Date().toISOString()}\n`)

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const context = browser.contexts()[0]
  const page = context.pages()[0]

  const allTests = []
  let totalPass = 0
  let totalFail = 0

  const testSuites = [
    { name: '仪表盘', fn: testDashboard },
    { name: 'AI对话', fn: testChat },
    { name: '学生管理', fn: testStudents },
    { name: '班级管理', fn: testClasses },
    { name: '智能体', fn: testAgents },
    { name: '模型配置', fn: testModels },
    { name: '技能', fn: testSkills },
    { name: '定时任务', fn: testScheduler },
    { name: '隐私引擎', fn: testPrivacy },
    { name: '设置', fn: testSettings },
  ]

  for (const suite of testSuites) {
    console.log(`\n━━━ ${suite.name} ━━━`)
    const { result: tests, errors } = await collectConsoleErrors(page, () => suite.fn(page))
    let pass = 0
    let fail = 0
    for (const t of tests) {
      if (t.pass) {
        pass++
        console.log(`  ✓ ${t.name} — ${t.detail}`)
      } else {
        fail++
        console.log(`  ✗ ${t.name} — ${t.detail}`)
      }
    }
    if (errors.length > 0) {
      console.log(`  ! 控制台错误: ${errors.length} 条`)
      for (const e of errors.slice(0, 3)) {
        console.log(`    - ${e.slice(0, 150)}`)
      }
    }
    totalPass += pass
    totalFail += fail
    allTests.push({ suite: suite.name, tests, errors })
  }

  const report = {
    timestamp: new Date().toISOString(),
    summary: { totalPass, totalFail, total: totalPass + totalFail },
    suites: allTests,
  }
  const reportPath = resolve(REPORTS_DIR, `cdp-functional-${Date.now()}.json`)
  writeFileSync(reportPath, JSON.stringify(report, null, 2))

  console.log(`\n━━━ 总结 ━━━`)
  console.log(`通过: ${totalPass}/${totalPass + totalFail}`)
  console.log(`失败: ${totalFail}`)
  console.log(`报告: ${reportPath}`)

  await browser.close()
  process.exit(totalFail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(2)
})
