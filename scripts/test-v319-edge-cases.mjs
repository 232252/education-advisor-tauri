// =============================================================
// v3.1.9 边缘案例测试 — 错误处理、边界条件、异常输入
// =============================================================

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const EAA = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\core\\eaa-cli\\target\\release\\eaa.exe'
const DATA_DIR = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\test-volume-data\\eaa-data'

function runEaa(args, expectFail = false) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const env = { ...process.env, EAA_DATA_DIR: DATA_DIR }
    const proc = spawn(EAA, ['-O', 'json', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('close', () => {
      const elapsed = performance.now() - t0
      const result = { elapsed, stdout, stderr, exitCode: proc.exitCode, args }
      if (expectFail && proc.exitCode === 0) {
        result.warning = 'Expected failure but succeeded'
      } else if (!expectFail && proc.exitCode !== 0) {
        result.warning = `Expected success but failed with exit ${proc.exitCode}`
      }
      resolve(result)
    })
    proc.on('error', (err) => resolve({ elapsed: 0, stdout: '', stderr: String(err), exitCode: -1, args, warning: String(err) }))
  })
}

function check(label, condition, detail = '') {
  const status = condition ? '✓' : '✗'
  console.log(`  ${status} ${label}${detail ? ' — ' + detail : ''}`)
  return condition
}

