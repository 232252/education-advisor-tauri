// =============================================================
// v3.2.2 班级批量 + 持续压力测试
// 用户指令: 3 个班级, ~100 学生, 单学生最多 1000 事件
// 1. 给未分班学生分配班级 (一一对应)
// 2. 持续添加事件 (每学生 10-1000 不等)
// 3. 班级批量操作测试
// 4. 性能监控 (score/history/ranking)
// 5. 持续运行直到手动停止
// =============================================================

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const EAA = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\core\\eaa-cli\\target\\release\\eaa.exe'
const DATA_DIR = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\test-volume-data\\eaa-data'

const CLASS_IDS = ['C1', 'C2', 'C3']
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function getStudents() {
  const r = await runEaa(['list-students'])
  if (r.exitCode !== 0) return []
  try { return JSON.parse(r.stdout).students || [] } catch { return [] }
}

async function assignUnassignedStudents(students) {
  const unassigned = students.filter(s => !s.class_id)
  if (unassigned.length === 0) {
    console.log('  ✓ 所有学生已有班级')
    return 0
  }
  console.log(`  发现 ${unassigned.length} 个未分班学生, 正在分配...`)
  let assigned = 0
  for (const s of unassigned) {
    const classId = pick(CLASS_IDS)
    const r = await runEaa(['set-student-meta', s.name, '--class-id', classId])
    if (r.exitCode === 0) assigned++
    else console.log(`    ✗ ${s.name} 分配失败: ${r.stderr.slice(0, 80)}`)
  }
  console.log(`  ✓ 已分配 ${assigned}/${unassigned.length}`)
  return assigned
}

async function classBatchTest(students) {
  console.log('\n[Phase 3] 班级批量操作测试...')
  const classGroups = {}
  for (const cid of CLASS_IDS) {
    classGroups[cid] = students.filter(s => s.class_id === cid)
  }
  for (const cid of CLASS_IDS) {
    console.log(`  ${cid}: ${classGroups[cid].length} 学生`)
  }

  // 批量添加事件到同一班级的学生 (模拟批量录入)
  const batchClass = pick(CLASS_IDS)
  const batchStudents = classGroups[batchClass].slice(0, 10)
  console.log(`  批量录入: 班级 ${batchClass}, ${batchStudents.length} 学生`)
  const t0 = performance.now()
  let batchOk = 0
  for (const s of batchStudents) {
    const code = pick(DEDUCT_CODES)
    const delta = pick([-1, -2, -5])
    const r = await runEaa(['add', s.name, code, '--delta', String(delta), '--note', `batch-${batchClass}`, '--force'])
    if (r.exitCode === 0) batchOk++
  }
  const batchTime = performance.now() - t0
  console.log(`  ✓ 批量录入完成: ${batchOk}/${batchStudents.length}, ${Math.round(batchTime)}ms`)

  // 按班级查询排行榜
  const rankR = await runEaa(['ranking', '20'])
  if (rankR.exitCode === 0) {
    const rankData = JSON.parse(rankR.stdout)
    const topByClass = {}
    for (const r of rankData.ranking) {
      const cid = r.class_id || '未分班'
      if (!topByClass[cid]) topByClass[cid] = []
      if (topByClass[cid].length < 5) topByClass[cid].push(r)
    }
    for (const cid of CLASS_IDS) {
      console.log(`  ${cid} Top3: ${topByClass[cid]?.slice(0, 3).map(r => `${r.name}=${r.score}`).join(', ') || 'N/A'}`)
    }
  }
}

