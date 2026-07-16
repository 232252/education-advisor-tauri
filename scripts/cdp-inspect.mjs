// =============================================================
// CDP 全面调试脚本 — 连接到 Tauri WebView2,逐页检查渲染状态
// 用法: node scripts/cdp-inspect.mjs
// 前提: Tauri 应用已用 --remote-debugging-port=9222 启动
// =============================================================

import { chromium } from 'playwright'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SHOTS_DIR = resolve(ROOT, 'test-results', 'cdp-shots')
const REPORTS_DIR = resolve(ROOT, 'test-results', 'cdp-reports')
if (!existsSync(SHOTS_DIR)) mkdirSync(SHOTS_DIR, { recursive: true })
if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true })

// 10 个页面路由
const PAGES = [
  { path: '/dashboard', name: '仪表盘', expectText: ['仪表', 'Dashboard', '概览', '统计'] },
  { path: '/chat', name: 'AI对话', expectText: ['对话', 'Chat', '消息', '发送'] },
  { path: '/students', name: '学生管理', expectText: ['学生', 'Student', '姓名', '班级'] },
  { path: '/classes', name: '班级管理', expectText: ['班级', 'Class', '年级'] },
  { path: '/agents', name: '智能体', expectText: ['Agent', '智能体', '代理'] },
  { path: '/models', name: '模型配置', expectText: ['模型', 'Model', 'Provider', 'API'] },
  { path: '/skills', name: '技能', expectText: ['Skill', '技能', '工具'] },
  { path: '/scheduler', name: '定时任务', expectText: ['定时', 'Scheduler', '任务', 'cron'] },
  { path: '/privacy', name: '隐私引擎', expectText: ['隐私', 'Privacy', '脱敏'] },
  { path: '/settings', name: '设置', expectText: ['设置', 'Settings', '主题', '语言'] },
]

async function inspectPage(page, route) {
  const result = {
    route: route.path,
    name: route.name,
    timestamp: new Date().toISOString(),
    errors: [],
    warnings: [],
    consoleMessages: [],
    unhandledRejections: [],
    domStats: {},
    rendered: false,
    hasContent: false,
    expectTextFound: [],
    expectTextMissing: [],
    interactions: {},
    screenshotPath: '',
    issues: [],
  }

  // 收集 console 消息
  const consoleHandler = (msg) => {
    const type = msg.type()
    const text = msg.text()
    result.consoleMessages.push({ type, text, location: msg.location() })
    if (type === 'error') {
      result.errors.push(text)
    } else if (type === 'warning') {
      result.warnings.push(text)
    }
  }
  page.on('console', consoleHandler)

  // 捕获未处理的 Promise rejection
  const rejectionHandler = (err) => {
    result.unhandledRejections.push(err.message || String(err))
  }
  page.on('pageerror', rejectionHandler)

  // 导航到页面 (使用 hash 路由)
  try {
    await page.evaluate((p) => {
      window.location.hash = p
    }, route.path)
    // 等待路由切换 + 懒加载完成
    await page.waitForTimeout(2000)
  } catch (e) {
    result.issues.push(`导航失败: ${e.message}`)
  }

  // 等待可能的骨架屏消失
  await page.waitForTimeout(1000)

  // 采集 DOM 统计
  try {
    result.domStats = await page.evaluate(() => {
      const body = document.body
      const main = document.querySelector('main') || document.querySelector('#root') || body
      return {
        bodyChildCount: body?.children?.length || 0,
        bodyTextLength: body?.innerText?.length || 0,
        mainChildCount: main?.children?.length || 0,
        buttonCount: document.querySelectorAll('button').length,
        inputCount: document.querySelectorAll('input,textarea,select').length,
        linkCount: document.querySelectorAll('a[href]').length,
        imgCount: document.querySelectorAll('img').length,
        svgCount: document.querySelectorAll('svg').length,
        tableCount: document.querySelectorAll('table').length,
        formCount: document.querySelectorAll('form').length,
        // 检测骨架屏(还在加载中)
        skeletonCount: document.querySelectorAll('.animate-pulse, .animate-fade-in').length,
        // 检测错误边界
        errorBoundaryCount: document.querySelectorAll('[class*="error"], [class*="Error"]').length,
        // 检测空状态
        emptyStateCount: document.querySelectorAll('[class*="empty"], [class*="Empty"]').length,
        // 检测加载状态
        loadingCount: document.querySelectorAll('[class*="loading"], [class*="Loading"], [class*="spinner"], [class*="Spinner"]').length,
        // 标题
        title: document.title,
        // 第一个 h1/h2 文本
        h1Text: document.querySelector('h1')?.innerText || '',
        h2Text: document.querySelector('h2')?.innerText || '',
        // body 前 500 字符
        bodySnippet: body?.innerText?.slice(0, 500) || '',
      }
    })
  } catch (e) {
    result.issues.push(`DOM统计失败: ${e.message}`)
  }

  // 判断是否成功渲染
  result.rendered = result.domStats.bodyChildCount > 0
  result.hasContent = (result.domStats.bodyTextLength || 0) > 50

  // 检查预期文本
  const bodyText = (result.domStats.bodySnippet || '').toLowerCase()
  for (const expect of route.expectText) {
    if (bodyText.includes(expect.toLowerCase())) {
      result.expectTextFound.push(expect)
    } else {
      result.expectTextMissing.push(expect)
    }
  }

  // 如果所有预期文本都缺失,可能是页面渲染异常
  if (result.expectTextMissing.length === route.expectText.length && result.expectTextFound.length === 0) {
    result.issues.push(`页面可能未正确渲染: 未找到任何预期文本 ${JSON.stringify(route.expectText)}`)
  }

  // 检测常见渲染问题
  if (result.errors.length > 0) {
    for (const err of result.errors) {
      // 过滤掉已知的无害错误
      if (err.includes('favicon') || err.includes('DevTools')) continue
      result.issues.push(`控制台错误: ${err.slice(0, 200)}`)
    }
  }

  if (result.unhandledRejections.length > 0) {
    for (const rej of result.unhandledRejections) {
      result.issues.push(`未处理异常: ${rej.slice(0, 200)}`)
    }
  }

  // 如果页面文本长度过短,可能是空白页
  if (result.hasContent && (result.domStats.bodyTextLength || 0) < 100) {
    result.issues.push(`页面内容过少 (${result.domStats.bodyTextLength} 字符),可能渲染不完整`)
  }

  // 如果还在显示骨架屏
  if ((result.domStats.skeletonCount || 0) > 5) {
    result.issues.push(`页面可能有 ${result.domStats.skeletonCount} 个骨架屏未消失(加载卡住)`)
  }

  // 截图
  try {
    const shotPath = resolve(SHOTS_DIR, `${route.path.slice(1)}.png`)
    await page.screenshot({ path: shotPath, fullPage: true })
    result.screenshotPath = shotPath
  } catch (e) {
    result.issues.push(`截图失败: ${e.message}`)
  }

  // 采集交互元素信息
  try {
    result.interactions = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button')).slice(0, 20)
      const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 20)
      return {
        buttons: buttons.map((b) => ({
          text: b.innerText?.slice(0, 50) || b.getAttribute('aria-label') || '',
          disabled: b.disabled,
          classes: b.className?.slice(0, 80) || '',
        })),
        links: links.map((l) => ({
          text: l.innerText?.slice(0, 50) || '',
          href: l.getAttribute('href') || '',
        })),
      }
    })
  } catch (e) {
    result.issues.push(`交互元素采集失败: ${e.message}`)
  }

  page.off('console', consoleHandler)
  page.off('pageerror', rejectionHandler)

  return result
}

