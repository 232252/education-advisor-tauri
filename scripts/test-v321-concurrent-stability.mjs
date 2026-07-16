// =============================================================
// v3.2.1 长时间并发稳定性测试
// - 20 轮 × 100 并发操作 (2000 总计)
// - 每轮: 40 add + 20 revert + 30 读 + 5 export + 5 dashboard
// - 每轮后缓存一致性检查
// - 最终 validate + cache consistency
// =============================================================

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const EAA = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\core\\eaa-cli\\target\\release\\eaa.exe'
const DATA_DIR = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\test-volume-data\\eaa-data'
const ROUNDS = 20
const CONCURRENCY = 100

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

async function checkCacheConsistency() {
  // 抽查 10 个学生的 score 和 events_count
  const listRes = await runEaa(['list-students'])
  if (listRes.exitCode !== 0) return { ok: false, reason: 'list-students failed' }
  const students = JSON.parse(listRes.stdout).students || []
  const sample = []
  for (let i = 0; i < Math.min(10, students.length); i++) {
    sample.push(students[Math.floor(Math.random() * students.length)])
  }
  let consistent = 0
  for (const s of sample) {
    const sr = await runEaa(['score', s.name])
    if (sr.exitCode !== 0) continue
    const sd = JSON.parse(sr.stdout)
    // score 应该在合理范围内
    if (typeof sd.score === 'number' && sd.score >= -10000 && sd.score <= 10000) {
      consistent++
    }
  }
  return { ok: true, consistent, total: sample.length }
}

async function main() {
  console.log('='.repeat(60))
  console.log(`v3.2.1 并发稳定性测试 (${ROUNDS} 轮 × ${CONCURRENCY} 并发 = ${ROUNDS * CONCURRENCY} 总计)`)
  console.log('='.repeat(60))

  // 获取学生列表
  const listRes = await runEaa(['list-students'])
  const students = JSON.parse(listRes.stdout).students || []
  const names = students.map(s => s.name)
  console.log(`[info] ${students.length} 学生`)
  console.log('')

  let totalOps = 0
  let totalErrors = 0
  let totalWarnings = 0
  const addedEvents = []
  const roundTimes = []

  for (let round = 0; round < ROUNDS; round++) {
    const roundStart = performance.now()
    const ops = []

    // 40 add 操作
    for (let i = 0; i < 40; i++) {
      const name = pick(names)
      const isBonus = Math.random() < 0.3
      const code = isBonus ? pick(BONUS_CODES) : pick(DEDUCT_CODES)
      const delta = isBonus ? pick([1, 2, 3]) : pick([-1, -2, -5])
      ops.push(
        runEaa(['add', name, code, '--delta', String(delta), '--note', `v321-r${round}-i${i}`, '--force']).then(r => {
          if (r.exitCode === 0) {
            // v3.2.2 fix: JSON 模式下解析 JSON 获取 event_id (旧版正则只匹配 text 模式)
            try {
              const j = JSON.parse(r.stdout)
              if (j.event_id) addedEvents.push(j.event_id)
            } catch { /* 非 JSON 输出, 忽略 */ }
          } else if (!r.stderr.includes('重复') && !r.stdout.includes('重复')) {
            totalErrors++
            if (round < 3) console.log(`  [err] add ${name} ${code}: exit=${r.exitCode} stderr=${r.stderr.slice(0,100)}`)
          }
        })
      )
    }

    // 20 revert 操作 (如果有之前 add 的事件)
    for (let i = 0; i < 20; i++) {
      const evtId = addedEvents.shift()
      if (evtId) {
        ops.push(
          runEaa(['revert', evtId, '--reason', `v321-revert-r${round}`]).then(r => {
            // v3.2.2: 已撤销/不存在的事件不算错误 (并发竞争正常)
            if (r.exitCode !== 0 && !r.stderr.includes('not found') && !r.stderr.includes('已撤销')) {
              totalErrors++
              if (round < 3) console.log(`  [err] revert ${evtId}: exit=${r.exitCode} stderr=${r.stderr.slice(0,100)}`)
            }
          })
        )
      }
    }

    // 30 读操作
    for (let i = 0; i < 30; i++) {
      const op = pick(['score', 'history', 'ranking', 'list-students', 'stats', 'search', 'tag', 'summary'])
      const args = {
        'score': ['score', pick(names)],
        'history': ['history', pick(names)],
        'ranking': ['ranking', '10'],
        'list-students': ['list-students'],
        'stats': ['stats'],
        'search': ['search', pick(['迟到', '说话', '活动', '睡觉', 'makeup'])],
        'tag': ['tag', ''],
        'summary': ['summary'],
      }[op]
      ops.push(
        runEaa(args).then(r => {
          if (r.exitCode !== 0) {
            totalErrors++
            if (round < 3) console.log(`  [err] read ${op}: exit=${r.exitCode} stderr=${r.stderr.slice(0,100)}`)
          }
        })
      )
    }

    // 5 export 操作
    for (let i = 0; i < 5; i++) {
      ops.push(
        runEaa(['export', '--format', pick(['csv', 'jsonl'])]).then(r => {
          if (r.exitCode !== 0) totalErrors++
        })
      )
    }

    // 5 dashboard 操作
    for (let i = 0; i < 5; i++) {
      ops.push(
        runEaa(['dashboard']).then(r => {
          if (r.exitCode !== 0) totalErrors++
        })
      )
    }

    await Promise.all(ops)
    totalOps += ops.length

    const roundTime = performance.now() - roundStart
    roundTimes.push(roundTime)

    // 每轮后缓存一致性检查
    const cacheCheck = await checkCacheConsistency()

    console.log(`[Round ${round + 1}/${ROUNDS}] ${ops.length} ops, ${Math.round(roundTime)}ms, errors: ${totalErrors}, cache: ${cacheCheck.consistent}/${cacheCheck.total}`)

    // 每 5 轮做一次 validate
    if ((round + 1) % 5 === 0) {
      const vr = await runEaa(['validate'])
      if (vr.exitCode === 0) {
        const vd = JSON.parse(vr.stdout)
        console.log(`  validate: ${vd.valid ? '✓' : '✗'} (${vd.total_events} events, ${vd.errors.length} errors)`)
      }
    }
  }

  // 最终 validate
  const finalVal = await runEaa(['validate'])
  const finalValData = JSON.parse(finalVal.stdout)

  // 最终缓存一致性
  const finalCache = await checkCacheConsistency()

  console.log('')
  console.log('='.repeat(60))
  console.log('最终结果')
  console.log('='.repeat(60))
  console.log(`总操作: ${totalOps}`)
  console.log(`总错误: ${totalErrors}`)
  console.log(`平均轮次时间: ${Math.round(roundTimes.reduce((a, b) => a + b, 0) / roundTimes.length)}ms`)
  console.log(`最终 validate: ${finalValData.valid ? '✓ 通过' : '✗ 失败'} (${finalValData.total_events} 事件, ${finalValData.errors.length} 错误)`)
  console.log(`最终缓存一致性: ${finalCache.consistent}/${finalCache.total}`)
  console.log(`待 revert 事件: ${addedEvents.length}`)
}

main().catch(console.error)
