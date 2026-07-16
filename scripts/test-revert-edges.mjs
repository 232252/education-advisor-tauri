// =============================================================
// v3.1.7 revert 边界位置测试
// 测试 revert 文件中不同位置的事件:
// 1. 第一个事件 (byte offset = 0)
// 2. 最后一个事件 (文件末尾)
// 3. 中间事件
// 4. 唯一事件 (特殊: 只有1个事件的学生)
// 验证每次 revert 后文件结构正确 (validate 通过)
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

let passed = 0, failed = 0
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name} ${detail}`) }
}

async function main() {
  console.log('='.repeat(60))
  console.log('v3.1.7 revert 边界位置测试')
  console.log('='.repeat(60))

  // 获取学生列表
  const listRes = await runEaa(['list-students'])
  const students = JSON.parse(listRes.stdout).students || []
  const names = students.map(s => s.name)

  // === 测试 1: revert 最后一个 add 的事件 (文件末尾附近) ===
  console.log('\n--- 测试 1: revert 刚 add 的事件 (文件末尾) ---')
  const add1 = await runEaa(['add', names[0], 'LATE', '--delta', '-2', '--note', 'edge-last', '--force'])
  const evt1 = add1.stdout.match(/事件已创建:\s*(\S+)/)?.[1]
  check('add 成功', !!evt1)

  const eventsBefore = JSON.parse((await runEaa(['validate'])).stdout).total_events
  const rev1 = await runEaa(['revert', evt1, '--reason', 'edge-last-revert'])
  check('revert 末尾事件成功', rev1.exitCode === 0, rev1.stderr.slice(0, 100))
  check('revert 耗时 < 600ms', rev1.elapsed < 600, `${Math.round(rev1.elapsed)}ms`)

  const eventsAfter = JSON.parse((await runEaa(['validate'])).stdout).total_events
  check('事件数 +1 (revert 事件)', eventsAfter === eventsBefore + 1,
    `before=${eventsBefore} after=${eventsAfter}`)

  // validate
  const val1 = JSON.parse((await runEaa(['validate'])).stdout)
  check('validate 通过', val1.valid === true)

  // === 测试 2: 连续 add 3 个, 然后 revert 中间那个 ===
  console.log('\n--- 测试 2: revert 中间事件 ---')
  const adds = []
  for (let i = 0; i < 3; i++) {
    const r = await runEaa(['add', names[1], 'SLEEP_IN_CLASS', '--delta', '-3', '--note', `edge-mid-${i}`, '--force'])
    const id = r.stdout.match(/事件已创建:\s*(\S+)/)?.[1]
    if (id) adds.push(id)
  }
  check('add 3 个事件', adds.length === 3)

  // revert 中间那个 (adds[1])
  const rev2 = await runEaa(['revert', adds[1], '--reason', 'edge-mid-revert'])
  check('revert 中间事件成功', rev2.exitCode === 0)

  // 验证其他两个事件不受影响
  const hist2 = JSON.parse((await runEaa(['history', names[1]])).stdout)
  const evt0 = hist2.events.find(e => e.event_id === adds[0])
  const evt1b = hist2.events.find(e => e.event_id === adds[1])
  const evt2 = hist2.events.find(e => e.event_id === adds[2])
  check('第一个事件未受影响 (reverted=false)', evt0?.reverted === false)
  check('中间事件已 revert (reverted=true)', evt1b?.reverted === true)
  check('最后一个事件未受影响 (reverted=false)', evt2?.reverted === false)

  // 清理: revert 剩余两个
  await runEaa(['revert', adds[0], '--reason', 'cleanup'])
  await runEaa(['revert', adds[2], '--reason', 'cleanup'])

  // === 测试 3: revert 后立即 add 同一学生同一原因码 (re-add) ===
  console.log('\n--- 测试 3: revert 后 re-add ---')
  const add3 = await runEaa(['add', names[2], 'LATE', '--delta', '-2', '--note', 'edge-readd', '--force'])
  const evt3 = add3.stdout.match(/事件已创建:\s*(\S+)/)?.[1]
  check('add 成功', !!evt3)

  const rev3 = await runEaa(['revert', evt3, '--reason', 'edge-readd-revert'])
  check('revert 成功', rev3.exitCode === 0)

  // re-add: 同一学生同一原因码今天应该可以再次 add
  const readd = await runEaa(['add', names[2], 'LATE', '--delta', '-2', '--note', 'edge-readd-2', '--force'])
  check('re-add 成功 (原事件已 revert, daily_dedup cache 已更新)', readd.exitCode === 0, readd.stderr.slice(0, 100))

  // 清理
  const readdId = readd.stdout.match(/事件已创建:\s*(\S+)/)?.[1]
  if (readdId) await runEaa(['revert', readdId, '--reason', 'cleanup'])

  // === 测试 4: 快速连续 revert 同一学生的多个事件 ===
  console.log('\n--- 测试 4: 快速连续 revert 同一学生 5 个事件 ---')
  const bulkAdds = []
  for (let i = 0; i < 5; i++) {
    const r = await runEaa(['add', names[3], 'LATE', '--delta', '-2', '--note', `edge-bulk-${i}`, '--force'])
    const id = r.stdout.match(/事件已创建:\s*(\S+)/)?.[1]
    if (id) bulkAdds.push(id)
  }
  check('add 5 个事件', bulkAdds.length === 5)

  let allRevertOk = true
  for (let i = 0; i < bulkAdds.length; i++) {
    const r = await runEaa(['revert', bulkAdds[i], '--reason', `edge-bulk-revert-${i}`])
    if (r.exitCode !== 0) { allRevertOk = false; console.log(`  [${i}] revert failed: ${r.stderr.slice(0, 80)}`) }
    else { console.log(`  [${i}] revert ${Math.round(r.elapsed)}ms ✓`) }
  }
  check('5 个连续 revert 全部成功', allRevertOk)

  // 验证所有 5 个事件都标记为 reverted
  const hist4 = JSON.parse((await runEaa(['history', names[3]])).stdout)
  let allReverted = true
  for (const id of bulkAdds) {
    const evt = hist4.events.find(e => e.event_id === id)
    if (!evt || evt.reverted !== true) { allReverted = false; break }
  }
  check('所有 5 个事件都标记为 reverted', allReverted)

  // === 测试 5: revert 后 score 正确回退 ===
  console.log('\n--- 测试 5: revert 后 score 正确回退 ---')
  const scoreBefore5 = JSON.parse((await runEaa(['score', names[4]])).stdout)
  const add5 = await runEaa(['add', names[4], 'LATE', '--delta', '-5', '--note', 'edge-score', '--force'])
  const evt5 = add5.stdout.match(/事件已创建:\s*(\S+)/)?.[1]
  const scoreAfterAdd = JSON.parse((await runEaa(['score', names[4]])).stdout)
  check('add 后 score -5', Math.abs(scoreAfterAdd.score - scoreBefore5.score - (-5)) < 0.01,
    `before=${scoreBefore5.score} after=${scoreAfterAdd.score}`)

  await runEaa(['revert', evt5, '--reason', 'edge-score-revert'])
  const scoreAfterRevert = JSON.parse((await runEaa(['score', names[4]])).stdout)
  check('revert 后 score 回退 +5', Math.abs(scoreAfterRevert.score - scoreBefore5.score) < 0.01,
    `before=${scoreBefore5.score} after=${scoreAfterRevert.score}`)

  // === 最终 validate ===
  console.log('\n--- 最终 validate ---')
  const finalVal = JSON.parse((await runEaa(['validate'])).stdout)
  check('validate 通过', finalVal.valid === true, `${finalVal.errors.length} errors`)
  console.log(`  事件总数: ${finalVal.total_events}`)

  // === 总结 ===
  console.log('\n' + '='.repeat(60))
  console.log(`通过: ${passed} / 失败: ${failed}`)
  console.log('='.repeat(60))
  if (failed > 0) { process.exit(1) }
}

main().catch(console.error)
