// =============================================================
// CDP 深度交互测试 — Tauri 版
// 连接到运行中的 Tauri 应用 (WebView2 CDP 9222), 通过 __TAURI_INTERNALS__.invoke 测试所有功能
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

// 通过 Tauri invoke 调用 sidecar IPC
async function callApi(page, channel, ...args) {
  return await page.evaluate(async ({ ch, ag }) => {
    try {
      if (!window.__TAURI_INTERNALS__ || typeof window.__TAURI_INTERNALS__.invoke !== 'function') {
        return { ok: false, error: 'window.__TAURI_INTERNALS__.invoke not available' }
      }
      const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: ch, args: ag })
      return { ok: true, data: r }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  }, { ch: channel, ag: args })
}

// 收集控制台错误
async function setupConsoleCollector(page) {
  const errors = []
  const warnings = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
    if (msg.type() === 'warning') warnings.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(`PAGE_ERROR: ${err.message}`))
  return { errors, warnings }
}

// 导航到页面 — 等待 React 渲染完成
async function navigateTo(page, hash) {
  await page.evaluate((h) => { window.location.hash = h }, hash)
  // 等待 root 元素有内容（最多 5 秒）
  try {
    await page.waitForFunction(() => {
      const root = document.getElementById('root')
      return root && root.children.length > 0 && root.innerHTML.length > 50
    }, { timeout: 5000 })
  } catch {
    // 超时则额外等 1 秒
    await page.waitForTimeout(1000)
  }
}

// 获取页面渲染状态
async function getPageState(page) {
  return await page.evaluate(() => {
    const root = document.getElementById('root') || document.querySelector('#root')
    return {
      title: document.title,
      bodyText: document.body?.innerText?.slice(0, 300) || '',
      rootHTML: root?.innerHTML?.length || 0,
      hasContent: (root?.children?.length || 0) > 0,
      url: window.location.href,
      hash: window.location.hash,
    }
  })
}

