// =============================================================
// 缓存一致性验证: 并发操作后 scores.cache / event_stats.cache 是否与从 events 重算一致
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

// 从 events.jsonl 重算分数 (ground truth)
function computeScoreFromEvents(entityId, events) {
  let score = 100.0 // BASE_SCORE
  for (const e of events) {
    if (e.entity_id === entityId && e.is_valid && !e.reverted_by && e.reason_code !== 'REVERT') {
      score += e.score_delta
    }
  }
  return score
}

async function main() {
  console.log('='.repeat(60))
  console.log('缓存一致性验证')
  console.log('='.repeat(60))

  // 1. 获取学生列表
  const listRes = await runEaa(['list-students'])
  const students = JSON.parse(listRes.stdout).students || []
  const names = students.map(s => s.name)
  console.log(`学生数: ${students.length}`)

  // 2. 读取 scores.cache.json (cache 值)
  const scoresCachePath = join(DATA_DIR, 'entities/scores.cache.json')
  const scoresCache = JSON.parse(readFileSync(scoresCachePath, 'utf-8'))
  console.log(`scores.cache.json: ${Object.keys(scoresCache).length} 条记录`)

  // 3. 读取 event_stats.cache.json
  const statsCachePath = join(DATA_DIR, 'entities/event_stats.cache.json')
  const statsCache = JSON.parse(readFileSync(statsCachePath, 'utf-8'))
  console.log(`event_stats.cache.json: ${Object.keys(statsCache).length} 条记录`)

  // 4. 流式读取 events.jsonl 并重算分数 (ground truth)
  console.log('\n读取 events.jsonl 重算 ground truth...')
  const t0 = performance.now()
  const eventsPath = join(DATA_DIR, 'events/events.jsonl')
  const content = readFileSync(eventsPath, 'utf-8')
  const allEvents = []
  const validEventCountByEntity = {}  // 只统计有效事件 (与 cache 逻辑一致)
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const e = JSON.parse(trimmed)
      allEvents.push(e)
      // event_stats.cache 只统计 is_valid && !reverted_by && reason_code != REVERT 的事件
      if (e.is_valid && !e.reverted_by && e.reason_code !== 'REVERT') {
        validEventCountByEntity[e.entity_id] = (validEventCountByEntity[e.entity_id] || 0) + 1
      }
    } catch {}
  }
  console.log(`  读取 ${allEvents.length} 个事件, 耗时 ${(performance.now() - t0).toFixed(0)}ms`)

  // 5. 对比每个学生的 cache 分数 vs 重算分数
  let mismatches = 0
  let checked = 0
  const mismatchesDetails = []
  for (const student of students) {
    const eid = student.entity_id
    const cacheScore = scoresCache[eid]
    const computedScore = computeScoreFromEvents(eid, allEvents)
    if (cacheScore === undefined) {
      console.log(`  ⚠ 学生 ${student.name} (${eid}) 不在 scores.cache 中`)
      mismatches++
      continue
    }
    checked++
    const diff = Math.abs(cacheScore - computedScore)
    if (diff > 0.001) {
      mismatches++
      if (mismatchesDetails.length < 10) {
        mismatchesDetails.push({
          name: student.name,
          eid,
          cacheScore,
          computedScore,
          diff,
          eventCount: validEventCountByEntity[eid] || 0,
        })
      }
    }
  }

  console.log(`\n分数一致性检查: ${checked}/${students.length} 已检查, ${mismatches} 不一致`)
  if (mismatchesDetails.length > 0) {
    console.log('不一致详情 (前 10 个):')
    for (const m of mismatchesDetails) {
      console.log(`  ${m.name}: cache=${m.cacheScore.toFixed(2)} vs computed=${m.computedScore.toFixed(2)} (diff=${m.diff.toFixed(2)}, events=${m.eventCount})`)
    }
  }

  // 6. 对比 event_stats.cache 中的 count (只统计有效事件)
  console.log('\nevent_stats.cache 一致性检查:')
  let statsMismatches = 0
  let statsChecked = 0
  for (const student of students) {
    const eid = student.entity_id
    const cachedStats = statsCache[eid]
    const computedCount = validEventCountByEntity[eid] || 0
    if (cachedStats && cachedStats.count !== computedCount) {
      statsMismatches++
      if (statsMismatches <= 10) {
        console.log(`  ⚠ ${student.name}: cache.count=${cachedStats.count} vs computed=${computedCount}`)
      }
    }
    statsChecked++
  }
  console.log(`  ${statsChecked} 已检查, ${statsMismatches} 不一致`)

  // 7. CLI score vs cache score (随机抽 5 个)
  console.log('\nCLI score vs cache score 抽查 (5 个):')
  for (let i = 0; i < 5; i++) {
    const name = pick(names)
    const res = await runEaa(['score', name])
    if (res.exitCode === 0) {
      const data = JSON.parse(res.stdout)
      const eid = data.entity_id
      const cacheScore = scoresCache[eid]
      const computedScore = computeScoreFromEvents(eid, allEvents)
      const cliScore = data.score
      const matchCache = Math.abs(cliScore - cacheScore) < 0.001
      const matchComputed = Math.abs(cliScore - computedScore) < 0.001
      console.log(`  ${name}: cli=${cliScore.toFixed(2)} cache=${cacheScore?.toFixed(2)} computed=${computedScore.toFixed(2)} ${matchCache ? '✓cache' : '✗cache'} ${matchComputed ? '✓computed' : '✗computed'}`)
    }
  }

  // 8. 总结
  console.log('\n' + '='.repeat(60))
  if (mismatches === 0 && statsMismatches === 0) {
    console.log('✓ 缓存一致性验证通过 — cache 与 ground truth 完全一致')
  } else {
    console.log(`✗ 发现不一致: 分数 ${mismatches} 个, stats ${statsMismatches} 个`)
  }
  console.log('='.repeat(60))
}

main().catch(e => {
  console.error('脚本错误:', e)
  process.exit(1)
})
