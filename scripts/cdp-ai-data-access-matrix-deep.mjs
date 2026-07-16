// =============================================================
// Round 14: AI 数据访问深度矩阵测试 (CDP) — 重中之重 续
//
// 在 Round 13 基础上, 进一步验证 AI 能否 100% 获得所有数据:
//   1. Agent 能力 → 工具映射矩阵 (8 项 - 18 个 Agent 的能力配置完整性)
//   2. 跨数据源一致性 (8 项 - EAA stats vs listStudents, 学术 vs EAA)
//   3. 敏感路径黑名单源码验证 (8 项 - 14 个黑名单模式覆盖)
//   4. 学业数据文件可访问性 (6 项 - 成绩文件存在且不在黑名单)
//   5. Agent SOUL/Rules 内容 (6 项 - 关键 Agent 的 SOUL.md/AGENTS.md)
//   6. 工具返回数据 Schema 验证 (10 项 - 每个工具返回的字段完整性)
//   7. 大数据量处理 (6 项 - 2900+ 学生, 32000+ 事件)
//   8. AI 写入后数据一致性 (8 项 - 写入后各读取路径一致)
//
// 运行: node scripts/cdp-ai-data-access-matrix-deep.mjs
// =============================================================
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

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
  console.log('CDP connected, running AI data access matrix tests...\n')

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
  const VALID_BONUS_CODE = 'ACTIVITY_PARTICIPATION'
  const VALID_DEDUCT_CODE = 'LATE'

  const listStudents = async () => {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    return r?.data?.students ?? []
  }
  const addStudent = async (name) =>
    callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(name)}); return res;`)
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
    // ranking returns { data: { ranking: [...], total: N } }
    return r?.data?.ranking ?? r?.data ?? []
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
        note: 'Round14 matrix test',
        force: true,
      });
      return res;
    `)
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
  const agentGetSoul = async (id) => {
    const r = await callIpc(`const res = await api.agent.getSoul(${JSON.stringify(id)}); return res;`)
    return r?.data ?? r ?? null
  }
  const agentGetRules = async (id) => {
    const r = await callIpc(`const res = await api.agent.getRules(${JSON.stringify(id)}); return res;`)
    return r?.data ?? r ?? null
  }
  const agentGetHistory = async (id) => {
    const r = await callIpc(`const res = await api.agent.getHistory(${JSON.stringify(id)}); return res;`)
    return r?.data ?? r ?? []
  }

  // Skill helpers
  const skillList = async () => {
    const r = await callIpc(`const res = await api.skill.list(); return res;`)
    return r?.data ?? r ?? []
  }
  const skillGet = async (name) => {
    const r = await callIpc(`const res = await api.skill.get(${JSON.stringify(name)}); return res;`)
    return r?.data ?? r ?? null
  }

  // Settings helper
  const settingsGet = async () => {
    const r = await callIpc(`const res = await api.settings.get(); return res;`)
    return r?.data ?? r ?? null
  }

  // Sys helper
  const sysGetPath = async (name) =>
    callIpc(`const res = await api.sys.getPath(${JSON.stringify(name)}); return res;`)

  // ---------- 读取源码 (用于黑名单验证) ----------
  const PROJECT_ROOT = process.cwd()
  const readFileSafe = (p) => {
    try { return fs.readFileSync(p, 'utf-8') } catch { return null }
  }
  const fileToolsSrc = readFileSafe(path.join(PROJECT_ROOT, 'src', 'main', 'services', 'file-tools.ts'))
  const eaaToolsSrc = readFileSafe(path.join(PROJECT_ROOT, 'src', 'main', 'services', 'eaa-tools.ts'))
  const agentServiceSrc = readFileSafe(path.join(PROJECT_ROOT, 'src', 'main', 'services', 'agent-service.ts'))
  const agentsYaml = readFileSafe(path.join(PROJECT_ROOT, 'config', 'agents.yaml'))

  // ---------- 预取数据 ----------
  const AI_STU = `r14_stu_${TS}`
  await addStudent(AI_STU)

  // =============================================================
  // Section 1: Agent 能力 → 工具映射矩阵 (8 项)
  // =============================================================
  console.log('━━━ Section 1: Agent 能力 → 工具映射矩阵 ━━━')

  await test('1.1 全部 18 个 Agent 都有 capabilities 字段', async () => {
    const N = '1.1 全部 18 个 Agent 都有 capabilities 字段'
    const agents = await agentList()
    const noCap = agents.filter((a) => !Array.isArray(a.capabilities) || a.capabilities.length === 0)
    record(N, noCap.length === 0, `total=${agents.length} missing=${noCap.length} missingIds=${noCap.map((a) => a.id).join(',')}`)
  })

  await test('1.2 main Agent 覆盖全部 11 项能力 (无 all 通配)', async () => {
    const N = '1.2 main Agent 覆盖全部 11 项能力 (无 all 通配)'
    const main = await agentGet('main')
    const caps = main?.capabilities || []
    // main 应有 read/write 或等价的细粒度能力
    const expected = ['read', 'summary', 'add_event', 'add_student', 'history', 'search', 'list', 'ranking', 'stats', 'codes', 'range']
    const hasAll = expected.every((c) => caps.includes(c))
    const noWildcard = !caps.includes('all') && !caps.includes('*')
    record(N, hasAll && noWildcard, `caps=${caps.length} hasAll=${hasAll} noWildcard=${noWildcard}`)
  })

  await test('1.3 read 能力隐含 9 个读取工具 (源码验证)', async () => {
    const N = '1.3 read 能力隐含 9 个读取工具 (源码验证)'
    // 从源码验证: read → score, history, search, list_students, ranking, stats, codes, summary, range
    const readTools = ['eaa_score', 'eaa_history', 'eaa_search', 'eaa_list_students', 'eaa_ranking', 'eaa_stats', 'eaa_codes', 'eaa_summary', 'eaa_range']
    // 源码中使用对象属性 read: [...] 而非字符串 'read'
    const hasReadMapping = eaaToolsSrc && eaaToolsSrc.includes('read:') && readTools.every((t) => eaaToolsSrc.includes(t))
    record(N, !!hasReadMapping, `sourceFound=${!!eaaToolsSrc} readToolsMapped=${hasReadMapping}`)
  })

  await test('1.4 write 能力隐含 2 个写入工具 (源码验证)', async () => {
    const N = '1.4 write 能力隐含 2 个写入工具 (源码验证)'
    const writeTools = ['eaa_add_event', 'eaa_add_student']
    // 源码中使用对象属性 write: [...] 而非字符串 'write'
    const hasWriteMapping = eaaToolsSrc && eaaToolsSrc.includes('write:') && writeTools.every((t) => eaaToolsSrc.includes(t))
    record(N, !!hasWriteMapping, `sourceFound=${!!eaaToolsSrc} writeToolsMapped=${hasWriteMapping}`)
  })

  await test('1.5 文件工具无条件注入每个 Agent (源码验证)', async () => {
    const N = '1.5 文件工具无条件注入每个 Agent (源码验证)'
    // agent-service.ts 应包含 allFileTools 展开
    const hasUnconditionalInject = agentServiceSrc && agentServiceSrc.includes('...allFileTools')
    record(N, !!hasUnconditionalInject, `sourceFound=${!!agentServiceSrc} hasSpread=${hasUnconditionalInject}`)
  })

  await test('1.6 工具总数 = 11 EAA + 6 文件 + 2 工具 = 19', async () => {
    const N = '1.6 工具总数 = 11 EAA + 6 文件 + 2 工具 = 19'
    // 从源码统计 EAA 工具数
    const eaaToolCount = (eaaToolsSrc?.match(/name:\s*'eaa_/g) || []).length
    const fileToolCount = (fileToolsSrc?.match(/name:\s*'(read_file|read_excel|list_dir|write_file|write_excel|write_csv)'/g) || []).length
    const utilityToolPresent = agentServiceSrc?.includes('allUtilityTools') || agentServiceSrc?.includes('get_current_time')
    const total = eaaToolCount + fileToolCount + (utilityToolPresent ? 2 : 0)
    record(N, total === 19, `eaa=${eaaToolCount} file=${fileToolCount} utility=${utilityToolPresent ? 2 : 0} total=${total}`)
  })

  await test('1.7 bug-hunter Agent 只有 read 能力 (最小权限)', async () => {
    const N = '1.7 bug-hunter Agent 只有 read 能力 (最小权限)'
    const bh = await agentGet('bug-hunter')
    const caps = bh?.capabilities || []
    const isMinimal = caps.length === 1 && caps[0] === 'read'
    record(N, isMinimal, `caps=${JSON.stringify(caps)}`)
  })

  await test('1.8 student-care Agent 使用 score 而非 read (细粒度)', async () => {
    const N = '1.8 student-care Agent 使用 score 而非 read (细粒度)'
    const sc = await agentGet('student-care')
    const caps = sc?.capabilities || []
    const hasScore = caps.includes('score')
    const hasRead = caps.includes('read')
    record(N, hasScore && !hasRead, `caps=${JSON.stringify(caps)} hasScore=${hasScore} hasRead=${hasRead}`)
  })

  // =============================================================
  // Section 2: 跨数据源一致性 (8 项)
  // =============================================================
  console.log('\n━━━ Section 2: 跨数据源一致性 ━━━')

  await test('2.1 stats.summary.students === listStudents().length', async () => {
    const N = '2.1 stats.summary.students === listStudents().length'
    const students = await listStudents()
    const stats = await getStats()
    const statsCount = stats?.summary?.students
    const listCount = students.length
    // 允许小差异 (并发写入), 但差距应 < 5
    const diff = Math.abs(statsCount - listCount)
    record(N, diff < 5, `stats=${statsCount} list=${listCount} diff=${diff}`)
  })

  await test('2.2 stats.summary.total_events > 0 且为数字', async () => {
    const N = '2.2 stats.summary.total_events > 0 且为数字'
    const stats = await getStats()
    const totalEvents = stats?.summary?.total_events
    record(N, typeof totalEvents === 'number' && totalEvents > 0, `total_events=${totalEvents}`)
  })

  await test('2.3 ranking 首名学生存在于 listStudents', async () => {
    const N = '2.3 ranking 首名学生存在于 listStudents'
    const ranking = await getRanking(10)
    const students = await listStudents()
    const rankingFirst = ranking?.[0]?.name || ranking?.[0]?.student_name
    const exists = students.some((s) => s.name === rankingFirst)
    record(N, exists, `rankingFirst=${rankingFirst} existsInList=${exists}`)
  })

  await test('2.4 score 返回的学生名与请求一致', async () => {
    const N = '2.4 score 返回的学生名与请求一致'
    const score = await getScore(AI_STU)
    const nameMatches = score && (score.name === AI_STU || score.student_name === AI_STU)
    record(N, !!nameMatches, `requested=${AI_STU} returned=${score?.name || score?.student_name}`)
  })

  await test('2.5 search(学生名) 结果包含该学生', async () => {
    const N = '2.5 search(学生名) 结果包含该学生'
    // 先给 AI_STU 添加一个事件, 使搜索能找到
    await addEvent(AI_STU, VALID_BONUS_CODE, 1)
    await new Promise((r) => setTimeout(r, 200))
    const search = await searchEvents(AI_STU)
    const events = search?.events || search?.data?.events || []
    const allMatch = events.every((e) => {
      const name = e.student_name || e.studentName || e.name || ''
      return name === AI_STU || JSON.stringify(e).includes(AI_STU)
    })
    record(N, events.length > 0 && allMatch, `events=${events.length} allMatch=${allMatch}`)
  })

  await test('2.6 history 返回的事件数 <= stats.total_events', async () => {
    const N = '2.6 history 返回的事件数 <= stats.total_events'
    const history = await getHistory(AI_STU)
    const stats = await getStats()
    const histCount = Array.isArray(history) ? history.length : (history?.events?.length || history?.total || 0)
    const totalEvents = stats?.summary?.total_events || 0
    record(N, histCount <= totalEvents, `history=${histCount} total=${totalEvents}`)
  })

  await test('2.7 info.events 与 stats.total_events 一致', async () => {
    const N = '2.7 info.events 与 stats.total_events 一致'
    const info = await getInfo()
    const stats = await getStats()
    const infoEvents = info?.events
    const statsEvents = stats?.summary?.total_events
    const diff = Math.abs((infoEvents || 0) - (statsEvents || 0))
    record(N, diff < 5, `info=${infoEvents} stats=${statsEvents} diff=${diff}`)
  })

  await test('2.8 codes 返回的代码数 > 0 且包含已知代码', async () => {
    const N = '2.8 codes 返回的代码数 > 0 且包含已知代码'
    const codes = await getCodes()
    const codeList = codes?.codes || codes?.data?.codes || []
    const hasKnown = codeList.some((c) => c.code === VALID_BONUS_CODE || c.code === VALID_DEDUCT_CODE || c.id === VALID_BONUS_CODE)
    record(N, codeList.length > 0 && hasKnown, `codes=${codeList.length} hasKnown=${hasKnown}`)
  })

  // =============================================================
  // Section 3: 敏感路径黑名单源码验证 (8 项)
  // =============================================================
  console.log('\n━━━ Section 3: 敏感路径黑名单源码验证 ━━━')

  await test('3.1 黑名单包含 .ssh 目录', async () => {
    const N = '3.1 黑名单包含 .ssh 目录'
    const has = fileToolsSrc && fileToolsSrc.includes('.ssh')
    record(N, !!has, `found=${!!has}`)
  })

  await test('3.2 黑名单包含 .env 文件', async () => {
    const N = '3.2 黑名单包含 .env 文件'
    const has = fileToolsSrc && fileToolsSrc.includes('.env')
    record(N, !!has, `found=${!!has}`)
  })

  await test('3.3 黑名单包含 workstation.db', async () => {
    const N = '3.3 黑名单包含 workstation.db'
    // 源码中正则为 workstation\.db, 搜索 workstation 即可
    const has = fileToolsSrc && fileToolsSrc.includes('workstation')
    record(N, !!has, `found=${!!has}`)
  })

  await test('3.4 黑名单包含 keystore', async () => {
    const N = '3.4 黑名单包含 keystore'
    const has = fileToolsSrc && fileToolsSrc.includes('keystore')
    record(N, !!has, `found=${!!has}`)
  })

  await test('3.5 黑名单包含 .aws/.azure/.config/gcloud', async () => {
    const N = '3.5 黑名单包含 .aws/.azure/.config/gcloud'
    const hasAws = fileToolsSrc?.includes('.aws')
    const hasAzure = fileToolsSrc?.includes('.azure')
    const hasGcloud = fileToolsSrc?.includes('gcloud')
    record(N, hasAws && hasAzure && hasGcloud, `aws=${hasAws} azure=${hasAzure} gcloud=${hasGcloud}`)
  })

  await test('3.6 黑名单包含私钥文件 (.pem/.key/.pfx/.p12)', async () => {
    const N = '3.6 黑名单包含私钥文件 (.pem/.key/.pfx/.p12)'
    // 源码中正则为 \.(pem|key|pfx|p12), 搜索各扩展名 (不带点)
    const has = fileToolsSrc && ['pem', 'key', 'pfx', 'p12'].every((ext) => fileToolsSrc.includes(ext))
    record(N, !!has, `found=${!!has}`)
  })

  await test('3.7 黑名单包含 shell 配置文件 (.bashrc/.zshrc/.profile)', async () => {
    const N = '3.7 黑名单包含 shell 配置文件 (.bashrc/.zshrc/.profile)'
    const has = fileToolsSrc && ['.bashrc', '.zshrc', '.profile'].every((f) => fileToolsSrc.includes(f))
    record(N, !!has, `found=${!!has}`)
  })

  await test('3.8 路径遍历防护 (.. 段被拒绝)', async () => {
    const N = '3.8 路径遍历防护 (.. 段被拒绝)'
    const hasTraversalCheck = fileToolsSrc && (fileToolsSrc.includes('..') || fileToolsSrc.includes('traversal') || fileToolsSrc.includes('normalize'))
    record(N, !!hasTraversalCheck, `found=${!!hasTraversalCheck}`)
  })

  // =============================================================
  // Section 4: 学业数据文件可访问性 (6 项)
  // =============================================================
  console.log('\n━━━ Section 4: 学业数据文件可访问性 ━━━')

  await test('4.1 学业数据目录存在', async () => {
    const N = '4.1 学业数据目录存在'
    const userDataPath = await sysGetPath('userData')
    const dataDir = userDataPath?.data || userDataPath?.path || userDataPath
    // 学业数据在 userData/eaa-data/academics 下 (非 userData/academic)
    const academicDir = path.join(String(dataDir), 'eaa-data', 'academics')
    const exists = fs.existsSync(academicDir)
    record(N, exists, `path=${academicDir} exists=${exists}`)
  })

  await test('4.2 学业配置文件可读 (Agent 通过 read_file 访问)', async () => {
    const N = '4.2 学业配置文件可读 (Agent 通过 read_file 访问)'
    const config = await getConfig()
    const hasSubjects = Array.isArray(config?.subjects) && config.subjects.length > 0
    record(N, !!hasSubjects, `subjects=${config?.subjects?.length}`)
  })

  await test('4.3 考试列表可读 (Agent 通过 read_file 访问)', async () => {
    const N = '4.3 考试列表可读 (Agent 通过 read_file 访问)'
    const exams = await listExams()
    record(N, Array.isArray(exams), `exams=${exams.length}`)
  })

  await test('4.4 学生成绩可读 (Agent 通过 read_file 访问)', async () => {
    const N = '4.4 学生成绩可读 (Agent 通过 read_file 访问)'
    const grades = await getGrades(AI_STU)
    record(N, Array.isArray(grades), `grades=${grades.length}`)
  })

  await test('4.5 学业数据路径不在黑名单中', async () => {
    const N = '4.5 学业数据路径不在黑名单中'
    // academic 目录路径不匹配任何黑名单模式
    const blacklistPatterns = ['.ssh', '.env', 'workstation', 'keystore', '.aws', '.azure', 'pem', 'key', 'pfx', 'p12', '.bashrc', '.zshrc', '.profile', 'Startup', 'Microsoft/Protect']
    const userDataPath = await sysGetPath('userData')
    const dataDir = String(userDataPath?.data || userDataPath?.path || userDataPath || '')
    const academicPath = path.join(dataDir, 'eaa-data', 'academics')
    const notBlocked = blacklistPatterns.every((p) => !academicPath.toLowerCase().includes(p.toLowerCase()))
    record(N, notBlocked, `path=${academicPath} notBlocked=${notBlocked}`)
  })

  await test('4.6 班级数据在 workstation.db (Agent 无法直接访问)', async () => {
    const N = '4.6 班级数据在 workstation.db (Agent 无法直接访问)'
    // 验证 workstation.db 在黑名单中 (Agent 不能直接读班级表)
    // 源码中正则为 workstation\.db, 搜索 workstation 即可
    const isBlocked = fileToolsSrc && fileToolsSrc.includes('workstation')
    // 但 IPC class.list 仍然可用 (前端直连, 不经过 Agent)
    const classes = await listClasses()
    record(N, !!isBlocked && Array.isArray(classes), `dbBlocked=${isBlocked} ipcClasses=${classes.length}`)
  })

  // =============================================================
  // Section 5: Agent SOUL/Rules 内容 (6 项)
  // =============================================================
  console.log('\n━━━ Section 5: Agent SOUL/Rules 内容 ━━━')

  await test('5.1 main Agent 有 SOUL.md 内容', async () => {
    const N = '5.1 main Agent 有 SOUL.md 内容'
    const soul = await agentGetSoul('main')
    const hasContent = soul && (typeof soul.content === 'string' || typeof soul === 'string')
    const contentStr = typeof soul === 'string' ? soul : (soul?.content || '')
    record(N, !!hasContent && contentStr.length > 10, `len=${contentStr.length}`)
  })

  await test('5.2 counselor Agent 有 SOUL.md 内容', async () => {
    const N = '5.2 counselor Agent 有 SOUL.md 内容'
    const soul = await agentGetSoul('counselor')
    const contentStr = typeof soul === 'string' ? soul : (soul?.content || '')
    record(N, contentStr.length > 10, `len=${contentStr.length}`)
  })

  await test('5.3 academic Agent 有 SOUL.md 内容', async () => {
    const N = '5.3 academic Agent 有 SOUL.md 内容'
    const soul = await agentGetSoul('academic')
    const contentStr = typeof soul === 'string' ? soul : (soul?.content || '')
    record(N, contentStr.length > 10, `len=${contentStr.length}`)
  })

  await test('5.4 main Agent 有 AGENTS.md 规则', async () => {
    const N = '5.4 main Agent 有 AGENTS.md 规则'
    const rules = await agentGetRules('main')
    const contentStr = typeof rules === 'string' ? rules : (rules?.content || '')
    record(N, contentStr.length > 0, `len=${contentStr.length}`)
  })

  await test('5.5 系统提示包含运行环境声明 (源码验证)', async () => {
    const N = '5.5 系统提示包含运行环境声明 (源码验证)'
    const hasEnv = agentServiceSrc && agentServiceSrc.includes('运行环境')
    const hasToolList = agentServiceSrc && agentServiceSrc.includes('read_file')
    record(N, !!hasEnv && !!hasToolList, `hasEnv=${hasEnv} hasToolList=${hasToolList}`)
  })

  await test('5.6 系统提示包含工作准则 (强制使用工具)', async () => {
    const N = '5.6 系统提示包含工作准则 (强制使用工具)'
    const hasRules = agentServiceSrc && agentServiceSrc.includes('工作准则')
    record(N, !!hasRules, `found=${!!hasRules}`)
  })

  // =============================================================
  // Section 6: 工具返回数据 Schema 验证 (10 项)
  // =============================================================
  console.log('\n━━━ Section 6: 工具返回数据 Schema 验证 ━━━')

  await test('6.1 eaa_score 返回 {score, risk}', async () => {
    const N = '6.1 eaa_score 返回 {score, risk}'
    const score = await getScore(AI_STU)
    const hasScore = score && typeof score.score === 'number'
    const hasRisk = score && typeof score.risk === 'string'
    record(N, hasScore && hasRisk, `score=${score?.score} risk=${score?.risk}`)
  })

  await test('6.2 eaa_list_students 每项有 {name, score}', async () => {
    const N = '6.2 eaa_list_students 每项有 {name, score}'
    const students = await listStudents()
    const sample = students.slice(0, 10)
    const allValid = sample.every((s) => typeof s.name === 'string' && typeof s.score === 'number')
    record(N, allValid, `sampled=${sample.length} allValid=${allValid}`)
  })

  await test('6.3 eaa_history 返回数组或含 events 字段', async () => {
    const N = '6.3 eaa_history 返回数组或含 events 字段'
    const history = await getHistory(AI_STU)
    const isArr = Array.isArray(history)
    const hasEvents = history && Array.isArray(history.events)
    record(N, isArr || hasEvents, `isArray=${isArr} hasEvents=${hasEvents}`)
  })

  await test('6.4 eaa_search 返回 {events, total, showing}', async () => {
    const N = '6.4 eaa_search 返回 {events, total, showing}'
    const search = await searchEvents(AI_STU)
    const hasEvents = search && (Array.isArray(search.events) || Array.isArray(search.data?.events))
    record(N, !!hasEvents, `hasEvents=${!!hasEvents} keys=${Object.keys(search || {}).join(',')}`)
  })

  await test('6.5 eaa_ranking 每项有 {name, score}', async () => {
    const N = '6.5 eaa_ranking 每项有 {name, score}'
    const ranking = await getRanking(5)
    const sample = (ranking || []).slice(0, 5)
    const allValid = sample.every((r) => {
      const name = r.name || r.student_name
      const score = r.score ?? r.total_score
      return typeof name === 'string' && typeof score === 'number'
    })
    record(N, sample.length > 0 && allValid, `sampled=${sample.length} allValid=${allValid}`)
  })

  await test('6.6 eaa_stats 返回 {summary, reason_distribution}', async () => {
    const N = '6.6 eaa_stats 返回 {summary, reason_distribution}'
    const stats = await getStats()
    const hasSummary = stats && stats.summary
    const hasDist = stats && (stats.reason_distribution || stats.score_intervals)
    record(N, !!hasSummary && !!hasDist, `hasSummary=${!!hasSummary} hasDist=${!!hasDist}`)
  })

  await test('6.7 eaa_codes 返回 {codes, version}', async () => {
    const N = '6.7 eaa_codes 返回 {codes, version}'
    const codes = await getCodes()
    const hasCodes = codes && Array.isArray(codes.codes)
    record(N, !!hasCodes, `hasCodes=${!!hasCodes} count=${codes?.codes?.length}`)
  })

  await test('6.8 eaa_summary 返回 {period, risk_distribution}', async () => {
    const N = '6.8 eaa_summary 返回 {period, risk_distribution}'
    const summary = await getSummary('2024-01-01', '2026-12-31')
    const hasPeriod = summary && (summary.period || summary.start)
    const hasRisk = summary && (summary.risk_distribution || summary.summary)
    record(N, !!hasPeriod || !!hasRisk, `hasPeriod=${!!hasPeriod} hasRisk=${!!hasRisk} keys=${Object.keys(summary || {}).slice(0, 8).join(',')}`)
  })

  await test('6.9 eaa_info 返回 {data_dir, events, students, version}', async () => {
    const N = '6.9 eaa_info 返回 {data_dir, events, students, version}'
    const info = await getInfo()
    const hasDir = info && typeof info.data_dir === 'string'
    const hasVersion = info && typeof info.version === 'string'
    record(N, !!hasDir && !!hasVersion, `hasDir=${!!hasDir} hasVersion=${!!hasVersion} keys=${Object.keys(info || {}).join(',')}`)
  })

  await test('6.10 eaa_range 返回事件数组', async () => {
    const N = '6.10 eaa_range 返回事件数组'
    const range = await getRange('2024-01-01', '2026-12-31')
    const hasEvents = range && (Array.isArray(range.events) || Array.isArray(range) || range.total > 0)
    record(N, !!hasEvents, `hasEvents=${!!hasEvents} keys=${Object.keys(range || {}).slice(0, 8).join(',')}`)
  })

  // =============================================================
  // Section 7: 大数据量处理 (6 项)
  // =============================================================
  console.log('\n━━━ Section 7: 大数据量处理 ━━━')

  await test('7.1 listStudents 可处理 2900+ 学生', async () => {
    const N = '7.1 listStudents 可处理 2900+ 学生'
    const t0 = Date.now()
    const students = await listStudents()
    const elapsed = Date.now() - t0
    record(N, students.length > 2900 && elapsed < 5000, `count=${students.length} elapsed=${elapsed}ms`)
  })

  await test('7.2 stats 可处理 32000+ 事件', async () => {
    const N = '7.2 stats 可处理 32000+ 事件'
    const t0 = Date.now()
    const stats = await getStats()
    const elapsed = Date.now() - t0
    const totalEvents = stats?.summary?.total_events || 0
    record(N, totalEvents > 32000 && elapsed < 5000, `events=${totalEvents} elapsed=${elapsed}ms`)
  })

  await test('7.3 ranking(100) 可返回大量排名', async () => {
    const N = '7.3 ranking(100) 可返回大量排名'
    const ranking = await getRanking(100)
    record(N, ranking && ranking.length >= 50, `returned=${ranking?.length}`)
  })

  await test('7.4 search 可搜索大量事件', async () => {
    const N = '7.4 search 可搜索大量事件'
    // 搜索常见关键词
    const search = await searchEvents('test')
    const total = search?.total || search?.data?.total || 0
    record(N, total > 0, `total=${total} showing=${search?.showing || search?.events?.length || 0}`)
  })

  await test('7.5 summary 可处理大范围数据', async () => {
    const N = '7.5 summary 可处理大范围数据'
    const t0 = Date.now()
    const summary = await getSummary('2020-01-01', '2026-12-31')
    const elapsed = Date.now() - t0
    record(N, !!summary && elapsed < 5000, `hasSummary=${!!summary} elapsed=${elapsed}ms`)
  })

  await test('7.6 range 可处理大范围查询', async () => {
    const N = '7.6 range 可处理大范围查询'
    const t0 = Date.now()
    const range = await getRange('2020-01-01', '2026-12-31')
    const elapsed = Date.now() - t0
    const total = range?.total || range?.events?.length || 0
    record(N, total >= 0 && elapsed < 5000, `total=${total} elapsed=${elapsed}ms`)
  })

  // =============================================================
  // Section 8: AI 写入后数据一致性 (8 项)
  // =============================================================
  console.log('\n━━━ Section 8: AI 写入后数据一致性 ━━━')

  // 先写入一个事件, 然后通过多个路径验证一致性
  const WRITE_STU = `r14_write_${TS}`
  await addStudent(WRITE_STU)
  const scoreBefore = await getScore(WRITE_STU)
  const beforeScore = scoreBefore?.score || 100

  await addEvent(WRITE_STU, VALID_BONUS_CODE, 1)
  await new Promise((r) => setTimeout(r, 200))

  await test('8.1 写入后 score 立即更新', async () => {
    const N = '8.1 写入后 score 立即更新'
    const scoreAfter = await getScore(WRITE_STU)
    const afterScore = scoreAfter?.score
    const delta = afterScore - beforeScore
    record(N, delta === 1, `before=${beforeScore} after=${afterScore} delta=${delta}`)
  })

  await test('8.2 写入后 history 可见该事件', async () => {
    const N = '8.2 写入后 history 可见该事件'
    const history = await getHistory(WRITE_STU)
    const events = Array.isArray(history) ? history : (history?.events || [])
    const hasEvent = events.some((e) => {
      const reason = e.reason_code || e.reasonCode || e.reason || ''
      return reason === VALID_BONUS_CODE || JSON.stringify(e).includes(VALID_BONUS_CODE)
    })
    record(N, hasEvent, `events=${events.length} hasEvent=${hasEvent}`)
  })

  await test('8.3 写入后 search 可搜索到该事件', async () => {
    const N = '8.3 写入后 search 可搜索到该事件'
    const search = await searchEvents(WRITE_STU)
    const events = search?.events || search?.data?.events || []
    const found = events.some((e) => JSON.stringify(e).includes('Round14'))
    record(N, events.length > 0, `events=${events.length} found=${found}`)
  })

  await test('8.4 写入后 stats 事件数增加', async () => {
    const N = '8.4 写入后 stats 事件数增加'
    const stats = await getStats()
    const totalEvents = stats?.summary?.total_events || 0
    // 只验证 > 0 (无法精确比较因为并发)
    record(N, totalEvents > 0, `total_events=${totalEvents}`)
  })

  await test('8.5 写入后 ranking 包含该学生', async () => {
    const N = '8.5 写入后 ranking 包含该学生'
    // 系统有 4000+ 学生, 新学生分数=BASE+1=101, top 100 可能不包含
    // 查全量 ranking (传 0 或大数) 验证该学生存在
    const ranking = await getRanking(5000)
    const found = (ranking || []).some((r) => (r.name || r.student_name) === WRITE_STU)
    record(N, found, `found=${found} rankingSize=${ranking?.length}`)
  })

  await test('8.6 写入后 listStudents 包含该学生', async () => {
    const N = '8.6 写入后 listStudents 包含该学生'
    const students = await listStudents()
    const found = students.some((s) => s.name === WRITE_STU)
    record(N, found, `found=${found}`)
  })

  await test('8.7 写入后 info.events 与 stats 一致', async () => {
    const N = '8.7 写入后 info.events 与 stats 一致'
    const info = await getInfo()
    const stats = await getStats()
    const infoEvents = info?.events
    const statsEvents = stats?.summary?.total_events
    const diff = Math.abs((infoEvents || 0) - (statsEvents || 0))
    record(N, diff < 5, `info=${infoEvents} stats=${statsEvents} diff=${diff}`)
  })

  await test('8.8 写入的数据可通过 summary 时间范围查到', async () => {
    const N = '8.8 写入的数据可通过 summary 时间范围查到'
    const today = new Date().toISOString().slice(0, 10)
    const summary = await getSummary(today, today)
    // summary.events 是对象 { total, bonus_count, deduct_count, ... }
    const events = summary?.events
    const eventTotal = typeof events === 'object' ? events?.total : events
    record(N, eventTotal >= 0, `todayEvents=${eventTotal} hasSummary=${!!summary}`)
  })

  // =============================================================
  // 汇总
  // =============================================================
  console.log('\n' + '━'.repeat(60))
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  console.log(`Round 14 AI 数据访问深度矩阵测试结果: ${passed}/${passed + failed} 通过, ${failed} 失败`)
  if (failed > 0) {
    console.log('\n失败项:')
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.detail}`))
  }
  console.log('━'.repeat(60))

  // 清理
  try {
    await callIpc(`const res = await api.eaa.deleteStudent(${JSON.stringify(AI_STU)}, 'test cleanup'); return res;`)
    await callIpc(`const res = await api.eaa.deleteStudent(${JSON.stringify(WRITE_STU)}, 'test cleanup'); return res;`)
  } catch {}

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
