// =============================================================
// v3.1.6 revert cache 一致性 — 干净测试 (用临时学生)
// 流程: add-student → add → 重复add(拒) → revert → re-add(成功) → 重复add(拒)
//       → 多次add(force) → 逐个revert → 全revert后add(成功) → delete-student
// 用法: node scripts/test-revert-clean.mjs
// =============================================================

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'

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
    proc.on('error', () => resolve({ elapsed: 0, stdout: '', stderr: '', exitCode: -1 }))
  })
}

function extractEventId(stdout) {
  const m = stdout.match(/事件已创建:\s*(\S+)/)
  return m ? m[1] : null
}

function isDupRejected(r) {
  return r.exitCode !== 0 && (r.stderr.includes('重复事件') || r.stdout.includes('重复事件'))
}

function getCacheCount(entityId, code) {
  try {
    const cache = JSON.parse(readFileSync(CACHE, 'utf8'))
    const today = new Date().toISOString().slice(0, 10)
    return cache[today]?.[`${entityId}|${code}`] || 0
  } catch { return -1 }
}

async function main() {
  console.log('='.repeat(60))
  console.log('revert cache 一致性 — 干净测试 (临时学生)')
  console.log('='.repeat(60))
  console.log('')

  const TMP_NAME = '测试临时生_' + Date.now().toString().slice(-6)
  const CODE = 'LAB_CLEAN_UP'
  let allPass = true

  // 0. 创建临时学生
  console.log(`[setup] 创建临时学生: ${TMP_NAME}`)
  const addStudentRes = await runEaa(['add-student', TMP_NAME])
  console.log(`  add-student: exit=${addStudentRes.exitCode}`)
  if (addStudentRes.exitCode !== 0) { console.log('  ✗ 创建失败, 退出'); return }

  // 获取 entity_id
  const scoreRes = await runEaa(['score', TMP_NAME])
  const scoreData = JSON.parse(scoreRes.stdout)
  const eid = scoreData.entity_id
  console.log(`  entity_id: ${eid}, score: ${scoreData.score}`)
  console.log('')

  // --- 测试1: add → 重复(拒) → revert → re-add(成功) → 重复(拒) ---
  console.log('--- 测试1: add → revert → re-add 循环 ---')

  // 1. add (应该成功)
  const r1 = await runEaa(['add', TMP_NAME, CODE, '--delta', '-1', '--note', 'test1'])
  const eid1 = extractEventId(r1.stdout)
  const cache1 = getCacheCount(eid, CODE)
  console.log(`  1. add: ${Math.round(r1.elapsed)}ms exit=${r1.exitCode} evtId=${eid1} cache_count=${cache1} ${r1.exitCode === 0 ? '✓' : '✗ FAIL'}`)
  if (r1.exitCode !== 0) allPass = false

  // 2. 重复 add (应该被拒)
  const r2 = await runEaa(['add', TMP_NAME, CODE, '--delta', '-1', '--note', 'dup'])
  const cache2 = getCacheCount(eid, CODE)
  console.log(`  2. 重复add(应拒): ${Math.round(r2.elapsed)}ms exit=${r2.exitCode} cache_count=${cache2} 拒绝=${isDupRejected(r2) ? '✓' : '✗ FAIL'}`)
  if (!isDupRejected(r2)) allPass = false

  // 3. revert (应该成功)
  const r3 = await runEaa(['revert', eid1, '--reason', 'test1-revert'])
  const cache3 = getCacheCount(eid, CODE)
  console.log(`  3. revert: ${Math.round(r3.elapsed)}ms exit=${r3.exitCode} cache_count=${cache3} ${r3.exitCode === 0 ? '✓' : '✗ FAIL'}`)
  if (r3.exitCode !== 0) allPass = false
  // 验证 cache 递减到 0
  if (cache3 !== 0) { console.log(`     ✗ cache 未递减到 0 (期望 0, 实际 ${cache3})`); allPass = false }
  else console.log(`     ✓ cache 正确递减到 0`)

  // 4. re-add (应该成功 — cache 为 0)
  const r4 = await runEaa(['add', TMP_NAME, CODE, '--delta', '-1', '--note', 're-add'])
  const eid4 = extractEventId(r4.stdout)
  const cache4 = getCacheCount(eid, CODE)
  console.log(`  4. re-add(应成功): ${Math.round(r4.elapsed)}ms exit=${r4.exitCode} evtId=${eid4} cache_count=${cache4} ${r4.exitCode === 0 ? '✓' : '✗ FAIL'}`)
  if (r4.exitCode !== 0) allPass = false

  // 5. 重复 add (应该再次被拒)
  const r5 = await runEaa(['add', TMP_NAME, CODE, '--delta', '-1', '--note', 'dup2'])
  const cache5 = getCacheCount(eid, CODE)
  console.log(`  5. 重复add(应拒): ${Math.round(r5.elapsed)}ms exit=${r5.exitCode} cache_count=${cache5} 拒绝=${isDupRejected(r5) ? '✓' : '✗ FAIL'}`)
  if (!isDupRejected(r5)) allPass = false

  // 清理: revert eid4
  await runEaa(['revert', eid4, '--reason', 'cleanup'])
  console.log('')

  // --- 测试2: 多次 add(force) + 逐个 revert + 全 revert 后 add ---
  console.log('--- 测试2: 多次add(force) + 逐个revert ---')
  const evtIds = []
  // force add 3 个
  for (let i = 0; i < 3; i++) {
    const r = await runEaa(['add', TMP_NAME, CODE, '--delta', '-1', '--note', `multi-${i}`, '--force'])
    const id = extractEventId(r.stdout)
    if (id) evtIds.push(id)
    console.log(`  add #${i + 1}: exit=${r.exitCode} evtId=${id}`)
  }
  const cacheAfterAdd = getCacheCount(eid, CODE)
  console.log(`  cache_count (3个add后): ${cacheAfterAdd} ${cacheAfterAdd === 3 ? '✓' : '✗ 期望3'}`)
  if (cacheAfterAdd !== 3) allPass = false

  // 重复 add (应该被拒)
  const rDup = await runEaa(['add', TMP_NAME, CODE, '--delta', '-1', '--note', 'dup'])
  console.log(`  重复add(应拒): 拒绝=${isDupRejected(rDup) ? '✓' : '✗ FAIL'}`)
  if (!isDupRejected(rDup)) allPass = false

  // 逐个 revert
  for (let i = 0; i < evtIds.length; i++) {
    const r = await runEaa(['revert', evtIds[i], '--reason', `multi-revert-${i}`])
    const c = getCacheCount(eid, CODE)
    console.log(`  revert #${i + 1}: exit=${r.exitCode} cache_count=${c} (期望 ${3 - i - 1})`)
    if (r.exitCode !== 0) allPass = false
    if (c !== 3 - i - 1) { console.log(`    ✗ cache 期望 ${3 - i - 1}, 实际 ${c}`); allPass = false }
  }

  // 全部 revert 后, add (应该成功 — cache = 0)
  const rReAdd = await runEaa(['add', TMP_NAME, CODE, '--delta', '-1', '--note', 'after-all-revert'])
  const reAddId = extractEventId(rReAdd.stdout)
  const cacheFinal = getCacheCount(eid, CODE)
  console.log(`  全revert后add(应成功): exit=${rReAdd.exitCode} evtId=${reAddId} cache_count=${cacheFinal} ${rReAdd.exitCode === 0 ? '✓' : '✗ FAIL'}`)
  if (rReAdd.exitCode !== 0) allPass = false
  if (reAddId) await runEaa(['revert', reAddId, '--reason', 'cleanup'])
  console.log('')

  // --- 清理: 删除临时学生 ---
  console.log('[cleanup] 删除临时学生')
  const delRes = await runEaa(['delete-student', TMP_NAME, '--confirm', '--reason', 'test-cleanup'])
  console.log(`  delete-student: exit=${delRes.exitCode}`)
  console.log('')

  // --- 最终 validate ---
  const valRes = await runEaa(['validate'])
  const valData = JSON.parse(valRes.stdout)
  console.log('='.repeat(60))
  console.log(`结果: ${allPass ? '✓ 全部通过' : '✗ 有失败'}`)
  console.log(`validate: ${valData.valid ? '✓' : '✗'} (${valData.total_events} 事件, ${valData.errors.length} 错误)`)
  console.log('='.repeat(60))
}

main().catch(console.error)
