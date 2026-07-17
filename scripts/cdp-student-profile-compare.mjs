// =============================================================
// CDP StudentProfile 单生对比区深度测试
// 覆盖: 数据创建 → 打开学生档案 → 学业 tab → 考试对比区
//       (2 个 select + 对比表 grid-cols-12 + 总分行 + 汇总行 + 柱状图)
//       边界: 相同考试 / 无成绩 / 缺考 / 操行分
// 运行: node scripts/cdp-student-profile-compare.mjs
// =============================================================
import http from 'node:http'
import WebSocket from 'ws'

const CDP_HOST = 'http://127.0.0.1:9222'

// 全局状态
let ws, send, evalInPage
let passCount = 0
let failCount = 0
let warnCount = 0
const notes = []
const bugs = []

const TS = Date.now()
const uid = (tag) => `SP${TS}_${tag}`
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

const isOk = (r) => !!r && r.__error === undefined && r.success === true

// ---------------- React select 驱动 ----------------
// StudentProfile 对比区的 2 个 select: 首个 option 为 "选择考试 A" / "选择考试 B"
async function setProfileSelect(which, value) {
  const label = which === 'examA' ? '选择考试 A' : '选择考试 B'
  return evalInPage(`(function(){
    const sels = Array.from(document.querySelectorAll('select'));
    let target = null;
    for (const s of sels) {
      if (s.options[0] && s.options[0].textContent.includes(${JSON.stringify(label)})) {
        target = s; // 只取第一个(StudentProfile 对比区只有 2 个 select)
        break;
      }
    }
    if (!target) return { ok: false, error: ${JSON.stringify(label)} + ' select 未找到' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(target, ${JSON.stringify(value)});
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: target.value, optionCount: target.options.length };
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
    const candidates = document.querySelectorAll('button, li, [role="button"], tr, .student-item, .student-row');
    for (const el of candidates) {
      if (el.textContent && el.textContent.trim().includes(${JSON.stringify(studentName)})) {
        el.click();
        return { ok: true, tag: el.tagName, text: el.textContent.trim().slice(0, 80) };
      }
    }
    return { ok: false, error: 'student not found in list: ' + ${JSON.stringify(studentName)} };
  })()`)
}

async function waitFor(ms) { await sleep(ms) }

async function navigateTo(hash) {
  await evalInPage(`window.location.hash = ${JSON.stringify(hash)}`)
  await waitFor(1500)
}

// 获取对比区 DOM 状态
async function getCompareSectionDOM() {
  return evalInPage(`(function(){
    const out = {
      hasSection: false,
      hasSelects: false,
      selectCount: 0,
      hasTable: false,
      hasTotalRow: false,
      hasSummary: false,
      hasChart: false,
      hasEmpty: false,
      emptyText: '',
      subjectRows: 0,
      deltaBadges: 0,
      bodyText: '',
    };
    // 对比区标题: <h5>📈 考试对比</h5>
    const h5s = document.querySelectorAll('h5');
    let section = null;
    for (const h of h5s) {
      if (h.textContent.includes('考试对比')) {
        section = h.closest('.bg-white.dark\\\\:bg-gray-800') || h.parentElement;
        out.hasSection = true;
        break;
      }
    }
    if (!section) return out;
    // select 数量
    const sels = section.querySelectorAll('select');
    out.selectCount = sels.length;
    out.hasSelects = sels.length >= 2;
    // 对比表: grid-cols-12 行(排除表头)
    const gridRows = section.querySelectorAll('.grid.grid-cols-12');
    out.subjectRows = gridRows.length > 1 ? gridRows.length - 1 : 0; // 减去表头
    out.hasTable = out.subjectRows > 0;
    // 总分行: 含 "总分" 文本
    const allDivs = section.querySelectorAll('div');
    for (const d of allDivs) {
      if (d.textContent.includes('总分') && d.textContent.includes('→')) {
        out.hasTotalRow = true;
        break;
      }
    }
    // 汇总行: 含 "进步" 和 "退步"
    for (const d of allDivs) {
      if (d.textContent.includes('进步') && d.textContent.includes('退步')) {
        out.hasSummary = true;
        break;
      }
    }
    // 柱状图: ECharts
    out.hasChart = section.querySelectorAll('canvas, div[_echarts_instance_]').length > 0;
    // 空状态: "请选择两场"
    for (const d of allDivs) {
      const t = d.textContent.trim();
      if ((t === '请选择两场不同的考试' || t === '请选择两场考试进行对比') && d.children.length === 0) {
        out.hasEmpty = true;
        out.emptyText = t;
        break;
      }
    }
    // DeltaBadge
    out.deltaBadges = section.querySelectorAll('span.inline-flex').length;
    out.bodyText = section.innerText.slice(0, 2000);
    return out;
  })()`)
}

