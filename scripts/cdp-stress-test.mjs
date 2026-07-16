// 数据完整性压力测试: 多轮成绩保存/读取/验证
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
    throw new Error(desc.substring(0, 300))
  }
  return r.result?.result?.value
}
await new Promise((r) => ws.on('open', r))

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

// 获取学生列表
const studentsData = await evalInPage(`
  (async function() {
    const api = window.api;
    const res = await api.eaa.listStudents();
    if (res.success && res.data?.students) {
      return res.data.students.filter(s => s.status !== 'Deleted').slice(0, 10).map(s => s.name);
    }
    return [];
  })()
`)
console.log(`Using ${studentsData.length} students for stress test`)

// 创建测试考试
const examData = await evalInPage(`
  (async function() {
    const api = window.api;
    const res = await api.academic.createExam({
      name: '压力测试_' + Date.now(),
      type: 'test',
      date: '2026-07-15',
      semester: '2025-2026-2',
      scope: 'stress',
      subjects: ['math', 'chinese', 'english']
    });
    return JSON.stringify(res);
  })()
`)
const exam = JSON.parse(examData)
const examId = exam.data.id
console.log(`Created exam: ${examId}`)

// 测试 1: 批量保存 10 个学生 × 3 科目 = 30 条成绩
try {
  const records = []
  for (let i = 0; i < studentsData.length; i++) {
    for (const subjectId of ['math', 'chinese', 'english']) {
      records.push({
        examId,
        subjectId,
        studentName: studentsData[i],
        score: Math.round(Math.random() * 150 * 10) / 10,
        fullMark: 150,
        classRank: i + 1
      })
    }
  }

  const recordsJson = JSON.stringify(records)
  const saveResult = await evalInPage(`
    (async function() {
      const api = window.api;
      const res = await api.academic.batchSetGrades(JSON.parse(${JSON.stringify(recordsJson)}));
      return JSON.stringify(res);
    })()
  `)
  const parsed = JSON.parse(saveResult)
  record('批量保存30条成绩', parsed.success && parsed.data === 30, `saved=${parsed.data}`)
} catch (e) { record('批量保存30条成绩', false, e.message) }

// 测试 2: 逐个验证每个学生每个科目的成绩
try {
  let mismatches = 0
  let checked = 0
  for (const studentName of studentsData) {
    const gradeResult = await evalInPage(`
      (async function() {
        const api = window.api;
        const res = await api.academic.getGrades(${JSON.stringify(studentName)});
        return JSON.stringify(res.success ? res.data.filter(g => g.examId === ${JSON.stringify(examId)}) : []);
      })()
    `)
    const grades = JSON.parse(gradeResult)
    for (const g of grades) {
      checked++
      if (g.score == null || g.score < 0 || g.score > 150) {
        mismatches++
      }
      if (g.fullMark !== 150) {
        mismatches++
      }
    }
  }
  record('逐个验证成绩完整性', mismatches === 0 && checked === 30, `checked=${checked} mismatches=${mismatches}`)
} catch (e) { record('逐个验证成绩完整性', false, e.message) }

// 测试 3: 更新成绩 (upsert) — 修改第一个学生的数学成绩
try {
  const newName = studentsData[0]
  const newScore = 99.5
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      const res = await api.academic.batchSetGrades([{
        examId: ${JSON.stringify(examId)},
        subjectId: 'math',
        studentName: ${JSON.stringify(newName)},
        score: ${newScore},
        fullMark: 150,
        classRank: 1
      }]);
      // 验证
      const gradeRes = await api.academic.getGrades(${JSON.stringify(newName)});
      const grade = gradeRes.data.find(g => g.examId === ${JSON.stringify(examId)} && g.subjectId === 'math');
      return JSON.stringify({ success: res.success, updatedScore: grade?.score });
    })()
  `)
  const parsed = JSON.parse(result)
  record('更新成绩(upsert)', parsed.success && parsed.updatedScore === newScore, `score=${parsed.updatedScore}`)
} catch (e) { record('更新成绩(upsert)', false, e.message) }

// 测试 4: getClassGrades 班级查询
try {
  const studentsArray = JSON.stringify(studentsData)
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      const res = await api.academic.getClassGrades(${studentsArray}, ${JSON.stringify(examId)}, 'math');
      const data = res.data || {};
      const count = Object.keys(data).length;
      const withGrades = Object.values(data).filter(g => g && g.length > 0).length;
      return JSON.stringify({ count, withGrades });
    })()
  `)
  const parsed = JSON.parse(result)
  record('getClassGrades 班级查询', parsed.count === studentsData.length && parsed.withGrades === studentsData.length, `students=${parsed.count} withGrades=${parsed.withGrades}`)
} catch (e) { record('getClassGrades 班级查询', false, e.message) }

