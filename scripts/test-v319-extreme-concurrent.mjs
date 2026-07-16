// =============================================================
// v3.1.9 极限并发测试 — 150+ 并发操作, 5 轮, 每轮后缓存一致性检查
// 重点: 大量并发写操作 (add + revert) 的排他锁竞争
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
  const mismatches = []
  for (const student of students) {
    const eid = student.entity_id
    const cacheScore = scoresCache[eid]
    const computedScore = computeScoreFromEvents(eid, allEvents)
    if (cacheScore === undefined || Math.abs(cacheScore - computedScore) > 0.001) {
      scoreMismatches++
      if (mismatches.length < 5) {
        mismatches.push(`  [${label}] 分数不一致: ${student.name} cache=${cacheScore} vs computed=${computedScore}`)
      }
    }
    const cachedStats = statsCache[eid]
    const computedCount = validCountByEntity[eid] || 0
    if (cachedStats && cachedStats.count !== computedCount) {
      statsMismatches++
      if (mismatches.length < 10) {
        mismatches.push(`  [${label}] stats不一致: ${student.name} cache.count=${cachedStats.count} vs computed=${computedCount}`)
      }
    }
  }
  mismatches.forEach(m => console.log(m))
  console.log(`  [${label}] 分数: ${students.length - scoreMismatches}/${students.length} 一致, stats: ${students.length - statsMismatches}/${students.length} 一致 (events: ${allEvents.length})`)
  return { scoreMismatches, statsMismatches, total: students.length, eventCount: allEvents.length }
}

async function runExtremeRound(roundNum, names) {
  console.log(`\n--- 第 ${roundNum} 轮极限并发 (150 并发) ---`)

  const DEDUCT_CODES = ['SPEAK_IN_CLASS', 'SLEEP_IN_CLASS', 'LATE', 'MAKEUP', 'DESK_UNALIGNED', 'OTHER_DEDUCT']
  const BONUS_CODES = ['ACTIVITY_PARTICIPATION', 'CIVILIZED_DORM', 'MONTHLY_ATTENDANCE']

  // 先 add 30 个事件用于 revert
  const preAddPromises = []
  for (let i = 0; i < 30; i++) {
    preAddPromises.push(runEaa(['add', pick(names), pick(DEDUCT_CODES), '--delta', '-1', '--note', `extreme-r${roundNum}-pre-${i}`, '--force']))
  }
  const preResults = await Promise.all(preAddPromises)
  const eventIds = []
  for (const r of preResults) {
    if (r.exitCode === 0) {
      try { const d = JSON.parse(r.stdout); if (d.event_id) eventIds.push(d.event_id) } catch {}
    }
  }
  console.log(`  预添加 ${eventIds.length}/30 事件用于 revert`)

  // 150 并发混合
  const t0 = performance.now()
  const promises = []

  // 60 add (大量并发写)
  for (let i = 0; i < 60; i++) {
    const isBonus = Math.random() < 0.3
    const code = isBonus ? pick(BONUS_CODES) : pick(DEDUCT_CODES)
    const delta = isBonus ? pick([1, 2, 3]) : pick([-1, -2, -5])
    promises.push(runEaa(['add', pick(names), code, '--delta', String(delta), '--note', `extreme-r${roundNum}-add-${i}`, '--force']))
  }

  // 30 revert (并发写, 与 add 竞争排他锁)
  for (let i = 0; i < Math.min(30, eventIds.length); i++) {
    promises.push(runEaa(['revert', eventIds[i], '--reason', `extreme-r${roundNum}-revert`]))
  }

  // 20 score (并发读, 共享锁)
  for (let i = 0; i < 20; i++) {
    promises.push(runEaa(['score', pick(names)]))
  }

  // 10 ranking (并发读)
  for (let i = 0; i < 10; i++) {
    promises.push(runEaa(['ranking', '20']))
  }

  // 10 list-students (并发读)
  for (let i = 0; i < 10; i++) {
    promises.push(runEaa(['list-students']))
  }

  // 10 search (并发读)
  for (let i = 0; i < 10; i++) {
    promises.push(runEaa(['search', pick(names), '--limit', '5']))
  }

  // 10 stats (并发读)
  for (let i = 0; i < 10; i++) {
    promises.push(runEaa(['stats']))
  }

  const results = await Promise.all(promises)
  const elapsed = performance.now() - t0
  const ok = results.filter(r => r.exitCode === 0).length
  const total = results.length
  const warnings = results.filter(r => r.stderr && r.stderr.includes('[warn]')).length
  const errors = results.filter(r => r.exitCode !== 0 && !r.stderr.includes('重复') && !r.stdout.includes('重复'))

  // 按类型统计耗时
  const addTimes = []
  const revertTimes = []
  const readTimes = []
  for (let i = 0; i < 60; i++) addTimes.push(results[i].elapsed)
  for (let i = 60; i < 60 + 30; i++) if (results[i]) revertTimes.push(results[i].elapsed)
  for (let i = 90; i < results.length; i++) readTimes.push(results[i].elapsed)

  const avg = (arr) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0
  const max = (arr) => arr.length > 0 ? Math.round(Math.max(...arr)) : 0

  console.log(`  ${ok}/${total} 成功, ${warnings} 个缓存警告, ${errors.length} 个非重复错误, 耗时 ${elapsed.toFixed(0)}ms`)
  console.log(`  add: avg=${avg(addTimes)}ms max=${max(addTimes)}ms`)
  console.log(`  revert: avg=${avg(revertTimes)}ms max=${max(revertTimes)}ms`)
  console.log(`  read: avg=${avg(readTimes)}ms max=${max(readTimes)}ms`)

  if (errors.length > 0) {
    console.log(`  错误详情 (前 5):`)
    errors.slice(0, 5).forEach((e, i) => {
      console.log(`    [${i}] exit=${e.exitCode}: ${e.stderr.slice(0, 100)}`)
    })
  }

  if (warnings > 0) {
    console.log(`  缓存警告详情 (前 5):`)
    results.filter(r => r.stderr && r.stderr.includes('[warn]')).slice(0, 5).forEach((r, i) => {
      console.log(`    [${i}] ${r.stderr.slice(0, 150)}`)
    })
  }

  return { ok, total, warnings, errors: errors.length, elapsed }
}

