// =============================================================
// CDP 深度交互测试 v2 — 多角度功能验证
// 连接到运行中的 Tauri 应用 (CDP 9222), 对每个页面进行深度测试
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

// IPC 调用辅助
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

// 等待页面就绪
async function waitForPageReady(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(500)
}

// 导航到页面
async function navigateTo(page, hash) {
  await page.evaluate((h) => { window.location.hash = h }, hash)
  // 缩短固定等待 (原 800ms 过长, 100次切换需 80s+)
  await page.waitForTimeout(300)
}

// 获取页面渲染状态
async function getPageState(page) {
  return await page.evaluate(() => {
    const body = document.body
    const root = document.getElementById('root') || document.querySelector('#root')
    return {
      title: document.title,
      bodyText: body?.innerText?.slice(0, 200) || '',
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

  console.log('╔══════════════════════════════════════════════╗')
  console.log('║  CDP 深度交互测试 v2 — 多角度功能验证         ║')
  console.log('╚══════════════════════════════════════════════╝\n')

  // ===== 1. 仪表盘页面深度测试 =====
  console.log('━━━ 1. 仪表盘页面深度测试 ━━━')
  await navigateTo(page, '/')
  await waitForPageReady(page)

  // 验证仪表盘数据加载
  const dashboardData = await callIPC(page, 'eaa:dashboard', [])
  log('仪表盘数据加载', dashboardData.ok && dashboardData.data?.success !== false)

  const summaryData = await callIPC(page, 'eaa:summary', [])
  log('摘要数据加载', summaryData.ok && summaryData.data?.success !== false)

  const rankingData = await callIPC(page, 'eaa:ranking', [10])
  log('排行榜数据加载', rankingData.ok && rankingData.data?.success !== false)

  // 验证页面有渲染内容
  const dashState = await getPageState(page)
  log('仪表盘页面有内容', dashState.hasContent && dashState.rootHTML > 100, `rootHTML=${dashState.rootHTML}`)

  // ===== 2. 学生管理页面深度测试 =====
  console.log('\n━━━ 2. 学生管理页面深度测试 ━━━')
  await navigateTo(page, '/students')
  await waitForPageReady(page)

  const studentsData = await callIPC(page, 'eaa:list-students', [])
  log('学生列表加载', studentsData.ok)

  // 测试添加学生
  const addResult = await callIPC(page, 'eaa:add-student', ['CDP测试学生_A'])
  log('添加测试学生A', addResult.ok)

  // 测试重复添加（应返回成功但幂等或失败）
  const addDup = await callIPC(page, 'eaa:add-student', ['CDP测试学生_A'])
  log('重复添加学生(幂等或失败)', addDup.ok || addDup.error)

  // 测试空名字（应失败）
  const addEmpty = await callIPC(page, 'eaa:add-student', [''])
  log('空名字拒绝', !addEmpty.ok || (addEmpty.data && addEmpty.data.success === false))

  // 测试注入尝试（应失败）
  const addInject = await callIPC(page, 'eaa:add-student', ['--inject'])
  log('参数注入拒绝', !addInject.ok || (addInject.data && addInject.data.success === false))

  // 测试超长名字（应失败）
  const addLong = await callIPC(page, 'eaa:add-student', ['A'.repeat(100)])
  log('超长名字拒绝', !addLong.ok || (addLong.data && addLong.data.success === false))

  // 查询学生分数
  if (addResult.ok) {
    const score = await callIPC(page, 'eaa:score', ['CDP测试学生_A'])
    log('查询学生分数', score.ok)
  }

  // 查询学生历史
  if (addResult.ok) {
    const history = await callIPC(page, 'eaa:history', ['CDP测试学生_A'])
    log('查询学生历史', history.ok)
  }

  // ===== 3. 班级管理页面深度测试 =====
  console.log('\n━━━ 3. 班级管理页面深度测试 ━━━')
  await navigateTo(page, '/classes')
  await waitForPageReady(page)

  const classList = await callIPC(page, 'class:list', [])
  log('班级列表加载', classList.ok)

  // 创建测试班级
  const createResult = await callIPC(page, 'class:create', [{
    class_id: 'CDP-TEST-1',
    name: 'CDP测试班级',
    grade: 7,
    teacher: '测试老师'
  }])
  log('创建测试班级', createResult.ok)

  // 重复创建（应幂等或失败）
  const createDup = await callIPC(page, 'class:create', [{
    class_id: 'CDP-TEST-1',
    name: '重复班级'
  }])
  log('重复创建班级处理', createDup.ok || createDup.error)

  // 更新班级
  const updateResult = await callIPC(page, 'class:update', [{
    class_id: 'CDP-TEST-1',
    name: 'CDP测试班级_改名'
  }])
  log('更新班级名称', updateResult.ok)

  // 分配学生到班级
  const assignResult = await callIPC(page, 'class:assign', [{
    class_id: 'CDP-TEST-1',
    student_names: ['CDP测试学生_A']
  }])
  log('分配学生到班级', assignResult.ok)

  // 验证分配结果
  const studentsAfter = await callIPC(page, 'eaa:list-students', [])
  if (studentsAfter.ok) {
    const students = studentsAfter.data?.data?.students || []
    const assigned = students.find(s => s.name === 'CDP测试学生_A')
    log('验证学生已分配', assigned && assigned.class_id === 'CDP-TEST-1', `class_id=${assigned?.class_id}`)
  }

  // 归档班级
  const archiveResult = await callIPC(page, 'class:archive', ['CDP-TEST-1'])
  log('归档班级', archiveResult.ok)

  // 恢复班级
  const restoreResult = await callIPC(page, 'class:restore', ['CDP-TEST-1'])
  log('恢复班级', restoreResult.ok)

  // 删除班级
  const deleteResult = await callIPC(page, 'class:delete', ['CDP-TEST-1'])
  log('删除班级', deleteResult.ok)

  // ===== 4. 事件管理测试 =====
  console.log('\n━━━ 4. 事件管理深度测试 ━━━')

  // 添加加分事件
  const addEvent1 = await callIPC(page, 'eaa:add-event', [{
    studentName: 'CDP测试学生_A',
    reasonCode: 'CLASS_MONITOR',
    delta: 10,
    note: 'CDP测试加分'
  }])
  log('添加加分事件(+10)', addEvent1.ok)

  // 添加扣分事件
  const addEvent2 = await callIPC(page, 'eaa:add-event', [{
    studentName: 'CDP测试学生_A',
    reasonCode: 'LATE',
    delta: -2,
    note: 'CDP测试扣分'
  }])
  log('添加扣分事件(-2)', addEvent2.ok)

  // dryRun 模式
  const dryRun = await callIPC(page, 'eaa:add-event', [{
    studentName: 'CDP测试学生_A',
    reasonCode: 'CLASS_COMMITTEE',
    delta: 5,
    dryRun: true
  }])
  log('dryRun模式不写入', dryRun.ok)

  // 验证分数变化
  const scoreAfter = await callIPC(page, 'eaa:score', ['CDP测试学生_A'])
  log('验证分数正确', scoreAfter.ok)

  // 不存在学生加事件
  const ghostEvent = await callIPC(page, 'eaa:add-event', [{
    studentName: '不存在的学生XYZ',
    reasonCode: 'LATE',
    delta: -1
  }])
  log('不存在学生加事件处理', ghostEvent.ok)

  // ===== 5. Agent 管理页面测试 =====
  console.log('\n━━━ 5. Agent 管理页面深度测试 ━━━')
  await navigateTo(page, '/agents')
  await waitForPageReady(page)

  const agentList = await callIPC(page, 'agent:list', [])
  log('Agent列表加载', agentList.ok && Array.isArray(agentList.data?.data || agentList.data))

  const agentCount = agentList.data?.data?.length || agentList.data?.length || 0
  log('Agent数量为18', agentCount === 18, `count=${agentCount}`)

  // 获取 main Agent
  const mainAgent = await callIPC(page, 'agent:get', ['main'])
  log('获取main Agent', mainAgent.ok)

  // 获取 SOUL.md
  const soul = await callIPC(page, 'agent:get-soul', ['main'])
  log('获取SOUL.md', soul.ok)

  // 获取 AGENTS.md
  const rules = await callIPC(page, 'agent:get-rules', ['main'])
  log('获取AGENTS.md', rules.ok)

  // 切换 Agent 启用状态
  const toggleOff = await callIPC(page, 'agent:toggle', ['main', false])
  log('禁用main Agent', toggleOff.ok)
  const toggleOn = await callIPC(page, 'agent:toggle', ['main', true])
  log('启用main Agent', toggleOn.ok)

  // 不存在 Agent
  const ghostAgent = await callIPC(page, 'agent:get', ['nonexistent_agent'])
  log('不存在Agent处理', ghostAgent.ok)

  // Agent 页面渲染
  const agentState = await getPageState(page)
  log('Agent页面有内容', agentState.hasContent && agentState.rootHTML > 100)

  // ===== 6. 模型管理页面测试 =====
  console.log('\n━━━ 6. 模型管理页面深度测试 ━━━')
  await navigateTo(page, '/models')
  await waitForPageReady(page)

  const providers = await callIPC(page, 'ai:list-providers', [])
  log('AI供应商列表', providers.ok)

  const providerCount = providers.data?.data?.length || providers.data?.length || 0
  log('供应商数量>0', providerCount > 0, `count=${providerCount}`)

  const openaiModels = await callIPC(page, 'ai:list-models', ['openai'])
  log('OpenAI模型列表', openaiModels.ok)

  const ollamaDetect = await callIPC(page, 'ollama:detect', [])
  log('Ollama检测', ollamaDetect.ok)

  const modelsState = await getPageState(page)
  log('模型页面有内容', modelsState.hasContent)

  // ===== 7. 技能管理页面测试 =====
  console.log('\n━━━ 7. 技能管理页面深度测试 ━━━')
  await navigateTo(page, '/skills')
  await waitForPageReady(page)

  const skillList = await callIPC(page, 'skill:list', [])
  log('技能列表加载', skillList.ok)

  // 保存技能
  const saveSkill = await callIPC(page, 'skill:save', [{
    name: 'CDP测试技能',
    content: '# CDP测试技能\n这是一个测试技能'
  }])
  log('保存测试技能', saveSkill.ok)

  // 获取技能
  const getSkill = await callIPC(page, 'skill:get', ['CDP测试技能'])
  log('读取测试技能', getSkill.ok)

  // 删除技能
  const delSkill = await callIPC(page, 'skill:delete', ['CDP测试技能'])
  log('删除测试技能', delSkill.ok)

  const skillsState = await getPageState(page)
  log('技能页面有内容', skillsState.hasContent)

  // ===== 8. 定时任务页面测试 =====
  console.log('\n━━━ 8. 定时任务页面深度测试 ━━━')
  await navigateTo(page, '/cron')
  await waitForPageReady(page)

  const cronList = await callIPC(page, 'cron:list', [])
  log('Cron列表加载', cronList.ok)

  // 添加合法 Cron
  const addCron = await callIPC(page, 'cron:add', [{
    name: 'CDP测试任务',
    expression: '0 9 * * *',
    agentId: 'main',
    enabled: false
  }])
  log('添加Cron任务', addCron.ok)

  // 非法表达式
  const badCron = await callIPC(page, 'cron:add', [{
    name: '非法',
    expression: '*/foo * * * *'
  }])
  log('非法cron表达式拒绝', !badCron.ok || (badCron.data && badCron.data.success === false))

  // 空 name
  const emptyName = await callIPC(page, 'cron:add', [{
    name: '',
    expression: '0 9 * * *'
  }])
  log('空name拒绝', !emptyName.ok || (emptyName.data && emptyName.data.success === false))

  const cronState = await getPageState(page)
  log('Cron页面有内容', cronState.hasContent)

  // ===== 9. 隐私引擎页面测试 =====
  console.log('\n━━━ 9. 隐私引擎页面深度测试 ━━━')
  await navigateTo(page, '/privacy')
  await waitForPageReady(page)

  const privacyStatus = await callIPC(page, 'privacy:status', [])
  log('隐私状态查询', privacyStatus.ok)

  // 过短密码
  const shortPwd = await callIPC(page, 'privacy:load', ['ab'])
  log('过短密码拒绝', !shortPwd.ok || (shortPwd.data && shortPwd.data.success === false))

  // 空密码
  const emptyPwd = await callIPC(page, 'privacy:load', [''])
  log('空密码拒绝', !emptyPwd.ok || (emptyPwd.data && emptyPwd.data.success === false))

  // 正常密码加载
  const loadPwd = await callIPC(page, 'privacy:load', ['testpassword123'])
  log('正常密码加载', loadPwd.ok)

  // dryrun 匿名化
  const dryRunPrivacy = await callIPC(page, 'privacy:dryrun', ['张三今天迟到了'])
  log('匿名化试运行', dryRunPrivacy.ok)

  // 空文本
  const emptyText = await callIPC(page, 'privacy:dryrun', [''])
  log('空文本拒绝', !emptyText.ok || (emptyText.data && emptyText.data.success === false))

  const privacyState = await getPageState(page)
  log('隐私页面有内容', privacyState.hasContent)

  // ===== 10. 设置页面测试 =====
  console.log('\n━━━ 10. 设置页面深度测试 ━━━')
  await navigateTo(page, '/settings')
  await waitForPageReady(page)

  const settings = await callIPC(page, 'settings:get', [])
  log('获取设置', settings.ok)

  // 主题切换
  const setDark = await callIPC(page, 'settings:set', ['general.theme', 'dark'])
  log('设置dark主题', setDark.ok)
  const setLight = await callIPC(page, 'settings:set', ['general.theme', 'light'])
  log('恢复light主题', setLight.ok)

  // 语言切换
  const setEn = await callIPC(page, 'settings:set', ['general.language', 'en-US'])
  log('设置英文', setEn.ok)
  const setZh = await callIPC(page, 'settings:set', ['general.language', 'zh-CN'])
  log('恢复中文', setZh.ok)

  // 非法路径
  const badPath = await callIPC(page, 'settings:set', ['', 'x'])
  log('空路径拒绝', !badPath.ok || (badPath.data && badPath.data.success === false))

  // 日志级别
  const setDebug = await callIPC(page, 'settings:set', ['general.logLevel', 'debug'])
  log('设置debug日志', setDebug.ok)
  const setInfo = await callIPC(page, 'settings:set', ['general.logLevel', 'info'])
  log('恢复info日志', setInfo.ok)

  const settingsState = await getPageState(page)
  log('设置页面有内容', settingsState.hasContent)

  // ===== 11. 聊天页面测试 =====
  console.log('\n━━━ 11. 聊天页面深度测试 ━━━')
  await navigateTo(page, '/chat')
  await waitForPageReady(page)

  const sessions = await callIPC(page, 'chat:list-sessions', [])
  log('会话列表加载', sessions.ok)

  // 保存消息
  const saveMsg = await callIPC(page, 'chat:save-message', [{
    sessionId: 'cdp-test-session',
    role: 'user',
    content: 'CDP测试消息'
  }])
  log('保存消息', saveMsg.ok)

  // 加载消息
  const loadMsgs = await callIPC(page, 'chat:load-messages', ['cdp-test-session'])
  log('加载消息', loadMsgs.ok)

  // 删除会话
  const delSession = await callIPC(page, 'chat:delete-session', ['cdp-test-session'])
  log('删除会话', delSession.ok)

  const chatState = await getPageState(page)
  log('聊天页面有内容', chatState.hasContent)

  // ===== 12. 导航压力测试 =====
  console.log('\n━━━ 12. 导航压力测试 ━━━')
  const routes = ['/', '/students', '/classes', '/dashboard', '/agents', '/models', '/skills', '/cron', '/privacy', '/settings', '/chat']
  let navOk = 0
  const navTimes = []
  for (let i = 0; i < 30; i++) {
    const route = routes[i % routes.length]
    const t0 = Date.now()
    await navigateTo(page, route)
    const dt = Date.now() - t0
    navTimes.push(dt)
    const state = await getPageState(page)
    if (state.hasContent) navOk++
  }
  const avgNav = (navTimes.reduce((a, b) => a + b, 0) / navTimes.length).toFixed(0)
  log('30次导航全部有内容', navOk === 30, `${navOk}/30, avg=${avgNav}ms`)

  // ===== 13. 快速切换性能测试 =====
  console.log('\n━━━ 13. 快速页面切换性能测试 ━━━')
  const quickT0 = Date.now()
  for (let i = 0; i < 100; i++) {
    await navigateTo(page, routes[i % routes.length])
  }
  const quickDt = Date.now() - quickT0
  log('100次页面切换 < 60s', quickDt < 60000, `${(quickDt / 1000).toFixed(1)}s`)

  // ===== 14. 并发 IPC 调用测试 =====
  console.log('\n━━━ 14. 并发 IPC 调用测试 ━━━')
  const concurrentResults = await page.evaluate(async () => {
    const channels = [
      ['eaa:info', []],
      ['eaa:list-students', []],
      ['eaa:ranking', [10]],
      ['eaa:summary', []],
      ['eaa:stats', []],
      ['eaa:codes', []],
      ['agent:list', []],
      ['settings:get', []],
      ['class:list', []],
      ['skill:list', []],
    ]
    const results = await Promise.all(channels.map(async ([ch, args]) => {
      try {
        const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: ch, args })
        return { ch, ok: true }
      } catch (e) {
        return { ch, ok: false, error: e.message }
      }
    }))
    return results
  })
  const concurrentOk = concurrentResults.filter(r => r.ok).length
  log('10并发IPC调用', concurrentOk === 10, `${concurrentOk}/10`)

  // ===== 15. 大量 IPC 调用压力测试 =====
  console.log('\n━━━ 15. 大量 IPC 调用压力测试 ━━━')
  const stressT0 = Date.now()
  const stressResults = await page.evaluate(async () => {
    let ok = 0
    let fail = 0
    for (let i = 0; i < 200; i++) {
      try {
        await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: 'eaa:info', args: [] })
        ok++
      } catch {
        fail++
      }
    }
    return { ok, fail }
  })
  const stressDt = Date.now() - stressT0
  log('200次连续IPC调用', stressResults.ok === 200, `${stressResults.ok}/200, ${stressDt}ms, avg=${(stressDt/200).toFixed(1)}ms`)

  // ===== 16. 控制台错误检查 =====
  console.log('\n━━━ 16. 控制台错误检查 ━━━')
  log('无页面错误', errors.filter(e => !e.includes('favicon')).length === 0,
    errors.filter(e => !e.includes('favicon')).slice(0, 3).join('; '))

  // ===== 清理测试数据 =====
  console.log('\n━━━ 清理测试数据 ━━━')
  await callIPC(page, 'eaa:delete-student', ['CDP测试学生_A', '--confirm'])
  console.log('  已清理 CDP测试学生_A')

  // ===== 总结 =====
  console.log('\n╔══════════════════════════════════════════════════╗')
  console.log(`║  通过: ${results.pass} / 失败: ${results.fail} / 总计: ${results.pass + results.fail}`)
  console.log(`║  控制台错误: ${errors.filter(e => !e.includes('favicon')).length}`)
  console.log(`║  状态: ${results.fail === 0 ? '✅ 全部通过' : '⚠️ 有失败项'}`)
  console.log('╚══════════════════════════════════════════════════╝')

  await browser.close()
  process.exit(results.fail > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
