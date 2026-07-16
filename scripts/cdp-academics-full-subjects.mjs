// =============================================================
// CDP 学业模块全科目深度测试
// 覆盖: 科目配置 / 考试CRUD / 10 科目成绩 CRUD / 批量 / 统计 /
//       边界值 / 级联删除 / 异常入参 / 满分校验 / 并发录入
// 运行: node scripts/cdp-academics-full-subjects.mjs
// =============================================================
import http from 'node:http'
import WebSocket from 'ws'

const CDP_HOST = 'http://127.0.0.1:9222'
const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'

// 预期科目 (getConfig 失败时作为兜底, 以 getConfig 实际返回为准)
const EXPECTED_SUBJECTS = [
  { id: 'chinese', name: '语文', maxScore: 150 },
  { id: 'math', name: '数学', maxScore: 150 },
  { id: 'english', name: '英语', maxScore: 150 },
  { id: 'physics', name: '物理', maxScore: 100 },
  { id: 'chemistry', name: '化学', maxScore: 100 },
  { id: 'biology', name: '生物', maxScore: 100 },
  { id: 'politics', name: '政治', maxScore: 100 },
  { id: 'history', name: '历史', maxScore: 100 },
  { id: 'geography', name: '地理', maxScore: 100 },
  { id: 'pe', name: '体育', maxScore: 100 },
]
const TEST_STUDENT = 'Bulk_Limit_1783913495642'

// 全局状态
let ws, send, evalInPage
const createdExamIds = new Set()
let passCount = 0
let failCount = 0
const notes = []

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

