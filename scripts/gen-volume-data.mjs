// =============================================================
// 大数据量测试数据生成器
// 生成 100 学生 (3 班级) + 每学生 10-500 事件
// 模拟一学期 (2026-03-01 ~ 2026-07-13) 的真实数据分布
// =============================================================

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const TEST_DIR = path.resolve('test-volume-data/eaa-data')
const ENTITIES_DIR = path.join(TEST_DIR, 'entities')
const EVENTS_DIR = path.join(TEST_DIR, 'events')
const SCHEMA_DIR = path.resolve('test-volume-data/schema')

// === 确保目录存在 ===
fs.mkdirSync(ENTITIES_DIR, { recursive: true })
fs.mkdirSync(EVENTS_DIR, { recursive: true })
fs.mkdirSync(SCHEMA_DIR, { recursive: true })

// === 复制 reason_codes.json ===
const reasonCodesSrc = path.resolve('config/reason-codes.json')
const reasonCodesRaw = JSON.parse(fs.readFileSync(reasonCodesSrc, 'utf-8'))
// 转换为 EAA CLI 格式 { version, codes: { CODE: { label, category, score_delta } } }
const reasonCodesEaa = {
  version: '1.0',
  codes: {},
}
for (const [code, def] of Object.entries(reasonCodesRaw)) {
  reasonCodesEaa.codes[code] = {
    label: def.label,
    category: def.category,
    score_delta: def.delta,
  }
}
fs.writeFileSync(
  path.join(SCHEMA_DIR, 'reason_codes.json'),
  JSON.stringify(reasonCodesEaa, null, 2),
)

// === 事件类型定义 ===
const REASON_CODES = Object.entries(reasonCodesEaa.codes).filter(
  ([code]) => code !== 'REVERT' && code !== 'BONUS_VARIABLE',
)
const DEDUCT_CODES = REASON_CODES.filter(([, d]) => d.score_delta < 0)
const BONUS_CODES = REASON_CODES.filter(([, d]) => d.score_delta > 0)

// === 中文姓名生成 ===
const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫'.split('')
const GIVEN_NAMES_1 = '伟芳娜秀英敏静丽强磊军洋勇艳杰娟涛明超秀兰霞平刚桂英华昌鹏文辉玉兰玉梅琳根才子轩宇浩然雨彤欣怡梓晗嘉诚志远晨曦梦琪若熙俊豪皓轩诗语紫萱子墨浩宇泓茗'.split('')
const GIVEN_NAMES_2 = '杰娟涛明超昌鹏文辉兰霞平刚华英宁远曦琪怡涵轩豪宇墨茗然彤熙诚'.split('')

function genName(idx) {
  const surname = SURNAMES[idx % SURNAMES.length]
  const useTwoChar = idx % 3 === 0
  const given = useTwoChar
    ? GIVEN_NAMES_1[idx % GIVEN_NAMES_1.length] + GIVEN_NAMES_2[(idx * 7) % GIVEN_NAMES_2.length]
    : GIVEN_NAMES_1[idx % GIVEN_NAMES_1.length]
  return surname + given
}

// === 生成 100 学生 ===
const NUM_STUDENTS = 100
const CLASSES = [
  { class_id: 'C1', name: '七年级1班', size: 40 },
  { class_id: 'C2', name: '七年级2班', size: 35 },
  { class_id: 'C3', name: '七年级3班', size: 25 },
]

const entities = {}
const nameIndex = {}
const students = []

let classIdx = 0
let classCount = 0
for (let i = 0; i < NUM_STUDENTS; i++) {
  // 分配班级
  while (classCount >= CLASSES[classIdx].size) {
    classIdx++
    classCount = 0
  }
  const classId = CLASSES[classIdx].class_id
  classCount++

  const eid = `ent_${String(i + 1).padStart(4, '0')}`
  const name = genName(i)
  const createdAt = `2026-02-2${(i % 5) + 5}T08:00:00+08:00`

  entities[eid] = {
    id: eid,
    name,
    aliases: [],
    status: 'ACTIVE',
    created_at: createdAt,
    metadata: {},
    class_id: classId,
  }
  nameIndex[name] = eid
  students.push({ eid, name, classId, index: i })
}

// 写 entities.json
fs.writeFileSync(
  path.join(ENTITIES_DIR, 'entities.json'),
  JSON.stringify({ entities }, null, 2),
)
// 写 name_index.json
fs.writeFileSync(
  path.join(ENTITIES_DIR, 'name_index.json'),
  JSON.stringify(nameIndex, null, 2),
)

console.log(`[gen] 生成 ${NUM_STUDENTS} 学生 (${CLASSES.map(c => `${c.class_id}:${c.size}`).join(', ')})`)

// === 生成事件 ===
// 分布: 10% 少量(10-30), 30% 中等(50-100), 40% 较多(100-200), 15% 大量(200-400), 5% 极端(400-500)
function getEventCount(index) {
  const pct = index / NUM_STUDENTS
  if (pct < 0.10) return 10 + Math.floor(Math.random() * 21)     // 10-30
  if (pct < 0.40) return 50 + Math.floor(Math.random() * 51)     // 50-100
  if (pct < 0.80) return 100 + Math.floor(Math.random() * 101)   // 100-200
  if (pct < 0.95) return 200 + Math.floor(Math.random() * 201)   // 200-400
  return 400 + Math.floor(Math.random() * 101)                   // 400-500
}

// 学期日期范围: 2026-03-01 ~ 2026-07-13
const SEMESTER_START = new Date('2026-03-01T00:00:00+08:00')
const SEMESTER_END = new Date('2026-07-13T23:59:59+08:00')
const SEMESTER_MS = SEMESTER_END - SEMESTER_START

