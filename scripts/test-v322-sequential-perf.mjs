// =============================================================
// v3.2.2 单线程顺序性能测试 (无并发竞争)
// 测量真实单操作延迟, 排除 FileLock 串行化等待
// =============================================================

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const EAA = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\core\\eaa-cli\\target\\release\\eaa.exe'
const DATA_DIR = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\test-volume-data\\eaa-data'

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
function avg(arr) { return arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0 }
function p95(arr) {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return Math.round(sorted[Math.floor(sorted.length * 0.95)])
}

async function getStudents() {
  const r = await runEaa(['list-students'])
  if (r.exitCode !== 0) return []
  try { return JSON.parse(r.stdout).students || [] } catch { return [] }
}

async function main() {
  console.log('='.repeat(60))
  console.log('v3.2.2 单线程顺序性能测试 (无并发)')
  console.log('='.repeat(60))

  const students = await getStudents()
  console.log(`学生数: ${students.length}\n`)

  const samples = { add: [], score: [], history: [], ranking: [], stats: [], search: [], export: [], dashboard: [], validate: [] }
  const addedEvents = []
  let errors = 0

  // 测试 1: 顺序 add (100 次)
  console.log('[1] 顺序 add (100 次)...')
  for (let i = 0; i < 100; i++) {
    const s = pick(students)
    const isBonus = Math.random() < 0.3
    const code = isBonus ? pick(BONUS_CODES) : pick(DEDUCT_CODES)
    const delta = isBonus ? pick([1, 2, 3]) : pick([-1, -2, -5])
    const r = await runEaa(['add', s.name, code, '--delta', String(delta), '--note', `seq-${i}`, '--force'])
    if (r.exitCode === 0) {
      samples.add.push(r.elapsed)
      try { const j = JSON.parse(r.stdout); if (j.event_id) addedEvents.push(j.event_id) } catch {}
    } else errors++
  }
  console.log(`  add: avg ${avg(samples.add)}ms, p95 ${p95(samples.add)}ms, ${errors} errors`)

  // 测试 2: 顺序 score (50 次)
  console.log('[2] 顺序 score (50 次)...')
  for (let i = 0; i < 50; i++) {
    const s = pick(students)
    const r = await runEaa(['score', s.name])
    if (r.exitCode === 0) samples.score.push(r.elapsed)
    else errors++
  }
  console.log(`  score: avg ${avg(samples.score)}ms, p95 ${p95(samples.score)}ms`)

  // 测试 3: 顺序 history (30 次, 大事件量学生)
  console.log('[3] 顺序 history (30 次)...')
  for (let i = 0; i < 30; i++) {
    const s = pick(students)
    const r = await runEaa(['history', s.name])
    if (r.exitCode === 0) samples.history.push(r.elapsed)
    else errors++
  }
  console.log(`  history: avg ${avg(samples.history)}ms, p95 ${p95(samples.history)}ms`)

  // 测试 4: ranking (30 次)
  console.log('[4] 顺序 ranking (30 次)...')
  for (let i = 0; i < 30; i++) {
    const r = await runEaa(['ranking', '50'])
    if (r.exitCode === 0) samples.ranking.push(r.elapsed)
  }
  console.log(`  ranking: avg ${avg(samples.ranking)}ms, p95 ${p95(samples.ranking)}ms`)

  // 测试 5: stats (20 次)
  console.log('[5] 顺序 stats (20 次)...')
  for (let i = 0; i < 20; i++) {
    const r = await runEaa(['stats'])
    if (r.exitCode === 0) samples.stats.push(r.elapsed)
  }
  console.log(`  stats: avg ${avg(samples.stats)}ms, p95 ${p95(samples.stats)}ms`)

  // 测试 6: search (20 次)
  console.log('[6] 顺序 search (20 次)...')
  const keywords = ['迟到', '说话', '活动', '睡觉', 'makeup', '课堂', '宿舍', '出勤']
  for (let i = 0; i < 20; i++) {
    const r = await runEaa(['search', pick(keywords)])
    if (r.exitCode === 0) samples.search.push(r.elapsed)
  }
  console.log(`  search: avg ${avg(samples.search)}ms, p95 ${p95(samples.search)}ms`)

  // 测试 7: export (10 次)
  console.log('[7] 顺序 export (10 次)...')
  for (let i = 0; i < 10; i++) {
    const r = await runEaa(['export', '--format', 'jsonl'])
    if (r.exitCode === 0) samples.export.push(r.elapsed)
  }
  console.log(`  export: avg ${avg(samples.export)}ms, p95 ${p95(samples.export)}ms`)

  // 测试 8: dashboard (10 次)
  console.log('[8] 顺序 dashboard (10 次)...')
  for (let i = 0; i < 10; i++) {
    const r = await runEaa(['dashboard'])
    if (r.exitCode === 0) samples.dashboard.push(r.elapsed)
  }
  console.log(`  dashboard: avg ${avg(samples.dashboard)}ms, p95 ${p95(samples.dashboard)}ms`)

  // 测试 9: revert (50 次)
  console.log('[9] 顺序 revert (50 次)...')
  const revertSamples = []
  for (let i = 0; i < 50; i++) {
    const evtId = addedEvents.shift()
    if (!evtId) break
    const r = await runEaa(['revert', evtId, '--reason', `seq-revert-${i}`])
    if (r.exitCode === 0) revertSamples.push(r.elapsed)
  }
  console.log(`  revert: avg ${avg(revertSamples)}ms, p95 ${p95(revertSamples)}ms`)

  // 测试 10: validate (5 次)
  console.log('[10] 顺序 validate (5 次)...')
  for (let i = 0; i < 5; i++) {
    const r = await runEaa(['validate'])
    if (r.exitCode === 0) samples.validate.push(r.elapsed)
  }
  console.log(`  validate: avg ${avg(samples.validate)}ms, p95 ${p95(samples.validate)}ms`)

  // 汇总
  console.log('\n' + '='.repeat(60))
  console.log('单线程顺序性能汇总 (225K+ 事件)')
  console.log('='.repeat(60))
  console.log(`  add:       avg ${avg(samples.add)}ms  p95 ${p95(samples.add)}ms`)
  console.log(`  score:     avg ${avg(samples.score)}ms  p95 ${p95(samples.score)}ms`)
  console.log(`  history:   avg ${avg(samples.history)}ms  p95 ${p95(samples.history)}ms`)
  console.log(`  ranking:   avg ${avg(samples.ranking)}ms  p95 ${p95(samples.ranking)}ms`)
  console.log(`  stats:     avg ${avg(samples.stats)}ms  p95 ${p95(samples.stats)}ms`)
  console.log(`  search:    avg ${avg(samples.search)}ms  p95 ${p95(samples.search)}ms`)
  console.log(`  export:    avg ${avg(samples.export)}ms  p95 ${p95(samples.export)}ms`)
  console.log(`  dashboard: avg ${avg(samples.dashboard)}ms  p95 ${p95(samples.dashboard)}ms`)
  console.log(`  revert:    avg ${avg(revertSamples)}ms  p95 ${p95(revertSamples)}ms`)
  console.log(`  validate:  avg ${avg(samples.validate)}ms  p95 ${p95(samples.validate)}ms`)
  console.log(`  errors: ${errors}`)
}

main().catch(console.error)
