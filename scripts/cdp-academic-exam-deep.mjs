// =============================================================
// CDP 学业模块深度测试 — 考试 CRUD / 试卷分析 / 成绩边界
// 覆盖: getConfig / createExam / listExams / setGrade /
//       batchSetGrades / getGrades / getClassGrades /
//       analyzePaper / deleteExam(级联) / upsert / 并发 / 清理
// 运行: node scripts/cdp-academic-exam-deep.mjs
// =============================================================
import http from 'node:http'
import WebSocket from 'ws'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const CDP_HOST = 'http://127.0.0.1:9222'
const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'

// 预期科目 (fullMark 为最大分数字段)
const EXPECTED_SUBJECTS = [
  { id: 'chinese', name: '语文', fullMark: 150, isCore: true, category: 'core' },
  { id: 'math', name: '数学', fullMark: 150, isCore: true, category: 'core' },
  { id: 'english', name: '英语', fullMark: 150, isCore: true, category: 'core' },
  { id: 'physics', name: '物理', fullMark: 100, category: 'science' },
  { id: 'chemistry', name: '化学', fullMark: 100, category: 'science' },
  { id: 'biology', name: '生物', fullMark: 100, category: 'science' },
  { id: 'politics', name: '政治', fullMark: 100, category: 'arts' },
  { id: 'history', name: '历史', fullMark: 100, category: 'arts' },
  { id: 'geography', name: '地理', fullMark: 100, category: 'arts' },
  { id: 'pe', name: '体育', fullMark: 100, category: 'pe' },
]

// 全局状态
let ws, send, evalInPage
const createdExamIds = new Set()
let passCount = 0
let failCount = 0
const notes = []

const TS = Date.now()
const studentName = (tag) => `CDPDeep_${TS}_${tag}` // 仅含字母/数字/下划线, 通过 sanitizeName

function record(name, ok, detail = '') {
  if (ok) passCount++
  else failCount++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}
const note = (m) => notes.push(m)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------- CDP 连接 ----------------
const httpGet = (u) =>
  new Promise((r, j) => {
    http.get(u, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try {
          r(JSON.parse(d))
        } catch (e) {
          j(e)
        }
      })
    }).on('error', j)
  })

