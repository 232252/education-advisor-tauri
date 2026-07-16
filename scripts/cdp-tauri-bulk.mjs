// =============================================================
// CDP Tauri 大数据量极限测试 — 录入 100 学生 + 单学生极限 + 性能瓶颈分析
//
// 阶段:
//   A. 单学生极限:连续加 500 事件(--force),测量写入耗时趋势
//   B. 单学生查询性能:history/score/ranking 耗时随事件数增长
//   C. 批量录入:100 学生 × 3 班级,每人 10-200 事件
//   D. 整体性能:排行榜/摘要/统计在全量数据下的耗时
// =============================================================
import { chromium } from 'playwright'

const CDP_URL = 'http://localhost:9222'

// EAA reasonCode 列表(16 个常用,不含 REVERT/BONUS_VARIABLE)
const REASON_CODES = [
  'SPEAK_IN_CLASS', 'SLEEP_IN_CLASS', 'LATE', 'SCHOOL_CAUGHT',
  'MAKEUP', 'DESK_UNALIGNED', 'PHONE_IN_CLASS', 'SMOKING',
  'DRINKING_DORM', 'OTHER_DEDUCT', 'APPEARANCE_VIOLATION',
  'ACTIVITY_PARTICIPATION', 'CLASS_MONITOR', 'CLASS_COMMITTEE',
  'CIVILIZED_DORM', 'MONTHLY_ATTENDANCE',
]

async function connect() {
  const browser = await chromium.connectOverCDP(CDP_URL)
  const contexts = browser.contexts()
  const pages = contexts[0].pages()
  return { browser, page: pages[0] }
}

// 带耗时测量的 IPC 调用(ms 在 WebView2 内测量,反映用户感知)
async function callApiTimed(page, channel, ...args) {
  return await page.evaluate(async ({ ch, ag }) => {
    const t0 = performance.now()
    try {
      const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: ch, args: ag })
      const t1 = performance.now()
      return { ok: true, data: r, ms: t1 - t0 }
    } catch (e) {
      const t1 = performance.now()
      return { ok: false, error: e?.message || String(e), ms: t1 - t0 }
    }
  }, { ch: channel, ag: args })
}

const results = { pass: 0, fail: 0, details: [] }
function log(name, ok, detail = '') {
  results.details.push({ name, ok, detail })
  if (ok) { results.pass++; console.log(`  ✓ ${name} ${detail}`) }
  else { results.fail++; console.log(`  ✗ ${name} ${detail}`) }
}

