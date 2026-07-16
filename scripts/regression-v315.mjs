// =============================================================
// v3.1.5 回归验证 — 确保优化未破坏功能
// =============================================================

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const EAA = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\core\\eaa-cli\\target\\release\\eaa.exe'
const TEST_DIR = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\test-volume-data\\eaa-data'

function runEaa(args) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const env = { ...process.env, EAA_DATA_DIR: TEST_DIR }
    const proc = spawn(EAA, ['-O', 'json', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('close', () => {
      resolve({ elapsed: performance.now() - t0, stdout, stderr, exitCode: proc.exitCode })
    })
  })
}

function assert(cond, msg) {
  if (!cond) {
    console.log(`  ✗ FAIL: ${msg}`)
    return false
  }
  console.log(`  ✓ PASS: ${msg}`)
  return true
}

async function main() {
  console.log('[regression] v3.1.5 回归验证')
  console.log(`[regression] 数据目录: ${TEST_DIR}`)
  console.log('')

  let allPass = true

  // 1. info 正常
  console.log('[1] info 命令')
  const infoRes = await runEaa(['info'])
  let infoData
  try { infoData = JSON.parse(infoRes.stdout) } catch { infoData = {} }
  allPass &= assert(infoRes.exitCode === 0, `exit code 0 (got ${infoRes.exitCode})`)
  allPass &= assert(infoData.students === 100, `100 学生 (got ${infoData.students})`)
  allPass &= assert(infoData.events > 100000, `事件 > 100000 (got ${infoData.events})`)

  // 2. validate 无错误
  console.log('[2] validate 命令')
  const valRes = await runEaa(['validate'])
  let valData
  try { valData = JSON.parse(valRes.stdout) } catch { valData = {} }
  allPass &= assert(valData.valid === true, `所有事件有效`)
  allPass &= assert((valData.errors || []).length === 0, `0 错误`)

  // 3. ranking class_id 完整
  console.log('[3] ranking class_id')
  const rankRes = await runEaa(['ranking', '100'])
  let rankData
  try { rankData = JSON.parse(rankRes.stdout) } catch { rankData = {} }
  const ranking = rankData.ranking || []
  const withClassId = ranking.filter(r => r.class_id).length
  allPass &= assert(ranking.length === 100, `100 条排名 (got ${ranking.length})`)
  allPass &= assert(withClassId === 100, `全部有 class_id (got ${withClassId})`)

  // 4. score 与 ranking 一致
  console.log('[4] score 一致性')
  const top1 = ranking[0]
  const scoreRes = await runEaa(['score', top1.name])
  let scoreData
  try { scoreData = JSON.parse(scoreRes.stdout) } catch { scoreData = {} }
  allPass &= assert(scoreData.score === top1.score, `score=${scoreData.score} ranking=${top1.score}`)

  // 5. score events_count 与 event_stats cache 一致
  console.log('[5] score events_count (v3.1.5 event_stats cache)')
  const statsCache = JSON.parse(fs.readFileSync(
    path.join(TEST_DIR, 'entities', 'event_stats.cache.json'), 'utf-8'
  ))
  const top1Stats = statsCache[top1.entity_id]
  allPass &= assert(scoreData.events_count === top1Stats.count,
    `score.events_count=${scoreData.events_count} cache.count=${top1Stats.count}`)

  // 6. list-students events_count 与 event_stats cache 一致
  console.log('[6] list-students events_count (v3.1.5)')
  const lsRes = await runEaa(['list-students'])
  let lsData
  try { lsData = JSON.parse(lsRes.stdout) } catch { lsData = {} }
  const students = lsData.students || []
  let countMatch = true
  let mismatchSample = ''
  for (const s of students) {
    const cached = statsCache[s.entity_id]
    if (!cached || cached.count !== s.events_count) {
      countMatch = false
      mismatchSample = `${s.name}: score.events_count=${s.events_count} cache.count=${cached?.count ?? 'missing'}`
      break
    }
  }
  allPass &= assert(countMatch, `所有学生 events_count 与 cache 一致 ${mismatchSample ? '(' + mismatchSample + ')' : ''}`)

  // 7. history events_count 与 event_stats cache 一致
  console.log('[7] history events_count (v3.1.5 流式读取)')
  const histRes = await runEaa(['history', top1.name])
  let histData
  try { histData = JSON.parse(histRes.stdout) } catch { histData = {} }
  allPass &= assert(histData.events_count === top1Stats.count,
    `history.events_count=${histData.events_count} cache.count=${top1Stats.count}`)

  // 8. summary 数据完整
  console.log('[8] summary (v3.1.5 流式统计)')
  const sumRes = await runEaa(['summary'])
  let sumData
  try { sumData = JSON.parse(sumRes.stdout) } catch { sumData = {} }
  allPass &= assert(sumData.events && sumData.events.total > 0, `summary.events.total > 0`)
  allPass &= assert(sumData.risk_distribution && Object.keys(sumData.risk_distribution).length === 4, `risk_distribution 4 级`)
  allPass &= assert(sumData.top_gainers && sumData.top_gainers.length === 5, `top_gainers 5 条`)
  allPass &= assert(sumData.top_losers && sumData.top_losers.length === 5, `top_losers 5 条`)
  allPass &= assert(sumData.top_gainers.every(g => g.class_id), `top_gainers 全部有 class_id`)

  // 9. add-event 增量更新验证
  console.log('[9] add-event 增量更新 (v3.1.5)')
  const beforeScore = scoreData.score
  const beforeCount = scoreData.events_count
  const addRes = await runEaa(['add', top1.name, 'LATE', '--delta', '-2', '--note', '回归测试迟到', '--force'])
  const afterScoreRes = await runEaa(['score', top1.name])
  let afterScoreData
  try { afterScoreData = JSON.parse(afterScoreRes.stdout) } catch { afterScoreData = {} }
  allPass &= assert(afterScoreData.score === beforeScore - 2,
    `score ${beforeScore} → ${afterScoreData.score} (期望 ${beforeScore - 2})`)
  allPass &= assert(afterScoreData.events_count === beforeCount + 1,
    `events_count ${beforeCount} → ${afterScoreData.events_count} (期望 ${beforeCount + 1})`)

  // 10. revert 增量更新验证
  console.log('[10] revert 增量更新 (v3.1.5)')
  // 找最近一个事件来 revert
  const histRes2 = await runEaa(['history', top1.name])
  let histData2
  try { histData2 = JSON.parse(histRes2.stdout) } catch { histData2 = {} }
  const events = histData2.events || []
  const lastEvent = events[events.length - 1]
  if (lastEvent && !lastEvent.reverted) {
    const beforeRevertScore = afterScoreData.score
    const beforeRevertCount = afterScoreData.events_count
    const revRes = await runEaa(['revert', lastEvent.event_id, '--reason', '回归测试撤销'])
    const afterRevertRes = await runEaa(['score', top1.name])
    let afterRevertData
    try { afterRevertData = JSON.parse(afterRevertRes.stdout) } catch { afterRevertData = {} }
    // revert 后 score 应该 += |lastEvent.score_delta| (撤销扣分 = 加回)
    const expectedScore = beforeRevertScore - lastEvent.score_delta
    allPass &= assert(afterRevertData.score === expectedScore,
      `revert 后 score ${beforeRevertScore} → ${afterRevertData.score} (期望 ${expectedScore})`)
    allPass &= assert(afterRevertData.events_count === beforeRevertCount - 1,
      `revert 后 events_count ${beforeRevertCount} → ${afterRevertData.events_count} (期望 ${beforeRevertCount - 1})`)
  }

  // 11. scores.cache.json 存在且非空
  console.log('[11] cache 文件完整性')
  const scoresCache = JSON.parse(fs.readFileSync(
    path.join(TEST_DIR, 'entities', 'scores.cache.json'), 'utf-8'
  ))
  allPass &= assert(Object.keys(scoresCache).length === 100, `scores.cache.json 100 条 (got ${Object.keys(scoresCache).length})`)
  allPass &= assert(Object.keys(statsCache).length >= 100, `event_stats.cache.json >= 100 条 (got ${Object.keys(statsCache).length})`)

  console.log('')
  if (allPass) {
    console.log('[regression] ✅ 全部通过')
  } else {
    console.log('[regression] ❌ 存在失败项')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[regression] FATAL:', err)
  process.exit(1)
})
