// =============================================================
// EAA 仪表盘/统计/摘要 数据一致性深度测试
// 通过 CDP + Tauri Bridge 深度测试 eaa.dashboard / stats / summary /
// ranking / score / export / validate 的数据结构与跨数据一致性
//
// 运行: node scripts/cdp-dashboard-stats-deep.mjs
// 前置: Tauri 应用已运行, CDP 远程调试端口 9222 可用
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

// 日期格式化: Date -> YYYY-MM-DD
function fmtDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 本周周一
function mondayOfWeek() {
  const now = new Date()
  const day = now.getDay() // 0=Sun, 1=Mon, ..., 6=Sat
  const daysSinceMonday = day === 0 ? 6 : day - 1
  const monday = new Date(now)
  monday.setDate(now.getDate() - daysSinceMonday)
  return fmtDate(monday)
}

// 本月1号
function firstOfMonth() {
  const now = new Date()
  return fmtDate(new Date(now.getFullYear(), now.getMonth(), 1))
}

// 上月1号和最后一天
function lastMonthRange() {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const last = new Date(now.getFullYear(), now.getMonth(), 0)
  return { since: fmtDate(first), until: fmtDate(last) }
}

async function main() {
  const results = []
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  }

  // === CDP 连接 ===
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
  const send = (method, params = {}) => new Promise((resolve, reject) => {
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
  console.log('CDP connected, running dashboard/stats/summary deep tests...\n')

  // EAA IPC 调用封装 (与 cdp-eaa-integration.mjs 一致)
  const callIpc = async (code) => {
    return await evalInPage(`
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
  }

  const today = fmtDate(new Date())
  const monday = mondayOfWeek()
  const monthStart = firstOfMonth()
  const lastMonth = lastMonthRange()
  const RISK_LEVELS = new Set(['极高', '高', '中', '低'])

  // =============================================================
  // 预备: 获取 listStudents 和 stats 基准数据 (供后续一致性检查)
  // =============================================================
  console.log('--- 收集基准数据 ---')
  const listR = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
  const statsR = await callIpc(`const res = await api.eaa.stats(); return res;`)

  const studentsArr = listR?.data?.students || []
  const listTotal = listR?.data?.total ?? 0
  const statsSummary = statsR?.data?.summary
  const statsStudents = statsSummary?.students ?? 0
  console.log(`listStudents: total=${listTotal}, students.length=${studentsArr.length}`)
  console.log(`stats.summary: students=${statsStudents}, total_events=${statsSummary?.total_events ?? 0}\n`)

  // =============================================================
  // 1. Dashboard 结构测试
  // =============================================================
  console.log('━━━ 1. Dashboard 结构测试 ━━━')

  let dashData1 = null
  try {
    const r = await callIpc(`const res = await api.eaa.dashboard(); return res;`)
    dashData1 = r
    const data = r?.data
    const hasData = data !== null && data !== undefined && String(data).length > 0
    record('dashboard() 返回成功且数据非空', r?.success === true && hasData, `success=${r?.success} dataLen=${String(data ?? '').length}`)
  } catch (err) {
    record('dashboard() 返回成功且数据非空', false, String(err.message || err))
  }

  try {
    const text = String(dashData1?.data ?? '')
    record('dashboard 数据包含"仪表盘"关键词', text.includes('仪表盘'), `text=${text.slice(0, 80)}`)
  } catch (err) {
    record('dashboard 数据包含"仪表盘"关键词', false, String(err.message || err))
  }

  try {
    const text = String(dashData1?.data ?? '')
    record('dashboard 数据提及文件路径', text.includes('index.html') || text.includes('.html'), `text=${text.slice(0, 100)}`)
  } catch (err) {
    record('dashboard 数据提及文件路径', false, String(err.message || err))
  }

  // =============================================================
  // 2. Stats 结构测试
  // =============================================================
  console.log('\n━━━ 2. Stats 结构测试 ━━━')

  try {
    record('stats() 返回成功且包含 summary 对象', statsR?.success === true && typeof statsSummary === 'object' && statsSummary !== null, `success=${statsR?.success} hasSummary=${!!statsSummary}`)
  } catch (err) {
    record('stats() 返回成功且包含 summary 对象', false, String(err.message || err))
  }

  try {
    record('stats.summary.students > 0', typeof statsStudents === 'number' && statsStudents > 0, `students=${statsStudents}`)
  } catch (err) {
    record('stats.summary.students > 0', false, String(err.message || err))
  }

  try {
    const totalEvents = statsSummary?.total_events
    record('stats.summary 包含 total_events', typeof totalEvents === 'number', `total_events=${totalEvents}`)
  } catch (err) {
    record('stats.summary 包含 total_events', false, String(err.message || err))
  }

  try {
    const reasonDist = statsR?.data?.reason_distribution
    record('stats 包含 reason_distribution 数组', Array.isArray(reasonDist) && reasonDist.length > 0, `length=${reasonDist?.length ?? 0}`)
  } catch (err) {
    record('stats 包含 reason_distribution 数组', false, String(err.message || err))
  }

  try {
    const intervals = statsR?.data?.score_intervals
    record('stats 包含 score_intervals 对象', typeof intervals === 'object' && intervals !== null, `keys=${Object.keys(intervals || {}).join(',')}`)
  } catch (err) {
    record('stats 包含 score_intervals 对象', false, String(err.message || err))
  }

  // =============================================================
  // 3. Summary 各种日期范围测试
  // =============================================================
  console.log('\n━━━ 3. Summary 日期范围测试 ━━━')

  try {
    const r = await callIpc(`const res = await api.eaa.summary(); return res;`)
    const events = r?.data?.events
    record('summary() 无参数(缺失since/until)返回成功', r?.success === true && events && typeof events.total === 'number', `success=${r?.success} total=${events?.total ?? 'N/A'}`)
  } catch (err) {
    record('summary() 无参数(缺失since/until)返回成功', false, String(err.message || err))
  }

  try {
    const r = await callIpc(`const res = await api.eaa.summary('${today}', '${today}'); return res;`)
    record('summary(今天, 今天)返回成功', r?.success === true && r?.data?.events, `success=${r?.success} total=${r?.data?.events?.total ?? 'N/A'}`)
  } catch (err) {
    record('summary(今天, 今天)返回成功', false, String(err.message || err))
  }

  try {
    const r = await callIpc(`const res = await api.eaa.summary('${monday}', '${today}'); return res;`)
    record('summary(本周一, 今天)返回成功', r?.success === true && r?.data?.events, `success=${r?.success} total=${r?.data?.events?.total ?? 'N/A'}`)
  } catch (err) {
    record('summary(本周一, 今天)返回成功', false, String(err.message || err))
  }

  try {
    const r = await callIpc(`const res = await api.eaa.summary('${monthStart}', '${today}'); return res;`)
    record('summary(本月1号, 今天)返回成功', r?.success === true && r?.data?.events, `success=${r?.success} total=${r?.data?.events?.total ?? 'N/A'}`)
  } catch (err) {
    record('summary(本月1号, 今天)返回成功', false, String(err.message || err))
  }

  try {
    const r = await callIpc(`const res = await api.eaa.summary('${lastMonth.since}', '${lastMonth.until}'); return res;`)
    record('summary(上月)返回成功', r?.success === true && r?.data?.events, `success=${r?.success} total=${r?.data?.events?.total ?? 'N/A'}`)
  } catch (err) {
    record('summary(上月)返回成功', false, String(err.message || err))
  }

  try {
    const r = await callIpc(`const res = await api.eaa.summary('${today}', '${lastMonth.until}'); return res;`)
    record('summary(反转日期 since>until) 优雅处理', r?.success === true && r?.data?.events, `success=${r?.success} total=${r?.data?.events?.total ?? 'N/A'}`)
  } catch (err) {
    record('summary(反转日期 since>until) 优雅处理', false, String(err.message || err))
  }

  try {
    const r = await callIpc(`const res = await api.eaa.summary('invalid-date', '${today}'); return res;`)
    record('summary(非法日期格式) 返回错误', r?.__error !== undefined, `error=${r?.__error ?? 'none'}`)
  } catch (err) {
    record('summary(非法日期格式) 返回错误', false, String(err.message || err))
  }

  // =============================================================
  // 4. Ranking 深度测试
  // =============================================================
  console.log('\n━━━ 4. Ranking 深度测试 ━━━')

  let ranking10 = null
  try {
    const r = await callIpc(`const res = await api.eaa.ranking(10); return res;`)
    ranking10 = r?.data?.ranking
    record('ranking(10) 返回成功且含 ranking 数组', r?.success === true && Array.isArray(ranking10), `success=${r?.success} count=${ranking10?.length ?? 0}`)
  } catch (err) {
    record('ranking(10) 返回成功且含 ranking 数组', false, String(err.message || err))
  }

  try {
    const r = await callIpc(`const res = await api.eaa.ranking(1); return res;`)
    const rk = r?.data?.ranking
    record('ranking(1) 返回1条记录', r?.success === true && Array.isArray(rk) && rk.length === 1, `success=${r?.success} count=${rk?.length ?? 0} first=${rk?.[0]?.name ?? ''}`)
  } catch (err) {
    record('ranking(1) 返回1条记录', false, String(err.message || err))
  }

  try {
    const r = await callIpc(`const res = await api.eaa.ranking(0); return res;`)
    const rk = r?.data?.ranking
    // n=0 时 handler 视为"无限制"(0 不满足 n>0), CLI 使用默认值 10
    record('ranking(0) 边界返回默认10条', r?.success === true && Array.isArray(rk) && rk.length === 10, `success=${r?.success} count=${rk?.length ?? 0}`)
  } catch (err) {
    record('ranking(0) 边界返回默认10条', false, String(err.message || err))
  }

  try {
    const r = await callIpc(`const res = await api.eaa.ranking(1000); return res;`)
    const rk = r?.data?.ranking
    // handler 将 n 上限截断为 Math.min(1000, n), 返回 1000 条
    record('ranking(1000) 返回1000条(上限)', r?.success === true && Array.isArray(rk) && rk.length === 1000, `success=${r?.success} count=${rk?.length ?? 0}`)
  } catch (err) {
    record('ranking(1000) 返回1000条(上限)', false, String(err.message || err))
  }

  let rankingAll = null
  try {
    const r = await callIpc(`const res = await api.eaa.ranking(); return res;`)
    rankingAll = r?.data?.ranking
    // 无参数时 CLI 使用默认值 10
    record('ranking() 无参数返回默认10条', r?.success === true && Array.isArray(rankingAll) && rankingAll.length === 10, `success=${r?.success} count=${rankingAll?.length ?? 0}`)
  } catch (err) {
    record('ranking() 无参数返回默认10条', false, String(err.message || err))
  }

  try {
    const rk = ranking10 || []
    let sorted = true
    for (let i = 1; i < rk.length; i++) {
      const prev = rk[i - 1]?.score
      const curr = rk[i]?.score
      if (typeof prev === 'number' && typeof curr === 'number' && curr > prev + 0.001) { sorted = false; break }
    }
    record('ranking(10) 按分数降序排列', rk.length > 0 && sorted, `first=${rk[0]?.score} last=${rk[rk.length - 1]?.score}`)
  } catch (err) {
    record('ranking(10) 按分数降序排列', false, String(err.message || err))
  }

  try {
    const rk = rankingAll || ranking10 || []
    const allScores = (rankingAll || ranking10 || []).map((x) => x.score)
    const maxScore = allScores.length > 0 ? Math.max(...allScores) : null
    record('ranking 首条为最高分', rk.length > 0 && typeof rk[0]?.score === 'number' && maxScore !== null && Math.abs(rk[0].score - maxScore) < 0.001, `first=${rk[0]?.score} max=${maxScore}`)
  } catch (err) {
    record('ranking 首条为最高分', false, String(err.message || err))
  }

  // =============================================================
  // 5. 跨数据一致性
  // =============================================================
  console.log('\n━━━ 5. 跨数据一致性 ━━━')

  try {
    record('listStudents.total == stats.summary.students', listTotal === statsStudents, `list=${listTotal} stats=${statsStudents}`)
  } catch (err) {
    record('listStudents.total == stats.summary.students', false, String(err.message || err))
  }

  try {
    const rkCount = (rankingAll || []).length
    record('ranking() 条数 <= listStudents.total', rkCount <= listTotal, `ranking=${rkCount} list=${listTotal}`)
  } catch (err) {
    record('ranking() 条数 <= listStudents.total', false, String(err.message || err))
  }

  try {
    const rk = rankingAll || ranking10 || []
    let matchOk = false
    let matchDetail = '无可用数据'
    if (rk.length > 0) {
      const first = rk[0]
      const name = first?.name
      const rkScore = first?.score
      if (name && typeof rkScore === 'number') {
        const sc = await callIpc(`const res = await api.eaa.score(${JSON.stringify(name)}); return res;`)
        const scScore = sc?.data?.score
        matchOk = typeof scScore === 'number' && Math.abs(scScore - rkScore) < 0.001
        matchDetail = `name=${name} ranking=${rkScore} score=${scScore}`
      }
    }
    record('score(name) 与 ranking 分数一致', matchOk, matchDetail)
  } catch (err) {
    record('score(name) 与 ranking 分数一致', false, String(err.message || err))
  }

  try {
    const r = await callIpc(`const res = await api.eaa.validate(); return res;`)
    const data = r?.data
    record('validate() 返回成功', r?.success === true && data, `success=${r?.success} valid=${data?.valid} errors=${data?.errors?.length ?? 0}`)
  } catch (err) {
    record('validate() 返回成功', false, String(err.message || err))
  }

  // =============================================================
  // 6. 每个学生分数
  // =============================================================
  console.log('\n━━━ 6. 每个学生分数 ━━━')

  // 选取低分学生(按分数升序取前5), 避开 ranking 预填充的 scoreCache
  // (ranking 缓存只存 {score,entity_id,name}, 不含 risk 字段)
  let sampledStudents = []
  try {
    const active = studentsArr.filter((s) => s.status !== 'Deleted')
    const sorted = active.slice().sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
    sampledStudents = sorted.slice(0, Math.min(5, sorted.length))
    if (sampledStudents.length === 0) sampledStudents = studentsArr.slice(0, Math.min(5, studentsArr.length))
  } catch {
    sampledStudents = []
  }

  try {
    let allOk = true
    const details = []
    for (const s of sampledStudents) {
      const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(s.name)}); return res;`)
      const ok = r?.success === true && typeof r?.data?.score === 'number'
      if (!ok) allOk = false
      details.push(`${s.name}=${r?.data?.score ?? 'fail'}`)
    }
    record(`score() 对 ${sampledStudents.length} 个学生返回有效数据`, allOk && sampledStudents.length >= 3, details.join(', '))
  } catch (err) {
    record(`score() 对 ${sampledStudents.length} 个学生返回有效数据`, false, String(err.message || err))
  }

  try {
    let allRiskValid = true
    const riskDetail = []
    for (const s of sampledStudents) {
      const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(s.name)}); return res;`)
      const risk = r?.data?.risk
      const valid = typeof risk === 'string' && RISK_LEVELS.has(risk)
      if (!valid) allRiskValid = false
      riskDetail.push(`${s.name}:${risk ?? 'invalid'}`)
    }
    record('risk 等级属于 极高/高/中/低', allRiskValid && sampledStudents.length >= 3, riskDetail.join(', '))
  } catch (err) {
    record('risk 等级属于 极高/高/中/低', false, String(err.message || err))
  }

  // =============================================================
  // 7. Export 数据完整性
  // =============================================================
  console.log('\n━━━ 7. Export 数据完整性 ━━━')

  let csvData = null
  try {
    const r = await callIpc(`const res = await api.eaa.export('csv'); return res;`)
    csvData = String(r?.data ?? '')
    const hasHeader = csvData.startsWith('姓名,分数,变动,风险')
    record('export(csv) 包含正确表头', r?.success === true && hasHeader, `success=${r?.success} header=${csvData.slice(0, 30)}`)
  } catch (err) {
    record('export(csv) 包含正确表头', false, String(err.message || err))
  }

  try {
    const lines = csvData.split('\n').filter((l) => l.length > 0)
    const dataRows = Math.max(0, lines.length - 1) // 减去表头
    record('export(csv) 数据行数匹配学生数', dataRows === listTotal, `csvRows=${dataRows} students=${listTotal}`)
  } catch (err) {
    record('export(csv) 数据行数匹配学生数', false, String(err.message || err))
  }

  let jsonlData = null
  try {
    const r = await callIpc(`const res = await api.eaa.export('jsonl'); return res;`)
    jsonlData = String(r?.data ?? '')
    const lines = jsonlData.split('\n').filter((l) => l.length > 0)
    record('export(jsonl) 行数匹配学生数', r?.success === true && lines.length === listTotal, `success=${r?.success} jsonlLines=${lines.length} students=${listTotal}`)
  } catch (err) {
    record('export(jsonl) 行数匹配学生数', false, String(err.message || err))
  }

  try {
    const lines = jsonlData.split('\n').filter((l) => l.length > 0)
    let allValid = true
    let parsedCount = 0
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (typeof obj.name !== 'string' || typeof obj.score !== 'number') { allValid = false; break }
        parsedCount++
      } catch {
        allValid = false; break
      }
    }
    record('export(jsonl) 每行可解析为有效JSON', allValid && parsedCount === lines.length, `valid=${parsedCount}/${lines.length}`)
  } catch (err) {
    record('export(jsonl) 每行可解析为有效JSON', false, String(err.message || err))
  }

  // =============================================================
  // 8. 并发读取
  // =============================================================
  console.log('\n━━━ 8. 并发读取 ━━━')

  try {
    const [statsC, dashC, rankC] = await Promise.all([
      callIpc(`const res = await api.eaa.stats(); return res;`),
      callIpc(`const res = await api.eaa.dashboard(); return res;`),
      callIpc(`const res = await api.eaa.ranking(10); return res;`),
    ])
    const allSuccess = statsC?.success === true && dashC?.success === true && rankC?.success === true
    const consistent = statsC?.data?.summary?.students === statsStudents
    record('并发 stats+dashboard+ranking 全部成功且数据一致', allSuccess && consistent, `stats=${statsC?.success} dash=${dashC?.success} rank=${rankC?.success} students=${statsC?.data?.summary?.students}`)
  } catch (err) {
    record('并发 stats+dashboard+ranking 全部成功且数据一致', false, String(err.message || err))
  }

  // =============================================================
  // 9. 幂等性
  // =============================================================
  console.log('\n━━━ 9. 幂等性 ━━━')

  try {
    const s1 = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const s2 = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const same = s1?.data?.summary?.students === s2?.data?.summary?.students &&
      s1?.data?.summary?.total_events === s2?.data?.summary?.total_events
    record('stats() 两次调用结果一致', same, `students=${s1?.data?.summary?.students}==${s2?.data?.summary?.students} events=${s1?.data?.summary?.total_events}==${s2?.data?.summary?.total_events}`)
  } catch (err) {
    record('stats() 两次调用结果一致', false, String(err.message || err))
  }

  try {
    const d1 = await callIpc(`const res = await api.eaa.dashboard(); return res;`)
    const d2 = await callIpc(`const res = await api.eaa.dashboard(); return res;`)
    const same = String(d1?.data ?? '') === String(d2?.data ?? '')
    record('dashboard() 两次调用结果一致', same, `d1=${String(d1?.data ?? '').slice(0, 50)} d2=${String(d2?.data ?? '').slice(0, 50)}`)
  } catch (err) {
    record('dashboard() 两次调用结果一致', false, String(err.message || err))
  }

  // =============================================================
  // 汇总
  // =============================================================
  console.log('\n========== EAA 仪表盘/统计/摘要 深度测试汇总 ==========')
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  console.log(`总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`)
  if (failed > 0) {
    console.log('\n失败项:')
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  - ${r.name}: ${r.detail}`)
    }
  }
  console.log('========================================================')

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
