// =============================================================
// v3.1.6 极端并发测试
// - 50/100 并发 add (force, 不同学生) → 文件锁 + 写入安全
// - 50 并发 score 查询 → 读写并发
// - 100 并发 add + 50 并发 score 混合
// - 并发后 validate → 数据一致性
// 用法: node scripts/extreme-concurrent.mjs
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
    proc.on('error', () => resolve({ elapsed: 0, stdout: '', stderr: '', exitCode: -1 }))
  })
}

async function main() {
  console.log('='.repeat(60))
  console.log('v3.1.6 极端并发测试')
  console.log('='.repeat(60))
  console.log('')

  const listRes = await runEaa(['list-students'])
  const students = JSON.parse(listRes.stdout).students || []
  const names = students.map(s => s.name)
  console.log(`[info] ${students.length} 学生`)
  console.log('')

  // --- 测试1: 50 并发 add (force, 不同学生不同code) ---
  console.log('--- 测试1: 50 并发 add (force) ---')
  const codes = ['SPEAK_IN_CLASS', 'SLEEP_IN_CLASS', 'LATE', 'MAKEUP', 'DESK_UNALIGNED',
                 'OTHER_DEDUCT', 'APPEARANCE_VIOLATION', 'ACTIVITY_PARTICIPATION', 'CIVILIZED_DORM', 'MONTHLY_ATTENDANCE']
  const batch50 = names.slice(0, 50).map((name, i) =>
    runEaa(['add', name, codes[i % codes.length], '--delta', '-1', '--note', `concurrent50-${i}`, '--force'])
  )
  const t1 = performance.now()
  const results50 = await Promise.all(batch50)
  const t50 = performance.now() - t1
  const ok50 = results50.filter(r => r.exitCode === 0).length
  console.log(`  50 并发 add: ${Math.round(t50)}ms, 成功 ${ok50}/50`)
  console.log(`  平均 ${Math.round(t50 / 50)}ms/人`)
  console.log('')

  // --- 测试2: 50 并发 score 查询 ---
  console.log('--- 测试2: 50 并发 score 查询 ---')
  const scoreBatch = names.slice(0, 50).map(name => runEaa(['score', name]))
  const t2 = performance.now()
  const scoreResults = await Promise.all(scoreBatch)
  const tScore = performance.now() - t2
  const scoreOk = scoreResults.filter(r => r.exitCode === 0).length
  console.log(`  50 并发 score: ${Math.round(tScore)}ms, 成功 ${scoreOk}/50`)
  console.log(`  平均 ${Math.round(tScore / 50)}ms/人`)
  console.log('')

  // --- 测试3: 100 并发 add (force) ---
  console.log('--- 测试3: 100 并发 add (force) ---')
  const batch100 = names.slice(0, 100).map((name, i) =>
    runEaa(['add', name, codes[i % codes.length], '--delta', '-1', '--note', `concurrent100-${i}`, '--force'])
  )
  const t3 = performance.now()
  const results100 = await Promise.all(batch100)
  const t100 = performance.now() - t3
  const ok100 = results100.filter(r => r.exitCode === 0).length
  console.log(`  100 并发 add: ${Math.round(t100)}ms, 成功 ${ok100}/100`)
  console.log(`  平均 ${Math.round(t100 / 100)}ms/人`)
  console.log('')

  // --- 测试4: 混合并发 (50 add + 50 score 同时) ---
  console.log('--- 测试4: 混合并发 (50 add + 50 score) ---')
  const mixedAdd = names.slice(0, 50).map((name, i) =>
    runEaa(['add', name, codes[i % codes.length], '--delta', '-1', '--note', `mixed-${i}`, '--force'])
  )
  const mixedScore = names.slice(50, 100).map(name => runEaa(['score', name]))
  const t4 = performance.now()
  const mixedResults = await Promise.all([...mixedAdd, ...mixedScore])
  const tMixed = performance.now() - t4
  const mixedAddOk = mixedResults.slice(0, 50).filter(r => r.exitCode === 0).length
  const mixedScoreOk = mixedResults.slice(50).filter(r => r.exitCode === 0).length
  console.log(`  混合并发 (100总): ${Math.round(tMixed)}ms`)
  console.log(`  add 成功 ${mixedAddOk}/50, score 成功 ${mixedScoreOk}/50`)
  console.log('')

  // --- 测试5: 并发后 validate ---
  console.log('--- 测试5: 并发后 validate ---')
  const valRes = await runEaa(['validate'])
  const valData = JSON.parse(valRes.stdout)
  console.log(`  valid: ${valData.valid ? '✓' : '✗'} (${valData.total_events} 事件, ${valData.errors.length} 错误)`)
  if (valData.errors.length > 0) console.log(`  错误: ${valData.errors.slice(0, 5).join('; ')}`)
  console.log('')

  // --- 测试6: 连续 3 轮 100 并发 add (300 事件) ---
  console.log('--- 测试6: 连续 3 轮 100 并发 add ---')
  for (let round = 1; round <= 3; round++) {
    const batch = names.slice(0, 100).map((name, i) =>
      runEaa(['add', name, codes[i % codes.length], '--delta', '-1', '--note', `round${round}-${i}`, '--force'])
    )
    const tr = performance.now()
    const res = await Promise.all(batch)
    const trEnd = performance.now() - tr
    const ok = res.filter(r => r.exitCode === 0).length
    console.log(`  轮 ${round}: ${Math.round(trEnd)}ms, 成功 ${ok}/100`)
  }
  console.log('')

  // --- 最终 validate ---
  const finalVal = await runEaa(['validate'])
  const finalValData = JSON.parse(finalVal.stdout)
  console.log('='.repeat(60))
  console.log('汇总')
  console.log('='.repeat(60))
  console.log(`50 并发 add:  ${Math.round(t50)}ms (${Math.round(t50 / 50)}ms/人), 成功 ${ok50}/50`)
  console.log(`50 并发 score: ${Math.round(tScore)}ms (${Math.round(tScore / 50)}ms/人), 成功 ${scoreOk}/50`)
  console.log(`100 并发 add: ${Math.round(t100)}ms (${Math.round(t100 / 100)}ms/人), 成功 ${ok100}/100`)
  console.log(`混合并发:     ${Math.round(tMixed)}ms, add ${mixedAddOk}/50, score ${mixedScoreOk}/50`)
  console.log(`最终 validate: ${finalValData.valid ? '✓ 通过' : '✗ 失败'} (${finalValData.total_events} 事件, ${finalValData.errors.length} 错误)`)
}

main().catch(console.error)
