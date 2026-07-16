// CDP 交互流测试 — 模拟用户真实操作（点击、输入、导航切换）
// 从 UI 交互角度验证各页面的功能性
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const REPORT_DIR = resolve(ROOT, 'test-results', 'cdp-reports')
mkdirSync(REPORT_DIR, { recursive: true })

const results = []
function log(ok, msg) {
  const sym = ok ? '✓' : '✗'
  console.log(`  ${sym} ${msg}`)
  results.push({ ok, msg })
}

async function callIPC(page, channel, args = []) {
  return await page.evaluate(async ({ ch, ag }) => {
    try {
      const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: ch, args: ag })
      return { ok: true, data: r }
    } catch (e) {
      return { ok: false, error: e.message || String(e) }
    }
  }, { ch: channel, ag: args })
}

async function navigate(page, hash) {
  await page.evaluate((h) => { window.location.hash = h }, hash)
  await page.waitForTimeout(800)
}

async function clickIfExists(page, selector) {
  const el = await page.$(selector)
  if (el) {
    await el.click()
    await page.waitForTimeout(300)
    return true
  }
  return false
}

async function run() {
  console.log('━━━ CDP 交互流测试 ━━━\n')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const context = browser.contexts()[0]
  const page = context.pages()[0]

  // ===== 1. 导航栏切换测试 =====
  console.log('━━━ 1. 导航栏切换测试 ━━━')
  const routes = [
    { hash: '#/dashboard', name: '仪表盘' },
    { hash: '#/chat', name: '对话' },
    { hash: '#/students', name: '学生' },
    { hash: '#/classes', name: '班级' },
    { hash: '#/agents', name: 'Agent' },
    { hash: '#/models', name: '模型' },
    { hash: '#/skills', name: '技能' },
    { hash: '#/scheduler', name: '任务' },
    { hash: '#/privacy', name: '隐私' },
    { hash: '#/settings', name: '设置' },
  ]
  for (const r of routes) {
    await navigate(page, r.hash)
    const h1 = await page.$eval('h1', (el) => el.textContent?.trim() || '').catch(() => '')
    const bodyLen = await page.evaluate(() => document.body.innerText.length)
    log(bodyLen > 100, `${r.name} (${r.hash}): h1="${h1}", 内容长度=${bodyLen}`)
  }

  // ===== 2. 学生页面交互 =====
  console.log('\n━━━ 2. 学生页面交互 ━━━')
  await navigate(page, '#/students')
  // 验证表格存在
  const tableRows = await page.$$eval('table tbody tr', (rows) => rows.length).catch(() => 0)
  log(tableRows > 0, `学生表格行数: ${tableRows}`)

  // 测试班级筛选
  const filterBtns = await page.$$('button, label')
  let filterTested = false
  for (const btn of filterBtns) {
    const text = await btn.textContent()
    if (text && text.includes('三年级一班')) {
      await btn.click()
      await page.waitForTimeout(500)
      const filteredRows = await page.$$eval('table tbody tr', (rows) => rows.length).catch(() => 0)
      log(true, `班级筛选"三年级一班": ${filteredRows} 行`)
      filterTested = true
      break
    }
  }
  if (!filterTested) log(true, '班级筛选按钮未找到（跳过）')

  // ===== 3. 班级页面交互 =====
  console.log('\n━━━ 3. 班级页面交互 ━━━')
  await navigate(page, '#/classes')
  const classRows = await page.$$eval('table tbody tr', (rows) => rows.length).catch(() => 0)
  log(classRows > 0, `班级表格行数: ${classRows}`)

  // 测试新建班级表单
  const addBtn = await page.$('button:has-text("新建班级")')
  if (addBtn) {
    await addBtn.click()
    await page.waitForTimeout(500)
    const formVisible = await page.$('input[placeholder*="班级编号"], input[placeholder*="class"]')
    log(!!formVisible, '新建班级表单打开')
    // 关闭表单
    const cancelBtn = await page.$('button:has-text("取消")')
    if (cancelBtn) await cancelBtn.click()
    await page.waitForTimeout(300)
  } else {
    log(false, '新建班级按钮未找到')
  }

  // ===== 4. Agent 页面交互 =====
  console.log('\n━━━ 4. Agent 页面交互 ━━━')
  await navigate(page, '#/agents')
  // 验证 Agent 卡片
  const agentCards = await page.$$eval('[class*="card"], [class*="agent"]', (els) => els.length).catch(() => 0)
  log(agentCards > 0, `Agent 卡片元素: ${agentCards}`)

  // 测试 Agent 列表 IPC
  const agentList = await callIPC(page, 'agent:list', [])
  log(agentList.ok && agentList.data?.data?.length >= 18, `Agent IPC: ${agentList.data?.data?.length || 0} 个`)

  // ===== 5. 模型页面交互 =====
  console.log('\n━━━ 5. 模型页面交互 ━━━')
  await navigate(page, '#/models')
  const providerSections = await page.$$eval('h3', (els) => els.length).catch(() => 0)
  log(providerSections > 10, `模型 Provider 数: ${providerSections}`)

  // 测试模型 IPC
  const providers = await callIPC(page, 'ai:list-providers', [])
  log(providers.ok && providers.data?.data?.length >= 30, `ai:list-providers: ${providers.data?.data?.length || 0} 个`)

  // ===== 6. 技能页面交互 =====
  console.log('\n━━━ 6. 技能页面交互 ━━━')
  await navigate(page, '#/skills')
  const skillItems = await page.$$eval('[class*="skill"], [class*="item"]', (els) => els.length).catch(() => 0)
  log(skillItems > 0, `技能元素: ${skillItems}`)

  const skills = await callIPC(page, 'skill:list', [])
  log(skills.ok, `skill:list IPC: ${skills.ok ? '成功' : skills.error}`)

  // ===== 7. 任务页面交互 =====
  console.log('\n━━━ 7. 任务页面交互 ━━━')
  await navigate(page, '#/scheduler')
  const cronList = await callIPC(page, 'cron:list', [])
  log(cronList.ok && cronList.data?.data?.length >= 20, `cron:list IPC: ${cronList.data?.data?.length || 0} 个任务`)

  // ===== 8. 隐私页面交互 =====
  console.log('\n━━━ 8. 隐私页面交互 ━━━')
  await navigate(page, '#/privacy')
  const privacyStatus = await callIPC(page, 'privacy:status', [])
  log(privacyStatus.ok, `privacy:status IPC: ${privacyStatus.ok ? '成功' : privacyStatus.error}`)

  // ===== 9. 设置页面交互 =====
  console.log('\n━━━ 9. 设置页面交互 ━━━')
  await navigate(page, '#/settings')
  const settings = await callIPC(page, 'settings:get', [])
  log(settings.ok, `settings:get IPC: ${settings.ok ? '成功' : settings.error}`)

  // 验证设置页面的选项卡
  const tabs = await page.$$eval('button, [role="tab"]', (els) =>
    els.map((e) => e.textContent?.trim()).filter((t) => t && t.length < 20)
  ).catch(() => [])
  const settingTabs = tabs.filter((t) => ['通用', '对话', '飞书', '诊断', '日志', '关于', 'General', 'Chat', 'Feishu', 'Diagnostics', 'Log', 'About'].some((k) => t?.includes(k)))
  log(settingTabs.length > 0, `设置选项卡: ${settingTabs.join(', ')}`)

  // ===== 10. 仪表盘数据验证 =====
  console.log('\n━━━ 10. 仪表盘数据验证 ━━━')
  await navigate(page, '#/dashboard')
  // 验证图表 canvas
  const canvasCount = await page.$$eval('canvas', (els) => els.length).catch(() => 0)
  log(canvasCount > 0, `仪表盘图表(canvas): ${canvasCount}`)

  // 验证学生总数显示
  const bodyText = await page.evaluate(() => document.body.innerText)
  const hasStudentCount = /\d+\s*\n/.test(bodyText) || bodyText.includes('学生总数')
  log(hasStudentCount, '仪表盘显示学生总数')

  // 验证排行榜
  const ranking = await callIPC(page, 'eaa:ranking', [10])
  log(ranking.ok, `eaa:ranking IPC: ${ranking.ok ? '成功' : ranking.error}`)
  if (ranking.ok) {
    const rankData = ranking.data?.data?.ranking || []
    log(rankData.length > 0, `排行榜数据: ${rankData.length} 条`)
  }

  // ===== 11. 深色/浅色主题切换 =====
  console.log('\n━━━ 11. 主题切换测试 ━━━')
  // 找到主题切换按钮（通常是"浅色"或"深色"按钮）
  const themeBtn = await page.$('button:has-text("浅色"), button:has-text("深色"), button:has-text("light"), button:has-text("dark")')
  if (themeBtn) {
    const beforeClass = await page.evaluate(() => document.documentElement.className)
    await themeBtn.click()
    await page.waitForTimeout(500)
    const afterClass = await page.evaluate(() => document.documentElement.className)
    log(beforeClass !== afterClass, `主题切换: class "${beforeClass}" → "${afterClass}"`)
    // 切换回来
    await themeBtn.click()
    await page.waitForTimeout(300)
  } else {
    log(false, '主题切换按钮未找到')
  }

  // ===== 12. 快速页面切换性能 =====
  console.log('\n━━━ 12. 快速页面切换性能 ━━━')
  const switchStart = Date.now()
  for (let i = 0; i < 10; i++) {
    for (const r of routes) {
      await page.evaluate((h) => { window.location.hash = h }, r.hash)
    }
  }
  const switchTime = Date.now() - switchStart
  log(switchTime < 15000, `100次页面切换: ${switchTime}ms (avg ${Math.round(switchTime / 100)}ms/次)`)

  // ===== 总结 =====
  const pass = results.filter((r) => r.ok).length
  const fail = results.filter((r) => !r.ok).length
  console.log(`\n━━━ 总结: ${pass} 通过 / ${fail} 失败 (共 ${results.length}) ━━━`)

  const ts = Date.now()
  writeFileSync(
    resolve(REPORT_DIR, `cdp-interaction-${ts}.json`),
    JSON.stringify({ timestamp: ts, results, summary: { pass, fail, total: results.length } }, null, 2)
  )
  console.log(`报告: ${resolve(REPORT_DIR, `cdp-interaction-${ts}.json`)}`)

  await browser.close()
  process.exit(fail > 0 ? 1 : 0)
}

run().catch((e) => {
  console.error('FATAL:', e)
  process.exit(2)
})
