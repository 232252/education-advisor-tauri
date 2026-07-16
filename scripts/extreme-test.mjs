// =============================================================
// 单学生极限测试 — 给一个学生不断追加事件, 测试稳定性与性能拐点
// 直接写 events.jsonl (绕过 add 命令的重复检测), 模拟真实极限
// =============================================================

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const EAA = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\core\\eaa-cli\\target\\release\\eaa.exe'
const TEST_DIR = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\test-volume-data\\eaa-data'
const EVENTS_PATH = path.join(TEST_DIR, 'events', 'events.jsonl')
const SCORES_CACHE = path.join(TEST_DIR, 'entities', 'scores.cache.json')

const REASON_CODES = [
  { code: 'SPEAK_IN_CLASS', delta: -2, label: '课堂讲话' },
  { code: 'SLEEP_IN_CLASS', delta: -2, label: '课堂睡觉' },
  { code: 'LATE', delta: -2, label: '迟到' },
  { code: 'SCHOOL_CAUGHT', delta: -5, label: '学校抓拍违纪' },
  { code: 'MAKEUP', delta: -2, label: '补差扣分' },
  { code: 'DESK_UNALIGNED', delta: -1, label: '桌椅不整齐' },
  { code: 'PHONE_IN_CLASS', delta: -5, label: '手机违纪' },
  { code: 'SMOKING', delta: -10, label: '抽烟' },
  { code: 'DRINKING_DORM', delta: -5, label: '寝室饮酒' },
  { code: 'OTHER_DEDUCT', delta: -1, label: '其他扣分' },
  { code: 'APPEARANCE_VIOLATION', delta: -2, label: '仪容仪表违纪' },
  { code: 'ACTIVITY_PARTICIPATION', delta: 1, label: '活动参与加分' },
  { code: 'CLASS_MONITOR', delta: 10, label: '班长履职加分' },
  { code: 'CLASS_COMMITTEE', delta: 5, label: '班委履职加分' },
  { code: 'CIVILIZED_DORM', delta: 3, label: '文明寝室' },
  { code: 'MONTHLY_ATTENDANCE', delta: 2, label: '月勤奖励' },
  { code: 'LAB_EQUIPMENT_DAMAGE', delta: -5, label: '实验室设备损坏' },
  { code: 'LAB_SAFETY_VIOLATION', delta: -10, label: '实验室安全违规' },
  { code: 'LAB_UNSAFE_BEHAVIOR', delta: -5, label: '实验室不安全行为' },
  { code: 'LAB_CLEAN_UP', delta: -1, label: '实验室未清理' },
]

const NOTES = [
  '上课与同桌说话', '课堂讨论时插话', '自习课讲话影响他人', '数学课上打瞌睡',
  '英语课趴桌睡觉', '早上迟到5分钟', '晚自习迟到10分钟', '校门口检查未戴校牌',
  '课间走廊追逐被值周老师记录', '数学补差测试未通过', '课桌未对齐', '上课玩手机被没收',
  '男厕所吸烟被发现', '寝室查寝发现啤酒', '未穿校服', '头发过长', '染发', '佩戴首饰',
  '参加学校运动会', '参加文艺汇演', '班长履职优秀', '学习委员履职', '文明寝室称号',
  '本月全勤', '物理实验损坏烧杯', '实验室未穿防护服', '实验室追逐打闹', '实验结束未清理台面',
]

function genEventId() {
  return 'evt_' + crypto.randomBytes(6).toString('hex')
}

function randomTimestamp() {
  // 2025-01-01 ~ 2026-07-13 (扩大时间范围以容纳更多事件)
  const start = new Date('2025-01-01T00:00:00+08:00').getTime()
  const end = new Date('2026-07-13T23:59:59+08:00').getTime()
  const d = new Date(start + Math.random() * (end - start))
  d.setHours(7 + Math.floor(Math.random() * 15), Math.floor(Math.random() * 60), Math.floor(Math.random() * 60))
  return d.toISOString().replace('Z', '+08:00')
}

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

// 直接追加事件到 events.jsonl (绕过 add 命令的重复检测和逐条 spawn 开销)
function appendEvents(entityId, count) {
  const lines = []
  for (let i = 0; i < count; i++) {
    const rc = REASON_CODES[Math.floor(Math.random() * REASON_CODES.length)]
    const event = {
      event_id: genEventId(),
      entity_id: entityId,
      event_type: rc.delta >= 0 ? 'CONDUCT_BONUS' : 'CONDUCT_DEDUCT',
      category_tags: [rc.delta >= 0 ? 'bonus' : 'deduct'],
      reason_code: rc.code,
      original_reason: rc.label,
      score_delta: rc.delta,
      evidence_ref: '',
      operator: '班主任',
      timestamp: randomTimestamp(),
      is_valid: true,
      reverted_by: null,
      note: NOTES[Math.floor(Math.random() * NOTES.length)],
    }
    lines.push(JSON.stringify(event))
  }
  fs.appendFileSync(EVENTS_PATH, lines.join('\n') + '\n', 'utf-8')
}