// 测试 5: 边界值 — 分数为 0
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      const res = await api.academic.batchSetGrades([{
        examId: ${JSON.stringify(examId)},
        subjectId: 'math',
        studentName: ${JSON.stringify(studentsData[1])},
        score: 0,
        fullMark: 150
      }]);
      const gradeRes = await api.academic.getGrades(${JSON.stringify(studentsData[1])});
      const grade = gradeRes.data.find(g => g.examId === ${JSON.stringify(examId)} && g.subjectId === 'math');
      return JSON.stringify({ success: res.success, score: grade?.score });
    })()
  `)
  const parsed = JSON.parse(result)
  record('边界值: 分数为0', parsed.success && parsed.score === 0, `score=${parsed.score}`)
} catch (e) { record('边界值: 分数为0', false, e.message) }

// 测试 6: 边界值 — 满分
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      const res = await api.academic.batchSetGrades([{
        examId: ${JSON.stringify(examId)},
        subjectId: 'chinese',
        studentName: ${JSON.stringify(studentsData[0])},
        score: 150,
        fullMark: 150
      }]);
      const gradeRes = await api.academic.getGrades(${JSON.stringify(studentsData[0])});
      const grade = gradeRes.data.find(g => g.examId === ${JSON.stringify(examId)} && g.subjectId === 'chinese');
      return JSON.stringify({ success: res.success, score: grade?.score });
    })()
  `)
  const parsed = JSON.parse(result)
  record('边界值: 满分150', parsed.success && parsed.score === 150, `score=${parsed.score}`)
} catch (e) { record('边界值: 满分150', false, e.message) }

// 测试 7: 边界值 — null 分数 (缺考)
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      const res = await api.academic.batchSetGrades([{
        examId: ${JSON.stringify(examId)},
        subjectId: 'english',
        studentName: ${JSON.stringify(studentsData[2])},
        score: null,
        fullMark: 150
      }]);
      const gradeRes = await api.academic.getGrades(${JSON.stringify(studentsData[2])});
      const grade = gradeRes.data.find(g => g.examId === ${JSON.stringify(examId)} && g.subjectId === 'english');
      return JSON.stringify({ success: res.success, score: grade?.score, hasRecord: !!grade });
    })()
  `)
  const parsed = JSON.parse(result)
  record('边界值: null分数(缺考)', parsed.success && parsed.hasRecord && parsed.score === null, `score=${parsed.score}`)
} catch (e) { record('边界值: null分数(缺考)', false, e.message) }

// 测试 8: 并发保存 (同一学生不同科目)
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      const student = ${JSON.stringify(studentsData[3])};
      // 并发保存3个科目
      const [r1, r2, r3] = await Promise.all([
        api.academic.batchSetGrades([{ examId: ${JSON.stringify(examId)}, subjectId: 'math', studentName: student, score: 80, fullMark: 150 }]),
        api.academic.batchSetGrades([{ examId: ${JSON.stringify(examId)}, subjectId: 'chinese', studentName: student, score: 90, fullMark: 150 }]),
        api.academic.batchSetGrades([{ examId: ${JSON.stringify(examId)}, subjectId: 'english', studentName: student, score: 85, fullMark: 150 }]),
      ]);
      // 验证
      const gradeRes = await api.academic.getGrades(student);
      const grades = gradeRes.data.filter(g => g.examId === ${JSON.stringify(examId)});
      return JSON.stringify({
        allSuccess: r1.success && r2.success && r3.success,
        gradeCount: grades.length,
        scores: grades.map(g => g.subjectId + ':' + g.score).sort()
      });
    })()
  `)
  const parsed = JSON.parse(result)
  const ok = parsed.allSuccess && parsed.gradeCount === 3
  record('并发保存(同学生3科目)', ok, `count=${parsed.gradeCount} scores=${parsed.scores?.join(',')}`)
} catch (e) { record('并发保存(同学生3科目)', false, e.message) }

// 清理
try {
  await evalInPage(`
    (async function() {
      const api = window.api;
      await api.academic.deleteExam(${JSON.stringify(examId)});
    })()
  `)
  record('清理测试数据', true)
} catch (e) { record('清理测试数据', false, e.message) }

// 总结
console.log('\n========== 数据完整性压力测试 ==========')
const pass = results.filter(r => r.ok).length
console.log(`总计: ${results.length}, 通过: ${pass}, 失败: ${results.length - pass}`)
if (pass < results.length) {
  console.log('\n失败项:')
  results.filter(r => !r.ok).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`))
}

ws.close()
process.exit(pass === results.length ? 0 : 1)
