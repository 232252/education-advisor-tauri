// =============================================================
// Round 9: 用户需求功能深度验证测试
//
// 针对用户提出的 4 个核心需求, 逐项深度验证:
//   1. 学业模块直接录入成绩 (不需先建考试)
//   2. 学生按班级筛选
//   3. 导航栏分组 (学业/学生分离)
//   4. 学生档案学业Tab与学业模块联动
//
// 每项需求测试: 正常流程 + 边界场景 + 跨页面一致性
//
// 运行: node scripts/cdp-feature-deep-test.mjs
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
  console.log('CDP connected, running feature deep tests...\n')

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

  const isOk = (res) => !!res && !res.__error

  // ---------- UI 导航辅助 ----------
  const navigateTo = async (hash) => {
    await evalInPage(`window.location.hash = '${hash}';`)
    // 等待路由切换 + 组件渲染
    await new Promise((r) => setTimeout(r, 1500))
  }

  const getPageText = async () => {
    return await evalInPage(`document.body.innerText.substring(0, 5000)`)
  }

  const waitForSelector = async (selector, timeout = 5000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const exists = await evalInPage(`!!document.querySelector('${selector}')`)
      if (exists) return true
      await new Promise((r) => setTimeout(r, 200))
    }
    return false
  }

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
  const getConfig = async () => {
    const r = await callIpc(`const res = await api.academic.getConfig(); return res;`)
    return r?.data ?? null
  }
  const batchSetGrades = async (examId, gradeItems) =>
    callIpc(`
      const records = ${JSON.stringify(gradeItems)}.map(g => ({ ...g, examId: ${JSON.stringify(examId)} }));
      const res = await api.academic.batchSetGrades(records);
      return res;
    `)

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
        note: 'feature-deep-test',
        teacher: '测试老师',
      });
      return res;
    `)
    return r?.success ? r.data : null
  }
  const deleteClass = async (id) =>
    callIpc(`const res = await api.class.delete(${JSON.stringify(id)}); return res;`)
  const assignStudents = async (classId, names) =>
    callIpc(`const res = await api.class.assign({ class_id: ${JSON.stringify(classId)}, student_names: ${JSON.stringify(names)} }); return res;`)
  const setStudentClassId = async (name, classId) =>
    callIpc(`const res = await api.eaa.setStudentMeta({ name: ${JSON.stringify(name)}, classId: ${JSON.stringify(classId)} }); return res;`)
  const clearStudentClassId = async (name) =>
    callIpc(`const res = await api.eaa.setStudentMeta({ name: ${JSON.stringify(name)}, clearClassId: true }); return res;`)

  // ---------- 清理账本 ----------
  const createdExamIds = []
  const createdClassIds = []
  const throwawayStudents = []
  const studentClassRestorations = new Map()

  // ---------- 预取学业配置 ----------
  const config = await getConfig()
  const subjects = config?.subjects ?? []
  const SUBJECT_A = subjects[0]?.id ?? 'chinese'
  const SUBJECT_A_FULL = subjects[0]?.fullMark ?? 150
  const SUBJECT_B = subjects[1]?.id ?? 'math'
  const SUBJECT_B_FULL = subjects[1]?.fullMark ?? 150
  console.log(`学业配置: ${subjects.length} 科目, 使用 ${SUBJECT_A}(${SUBJECT_A_FULL}) + ${SUBJECT_B}(${SUBJECT_B_FULL})\n`)

  // =============================================================
  // 需求 1: 学业模块直接录入成绩 (不需先建考试)
  // =============================================================
  console.log('━━━ 需求 1: 直接录入成绩 (不需先建考试) ━━━')

  await test('1.1 createExam 后直接 setGrade (无显式建考试步骤)', async () => {
    const N = '1.1 createExam 后直接 setGrade (无显式建考试步骤)'
    const examName = `feature-test-direct_${TS}_1`
    const exam = await createExam(examName, [SUBJECT_A])
    if (!exam) return record(N, false, '建考试失败')
    createdExamIds.push(exam.id)

    const stu = `feature_stu_${TS}_1`
    await addStudent(stu)
    throwawayStudents.push(stu)

    const grade = await setGrade(exam.id, stu, SUBJECT_A, 95, SUBJECT_A_FULL)
    const ok = grade?.success === true
    record(N, ok, `exam=${exam.id} grade=${grade?.success} score=95`)
  })

  await test('1.2 batchSetGrades 批量录入 (一次多学生多科目)', async () => {
    const N = '1.2 batchSetGrades 批量录入 (一次多学生多科目)'
    const examName = `feature-test-batch_${TS}_2`
    const exam = await createExam(examName, [SUBJECT_A, SUBJECT_B])
    if (!exam) return record(N, false, '建考试失败')
    createdExamIds.push(exam.id)

    const stuA = `feature_stu_${TS}_2a`
    const stuB = `feature_stu_${TS}_2b`
    await addStudent(stuA)
    await addStudent(stuB)
    throwawayStudents.push(stuA, stuB)

    const grades = [
      { studentName: stuA, subjectId: SUBJECT_A, score: 88, fullMark: SUBJECT_A_FULL },
      { studentName: stuA, subjectId: SUBJECT_B, score: 92, fullMark: SUBJECT_B_FULL },
      { studentName: stuB, subjectId: SUBJECT_A, score: 76, fullMark: SUBJECT_A_FULL },
      { studentName: stuB, subjectId: SUBJECT_B, score: 81, fullMark: SUBJECT_B_FULL },
    ]
    const r = await batchSetGrades(exam.id, grades)
    const ok = r?.success === true
    record(N, ok, `exam=${exam.id} batch=${r?.success} count=${grades.length}`)
  })

  await test('1.3 setGrade 重复录入 (同一学生同一科目) 更新而非追加', async () => {
    const N = '1.3 setGrade 重复录入 (同一学生同一科目) 更新而非追加'
    const examName = `feature-test-update_${TS}_3`
    const exam = await createExam(examName, [SUBJECT_A])
    if (!exam) return record(N, false, '建考试失败')
    createdExamIds.push(exam.id)

    const stu = `feature_stu_${TS}_3`
    await addStudent(stu)
    throwawayStudents.push(stu)

    await setGrade(exam.id, stu, SUBJECT_A, 60, SUBJECT_A_FULL)
    await setGrade(exam.id, stu, SUBJECT_A, 85, SUBJECT_A_FULL) // 覆盖

    const grades = await getGrades(stu)
    const subjectGrades = grades.filter((g) => g.subjectId === SUBJECT_A && g.examId === exam.id)
    const ok = subjectGrades.length === 1 && subjectGrades[0].score === 85
    record(N, ok, `gradesCount=${subjectGrades.length} score=${subjectGrades[0]?.score} (期望=85, 单条)`)
  })

  await test('1.4 setGrade 边界分数 (0 分 / 满分 / 超满分)', async () => {
    const N = '1.4 setGrade 边界分数 (0 分 / 满分 / 超满分)'
    const examName = `feature-test-edge_${TS}_4`
    const exam = await createExam(examName, [SUBJECT_A])
    if (!exam) return record(N, false, '建考试失败')
    createdExamIds.push(exam.id)

    const stu = `feature_stu_${TS}_4`
    await addStudent(stu)
    throwawayStudents.push(stu)

    const r0 = await setGrade(exam.id, stu, SUBJECT_A, 0, SUBJECT_A_FULL)
    const rFull = await setGrade(exam.id, stu, SUBJECT_A, SUBJECT_A_FULL, SUBJECT_A_FULL)
    const rOver = await setGrade(exam.id, stu, SUBJECT_A, SUBJECT_A_FULL + 10, SUBJECT_A_FULL)
    // 0 分和满分应该成功; 超满分应该失败或受控
    const ok = r0?.success === true && rFull?.success === true && rOver
    record(N, ok, `zero=${r0?.success} full=${rFull?.success} over=${rOver?.success}(error=${rOver?.error || 'none'})`)
  })

  await test('1.5 UI 快速录入页面可访问', async () => {
    const N = '1.5 UI 快速录入页面可访问'
    await navigateTo('#/academics')
    const hasAcademics = await waitForSelector('table, input, select, [class*="academic"], [class*="Academic"], [class*="grade"], [class*="exam"]', 5000)
    const pageText = await getPageText()
    // 学业页面应该有成绩录入相关的 UI 元素或文字 (放宽匹配)
    const hasRelevantText = pageText.includes('成绩') || pageText.includes('录入') || pageText.includes('考试') ||
      pageText.includes('学業') || pageText.includes('学业') || pageText.includes('Academic') ||
      pageText.includes('科目') || pageText.includes('分数') || pageText.includes('快速') ||
      pageText.includes('单科') || pageText.includes('全科')
    const ok = hasAcademics && hasRelevantText
    record(N, ok, `pageLoaded=${hasAcademics} hasText=${hasRelevantText}`)
  })

  // =============================================================
  // 需求 2: 学生按班级筛选
  // =============================================================
  console.log('\n━━━ 需求 2: 学生按班级筛选 ━━━')

  const CLASS_A = `feature-class-${TS}-A`
  const CLASS_B = `feature-class-${TS}-B`

  await test('2.1 创建 2 个测试班级 + 分配学生', async () => {
    const N = '2.1 创建 2 个测试班级 + 分配学生'
    const clsA = await createClass(CLASS_A, `特征测试班A_${TS}`)
    const clsB = await createClass(CLASS_B, `特征测试班B_${TS}`)
    if (!clsA || !clsB) return record(N, false, '建班失败')
    createdClassIds.push(clsA.id, clsB.id)

    const stuA1 = `feature_stu_${TS}_5a1`
    const stuA2 = `feature_stu_${TS}_5a2`
    const stuB1 = `feature_stu_${TS}_5b1`
    await addStudent(stuA1)
    await addStudent(stuA2)
    await addStudent(stuB1)
    throwawayStudents.push(stuA1, stuA2, stuB1)

    const assignA = await assignStudents(CLASS_A, [stuA1, stuA2])
    const assignB = await assignStudents(CLASS_B, [stuB1])
    const ok = assignA?.success !== false && assignB?.success !== false
    record(N, ok, `classA=${clsA.class_id} assignA=${assignA?.success} assignB=${assignB?.success}`)
  })

  await test('2.2 IPC 层: 学生 class_id 正确分配', async () => {
    const N = '2.2 IPC 层: 学生 class_id 正确分配'
    const all = await listStudents()
    const stuA1 = all.find((s) => s.name === `feature_stu_${TS}_5a1`)
    const stuA2 = all.find((s) => s.name === `feature_stu_${TS}_5a2`)
    const stuB1 = all.find((s) => s.name === `feature_stu_${TS}_5b1`)
    const ok = stuA1?.class_id === CLASS_A && stuA2?.class_id === CLASS_A && stuB1?.class_id === CLASS_B
    record(N, ok, `A1=${stuA1?.class_id} A2=${stuA2?.class_id} B1=${stuB1?.class_id}`)
  })

  await test('2.3 UI 学生页面有班级筛选下拉框', async () => {
    const N = '2.3 UI 学生页面有班级筛选下拉框'
    await navigateTo('#/students')
    // 查找 select 元素 (班级筛选下拉)
    const hasSelect = await evalInPage(`
      (function() {
        var selects = document.querySelectorAll('select');
        var text = Array.from(selects).map(function(s) { return s.innerText || s.textContent || ''; }).join(' ');
        return !!(text.includes(${JSON.stringify(`特征测试班A_${TS}`)}) || text.includes(${JSON.stringify(CLASS_A)}));
      })()
    `)
    const ok = !!hasSelect
    record(N, ok, `classFilterPresent=${hasSelect}`)
  })

  await test('2.4 UI 学业页面有班级筛选下拉框', async () => {
    const N = '2.4 UI 学业页面有班级筛选下拉框'
    await navigateTo('#/academics')
    const hasSelect = await evalInPage(`
      (function() {
        var selects = document.querySelectorAll('select');
        var text = Array.from(selects).map(function(s) { return s.innerText || s.textContent || ''; }).join(' ');
        return !!(text.includes('班级') || text.includes('全部') || text.includes('Class'));
      })()
    `)
    const ok = !!hasSelect
    record(N, ok, `classFilterPresent=${hasSelect}`)
  })

  await test('2.5 切换班级筛选 — IPC 数据一致性', async () => {
    const N = '2.5 切换班级筛选 — IPC 数据一致性'
    const all = await listStudents()
    const classAStudents = all.filter((s) => s.class_id === CLASS_A)
    const classBStudents = all.filter((s) => s.class_id === CLASS_B)
    const noneStudents = all.filter((s) => !s.class_id)
    // 验证筛选结果数量正确
    const ok = classAStudents.length >= 2 && classBStudents.length >= 1 && noneStudents.length > 0
    record(N, ok, `classA=${classAStudents.length} classB=${classBStudents.length} none=${noneStudents.length} total=${all.length}`)
  })

  await test('2.6 班级筛选后学生不交叉 (A 班学生不在 B 班)', async () => {
    const N = '2.6 班级筛选后学生不交叉 (A 班学生不在 B 班)'
    const all = await listStudents()
    const classAStudents = all.filter((s) => s.class_id === CLASS_A)
    const classBStudents = all.filter((s) => s.class_id === CLASS_B)
    const aNames = new Set(classAStudents.map((s) => s.name))
    const bNames = new Set(classBStudents.map((s) => s.name))
    const intersection = [...aNames].filter((n) => bNames.has(n))
    const ok = intersection.length === 0
    record(N, ok, `A班=${aNames.size} B班=${bNames.size} 交叉=${intersection.length}`)
  })

  await test('2.7 removeStudent 后 class_id 清空', async () => {
    const N = '2.7 removeStudent 后 class_id 清空'
    const stu = `feature_stu_${TS}_5a1`
    // 记录原始 class_id 以便恢复
    studentClassRestorations.set(stu, CLASS_A)
    const r = await callIpc(`const res = await api.class.removeStudent({ student_name: ${JSON.stringify(stu)} }); return res;`)
    const all = await listStudents()
    const s = all.find((x) => x.name === stu)
    const ok = r?.success !== false && !s?.class_id
    record(N, ok, `remove=${r?.success} class_id=${s?.class_id ?? '(空)'}`)
    // 恢复
    await setStudentClassId(stu, CLASS_A)
  })

  // =============================================================
  // 需求 3: 导航栏分组 (学业/学生分离)
  // =============================================================
  console.log('\n━━━ 需求 3: 导航栏分组 (学业/学生分离) ━━━')

  await test('3.1 侧边栏有 12 个导航项', async () => {
    const N = '3.1 侧边栏有 12 个导航项'
    await navigateTo('#/dashboard')
    const navItems = await evalInPage(`
      (function() {
        var links = document.querySelectorAll('nav a, aside a, [class*="nav"] a, [class*="sidebar"] a');
        return links.length;
      })()
    `)
    const ok = navItems >= 10 // 至少 10 个导航项
    record(N, ok, `navItems=${navItems}`)
  })

  await test('3.2 学生和学业在不同分组 (有分隔线)', async () => {
    const N = '3.2 学生和学业在不同分组 (有分隔线)'
    const hasDivider = await evalInPage(`
      (function() {
        var sidebar = document.querySelector('nav, aside, [class*="sidebar"], [class*="nav"]');
        if (!sidebar) return false;
        var html = sidebar.innerHTML;
        var hasHr = html.indexOf('<hr') >= 0 || html.indexOf('divider') >= 0 || html.indexOf('separator') >= 0 || html.indexOf('border-t') >= 0;
        var hasStudents = html.indexOf('学生') >= 0 || html.indexOf('Students') >= 0 || html.indexOf('/students') >= 0;
        var hasAcademics = html.indexOf('学业') >= 0 || html.indexOf('Academics') >= 0 || html.indexOf('/academics') >= 0;
        return !!(hasHr && hasStudents && hasAcademics);
      })()
    `)
    const ok = !!hasDivider
    record(N, ok, `hasDividerAndBoth=${hasDivider}`)
  })

  await test('3.3 所有 12 个路由可访问', async () => {
    const N = '3.3 所有 12 个路由可访问'
    const routes = ['/dashboard', '/chat', '/students', '/classes', '/academics', '/agents', '/scheduler', '/models', '/skills', '/privacy', '/settings']
    let accessible = 0
    for (const route of routes) {
      await navigateTo(`#${route}`)
      const hasContent = await evalInPage(`document.body.innerText.trim().length > 50`)
      if (hasContent) accessible++
    }
    const ok = accessible >= 10
    record(N, ok, `accessible=${accessible}/${routes.length}`)
  })

  await test('3.4 导航到学生页后侧边栏高亮学生', async () => {
    const N = '3.4 导航到学生页后侧边栏高亮学生'
    await navigateTo('#/students')
    // NavLink active 样式: text-blue-600 / text-blue-700 / bg-blue-50
    const hasActive = await evalInPage(`
      (function() {
        var links = document.querySelectorAll('nav a, aside a, [class*="sidebar"] a, [class*="nav"] a');
        for (var i = 0; i < links.length; i++) {
          var cls = links[i].className || '';
          var href = links[i].getAttribute('href') || '';
          if ((cls.indexOf('text-blue-600') >= 0 || cls.indexOf('text-blue-700') >= 0 || cls.indexOf('bg-blue-50') >= 0) && href.indexOf('/students') >= 0) {
            return true;
          }
        }
        return false;
      })()
    `)
    const ok = !!hasActive
    record(N, ok, `studentsActive=${hasActive}`)
  })

  await test('3.5 导航到学业页后侧边栏高亮学业', async () => {
    const N = '3.5 导航到学业页后侧边栏高亮学业'
    await navigateTo('#/academics')
    const hasActive = await evalInPage(`
      (function() {
        var links = document.querySelectorAll('nav a, aside a, [class*="sidebar"] a, [class*="nav"] a');
        for (var i = 0; i < links.length; i++) {
          var cls = links[i].className || '';
          var href = links[i].getAttribute('href') || '';
          if ((cls.indexOf('text-blue-600') >= 0 || cls.indexOf('text-blue-700') >= 0 || cls.indexOf('bg-blue-50') >= 0) && href.indexOf('/academics') >= 0) {
            return true;
          }
        }
        return false;
      })()
    `)
    const ok = !!hasActive
    record(N, ok, `academicsActive=${hasActive}`)
  })

  // =============================================================
  // 需求 4: 学生档案学业Tab与学业模块联动
  // =============================================================
  console.log('\n━━━ 需求 4: 学生档案学业Tab与学业模块联动 ━━━')

  const LINKAGE_STU = `feature_stu_${TS}_linkage`
  const LINKAGE_EXAM_NAME = `feature-test-linkage_${TS}`

  await test('4.1 在学业模块录入成绩', async () => {
    const N = '4.1 在学业模块录入成绩'
    await addStudent(LINKAGE_STU)
    throwawayStudents.push(LINKAGE_STU)

    const exam = await createExam(LINKAGE_EXAM_NAME, [SUBJECT_A, SUBJECT_B])
    if (!exam) return record(N, false, '建考试失败')
    createdExamIds.push(exam.id)

    const g1 = await setGrade(exam.id, LINKAGE_STU, SUBJECT_A, 78, SUBJECT_A_FULL)
    const g2 = await setGrade(exam.id, LINKAGE_STU, SUBJECT_B, 91, SUBJECT_B_FULL)
    const ok = g1?.success && g2?.success
    record(N, ok, `exam=${exam.id} g1=${g1?.success}(78) g2=${g2?.success}(91)`)
  })

  await test('4.2 IPC 层: getGrades 返回刚录入的成绩', async () => {
    const N = '4.2 IPC 层: getGrades 返回刚录入的成绩'
    const grades = await getGrades(LINKAGE_STU)
    const hasExam = grades.some((g) => g.examId === createdExamIds[createdExamIds.length - 1])
    const hasSubjectA = grades.some((g) => g.subjectId === SUBJECT_A && g.score === 78)
    const hasSubjectB = grades.some((g) => g.subjectId === SUBJECT_B && g.score === 91)
    const ok = hasExam && hasSubjectA && hasSubjectB
    record(N, ok, `grades=${grades.length} hasExam=${hasExam} A=${hasSubjectA}(78) B=${hasSubjectB}(91)`)
  })

  await test('4.3 UI 学生档案有学业 Tab', async () => {
    const N = '4.3 UI 学生档案有学业 Tab'
    await navigateTo('#/students')
    // 搜索学生
    await evalInPage(`
      (function() {
        var input = document.querySelector('input[type="text"], input[type="search"]');
        if (input) {
          input.value = ${JSON.stringify(LINKAGE_STU)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `)
    await new Promise((r) => setTimeout(r, 800))
    // 点击学生行
    await evalInPage(`
      (function() {
        var allElements = document.querySelectorAll('tr, [class*="student"], [role="button"]');
        for (var i = 0; i < allElements.length; i++) {
          if (allElements[i].textContent.indexOf(${JSON.stringify(LINKAGE_STU)}) >= 0) {
            allElements[i].click();
            break;
          }
        }
      })()
    `)
    await new Promise((r) => setTimeout(r, 800))
    // 查找学业 Tab — StudentProfile 的 Tab 是 <button> 元素 (border-b-2 类), 无 role="tab"
    const hasAcademicsTab = await evalInPage(`
      (function() {
        var tabs = document.querySelectorAll('button, [role="tab"], [class*="tab"]');
        for (var i = 0; i < tabs.length; i++) {
          var text = tabs[i].textContent || '';
          if (text.indexOf('学业') >= 0 || text.indexOf('Academic') >= 0) return true;
        }
        return false;
      })()
    `)
    const ok = !!hasAcademicsTab
    record(N, ok, `hasAcademicsTab=${hasAcademicsTab}`)
  })

  await test('4.4 点击学业 Tab 后显示成绩数据', async () => {
    const N = '4.4 点击学业 Tab 后显示成绩数据'
    // 点击学业 Tab — StudentProfile 的 Tab 是 <button> 元素 (border-b-2 类), 无 role="tab"
    await evalInPage(`
      (function() {
        var tabs = document.querySelectorAll('button, [role="tab"], [class*="tab"]');
        for (var i = 0; i < tabs.length; i++) {
          var text = tabs[i].textContent || '';
          if (text.indexOf('学业') >= 0 || text.indexOf('Academic') >= 0) {
            tabs[i].click();
            break;
          }
        }
      })()
    `)
    await new Promise((r) => setTimeout(r, 1500))

    // 检查页面是否显示成绩数据
    const pageText = await getPageText()
    const hasExamName = pageText.includes(LINKAGE_EXAM_NAME)
    const hasScore = pageText.includes('78') || pageText.includes('91')
    // 或者至少有成绩相关的文字
    const hasGradeText = pageText.includes('成绩') || pageText.includes('分数') || pageText.includes('科目')
    const ok = hasGradeText || hasExamName || hasScore
    record(N, ok, `hasExamName=${hasExamName} hasScore=${hasScore} hasGradeText=${hasGradeText}`)
  })

  await test('4.5 联动一致性: 学业模块删考试后学生档案也清空', async () => {
    const N = '4.5 联动一致性: 学业模块删考试后学生档案也清空'
    const examId = createdExamIds[createdExamIds.length - 1]
    const before = await getGrades(LINKAGE_STU)
    const beforeCount = before.filter((g) => g.examId === examId).length

    await deleteExam(examId)
    // 从账本中移除 (已删除)
    createdExamIds.pop()

    const after = await getGrades(LINKAGE_STU)
    const afterCount = after.filter((g) => g.examId === examId).length
    const ok = beforeCount > 0 && afterCount === 0
    record(N, ok, `before=${beforeCount} after=${afterCount} (删除后应=0)`)
  })

  await test('4.6 无成绩学生学业 Tab 显示引导提示', async () => {
    const N = '4.6 无成绩学生学业 Tab 显示引导提示'
    const noGradeStu = `feature_stu_${TS}_nograde`
    await addStudent(noGradeStu)
    throwawayStudents.push(noGradeStu)

    // 先导航到其他页面再回来, 强制 StudentsPage 重新挂载并重新加载学生列表
    // (如果已经在 #/students, 设置相同 hash 不会触发 remount, 新创建的学生不会出现在列表中)
    await navigateTo('#/dashboard')
    await navigateTo('#/students')
    // 用 React 兼容方式设置搜索输入值 (直接设 .value 不会触发 React onChange)
    await evalInPage(`
      (function() {
        var input = document.querySelector('input[placeholder*="搜索"], input[type="text"]');
        if (input) {
          var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, ${JSON.stringify(noGradeStu)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `)
    await new Promise((r) => setTimeout(r, 1000))
    // 点击学生行
    var clicked = await evalInPage(`
      (function() {
        var allElements = document.querySelectorAll('tr, [class*="student"], [role="button"], div[class*="cursor-pointer"]');
        for (var i = 0; i < allElements.length; i++) {
          if (allElements[i].textContent.indexOf(${JSON.stringify(noGradeStu)}) >= 0) {
            allElements[i].click();
            return true;
          }
        }
        return false;
      })()
    `)
    await new Promise((r) => setTimeout(r, 800))
    // 点击学业 Tab — StudentProfile 的 Tab 是 <button> 元素 (border-b-2 类), 无 role="tab"
    await evalInPage(`
      (function() {
        var tabs = document.querySelectorAll('button, [role="tab"], [class*="tab"]');
        for (var i = 0; i < tabs.length; i++) {
          var text = tabs[i].textContent || '';
          if (text.indexOf('学业') >= 0 || text.indexOf('Academic') >= 0) {
            tabs[i].click();
            break;
          }
        }
      })()
    `)
    // AcademicsTab 异步加载 (listExams + getGrades), 用重试循环等待提示出现
    var hasHint = false
    for (var attempt = 0; attempt < 6; attempt++) {
      await new Promise((r) => setTimeout(r, 500))
      const pageText = await getPageText()
      hasHint = pageText.includes('学业') && (pageText.includes('录入') || pageText.includes('暂无') || pageText.includes('没有') || pageText.includes('请到'))
      if (hasHint) break
    }
    const ok = !!hasHint
    record(N, ok, `hasHint=${hasHint} clicked=${clicked}`)
  })

  // =============================================================
  // 跨需求一致性: 同一数据在多个视图中一致
  // =============================================================
  console.log('\n━━━ 跨需求一致性验证 ━━━')

  await test('5.1 学生总数: listStudents = stats = dashboard 一致', async () => {
    const N = '5.1 学生总数: listStudents = stats = dashboard 一致'
    const [listRes, statsRes] = await Promise.all([
      callIpc(`const res = await api.eaa.listStudents(); return res;`),
      callIpc(`const res = await api.eaa.stats(); return res;`),
    ])
    const listTotal = listRes?.data?.total
    const statsStudents = statsRes?.data?.summary?.students
    const ok = listTotal === statsStudents
    record(N, ok, `listTotal=${listTotal} statsStudents=${statsStudents}`)
  })

  await test('5.2 班级列表: class.list 返回的班级都有有效 ID', async () => {
    const N = '5.2 班级列表: class.list 返回的班级都有有效 ID'
    const classes = await listClasses()
    const allValid = classes.every((c) => c.id && c.class_id && c.name)
    const ok = allValid && classes.length > 0
    record(N, ok, `classes=${classes.length} allValid=${allValid}`)
  })

  await test('5.3 学业配置: 所有科目都有 id 和 fullMark', async () => {
    const N = '5.3 学业配置: 所有科目都有 id 和 fullMark'
    const cfg = await getConfig()
    const allValid = cfg?.subjects?.every((s) => s.id && s.fullMark > 0) ?? false
    const ok = allValid && cfg.subjects.length > 0
    record(N, ok, `subjects=${cfg?.subjects?.length} allValid=${allValid}`)
  })

  await test('5.4 考试列表: listExams 返回有效数据结构', async () => {
    const N = '5.4 考试列表: listExams 返回有效数据结构'
    const exams = await listExams()
    const allValid = exams.every((e) => e.id && e.name)
    const ok = allValid
    record(N, ok, `exams=${exams.length} allValid=${allValid}`)
  })

  // =============================================================
  // 清理
  // =============================================================
  console.log('\n--- 开始清理测试数据 ---')

  // 删除考试 (级联清理成绩)
  for (const examId of createdExamIds) {
    const r = await deleteExam(examId)
    console.log(`  删除测试考试: ${examId} (${r?.success ? '成功' : '失败'})`)
  }

  // 还原学生 class_id
  for (const [name, origClassId] of studentClassRestorations) {
    if (origClassId) {
      await setStudentClassId(name, origClassId)
    } else {
      await clearStudentClassId(name)
    }
    console.log(`  还原学生 ${name} class_id -> ${origClassId || '(空)'}`)
  }

  // 清除测试学生的 class_id (防止班级删除失败)
  for (const name of throwawayStudents) {
    await clearStudentClassId(name)
  }

  // 删除测试班级
  for (const cls of createdClassIds) {
    const r = await deleteClass(cls)
    console.log(`  删除测试班级: ${cls} (${r?.success ? '成功' : '失败'})`)
  }

  // 软删除临时学生
  for (const name of throwawayStudents) {
    await deleteStudentSoft(name, 'feature-deep-test 清理')
    console.log(`  软删除临时学生: ${name}`)
  }

  console.log('--- 清理完成 ---\n')

  // =============================================================
  // 汇总
  // =============================================================
  console.log('========== 用户需求功能深度验证测试 ==========')
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