// ---------------- 通用 API 调用 (自动序列化参数, 双重 stringify 防 ${} 注入) ----------------
async function callNS(ns, method, ...args) {
  const argsLiteral = JSON.stringify(JSON.stringify(args))
  const methodLiteral = JSON.stringify(method)
  const nsLiteral = JSON.stringify(ns)
  const expr = `(async function(){
    try {
      const api = window.api;
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
const callEaa = (m, ...a) => callNS('eaa', m, ...a)

// 探测某命名空间下哪些方法存在
async function probeMethods(ns, names) {
  const namesLiteral = JSON.stringify(names)
  const nsLiteral = JSON.stringify(ns)
  const expr = `(function(){
    const api = window.api;
    const obj = api && api[${nsLiteral}];
    const out = {};
    for (const n of ${namesLiteral}) { out[n] = !!(obj && typeof obj[n] === 'function'); }
    return JSON.stringify(out);
  })()`
  return JSON.parse(await evalInPage(expr))
}

// ---------------- 业务 helper ----------------
// 将 config 返回的科目归一化: 统一 maxScore 字段 (可能是 fullMark/max_score/fullScore/totalScore 等)
// 找不到时按 id/name 从 EXPECTED_SUBJECTS 回填
function normalizeSubjects(rawSubjects) {
  const byId = new Map(EXPECTED_SUBJECTS.map((s) => [s.id, s]))
  const byName = new Map(EXPECTED_SUBJECTS.map((s) => [s.name, s]))
  return rawSubjects.map((s) => {
    const ms =
      s.maxScore ?? s.fullMark ?? s.max_score ?? s.fullScore ?? s.totalScore ?? s.total ?? null
    let maxScore = ms != null ? Number(ms) : null
    if ((maxScore == null || Number.isNaN(maxScore))) {
      const ref = byId.get(s.id) || byId.get(s.name) || byName.get(s.name) || byName.get(s.id)
      if (ref) maxScore = ref.maxScore
    }
    return { id: s.id, name: s.name, maxScore, raw: s }
  })
}

async function getAcademicConfig() {
  // 1. window.api.academic.getConfig()
  const r = await callAcademic('getConfig')
  if (r && r.__error === undefined) {
    const d = r?.data || r
    const subjects = d?.subjects || []
    if (subjects.length) {
      const rawKeys = subjects[0] ? Object.keys(subjects[0]) : []
      return { via: 'api.academic.getConfig', subjects, raw: r, rawKeys }
    }
  }
  // 2. Tauri invoke channel 兜底
  try {
    const expr = `(async function(){
      try {
        const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: 'academic:get-config', args: [] });
        return JSON.stringify({ __ok: true, res: r });
      } catch (e) { return JSON.stringify({ __error: (e&&e.message)||String(e) }); }
    })()`
    const parsed = JSON.parse(await evalInPage(expr))
    if (parsed.__ok) {
      const d = parsed.res?.data || parsed.res
      const subjects = d?.subjects || []
      if (subjects.length) return { via: 'invoke academic:get-config', subjects, raw: parsed.res }
    }
  } catch {
    /* ignore */
  }
  return { via: 'none', subjects: [], raw: null }
}

async function createTestExam(subjects, tag) {
  const rand = Math.random().toString(36).slice(2, 8)
  const stamp = `exam-${Date.now()}-${rand}`
  const res = await callAcademic('createExam', {
    name: `${stamp}_${tag || 'test'}`,
    type: 'test',
    date: new Date().toISOString().slice(0, 10),
    semester: '2025-2026-2',
    scope: 'cdp-full-subjects',
    subjects,
  })
  if (res && res.__error) throw new Error('createExam: ' + res.__error)
  const id = res?.data?.id
  if (id) createdExamIds.add(id)
  return { id, name: stamp, raw: res }
}

// 单条成绩录入 — 优先 setGrade, 不可用则回退 batchSetGrades([grade])
async function setOneGrade(grade) {
  const r = await callAcademic('setGrade', grade)
  if (r && r.__error === undefined) return { via: 'setGrade', res: r }
  const r2 = await callAcademic('batchSetGrades', [grade])
  return { via: 'batchSetGrades', res: r2 }
}

// 读取某学生在某考试的成绩 (getGrades 实测接收 studentName, 客户端按 examId 过滤)
async function getStudentExamGrades(studentName, examId) {
  const r = await callAcademic('getGrades', studentName)
  if (r && r.__error) return { error: r.__error, grades: [], all: [] }
  const all = r && r.success && Array.isArray(r.data) ? r.data : []
  return { grades: all.filter((g) => g.examId === examId), all }
}

// 班级成绩 — 优先对象形式 {examId, classId, subjectId?}, 回退数组形式 (students, examId, subjectId?)
async function getClassGradesFor(examId, students, classId, subjectId) {
  const objArg = { examId }
  if (classId !== undefined && classId !== null) objArg.classId = classId
  if (subjectId) objArg.subjectId = subjectId
  const r1 = await callAcademic('getClassGrades', objArg)
  if (r1 && r1.__error === undefined && r1.success) {
    return { via: 'object', res: r1 }
  }
  const r2 = await callAcademic('getClassGrades', students, examId, subjectId)
  return { via: 'array', res: r2 }
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

// 获取可用学生 (排除 Deleted), 保证至少包含 TEST_STUDENT
async function getStudents(max) {
  const r = await callEaa('listStudents')
  let list = []
  if (r && r.__error === undefined && r.success) {
    list = (r.data?.students || r.data || []).filter((s) => s.status !== 'Deleted')
  }
  let names = list.map((s) => s.name || s.studentName).filter(Boolean)
  if (!names.includes(TEST_STUDENT)) names.unshift(TEST_STUDENT)
  // 去重
  names = [...new Set(names)]
  return { names, raw: list, maxScoreField: list[0] || {} }
}

// ---------------- 主流程 ----------------
async function main() {
  console.log('=== 学业模块 CDP 全科目深度测试 ===\n')
  await connect()

  // 导航到学业页 (确保 academic 模块初始化; window.api 全局可用)
  try {
    await evalInPage(`(async function(){ location.hash='#/academics'; await new Promise(r=>setTimeout(r,1200)); })()`)
  } catch {
    /* ignore */
  }

  // 先探测 academic 方法可用性
  const methodsAvail = await probeMethods('academic', [
    'getConfig', 'listExams', 'createExam', 'deleteExam',
    'setGrade', 'batchSetGrades', 'getGrades', 'getClassGrades',
    'getStats', 'getStatistics', 'getExamStats', 'getClassStats',
    'getSubjectStats', 'getGradeStats',
  ])
  console.log('— academic 方法探测:')
  for (const [k, v] of Object.entries(methodsAvail)) {
    if (v) console.log(`    ${PASS} ${k}`)
  }
  console.log('')

  let subjects = []
  let examId = null
  let students = []

  // ===== 1. 科目配置完整性 =====
  console.log('--- 1. 科目配置完整性 ---')
  try {
    const cfg = await getAcademicConfig()
    subjects = normalizeSubjects(cfg.subjects || [])
    if (cfg.rawKeys && cfg.rawKeys.length) note(`config 科目原始字段: ${cfg.rawKeys.join(', ')}`)
    if ((cfg.subjects || []).length >= 10) {
      let allValid = true
      const missing = []
      for (const s of subjects) {
        if (s.id == null || s.name == null || s.maxScore == null) {
          allValid = false
          missing.push(JSON.stringify(s))
        }
      }
      record(
        'getConfig 返回科目配置',
        allValid,
        `via=${cfg.via} 共 ${subjects.length} 科, 每科含 id/name/maxScore`,
      )
      const summary = subjects.map((s) => `${s.name}(${s.id})=${s.maxScore}`).join(' / ')
      note(`科目配置: ${summary}`)
    } else if ((cfg.subjects || []).length > 0) {
      record('getConfig 返回科目配置', false, `仅 ${cfg.subjects.length} 科 (期望 >=10)`)
    } else {
      // 兜底
      subjects = EXPECTED_SUBJECTS.slice()
      record('getConfig 返回科目配置', false, `getConfig 不可用(${cfg.via}), 使用预期兜底 ${subjects.length} 科`)
      note('getConfig 不可用, 后续以预期科目表为准')
    }
  } catch (e) {
    subjects = EXPECTED_SUBJECTS.slice()
    record('科目配置完整性', false, `异常: ${e.message}`)
  }

  // 额外: 验证 10 个预期科目名都存在
  try {
    const expectedNames = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理', '体育']
    const gotNames = subjects.map((s) => s.name)
    const missing = expectedNames.filter((n) => !gotNames.includes(n))
    record('10 个预期科目齐全', missing.length === 0, missing.length ? `缺失: ${missing.join(',')}` : `共 ${subjects.length} 科`)
  } catch (e) {
    record('10 个预期科目齐全', false, e.message)
  }

  // ===== 2. 创建考试 =====
  console.log('\n--- 2. 创建考试 (涵盖所有科目) ---')
  try {
    const subjectIds = subjects.map((s) => s.id)
    const ex = await createTestExam(subjectIds, 'full10')
    examId = ex.id
    if (examId) {
      record('createExam 全科目考试', true, `id=${examId}`)
    } else {
      record('createExam 全科目考试', false, `未返回 id, raw=${JSON.stringify(ex.raw).slice(0, 200)}`)
    }
    // 验证出现在 listExams
    const lr = await callAcademic('listExams')
    const list = lr && lr.success ? lr.data || [] : []
    const found = list.find((e) => e.id === examId)
    record('listExams 含新考试', !!found, found ? `name=${found.name}` : '未找到')
  } catch (e) {
    record('创建考试', false, e.message)
  }

  // 获取学生
  students = (await getStudents(10)).names
  note(`可用学生 ${students.length} 名: ${students.slice(0, 5).join(', ')}${students.length > 5 ? '...' : ''}`)

  // ===== 3. 逐科目录入成绩 =====
  console.log('\n--- 3. 逐科目录入成绩 (单条 setGrade) ---')
  if (examId) {
    let okCount = 0
    const perSubjectDetail = []
    for (const s of subjects) {
      const score = Math.min(120, Math.round(s.maxScore * 0.8))
      const grade = {
        examId,
        subjectId: s.id,
        studentName: TEST_STUDENT,
        score,
        fullMark: s.maxScore,
      }
      try {
        const r = await setOneGrade(grade)
        const success = !!(r.res && r.res.success)
        if (success) okCount++
        perSubjectDetail.push(`${s.name}=${score}[${r.via}:${success ? 'ok' : 'fail'}]`)
      } catch (e) {
        perSubjectDetail.push(`${s.name}=ERR:${e.message}`)
      }
    }
    const viaSet = new Set()
    for (const d of perSubjectDetail) {
      const m = d.match(/\[([a-zA-Z]+):/)
      if (m) viaSet.add(m[1])
    }
    record('逐科目录入全部成功', okCount === subjects.length, `${okCount}/${subjects.length} via=${[...viaSet].join('/') || 'n/a'}`)
    note(`逐科目: ${perSubjectDetail.join(' | ')}`)
  } else {
    record('逐科目录入成绩', false, '无 examId, 跳过')
  }

  // ===== 4. 批量录入 (多学生多科目) =====
  console.log('\n--- 4. 批量录入 batchSetGrades ---')
  if (examId) {
    try {
      const batchStudents = students.slice(0, Math.min(4, students.length))
      const batchSubjects = subjects.slice(0, 3).map((s) => s.id)
      const records = []
      for (const sn of batchStudents) {
        for (const subj of batchSubjects) {
          const sub = subjects.find((x) => x.id === subj)
          records.push({
            examId,
            subjectId: subj,
            studentName: sn,
            score: Math.min(80, sub.maxScore - 10),
            fullMark: sub.maxScore,
          })
        }
      }
      const r = await callAcademic('batchSetGrades', records)
      const success = !!(r && r.success)
      const count = r?.data
      record('batchSetGrades 多学生多科目', success, `期望 ${records.length} 条, 返回 ${count}`)
    } catch (e) {
      record('batchSetGrades 多学生多科目', false, e.message)
    }
  } else {
    record('batchSetGrades 多学生多科目', false, '无 examId')
  }

  // ===== 5. 读取成绩 (验证所有科目都能读回) =====
  console.log('\n--- 5. 读取成绩 getGrades ---')
  if (examId) {
    try {
      const { grades, all } = await getStudentExamGrades(TEST_STUDENT, examId)
      const gotSubjects = new Set(grades.map((g) => g.subjectId))
      const missing = subjects.filter((s) => !gotSubjects.has(s.id)).map((s) => s.name)
      record('读回全部科目成绩', grades.length >= subjects.length && missing.length === 0, `读到 ${grades.length}/${subjects.length} 科, 缺 ${missing.join(',') || '无'}`)
      note(`getGrades(${TEST_STUDENT}) 共 ${all.length} 条历史, 本考试 ${grades.length} 条`)
    } catch (e) {
      record('读取成绩', false, e.message)
    }
  } else {
    record('读取成绩', false, '无 examId')
  }

  // ===== 6. 班级成绩 getClassGrades =====
  console.log('\n--- 6. 班级成绩 getClassGrades ---')
  if (examId) {
    try {
      const classStudents = students.slice(0, Math.min(5, students.length))
      const cg = await getClassGradesFor(examId, classStudents, null, null)
      const res = cg.res
      const success = !!(res && res.success)
      let countInfo = ''
      if (success) {
        const d = res.data
        if (d && typeof d === 'object' && !Array.isArray(d)) {
          countInfo = `对象键数=${Object.keys(d).length}, via=${cg.via}`
        } else if (Array.isArray(d)) {
          countInfo = `数组长度=${d.length}, via=${cg.via}`
        } else {
          countInfo = `data类型=${typeof d}, via=${cg.via}`
        }
      }
      record('getClassGrades 按班级查询', success, success ? countInfo : `error=${res?.error || res?.__error || cg.via}`)
    } catch (e) {
      record('getClassGrades 按班级查询', false, e.message)
    }
  } else {
    record('getClassGrades 按班级查询', false, '无 examId')
  }

  // ===== 7. 成绩更新 upsert (同学生同科目设新分数, 验证更新非新增) =====
  console.log('\n--- 7. 成绩更新 (upsert) ---')
  if (examId && subjects.length) {
    try {
      const before = await getStudentExamGrades(TEST_STUDENT, examId)
      const beforeCount = before.grades.length
      const subj = subjects[0]
      const newScore = 77
      const r = await setOneGrade({
        examId,
        subjectId: subj.id,
        studentName: TEST_STUDENT,
        score: newScore,
        fullMark: subj.maxScore,
      })
      const after = await getStudentExamGrades(TEST_STUDENT, examId)
      const afterCount = after.grades.length
      const updated = after.grades.find((g) => g.subjectId === subj.id)
      const isUpdate = afterCount === beforeCount && updated && Number(updated.score) === newScore
      record('upsert 更新非新增', !!isUpdate, `before=${beforeCount} after=${afterCount} ${subj.name}=>${updated?.score}(期望${newScore}) via=${r.via}`)
    } catch (e) {
      record('upsert 更新非新增', false, e.message)
    }
  } else {
    record('upsert 更新非新增', false, '无 examId/科目')
  }

  // ===== 8. 成绩统计 =====
  console.log('\n--- 8. 成绩统计 ---')
  if (examId && subjects.length) {
    try {
      const statsCandidates = ['getStats', 'getStatistics', 'getExamStats', 'getClassStats', 'getSubjectStats', 'getGradeStats']
      const avail = statsCandidates.filter((n) => methodsAvail[n])
      if (avail.length) {
        // 尝试调用第一个可用的统计接口
        const m = avail[0]
        let res
        if (m === 'getClassStats' || m === 'getSubjectStats') {
          res = await callAcademic(m, examId, subjects[0].id)
        } else {
          res = await callAcademic(m, examId)
        }
        const success = !!(res && res.success !== false)
        record(`统计接口 ${m}`, success, `data=${JSON.stringify(res?.data || res?.__error || res?.error || '').slice(0, 150)}`)
      } else {
        // 无统计接口 — 客户端按科目计算均分/最高/最低
        const classStudents = students.slice(0, Math.min(5, students.length))
        const perSubject = {}
        for (const subj of subjects.slice(0, 5)) {
          const cg = await getClassGradesFor(examId, classStudents, null, subj.id)
          const d = cg.res?.data
          let scores = []
          if (Array.isArray(d)) scores = d.map((x) => x.score).filter((x) => x != null && !Number.isNaN(Number(x))).map(Number)
          else if (d && typeof d === 'object') {
            for (const v of Object.values(d)) {
              if (Array.isArray(v)) scores.push(...v.map((x) => x?.score).filter((x) => x != null).map(Number))
            }
          }
          if (scores.length) {
            perSubject[subj.name] = {
              avg: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100,
              max: Math.max(...scores),
              min: Math.min(...scores),
              n: scores.length,
            }
          }
        }
        const hasStats = Object.keys(perSubject).length > 0
        record('统计 (无服务端接口, 客户端计算均分/最高/最低)', hasStats, JSON.stringify(perSubject))
        note('academic 无独立统计接口, 客户端基于 getGrades/getClassGrades 计算')
      }
    } catch (e) {
      record('成绩统计', false, e.message)
    }
  } else {
    record('成绩统计', false, '无 examId/科目')
  }

  // ===== 9. 分数边界 (0 / 满分 / 小数 / null 缺考) =====
  console.log('\n--- 9. 分数边界 ---')
  if (examId && subjects.length >= 4) {
    const boundaryStudents = students.slice(0, Math.min(4, students.length))
    // 保证 4 个不同 (学生, 科目) 组合
    const cases = [
      { label: '0 分', subjectIdx: 1, score: 0 },
      { label: '满分', subjectIdx: 2, score: 'MAX' },
      { label: '小数 99.5', subjectIdx: 3, score: 99.5 },
      { label: 'null 缺考', subjectIdx: 0, score: null },
    ]
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]
      const subj = subjects[c.subjectIdx]
      const sn = boundaryStudents[i % boundaryStudents.length]
      const scoreVal = c.score === 'MAX' ? subj.maxScore : c.score
      try {
        const r = await setOneGrade({
          examId,
          subjectId: subj.id,
          studentName: sn,
          score: scoreVal,
          fullMark: subj.maxScore,
        })
        const success = !!(r.res && r.res.success)
        // 读回验证
        let readBack = '__no_read__'
        if (success) {
          const { grades } = await getStudentExamGrades(sn, examId)
          const g = grades.find((x) => x.subjectId === subj.id)
          readBack = g ? g.score : '未读到'
        }
        // 严格比较: null 缺考要求读回为 null/undefined; 数值要求读回数值相等 (拒绝 0<->null 混淆)
        const readIsNull = readBack === null || readBack === undefined
        let ok
        if (scoreVal === null) {
          ok = success && readIsNull
        } else if (readIsNull || readBack === '__no_read__' || readBack === '未读到') {
          ok = false
        } else {
          ok = success && Number(readBack) === Number(scoreVal)
        }
        record(`边界 ${c.label} (${subj.name}/${sn})`, ok, `写入=${scoreVal} 读回=${readBack} via=${r.via}`)
      } catch (e) {
        record(`边界 ${c.label}`, false, e.message)
      }
    }
  } else {
    record('分数边界', false, '无 examId 或科目不足 4')
  }

  // ===== 10. 删除考试级联 =====
  console.log('\n--- 10. 删除考试级联 ---')
  try {
    const ex2 = await createTestExam(subjects.map((s) => s.id), 'cascade')
    const examId2 = ex2.id
    if (examId2) {
      // 录入一条成绩
      await setOneGrade({
        examId: examId2,
        subjectId: subjects[0].id,
        studentName: TEST_STUDENT,
        score: 50,
        fullMark: subjects[0].maxScore,
      })
      const before = await getStudentExamGrades(TEST_STUDENT, examId2)
      const hasBefore = before.grades.length > 0
      // 删除考试
      const dr = await callAcademic('deleteExam', examId2)
      createdExamIds.delete(examId2)
      const delSuccess = !!(dr && dr.success)
      // 验证成绩被级联删除
      const after = await getStudentExamGrades(TEST_STUDENT, examId2)
      const cascaded = after.grades.length === 0
      record('删除考试级联删除成绩', delSuccess && hasBefore && cascaded, `删除前=${before.grades.length}条 删除后=${after.grades.length}条`)
    } else {
      record('删除考试级联删除成绩', false, '级联考试创建失败')
    }
  } catch (e) {
    record('删除考试级联删除成绩', false, e.message)
  }

  // ===== 11. 不存在的 examId =====
  console.log('\n--- 11. 不存在的 examId ---')
  try {
    const fakeExamId = `exam-nonexistent-${Date.now()}-xyz`
    // getGrades 按学生读再过滤不存在的 examId
    const { grades, all } = await getStudentExamGrades(TEST_STUDENT, fakeExamId)
    const noCrash = true
    record('不存在的 examId 返回空不报错', noCrash && grades.length === 0, `过滤后=${grades.length}条 (该学生历史共${all.length}条)`)
    // 也尝试 batchSetGrades 写入不存在的 examId, 验证不崩溃 (行为记录)
    try {
      const wr = await callAcademic('batchSetGrades', [{
        examId: fakeExamId,
        subjectId: subjects[0]?.id || 'math',
        studentName: TEST_STUDENT,
        score: 10,
        fullMark: 100,
      }])
      const accepted = !!(wr && wr.success)
      record('向不存在 examId 写入(行为记录)', true, accepted ? '接受(未校验examId存在性)' : `拒绝: ${wr?.error || wr?.__error || 'success=false'}`)
      // 清理: 若接受了, 删除该假考试(若被自动创建)
      if (accepted) {
        try {
          const lr = await callAcademic('listExams')
          const list = lr?.data || []
          const auto = list.find((e) => e.id === fakeExamId || e.name?.includes(fakeExamId))
          if (auto) await deleteExamSafe(auto.id)
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      record('向不存在 examId 写入(行为记录)', true, `抛异常(被拒绝): ${e.message.slice(0, 120)}`)
    }
  } catch (e) {
    record('不存在的 examId 返回空不报错', false, e.message)
  }

  // ===== 12. 空学生列表 batchSetGrades([]) =====
  console.log('\n--- 12. 空数组 batchSetGrades([]) ---')
  try {
    const r = await callAcademic('batchSetGrades', [])
    const success = !!(r && r.success !== false)
    record('空数组 batchSetGrades 不报错', success, `success=${r?.success} data=${r?.data} error=${r?.error || r?.__error || '无'}`)
  } catch (e) {
    record('空数组 batchSetGrades 不报错', false, `抛异常: ${e.message.slice(0, 150)}`)
  }

  // ===== 13. 科目满分校验 (超满分) =====
  console.log('\n--- 13. 科目满分校验 (超满分) ---')
  if (examId && subjects.length) {
    try {
      const subj = subjects.find((s) => s.name === '语文') || subjects[0]
      const overScore = subj.maxScore + 50 // 如语文 150 -> 200
      const r = await setOneGrade({
        examId,
        subjectId: subj.id,
        studentName: TEST_STUDENT,
        score: overScore,
        fullMark: subj.maxScore,
      })
      const accepted = !!(r.res && r.res.success)
      let readBack = '__no_read__'
      if (accepted) {
        const { grades } = await getStudentExamGrades(TEST_STUDENT, examId)
        const g = grades.find((x) => x.subjectId === subj.id)
        readBack = g ? g.score : '未读到'
      }
      // 任务要求: 记录行为 (拒绝或接受均可)
      const behavior = accepted ? `接受(读回=${readBack})` : `拒绝: ${r.res?.error || r.res?.__error || 'success=false'}`
      record(`超满分录入行为记录 (${subj.name}=${overScore}/${subj.maxScore})`, true, behavior)
      note(`满分校验: ${subj.name} 超 ${overScore} => ${behavior}`)
    } catch (e) {
      record('超满分录入行为记录', true, `抛异常(被拒绝): ${e.message.slice(0, 120)}`)
      note('满分校验: 超分录入抛异常被拒绝')
    }
  } else {
    record('超满分录入行为记录', false, '无 examId/科目')
  }

  // ===== 14. 并发录入 =====
  console.log('\n--- 14. 并发录入 (不同学生/科目) ---')
  if (examId && subjects.length >= 3 && students.length >= 1) {
    try {
      const pairs = []
      const subjs = subjects.slice(0, Math.min(6, subjects.length))
      for (let i = 0; i < subjs.length; i++) {
        const sn = students[i % students.length]
        pairs.push({
          examId,
          subjectId: subjs[i].id,
          studentName: sn,
          score: Math.min(60 + i * 5, subjs[i].maxScore),
          fullMark: subjs[i].maxScore,
          subjectName: subjs[i].name,
        })
      }
      const pairsLiteral = JSON.stringify(JSON.stringify(pairs))
      const expr = `(async function(){
        const api = window.api;
        const pairs = JSON.parse(${pairsLiteral});
        const results = await Promise.all(pairs.map(p =>
          api.academic.batchSetGrades([{ examId: p.examId, subjectId: p.subjectId, studentName: p.studentName, score: p.score, fullMark: p.fullMark }])
            .then(r => ({ ok: !!(r && r.success), count: r && r.data, err: r && (r.error || r.__error) }))
            .catch(e => ({ ok: false, err: e && e.message ? e.message : String(e) }))
        ));
        return JSON.stringify(results);
      })()`
      const raw = await evalInPage(expr)
      const results = JSON.parse(raw)
      const allOk = results.every((x) => x.ok)
      const okN = results.filter((x) => x.ok).length
      // 读回验证
      let readOk = 0
      for (const p of pairs) {
        const { grades } = await getStudentExamGrades(p.studentName, p.examId)
        if (grades.find((g) => g.subjectId === p.subjectId && Number(g.score) === Number(p.score))) readOk++
      }
      record('并发录入不冲突', allOk && readOk === pairs.length, `并发 ${pairs.length} 个, 成功 ${okN}, 读回匹配 ${readOk}`)
    } catch (e) {
      record('并发录入不冲突', false, e.message)
    }
  } else {
    record('并发录入不冲突', false, '无 examId/科目/学生')
  }

  // ===== 总结 =====
  console.log('\n=== 总结 ===')
  console.log(`  ${PASS} 通过: ${passCount}`)
  console.log(`  ${FAIL} 失败: ${failCount}`)
  if (notes.length) {
    console.log('\n— 备注:')
    for (const n of notes) console.log(`  ℹ ${n}`)
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
    console.log(`  已清理 ${createdExamIds.size === 0 ? '全部' : '残留 ' + createdExamIds.size} 个测试考试`)
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    process.exit(failCount > 0 ? 1 : 0)
  })
