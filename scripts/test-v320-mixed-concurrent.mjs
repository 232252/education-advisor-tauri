// =============================================================
// v3.2.0 高强度混合并发测试 — 10 轮 × 100 并发 (add+revert+读混合)
// 每轮后缓存一致性检查, 重点测试 v3.2.0 优化后的稳定性
// =============================================================

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const EAA = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\core\\eaa-cli\\target\\release\\eaa.exe'
const DATA_DIR = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\test-volume-data\\eaa-data'

function runEaa(args) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const env = { ...process.env, EAA_DATA_DIR: DATA_DIR }
    const proc = spawn(EAA, ['-O', 'json', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('close', () => resolve({ elapsed: performance.now() - t0, stdout, stderr, exitCode: proc.exitCode }))
    proc.on('error', (err) => resolve({ elapsed: performance.now() - t0, stdout: '', stderr: String(err), exitCode: -1 }))
  })
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }

function computeScoreFromEvents(entityId, events) {
  let score = 100.0
  for (const e of events) {
    if (e.entity_id === entityId && e.is_valid && !e.reverted_by && e.reason_code !== 'REVERT') {
      score += e.score_delta
    }
  }
  return score
}

async function checkConsistency(label) {
  const listRes = await runEaa(['list-students'])
  const students = JSON.parse(listRes.stdout).students || []

  const scoresCache = JSON.parse(readFileSync(join(DATA_DIR, 'entities/scores.cache.json'), 'utf-8'))
  const statsCache = JSON.parse(readFileSync(join(DATA_DIR, 'entities/event_stats.cache.json'), 'utf-8'))

  const content = readFileSync(join(DATA_DIR, 'events/events.jsonl'), 'utf-8')
  const allEvents = []
  const validCountByEntity = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const e = JSON.parse(trimmed)
      allEvents.push(e)
      if (e.is_valid && !e.reverted_by && e.reason_code !== 'REVERT') {
        validCountByEntity[e.entity_id] = (validCountByEntity[e.entity_id] || 0) + 1
      }
    } catch {}
  }

  let scoreMismatches = 0
  let statsMismatches = 0
  for (const student of students) {
    const eid = student.entity_id
    const cacheScore = scoresCache[eid]
    const computedScore = computeScoreFromEvents(eid, allEvents)
    if (cacheScore === undefined || Math.abs(cacheScore - computedScore) > 0.001) {
      scoreMismatches++
      if (scoreMismatches <= 3) {
        console.log(`  [${label}] 分数不一致: ${student.name} cache=${cacheScore} vs computed=${computedScore}`)
      }
    }
    const cachedStats = statsCache[eid]
    const computedCount = validCountByEntity[eid] || 0
    if (cachedStats && cachedStats.count !== computedCount) {
      statsMismatches++
      if (statsMismatches <= 3) {
        console.log(`  [${label}] stats不一致: ${student.name} cache.count=${cachedStats.count} vs computed=${computedCount}`)
      }
    }
  }
  const ok = scoreMismatches === 0 && statsMismatches === 0
  console.log(`  [${label}] 分数: ${students.length - scoreMismatches}/${students.length}, stats: ${students.length - statsMismatches}/${students.length}, events: ${allEvents.length} ${ok ? '✓' : '✗'}`)
  return { scoreMismatches, statsMismatches, total: students.length, eventCount: allEvents.length }
}

