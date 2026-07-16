// 边缘情况测试 — 成绩录入的各种边界值
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

// === 创建测试考试 ===
const setupResult = await evalInPage(`
  (async function() {
    const api = window.api;
    const examRes = await api.academic.createExam({
      name: '边缘测试_' + Date.now(),
      type: 'quiz',
      date: '2026-07-15',
      semester: '2025-2026-1',
      scope: '',
      subjects: ['chinese', 'math'],
    });
    return JSON.stringify({ examId: examRes.data?.id });
  })()
`)
const { examId } = JSON.parse(setupResult)
console.log(`Test exam: ${examId}\n`)

// === 获取测试学生 ===
const stuResult = await evalInPage(`
  (async function() {
    const api = window.api;
    const res = await api.eaa.listStudents();
    const student = res.data.students.find(s => s.status !== 'Deleted');
    return JSON.stringify({ name: student?.name });
  })()
`)
const { name: studentName } = JSON.parse(stuResult)
console.log(`Test student: ${studentName}\n`)

// 测试 1: 分数为 0
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      const res = await api.academic.setGrade({
        examId: ${JSON.stringify(examId)},
        subjectId: 'chinese',
        studentName: ${JSON.stringify(studentName)},
        score: 0,
        fullMark: 150,
      });
      if (!res.success) return JSON.stringify({ error: res.error });
      const grades = await api.academic.getGrades(${JSON.stringify(studentName)});
      const g = grades.data.find(x => x.examId === ${JSON.stringify(examId)} && x.subjectId === 'chinese');
      return JSON.stringify({ score: g?.score });
    })()
  `)
  const parsed = JSON.parse(result)
  record('分数为 0 (零分)', parsed.score === 0, `score=${parsed.score}`)
} catch (e) { record('分数为 0 (零分)', false, e.message) }

// 测试 2: 分数为满分
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      const res = await api.academic.setGrade({
        examId: ${JSON.stringify(examId)},
        subjectId: 'math',
        studentName: ${JSON.stringify(studentName)},
        score: 150,
        fullMark: 150,
        classRank: 1,
      });
      if (!res.success) return JSON.stringify({ error: res.error });
      const grades = await api.academic.getGrades(${JSON.stringify(studentName)});
      const g = grades.data.find(x => x.examId === ${JSON.stringify(examId)} && x.subjectId === 'math');
      return JSON.stringify({ score: g?.score, rank: g?.classRank });
    })()
  `)
  const parsed = JSON.parse(result)
  record('分数为满分 150', parsed.score === 150, `score=${parsed.score} rank=${parsed.rank}`)
} catch (e) { record('分数为满分 150', false, e.message) }

// 测试 3: 分数为 null (缺考)
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      const res = await api.academic.setGrade({
        examId: ${JSON.stringify(examId)},
        subjectId: 'chinese',
        studentName: ${JSON.stringify(studentName)},
        score: null,
        fullMark: 150,
        note: '缺考',
      });
      if (!res.success) return JSON.stringify({ error: res.error });
      const grades = await api.academic.getGrades(${JSON.stringify(studentName)});
      const g = grades.data.find(x => x.examId === ${JSON.stringify(examId)} && x.subjectId === 'chinese');
      return JSON.stringify({ score: g?.score, note: g?.note });
    })()
  `)
  const parsed = JSON.parse(result)
  record('分数为 null (缺考)', parsed.score === null, `score=${parsed.score} note=${parsed.note}`)
} catch (e) { record('分数为 null (缺考)', false, e.message) }

// 测试 4: 小数分数
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      const res = await api.academic.setGrade({
        examId: ${JSON.stringify(examId)},
        subjectId: 'math',
        studentName: ${JSON.stringify(studentName)},
        score: 99.5,
        fullMark: 150,
      });
      if (!res.success) return JSON.stringify({ error: res.error });
      const grades = await api.academic.getGrades(${JSON.stringify(studentName)});
      const g = grades.data.find(x => x.examId === ${JSON.stringify(examId)} && x.subjectId === 'math');
      return JSON.stringify({ score: g?.score });
    })()
  `)
  const parsed = JSON.parse(result)
  record('小数分数 99.5', parsed.score === 99.5, `score=${parsed.score}`)
} catch (e) { record('小数分数 99.5', false, e.message) }

