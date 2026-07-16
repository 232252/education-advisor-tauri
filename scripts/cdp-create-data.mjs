// =============================================================
// CDP 功能测试 — 通过IPC创建测试数据,验证CRUD功能
// =============================================================

import { chromium } from 'playwright'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const REPORTS_DIR = resolve(ROOT, 'test-results', 'cdp-reports')
if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true })

async function nav(page, path) {
  await page.evaluate((p) => { window.location.hash = p }, path)
  await page.waitForTimeout(2000)
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

async function main() {
  console.log('━━━ CDP 功能测试 — 创建数据 & CRUD ━━━\n')
  console.log(`时间: ${new Date().toISOString()}\n`)

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const context = browser.contexts()[0]
  const page = context.pages()[0]

  const results = []
  let pass = 0, fail = 0
  const ok = (name, detail = '') => { console.log(`  ✓ ${name} ${detail}`); pass++; results.push({ name, status: 'pass', detail }) }
  const bad = (name, err) => { console.log(`  ✗ ${name}: ${err}`); fail++; results.push({ name, status: 'fail', error: err }) }

  // ===== 1. 创建班级 =====
  console.log('\n━━━ 1. 创建班级 ━━━')
  const testClasses = [
    { class_id: 'class-a', name: '三年级一班', grade: '三年级', teacher: '张老师', note: '测试班级A' },
    { class_id: 'class-b', name: '三年级二班', grade: '三年级', teacher: '李老师', note: '测试班级B' },
  ]
  for (const cls of testClasses) {
    const r = await callIPC(page, 'class:create', [cls])
    if (r.ok && r.data?.success !== false) ok(`创建班级 ${cls.name}`, `→ ${JSON.stringify(r.data).slice(0, 80)}`)
    else bad(`创建班级 ${cls.name}`, r.error || JSON.stringify(r.data))
  }

  // 验证班级列表
  const classList = await callIPC(page, 'class:list', [])
  if (classList.ok) {
    const classes = classList.data?.data || []
    ok(`班级列表`, `→ ${classes.length} 个班级`)
  } else {
    bad('班级列表', classList.error)
  }

  // ===== 2. 创建学生 =====
  console.log('\n━━━ 2. 创建学生 (通过 EAA CLI) ━━━')
  const testStudents = ['张三', '李四', '王五', '赵六', '钱七', '孙八', '周九', '吴十']
  for (const name of testStudents) {
    const r = await callIPC(page, 'eaa:add-student', [name])
    if (r.ok && r.data?.success !== false) ok(`创建学生 ${name}`, `→ ${JSON.stringify(r.data).slice(0, 80)}`)
    else bad(`创建学生 ${name}`, r.error || JSON.stringify(r.data)?.slice(0, 100))
  }

  // 验证学生列表
  const studentList = await callIPC(page, 'eaa:list-students', [])
  if (studentList.ok) {
    const students = studentList.data?.data?.students || []
    ok(`学生列表`, `→ ${students.length} 个学生`)
  } else {
    bad('学生列表', studentList.error)
  }

  // ===== 3. 给学生添加事件 =====
  console.log('\n━━━ 3. 添加学生事件 ━━━')
  // AddEventParams: { studentName, reasonCode, delta?, note?, operator?, dryRun?, force?, tags? }
  // reason codes from config/reason-codes.json (UPPERCASE keys)
  const events = [
    { studentName: '张三', reasonCode: 'ACTIVITY_PARTICIPATION', note: '课堂积极发言' },
    { studentName: '张三', reasonCode: 'CLASS_COMMITTEE', note: '作业完成优秀' },
    { studentName: '李四', reasonCode: 'LATE', note: '迟到' },
    { studentName: '王五', reasonCode: 'CIVILIZED_DORM', note: '帮助同学' },
    { studentName: '赵六', reasonCode: 'SPEAK_IN_CLASS', note: '课堂违纪' },
  ]
  for (const ev of events) {
    const r = await callIPC(page, 'eaa:add-event', [ev])
    if (r.ok && r.data?.success !== false) ok(`事件 ${ev.studentName}: ${ev.note}`, `→ ${r.data?.success || 'ok'}`)
    else bad(`事件 ${ev.studentName}: ${ev.note}`, r.error || JSON.stringify(r.data)?.slice(0, 100))
  }

  // ===== 4. 查询学生分数 =====
  console.log('\n━━━ 4. 查询学生分数 ━━━')
  for (const name of ['张三', '李四', '王五']) {
    const r = await callIPC(page, 'eaa:score', [name])
    if (r.ok) ok(`分数 ${name}`, `→ ${JSON.stringify(r.data).slice(0, 100)}`)
    else bad(`分数 ${name}`, r.error)
  }

  // ===== 5. 查询排行榜 =====
  console.log('\n━━━ 5. 查询排行榜 ━━━')
  const rankR = await callIPC(page, 'eaa:ranking', [10])
  if (rankR.ok) ok('排行榜', `→ ${JSON.stringify(rankR.data).slice(0, 150)}`)
  else bad('排行榜', rankR.error)

  // ===== 6. 分配学生到班级 =====
  console.log('\n━━━ 6. 分配学生到班级 ━━━')
  const assignR = await callIPC(page, 'class:assign', [{ class_id: 'class-a', student_names: ['张三', '李四', '王五'] }])
  if (assignR.ok) ok('分配学生到班级A', `→ ${JSON.stringify(assignR.data).slice(0, 100)}`)
  else bad('分配学生到班级A', assignR.error)

  const assignR2 = await callIPC(page, 'class:assign', [{ class_id: 'class-b', student_names: ['赵六', '钱七'] }])
  if (assignR2.ok) ok('分配学生到班级B', `→ ${JSON.stringify(assignR2.data).slice(0, 100)}`)
  else bad('分配学生到班级B', assignR2.error)

  // ===== 7. 切换页面验证UI更新 =====
  console.log('\n━━━ 7. 页面UI更新验证 ━━━')
  await nav(page, '/students')
  await page.waitForTimeout(2000)
  const studentsDom = await page.evaluate(() => ({
    tableRows: document.querySelectorAll('tbody tr').length,
    h1: document.querySelector('h1')?.innerText || '',
    bodyText: document.body.innerText.slice(0, 500),
  }))
  if (studentsDom.tableRows > 0) ok(`学生页面表格 ${studentsDom.tableRows} 行`)
  else bad('学生页面表格', `0 行, h1=${studentsDom.h1}`)
  console.log(`  h1: ${studentsDom.h1}`)

  await nav(page, '/classes')
  await page.waitForTimeout(1500)
  const classesDom = await page.evaluate(() => ({
    tableRows: document.querySelectorAll('tbody tr').length,
    bodyText: document.body.innerText.slice(0, 500),
  }))
  if (classesDom.tableRows > 0) ok(`班级页面表格 ${classesDom.tableRows} 行`)
  else bad('班级页面表格', `0 行`)

  await nav(page, '/dashboard')
  await page.waitForTimeout(2000)
  const dashDom = await page.evaluate(() => ({
    bodyText: document.body.innerText.slice(0, 1000),
    canvasCount: document.querySelectorAll('canvas').length,
  }))
  // 检查仪表盘是否显示了学生数据
  if (dashDom.bodyText.includes('学生总数')) {
    const match = dashDom.bodyText.match(/学生总数[\s\S]*?(\d+)/)
    const count = match ? match[1] : '?'
    ok(`仪表盘学生总数`, `→ ${count}`)
  } else {
    bad('仪表盘学生总数', '未找到')
  }

  // ===== 8. 更新班级 =====
  console.log('\n━━━ 8. 更新班级 ━━━')
  // 需要用数据库 id (不是 class_id) 来更新
  const classListForId = await callIPC(page, 'class:list', [])
  const classesData = classListForId.ok ? (classListForId.data?.data || []) : []
  const classA = classesData.find((c) => c.class_id === 'class-a')
  if (classA) {
    const updateR = await callIPC(page, 'class:update', [classA.id, { name: '三年级一班(更新)', teacher: '王老师' }])
    if (updateR.ok && updateR.data?.success !== false) ok('更新班级', `→ ${JSON.stringify(updateR.data).slice(0, 80)}`)
    else bad('更新班级', updateR.error || JSON.stringify(updateR.data))
  } else {
    bad('更新班级', '未找到 class-a')
  }

  // ===== 9. 删除事件(撤销) =====
  console.log('\n━━━ 9. 撤销事件 ━━━')
  const eventsR = await callIPC(page, 'eaa:history', ['张三'])
  if (eventsR.ok) {
    ok('查询张三历史', `→ ${JSON.stringify(eventsR.data).slice(0, 150)}`)
  } else {
    bad('查询张三历史', eventsR.error)
  }

  // ===== 10. 设置变更 =====
  console.log('\n━━━ 10. 设置变更 ━━━')
  const themeR = await callIPC(page, 'settings:set', ['general.theme', 'light'])
  if (themeR.ok) ok('切换主题到light')
  else bad('切换主题', themeR.error)

  const langR = await callIPC(page, 'settings:set', ['general.language', 'en-US'])
  if (langR.ok) ok('切换语言到en-US')
  else bad('切换语言', langR.error)

  // 还原
  await callIPC(page, 'settings:set', ['general.theme', 'dark'])
  await callIPC(page, 'settings:set', ['general.language', 'zh-CN'])
  ok('还原设置')

  // ===== 总结 =====
  console.log(`\n━━━ 总结: ${pass} 通过 / ${fail} 失败 (共 ${pass + fail}) ━━━`)

  const report = {
    timestamp: new Date().toISOString(),
    summary: { pass, fail },
    results,
  }
  const reportPath = resolve(REPORTS_DIR, `cdp-create-data-${Date.now()}.json`)
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`报告: ${reportPath}`)

  await browser.close()
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(2)
})