async function runMixedRound(roundNum, names) {
  console.log(`\n--- 第 ${roundNum} 轮混合并发 (100 并发: 40add + 20revert + 40读) ---`)

  const DEDUCT_CODES = ['SPEAK_IN_CLASS', 'SLEEP_IN_CLASS', 'LATE', 'MAKEUP', 'DESK_UNALIGNED', 'OTHER_DEDUCT']
  const BONUS_CODES = ['ACTIVITY_PARTICIPATION', 'CIVILIZED_DORM', 'MONTHLY_ATTENDANCE']

  // 先 add 20 个事件用于 revert
  const preAddPromises = []
  for (let i = 0; i < 20; i++) {
    preAddPromises.push(runEaa(['add', pick(names), pick(DEDUCT_CODES), '--delta', '-1', '--note', `mix-r${roundNum}-pre-${i}`, '--force']))
  }
  const preResults = await Promise.all(preAddPromises)
  const eventIds = []
  for (const r of preResults) {
    if (r.exitCode === 0) {
      try { const d = JSON.parse(r.stdout); if (d.event_id) eventIds.push(d.event_id) } catch {}
    }
  }

  // 100 并发混合
  const t0 = performance.now()
  const promises = []

  // 40 add (并发写)
  for (let i = 0; i < 40; i++) {
    const isBonus = Math.random() < 0.3
    const code = isBonus ? pick(BONUS_CODES) : pick(DEDUCT_CODES)
    const delta = isBonus ? pick([1, 2, 3]) : pick([-1, -2, -5])
    promises.push(runEaa(['add', pick(names), code, '--delta', String(delta), '--note', `mix-r${roundNum}-add-${i}`, '--force']))
  }

  // 20 revert (并发写)
  for (let i = 0; i < Math.min(20, eventIds.length); i++) {
    promises.push(runEaa(['revert', eventIds[i], '--reason', `mix-r${roundNum}-revert`]))
  }

  // 10 score (并发读)
  for (let i = 0; i < 10; i++) {
    promises.push(runEaa(['score', pick(names)]))
  }

  // 5 ranking
  for (let i = 0; i < 5; i++) {
    promises.push(runEaa(['ranking', '20']))
  }

  // 5 list-students
  for (let i = 0; i < 5; i++) {
    promises.push(runEaa(['list-students']))
  }

  // 5 search
  for (let i = 0; i < 5; i++) {
    promises.push(runEaa(['search', pick(names), '--limit', '5']))
  }

  // 5 stats
  for (let i = 0; i < 5; i++) {
    promises.push(runEaa(['stats']))
  }

  // 5 export (v3.2.0 优化后的命令)
  for (let i = 0; i < 5; i++) {
    promises.push(runEaa(['export', '--format', 'csv']))
  }

  const results = await Promise.all(promises)
  const elapsed = performance.now() - t0
  const ok = results.filter(r => r.exitCode === 0).length
  const total = results.length
  const warnings = results.filter(r => r.stderr && r.stderr.includes('[warn]')).length
  const errors = results.filter(r => r.exitCode !== 0 && !r.stderr.includes('重复') && !r.stdout.includes('重复'))

  // 按类型统计
  const addTimes = results.slice(0, 40).map(r => r.elapsed)
  const revertTimes = results.slice(40, 60).map(r => r.elapsed)
  const readTimes = results.slice(60).map(r => r.elapsed)

  const avg = (arr) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0
  const max = (arr) => arr.length > 0 ? Math.round(Math.max(...arr)) : 0

  console.log(`  ${ok}/${total} 成功, ${warnings} 警告, ${errors.length} 错误, ${elapsed.toFixed(0)}ms`)
  console.log(`  add: avg=${avg(addTimes)}ms max=${max(addTimes)}ms | revert: avg=${avg(revertTimes)}ms max=${max(revertTimes)}ms | read: avg=${avg(readTimes)}ms max=${max(readTimes)}ms`)

  if (warnings > 0) {
    results.filter(r => r.stderr && r.stderr.includes('[warn]')).slice(0, 3).forEach((r, i) => {
      console.log(`    [warn-${i}] ${r.stderr.slice(0, 150)}`)
    })
  }
  if (errors.length > 0) {
    errors.slice(0, 3).forEach((e, i) => {
      console.log(`    [err-${i}] exit=${e.exitCode}: ${e.stderr.slice(0, 100)}`)
    })
  }

  return { ok, total, warnings, errors: errors.length, elapsed }
}

async function main() {
  console.log('='.repeat(60))
  console.log('v3.2.0 高强度混合并发测试 (10 轮 × 100 并发)')
  console.log('='.repeat(60))

  const listRes = await runEaa(['list-students'])
  const students = JSON.parse(listRes.stdout).students || []
  const names = students.map(s => s.name)
  console.log(`学生数: ${students.length}`)

  // 初始一致性
  console.log('\n--- 初始一致性 ---')
  const initCheck = await checkConsistency('初始')
  if (initCheck.scoreMismatches > 0 || initCheck.statsMismatches > 0) {
    console.log('✗ 初始不一致, 运行 rebuild-cache')
    await runEaa(['rebuild-cache'])
    await checkConsistency('rebuild后')
  }

  // 10 轮混合并发
  const roundResults = []
  for (let round = 1; round <= 10; round++) {
    const result = await runMixedRound(round, names)
    roundResults.push(result)

    const check = await checkConsistency(`第${round}轮后`)
    if (check.scoreMismatches > 0 || check.statsMismatches > 0) {
      console.log(`  ⚠ 第${round}轮不一致! rebuild-cache 修复...`)
      await runEaa(['rebuild-cache'])
      const recheck = await checkConsistency(`第${round}轮rebuild后`)
      if (recheck.scoreMismatches > 0 || recheck.statsMismatches > 0) {
        console.log(`  ✗ rebuild 后仍不一致! 中止`)
        process.exit(1)
      }
    }
  }

  // 最终 validate
  console.log('\n--- 最终 validate ---')
  const valRes = await runEaa(['validate'])
  if (valRes.exitCode === 0) {
    const v = JSON.parse(valRes.stdout)
    console.log(`  valid=${v.valid}, events=${v.total_events}, errors=${v.errors.length}`)
  }

  // 最终一致性
  console.log('\n--- 最终一致性 ---')
  await checkConsistency('最终')

  // 汇总
  console.log('\n' + '='.repeat(60))
  console.log('汇总')
  console.log('='.repeat(60))
  let totalOk = 0, totalOps = 0, totalWarnings = 0, totalErrors = 0
  roundResults.forEach((r, i) => {
    console.log(`  第${i + 1}轮: ${r.ok}/${r.total} 成功, ${r.warnings} 警告, ${r.errors} 错误, ${r.elapsed.toFixed(0)}ms`)
    totalOk += r.ok; totalOps += r.total; totalWarnings += r.warnings; totalErrors += r.errors
  })
  console.log(`  总计: ${totalOk}/${totalOps} 成功, ${totalWarnings} 警告, ${totalErrors} 错误`)
  console.log('='.repeat(60))
  if (totalWarnings === 0 && totalErrors === 0) {
    console.log('✓ v3.2.0 高强度混合并发测试通过')
  } else {
    console.log('✗ 发现问题')
  }
  console.log('='.repeat(60))
}

main().catch(e => {
  console.error('脚本错误:', e)
  process.exit(1)
})