// 获取科目对比行详情
async function getSubjectRows() {
  return evalInPage(`(function(){
    const h5s = document.querySelectorAll('h5');
    let section = null;
    for (const h of h5s) {
      if (h.textContent.includes('考试对比')) {
        section = h.parentElement;
        break;
      }
    }
    if (!section) return { ok: false, error: 'section not found' };
    const gridRows = section.querySelectorAll('.grid.grid-cols-12');
    const rows = [];
    for (let i = 1; i < gridRows.length; i++) { // 跳过表头
      const cells = gridRows[i].children;
      rows.push({
        subject: cells[0] ? cells[0].textContent.trim() : '',
        scoreA: cells[1] ? cells[1].textContent.trim() : '',
        scoreB: cells[2] ? cells[2].textContent.trim() : '',
        delta: cells[3] ? cells[3].textContent.trim() : '',
        rankChange: cells[4] ? cells[4].textContent.trim() : '',
      });
    }
    return { ok: true, rows };
  })()`)
}

// 获取总分行和汇总行文本
async function getSummaryText() {
  return evalInPage(`(function(){
    const h5s = document.querySelectorAll('h5');
    let section = null;
    for (const h of h5s) {
      if (h.textContent.includes('考试对比')) {
        section = h.parentElement;
        break;
      }
    }
    if (!section) return { ok: false };
    const allDivs = section.querySelectorAll('div');
    let totalRow = '', summaryRow = '';
    for (const d of allDivs) {
      const t = d.textContent.trim();
      if (d.querySelector('.border-t') || (t.includes('总分') && t.includes('→'))) {
        if (t.length < 200 && t.includes('总分')) totalRow = t;
      }
      if (t.includes('进步') && t.includes('退步') && t.length < 500) {
        summaryRow = t;
      }
    }
    return { ok: true, totalRow, summaryRow };
  })()`)
}