function randomTimestamp() {
  const offset = Math.random() * SEMESTER_MS
  const d = new Date(SEMESTER_START.getTime() + offset)
  // 只在工作日生成事件 (跳过周末)
  const day = d.getDay()
  if (day === 0) d.setDate(d.getDate() + 1) // 周日→周一
  if (day === 6) d.setDate(d.getDate() + 2) // 周六→周一
  // 上课时间: 7:00-18:00 或 19:00-22:00(晚自习)
  const hour = Math.random() < 0.8
    ? 7 + Math.floor(Math.random() * 11)  // 7-17
    : 19 + Math.floor(Math.random() * 4)  // 19-22
  d.setHours(hour, Math.floor(Math.random() * 60), Math.floor(Math.random() * 60))
  return d.toISOString().replace('Z', '+08:00').replace('T', 'T')
}

function genEventId() {
  return 'evt_' + crypto.randomBytes(6).toString('hex')
}

function pickReasonCode() {
  // 70% 扣分, 30% 加分 (模拟真实: 扣分比加分多)
  const pool = Math.random() < 0.7 ? DEDUCT_CODES : BONUS_CODES
  const [code, def] = pool[Math.floor(Math.random() * pool.length)]
  return { code, def }
}

// 详细的 note 模板 (模拟真实记录)
const NOTE_TEMPLATES = {
  SPEAK_IN_CLASS: ['上课与同桌说话', '课堂讨论时插话', '自习课讲话影响他人', '老师讲课时交头接耳'],
  SLEEP_IN_CLASS: ['上午第一节课打瞌睡', '下午午休后未醒', '数学课上睡觉', '英语课趴桌睡觉'],
  LATE: ['早上迟到5分钟', '午休后迟到', '晚自习迟到10分钟', '升旗仪式迟到'],
  SCHOOL_CAUGHT: ['校门口检查未戴校牌', '课间走廊追逐被值周老师记录', '食堂插队被督查抓拍'],
  MAKEUP: ['数学补差测试未通过', '英语单词默写补差', '物理补差未达标'],
  DESK_UNALIGNED: ['课桌未对齐', '桌下有垃圾', '桌面物品摆放凌乱'],
  PHONE_IN_CLASS: ['上课玩手机被没收', '课间在教室打游戏', '晚自习看手机视频'],
  SMOKING: ['男厕所吸烟被发现', '教学楼后方吸烟'],
  DRINKING_DORM: ['寝室查寝发现啤酒', '室友举报寝室饮酒'],
  OTHER_DEDUCT: ['未穿校服', '未戴红领巾', '走廊奔跑'],
  APPEARANCE_VIOLATION: ['头发过长', '染发', '佩戴首饰', '化妆'],
  ACTIVITY_PARTICIPATION: ['参加学校运动会', '参加文艺汇演', '参加科技创新大赛', '参加志愿服务'],
  CLASS_MONITOR: ['本月班长履职优秀', '组织班会活动'],
  CLASS_COMMITTEE: ['学习委员履职', '宣传委员出黑板报', '体育委员组织早操'],
  CIVILIZED_DORM: ['本周寝室卫生评比优秀', '文明寝室称号'],
  MONTHLY_ATTENDANCE: ['本月全勤', '本月无迟到早退'],
  LAB_EQUIPMENT_DAMAGE: ['物理实验损坏烧杯', '化学实验打翻试剂瓶'],
  LAB_SAFETY_VIOLATION: ['实验室未穿防护服', '实验室违规操作'],
  LAB_UNSAFE_BEHAVIOR: ['实验室追逐打闹', '实验时未按规程操作'],
  LAB_CLEAN_UP: ['实验结束后未清理台面', '未归还实验器材'],
}

function genNote(code) {
  const templates = NOTE_TEMPLATES[code]
  if (!templates) return ''
  return templates[Math.floor(Math.random() * templates.length)]
}

// === 生成事件并写入 events.jsonl ===
const eventsPath = path.join(EVENTS_DIR, 'events.jsonl')
const ws = fs.createWriteStream(eventsPath, { encoding: 'utf-8' })

let totalEvents = 0
let maxEvents = 0
let minEvents = Infinity
let maxStudent = ''
let minStudent = ''
const classEventCounts = { C1: 0, C2: 0, C3: 0 }

const T0 = Date.now()
for (const student of students) {
  const count = getEventCount(student.index)
  for (let j = 0; j < count; j++) {
    const { code, def } = pickReasonCode()
    const delta = def.score_delta
    const event = {
      event_id: genEventId(),
      entity_id: student.eid,
      event_type: delta >= 0 ? 'CONDUCT_BONUS' : 'CONDUCT_DEDUCT',
      category_tags: [def.category],
      reason_code: code,
      original_reason: def.label,
      score_delta: delta,
      evidence_ref: '',
      operator: '班主任',
      timestamp: randomTimestamp(),
      is_valid: true,
      reverted_by: null,
      note: genNote(code),
    }
    ws.write(JSON.stringify(event) + '\n')
    totalEvents++
    classEventCounts[student.classId]++
  }
  if (count > maxEvents) { maxEvents = count; maxStudent = student.name }
  if (count < minEvents) { minEvents = count; minStudent = student.name }
}

ws.end()
ws.close()

const elapsed = Date.now() - T0
console.log(`[gen] 生成 ${totalEvents} 事件 (${elapsed}ms)`)
console.log(`[gen] 事件分布: 最少 ${minEvents} (${minStudent}), 最多 ${maxEvents} (${maxStudent}), 平均 ${Math.round(totalEvents / NUM_STUDENTS)}`)
console.log(`[gen] 班级事件: C1=${classEventCounts.C1}, C2=${classEventCounts.C2}, C3=${classEventCounts.C3}`)
console.log(`[gen] 数据目录: ${TEST_DIR}`)
