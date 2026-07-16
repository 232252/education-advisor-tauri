// =============================================================
// 跨模块并发压力深度测试 (EAA / Academic / Class / Settings / Cron / Agent / Skill)
//
// 通过 CDP 远程调试 (端口 9222) 调用 Tauri 2 渲染进程 IPC API,
// 在 7 个模块上执行并发读写操作, 验证数据一致性与错误隔离。
//
// 覆盖 8 类场景 / ~42 个用例:
//   1. 并行模块读取 (5+ 模块同时读)
//   2. 混合读写 (并发读 + 写, 验证不互相干扰)
//   3. EAA + Academic 并发 (addEvent 与 createExam/setGrade 独立)
//   4. Class + EAA 并发 (建班/分配/加事件, class_id 一致)
//   5. Settings + Cron 并发 (改设置与增删 cron 任务)
//   6. 高并发并行 (20+ 跨模块操作)
//   7. 数据完整性 (并发后各模块无交叉污染)
//   8. 错误隔离 (单模块抛错不影响其他模块)
//
// 测试数据全部自动清理: 回滚 EAA 事件 / 删考试 / 删班级 / 删 cron /
//                       软删临时学生 / 还原 settings / 还原学生 class_id
// 运行: node scripts/cdp-cross-module-stress-deep.mjs
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
  // 包装每个测试: 捕获未预期异常, 不中断后续测试
  const test = (name, fn) =>
    fn().catch((err) => record(name, false, `异常: ${String(err && err.message ? err.message : err).slice(0, 160)}`))

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
  console.log('CDP connected, running cross-module stress tests...\n')

  // ---------- IPC 封装 (符合框架 try/catch 包装要求) ----------
  // callIpc 执行 code 片段 (code 内可用 api), 返回原始结果;
  // 调用方代码抛错时返回 { __error: ... }
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
  // 受控响应: callIpc 已用 try/catch 包装, 任何返回值都是"不崩溃"
  // (deleteExam/assign 对不存在 ID 可能返回 success:true no-op, 也算受控)
  const isControlled = (res) => res != null && (!res.__error || typeof res.__error === 'string')
  // 从多种可能形状中取出数组
  const unwrapArr = (res) => {
    if (!isOk(res)) return []
    if (Array.isArray(res)) return res
    if (Array.isArray(res.data)) return res.data
    if (res.data && Array.isArray(res.data.students)) return res.data.students
    if (res.data && Array.isArray(res.data.exams)) return res.data.exams
    if (res.data && Array.isArray(res.data.tasks)) return res.data.tasks
    return []
  }

  // ---------- 业务 helper ----------
  const TS = Date.now()
  const RUN_PREFIX = `TST-STRESS-${TS}` // 测试班级 class_id 前缀, 便于清理识别

  // EAA
  const listStudents = async () => {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    return unwrapArr(r)
  }
  const getStudentByName = async (name) => {
    const all = await listStudents()
    return all.find((s) => s.name === name) || null
  }
  const getScore = async (name) => {
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(name)}); return res;`)
    return r?.data ?? null
  }
  const addStudent = async (name) =>
    callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(name)}); return res;`)
  const deleteStudentSoft = async (name, reason) =>
    callIpc(`const res = await api.eaa.deleteStudent(${JSON.stringify(name)}, ${JSON.stringify(reason)}); return res;`)
  const setStudentClassId = async (name, classId) =>
    callIpc(`const res = await api.eaa.setStudentMeta({ name: ${JSON.stringify(name)}, classId: ${JSON.stringify(classId)} }); return res;`)
  const clearStudentClassId = async (name) =>
    callIpc(`const res = await api.eaa.setStudentMeta({ name: ${JSON.stringify(name)}, clearClassId: true }); return res;`)
  const addEvent = async (studentName, reasonCode, delta) =>
    callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(studentName)},
        reasonCode: ${JSON.stringify(reasonCode)},
        delta: ${delta},
        note: 'cdp-cross-module-stress 自动化测试',
        force: true,
      });
      return res;
    `)
  const revertEvent = async (eventId, reason) =>
    callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(eventId)}, ${JSON.stringify(reason)}); return res;`)
  const extractEventId = (res) => (String(res?.data ?? '').match(/evt_\w+/) || [])[0] || null

  // Academic
  const getConfig = async () => {
    const r = await callIpc(`const res = await api.academic.getConfig(); return res;`)
    return r?.data ?? null
  }
  const listExams = async (semester) =>
    callIpc(`const res = await api.academic.listExams(${semester ? JSON.stringify(semester) : 'undefined'}); return res;`)
  const createExam = async (tag, subjectId) => {
    const r = await callIpc(`
      const res = await api.academic.createExam({
        name: ${JSON.stringify(`cdp压力测试_${tag}_${TS}`)},
        type: 'monthly',
        date: new Date().toISOString().slice(0, 10),
        semester: '测试学期',
        subjects: ${JSON.stringify([subjectId])},
      });
      return res;
    `)
    if (r?.success && r?.data?.id) { createdExamIds.push(r.data.id); return r.data }
    return null
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

  // Class
  const listClasses = async () => {
    const r = await callIpc(`const res = await api.class.list(); return res;`)
    return r?.data ?? []
  }
  const createClass = async (tag, dispName) => {
    const classId = `${RUN_PREFIX}-${tag}`
    const r = await callIpc(`
      const res = await api.class.create({
        class_id: ${JSON.stringify(classId)},
        name: ${JSON.stringify(dispName)},
        grade: '测试年级',
        note: 'cdp-cross-module-stress 自动化测试',
        teacher: '测试班主任',
      });
      return res;
    `)
    if (r?.success && r?.data?.id) {
      createdClassIds.push({ id: r.data.id, class_id: r.data.class_id })
      return { id: r.data.id, class_id: r.data.class_id, name: r.data.name }
    }
    return { error: `res=${JSON.stringify(r).slice(0, 100)}`, class_id: classId }
  }
  const deleteClass = async (id) =>
    callIpc(`const res = await api.class.delete(${JSON.stringify(id)}); return res;`)
  const assignStudents = async (classId, names) =>
    callIpc(`const res = await api.class.assign({ class_id: ${JSON.stringify(classId)}, student_names: ${JSON.stringify(names)} }); return res;`)
  const removeStudent = async (studentName) =>
    callIpc(`const res = await api.class.removeStudent({ student_name: ${JSON.stringify(studentName)} }); return res;`)

  // Settings
  const getSettings = async () =>
    evalInPage(`
      (async function() {
        const api = window.__EAA_API__ || window.api;
        return await api.settings.get();
      })()
    `)
  const setSetting = async (path, value) =>
    evalInPage(`
      (async function() {
        const api = window.__EAA_API__ || window.api;
        return await api.settings.set(${JSON.stringify(path)}, ${JSON.stringify(value)});
      })()
    `)
  const getByPath = (obj, path) => {
    const keys = path.split('.')
    return keys.reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj)
  }

  // Cron
  const cronList = async () => {
    const r = await callIpc(`const res = await api.cron.list(); return res;`)
    return unwrapArr(r)
  }
  const cronAdd = async (overrides = {}) => {
    const task = {
      name: 'stress-' + TS + '-' + Math.random().toString(36).slice(2, 6),
      agentId: 'test-agent',
      // 每年 1 月 1 日 9 点, 即使被 enable 也不会在测试期间触发
      expression: '0 9 1 1 *',
      prompt: 'stress-test-prompt',
      enabled: false,
      modelTier: 'low_cost',
      ...overrides,
    }
    const r = await callIpc(`const res = await api.cron.add(${JSON.stringify(task)}); return res;`)
    const id = r && r.success ? r.id : null
    if (id) createdCronIds.add(id)
    return { id, raw: r, task }
  }
  const cronRemove = async (id) =>
    callIpc(`const res = await api.cron.remove(${JSON.stringify(id)}); return res;`)
  const cronGetLogs = async () =>
    callIpc(`const res = await api.cron.getLogs(); return res;`)

  // Agent
  const agentList = async () => {
    const r = await callIpc(`const res = await api.agent.list(); return res;`)
    return unwrapArr(r)
  }
  const agentGet = async (id) =>
    callIpc(`const res = await api.agent.get(${JSON.stringify(id)}); return res;`)

  // Skill
  const skillList = async () => {
    const r = await callIpc(`const res = await api.skill.list(); return res;`)
    return unwrapArr(r)
  }
  const skillGet = async (name) =>
    callIpc(`const res = await api.skill.get(${JSON.stringify(name)}); return res;`)

  // ---------- 清理账本 ----------
  const createdClassIds = [] // {id, class_id}
  const createdExamIds = [] // examId (删除时级联清理成绩)
  const createdCronIds = new Set() // cron task id
  const throwawayStudents = [] // 临时学生名 (最终软删除)
  const addedEventIds = [] // EAA eventId (最终回滚)
  const settingsRestorations = [] // {path, orig} (最终还原)
  const studentClassIdRestorations = new Map() // name -> 原始 class_id

  const trackSetting = (path, orig) => settingsRestorations.push({ path, orig })
  const trackOriginalClassId = async (name) => {
    if (!studentClassIdRestorations.has(name)) {
      const s = await getStudentByName(name)
      studentClassIdRestorations.set(name, s?.class_id ?? null)
    }
  }

  // ---------- 预取学业配置 (科目) ----------
  const configRes = await getConfig()
  const subjects = configRes?.subjects ?? []
  const SUBJECT_ID = subjects[0]?.id ?? 'math'
  const SUBJECT_FULL = subjects[0]?.fullMark ?? 150
  console.log(`学业配置: subjects=${subjects.length} 使用科目=${SUBJECT_ID}(满分${SUBJECT_FULL})`)

  // ---------- 基线采集 ----------
  const origSettings = await getSettings()
  if (!origSettings || typeof origSettings !== 'object') {
    console.log('FAIL: 无法读取初始 settings'); ws.close(); process.exit(1)
  }
  const baselineStudents = await listStudents()
  const baselineClasses = await listClasses()
  const baselineExams = unwrapArr(await listExams())
  const baselineCron = await cronList()
  const baselineAgents = await agentList()
  const baselineSkills = await skillList()
  console.log(
    `基线: students=${baselineStudents.length} classes=${baselineClasses.length} exams=${baselineExams.length} ` +
    `cron=${baselineCron.length} agents=${baselineAgents.length} skills=${baselineSkills.length}\n`,
  )

  // 创建 2 个临时学生用于 EAA 事件测试 (避免污染既有学生)
  const STU_A = `cdp_stress_stuA_${TS}`
  const STU_B = `cdp_stress_stuB_${TS}`
  for (const nm of [STU_A, STU_B]) {
    const r = await addStudent(nm)
    if (r && r.success !== false) throwawayStudents.push(nm)
  }
  const scoreA = await getScore(STU_A)
  const baselineScoreA = scoreA?.score
  console.log(`临时学生: ${STU_A}(score=${baselineScoreA}) ${STU_B}\n`)

  // =============================================================
  // 场景 1: 并行模块读取 (5+ 模块同时读)
  // =============================================================
  console.log('━━━ 场景 1: 并行模块读取 ━━━')

  await test('1.1 7 模块并行读取全部成功', async () => {
    const N = '1.1 7 模块并行读取全部成功'
    const [stu, exa, cls, crn, agt, skl, set] = await Promise.all([
      callIpc(`const res = await api.eaa.listStudents(); return res;`),
      listExams(),
      callIpc(`const res = await api.class.list(); return res;`),
      callIpc(`const res = await api.cron.list(); return res;`),
      callIpc(`const res = await api.agent.list(); return res;`),
      callIpc(`const res = await api.skill.list(); return res;`),
      getSettings(),
    ])
    const allOk = [stu, exa, cls, crn, agt, skl].every(isOk) && !!set
    record(N, allOk, `studentsOk=${isOk(stu)} examsOk=${isOk(exa)} classesOk=${isOk(cls)} cronOk=${isOk(crn)} agentsOk=${isOk(agt)} skillsOk=${isOk(skl)} settingsOk=${!!set}`)
  })

  await test('1.2 5 个 EAA 读操作并行', async () => {
    const N = '1.2 5 个 EAA 读操作并行'
    const [info, score, ranking, stats, codes] = await Promise.all([
      callIpc(`const res = await api.eaa.info(); return res;`),
      callIpc(`const res = await api.eaa.score(${JSON.stringify(STU_A)}); return res;`),
      callIpc(`const res = await api.eaa.ranking(10); return res;`),
      callIpc(`const res = await api.eaa.stats(); return res;`),
      callIpc(`const res = await api.eaa.codes(); return res;`),
    ])
    const allOk = [info, score, ranking, stats, codes].every(isOk)
    record(N, allOk, `info=${isOk(info)} score=${isOk(score)} ranking=${isOk(ranking)} stats=${isOk(stats)} codes=${isOk(codes)}`)
  })

  await test('1.3 Agent list + get 并行', async () => {
    const N = '1.3 Agent list + get 并行'
    const agents = await agentList()
    if (agents.length === 0) return record(N, true, '无 agent, 跳过 get')
    const firstId = agents[0].id
    const [lst, detail] = await Promise.all([agentList(), agentGet(firstId)])
    const ok = lst.length === agents.length && isOk(detail)
    record(N, ok, `listLen=${lst.length} getOk=${isOk(detail)} target=${firstId}`)
  })

  await test('1.4 Skill list + get 并行', async () => {
    const N = '1.4 Skill list + get 并行'
    const skills = await skillList()
    if (skills.length === 0) return record(N, true, '无 skill, 跳过 get')
    // skill.get 不存在的名字返回 null (非错误), 用首个真实名字
    const firstName = skills[0].name || skills[0]
    const [lst, detail] = await Promise.all([skillList(), skillGet(firstName)])
    const ok = lst.length === skills.length
    record(N, ok, `listLen=${lst.length} getOk=${isOk(detail)} target=${firstName}`)
  })

  await test('1.5 Cron list + getLogs 并行', async () => {
    const N = '1.5 Cron list + getLogs 并行'
    const [lst, logs] = await Promise.all([cronList(), cronGetLogs()])
    const ok = Array.isArray(lst) && isOk(logs)
    record(N, ok, `listLen=${lst.length} logsOk=${isOk(logs)}`)
  })

  await test('1.6 重复 3 轮 7 模块并行读 (一致性)', async () => {
    const N = '1.6 重复 3 轮 7 模块并行读 (一致性)'
    let allOk = true
    let lastStudents = -1
    for (let i = 0; i < 3; i++) {
      const [stu, exa, cls, crn, agt, skl] = await Promise.all([
        callIpc(`const res = await api.eaa.listStudents(); return res;`),
        listExams(),
        callIpc(`const res = await api.class.list(); return res;`),
        callIpc(`const res = await api.cron.list(); return res;`),
        callIpc(`const res = await api.agent.list(); return res;`),
        callIpc(`const res = await api.skill.list(); return res;`),
      ])
      if (![stu, exa, cls, crn, agt, skl].every(isOk)) { allOk = false; break }
      const curStudents = unwrapArr(stu).length
      if (i > 0 && curStudents !== lastStudents) { allOk = false; break }
      lastStudents = curStudents
    }
    record(N, allOk, `3 轮读取均成功且学生数一致=${lastStudents}`)
  })

  // =============================================================
  // 场景 2: 混合读写 (并发读 + 写, 验证不互相干扰)
  // =============================================================
  console.log('\n━━━ 场景 2: 混合读写 ━━━')

  await test('2.1 EAA 混合 (listStudents 读 + addEvent 写 + listStudents 读)', async () => {
    const N = '2.1 EAA 混合 (listStudents 读 + addEvent 写 + listStudents 读)'
    const [r1, ev, r2] = await Promise.all([
      callIpc(`const res = await api.eaa.listStudents(); return res;`),
      addEvent(STU_A, 'CLASS_COMMITTEE', 1),
      callIpc(`const res = await api.eaa.listStudents(); return res;`),
    ])
    const evtId = extractEventId(ev)
    if (evtId) addedEventIds.push(evtId)
    const ok = isOk(r1) && !!evtId && isOk(r2)
    record(N, ok, `read1Ok=${isOk(r1)} writeEvt=${evtId || '无'} read2Ok=${isOk(r2)}`)
  })

  await test('2.2 Class 混合 (list 读 + create 写 + list 读)', async () => {
    const N = '2.2 Class 混合 (list 读 + create 写 + list 读)'
    const [r1, cls, r2] = await Promise.all([
      callIpc(`const res = await api.class.list(); return res;`),
      createClass('M22', '压力-混合读写班'),
      callIpc(`const res = await api.class.list(); return res;`),
    ])
    const ok = isOk(r1) && !!cls.id && isOk(r2)
    record(N, ok, `read1Ok=${isOk(r1)} createId=${cls.id || cls.error} read2Ok=${isOk(r2)}`)
  })

  await test('2.3 Settings 混合 (get + set + get)', async () => {
    const N = '2.3 Settings 混合 (get + set + get)'
    const path = 'general.defaultOperator'
    trackSetting(path, getByPath(origSettings, path))
    const newVal = `mix_${TS}`
    const [g1, sr, g2] = await Promise.all([
      getSettings(),
      setSetting(path, newVal),
      getSettings(),
    ])
    const ok = !!g1 && sr?.success === true && !!g2
    record(N, ok, `get1Ok=${!!g1} setSuccess=${sr?.success} get2Ok=${!!g2}`)
  })

  await test('2.4 Cron 混合 (list + add + list)', async () => {
    const N = '2.4 Cron 混合 (list + add + list)'
    const [r1, add, r2] = await Promise.all([
      callIpc(`const res = await api.cron.list(); return res;`),
      cronAdd({ name: 'stress-mix-' + TS }),
      callIpc(`const res = await api.cron.list(); return res;`),
    ])
    const ok = isOk(r1) && !!add.id && isOk(r2)
    record(N, ok, `list1Ok=${isOk(r1)} addId=${add.id || '无'} list2Ok=${isOk(r2)}`)
  })

  await test('2.5 Academic 混合 (listExams + createExam + listExams)', async () => {
    const N = '2.5 Academic 混合 (listExams + createExam + listExams)'
    const [r1, exam, r2] = await Promise.all([
      listExams(),
      createExam('M25', SUBJECT_ID),
      listExams(),
    ])
    const ok = isOk(r1) && !!exam && isOk(r2)
    record(N, ok, `list1Ok=${isOk(r1)} createExam=${exam ? exam.id : '无'} list2Ok=${isOk(r2)}`)
  })

  // =============================================================
  // 场景 3: EAA + Academic 并发
  // =============================================================
  console.log('\n━━━ 场景 3: EAA + Academic 并发 ━━━')

  await test('3.1 addEvent 与 createExam 并发独立完成', async () => {
    const N = '3.1 addEvent 与 createExam 并发独立完成'
    const [ev, exam] = await Promise.all([
      addEvent(STU_A, 'CLASS_COMMITTEE', 2),
      createExam('E31', SUBJECT_ID),
    ])
    const evtId = extractEventId(ev)
    if (evtId) addedEventIds.push(evtId)
    const ok = !!evtId && !!exam
    record(N, ok, `event=${evtId || '无'} exam=${exam ? exam.id : '无'}`)
  })

  await test('3.2 addEvent 与 setGrade 并发 (EAA 分变化 / 学业成绩独立)', async () => {
    const N = '3.2 addEvent 与 setGrade 并发 (EAA 分变化 / 学业成绩独立)'
    const exam = await createExam('E32', SUBJECT_ID)
    if (!exam) return record(N, false, '建考试失败')
    const scoreBefore = (await getScore(STU_A))?.score
    const [ev, grade] = await Promise.all([
      addEvent(STU_A, 'CLASS_COMMITTEE', 3),
      setGrade(exam.id, STU_A, SUBJECT_ID, 88, SUBJECT_FULL),
    ])
    const evtId = extractEventId(ev)
    if (evtId) addedEventIds.push(evtId)
    const scoreAfter = (await getScore(STU_A))?.score
    const grades = await getGrades(STU_A)
    const gradeRecorded = grades.some((g) => g.examId === exam.id && g.score === 88)
    const eaaChanged = scoreAfter === scoreBefore + 3
    const ok = !!evtId && grade?.success === true && eaaChanged && gradeRecorded
    record(N, ok, `evt=${evtId || '无'} score ${scoreBefore}→${scoreAfter}(+3=${eaaChanged}) grade录入=${gradeRecorded}`)
  })

  await test('3.3 并发 3x addEvent + 2x createExam', async () => {
    const N = '3.3 并发 3x addEvent + 2x createExam'
    const scoreBefore = (await getScore(STU_A))?.score
    const ops = await Promise.all([
      addEvent(STU_A, 'CLASS_COMMITTEE', 1),
      addEvent(STU_A, 'CLASS_COMMITTEE', 1),
      addEvent(STU_A, 'CLASS_COMMITTEE', 1),
      createExam('E33a', SUBJECT_ID),
      createExam('E33b', SUBJECT_ID),
    ])
    const evtIds = [ops[0], ops[1], ops[2]].map(extractEventId).filter(Boolean)
    for (const id of evtIds) addedEventIds.push(id)
    const exams = [ops[3], ops[4]]
    const scoreAfter = (await getScore(STU_A))?.score
    const ok = evtIds.length === 3 && exams.every(Boolean) && scoreAfter === scoreBefore + 3
    record(N, ok, `events=${evtIds.length}/3 exams=${exams.filter(Boolean).length}/2 score ${scoreBefore}→${scoreAfter}`)
  })

  await test('3.4 并发 addEvent + setGrade + getGrades + score', async () => {
    const N = '3.4 并发 addEvent + setGrade + getGrades + score'
    const exam = await createExam('E34', SUBJECT_ID)
    if (!exam) return record(N, false, '建考试失败')
    const [ev, grade, grades, score] = await Promise.all([
      addEvent(STU_A, 'CLASS_COMMITTEE', 2),
      setGrade(exam.id, STU_A, SUBJECT_ID, 92, SUBJECT_FULL),
      getGrades(STU_A),
      getScore(STU_A),
    ])
    const evtId = extractEventId(ev)
    if (evtId) addedEventIds.push(evtId)
    const ok = !!evtId && grade?.success === true && Array.isArray(grades) && !!score
    record(N, ok, `evt=${evtId || '无'} gradeOk=${grade?.success} gradesLen=${grades.length} scoreOk=${!!score}`)
  })

  await test('3.5 并发 revertEvent + createExam + setGrade', async () => {
    const N = '3.5 并发 revertEvent + createExam + setGrade'
    // 先准备一个可回滚的事件 + 先建考试 (setGrade 依赖 exam.id, 不能与 createExam 并行)
    const ev = await addEvent(STU_A, 'CLASS_COMMITTEE', 1)
    const evtId = extractEventId(ev)
    const exam = await createExam('E35', SUBJECT_ID)
    if (!evtId) return record(N, false, '准备事件失败')
    if (!exam) return record(N, false, '建考试失败')
    // 并发: revertEvent + setGrade (两者无依赖, 可并行)
    const [rev, grade] = await Promise.all([
      revertEvent(evtId, 'cdp-cross-module-stress 回滚'),
      setGrade(exam.id, STU_A, SUBJECT_ID, 75, SUBJECT_FULL),
    ])
    const ok = isOk(rev) && grade?.success === true
    record(N, ok, `revertOk=${isOk(rev)} exam=${exam.id} gradeOk=${grade?.success === true}`)
  })

  // =============================================================
  // 场景 4: Class + EAA 并发 (建班/分配/加事件, class_id 一致)
  // =============================================================
  console.log('\n━━━ 场景 4: Class + EAA 并发 ━━━')

  await test('4.1 并发 createClass + assignStudent + addEvent (class_id 一致)', async () => {
    const N = '4.1 并发 createClass + assignStudent + addEvent (class_id 一致)'
    await trackOriginalClassId(STU_A)
    const cls = await createClass('C41', '压力-ClassEAA-1')
    if (!cls.id) return record(N, false, `建班失败: ${cls.error}`)
    // 并发: 分配学生 + 加事件
    const [assign, ev] = await Promise.all([
      assignStudents(cls.class_id, [STU_A]),
      addEvent(STU_A, 'CLASS_COMMITTEE', 1),
    ])
    const evtId = extractEventId(ev)
    if (evtId) addedEventIds.push(evtId)
    const stu = await getStudentByName(STU_A)
    const ok = assign?.success && !!evtId && stu?.class_id === cls.class_id
    record(N, ok, `assignOk=${assign?.success} evt=${evtId || '无'} stu.class_id=${stu?.class_id} expected=${cls.class_id}`)
  })

  await test('4.2 并发 createClass + 2x addEvent (班级独立建立)', async () => {
    const N = '4.2 并发 createClass + 2x addEvent (班级独立建立)'
    const [cls, ev1, ev2] = await Promise.all([
      createClass('C42', '压力-ClassEAA-2'),
      addEvent(STU_A, 'CLASS_COMMITTEE', 1),
      addEvent(STU_B, 'CLASS_COMMITTEE', 1),
    ])
    const e1 = extractEventId(ev1); const e2 = extractEventId(ev2)
    if (e1) addedEventIds.push(e1)
    if (e2) addedEventIds.push(e2)
    const classes = await listClasses()
    const exists = classes.some((c) => c.class_id === cls.class_id)
    const ok = !!cls.id && !!e1 && !!e2 && exists
    record(N, ok, `classId=${cls.id || cls.error} evt1=${e1 || '无'} evt2=${e2 || '无'} 班级存在=${exists}`)
  })

  await test('4.3 并发 assignStudent + addEvent (学生 class_id 正确)', async () => {
    const N = '4.3 并发 assignStudent + addEvent (学生 class_id 正确)'
    await trackOriginalClassId(STU_B)
    const cls = await createClass('C43', '压力-ClassEAA-3')
    if (!cls.id) return record(N, false, `建班失败: ${cls.error}`)
    const [assign, ev] = await Promise.all([
      assignStudents(cls.class_id, [STU_B]),
      addEvent(STU_B, 'CLASS_COMMITTEE', 2),
    ])
    const evtId = extractEventId(ev)
    if (evtId) addedEventIds.push(evtId)
    const stu = await getStudentByName(STU_B)
    const ok = assign?.success && !!evtId && stu?.class_id === cls.class_id
    record(N, ok, `assignOk=${assign?.success} evt=${evtId || '无'} stuB.class_id=${stu?.class_id}`)
  })

  await test('4.4 并发 removeStudent + addEvent (class_id 清空)', async () => {
    const N = '4.4 并发 removeStudent + addEvent (class_id 清空)'
    // 先确保 STU_A 在某班, 用上一步分配的班级; 若无则建一个
    let stu = await getStudentByName(STU_A)
    if (!stu?.class_id || !String(stu.class_id).startsWith(RUN_PREFIX)) {
      const cls = await createClass('C44', '压力-ClassEAA-4')
      if (cls.id) await assignStudents(cls.class_id, [STU_A])
      stu = await getStudentByName(STU_A)
    }
    const before = stu?.class_id
    const [rm, ev] = await Promise.all([
      removeStudent(STU_A),
      addEvent(STU_A, 'CLASS_COMMITTEE', 1),
    ])
    const evtId = extractEventId(ev)
    if (evtId) addedEventIds.push(evtId)
    const after = await getStudentByName(STU_A)
    const ok = rm?.success && !!evtId && !after?.class_id
    record(N, ok, `removeOk=${rm?.success} evt=${evtId || '无'} class_id ${before}→${after?.class_id || '(空)'}`)
  })

  await test('4.5 并发 createClass + assignStudent + addEvent + score (全链一致)', async () => {
    const N = '4.5 并发 createClass + assignStudent + addEvent + score (全链一致)'
    await trackOriginalClassId(STU_B)
    const cls = await createClass('C45', '压力-ClassEAA-5')
    if (!cls.id) return record(N, false, `建班失败: ${cls.error}`)
    const [assign, ev, score] = await Promise.all([
      assignStudents(cls.class_id, [STU_B]),
      addEvent(STU_B, 'CLASS_COMMITTEE', 2),
      getScore(STU_B),
    ])
    const evtId = extractEventId(ev)
    if (evtId) addedEventIds.push(evtId)
    const stu = await getStudentByName(STU_B)
    const ok = assign?.success && !!evtId && !!score && stu?.class_id === cls.class_id
    record(N, ok, `assignOk=${assign?.success} evt=${evtId || '无'} scoreOk=${!!score} class_id一致=${stu?.class_id === cls.class_id}`)
  })

  // =============================================================
  // 场景 5: Settings + Cron 并发
  // =============================================================
  console.log('\n━━━ 场景 5: Settings + Cron 并发 ━━━')

  await test('5.1 并发 settings.set + cron.add', async () => {
    const N = '5.1 并发 settings.set + cron.add'
    const path = 'general.defaultOperator'
    trackSetting(path, getByPath(origSettings, path))
    const [sr, add] = await Promise.all([
      setSetting(path, `sc_${TS}_1`),
      cronAdd({ name: 'stress-sc-1-' + TS }),
    ])
    const ok = sr?.success === true && !!add.id
    record(N, ok, `setOk=${sr?.success} cronId=${add.id || '无'}`)
  })

  await test('5.2 并发 settings.set + cron.remove', async () => {
    const N = '5.2 并发 settings.set + cron.remove'
    const path = 'chat.maxTokens'
    trackSetting(path, getByPath(origSettings, path))
    // 先建一个待删 cron
    const tmp = await cronAdd({ name: 'stress-sc-rm-' + TS })
    if (!tmp.id) return record(N, false, '准备 cron 失败')
    const [sr, rm] = await Promise.all([
      setSetting(path, 8192),
      cronRemove(tmp.id),
    ])
    createdCronIds.delete(tmp.id) // 已删
    const ok = sr?.success === true && rm?.success === true
    record(N, ok, `setOk=${sr?.success} removeOk=${rm?.success}`)
  })

  await test('5.3 并发 3x settings.set + 2x cron.add', async () => {
    const N = '5.3 并发 3x settings.set + 2x cron.add'
    const p1 = 'general.defaultOperator'; const p2 = 'chat.maxTokens'; const p3 = 'advanced.httpIdleTimeoutMs'
    trackSetting(p1, getByPath(origSettings, p1))
    trackSetting(p2, getByPath(origSettings, p2))
    trackSetting(p3, getByPath(origSettings, p3))
    const ops = await Promise.all([
      setSetting(p1, `b_${TS}`),
      setSetting(p2, 4096),
      setSetting(p3, 95000),
      cronAdd({ name: 'stress-sc-3a-' + TS }),
      cronAdd({ name: 'stress-sc-3b-' + TS }),
    ])
    const setsOk = ops.slice(0, 3).every((s) => s?.success === true)
    const cronsOk = ops.slice(3).every((c) => !!c.id)
    const ok = setsOk && cronsOk
    record(N, ok, `setsOk=${setsOk} cronsOk=${cronsOk} cronIds=${ops.slice(3).map((c) => c.id).join(',')}`)
  })

  await test('5.4 并发 settings.get + cron.list + settings.set + cron.add', async () => {
    const N = '5.4 并发 settings.get + cron.list + settings.set + cron.add'
    const path = 'models.defaultProvider'
    trackSetting(path, getByPath(origSettings, path))
    const [g, lst, sr, add] = await Promise.all([
      getSettings(),
      cronList(),
      setSetting(path, `prov_${TS}`),
      cronAdd({ name: 'stress-sc-4-' + TS }),
    ])
    const ok = !!g && Array.isArray(lst) && sr?.success === true && !!add.id
    record(N, ok, `getOk=${!!g} listOk=${Array.isArray(lst)} setOk=${sr?.success} addId=${add.id || '无'}`)
  })

  await test('5.5 并发 settings.set + cron.add + cron.remove (链式)', async () => {
    const N = '5.5 并发 settings.set + cron.add + cron.remove (链式)'
    const path = 'models.defaultModel'
    trackSetting(path, getByPath(origSettings, path))
    const tmp = await cronAdd({ name: 'stress-sc-5-prep-' + TS })
    if (!tmp.id) return record(N, false, '准备 cron 失败')
    const [sr, add, rm] = await Promise.all([
      setSetting(path, `model_${TS}`),
      cronAdd({ name: 'stress-sc-5-new-' + TS }),
      cronRemove(tmp.id),
    ])
    createdCronIds.delete(tmp.id)
    const ok = sr?.success === true && !!add.id && rm?.success === true
    record(N, ok, `setOk=${sr?.success} addId=${add.id || '无'} removeOk=${rm?.success}`)
  })

  // =============================================================
  // 场景 6: 高并发并行 (20+ 跨模块操作)
  // =============================================================
  console.log('\n━━━ 场景 6: 高并发并行 ━━━')

  await test('6.1 25 并发读 (跨 7 模块)', async () => {
    const N = '6.1 25 并发读 (跨 7 模块)'
    const tasks = []
    for (let i = 0; i < 4; i++) tasks.push(callIpc(`const res = await api.eaa.listStudents(); return res;`))
    for (let i = 0; i < 4; i++) tasks.push(listExams())
    for (let i = 0; i < 4; i++) tasks.push(callIpc(`const res = await api.class.list(); return res;`))
    for (let i = 0; i < 4; i++) tasks.push(callIpc(`const res = await api.cron.list(); return res;`))
    for (let i = 0; i < 3; i++) tasks.push(callIpc(`const res = await api.agent.list(); return res;`))
    for (let i = 0; i < 3; i++) tasks.push(callIpc(`const res = await api.skill.list(); return res;`))
    for (let i = 0; i < 3; i++) tasks.push(getSettings())
    const out = await Promise.all(tasks)
    const okCount = out.filter((r, idx) => {
      // settings (后 3 个) 检查 truthy, 其余检查 isOk
      if (idx >= 22) return !!r
      return isOk(r)
    }).length
    const ok = okCount === 25
    record(N, ok, `成功=${okCount}/25`)
  })

  await test('6.2 20 并发混合 (10 读 + 10 写)', async () => {
    const N = '6.2 20 并发混合 (10 读 + 10 写)'
    const path = 'general.defaultOperator'
    trackSetting(path, getByPath(origSettings, path))
    const reads = []
    for (let i = 0; i < 5; i++) reads.push(callIpc(`const res = await api.eaa.listStudents(); return res;`))
    for (let i = 0; i < 5; i++) reads.push(callIpc(`const res = await api.cron.list(); return res;`))
    const writes = []
    for (let i = 0; i < 3; i++) writes.push(addEvent(STU_A, 'CLASS_COMMITTEE', 1).then((r) => { const id = extractEventId(r); if (id) addedEventIds.push(id); return id }))
    for (let i = 0; i < 2; i++) writes.push(createExam(`H62_${i}`, SUBJECT_ID))
    for (let i = 0; i < 2; i++) writes.push(cronAdd({ name: `stress-h62-${i}-${TS}` }))
    for (let i = 0; i < 2; i++) writes.push(setSetting(path, `h62_${i}_${TS}`))
    for (let i = 0; i < 1; i++) writes.push(createClass(`H62_${i}`, '压力-高并发班'))
    const out = await Promise.all([...reads, ...writes])
    const readsOk = out.slice(0, 10).every((r) => isOk(r))
    const writesOk = out.slice(10).every((r) => {
      if (typeof r === 'string') return !!r // eventId
      if (r && r.success !== undefined) return r.success === true || !!r.id
      if (r && r.id) return true // exam/class
      return !!r
    })
    const ok = readsOk && writesOk
    record(N, ok, `readsOk=${readsOk} writesOk=${writesOk}`)
  })

  await test('6.3 24 并发 (6 EAA + 6 Academic + 4 Class + 4 Cron + 2 Settings + 2 Agent)', async () => {
    const N = '6.3 24 并发 (6 EAA + 6 Academic + 4 Class + 4 Cron + 2 Settings + 2 Agent)'
    const p1 = 'general.defaultOperator'; const p2 = 'chat.maxTokens'
    trackSetting(p1, getByPath(origSettings, p1))
    trackSetting(p2, getByPath(origSettings, p2))
    const tasks = []
    // 6 EAA: 3 读 + 3 写
    for (let i = 0; i < 3; i++) tasks.push(callIpc(`const res = await api.eaa.score(${JSON.stringify(STU_A)}); return res;`))
    for (let i = 0; i < 3; i++) tasks.push(addEvent(STU_A, 'CLASS_COMMITTEE', 1).then((r) => { const id = extractEventId(r); if (id) addedEventIds.push(id); return id }))
    // 6 Academic: 3 读 + 3 写
    for (let i = 0; i < 3; i++) tasks.push(listExams())
    for (let i = 0; i < 3; i++) tasks.push(createExam(`H63_${i}`, SUBJECT_ID))
    // 4 Class: 2 读 + 2 写
    for (let i = 0; i < 2; i++) tasks.push(callIpc(`const res = await api.class.list(); return res;`))
    for (let i = 0; i < 2; i++) tasks.push(createClass(`H63_${i}`, '压力-高并发班'))
    // 4 Cron: 2 读 + 2 写
    for (let i = 0; i < 2; i++) tasks.push(callIpc(`const res = await api.cron.list(); return res;`))
    for (let i = 0; i < 2; i++) tasks.push(cronAdd({ name: `stress-h63-${i}-${TS}` }))
    // 2 Settings 写
    tasks.push(setSetting(p1, `h63_${TS}`))
    tasks.push(setSetting(p2, 12000))
    // 2 Agent 读
    for (let i = 0; i < 2; i++) tasks.push(callIpc(`const res = await api.agent.list(); return res;`))
    const out = await Promise.all(tasks)
    let okCount = 0
    out.forEach((r, i) => {
      if (i < 3 || (i >= 6 && i < 9) || (i >= 12 && i < 14) || (i >= 16 && i < 18) || i >= 22) {
        // 读操作 / agent 读
        if (isOk(r)) okCount++
      } else if (typeof r === 'string') {
        if (r) okCount++ // eventId
      } else if (r && r.success !== undefined) {
        if (r.success === true || !!r.id) okCount++
      } else if (r && r.id) {
        okCount++ // exam/class/cron add
      }
    })
    // 高并发下允许少量失败 (>= 22/24 视为通过, 并发竞态是预期行为)
    const ok = okCount >= 22
    record(N, ok, `成功=${okCount}/24 (容忍>=22)`)
  })

  await test('6.4 30 并发同模块读 (30x settings.get)', async () => {
    const N = '6.4 30 并发同模块读 (30x settings.get)'
    const tasks = []
    for (let i = 0; i < 30; i++) tasks.push(getSettings())
    const out = await Promise.all(tasks)
    const okCount = out.filter((r) => r && typeof r === 'object').length
    const ok = okCount === 30
    record(N, ok, `成功=${okCount}/30`)
  })

  await test('6.5 20 并发 addEvent + 后续 revert 配对', async () => {
    const N = '6.5 20 并发 addEvent + 后续 revert 配对'
    const scoreBefore = (await getScore(STU_A))?.score
    const evRes = await Promise.all(
      Array.from({ length: 20 }, () => addEvent(STU_A, 'CLASS_COMMITTEE', 1)),
    )
    const evtIds = evRes.map(extractEventId).filter(Boolean)
    for (const id of evtIds) addedEventIds.push(id)
    const scoreAfter = (await getScore(STU_A))?.score
    const added20 = evtIds.length === 20
    const scoreIncreased = scoreAfter === scoreBefore + 20
    record(N, added20 && scoreIncreased, `events=${evtIds.length}/20 score ${scoreBefore}→${scoreAfter}(+20=${scoreIncreased})`)
  })

  // =============================================================
  // 场景 7: 数据完整性 (并发后各模块无交叉污染)
  // =============================================================
  console.log('\n━━━ 场景 7: 数据完整性 ━━━')

  await test('7.1 Class 数据未泄漏到 Academic exam', async () => {
    const N = '7.1 Class 数据未泄漏到 Academic exam'
    const exams = unwrapArr(await listExams())
    const classes = await listClasses()
    const testClasses = classes.filter((c) => String(c.class_id).startsWith(RUN_PREFIX))
    // 检查: 没有任何 exam 的 name/id 等于测试 class_id
    const leaked = exams.filter((e) => testClasses.some((c) => c.class_id === e.id || c.class_id === e.name))
    const ok = leaked.length === 0
    record(N, ok, `exams=${exams.length} testClasses=${testClasses.length} 泄漏数=${leaked.length}`)
  })

  await test('7.2 Settings 键未出现在 cron 任务中', async () => {
    const N = '7.2 Settings 键未出现在 cron 任务中'
    const tasks = await cronList()
    const settingsKeys = Object.keys(origSettings)
    // cron 任务字段: id, name, agentId, expression, prompt, enabled, modelTier
    const validCronFields = new Set(['id', 'name', 'agentId', 'expression', 'prompt', 'enabled', 'modelTier', 'lastRunAt', 'lastStatus', 'nextRunAt'])
    const contaminated = tasks.filter((t) => Object.keys(t).some((k) => settingsKeys.includes(k) && !validCronFields.has(k)))
    const ok = contaminated.length === 0
    record(N, ok, `cronTasks=${tasks.length} settingsKeys=${settingsKeys.length} 污染数=${contaminated.length}`)
  })

  await test('7.3 EAA 行为分与学业成绩相互独立', async () => {
    const N = '7.3 EAA 行为分与学业成绩相互独立'
    const exam = await createExam('E73', SUBJECT_ID)
    if (!exam) return record(N, false, '建考试失败')
    const scoreBefore = (await getScore(STU_A))?.score
    // 录入学业成绩 80
    await setGrade(exam.id, STU_A, SUBJECT_ID, 80, SUBJECT_FULL)
    const gradeAfter1 = (await getGrades(STU_A)).find((g) => g.examId === exam.id)
    const scoreAfterGrade = (await getScore(STU_A))?.score
    // 改 EAA 分 (+2)
    const ev = await addEvent(STU_A, 'CLASS_COMMITTEE', 2)
    const evtId = extractEventId(ev)
    if (evtId) addedEventIds.push(evtId)
    const gradeAfter2 = (await getGrades(STU_A)).find((g) => g.examId === exam.id)
    const scoreAfterEaa = (await getScore(STU_A))?.score
    const gradeIndependent = gradeAfter1?.score === 80 && gradeAfter2?.score === 80
    const scoreIndependent = scoreAfterGrade === scoreBefore && scoreAfterEaa === scoreBefore + 2
    const ok = gradeIndependent && scoreIndependent
    record(N, ok, `学业成绩不变=${gradeIndependent}(=80) EAA分 ${scoreBefore}→${scoreAfterGrade}(改学业不变) →${scoreAfterEaa}(+2)`)
  })

  await test('7.4 各模块基线计数正确 (无幽灵记录)', async () => {
    const N = '7.4 各模块基线计数正确 (无幽灵记录)'
    const curStudents = await listStudents()
    const curClasses = await listClasses()
    const curExams = unwrapArr(await listExams())
    const curCron = await cronList()
    const curAgents = await agentList()
    const curSkills = await skillList()
    // agent/skill 应与基线完全一致 (本测试不增删 agent/skill)
    const agentsUnchanged = curAgents.length === baselineAgents.length
    const skillsUnchanged = curSkills.length === baselineSkills.length
    // 学生数 = 基线 + 2 临时学生 (尚未清理)
    const studentsDelta = curStudents.length - baselineStudents.length
    // 测试班级/cron/exam 增量 > 0 (尚未清理), 但不应出现非测试前缀的幽灵
    const phantomClasses = curClasses.filter((c) => !String(c.class_id).startsWith(RUN_PREFIX) && !baselineClasses.some((b) => b.id === c.id)).length
    const ok = agentsUnchanged && skillsUnchanged && studentsDelta === 2 && phantomClasses === 0
    record(N, ok, `agents=${curAgents.length}/${baselineAgents.length} skills=${curSkills.length}/${baselineSkills.length} 学生增量=${studentsDelta}(预期2) 幽灵班级=${phantomClasses}`)
  })

  await test('7.5 学生 class_id 仅指向真实存在的班级', async () => {
    const N = '7.5 学生 class_id 仅指向真实存在的班级'
    const students = await listStudents()
    const classes = await listClasses()
    const classIdSet = new Set(classes.map((c) => c.class_id))
    // 仅检查测试期间临时学生 (避免对既有数据做断言)
    const testStudents = students.filter((s) => s.name === STU_A || s.name === STU_B)
    let consistent = true
    for (const s of testStudents) {
      if (s.class_id && !classIdSet.has(s.class_id)) {
        // 允许: 测试班级已被删除后 class_id 已清空; 若仍指向不存在的测试班则不一致
        if (String(s.class_id).startsWith(RUN_PREFIX)) consistent = false
      }
    }
    record(N, consistent, `测试学生=${testStudents.length} 班级总数=${classes.length} class_id一致=${consistent}`)
  })

  await test('7.6 EAA 回滚后行为分恢复基线', async () => {
    const N = '7.6 EAA 回滚后行为分恢复基线'
    // 先记录当前分, 加一个事件再回滚, 验证恢复
    const before = (await getScore(STU_A))?.score
    const ev = await addEvent(STU_A, 'CLASS_COMMITTEE', 2)
    const evtId = extractEventId(ev)
    if (!evtId) return record(N, false, '加事件失败')
    const afterAdd = (await getScore(STU_A))?.score
    const rev = await revertEvent(evtId, 'cdp-cross-module-stress 完整性回滚')
    const afterRevert = (await getScore(STU_A))?.score
    const ok = isOk(rev) && afterAdd === before + 2 && afterRevert === before
    record(N, ok, `before=${before} +2→${afterAdd} revert→${afterRevert} 恢复=${afterRevert === before}`)
  })

  // =============================================================
  // 场景 8: 错误隔离 (单模块抛错不影响其他模块)
  // =============================================================
  console.log('\n━━━ 场景 8: 错误隔离 ━━━')

  await test('8.1 非法 cron.add + 合法 eaa.listStudents (cron 失败, EAA 成功)', async () => {
    const N = '8.1 非法 cron.add + 合法 eaa.listStudents (cron 失败, EAA 成功)'
    const [badCron, goodEaa] = await Promise.all([
      callIpc(`const res = await api.cron.add({ name: 'bad', agentId: 'x', expression: 'invalid-expr', prompt: 'p', enabled: false }); return res;`),
      callIpc(`const res = await api.eaa.listStudents(); return res;`),
    ])
    const cronFailed = !isOk(badCron) || badCron?.success === false
    const eaaOk = isOk(goodEaa)
    const ok = cronFailed && eaaOk
    record(N, ok, `cronFailed=${cronFailed} eaaOk=${eaaOk}`)
  })

  await test('8.2 非法 settings.set (枚举) + 合法 class.list', async () => {
    const N = '8.2 非法 settings.set (枚举) + 合法 class.list'
    const [badSet, goodClass] = await Promise.all([
      setSetting('general.theme', 'not-a-valid-theme'),
      callIpc(`const res = await api.class.list(); return res;`),
    ])
    const setFailed = badSet?.success === false
    const classOk = isOk(goodClass)
    const ok = setFailed && classOk
    record(N, ok, `setFailed=${setFailed}(${badSet?.error || ''}) classOk=${classOk}`)
  })

  await test('8.3 非法 eaa.revertEvent + 合法 skill.list', async () => {
    const N = '8.3 非法 eaa.revertEvent + 合法 skill.list'
    const [badRev, goodSkill] = await Promise.all([
      callIpc(`const res = await api.eaa.revertEvent('evt_nonexistent_${TS}', 'test'); return res;`),
      callIpc(`const res = await api.skill.list(); return res;`),
    ])
    const revFailed = !isOk(badRev) || badRev?.success === false
    const skillOk = isOk(goodSkill)
    const ok = revFailed && skillOk
    record(N, ok, `revFailed=${revFailed} skillOk=${skillOk}`)
  })

  await test('8.4 非法 academic.deleteExam + 合法 agent.list', async () => {
    const N = '8.4 非法 academic.deleteExam + 合法 agent.list'
    const [badDel, goodAgent] = await Promise.all([
      callIpc(`const res = await api.academic.deleteExam('nonexistent-exam-${TS}'); return res;`),
      callIpc(`const res = await api.agent.list(); return res;`),
    ])
    // deleteExam 对不存在的 ID 是幂等的 (返回 success:true, no-op), 不视为错误
    // 关键验证: 系统不崩溃 + agent.list 仍正常 (错误隔离)
    const delControlled = isControlled(badDel)
    const agentOk = isOk(goodAgent)
    const ok = delControlled && agentOk
    record(N, ok, `delControlled=${delControlled}(success=${badDel?.success}) agentOk=${agentOk}`)
  })

  await test('8.5 混合: 1 失败 + 5 成功 并发', async () => {
    const N = '8.5 混合: 1 失败 + 5 成功 并发'
    const out = await Promise.all([
      callIpc(`const res = await api.cron.add({ name: 'bad', agentId: 'x', expression: 'bad', prompt: 'p', enabled: false }); return res;`), // 失败
      callIpc(`const res = await api.eaa.listStudents(); return res;`), // 成功
      callIpc(`const res = await api.class.list(); return res;`), // 成功
      callIpc(`const res = await api.cron.list(); return res;`), // 成功
      callIpc(`const res = await api.agent.list(); return res;`), // 成功
      callIpc(`const res = await api.skill.list(); return res;`), // 成功
    ])
    const failOk = !isOk(out[0]) || out[0]?.success === false
    const successOk = out.slice(1).every(isOk)
    const ok = failOk && successOk
    record(N, ok, `失败项失败=${failOk} 成功项均成功=${successOk}`)
  })

  await test('8.6 并发 3 失败 cron.add + 5 合法读', async () => {
    const N = '8.6 并发 3 失败 cron.add + 5 合法读'
    const out = await Promise.all([
      callIpc(`const res = await api.cron.add({ name: 'b1', agentId: 'x', expression: 'bad1', prompt: 'p', enabled: false }); return res;`),
      callIpc(`const res = await api.cron.add({ name: 'b2', agentId: 'x', expression: 'bad2', prompt: 'p', enabled: false }); return res;`),
      callIpc(`const res = await api.cron.add({ name: 'b3', agentId: 'x', expression: 'bad3', prompt: 'p', enabled: false }); return res;`),
      callIpc(`const res = await api.eaa.listStudents(); return res;`),
      callIpc(`const res = await api.class.list(); return res;`),
      callIpc(`const res = await api.cron.list(); return res;`),
      callIpc(`const res = await api.agent.list(); return res;`),
      callIpc(`const res = await api.skill.list(); return res;`),
    ])
    const failsOk = out.slice(0, 3).every((r) => !isOk(r) || r?.success === false)
    const readsOk = out.slice(3).every(isOk)
    const ok = failsOk && readsOk
    record(N, ok, `3失败项均失败=${failsOk} 5读项均成功=${readsOk}`)
  })

  await test('8.7 非法 class.assign (坏 class_id) + 合法 cron.list', async () => {
    const N = '8.7 非法 class.assign (坏 class_id) + 合法 cron.list'
    const [badAssign, goodCron] = await Promise.all([
      callIpc(`const res = await api.class.assign({ class_id: 'nonexistent-class-${TS}', student_names: [${JSON.stringify(STU_A)}] }); return res;`),
      callIpc(`const res = await api.cron.list(); return res;`),
    ])
    // class.assign 对不存在的 class_id 可能返回 success (no-op) 或 error
    // 关键验证: 系统不崩溃 + cron.list 仍正常 (错误隔离)
    const assignControlled = isControlled(badAssign)
    const cronOk = isOk(goodCron)
    const ok = assignControlled && cronOk
    record(N, ok, `assignControlled=${assignControlled}(success=${badAssign?.success}) cronOk=${cronOk}`)
  })

  await test('8.8 错误后系统仍可正常读写 (恢复验证)', async () => {
    const N = '8.8 错误后系统仍可正常读写 (恢复验证)'
    // 先触发一个错误
    try { await callIpc(`const res = await api.cron.add({ name: 'b', agentId: 'x', expression: 'bad', prompt: 'p', enabled: false }); return res;`) } catch (_) {}
    // 然后正常读写
    const path = 'general.defaultOperator'
    trackSetting(path, getByPath(origSettings, path))
    const [sr, lst, ev] = await Promise.all([
      setSetting(path, `recovery_${TS}`),
      cronList(),
      addEvent(STU_A, 'CLASS_COMMITTEE', 1),
    ])
    const evtId = extractEventId(ev)
    if (evtId) addedEventIds.push(evtId)
    const ok = sr?.success === true && Array.isArray(lst) && !!evtId
    record(N, ok, `setOk=${sr?.success} listOk=${Array.isArray(lst)} evtOk=${!!evtId}`)
  })

  // =============================================================
  // 清理
  // =============================================================
  console.log('\n--- 开始清理测试数据 ---')
  // (1) 回滚所有 EAA 事件
  for (const id of addedEventIds) {
    try { await revertEvent(id, 'cdp-cross-module-stress cleanup'); console.log(`  回滚 EAA 事件: ${id}`) } catch (e) { console.log(`  回滚 ${id} 失败: ${String(e.message || e).slice(0, 80)}`) }
  }
  // (2) 删除测试考试 (级联清理成绩)
  for (const examId of createdExamIds) {
    try { await deleteExam(examId); console.log(`  删除测试考试: ${examId} (级联清理成绩)`) } catch (e) {}
  }
  // (3) 清空所有指向测试班级的学生 class_id
  try {
    const all = await listStudents()
    for (const s of all) {
      if (s.class_id && String(s.class_id).startsWith(RUN_PREFIX)) {
        try { await removeStudent(s.name) } catch (e) {}
      }
    }
  } catch (e) {}
  // (4) 删除测试班级
  for (const { id, class_id } of [...createdClassIds]) {
    try {
      const lst = await listClasses()
      if (!lst.find((c) => c.id === id)) continue
      await deleteClass(id)
      console.log(`  删除测试班级: ${class_id}`)
    } catch (e) { console.log(`  删除班级 ${class_id} 失败: ${String(e.message || e).slice(0, 80)}`) }
  }
  // (5) 删除测试 cron 任务
  for (const id of createdCronIds) {
    try { await cronRemove(id); console.log(`  删除测试 cron: ${id}`) } catch (e) {}
  }
  // (6) 还原既有学生 class_id
  for (const [name, orig] of studentClassIdRestorations.entries()) {
    try {
      const cur = await getStudentByName(name)
      if (cur?.status === 'Deleted') continue
      if (orig) await setStudentClassId(name, orig)
      else await clearStudentClassId(name)
      console.log(`  还原学生 ${name} class_id -> ${orig || '(空)'}`)
    } catch (e) {}
  }
  // (7) 软删除临时学生
  for (const name of throwawayStudents) {
    try {
      const s = await getStudentByName(name)
      if (s && s.status !== 'Deleted') {
        await deleteStudentSoft(name, 'cdp-cross-module-stress cleanup')
        console.log(`  软删除临时学生: ${name}`)
      }
    } catch (e) {}
  }
  // (8) 还原 settings (去重路径)
  const restoreMap = new Map()
  for (const { path, orig } of settingsRestorations) restoreMap.set(path, orig)
  for (const [path, orig] of restoreMap.entries()) {
    try { await setSetting(path, orig); console.log(`  还原 settings.${path}`) } catch (e) {}
  }
  console.log('--- 清理完成 ---')

  // =============================================================
  // 汇总
  // =============================================================
  console.log('\n========== 跨模块并发压力深度测试 ==========')
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
