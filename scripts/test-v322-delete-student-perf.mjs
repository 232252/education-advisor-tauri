// =============================================================
// v3.2.2 delete-student 性能对比测试
// 创建 4 个测试学生 (0/10/100/1000 事件), 分别删除并测量耗时
// 验证: 性能随事件数是否线性增长, 缓存是否正确更新
// =============================================================

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

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

async function addEvents(name, count) {
  const codes = ['SPEAK_IN_CLASS', 'LATE', 'ACTIVITY_PARTICIPATION', 'SLEEP_IN_CLASS', 'MONTHLY_ATTENDANCE']
  const deltas = [-1, -2, 2, -5, 3]
  let added = 0
  for (let i = 0; i < count; i++) {
    const idx = i % codes.length
    // 使用 --force 绕过 daily_dedup (同一学生同一天同一原因码)
    const r = await runEaa(['add', name, codes[idx], '--delta', String(deltas[idx]), '--note', `perf-test-${i}`, '--force'])
    if (r.exitCode === 0) added++
  }
  return added
}

async function getScore(name) {
  const r = await runEaa(['score', name])
  if (r.exitCode === 0) {
    try { return JSON.parse(r.stdout) } catch { return null }
  }
  return null
}

async function getEventCount(name) {
  const r = await runEaa(['history', name])
  if (r.exitCode === 0) {
    try { const j = JSON.parse(r.stdout); return j.events_count || 0 } catch { return -1 }
  }
  return -1
}

async function main() {
  console.log('='.repeat(60))
  console.log('v3.2.2 delete-student 性能对比测试')
  console.log('='.repeat(60))
  console.log('')

  const testCases = [
    { name: 'PerfTest_Zero', events: 0 },
    { name: 'PerfTest_10', events: 10 },
    { name: 'PerfTest_100', events: 100 },
    { name: 'PerfTest_1000', events: 1000 },
  ]

  // Phase 1: 创建测试学生并添加事件
  console.log('[Phase 1] 创建测试学生...')
  for (const tc of testCases) {
    // 先删除可能存在的同名学生
    await runEaa(['delete-student', tc.name, '--confirm', '--reason', 'cleanup'])
    // 创建学生
    const r = await runEaa(['add-student', tc.name])
    if (r.exitCode !== 0 && !r.stdout.includes('已存在')) {
      console.log(`  ✗ 创建 ${tc.name} 失败: ${r.stderr || r.stdout}`)
    }
    // 添加事件
    if (tc.events > 0) {
      console.log(`  ${tc.name}: 添加 ${tc.events} 事件...`)
      const added = await addEvents(tc.name, tc.events)
      const evtCount = await getEventCount(tc.name)
      const score = await getScore(tc.name)
      console.log(`    ✓ 添加 ${added}/${tc.events}, history:${evtCount}, score:${score?.score || '?'}`)
    } else {
      console.log(`  ${tc.name}: 0 事件`)
    }
  }
  console.log('')

  // Phase 2: 删除并测量耗时
  console.log('[Phase 2] 删除测试...')
  const results = []
  for (const tc of testCases) {
    const evtCount = await getEventCount(tc.name)
    console.log(`  删除 ${tc.name} (${evtCount} 事件)...`)
    const t0 = performance.now()
    const r = await runEaa(['delete-student', tc.name, '--confirm', '--reason', 'perf-test'])
    const elapsed = performance.now() - t0
    const ok = r.exitCode === 0
    console.log(`    ${ok ? '✓' : '✗'} ${elapsed.toFixed(0)}ms (exit=${r.exitCode})`)
    if (!ok) { console.log(`      stderr: ${r.stderr}`) }
    results.push({ name: tc.name, events: evtCount, elapsed, ok })
  }
  console.log('')

  // Phase 3: 验证缓存一致性
  console.log('[Phase 3] 缓存一致性验证...')
  for (const tc of testCases) {
    const score = await getScore(tc.name)
    // 删除后 score 应该返回错误或基础分
    if (score === null) {
      console.log(`  ✓ ${tc.name}: score 查询返回错误 (符合预期, 学生已删除)`)
    } else {
      console.log(`  ⚠ ${tc.name}: score=${score.score} (删除后仍可查询?)`)
    }
  }
  console.log('')

  // Summary
  console.log('='.repeat(60))
  console.log('性能对比汇总:')
  console.log('-'.repeat(40))
  console.log(`${'学生'.padEnd(20)} ${'事件数'.padStart(6)} ${'耗时'.padStart(8)} ${'状态'.padStart(4)}`)
  console.log('-'.repeat(40))
  for (const r of results) {
    console.log(`${r.name.padEnd(20)} ${String(r.events).padStart(6)} ${r.elapsed.toFixed(0).padStart(6)}ms ${r.ok ? ' ✓' : ' ✗'}`)
  }
  console.log('='.repeat(60))

  // 分析
  const allOk = results.every(r => r.ok)
  console.log(`\n结论: ${allOk ? '全部通过' : '有失败'}`)
  if (allOk) {
    const zeroMs = results[0].elapsed
    const maxMs = Math.max(...results.map(r => r.elapsed))
    console.log(`  0 事件: ${zeroMs.toFixed(0)}ms`)
    console.log(`  最大: ${maxMs.toFixed(0)}ms (1000 事件)`)
    console.log(`  比率: ${(maxMs / zeroMs).toFixed(2)}x`)
    if (maxMs < 2000) {
      console.log('  ✓ 性能良好 (<2s)')
    } else {
      console.log('  ⚠ 性能可能需要优化 (>2s)')
    }
  }
}

main().catch(console.error)