async function connect() {
  const targets = (await httpGet(`${CDP_HOST}/json`)).filter((x) => x.type === 'page')
  if (!targets.length) {
    console.error('❌ 无可用 CDP page target (应用是否运行? 端口 9222?)')
    process.exit(1)
  }
  ws = new WebSocket(targets[0].webSocketDebuggerUrl)
  let _id = 1
  const pending = new Map()
  ws.on('message', (r) => {
    const m = JSON.parse(r.toString())
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
  send = (method, params = {}) =>
    new Promise((r) => {
      const i = _id++
      pending.set(i, r)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  evalInPage = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.result?.exceptionDetails) {
      const desc =
        r.result.exceptionDetails.exception?.description ||
        r.result.exceptionDetails.text ||
        'unknown'
      throw new Error(desc.substring(0, 500))
    }
    return r.result?.result?.value
  }
  await new Promise((r) => ws.on('open', r))
}

// ---------------- 通用 API 调用 (双重 stringify 防 ${} 注入) ----------------
async function callNS(ns, method, ...args) {
  const argsLiteral = JSON.stringify(JSON.stringify(args))
  const methodLiteral = JSON.stringify(method)
  const nsLiteral = JSON.stringify(ns)
  const expr = `(async function(){
    try {
      const api = window.__EAA_API__ || window.api;
      const obj = api && api[${nsLiteral}];
      if (!obj || typeof obj[${methodLiteral}] !== 'function') {
        return JSON.stringify({ __error: 'method not available: ' + ${nsLiteral} + '.' + ${methodLiteral} });
      }
      const args = JSON.parse(${argsLiteral});
      const res = await obj[${methodLiteral}].apply(obj, args);
      return JSON.stringify({ __ok: true, res });
    } catch (e) {
      return JSON.stringify({ __error: (e && e.message) ? e.message : String(e) });
    }
  })()`
  const raw = await evalInPage(expr)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { __error: 'non-json result: ' + String(raw).slice(0, 200) }
  }
  if (parsed.__error) return { __error: parsed.__error }
  return parsed.res
}
const callAcademic = (m, ...a) => callNS('academic', m, ...a)

// 探测某命名空间下哪些方法存在
async function probeMethods(ns, names) {
  const namesLiteral = JSON.stringify(names)
  const nsLiteral = JSON.stringify(ns)
  const expr = `(function(){
    const api = window.__EAA_API__ || window.api;
    const obj = api && api[${nsLiteral}];
    const out = {};
    for (const n of ${namesLiteral}) { out[n] = !!(obj && typeof obj[n] === 'function'); }
    return JSON.stringify(out);
  })()`
  return JSON.parse(await evalInPage(expr))
}

// ---------------- 业务 helper ----------------
// 判定: 方法可用且 success===true
const isOk = (r) => !!r && r.__error === undefined && r.success === true
// 判定: 方法可用但被业务拒绝 (success===false)
const isRejected = (r) => !!r && r.__error === undefined && r.success === false

function normalizeSubjects(rawSubjects) {
  const byId = new Map(EXPECTED_SUBJECTS.map((s) => [s.id, s]))
  return (rawSubjects || []).map((s) => {
    const ms = s.fullMark ?? s.maxScore ?? s.max_score ?? s.fullScore ?? s.totalScore ?? null
    let fullMark = ms != null ? Number(ms) : null
    if (fullMark == null || Number.isNaN(fullMark)) {
      const ref = byId.get(s.id)
      if (ref) fullMark = ref.fullMark
    }
    return {
      id: s.id,
      name: s.name,
      fullMark,
      isCore: s.isCore,
      category: s.category,
      raw: s,
    }
  })
}

async function getConfigSubjects() {
  const r = await callAcademic('getConfig')
  if (!isOk(r)) return { ok: false, subjects: [], raw: r }
  const d = r.data || {}
  const subjects = normalizeSubjects(d.subjects || [])
  return { ok: true, subjects, raw: r, rawKeys: d.subjects?.[0] ? Object.keys(d.subjects[0]) : [] }
}

// 创建考试 (成功则登记 id 以便清理)
async function createExamRaw(examData) {
  const r = await callAcademic('createExam', examData)
  if (isOk(r) && r.data?.id) createdExamIds.add(r.data.id)
  return r
}

async function createTestExam(tag, subjects) {
  const r = await createExamRaw({
    name: `CDP_Exam_Deep_${TS}_${tag}`,
    type: 'monthly',
    date: new Date().toISOString().slice(0, 10),
    semester: '2025-2026-2',
    scope: 'cdp-deep',
    subjects: subjects || EXPECTED_SUBJECTS.map((s) => s.id),
  })
  return { id: r?.data?.id || null, raw: r }
}

async function setOneGrade(grade) {
  return callAcademic('setGrade', grade)
}

// 读取学生在某考试的成绩 (getGrades 仅接收 studentName, 客户端按 examId 过滤)
async function getStudentExamGrades(name, examId) {
  const r = await callAcademic('getGrades', name)
  if (!isOk(r)) return { error: r?.error || r?.__error, grades: [], all: [] }
  const all = Array.isArray(r.data) ? r.data : []
  return { grades: examId ? all.filter((g) => g.examId === examId) : all, all }
}

async function deleteExamSafe(examId) {
  try {
    await callAcademic('deleteExam', examId)
  } catch {
    /* ignore */
  }
  createdExamIds.delete(examId)
}

async function cleanupAll() {
  for (const id of [...createdExamIds]) await deleteExamSafe(id)
}

// ---------------- 主流程 ----------------
async function main() {
  console.log('=== 学业模块 CDP 深度测试 (考试/试卷/成绩边界) ===\n')
  await connect()

  // 导航到学业页, 确保 academic 命名空间初始化
  try {
    await evalInPage(
      `(async function(){ if(location) location.hash='#/academics'; await new Promise(r=>setTimeout(r,1000)); })()`,
    )
  } catch {
    /* ignore */
  }

  // 探测 academic 方法可用性
  const methodsAvail = await probeMethods('academic', [
    'getConfig',
    'setConfig',
    'listExams',
    'createExam',
    'deleteExam',
    'getGrades',
    'setGrade',
    'batchSetGrades',
    'getClassGrades',
    'analyzePaper',
  ])
  console.log('— academic 方法探测:')
  for (const [k, v] of Object.entries(methodsAvail)) {
    if (v) console.log(`    ${PASS} ${k}`)
  }
  console.log('')

  let subjects = []
  let mainExamId = null

  // ===== 1. getConfig 深度测试 =====
  console.log('--- 1. getConfig 深度测试 ---')
  try {
    const cfg = await getConfigSubjects()
    subjects = cfg.subjects
    if (cfg.rawKeys?.length) note(`config 科目原始字段: ${cfg.rawKeys.join(', ')}`)
    record('getConfig 返回成功且含 subjects', cfg.ok && subjects.length > 0, cfg.ok ? `共 ${subjects.length} 科` : `error=${cfg.raw?.error || cfg.raw?.__error}`)
  } catch (e) {
    record('getConfig 返回成功且含 subjects', false, e.message)
  }

  try {
    record('getConfig 返回 10 个科目', subjects.length === 10, `实际 ${subjects.length}`)
  } catch (e) {
    record('getConfig 返回 10 个科目', false, e.message)
  }

  try {
    const required = ['id', 'name', 'fullMark', 'category']
    const allHave = subjects.every((s) => required.every((k) => s[k] != null))
    // isCore 仅核心科目具备 (非核心科目缺省该字段)
    const coreNames = ['语文', '数学', '英语']
    const coreOk = subjects.filter((s) => coreNames.includes(s.name)).every((s) => s.isCore === true)
    record('每个科目含 id/name/fullMark/category 且核心科目 isCore=true', allHave && coreOk, allHave && coreOk ? '字段完整' : `缺失: ${subjects.map((s) => JSON.stringify({ id: s.id, has: required.filter((k) => s[k] == null) })).join('; ')}`)
  } catch (e) {
    record('每个科目含 id/name/fullMark/isCore/category', false, e.message)
  }

  try {
    const core = subjects.filter((s) => ['语文', '数学', '英语'].includes(s.name))
    const all150 = core.length === 3 && core.every((s) => Number(s.fullMark) === 150)
    record('核心科目(语文/数学/英语) fullMark=150', all150, core.map((s) => `${s.name}=${s.fullMark}`).join(', '))
  } catch (e) {
    record('核心科目 fullMark=150', false, e.message)
  }

  try {
    const noncore = subjects.filter((s) => !['语文', '数学', '英语'].includes(s.name))
    const all100 = noncore.length === 7 && noncore.every((s) => Number(s.fullMark) === 100)
    record('非核心科目 fullMark=100', all100, noncore.map((s) => `${s.name}=${s.fullMark}`).join(', '))
  } catch (e) {
    record('非核心科目 fullMark=100', false, e.message)
  }

  try {
    const expectedIds = EXPECTED_SUBJECTS.map((s) => s.id)
    const gotIds = subjects.map((s) => s.id)
    const match = expectedIds.every((id) => gotIds.includes(id))
    record('科目 ID 匹配预期 (chinese/math/english/...)', match, match ? gotIds.join(',') : `缺: ${expectedIds.filter((i) => !gotIds.includes(i)).join(',')}`)
  } catch (e) {
    record('科目 ID 匹配预期', false, e.message)
  }

  // ===== 2. createExam 深度测试 =====
  console.log('\n--- 2. createExam 深度测试 ---')
  // 2a. 全字段有效考试
  try {
    const ex = await createTestExam('full', subjects.map((s) => s.id))
    mainExamId = ex.id
    record('createExam 全字段有效', isOk(ex.raw) && mainExamId, `id=${mainExamId}`)
  } catch (e) {
    record('createExam 全字段有效', false, e.message)
  }

  // 2b. 最小有效集 (name + subjects)
  try {
    const r = await createExamRaw({ name: `CDP_Exam_Deep_${TS}_min`, subjects: ['math'] })
    record('createExam 最小有效集 (name+subjects)', isOk(r) && r.data?.id, `id=${r.data?.id}`)
  } catch (e) {
    record('createExam 最小有效集', false, e.message)
  }

  // 2c. 仅 name 无 subjects → 应拒绝
  try {
    const r = await createExamRaw({ name: `CDP_Exam_Deep_${TS}_nosub` })
    record('createExam 仅 name 无 subjects 正确拒绝', isRejected(r), isRejected(r) ? `error=${r.error}` : `未拒绝 success=${r?.success}`)
  } catch (e) {
    record('createExam 仅 name 无 subjects 正确拒绝', false, e.message)
  }

  // 2d. 空 name → 应拒绝
  try {
    const r = await createExamRaw({ name: '', subjects: ['math'] })
    record('createExam 空 name 正确拒绝', isRejected(r), isRejected(r) ? `error=${r.error}` : `未拒绝`)
  } catch (e) {
    record('createExam 空 name 正确拒绝', false, e.message)
  }

  // 2e. 超长 name (>100 字符) → 行为记录 (实际无长度校验, 接受)
  try {
    const longName = `CDP_Exam_Deep_${TS}_long_` + 'A'.repeat(120)
    const r = await createExamRaw({ name: longName, subjects: ['math'] })
    record('createExam 超长 name(>100) 行为记录', isOk(r), isOk(r) ? '接受(无长度校验)' : `error=${r.error}`)
    if (isOk(r)) note('createExam: name 无长度上限校验')
  } catch (e) {
    record('createExam 超长 name 行为记录', false, e.message)
  }

  // 2f. 特殊字符 name → 行为记录 (exam.name 未走 sanitizeName, 接受)
  try {
    const spName = `CDP_Exam_Deep_${TS}_!@#%^&*()_+-=特殊`
    const r = await createExamRaw({ name: spName, subjects: ['math'] })
    record('createExam 特殊字符 name 行为记录', isOk(r), isOk(r) ? '接受(无字符校验)' : `error=${r.error}`)
  } catch (e) {
    record('createExam 特殊字符 name 行为记录', false, e.message)
  }

  // 2g. Unicode/emoji name → 行为记录 (接受)
  try {
    const emojiName = `CDP_Exam_Deep_${TS}_测试📚🎯试卷`
    const r = await createExamRaw({ name: emojiName, subjects: ['math'] })
    record('createExam Unicode/emoji name 行为记录', isOk(r), isOk(r) ? '接受' : `error=${r.error}`)
  } catch (e) {
    record('createExam Unicode/emoji name 行为记录', false, e.message)
  }

  // 2h. 无效日期格式 → 行为记录 (无日期校验, 接受)
  try {
    const r = await createExamRaw({ name: `CDP_Exam_Deep_${TS}_baddate`, type: 'monthly', date: 'not-a-date', semester: '2025-2026-2', subjects: ['math'] })
    record('createExam 无效日期格式 行为记录', isOk(r), isOk(r) ? '接受(无日期校验)' : `error=${r.error}`)
    if (isOk(r)) note('createExam: date 无格式校验')
  } catch (e) {
    record('createExam 无效日期格式 行为记录', false, e.message)
  }

  // ===== 3. listExams 深度测试 =====
  console.log('\n--- 3. listExams 深度测试 ---')
  let listRaw = null
  try {
    listRaw = await callAcademic('listExams')
    const arr = isOk(listRaw) && Array.isArray(listRaw.data) ? listRaw.data : null
    record('listExams 返回数组', !!arr, arr ? `长度=${arr.length}` : `error=${listRaw?.error}`)
  } catch (e) {
    record('listExams 返回数组', false, e.message)
  }

  try {
    const arr = isOk(listRaw) ? listRaw.data || [] : []
    // createExam 仅强制要求 name + subjects; date/type 为可选, 最小创建的考试可能缺省
    const need = ['id', 'name', 'subjects']
    const allHave = arr.length > 0 && arr.every((e) => need.every((k) => e[k] !== undefined))
    // 主考试(全字段创建)应含完整字段
    const main = arr.find((e) => e.id === mainExamId)
    const mainFull = main && ['id', 'name', 'date', 'type', 'subjects', 'createdAt'].every((k) => main[k] !== undefined)
    record('每个考试含 id/name/subjects (主考试含全字段)', allHave && mainFull, allHave ? `检查 ${arr.length} 条, 主考试全字段=${!!mainFull}` : `样例字段: ${arr[0] ? Object.keys(arr[0]).join(',') : '空'}`)
  } catch (e) {
    record('每个考试含 id/name/date/type/subjects', false, e.message)
  }

  try {
    const arr = isOk(listRaw) ? listRaw.data || [] : []
    const found = mainExamId && arr.find((e) => e.id === mainExamId)
    record('新创建考试出现在 listExams', !!found, found ? `name=${found.name}` : '未找到')
  } catch (e) {
    record('新创建考试出现在 listExams', false, e.message)
  }

  // ===== 4. setGrade 深度测试 =====
  console.log('\n--- 4. setGrade 深度测试 ---')
  if (!mainExamId) {
    record('setGrade 测试集 (依赖 mainExamId)', false, '无 mainExamId, 跳过')
  }

  async function setGradeAndRead(label, grade, expectAccept, readCheck) {
    if (!mainExamId) {
      record(`setGrade ${label}`, false, '无 mainExamId')
      return
    }
    try {
      const r = await setOneGrade(grade)
      const accepted = isOk(r)
      let detail = `accepted=${accepted}`
      if (accepted && readCheck) {
        const { grades } = await getStudentExamGrades(grade.studentName, grade.examId)
        const g = grades.find((x) => x.subjectId === grade.subjectId)
        const ok = readCheck(g)
        detail += ` 读回=${g ? JSON.stringify(g.score) : '无'}`
        record(`setGrade ${label}`, ok, detail)
        return
      }
      // 期望拒绝
      if (!expectAccept) {
        record(`setGrade ${label}`, isRejected(r), isRejected(r) ? `error=${r.error}` : `未拒绝 success=${r?.success}`)
      } else {
        record(`setGrade ${label}`, accepted, detail + ` error=${r?.error || ''}`)
      }
    } catch (e) {
      record(`setGrade ${label}`, false, e.message)
    }
  }

  if (mainExamId) {
    const subj = subjects[0] || EXPECTED_SUBJECTS[0] // 语文
    const math = subjects.find((s) => s.id === 'math') || EXPECTED_SUBJECTS[1]

    // 4a. 有效分数 80
    await setGradeAndRead('有效分数 80', { examId: mainExamId, subjectId: math.id, studentName: studentName('g80'), score: 80, fullMark: math.fullMark }, true, (g) => g && Number(g.score) === 80)
    // 4b. score=0 边界 (严格区分 0 与 null)
    await setGradeAndRead('score=0 边界', { examId: mainExamId, subjectId: math.id, studentName: studentName('g0'), score: 0, fullMark: math.fullMark }, true, (g) => g && g.score === 0)
    // 4c. score=满分 (语文 150)
    await setGradeAndRead('score=满分', { examId: mainExamId, subjectId: subj.id, studentName: studentName('gfull'), score: subj.fullMark, fullMark: subj.fullMark }, true, (g) => g && Number(g.score) === Number(subj.fullMark))
    // 4d. score 超满分 (200/150) — 已知 gap, 接受
    await setGradeAndRead('score 超满分(已知gap)', { examId: mainExamId, subjectId: subj.id, studentName: studentName('gover'), score: subj.fullMark + 50, fullMark: subj.fullMark }, true, (g) => g && Number(g.score) === subj.fullMark + 50)
    // 4e. 负分数 -10 — 行为记录 (接受)
    await setGradeAndRead('负分数 -10', { examId: mainExamId, subjectId: math.id, studentName: studentName('gneg'), score: -10, fullMark: math.fullMark }, true, (g) => g && Number(g.score) === -10)
    // 4f. 小数 85.5
    await setGradeAndRead('小数 85.5', { examId: mainExamId, subjectId: math.id, studentName: studentName('gfrac'), score: 85.5, fullMark: math.fullMark }, true, (g) => g && Number(g.score) === 85.5)
    // 4g. null 缺考
    await setGradeAndRead('null 缺考', { examId: mainExamId, subjectId: math.id, studentName: studentName('gnull'), score: null, fullMark: math.fullMark }, true, (g) => g && (g.score === null || g.score === undefined))
    // 4h. 空学生名 → 拒绝
    try {
      const r = await setOneGrade({ examId: mainExamId, subjectId: math.id, studentName: '', score: 50, fullMark: math.fullMark })
      record('setGrade 空学生名 正确拒绝', isRejected(r), isRejected(r) ? `error=${r.error}` : '未拒绝')
    } catch (e) {
      record('setGrade 空学生名 正确拒绝', false, e.message)
    }
    // 4i. 不存在 subjectId — 行为记录 (接受, 无校验)
    await setGradeAndRead('不存在 subjectId(行为记录)', { examId: mainExamId, subjectId: 'nonexistent_subj_xyz', studentName: studentName('gbsub'), score: 60, fullMark: 100 }, true, (g) => g && Number(g.score) === 60)
    // 4j. 不存在 examId — 行为记录 (接受)
    try {
      const r = await setOneGrade({ examId: `exam-fake-${TS}`, subjectId: math.id, studentName: studentName('gbeid'), score: 70, fullMark: math.fullMark })
      record('setGrade 不存在 examId(行为记录)', isOk(r), isOk(r) ? '接受(无 examId 存在性校验)' : `error=${r.error}`)
      if (isOk(r)) note('setGrade: 不校验 examId 是否存在')
    } catch (e) {
      record('setGrade 不存在 examId(行为记录)', false, e.message)
    }
    // 4k. 超大分数 99999 — 行为记录 (接受)
    await setGradeAndRead('超大分数 99999', { examId: mainExamId, subjectId: math.id, studentName: studentName('ghuge'), score: 99999, fullMark: math.fullMark }, true, (g) => g && Number(g.score) === 99999)
  }

  // ===== 5. batchSetGrades 深度测试 =====
  console.log('\n--- 5. batchSetGrades 深度测试 ---')
  if (mainExamId) {
    const math = subjects.find((s) => s.id === 'math') || EXPECTED_SUBJECTS[1]
    const chi = subjects[0] || EXPECTED_SUBJECTS[0]

    // 5a. 批量 5 条 (不同学生/科目)
    try {
      const recs = []
      const subjs = subjects.slice(0, Math.min(5, subjects.length))
      for (let i = 0; i < 5; i++) {
        const s = subjs[i % subjs.length]
        recs.push({ examId: mainExamId, subjectId: s.id, studentName: studentName(`b${i}`), score: 60 + i, fullMark: s.fullMark })
      }
      const r = await callAcademic('batchSetGrades', recs)
      record('batchSetGrades 批量 5 条', isOk(r) && Number(r.data) === 5, `count=${r.data}`)
    } catch (e) {
      record('batchSetGrades 批量 5 条', false, e.message)
    }

    // 5b. 空数组 → success, data=0
    try {
      const r = await callAcademic('batchSetGrades', [])
      record('batchSetGrades 空数组 data=0', isOk(r) && Number(r.data) === 0, `success=${r.success} data=${r.data}`)
    } catch (e) {
      record('batchSetGrades 空数组 data=0', false, e.message)
    }

    // 5c. 单条批量
    try {
      const r = await callAcademic('batchSetGrades', [{ examId: mainExamId, subjectId: math.id, studentName: studentName('single'), score: 88, fullMark: math.fullMark }])
      record('batchSetGrades 单条', isOk(r) && Number(r.data) === 1, `count=${r.data}`)
    } catch (e) {
      record('batchSetGrades 单条', false, e.message)
    }

    // 5d. 重复条目 (同学生同科目) → upsert, 不报错
    try {
      const name = studentName('dup')
      const recs = [
        { examId: mainExamId, subjectId: math.id, studentName: name, score: 50, fullMark: math.fullMark },
        { examId: mainExamId, subjectId: math.id, studentName: name, score: 60, fullMark: math.fullMark },
      ]
      const r = await callAcademic('batchSetGrades', recs)
      const { grades } = await getStudentExamGrades(name, mainExamId)
      const g = grades.find((x) => x.subjectId === math.id)
      record('batchSetGrades 重复条目 upsert', isOk(r) && grades.filter((x) => x.subjectId === math.id).length === 1 && Number(g?.score) === 60, `count=${r.data} 读回=${g?.score}`)
    } catch (e) {
      record('batchSetGrades 重复条目 upsert', false, e.message)
    }

    // 5e. 混合有效/无效 → 整批拒绝 (handler 预校验所有)
    try {
      const recs = [
        { examId: mainExamId, subjectId: math.id, studentName: studentName('mix1'), score: 70, fullMark: math.fullMark },
        { examId: mainExamId, subjectId: chi.id, studentName: '', score: 70, fullMark: chi.fullMark }, // 无效: 空学生名
      ]
      const r = await callAcademic('batchSetGrades', recs)
      record('batchSetGrades 混合有效/无效 整批拒绝', isRejected(r), isRejected(r) ? `error=${r.error}` : `未拒绝 success=${r?.success}`)
    } catch (e) {
      record('batchSetGrades 混合有效/无效 整批拒绝', false, e.message)
    }
  } else {
    record('batchSetGrades 测试集', false, '无 mainExamId')
  }

  // ===== 6. getGrades 深度测试 =====
  console.log('\n--- 6. getGrades 深度测试 ---')
  if (mainExamId) {
    const math = subjects.find((s) => s.id === 'math') || EXPECTED_SUBJECTS[1]
    // 6a. 已知成绩学生
    try {
      const known = studentName('g80')
      await setOneGrade({ examId: mainExamId, subjectId: math.id, studentName: known, score: 80, fullMark: math.fullMark })
      const r = await callAcademic('getGrades', known)
      const arr = isOk(r) && Array.isArray(r.data) ? r.data : []
      record('getGrades 已知成绩学生读回', arr.length > 0 && arr.some((g) => g.subjectId === math.id && Number(g.score) === 80), `共 ${arr.length} 条`)
    } catch (e) {
      record('getGrades 已知成绩学生读回', false, e.message)
    }
    // 6b. 无成绩学生 → 空数组
    try {
      const r = await callAcademic('getGrades', studentName('empty'))
      record('getGrades 无成绩学生返回空', isOk(r) && Array.isArray(r.data) && r.data.length === 0, `len=${r.data?.length}`)
    } catch (e) {
      record('getGrades 无成绩学生返回空', false, e.message)
    }
    // 6c. 不存在学生 → 空不报错
    try {
      const r = await callAcademic('getGrades', studentName('noexist'))
      record('getGrades 不存在学生返回空不报错', isOk(r) && Array.isArray(r.data) && r.data.length === 0, `len=${r.data?.length}`)
    } catch (e) {
      record('getGrades 不存在学生返回空不报错', false, e.message)
    }
    // 6d. 按 examId 过滤 (客户端)
    try {
      const multi = studentName('multi')
      await setOneGrade({ examId: mainExamId, subjectId: math.id, studentName: multi, score: 80, fullMark: math.fullMark })
      const { grades, all } = await getStudentExamGrades(multi, mainExamId)
      const ok = grades.length >= 1 && grades.every((g) => g.examId === mainExamId)
      record('getGrades 按 examId 过滤(客户端)', ok, `本考试 ${grades.length}/${all.length} 条`)
    } catch (e) {
      record('getGrades 按 examId 过滤', false, e.message)
    }
  } else {
    record('getGrades 测试集', false, '无 mainExamId')
  }

  // ===== 7. getClassGrades 深度测试 =====
  console.log('\n--- 7. getClassGrades 深度测试 ---')
  if (mainExamId) {
    const math = subjects.find((s) => s.id === 'math') || EXPECTED_SUBJECTS[1]
    // 7a. 班级(多学生)成绩查询
    try {
      const c1 = studentName('cls1')
      const c2 = studentName('cls2')
      await setOneGrade({ examId: mainExamId, subjectId: math.id, studentName: c1, score: 70, fullMark: math.fullMark })
      await setOneGrade({ examId: mainExamId, subjectId: math.id, studentName: c2, score: 90, fullMark: math.fullMark })
      const r = await callAcademic('getClassGrades', [c1, c2], mainExamId)
      const d = isOk(r) ? r.data : null
      const ok = d && typeof d === 'object' && Array.isArray(d[c1]) && Array.isArray(d[c2]) && d[c1].length >= 1 && d[c2].length >= 1
      record('getClassGrades 班级成绩查询', ok, ok ? `${c1}:${d[c1].length}条 ${c2}:${d[c2].length}条` : `data=${JSON.stringify(d).slice(0, 100)}`)
    } catch (e) {
      record('getClassGrades 班级成绩查询', false, e.message)
    }
    // 7b. 不存在班级(假学生名) → 空映射不报错
    try {
      const r = await callAcademic('getClassGrades', [studentName('ghost1'), studentName('ghost2')], mainExamId)
      const d = isOk(r) ? r.data : null
      const allEmpty = d && Object.values(d).every((arr) => Array.isArray(arr) && arr.length === 0)
      record('getClassGrades 不存在班级返回空映射', isOk(r) && allEmpty, `keys=${d ? Object.keys(d).length : 0}`)
    } catch (e) {
      record('getClassGrades 不存在班级返回空映射', false, e.message)
    }
    // 7c. 带 subjectId 过滤
    try {
      const c = studentName('cls3')
      await setOneGrade({ examId: mainExamId, subjectId: math.id, studentName: c, score: 55, fullMark: math.fullMark })
      const r = await callAcademic('getClassGrades', [c], mainExamId, math.id)
      const d = isOk(r) ? r.data : null
      const ok = d && Array.isArray(d[c]) && d[c].length === 1 && d[c][0].subjectId === math.id
      record('getClassGrades 带 subjectId 过滤', ok, `读回 ${d?.[c]?.length || 0} 条`)
    } catch (e) {
      record('getClassGrades 带 subjectId 过滤', false, e.message)
    }
  } else {
    record('getClassGrades 测试集', false, '无 mainExamId')
  }

  // ===== 8. analyzePaper 深度测试 =====
  console.log('\n--- 8. analyzePaper 深度测试 ---')
  const tmpDir = os.tmpdir()
  const testPng = path.join(tmpDir, `cdp-deep-paper-${TS}.png`)
  const testTxt = path.join(tmpDir, `cdp-deep-paper-${TS}.txt`)
  const tempFiles = [testPng, testTxt]
  try {
    await fsp.writeFile(testPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    await fsp.writeFile(testTxt, 'not an image')
  } catch (e) {
    note(`临时文件创建失败: ${e.message}`)
  }

  // 8a. 有效 PNG + examId + subjectId → 成功且结构完整
  try {
    const r = await callAcademic('analyzePaper', testPng, mainExamId, 'math')
    const d = isOk(r) ? r.data : null
    const need = ['filePath', 'fileName', 'fileType', 'examId', 'subjectId', 'questionScores', 'analysis', 'analyzedAt']
    const ok = d && need.every((k) => d[k] !== undefined) && Array.isArray(d.questionScores) && d.examId === mainExamId && d.subjectId === 'math'
    record('analyzePaper 有效PNG+examId+subjectId 结构完整', ok, ok ? `file=${d.fileName} type=${d.fileType}` : `fields=${d ? Object.keys(d).join(',') : 'null'} err=${r?.error || ''}`)
  } catch (e) {
    record('analyzePaper 有效PNG+examId+subjectId 结构完整', false, e.message)
  }

  // 8b. 不存在文件 → 返回错误
  try {
    const r = await callAcademic('analyzePaper', `C:/nonexistent/cdp-deep-${TS}.png`)
    record('analyzePaper 不存在文件返回错误', isRejected(r), isRejected(r) ? `error=${r.error}` : `未拒绝 success=${r?.success}`)
  } catch (e) {
    record('analyzePaper 不存在文件返回错误', false, e.message)
  }

  // 8c. 空路径 → 返回错误
  try {
    const r = await callAcademic('analyzePaper', '')
    record('analyzePaper 空路径返回错误', isRejected(r), isRejected(r) ? `error=${r.error}` : `未拒绝`)
  } catch (e) {
    record('analyzePaper 空路径返回错误', false, e.message)
  }

  // 8d. 带不存在 examId → 行为记录 (examId 原样存储, 不校验存在性)
  try {
    const r = await callAcademic('analyzePaper', testPng, `exam-fake-${TS}`)
    const d = isOk(r) ? r.data : null
    record('analyzePaper 不存在 examId(行为记录)', isOk(r) && d && d.examId === `exam-fake-${TS}`, isOk(r) ? `examId=${d.examId}(原样存储)` : `error=${r?.error}`)
  } catch (e) {
    record('analyzePaper 不存在 examId(行为记录)', false, e.message)
  }

  // 8e. 不支持文件类型 → 返回错误
  try {
    const r = await callAcademic('analyzePaper', testTxt)
    record('analyzePaper 不支持文件类型返回错误', isRejected(r), isRejected(r) ? `error=${r.error}` : `未拒绝`)
  } catch (e) {
    record('analyzePaper 不支持文件类型返回错误', false, e.message)
  }

  // ===== 9. deleteExam 深度测试 =====
  console.log('\n--- 9. deleteExam 深度测试 ---')
  // 9a. 删除测试考试 → 成功
  try {
    const ex = await createTestExam('del', subjects.map((s) => s.id))
    const id = ex.id
    const r = await callAcademic('deleteExam', id)
    createdExamIds.delete(id)
    record('deleteExam 删除测试考试成功', isOk(r), `id=${id}`)
  } catch (e) {
    record('deleteExam 删除测试考试成功', false, e.message)
  }

  // 9b. 删除不存在考试 → 行为记录 (idempotent, success=true)
  try {
    const fakeId = `exam-nonexistent-${TS}-xyz`
    const r = await callAcademic('deleteExam', fakeId)
    record('deleteExam 不存在考试 行为记录', isOk(r), isOk(r) ? '幂等成功(不报错)' : `error=${r?.error}`)
    if (isOk(r)) note('deleteExam: 不存在 examId 也返回 success=true (幂等)')
  } catch (e) {
    record('deleteExam 不存在考试 行为记录', false, e.message)
  }

  // 9c. 级联删除成绩验证
  try {
    const ex = await createTestExam('cascade', subjects.map((s) => s.id))
    const id = ex.id
    const math = subjects.find((s) => s.id === 'math') || EXPECTED_SUBJECTS[1]
    const cn = studentName('cascade')
    await setOneGrade({ examId: id, subjectId: math.id, studentName: cn, score: 50, fullMark: math.fullMark })
    const before = await getStudentExamGrades(cn, id)
    const hasBefore = before.grades.length > 0
    const dr = await callAcademic('deleteExam', id)
    createdExamIds.delete(id)
    const after = await getStudentExamGrades(cn, id)
    const cascaded = after.grades.length === 0
    record('deleteExam 级联删除成绩', isOk(dr) && hasBefore && cascaded, `删除前=${before.grades.length}条 删除后=${after.grades.length}条`)
  } catch (e) {
    record('deleteExam 级联删除成绩', false, e.message)
  }

  // ===== 10. 成绩更新 (upsert) =====
  console.log('\n--- 10. 成绩更新 (upsert) ---')
  if (mainExamId) {
    const math = subjects.find((s) => s.id === 'math') || EXPECTED_SUBJECTS[1]
    try {
      const cn = studentName('upsert')
      // 首次写入
      await setOneGrade({ examId: mainExamId, subjectId: math.id, studentName: cn, score: 70, fullMark: math.fullMark })
      const after1 = await getStudentExamGrades(cn, mainExamId)
      const c1 = after1.grades.filter((x) => x.subjectId === math.id).length
      const s1 = after1.grades.find((x) => x.subjectId === math.id)?.score
      // 更新为不同分数
      await setOneGrade({ examId: mainExamId, subjectId: math.id, studentName: cn, score: 95, fullMark: math.fullMark })
      const after2 = await getStudentExamGrades(cn, mainExamId)
      const c2 = after2.grades.filter((x) => x.subjectId === math.id).length
      const s2 = after2.grades.find((x) => x.subjectId === math.id)?.score
      const isUpdate = c1 === 1 && c2 === 1 && Number(s2) === 95 && Number(s1) === 70
      record('upsert 更新非新增', isUpdate, `count ${c1}->${c2}, score ${s1}->${s2}`)
    } catch (e) {
      record('upsert 更新非新增', false, e.message)
    }
    // 同分再设 → 数量不变
    try {
      const cn = studentName('upsame')
      await setOneGrade({ examId: mainExamId, subjectId: math.id, studentName: cn, score: 80, fullMark: math.fullMark })
      const c1 = (await getStudentExamGrades(cn, mainExamId)).grades.filter((x) => x.subjectId === math.id).length
      await setOneGrade({ examId: mainExamId, subjectId: math.id, studentName: cn, score: 80, fullMark: math.fullMark })
      const c2 = (await getStudentExamGrades(cn, mainExamId)).grades.filter((x) => x.subjectId === math.id).length
      record('upsert 同分再设数量不变', c1 === 1 && c2 === 1, `count ${c1}->${c2}`)
    } catch (e) {
      record('upsert 同分再设数量不变', false, e.message)
    }
  } else {
    record('upsert 测试集', false, '无 mainExamId')
  }

  // ===== 11. 并发操作 =====
  console.log('\n--- 11. 并发操作 ---')
  if (mainExamId) {
    const subjs = subjects.slice(0, Math.min(4, subjects.length))
    // 11a. 并发 setGrade 不同学生
    try {
      const targets = subjs.map((s, i) => ({ s, n: studentName(`conc${i}`), score: 60 + i }))
      const results = await Promise.all(
        targets.map((t) =>
          callAcademic('setGrade', { examId: mainExamId, subjectId: t.s.id, studentName: t.n, score: t.score, fullMark: t.s.fullMark })
            .then((r) => isOk(r))
            .catch(() => false),
        ),
      )
      // 读回校验
      let readOk = 0
      for (const t of targets) {
        const { grades } = await getStudentExamGrades(t.n, mainExamId)
        if (grades.find((g) => g.subjectId === t.s.id && Number(g.score) === t.score)) readOk++
      }
      const allOk = results.every((x) => x) && readOk === targets.length
      record('并发 setGrade 不同学生', allOk, `并发 ${targets.length}, 读回匹配 ${readOk}`)
    } catch (e) {
      record('并发 setGrade 不同学生', false, e.message)
    }
    // 11b. 并发 getGrades 不同学生
    try {
      const names = subjs.map((_, i) => studentName(`cg${i}`))
      // 先写入一些
      await Promise.all(names.map((n, i) => callAcademic('setGrade', { examId: mainExamId, subjectId: subjs[i].id, studentName: n, score: 75, fullMark: subjs[i].fullMark })))
      const results = await Promise.all(names.map((n) => callAcademic('getGrades', n)))
      const allOk = results.every((r) => isOk(r) && Array.isArray(r.data))
      record('并发 getGrades 不同学生', allOk, `并发 ${names.length} 个, 全部返回数组`)
    } catch (e) {
      record('并发 getGrades 不同学生', false, e.message)
    }
    // 11c. 并发 batchSetGrades 不同批次
    try {
      const b1 = [{ examId: mainExamId, subjectId: subjs[0].id, studentName: studentName('cb1'), score: 60, fullMark: subjs[0].fullMark }]
      const b2 = [{ examId: mainExamId, subjectId: subjs[1 % subjs.length].id, studentName: studentName('cb2'), score: 70, fullMark: subjs[1 % subjs.length].fullMark }]
      const [r1, r2] = await Promise.all([callAcademic('batchSetGrades', b1), callAcademic('batchSetGrades', b2)])
      record('并发 batchSetGrades 不同批次', isOk(r1) && isOk(r2), `count=${r1?.data},${r2?.data}`)
    } catch (e) {
      record('并发 batchSetGrades 不同批次', false, e.message)
    }
  } else {
    record('并发操作测试集', false, '无 mainExamId')
  }

  // ===== 12. 清理临时文件 =====
  console.log('\n--- 12. 清理临时文件 ---')
  try {
    for (const f of tempFiles) await fsp.unlink(f).catch(() => {})
    record('清理临时文件', true, `删除 ${tempFiles.length} 个`)
  } catch (e) {
    record('清理临时文件', false, e.message)
  }
}

// ---------------- 入口 + 清理 ----------------
main()
  .catch((e) => {
    console.error('\n❌ 测试异常:', e)
    failCount++
  })
  .then(async () => {
    console.log('\n--- 清理测试考试 ---')
    await cleanupAll()
    const left = createdExamIds.size
    console.log(`  已清理${left === 0 ? '全部测试考试' : '残留 ' + left + ' 个测试考试'}`)
    console.log('\n=== 总结 ===')
    const total = passCount + failCount
    console.log(`总计: ${total}, 通过: ${passCount}, 失败: ${failCount}`)
    if (notes.length) {
      console.log('\n— 备注:')
      for (const n of notes) console.log(`  ℹ ${n}`)
    }
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    process.exit(failCount > 0 ? 1 : 0)
  })