// 测试 5: 包含特殊字符的学生备注
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      const res = await api.academic.setGrade({
        examId: ${JSON.stringify(examId)},
        subjectId: 'chinese',
        studentName: ${JSON.stringify(studentName)},
        score: 85,
        fullMark: 150,
        note: '考试时生病,带病坚持 💪 <script>alert(1)</script>',
      });
      if (!res.success) return JSON.stringify({ error: res.error });
      const grades = await api.academic.getGrades(${JSON.stringify(studentName)});
      const g = grades.data.find(x => x.examId === ${JSON.stringify(examId)} && x.subjectId === 'chinese');
      return JSON.stringify({ hasNote: !!g?.note, noteLen: g?.note?.length || 0 });
    })()
  `)
  const parsed = JSON.parse(result)
  record('特殊字符备注 (emoji+HTML)', parsed.hasNote, `noteLen=${parsed.noteLen}`)
} catch (e) { record('特殊字符备注 (emoji+HTML)', false, e.message) }

// 测试 6: upsert 更新已有成绩
try {
  // 先设置一个成绩
  await evalInPage(`
    (async function() {
      const api = window.api;
      await api.academic.setGrade({
        examId: ${JSON.stringify(examId)},
        subjectId: 'chinese',
        studentName: ${JSON.stringify(studentName)},
        score: 80,
        fullMark: 150,
      });
    })()
  `)

  // 再更新为不同分数
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      await api.academic.setGrade({
        examId: ${JSON.stringify(examId)},
        subjectId: 'chinese',
        studentName: ${JSON.stringify(studentName)},
        score: 95,
        fullMark: 150,
      });
      const grades = await api.academic.getGrades(${JSON.stringify(studentName)});
      const matching = grades.data.filter(x => x.examId === ${JSON.stringify(examId)} && x.subjectId === 'chinese');
      return JSON.stringify({ count: matching.length, score: matching[0]?.score });
    })()
  `)
  const parsed = JSON.parse(result)
  record('upsert 更新 (不创建重复)', parsed.count === 1 && parsed.score === 95, `count=${parsed.count} score=${parsed.score}`)
} catch (e) { record('upsert 更新 (不创建重复)', false, e.message) }

// 测试 7: 批量保存后验证数量
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      const stuRes = await api.eaa.listStudents();
      const students = stuRes.data.students.filter(s => s.status !== 'Deleted').slice(0, 5);
      const records = students.map((s, i) => ({
        examId: ${JSON.stringify(examId)},
        subjectId: 'chinese',
        studentName: s.name,
        score: 60 + i * 10,
        fullMark: 150,
      }));
      const saveRes = await api.academic.batchSetGrades(records);
      if (!saveRes.success) return JSON.stringify({ error: saveRes.error });

      // 验证每个学生都有成绩
      let verified = 0;
      for (const r of records) {
        const gRes = await api.academic.getGrades(r.studentName);
        const g = gRes.data?.find(x => x.examId === r.examId && x.subjectId === r.subjectId);
        if (g && g.score === r.score) verified++;
      }
      return JSON.stringify({ saved: saveRes.data, verified });
    })()
  `)
  const parsed = JSON.parse(result)
  record('批量保存5学生+验证', parsed.verified === 5, `saved=${parsed.saved} verified=${parsed.verified}`)
} catch (e) { record('批量保存5学生+验证', false, e.message) }

// 测试 8: 删除考试后成绩级联删除
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      // 删除考试
      await api.academic.deleteExam(${JSON.stringify(examId)});

      // 验证成绩已被删除
      const stuRes = await api.eaa.listStudents();
      const students = stuRes.data.students.filter(s => s.status !== 'Deleted').slice(0, 5);
      let remaining = 0;
      for (const s of students) {
        const gRes = await api.academic.getGrades(s.name);
        const matching = gRes.data?.filter(x => x.examId === ${JSON.stringify(examId)}) || [];
        remaining += matching.length;
      }
      return JSON.stringify({ remaining });
    })()
  `)
  const parsed = JSON.parse(result)
  record('删除考试级联删除成绩', parsed.remaining === 0, `remaining=${parsed.remaining}`)
} catch (e) { record('删除考试级联删除成绩', false, e.message) }

// 测试 9: 无效 examId 处理
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      // 使用不存在的 examId 查询班级成绩
      const res = await api.academic.getClassGrades(['学生1'], 'nonexistent-exam-id', 'chinese');
      return JSON.stringify({ success: res.success, hasData: !!res.data });
    })()
  `)
  const parsed = JSON.parse(result)
  record('无效 examId 不报错', parsed.success, `hasData=${parsed.hasData}`)
} catch (e) { record('无效 examId 不报错', false, e.message) }

// 测试 10: 空学生列表
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      const res = await api.academic.getClassGrades([], 'exam-123', 'chinese');
      return JSON.stringify({ success: res.success, isEmpty: Object.keys(res.data || {}).length === 0 });
    })()
  `)
  const parsed = JSON.parse(result)
  record('空学生列表返回空对象', parsed.success && parsed.isEmpty, `isEmpty=${parsed.isEmpty}`)
} catch (e) { record('空学生列表返回空对象', false, e.message) }

// 总结
console.log('\n========== 边缘情况测试 ==========')
const pass = results.filter(r => r.ok).length
console.log(`总计: ${results.length}, 通过: ${pass}, 失败: ${results.length - pass}`)
if (pass < results.length) {
  console.log('\n失败项:')
  results.filter(r => !r.ok).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`))
}

ws.close()
process.exit(pass === results.length ? 0 : 1)
