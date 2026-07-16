// =============================================================
// v3.1.9 极限并发压力测试 — 连续 3 轮高并发 + 缓存一致性验证
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
      if (scoreMismatches <= 5) {
        console.log(`  [${label}] 分数不一致: ${student.name} cache=${cacheScore} vs computed=${computedScore}`)
      }
    }
    const cachedStats = statsCache[eid]
    const computedCount = validCountByEntity[eid] || 0
    if (cachedStats && cachedStats.count !== computedCount) {
      statsMismatches++
      if (statsMismatches <= 5) {
        console.log(`  [${label}] stats不一致: ${student.name} cache.count=${cachedStats.count} vs computed=${computedCount}`)
      }
    }
  }
  console.log(`  [${label}] 分数: ${students.length - scoreMismatches}/${students.length} 一致, stats: ${students.length - statsMismatches}/${students.length} 一致`)
  return { scoreMismatches, statsMismatches, total: students.length }
}

async function runConcurrentRound(roundNum) {
  console.log(`\n--- 第 ${roundNum} 轮高并发 ---`)
  const listRes = await runEaa(['list-students'])
  const students = JSON.parse(listRes.stdout).students || []
  const names = students.map(s => s.name)

  const DEDUCT_CODES = ['SPEAK_IN_CLASS', 'SLEEP_IN_CLASS', 'LATE', 'MAKEUP', 'DESK_UNALIGNED']
  const BONUS_CODES = ['ACTIVITY_PARTICIPATION', 'CIVILIZED_DORM', 'MONTHLY_ATTENDANCE']

  // 50 并发混合 (20 add + 10 revert + 10 score + 10 search)
  // 先 add 10 个事件用于 revert
  const preAdd = []
  for (let i = 0; i < 10; i++) {
    preAdd.push(runEaa(['add', pick(names), pick(DEDUCT_CODES), '--delta', '-1', '--note', `r${roundNum}-pre-${i}`, '--force']))
  }
  const preResults = await Promise.all(preAdd)
  const eventIds = []
  for (const r of preResults) {
    if (r.exitCode === 0) {
      try { const d = JSON.parse(r.stdout); if (d.event_id) eventIds.push(d.event_id) } catch {}
    }
  }

  const t0 = performance.now()
  const promises = []
  // 20 add
  for (let i = 0; i < 20; i++) {
    promises.push(runEaa(['add', pick(names), pick([...DEDUCT_CODES, ...BONUS_CODES]), '--delta', pick([-1, -2, 1, 2, 3]), '--note', `r${roundNum}-add-${i}`, '--force']))
  }
  // 10 revert
  for (let i = 0; i < Math.min(10, eventIds.length); i++) {
    promises.push(runEaa(['revert', eventIds[i], '--reason', `r${roundNum}-revert`]))
  }
  // 10 score
  for (let i = 0; i < 10; i++) {
    promises.push(runEaa(['score', pick(names)]))
  }
  // 10 search
  for (let i = 0; i < 10; i++) {
    promises.push(runEaa(['search', pick(names), '--limit', '5']))
  }
  // 10 stats
  for (let i = 0; i < 10; i++) {
    promises.push(runEaa(['stats']))
  }
  // 10 ranking
  for (let i = 0; i < 10; i++) {
    promises.push(runEaa(['ranking', '10']))
  }

  const results = await Promise.all(promises)
  const elapsed = performance.now() - t0
  const ok = results.filter(r => r.exitCode === 0).length
  const total = results.length
  const warnings = results.filter(r => r.stderr && r.stderr.includes('[warn]')).length
  console.log(`  ${ok}/${total} 成功, ${warnings} 个缓存警告, 耗时 ${elapsed.toFixed(0)}ms`)

  // 最终 validate
  const valRes = await runEaa(['validate'])
  if (valRes.exitCode === 0) {
    const v = JSON.parse(valRes.stdout)
    console.log(`  validate: valid=${v.valid}, events=${v.total_events}, errors=${v.errors.length}`)
  }
}

async function main() {
  console.log('='.repeat(60))
  console.log('v3.1.9 极限并发压力测试 (3 轮)')
  console.log('='.repeat(60))

  // 初始一致性检查
  console.log('\n--- 初始一致性 ---')
  await checkConsistency('初始')

  // 3 轮高并发
  for (let round = 1; round <= 3; round++) {
    await runConcurrentRound(round)

    // 每轮后检查一致性
    await checkConsistency(`第${round}轮后`)
  }

  // 最终 validate
  console.log('\n--- 最终 validate ---')
  const valRes = await runEaa(['validate'])
  if (valRes.exitCode === 0) {
    const v = JSON.parse(valRes.stdout)
    console.log(`  valid=${v.valid}, total_events=${v.total_events}, errors=${v.errors.length}`)
  }

  console.log('\n' + '='.repeat(60))
  console.log('v3.1.9 极限并发压力测试完成')
  console.log('='.repeat(60))
}

main().catch(e => {
  console.error('脚本错误:', e)
  process.exit(1)
})
