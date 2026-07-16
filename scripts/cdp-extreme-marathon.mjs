#!/usr/bin/env node
// =============================================================
// CDP 大数据量极限+性能马拉松 (Electron window.api.eaa.* 版本)
//
// 阶段:
//   A. 单学生极限: 连续加 500 → 1000 → 2000 事件, 直至失败或太慢
//      事件类型丰富: 含扣分/加分/作业/考试/常规行为等
//   B. 单学生查询性能: history/score 随事件数增长
//   C. 班级批量常见: 30-40 学生 × 50-200 事件
//   D. 班级极端: 单班 20 学生 × 500 事件
//   E. 整体性能: ranking/summary/stats/list-students 耗时
//   F. 瓶颈分析: 定位慢的具体环节
// =============================================================
import { chromium } from 'playwright'
import { appendFileSync } from 'node:fs'

const CDP_URL = 'http://127.0.0.1:9222'
const LOG_FILE = 'test-results/extreme-marathon.log'

// 即时写文件+控制台(避免 stdout 块缓冲丢失日志)
function out(msg) {
  process.stdout.write(msg + '\n')
  appendFileSync(LOG_FILE, msg + '\n')
}

// 丰富事件类型: 含扣分/加分/作业/考试/常规
const REASON_CODES = [
  'SPEAK_IN_CLASS', 'SLEEP_IN_CLASS', 'LATE', 'SCHOOL_CAUGHT',
  'MAKEUP', 'DESK_UNALIGNED', 'PHONE_IN_CLASS', 'SMOKING',
  'DRINKING_DORM', 'OTHER_DEDUCT', 'APPEARANCE_VIOLATION',
  'ACTIVITY_PARTICIPATION', 'CLASS_MONITOR', 'CLASS_COMMITTEE',
  'CIVILIZED_DORM', 'MONTHLY_ATTENDANCE',
]

const results = { pass: 0, fail: 0, details: [] }
function log(name, ok, detail = '') {
  results.details.push({ name, ok, detail })
  if (ok) { results.pass++; out(`  ✓ ${name} ${detail}`) }
  else { results.fail++; out(`  ✗ ${name} ${detail}`) }
}

// 通过 window.api.eaa.* 调用 (Electron 模式), 计时
async function callEaa(page, method, ...args) {
  return await page.evaluate(async ({ m, a }) => {
    const t0 = performance.now()
    try {
      const r = await window.api.eaa[m](...a)
      const t1 = performance.now()
      return { ok: true, data: r, ms: t1 - t0 }
    } catch (e) {
      const t1 = performance.now()
      return { ok: false, error: e?.message || String(e), ms: t1 - t0 }
    }
  }, { m: method, a: args })
}

// 通过 window.api.class.* 调用
async function callClass(page, method, ...args) {
  return await page.evaluate(async ({ m, a }) => {
    const t0 = performance.now()
    try {
      const r = await window.api.class[m](...a)
      const t1 = performance.now()
      return { ok: true, data: r, ms: t1 - t0 }
    } catch (e) {
      const t1 = performance.now()
      return { ok: false, error: e?.message || String(e), ms: t1 - t0 }
    }
  }, { m: method, a: args })
}

