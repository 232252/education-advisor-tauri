// 跨页面深度联动测试 — 在学业页面保存成绩 → 在学生档案学业tab验证数据一致
import http from 'node:http'
import WebSocket from 'ws'

const get = (u) => new Promise((r, j) => {
  http.get(u, (res) => {
    let d = ''
    res.on('data', (c) => (d += c))
    res.on('end', () => r(JSON.parse(d)))
  }).on('error', j)
})

const targets = (await get('http://127.0.0.1:9222/json')).filter((x) => x.type === 'page')
const target = targets[0]
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 1
const p = new Map()
ws.on('message', (r) => {
  const m = JSON.parse(r.toString())
  if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) }
})
const send = (method, params = {}) => new Promise((r) => {
  const i = id++; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params }))
})
const evalInPage = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) {
    const desc = r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'unknown'
    throw new Error(desc.substring(0, 500))
  }
  return r.result?.result?.value
}
await new Promise((r) => ws.on('open', r))

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

// === 步骤 1: 在学业页面创建考试并保存成绩 ===
console.log('\n--- 步骤 1: 学业页面创建考试+保存成绩 ---')

const setupResult = await evalInPage(`
  (async function() {
    const api = window.api;

    // 创建测试考试
    const examRes = await api.academic.createExam({
      name: '跨页面联动测试_' + Date.now(),
      type: 'midterm',
      date: '2026-07-15',
      semester: '2025-2026-1',
      scope: '全年级',
      subjects: ['chinese', 'math', 'english'],
    });
    if (!examRes.success) return JSON.stringify({ error: 'createExam failed' });
    const examId = examRes.data.id;
    const examName = examRes.data.name;

    // 获取学生
    const stuRes = await api.eaa.listStudents();
    if (!stuRes.success) return JSON.stringify({ error: 'listStudents failed' });
    const student = stuRes.data.students.find(s => s.status !== 'Deleted' && !s.name.includes('测试'));
    if (!student) return JSON.stringify({ error: 'no suitable student' });

    // 保存 3 科成绩
    const records = [
      { examId, subjectId: 'chinese', studentName: student.name, score: 128, fullMark: 150, classRank: 5 },
      { examId, subjectId: 'math', studentName: student.name, score: 142, fullMark: 150, classRank: 2 },
      { examId, subjectId: 'english', studentName: student.name, score: 135, fullMark: 150, classRank: 8 },
    ];
    const saveRes = await api.academic.batchSetGrades(records);
    if (!saveRes.success) return JSON.stringify({ error: 'batchSetGrades failed' });

    return JSON.stringify({
      examId, examName,
      studentName: student.name,
      recordsCount: records.length,
      scores: records.map(r => ({ subject: r.subjectId, score: r.score, rank: r.classRank })),
    });
  })()
`)
const setup = JSON.parse(setupResult)
if (setup.error) {
  console.log('Setup failed:', setup.error)
  process.exit(1)
}
console.log(`考试: ${setup.examName}`)
console.log(`学生: ${setup.studentName}`)
console.log(`成绩: 语文=${setup.scores[0].score} 数学=${setup.scores[1].score} 英语=${setup.scores[2].score}`)

// === 步骤 2: 导航到学业页面,验证成绩总览显示 ===
console.log('\n--- 步骤 2: 学业页面成绩总览 ---')
await evalInPage(`(async function() { location.hash = '#/academics'; await new Promise(r => setTimeout(r, 1500)); })()`)

try {
  // 检查成绩总览是否有数据
  const hasOverview = await evalInPage(`
    (function() {
      const main = document.querySelector('main');
      const text = main?.textContent || '';
      return text.length > 100;
    })()
  `)
  record('学业页面成绩总览有内容', hasOverview)
} catch (e) { record('学业页面成绩总览有内容', false, e.message) }

// === 步骤 3: 导航到学生页面,打开该学生档案 ===
console.log('\n--- 步骤 3: 学生档案学业tab ---')
await evalInPage(`(async function() { location.hash = '#/students'; await new Promise(r => setTimeout(r, 1500)); })()`)