async function main() {
  console.log('='.repeat(60))
  console.log('v3.1.9 边缘案例测试')
  console.log('='.repeat(60))
  let pass = 0, fail = 0

  // 获取一个实际存在的学生名
  const listRes = await runEaa(['list-students'])
  let testStudent = '测试学生'
  if (listRes.exitCode === 0) {
    try {
      const data = JSON.parse(listRes.stdout)
      if (data.students && data.students.length > 0) {
        testStudent = data.students[0].name
        console.log(`使用学生: ${testStudent}`)
      }
    } catch {}
  }

  // === 1. 错误处理: 不存在的事件 ===
  console.log('\n--- 1. 错误处理: 不存在的事件 ---')
  let r = await runEaa(['revert', 'evt_NONEXISTENT123', '--reason', 'test'], true)
  if (check('revert 不存在的事件 → 失败', r.exitCode !== 0, `exit=${r.exitCode}`)) pass++; else fail++

  r = await runEaa(['history', '不存在的学生名'], true)
  if (check('history 不存在的学生 → 失败', r.exitCode !== 0, `exit=${r.exitCode}`)) pass++; else fail++

  r = await runEaa(['score', '不存在的学生名'], true)
  if (check('score 不存在的学生 → 失败', r.exitCode !== 0, `exit=${r.exitCode}`)) pass++; else fail++

  // === 2. 错误处理: 无效原因码 ===
  console.log('\n--- 2. 错误处理: 无效原因码 ---')
  r = await runEaa(['add', testStudent, 'INVALID_CODE_XYZ', '--delta', '-1', '--force'], true)
  if (check('add 无效原因码 → 失败', r.exitCode !== 0, `exit=${r.exitCode}`)) pass++; else fail++

  // === 3. 双重 revert ===
  console.log('\n--- 3. 双重 revert ---')
  // 先添加一个事件
  r = await runEaa(['add', testStudent, 'LATE', '--delta', '-1', '--note', 'double-revert-test', '--force'])
  let eventId = null
  if (r.exitCode === 0) {
    try { eventId = JSON.parse(r.stdout).event_id } catch {}
  }
  if (eventId) {
    // 第一次 revert (应该成功)
    r = await runEaa(['revert', eventId, '--reason', 'first-revert'])
    if (check('第一次 revert → 成功', r.exitCode === 0, `exit=${r.exitCode}`)) pass++; else fail++

    // 第二次 revert 同一个事件 (应该失败)
    r = await runEaa(['revert', eventId, '--reason', 'second-revert'], true)
    if (check('第二次 revert 同一事件 → 失败', r.exitCode !== 0, `exit=${r.exitCode}, stderr=${r.stderr.slice(0, 100)}`)) pass++; else fail++
  } else {
    console.log('  ⚠ 跳过: 无法创建测试事件')
    fail += 2
  }

  // === 4. revert 一个已经被 revert 的事件 (REVERT 类型) ===
  console.log('\n--- 4. revert REVERT 类型事件 ---')
  // 上面的 revert 操作创建了一个 REVERT 事件, 尝试 revert 它
  // 搜索 revert 事件 (note = 'first-revert')
  r = await runEaa(['search', 'first-revert', '--limit', '5'])
  if (r.exitCode === 0) {
    try {
      const data = JSON.parse(r.stdout)
      const revertEvent = data.events?.find(e => e.reason_code === 'REVERT')
      if (revertEvent) {
        r = await runEaa(['revert', revertEvent.event_id, '--reason', 'revert-a-revert'], true)
        if (check('revert REVERT 事件 → 失败', r.exitCode !== 0, `exit=${r.exitCode}`)) pass++; else fail++
      } else {
        console.log('  ⚠ 跳过: 未找到 REVERT 事件')
        fail++
      }
    } catch {
      console.log('  ⚠ 跳过: search 结果解析失败')
      fail++
    }
  } else {
    fail++
  }

  // === 5. 空查询/边界值 ===
  console.log('\n--- 5. 空查询/边界值 ---')
  r = await runEaa(['search', 'zzzznomatchzzzz', '--limit', '5'])
  if (check('search 无匹配 → 成功 (空结果)', r.exitCode === 0)) {
    try {
      const data = JSON.parse(r.stdout)
      if (check('search 无匹配 → total=0', data.total === 0)) pass++; else fail++
    } catch { fail++ }
  } else fail++

  r = await runEaa(['tag', 'NONEXISTENT_TAG_XYZ'])
  if (check('tag 不存在 → 成功 (空结果)', r.exitCode === 0)) {
    try {
      const data = JSON.parse(r.stdout)
      if (check('tag 不存在 → total=0', data.total === 0)) pass++; else fail++
    } catch { fail++ }
  } else fail++

  r = await runEaa(['range', '2099-01-01', '2099-12-31', '--limit', '5'])
  if (check('range 未来日期 → 成功 (空结果)', r.exitCode === 0)) {
    try {
      const data = JSON.parse(r.stdout)
      if (check('range 未来日期 → total=0', data.total === 0)) pass++; else fail++
    } catch { fail++ }
  } else fail++

  // === 6. 极限参数 ===
  console.log('\n--- 6. 极限参数 ---')
  r = await runEaa(['ranking', '0'])
  if (check('ranking n=0 → 成功', r.exitCode === 0)) pass++; else fail++

  r = await runEaa(['ranking', '999999'])
  if (check('ranking n=999999 → 成功', r.exitCode === 0)) pass++; else fail++

  r = await runEaa(['search', 'a', '--limit', '0'])
  if (check('search limit=0 → 成功', r.exitCode === 0)) pass++; else fail++

  r = await runEaa(['search', 'a', '--limit', '999999'])
  if (check('search limit=999999 → 成功', r.exitCode === 0)) pass++; else fail++

  // === 7. dry_run 不修改数据 ===
  console.log('\n--- 7. dry_run 不修改数据 ---')
  r = await runEaa(['add', testStudent, 'LATE', '--delta', '-1', '--note', 'dry-run-test', '--dry-run', '--force'])
  if (check('add --dry-run → 成功', r.exitCode === 0)) pass++; else fail++

  // 验证 dry-run 事件不存在
  r = await runEaa(['search', 'dry-run-test', '--limit', '5'])
  if (r.exitCode === 0) {
    try {
      const data = JSON.parse(r.stdout)
      if (check('dry-run 事件未写入', data.total === 0)) pass++; else fail++
    } catch { fail++ }
  } else fail++

  r = await runEaa(['revert', 'evt_NONEXISTENT', '--dry-run'], true)
  if (check('revert --dry-run 不存在事件 → 失败', r.exitCode !== 0)) pass++; else fail++

  // === 8. rebuild-cache 命令 ===
  console.log('\n--- 8. rebuild-cache 命令 ---')
  r = await runEaa(['rebuild-cache'])
  if (check('rebuild-cache → 成功', r.exitCode === 0)) {
    try {
      const data = JSON.parse(r.stdout)
      if (check('rebuild-cache 返回学生数', data.students > 0, `students=${data.students}`)) pass++; else fail++
      if (check('rebuild-cache 返回事件数', data.events > 0, `events=${data.events}`)) pass++; else fail++
    } catch { fail += 2 }
  } else fail++

  // === 总结 ===
  console.log('\n' + '='.repeat(60))
  console.log(`边缘案例测试: ${pass} 通过, ${fail} 失败`)
  console.log('='.repeat(60))
}

main().catch(e => {
  console.error('脚本错误:', e)
  process.exit(1)
})