async function continuousStressTest(students, durationMin = 10) {
  console.log(`\n[Phase 4] 持续压力测试 (${durationMin} 分钟)...`)
  const endTime = Date.now() + durationMin * 60 * 1000
  let totalOps = 0
  let totalErrors = 0
  const addedEvents = []
  const perfSamples = { add: [], score: [], history: [], ranking: [] }
  let round = 0

  while (Date.now() < endTime) {
    round++
    const ops = []
    const roundStudents = []

    // 30 add 操作
    for (let i = 0; i < 30; i++) {
      const s = pick(students)
      const isBonus = Math.random() < 0.3
      const code = isBonus ? pick(BONUS_CODES) : pick(DEDUCT_CODES)
      const delta = isBonus ? pick([1, 2, 3]) : pick([-1, -2, -5])
      ops.push(
        runEaa(['add', s.name, code, '--delta', String(delta), '--note', `stress-r${round}-i${i}`, '--force']).then(r => {
          if (r.exitCode === 0) {
            try { const j = JSON.parse(r.stdout); if (j.event_id) addedEvents.push(j.event_id) } catch {}
          } else if (!r.stderr.includes('重复')) totalErrors++
          perfSamples.add.push(r.elapsed)
        })
      )
      roundStudents.push(s)
    }

    // 10 revert 操作
    for (let i = 0; i < 10; i++) {
      const evtId = addedEvents.shift()
      if (evtId) {
        ops.push(
          runEaa(['revert', evtId, '--reason', `revert-r${round}`]).then(r => {
            if (r.exitCode !== 0 && !r.stderr.includes('not found') && !r.stderr.includes('已撤销')) totalErrors++
          })
        )
      }
    }

    // 20 读操作
    for (let i = 0; i < 20; i++) {
      const s = pick(students)
      const op = pick(['score', 'history', 'ranking'])
      const args = op === 'ranking' ? ['ranking', '20'] : [op, s.name]
      ops.push(
        runEaa(args).then(r => {
          if (r.exitCode !== 0) totalErrors++
          perfSamples[op].push(r.elapsed)
        })
      )
    }

    await Promise.all(ops)
    totalOps += ops.length

    // 每 5 轮报告
    if (round % 5 === 0) {
      const avg = (arr) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0
      const elapsed = Math.round((Date.now() - (endTime - durationMin * 60 * 1000)) / 1000)
      console.log(`  [Round ${round}] ${totalOps} ops, ${totalErrors} errors, ${elapsed}s elapsed | add ${avg(perfSamples.add.slice(-30))}ms score ${avg(perfSamples.score.slice(-20))}ms history ${avg(perfSamples.history.slice(-20))}ms ranking ${avg(perfSamples.ranking.slice(-20))}ms`)
    }

    // 每 10 轮 validate
    if (round % 10 === 0) {
      const vr = await runEaa(['validate'])
      if (vr.exitCode === 0) {
        const vd = JSON.parse(vr.stdout)
        console.log(`    validate: ${vd.valid ? '✓' : '✗'} (${vd.total_events} events, ${vd.errors.length} errors)`)
      }
    }
  }

  console.log(`\n  压力测试完成: ${totalOps} ops, ${totalErrors} errors, ${round} rounds`)
  return { totalOps, totalErrors, round }
}

async function main() {
  console.log('='.repeat(60))
  console.log('v3.2.2 班级批量 + 持续压力测试')
  console.log('='.repeat(60))

  // Phase 1: 获取学生列表 + 分配未分班学生
  console.log('\n[Phase 1] 加载学生列表...')
  let students = await getStudents()
  console.log(`  ${students.length} 学生`)

  console.log('\n[Phase 2] 确保学生-班级一一对应...')
  await assignUnassignedStudents(students)
  students = await getStudents()
  const unassigned = students.filter(s => !s.class_id).length
  console.log(`  ✓ ${students.length} 学生, ${unassigned} 未分班`)

  // Phase 3: 班级批量操作测试
  await classBatchTest(students)

  // Phase 4: 持续压力测试 (10 分钟一轮, 循环执行)
  console.log('\n[Phase 4] 持续压力测试 (循环直到手动停止)...')
  let totalAllOps = 0
  let totalAllErrors = 0
  let cycle = 0
  while (true) {
    cycle++
    console.log(`\n--- 压力测试循环 #${cycle} ---`)
    const result = await continuousStressTest(students, 10)
    totalAllOps += result.totalOps
    totalAllErrors += result.totalErrors

    // 每轮循环后做缓存一致性检查
    console.log('\n  缓存一致性检查...')
    const refreshStudents = await getStudents()
    let consistent = 0
    let checked = 0
    for (let i = 0; i < Math.min(20, refreshStudents.length); i++) {
      const s = refreshStudents[Math.floor(Math.random() * refreshStudents.length)]
      const sr = await runEaa(['score', s.name])
      if (sr.exitCode === 0) {
        const sd = JSON.parse(sr.stdout)
        if (typeof sd.score === 'number' && sd.score >= -10000 && sd.score <= 10000) consistent++
      }
      checked++
    }
    console.log(`  缓存一致性: ${consistent}/${checked}`)
    console.log(`  累计: ${totalAllOps} ops, ${totalAllErrors} errors, ${cycle} cycles`)
  }
}

main().catch(console.error)
