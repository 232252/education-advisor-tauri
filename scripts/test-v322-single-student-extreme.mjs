// =============================================================
// v3.2.2 单学生极限测试
// 向一个学生添加 5000 事件, 测试 score/history/ranking 性能
// 验证: 大事件量下是否稳定, 性能是否退化
// =============================================================

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const EAA = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\core\\eaa-cli\\target\\release\\eaa.exe'
const DATA_DIR = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\test-volume-data\\eaa-data'
const TARGET_COUNT = 5000

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

async function main() {
  console.log('='.repeat(60))
  console.log(`v3.2.2 单学生极限测试 (${TARGET_COUNT} 事件)`)
  console.log('='.repeat(60))
  console.log('')

  const testName = 'ExtremeTest_Student'

  // Phase 0: 清理旧测试学生
  console.log('[Phase 0] 清理旧测试学生...')
  await runEaa(['delete-student', testName, '--confirm', '--reason', 'cleanup'])

  // 创建学生
  const addR = await runEaa(['add-student', testName])
  if (addR.exitCode !== 0 && !addR.stdout.includes('已存在')) {
    console.log(`  ✗ 创建失败: ${addR.stderr}`)
    return
  }
  console.log(`  ✓ 学生已创建: ${testName}`)
  console.log('')

  // Phase 1: 批量添加事件
  console.log(`[Phase 1] 添加 ${TARGET_COUNT} 事件...`)
  const codes = ['SPEAK_IN_CLASS', 'LATE', 'ACTIVITY_PARTICIPATION', 'SLEEP_IN_CLASS', 'MONTHLY_ATTENDANCE', 'CIVILIZED_DORM', 'MAKEUP', 'DESK_UNALIGNED']
  const deltas = [-1, -2, 2, -5, 3, 1, -2, -1]

  let added = 0
  let errors = 0
  const addTimes = []
  const t0 = performance.now()

  for (let i = 0; i < TARGET_COUNT; i++) {
    const idx = i % codes.length
    const r = await runEaa(['add', testName, codes[idx], '--delta', String(deltas[idx]), '--note', `extreme-${i}`, '--force'])
    if (r.exitCode === 0) {
      added++
      addTimes.push(r.elapsed)
    } else {
      errors++
    }

    // 每 500 次报告进度
    if ((i + 1) % 500 === 0) {
      const avgAdd = addTimes.slice(-500).reduce((a, b) => a + b, 0) / Math.min(500, addTimes.length)
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
      console.log(`  [${i + 1}/${TARGET_COUNT}] added=${added} errors=${errors} avgAdd=${avgAdd.toFixed(0)}ms elapsed=${elapsed}s`)
    }
  }

  const totalTime = (performance.now() - t0) / 1000
  const avgAddTime = addTimes.reduce((a, b) => a + b, 0) / addTimes.length
  console.log(`  ✓ 添加完成: ${added}/${TARGET_COUNT}, ${errors} 错误, ${totalTime.toFixed(1)}s, avg ${avgAddTime.toFixed(0)}ms/op`)
  console.log('')

  // Phase 2: 性能测试
  console.log('[Phase 2] 性能测试...')

  // score 测试
  const scoreTimes = []
  for (let i = 0; i < 5; i++) {
    const r = await runEaa(['score', testName])
    if (r.exitCode === 0) {
      scoreTimes.push(r.elapsed)
      if (i === 0) {
        const j = JSON.parse(r.stdout)
        console.log(`  score: ${j.score} (events_count=${j.events_count})`)
      }
    }
  }
  const avgScore = scoreTimes.reduce((a, b) => a + b, 0) / scoreTimes.length
  console.log(`  score avg: ${avgScore.toFixed(0)}ms (${scoreTimes.length} samples)`)

  // history 测试
  const historyTimes = []
  for (let i = 0; i < 3; i++) {
    const r = await runEaa(['history', testName])
    if (r.exitCode === 0) {
      historyTimes.push(r.elapsed)
      if (i === 0) {
        const j = JSON.parse(r.stdout)
        console.log(`  history: ${j.events_count} events`)
      }
    }
  }
  const avgHistory = historyTimes.reduce((a, b) => a + b, 0) / historyTimes.length
  console.log(`  history avg: ${avgHistory.toFixed(0)}ms (${historyTimes.length} samples)`)

  // ranking 测试
  const rankingTimes = []
  for (let i = 0; i < 3; i++) {
    const r = await runEaa(['ranking', '10'])
    if (r.exitCode === 0) rankingTimes.push(r.elapsed)
  }
  const avgRanking = rankingTimes.reduce((a, b) => a + b, 0) / rankingTimes.length
  console.log(`  ranking avg: ${avgRanking.toFixed(0)}ms (${rankingTimes.length} samples)`)

  // validate 测试
  const validateR = await runEaa(['validate'])
  const validateJ = validateR.exitCode === 0 ? JSON.parse(validateR.stdout) : {}
  console.log(`  validate: ${validateJ.valid ? '✓' : '✗'} (${validateJ.total_events} events, ${validateJ.errors?.length || 0} errors)`)
  console.log('')

  // Phase 3: 缓存一致性
  console.log('[Phase 3] 缓存一致性...')
  const cacheR = await runEaa(['score', testName])
  if (cacheR.exitCode === 0) {
    const j = JSON.parse(cacheR.stdout)
    console.log(`  score=${j.score} events_count=${j.events_count}`)
    // 手动计算预期分数
    let expected = 100 // BASE_SCORE
    for (let i = 0; i < added; i++) {
      expected += deltas[i % codes.length]
    }
    console.log(`  expected=${expected.toFixed(1)} (manual calc)`)
    if (Math.abs(j.score - expected) < 0.01) {
      console.log('  ✓ 分数一致')
    } else {
      console.log(`  ✗ 分数不一致: score=${j.score} vs expected=${expected}`)
    }
  }
  console.log('')

  // Summary
  console.log('='.repeat(60))
  console.log('单学生极限测试汇总:')
  console.log('-'.repeat(40))
  console.log(`  学生: ${testName}`)
  console.log(`  事件数: ${added}`)
  console.log(`  添加耗时: ${totalTime.toFixed(1)}s (${avgAddTime.toFixed(0)}ms/op)`)
  console.log(`  score: ${avgScore.toFixed(0)}ms`)
  console.log(`  history: ${avgHistory.toFixed(0)}ms`)
  console.log(`  ranking: ${avgRanking.toFixed(0)}ms`)
  console.log(`  validate: ${validateJ.valid ? '✓' : '✗'} (${validateJ.total_events} events)`)
  console.log('='.repeat(60))

  // 性能评估
  if (avgScore < 50 && avgHistory < 1000 && avgRanking < 100) {
    console.log('\n✓ 性能良好 — 大事件量下仍保持快速响应')
  } else if (avgScore < 100 && avgHistory < 2000) {
    console.log('\n⚠ 性能可接受 — 但可能需要优化')
  } else {
    console.log('\n✗ 性能较差 — 需要优化')
  }
}

main().catch(console.error)
