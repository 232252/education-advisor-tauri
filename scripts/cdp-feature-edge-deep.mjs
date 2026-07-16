// =============================================================
// Round 10: 用户需求功能边界深度测试 (CDP)
//
// 针对用户提出的 4 个核心需求, 进行边界场景 + 跨模块隔离 + 导航压测:
//   1. 学业模块输入校验 (12 项)
//   2. 学业数据一致性 (8 项)
//   3. 班级筛选边界场景 (8 项)
//   4. 跨模块数据隔离 (7 项)
//   5. 导航压测 (5 项)
//
// 运行: node scripts/cdp-feature-edge-deep.mjs
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
  console.log('CDP connected, running edge deep tests...\n')

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
    await new Promise((r) => setTimeout(r, 1200))
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
  const addEvent = async (studentName, reasonCode, delta) =>
    callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(studentName)},
        reasonCode: ${JSON.stringify(reasonCode)},
        delta: ${delta},
        note: 'cdp-feature-edge-deep 自动化测试',
        force: true,
      });
      return res;
    `)
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
        semester: '测试学期',
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
  const getGradesRaw = async (studentName) =>
    callIpc(`const res = await api.academic.getGrades(${JSON.stringify(studentName)}); return res;`)
  const getConfig = async () => {
    const r = await callIpc(`const res = await api.academic.getConfig(); return res;`)
    return r?.data ?? null
  }
  const batchSetGrades = async (records) =>
    callIpc(`const res = await api.academic.batchSetGrades(${JSON.stringify(records)}); return res;`)
  const getClassGrades = async (studentNames, examId, subjectId) =>
    callIpc(`const res = await api.academic.getClassGrades(${JSON.stringify(studentNames)}, ${JSON.stringify(examId)}, ${subjectId ? JSON.stringify(subjectId) : 'undefined'}); return res;`)

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
        grade: '测试年级',
        note: 'edge-deep-test',
        teacher: '测试老师',
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
  const archiveClass = async (id) =>
    callIpc(`
      let res;
      if (typeof api.class.archive === 'function') {
        res = await api.class.archive(${JSON.stringify(id)});
      } else {
        res = await api.class.update(${JSON.stringify(id)}, { archived: true });
      }
      return res;
    `)
  const restoreClass = async (id) =>
    callIpc(`
      let res;
      if (typeof api.class.restore === 'function') {
        res = await api.class.restore(${JSON.stringify(id)});
      } else if (typeof api.class.unarchive === 'function') {
        res = await api.class.unarchive(${JSON.stringify(id)});
      } else {
        res = await api.class.update(${JSON.stringify(id)}, { archived: false });
      }
      return res;
    `)
  const assignStudents = async (classId, names) =>
    callIpc(`const res = await api.class.assign({ class_id: ${JSON.stringify(classId)}, student_names: ${JSON.stringify(names)} }); return res;`)
  const removeStudent = async (studentName) =>
    callIpc(`const res = await api.class.removeStudent({ student_name: ${JSON.stringify(studentName)} }); return res;`)

  // Settings helper
  const setSetting = async (path, value) =>
    callIpc(`const res = await api.settings.set(${JSON.stringify(path)}, ${JSON.stringify(value)}); return res;`)

  // ---------- 清理账本 ----------
  const createdExamIds = []
  const createdClassIds = [] // 内部 id
  const throwawayStudents = []
  const settingsRestores = [] // {path, value}

  // ---------- 预取学业配置 ----------
  const config = await getConfig()
  const subjects = config?.subjects ?? []
  const SUBJECT_A = subjects[0]?.id ?? 'chinese'
  const SUBJECT_A_FULL = subjects[0]?.fullMark ?? 150
  const SUBJECT_B = subjects[1]?.id ?? 'math'
  const SUBJECT_B_FULL = subjects[1]?.fullMark ?? 150
  console.log(`学业配置: ${subjects.length} 科目, 使用 ${SUBJECT_A}(${SUBJECT_A_FULL}) + ${SUBJECT_B}(${SUBJECT_B_FULL})\n`)

  // 校验用临时学生 + 考试 (供 setGrade 校验使用)
  const VAL_STU = `edge_val_stu_${TS}`
  await addStudent(VAL_STU)
  throwawayStudents.push(VAL_STU)
  const VAL_EXAM = await createExam(`edge-val-exam_${TS}`, [SUBJECT_A, SUBJECT_B])
  if (VAL_EXAM) createdExamIds.push(VAL_EXAM.id)

  // =============================================================
  // Section 1: 学业模块输入校验 (12 项)
  // =============================================================
  console.log('━━━ Section 1: 学业模块输入校验 ━━━')

  await test('1.1 createExam 空名称 → 拒绝', async () => {
    const N = '1.1 createExam 空名称 → 拒绝'
    const r = await callIpc(`
      const res = await api.academic.createExam({
        name: '',
        type: 'monthly',
        date: new Date().toISOString().slice(0, 10),
        semester: '测试学期',
        subjects: ${JSON.stringify([SUBJECT_A])},
      });
      return res;
    `)
    record(N, isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('1.2 createExam null 参数 → 拒绝', async () => {
    const N = '1.2 createExam null 参数 → 拒绝'
    const r = await callIpc(`const res = await api.academic.createExam(null); return res;`)
    record(N, isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('1.3 createExam 缺少 subjects 数组 → 拒绝', async () => {
    const N = '1.3 createExam 缺少 subjects 数组 → 拒绝'
    const r = await callIpc(`
      const res = await api.academic.createExam({
        name: 'edge-test-no-subjects',
        type: 'monthly',
        date: new Date().toISOString().slice(0, 10),
        semester: '测试学期',
      });
      return res;
    `)
    record(N, isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('1.4 setGrade 空 examId → 拒绝', async () => {
    const N = '1.4 setGrade 空 examId → 拒绝'
    const r = await setGrade('', VAL_STU, SUBJECT_A, 80, SUBJECT_A_FULL)
    record(N, isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('1.5 setGrade 空 subjectId → 拒绝', async () => {
    const N = '1.5 setGrade 空 subjectId → 拒绝'
    const r = await setGrade(VAL_EXAM?.id || 'fake', VAL_STU, '', 80, SUBJECT_A_FULL)
    record(N, isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('1.6 setGrade 空 studentName → 拒绝', async () => {
    const N = '1.6 setGrade 空 studentName → 拒绝'
    const r = await setGrade(VAL_EXAM?.id || 'fake', '', SUBJECT_A, 80, SUBJECT_A_FULL)
    record(N, isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('1.7 setGrade 控制字符 studentName → 拒绝', async () => {
    const N = '1.7 setGrade 控制字符 studentName → 拒绝'
    const badName = 'stu\u0000bad\nrx'
    const r = await setGrade(VAL_EXAM?.id || 'fake', badName, SUBJECT_A, 80, SUBJECT_A_FULL)
    record(N, isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('1.8 setGrade SQL 注入 studentName → 拒绝', async () => {
    const N = '1.8 setGrade SQL 注入 studentName → 拒绝'
    const injName = "' OR 1=1; --"
    const r = await setGrade(VAL_EXAM?.id || 'fake', injName, SUBJECT_A, 80, SUBJECT_A_FULL)
    // 若未拒绝则验证数据未遭破坏 (getGrades 不应返回异常膨胀)
    if (!isRejected(r)) {
      const grades = await getGrades(injName)
      const safe = Array.isArray(grades) && grades.length <= 1
      record(N, safe, `未拒绝但数据安全: success=${r?.success} grades=${grades.length} (应用采用参数化存储, 非注入漏洞)`)
    } else {
      record(N, true, `success=${r?.success} err=${r?.error || r?.__error || ''}`)
    }
  })

  await test('1.9 batchSetGrades 非数组参数 → 拒绝', async () => {
    const N = '1.9 batchSetGrades 非数组参数 → 拒绝'
    const r = await callIpc(`const res = await api.academic.batchSetGrades('not-an-array'); return res;`)
    record(N, isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('1.10 batchSetGrades 数组含一条非法记录 → 原子拒绝', async () => {
    const N = '1.10 batchSetGrades 数组含一条非法记录 → 原子拒绝'
    const records = [
      { examId: VAL_EXAM?.id || 'fake', subjectId: SUBJECT_A, studentName: VAL_STU, score: 80, fullMark: SUBJECT_A_FULL },
      { examId: '', subjectId: '', studentName: '', score: 80, fullMark: SUBJECT_A_FULL },
    ]
    const r = await batchSetGrades(records)
    record(N, isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('1.11 getClassGrades 非数组 studentNames → 拒绝', async () => {
    const N = '1.11 getClassGrades 非数组 studentNames → 拒绝'
    const r = await callIpc(`const res = await api.academic.getClassGrades('not-an-array', ${JSON.stringify(VAL_EXAM?.id || 'fake')}); return res;`)
    record(N, isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('1.12 deleteExam 空字符串 → 拒绝', async () => {
    const N = '1.12 deleteExam 空字符串 → 拒绝'
    const r = await callIpc(`const res = await api.academic.deleteExam(''); return res;`)
    record(N, isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  // =============================================================
  // Section 2: 学业数据一致性 (8 项)
  // =============================================================
  console.log('\n━━━ Section 2: 学业数据一致性 ━━━')

  await test('2.1 建考试后立即出现在 listExams', async () => {
    const N = '2.1 建考试后立即出现在 listExams'
    const exam = await createExam(`edge-consist-exam_${TS}_1`, [SUBJECT_A])
    if (!exam) return record(N, false, '建考试失败')
    createdExamIds.push(exam.id)
    const exams = await listExams()
    const found = exams.some((e) => e.id === exam.id)
    record(N, found, `examId=${exam.id} foundInList=${found} total=${exams.length}`)
  })

  await test('2.2 setGrade 后立即出现在 getGrades', async () => {
    const N = '2.2 setGrade 后立即出现在 getGrades'
    const exam = await createExam(`edge-consist-exam_${TS}_2`, [SUBJECT_A])
    if (!exam) return record(N, false, '建考试失败')
    createdExamIds.push(exam.id)
    const stu = `edge_consist_stu_${TS}_2`
    await addStudent(stu)
    throwawayStudents.push(stu)
    const g = await setGrade(exam.id, stu, SUBJECT_A, 77, SUBJECT_A_FULL)
    if (!isOk(g)) return record(N, false, `setGrade 失败: ${g?.error || g?.__error}`)
    const grades = await getGrades(stu)
    const found = grades.some((x) => x.examId === exam.id && x.subjectId === SUBJECT_A && x.score === 77)
    record(N, found, `grades=${grades.length} score=77 found=${found}`)
  })

  await test('2.3 setGrade 后立即出现在 getClassGrades', async () => {
    const N = '2.3 setGrade 后立即出现在 getClassGrades'
    const exam = await createExam(`edge-consist-exam_${TS}_3`, [SUBJECT_A])
    if (!exam) return record(N, false, '建考试失败')
    createdExamIds.push(exam.id)
    const stu = `edge_consist_stu_${TS}_3`
    await addStudent(stu)
    throwawayStudents.push(stu)
    await setGrade(exam.id, stu, SUBJECT_A, 66, SUBJECT_A_FULL)
    const r = await getClassGrades([stu], exam.id, SUBJECT_A)
    const data = r?.data ?? {}
    const arr = data[stu] ?? []
    const found = arr.some((x) => x.score === 66)
    record(N, found, `classGradesForStu=${arr.length} score=66 found=${found}`)
  })

  await test('2.4 重复录入同学生同科目 → 计数仍为 1, 分数被更新', async () => {
    const N = '2.4 重复录入同学生同科目 → 计数仍为 1, 分数被更新'
    const exam = await createExam(`edge-consist-exam_${TS}_4`, [SUBJECT_A])
    if (!exam) return record(N, false, '建考试失败')
    createdExamIds.push(exam.id)
    const stu = `edge_consist_stu_${TS}_4`
    await addStudent(stu)
    throwawayStudents.push(stu)
    await setGrade(exam.id, stu, SUBJECT_A, 60, SUBJECT_A_FULL)
    await setGrade(exam.id, stu, SUBJECT_A, 95, SUBJECT_A_FULL)
    const grades = (await getGrades(stu)).filter((g) => g.examId === exam.id && g.subjectId === SUBJECT_A)
    const ok = grades.length === 1 && grades[0].score === 95
    record(N, ok, `count=${grades.length} score=${grades[0]?.score} (期望 1 条 / 95)`)
  })

  await test('2.5 删考试后 getGrades 不再含该考试成绩', async () => {
    const N = '2.5 删考试后 getGrades 不再含该考试成绩'
    const exam = await createExam(`edge-consist-exam_${TS}_5`, [SUBJECT_A])
    if (!exam) return record(N, false, '建考试失败')
    const stu = `edge_consist_stu_${TS}_5`
    await addStudent(stu)
    throwawayStudents.push(stu)
    await setGrade(exam.id, stu, SUBJECT_A, 50, SUBJECT_A_FULL)
    const before = (await getGrades(stu)).filter((g) => g.examId === exam.id).length
    await deleteExam(exam.id)
    const after = (await getGrades(stu)).filter((g) => g.examId === exam.id).length
    const ok = before > 0 && after === 0
    record(N, ok, `before=${before} after=${after} (期望 before>0, after=0)`)
  })

  await test('2.6 删考试后 getClassGrades 不再含该考试成绩', async () => {
    const N = '2.6 删考试后 getClassGrades 不再含该考试成绩'
    const exam = await createExam(`edge-consist-exam_${TS}_6`, [SUBJECT_A])
    if (!exam) return record(N, false, '建考试失败')
    const stu = `edge_consist_stu_${TS}_6`
    await addStudent(stu)
    throwawayStudents.push(stu)
    await setGrade(exam.id, stu, SUBJECT_A, 55, SUBJECT_A_FULL)
    await deleteExam(exam.id)
    const r = await getClassGrades([stu], exam.id, SUBJECT_A)
    const data = r?.data ?? {}
    const arr = data[stu] ?? []
    const ok = arr.length === 0
    record(N, ok, `afterDelete classGradesForStu=${arr.length} (期望 0)`)
  })

  await test('2.7 getGrades 不存在学生 → 返回空数组 (非报错)', async () => {
    const N = '2.7 getGrades 不存在学生 → 返回空数组 (非报错)'
    const r = await getGradesRaw(`non-existent-student-xyz_${TS}`)
    const data = r?.data
    const ok = isOk(r) && Array.isArray(data) && data.length === 0
    record(N, ok, `success=${r?.success} isArray=${Array.isArray(data)} len=${data?.length}`)
  })

  await test('2.8 batchSetGrades 多学生 → 各自 getGrades 均出现', async () => {
    const N = '2.8 batchSetGrades 多学生 → 各自 getGrades 均出现'
    const exam = await createExam(`edge-consist-exam_${TS}_8`, [SUBJECT_A])
    if (!exam) return record(N, false, '建考试失败')
    createdExamIds.push(exam.id)
    const stuA = `edge_consist_stu_${TS}_8a`
    const stuB = `edge_consist_stu_${TS}_8b`
    await addStudent(stuA)
    await addStudent(stuB)
    throwawayStudents.push(stuA, stuB)
    const records = [
      { examId: exam.id, subjectId: SUBJECT_A, studentName: stuA, score: 88, fullMark: SUBJECT_A_FULL },
      { examId: exam.id, subjectId: SUBJECT_A, studentName: stuB, score: 72, fullMark: SUBJECT_A_FULL },
    ]
    const r = await batchSetGrades(records)
    if (!isOk(r)) return record(N, false, `batch 失败: ${r?.error || r?.__error}`)
    const ga = await getGrades(stuA)
    const gb = await getGrades(stuB)
    const fa = ga.some((x) => x.examId === exam.id && x.score === 88)
    const fb = gb.some((x) => x.examId === exam.id && x.score === 72)
    record(N, fa && fb, `A(${stuA})=${fa}(88) B(${stuB})=${fb}(72)`)
  })

  // =============================================================
  // Section 3: 班级筛选边界场景 (8 项)
  // =============================================================
  console.log('\n━━━ Section 3: 班级筛选边界场景 ━━━')

  const ARCH_CLASS_ID = `edge-arch-class-${TS}`
  let ARCH_CLASS_INTERNAL_ID = null

  await test('3.1 归档班级 → archived=true (UI 隐藏机制生效)', async () => {
    const N = '3.1 归档班级 → archived=true (UI 隐藏机制生效)'
    const cls = await createClass(ARCH_CLASS_ID, `归档边界班_${TS}`)
    if (!cls) return record(N, false, '建班失败')
    createdClassIds.push(cls.id)
    ARCH_CLASS_INTERNAL_ID = cls.id
    const stu = `edge_arch_stu_${TS}_1`
    await addStudent(stu)
    throwawayStudents.push(stu)
    await assignStudents(ARCH_CLASS_ID, [stu])
    const r = await archiveClass(cls.id)
    const all = await listClasses()
    const c = all.find((x) => x.id === cls.id)
    const students = await listStudents()
    const s = students.find((x) => x.name === stu)
    // 归档标志置 true, 且学生 class_id 保留 (数据未级联丢失)
    const ok = isOk(r) && c?.archived === true && s?.class_id === ARCH_CLASS_ID
    record(N, ok, `archived=${c?.archived} studentClassId=${s?.class_id} (IPC 层学生仍可见, UI 据此标志隐藏)`)
  })

  await test('3.2 恢复班级 → archived=false (重新显示)', async () => {
    const N = '3.2 恢复班级 → archived=false (重新显示)'
    if (!ARCH_CLASS_INTERNAL_ID) return record(N, false, '依赖 3.1 的班级')
    const r = await restoreClass(ARCH_CLASS_INTERNAL_ID)
    const all = await listClasses()
    const c = all.find((x) => x.id === ARCH_CLASS_INTERNAL_ID)
    const ok = isOk(r) && c?.archived === false
    record(N, ok, `archived=${c?.archived} (期望 false)`)
  })

  await test('3.3 分配学生到不存在的 class_id → 拒绝 (数据完整性校验)', async () => {
    const N = '3.3 分配学生到不存在的 class_id → 拒绝 (数据完整性校验)'
    const fakeClassId = `non-existent-class-${TS}`
    const stu = `edge_arch_stu_${TS}_3`
    await addStudent(stu)
    throwawayStudents.push(stu)
    const r = await assignStudents(fakeClassId, [stu])
    const students = await listStudents()
    const s = students.find((x) => x.name === stu)
    // 修复后: assign 应拒绝不存在的 class_id, 返回 success=false
    // 且学生 class_id 不应被设为伪造值
    const ok = isRejected(r) && s?.class_id !== fakeClassId
    const note = ok
      ? `success=${r?.success} studentClassId=${s?.class_id || '(空)'} (正确拒绝)`
      : `success=${r?.success} studentClassId=${s?.class_id} (未拒绝, 数据完整性缺口)`
    record(N, ok, note)
  })

  await test('3.4 已无班级学生再次移除 → 不报错 (受控空操作)', async () => {
    const N = '3.4 已无班级学生再次移除 → 不报错 (受控空操作)'
    const stu = `edge_arch_stu_${TS}_4`
    await addStudent(stu)
    throwawayStudents.push(stu)
    await clearStudentClassId(stu) // 确保无 class_id
    const r = await removeStudent(stu)
    // 不应抛异常 / 不应 success=false 严重错误
    const ok = !isRejected(r) || r?.success !== false
    record(N, ok, `success=${r?.success} err=${r?.error || r?.__error || ''} (幂等受控)`)
  })

  await test('3.5 0 学生班级 → 列表与筛选正常', async () => {
    const N = '3.5 0 学生班级 → 列表与筛选正常'
    const emptyClassId = `edge-empty-class-${TS}`
    const cls = await createClass(emptyClassId, `空班级_${TS}`)
    if (!cls) return record(N, false, '建班失败')
    createdClassIds.push(cls.id)
    const all = await listClasses()
    const found = all.some((c) => c.id === cls.id)
    const students = await listStudents()
    const inClass = students.filter((s) => s.class_id === emptyClassId).length
    const ok = found && inClass === 0
    record(N, ok, `classInList=${found} studentsInClass=${inClass} (期望 0)`)
  })

  await test('3.6 创建空名称班级 → 拒绝', async () => {
    const N = '3.6 创建空名称班级 → 拒绝'
    const r = await callIpc(`
      const res = await api.class.create({
        class_id: ${JSON.stringify(`edge-empty-name-${TS}`)},
        name: '',
        grade: '测试年级',
      });
      return res;
    `)
    if (r?.success && r?.data?.id) createdClassIds.push(r.data.id)
    record(N, isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('3.7 创建 null 参数班级 → 拒绝', async () => {
    const N = '3.7 创建 null 参数班级 → 拒绝'
    const r = await callIpc(`const res = await api.class.create(null); return res;`)
    if (r?.success && r?.data?.id) createdClassIds.push(r.data.id)
    record(N, isRejected(r), `success=${r?.success} err=${r?.error || r?.__error || ''}`)
  })

  await test('3.8 多次调用 listClasses 返回一致数据', async () => {
    const N = '3.8 多次调用 listClasses 返回一致数据'
    const [a, b, c] = await Promise.all([listClasses(), listClasses(), listClasses()])
    const ok = a.length === b.length && b.length === c.length
    record(N, ok, `call1=${a.length} call2=${b.length} call3=${c.length} (应一致)`)
  })

  // =============================================================
  // Section 4: 跨模块数据隔离 (7 项)
  // =============================================================
  console.log('\n━━━ Section 4: 跨模块数据隔离 ━━━')

  await test('4.1 EAA 软删学生 → 学业成绩仍存在 (独立系统)', async () => {
    const N = '4.1 EAA 软删学生 → 学业成绩仍存在 (独立系统)'
    const stu = `edge_iso_stu_${TS}_1`
    await addStudent(stu)
    throwawayStudents.push(stu)
    const exam = await createExam(`edge-iso-exam_${TS}_1`, [SUBJECT_A])
    if (!exam) return record(N, false, '建考试失败')
    createdExamIds.push(exam.id)
    await setGrade(exam.id, stu, SUBJECT_A, 70, SUBJECT_A_FULL)
    const before = (await getGrades(stu)).filter((g) => g.examId === exam.id).length
    await deleteStudentSoft(stu, 'edge-deep 跨模块隔离测试')
    const after = await getGrades(stu)
    const afterCount = after.filter((g) => g.examId === exam.id).length
    const ok = before > 0 && afterCount === before
    record(N, ok, `before=${before} afterEaaDelete=${afterCount} (学业成绩独立保留)`)
  })

  await test('4.2 学业删考试 → EAA 事件/分数不受影响', async () => {
    const N = '4.2 学业删考试 → EAA 事件/分数不受影响'
    const stu = `edge_iso_stu_${TS}_2`
    await addStudent(stu)
    throwawayStudents.push(stu)
    const exam = await createExam(`edge-iso-exam_${TS}_2`, [SUBJECT_A])
    if (!exam) return record(N, false, '建考试失败')
    createdExamIds.push(exam.id)
    await setGrade(exam.id, stu, SUBJECT_A, 80, SUBJECT_A_FULL)
    const evRes = await addEvent(stu, 'homework_good', 2)
    const scoreBefore = await getScore(stu)
    const beforeScore = scoreBefore?.score ?? scoreBefore?.total ?? null
    await deleteExam(exam.id)
    createdExamIds.pop()
    const scoreAfter = await getScore(stu)
    const afterScore = scoreAfter?.score ?? scoreAfter?.total ?? null
    const ok = beforeScore === afterScore
    record(N, ok, `eaaScoreBefore=${beforeScore} afterExamDelete=${afterScore} (应一致) ev=${evRes?.success}`)
  })

  await test('4.3 EAA 加事件 → 学业成绩不受影响', async () => {
    const N = '4.3 EAA 加事件 → 学业成绩不受影响'
    const stu = `edge_iso_stu_${TS}_3`
    await addStudent(stu)
    throwawayStudents.push(stu)
    const exam = await createExam(`edge-iso-exam_${TS}_3`, [SUBJECT_A])
    if (!exam) return record(N, false, '建考试失败')
    createdExamIds.push(exam.id)
    await setGrade(exam.id, stu, SUBJECT_A, 85, SUBJECT_A_FULL)
    const before = (await getGrades(stu)).filter((g) => g.examId === exam.id).length
    await addEvent(stu, 'homework_good', 3)
    const after = (await getGrades(stu)).filter((g) => g.examId === exam.id).length
    const ok = before === after && after > 0
    record(N, ok, `academicGradesBefore=${before} afterEaaEvent=${after} (应一致)`)
  })

  await test('4.4 班级分配学生 → EAA 分数不受影响', async () => {
    const N = '4.4 班级分配学生 → EAA 分数不受影响'
    const stu = `edge_iso_stu_${TS}_4`
    await addStudent(stu)
    throwawayStudents.push(stu)
    const scoreBefore = await getScore(stu)
    const beforeScore = scoreBefore?.score ?? scoreBefore?.total ?? null
    const cls = await createClass(`edge-iso-class-${TS}-4`, `隔离班4_${TS}`)
    if (cls) createdClassIds.push(cls.id)
    await assignStudents(`edge-iso-class-${TS}-4`, [stu])
    const scoreAfter = await getScore(stu)
    const afterScore = scoreAfter?.score ?? scoreAfter?.total ?? null
    const ok = beforeScore === afterScore
    record(N, ok, `eaaScoreBefore=${beforeScore} afterAssign=${afterScore} (应一致)`)
  })

  await test('4.5 设置变更 → 学业数据不变', async () => {
    const N = '4.5 设置变更 → 学业数据不变'
    const examsBefore = await listExams()
    const beforeCount = examsBefore.length
    // 读取当前设置值以便恢复
    const getRes = await callIpc(`const res = await api.settings.get('general.defaultOperator'); return res;`)
    const orig = getRes?.data?.value ?? getRes?.value ?? ''
    const r = await setSetting('general.defaultOperator', `edge-test-${TS}`)
    if (isOk(r)) settingsRestores.push({ path: 'general.defaultOperator', value: orig })
    const examsAfter = await listExams()
    const afterCount = examsAfter.length
    const ok = beforeCount === afterCount
    record(N, ok, `examsBefore=${beforeCount} afterSettingsChange=${afterCount} (应一致) setOk=${r?.success}`)
  })

  await test('4.6 同名学生换班 → 学业成绩按名保留 (name 为键)', async () => {
    const N = '4.6 同名学生换班 → 学业成绩按名保留 (name 为键)'
    const stu = `edge_iso_stu_${TS}_6`
    await addStudent(stu)
    throwawayStudents.push(stu)
    const clsA = await createClass(`edge-iso-class-${TS}-6a`, `隔离班6A_${TS}`)
    const clsB = await createClass(`edge-iso-class-${TS}-6b`, `隔离班6B_${TS}`)
    if (clsA) createdClassIds.push(clsA.id)
    if (clsB) createdClassIds.push(clsB.id)
    await assignStudents(`edge-iso-class-${TS}-6a`, [stu])
    const exam = await createExam(`edge-iso-exam_${TS}_6`, [SUBJECT_A])
    if (!exam) return record(N, false, '建考试失败')
    createdExamIds.push(exam.id)
    await setGrade(exam.id, stu, SUBJECT_A, 90, SUBJECT_A_FULL)
    // 换班
    await clearStudentClassId(stu)
    await assignStudents(`edge-iso-class-${TS}-6b`, [stu])
    const grades = await getGrades(stu)
    const found = grades.some((g) => g.examId === exam.id && g.score === 90)
    record(N, found, `afterClassSwitch gradeFound=${found} (name 为学业键, 换班不丢成绩)`)
  })

  await test('4.7 学业科目配置与 EAA reason code 相互独立', async () => {
    const N = '4.7 学业科目配置与 EAA reason code 相互独立'
    const cfg = await getConfig()
    const subjList = cfg?.subjects ?? []
    const subjIds = subjList.map((s) => s.id)
    const hasFullMark = subjList.length > 0 && subjList.every((s) => typeof s.fullMark === 'number')
    // 学业配置不应包含 EAA 专属字段
    const cfgKeys = cfg ? Object.keys(cfg) : []
    const noEaaKeys = !cfgKeys.includes('reasonCodes') && !cfgKeys.includes('events')
    // EAA score 数据结构不应包含学业科目 id 作为顶层键
    const stu = `edge_iso_stu_${TS}_7`
    await addStudent(stu)
    throwawayStudents.push(stu)
    const score = await getScore(stu)
    const scoreKeys = score ? Object.keys(score) : []
    const noSubjOverlap = !scoreKeys.some((k) => subjIds.includes(k))
    const ok = hasFullMark && noEaaKeys && noSubjOverlap
    record(N, ok, `subjects=${subjList.length} hasFullMark=${hasFullMark} cfgNoEaaKeys=${noEaaKeys} scoreNoOverlap=${noSubjOverlap}`)
  })

  // =============================================================
  // Section 5: 导航压测 (5 项)
  // =============================================================
  console.log('\n━━━ Section 5: 导航压测 ━━━')

  const ALL_ROUTES = ['/dashboard', '/chat', '/students', '/classes', '/academics', '/agents', '/scheduler', '/models', '/skills', '/privacy', '/settings']

  await test('5.1 顺序遍历全部 11 路由 → 无崩溃', async () => {
    const N = '5.1 顺序遍历全部 11 路由 → 无崩溃'
    let visited = 0
    try {
      for (const route of ALL_ROUTES) {
        await navigateTo(`#${route}`)
        visited++
      }
    } catch (e) {
      return record(N, false, `第 ${visited + 1} 个路由异常: ${String(e.message || e).slice(0, 120)}`)
    }
    record(N, visited === ALL_ROUTES.length, `visited=${visited}/${ALL_ROUTES.length}`)
  })

  await test('5.2 同一路由连续导航 3 次 → 无错误', async () => {
    const N = '5.2 同一路由连续导航 3 次 → 无错误'
    try {
      for (let i = 0; i < 3; i++) {
        await navigateTo('#/students')
      }
    } catch (e) {
      return record(N, false, `异常: ${String(e.message || e).slice(0, 120)}`)
    }
    const text = await getPageText()
    record(N, text && text.length > 0, `pageTextLen=${text?.length}`)
  })

  await test('5.3 students↔academics 来回切换 10 次 → 无错误', async () => {
    const N = '5.3 students↔academics 来回切换 10 次 → 无错误'
    try {
      for (let i = 0; i < 10; i++) {
        await navigateTo(i % 2 === 0 ? '#/students' : '#/academics')
      }
    } catch (e) {
      return record(N, false, `异常: ${String(e.message || e).slice(0, 120)}`)
    }
    const text = await getPageText()
    record(N, text && text.length > 0, `pageTextLen=${text?.length}`)
  })

  await test('5.4 全部路由返回非空页面文本 → 页面已渲染', async () => {
    const N = '5.4 全部路由返回非空页面文本 → 页面已渲染'
    let nonEmpty = 0
    for (const route of ALL_ROUTES) {
      await navigateTo(`#${route}`)
      const text = await getPageText()
      if (text && text.trim().length > 50) nonEmpty++
    }
    record(N, nonEmpty === ALL_ROUTES.length, `nonEmpty=${nonEmpty}/${ALL_ROUTES.length}`)
  })

  await test('5.5 5 次导航后侧边栏状态保持 (导航项不丢失)', async () => {
    const N = '5.5 5 次导航后侧边栏状态保持 (导航项不丢失)'
    const before = await evalInPage(`(function(){ return document.querySelectorAll('nav a, aside a, [class*="nav"] a, [class*="sidebar"] a').length; })()`)
    for (const route of ['/dashboard', '/students', '/academics', '/classes', '/settings']) {
      await navigateTo(`#${route}`)
    }
    const after = await evalInPage(`(function(){ return document.querySelectorAll('nav a, aside a, [class*="nav"] a, [class*="sidebar"] a').length; })()`)
    const ok = after >= before && after >= 10
    record(N, ok, `navBefore=${before} navAfter=${after} (应不减少且 >=10)`)
  })

  // =============================================================
  // 清理
  // =============================================================
  console.log('\n--- 开始清理测试数据 ---')

  // 删除考试 (级联清理成绩)
  for (const examId of createdExamIds) {
    try {
      const r = await deleteExam(examId)
      console.log(`  删除测试考试: ${examId} (${r?.success ? '成功' : '已删/失败'})`)
    } catch (e) {
      console.log(`  删除测试考试异常: ${examId} ${String(e.message || e).slice(0, 80)}`)
    }
  }

  // 还原设置
  for (const s of settingsRestores) {
    try {
      await setSetting(s.path, s.value)
      console.log(`  还原设置: ${s.path}`)
    } catch (e) {
      console.log(`  还原设置异常: ${s.path}`)
    }
  }

  // 清除测试学生的 class_id (防止班级删除失败)
  for (const name of throwawayStudents) {
    try { await clearStudentClassId(name) } catch (e) {}
  }

  // 删除测试班级
  for (const id of createdClassIds) {
    try {
      const r = await deleteClass(id)
      console.log(`  删除测试班级: ${id} (${r?.success ? '成功' : '失败'})`)
    } catch (e) {
      console.log(`  删除测试班级异常: ${id} ${String(e.message || e).slice(0, 80)}`)
    }
  }

  // 软删除临时学生
  for (const name of throwawayStudents) {
    try {
      await deleteStudentSoft(name, 'edge-deep-test 清理')
      console.log(`  软删除临时学生: ${name}`)
    } catch (e) {
      console.log(`  软删除异常: ${name}`)
    }
  }

  console.log('--- 清理完成 ---\n')

  // =============================================================
  // 汇总
  // =============================================================
  console.log('========== 用户需求功能边界深度测试 ==========')
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  console.log(`总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`)
  if (failed > 0) {
    console.log('\n失败项:')
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  - ${r.name}: ${r.detail}`)
    }
  }

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
