// =============================================================
// 班级批量测试 — 常见情况 + 极端情况
// 常见: 按班级查询排行榜、批量录入事件、按班级统计
// 极端: 一个班级全部学生大量事件、并发 add、revert 连锁
// =============================================================

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'

const EAA = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\core\\eaa-cli\\target\\release\\eaa.exe'
const TEST_DIR = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\test-volume-data\\eaa-data'

function runEaa(args) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const env = { ...process.env, EAA_DATA_DIR: TEST_DIR }
    const proc = spawn(EAA, ['-O', 'json', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('close', () => {
      resolve({ elapsed: performance.now() - t0, stdout, stderr, exitCode: proc.exitCode })
    })
  })
}

function assert(cond, msg) {
  if (!cond) { console.log(`  ✗ FAIL: ${msg}`); return false }
  console.log(`  ✓ PASS: ${msg}`); return true
}

// 并发执行多个 EAA 命令 (模拟前端并发请求)
function runConcurrent(tasks) {
  return Promise.all(tasks.map(args => runEaa(args)))
}

async function main() {
  console.log('[class-test] 班级批量测试')
  console.log('')

  let allPass = true

  // === 获取学生列表 ===
  const lsRes = await runEaa(['list-students'])
  const lsData = JSON.parse(lsRes.stdout)
  const students = lsData.students || []
  const classC1 = students.filter(s => s.class_id === 'C1')
  const classC2 = students.filter(s => s.class_id === 'C2')
  const classC3 = students.filter(s => s.class_id === 'C3')
  console.log(`[setup] C1=${classC1.length}, C2=${classC2.length}, C3=${classC3.length}`)

  // ============================================================
  // 阶段 A: 常见情况 — 按班级查询排行榜
  // ============================================================
  console.log('\n=== 阶段 A: 按班级查询排行榜 ===')

  // 1. 获取全量 ranking
  const t0 = performance.now()
  const rankRes = await runEaa(['ranking', '100'])
  const rankData = JSON.parse(rankRes.stdout)
  const ranking = rankData.ranking || []
  const rankTime = Math.round(performance.now() - t0)

  // 按班级过滤
  const c1Ranking = ranking.filter(r => r.class_id === 'C1')
  const c2Ranking = ranking.filter(r => r.class_id === 'C2')
  const c3Ranking = ranking.filter(r => r.class_id === 'C3')

  console.log(`[A1] ranking(100) ${rankTime}ms → C1:${c1Ranking.length}, C2:${c2Ranking.length}, C3:${c3Ranking.length}`)
  allPass &= assert(c1Ranking.length + c2Ranking.length + c3Ranking.length === ranking.length,
    '班级人数总和等于排名总数')

  // 2. 验证班级内排名正确 (分数降序)
  const isSorted = (arr) => arr.every((v, i) => i === 0 || arr[i-1].score >= v.score)
  allPass &= assert(isSorted(c1Ranking), 'C1 班级内分数降序')
  allPass &= assert(isSorted(c2Ranking), 'C2 班级内分数降序')
  allPass &= assert(isSorted(c3Ranking), 'C3 班级内分数降序')

  // ============================================================
  // 阶段 B: 常见情况 — 批量录入事件 (模拟班主任录入)
  // ============================================================
  console.log('\n=== 阶段 B: 批量录入事件 ===')

  // 给 C1 班的 5 个学生各录入 1 个事件
  const batchStudents = classC1.slice(0, 5)
  const t1 = performance.now()
  const addResults = []
  for (const s of batchStudents) {
    const r = await runEaa(['add', s.name, 'LATE', '--delta', '-2', '--note', '班级批量测试迟到', '--force'])
    addResults.push({ name: s.name, success: r.exitCode === 0 })
  }
  const batchAddTime = Math.round(performance.now() - t1)
  console.log(`[B1] 串行录入 5 个事件 ${batchAddTime}ms (avg ${Math.round(batchAddTime/5)}ms/个)`)
  allPass &= assert(addResults.every(r => r.success), '5 个事件全部成功')

  // 3. 验证分数增量
  const checkRes = await runEaa(['score', batchStudents[0].name])
  const checkData = JSON.parse(checkRes.stdout)
  allPass &= assert(checkData.score === batchStudents[0].score - 2,
    `${batchStudents[0].name} 分数 ${batchStudents[0].score} → ${checkData.score}`)

  // ============================================================
  // 阶段 C: 常见情况 — 并发查询 (模拟前端同时打开多个面板)
  // ============================================================
  console.log('\n=== 阶段 C: 并发查询 ===')

  const t2 = performance.now()
  const concurrentResults = await runConcurrent([
    ['ranking', '100'],
    ['list-students'],
    ['summary'],
    ['score', batchStudents[0].name],
    ['history', batchStudents[0].name],
  ])
  const concurrentTime = Math.round(performance.now() - t2)
  console.log(`[C1] 5 个并发查询 ${concurrentTime}ms (vs 串行 ${concurrentResults.reduce((a, r) => a + r.elapsed, 0).toFixed(0)}ms)`)
  allPass &= assert(concurrentResults.every(r => r.exitCode === 0), '5 个并发查询全部成功')

  // ============================================================
  // 阶段 D: 极端情况 — 一个班级全部学生大量并发录入
  // ============================================================
  console.log('\n=== 阶段 D: 班级极端 — 全班并发录入 ===')

  // C3 班 25 个学生, 每人并发录入 1 个事件
  const t3 = performance.now()
  const classAddResults = await runConcurrent(
    classC3.map(s => ['add', s.name, 'SPEAK_IN_CLASS', '--delta', '-2', '--note', '全班讲话事件', '--force'])
  )
  const classAddTime = Math.round(performance.now() - t3)
  console.log(`[D1] C3 班 25 人并发录入 ${classAddTime}ms (avg ${Math.round(classAddTime/25)}ms/个)`)
  allPass &= assert(classAddResults.every(r => r.exitCode === 0), '25 人并发录入全部成功')

  // 验证文件锁未导致数据损坏
  const valRes = await runEaa(['validate'])
  const valData = JSON.parse(valRes.stdout)
  allPass &= assert(valData.valid === true, '并发写入后数据仍有效')

  // ============================================================
  // 阶段 E: 极端情况 — revert 连锁
  // ============================================================
  console.log('\n=== 阶段 E: revert 连锁 ===')

  // 获取一个学生最近的事件, 连续 revert 3 个
  const histRes = await runEaa(['history', classC3[0].name])
  const histData = JSON.parse(histRes.stdout)
  const events = histData.events || []
  const toRevert = events.filter(e => !e.reverted).slice(-3)

  if (toRevert.length === 3) {
    const beforeScoreRes = await runEaa(['score', classC3[0].name])
    const beforeScore = JSON.parse(beforeScoreRes.stdout).score

    for (let i = 0; i < 3; i++) {
      const r = await runEaa(['revert', toRevert[i].event_id, '--reason', `连锁撤销 ${i+1}`])
      allPass &= assert(r.exitCode === 0, `revert ${i+1}/${toRevert[i].event_id} 成功`)
    }

    const afterScoreRes = await runEaa(['score', classC3[0].name])
    const afterScore = JSON.parse(afterScoreRes.stdout).score
    const expectedDelta = toRevert.reduce((sum, e) => sum - e.score_delta, 0)
    allPass &= assert(afterScore === beforeScore + expectedDelta,
      `revert 3 个后 score ${beforeScore} → ${afterScore} (期望 ${beforeScore + expectedDelta})`)
  }

  // ============================================================
  // 阶段 F: 极端情况 — 大文件并发读写
  // ============================================================
  console.log('\n=== 阶段 F: 大文件并发读写 ===')

  // 10 个并发读 + 2 个并发写
  const t4 = performance.now()
  const mixedResults = await runConcurrent([
    ['ranking', '100'],
    ['list-students'],
    ['summary'],
    ['score', batchStudents[0].name],
    ['history', batchStudents[0].name],
    ['score', classC3[0].name],
    ['history', classC3[0].name],
    ['ranking', '50'],
    ['add', classC2[0].name, 'LATE', '--delta', '-2', '--note', '混合测试', '--force'],
    ['add', classC2[1].name, 'LATE', '--delta', '-2', '--note', '混合测试', '--force'],
    ['ranking', '100'],
    ['score', classC2[0].name],
  ])
  const mixedTime = Math.round(performance.now() - t4)
  console.log(`[F1] 12 个并发读写 ${mixedTime}ms`)
  allPass &= assert(mixedResults.every(r => r.exitCode === 0), '12 个并发读写全部成功')

  // 最终验证
  const finalVal = await runEaa(['validate'])
  const finalValData = JSON.parse(finalVal.stdout)
  allPass &= assert(finalValData.valid === true, '混合读写后数据仍有效')

  console.log('')
  if (allPass) {
    console.log('[class-test] ✅ 全部通过')
  } else {
    console.log('[class-test] ❌ 存在失败项')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[class-test] FATAL:', err)
  process.exit(1)
})
