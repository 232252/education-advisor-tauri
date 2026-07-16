// =============================================================
// v3.1.9 极端边缘案例测试 — 超长输入、特殊字符、极端参数、新命令
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
  return condition ? 1 : 0
}

async function main() {
  console.log('='.repeat(60))
  console.log('v3.1.9 极端边缘案例测试')
  console.log('='.repeat(60))
  let pass = 0, fail = 0

  const addResult = (r) => { if (r) pass++; else fail++ }

  // 获取学生列表
  const listRes = await runEaa(['list-students'])
  let testStudent = '韩杰', testStudent2 = '费语'
  if (listRes.exitCode === 0) {
    try {
      const data = JSON.parse(listRes.stdout)
      if (data.students && data.students.length > 0) {
        testStudent = data.students[0].name
        testStudent2 = data.students[Math.min(1, data.students.length - 1)].name
        console.log(`使用学生: ${testStudent}, ${testStudent2}`)
      }
    } catch {}
  }

  // === 1. 超长 note 字符串 ===
  console.log('\n--- 1. 超长 note 字符串 ---')
  const longNote = 'A'.repeat(10000)
  let r = await runEaa(['add', testStudent, 'LATE', '--delta', '-1', '--note', longNote, '--force'])
  addResult(check('add 超长 note (10000字符) → 成功', r.exitCode === 0, `exit=${r.exitCode}, ${r.elapsed.toFixed(0)}ms`))

  // 验证超长 note 被正确存储 (用 history 命令查找该学生最近的事件)
  if (r.exitCode === 0) {
    try {
      const d = JSON.parse(r.stdout)
      if (d.event_id) {
        const hr = await runEaa(['history', testStudent])
        if (hr.exitCode === 0) {
          const hd = JSON.parse(hr.stdout)
          const found = hd.events?.find(e => e.event_id === d.event_id)
          addResult(check('超长 note 正确存储', found !== undefined, `found=${!!found}`))
        } else addResult(0)
      } else addResult(0)
    } catch { addResult(0) }
  } else addResult(0)

  // === 2. 特殊字符 note ===
  console.log('\n--- 2. 特殊字符 note ---')
  const specialNotes = [
    { label: 'Unicode中文', note: '测试🎉表情符号✨' },
    { label: '换行符', note: 'line1\nline2\nline3' },
    { label: '引号', note: '包含"双引号"和\'单引号\'' },
    { label: '反斜杠', note: 'path\\to\\file' },
    { label: 'JSON注入', note: '{"key":"value","injection":true}' },
    { label: 'SQL注入', note: "'; DROP TABLE events; --" },
    { label: 'HTML标签', note: '<script>alert("xss")</script>' },
  ]
  for (const { label, note } of specialNotes) {
    r = await runEaa(['add', testStudent, 'LATE', '--delta', '-1', '--note', note, '--force'])
    addResult(check(`add ${label} → 成功`, r.exitCode === 0, `exit=${r.exitCode}`))
  }

  // === 3. 极端 delta 值 ===
  console.log('\n--- 3. 极端 delta 值 ---')
  const deltas = [
    { label: 'delta=0', delta: '0' },
    { label: 'delta=0.001', delta: '0.001' },
    { label: 'delta=-0.001', delta: '-0.001' },
    { label: 'delta=999999', delta: '999999' },
    { label: 'delta=-999999', delta: '-999999' },
  ]
  for (const { label, delta } of deltas) {
    r = await runEaa(['add', testStudent, 'LATE', '--delta', delta, '--note', `delta-test-${label}`, '--force'])
    addResult(check(`add ${label} → 成功`, r.exitCode === 0, `exit=${r.exitCode}`))
  }

  // === 4. 日期范围边界 ===
  console.log('\n--- 4. 日期范围边界 ---')
  r = await runEaa(['range', '2025-01-01', '2025-01-01', '--limit', '10'])
  addResult(check('range 同一天 → 成功', r.exitCode === 0, `exit=${r.exitCode}`))

  r = await runEaa(['range', '2025-12-31', '2025-01-01', '--limit', '10'])
  addResult(check('range 反向日期 (start>end) → 成功(空结果)', r.exitCode === 0, `exit=${r.exitCode}`))

  r = await runEaa(['range', '2025-06-15', '2025-06-15', '--limit', '10'])
  addResult(check('range 单日边界 → 成功', r.exitCode === 0, `exit=${r.exitCode}`))

  // === 5. summary 命令各种参数 ===
  console.log('\n--- 5. summary 命令 ---')
  r = await runEaa(['summary'])
  addResult(check('summary 无参数 → 成功', r.exitCode === 0, `exit=${r.exitCode}, ${r.elapsed.toFixed(0)}ms`))

  r = await runEaa(['summary', '--since', '2025-01-01'])
  addResult(check('summary --since → 成功', r.exitCode === 0, `exit=${r.exitCode}`))

  r = await runEaa(['summary', '--until', '2025-12-31'])
  addResult(check('summary --until → 成功', r.exitCode === 0, `exit=${r.exitCode}`))

  r = await runEaa(['summary', '--since', '2025-06-01', '--until', '2025-06-30'])
  addResult(check('summary --since+--until → 成功', r.exitCode === 0, `exit=${r.exitCode}`))

  r = await runEaa(['summary', '--since', '2099-01-01', '--until', '2099-12-31'])
  addResult(check('summary 未来日期 → 成功(空)', r.exitCode === 0, `exit=${r.exitCode}`))

  // === 6. tag 命令 ===
  console.log('\n--- 6. tag 命令 ---')
  r = await runEaa(['tag', ''])
  addResult(check('tag 空字符串 (列出所有) → 成功', r.exitCode === 0, `exit=${r.exitCode}`))

  r = await runEaa(['tag', 'NONEXISTENT_TAG'])
  addResult(check('tag 不存在 → 成功(空)', r.exitCode === 0, `exit=${r.exitCode}`))

  // === 7. search 多关键词 ===
  console.log('\n--- 7. search 多关键词 ---')
  r = await runEaa(['search', '测试', '学生', '--limit', '5'])
  addResult(check('search 多关键词 → 成功', r.exitCode === 0, `exit=${r.exitCode}`))

  r = await runEaa(['search', 'a', 'b', 'c', 'd', 'e', '--limit', '5'])
  addResult(check('search 5个关键词 → 成功', r.exitCode === 0, `exit=${r.exitCode}`))

  // === 8. set-student-meta 命令 ===
  console.log('\n--- 8. set-student-meta 命令 ---')
  r = await runEaa(['set-student-meta', testStudent, '--group', 'A组', '--role', '班长'])
  addResult(check('set-student-meta group+role → 成功', r.exitCode === 0, `exit=${r.exitCode}`))

  r = await runEaa(['set-student-meta', testStudent, '--class-id', 'CLASS_2025_1'])
  addResult(check('set-student-meta class-id → 成功', r.exitCode === 0, `exit=${r.exitCode}`))

  r = await runEaa(['set-student-meta', testStudent, '--clear-class-id'])
  addResult(check('set-student-meta --clear-class-id → 成功', r.exitCode === 0, `exit=${r.exitCode}`))

  r = await runEaa(['set-student-meta', '不存在的学生名', '--group', 'A'], true)
  addResult(check('set-student-meta 不存在学生 → 失败', r.exitCode !== 0, `exit=${r.exitCode}`))

  // === 9. revert 后再 add 同一 reason_code ===
  console.log('\n--- 9. revert 后再 add 同一 reason_code ===')
  r = await runEaa(['add', testStudent2, 'LATE', '--delta', '-2', '--note', 'revert-readd-test', '--force'])
  let eventId9 = null
  if (r.exitCode === 0) {
    try { eventId9 = JSON.parse(r.stdout).event_id } catch {}
  }
  if (eventId9) {
    // revert
    r = await runEaa(['revert', eventId9, '--reason', 'revert-for-readd'])
    addResult(check('revert 事件 → 成功', r.exitCode === 0, `exit=${r.exitCode}`))

    // 再 add 同一 reason_code (应该成功, 因为前一个被 revert 了)
    r = await runEaa(['add', testStudent2, 'LATE', '--delta', '-2', '--note', 'revert-readd-test', '--force'])
    addResult(check('revert 后再 add 同 reason_code → 成功', r.exitCode === 0, `exit=${r.exitCode}`))
  } else {
    addResult(0); addResult(0)
  }

  // === 10. 连续 add 同一学生不同 reason_code (不应被去重阻止) ===
  console.log('\n--- 10. 连续 add 不同 reason_code ---')
  const codes = ['LATE', 'SLEEP_IN_CLASS', 'SPEAK_IN_CLASS', 'MAKEUP', 'DESK_UNALIGNED']
  let consecutiveOk = 0
  for (const code of codes) {
    r = await runEaa(['add', testStudent, code, '--delta', '-1', '--note', `consecutive-${code}`, '--force'])
    if (r.exitCode === 0) consecutiveOk++
  }
  addResult(check(`连续 add ${codes.length} 个不同 reason_code → 全部成功`, consecutiveOk === codes.length, `${consecutiveOk}/${codes.length}`))

  // === 11. doctor 命令 ===
  console.log('\n--- 11. doctor 命令 ---')
  r = await runEaa(['doctor'])
  addResult(check('doctor → 成功', r.exitCode === 0, `exit=${r.exitCode}`))

  // === 12. codes 命令 ===
  console.log('\n--- 12. codes 命令 ---')
  r = await runEaa(['codes'])
  addResult(check('codes → 成功', r.exitCode === 0, `exit=${r.exitCode}`))

  // === 13. export 命令 ===
  console.log('\n--- 13. export 命令 ---')
  r = await runEaa(['export', '--format', 'csv'])
  addResult(check('export csv → 成功', r.exitCode === 0, `exit=${r.exitCode}, ${r.elapsed.toFixed(0)}ms`))

  r = await runEaa(['export', '--format', 'jsonl'])
  addResult(check('export jsonl → 成功', r.exitCode === 0, `exit=${r.exitCode}`))

  // === 14. 重复 add 被 daily_dedup 阻止 (无 --force) ===
  console.log('\n--- 14. daily_dedup 去重 (无 --force) ---')
  // 先用 --force 添加一个
  r = await runEaa(['add', testStudent, 'SLEEP_IN_CLASS', '--delta', '-1', '--note', 'dedup-test-unique', '--force'])
  addResult(check('首次 add (--force) → 成功', r.exitCode === 0, `exit=${r.exitCode}`))

  // 再不用 --force 添加同一个 (应该被去重阻止)
  r = await runEaa(['add', testStudent, 'SLEEP_IN_CLASS', '--delta', '-1', '--note', 'dedup-test-unique'], true)
  addResult(check('重复 add (无 --force) → 被拒绝', r.exitCode !== 0, `exit=${r.exitCode}`))

  // === 15. validate 后 rebuild-cache 一致性 ===
  console.log('\n--- 15. rebuild-cache 后 validate ---')
  r = await runEaa(['rebuild-cache'])
  addResult(check('rebuild-cache → 成功', r.exitCode === 0, `exit=${r.exitCode}, ${r.elapsed.toFixed(0)}ms`))

  r = await runEaa(['validate'])
  if (r.exitCode === 0) {
    try {
      const v = JSON.parse(r.stdout)
      addResult(check('rebuild-cache 后 validate → valid', v.valid === true, `events=${v.total_events}, errors=${v.errors.length}`))
    } catch { addResult(0) }
  } else addResult(0)

  // === 总结 ===
  console.log('\n' + '='.repeat(60))
  console.log(`极端边缘案例测试: ${pass} 通过, ${fail} 失败`)
  console.log('='.repeat(60))
  if (fail > 0) {
    console.log('失败详情:')
  }
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('脚本错误:', e)
  process.exit(1)
})