async function main() {
  const stamp = Date.now()
  out('╔══════════════════════════════════════════════════╗')
  out('║  大数据量极限+性能马拉松 — Electron window.api    ║')
  out(`║  开始时间: ${new Date().toISOString()}`)
  out('╚══════════════════════════════════════════════════╝\n')

  const browser = await chromium.connectOverCDP(CDP_URL)
  const page = browser.contexts()[0].pages()[0]
  out(`页面: ${page.url()}\n`)

  // 先看当前数据规模
  const info0 = await callEaa(page, 'info')
  out(`初始数据: ${JSON.stringify(info0.data?.data || info0.data)}\n`)

  // ============================================================
  // 阶段 A: 单学生极限测试 — 500 → 1000 → 2000
  // ============================================================
  out('━━━ 阶段 A: 单学生极限测试 ━━━')
  const limitStudent = `Limit_${stamp}`
  const addStu = await callEaa(page, 'addStudent', limitStudent)
  log('创建极限测试学生', addStu.ok && addStu.data?.success !== false, `${limitStudent} ${addStu.ms.toFixed(0)}ms`)

  // 阶段 A1: 0 → 500
  const LIMITS = [500, 1000, 2000]
  let cumulative = 0
  const writeTimings = []

  for (const target of LIMITS) {
    const need = target - cumulative
    if (need <= 0) continue
    out(`\n  ─ 加到 ${target} 事件 (再+${need}) ─`)
    let failCount = 0
    const segStart = Date.now()
    for (let i = 0; i < need; i++) {
      const code = REASON_CODES[(cumulative + i) % REASON_CODES.length]
      const r = await callEaa(page, 'addEvent', {
        studentName: limitStudent,
        reasonCode: code,
        force: true,
        note: `极限事件#${cumulative + i + 1} ${code}`,
      })
      writeTimings.push(r.ms)
      if (!r.ok || r.data?.success === false) failCount++
      if ((i + 1) % 100 === 0) {
        const recent = writeTimings.slice(-100)
        const avg = recent.reduce((s, t) => s + t, 0) / recent.length
        const max = Math.max(...recent)
        out(`    事件 ${cumulative + i + 1}/${target}: avg=${avg.toFixed(0)}ms max=${max.toFixed(0)}ms 失败=${failCount}`)
      }
      // 2000 事件后若 avg > 2000ms 提前终止
      if (writeTimings.length > 10) {
        const last10 = writeTimings.slice(-10)
        const avg10 = last10.reduce((s, t) => s + t, 0) / 10
        if (avg10 > 3000) {
          out(`    ⚠ avg=${avg10.toFixed(0)}ms > 3000ms, 提前终止`)
          failCount = -1
          break
        }
      }
    }
    cumulative = target
    const segElapsed = ((Date.now() - segStart) / 1000).toFixed(1)
    if (failCount === -1) {
      log(`阶段 A ${target} 事件`, false, `提前终止 avg>3000ms 耗时=${segElapsed}s`)
      break
    }
    log(`阶段 A ${target} 事件`, failCount === 0, `失败=${failCount} 耗时=${segElapsed}s`)

    // 每阶段查一次性能
    const histR = await callEaa(page, 'history', limitStudent)
    const histCount = histR.data?.data?.events?.length || 0
    log(`  ${target}事件 history 查询`, histR.ok, `${histR.ms.toFixed(0)}ms 返回${histCount}条`)
  }

  // 写入趋势分析
  if (writeTimings.length >= 100) {
    const first50 = writeTimings.slice(0, 50).reduce((s, t) => s + t, 0) / 50
    const last50 = writeTimings.slice(-50).reduce((s, t) => s + t, 0) / 50
    out(`  写入趋势: 首50=${first50.toFixed(0)}ms → 末50=${last50.toFixed(0)}ms (增长${(last50 / first50).toFixed(1)}x)`)
  }

  // ============================================================
  // 阶段 B: 单学生查询性能(极限事件数下)
  // ============================================================
  out('\n━━━ 阶段 B: 单学生查询性能 ━━━')
  const histR = await callEaa(page, 'history', limitStudent)
  const histCount = histR.data?.data?.events?.length || 0
  log('history 查询(极限学生)', histR.ok, `${histR.ms.toFixed(0)}ms 返回${histCount}条`)

  const histR2 = await callEaa(page, 'history', limitStudent)
  log('history 二次(缓存)', histR2.ok, `${histR2.ms.toFixed(0)}ms (首次=${histR.ms.toFixed(0)}ms)`)

  const scoreR = await callEaa(page, 'score', limitStudent)
  log('score 查询', scoreR.ok, `${scoreR.ms.toFixed(0)}ms score=${scoreR.data?.data?.score}`)

  const rankR = await callEaa(page, 'ranking', 50)
  log('ranking(50)', rankR.ok, `${rankR.ms.toFixed(0)}ms`)

  // ============================================================
  // 阶段 C: 班级批量常见情况 — 30 学生 × 50-200 事件
  // ============================================================
  out('\n━━━ 阶段 C: 班级批量常见情况 ━━━')
  const phaseCStart = Date.now()
  const classId = `Common${stamp}`
  const cR = await callClass(page, 'create', { class_id: classId, name: `常见批量_${classId}`, grade: '八年级' })
  log(`创建班级 ${classId}`, cR.ok && cR.data?.success !== false, `${cR.ms.toFixed(0)}ms`)

  const cStudents = []
  let cCreateFail = 0
  for (let i = 0; i < 30; i++) {
    const name = `常见学生${String(i + 1).padStart(3, '0')}_${stamp}`
    const r = await callEaa(page, 'addStudent', name)
    if (r.ok && r.data?.success !== false) cStudents.push(name)
    else cCreateFail++
  }
  log('创建 30 学生', cCreateFail === 0, `失败=${cCreateFail}`)

  // 分配到班级(批量)
  const assignR = await callClass(page, 'assign', { class_id: classId, student_names: cStudents })
  log('批量调班', assignR.ok, `assigned=${assignR.data?.assigned} failed=${assignR.data?.failed?.length || 0} ${assignR.ms.toFixed(0)}ms`)

  // 每人 50-200 事件
  let cEvents = 0, cFail = 0
  const cTimings = []
  for (let si = 0; si < cStudents.length; si++) {
    const name = cStudents[si]
    const count = 50 + Math.floor(Math.random() * 151) // 50-200
    for (let ei = 0; ei < count; ei++) {
      const code = REASON_CODES[ei % REASON_CODES.length]
      const r = await callEaa(page, 'addEvent', {
        studentName: name, reasonCode: code, force: true,
        note: `学期事件#${ei + 1}`,
      })
      cTimings.push(r.ms)
      if (!r.ok || r.data?.success === false) cFail++
      cEvents++
    }
    if ((si + 1) % 10 === 0) {
      const recent = cTimings.slice(-50)
      const avg = recent.reduce((s, t) => s + t, 0) / recent.length
      out(`    学生 ${si + 1}/${cStudents.length} 累计=${cEvents} avg=${avg.toFixed(0)}ms 失败=${cFail}`)
    }
  }
  log('阶段C 事件录入', cFail === 0, `总事件=${cEvents} 失败=${cFail} 耗时=${((Date.now() - phaseCStart) / 1000).toFixed(1)}s`)

  // 查询性能
  const cRank = await callEaa(page, 'ranking', 30)
  log('阶段C ranking(30)', cRank.ok, `${cRank.ms.toFixed(0)}ms`)

  const cHist = await callEaa(page, 'history', cStudents[0])
  log('阶段C 单学生 history', cHist.ok, `${cHist.ms.toFixed(0)}ms`)

  // ============================================================
  // 阶段 D: 班级极端情况 — 单班 20 学生 × 500 事件
  // ============================================================
  out('\n━━━ 阶段 D: 班级极端情况(20 学生 × 500 事件)━━━')
  const phaseDStart = Date.now()
  const extremeClassId = `Extreme${stamp}`
  const dR = await callClass(page, 'create', { class_id: extremeClassId, name: `极端批量_${extremeClassId}`, grade: '九年级' })
  log(`创建极端班级`, dR.ok && dR.data?.success !== false, `${dR.ms.toFixed(0)}ms`)

  const dStudents = []
  for (let i = 0; i < 20; i++) {
    const name = `极端学生${String(i + 1).padStart(2, '0')}_${stamp}`
    const r = await callEaa(page, 'addStudent', name)
    if (r.ok && r.data?.success !== false) dStudents.push(name)
  }
  log('创建 20 极端学生', dStudents.length === 20, `成功=${dStudents.length}`)

  const dAssign = await callClass(page, 'assign', { class_id: extremeClassId, student_names: dStudents })
  log('极端班级调班', dAssign.ok, `${dAssign.ms.toFixed(0)}ms`)

  let dEvents = 0, dFail = 0
  const dTimings = []
  const EXTREME_PER_STUDENT = 500
  for (let si = 0; si < dStudents.length; si++) {
    const name = dStudents[si]
    for (let ei = 0; ei < EXTREME_PER_STUDENT; ei++) {
      const code = REASON_CODES[ei % REASON_CODES.length]
      const r = await callEaa(page, 'addEvent', {
        studentName: name, reasonCode: code, force: true,
        note: `极端事件#${ei + 1}`,
      })
      dTimings.push(r.ms)
      if (!r.ok || r.data?.success === false) dFail++
      dEvents++
    }
    if ((si + 1) % 5 === 0) {
      const recent = dTimings.slice(-100)
      const avg = recent.reduce((s, t) => s + t, 0) / recent.length
      out(`    极端学生 ${si + 1}/${dStudents.length} 累计=${dEvents} avg=${avg.toFixed(0)}ms 失败=${dFail}`)
    }
  }
  log('阶段D 极端录入', dFail === 0, `总事件=${dEvents} 失败=${dFail} 耗时=${((Date.now() - phaseDStart) / 1000).toFixed(1)}s`)

  // ============================================================
  // 阶段 E: 整体性能(全量数据)
  // ============================================================
  out('\n━━━ 阶段 E: 整体性能 ━━━')
  const infoE = await callEaa(page, 'info')
  out(`  当前总数据: ${JSON.stringify(infoE.data?.data)}`)

  const eRank = await callEaa(page, 'ranking', 100)
  log('ranking 全量(100)', eRank.ok, `${eRank.ms.toFixed(0)}ms`)

  const eRank2 = await callEaa(page, 'ranking', 100)
  log('ranking 二次(缓存)', eRank2.ok, `${eRank2.ms.toFixed(0)}ms (首次=${eRank.ms.toFixed(0)}ms)`)

  const eSum = await callEaa(page, 'summary')
  log('summary 查询', eSum.ok, `${eSum.ms.toFixed(0)}ms`)

  const eStats = await callEaa(page, 'stats')
  log('stats 查询', eStats.ok, `${eStats.ms.toFixed(0)}ms`)

  const eList = await callEaa(page, 'listStudents')
  const eStuCount = eList.data?.data?.students?.length || eList.data?.data?.length || 0
  log('list-students', eList.ok, `${eList.ms.toFixed(0)}ms 返回${eStuCount}学生`)

  // 极端学生 history(应有 500+)
  const eHeavyHist = await callEaa(page, 'history', dStudents[0])
  const eHeavyCount = eHeavyHist.data?.data?.events?.length || 0
  log('极端学生 history(500事件)', eHeavyHist.ok, `${eHeavyHist.ms.toFixed(0)}ms 返回${eHeavyCount}条`)

  // ============================================================
  // 阶段 F: 瓶颈分析
  // ============================================================
  out('\n╔══════════════════════════════════════════════════╗')
  out('║  瓶颈分析报告                                    ║')
  out('╚══════════════════════════════════════════════════╝')
  if (writeTimings.length > 0) {
    const wAvg = writeTimings.reduce((s, t) => s + t, 0) / writeTimings.length
    const wMax = Math.max(...writeTimings)
    out(`  写入: avg=${wAvg.toFixed(0)}ms max=${wMax.toFixed(0)}ms 总=${writeTimings.length}`)
  }
  if (dTimings.length > 0) {
    const dAvg = dTimings.reduce((s, t) => s + t, 0) / dTimings.length
    const dMax = Math.max(...dTimings)
    out(`  极端写入: avg=${dAvg.toFixed(0)}ms max=${dMax.toFixed(0)}ms 总=${dTimings.length}`)
  }
  out(`  查询: history=${histR.ms.toFixed(0)}ms score=${scoreR.ms.toFixed(0)}ms ranking=${eRank.ms.toFixed(0)}ms summary=${eSum.ms.toFixed(0)}ms stats=${eStats.ms.toFixed(0)}ms`)
  out(`  缓存: history ${histR.ms.toFixed(0)}→${histR2.ms.toFixed(0)}ms ranking ${eRank.ms.toFixed(0)}→${eRank2.ms.toFixed(0)}ms`)

  // 瓶颈阈值判断
  const slowQueries = []
  if (eRank.ms > 1000) slowQueries.push(`ranking ${eRank.ms.toFixed(0)}ms (>1000ms)`)
  if (eSum.ms > 800) slowQueries.push(`summary ${eSum.ms.toFixed(0)}ms (>800ms)`)
  if (eHeavyHist.ms > 500) slowQueries.push(`heavy history ${eHeavyHist.ms.toFixed(0)}ms (>500ms)`)
  if (slowQueries.length > 0) {
    out(`\n  ⚠ 慢查询: ${slowQueries.join(', ')}`)
  }

  out(`\n总计: ${results.pass} 通过 / ${results.fail} 失败`)
  await browser.close()
  process.exit(results.fail > 0 ? 1 : 0)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
