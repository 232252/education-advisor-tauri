#!/usr/bin/env node
// v3.1.4 优化验证: 对比 scores.cache.json 优化前后 ranking/score 耗时
import { chromium } from 'playwright'
import { appendFileSync } from 'node:fs'

const LOG = 'test-results/perf-compare.log'
function out(m) { console.log(m); appendFileSync(LOG, m + '\n') }

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

async function main() {
  out('╔══════════════════════════════════════════════════╗')
  out('║  v3.1.4 scores.cache.json 优化验证              ║')
  out(`║  ${new Date().toISOString()}`)
  out('╚══════════════════════════════════════════════════╝\n')

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const page = browser.contexts()[0].pages()[0]

  // 当前数据规模
  const info = await callEaa(page, 'info')
  out(`当前数据: ${JSON.stringify(info.data?.data)}\n`)

  // === 1. ranking 查询(3 次, 第1次可能触发 cache 重建) ===
  out('━━━ ranking 查询(3 次)━━━')
  for (let i = 1; i <= 3; i++) {
    const r = await callEaa(page, 'ranking', 100)
    out(`  #${i}: ${r.ms.toFixed(0)}ms ok=${r.ok}`)
  }

  // === 2. score 查询(3 次) ===
  out('\n━━━ score 查询(3 次, 取排行榜第1名)━━━')
  const rankR = await callEaa(page, 'ranking', 1)
  const topStudent = rankR.data?.data?.ranking?.[0]?.name
  if (topStudent) {
    for (let i = 1; i <= 3; i++) {
      const r = await callEaa(page, 'score', topStudent)
      out(`  #${i} ${topStudent}: ${r.ms.toFixed(0)}ms score=${r.data?.data?.score}`)
    }
  }

  // === 3. history 查询(找一个事件多的学生) ===
  out('\n━━━ history 查询 ━━━')
  // 用极限测试学生
  const histR = await callEaa(page, 'history', `Limit_1783944962277`)
  out(`  极限学生: ${histR.ms.toFixed(0)}ms 返回${histR.data?.data?.events?.length || 0}条`)

  // === 4. list-students ===
  out('\n━━━ list-students ━━━')
  const listR = await callEaa(page, 'listStudents')
  out(`  ${listR.ms.toFixed(0)}ms 返回${listR.data?.data?.students?.length || 0}学生`)

  // === 5. summary/stats ===
  out('\n━━━ summary / stats ━━━')
  const sumR = await callEaa(page, 'summary')
  out(`  summary: ${sumR.ms.toFixed(0)}ms`)
  const statsR = await callEaa(page, 'stats')
  out(`  stats: ${statsR.ms.toFixed(0)}ms`)

  // === 6. add-event 后再查 ranking(验证 cache 增量更新) ===
  out('\n━━━ add-event 后 ranking(验证 cache 增量更新)━━━')
  const addR = await callEaa(page, 'addEvent', {
    studentName: topStudent || `Limit_1783944962277`,
    reasonCode: 'SPEAK_IN_CLASS',
    force: true,
    note: 'v3.1.4 cache 验证',
  })
  out(`  add-event: ${addR.ms.toFixed(0)}ms ok=${addR.ok}`)
  const rankAfter = await callEaa(page, 'ranking', 100)
  out(`  add 后 ranking: ${rankAfter.ms.toFixed(0)}ms`)

  // === 对比表 ===
  out('\n╔══════════════════════════════════════════════════╗')
  out('║  优化前后对比                                    ║')
  out('╚══════════════════════════════════════════════════╝')
  out('  优化前(32294事件): ranking=5080ms score=511ms summary=5173ms')
  out('  优化后: 见上方数据')
  out('  预期: ranking 降到 ~200ms (25x), score 降到 ~50ms (10x)')

  await browser.close()
}
main().catch(e => { console.error('Fatal:', e); process.exit(1) })
