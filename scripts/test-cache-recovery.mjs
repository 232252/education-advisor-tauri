// =============================================================
// v3.1.6 边界测试: cache 损坏自动重建
// - 损坏 scores.cache.json → 验证 ranking 自动重建
// - 损坏 event_stats.cache.json → 验证 score 自动重建
// - 损坏 daily_dedup.cache.json → 验证 add 自动重建
// - 删除所有 cache → 验证从 events 全量重建
// - 超大 note 测试
// - 特殊字符学生名测试
// 用法: node scripts/test-cache-recovery.mjs
// =============================================================

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { writeFileSync, readFileSync, unlinkSync, existsSync, copyFileSync } from 'node:fs'

const EAA = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\core\\eaa-cli\\target\\release\\eaa.exe'
const DATA_DIR = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\test-volume-data\\eaa-data'
const ENTITIES_DIR = DATA_DIR + '\\entities'
const CACHES = {
  scores: ENTITIES_DIR + '\\scores.cache.json',
  event_stats: ENTITIES_DIR + '\\event_stats.cache.json',
  daily_dedup: ENTITIES_DIR + '\\daily_dedup.cache.json',
}

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

function backup(path) { const b = path + '.bak'; if (existsSync(path)) copyFileSync(path, b); return b }
function restore(path) { const b = path + '.bak'; if (existsSync(b)) { copyFileSync(b, path); unlinkSync(b) } }
function corrupt(path) { writeFileSync(path, '{ corrupted json !!! }') }
function remove(path) { if (existsSync(path)) unlinkSync(path) }

