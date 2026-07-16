// 深度联动测试: 学业页录入成绩 → 学生档案学业tab同步显示
// 通过 CDP 在浏览器上下文中调用 window.api (Tauri bridge) 验证数据一致性
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

// 测试用的唯一标记,避免与真实数据冲突
const TEST_EXAM_NAME = `联动测试_${Date.now()}`
const TEST_SUBJECT_ID = 'math'

// 测试 1: 通过 IPC 创建考试
let examId = null
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      const res = await api.academic.createExam({
        name: ${JSON.stringify(TEST_EXAM_NAME)},
        type: 'other',
        date: new Date().toISOString().slice(0, 10),
        semester: '2025-2026-2',
        scope: '联动测试',
        subjects: ['${TEST_SUBJECT_ID}']
      });
      return JSON.stringify(res);
    })()
  `)
  const parsed = JSON.parse(result)
  if (parsed.success && parsed.data) {
    examId = parsed.data.id
    record('IPC 创建考试成功', true, `examId=${examId}`)
  } else {
    record('IPC 创建考试成功', false, JSON.stringify(parsed))
  }
} catch (e) { record('IPC 创建考试成功', false, e.message) }

// 测试 2: 获取学生列表,选第一个学生
let testStudentName = null
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      const res = await api.eaa.listStudents();
      if (res.success && res.data && res.data.students) {
        const active = res.data.students.filter(s => s.status !== 'Deleted');
        return active.length > 0 ? active[0].name : null;
      }
      return null;
    })()
  `)
  testStudentName = result
  record('获取测试学生', testStudentName != null, `name=${testStudentName}`)
} catch (e) { record('获取测试学生', false, e.message) }

// 测试 3: 通过 IPC 保存成绩 (academic.batchSetGrades)
const TEST_SCORE = 95.5
try {
  if (examId && testStudentName) {
    const result = await evalInPage(`
      (async function() {
        const api = window.api;
        const res = await api.academic.batchSetGrades([{
          examId: ${JSON.stringify(examId)},
          subjectId: '${TEST_SUBJECT_ID}',
          studentName: ${JSON.stringify(testStudentName)},
          score: ${TEST_SCORE},
          fullMark: 150,
          classRank: 3
        }]);
        return JSON.stringify(res);
      })()
    `)
    const parsed = JSON.parse(result)
    record('IPC 保存成绩成功', parsed.success === true, JSON.stringify(parsed))
  } else {
    record('IPC 保存成绩成功', false, '缺少 examId 或 studentName')
  }
} catch (e) { record('IPC 保存成绩成功', false, e.message) }

// 测试 4: 通过 academic.getGrades 读取该学生成绩,验证分数一致
try {
  if (testStudentName) {
    const result = await evalInPage(`
      (async function() {
        const api = window.api;
        const res = await api.academic.getGrades(${JSON.stringify(testStudentName)});
        return JSON.stringify(res);
      })()
    `)
    const parsed = JSON.parse(result)
    if (parsed.success && parsed.data && Array.isArray(parsed.data)) {
      const grade = parsed.data.find(g => g.examId === examId && g.subjectId === TEST_SUBJECT_ID)
      if (grade && grade.score === TEST_SCORE) {
        record('academic.getGrades 读取成绩一致', true, `score=${grade.score} rank=${grade.classRank}`)
      } else {
        record('academic.getGrades 读取成绩一致', false, `找到成绩但分数不匹配: ${JSON.stringify(grade)}`)
      }
    } else {
      record('academic.getGrades 读取成绩一致', false, '无数据或请求失败')
    }
  }
} catch (e) { record('academic.getGrades 读取成绩一致', false, e.message) }

// 测试 5: 验证学生档案学业tab使用相同IPC读取相同数据
try {
  if (testStudentName) {
    // 模拟 StudentProfile.AcademicsTab 的数据加载逻辑
    const result = await evalInPage(`
      (async function() {
        const api = window.api;
        // 同时加载考试列表和成绩(与 StudentProfile.AcademicsTab 完全一致)
        const [examRes, gradeRes] = await Promise.allSettled([
          api.academic.listExams(),
          api.academic.getGrades(${JSON.stringify(testStudentName)})
        ]);
        const exams = (examRes.status === 'fulfilled' && examRes.value.success) ? examRes.value.data : [];
        const grades = (gradeRes.status === 'fulfilled' && gradeRes.value.success) ? gradeRes.value.data : [];
        // 找到联动测试的考试
        const exam = exams.find(e => e.id === ${JSON.stringify(examId)});
        const grade = grades.find(g => g.examId === ${JSON.stringify(examId)} && g.subjectId === '${TEST_SUBJECT_ID}');
        return JSON.stringify({
          examFound: !!exam,
          examName: exam?.name,
          gradeFound: !!grade,
          gradeScore: grade?.score,
          gradeRank: grade?.classRank,
          gradeSubject: grade?.subjectId
        });
      })()
    `)
    const parsed = JSON.parse(result)
    const ok = parsed.examFound && parsed.gradeFound && parsed.gradeScore === TEST_SCORE
    record('学生档案学业tab数据一致(联动)', ok, `exam=${parsed.examName} score=${parsed.gradeScore} rank=${parsed.gradeRank}`)
  }
} catch (e) { record('学生档案学业tab数据一致(联动)', false, e.message) }

// 测试 6: 验证学业页面也能读取相同数据
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      // 模拟 AcademicsPage 的数据加载
      const [examRes, gradeRes] = await Promise.allSettled([
        api.academic.listExams(),
        api.academic.getGrades(${JSON.stringify(testStudentName)})
      ]);
      const exams = (examRes.status === 'fulfilled' && examRes.value.success) ? examRes.value.data : [];
      const grades = (gradeRes.status === 'fulfilled' && gradeRes.value.success) ? gradeRes.value.data : [];
      const exam = exams.find(e => e.id === ${JSON.stringify(examId)});
      const grade = grades.find(g => g.examId === ${JSON.stringify(examId)});
      return JSON.stringify({
        examInList: !!exam,
        gradeInList: !!grade,
        score: grade?.score
      });
    })()
  `)
  const parsed = JSON.parse(result)
  const ok = parsed.examInList && parsed.gradeInList && parsed.score === TEST_SCORE
  record('学业页面数据一致(联动)', ok, `score=${parsed.score}`)
} catch (e) { record('学业页面数据一致(联动)', false, e.message) }

// 测试 7: 清理 — 删除测试考试
try {
  if (examId) {
    await evalInPage(`
      (async function() {
        const api = window.api;
        await api.academic.deleteExam(${JSON.stringify(examId)});
      })()
    `)
    record('清理测试数据', true)
  }
} catch (e) { record('清理测试数据', false, e.message) }

// 测试 8: 验证删除后成绩也消失
try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      const res = await api.academic.getGrades(${JSON.stringify(testStudentName)});
      const grades = (res.success && res.data) ? res.data : [];
      const stillExists = grades.some(g => g.examId === ${JSON.stringify(examId)});
      return !stillExists;
    })()
  `)
  record('删除考试后成绩联动清除', result === true)
} catch (e) { record('删除考试后成绩联动清除', false, e.message) }

// 总结
console.log('\n========== 联动测试 ==========')
const pass = results.filter(r => r.ok).length
console.log(`总计: ${results.length}, 通过: ${pass}, 失败: ${results.length - pass}`)
if (pass < results.length) {
  console.log('\n失败项:')
  results.filter(r => !r.ok).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`))
}

ws.close()
process.exit(pass === results.length ? 0 : 1)