async function benchAtLevel(label, studentName, expectedEvents) {
  // 删除 scores.cache.json 强制重建
  try { fs.unlinkSync(SCORES_CACHE) } catch {}

  const info = await runEaa(['info'])
  const infoData = JSON.parse(info.stdout)
  const totalEvents = infoData.events ?? infoData.data?.events ?? 0

  // 测量 ranking (需要重建 scores cache)
  const rankRes = await runEaa(['ranking', '100'])
  const rankMs = rankRes.elapsed
  let rankData
  try { rankData = JSON.parse(rankRes.stdout) } catch { rankData = {} }
  const ranking = rankData.ranking || rankData.data?.ranking || []
  const target = ranking.find(r => r.name === studentName)

  // 第二次 ranking (cache 命中)
  const rank2Res = await runEaa(['ranking', '100'])
  const rank2Ms = rank2Res.elapsed

  // score
  const scoreRes = await runEaa(['score', studentName])
  const scoreMs = scoreRes.elapsed
  let scoreData
  try { scoreData = JSON.parse(scoreRes.stdout) } catch { scoreData = {} }
  const score = scoreData.score ?? scoreData.data?.score

  // history (最重操作, 需要 load_events)
  const histRes = await runEaa(['history', studentName])
  const histMs = histRes.elapsed
  let histData
  try { histData = JSON.parse(histRes.stdout) } catch { histData = {} }
  const eventsCount = histData.events_count ?? histData.data?.events_count ?? 0

  // list-students
  const lsRes = await runEaa(['list-students'])
  const lsMs = lsRes.elapsed

  // summary
  const sumRes = await runEaa(['summary'])
  const sumMs = sumRes.elapsed

  const consistent = target && score !== undefined ? (target.score === score) : '?'

  console.log(
    `${label.padEnd(22)} | 总事件:${String(totalEvents).padStart(6)} | ` +
    `该生:${String(eventsCount).padStart(5)} | ` +
    `rank1:${String(Math.round(rankMs)).padStart(5)}ms ` +
    `rank2:${String(Math.round(rank2Ms)).padStart(4)}ms ` +
    `score:${String(Math.round(scoreMs)).padStart(4)}ms ` +
    `hist:${String(Math.round(histMs)).padStart(5)}ms ` +
    `list:${String(Math.round(lsMs)).padStart(4)}ms ` +
    `sum:${String(Math.round(sumMs)).padStart(4)}ms | ` +
    `score:${score} 一致:${consistent}`
  )

  return { totalEvents, eventsCount, rankMs, rank2Ms, scoreMs, histMs, lsMs, sumMs, score, consistent }
}

async function main() {
  // 读取 entities 找第一个学生
  const entitiesRaw = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'entities', 'entities.json'), 'utf-8'))
  const entities = entitiesRaw.entities || {}
  const firstEid = Object.keys(entities)[0]
  const firstName = entities[firstEid].name

  console.log(`[extreme] 极限测试学生: ${firstName} (${firstEid})`)
  console.log(`[extreme] 初始 events.jsonl 大小: ${(fs.statSync(EVENTS_PATH).size / 1024 / 1024).toFixed(2)} MB`)
  console.log('')

  console.log('级别                   |        |        | 耗时(ms)'.padEnd(80))
  console.log('-'.repeat(95))

  // 基准 (当前事件量)
  await benchAtLevel('基准', firstName)

  // 逐级追加: +500, +1000, +2000, +5000, +10000, +20000, +50000
  const levels = [
    { label: '+500', count: 500 },
    { label: '+1000', count: 1000 },
    { label: '+2000', count: 2000 },
    { label: '+5000', count: 5000 },
    { label: '+10000', count: 10000 },
    { label: '+20000', count: 20000 },
    { label: '+50000', count: 50000 },
  ]

  const results = []
  for (const lv of levels) {
    const t0 = performance.now()
    appendEvents(firstEid, lv.count)
    const writeMs = performance.now() - t0
    const fileSize = (fs.statSync(EVENTS_PATH).size / 1024 / 1024).toFixed(2)
    process.stdout.write(`[${lv.label}] 追加 ${lv.count} 事件 (${Math.round(writeMs)}ms, ${fileSize}MB)... `)
    const r = await benchAtLevel(lv.label, firstName)
    results.push(r)
    // 如果 history 超过 5 秒, 停止追加
    if (r.histMs > 5000) {
      console.log(`\n[extreme] history 超过 5 秒 (${Math.round(r.histMs)}ms), 停止追加`)
      break
    }
    // 如果出错停止
    if (r.consistent === '?' || r.score === undefined) {
      console.log(`\n[extreme] 数据异常, 停止追加`)
      break
    }
  }

  console.log('')
  console.log('[extreme] 极限测试完成')
  console.log(`[extreme] 最终 events.jsonl: ${(fs.statSync(EVENTS_PATH).size / 1024 / 1024).toFixed(2)} MB`)
}

main().catch((err) => {
  console.error('[extreme] FATAL:', err)
  process.exit(1)
})