try {
  // 搜索该学生
  await evalInPage(`
    (async function() {
      const inputs = document.querySelectorAll('input[type="text"], input[type="search"]');
      for (const inp of inputs) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(inp, ${JSON.stringify(setup.studentName)});
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 800));
        break;
      }
    })()
  `)

  // 点击学生行
  await evalInPage(`
    (async function() {
      const rows = document.querySelectorAll('tr, button');
      for (const row of rows) {
        if (row.textContent.includes(${JSON.stringify(setup.studentName)}) && row.textContent.length < 200) {
          row.click();
          await new Promise(r => setTimeout(r, 1500));
          break;
        }
      }
    })()
  `)

  // 切换到学业 tab
  await evalInPage(`
    (async function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const acadBtn = btns.find(b => b.textContent.includes('学业') && b.textContent.length < 20);
      if (acadBtn) { acadBtn.click(); await new Promise(r => setTimeout(r, 1500)); }
    })()
  `)

  // 检查学业 tab 是否显示成绩
  const profileAcademics = await evalInPage(`
    (function() {
      const text = document.body.textContent;
      // 检查是否有考试成绩显示
      const hasExam = text.includes(${JSON.stringify(setup.examName)}) || text.includes('期中');
      const hasScore = text.includes('128') || text.includes('142') || text.includes('135');
      return JSON.stringify({ hasExam, hasScore, textLen: text.length });
    })()
  `)
  const parsed = JSON.parse(profileAcademics)
  record('学生档案学业tab显示考试', parsed.hasExam, `exam=${setup.examName} hasScore=${parsed.hasScore}`)
  record('学生档案学业tab显示成绩', parsed.hasScore, `期望: 128/142/135`)
} catch (e) { record('学生档案学业tab联动', false, e.message) }

// === 步骤 4: 在学生档案学业tab中验证成绩数据一致 ===
console.log('\n--- 步骤 4: IPC 数据一致性验证 ---')
try {
  const ipcCheck = await evalInPage(`
    (async function() {
      const api = window.api;
      const grades = await api.academic.getGrades(${JSON.stringify(setup.studentName)});
      if (!grades.success) return JSON.stringify({ error: 'getGrades failed' });

      const examGrades = grades.data.filter(g => g.examId === ${JSON.stringify(setup.examId)});
      const subjectScores = {};
      for (const g of examGrades) {
        subjectScores[g.subjectId] = { score: g.score, rank: g.classRank };
      }

      return JSON.stringify({
        totalGrades: grades.data.length,
        examGrades: examGrades.length,
        subjectScores,
      });
    })()
  `)
  const parsed = JSON.parse(ipcCheck)
  if (parsed.error) {
    record('IPC 数据一致性', false, parsed.error)
  } else {
    const chinese = parsed.subjectScores.chinese
    const math = parsed.subjectScores.math
    const english = parsed.subjectScores.english
    const allMatch = chinese?.score === 128 && math?.score === 142 && english?.score === 135
    record('IPC 数据一致性', allMatch, `语文=${chinese?.score} 数学=${math?.score} 英语=${english?.score} 共${parsed.examGrades}条`)
  }
} catch (e) { record('IPC 数据一致性', false, e.message) }

// === 步骤 5: 清理 ===
console.log('\n--- 步骤 5: 清理 ---')
try {
  const cleanup = await evalInPage(`
    (async function() {
      const api = window.api;
      await api.academic.deleteExam(${JSON.stringify(setup.examId)});

      // 验证成绩已被级联删除
      const grades = await api.academic.getGrades(${JSON.stringify(setup.studentName)});
      const remaining = grades.success ? grades.data.filter(g => g.examId === ${JSON.stringify(setup.examId)}).length : -1;

      return JSON.stringify({ deleted: true, remainingGrades: remaining });
    })()
  `)
  const parsed = JSON.parse(cleanup)
  record('清理: 删除考试+级联删除成绩', parsed.remainingGrades === 0, `剩余成绩=${parsed.remainingGrades}`)
} catch (e) { record('清理: 删除考试+级联删除成绩', false, e.message) }

// 总结
console.log('\n========== 跨页面联动测试 ==========')
const pass = results.filter(r => r.ok).length
console.log(`总计: ${results.length}, 通过: ${pass}, 失败: ${results.length - pass}`)
if (pass < results.length) {
  console.log('\n失败项:')
  results.filter(r => !r.ok).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`))
}

ws.close()
process.exit(pass === results.length ? 0 : 1)
