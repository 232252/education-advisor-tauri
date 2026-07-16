// =============================================================
// v3.1.7 cmd_revert 性能基准测试
// 测量 revert 操作在不同数据量下的耗时
// 用法: node scripts/bench-revert.mjs
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

async function main() {
  console.log('='.repeat(60))
  console.log('cmd_revert 性能基准测试')
  console.log('='.repeat(60))

  // 获取学生列表
  const listRes = await runEaa(['list-students'])
  const students = JSON.parse(listRes.stdout).students || []
  const names = students.map(s => s.name)
  console.log(`学生数: ${students.length}`)

  // 用一个临时学生做 revert 测试 (避免影响已有数据)
  // 先 add 5 个事件, 然后 revert 它们, 测量 revert 耗时
  const testName = names[0] // 用第一个学生
  const addedIds = []

  console.log(`\n--- 添加 5 个测试事件 (${testName}) ---`)
  for (let i = 0; i < 5; i++) {
    const r = await runEaa(['add', testName, 'LATE', '--delta', '-2', '--note', `revert-bench-${i}`, '--force'])
    if (r.exitCode === 0) {
      const m = r.stdout.match(/事件已创建:\s*(\S+)/)
      if (m) {
        addedIds.push(m[1])
        console.log(`  [${i+1}] add: ${Math.round(r.elapsed)}ms → ${m[1]}`)
      }
    } else {
      console.log(`  [${i+1}] add failed: ${r.stderr.slice(0, 100)}`)
    }
  }

  console.log(`\n--- revert 5 个事件 (测量耗时) ---`)
  const revertTimes = []
  for (let i = 0; i < addedIds.length; i++) {
    const r = await runEaa(['revert', addedIds[i], '--reason', `bench-revert-${i}`])
    revertTimes.push(r.elapsed)
    console.log(`  [${i+1}] revert ${addedIds[i]}: ${Math.round(r.elapsed)}ms exit=${r.exitCode}`)
  }

  // 对比: add 耗时 (cache hit, 应该很快)
  console.log(`\n--- 对比: add (cache hit) ---`)
  const addTimes = []
  for (let i = 0; i < 3; i++) {
    const r = await runEaa(['add', testName, 'LATE', '--delta', '-2', '--note', `add-bench-${i}`, '--force'])
    addTimes.push(r.elapsed)
    console.log(`  [${i+1}] add: ${Math.round(r.elapsed)}ms exit=${r.exitCode}`)
    // revert it to clean up
    const m = r.stdout.match(/事件已创建:\s*(\S+)/)
    if (m) await runEaa(['revert', m[1], '--reason', 'cleanup'])
  }

  // 对比: score 耗时 (LightContext, 应该 ~20ms)
  console.log(`\n--- 对比: score (LightContext) ---`)
  const scoreTimes = []
  for (let i = 0; i < 3; i++) {
    const r = await runEaa(['score', testName])
    scoreTimes.push(r.elapsed)
    console.log(`  [${i+1}] score: ${Math.round(r.elapsed)}ms`)
  }

  // 总结
  console.log('\n' + '='.repeat(60))
  console.log('总结')
  console.log('='.repeat(60))
  const avgRevert = revertTimes.reduce((a, b) => a + b, 0) / revertTimes.length
  const avgAdd = addTimes.reduce((a, b) => a + b, 0) / addTimes.length
  const avgScore = scoreTimes.reduce((a, b) => a + b, 0) / scoreTimes.length
  console.log(`revert 平均: ${Math.round(avgRevert)}ms (${revertTimes.map(t => Math.round(t)).join(', ')}ms)`)
  console.log(`add    平均: ${Math.round(avgAdd)}ms (cache hit)`)
  console.log(`score  平均: ${Math.round(avgScore)}ms (LightContext)`)
  console.log(`revert/add 比: ${(avgRevert / avgAdd).toFixed(1)}x`)
  console.log(`revert/score 比: ${(avgRevert / avgScore).toFixed(1)}x`)
}

main().catch(console.error)