// ---------------- 主流程 ----------------
async function main() {
  console.log('=== StudentProfile 单生对比区 CDP 深度测试 ===\n')
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`UID 前缀: ${TS}\n`)

  await connect()

  // 测试数据
  const studentA = uid('stuA') // 进步生: math 70→80, chinese 100→110
  const studentB = uid('stuB') // 退步生: math 90→80, chinese 110→100
  const studentE = uid('stuE') // 无成绩学生
  const examAName = `SP对比考试A_${TS}`
  const examBName = `SP对比考试B_${TS}`
  const examADate = '2026-07-10'
  const examBDate = '2026-07-20'

  // 预期值
  // StudentA: math 70→80 (+10), chinese 100→110 (+10) → total 170→190, delta +20
  //   improved=2, declined=0, conductDelta=-1 (ACTIVITY +1, SPEAK -2)
  // StudentB: math 90→80 (-10), chinese 110→100 (-10) → total 200→180, delta -20
  //   improved=0, declined=2, conductDelta=null (无事件)

  let examAId = null
  let examBId = null

  // ===== 1. 创建测试学生 =====
  console.log('\n--- 1. 创建测试学生 ---')
  for (const [tag, name] of [['A', studentA], ['B', studentB], ['E', studentE]]) {
    try {
      const r = await callEAA('addStudent', name)
      record(`创建学生 ${tag} (${name})`, isOk(r), isOk(r) ? 'ok' : `error=${r?.error || r?.__error}`)
    } catch (e) {
      record(`创建学生 ${tag}`, false, e.message)
    }
  }

  // ===== 2. 创建两场考试 =====
  console.log('\n--- 2. 创建两场考试 ---')
  try {
    const r = await callAcademic('createExam', {
      name: examAName, type: 'monthly', date: examADate,
      semester: '2025-2026-2', scope: 'sp-compare', subjects: ['math', 'chinese'],
    })
    if (isOk(r) && r.data?.id) {
      examAId = r.data.id; createdExamIds.add(examAId)
      record('创建考试 A', true, `id=${examAId}`)
    } else { record('创建考试 A', false, `error=${r?.error || r?.__error}`) }
  } catch (e) { record('创建考试 A', false, e.message) }

  try {
    const r = await callAcademic('createExam', {
      name: examBName, type: 'monthly', date: examBDate,
      semester: '2025-2026-2', scope: 'sp-compare', subjects: ['math', 'chinese'],
    })
    if (isOk(r) && r.data?.id) {
      examBId = r.data.id; createdExamIds.add(examBId)
      record('创建考试 B', true, `id=${examBId}`)
    } else { record('创建考试 B', false, `error=${r?.error || r?.__error}`) }
  } catch (e) { record('创建考试 B', false, e.message) }

  if (!examAId || !examBId) {
    console.error('\n❌ 考试创建失败,无法继续')
    return
  }

  // ===== 3. 设置成绩 =====
  console.log('\n--- 3. 设置成绩 ---')
  const grades = [
    // StudentA: A 场
    { examId: examAId, subjectId: 'math', studentName: studentA, score: 70, fullMark: 150 },
    { examId: examAId, subjectId: 'chinese', studentName: studentA, score: 100, fullMark: 150 },
    // StudentA: B 场
    { examId: examBId, subjectId: 'math', studentName: studentA, score: 80, fullMark: 150 },
    { examId: examBId, subjectId: 'chinese', studentName: studentA, score: 110, fullMark: 150 },
    // StudentB: A 场
    { examId: examAId, subjectId: 'math', studentName: studentB, score: 90, fullMark: 150 },
    { examId: examAId, subjectId: 'chinese', studentName: studentB, score: 110, fullMark: 150 },
    // StudentB: B 场
    { examId: examBId, subjectId: 'math', studentName: studentB, score: 80, fullMark: 150 },
    { examId: examBId, subjectId: 'chinese', studentName: studentB, score: 100, fullMark: 150 },
  ]
  try {
    const r = await callAcademic('batchSetGrades', grades)
    record('批量录入成绩 (8 条)', isOk(r) && Number(r.data) === 8, `count=${r.data}`)
  } catch (e) { record('批量录入成绩', false, e.message) }

  // ===== 4. 添加操行事件 (StudentA) =====
  console.log('\n--- 4. 添加操行事件 (StudentA) ---')
  try {
    const r = await callEAA('addEvent', {
      studentName: studentA, reasonCode: 'ACTIVITY_PARTICIPATION',
      note: 'SP测试-活动参与', operator: 'cdp-test',
    })
    record('StudentA +1 活动参与', isOk(r))
  } catch (e) { record('StudentA +1 活动参与', false, e.message) }
  try {
    const r = await callEAA('addEvent', {
      studentName: studentA, reasonCode: 'SPEAK_IN_CLASS',
      note: 'SP测试-课堂讲话', operator: 'cdp-test',
    })
    record('StudentA -2 课堂讲话', isOk(r))
  } catch (e) { record('StudentA -2 课堂讲话', false, e.message) }

  // ===== 5. IPC 数据交叉验证 =====
  console.log('\n--- 5. IPC 数据交叉验证 ---')
  try {
    const r = await callAcademic('getGrades', studentA)
    const d = isOk(r) ? r.data : []
    const ok = Array.isArray(d) && d.length === 4 // 2 exams × 2 subjects
    record('StudentA getGrades 返回 4 条', ok, `count=${d?.length}`)
  } catch (e) { record('getGrades 验证', false, e.message) }

  try {
    const r = await callEAA('range', examADate, examBDate, 1000)
    const events = isOk(r) && r.data?.events ? r.data.events : []
    const aEvents = events.filter((e) => e.name === studentA)
    const ok = aEvents.length === 2 && aEvents.every((e) => e.is_valid === true)
    record('eaa.range 返回 StudentA 2 条有效事件', ok, `events=${aEvents.length}`)
  } catch (e) { record('eaa.range 验证', false, e.message) }

  // ===== 6. UI 测试: 打开 StudentProfile =====
  console.log('\n--- 6. UI 测试: 打开 StudentProfile ---')
  // 导航到 Students 页 (先去 dashboard 再来,强制 remount)
  await navigateTo('#/dashboard')
  await waitFor(1000)
  await navigateTo('#/students')
  await waitFor(2500)

  // 点击 StudentA 打开档案
  const clickStu = await clickStudentInList(studentA)
  record('点击 StudentA 打开档案', clickStu.ok, clickStu.ok ? `tag=${clickStu.tag}` : clickStu.error)
  await waitFor(1500)

  // 点击 "学业" tab
  const tabClick = await clickTab('学业')
  record('点击 "学业" tab', tabClick.ok, tabClick.ok ? tabClick.text : tabClick.error)
  await waitFor(2500) // 等 listExams + getGrades 加载

  // ===== 7. 验证对比区渲染 =====
  console.log('\n--- 7. 验证对比区渲染 ---')
  const dom1 = await getCompareSectionDOM()
  record('对比区标题 "📈 考试对比" 存在', dom1.hasSection, dom1.hasSection ? 'ok' : '未找到')
  record('对比区 2 个 select', dom1.hasSelects, `count=${dom1.selectCount}`)

  // 7a. 验证默认自动选择最近两场考试
  const defaultSel = await evalInPage(`(function(){
    const h5s = document.querySelectorAll('h5');
    let section = null;
    for (const h of h5s) {
      if (h.textContent.includes('考试对比')) { section = h.parentElement; break; }
    }
    if (!section) return { ok: false };
    const sels = section.querySelectorAll('select');
    if (sels.length < 2) return { ok: false, error: 'selects<2' };
    return { ok: true, examA: sels[0].value, examB: sels[1].value };
  })()`)
  const defaultOk = defaultSel.ok && defaultSel.examA && defaultSel.examB &&
    defaultSel.examA !== defaultSel.examB && defaultSel.examA !== '' && defaultSel.examB !== ''
  record('默认自动选择最近两场考试', defaultOk,
    defaultSel.ok ? `A=${defaultSel.examA?.slice(0, 25)}, B=${defaultSel.examB?.slice(0, 25)}` : defaultSel.error)

  // 7b. 设置 examA 和 examB 为我们的测试考试
  const setA = await setProfileSelect('examA', examAId)
  const setB = await setProfileSelect('examB', examBId)
  record('设置 examA = 测试考试A', setA.ok, setA.ok ? 'ok' : setA.error)
  record('设置 examB = 测试考试B', setB.ok, setB.ok ? 'ok' : setB.error)
  await waitFor(2500) // 等 eaa.range + compareStudentGrades

  // ===== 8. 验证科目对比表 =====
  console.log('\n--- 8. 验证科目对比表 ---')
  const dom2 = await getCompareSectionDOM()
  record('科目对比表渲染 (2 行)', dom2.subjectRows === 2, `actual=${dom2.subjectRows}`)

  if (dom2.subjectRows >= 2) {
    const rows = await getSubjectRows()
    if (rows.ok) {
      console.log('    科目行:')
      rows.rows.forEach((r, i) => console.log(`      ${i + 1}. ${r.subject} | A=${r.scoreA} B=${r.scoreB} Δ=${r.delta} 排名=${r.rankChange}`))

      // math: 70→80, delta=+10 (green ↑)
      const mathRow = rows.rows.find((r) => r.subject.includes('数学') || r.subject === 'math')
      if (mathRow) {
        record('math scoreA=70', mathRow.scoreA === '70', `actual=${mathRow.scoreA}`)
        record('math scoreB=80', mathRow.scoreB === '80', `actual=${mathRow.scoreB}`)
        record('math delta=+10 (↑)', mathRow.delta.includes('10') && mathRow.delta.includes('↑'), `actual="${mathRow.delta}"`)
      } else {
        record('math 行存在', false, '未找到')
      }

      // chinese: 100→110, delta=+10 (green ↑)
      const chineseRow = rows.rows.find((r) => r.subject.includes('语文') || r.subject === 'chinese')
      if (chineseRow) {
        record('chinese scoreA=100', chineseRow.scoreA === '100', `actual=${chineseRow.scoreA}`)
        record('chinese scoreB=110', chineseRow.scoreB === '110', `actual=${chineseRow.scoreB}`)
        record('chinese delta=+10 (↑)', chineseRow.delta.includes('10') && chineseRow.delta.includes('↑'), `actual="${chineseRow.delta}"`)
      } else {
        record('chinese 行存在', false, '未找到')
      }
    } else {
      record('科目行读取', false, rows.error)
    }
  }

  // ===== 9. 验证总分行 =====
  console.log('\n--- 9. 验证总分行 ---')
  const dom3 = await getCompareSectionDOM()
  record('总分行渲染', dom3.hasTotalRow, dom3.hasTotalRow ? 'ok' : '未找到')
  if (dom3.hasTotalRow) {
    const sum = await getSummaryText()
    if (sum.ok) {
      console.log(`    总分行: ${sum.totalRow}`)
      // 总分 170→190, delta=+20
      const totalOk = sum.totalRow.includes('170') && sum.totalRow.includes('190') && sum.totalRow.includes('20')
      record('总分 170→190 delta=+20', totalOk, `actual="${sum.totalRow}"`)
    }
  }

  // ===== 10. 验证汇总行 (进步/退步/操行) =====
  console.log('\n--- 10. 验证汇总行 ---')
  if (dom3.hasSummary) {
    const sum = await getSummaryText()
    if (sum.ok && sum.summaryRow) {
      console.log(`    汇总行: ${sum.summaryRow}`)
      // StudentA: 进步 2 科, 退步 0 科, 期间操行分=-1
      const impOk = sum.summaryRow.includes('进步') && sum.summaryRow.includes('2')
      record('汇总: 进步 2 科', impOk, `actual="${sum.summaryRow.slice(0, 80)}"`)
      const decOk = sum.summaryRow.includes('退步') && sum.summaryRow.includes('0')
      record('汇总: 退步 0 科', decOk, `actual="${sum.summaryRow.slice(0, 80)}"`)
      // 操行分 -1 (↓1)
      const conductOk = sum.summaryRow.includes('操行') && (sum.summaryRow.includes('↓') || sum.summaryRow.includes('1'))
      record('汇总: 操行分=-1', conductOk, `actual="${sum.summaryRow.slice(0, 80)}"`)
    }
  }

  // ===== 11. 验证柱状图 =====
  console.log('\n--- 11. 验证柱状图 ---')
  record('并排柱状图渲染', dom3.hasChart, dom3.hasChart ? 'ok' : '未找到')

  // ===== 12. 验证 DeltaBadge =====
  console.log('\n--- 12. 验证 DeltaBadge ---')
  record('DeltaBadge 渲染数量 > 0', dom3.deltaBadges > 0, `count=${dom3.deltaBadges}`)

  // ===== 13. 边界: 相同考试 =====
  console.log('\n--- 13. 边界: 相同考试 ---')
  await setProfileSelect('examB', examAId) // B = A
  await waitFor(1500)
  const domSame = await getCompareSectionDOM()
  record('相同考试显示提示', domSame.hasEmpty,
    `empty=${domSame.hasEmpty} text="${domSame.emptyText}"`)
  // 恢复
  await setProfileSelect('examB', examBId)
  await waitFor(2000)

  // ===== 14. 切换到 StudentB (退步生) =====
  console.log('\n--- 14. 切换到 StudentB (退步生) ---')
  // 关闭当前档案,打开 StudentB
  // 先找关闭按钮
  const closeBtn = await evalInPage(`(function(){
    const btns = Array.from(document.querySelectorAll('button'));
    const close = btns.find(b => b.textContent.includes('关闭') || b.textContent.includes('×') || b.textContent.includes('返回'));
    if (close) { close.click(); return { ok: true, text: close.textContent.trim() }; }
    return { ok: false };
  })()`)
  if (closeBtn.ok) {
    record('关闭 StudentA 档案', true, closeBtn.text)
    await waitFor(1000)
  } else {
    // 用返回按钮导航
    note('未找到关闭按钮,直接导航回 students 页')
    await navigateTo('#/dashboard')
    await waitFor(800)
    await navigateTo('#/students')
    await waitFor(2000)
  }

  const clickStuB = await clickStudentInList(studentB)
  record('点击 StudentB 打开档案', clickStuB.ok, clickStuB.ok ? 'ok' : clickStuB.error)
  await waitFor(1000)
  await clickTab('学业')
  await waitFor(2500)

  // 设置 examA 和 examB
  await setProfileSelect('examA', examAId)
  await setProfileSelect('examB', examBId)
  await waitFor(2500)

  // 验证 StudentB: math 90→80 (-10), chinese 110→100 (-10), total 200→180 (-20)
  const rowsB = await getSubjectRows()
  if (rowsB.ok && rowsB.rows.length >= 2) {
    console.log('    StudentB 科目行:')
    rowsB.rows.forEach((r, i) => console.log(`      ${i + 1}. ${r.subject} | A=${r.scoreA} B=${r.scoreB} Δ=${r.delta}`))
    const mathB = rowsB.rows.find((r) => r.subject.includes('数学') || r.subject === 'math')
    if (mathB) {
      record('StudentB math 90→80 (-10 ↓)', mathB.scoreA === '90' && mathB.scoreB === '80' && mathB.delta.includes('↓'), `actual="${mathB.delta}"`)
    }
    const chineseB = rowsB.rows.find((r) => r.subject.includes('语文') || r.subject === 'chinese')
    if (chineseB) {
      record('StudentB chinese 110→100 (-10 ↓)', chineseB.scoreA === '110' && chineseB.scoreB === '100' && chineseB.delta.includes('↓'), `actual="${chineseB.delta}"`)
    }
  } else {
    record('StudentB 科目行读取', false, `rows=${rowsB.rows?.length}`)
  }

  // 验证 StudentB 总分 200→180 (-20)
  const sumB = await getSummaryText()
  if (sumB.ok && sumB.totalRow) {
    const totalOk = sumB.totalRow.includes('200') && sumB.totalRow.includes('180') && sumB.totalRow.includes('20')
    record('StudentB 总分 200→180 (-20)', totalOk, `actual="${sumB.totalRow}"`)
  }

  // 验证 StudentB 汇总: 进步 0, 退步 2, 无操行分
  if (sumB.ok && sumB.summaryRow) {
    console.log(`    StudentB 汇总行: ${sumB.summaryRow}`)
    const impOk = sumB.summaryRow.includes('进步') && sumB.summaryRow.includes('0')
    record('StudentB 汇总: 进步 0 科', impOk)
    const decOk = sumB.summaryRow.includes('退步') && sumB.summaryRow.includes('2')
    record('StudentB 汇总: 退步 2 科', decOk)
    // StudentB 无操行事件,conductDelta=null → 不显示操行分
    const noConduct = !sumB.summaryRow.includes('操行')
    record('StudentB 汇总: 无操行分 (不显示)', noConduct, noConduct ? 'ok' : '不应显示操行分')
  }

  // ===== 15. 边界: 无成绩学生 =====
  console.log('\n--- 15. 边界: 无成绩学生 ---')
  // 关闭 StudentB,打开 StudentE (无成绩)
  await evalInPage(`(function(){
    const btns = Array.from(document.querySelectorAll('button'));
    const close = btns.find(b => b.textContent.includes('关闭') || b.textContent.includes('×') || b.textContent.includes('返回'));
    if (close) close.click();
  })()`)
  await waitFor(1000)
  const clickStuE = await clickStudentInList(studentE)
  record('点击 StudentE (无成绩) 打开档案', clickStuE.ok, clickStuE.ok ? 'ok' : clickStuE.error)
  await waitFor(1000)
  await clickTab('学业')
  await waitFor(2000)

  // StudentE 无成绩,应显示 "📚 暂无学业成绩"
  const noGradeText = await evalInPage(`(function(){
    return document.body.innerText.includes('暂无学业成绩');
  })()`)
  record('无成绩学生显示 "暂无学业成绩"', noGradeText, noGradeText ? 'ok' : '未找到提示')

  // 无成绩学生不应有对比区
  const domE = await getCompareSectionDOM()
  record('无成绩学生无对比区', !domE.hasSection, domE.hasSection ? '不应渲染对比区' : 'ok')

  // ===== 16. 性能测试 =====
  console.log('\n--- 16. 性能测试 ---')
  // 回到 StudentA 测性能
  await evalInPage(`(function(){
    const btns = Array.from(document.querySelectorAll('button'));
    const close = btns.find(b => b.textContent.includes('关闭') || b.textContent.includes('×') || b.textContent.includes('返回'));
    if (close) close.click();
  })()`)
  await waitFor(1000)
  await clickStudentInList(studentA)
  await waitFor(1000)
  await clickTab('学业')
  await waitFor(2500)

  const perfResult = await evalInPage(`(async function(){
    const h5s = document.querySelectorAll('h5');
    let section = null;
    for (const h of h5s) {
      if (h.textContent.includes('考试对比')) { section = h.parentElement; break; }
    }
    if (!section) return { ok: false, error: 'section not found' };
    const sels = section.querySelectorAll('select');
    if (sels.length < 2) return { ok: false, error: 'selects<2' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    const t0 = performance.now();
    setter.call(sels[0], ${JSON.stringify(examAId)});
    sels[0].dispatchEvent(new Event('change', { bubbles: true }));
    setter.call(sels[1], ${JSON.stringify(examBId)});
    sels[1].dispatchEvent(new Event('change', { bubbles: true }));
    // 等待加载完成
    let waited = 0;
    while (waited < 10000) {
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
      // 检查对比表是否渲染
      const rows = section.querySelectorAll('.grid.grid-cols-12');
      if (rows.length > 1) break;
    }
    const t1 = performance.now();
    return { ok: true, loadMs: t1 - t0, waited };
  })()`)
  if (perfResult.ok) {
    record('对比区加载性能', perfResult.loadMs < 5000, `load=${perfResult.loadMs.toFixed(0)}ms (阈值 5000ms)`)
  } else {
    record('对比区加载性能', false, perfResult.error)
  }

  // ===== 17. 内存检查 =====
  console.log('\n--- 17. 内存检查 ---')
  const memBefore = await evalInPage(`(function(){
    if (!performance.memory) return { ok: false };
    return { ok: true, used: performance.memory.usedJSHeapSize };
  })()`)
  if (memBefore.ok) {
    console.log(`    内存: used=${(memBefore.used / 1024 / 1024).toFixed(1)}MB`)
    // 多次切换 examA 触发重渲染
    for (let i = 0; i < 5; i++) {
      await setProfileSelect('examA', '')
      await waitFor(300)
      await setProfileSelect('examA', examAId)
      await waitFor(300)
    }
    const memAfter = await evalInPage(`(function(){
      if (!performance.memory) return { ok: false };
      return { ok: true, used: performance.memory.usedJSHeapSize };
    })()`)
    if (memAfter.ok) {
      const delta = (memAfter.used - memBefore.used) / 1024 / 1024
      console.log(`    切换后: used=${(memAfter.used / 1024 / 1024).toFixed(1)}MB, delta=${delta.toFixed(1)}MB`)
      record('内存泄漏检查 (5 次切换)', delta < 50, `delta=${delta.toFixed(1)}MB (阈值 50MB)`)
    }
  } else {
    record('内存检查', 'warn', 'performance.memory 不可用')
  }

  // ===== 18. 渲染一致性 =====
  console.log('\n--- 18. 渲染一致性 ---')
  await setProfileSelect('examA', examAId)
  await setProfileSelect('examB', examBId)
  await waitFor(2000)
  const render1 = await getSubjectRows()
  // 切空再切回
  await setProfileSelect('examA', '')
  await waitFor(800)
  await setProfileSelect('examA', examAId)
  await waitFor(2000)
  const render2 = await getSubjectRows()
  let consistent = false
  if (render1.ok && render2.ok && render1.rows.length === render2.rows.length) {
    consistent = render1.rows.every((r, i) =>
      r.subject === render2.rows[i].subject && r.scoreA === render2.rows[i].scoreA && r.delta === render2.rows[i].delta
    )
  }
  record('两次渲染结果一致', consistent, `rows=${render1.rows?.length} vs ${render2.rows?.length}`)

  // ===== 19. 总结 =====
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
