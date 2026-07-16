// =============================================================
// 单学生极限事件数测试
// 对一个学生添加大量事件 (目标 10000+), 测试:
//   1. 能添加多少事件稳定运行
//   2. score / history / ranking 在大量事件下是否快速响应
//   3. add 性能随事件数增长是否保持稳定
//   4. validate 在大量事件下是否通过
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
  console.log('单学生极限事件数测试')
  console.log('='.repeat(60))

  // 创建专用测试学生 (避免污染主测试数据)
  const testStudent = '极限测试生'
  console.log(`\n创建测试学生: ${testStudent}`)

  // 先删除已存在的同名学生 (如果有)
  const addStudentRes = await runEaa(['add-student', testStudent])
  if (addStudentRes.exitCode === 0) {
    console.log(`✓ 学生已创建: ${testStudent}`)
  } else {
    console.log(`! 创建学生结果: exit=${addStudentRes.exitCode} stderr=${addStudentRes.stderr.slice(0, 100)}`)
  }

  // 初始 score
  const scoreRes0 = await runEaa(['score', testStudent])
  if (scoreRes0.exitCode === 0) {
    const score0 = JSON.parse(scoreRes0.stdout)
    console.log(`初始分数: ${score0.score}, 事件数: ${score0.events_count}`)
  }

  // === 阶段 1: 快速添加 1000 个事件 ===
  console.log('\n--- 阶段 1: 添加 1000 个事件 ---')
  const DEDUCT_CODES = ['SPEAK_IN_CLASS', 'SLEEP_IN_CLASS', 'LATE', 'MAKEUP', 'DESK_UNALIGNED', 'OTHER_DEDUCT', 'APPEARANCE_VIOLATION']
  const BONUS_CODES = ['ACTIVITY_PARTICIPATION', 'CIVILIZED_DORM', 'MONTHLY_ATTENDANCE']

  // 用不同日期避免 daily_dedup 拦截
  let baseDate = new Date('2024-09-01')
  const BATCH_SIZE = 1000
  const addedIds = []

  for (let batch = 0; batch < 1; batch++) {
    const batchStart = performance.now()
    let ok = 0, dup = 0, err = 0
    for (let i = 0; i < BATCH_SIZE; i++) {
      // 不同日期
      const d = new Date(baseDate)
      d.setDate(d.getDate() + i)
      const dateStr = d.toISOString().slice(0, 10)
      // 设 EAA_TODAY 环境变量绕过 daily_dedup (如果支持) — 否则用不同 reason_code
      const isBonus = i % 5 === 0
      const code = isBonus ? BONUS_CODES[i % BONUS_CODES.length] : DEDUCT_CODES[i % DEDUCT_CODES.length]
      const delta = isBonus ? 1 : -1
      // 通过 --force 绕过 daily_dedup (如果 CLI 支持)
      const r = await runEaa(['add', testStudent, code, '--delta', String(delta), '--note', `batch${batch}-${i}`, '--force'])
      if (r.exitCode === 0) {
        ok++
        // 提取 event_id
        try {
          const data = JSON.parse(r.stdout)
          if (data.event_id) addedIds.push(data.event_id)
        } catch {}
      } else if (r.stderr.includes('重复')) {
        dup++
      } else {
        err++
        if (err < 3) console.log(`  ! add 错误: ${r.stderr.slice(0, 100)}`)
      }
    }
    const batchTime = performance.now() - batchStart
    console.log(`批次 ${batch + 1}: ${ok} 成功, ${dup} 重复, ${err} 错误, 耗时 ${(batchTime / 1000).toFixed(1)}s, 平均 ${(batchTime / BATCH_SIZE).toFixed(0)}ms/op`)
  }

  // === 阶段 2: 检查单学生查询性能 ===
  console.log('\n--- 阶段 2: 查询性能 (单学生大量事件) ---')
  const checkPerf = async (cmd, label) => {
    const times = []
    for (let i = 0; i < 5; i++) {
      const r = await runEaa(cmd)
      times.push(r.elapsed)
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length
    const max = Math.max(...times)
    const min = Math.min(...times)
    console.log(`  ${label}: avg ${avg.toFixed(0)}ms, min ${min.toFixed(0)}ms, max ${max.toFixed(0)}ms`)
    return { avg, min, max }
  }

  await checkPerf(['score', testStudent], 'score')
  await checkPerf(['history', testStudent], 'history')
  await checkPerf(['ranking', '10'], 'ranking(10)')

  // === 阶段 3: 获取学生最终事件数 ===
  const scoreFinal = await runEaa(['score', testStudent])
  if (scoreFinal.exitCode === 0) {
    const s = JSON.parse(scoreFinal.stdout)
    console.log(`\n最终: score=${s.score}, events_count=${s.events_count}`)
  }

  // === 阶段 4: 验证整体数据完整性 ===
  console.log('\n--- 阶段 3: validate 全量验证 ---')
  const valRes = await runEaa(['validate'])
  if (valRes.exitCode === 0) {
    const v = JSON.parse(valRes.stdout)
    console.log(`validate: valid=${v.valid}, total_events=${v.total_events}, errors=${v.errors.length}, warnings=${v.warnings.length}`)
  }

  // === 阶段 5: revert 一些事件, 测试 revert 在大量事件下的性能 ===
  if (addedIds.length > 0) {
    console.log('\n--- 阶段 5: revert 性能 (大量事件下) ---')
    const revertTimes = []
    const revertCount = Math.min(10, addedIds.length)
    for (let i = 0; i < revertCount; i++) {
      const r = await runEaa(['revert', addedIds[i], '--reason', 'limit-test-revert'])
      revertTimes.push(r.elapsed)
      if (r.exitCode !== 0) {
        console.log(`  ! revert ${addedIds[i]} 失败: ${r.stderr.slice(0, 100)}`)
      }
    }
    const avgRevert = revertTimes.reduce((a, b) => a + b, 0) / revertTimes.length
    console.log(`revert ${revertCount} 次: avg ${avgRevert.toFixed(0)}ms, min ${Math.min(...revertTimes).toFixed(0)}ms, max ${Math.max(...revertTimes).toFixed(0)}ms`)
  }

  // === 阶段 6: 全局性能对比 (添加前后) ===
  console.log('\n--- 阶段 6: 全局性能对比 ---')
  await checkPerf(['info'], 'info')
  await checkPerf(['stats'], 'stats')
  await checkPerf(['list-students'], 'list-students')
  await checkPerf(['search', testStudent, '--limit', '10'], 'search(测试生)')

  console.log('\n' + '='.repeat(60))
  console.log('单学生极限事件数测试完成')
  console.log('='.repeat(60))
}

main().catch(e => {
  console.error('测试脚本错误:', e)
  process.exit(1)
})