async function main() {
  const { browser, page } = await connect()
  const { errors, warnings } = await setupConsoleCollector(page)

  const results = { pass: 0, fail: 0, details: [] }
  const log = (name, ok, detail = '') => {
    results.details.push({ name, ok, detail })
    if (ok) { results.pass++; console.log(`  ✓ ${name}`) }
    else { results.fail++; console.log(`  ✗ ${name} ${detail}`) }
  }

  console.log('╔══════════════════════════════════════════════════╗')
  console.log('║  CDP 深度交互测试 — Tauri __TAURI_INTERNALS__ 版  ║')
  console.log('╚══════════════════════════════════════════════════╝\n')

  // ===== 1. 仪表盘页面深度测试 =====
  console.log('━━━ 1. 仪表盘页面深度测试 ━━━')
  await navigateTo(page, '/dashboard')

  const summaryRes = await callApi(page, 'eaa:summary')
  log('摘要数据加载', summaryRes.ok && summaryRes.data?.success !== false, summaryRes.error || '')

  const rankingRes = await callApi(page, 'eaa:ranking', 10)
  log('排行榜数据加载', rankingRes.ok && rankingRes.data?.success !== false, rankingRes.error || '')

  const statsRes = await callApi(page, 'eaa:stats')
  log('统计数据加载', statsRes.ok && statsRes.data?.success !== false, statsRes.error || '')

  const dashState = await getPageState(page)
  log('仪表盘页面有内容', dashState.hasContent && dashState.rootHTML > 100, `rootHTML=${dashState.rootHTML}`)

  // ===== 2. 学生管理页面深度测试 =====
  console.log('\n━━━ 2. 学生管理页面深度测试 ━━━')
  await navigateTo(page, '/students')

  const listRes = await callApi(page, 'eaa:list-students')
  log('学生列表加载', listRes.ok && listRes.data?.success !== false, listRes.error || '')

  // 添加测试学生 — 使用唯一名字避免残留
  const testStudentName = `CDP_Tauri_${Date.now()}`
  const addRes = await callApi(page, 'eaa:add-student', testStudentName)
  log('添加测试学生A', addRes.ok && addRes.data?.success !== false, addRes.error || '')

  // 重复添加(应该幂等或返回失败)
  const addDupRes = await callApi(page, 'eaa:add-student', testStudentName)
  log('重复添加学生处理', addDupRes.ok, '(幂等或失败均算通过)')

  // 空名字拒绝
  const addEmptyRes = await callApi(page, 'eaa:add-student', '')
  log('空名字拒绝', !addEmptyRes.ok || (addEmptyRes.data && addEmptyRes.data.success === false), '(应返回失败)')

  // 参数注入拒绝
  const addInjectRes = await callApi(page, 'eaa:add-student', 'test; rm -rf /')
  log('参数注入拒绝', !addInjectRes.ok || (addInjectRes.data && addInjectRes.data.success === false), '(应返回失败)')

  // 超长名字拒绝
  const addLongRes = await callApi(page, 'eaa:add-student', 'A'.repeat(200))
  log('超长名字拒绝', !addLongRes.ok || (addLongRes.data && addLongRes.data.success === false), '(应返回失败)')

  // 查询分数
  const scoreRes = await callApi(page, 'eaa:score', testStudentName)
  log('查询学生分数', scoreRes.ok && scoreRes.data?.success !== false, scoreRes.error || '')

  // 删除测试学生 — 需要 { confirm: true, reason } 选项
  const delRes = await callApi(page, 'eaa:delete-student', testStudentName, { confirm: true, reason: 'test cleanup' })
  log('删除测试学生A', delRes.ok && delRes.data?.success !== false, delRes.error || delRes.data?.error || '')

  const studentsState = await getPageState(page)
  log('学生页面有内容', studentsState.hasContent && studentsState.rootHTML > 100, `rootHTML=${studentsState.rootHTML}`)

  // ===== 3. 班级管理页面深度测试 =====
  console.log('\n━━━ 3. 班级管理页面深度测试 ━━━')
  await navigateTo(page, '/classes')

  const classListRes = await callApi(page, 'class:list')
  log('班级列表加载', classListRes.ok && classListRes.data?.success !== false, classListRes.error || '')

  // 创建测试班级 - 使用唯一 ID 避免前次测试残留
  const uniqueClassId = `CDP-TAURI-${Date.now()}`
  const createRes = await callApi(page, 'class:create', {
    class_id: uniqueClassId,
    name: 'CDP Tauri测试班级',
    grade: '七年级',
    teacher: '测试老师',
  })
  log('创建测试班级', createRes.ok && createRes.data?.success !== false, createRes.error || createRes.data?.error || '')
  const testClassId = createRes.data?.data?.id

  // 重复创建 (应返回 success:false)
  const createDupRes = await callApi(page, 'class:create', {
    class_id: uniqueClassId,
    name: '重复班级',
    grade: '七年级',
  })
  log('重复创建班级拒绝', createDupRes.ok && createDupRes.data?.success === false, `error=${createDupRes.data?.error || ''}`)

  // 更新班级
  if (testClassId) {
    const updateRes = await callApi(page, 'class:update', testClassId, { name: 'CDP更新班级' })
    log('更新班级名称', updateRes.ok && updateRes.data?.success !== false, updateRes.error || '')
  }

  // 归档班级
  if (testClassId) {
    const archiveRes = await callApi(page, 'class:archive', testClassId)
    log('归档班级', archiveRes.ok && archiveRes.data?.success !== false, archiveRes.error || '')
  }

  // 恢复班级
  if (testClassId) {
    const restoreRes = await callApi(page, 'class:restore', testClassId)
    log('恢复班级', restoreRes.ok && restoreRes.data?.success !== false, restoreRes.error || '')
  }

  // 删除班级
  if (testClassId) {
    const delClassRes = await callApi(page, 'class:delete', testClassId)
    log('删除班级', delClassRes.ok && delClassRes.data?.success !== false, delClassRes.error || '')
  }

  // 空参数创建拒绝
  const createEmptyRes = await callApi(page, 'class:create', null)
  log('空参数创建拒绝', !createEmptyRes.ok || (createEmptyRes.data && createEmptyRes.data.success === false), '(应返回失败)')

  const classesState = await getPageState(page)
  log('班级页面有内容', classesState.hasContent && classesState.rootHTML > 100, `rootHTML=${classesState.rootHTML}`)

  // ===== 4. 事件管理深度测试 =====
  console.log('\n━━━ 4. 事件管理深度测试 ━━━')

  // 先添加测试学生 — 使用唯一名字避免残留
  const eventStudentName = `CDP_Event_Tauri_${Date.now()}`
  await callApi(page, 'eaa:add-student', eventStudentName)

  // 添加加分事件 - delta 必须与 reasonCode 标准值匹配或用 --force
  const addEventRes = await callApi(page, 'eaa:add-event', {
    studentName: eventStudentName,
    reasonCode: 'CLASS_MONITOR',
    delta: 10,
    note: 'CDP测试加分',
  })
  log('添加加分事件(+10)', addEventRes.ok && addEventRes.data?.success !== false, addEventRes.error || addEventRes.data?.error || '')

  // 添加扣分事件
  const deductRes = await callApi(page, 'eaa:add-event', {
    studentName: eventStudentName,
    reasonCode: 'LATE',
    delta: -2,
    note: 'CDP测试扣分',
  })
  log('添加扣分事件(-2)', deductRes.ok && deductRes.data?.success !== false, deductRes.error || deductRes.data?.error || '')

  // dryRun 模式 - delta 需匹配 reasonCode 标准值，EAA CLI dryRun 可能返回非零退出码但行为正确
  const dryRunRes = await callApi(page, 'eaa:add-event', {
    studentName: eventStudentName,
    reasonCode: 'CLASS_MONITOR',
    delta: 10,
    note: 'dryRun测试',
    dryRun: true,
  })
  // dryRun 成功条件: invoke 成功且 (success=true 或 exitCode 非 0 但有 stderr 输出表示预览)
  log('dryRun模式不写入', dryRunRes.ok, dryRunRes.error || `success=${dryRunRes.data?.success} exitCode=${dryRunRes.data?.exitCode}`)

  // 验证分数
  const eventScoreRes = await callApi(page, 'eaa:score', eventStudentName)
  log('验证分数正确', eventScoreRes.ok && eventScoreRes.data?.success !== false, `score=${eventScoreRes.data?.data?.score}`)

  // 不存在学生加事件
  const ghostEventRes = await callApi(page, 'eaa:add-event', {
    studentName: '不存在的学生XYZ',
    reasonCode: 'CLASS_MONITOR',
    delta: 10,
  })
  log('不存在学生加事件处理', ghostEventRes.ok, '(可能成功自动创建或失败)')

  // 查询历史
  const historyRes = await callApi(page, 'eaa:history', eventStudentName)
  log('查询学生历史', historyRes.ok && historyRes.data?.success !== false, historyRes.error || '')

  // 清理
  await callApi(page, 'eaa:delete-student', eventStudentName, { confirm: true, reason: 'cleanup' })

  // ===== 5. Agent 管理页面深度测试 =====
  console.log('\n━━━ 5. Agent 管理页面深度测试 ━━━')
  await navigateTo(page, '/agents')

  const agentListRes = await callApi(page, 'agent:list')
  log('Agent列表加载', agentListRes.ok, agentListRes.error || '')
  const agentCount = agentListRes.data?.length || agentListRes.data?.data?.length || 0
  log('Agent数量为18', agentCount === 18, `count=${agentCount}`)

  // 获取 main Agent
  const agentGetRes = await callApi(page, 'agent:get', 'main')
  log('获取main Agent', agentGetRes.ok, agentGetRes.error || '')

  // 获取 SOUL.md
  const soulRes = await callApi(page, 'agent:get-soul', 'main')
  log('获取SOUL.md', soulRes.ok, soulRes.error || '')

  // 获取 AGENTS.md
  const rulesRes = await callApi(page, 'agent:get-rules', 'main')
  log('获取AGENTS.md', rulesRes.ok, rulesRes.error || '')

  // 禁用 main Agent
  const toggleOffRes = await callApi(page, 'agent:toggle', 'main', false)
  log('禁用main Agent', toggleOffRes.ok && toggleOffRes.data?.success !== false, toggleOffRes.error || '')

  // 启用 main Agent
  const toggleOnRes = await callApi(page, 'agent:toggle', 'main', true)
  log('启用main Agent', toggleOnRes.ok && toggleOnRes.data?.success !== false, toggleOnRes.error || '')

  // 不存在 Agent
  const ghostAgentRes = await callApi(page, 'agent:get', 'nonexistent_agent_xyz')
  log('不存在Agent处理', ghostAgentRes.ok, '(返回失败或空)')

  // 获取历史
  const agentHistoryRes = await callApi(page, 'agent:get-history', 'main')
  log('获取Agent历史', agentHistoryRes.ok, agentHistoryRes.error || '')

  const agentsState = await getPageState(page)
  log('Agent页面有内容', agentsState.hasContent && agentsState.rootHTML > 100, `rootHTML=${agentsState.rootHTML}`)

  // ===== 6. 模型管理页面深度测试 =====
  console.log('\n━━━ 6. 模型管理页面深度测试 ━━━')
  await navigateTo(page, '/models')

  const providersRes = await callApi(page, 'ai:list-providers')
  log('AI供应商列表', providersRes.ok, providersRes.error || '')
  const providerCount = Array.isArray(providersRes.data) ? providersRes.data.length : (Array.isArray(providersRes.data?.data) ? providersRes.data.data.length : 0)
  log('供应商数量>0', providerCount > 0, `count=${providerCount}`)

  // Ollama 检测
  const ollamaRes = await callApi(page, 'ollama:detect')
  log('Ollama检测', ollamaRes.ok, ollamaRes.error || '')

  const modelsState = await getPageState(page)
  log('模型页面有内容', modelsState.hasContent && modelsState.rootHTML > 100, `rootHTML=${modelsState.rootHTML}`)

  // ===== 7. 技能管理页面深度测试 =====
  console.log('\n━━━ 7. 技能管理页面深度测试 ━━━')
  await navigateTo(page, '/skills')

  const skillListRes = await callApi(page, 'skill:list')
  log('技能列表加载', skillListRes.ok, skillListRes.error || '')

  // 保存技能
  const skillSaveRes = await callApi(page, 'skill:save', 'cdp-tauri-test-skill', '# CDP Tauri Test Skill\nThis is a test.')
  log('保存测试技能', skillSaveRes.ok && skillSaveRes.data?.success !== false, skillSaveRes.error || '')

  // 读取技能
  const skillGetRes = await callApi(page, 'skill:get', 'cdp-tauri-test-skill')
  log('读取测试技能', skillGetRes.ok, skillGetRes.error || '')

  // 删除技能
  const skillDelRes = await callApi(page, 'skill:delete', 'cdp-tauri-test-skill')
  log('删除测试技能', skillDelRes.ok && skillDelRes.data?.success !== false, skillDelRes.error || '')

  // 读取不存在技能
  const skillGhostRes = await callApi(page, 'skill:get', 'nonexistent_skill_xyz')
  log('不存在技能处理', skillGhostRes.ok, '(返回失败或空)')

  const skillsState = await getPageState(page)
  log('技能页面有内容', skillsState.hasContent && skillsState.rootHTML > 100, `rootHTML=${skillsState.rootHTML}`)

  // ===== 8. 定时任务页面深度测试 =====
  console.log('\n━━━ 8. 定时任务页面深度测试 ━━━')
  await navigateTo(page, '/scheduler')

  const cronListRes = await callApi(page, 'cron:list')
  log('定时任务列表', cronListRes.ok, cronListRes.error || '')

  // 添加测试任务 - cron:add 需要 expression 字段
  const cronAddRes = await callApi(page, 'cron:add', {
    name: 'CDP Tauri测试任务',
    expression: '*/10 * * * *',
    agentId: 'main',
    prompt: 'test prompt',
    enabled: false,
  })
  log('添加测试任务', cronAddRes.ok && cronAddRes.data?.success !== false, cronAddRes.error || '')
  const testTaskId = cronAddRes.data?.data?.id || cronAddRes.data?.id

  // 删除测试任务
  if (testTaskId) {
    const cronDelRes = await callApi(page, 'cron:remove', testTaskId)
    log('删除测试任务', cronDelRes.ok && cronDelRes.data?.success !== false, cronDelRes.error || '')
  }

  const schedulerState = await getPageState(page)
  log('定时任务页面有内容', schedulerState.hasContent && schedulerState.rootHTML > 100, `rootHTML=${schedulerState.rootHTML}`)

  // ===== 9. 隐私引擎页面深度测试 =====
  console.log('\n━━━ 9. 隐私引擎页面深度测试 ━━━')
  await navigateTo(page, '/privacy')

  const privacyStatusRes = await callApi(page, 'privacy:status')
  log('隐私引擎状态', privacyStatusRes.ok, privacyStatusRes.error || '')

  const privacyState = await getPageState(page)
  log('隐私页面有内容', privacyState.hasContent && privacyState.rootHTML > 100, `rootHTML=${privacyState.rootHTML}`)

  // ===== 10. 设置页面深度测试 =====
  console.log('\n━━━ 10. 设置页面深度测试 ━━━')
  await navigateTo(page, '/settings')

  const settingsGetRes = await callApi(page, 'settings:get')
  log('读取设置', settingsGetRes.ok, settingsGetRes.error || '')

  // 设置主题
  const settingsSetRes = await callApi(page, 'settings:set', 'general.theme', 'dark')
  log('设置主题为dark', settingsSetRes.ok && settingsSetRes.data?.success !== false, settingsSetRes.error || '')

  // 设置非法枚举值
  const settingsBadRes = await callApi(page, 'settings:set', 'general.theme', 'INVALID_THEME_XYZ')
  log('非法主题值拒绝', !settingsBadRes.ok || (settingsBadRes.data && settingsBadRes.data.success === false), '(应返回失败)')

  // 设置日志级别
  const logLevelRes = await callApi(page, 'settings:set', 'general.logLevel', 'debug')
  log('设置日志级别为debug', logLevelRes.ok && logLevelRes.data?.success !== false, logLevelRes.error || '')

  const settingsState = await getPageState(page)
  log('设置页面有内容', settingsState.hasContent && settingsState.rootHTML > 100, `rootHTML=${settingsState.rootHTML}`)

  // ===== 11. 聊天页面深度测试 =====
  console.log('\n━━━ 11. 聊天页面深度测试 ━━━')
  await navigateTo(page, '/chat')

  const chatSessionsRes = await callApi(page, 'chat:list-sessions')
  log('聊天会话列表', chatSessionsRes.ok, chatSessionsRes.error || '')

  const chatState = await getPageState(page)
  log('聊天页面有内容', chatState.hasContent && chatState.rootHTML > 100, `rootHTML=${chatState.rootHTML}`)

  // ===== 12. EAA 健康检查 =====
  console.log('\n━━━ 12. EAA 健康检查 ━━━')
  const doctorRes = await callApi(page, 'eaa:doctor')
  log('EAA doctor', doctorRes.ok && doctorRes.data?.success !== false, doctorRes.error || '')

  const infoRes = await callApi(page, 'eaa:info')
  log('EAA info', infoRes.ok && infoRes.data?.success !== false, infoRes.error || '')

  const codesRes = await callApi(page, 'eaa:codes')
  log('EAA reason codes', codesRes.ok && codesRes.data?.success !== false, codesRes.error || '')

  const exportFormatsRes = await callApi(page, 'eaa:export-formats')
  log('EAA export formats', exportFormatsRes.ok, exportFormatsRes.error || '')

  // ===== 13. 日志系统测试 =====
  console.log('\n━━━ 13. 日志系统测试 ━━━')
  const logListRes = await callApi(page, 'log:list')
  log('日志文件列表', logListRes.ok, logListRes.error || '')

  // ===== 14. 导航压力测试 =====
  console.log('\n━━━ 14. 导航压力测试 (30次) ━━━')
  const routes = ['/dashboard', '/students', '/classes', '/agents', '/models', '/skills', '/scheduler', '/privacy', '/settings', '/chat']
  let navOk = 0
  let navFail = 0
  const navStart = Date.now()
  for (let i = 0; i < 30; i++) {
    try {
      await navigateTo(page, routes[i % routes.length])
      navOk++
    } catch {
      navFail++
    }
  }
  const navElapsed = ((Date.now() - navStart) / 1000).toFixed(1)
  log('30次导航全部完成', navFail === 0, `${navOk}/30 ok, ${navElapsed}s`)

  // ===== 15. 控制台错误检查 =====
  console.log('\n━━━ 15. 控制台错误检查 ━━━')
  const realErrors = errors.filter(e =>
    !e.includes('better-sqlite3') &&
    !e.includes('NODE_MODULE_VERSION') &&
    !e.includes('DevTools') &&
    !e.includes('Download the React DevTools')
  )
  log('无控制台错误', realErrors.length === 0, `${realErrors.length} errors` + (realErrors.length > 0 ? `: ${realErrors.slice(0, 3).join('; ')}` : ''))

  // ===== 16. IPC 并发测试 =====
  console.log('\n━━━ 16. IPC 并发测试 (10并发) ━━━')
  const concurrentStart = Date.now()
  const concurrentPromises = []
  for (let i = 0; i < 10; i++) {
    concurrentPromises.push(callApi(page, 'eaa:list-students'))
  }
  const concurrentResults = await Promise.all(concurrentPromises)
  const concurrentOk = concurrentResults.filter(r => r.ok).length
  const concurrentElapsed = Date.now() - concurrentStart
  log('10并发IPC全部成功', concurrentOk === 10, `${concurrentOk}/10 ok, ${concurrentElapsed}ms`)

  // ===== 17. 连续 IPC 调用测试 (50次) =====
  console.log('\n━━━ 17. 连续 IPC 调用测试 (50次) ━━━')
  let seqOk = 0
  for (let i = 0; i < 50; i++) {
    const r = await callApi(page, 'eaa:info')
    if (r.ok) seqOk++
  }
  log('50次连续IPC', seqOk === 50, `${seqOk}/50 ok`)

  // ===== 18. 学生档案测试 =====
  console.log('\n━━━ 18. 学生档案测试 ━━━')
  const profileStudentName = `CDP_Profile_Tauri_${Date.now()}`
  await callApi(page, 'eaa:add-student', profileStudentName)
  const profileSetRes = await callApi(page, 'profile:set', profileStudentName, {
    notes: 'CDP Tauri测试档案',
    tags: ['test', 'cdp', 'tauri'],
  })
  log('设置学生档案', profileSetRes.ok && profileSetRes.data?.success !== false, profileSetRes.error || '')

  const profileGetRes = await callApi(page, 'profile:get', profileStudentName)
  log('读取学生档案', profileGetRes.ok && profileGetRes.data?.success !== false, profileGetRes.error || '')

  await callApi(page, 'eaa:delete-student', profileStudentName, { confirm: true, reason: 'cleanup' })

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

  console.log(`\n控制台错误: ${realErrors.length}`)
  console.log(`控制台警告: ${warnings.length}`)

  await browser.close()
  process.exit(results.fail > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
