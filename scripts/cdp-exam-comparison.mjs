// =============================================================
// CDP 考试对比功能深度测试
// 覆盖: 数据创建(学生/班级/考试/成绩/操行事件) +
//       CompareTab UI 驱动(选择器/汇总卡片/对比表/DeltaBadge) +
//       纯函数交叉验证(与 exam-comparison.ts 预期值对比) +
//       边界情况(空班级/相同考试/未分班过滤) +
//       已知 UX bug 验证(未选学生时对比 tab 被阻挡)
// 运行: node scripts/cdp-exam-comparison.mjs
// =============================================================
import http from 'node:http'
import WebSocket from 'ws'

const CDP_HOST = 'http://127.0.0.1:9222'
const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'
const WARN = '\x1b[33m!\x1b[0m'

// 全局状态
let ws, send, evalInPage
let passCount = 0
let failCount = 0
let warnCount = 0
const notes = []
const bugs = []

const TS = Date.now()
// 仅含字母/数字/下划线,通过 sanitizeName (中文也允许,这里混用)
const uid = (tag) => `Cmp${TS}_${tag}`

// 全局考试 ID 集合(cleanup 需在 main 外访问)
const createdExamIds = new Set()

function record(name, ok, detail = '') {
  if (ok === true) passCount++
  else if (ok === 'warn') warnCount++
  else failCount++
  const mark = ok === true ? 'PASS' : ok === 'warn' ? 'WARN' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ' — ' + detail : ''}`)
}
const note = (m) => notes.push(m)
const bug = (m) => bugs.push(m)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------- CDP 连接 ----------------
const httpGet = (u) =>
  new Promise((r, j) => {
    http.get(u, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try { r(JSON.parse(d)) } catch (e) { j(e) }
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
      throw new Error(desc.substring(0, 800))
    }
    return r.result?.result?.value
  }
  await new Promise((r) => ws.on('open', r))
}

// ---------------- 通用 IPC 调用 ----------------
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
  try { parsed = JSON.parse(raw) } catch { return { __error: 'non-json: ' + String(raw).slice(0, 200) } }
  if (parsed.__error) return { __error: parsed.__error }
  return parsed.res
}
const callEAA = (m, ...a) => callNS('eaa', m, ...a)
const callAcademic = (m, ...a) => callNS('academic', m, ...a)
const callClass = (m, ...a) => callNS('class', m, ...a)

const isOk = (r) => !!r && r.__error === undefined && r.success === true
const isRejected = (r) => !!r && r.__error === undefined && r.success === false

// ---------------- React 选择器驱动 ----------------
// React 受控 <select> 必须用原生 setter + change 事件才能触发 onChange
// 通过 option 文本特征定位 CompareTab 内的 3 个 select
// 注意: 页面 header 也有 classFilter(全部班级),需区分 — 用最后一个匹配的(CompareTab 在 header 后渲染)
async function setCompareSelect(which, value) {
  // which: 'classFilter' | 'examA' | 'examB'
  return evalInPage(`(function(){
    const sels = Array.from(document.querySelectorAll('select'));
    let candidates = [];
    let target = null;
    if (${JSON.stringify(which)} === 'classFilter') {
      // classFilter: 首个 option "全部班级" — 取最后一个(header 在前, CompareTab 在后)
      candidates = sels.filter(s => s.options[0] && s.options[0].textContent.includes('全部班级'));
      if (candidates.length === 0) return { ok: false, error: 'classFilter select 未找到' };
      // 用最后一个 (CompareTab 的)
      target = candidates[candidates.length - 1];
    } else if (${JSON.stringify(which)} === 'examA') {
      candidates = sels.filter(s => s.options[0] && s.options[0].textContent.includes('选择考试 A'));
      if (candidates.length === 0) return { ok: false, error: 'examA select 未找到' };
      target = candidates[candidates.length - 1];
    } else if (${JSON.stringify(which)} === 'examB') {
      candidates = sels.filter(s => s.options[0] && s.options[0].textContent.includes('选择考试 B'));
      if (candidates.length === 0) return { ok: false, error: 'examB select 未找到' };
      target = candidates[candidates.length - 1];
    } else {
      return { ok: false, error: 'unknown which: ' + ${JSON.stringify(which)} };
    }
    if (!target) return { ok: false, error: 'target not assigned' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(target, ${JSON.stringify(value)});
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: target.value, optionCount: target.options.length, matched: candidates.length };
  })()`)
}

// 通用版:按 CSS selector
async function setSelectValue(selector, value) {
  return evalInPage(`(function(){
    const sel = document.querySelector(${JSON.stringify(selector)});
    if (!sel) return { ok: false, error: 'select not found: ' + ${JSON.stringify(selector)} };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, ${JSON.stringify(value)});
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: sel.value };
  })()`)
}

async function clickTab(tabLabel) {
  return evalInPage(`(function(){
    const btns = Array.from(document.querySelectorAll('button'));
    const target = btns.find(b => b.textContent && b.textContent.includes(${JSON.stringify(tabLabel)}));
    if (!target) return { ok: false, error: 'tab button not found: ' + ${JSON.stringify(tabLabel)} };
    target.click();
    return { ok: true, text: target.textContent.trim() };
  })()`)
}

async function clickStudentInList(studentName) {
  return evalInPage(`(function(){
    // 学生列表项可能是 button/li/div,按文本匹配
    const candidates = document.querySelectorAll('button, li, [role="button"], .student-item, .student-row');
    for (const el of candidates) {
      if (el.textContent && el.textContent.trim().includes(${JSON.stringify(studentName)})) {
        el.click();
        return { ok: true, tag: el.tagName, text: el.textContent.trim().slice(0, 60) };
      }
    }
    return { ok: false, error: 'student not found in list: ' + ${JSON.stringify(studentName)} };
  })()`)
}

async function waitFor(ms) { await sleep(ms) }

async function getCompareTabDOM() {
  return evalInPage(`(function(){
    const out = { hasSelectors: false, hasSummary: false, hasTable: false, hasEmpty: false, hasChart: false, bodyText: '', selectCount: 0, compareSelectCount: 0, tableRows: 0, summaryCards: 0, deltaBadges: 0, emptyTitle: '', emptyDesc: '' };
    // 全部 select 数量
    const allSelects = document.querySelectorAll('select');
    out.selectCount = allSelects.length;
    // CompareTab 专属 select: 首个 option 含 "全部班级" / "选择考试 A" / "选择考试 B"
    let cmpSelects = 0;
    for (const s of allSelects) {
      if (s.options[0] && (s.options[0].textContent.includes('全部班级') || s.options[0].textContent.includes('选择考试'))) cmpSelects++;
    }
    out.compareSelectCount = cmpSelects;
    out.hasSelectors = cmpSelects >= 3;
    // 汇总卡片 (grid 容器下 4 个 div,且首个含 "班级平均分变化")
    const grids = document.querySelectorAll('.grid');
    for (const g of grids) {
      const divs = g.querySelectorAll(':scope > div');
      if (divs.length === 4 && divs[0].textContent.includes('班级平均分变化')) {
        out.summaryCards = 4;
        out.hasSummary = true;
        break;
      }
    }
    // 对比表
    const rows = document.querySelectorAll('table tbody tr');
    out.tableRows = rows.length;
    out.hasTable = rows.length > 0;
    // ECharts 图表
    out.hasChart = document.querySelectorAll('canvas, [_echarts_instance_]').length > 0;
    // 空状态: EmptyState 用 <h3> 标题, 查找含特定标题的 h3
    const h3s = document.querySelectorAll('h3');
    for (const h of h3s) {
      const title = h.textContent.trim();
      if (title === '选择两场考试进行对比' || title === '暂无对比数据' || title === '请先选择学生') {
        out.hasEmpty = true;
        out.emptyTitle = title;
        const desc = h.nextElementSibling;
        out.emptyDesc = desc ? desc.textContent.trim() : '';
        break;
      }
    }
    // DeltaBadge 数量
    out.deltaBadges = document.querySelectorAll('span.inline-flex').length;
    out.bodyText = document.body.innerText.slice(0, 1500);
    return out;
  })()`)
}

async function getSummaryValues() {
  return evalInPage(`(function(){
    // 汇总卡片: 班级平均分变化 / 进步最多 / 退步最多 / 参与对比
    const cards = document.querySelectorAll('.grid > div');
    if (cards.length < 4) return { ok: false, error: 'cards<4' };
    const text = (i) => cards[i] ? cards[i].textContent.trim() : '';
    return {
      ok: true,
      avgScoreDelta: text(0),
      mostImproved: text(1),
      mostDeclined: text(2),
      totalStudents: text(3),
    };
  })()`)
}

async function getStudentTableRows() {
  return evalInPage(`(function(){
    const rows = document.querySelectorAll('table tbody tr');
    if (!rows.length) return { ok: false, rows: [] };
    const data = Array.from(rows).map(r => {
      const cells = r.querySelectorAll('td');
      return {
        name: cells[0] ? cells[0].textContent.trim() : '',
        totalA: cells[1] ? cells[1].textContent.trim() : '',
        totalB: cells[2] ? cells[2].textContent.trim() : '',
        totalDelta: cells[3] ? cells[3].textContent.trim() : '',
        improvedDeclined: cells[4] ? cells[4].textContent.trim() : '',
        conductDelta: cells[5] ? cells[5].textContent.trim() : '',
      };
    });
    return { ok: true, rows: data };
  })()`)
}

async function navigateTo(hash) {
  await evalInPage(`window.location.hash = ${JSON.stringify(hash)}`)
  await waitFor(1500)
}

// ---------------- 主流程 ----------------
async function main() {
  console.log('=== 考试对比功能 CDP 深度测试 ===\n')
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`UID 前缀: ${TS}\n`)

  await connect()

  // 测试数据准备
  const studentA = uid('stuA') // 进步生
  const studentB = uid('stuB') // 退步生
  const studentC = uid('stuC') // 持平生
  const studentD = uid('stuD') // 仅 A 有成绩
  const classId = `cdpcmp${TS}`.slice(0, 20) // sanitizeClassId 只允许字母数字.-,长度<=32
  const className = `CDP对比测试班_${TS}`
  const examAName = `CDP对比考试A_${TS}`
  const examBName = `CDP对比考试B_${TS}`
  const examADate = '2026-07-10'
  const examBDate = '2026-07-20'

  // 预期值(与 exam-comparison.ts 纯函数逻辑一致)
  // StudentA: math 70→80 (+10), chinese 100→110 (+10) → total 170→190, delta +20
  // StudentB: math 90→80 (-10), chinese 110→100 (-10) → total 200→180, delta -20
  // StudentC: math 80→80 (0), chinese 100→100 (0) → total 180→180, delta 0
  // StudentD: math 75→(无) → totalA=75, totalB=null, delta=null
  // 操行: StudentA 今天 +1 (ACTIVITY_PARTICIPATION) -2 (SPEAK_IN_CLASS) = -1
  // avgScoreDelta = (20 + (-20) + 0) / 3 = 0 (StudentD delta=null 不计入)
  // mostImproved = StudentA (+20), mostDeclined = StudentB (-20)
  // totalStudents = 4
  // math 平均变化 = (10 + (-10) + 0) / 3 = 0 (StudentD scoreB=null, scoreDelta=null 不计入)
  // chinese 平均变化 = (10 + (-10) + 0) / 3 = 0
  const EXPECTED = {
    studentA: { totalA: 170, totalB: 190, delta: 20, improved: 2, declined: 0, conductDelta: -1 },
    studentB: { totalA: 200, totalB: 180, delta: -20, improved: 0, declined: 2, conductDelta: null },
    studentC: { totalA: 180, totalB: 180, delta: 0, improved: 0, declined: 0, conductDelta: null },
    studentD: { totalA: 75, totalB: null, delta: null, improved: 0, declined: 0, conductDelta: null },
    summary: {
      avgScoreDelta: 0,
      mostImproved: studentA,
      mostDeclined: studentB,
      totalStudents: 4,
    },
  }

  let examAId = null
  let examBId = null

  // ===== 1. 导航到学业页,确认 academic 命名空间可用 =====
  console.log('\n--- 1. 导航 & 命名空间探测 ---')
  await navigateTo('#/academics')
  await waitFor(2000)

  // ===== 2. 创建测试学生 =====
  console.log('\n--- 2. 创建测试学生 ---')
  for (const [tag, name] of [['A', studentA], ['B', studentB], ['C', studentC], ['D', studentD]]) {
    try {
      const r = await callEAA('addStudent', name)
      record(`创建学生 ${tag} (${name})`, isOk(r), isOk(r) ? 'ok' : `error=${r?.error || r?.__error}`)
    } catch (e) {
      record(`创建学生 ${tag}`, false, e.message)
    }
  }

  // ===== 3. 创建测试班级 =====
  console.log('\n--- 3. 创建测试班级 ---')
  try {
    const r = await callClass('create', {
      class_id: classId,
      name: className,
      grade: '三年级',
      teacher: 'CDP测试老师',
      note: '考试对比测试班级',
    })
    record('创建班级', isOk(r), isOk(r) ? `class_id=${classId}` : `error=${r?.error || r?.__error}`)
  } catch (e) {
    record('创建班级', false, e.message)
  }

  // ===== 4. 分配学生到班级 =====
  console.log('\n--- 4. 分配学生到班级 ---')
  try {
    const r = await callClass('assign', {
      class_id: classId,
      student_names: [studentA, studentB, studentC, studentD],
    })
    record('分配 4 学生到班级', isOk(r), isOk(r) ? 'ok' : `error=${r?.error || r?.__error}`)
  } catch (e) {
    record('分配学生到班级', false, e.message)
  }
  await waitFor(500) // 等待 listStudents 缓存失效

  // ===== 5. 创建两场考试 =====
  console.log('\n--- 5. 创建两场考试 ---')
  try {
    const r = await callAcademic('createExam', {
      name: examAName,
      type: 'monthly',
      date: examADate,
      semester: '2025-2026-2',
      scope: 'cdp-compare',
      subjects: ['math', 'chinese'],
    })
    if (isOk(r) && r.data?.id) {
      examAId = r.data.id
      createdExamIds.add(examAId)
      record('创建考试 A', true, `id=${examAId} date=${examADate}`)
    } else {
      record('创建考试 A', false, `error=${r?.error || r?.__error}`)
    }
  } catch (e) {
    record('创建考试 A', false, e.message)
  }

  try {
    const r = await callAcademic('createExam', {
      name: examBName,
      type: 'monthly',
      date: examBDate,
      semester: '2025-2026-2',
      scope: 'cdp-compare',
      subjects: ['math', 'chinese'],
    })
    if (isOk(r) && r.data?.id) {
      examBId = r.data.id
      createdExamIds.add(examBId)
      record('创建考试 B', true, `id=${examBId} date=${examBDate}`)
    } else {
      record('创建考试 B', false, `error=${r?.error || r?.__error}`)
    }
  } catch (e) {
    record('创建考试 B', false, e.message)
  }

  if (!examAId || !examBId) {
    console.error('\n❌ 考试创建失败,无法继续测试')
    cleanup(createdExamIds)
    return
  }

  // ===== 6. 设置成绩 =====
  console.log('\n--- 6. 设置成绩 (4 学生 × 2 科目 × 2 考试) ---')
  const gradesA = [
    { examId: examAId, subjectId: 'math', studentName: studentA, score: 70, fullMark: 150 },
    { examId: examAId, subjectId: 'chinese', studentName: studentA, score: 100, fullMark: 150 },
    { examId: examAId, subjectId: 'math', studentName: studentB, score: 90, fullMark: 150 },
    { examId: examAId, subjectId: 'chinese', studentName: studentB, score: 110, fullMark: 150 },
    { examId: examAId, subjectId: 'math', studentName: studentC, score: 80, fullMark: 150 },
    { examId: examAId, subjectId: 'chinese', studentName: studentC, score: 100, fullMark: 150 },
    { examId: examAId, subjectId: 'math', studentName: studentD, score: 75, fullMark: 150 },
    // StudentD chinese 不录入 (在 A 中也缺)
  ]
  const gradesB = [
    { examId: examBId, subjectId: 'math', studentName: studentA, score: 80, fullMark: 150 },
    { examId: examBId, subjectId: 'chinese', studentName: studentA, score: 110, fullMark: 150 },
    { examId: examBId, subjectId: 'math', studentName: studentB, score: 80, fullMark: 150 },
    { examId: examBId, subjectId: 'chinese', studentName: studentB, score: 100, fullMark: 150 },
    { examId: examBId, subjectId: 'math', studentName: studentC, score: 80, fullMark: 150 },
    { examId: examBId, subjectId: 'chinese', studentName: studentC, score: 100, fullMark: 150 },
    // StudentD 在 B 中无成绩
  ]

  try {
    const r = await callAcademic('batchSetGrades', gradesA)
    record('批量录入考试 A 成绩 (7 条)', isOk(r) && Number(r.data) === 7, `count=${r.data}`)
  } catch (e) {
    record('批量录入考试 A 成绩', false, e.message)
  }

  try {
    const r = await callAcademic('batchSetGrades', gradesB)
    record('批量录入考试 B 成绩 (6 条)', isOk(r) && Number(r.data) === 6, `count=${r.data}`)
  } catch (e) {
    record('批量录入考试 B 成绩', false, e.message)
  }

  // ===== 7. 添加操行事件 (StudentA 今天,落在 07-10 ~ 07-20 范围内) =====
  console.log('\n--- 7. 添加操行事件 (StudentA) ---')
  try {
    const r = await callEAA('addEvent', {
      studentName: studentA,
      reasonCode: 'ACTIVITY_PARTICIPATION',
      note: 'CDP对比测试-活动参与',
      operator: 'cdp-test',
    })
    record('StudentA +1 活动参与', isOk(r), isOk(r) ? 'ok' : `error=${r?.error || r?.__error}`)
  } catch (e) {
    record('StudentA +1 活动参与', false, e.message)
  }
  try {
    const r = await callEAA('addEvent', {
      studentName: studentA,
      reasonCode: 'SPEAK_IN_CLASS',
      note: 'CDP对比测试-课堂讲话',
      operator: 'cdp-test',
    })
    record('StudentA -2 课堂讲话', isOk(r), isOk(r) ? 'ok' : `error=${r?.error || r?.__error}`)
  } catch (e) {
    record('StudentA -2 课堂讲话', false, e.message)
  }

  // ===== 8. 数据交叉验证 (IPC 直读) =====
  console.log('\n--- 8. IPC 数据交叉验证 ---')
  // 8a. 验证 getClassGrades A
  try {
    const r = await callAcademic('getClassGrades', [studentA, studentB, studentC, studentD], examAId)
    const d = isOk(r) ? r.data : null
    const aMath = d?.[studentA]?.find((g) => g.subjectId === 'math')
    const dMath = d?.[studentD]?.find((g) => g.subjectId === 'math')
    const ok = d && aMath && Number(aMath.score) === 70 && dMath && Number(dMath.score) === 75
    record('getClassGrades A 数据正确', ok, ok ? `A.math=70, D.math=75` : `data=${JSON.stringify(d).slice(0, 200)}`)
  } catch (e) {
    record('getClassGrades A 数据正确', false, e.message)
  }
  // 8b. 验证 getClassGrades B
  try {
    const r = await callAcademic('getClassGrades', [studentA, studentB, studentC, studentD], examBId)
    const d = isOk(r) ? r.data : null
    const aMath = d?.[studentA]?.find((g) => g.subjectId === 'math')
    const dGrades = d?.[studentD] ?? []
    const ok = d && aMath && Number(aMath.score) === 80 && dGrades.length === 0
    record('getClassGrades B 数据正确 (StudentD 无成绩)', ok, ok ? `A.math=80, D 空` : `data=${JSON.stringify(d).slice(0, 200)}`)
  } catch (e) {
    record('getClassGrades B 数据正确', false, e.message)
  }
  // 8c. 验证 eaa.range 返回事件含 StudentA 的 2 条
  try {
    const r = await callEAA('range', examADate, examBDate, 5000)
    const events = isOk(r) && r.data?.events ? r.data.events : []
    const aEvents = events.filter((e) => e.name === studentA)
    const ok = aEvents.length === 2 && aEvents.every((e) => e.is_valid === true)
    record('eaa.range 返回 StudentA 2 条有效事件', ok, ok ? `events=${aEvents.length}` : `events=${aEvents.length}, raw=${JSON.stringify(events).slice(0, 200)}`)
  } catch (e) {
    record('eaa.range 事件验证', false, e.message)
  }

  // ===== 9. UI 测试: 导航到学业页 + 选学生 + 点对比 tab =====
  console.log('\n--- 9. UI 测试: CompareTab 渲染 ---')
  // 先导航到 dashboard 再回来,强制 React Router 重新挂载 AcademicsPage 并重新 loadInitialData
  // (否则若已在 academics 页,hash 不变不会触发 remount,students 列表为陈旧数据)
  await navigateTo('#/dashboard')
  await waitFor(1200)
  await navigateTo('#/academics')
  await waitFor(2500)

  // 9a. 验证 compare tab 不被 "请先选择学生" 阻挡 (原 UX bug 已修复)
  // 注意: loadInitialData 会自动选中第一个学生,所以 selectedStudent 通常非空。
  // 此处验证: 点击对比 tab 后应直接显示 CompareTab 的选择器,而非 "请先选择学生" 空状态。
  const tabClick1 = await clickTab('成绩对比')
  record('点击"成绩对比" tab', tabClick1.ok, tabClick1.ok ? tabClick1.text : tabClick1.error)
  await waitFor(1200) // 等 React 渲染
  const domBeforeSelect = await getCompareTabDOM()
  const blockedByNoStudent = domBeforeSelect.hasEmpty && domBeforeSelect.emptyTitle === '请先选择学生'
  if (blockedByNoStudent) {
    // 仍然被阻挡 = bug 未修复
    record('compare tab 未被 "请先选择学生" 阻挡', false, `title="${domBeforeSelect.emptyTitle}" — bug 未修复`)
    bug('AcademicsPage.tsx:515 条件仍阻挡 compare tab')
  } else {
    // 未被阻挡 = 正常(无论是因为 selectedStudent 已设置,还是因为 bug 已修复)
    record('compare tab 未被 "请先选择学生" 阻挡', true, `cmpSelects=${domBeforeSelect.compareSelectCount}`)
  }

  // 9b. 选择 StudentA (确保 compare tab 内部数据加载用到的学生上下文一致)
  const clickStu = await clickStudentInList(studentA)
  if (!clickStu.ok) {
    // 备选: 尝试其他选择器
    const alt = await evalInPage(`(function(){
      const all = document.querySelectorAll('*');
      for (const el of all) {
        if (el.children.length === 0 && el.textContent && el.textContent.trim() === ${JSON.stringify(studentA)}) {
          el.click();
          return { ok: true, tag: el.tagName, parent: el.parentElement?.tagName };
        }
      }
      return { ok: false };
    })()`)
    record('选择 StudentA (上下文)', alt.ok, alt.ok ? `tag=${alt.tag}` : `未找到学生元素(可能已自动选中)`)
  } else {
    record('选择 StudentA (上下文)', true, clickStu.tag)
  }
  await waitFor(1000)

  // 9c. 再次点击对比 tab
  const tabClick2 = await clickTab('成绩对比')
  record('再次点击"成绩对比" tab', tabClick2.ok, tabClick2.ok ? 'ok' : tabClick2.error)
  await waitFor(2500) // 等待 loadComparison + 纯函数计算

  // 9d. 验证 CompareTab 专属 select 存在 (examA + examB 是 CompareTab 独有)
  // 注意: header 也有 classFilter(全部班级),所以 compareSelectCount 可能=4 (2 classFilter + 2 exam)
  // 关键判据: examA 和 examB 各存在 (这是 CompareTab 独有的)
  const dom1 = await getCompareTabDOM()
  const examSelectCount = await evalInPage(`(function(){
    const sels = Array.from(document.querySelectorAll('select'));
    const examA = sels.filter(s => s.options[0] && s.options[0].textContent.includes('选择考试 A')).length;
    const examB = sels.filter(s => s.options[0] && s.options[0].textContent.includes('选择考试 B')).length;
    return { examA, examB, total: examA + examB };
  })()`)
  record('CompareTab 渲染 examA + examB 专属 select', examSelectCount.examA === 1 && examSelectCount.examB === 1, `examA=${examSelectCount.examA}, examB=${examSelectCount.examB}, 全部select=${dom1.selectCount}`)

  // 9e. 验证默认自动选择最近两场考试
  const defaultSel = await evalInPage(`(function(){
    const sels = Array.from(document.querySelectorAll('select'));
    const examASel = sels.find(s => s.options[0] && s.options[0].textContent.includes('选择考试 A'));
    const examBSel = sels.find(s => s.options[0] && s.options[0].textContent.includes('选择考试 B'));
    if (!examASel || !examBSel) return { ok: false, error: 'exam selects not found' };
    return { ok: true, examA: examASel.value, examB: examBSel.value };
  })()`)
  const defaultOk = defaultSel.ok && defaultSel.examA && defaultSel.examB && defaultSel.examA !== defaultSel.examB && defaultSel.examA !== '' && defaultSel.examB !== ''
  record('默认自动选择最近两场考试', defaultOk, defaultSel.ok ? `A=${defaultSel.examA?.slice(0, 25)}, B=${defaultSel.examB?.slice(0, 25)}` : defaultSel.error)

  // 9f. 设置 classFilter 为我们的测试班级
  const setClass = await setCompareSelect('classFilter', classId)
  record('设置 classFilter = 测试班级', setClass.ok, setClass.ok ? `value=${setClass.value}` : setClass.error)
  await waitFor(2000)

  // 9g. 设置 examA 和 examB 为我们的两场考试
  const setA = await setCompareSelect('examA', examAId)
  const setB = await setCompareSelect('examB', examBId)
  record('设置 examA = 测试考试A', setA.ok, setA.ok ? 'ok' : setA.error)
  record('设置 examB = 测试考试B', setB.ok, setB.ok ? 'ok' : setB.error)
  await waitFor(3000) // 等待 getClassGrades × 2 + eaa.range

  // ===== 10. 验证汇总卡片 =====
  console.log('\n--- 10. 验证汇总卡片 ---')
  const dom2 = await getCompareTabDOM()
  record('汇总卡片渲染 (4 个)', dom2.summaryCards === 4, `actual=${dom2.summaryCards}`)

  if (dom2.summaryCards >= 4) {
    const sum = await getSummaryValues()
    if (sum.ok) {
      console.log(`    卡片文本:`)
      console.log(`      平均分变化: ${sum.avgScoreDelta}`)
      console.log(`      进步最多:   ${sum.mostImproved}`)
      console.log(`      退步最多:   ${sum.mostDeclined}`)
      console.log(`      参与对比:   ${sum.totalStudents}`)

      // 验证 avgScoreDelta = 0 (显示 "0.0")
      const avgOk = sum.avgScoreDelta.includes('0.0') || sum.avgScoreDelta === '0'
      record('汇总: avgScoreDelta = 0.0', avgOk, `actual="${sum.avgScoreDelta}"`)

      // 验证 mostImproved = StudentA
      const impOk = sum.mostImproved.includes(studentA)
      record('汇总: mostImproved = StudentA', impOk, `actual="${sum.mostImproved.slice(0, 50)}"`)

      // 验证 mostDeclined = StudentB
      const decOk = sum.mostDeclined.includes(studentB)
      record('汇总: mostDeclined = StudentB', decOk, `actual="${sum.mostDeclined.slice(0, 50)}"`)

      // 验证 totalStudents = 4
      const totalOk = sum.totalStudents.includes('4')
      record('汇总: totalStudents = 4', totalOk, `actual="${sum.totalStudents}"`)
    } else {
      record('汇总卡片读取', false, sum.error)
    }
  }

  // ===== 11. 验证学生对比表 =====
  console.log('\n--- 11. 验证学生对比表 ---')
  const tableData = await getStudentTableRows()
  record('对比表渲染 4 行', tableData.ok && tableData.rows.length === 4, `actual=${tableData.rows.length}`)

  if (tableData.ok && tableData.rows.length >= 4) {
    // 表格按 totalScoreDelta 降序: StudentA(+20) > StudentC(0) > StudentB(-20) > StudentD(null→-Infinity)
    // 注意: null delta 在排序中按 -Infinity 处理,放最后
    console.log('    表格行顺序:')
    tableData.rows.forEach((r, i) => console.log(`      ${i + 1}. ${r.name} | A=${r.totalA} B=${r.totalB} Δ=${r.totalDelta} 进退=${r.improvedDeclined} 操行=${r.conductDelta}`))

    // 找到各学生行
    const rowA = tableData.rows.find((r) => r.name === studentA)
    const rowB = tableData.rows.find((r) => r.name === studentB)
    const rowC = tableData.rows.find((r) => r.name === studentC)
    const rowD = tableData.rows.find((r) => r.name === studentD)

    // StudentA: A=170, B=190, delta=+20, 进退=2/0, 操行=-1
    if (rowA) {
      record('StudentA totalA=170', rowA.totalA === '170', `actual=${rowA.totalA}`)
      record('StudentA totalB=190', rowA.totalB === '190', `actual=${rowA.totalB}`)
      record('StudentA delta=+20', rowA.totalDelta.includes('20') && rowA.totalDelta.includes('↑'), `actual="${rowA.totalDelta}"`)
      record('StudentA 进退=2/0', rowA.improvedDeclined.includes('2') && rowA.improvedDeclined.includes('0'), `actual="${rowA.improvedDeclined}"`)
      record('StudentA 操行=-1', rowA.conductDelta.includes('1') && rowA.conductDelta.includes('↓'), `actual="${rowA.conductDelta}"`)
    } else {
      record('StudentA 行存在', false, '未找到')
    }

    // StudentB: A=200, B=180, delta=-20, 进退=0/2, 操行=—(null)
    if (rowB) {
      record('StudentB totalA=200', rowB.totalA === '200', `actual=${rowB.totalA}`)
      record('StudentB totalB=180', rowB.totalB === '180', `actual=${rowB.totalB}`)
      record('StudentB delta=-20', rowB.totalDelta.includes('20') && rowB.totalDelta.includes('↓'), `actual="${rowB.totalDelta}"`)
      record('StudentB 进退=0/2', rowB.improvedDeclined.includes('0') && rowB.improvedDeclined.includes('2'), `actual="${rowB.improvedDeclined}"`)
      record('StudentB 操行=—(null)', rowB.conductDelta.includes('—') || rowB.conductDelta.includes('-'), `actual="${rowB.conductDelta}"`)
    } else {
      record('StudentB 行存在', false, '未找到')
    }

    // StudentC: A=180, B=180, delta=0(—), 进退=0/0, 操行=—
    if (rowC) {
      record('StudentC totalA=180', rowC.totalA === '180', `actual=${rowC.totalA}`)
      record('StudentC totalB=180', rowC.totalB === '180', `actual=${rowC.totalB}`)
      record('StudentC delta=0(—)', rowC.totalDelta.includes('—') || rowC.totalDelta === '0', `actual="${rowC.totalDelta}"`)
      record('StudentC 操行=—(null)', rowC.conductDelta.includes('—') || rowC.conductDelta.includes('-'), `actual="${rowC.conductDelta}"`)
    } else {
      record('StudentC 行存在', false, '未找到')
    }

    // StudentD: A=75, B=-(null), delta=—(null), 进退=0/0, 操行=—
    if (rowD) {
      record('StudentD totalA=75', rowD.totalA === '75', `actual=${rowD.totalA}`)
      record('StudentD totalB=-(null)', rowD.totalB === '-' || rowD.totalB === '—', `actual="${rowD.totalB}"`)
      record('StudentD delta=—(null)', rowD.totalDelta.includes('—'), `actual="${rowD.totalDelta}"`)
    } else {
      record('StudentD 行存在', false, '未找到')
    }

    // 验证排序: StudentA 应在 StudentB 之前 (delta +20 > -20)
    const idxA = tableData.rows.findIndex((r) => r.name === studentA)
    const idxB = tableData.rows.findIndex((r) => r.name === studentB)
    const idxD = tableData.rows.findIndex((r) => r.name === studentD)
    record('排序: StudentA 在 StudentB 之前', idxA >= 0 && idxB >= 0 && idxA < idxB, `idxA=${idxA}, idxB=${idxB}`)
    // StudentD (delta=null→-Infinity) 应在最后
    record('排序: StudentD (null delta) 在最后', idxD === tableData.rows.length - 1, `idxD=${idxD}, total=${tableData.rows.length}`)
  }

  // ===== 12. 验证科目平均变化图表 =====
  console.log('\n--- 12. 验证科目平均变化图表 ---')
  const chartOk = await evalInPage(`(function(){
    // ECharts 渲染为 canvas 或 svg
    const canvas = document.querySelector('canvas');
    const svg = document.querySelector('div[_echarts_instance_] svg');
    return { hasCanvas: !!canvas, hasSvg: !!svg, hasInstance: !!document.querySelector('div[_echarts_instance_]') };
  })()`)
  record('科目平均变化图表渲染', chartOk.hasCanvas || chartOk.hasSvg || chartOk.hasInstance, `canvas=${chartOk.hasCanvas} svg=${chartOk.hasSvg} inst=${chartOk.hasInstance}`)

  // ===== 13. 边界情况: 切换到相同考试 =====
  console.log('\n--- 13. 边界情况: 相同考试 =====')
  const setSame = await setCompareSelect('examB', examAId) // B = A
  await waitFor(1500)
  const domSame = await getCompareTabDOM()
  const sameExamOk = domSame.hasEmpty && (domSame.emptyTitle === '选择两场考试进行对比')
  record('相同考试显示提示', sameExamOk, `empty=${domSame.hasEmpty} title="${domSame.emptyTitle}" desc="${domSame.emptyDesc}"`)
  // 恢复
  await setCompareSelect('examB', examBId)
  await waitFor(2000)

  // ===== 14. 边界情况: 切换到"未分班" =====
  console.log('\n--- 14. 边界情况: 未分班过滤 ---')
  const setNone = await setCompareSelect('classFilter', '__NONE__')
  await waitFor(2000)
  const domNone = await getCompareTabDOM()
  // 我们的 4 个测试学生都在测试班级里,"未分班"不应包含他们
  // 但系统中可能有其他无班级学生,所以只检查我们的学生不在结果里
  const noneTable = await getStudentTableRows()
  const ourStudentsInNone = noneTable.rows.filter(r => [studentA, studentB, studentC, studentD].includes(r.name))
  record('未分班过滤 (测试学生被排除)', ourStudentsInNone.length === 0, `测试学生出现=${ourStudentsInNone.length}, 总行数=${noneTable.rows.length}`)

  // 恢复到测试班级
  await setCompareSelect('classFilter', classId)
  await waitFor(2500)

  // ===== 15. 边界情况: 全部班级 =====
  console.log('\n--- 15. 边界情况: 全部班级 ---')
  const setAll = await setCompareSelect('classFilter', '__ALL__')
  await waitFor(2500)
  const domAll = await getCompareTabDOM()
  record('全部班级过滤 (包含其他学生)', domAll.tableRows >= 4, `rows=${domAll.tableRows}`)

  // ===== 16. DeltaBadge 渲染验证 =====
  console.log('\n--- 16. DeltaBadge 渲染验证 ---')
  const badgeInfo = await evalInPage(`(function(){
    // 查找所有 inline-flex span (DeltaBadge 的 className 含 inline-flex)
    const spans = document.querySelectorAll('span.inline-flex');
    const out = [];
    for (const s of spans) {
      const text = s.textContent.trim();
      if (text.includes('↑') || text.includes('↓') || text === '—' || text.includes('分')) {
        const cls = s.className;
        let color = 'unknown';
        if (cls.includes('green')) color = 'green';
        else if (cls.includes('red')) color = 'red';
        else if (cls.includes('gray')) color = 'gray';
        out.push({ text, color });
      }
    }
    return { count: out.length, samples: out.slice(0, 15) };
  })()`)
  record('DeltaBadge 渲染数量 > 0', badgeInfo.count > 0, `count=${badgeInfo.count}`)
  if (badgeInfo.count > 0) {
    console.log('    DeltaBadge 样本:')
    badgeInfo.samples.forEach((s, i) => console.log(`      ${i + 1}. text="${s.text}" color=${s.color}`))
  }

  // 验证颜色规则: 正分绿↑, 负分红↓, 0/null 灰—
  const hasGreenUp = badgeInfo.samples.some((s) => s.color === 'green' && s.text.includes('↑'))
  const hasRedDown = badgeInfo.samples.some((s) => s.color === 'red' && s.text.includes('↓'))
  const hasGrayDash = badgeInfo.samples.some((s) => s.color === 'gray' && s.text.includes('—'))
  record('DeltaBadge 颜色: 绿↑ (正分)', hasGreenUp, hasGreenUp ? 'ok' : '未找到')
  record('DeltaBadge 颜色: 红↓ (负分)', hasRedDown, hasRedDown ? 'ok' : '未找到')
  record('DeltaBadge 颜色: 灰— (null/0)', hasGrayDash, hasGrayDash ? 'ok' : '未找到')

  // ===== 17. 性能测试: loadComparison 耗时 =====
  console.log('\n--- 17. 性能测试: loadComparison 耗时 ---')
  const perfResult = await evalInPage(`(async function(){
    const t0 = performance.now();
    const sels = Array.from(document.querySelectorAll('select'));
    const examASel = sels.find(s => s.options[0] && s.options[0].textContent.includes('选择考试 A'));
    if (!examASel) return { ok: false, error: 'examA select not found' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    // 切到空再切回,强制触发 loadComparison
    setter.call(examASel, '');
    examASel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const t1 = performance.now();
    setter.call(examASel, ${JSON.stringify(examAId)});
    examASel.dispatchEvent(new Event('change', { bubbles: true }));
    // 等待加载完成 (检查 loading skeleton 消失)
    let waited = 0;
    while (waited < 10000) {
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
      const skeleton = document.querySelector('.animate-pulse');
      if (!skeleton) break;
    }
    const t2 = performance.now();
    return { ok: true, triggerMs: t1 - t0, loadMs: t2 - t1, totalMs: t2 - t0, waited };
  })()`)
  if (perfResult.ok) {
    record('loadComparison 性能', perfResult.loadMs < 5000, `load=${perfResult.loadMs.toFixed(0)}ms (阈值 5000ms)`)
    if (perfResult.loadMs >= 5000) note(`loadComparison 较慢: ${perfResult.loadMs.toFixed(0)}ms`)
  } else {
    record('loadComparison 性能', false, perfResult.error)
  }

  // ===== 18. 内存泄漏检查 (长时间运行) =====
  console.log('\n--- 18. 内存检查 ---')
  const memBefore = await evalInPage(`(function(){
    if (!performance.memory) return { ok: false };
    return { ok: true, used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize };
  })()`)
  if (memBefore.ok) {
    console.log(`    内存: used=${(memBefore.used / 1024 / 1024).toFixed(1)}MB, total=${(memBefore.total / 1024 / 1024).toFixed(1)}MB`)
    // 多次切换触发重渲染
    for (let i = 0; i < 5; i++) {
      await setCompareSelect('classFilter', '__ALL__')
      await waitFor(500)
      await setCompareSelect('classFilter', classId)
      await waitFor(500)
    }
    const memAfter = await evalInPage(`(function(){
      if (!performance.memory) return { ok: false };
      return { ok: true, used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize };
    })()`)
    if (memAfter.ok) {
      const delta = memAfter.used - memBefore.used
      const deltaMB = delta / 1024 / 1024
      console.log(`    切换后: used=${(memAfter.used / 1024 / 1024).toFixed(1)}MB, delta=${deltaMB.toFixed(1)}MB`)
      record('内存泄漏检查 (5 次切换)', deltaMB < 50, `delta=${deltaMB.toFixed(1)}MB (阈值 50MB)`)
    }
  } else {
    record('内存检查 (performance.memory 不可用)', 'warn', 'WebView2 可能不支持')
  }

  // ===== 19. 渲染一致性 (多次加载结果一致) =====
  console.log('\n--- 19. 渲染一致性 ---')
  await setCompareSelect('classFilter', classId)
  await waitFor(2500)
  const render1 = await getStudentTableRows()
  await setCompareSelect('classFilter', '__ALL__')
  await waitFor(1500)
  await setCompareSelect('classFilter', classId)
  await waitFor(2500)
  const render2 = await getStudentTableRows()
  let consistent = true
  if (render1.rows.length === render2.rows.length) {
    for (let i = 0; i < render1.rows.length; i++) {
      if (render1.rows[i].name !== render2.rows[i].name || render1.rows[i].totalDelta !== render2.rows[i].totalDelta) {
        consistent = false
        break
      }
    }
  } else {
    consistent = false
  }
  record('两次渲染结果一致', consistent, `rows=${render1.rows.length} vs ${render2.rows.length}`)

  // ===== 20. 总结 =====
  console.log('\n=== 总结 ===')
  const total = passCount + failCount + warnCount
  console.log(`总计: ${total}, 通过: ${passCount}, 警告: ${warnCount}, 失败: ${failCount}`)
  if (notes.length) {
    console.log('\n— 备注:')
    for (const n of notes) console.log(`  ℹ ${n}`)
  }
  if (bugs.length) {
    console.log('\n— 发现的 Bug:')
    for (const b of bugs) console.log(`  🐛 ${b}`)
  }
}

async function cleanup(examIds) {
  console.log('\n--- 清理测试考试 ---')
  for (const id of [...examIds]) {
    try { await callAcademic('deleteExam', id) } catch { /* ignore */ }
  }
  console.log(`  已清理 ${examIds.size} 个考试`)
}

main()
  .catch((e) => {
    console.error('\n❌ 测试异常:', e)
    failCount++
  })
  .then(async () => {
    await cleanup(createdExamIds)
    try { ws.close() } catch { /* ignore */ }
    process.exit(failCount > 0 ? 1 : 0)
  })