async function main() {
  console.log('━━━ CDP 全面页面调试 ━━━\n')
  console.log(`时间: ${new Date().toISOString()}\n`)

  // 连接到 Tauri 的 WebView2
  console.log('连接到 CDP (port 9222)...')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  console.log('已连接\n')

  // 获取已有的 context 和 page
  const contexts = browser.contexts()
  if (contexts.length === 0) {
    console.error('错误: 没有可用的浏览器上下文')
    process.exit(1)
  }
  const context = contexts[0]
  const pages = context.pages()
  if (pages.length === 0) {
    console.error('错误: 没有可用的页面')
    process.exit(1)
  }
  const page = pages[0]
  console.log(`当前页面 URL: ${page.url()}\n`)

  const allResults = []
  let passCount = 0
  let failCount = 0
  let issueCount = 0

  for (const route of PAGES) {
    console.log(`\n━━━ 检查: ${route.name} (${route.path}) ━━━`)
    try {
      const result = await inspectPage(page, route)
      allResults.push(result)

      const status = result.issues.length === 0 ? 'OK' : 'ISSUE'
      if (status === 'OK') {
        passCount++
        console.log(`  ✓ 渲染正常`)
      } else {
        failCount++
        issueCount += result.issues.length
        console.log(`  ✗ 发现 ${result.issues.length} 个问题:`)
        for (const issue of result.issues) {
          console.log(`    - ${issue}`)
        }
      }

      console.log(`  DOM: bodyChild=${result.domStats.bodyChildCount}, text=${result.domStats.bodyTextLength}字符, btn=${result.domStats.buttonCount}, input=${result.domStats.inputCount}`)
      console.log(`  预期文本: 找到 ${result.expectTextFound.length}/${route.expectText.length} (${result.expectTextFound.join(', ') || '无'})`)
      if (result.errors.length > 0) {
        console.log(`  控制台错误: ${result.errors.length} 条`)
        for (const e of result.errors.slice(0, 3)) {
          console.log(`    ! ${e.slice(0, 150)}`)
        }
      }
      if (result.warnings.length > 0) {
        console.log(`  警告: ${result.warnings.length} 条`)
      }
      console.log(`  截图: ${result.screenshotPath ? '已保存' : '失败'}`)
    } catch (e) {
      console.log(`  ✗ 检查异常: ${e.message}`)
      failCount++
      allResults.push({
        route: route.path,
        name: route.name,
        error: e.message,
        issues: [`检查异常: ${e.message}`],
      })
    }
  }

  // 生成报告
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      total: PAGES.length,
      passed: passCount,
      failed: failCount,
      totalIssues: issueCount,
    },
    pages: allResults,
  }

  const reportPath = resolve(REPORTS_DIR, `cdp-inspect-${Date.now()}.json`)
  writeFileSync(reportPath, JSON.stringify(report, null, 2))

  console.log(`\n━━━ 总结 ━━━`)
  console.log(`通过: ${passCount}/${PAGES.length}`)
  console.log(`失败: ${failCount}/${PAGES.length}`)
  console.log(`总问题数: ${issueCount}`)
  console.log(`报告: ${reportPath}`)
  console.log(`截图目录: ${SHOTS_DIR}`)

  await browser.close()

  // 以退出码反映结果
  process.exit(failCount > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(2)
})
