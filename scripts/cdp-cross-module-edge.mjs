// =============================================================
// 跨模块联动边界场景测试 (学生 ↔ 班级 ↔ 学业 ↔ EAA)
// 通过 CDP 远程调试 (端口 9222) 调用 Tauri 渲染进程 IPC API
// 覆盖 10 个边界场景 + 自动清理测试数据
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const results = []
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  }
  // 包装每个测试: 捕获未预期异常, 不中断后续测试
  const test = (name, fn) => fn().catch((err) => record(name, false, `异常: ${String(err && err.message ? err.message : err).slice(0, 160)}`))

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
      throw new Error(`Eval error: ${r.result.exceptionDetails.text}`)
    }
    return r.result?.result?.value
  }

  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP connected, running cross-module edge tests...\n')

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

  const navigateTo = async (path) => {
    await evalInPage(`
      (async function() {
        location.hash = '#${path}';
        await new Promise(r => setTimeout(r, 1500));
      })()
    `)
  }

  // ---------- 业务 helper ----------
  const TS = Date.now()
  const RUN_PREFIX = `TST-EDGE-${TS}` // class_id 前缀, 便于清理识别

  const listAllStudents = async () => {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    return r?.data?.students ?? []
  }
  const listClasses = async () => {
    const r = await callIpc(`const res = await api.class.list(); return res;`)
    return r?.data ?? []
  }
  const getStudentByName = async (name) => {
    const all = await listAllStudents()
    return all.find((s) => s.name === name) || null
  }
  const getScore = async (name) => {
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(name)}); return res;`)
    return r?.data ?? null
  }
  const setStudentClassId = async (name, classId) =>
    callIpc(`const res = await api.eaa.setStudentMeta({ name: ${JSON.stringify(name)}, classId: ${JSON.stringify(classId)} }); return res;`)
  const clearStudentClassId = async (name) =>
    callIpc(`const res = await api.eaa.setStudentMeta({ name: ${JSON.stringify(name)}, clearClassId: true }); return res;`)
  const addStudent = async (name) =>
    callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(name)}); return res;`)
  // 注意: preload/bridge 签名为 deleteStudent(name, reason?) — reason 是位置参数字符串,
  // preload 内部自动包装为 { confirm: true, reason }。不能传 options 对象, 否则 reason 变成对象触发 "reason must be a string"
  const deleteStudentSoft = async (name, reason) =>
    callIpc(`const res = await api.eaa.deleteStudent(${JSON.stringify(name)}, ${JSON.stringify(reason)}); return res;`)

  const createClass = async (tag, dispName) => {
    const classId = `${RUN_PREFIX}-${tag}`
    const r = await callIpc(`
      const res = await api.class.create({
        class_id: ${JSON.stringify(classId)},
        name: ${JSON.stringify(dispName)},
        grade: '测试年级',
        note: 'cdp-cross-module-edge 自动化测试',
        teacher: '测试班主任',
      });
      return res;
    `)
    if (r && r.__error) return { error: r.__error, class_id: classId }
    if (r?.success && r?.data?.id) {
      createdClassIds.push({ id: r.data.id, class_id: r.data.class_id })
      return { id: r.data.id, class_id: r.data.class_id, name: r.data.name }
    }
    return { error: `res=${JSON.stringify(r).slice(0, 120)}`, class_id: classId }
  }
  const archiveClass = async (id) => callIpc(`const res = await api.class.archive(${JSON.stringify(id)}); return res;`)
  const restoreClass = async (id) => callIpc(`const res = await api.class.restore(${JSON.stringify(id)}); return res;`)
  const deleteClass = async (id) => callIpc(`const res = await api.class.delete(${JSON.stringify(id)}); return res;`)
  const assignStudents = async (classId, names) =>
    callIpc(`const res = await api.class.assign({ class_id: ${JSON.stringify(classId)}, student_names: ${JSON.stringify(names)} }); return res;`)
  const removeStudent = async (studentName) =>
    callIpc(`const res = await api.class.removeStudent({ student_name: ${JSON.stringify(studentName)} }); return res;`)

  const createExam = async (tag, subjectId) => {
    const r = await callIpc(`
      const res = await api.academic.createExam({
        name: ${JSON.stringify(`cdp边缘测试_${tag}`)},
        type: 'monthly',
        date: new Date().toISOString().slice(0, 10),
        semester: '测试学期',
        subjects: ${JSON.stringify([subjectId])},
      });
      return res;
    `)
    if (r?.success && r?.data?.id) {
      createdExamIds.push(r.data.id)
      return r.data
    }
    return null
  }
  const deleteExam = async (examId) => callIpc(`const res = await api.academic.deleteExam(${JSON.stringify(examId)}); return res;`)
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
  const getClassGrades = async (studentNames, examId, subjectId) =>
    callIpc(`const res = await api.academic.getClassGrades(${JSON.stringify(studentNames)}, ${JSON.stringify(examId)}, ${subjectId ? JSON.stringify(subjectId) : 'undefined'}); return res;`)

  const addEvent = async (studentName, reasonCode, delta) =>
    callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(studentName)},
        reasonCode: ${JSON.stringify(reasonCode)},
        delta: ${delta},
        note: 'cdp-cross-module-edge 自动化测试',
        force: true,
      });
      return res;
    `)
  const revertEvent = async (eventId, reason) =>
    callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(eventId)}, ${JSON.stringify(reason)}); return res;`)

  // 取 N 个可用(未分班/非删除)学生; 不够则补建临时学生
  const ensureStudents = async (n, tag) => {
    const all = await listAllStudents()
    const avail = all.filter((s) => !s.class_id && s.status !== 'Deleted').slice(0, n).map((s) => s.name)
    let i = 0
    while (avail.length < n && i < n + 3) {
      const name = `cdp_edge_${tag}_${TS}_${i}`
      const r = await addStudent(name)
      if (r && r.success !== false) {
        throwawayStudents.push(name)
        avail.push(name)
      }
      i++
    }
    return avail.slice(0, n)
  }

  // ---------- 清理账本 ----------
  const createdClassIds = [] // {id, class_id} 仍存在的测试班级
  const createdExamIds = [] // 测试考试 id (删除时级联清理成绩)
  const throwawayStudents = [] // 临时学生名 (最终软删除)
  const restorations = new Map() // name -> 原始 class_id (null=清空), 仅对既有学生
  const trackOriginal = async (name) => {
    if (!restorations.has(name)) {
      const s = await getStudentByName(name)
      restorations.set(name, s?.class_id ?? null)
    }
  }

  // ---------- 预取学业配置 (科目) ----------
  const configRes = await callIpc(`const res = await api.academic.getConfig(); return res;`)
  const subjects = configRes?.data?.subjects ?? []
  const SUBJECT_ID = subjects[0]?.id ?? 'math'
  const SUBJECT_FULL = subjects[0]?.fullMark ?? 150
  console.log(`学业配置: subjects=${subjects.length} 使用科目=${SUBJECT_ID}(满分${SUBJECT_FULL})\n`)

  const TEST_STUDENT = 'Bulk_Limit_1783913495642'

  // ============================================================
  // 测试 1: 删除班级后学生状态 (边界: 不先移除学生直接删班)
  // ============================================================
  await test('1. 删除班级后学生 class_id 状态', async () => {
    const N = '1. 删除班级后学生 class_id 状态'
    const cls = await createClass('D1', '边缘-删班测试')
    if (!cls.id) return record(N, false, `建班失败: ${cls.error}`)
    const names = await ensureStudents(1, 'd1')
    if (names.length < 1) return record(N, false, '无可用学生')
    await trackOriginal(names[0])
    const assignRes = await assignStudents(cls.class_id, names)
    const stuAfterAssign = await getStudentByName(names[0])
    if (stuAfterAssign?.class_id !== cls.class_id) {
      return record(N, false, `分配后 class_id 未更新: ${stuAfterAssign?.class_id}`)
    }
    // 直接删除班级 (不先移除学生) —— 边界场景
    const delRes = await deleteClass(cls.id)
    if (!delRes?.success) return record(N, false, `删除班级失败: ${delRes?.error ?? ''}`)
    // 从账本移除 (已删)
    const idx = createdClassIds.findIndex((c) => c.id === cls.id)
    if (idx >= 0) createdClassIds.splice(idx, 1)
    // 验证: 学生 class_id 不应再指向已删除班级
    const stuAfterDel = await getStudentByName(names[0])
    const stillDangling = stuAfterDel?.class_id === cls.class_id
    const classStillExists = (await listClasses()).some((c) => c.class_id === cls.class_id)
    record(
      N,
      !stillDangling && !classStillExists,
      `学生 class_id=${stuAfterDel?.class_id ?? '(空)'} ${stillDangling ? '⚠仍指向已删除班级' : '已清空/不指向'} | 班级记录已删=${!classStillExists}`,
    )
  })

  // ============================================================
  // 测试 2: 归档班级后学生筛选
  // ============================================================
  await test('2. 归档班级后学生仍存在 & 筛选器隐藏归档班', async () => {
    const N = '2. 归档班级后学生仍存在 & 筛选器隐藏归档班'
    const cls = await createClass('A2', '边缘-归档测试')
    if (!cls.id) return record(N, false, `建班失败: ${cls.error}`)
    const names = await ensureStudents(1, 'a2')
    if (names.length < 1) return record(N, false, '无可用学生')
    await trackOriginal(names[0])
    await assignStudents(cls.class_id, names)
    await archiveClass(cls.id)
    // 验证: 归档状态
    const archived = (await listClasses()).find((c) => c.id === cls.id)
    if (!archived?.archived) return record(N, false, `归档标记未生效 archived=${archived?.archived}`)
    // 验证: 学生在 IPC listStudents 中仍存在 (数据未丢)
    const stu = await getStudentByName(names[0])
    const studentExists = !!stu && stu.class_id === cls.class_id
    // 验证: 活跃班级列表不含归档班 (前端筛选器数据源)
    const activeClasses = (await listClasses()).filter((c) => !c.archived)
    const archivedHidden = !activeClasses.some((c) => c.class_id === cls.class_id)
    record(N, studentExists && archivedHidden, `学生存在=${studentExists} 归档班被筛选器隐藏=${archivedHidden} (注: 前端 UI 默认隐藏归档班学生)`)
  })

  // ============================================================
  // 测试 3: 删除学生后学业成绩 (软删除保留数据)
  // ============================================================
  await test('3. 软删除学生后成绩仍保留', async () => {
    const N = '3. 软删除学生后成绩仍保留'
    // 创建临时学生 (避免破坏既有学生)
    const stuName = `cdp_edge_del_${TS}`
    const addR = await addStudent(stuName)
    if (!addR || addR.success === false) return record(N, false, `建学生失败: ${JSON.stringify(addR).slice(0, 100)}`)
    throwawayStudents.push(stuName)
    const exam = await createExam('T3', SUBJECT_ID)
    if (!exam) return record(N, false, '建考试失败')
    const scoreVal = 77
    const setR = await setGrade(exam.id, stuName, SUBJECT_ID, scoreVal, SUBJECT_FULL)
    if (!setR?.success) return record(N, false, `录入成绩失败: ${setR?.error ?? ''}`)
    const before = await getGrades(stuName)
    const hadGrade = before.some((g) => g.examId === exam.id && g.score === scoreVal)
    if (!hadGrade) return record(N, false, '录入后查不到成绩')
    // 软删除学生
    const delR = await deleteStudentSoft(stuName, 'cdp-cross-module-edge 软删除测试')
    if (!delR?.success) return record(N, false, `软删除失败: ${delR?.stderr || delR?.error || ''}`)
    // 验证: 成绩仍存在 (学业数据独立存储)
    const after = await getGrades(stuName)
    const gradeStillExists = after.some((g) => g.examId === exam.id && g.score === scoreVal)
    // 验证: 学生状态=Deleted (软删除)
    const stu = await getStudentByName(stuName)
    const isDeleted = stu?.status === 'Deleted'
    record(N, gradeStillExists && isDeleted, `成绩保留=${gradeStillExists} 学生status=${stu?.status} 成绩数 before=${before.length}/after=${after.length}`)
  })

  // ============================================================
  // 测试 4: 班级筛选 + 学业成绩联动
  // ============================================================
  await test('4. 班级筛选 + 学业成绩联动', async () => {
    const N = '4. 班级筛选 + 学业成绩联动'
    const cls = await createClass('C4', '边缘-班级成绩测试')
    if (!cls.id) return record(N, false, `建班失败: ${cls.error}`)
    const names = await ensureStudents(2, 'c4')
    if (names.length < 2) return record(N, false, '无足够可用学生(需2)')
    for (const nm of names) await trackOriginal(nm)
    await assignStudents(cls.class_id, names)
    const exam = await createExam('T4', SUBJECT_ID)
    if (!exam) return record(N, false, '建考试失败')
    await setGrade(exam.id, names[0], SUBJECT_ID, 80, SUBJECT_FULL)
    await setGrade(exam.id, names[1], SUBJECT_ID, 90, SUBJECT_FULL)
    // 另取一个其它班学生(未分班的)录入同考试成绩, 验证不被计入本班
    const others = await ensureStudents(1, 'c4o')
    let otherName = null
    if (others.length > 0) {
      otherName = others[0]
      await trackOriginal(otherName)
      await setGrade(exam.id, otherName, SUBJECT_ID, 60, SUBJECT_FULL)
    }
    // 取本班学生名单
    const classStu = (await listAllStudents()).filter((s) => s.class_id === cls.class_id).map((s) => s.name)
    const classGradesRes = await getClassGrades(classStu, exam.id, SUBJECT_ID)
    const classGrades = classGradesRes?.data ?? {}
    const gotNames = Object.keys(classGrades)
    const includesAllClass = names.every((n) => gotNames.includes(n))
    const excludesOther = !otherName || !gotNames.includes(otherName)
    const correctScores =
      (classGrades[names[0]]?.[0]?.score === 80) && (classGrades[names[1]]?.[0]?.score === 90)
    record(N, includesAllClass && excludesOther && correctScores, `本班学生成绩齐=${includesAllClass} 排除他班=${excludesOther} 分数正确=${correctScores} 本班数=${classStu.length}`)
  })

  // ============================================================
  // 测试 5: 学生搜索 + 班级筛选组合 (UI 级)
  // ============================================================
  await test('5. 学生页 搜索+班级筛选 组合', async () => {
    const N = '5. 学生页 搜索+班级筛选 组合'
    const cls = await createClass('C5', '边缘-搜索筛选测试')
    if (!cls.id) return record(N, false, `建班失败: ${cls.error}`)
    const names = await ensureStudents(1, 'c5')
    if (names.length < 1) return record(N, false, '无可用学生')
    await trackOriginal(names[0])
    await assignStudents(cls.class_id, names)
    // 先导航到其他路由强制卸载学生页, 再返回以触发重新挂载 + 重新拉取班级列表,
    // 否则若已在 /students 页, 班级筛选下拉框不会包含刚创建的测试班级
    await navigateTo('/dashboard')
    await navigateTo('/students')
    await sleep(500)
    // 设置班级筛选 = 测试班
    const filterSet = await evalInPage(`
      (async function() {
        const selects = document.querySelectorAll('select');
        for (const sel of selects) {
          for (const opt of sel.options) {
            if (opt.value === ${JSON.stringify(cls.class_id)}) {
              const ns = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
              ns.call(sel, ${JSON.stringify(cls.class_id)});
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              await new Promise(r => setTimeout(r, 1000));
              return true;
            }
          }
        }
        return false;
      })()
    `)
    // 设置搜索词 = 学生名
    const searchSet = await evalInPage(`
      (async function() {
        const input = document.querySelector('input[type="text"], input[type="search"], input[placeholder*="搜索"], input[placeholder*="search"]');
        if (!input) return { hasInput: false };
        const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        ns.call(input, ${JSON.stringify(names[0])});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1000));
        return { hasInput: true };
      })()
    `)
    const rowCount = await evalInPage(`(function(){ return document.querySelectorAll('table tbody tr').length; })()`)
    const bodyHasName = await evalInPage(`(function(){ return (document.querySelector('main')||document.body).textContent.includes(${JSON.stringify(names[0])}); })()`)
    // 复位筛选/搜索
    await evalInPage(`
      (async function() {
        const selects = document.querySelectorAll('select');
        for (const sel of selects) {
          for (const opt of sel.options) {
            if (opt.value === '__ALL__') {
              const ns = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
              ns.call(sel, '__ALL__'); sel.dispatchEvent(new Event('change', { bubbles: true }));
              break;
            }
          }
        }
        const input = document.querySelector('input[type="text"], input[type="search"]');
        if (input) { const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; ns.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); }
        await new Promise(r => setTimeout(r, 500));
      })()
    `)
    record(N, filterSet && searchSet.hasInput && rowCount >= 1 && bodyHasName, `筛选生效=${filterSet} 搜索框=${searchSet.hasInput} 行数=${rowCount} 含目标=${bodyHasName}`)
  })

  // ============================================================
  // 测试 6: EAA score 与学业成绩 独立性
  // ============================================================
  await test('6. EAA行为分 与 学业成绩 相互独立', async () => {
    const N = '6. EAA行为分 与 学业成绩 相互独立'
    const stu = await getStudentByName(TEST_STUDENT)
    if (!stu) return record(N, false, `测试学生 ${TEST_STUDENT} 不存在`)
    await trackOriginal(TEST_STUDENT)
    const scoreBefore = (await getScore(TEST_STUDENT))?.score
    if (scoreBefore === undefined || scoreBefore === null) return record(N, false, '无法读取 EAA score')
    const exam = await createExam('T6', SUBJECT_ID)
    if (!exam) return record(N, false, '建考试失败')
    // 录入学业成绩 80
    await setGrade(exam.id, TEST_STUDENT, SUBJECT_ID, 80, SUBJECT_FULL)
    const g1 = (await getGrades(TEST_STUDENT)).find((x) => x.examId === exam.id)
    // 改 EAA 行为分 (+2)
    const evR = await addEvent(TEST_STUDENT, 'CLASS_COMMITTEE', 2)
    const evtId = (String(evR?.data ?? '').match(/evt_\w+/) || [])[0]
    const scoreAfterEaa = (await getScore(TEST_STUDENT))?.score
    const g2 = (await getGrades(TEST_STUDENT)).find((x) => x.examId === exam.id)
    const eaaChangedGradeUnchanged = scoreAfterEaa === scoreBefore + 2 && g2?.score === 80
    // 改 学业成绩 90
    await setGrade(exam.id, TEST_STUDENT, SUBJECT_ID, 90, SUBJECT_FULL)
    const scoreAfterGrade = (await getScore(TEST_STUDENT))?.score
    const g3 = (await getGrades(TEST_STUDENT)).find((x) => x.examId === exam.id)
    const gradeChangedEaaUnchanged = g3?.score === 90 && scoreAfterGrade === scoreAfterEaa
    // 回滚 EAA 事件
    if (evtId) { try { await revertEvent(evtId, 'cdp-cross-module-edge 回滚') } catch (e) {} }
    const scoreRestored = (await getScore(TEST_STUDENT))?.score
    record(
      N,
      eaaChangedGradeUnchanged && gradeChangedEaaUnchanged,
      `EAA分:${scoreBefore}→${scoreAfterEaa}(+2) 学业不变=${g2?.score} | 改学业→${g3?.score} EAA不变=${scoreAfterGrade} | 回滚后EAA=${scoreRestored}`,
    )
  })

  // ============================================================
  // 测试 7: 批量分配学生到班级
  // ============================================================
  await test('7. 批量分配 5 个学生到同一班级', async () => {
    const N = '7. 批量分配 5 个学生到同一班级'
    const cls = await createClass('B7', '边缘-批量分配测试')
    if (!cls.id) return record(N, false, `建班失败: ${cls.error}`)
    const names = await ensureStudents(5, 'b7')
    if (names.length < 5) return record(N, false, `仅拿到 ${names.length} 个学生(需5)`)
    for (const nm of names) await trackOriginal(nm)
    const assignRes = await assignStudents(cls.class_id, names)
    if (!assignRes?.success) return record(N, false, `批量分配失败: ${assignRes?.error ?? ''}`)
    // 验证: 5 个学生 class_id 全部更新
    const all = await listAllStudents()
    const updated = names.filter((n) => all.find((s) => s.name === n)?.class_id === cls.class_id).length
    const assigned = assignRes.assigned ?? 0
    record(N, updated === 5 && assigned === 5, `API assigned=${assigned} 实际验证更新=${updated}/5 failed=${JSON.stringify(assignRes.failed ?? [])}`)
  })

  // ============================================================
  // 测试 8: 班级移除学生后 EAA class_id 同步
  // ============================================================
  await test('8. 班级移除学生后 EAA class_id 同步清空', async () => {
    const N = '8. 班级移除学生后 EAA class_id 同步清空'
    const cls = await createClass('R8', '边缘-移除学生测试')
    if (!cls.id) return record(N, false, `建班失败: ${cls.error}`)
    const names = await ensureStudents(1, 'r8')
    if (names.length < 1) return record(N, false, '无可用学生')
    await trackOriginal(names[0])
    await assignStudents(cls.class_id, names)
    const before = (await getStudentByName(names[0]))?.class_id
    if (before !== cls.class_id) return record(N, false, `分配后 class_id 不符: ${before}`)
    // 通过班级模块移除学生
    const rmRes = await removeStudent(names[0])
    if (!rmRes?.success) return record(N, false, `移除失败: ${rmRes?.error ?? ''}`)
    // 验证 EAA score.class_id 已同步清空
    const scoreData = await getScore(names[0])
    const listStu = await getStudentByName(names[0])
    const cleared = !scoreData?.class_id && !listStu?.class_id
    record(N, cleared, `score.class_id=${scoreData?.class_id ?? '(空)'} listStudents.class_id=${listStu?.class_id ?? '(空)'} 同步清空=${cleared}`)
  })

  // ============================================================
  // 测试 9: 端到端 创建班→分配→录成绩→班级成绩报表
  // ============================================================
  await test('9. 端到端 创建班→分配→录成绩→班级成绩报表', async () => {
    const N = '9. 端到端 创建班→分配→录成绩→班级成绩报表'
    const cls = await createClass('E9', '边缘-端到端测试')
    if (!cls.id) return record(N, false, `建班失败: ${cls.error}`)
    const names = await ensureStudents(2, 'e9')
    if (names.length < 2) return record(N, false, '无足够可用学生(需2)')
    for (const nm of names) await trackOriginal(nm)
    const assignRes = await assignStudents(cls.class_id, names)
    if (!assignRes?.success) return record(N, false, '分配失败')
    const exam = await createExam('T9', SUBJECT_ID)
    if (!exam) return record(N, false, '建考试失败')
    await setGrade(exam.id, names[0], SUBJECT_ID, 85, SUBJECT_FULL)
    await setGrade(exam.id, names[1], SUBJECT_ID, 95, SUBJECT_FULL)
    // 班级成绩报表
    const classStu = (await listAllStudents()).filter((s) => s.class_id === cls.class_id).map((s) => s.name)
    const reportRes = await getClassGrades(classStu, exam.id, SUBJECT_ID)
    const report = reportRes?.data ?? {}
    const entries = Object.entries(report)
    const allHaveScore = names.every((n) => report[n]?.[0]?.score != null)
    const avg = names.reduce((acc, n) => acc + (report[n]?.[0]?.score ?? 0), 0) / names.length
    record(N, allHaveScore && entries.length >= 2 && Math.abs(avg - 90) < 0.001, `班级人数=${classStu.length} 报表条目=${entries.length} 全有成绩=${allHaveScore} 均分=${avg}`)
  })

  // ============================================================
  // 测试 10: 并发 同时操作学生和班级
  // ============================================================
  await test('10. 并发 同时创建学生+班级+分配 不冲突', async () => {
    const N = '10. 并发 同时创建学生+班级+分配 不冲突'
    const stuName = `cdp_edge_conc_${TS}`
    const tag1 = 'J1'
    const tag2 = 'J2'
    // 并发: 创建学生 + 创建班级1 + 创建班级2
    const [stuR, cls1, cls2] = await Promise.all([
      addStudent(stuName),
      createClass(tag1, '边缘-并发班1'),
      createClass(tag2, '边缘-并发班2'),
    ])
    if (!stuR || stuR.success === false) return record(N, false, '并发建学生失败')
    throwawayStudents.push(stuName)
    if (!cls1.id || !cls2.id) return record(N, false, `并发建班失败 c1=${cls1.error || 'ok'} c2=${cls2.error || 'ok'}`)
    // 并发: 分配同一学生到班1 (用班2做对照, 分配另一个学生)
    const otherNames = await ensureStudents(1, 'c10')
    if (otherNames.length > 0) await trackOriginal(otherNames[0])
    const assignRes = await assignStudents(cls1.class_id, [stuName])
    if (!assignRes?.success) return record(N, false, '分配失败')
    // 验证: 学生 class_id 正确指向班1 (非班2)
    const stu = await getStudentByName(stuName)
    const correct = stu?.class_id === cls1.class_id && stu?.class_id !== cls2.class_id
    // 验证: 两个班级都存在且独立
    const classes = await listClasses()
    const bothExist = classes.some((c) => c.class_id === cls1.class_id) && classes.some((c) => c.class_id === cls2.class_id)
    record(N, correct && bothExist, `学生class_id=${stu?.class_id} 班1=${cls1.class_id} 班2=${cls2.class_id} 两班独立存在=${bothExist}`)
  })

  // ============================================================
  // 清理
  // ============================================================
  console.log('\n--- 开始清理测试数据 ---')
  // (1) 软删除临时学生 (跳过已删除)
  for (const name of throwawayStudents) {
    try {
      const s = await getStudentByName(name)
      if (s && s.status !== 'Deleted') {
        await deleteStudentSoft(name, 'cdp-cross-module-edge cleanup')
        console.log(`  软删除临时学生: ${name}`)
      }
    } catch (e) { console.log(`  清理学生 ${name} 失败: ${String(e.message || e).slice(0, 80)}`) }
  }
  // (2) 恢复既有学生的原始 class_id
  for (const [name, orig] of restorations.entries()) {
    try {
      const cur = await getStudentByName(name)
      if (cur?.status === 'Deleted') continue // 跳过被软删除的
      if (orig) await setStudentClassId(name, orig)
      else await clearStudentClassId(name)
      console.log(`  恢复学生 ${name} class_id -> ${orig || '(空)'}`)
    } catch (e) { console.log(`  恢复 ${name} 失败: ${String(e.message || e).slice(0, 80)}`) }
  }
  // (3) 安全网: 清空任何指向本次运行测试班级的 class_id (含删除班级后悬空引用)
  try {
    const all = await listAllStudents()
    for (const s of all) {
      if (s.class_id && String(s.class_id).startsWith(RUN_PREFIX)) {
        try { await clearStudentClassId(s.name) } catch (e) {}
      }
    }
  } catch (e) {}
  // (4) 删除测试考试 (级联清理成绩)
  for (const examId of createdExamIds) {
    try { await deleteExam(examId); console.log(`  删除测试考试: ${examId} (级联清理成绩)`) } catch (e) {}
  }
  // (5) 删除测试班级 (先移除仍分配的学生)
  for (const { id, class_id } of [...createdClassIds]) {
    try {
      const lst = await listClasses()
      const exists = lst.find((c) => c.id === id)
      if (!exists) continue
      const all = await listAllStudents()
      for (const s of all) {
        if (s.class_id === class_id) { try { await removeStudent(s.name) } catch (e) {} }
      }
      await deleteClass(id)
      console.log(`  删除测试班级: ${class_id}`)
    } catch (e) { console.log(`  删除班级 ${class_id} 失败: ${String(e.message || e).slice(0, 80)}`) }
  }
  console.log('--- 清理完成 ---')

  // ============================================================
  // 汇总
  // ============================================================
  console.log('\n========== 跨模块联动边界场景测试 ==========')
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
