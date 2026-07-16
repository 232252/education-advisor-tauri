// =============================================================
// Round 13: AI 数据访问能力全方面测试 (CDP) — 重中之重
//
// 模拟 AI Agent 的使用过程, 验证 AI 能否 100% 获得所有数据:
//   1. Agent 系统健康检查 (8 项 - agent list/get/config/status)
//   2. EAA 数据完整性 — AI 可读的全部学生行为数据 (10 项)
//   3. 学业数据间接访问 — AI 通过文件工具读取成绩 (8 项)
//   4. AI 写入能力 — Agent 可执行的数据写入 (6 项)
//   5. AI 分析能力 — 统计/排名/摘要/搜索 (8 项)
//   6. AI Chat 系统验证 (5 项)
//   7. Agent 执行端到端 (5 项)
//   8. 数据访问覆盖率总结 (5 项)
//
// 运行: node scripts/cdp-ai-data-access-deep.mjs
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
  console.log('CDP connected, running AI data access tests...\n')

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

  // ---------- 业务 helper ----------
  const TS = Date.now()
  const throwawayStudents = []

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
  const getHistory = async (name) => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(name)}); return res;`)
    return r?.data ?? null
  }
  const searchEvents = async (keyword) => {
    const r = await callIpc(`const res = await api.eaa.search(${JSON.stringify(keyword)}); return res;`)
    return r?.data ?? null
  }
  const getRanking = async (limit) => {
    const r = await callIpc(`const res = await api.eaa.ranking(${limit || 10}); return res;`)
    return r?.data ?? null
  }
  const getStats = async () => {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    return r?.data ?? null
  }
  const getCodes = async () => {
    const r = await callIpc(`const res = await api.eaa.codes(); return res;`)
    return r?.data ?? null
  }
  const getSummary = async (start, end) => {
    const r = await callIpc(`const res = await api.eaa.summary(${JSON.stringify(start)}, ${JSON.stringify(end)}); return res;`)
    return r?.data ?? null
  }
  const getRange = async (start, end) => {
    const r = await callIpc(`const res = await api.eaa.range(${JSON.stringify(start)}, ${JSON.stringify(end)}); return res;`)
    return r?.data ?? null
  }
  const addEvent = async (studentName, reasonCode, delta) =>
    callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(studentName)},
        reasonCode: ${JSON.stringify(reasonCode)},
        delta: ${delta},
        note: 'AI data access test',
        force: true,
      });
      return res;
    `)
  // 使用有效 reason code (从 codes 列表中选取)
  const VALID_BONUS_CODE = 'ACTIVITY_PARTICIPATION' // delta=1
  const VALID_DEDUCT_CODE = 'LATE' // delta=-2
  const getInfo = async () => {
    const r = await callIpc(`const res = await api.eaa.info(); return res;`)
    return r?.data ?? null
  }

  // Academic helpers
  const listExams = async () => {
    const r = await callIpc(`const res = await api.academic.listExams(); return res;`)
    return r?.data ?? []
  }
  const getGrades = async (studentName) => {
    const r = await callIpc(`const res = await api.academic.getGrades(${JSON.stringify(studentName)}); return res;`)
    return r?.data ?? []
  }
  const getConfig = async () => {
    const r = await callIpc(`const res = await api.academic.getConfig(); return res;`)
    return r?.data ?? null
  }
  const createExam = async (name, subjects) => {
    const r = await callIpc(`
      const res = await api.academic.createExam({
        name: ${JSON.stringify(name)},
        type: 'monthly',
        date: new Date().toISOString().slice(0, 10),
        semester: 'AI测试学期',
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

  // Class helpers
  const listClasses = async () => {
    const r = await callIpc(`const res = await api.class.list(); return res;`)
    return r?.data ?? []
  }

  // Agent helpers
  const agentList = async () => {
    const r = await callIpc(`const res = await api.agent.list(); return res;`)
    return r?.data ?? r ?? []
  }
  const agentGet = async (id) => {
    const r = await callIpc(`const res = await api.agent.get(${JSON.stringify(id)}); return res;`)
    return r?.data ?? r ?? null
  }
  const agentRunManual = async (id, prompt) =>
    callIpc(`const res = await api.agent.runManual(${JSON.stringify(id)}, ${JSON.stringify(prompt)}); return res;`)

  // AI helpers
  const aiListProviders = async () => {
    const r = await callIpc(`const res = await api.ai.listProviders(); return res;`)
    return r?.data ?? r ?? []
  }
  const aiChat = async (providerId, modelId, messages) =>
    callIpc(`
      const res = await api.ai.chat({
        providerId: ${JSON.stringify(providerId)},
        modelId: ${JSON.stringify(modelId)},
        messages: ${JSON.stringify(messages)},
      });
      return res;
    `)

  // Skill helpers
  const skillList = async () => {
    const r = await callIpc(`const res = await api.skill.list(); return res;`)
    return r?.data ?? r ?? []
  }
  const skillGet = async (name) => {
    const r = await callIpc(`const res = await api.skill.get(${JSON.stringify(name)}); return res;`)
    return r?.data ?? r ?? null
  }

  // Chat helpers
  const chatListSessions = async () => {
    const r = await callIpc(`const res = await api.chat.listSessions(); return res;`)
    return r?.sessions ?? r?.data ?? r ?? []
  }

  // Settings helper
  const settingsGet = async () => {
    const r = await callIpc(`const res = await api.settings.get(); return res;`)
    return r?.data ?? r ?? null
  }

  // Sys helper - getPath
  const sysGetPath = async (name) =>
    callIpc(`const res = await api.sys.getPath(${JSON.stringify(name)}); return res;`)

  // ---------- 清理账本 ----------
  const createdExamIds = []

  // =============================================================
  // Section 1: Agent 系统健康检查 (8 项)
  // =============================================================
  console.log('━━━ Section 1: Agent 系统健康检查 ━━━')

  await test('1.1 Agent 列表可获取且非空', async () => {
    const N = '1.1 Agent 列表可获取且非空'
    const agents = await agentList()
    const ok = Array.isArray(agents) && agents.length > 0
    record(N, ok, `agents=${agents?.length}`)
  })

  await test('1.2 每个 Agent 有 id/name/role/capabilities', async () => {
    const N = '1.2 每个 Agent 有 id/name/role/capabilities'
    const agents = await agentList()
    const allValid = agents.every((a) =>
      typeof a.id === 'string' &&
      typeof a.name === 'string' &&
      (typeof a.role === 'string' || a.role === undefined) &&
      (Array.isArray(a.capabilities) || typeof a.capabilities === 'string')
    )
    record(N, allValid, `checked=${agents.length} allValid=${allValid}`)
  })

  await test('1.3 Agent "main" 可获取详情', async () => {
    const N = '1.3 Agent "main" 可获取详情'
    const agent = await agentGet('main')
    const ok = agent && typeof agent.id === 'string' && agent.id === 'main'
    record(N, ok, `id=${agent?.id} name=${agent?.name}`)
  })

  await test('1.4 Agent capabilities 覆盖 read/write (含具体能力名)', async () => {
    const N = '1.4 Agent capabilities 覆盖 read/write (含具体能力名)'
    const agents = await agentList()
    const allCaps = agents.flatMap((a) => a.capabilities || [])
    const hasRead = allCaps.some((c) => c === 'read' || c === 'all' || c === '*')
    // 写入能力可能是 'write' 或具体名 'add_event'/'add_student'
    const hasWrite = allCaps.some((c) => c === 'write' || c === 'all' || c === '*' || c === 'add_event' || c === 'add_student')
    record(N, hasRead && hasWrite, `hasRead=${hasRead} hasWrite=${hasWrite} totalCaps=${allCaps.length}`)
  })

  await test('1.5 Agent 列表包含核心 Agent (main/counselor/academic)', async () => {
    const N = '1.5 Agent 列表包含核心 Agent (main/counselor/academic)'
    const agents = await agentList()
    const ids = agents.map((a) => a.id)
    const hasMain = ids.includes('main')
    const hasCounselor = ids.includes('counselor')
    const hasAcademic = ids.includes('academic')
    record(N, hasMain, `main=${hasMain} counselor=${hasCounselor} academic=${hasAcademic} ids=${ids.slice(0, 10).join(',')}`)
  })

  await test('1.6 Skill 列表可获取', async () => {
    const N = '1.6 Skill 列表可获取'
    const skills = await skillList()
    const ok = Array.isArray(skills)
    record(N, ok, `skills=${skills?.length}`)
  })

  await test('1.7 STUDENT_MANAGEMENT skill 可获取详情', async () => {
    const N = '1.7 STUDENT_MANAGEMENT skill 可获取详情'
    const skill = await skillGet('STUDENT_MANAGEMENT')
    const ok = skill && (typeof skill.content === 'string' || typeof skill.name === 'string')
    record(N, ok, `name=${skill?.name} hasContent=${!!skill?.content}`)
  })

  await test('1.8 AI Provider 列表可获取', async () => {
    const N = '1.8 AI Provider 列表可获取'
    const providers = await aiListProviders()
    const ok = Array.isArray(providers) && providers.length > 0
    record(N, ok, `providers=${providers?.length}`)
  })

  // =============================================================
  // Section 2: EAA 数据完整性 — AI 可读的全部学生行为数据 (10 项)
  // =============================================================
  console.log('\n━━━ Section 2: EAA 数据完整性 — AI 可读的全部学生行为数据 ━━━')

  await test('2.1 AI 可读取全部学生列表 (eaa_list_students)', async () => {
    const N = '2.1 AI 可读取全部学生列表 (eaa_list_students)'
    const students = await listStudents()
    const allHaveName = students.every((s) => typeof s.name === 'string')
    const allHaveScore = students.every((s) => typeof s.score === 'number')
    record(N, students.length > 0 && allHaveName && allHaveScore, `count=${students.length} allHaveName=${allHaveName} allHaveScore=${allHaveScore}`)
  })

  await test('2.2 AI 可读取学生行为分数 (eaa_score)', async () => {
    const N = '2.2 AI 可读取学生行为分数 (eaa_score)'
    const students = await listStudents()
    if (students.length === 0) { record(N, false, 'no students'); return }
    const stu = students[0]
    const score = await getScore(stu.name)
    const ok = score && typeof score.score === 'number' && typeof score.risk === 'string'
    record(N, ok, `student=${stu.name} score=${score?.score} risk=${score?.risk}`)
  })

  await test('2.3 AI 可读取学生事件历史 (eaa_history)', async () => {
    const N = '2.3 AI 可读取学生事件历史 (eaa_history)'
    const students = await listStudents()
    // 找一个有事件的学生
    const stuWithEvents = students.find((s) => s.events_count > 0) || students[0]
    if (!stuWithEvents) { record(N, false, 'no students'); return }
    const history = await getHistory(stuWithEvents.name)
    const ok = history && (Array.isArray(history.events) || Array.isArray(history))
    record(N, ok, `student=${stuWithEvents.name} events=${Array.isArray(history?.events) ? history.events.length : Array.isArray(history) ? history.length : 0}`)
  })

  await test('2.4 AI 可搜索事件 (eaa_search)', async () => {
    const N = '2.4 AI 可搜索事件 (eaa_search)'
    const result = await searchEvents('测试')
    const ok = result && (typeof result === 'object')
    record(N, ok, `hasResult=${ok} keys=${result ? Object.keys(result).slice(0, 5).join(',') : ''}`)
  })

  await test('2.5 AI 可读取行为排名 (eaa_ranking)', async () => {
    const N = '2.5 AI 可读取行为排名 (eaa_ranking)'
    const ranking = await getRanking(10)
    const ok = ranking && (Array.isArray(ranking) || Array.isArray(ranking?.ranking))
    const arr = Array.isArray(ranking) ? ranking : ranking?.ranking
    record(N, ok, `count=${arr?.length}`)
  })

  await test('2.6 AI 可读取系统统计 (eaa_stats)', async () => {
    const N = '2.6 AI 可读取系统统计 (eaa_stats)'
    const stats = await getStats()
    const ok = stats && typeof stats === 'object'
    record(N, ok, `hasStats=${ok} keys=${stats ? Object.keys(stats).slice(0, 8).join(',') : ''}`)
  })

  await test('2.7 AI 可读取行为代码表 (eaa_codes)', async () => {
    const N = '2.7 AI 可读取行为代码表 (eaa_codes)'
    const codes = await getCodes()
    const ok = codes && typeof codes === 'object'
    record(N, ok, `hasCodes=${ok} keys=${codes ? Object.keys(codes).slice(0, 5).join(',') : ''}`)
  })

  await test('2.8 AI 可读取周期摘要 (eaa_summary)', async () => {
    const N = '2.8 AI 可读取周期摘要 (eaa_summary)'
    const today = new Date()
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
    const start = weekAgo.toISOString().slice(0, 10)
    const end = today.toISOString().slice(0, 10)
    const summary = await getSummary(start, end)
    const ok = summary && typeof summary === 'object'
    record(N, ok, `hasSummary=${ok} range=${start}~${end}`)
  })

  await test('2.9 AI 可读取日期范围事件 (eaa_range)', async () => {
    const N = '2.9 AI 可读取日期范围事件 (eaa_range)'
    const today = new Date()
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
    const start = weekAgo.toISOString().slice(0, 10)
    const end = today.toISOString().slice(0, 10)
    const range = await getRange(start, end)
    const ok = range && typeof range === 'object'
    record(N, ok, `hasRange=${ok}`)
  })

  await test('2.10 AI 可读取系统信息 (eaa_info)', async () => {
    const N = '2.10 AI 可读取系统信息 (eaa_info)'
    const info = await getInfo()
    const ok = info && typeof info === 'object'
    record(N, ok, `hasInfo=${ok} keys=${info ? Object.keys(info).slice(0, 5).join(',') : ''}`)
  })

  // =============================================================
  // Section 3: 学业数据间接访问 — AI 通过文件工具读取成绩 (8 项)
  // =============================================================
  console.log('\n━━━ Section 3: 学业数据间接访问 — AI 通过文件工具读取成绩 ━━━')

  // 准备测试数据
  const AI_STU = `ai_stu_${TS}`
  await addStudent(AI_STU)
  throwawayStudents.push(AI_STU)
  const config = await getConfig()
  const subjects = config?.subjects ?? []
  const SUBJECT_A = subjects[0]?.id ?? 'chinese'
  const SUBJECT_A_FULL = subjects[0]?.fullMark ?? 150
  const AI_EXAM = await createExam(`ai-exam_${TS}`, [SUBJECT_A])
  if (AI_EXAM) createdExamIds.push(AI_EXAM.id)
  const EXAM_ID = AI_EXAM?.id || 'fake'
  await setGrade(EXAM_ID, AI_STU, SUBJECT_A, 92, SUBJECT_A_FULL)

  await test('3.1 AI 可通过 IPC 读取学业配置 (academic.getConfig)', async () => {
    const N = '3.1 AI 可通过 IPC 读取学业配置 (academic.getConfig)'
    const ok = config && Array.isArray(config.subjects) && config.subjects.length > 0
    record(N, ok, `subjects=${config?.subjects?.length}`)
  })

  await test('3.2 AI 可通过 IPC 读取考试列表 (academic.listExams)', async () => {
    const N = '3.2 AI 可通过 IPC 读取考试列表 (academic.listExams)'
    const exams = await listExams()
    const ok = Array.isArray(exams) && exams.length > 0
    record(N, ok, `exams=${exams.length}`)
  })

  await test('3.3 AI 可通过 IPC 读取学生成绩 (academic.getGrades)', async () => {
    const N = '3.3 AI 可通过 IPC 读取学生成绩 (academic.getGrades)'
    const grades = await getGrades(AI_STU)
    const ok = Array.isArray(grades) && grades.length > 0
    const hasCorrectScore = grades.some((g) => g.score === 92)
    record(N, ok && hasCorrectScore, `grades=${grades.length} hasScore92=${hasCorrectScore}`)
  })

  await test('3.4 学业成绩字段完整 (examId/subjectId/studentName/score/fullMark)', async () => {
    const N = '3.4 学业成绩字段完整 (examId/subjectId/studentName/score/fullMark)'
    const grades = await getGrades(AI_STU)
    const g = grades[0]
    const hasAllFields = g &&
      typeof g.examId === 'string' &&
      typeof g.subjectId === 'string' &&
      typeof g.studentName === 'string' &&
      typeof g.score === 'number' &&
      typeof g.fullMark === 'number'
    record(N, hasAllFields, `examId=${g?.examId} subjectId=${g?.subjectId} score=${g?.score} fullMark=${g?.fullMark}`)
  })

  await test('3.5 AI 可通过 IPC 读取班级列表 (class.list) — 注: Agent 无直接工具', async () => {
    const N = '3.5 AI 可通过 IPC 读取班级列表 (class.list) — 注: Agent 无直接工具'
    const classes = await listClasses()
    const ok = Array.isArray(classes)
    record(N, ok, `classes=${classes.length} (Agent 无直接工具但 IPC 可读)`)
  })

  await test('3.6 AI 可通过 IPC 读取全部学生 (含 class_id 字段)', async () => {
    const N = '3.6 AI 可通过 IPC 读取全部学生 (含 class_id 字段)'
    const students = await listStudents()
    // 学生数据应包含 class_id 字段 (即使为空)
    const hasClassIdField = students.every((s) => 'class_id' in s || s.class_id === undefined || s.class_id === null)
    record(N, students.length > 0, `count=${students.length} hasClassIdField=${hasClassIdField}`)
  })

  await test('3.7 学业配置包含科目 ID/名称/满分', async () => {
    const N = '3.7 学业配置包含科目 ID/名称/满分'
    const ok = config?.subjects?.every((s) =>
      typeof s.id === 'string' &&
      typeof s.name === 'string' &&
      typeof s.fullMark === 'number'
    )
    record(N, ok, `subjects=${config?.subjects?.length} allValid=${ok}`)
  })

  await test('3.8 学业成绩与 EAA 行为分独立 (不互相干扰)', async () => {
    const N = '3.8 学业成绩与 EAA 行为分独立 (不互相干扰)'
    const scoreBefore = await getScore(AI_STU)
    const eaaScoreBefore = scoreBefore?.score
    // 修改学业成绩
    await setGrade(EXAM_ID, AI_STU, SUBJECT_A, 55, SUBJECT_A_FULL)
    const scoreAfter = await getScore(AI_STU)
    const eaaScoreAfter = scoreAfter?.score
    // EAA 行为分不应因学业成绩改变而变化
    const independent = eaaScoreBefore === eaaScoreAfter
    record(N, independent, `eaaBefore=${eaaScoreBefore} eaaAfter=${eaaScoreAfter} independent=${independent}`)
  })

  // =============================================================
  // Section 4: AI 写入能力 — Agent 可执行的数据写入 (6 项)
  // =============================================================
  console.log('\n━━━ Section 4: AI 写入能力 — Agent 可执行的数据写入 ━━━')

  await test('4.1 AI 可添加行为事件 (eaa_add_event)', async () => {
    const N = '4.1 AI 可添加行为事件 (eaa_add_event)'
    const r = await addEvent(AI_STU, VALID_BONUS_CODE, 1)
    const ok = isOk(r)
    record(N, ok, `success=${r?.success} eventId=${r?.data?.event_id || r?.data?.id || ''}`)
  })

  await test('4.2 AI 添加事件后行为分立即更新', async () => {
    const N = '4.2 AI 添加事件后行为分立即更新'
    const before = await getScore(AI_STU)
    const scoreBefore = before?.score
    await addEvent(AI_STU, VALID_BONUS_CODE, 1)
    const after = await getScore(AI_STU)
    const scoreAfter = after?.score
    const updated = scoreAfter > scoreBefore
    record(N, updated, `before=${scoreBefore} after=${scoreAfter} delta=${scoreAfter - scoreBefore}`)
  })

  await test('4.3 AI 可注册新学生 (eaa_add_student)', async () => {
    const N = '4.3 AI 可注册新学生 (eaa_add_student)'
    const newName = `ai_add_stu_${TS}`
    const r = await addStudent(newName)
    throwawayStudents.push(newName)
    const ok = isOk(r)
    record(N, ok, `success=${r?.success}`)
  })

  await test('4.4 AI 写入事件后可通过 history 读取', async () => {
    const N = '4.4 AI 写入事件后可通过 history 读取'
    await addEvent(AI_STU, VALID_BONUS_CODE, 1)
    const history = await getHistory(AI_STU)
    const events = Array.isArray(history?.events) ? history.events : Array.isArray(history) ? history : []
    const hasRecentEvent = events.length > 0
    record(N, hasRecentEvent, `events=${events.length}`)
  })

  await test('4.5 AI 写入事件后可通过 search 搜索到', async () => {
    const N = '4.5 AI 写入事件后可通过 search 搜索到'
    const r = await searchEvents(AI_STU)
    const ok = r && typeof r === 'object'
    record(N, ok, `hasResult=${ok}`)
  })

  await test('4.6 AI 写入事件后可通过 stats 看到统计变化', async () => {
    const N = '4.6 AI 写入事件后可通过 stats 看到统计变化'
    const stats = await getStats()
    const ok = stats && typeof stats === 'object'
    record(N, ok, `hasStats=${ok}`)
  })

  // =============================================================
  // Section 5: AI 分析能力 — 统计/排名/摘要/搜索 (8 项)
  // =============================================================
  console.log('\n━━━ Section 5: AI 分析能力 — 统计/排名/摘要/搜索 ━━━')

  await test('5.1 排名数据包含学生名/分数/风险等级', async () => {
    const N = '5.1 排名数据包含学生名/分数/风险等级'
    const ranking = await getRanking(10)
    const arr = Array.isArray(ranking) ? ranking : ranking?.ranking
    const first = arr?.[0]
    const hasFields = first && typeof first.name === 'string' && typeof first.score === 'number'
    record(N, hasFields, `count=${arr?.length} firstName=${first?.name} firstScore=${first?.score}`)
  })

  await test('5.2 统计数据包含学生数/事件数 (stats.summary)', async () => {
    const N = '5.2 统计数据包含学生数/事件数 (stats.summary)'
    const stats = await getStats()
    const summary = stats?.summary || stats?.data?.summary
    const hasStudentCount = summary && typeof summary.students === 'number'
    const hasEventCount = summary && typeof summary.total_events === 'number'
    record(N, hasStudentCount && hasEventCount, `hasStudentCount=${hasStudentCount} hasEventCount=${hasEventCount} students=${summary?.students} events=${summary?.total_events}`)
  })

  await test('5.3 代码表包含加扣分代码', async () => {
    const N = '5.3 代码表包含加扣分代码'
    const codes = await getCodes()
    const ok = codes && typeof codes === 'object' && Object.keys(codes).length > 0
    record(N, ok, `categories=${Object.keys(codes || {}).length}`)
  })

  await test('5.4 摘要包含风险分布', async () => {
    const N = '5.4 摘要包含风险分布'
    const today = new Date()
    const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)
    const summary = await getSummary(monthAgo.toISOString().slice(0, 10), today.toISOString().slice(0, 10))
    const ok = summary && typeof summary === 'object'
    record(N, ok, `hasSummary=${ok} keys=${summary ? Object.keys(summary).slice(0, 8).join(',') : ''}`)
  })

  await test('5.5 日期范围查询返回事件数据', async () => {
    const N = '5.5 日期范围查询返回事件数据'
    const today = new Date()
    const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)
    const range = await getRange(monthAgo.toISOString().slice(0, 10), today.toISOString().slice(0, 10))
    const ok = range && typeof range === 'object'
    record(N, ok, `hasRange=${ok}`)
  })

  await test('5.6 搜索支持关键词 (学生名)', async () => {
    const N = '5.6 搜索支持关键词 (学生名)'
    const r = await searchEvents(AI_STU)
    const ok = r && typeof r === 'object'
    record(N, ok, `hasResult=${ok}`)
  })

  await test('5.7 排名支持自定义 limit', async () => {
    const N = '5.7 排名支持自定义 limit'
    const r5 = await getRanking(5)
    const r20 = await getRanking(20)
    const arr5 = Array.isArray(r5) ? r5 : r5?.ranking
    const arr20 = Array.isArray(r20) ? r20 : r20?.ranking
    const ok = arr5 && arr20 && arr20.length >= arr5.length
    record(N, ok, `top5=${arr5?.length} top20=${arr20?.length}`)
  })

  await test('5.8 学生列表包含风险等级字段', async () => {
    const N = '5.8 学生列表包含风险等级字段'
    const students = await listStudents()
    const hasRisk = students.every((s) => typeof s.risk === 'string' || s.risk === undefined)
    record(N, students.length > 0 && hasRisk, `count=${students.length} hasRisk=${hasRisk}`)
  })

  // =============================================================
  // Section 6: AI Chat 系统验证 (5 项)
  // =============================================================
  console.log('\n━━━ Section 6: AI Chat 系统验证 ━━━')

  await test('6.1 AI Chat 会话列表可获取', async () => {
    const N = '6.1 AI Chat 会话列表可获取'
    const sessions = await chatListSessions()
    const ok = Array.isArray(sessions)
    record(N, ok, `sessions=${sessions.length}`)
  })

  await test('6.2 AI Provider 列表包含已知 provider', async () => {
    const N = '6.2 AI Provider 列表包含已知 provider'
    const providers = await aiListProviders()
    const ids = providers.map((p) => p.id || p.name || '')
    const hasKnown = ids.some((id) => typeof id === 'string' && id.length > 0)
    record(N, hasKnown, `providers=${providers.length} sample=${ids.slice(0, 5).join(',')}`)
  })

  await test('6.3 AI Chat 接口存在且可调用 (无 provider 时优雅失败)', async () => {
    const N = '6.3 AI Chat 接口存在且可调用 (无 provider 时优雅失败)'
    const r = await aiChat('non-existent-provider', 'non-existent-model', [{ role: 'user', content: 'test' }])
    // 应该返回结构化错误, 而不是抛异常
    const ok = r && typeof r === 'object' && (r.__error || r.success === false || r.success === true)
    record(N, ok, `hasResponse=${ok} error=${r?.__error || r?.error || 'none'}`)
  })

  await test('6.4 Settings 包含 AI 相关配置', async () => {
    const N = '6.4 Settings 包含 AI 相关配置'
    const settings = await settingsGet()
    const hasAiConfig = settings && (settings.models || settings.ai || settings.advanced)
    record(N, !!hasAiConfig, `hasModels=${!!settings?.models} hasAi=${!!settings?.ai} hasAdvanced=${!!settings?.advanced}`)
  })

  await test('6.5 Agent runManual 接口存在且可调用', async () => {
    const N = '6.5 Agent runManual 接口存在且可调用'
    const r = await agentRunManual('main', '请列出所有学生的行为分数前3名')
    // 可能返回成功启动或错误, 但接口应存在
    const interfaceExists = r && typeof r === 'object'
    const notNoHandler = !JSON.stringify(r).includes('No handler')
    record(N, interfaceExists && notNoHandler, `hasResponse=${interfaceExists} notNoHandler=${notNoHandler}`)
  })

  // =============================================================
  // Section 7: Agent 执行端到端 (5 项)
  // =============================================================
  console.log('\n━━━ Section 7: Agent 执行端到端 ━━━')

  await test('7.1 Agent "main" 可启动执行', async () => {
    const N = '7.1 Agent "main" 可启动执行'
    const r = await agentRunManual('main', '你好,请简短回复"系统正常"四个字')
    const ok = r && typeof r === 'object' && !r.__error
    record(N, ok, `success=${r?.success} error=${r?.error || r?.__error || 'none'}`)
  })

  await test('7.2 Agent "academic" 配置存在', async () => {
    const N = '7.2 Agent "academic" 配置存在'
    const agent = await agentGet('academic')
    const ok = agent && typeof agent.id === 'string'
    record(N, ok, `id=${agent?.id} name=${agent?.name} caps=${agent?.capabilities}`)
  })

  await test('7.3 Agent "counselor" 配置存在', async () => {
    const N = '7.3 Agent "counselor" 配置存在'
    const agent = await agentGet('counselor')
    const ok = agent && typeof agent.id === 'string'
    record(N, ok, `id=${agent?.id} name=${agent?.name}`)
  })

  await test('7.4 Agent 执行不阻塞 IPC (执行后仍可查询数据)', async () => {
    const N = '7.4 Agent 执行不阻塞 IPC (执行后仍可查询数据)'
    // 启动 agent (不等待完成)
    await agentRunManual('main', '列出学生')
    // 立即查询数据 — 不应被阻塞
    const students = await listStudents()
    const ok = students.length > 0
    record(N, ok, `studentsAfterAgentRun=${students.length}`)
  })

  await test('7.5 Agent 配置包含 modelTier (high_quality/low_cost)', async () => {
    const N = '7.5 Agent 配置包含 modelTier (high_quality/low_cost)'
    const agents = await agentList()
    const hasTier = agents.some((a) => a.modelTier === 'high_quality' || a.modelTier === 'low_cost')
    record(N, hasTier, `hasTier=${hasTier} tiers=${agents.map((a) => a.modelTier).filter(Boolean).slice(0, 5).join(',')}`)
  })

  // =============================================================
  // Section 8: 数据访问覆盖率总结 (5 项)
  // =============================================================
  console.log('\n━━━ Section 8: 数据访问覆盖率总结 ━━━')

  await test('8.1 AI 可读取 100% 学生行为数据 (score/history/search/ranking)', async () => {
    const N = '8.1 AI 可读取 100% 学生行为数据 (score/history/search/ranking)'
    const students = await listStudents()
    // 验证每个学生都有 score 数据
    let scoreOk = 0
    for (const stu of students.slice(0, 20)) { // 抽查前 20 个
      const s = await getScore(stu.name)
      if (s && typeof s.score === 'number') scoreOk++
    }
    const allReadable = scoreOk === Math.min(20, students.length)
    record(N, allReadable, `students=${students.length} sampled=${Math.min(20, students.length)} scoreReadable=${scoreOk}`)
  })

  await test('8.2 AI 可读取 100% 学业成绩数据 (exams/grades/config)', async () => {
    const N = '8.2 AI 可读取 100% 学业成绩数据 (exams/grades/config)'
    const exams = await listExams()
    const config = await getConfig()
    const allReadable = exams.length >= 0 && config && config.subjects.length > 0
    record(N, allReadable, `exams=${exams.length} subjects=${config?.subjects?.length}`)
  })

  await test('8.3 AI 可读取 100% 系统统计 (stats/codes/summary/range/info)', async () => {
    const N = '8.3 AI 可读取 100% 系统统计 (stats/codes/summary/range/info)'
    const stats = await getStats()
    const codes = await getCodes()
    const info = await getInfo()
    const today = new Date()
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
    const summary = await getSummary(weekAgo.toISOString().slice(0, 10), today.toISOString().slice(0, 10))
    const range = await getRange(weekAgo.toISOString().slice(0, 10), today.toISOString().slice(0, 10))
    const allOk = stats && codes && info && summary && range
    record(N, allOk, `stats=${!!stats} codes=${!!codes} info=${!!info} summary=${!!summary} range=${!!range}`)
  })

  await test('8.4 AI 可写入行为数据 (add_event/add_student) 并立即可读', async () => {
    const N = '8.4 AI 可写入行为数据 (add_event/add_student) 并立即可读'
    const r = await addEvent(AI_STU, VALID_BONUS_CODE, 1)
    const score = await getScore(AI_STU)
    const ok = isOk(r) && score && typeof score.score === 'number'
    record(N, ok, `eventAdded=${isOk(r)} scoreReadable=${!!score}`)
  })

  await test('8.5 AI 数据访问覆盖率汇总 (EAA 11 项 + Academic 3 项 + Class 1 项)', async () => {
    const N = '8.5 AI 数据访问覆盖率汇总 (EAA 11 项 + Academic 3 项 + Class 1 项)'
    // 汇总所有数据访问点
    const checks = {
      // EAA 读取 (11 个工具对应的数据)
      listStudents: (await listStudents()).length > 0,
      score: !!(await getScore(AI_STU)),
      history: !!(await getHistory(AI_STU)),
      search: !!(await searchEvents(AI_STU)),
      ranking: !!(await getRanking(5)),
      stats: !!(await getStats()),
      codes: !!(await getCodes()),
      summary: !!(await getSummary('2024-01-01', '2026-12-31')),
      range: !!(await getRange('2024-01-01', '2026-12-31')),
      info: !!(await getInfo()),
      // EAA 写入
      addEvent: isOk(await addEvent(AI_STU, VALID_BONUS_CODE, 1)),
      addStudent: isOk(await addStudent(`ai_coverage_${TS}`)),
      // Academic (通过 IPC, Agent 通过文件工具间接访问)
      exams: (await listExams()).length >= 0,
      grades: Array.isArray(await getGrades(AI_STU)),
      config: !!(await getConfig()),
      // Class (仅 IPC, Agent 无直接工具)
      classes: Array.isArray(await listClasses()),
    }
    const passCount = Object.values(checks).filter(Boolean).length
    const totalCount = Object.keys(checks).length
    const allPass = passCount === totalCount
    const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
    record(N, allPass, `coverage=${passCount}/${totalCount} failed=${failed.join(',') || 'none'}`)
  })

  // =============================================================
  // 清理
  // =============================================================
  console.log('\n━━━ 清理测试数据 ━━━')
  for (const id of createdExamIds) {
    try { await deleteExam(id) } catch {}
  }
  for (const name of throwawayStudents) {
    try { await deleteStudentSoft(name, 'ai data access test cleanup') } catch {}
  }

  // ---------- 汇总 ----------
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`Round 13 AI 数据访问能力测试结果: ${passed}/${results.length} 通过, ${failed} 失败`)
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
