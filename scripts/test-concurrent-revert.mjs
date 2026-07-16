// =============================================================
// v3.1.7 并发 revert 测试
// 多个 revert 并发执行, 验证 FileLock 串行化 + 数据一致性
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
  console.log('v3.1.7 并发 revert 测试')
  console.log('='.repeat(60))

  // 获取学生列表
  const listRes = await runEaa(['list-students'])
  const students = JSON.parse(listRes.stdout).students || []
  const names = students.map(s => s.name)

  // 阶段 1: 为不同学生各 add 一个事件
  console.log('\n--- 阶段 1: 为 10 个学生各 add 一个事件 ---')
  const testNames = names.slice(0, 10)
  const evtIds = []
  for (const name of testNames) {
    const r = await runEaa(['add', name, 'LATE', '--delta', '-2', '--note', `conc-revert-${name}`, '--force'])
    const m = r.stdout.match(/事件已创建:\s*(\S+)/)
    if (m) { evtIds.push({ name, id: m[1] }); console.log(`  ${name}: ${m[1]} (${Math.round(r.elapsed)}ms)`) }
  }
  console.log(`已 add ${evtIds.length} 个事件`)

  // 阶段 2: 并发 revert 10 个事件
  console.log('\n--- 阶段 2: 并发 revert 10 个事件 ---')
  const t0 = performance.now()
  const revertPromises = evtIds.map(({ name, id }) =>
    runEaa(['revert', id, '--reason', `conc-revert-${name}`]).then(r => ({ name, id, r }))
  )
  const results = await Promise.all(revertPromises)
  const totalTime = performance.now() - t0

  let ok = 0, fail = 0
  for (const { name, id, r } of results) {
    if (r.exitCode === 0) {
      ok++
      console.log(`  ${name}: ✓ ${Math.round(r.elapsed)}ms`)
    } else {
      fail++
      console.log(`  ${name}: ✗ exit=${r.exitCode} ${r.stderr.slice(0, 80)}`)
    }
  }
  console.log(`并发 revert: ${ok} 成功, ${fail} 失败, 总耗时 ${Math.round(totalTime)}ms`)

  // 阶段 3: 并发 add + revert 混合
  console.log('\n--- 阶段 3: 并发 add + revert 混合 (20 操作) ---')
  const mixedPromises = []
  for (let i = 0; i < 10; i++) {
    const name = names[i % names.length]
    mixedPromises.push(
      runEaa(['add', name, 'SLEEP_IN_CLASS', '--delta', '-3', '--note', `mixed-add-${i}`, '--force'])
        .then(r => ({ op: 'add', i, r }))
    )
  }
  // 先等 add 完成, 再并发 revert
  const addResults = await Promise.all(mixedPromises)
  const revertIds = []
  for (const { i, r } of addResults) {
    const m = r.stdout.match(/事件已创建:\s*(\S+)/)
    if (m) revertIds.push({ i, id: m[1] })
  }

  const t1 = performance.now()
  const mixedRevertPromises = revertIds.map(({ i, id }) =>
    runEaa(['revert', id, '--reason', `mixed-revert-${i}`]).then(r => ({ i, id, r }))
  )
  // 同时并发一些 score 查询
  const scorePromises = []
  for (let i = 0; i < 10; i++) {
    scorePromises.push(
      runEaa(['score', names[i % names.length]]).then(r => ({ op: 'score', r }))
    )
  }

  const allMixed = await Promise.all([...mixedRevertPromises, ...scorePromises])
  const mixedTime = performance.now() - t1

  let revertOk = 0, scoreOk = 0
  for (const result of allMixed) {
    if (result.op === 'score') {
      if (result.r.exitCode === 0) scoreOk++
    } else {
      if (result.r.exitCode === 0) revertOk++
    }
  }
  console.log(`混合并发: revert ${revertOk}/${revertIds.length} 成功, score ${scoreOk}/10 成功, 总耗时 ${Math.round(mixedTime)}ms`)

  // 阶段 4: 极端并发 (30 个同时 revert)
  console.log('\n--- 阶段 4: 极端并发 30 个同时 revert ---')
  // 先 add 30 个
  const extremeIds = []
  for (let i = 0; i < 30; i++) {
    const name = names[i % names.length]
    const r = await runEaa(['add', name, 'LATE', '--delta', '-2', '--note', `extreme-${i}`, '--force'])
    const m = r.stdout.match(/事件已创建:\s*(\S+)/)
    if (m) extremeIds.push(m[1])
  }
  console.log(`  已 add ${extremeIds.length} 个事件`)

  const t2 = performance.now()
  const extremePromises = extremeIds.map(id =>
    runEaa(['revert', id, '--reason', 'extreme-revert']).then(r => ({ id, r }))
  )
  const extremeResults = await Promise.all(extremePromises)
  const extremeTime = performance.now() - t2

  let extremeOk = 0
  for (const { r } of extremeResults) {
    if (r.exitCode === 0) extremeOk++
  }
  console.log(`  30 并发 revert: ${extremeOk}/30 成功, 总耗时 ${Math.round(extremeTime)}ms`)
  if (extremeOk > 0) {
    const times = extremeResults.filter(({ r }) => r.exitCode === 0).map(({ r }) => r.elapsed)
    console.log(`  单次 revert 耗时: min=${Math.round(Math.min(...times))}ms max=${Math.round(Math.max(...times))}ms avg=${Math.round(times.reduce((a, b) => a + b, 0) / times.length)}ms`)
  }

  // 最终 validate
  console.log('\n--- 最终 validate ---')
  const finalVal = JSON.parse((await runEaa(['validate'])).stdout)
  console.log(`validate: ${finalVal.valid ? '✓ 通过' : '✗ 失败'} (${finalVal.total_events} 事件, ${finalVal.errors.length} 错误)`)

  console.log('\n' + '='.repeat(60))
  if (fail === 0 && ok === evtIds.length && revertOk === revertIds.length && scoreOk === 10 && extremeOk === 30 && finalVal.valid) {
    console.log('✓ 全部通过')
  } else {
    console.log('✗ 有失败')
  }
  console.log('='.repeat(60))
}

main().catch(console.error)
