// =============================================================
// v3.1.8 高并发混合读写测试
// 同时进行 add/revert/score/search/stats 等操作
// 测试 FileLock 在高并发下的正确性和性能
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

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }

async function main() {
  console.log('='.repeat(60))
  console.log('v3.1.8 高并发混合读写测试')
  console.log('='.repeat(60))

  // 获取学生列表
  const listRes = await runEaa(['list-students'])
  const students = JSON.parse(listRes.stdout).students || []
  const names = students.map(s => s.name)
  console.log(`学生数: ${students.length}`)

  const DEDUCT_CODES = ['SPEAK_IN_CLASS', 'SLEEP_IN_CLASS', 'LATE', 'MAKEUP', 'DESK_UNALIGNED']
  const BONUS_CODES = ['ACTIVITY_PARTICIPATION', 'CIVILIZED_DORM', 'MONTHLY_ATTENDANCE']

  // === 测试 1: 20 并发 add ===
  console.log('\n--- 测试 1: 20 并发 add ---')
  let t0 = performance.now()
  const addPromises = []
  for (let i = 0; i < 20; i++) {
    const name = pick(names)
    const code = pick(DEDUCT_CODES)
    addPromises.push(runEaa(['add', name, code, '--delta', '-1', '--note', `conc-add-${i}`, '--force']))
  }
  const addResults = await Promise.all(addPromises)
  const addTime = performance.now() - t0
  const addOk = addResults.filter(r => r.exitCode === 0).length
  console.log(`  ${addOk}/20 成功, 耗时 ${addTime.toFixed(0)}ms, 平均 ${(addTime / 20).toFixed(0)}ms/op`)

  // === 测试 2: 20 并发 score (只读) ===
  console.log('\n--- 测试 2: 20 并发 score (只读) ---')
  t0 = performance.now()
  const scorePromises = []
  for (let i = 0; i < 20; i++) {
    scorePromises.push(runEaa(['score', pick(names)]))
  }
  const scoreResults = await Promise.all(scorePromises)
  const scoreTime = performance.now() - t0
  const scoreOk = scoreResults.filter(r => r.exitCode === 0).length
  console.log(`  ${scoreOk}/20 成功, 耗时 ${scoreTime.toFixed(0)}ms, 平均 ${(scoreTime / 20).toFixed(0)}ms/op`)

  // === 测试 3: 20 并发 ranking (只读) ===
  console.log('\n--- 测试 3: 20 并发 ranking (只读) ---')
  t0 = performance.now()
  const rankPromises = []
  for (let i = 0; i < 20; i++) {
    rankPromises.push(runEaa(['ranking', '10']))
  }
  const rankResults = await Promise.all(rankPromises)
  const rankTime = performance.now() - t0
  console.log(`  耗时 ${rankTime.toFixed(0)}ms, 平均 ${(rankTime / 20).toFixed(0)}ms/op`)

  // === 测试 4: 20 并发 stats (只读, 流式) ===
  console.log('\n--- 测试 4: 20 并发 stats (只读, 流式) ---')
  t0 = performance.now()
  const statsPromises = []
  for (let i = 0; i < 20; i++) {
    statsPromises.push(runEaa(['stats']))
  }
  const statsResults = await Promise.all(statsPromises)
  const statsTime = performance.now() - t0
  console.log(`  耗时 ${statsTime.toFixed(0)}ms, 平均 ${(statsTime / 20).toFixed(0)}ms/op`)

  // === 测试 5: 混合 30 并发 (10 add + 10 score + 10 ranking) ===
  console.log('\n--- 测试 5: 混合 30 并发 (10 add + 10 score + 10 ranking) ---')
  t0 = performance.now()
  const mixedPromises = []
  for (let i = 0; i < 10; i++) {
    mixedPromises.push(runEaa(['add', pick(names), pick(DEDUCT_CODES), '--delta', '-1', '--note', `mix-${i}`, '--force']))
  }
  for (let i = 0; i < 10; i++) {
    mixedPromises.push(runEaa(['score', pick(names)]))
  }
  for (let i = 0; i < 10; i++) {
    mixedPromises.push(runEaa(['ranking', '10']))
  }
  const mixedResults = await Promise.all(mixedPromises)
  const mixedTime = performance.now() - t0
  const mixedOk = mixedResults.filter(r => r.exitCode === 0).length
  console.log(`  ${mixedOk}/30 成功, 耗时 ${mixedTime.toFixed(0)}ms, 平均 ${(mixedTime / 30).toFixed(0)}ms/op`)

  // === 测试 6: 混合 50 并发 (20 add + 10 revert + 10 score + 10 search) ===
  console.log('\n--- 测试 6: 混合 50 并发 (20 add + 10 score + 10 search + 10 stats) ---')
  // 先 add 一些事件获取 event_id
  const preAddPromises = []
  for (let i = 0; i < 10; i++) {
    preAddPromises.push(runEaa(['add', pick(names), pick(DEDUCT_CODES), '--delta', '-1', '--note', `pre-revert-${i}`, '--force']))
  }
  const preAddResults = await Promise.all(preAddPromises)
  const eventIds = []
  for (const r of preAddResults) {
    if (r.exitCode === 0) {
      try {
        const data = JSON.parse(r.stdout)
        if (data.event_id) eventIds.push(data.event_id)
      } catch {}
    }
  }
  console.log(`  预添加 ${eventIds.length} 个事件用于 revert`)

  t0 = performance.now()
  const heavyPromises = []
  // 20 add
  for (let i = 0; i < 20; i++) {
    heavyPromises.push(runEaa(['add', pick(names), pick(DEDUCT_CODES), '--delta', '-1', '--note', `heavy-add-${i}`, '--force']))
  }
  // 10 revert
  for (let i = 0; i < Math.min(10, eventIds.length); i++) {
    heavyPromises.push(runEaa(['revert', eventIds[i], '--reason', 'conc-revert']))
  }
  // 10 score
  for (let i = 0; i < 10; i++) {
    heavyPromises.push(runEaa(['score', pick(names)]))
  }
  // 10 search
  for (let i = 0; i < 10; i++) {
    heavyPromises.push(runEaa(['search', pick(names), '--limit', '5']))
  }
  const heavyResults = await Promise.all(heavyPromises)
  const heavyTime = performance.now() - t0
  const heavyOk = heavyResults.filter(r => r.exitCode === 0).length
  console.log(`  ${heavyOk}/50 成功, 耗时 ${heavyTime.toFixed(0)}ms, 平均 ${(heavyTime / 50).toFixed(0)}ms/op`)

  // === 测试 7: 极限并发 100 个只读查询 ===
  console.log('\n--- 测试 7: 极限并发 100 个只读查询 ---')
  t0 = performance.now()
  const readPromises = []
  for (let i = 0; i < 100; i++) {
    const op = i % 4
    if (op === 0) readPromises.push(runEaa(['score', pick(names)]))
    else if (op === 1) readPromises.push(runEaa(['ranking', '10']))
    else if (op === 2) readPromises.push(runEaa(['info']))
    else readPromises.push(runEaa(['list-students']))
  }
  const readResults = await Promise.all(readPromises)
  const readTime = performance.now() - t0
  const readOk = readResults.filter(r => r.exitCode === 0).length
  console.log(`  ${readOk}/100 成功, 耗时 ${readTime.toFixed(0)}ms, 平均 ${(readTime / 100).toFixed(0)}ms/op`)

  // === 最终验证 ===
  console.log('\n--- 最终 validate ---')
  const valRes = await runEaa(['validate'])
  if (valRes.exitCode === 0) {
    const v = JSON.parse(valRes.stdout)
    console.log(`  validate: valid=${v.valid}, total_events=${v.total_events}, errors=${v.errors.length}`)
  }

  // === 总结 ===
  console.log('\n' + '='.repeat(60))
  console.log('高并发混合读写测试完成')
  console.log('='.repeat(60))
}

main().catch(e => {
  console.error('测试脚本错误:', e)
  process.exit(1)
})