async function main() {
  const { browser, page } = await connect()
  const stamp = Date.now()

  console.log('╔══════════════════════════════════════════════════╗')
  console.log('║  CDP Tauri 大数据量极限测试 — 录入+性能瓶颈分析    ║')
  console.log('╚══════════════════════════════════════════════════╝\n')

  // ============================================================
  // 阶段 A: 单学生极限测试 — 连续加 500 事件
  // ============================================================
  console.log('━━━ 阶段 A: 单学生极限测试(500 事件)━━━')
  const limitStudent = `Bulk_Limit_${stamp}`
  const addStu = await callApiTimed(page, 'eaa:add-student', limitStudent)
  log('创建极限测试学生', addStu.ok && addStu.data?.success !== false, `${limitStudent} ${addStu.ms.toFixed(0)}ms`)

  const LIMIT = 500
  const writeTimings = []
  let failCount = 0
  const phaseAStart = Date.now()

  for (let i = 0; i < LIMIT; i++) {
    const code = REASON_CODES[i % REASON_CODES.length]
    const r = await callApiTimed(page, 'eaa:add-event', {
      studentName: limitStudent,
      reasonCode: code,
      force: true,
      note: `极限事件#${i + 1}`,
    })
    writeTimings.push(r.ms)
    if (!r.ok || r.data?.success === false) failCount++

    // 每 50 次采样输出
    if ((i + 1) % 50 === 0) {
      const recent = writeTimings.slice(-50)
      const avg = recent.reduce((s, t) => s + t, 0) / recent.length
      const max = Math.max(...recent)
      const min = Math.min(...recent)
      console.log(`  事件 ${String(i + 1).padStart(3)}/${LIMIT}: avg=${avg.toFixed(0)}ms min=${min.toFixed(0)}ms max=${max.toFixed(0)}ms 失败=${failCount}`)
    }
  }
  const phaseAElapsed = ((Date.now() - phaseAStart) / 1000).toFixed(1)
  const totalAvg = writeTimings.reduce((s, t) => s + t, 0) / writeTimings.length
  log(`500 事件写入完成`, failCount === 0, `总耗时=${phaseAElapsed}s 平均=${totalAvg.toFixed(0)}ms 失败=${failCount}`)

  // 写入耗时趋势分析(首 50 vs 末 50)
  const first50 = writeTimings.slice(0, 50).reduce((s, t) => s + t, 0) / 50
  const last50 = writeTimings.slice(-50).reduce((s, t) => s + t, 0) / 50
  console.log(`  写入耗时趋势: 首50=${first50.toFixed(0)}ms → 末50=${last50.toFixed(0)}ms (增长${(last50 / first50).toFixed(1)}x)`)

  // ============================================================
  // 阶段 B: 单学生查询性能(500 事件时)
  // ============================================================
  console.log('\n━━━ 阶段 B: 单学生查询性能(500 事件)━━━')

  // history 查询(返回所有事件,最重)
  const histR = await callApiTimed(page, 'eaa:history', limitStudent)
  const histCount = histR.data?.data?.events?.length || histR.data?.data?.length || 0
  log('history 查询(500事件)', histR.ok, `${histR.ms.toFixed(0)}ms 返回${histCount}条`)

  // score 查询
  const scoreR = await callApiTimed(page, 'eaa:score', limitStudent)
  const score = scoreR.data?.data?.score
  log('score 查询', scoreR.ok, `${scoreR.ms.toFixed(0)}ms score=${score}`)

  // 再查一次 history(看缓存效果)
  const histR2 = await callApiTimed(page, 'eaa:history', limitStudent)
  log('history 二次查询(缓存)', histR2.ok, `${histR2.ms.toFixed(0)}ms (首次=${histR.ms.toFixed(0)}ms)`)

  // ranking 查询
  const rankR = await callApiTimed(page, 'eaa:ranking', 100)
  log('ranking 查询(100)', rankR.ok, `${rankR.ms.toFixed(0)}ms`)

  // ============================================================
  // 阶段 C: 批量录入 100 学生 × 3 班级
  // ============================================================
  console.log('\n━━━ 阶段 C: 批量录入 100 学生 × 3 班级 ━━━')
  const phaseCStart = Date.now()

  // 创建 3 班级(class_id 只允许字母数字.-, 不能用中文/下划线)
  const classNames = [`BulkA${stamp}`, `BulkB${stamp}`, `BulkC${stamp}`]
  for (const cn of classNames) {
    const r = await callApiTimed(page, 'class:create', {
      class_id: cn, name: `批量班级_${cn}`, grade: '七年级',
    })
    log(`创建班级 ${cn}`, r.ok && r.data?.success !== false, `${r.ms.toFixed(0)}ms ${r.data?.error || ''}`)
  }

  // 创建 100 学生并分配到班级
  const students = []
  let createFail = 0
  for (let i = 0; i < 100; i++) {
    const cls = classNames[i % 3]
    const name = `学生${String(i + 1).padStart(3, '0')}_${stamp}`
    const r = await callApiTimed(page, 'eaa:add-student', name)
    if (r.ok && r.data?.success !== false) {
      students.push({ name, class: cls })
    } else {
      createFail++
    }
    if ((i + 1) % 25 === 0) {
      console.log(`  创建学生 ${i + 1}/100 失败=${createFail}`)
    }
  }
  log('创建 100 学生', createFail === 0, `失败=${createFail} 耗时=${((Date.now() - phaseCStart) / 1000).toFixed(1)}s`)

  // 给每个学生添加随机数量事件(10-200)
  // 为控制总耗时,事件数按区间分布:50%学生10-30件,30%学生50-80件,15%学生100-150件,5%学生180-200件
  const eventTimings = []
  let eventFail = 0
  let totalEvents = 0
  for (let si = 0; si < students.length; si++) {
    const stu = students[si]
    const rand = Math.random()
    let count
    if (rand < 0.5) count = 10 + Math.floor(Math.random() * 21)        // 10-30
    else if (rand < 0.8) count = 50 + Math.floor(Math.random() * 31)   // 50-80
    else if (rand < 0.95) count = 100 + Math.floor(Math.random() * 51) // 100-150
    else count = 180 + Math.floor(Math.random() * 21)                  // 180-200

    for (let ei = 0; ei < count; ei++) {
      const code = REASON_CODES[ei % REASON_CODES.length]
      const r = await callApiTimed(page, 'eaa:add-event', {
        studentName: stu.name,
        reasonCode: code,
        force: true,
        note: `学期事件#${ei + 1}`,
      })
      eventTimings.push(r.ms)
      if (!r.ok || r.data?.success === false) eventFail++
      totalEvents++
    }
    if ((si + 1) % 10 === 0) {
      const recent = eventTimings.slice(-100)
      const avg = recent.reduce((s, t) => s + t, 0) / recent.length
      console.log(`  学生 ${si + 1}/${students.length} 累计事件=${totalEvents} 失败=${eventFail} 近100avg=${avg.toFixed(0)}ms`)
    }
  }
  const phaseCElapsed = ((Date.now() - phaseCStart) / 1000).toFixed(1)
  const evtAvg = eventTimings.length ? eventTimings.reduce((s, t) => s + t, 0) / eventTimings.length : 0
  log('批量录入事件完成', eventFail === 0, `总事件=${totalEvents} 失败=${eventFail} 耗时=${phaseCElapsed}s avg=${evtAvg.toFixed(0)}ms`)

  // ============================================================
  // 阶段 D: 整体性能测试(全量数据下)
  // ============================================================
  console.log('\n━━━ 阶段 D: 整体性能测试(100 学生+全量事件)━━━')

  // ranking 查询(全量,最重)
  const rankAll = await callApiTimed(page, 'eaa:ranking', 100)
  log('ranking 全量(100)', rankAll.ok, `${rankAll.ms.toFixed(0)}ms`)

  // summary 查询
  const sumR = await callApiTimed(page, 'eaa:summary')
  log('summary 查询', sumR.ok, `${sumR.ms.toFixed(0)}ms`)

  // stats 查询
  const statsR = await callApiTimed(page, 'eaa:stats')
  log('stats 查询', statsR.ok, `${statsR.ms.toFixed(0)}ms`)

  // list-students 查询
  const listR = await callApiTimed(page, 'eaa:list-students')
  const stuCount = listR.data?.data?.length || listR.data?.data?.students?.length || 0
  log('list-students 查询', listR.ok, `${listR.ms.toFixed(0)}ms 返回${stuCount}学生`)

  // 查一个事件最多的学生的 history(找最大事件数学生)
  // 用第一个学生和极限学生对比
  const heavyHist = await callApiTimed(page, 'eaa:history', limitStudent)
  log('重学生 history(500事件)', heavyHist.ok, `${heavyHist.ms.toFixed(0)}ms`)

  const lightHist = await callApiTimed(page, 'eaa:history', students[0]?.name || limitStudent)
  log('轻学生 history', lightHist.ok, `${lightHist.ms.toFixed(0)}ms`)

  // 二次 ranking(缓存效果)
  const rankAll2 = await callApiTimed(page, 'eaa:ranking', 100)
  log('ranking 二次(缓存)', rankAll2.ok, `${rankAll2.ms.toFixed(0)}ms (首次=${rankAll.ms.toFixed(0)}ms)`)

  // ============================================================
  // 瓶颈分析报告
  // ============================================================
  console.log('\n╔══════════════════════════════════════════════════╗')
  console.log('║  瓶颈分析报告                                     ║')
  console.log('╚══════════════════════════════════════════════════╝')
  console.log(`写入耗时: 首50=${first50.toFixed(0)}ms → 末50=${last50.toFixed(0)}ms (增长${(last50 / first50).toFixed(1)}x)`)
  console.log(`批量写入: 总事件=${totalEvents} avg=${evtAvg.toFixed(0)}ms/次`)
  console.log(`重查询: history(500事件)=${histR.ms.toFixed(0)}ms ranking(全量)=${rankAll.ms.toFixed(0)}ms`)
  console.log(`缓存效果: history ${histR.ms.toFixed(0)}→${histR2.ms.toFixed(0)}ms ranking ${rankAll.ms.toFixed(0)}→${rankAll2.ms.toFixed(0)}ms`)

  console.log(`\n总计: ${results.pass} 通过 / ${results.fail} 失败`)

  await browser.close()
  process.exit(results.fail > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
