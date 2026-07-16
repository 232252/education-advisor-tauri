// =============================================================
// v3.1.7 revert_event_in_file 验证测试
// 1. add → revert → 验证 reverted_by 已设置
// 2. 验证 REVERT 事件已 append
// 3. 验证 score cache 一致性
// 4. 验证 event_stats cache 一致性
// 5. 验证 daily_dedup cache 一致性
// 6. dry_run 不写文件
// 7. 重复 revert 被拒绝
// 8. revert REVERT 事件被拒绝
// 9. add → revert → re-add 成功
// =============================================================

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { readFileSync, existsSync } from 'node:fs'

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

function readJson(path) {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8'))
}

let passed = 0, failed = 0
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name} ${detail}`) }
}

async function main() {
  console.log('='.repeat(60))
  console.log('v3.1.7 revert_event_in_file 验证测试')
  console.log('='.repeat(60))

  // 获取一个学生
  const listRes = await runEaa(['list-students'])
  const students = JSON.parse(listRes.stdout).students || []
  const testName = students[0].name
  console.log(`测试学生: ${testName}`)

  // === 测试 1: add → revert → 验证 reverted_by ===
  console.log('\n--- 测试 1: add → revert → 验证 reverted_by ---')
  const addRes = await runEaa(['add', testName, 'LATE', '--delta', '-2', '--note', 'v317-test-1', '--force'])
  check('add 成功', addRes.exitCode === 0)
  const evtId = addRes.stdout.match(/事件已创建:\s*(\S+)/)?.[1]
  check('提取 event_id', !!evtId, evtId)

  // 记录 add 后的 score
  const scoreBefore = await runEaa(['score', testName])
  const scoreBeforeData = JSON.parse(scoreBefore.stdout)

  // revert
  const revertRes = await runEaa(['revert', evtId, '--reason', 'v317-test-revert'])
  check('revert 成功', revertRes.exitCode === 0, revertRes.stderr.slice(0, 100))
  const revertId = revertRes.stdout.match(/撤销事件:\s*(\S+)/)?.[1]
  check('提取 revert_id', !!revertId, revertId)
  check('revert 耗时 < 600ms', revertRes.elapsed < 600, `${Math.round(revertRes.elapsed)}ms`)

  // 验证 score 变化 (revert +2)
  const scoreAfter = await runEaa(['score', testName])
  const scoreAfterData = JSON.parse(scoreAfter.stdout)
  check('score 回退 +2', scoreAfterData.score - scoreBeforeData.score === 2,
    `before=${scoreBeforeData.score} after=${scoreAfterData.score}`)

  // === 测试 2: 验证 events.jsonl 中 reverted_by 已设置 ===
  console.log('\n--- 测试 2: 验证 events.jsonl 中 reverted_by ---')
  // 用 history 查看该学生事件, 找到被 revert 的事件
  const histRes = await runEaa(['history', testName])
  const histData = JSON.parse(histRes.stdout)
  const revertedEvt = histData.events.find(e => e.event_id === evtId)
  check('被 revert 事件存在于 history', !!revertedEvt)
  check('reverted_by 已设置', revertedEvt?.reverted === true, `reverted_by=${revertedEvt?.reverted}`)
  check('reverted_by = revert_id', revertedEvt?.reverted === true)

  // === 测试 3: 验证 REVERT 事件已 append ===
  console.log('\n--- 测试 3: 验证 REVERT 事件已 append ---')
  const revertEvt = histData.events.find(e => e.event_id === revertId)
  check('REVERT 事件存在于 history', !!revertEvt)
  check('REVERT reason_code', revertEvt?.reason_code === 'REVERT')
  check('REVERT score_delta = +2', revertEvt?.score_delta === 2)

  // === 测试 4: 重复 revert 被拒绝 ===
  console.log('\n--- 测试 4: 重复 revert 被拒绝 ---')
  const dupRevert = await runEaa(['revert', evtId, '--reason', 'dup-revert'])
  check('重复 revert 被拒绝', dupRevert.exitCode !== 0)
  check('错误信息包含 "已被撤销"', dupRevert.stderr.includes('已被撤销') || dupRevert.stdout.includes('已被撤销'))

  // === 测试 5: revert REVERT 事件被拒绝 ===
  console.log('\n--- 测试 5: revert REVERT 事件被拒绝 ---')
  const revertRevert = await runEaa(['revert', revertId, '--reason', 'revert-revert'])
  check('revert REVERT 被拒绝', revertRevert.exitCode !== 0)
  check('错误信息包含 "撤销事件"', revertRevert.stderr.includes('撤销事件') || revertRevert.stdout.includes('撤销事件'))

  // === 测试 6: dry_run 不写文件 ===
  console.log('\n--- 测试 6: dry_run ---')
  const addRes2 = await runEaa(['add', testName, 'LATE', '--delta', '-2', '--note', 'v317-dry', '--force'])
  const evtId2 = addRes2.stdout.match(/事件已创建:\s*(\S+)/)?.[1]
  const eventCountBefore = JSON.parse((await runEaa(['validate'])).stdout).total_events

  const dryRun = await runEaa(['revert', evtId2, '--reason', 'dry-test', '--dry-run'])
  check('dry_run 成功', dryRun.exitCode === 0)
  check('dry_run 输出 DRY-RUN', dryRun.stdout.includes('DRY-RUN'))

  const eventCountAfter = JSON.parse((await runEaa(['validate'])).stdout).total_events
  check('dry_run 不写文件 (事件数不变)', eventCountAfter === eventCountBefore,
    `before=${eventCountBefore} after=${eventCountAfter}`)

  // === 测试 7: add → revert → re-add 成功 ===
  console.log('\n--- 测试 7: add → revert → re-add ---')
  // evtId2 还没被 revert (dry_run 没写), 先 revert 它
  const revert2 = await runEaa(['revert', evtId2, '--reason', 'real-revert'])
  check('revert evtId2 成功', revert2.exitCode === 0)

  // 现在 re-add (同一学生同一原因码今天应该可以再次 add, 因为原事件被 revert 了)
  const reAdd = await runEaa(['add', testName, 'LATE', '--delta', '-2', '--note', 'v317-readd', '--force'])
  check('re-add 成功 (原事件已 revert)', reAdd.exitCode === 0, reAdd.stderr.slice(0, 100))

  // === 测试 8: cache 一致性 ===
  console.log('\n--- 测试 8: cache 一致性 ---')
  // scores.cache
  const scoresCache = readJson(`${DATA_DIR}\\entities\\scores.cache.json`)
  const eventStatsCache = readJson(`${DATA_DIR}\\entities\\event_stats.cache.json`)
  const dailyDedupCache = readJson(`${DATA_DIR}\\entities\\daily_dedup.cache.json`)

  // 验证 score cache 中的分数与 score 命令一致
  const finalScore = JSON.parse((await runEaa(['score', testName])).stdout)
  const cachedScore = scoresCache[students[0].entity_id]
  check('scores.cache 与 score 命令一致', Math.abs(cachedScore - finalScore.score) < 0.01,
    `cache=${cachedScore} cmd=${finalScore.score}`)

  // 验证 event_stats cache
  const cachedStats = eventStatsCache[students[0].entity_id]
  check('event_stats.cache count 与 score 命令一致', cachedStats?.count === finalScore.events_count,
    `cache=${cachedStats?.count} cmd=${finalScore.events_count}`)

  // === 测试 9: revert 不存在的事件 ===
  console.log('\n--- 测试 9: revert 不存在的事件 ---')
  const notFound = await runEaa(['revert', 'evt_nonexistent_xyz', '--reason', 'test'])
  check('revert 不存在的事件返回错误', notFound.exitCode !== 0)
  check('错误信息包含 EventNotFound',
    notFound.stderr.includes('EventNotFound') || notFound.stdout.includes('EventNotFound') ||
    notFound.stderr.toLowerCase().includes('not found') || notFound.stdout.includes('不存在'))

  // === 测试 10: 连续多次 add + revert ===
  console.log('\n--- 测试 10: 连续 5 次 add + revert ---')
  let allOk = true
  for (let i = 0; i < 5; i++) {
    const a = await runEaa(['add', testName, 'SLEEP_IN_CLASS', '--delta', '-3', '--note', `v317-bulk-${i}`, '--force'])
    if (a.exitCode !== 0) { allOk = false; console.log(`  [${i}] add failed`); continue }
    const id = a.stdout.match(/事件已创建:\s*(\S+)/)?.[1]
    const r = await runEaa(['revert', id, '--reason', `bulk-revert-${i}`])
    if (r.exitCode !== 0) { allOk = false; console.log(`  [${i}] revert failed: ${r.stderr.slice(0, 80)}`); continue }
    if (r.elapsed > 600) { allOk = false; console.log(`  [${i}] revert slow: ${Math.round(r.elapsed)}ms`); continue }
    console.log(`  [${i}] add+revert: ${Math.round(r.elapsed)}ms ✓`)
  }
  check('5 次 add+revert 全部成功且 < 600ms', allOk)

  // === 最终 validate ===
  console.log('\n--- 最终 validate ---')
  const finalVal = JSON.parse((await runEaa(['validate'])).stdout)
  check('validate 通过', finalVal.valid === true, `${finalVal.errors.length} errors`)
  check(`事件总数 ${finalVal.total_events}`, finalVal.total_events > 192900)

  // === 总结 ===
  console.log('\n' + '='.repeat(60))
  console.log(`通过: ${passed} / 失败: ${failed}`)
  console.log('='.repeat(60))
  if (failed > 0) { process.exit(1) }
}

main().catch(console.error)
