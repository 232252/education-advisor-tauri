// =============================================================
// v3.1.6 add+revert 循环: 验证 daily_dedup cache 一致性
// 流程: add → 重复add(应拒) → revert → 重新add(应成功) → 重复add(应拒)
// 用法: node scripts/test-revert-dedup.mjs
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

// add 命令输出是 text 格式(即使 -O json), 提取 event_id
function extractEventId(stdout) {
  // "✓ 事件已创建: evt_xxx 严华 -2.0"
  const m = stdout.match(/事件已创建:\s*(\S+)/)
  return m ? m[1] : null
}

function isDupRejected(r) {
  return r.exitCode !== 0 && (r.stderr.includes('重复事件') || r.stdout.includes('重复事件'))
}

async function main() {
  console.log('='.repeat(60))
  console.log('add+revert 循环: daily_dedup cache 一致性验证')
  console.log('='.repeat(60))
  console.log('')

  // 用一个不常用的 code 避免和已有数据冲突
  // LAB_CLEAN_UP (-1) 实验室未清理
  const CODE = 'LAB_CLEAN_UP'
  const DELTA = '-1'

  // 取几个学生测试
  const listRes = await runEaa(['list-students'])
  const students = JSON.parse(listRes.stdout).students || []
  const testStudents = [students[0].name, students[30].name, students[60].name]

  let allPass = true
  let testNum = 0

  for (const name of testStudents) {
    testNum++
    console.log(`--- 测试 ${testNum}: ${name} (${CODE}) ---`)

    // 步骤1: add (应该成功, 或被已有数据拒绝)
    const r1 = await runEaa(['add', name, CODE, '--delta', DELTA, '--note', `revert-test-${testNum}`])
    const evtId = extractEventId(r1.stdout)
    console.log(`  1. add: ${Math.round(r1.elapsed)}ms exit=${r1.exitCode} evtId=${evtId || 'null'}`)

    if (evtId) {
      // 步骤2: 重复 add (应该被拒)
      const r2 = await runEaa(['add', name, CODE, '--delta', DELTA, '--note', 'dup'])
      const dup2 = isDupRejected(r2)
      console.log(`  2. 重复 add: ${Math.round(r2.elapsed)}ms exit=${r2.exitCode} 拒绝=${dup2 ? '✓' : '✗ FAIL'}`)
      if (!dup2) allPass = false

      // 步骤3: revert (应该成功)
      const r3 = await runEaa(['revert', evtId, '--reason', `revert-test-${testNum}`])
      console.log(`  3. revert: ${Math.round(r3.elapsed)}ms exit=${r3.exitCode} ${r3.exitCode === 0 ? '✓' : '✗ FAIL'}`)
      if (r3.exitCode !== 0) allPass = false

      // 步骤4: 重新 add (应该成功 — revert 后 cache 递减, 不再拒绝)
      const r4 = await runEaa(['add', name, CODE, '--delta', DELTA, '--note', `re-add-${testNum}`])
      const evtId4 = extractEventId(r4.stdout)
      console.log(`  4. revert后重新add: ${Math.round(r4.elapsed)}ms exit=${r4.exitCode} evtId=${evtId4 || 'null'} ${r4.exitCode === 0 ? '✓' : '✗ FAIL'}`)
      if (r4.exitCode !== 0) allPass = false

      // 步骤5: 重复 add (应该再次被拒)
      if (evtId4) {
        const r5 = await runEaa(['add', name, CODE, '--delta', DELTA, '--note', 'dup2'])
        const dup5 = isDupRejected(r5)
        console.log(`  5. 再次重复add: ${Math.round(r5.elapsed)}ms exit=${r5.exitCode} 拒绝=${dup5 ? '✓' : '✗ FAIL'}`)
        if (!dup5) allPass = false

        // 清理: revert 最后 add 的事件
        const rClean = await runEaa(['revert', evtId4, '--reason', 'cleanup'])
        console.log(`  6. 清理revert: ${Math.round(rClean.elapsed)}ms exit=${rClean.exitCode}`)
      }
    } else {
      // add 被拒(已有当天重复), 用 --force 强制 add
      const r1f = await runEaa(['add', name, CODE, '--delta', DELTA, '--note', `force-${testNum}`, '--force'])
      const evtIdF = extractEventId(r1f.stdout)
      console.log(`  1f. force add: ${Math.round(r1f.elapsed)}ms exit=${r1f.exitCode} evtId=${evtIdF || 'null'}`)
      if (evtIdF) {
        const r3 = await runEaa(['revert', evtIdF, '--reason', `revert-test-${testNum}`])
        console.log(`  3. revert: ${Math.round(r3.elapsed)}ms exit=${r3.exitCode}`)
        // revert 后重新 add (不用 force, 应该成功)
        const r4 = await runEaa(['add', name, CODE, '--delta', DELTA, '--note', `re-add-${testNum}`])
        const evtId4 = extractEventId(r4.stdout)
        console.log(`  4. revert后重新add: ${Math.round(r4.elapsed)}ms exit=${r4.exitCode} evtId=${evtId4 || 'null'} ${r4.exitCode === 0 ? '✓' : '✗ FAIL'}`)
        if (r4.exitCode !== 0) allPass = false
        if (evtId4) { const rc = await runEaa(['revert', evtId4, '--reason', 'cleanup']); console.log(`  6. 清理: exit=${rc.exitCode}`) }
      }
    }
    console.log('')
  }

  // --- 多次 add + 多次 revert 测试 ---
  console.log('--- 测试 4: 多次 add同code(force) + 逐个 revert ---')
  const name4 = students[90].name
  const evtIds = []
  // force add 3 个同 code 事件
  for (let i = 0; i < 3; i++) {
    const r = await runEaa(['add', name4, CODE, '--delta', DELTA, '--note', `multi-${i}`, '--force'])
    const eid = extractEventId(r.stdout)
    if (eid) evtIds.push(eid)
    console.log(`  add #${i + 1}: ${Math.round(r.elapsed)}ms exit=${r.exitCode} evtId=${eid}`)
  }
  // 重复 add (不用 force, 应该被拒 — cache 有记录)
  const rDup = await runEaa(['add', name4, CODE, '--delta', DELTA, '--note', 'dup-multi'])
  console.log(`  重复add(应拒): ${Math.round(rDup.elapsed)}ms exit=${rDup.exitCode} 拒绝=${isDupRejected(rDup) ? '✓' : '✗ FAIL'}`)
  if (!isDupRejected(rDup)) allPass = false

  // 逐个 revert
  for (let i = 0; i < evtIds.length; i++) {
    const r = await runEaa(['revert', evtIds[i], '--reason', `multi-revert-${i}`])
    console.log(`  revert #${i + 1} (${evtIds[i]}): ${Math.round(r.elapsed)}ms exit=${r.exitCode}`)
  }
  // 全部 revert 后, 重新 add (应该成功 — cache 全部递减到 0)
  const rReAdd = await runEaa(['add', name4, CODE, '--delta', DELTA, '--note', 'after-all-revert'])
  const reAddId = extractEventId(rReAdd.stdout)
  console.log(`  全部revert后add: ${Math.round(rReAdd.elapsed)}ms exit=${rReAdd.exitCode} evtId=${reAddId} ${rReAdd.exitCode === 0 ? '✓' : '✗ FAIL'}`)
  if (rReAdd.exitCode !== 0) allPass = false
  if (reAddId) { await runEaa(['revert', reAddId, '--reason', 'cleanup']); console.log('  清理完成') }
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
