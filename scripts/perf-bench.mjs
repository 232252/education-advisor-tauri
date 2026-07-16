// =============================================================
// 性能基准测试 — 测量 EAA CLI 各操作在不同数据量下的耗时
// 用法: node scripts/perf-bench.mjs [data_dir]
// =============================================================

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const EAA = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\core\\eaa-cli\\target\\release\\eaa.exe'
const DATA_DIR = process.argv[2] || 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\test-volume-data\\eaa-data'

function runEaa(args) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const env = { ...process.env, EAA_DATA_DIR: DATA_DIR }
    const proc = spawn(EAA, ['-O', 'json', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('close', () => {
      const elapsed = performance.now() - t0
      resolve({ elapsed, stdout, stderr, exitCode: proc.exitCode })
    })
    proc.on('error', (err) => {
      resolve({ elapsed: performance.now() - t0, stdout: '', stderr: String(err), exitCode: -1 })
    })
  })
}

async function bench(label, args, runs = 3) {
  const results = []
  for (let i = 0; i < runs; i++) {
    const r = await runEaa(args)
    results.push(r.elapsed)
  }
  const min = Math.min(...results)
  const avg = results.reduce((a, b) => a + b, 0) / results.length
  const max = Math.max(...results)
  return { label, args, min: Math.round(min), avg: Math.round(avg), max: Math.round(max), runs }
}

async function main() {
  console.log(`[bench] EAA CLI: ${EAA}`)
  console.log(`[bench] Data dir: ${DATA_DIR}`)
  console.log('')

  // 先获取学生名 (用于 score/history 测试)
  const listRes = await runEaa(['list-students'])
  const listData = JSON.parse(listRes.stdout)
  const students = listData.students || listData.data?.students || []
  // 从 ranking 找分数最低的(通常是事件最多、扣分最多的)
  const rankRes = await runEaa(['ranking', '100'])
  const rankData = JSON.parse(rankRes.stdout)
  const ranking = rankData.ranking || rankData.data?.ranking || []
  const firstStudent = students[0]?.name || '赵伟'
  // 分数最低 = 事件最多(扣分多), 分数最高 = 可能加分多
  const maxEventsStudent = ranking[ranking.length - 1]?.name || firstStudent
  const topStudent = ranking[0]?.name || firstStudent
  console.log(`[bench] 学生数: ${students.length}`)
  console.log(`[bench] 测试学生: ${firstStudent}(首位), ${maxEventsStudent}(末位), ${topStudent}(Top1)`)
  console.log('')

  const benches = [
    ['info', ['info']],
    ['validate', ['validate']],
    ['ranking(100)', ['ranking', '100']],
    ['list-students', ['list-students']],
    [`score(${firstStudent})`, ['score', firstStudent]],
    [`score(${maxEventsStudent})`, ['score', maxEventsStudent]],
    [`history(${firstStudent})`, ['history', firstStudent]],
    [`history(${maxEventsStudent})`, ['history', maxEventsStudent]],
    ['summary', ['summary']],
    ['stats', ['stats']],
  ]

  console.log('操作                       | min(ms) | avg(ms) | max(ms)')
  console.log('---------------------------|---------|---------|--------')

  for (const [label, args] of benches) {
    const r = await bench(label, args, 3)
    const labelPadded = label.padEnd(27)
    console.log(`${labelPadded} | ${String(r.min).padStart(7)} | ${String(r.avg).padStart(7)} | ${String(r.max).padStart(6)}`)
  }

  // 测试 ranking 数据正确性
  const verifyRankRes = await runEaa(['ranking', '100'])
  const verifyRankData = JSON.parse(verifyRankRes.stdout)
  const verifyRanking = verifyRankData.ranking || verifyRankData.data?.ranking || []
  const withClassId = verifyRanking.filter(r => r.class_id).length
  const top1 = verifyRanking[0]
  const last = verifyRanking[verifyRanking.length - 1]
  console.log('')
  console.log(`[verify] ranking: ${verifyRanking.length} 条, ${withClassId} 条有 class_id`)
  console.log(`[verify] Top1: ${top1?.name} = ${top1?.score} (${top1?.class_id})`)
  console.log(`[verify] Last: ${last?.name} = ${last?.score} (${last?.class_id})`)

  // 测试 score 一致性
  const scoreRes = await runEaa(['score', top1.name])
  const scoreData = JSON.parse(scoreRes.stdout)
  const score = scoreData.score ?? scoreData.data?.score
  console.log(`[verify] score(${top1.name}): ${score} (ranking 显示 ${top1.score}) — ${score === top1.score ? '✓ 一致' : '✗ 不一致'}`)
}

main().catch(console.error)