async function main() {
  console.log('='.repeat(60))
  console.log('v3.1.9 极限并发测试 (5 轮 × 150 并发)')
  console.log('='.repeat(60))

  // 获取学生列表
  const listRes = await runEaa(['list-students'])
  const students = JSON.parse(listRes.stdout).students || []
  const names = students.map(s => s.name)
  console.log(`学生数: ${students.length}`)

  // 初始一致性检查
  console.log('\n--- 初始一致性 ---')
  const initCheck = await checkConsistency('初始')
  if (initCheck.scoreMismatches > 0 || initCheck.statsMismatches > 0) {
    console.log('✗ 初始一致性检查失败, 先运行 rebuild-cache')
    const rb = await runEaa(['rebuild-cache'])
    console.log(`  rebuild-cache: exit=${rb.exitCode}`)
    await checkConsistency('rebuild后')
  }

  // 5 轮极限并发
  const roundResults = []
  for (let round = 1; round <= 5; round++) {
    const result = await runExtremeRound(round, names)
    roundResults.push(result)

    // 每轮后检查一致性
    const check = await checkConsistency(`第${round}轮后`)
    if (check.scoreMismatches > 0 || check.statsMismatches > 0) {
      console.log(`  ⚠ 第${round}轮后发现不一致! 尝试 rebuild-cache 修复...`)
      const rb = await runEaa(['rebuild-cache'])
      console.log(`  rebuild-cache: exit=${rb.exitCode}`)
      const recheck = await checkConsistency(`第${round}轮rebuild后`)
      if (recheck.scoreMismatches > 0 || recheck.statsMismatches > 0) {
        console.log(`  ✗ rebuild 后仍不一致! 测试中止`)
        process.exit(1)
      }
    }
  }

  // 最终 validate
  console.log('\n--- 最终 validate ---')
  const valRes = await runEaa(['validate'])
  if (valRes.exitCode === 0) {
    const v = JSON.parse(valRes.stdout)
    console.log(`  valid=${v.valid}, total_events=${v.total_events}, errors=${v.errors.length}`)
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
    console.log('✓ 极限并发测试通过')
  } else {
    console.log('✗ 极限并发测试发现问题')
  }
  console.log('='.repeat(60))
}

main().catch(e => {
  console.error('脚本错误:', e)
  process.exit(1)
})
