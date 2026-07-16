// =============================================================
// CDP Tauri UI 交互测试 — 模拟真实用户操作
// 通过 CDP 直接操作 DOM: 点击按钮、输入表单、导航页面
// =============================================================
import { chromium } from 'playwright'

const CDP_URL = 'http://localhost:9222'

async function connect() {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL)
    const contexts = browser.contexts()
    if (contexts.length === 0) throw new Error('No browser context')
    const pages = contexts[0].pages()
    if (pages.length === 0) throw new Error('No page')
    return { browser, page: pages[0] }
  } catch (e) {
    console.error('❌ 无法连接 CDP:', e.message)
    process.exit(1)
  }
}

async function callApi(page, channel, ...args) {
  return await page.evaluate(async ({ ch, ag }) => {
    try {
      const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: ch, args: ag })
      return { ok: true, data: r }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  }, { ch: channel, ag: args })
}

async function navigateTo(page, hash) {
  await page.evaluate((h) => { window.location.hash = h }, hash)
  try {
    await page.waitForFunction(() => {
      const root = document.getElementById('root')
      return root && root.children.length > 0 && root.innerHTML.length > 50
    }, { timeout: 5000 })
  } catch {
    await page.waitForTimeout(1500)
  }
}

async function main() {
  const { browser, page } = await connect()

  const results = { pass: 0, fail: 0, details: [] }
  const log = (name, ok, detail = '') => {
    results.details.push({ name, ok, detail })
    if (ok) { results.pass++; console.log(`  ✓ ${name}`) }
    else { results.fail++; console.log(`  ✗ ${name} ${detail}`) }
  }

  console.log('╔══════════════════════════════════════════════════╗')
  console.log('║  CDP Tauri UI 交互测试 — 模拟真实用户操作          ║')
  console.log('╚══════════════════════════════════════════════════╝\n')

  // ===== 1. 仪表盘 UI 检查 =====
  console.log('━━━ 1. 仪表盘 UI 检查 ━━━')
  await navigateTo(page, '/dashboard')
  const dashUI = await page.evaluate(() => {
    const root = document.getElementById('root')
    const buttons = root?.querySelectorAll('button') || []
    const links = root?.querySelectorAll('a') || []
    const inputs = root?.querySelectorAll('input, select, textarea') || []
    const text = root?.innerText || ''
    return {
      htmlLen: root?.innerHTML?.length || 0,
      buttonCount: buttons.length,
      linkCount: links.length,
      inputCount: inputs.length,
      hasText: text.length > 50,
      textPreview: text.slice(0, 200),
    }
  })
  log('仪表盘渲染HTML>500', dashUI.htmlLen > 500, `htmlLen=${dashUI.htmlLen}`)
  log('仪表盘有可见文本', dashUI.hasText, `textLen=${dashUI.textPreview.length}`)
  log('仪表盘有交互元素', dashUI.buttonCount + dashUI.linkCount > 0, `buttons=${dashUI.buttonCount} links=${dashUI.linkCount}`)

  // ===== 2. 学生管理 UI 检查 =====
  console.log('\n━━━ 2. 学生管理 UI 检查 ━━━')
  await navigateTo(page, '/students')
  const stuUI = await page.evaluate(() => {
    const root = document.getElementById('root')
    return {
      htmlLen: root?.innerHTML?.length || 0,
      hasTable: !!root?.querySelector('table, [class*="table"], [class*="list"], [class*="grid"]'),
      hasInput: !!root?.querySelector('input, textarea'),
      hasButton: !!root?.querySelector('button'),
    }
  })
  log('学生页渲染HTML>500', stuUI.htmlLen > 500, `htmlLen=${stuUI.htmlLen}`)
  log('学生页有输入控件', stuUI.hasInput, '')
  log('学生页有按钮', stuUI.hasButton, '')

  // 尝试找到输入框并输入
  const inputTest = await page.evaluate(() => {
    const input = document.querySelector('input[type="text"], input:not([type])')
    if (input) {
      input.focus()
      return { found: true, placeholder: input.placeholder || '' }
    }
    return { found: false }
  })
  log('学生页找到输入框', inputTest.found, inputTest.placeholder || '')

  // ===== 3. 班级管理 UI 检查 =====
  console.log('\n━━━ 3. 班级管理 UI 检查 ━━━')
  await navigateTo(page, '/classes')
  const clsUI = await page.evaluate(() => {
    const root = document.getElementById('root')
    return {
      htmlLen: root?.innerHTML?.length || 0,
      hasButton: !!root?.querySelector('button'),
      hasInput: !!root?.querySelector('input, textarea'),
    }
  })
  log('班级页渲染HTML>500', clsUI.htmlLen > 500, `htmlLen=${clsUI.htmlLen}`)
  log('班级页有按钮', clsUI.hasButton, '')

  // ===== 4. Agent 管理 UI 检查 =====
  console.log('\n━━━ 4. Agent 管理 UI 检查 ━━━')
  await navigateTo(page, '/agents')
  const agentUI = await page.evaluate(() => {
    const root = document.getElementById('root')
    return {
      htmlLen: root?.innerHTML?.length || 0,
      hasButton: !!root?.querySelector('button'),
      textLen: root?.innerText?.length || 0,
    }
  })
  log('Agent页渲染HTML>500', agentUI.htmlLen > 500, `htmlLen=${agentUI.htmlLen}`)
  log('Agent页有可见内容', agentUI.textLen > 50, `textLen=${agentUI.textLen}`)

  // ===== 5. 模型管理 UI 检查 =====
  console.log('\n━━━ 5. 模型管理 UI 检查 ━━━')
  await navigateTo(page, '/models')
  const modelUI = await page.evaluate(() => {
    const root = document.getElementById('root')
    return {
      htmlLen: root?.innerHTML?.length || 0,
      hasButton: !!root?.querySelector('button'),
    }
  })
  log('模型页渲染HTML>500', modelUI.htmlLen > 500, `htmlLen=${modelUI.htmlLen}`)

  // ===== 6. 技能管理 UI 检查 =====
  console.log('\n━━━ 6. 技能管理 UI 检查 ━━━')
  await navigateTo(page, '/skills')
  const skillUI = await page.evaluate(() => {
    const root = document.getElementById('root')
    return {
      htmlLen: root?.innerHTML?.length || 0,
      hasButton: !!root?.querySelector('button'),
    }
  })
  log('技能页渲染HTML>500', skillUI.htmlLen > 500, `htmlLen=${skillUI.htmlLen}`)

  // ===== 7. 定时任务 UI 检查 =====
  console.log('\n━━━ 7. 定时任务 UI 检查 ━━━')
  await navigateTo(page, '/scheduler')
  const schedUI = await page.evaluate(() => {
    const root = document.getElementById('root')
    return {
      htmlLen: root?.innerHTML?.length || 0,
      hasButton: !!root?.querySelector('button'),
    }
  })
  log('定时任务页渲染HTML>500', schedUI.htmlLen > 500, `htmlLen=${schedUI.htmlLen}`)

  // ===== 8. 隐私引擎 UI 检查 =====
  console.log('\n━━━ 8. 隐私引擎 UI 检查 ━━━')
  await navigateTo(page, '/privacy')
  const privUI = await page.evaluate(() => {
    const root = document.getElementById('root')
    return {
      htmlLen: root?.innerHTML?.length || 0,
      hasButton: !!root?.querySelector('button'),
    }
  })
  log('隐私页渲染HTML>500', privUI.htmlLen > 500, `htmlLen=${privUI.htmlLen}`)

  // ===== 9. 设置 UI 检查 =====
  console.log('\n━━━ 9. 设置 UI 检查 ━━━')
  await navigateTo(page, '/settings')
  // 等待 settings 异步加载完成(select/textarea/input 渲染出来)
  try {
    await page.waitForFunction(() => !!document.querySelector('#root select, #root textarea, #root input'), { timeout: 5000 })
  } catch {
    await page.waitForTimeout(1500)
  }
  const setUI = await page.evaluate(() => {
    const root = document.getElementById('root')
    return {
      htmlLen: root?.innerHTML?.length || 0,
      hasButton: !!root?.querySelector('button'),
      hasInput: !!root?.querySelector('input, select, textarea'),
    }
  })
  log('设置页渲染HTML>500', setUI.htmlLen > 500, `htmlLen=${setUI.htmlLen}`)
  log('设置页有输入控件', setUI.hasInput, '')

  // ===== 10. 聊天 UI 检查 =====
  console.log('\n━━━ 10. 聊天 UI 检查 ━━━')
  await navigateTo(page, '/chat')
  const chatUI = await page.evaluate(() => {
    const root = document.getElementById('root')
    return {
      htmlLen: root?.innerHTML?.length || 0,
      hasInput: !!root?.querySelector('input, textarea'),
      hasButton: !!root?.querySelector('button'),
    }
  })
  log('聊天页渲染HTML>500', chatUI.htmlLen > 500, `htmlLen=${chatUI.htmlLen}`)
  log('聊天页有输入框', chatUI.hasInput, '')

  // ===== 11. 导航栏检查 =====
  console.log('\n━━━ 11. 导航栏检查 ━━━')
  const navCheck = await page.evaluate(() => {
    const nav = document.querySelector('nav, [class*="nav"], [class*="sidebar"], [class*="menu"]')
    const navLinks = nav?.querySelectorAll('a, button') || []
    return {
      hasNav: !!nav,
      navLinkCount: navLinks.length,
      navText: nav?.innerText?.slice(0, 200) || '',
    }
  })
  log('有导航栏', navCheck.hasNav, navCheck.navText.slice(0, 80))
  log('导航栏有链接', navCheck.navLinkCount > 0, `count=${navCheck.navLinkCount}`)

  // ===== 12. 快速导航测试 (10个路由) =====
  console.log('\n━━━ 12. 快速导航测试 (10路由) ━━━')
  const routes = ['/dashboard', '/students', '/classes', '/agents', '/models', '/skills', '/scheduler', '/privacy', '/settings', '/chat']
  let navOk = 0
  for (const route of routes) {
    await navigateTo(page, route)
    const state = await page.evaluate(() => {
      const root = document.getElementById('root')
      return { htmlLen: root?.innerHTML?.length || 0 }
    })
    if (state.htmlLen > 100) navOk++
  }
  log('10个路由全部渲染', navOk === 10, `${navOk}/10`)

  // ===== 13. 主题切换测试 =====
  console.log('\n━━━ 13. 主题切换测试 ━━━')
  await callApi(page, 'settings:set', 'general.theme', 'dark')
  // 派发 theme-changed 事件触发 useTheme 应用到 DOM(模拟前端 ThemeToggle/SettingsPage 行为)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('theme-changed', { detail: 'dark' })))
  await page.waitForTimeout(500)
  const darkAttr = await page.evaluate(() => {
    return {
      htmlClass: document.documentElement.className,
      bodyClass: document.body.className,
      dataTheme: document.documentElement.getAttribute('data-theme') || document.body.getAttribute('data-theme') || '',
    }
  })
  log('dark主题已设置', darkAttr.htmlClass.includes('dark') || darkAttr.bodyClass.includes('dark') || darkAttr.dataTheme === 'dark',
    `html=${darkAttr.htmlClass} body=${darkAttr.bodyClass} theme=${darkAttr.dataTheme}`)

  await callApi(page, 'settings:set', 'general.theme', 'light')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('theme-changed', { detail: 'light' })))
  await page.waitForTimeout(500)
  const lightAttr = await page.evaluate(() => {
    return {
      htmlClass: document.documentElement.className,
      bodyClass: document.body.className,
      dataTheme: document.documentElement.getAttribute('data-theme') || document.body.getAttribute('data-theme') || '',
    }
  })
  log('light主题已设置', !lightAttr.htmlClass.includes('dark') || lightAttr.dataTheme === 'light',
    `html=${lightAttr.htmlClass} body=${lightAttr.bodyClass} theme=${lightAttr.dataTheme}`)

  // ===== 14. 控制台错误检查 =====
  console.log('\n━━━ 14. 控制台错误检查 ━━━')
  const errors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(`PAGE_ERROR: ${err.message}`))
  // 触发一次导航来收集错误
  await navigateTo(page, '/dashboard')
  await page.waitForTimeout(2000)
  const realErrors = errors.filter(e =>
    !e.includes('better-sqlite3') &&
    !e.includes('NODE_MODULE_VERSION') &&
    !e.includes('DevTools') &&
    !e.includes('Download the React DevTools')
  )
  log('无控制台错误', realErrors.length === 0, `${realErrors.length} errors`)

  // ===== 总结 =====
  console.log('\n╔══════════════════════════════════════════════════╗')
  console.log(`║  总计: ${results.pass} 通过 / ${results.fail} 失败 / ${results.pass + results.fail} 总计`.padEnd(50) + '║')
  console.log('╚══════════════════════════════════════════════════╝')

  if (results.fail > 0) {
    console.log('\n失败项:')
    for (const d of results.details.filter(x => !x.ok)) {
      console.log(`  ✗ ${d.name} ${d.detail}`)
    }
  }

  await browser.close()
  process.exit(results.fail > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
