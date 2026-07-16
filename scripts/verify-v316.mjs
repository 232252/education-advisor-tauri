// =============================================================
// v3.1.6 验证 + 性能测试
// 测试: daily_dedup cache 首次扫描 vs 后续 O(1) 命中
// 验证: add 重复检测 / revert cache 更新 / 批量并发 / 数据一致性
// 用法: node scripts/verify-v316.mjs
// =============================================================

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { existsSync, unlinkSync, readFileSync } from 'node:fs'

const EAA = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\core\\eaa-cli\\target\\release\\eaa.exe'
const DATA_DIR = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\test-volume-data\\eaa-data'
const CACHE = DATA_DIR + '\\entities\\daily_dedup.cache.json'

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
  console.log('v3.1.6 daily_dedup cache 验证 + 性能测试')
  console.log('='.repeat(60))
  console.log('')

  // 0. 清理旧 cache
  if (existsSync(CACHE)) { unlinkSync(CACHE); console.log('[setup] 已清理旧 daily_dedup.cache.json') }
  else console.log('[setup] 无旧 cache')
  console.log('')

  // 获取学生列表
  const listRes = await runEaa(['list-students'])
  const students = JSON.parse(listRes.stdout).students || []
  const s0 = students[0].name
  const s49 = students[49].name
  const s99 = students[99].name
  console.log(`[info] 学生数: ${students.length}, 测试: ${s0}, ${s49}, ${s99}, 赵伟杰`)
  console.log('')

  // --- 测试1: 首次 dry-run add (扫描填充 cache) ---
  console.log('--- 测试1: 首次 dry-run add (扫描填充 cache, 预期 ~235ms) ---')
  const t1 = await runEaa(['add', s0, 'LATE', '--delta', '-2', '--dry-run'])
  console.log(`  ${s0}: ${Math.round(t1.elapsed)}ms (exit=${t1.exitCode})`)
  const cacheExists1 = existsSync(CACHE)
  console.log(`  cache 已生成: ${cacheExists1}`)
  console.log('')

  // --- 测试2: 后续 dry-run add (cache 命中, 预期 <10ms) ---
  console.log('--- 测试2: 后续 dry-run add (cache 命中, 预期 <10ms) ---')
  for (const name of [s49, s99, '赵伟杰', s0]) {
    const r = await runEaa(['add', name, 'LATE', '--delta', '-2', '--dry-run'])
    console.log(`  ${name}: ${Math.round(r.elapsed)}ms (exit=${r.exitCode})`)
  }
  console.log('')

  // --- 测试3: 真实 add + 重复检测 ---
  console.log('--- 测试3: 真实 add + 重复检测 ---')
  // 先 add 一个真实事件
  const add1 = await runEaa(['add', s0, 'SLEEP_IN_CLASS', '--delta', '-2', '--note', 'v316-test'])
  console.log(`  首次 add ${s0} SLEEP_IN_CLASS: ${Math.round(add1.elapsed)}ms exit=${add1.exitCode}`)
  // 再 add 同样的 (应该被拒)
  const add2 = await runEaa(['add', s0, 'SLEEP_IN_CLASS', '--delta', '-2', '--note', 'dup'])
  const isDup = add2.stderr.includes('重复事件') || add2.stdout.includes('重复事件')
  console.log(`  重复 add (应被拒): ${Math.round(add2.elapsed)}ms exit=${add2.exitCode} 重复检测=${isDup ? '✓' : '✗'}`)
  // add 不同 code (应该成功)
  const add3 = await runEaa(['add', s0, 'LATE', '--delta', '-2', '--note', 'v316-test2'])
  console.log(`  add 不同 code LATE: ${Math.round(add3.elapsed)}ms exit=${add3.exitCode}`)
  console.log('')

  // --- 测试4: 批量并发 add (25 人) ---
  console.log('--- 测试4: 批量并发 add 25 人 (cache 命中) ---')
  const batch = students.slice(0, 25).map(s => s.name)
  const t0batch = performance.now()
  const batchResults = await Promise.all(batch.map(name =>
    runEaa(['add', name, 'OTHER_DEDUCT', '--delta', '-1', '--note', 'batch-v316'])
  ))
  const batchTime = performance.now() - t0batch
  const successCount = batchResults.filter(r => r.exitCode === 0).length
  console.log(`  25 人并发: ${Math.round(batchTime)}ms, 成功 ${successCount}/25`)
  console.log('')

  // --- 测试5: 串行 add 10 人对比 ---
  console.log('--- 测试5: 串行 add 10 人 (cache 命中, 预期每人 <20ms) ---')
  const serial = students.slice(25, 35).map(s => s.name)
  let serialTotal = 0
  for (const name of serial) {
    const r = await runEaa(['add', name, 'DESK_UNALIGNED', '--delta', '-1', '--note', 'serial-v316'])
    serialTotal += r.elapsed
    console.log(`  ${name}: ${Math.round(r.elapsed)}ms exit=${r.exitCode}`)
  }
  console.log(`  串行总耗时: ${Math.round(serialTotal)}ms, 平均 ${Math.round(serialTotal / 10)}ms/人`)
  console.log('')

  // --- 测试6: 数据一致性验证 ---
  console.log('--- 测试6: 数据一致性验证 ---')
  const scoreRes = await runEaa(['score', s0])
  const scoreData = JSON.parse(scoreRes.stdout)
  console.log(`  ${s0} score: ${scoreData.score}, events_count: ${scoreData.events_count}`)

  // 检查 cache 文件内容
  if (existsSync(CACHE)) {
    const cacheData = JSON.parse(readFileSync(CACHE, 'utf8'))
    const today = new Date().toISOString().slice(0, 10)
    const todayMap = cacheData[today] || {}
    const keyCount = Object.keys(todayMap).length
    console.log(`  daily_dedup cache: ${Object.keys(cacheData).length} 天, 今天 ${keyCount} 个 key`)
    // 检查刚 add 的 key 是否在 cache 中
    const idx0 = students[0].entity_id || students[0].id
    const checkKey = `${idx0}|SLEEP_IN_CLASS`
    console.log(`  cache[${today}][${checkKey}] = ${todayMap[checkKey] || 0}`)
  } else {
    console.log('  ✗ cache 文件不存在!')
  }
  console.log('')

  // --- 测试7: validate 全量校验 ---
  console.log('--- 测试7: validate 全量校验 ---')
  const valRes = await runEaa(['validate'])
  const valData = JSON.parse(valRes.stdout)
  console.log(`  valid: ${valData.valid}, total_events: ${valData.total_events}, errors: ${valData.errors.length}`)
  if (valData.errors.length > 0) console.log(`  错误: ${valData.errors.slice(0, 5).join('; ')}`)
  console.log('')

  // --- 汇总 ---
  console.log('='.repeat(60))
  console.log('汇总')
  console.log('='.repeat(60))
  console.log(`首次 add (扫描填充): ${Math.round(t1.elapsed)}ms`)
  console.log(`后续 add (cache 命中): ${Math.round((await runEaa(['add', s99, 'LATE', '--delta', '-2', '--dry-run'])).elapsed)}ms`)
  console.log(`25 人并发: ${Math.round(batchTime)}ms (${Math.round(batchTime / 25)}ms/人)`)
  console.log(`10 人串行: ${Math.round(serialTotal)}ms (${Math.round(serialTotal / 10)}ms/人)`)
  console.log(`数据校验: ${valData.valid ? '✓ 通过' : '✗ 失败'}`)
}

main().catch(console.error)
