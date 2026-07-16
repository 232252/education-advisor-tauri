// =============================================================
// v3.1.6 持续压力测试
// - 500+ 次随机操作 (add/score/history/ranking/list-students/summary)
// - add+revert 循环验证 daily_dedup cache 一致性
// - 并发读写混合
// - 定期 validate 全量校验
// 用法: node scripts/stress-test-v316.mjs [总次数, 默认 500]
// =============================================================

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const EAA = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\core\\eaa-cli\\target\\release\\eaa.exe'
const DATA_DIR = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\test-volume-data\\eaa-data'
const TOTAL = parseInt(process.argv[2] || '500', 10)

const DEDUCT_CODES = ['SPEAK_IN_CLASS', 'SLEEP_IN_CLASS', 'LATE', 'MAKEUP', 'DESK_UNALIGNED', 'OTHER_DEDUCT', 'APPEARANCE_VIOLATION']
const BONUS_CODES = ['ACTIVITY_PARTICIPATION', 'CIVILIZED_DORM', 'MONTHLY_ATTENDANCE']

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
  console.log(`v3.1.6 持续压力测试 (${TOTAL} 次操作)`)
  console.log('='.repeat(60))

  // 获取学生列表
  const listRes = await runEaa(['list-students'])
  const students = JSON.parse(listRes.stdout).students || []
  const names = students.map(s => s.name)
  console.log(`[info] ${students.length} 学生, ${TOTAL} 次操作`)
  console.log('')

  const stats = {
    add: { count: 0, time: 0, ok: 0, dup: 0 },
    score: { count: 0, time: 0 },
    history: { count: 0, time: 0 },
    ranking: { count: 0, time: 0 },
    list: { count: 0, time: 0 },
    summary: { count: 0, time: 0 },
    validate: { count: 0, time: 0, valid: 0 },
    revert: { count: 0, time: 0, ok: 0 },
  }

  const addedEvents = [] // 记录 add 成功的 event_id, 用于 revert 测试
  let errors = []
  let lastValidateOk = true

  for (let i = 0; i < TOTAL; i++) {
    const phase = i % 10
    let op, r

    if (phase === 0 && i > 0 && addedEvents.length > 0) {
      // revert 测试: revert 之前 add 的事件
      const evtId = addedEvents.shift()
      r = await runEaa(['revert', evtId, '--reason', 'stress-test-revert'])
      stats.revert.count++
      stats.revert.time += r.elapsed
      if (r.exitCode === 0) stats.revert.ok++
      op = `revert ${evtId}`
    } else if (phase === 1) {
      // add 测试
      const name = pick(names)
      const isBonus = Math.random() < 0.3
      const code = isBonus ? pick(BONUS_CODES) : pick(DEDUCT_CODES)
      const delta = isBonus ? pick([1, 2, 3]) : pick([-1, -2, -5])
      r = await runEaa(['add', name, code, '--delta', String(delta), '--note', `stress-${i}`])
      stats.add.count++
      stats.add.time += r.elapsed
      if (r.exitCode === 0) {
        stats.add.ok++
        // 提取 event_id
        const m = r.stdout.match(/事件已创建:\s*(\S+)/)
        if (m) addedEvents.push(m[1])
      } else if (r.stderr.includes('重复') || r.stdout.includes('重复')) {
        stats.add.dup++
      }
      op = `add ${name} ${code}`
    } else if (phase === 2) {
      r = await runEaa(['score', pick(names)])
      stats.score.count++; stats.score.time += r.elapsed
      op = 'score'
    } else if (phase === 3) {
      r = await runEaa(['history', pick(names)])
      stats.history.count++; stats.history.time += r.elapsed
      op = 'history'
    } else if (phase === 4) {
      r = await runEaa(['ranking', '20'])
      stats.ranking.count++; stats.ranking.time += r.elapsed
      op = 'ranking'
    } else if (phase === 5) {
      r = await runEaa(['list-students'])
      stats.list.count++; stats.list.time += r.elapsed
      op = 'list-students'
    } else if (phase === 6) {
      r = await runEaa(['summary'])
      stats.summary.count++; stats.summary.time += r.elapsed
      op = 'summary'
    } else if (phase === 7) {
      // add (第二次, 更多 add)
      const name = pick(names)
      const code = pick(DEDUCT_CODES)
      r = await runEaa(['add', name, code, '--delta', '-2', '--note', `stress-${i}`])
      stats.add.count++; stats.add.time += r.elapsed
      if (r.exitCode === 0) { stats.add.ok++; const m = r.stdout.match(/事件已创建:\s*(\S+)/); if (m) addedEvents.push(m[1]) }
      else if (r.stderr.includes('重复') || r.stdout.includes('重复')) stats.add.dup++
      op = `add ${name} ${code}`
    } else if (phase === 8) {
      // 并发 5 个查询
      const t0 = performance.now()
      await Promise.all([
        runEaa(['score', pick(names)]),
        runEaa(['score', pick(names)]),
        runEaa(['ranking', '10']),
        runEaa(['list-students']),
        runEaa(['score', pick(names)]),
      ])
      r = { elapsed: performance.now() - t0, exitCode: 0 }
      stats.score.count += 3; stats.ranking.count++; stats.list.count++
      op = 'concurrent-5'
    } else {
      // validate (每 10 次一次)
      r = await runEaa(['validate'])
      stats.validate.count++; stats.validate.time += r.elapsed
      try {
        const vd = JSON.parse(r.stdout)
        if (vd.valid) stats.validate.valid++
        else { errors.push(`validate 失败 @${i}: ${vd.errors.slice(0, 3).join('; ')}`); lastValidateOk = false }
      } catch { errors.push(`validate 解析失败 @${i}`) }
      op = 'validate'
    }

    // 进度报告 (每 50 次)
    if ((i + 1) % 50 === 0) {
      const avgAdd = stats.add.count > 0 ? Math.round(stats.add.time / stats.add.count) : 0
      const avgScore = stats.score.count > 0 ? Math.round(stats.score.time / stats.score.count) : 0
      console.log(`[${i + 1}/${TOTAL}] add:${avgAdd}ms score:${avgScore}ms validate_ok:${stats.validate.valid}/${stats.validate.count} errors:${errors.length}`)
    }

    // 错误收集
    if (r && r.exitCode !== 0 && !op.startsWith('add') && !op.startsWith('revert')) {
      errors.push(`@${i} ${op} exit=${r.exitCode}: ${r.stderr.slice(0, 100)}`)
    }
  }

  // 最终 validate
  const finalVal = await runEaa(['validate'])
  const finalValData = JSON.parse(finalVal.stdout)
  console.log('')
  console.log('='.repeat(60))
  console.log('最终结果')
  console.log('='.repeat(60))
  console.log(`总操作: ${TOTAL}`)
  console.log(`add: ${stats.add.count} 次 (成功 ${stats.add.ok}, 重复拒绝 ${stats.add.dup}), 平均 ${stats.add.count > 0 ? Math.round(stats.add.time / stats.add.count) : 0}ms`)
  console.log(`revert: ${stats.revert.count} 次 (成功 ${stats.revert.ok}), 平均 ${stats.revert.count > 0 ? Math.round(stats.revert.time / stats.revert.count) : 0}ms`)
  console.log(`score: ${stats.score.count} 次, 平均 ${stats.score.count > 0 ? Math.round(stats.score.time / stats.score.count) : 0}ms`)
  console.log(`history: ${stats.history.count} 次, 平均 ${stats.history.count > 0 ? Math.round(stats.history.time / stats.history.count) : 0}ms`)
  console.log(`ranking: ${stats.ranking.count} 次, 平均 ${stats.ranking.count > 0 ? Math.round(stats.ranking.time / stats.ranking.count) : 0}ms`)
  console.log(`list-students: ${stats.list.count} 次, 平均 ${stats.list.count > 0 ? Math.round(stats.list.time / stats.list.count) : 0}ms`)
  console.log(`summary: ${stats.summary.count} 次, 平均 ${stats.summary.count > 0 ? Math.round(stats.summary.time / stats.summary.count) : 0}ms`)
  console.log(`validate: ${stats.validate.count} 次 (${stats.validate.valid} 通过), 平均 ${stats.validate.count > 0 ? Math.round(stats.validate.time / stats.validate.count) : 0}ms`)
  console.log(`最终 validate: ${finalValData.valid ? '✓ 通过' : '✗ 失败'} (${finalValData.total_events} 事件, ${finalValData.errors.length} 错误)`)
  console.log(`错误数: ${errors.length}`)
  if (errors.length > 0) {
    console.log('错误详情 (前 10):')
    errors.slice(0, 10).forEach(e => console.log(`  ${e}`))
  }
  console.log(`待 revert 事件: ${addedEvents.length} (未 revert)`)

  // score 一致性抽查
  console.log('')
  console.log('--- score 一致性抽查 ---')
  const checkNames = [pick(names), pick(names), pick(names)]
  for (const name of checkNames) {
    const sr = await runEaa(['score', name])
    const sd = JSON.parse(sr.stdout)
    console.log(`  ${name}: score=${sd.score} events=${sd.events_count}`)
  }
}

main().catch(console.error)