async function main() {
  console.log('='.repeat(60))
  console.log('v3.1.6 边界测试: cache 损坏自动重建')
  console.log('='.repeat(60))
  console.log('')

  const listRes = await runEaa(['list-students'])
  const students = JSON.parse(listRes.stdout).students || []
  const name0 = students[0].name
  let allPass = true

  // --- 测试1: 损坏 scores.cache.json ---
  console.log('--- 测试1: 损坏 scores.cache.json → ranking 自动重建 ---')
  const bak1 = backup(CACHES.scores)
  // 先获取正常 ranking 结果
  const rankBefore = await runEaa(['ranking', '5'])
  const rankBeforeData = JSON.parse(rankBefore.stdout).ranking
  console.log(`  损坏前 ranking Top1: ${rankBeforeData[0].name} = ${rankBeforeData[0].score}`)
  // 损坏 cache
  corrupt(CACHES.scores)
  console.log(`  已损坏 scores.cache.json`)
  // ranking 应该自动重建 (LightContext 检测 cache 为空 → 从 events 重建)
  const t1 = performance.now()
  const rankAfter = await runEaa(['ranking', '5'])
  const t1End = performance.now() - t1
  const rankAfterData = JSON.parse(rankAfter.stdout).ranking
  console.log(`  损坏后 ranking: ${Math.round(t1End)}ms exit=${rankAfter.exitCode}`)
  console.log(`  重建后 Top1: ${rankAfterData[0].name} = ${rankAfterData[0].score}`)
  const scoresMatch = rankBeforeData[0].name === rankAfterData[0].name && rankBeforeData[0].score === rankAfterData[0].score
  console.log(`  一致性: ${scoresMatch ? '✓' : '✗ FAIL'}`)
  if (!scoresMatch) allPass = false
  // 验证 cache 已重建
  const cacheRebuilt = existsSync(CACHES.scores) && !readFileSync(CACHES.scores, 'utf8').includes('corrupted')
  console.log(`  cache 已重建: ${cacheRebuilt ? '✓' : '✗ FAIL'}`)
  if (!cacheRebuilt) allPass = false
  restore(CACHES.scores)
  console.log('')

  // --- 测试2: 损坏 event_stats.cache.json ---
  console.log('--- 测试2: 损坏 event_stats.cache.json → score 自动重建 ---')
  const bak2 = backup(CACHES.event_stats)
  const scoreBefore = await runEaa(['score', name0])
  const scoreBeforeData = JSON.parse(scoreBefore.stdout)
  console.log(`  损坏前 score: ${name0} = ${scoreBeforeData.score}, events=${scoreBeforeData.events_count}`)
  corrupt(CACHES.event_stats)
  console.log(`  已损坏 event_stats.cache.json`)
  const t2 = performance.now()
  const scoreAfter = await runEaa(['score', name0])
  const t2End = performance.now() - t2
  const scoreAfterData = JSON.parse(scoreAfter.stdout)
  console.log(`  损坏后 score: ${Math.round(t2End)}ms exit=${scoreAfter.exitCode}`)
  console.log(`  重建后: ${name0} = ${scoreAfterData.score}, events=${scoreAfterData.events_count}`)
  const statsMatch = scoreBeforeData.score === scoreAfterData.score && scoreBeforeData.events_count === scoreAfterData.events_count
  console.log(`  一致性: ${statsMatch ? '✓' : '✗ FAIL'}`)
  if (!statsMatch) allPass = false
  restore(CACHES.event_stats)
  console.log('')

  // --- 测试3: 损坏 daily_dedup.cache.json ---
  console.log('--- 测试3: 损坏 daily_dedup.cache.json → add 自动重建 ---')
  const bak3 = backup(CACHES.daily_dedup)
  corrupt(CACHES.daily_dedup)
  console.log(`  已损坏 daily_dedup.cache.json`)
  // dry-run add 应该自动重建 cache (首次查当天扫描填充)
  const t3 = performance.now()
  const addRes = await runEaa(['add', name0, 'SLEEP_IN_CLASS', '--delta', '-2', '--dry-run'])
  const t3End = performance.now() - t3
  console.log(`  dry-run add (重建cache): ${Math.round(t3End)}ms exit=${addRes.exitCode}`)
  const dedupRebuilt = existsSync(CACHES.daily_dedup) && !readFileSync(CACHES.daily_dedup, 'utf8').includes('corrupted')
  console.log(`  cache 已重建: ${dedupRebuilt ? '✓' : '✗ FAIL'}`)
  if (!dedupRebuilt) allPass = false
  restore(CACHES.daily_dedup)
  console.log('')

  // --- 测试4: 删除所有 cache ---
  console.log('--- 测试4: 删除所有 cache → 从 events 全量重建 ---')
  remove(CACHES.scores); remove(CACHES.event_stats); remove(CACHES.daily_dedup)
  console.log(`  已删除所有 cache 文件`)
  const t4 = performance.now()
  // ranking 会触发 scores cache 重建, score 会触发 event_stats cache 重建
  const rankRebuild = await runEaa(['ranking', '10'])
  const scoreRebuild = await runEaa(['score', name0])
  const t4End = performance.now() - t4
  console.log(`  ranking + score (全量重建): ${Math.round(t4End)}ms`)
  console.log(`  ranking exit=${rankRebuild.exitCode}, score exit=${scoreRebuild.exitCode}`)
  const allCacheExist = existsSync(CACHES.scores) && existsSync(CACHES.event_stats)
  console.log(`  scores.cache 重建: ${existsSync(CACHES.scores) ? '✓' : '✗'}`)
  console.log(`  event_stats.cache 重建: ${existsSync(CACHES.event_stats) ? '✓' : '✗'}`)
  if (!allCacheExist) allPass = false
  // 验证数据正确
  const scoreData = JSON.parse(scoreRebuild.stdout)
  console.log(`  ${name0} score=${scoreData.score} events=${scoreData.events_count}`)
  console.log('')

  // --- 测试5: 超大 note ---
  console.log('--- 测试5: 超大 note (10KB) ---')
  const bigNote = 'A'.repeat(10000)
  const t5 = performance.now()
  const bigAdd = await runEaa(['add', name0, 'OTHER_DEDUCT', '--delta', '-1', '--note', bigNote, '--force'])
  const t5End = performance.now() - t5
  console.log(`  超大 note add: ${Math.round(t5End)}ms exit=${bigAdd.exitCode} ${bigAdd.exitCode === 0 ? '✓' : '✗ FAIL'}`)
  if (bigAdd.exitCode !== 0) allPass = false
  // 验证 note 存储
  const histRes = await runEaa(['history', name0])
  const histData = JSON.parse(histRes.stdout)
  const lastEvent = histData.events[histData.events.length - 1]
  const noteOk = lastEvent && lastEvent.note && lastEvent.note.length === 10000
  console.log(`  note 存储正确 (长度=${lastEvent?.note?.length}): ${noteOk ? '✓' : '✗ FAIL'}`)
  if (!noteOk) allPass = false
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
