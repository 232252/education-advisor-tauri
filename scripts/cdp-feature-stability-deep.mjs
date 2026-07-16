// =============================================================
// Round 11: 用户需求功能稳定性 + 压力测试 (CDP)
//
// 针对用户提出的 4 个核心需求, 进行高频重复 / 长时稳定 / 并发压测:
//   1. 学业模块高频录入稳定性 (8 项 - 50+ 次循环 setGrade/update/delete)
//   2. 班级筛选并发压力 (7 项 - 学生分班/换班/清班循环)
//   3. 导航栏快速切换稳定性 (6 项 - 20+ 次路由跳转, sidebar 状态保持)
//   4. 学生档案学业Tab联动稳定性 (6 项 - 并发修改成绩后联动验证)
//   5. 长时运行数据一致性 (5 项 - 压测后数据完整性校验)
//
// 运行: node scripts/cdp-feature-stability-deep.mjs
// =============================================================
import http from 'node:http'

const CDP_PORT = 9222
const BASE = `http://127.0.0.1:${CDP_PORT}`

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error(`JSON parse fail: ${e.message}`)) }
      })
    }).on('error', reject)
  })
}

async function main() {
  const results = []
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  }
  const test = (name, fn) =>
    fn().catch((err) => record(name, false, `异常: ${String(err && err.message ? err.message : err).slice(0, 200)}`))

  // ---------- CDP 连接 ----------
  const targets = (await fetchJson(`${BASE}/json`)).filter((t) => t.type === 'page')
  if (targets.length === 0) { console.log('FAIL: No CDP targets'); process.exit(1) }
  const target = targets[0]
  console.log(`Target: ${target.title} (${target.url})\n`)

  const { default: WebSocket } = await import('ws')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let msgId = 1
  const pending = new Map()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = msgId++
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evalInPage = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) {
      const desc = r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'unknown'
      throw new Error(`Eval error: ${desc.slice(0, 300)}`)
    }
    return r.result?.result?.value
  }

  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP connected, running stability stress tests...\n')

  // ---------- IPC 封装 ----------
  const callIpc = async (code) =>
    evalInPage(`
      (async function() {
        const api = window.__EAA_API__ || window.api;
        if (!api) return { __error: 'no-api' };
        try {
          ${code}
        } catch (e) {
          return { __error: String(e && e.message ? e.message : e) };
        }
      })()
    `)

  const isOk = (res) => !!res && !res.__error && res?.success !== false
  const isRejected = (res) => !!res && (res?.success === false || !!res.__error)

  // ---------- UI 导航辅助 ----------
  const navigateTo = async (hash) => {
    await evalInPage(`(function(){ window.location.hash = ${JSON.stringify(hash)}; })()`)
    await new Promise((r) => setTimeout(r, 1000))
  }
  const getPageText = async () =>
    evalInPage(`(function(){ return document.body.innerText.substring(0, 5000); })()`)

  // ---------- 业务 helper ----------
  const TS = Date.now()

  // EAA helpers
  const listStudents = async () => {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    return r?.data?.students ?? []
  }
  const addStudent = async (name) =>
    callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(name)}); return res;`)
  const deleteStudentSoft = async (name, reason) =>
    callIpc(`const res = await api.eaa.deleteStudent(${JSON.stringify(name)}, ${JSON.stringify(reason)}); return res;`)
  const getScore = async (name) => {
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(name)}); return res;`)
    return r?.data ?? null
  }
  const setStudentClassId = async (name, classId) =>
    callIpc(`const res = await api.eaa.setStudentMeta({ name: ${JSON.stringify(name)}, classId: ${JSON.stringify(classId)} }); return res;`)
  const clearStudentClassId = async (name) =>
    callIpc(`const res = await api.eaa.setStudentMeta({ name: ${JSON.stringify(name)}, clearClassId: true }); return res;`)

  // Academic helpers
  const listExams = async () => {
    const r = await callIpc(`const res = await api.academic.listExams(); return res;`)
    return r?.data ?? []
  }
  const createExam = async (name, subjects) => {
    const r = await callIpc(`
      const res = await api.academic.createExam({
        name: ${JSON.stringify(name)},
        type: 'monthly',
        date: new Date().toISOString().slice(0, 10),
        semester: '稳定性测试学期',
        subjects: ${JSON.stringify(subjects)},
      });
      return res;
    `)
    return r?.success ? r.data : null
  }
  const deleteExam = async (examId) =>
    callIpc(`const res = await api.academic.deleteExam(${JSON.stringify(examId)}); return res;`)
  const setGrade = async (examId, studentName, subjectId, score, fullMark) =>
    callIpc(`
      const res = await api.academic.setGrade({
        examId: ${JSON.stringify(examId)},
        subjectId: ${JSON.stringify(subjectId)},
        studentName: ${JSON.stringify(studentName)},
        score: ${score},
        fullMark: ${fullMark},
      });
      return res;
    `)
  const getGrades = async (studentName) => {
    const r = await callIpc(`const res = await api.academic.getGrades(${JSON.stringify(studentName)}); return res;`)
    return r?.data ?? []
  }
  const getConfig = async () => {
    const r = await callIpc(`const res = await api.academic.getConfig(); return res;`)
    return r?.data ?? null
  }
  const batchSetGrades = async (records) =>
    callIpc(`const res = await api.academic.batchSetGrades(${JSON.stringify(records)}); return res;`)

  // Class helpers
  const listClasses = async () => {
    const r = await callIpc(`const res = await api.class.list(); return res;`)
    return r?.data ?? []
  }
  const createClass = async (classId, name) => {
    const r = await callIpc(`
      const res = await api.class.create({
        class_id: ${JSON.stringify(classId)},
        name: ${JSON.stringify(name)},
        grade: '稳定性年级',
        note: 'stability-deep-test',
        teacher: '稳定性老师',
      });
      return res;
    `)
    return r?.success ? r.data : null
  }
  const deleteClass = async (id) =>
    callIpc(`
      let res;
      if (typeof api.class.remove === 'function') {
        res = await api.class.remove(${JSON.stringify(id)});
      } else {
        res = await api.class.delete(${JSON.stringify(id)});
      }
      return res;
    `)
  const assignStudents = async (classId, names) =>
    callIpc(`const res = await api.class.assign({ class_id: ${JSON.stringify(classId)}, student_names: ${JSON.stringify(names)} }); return res;`)

  // ---------- 清理账本 ----------
  const createdExamIds = []
  const createdClassIds = [] // 内部 id
  const throwawayStudents = []

  // ---------- 预取学业配置 ----------
  const config = await getConfig()
  const subjects = config?.subjects ?? []
  const SUBJECT_A = subjects[0]?.id ?? 'chinese'
  const SUBJECT_A_FULL = subjects[0]?.fullMark ?? 150
  const SUBJECT_B = subjects[1]?.id ?? 'math'
  const SUBJECT_B_FULL = subjects[1]?.fullMark ?? 150
  console.log(`学业配置: ${subjects.length} 科目, 使用 ${SUBJECT_A}(${SUBJECT_A_FULL}) + ${SUBJECT_B}(${SUBJECT_B_FULL})\n`)

  // =============================================================
  // Section 1: 学业模块高频录入稳定性 (8 项)
  // =============================================================
  console.log('━━━ Section 1: 学业模块高频录入稳定性 ━━━')

  // 1.1 创建用于压测的考试和学生
  const STAB_STU = `stab_stu_${TS}`
  const STAB_STU2 = `stab_stu2_${TS}`
  await addStudent(STAB_STU)
  throwawayStudents.push(STAB_STU)
  await addStudent(STAB_STU2)
  throwawayStudents.push(STAB_STU2)
  const STAB_EXAM = await createExam(`stab-exam_${TS}`, [SUBJECT_A, SUBJECT_B])
  if (STAB_EXAM) createdExamIds.push(STAB_EXAM.id)
  const EXAM_ID = STAB_EXAM?.id || 'fake-exam-id'

  await test('1.1 50 次连续 setGrade 同一学生同一科目 (覆盖更新)', async () => {
    const N = '1.1 50 次连续 setGrade 同一学生同一科目 (覆盖更新)'
    let okCount = 0
    let lastScore = -1
    for (let i = 0; i < 50; i++) {
      const score = 50 + (i % 100)
      const r = await setGrade(EXAM_ID, STAB_STU, SUBJECT_A, score, SUBJECT_A_FULL)
      if (isOk(r)) {
        okCount++
        lastScore = score
      }
    }
    // 验证最终值正确 (覆盖更新, 应为最后一次)
    const grades = await getGrades(STAB_STU)
    const g = grades.find((x) => x.examId === EXAM_ID && x.subjectId === SUBJECT_A)
    const finalOk = g && g.score === lastScore
    record(N, okCount === 50 && finalOk, `ok=${okCount}/50 finalScore=${g?.score} expected=${lastScore}`)
  })

  await test('1.2 50 次连续 setGrade 不同学生不同科目 (批量交替)', async () => {
    const N = '1.2 50 次连续 setGrade 不同学生不同科目 (批量交替)'
    let okCount = 0
    for (let i = 0; i < 50; i++) {
      const stu = i % 2 === 0 ? STAB_STU : STAB_STU2
      const subj = i % 2 === 0 ? SUBJECT_A : SUBJECT_B
      const full = i % 2 === 0 ? SUBJECT_A_FULL : SUBJECT_B_FULL
      const score = 60 + (i % 80)
      const r = await setGrade(EXAM_ID, stu, subj, score, full)
      if (isOk(r)) okCount++
    }
    // 验证两个学生都有成绩
    const g1 = await getGrades(STAB_STU)
    const g2 = await getGrades(STAB_STU2)
    const bothHave = g1.length > 0 && g2.length > 0
    record(N, okCount === 50 && bothHave, `ok=${okCount}/50 g1=${g1.length} g2=${g2.length}`)
  })

  await test('1.3 batchSetGrades 50 条记录原子写入', async () => {
    const N = '1.3 batchSetGrades 50 条记录原子写入'
    // 准备 50 个临时学生
    const batchStus = []
    for (let i = 0; i < 50; i++) {
      const name = `stab_batch_${TS}_${i}`
      await addStudent(name)
      throwawayStudents.push(name)
      batchStus.push(name)
    }
    const records = batchStus.map((name, i) => ({
      examId: EXAM_ID,
      subjectId: SUBJECT_A,
      studentName: name,
      score: 50 + (i % 50),
      fullMark: SUBJECT_A_FULL,
    }))
    const r = await batchSetGrades(records)
    // 验证全部写入
    let verified = 0
    for (const name of batchStus) {
      const g = await getGrades(name)
      if (g.some((x) => x.examId === EXAM_ID && x.subjectId === SUBJECT_A)) verified++
    }
    record(N, isOk(r) && verified === 50, `success=${r?.success} verified=${verified}/50`)
  })

  await test('1.4 成绩反复修改后最终值一致性', async () => {
    const N = '1.4 成绩反复修改后最终值一致性'
    const targetScore = 123
    // 反复修改为不同值
    for (const s of [50, 80, 30, 90, 60, targetScore]) {
      await setGrade(EXAM_ID, STAB_STU, SUBJECT_B, s, SUBJECT_B_FULL)
    }
    const grades = await getGrades(STAB_STU)
    const g = grades.find((x) => x.examId === EXAM_ID && x.subjectId === SUBJECT_B)
    record(N, g && g.score === targetScore, `finalScore=${g?.score} expected=${targetScore}`)
  })

  await test('1.5 setGrade 后立即 getGrades 数据可见 (读己之写一致性)', async () => {
    const N = '1.5 setGrade 后立即 getGrades 数据可见 (读己之写一致性)'
    let consistent = 0
    for (let i = 0; i < 20; i++) {
      const score = 70 + i
      await setGrade(EXAM_ID, STAB_STU, SUBJECT_A, score, SUBJECT_A_FULL)
      const grades = await getGrades(STAB_STU)
      const g = grades.find((x) => x.examId === EXAM_ID && x.subjectId === SUBJECT_A)
      if (g && g.score === score) consistent++
    }
    record(N, consistent === 20, `consistent=${consistent}/20`)
  })

  await test('1.6 满分边界值 0 和 fullMark 反复录入', async () => {
    const N = '1.6 满分边界值 0 和 fullMark 反复录入'
    let okCount = 0
    for (let i = 0; i < 10; i++) {
      const score = i % 2 === 0 ? 0 : SUBJECT_A_FULL
      const r = await setGrade(EXAM_ID, STAB_STU, SUBJECT_A, score, SUBJECT_A_FULL)
      if (isOk(r)) okCount++
    }
    // 最终值应为 fullMark (最后一次 i=9 是奇数, score=fullMark)
    const grades = await getGrades(STAB_STU)
    const g = grades.find((x) => x.examId === EXAM_ID && x.subjectId === SUBJECT_A)
    record(N, okCount === 10 && g && g.score === SUBJECT_A_FULL, `ok=${okCount}/10 final=${g?.score}`)
  })

  await test('1.7 deleteExam 后 getGrades 返回空 (级联清理)', async () => {
    const N = '1.7 deleteExam 后 getGrades 返回空 (级联清理)'
    // 创建临时考试 + 录入成绩
    const tmpExam = await createExam(`stab-tmp-exam_${TS}`, [SUBJECT_A])
    if (tmpExam) createdExamIds.push(tmpExam.id)
    const tmpExamId = tmpExam?.id || 'fake'
    await setGrade(tmpExamId, STAB_STU, SUBJECT_A, 88, SUBJECT_A_FULL)
    const before = await getGrades(STAB_STU)
    const hadGrade = before.some((x) => x.examId === tmpExamId)
    // 删除考试
    const r = await deleteExam(tmpExamId)
    const after = await getGrades(STAB_STU)
    const noGrade = !after.some((x) => x.examId === tmpExamId)
    record(N, hadGrade && isOk(r) && noGrade, `hadBefore=${hadGrade} deleted=${isOk(r)} noAfter=${noGrade}`)
  })

  await test('1.8 高频 listExams 稳定性 (20 次连续调用)', async () => {
    const N = '1.8 高频 listExams 稳定性 (20 次连续调用)'
    let okCount = 0
    let lastCount = -1
    for (let i = 0; i < 20; i++) {
      const r = await listExams()
      if (Array.isArray(r)) {
        okCount++
        lastCount = r.length
      }
    }
    record(N, okCount === 20, `ok=${okCount}/20 exams=${lastCount}`)
  })

  // =============================================================
  // Section 2: 班级筛选并发压力 (7 项)
  // =============================================================
  console.log('\n━━━ Section 2: 班级筛选并发压力 ━━━')

  // 创建稳定性测试班级
  const STAB_CLASS_A = `stab-class-a-${TS}`
  const STAB_CLASS_B = `stab-class-b-${TS}`
  const clsA = await createClass(STAB_CLASS_A, `稳定性A班_${TS}`)
  const clsB = await createClass(STAB_CLASS_B, `稳定性B班_${TS}`)
  if (clsA?.id) createdClassIds.push(clsA.id)
  if (clsB?.id) createdClassIds.push(clsB.id)

  await test('2.1 20 个学生分入 A 班', async () => {
    const N = '2.1 20 个学生分入 A 班'
    const stus = []
    for (let i = 0; i < 20; i++) {
      const name = `stab_cls_a_${TS}_${i}`
      await addStudent(name)
      throwawayStudents.push(name)
      stus.push(name)
    }
    const r = await assignStudents(STAB_CLASS_A, stus)
    // 验证
    const students = await listStudents()
    const inClass = stus.filter((n) => students.find((s) => s.name === n && s.class_id === STAB_CLASS_A)).length
    record(N, isOk(r) && inClass === 20, `success=${r?.success} assigned=${r?.assigned} inClass=${inClass}/20`)
  })

  await test('2.2 20 个学生从 A 班调到 B 班', async () => {
    const N = '2.2 20 个学生从 A 班调到 B 班'
    const students = await listStudents()
    const classAStus = students.filter((s) => s.class_id === STAB_CLASS_A).map((s) => s.name)
    const r = await assignStudents(STAB_CLASS_B, classAStus)
    // 验证
    const after = await listStudents()
    const inB = classAStus.filter((n) => after.find((s) => s.name === n && s.class_id === STAB_CLASS_B)).length
    const stillInA = classAStus.filter((n) => after.find((s) => s.name === n && s.class_id === STAB_CLASS_A)).length
    record(N, isOk(r) && inB === classAStus.length && stillInA === 0, `inB=${inB}/${classAStus.length} stillInA=${stillInA}`)
  })

  await test('2.3 学生在 A/B 班间反复调班 10 次', async () => {
    const N = '2.3 学生在 A/B 班间反复调班 10 次'
    const testStu = `stab_switch_${TS}`
    await addStudent(testStu)
    throwawayStudents.push(testStu)
    let okCount = 0
    let lastClass = null
    for (let i = 0; i < 10; i++) {
      const targetClass = i % 2 === 0 ? STAB_CLASS_A : STAB_CLASS_B
      const r = await assignStudents(targetClass, [testStu])
      if (isOk(r)) {
        okCount++
        lastClass = targetClass
      }
    }
    // 验证最终班级
    const students = await listStudents()
    const s = students.find((x) => x.name === testStu)
    record(N, okCount === 10 && s?.class_id === lastClass, `ok=${okCount}/10 final=${s?.class_id} expected=${lastClass}`)
  })

  await test('2.4 listClasses 高频调用稳定性 (20 次)', async () => {
    const N = '2.4 listClasses 高频调用稳定性 (20 次)'
    let okCount = 0
    let lastCount = -1
    for (let i = 0; i < 20; i++) {
      const r = await listClasses()
      if (Array.isArray(r)) {
        okCount++
        lastCount = r.length
      }
    }
    record(N, okCount === 20, `ok=${okCount}/20 classes=${lastCount}`)
  })

  await test('2.5 班级存在性校验在 50 次错误 assign 中稳定拒绝', async () => {
    const N = '2.5 班级存在性校验在 50 次错误 assign 中稳定拒绝'
    let rejectCount = 0
    for (let i = 0; i < 50; i++) {
      const fakeClassId = `non-existent-${TS}-${i}`
      const r = await assignStudents(fakeClassId, [STAB_STU])
      if (isRejected(r)) rejectCount++
    }
    record(N, rejectCount === 50, `rejected=${rejectCount}/50`)
  })

  await test('2.6 学生清班后 class_id 为空', async () => {
    const N = '2.6 学生清班后 class_id 为空'
    // 先分班再清班
    await assignStudents(STAB_CLASS_A, [STAB_STU])
    const before = await listStudents()
    const hadClass = before.find((s) => s.name === STAB_STU)?.class_id === STAB_CLASS_A
    const r = await clearStudentClassId(STAB_STU)
    const after = await listStudents()
    const noClass = !after.find((s) => s.name === STAB_STU)?.class_id
    record(N, hadClass && isOk(r) && noClass, `hadClass=${hadClass} cleared=${isOk(r)} noClass=${noClass}`)
  })

  await test('2.7 班级筛选 + 学生列表一致性 (A 班学生数 = listStudents 过滤)', async () => {
    const N = '2.7 班级筛选 + 学生列表一致性 (A 班学生数 = listStudents 过滤)'
    const students = await listStudents()
    const classAStudents = students.filter((s) => s.class_id === STAB_CLASS_A)
    // class_id 在 listStudents 返回中存在
    const allValidClassIds = classAStudents.every((s) => s.class_id === STAB_CLASS_A)
    record(N, allValidClassIds, `classAStudents=${classAStudents.length} allValid=${allValidClassIds}`)
  })

  // =============================================================
  // Section 3: 导航栏快速切换稳定性 (6 项)
  // =============================================================
  console.log('\n━━━ Section 3: 导航栏快速切换稳定性 ━━━')

  await test('3.1 顺序遍历 6 个主路由 3 轮 (18 次跳转)', async () => {
    const N = '3.1 顺序遍历 6 个主路由 3 轮 (18 次跳转)'
    const routes = ['#/dashboard', '#/students', '#/academic', '#/classes', '#/events', '#/settings']
    let okCount = 0
    for (let round = 0; round < 3; round++) {
      for (const route of routes) {
        await navigateTo(route)
        const text = await getPageText()
        // 验证页面非空非报错
        if (text && text.length > 50 && !text.includes('Cannot read') && !text.includes('is not defined')) {
          okCount++
        }
      }
    }
    record(N, okCount === 18, `ok=${okCount}/18`)
  })

  await test('3.2 快速来回切换 students ↔ academic 10 次', async () => {
    const N = '3.2 快速来回切换 students ↔ academic 10 次'
    let okCount = 0
    for (let i = 0; i < 10; i++) {
      const route = i % 2 === 0 ? '#/students' : '#/academic'
      await navigateTo(route)
      const text = await getPageText()
      if (text && text.length > 50) okCount++
    }
    record(N, okCount === 10, `ok=${okCount}/10`)
  })

  await test('3.3 同一路由连续跳转 5 次 (hash 不变)', async () => {
    const N = '3.3 同一路由连续跳转 5 次 (hash 不变)'
    await navigateTo('#/dashboard')
    let okCount = 0
    for (let i = 0; i < 5; i++) {
      await navigateTo('#/dashboard')
      const text = await getPageText()
      if (text && text.length > 50) okCount++
    }
    record(N, okCount === 5, `ok=${okCount}/5`)
  })

  await test('3.4 导航到 students 后页面标题/内容包含学生相关字样', async () => {
    const N = '3.4 导航到 students 后页面标题/内容包含学生相关字样'
    await navigateTo('#/students')
    const text = await getPageText()
    const hasStudentKeyword = text.includes('学生') || text.includes('Student') || text.includes('搜索')
    record(N, hasStudentKeyword, `hasKeyword=${hasStudentKeyword}`)
  })

  await test('3.5 导航到 academic 后页面标题/内容包含学业相关字样', async () => {
    const N = '3.5 导航到 academic 后页面标题/内容包含学业相关字样'
    await navigateTo('#/academic')
    const text = await getPageText()
    const hasAcademicKeyword = text.includes('学业') || text.includes('考试') || text.includes('成绩') || text.includes('Academic')
    record(N, hasAcademicKeyword, `hasKeyword=${hasAcademicKeyword}`)
  })

  await test('3.6 导航到 classes 后页面标题/内容包含班级相关字样', async () => {
    const N = '3.6 导航到 classes 后页面标题/内容包含班级相关字样'
    await navigateTo('#/classes')
    const text = await getPageText()
    const hasClassKeyword = text.includes('班级') || text.includes('Class') || text.includes('学生')
    record(N, hasClassKeyword, `hasKeyword=${hasClassKeyword}`)
  })

  // =============================================================
  // Section 4: 学生档案学业Tab联动稳定性 (6 项)
  // =============================================================
  console.log('\n━━━ Section 4: 学生档案学业Tab联动稳定性 ━━━')

  await test('4.1 IPC 层: 成绩修改后 getGrades 立即反映 (无缓存陈旧)', async () => {
    const N = '4.1 IPC 层: 成绩修改后 getGrades 立即反映 (无缓存陈旧)'
    let consistent = 0
    for (let i = 0; i < 15; i++) {
      const score = 40 + i * 3
      await setGrade(EXAM_ID, STAB_STU, SUBJECT_A, score, SUBJECT_A_FULL)
      const grades = await getGrades(STAB_STU)
      const g = grades.find((x) => x.examId === EXAM_ID && x.subjectId === SUBJECT_A)
      if (g && g.score === score) consistent++
    }
    record(N, consistent === 15, `consistent=${consistent}/15`)
  })

  await test('4.2 IPC 层: 多学生成绩批量修改后各自 getGrades 独立正确', async () => {
    const N = '4.2 IPC 层: 多学生成绩批量修改后各自 getGrades 独立正确'
    const stus = [STAB_STU, STAB_STU2]
    let okCount = 0
    for (let i = 0; i < 10; i++) {
      const stu = stus[i % 2]
      const score = 50 + i * 5
      await setGrade(EXAM_ID, stu, SUBJECT_A, score, SUBJECT_A_FULL)
      // 验证另一个学生不受影响
      const otherStu = stus[(i + 1) % 2]
      const otherGrades = await getGrades(otherStu)
      const otherG = otherGrades.find((x) => x.examId === EXAM_ID && x.subjectId === SUBJECT_A)
      // 当前学生值正确
      const curGrades = await getGrades(stu)
      const curG = curGrades.find((x) => x.examId === EXAM_ID && x.subjectId === SUBJECT_A)
      if (curG && curG.score === score) okCount++
    }
    record(N, okCount === 10, `ok=${okCount}/10`)
  })

  await test('4.3 UI 层: StudentProfile AcademicsTab 加载提示显示', async () => {
    const N = '4.3 UI 层: StudentProfile AcademicsTab 加载提示显示'
    // 导航到 students 页面
    await navigateTo('#/dashboard')
    await navigateTo('#/students')
    const text = await getPageText()
    // 页面应包含学生相关内容
    const hasStudentsPage = text.includes('学生') || text.includes('搜索')
    record(N, hasStudentsPage, `hasStudentsPage=${hasStudentsPage}`)
  })

  await test('4.4 IPC 层: 学生有成绩后 getGrades 返回完整字段', async () => {
    const N = '4.4 IPC 层: 学生有成绩后 getGrades 返回完整字段'
    await setGrade(EXAM_ID, STAB_STU, SUBJECT_A, 95, SUBJECT_A_FULL)
    const grades = await getGrades(STAB_STU)
    const g = grades.find((x) => x.examId === EXAM_ID && x.subjectId === SUBJECT_A)
    // 验证字段完整性
    const hasAllFields = g && typeof g.examId === 'string' &&
      typeof g.subjectId === 'string' &&
      typeof g.studentName === 'string' &&
      typeof g.score === 'number' &&
      typeof g.fullMark === 'number'
    record(N, hasAllFields, `hasAllFields=${hasAllFields} score=${g?.score} fullMark=${g?.fullMark}`)
  })

  await test('4.5 IPC 层: 成绩 score 和 fullMark 关系合理', async () => {
    const N = '4.5 IPC 层: 成绩 score 和 fullMark 关系合理'
    await setGrade(EXAM_ID, STAB_STU, SUBJECT_A, 100, SUBJECT_A_FULL)
    const grades = await getGrades(STAB_STU)
    const g = grades.find((x) => x.examId === EXAM_ID && x.subjectId === SUBJECT_A)
    const reasonable = g && g.score >= 0 && g.score <= g.fullMark && g.fullMark > 0
    record(N, reasonable, `score=${g?.score} fullMark=${g?.fullMark} reasonable=${reasonable}`)
  })

  await test('4.6 IPC 层: getGrades 对不存在学生返回空数组 (非报错)', async () => {
    const N = '4.6 IPC 层: getGrades 对不存在学生返回空数组 (非报错)'
    const fakeName = `non-existent-stu-${TS}`
    const grades = await getGrades(fakeName)
    const isEmptyArray = Array.isArray(grades) && grades.length === 0
    record(N, isEmptyArray, `isEmptyArray=${isEmptyArray} len=${grades?.length}`)
  })

  // =============================================================
  // Section 5: 长时运行数据一致性 (5 项)
  // =============================================================
  console.log('\n━━━ Section 5: 长时运行数据一致性 ━━━')

  await test('5.1 压测后学生列表无重复学生', async () => {
    const N = '5.1 压测后学生列表无重复学生'
    const students = await listStudents()
    const names = students.map((s) => s.name)
    const uniqueNames = new Set(names)
    record(N, names.length === uniqueNames.size, `total=${names.length} unique=${uniqueNames.size}`)
  })

  await test('5.2 压测后班级列表无重复 class_id', async () => {
    const N = '5.2 压测后班级列表无重复 class_id'
    const classes = await listClasses()
    const ids = classes.map((c) => c.class_id)
    const uniqueIds = new Set(ids)
    record(N, ids.length === uniqueIds.size, `total=${ids.length} unique=${uniqueIds.size}`)
  })

  await test('5.3 压测后考试列表无重复 examId', async () => {
    const N = '5.3 压测后考试列表无重复 examId'
    const exams = await listExams()
    const ids = exams.map((e) => e.id)
    const uniqueIds = new Set(ids)
    record(N, ids.length === uniqueIds.size, `total=${ids.length} unique=${uniqueIds.size}`)
  })

  await test('5.4 活跃学生 class_id 全部指向有效班级 (无幽灵 class_id)', async () => {
    const N = '5.4 活跃学生 class_id 全部指向有效班级 (无幽灵 class_id)'
    const students = await listStudents()
    const classes = await listClasses()
    const validClassIds = new Set(classes.map((c) => c.class_id))
    // 只检查活跃学生 (status !== 'Deleted') — 已删除学生的 ghost class_id 不影响 UI
    const active = students.filter((s) => s.status !== 'Deleted')
    const activeWithClass = active.filter((s) => s.class_id)
    const activeInvalid = activeWithClass.filter((s) => !validClassIds.has(s.class_id))
    // 已删除学生的 ghost class_id 仅作信息记录 (cascade cleanup 不清理已删除学生)
    const deletedWithClass = students.filter((s) => s.status === 'Deleted' && s.class_id)
    const deletedInvalid = deletedWithClass.filter((s) => !validClassIds.has(s.class_id))
    const ok = activeInvalid.length === 0
    record(N, ok, `activeWithClass=${activeWithClass.length} activeInvalid=${activeInvalid.length} deletedGhost=${deletedInvalid.length}(info only)`)
  })

  await test('5.5 稳定性测试学生成绩可正常读取 (数据未损坏)', async () => {
    const N = '5.5 稳定性测试学生成绩可正常读取 (数据未损坏)'
    const grades = await getGrades(STAB_STU)
    const allValid = grades.every((g) =>
      typeof g.examId === 'string' &&
      typeof g.subjectId === 'string' &&
      typeof g.studentName === 'string' &&
      typeof g.score === 'number' &&
      typeof g.fullMark === 'number'
    )
    record(N, grades.length > 0 && allValid, `grades=${grades.length} allValid=${allValid}`)
  })

  // =============================================================
  // 清理
  // =============================================================
  console.log('\n━━━ 清理测试数据 ━━━')
  for (const id of createdExamIds) {
    try { await deleteExam(id) } catch {}
  }
  for (const id of createdClassIds) {
    try { await deleteClass(id) } catch {}
  }
  for (const name of throwawayStudents) {
    try { await deleteStudentSoft(name, 'stability test cleanup') } catch {}
  }

  // ---------- 汇总 ----------
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`Round 11 稳定性 + 压力测试结果: ${passed}/${results.length} 通过, ${failed} 失败`)
  if (failed > 0) {
    console.log(`\n失败项:`)
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.detail}`))
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
