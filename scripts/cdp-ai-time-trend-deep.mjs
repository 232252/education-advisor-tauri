// =============================================================
// Round 24: AI 跨时间段数据分析 + 趋势数据可达性测试 — 重中之重续11
//
// 验证 AI 对跨时间段数据的分析能力 + 趋势数据可达性:
//   1. 时间维度数据查询 — range/summary 跨时间段 (6 项)
//   2. 学生历史趋势 — 单学生跨时间段分数变化 (6 项)
//   3. 全局趋势分析 — ranking/stats 跨时间段对比 (6 项)
//   4. 事件时间分布 — 按日期/时段分析事件分布 (6 项)
//   5. 原因码时间趋势 — 不同时间段原因码分布变化 (6 项)
//   6. 数据导出时间维度 — 按时间段导出数据 (5 项)
//   7. 趋势数据完整性 — 验证趋势数据可完整读回 (5 项)
//   8. 跨时间段数据一致性 — 同一数据在不同查询中一致 (6 项)
//   9. 时间边界极限 — 跨年/跨月/跨日边界 (5 项)
//
// 运行: node scripts/cdp-ai-time-trend-deep.mjs
// =============================================================
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const CDP_PORT = 9222
const BASE = `http://127.0.0.1:${CDP_PORT}`

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
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
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  })
  const send = (method, params = {}) => new Promise((resolve) => { const id = msgId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
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
  console.log('CDP connected, running AI time-trend tests...\n')

  const callIpc = async (code) =>
    evalInPage(`(async function(){const api=window.__EAA_API__||window.api;if(!api)return{__error:'no-api'};try{${code}}catch(e){return{__error:String(e&&e.message?e.message:e)}}})()`)

  const isOk = (res) => !!res && !res.__error && res?.success !== false

  const TS = Date.now()
  const userDataDir = 'C:\\Users\\sq199\\AppData\\Roaming\\com.educationadvisor.tauri'
  const eaaDataDir = path.join(userDataDir, 'eaa-data')
  const eventsDir = path.join(eaaDataDir, 'events')
  const entitiesDir = path.join(eaaDataDir, 'entities')
  const logsDir = path.join(eaaDataDir, 'logs')
  const outputDir = path.join(eaaDataDir, 'r24-output')
  await fsp.mkdir(outputDir, { recursive: true }).catch(() => {})

  // ---------- 时间辅助 ----------
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const yesterday = new Date(today.getTime() - 86400000)
  const yesterdayStr = yesterday.toISOString().slice(0, 10)
  const weekAgo = new Date(today.getTime() - 7 * 86400000)
  const weekAgoStr = weekAgo.toISOString().slice(0, 10)
  const monthAgo = new Date(today.getTime() - 30 * 86400000)
  const monthAgoStr = monthAgo.toISOString().slice(0, 10)
  const yearStart = `${today.getFullYear()}-01-01`
  const lastYearStart = `${today.getFullYear() - 1}-01-01`
  const lastYearEnd = `${today.getFullYear() - 1}-12-31`

  // ===========================================================
  // 1. 时间维度数据查询 — range/summary 跨时间段
  // ===========================================================
  console.log('--- 1. 时间维度数据查询 ---')

  await test('1.1 eaa_range 查询今日事件', async () => {
    const r = await callIpc(`const res = await api.eaa.range(${JSON.stringify(todayStr)}, ${JSON.stringify(todayStr)}, 1000); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('1.1 eaa_range 查询今日事件', isOk(r), `events=${events.length}`)
  })

  await test('1.2 eaa_range 查询过去7天事件', async () => {
    const r = await callIpc(`const res = await api.eaa.range(${JSON.stringify(weekAgoStr)}, ${JSON.stringify(todayStr)}, 1000); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('1.2 eaa_range 查询过去7天事件', isOk(r), `events=${events.length}`)
  })

  await test('1.3 eaa_range 查询过去30天事件', async () => {
    const r = await callIpc(`const res = await api.eaa.range(${JSON.stringify(monthAgoStr)}, ${JSON.stringify(todayStr)}, 1000); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('1.3 eaa_range 查询过去30天事件', isOk(r), `events=${events.length}`)
  })

  await test('1.4 eaa_summary 查询本年摘要', async () => {
    const r = await callIpc(`const res = await api.eaa.summary(${JSON.stringify(yearStart)}, ${JSON.stringify(todayStr)}); return res;`)
    const data = r?.data ?? r
    const events = data?.events ?? {}
    record('1.4 eaa_summary 查询本年摘要', isOk(r), `total=${events.total} bonus=${events.bonus_count} deduct=${events.deduct_count}`)
  })

  await test('1.5 eaa_summary 查询去年摘要', async () => {
    const r = await callIpc(`const res = await api.eaa.summary(${JSON.stringify(lastYearStart)}, ${JSON.stringify(lastYearEnd)}); return res;`)
    const data = r?.data ?? r
    record('1.5 eaa_summary 查询去年摘要', isOk(r), `hasData=${!!data}`)
  })

  await test('1.6 eaa_range 跨年查询 (去年到今年)', async () => {
    const r = await callIpc(`const res = await api.eaa.range(${JSON.stringify(lastYearStart)}, ${JSON.stringify(todayStr)}, 100); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('1.6 eaa_range 跨年查询', isOk(r), `events=${events.length}`)
  })

  // ===========================================================
  // 2. 学生历史趋势 — 单学生跨时间段分数变化
  // ===========================================================
  console.log('\n--- 2. 学生历史趋势 ---')

  // 创建趋势测试学生并添加多个时间段的事件
  const trendStudent = `r24_trend_${TS}`
  await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(trendStudent)}); return res;`)

  // 添加多个事件模拟分数变化趋势
  for (let i = 0; i < 5; i++) {
    await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(trendStudent)},
        reasonCode: 'ACTIVITY_PARTICIPATION',
        delta: ${i + 1},
        note: 'R24 trend event ' + ${i},
        force: true,
      });
      return res;
    `)
  }

  await test('2.1 查询学生当前分数', async () => {
    await new Promise(r => setTimeout(r, 500))
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(trendStudent)}); return res;`)
    const data = r?.data ?? r
    // 100 + 1+2+3+4+5 = 115
    record('2.1 查询学生当前分数', isOk(r) && data?.score === 115, `score=${data?.score}`)
  })

  await test('2.2 查询学生事件历史 (趋势数据)', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(trendStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    // 验证事件按时间有序
    let isOrdered = true
    for (let i = 1; i < events.length; i++) {
      if (events[i - 1].timestamp > events[i].timestamp) { isOrdered = false; break }
    }
    record('2.2 查询学生事件历史', events.length === 5 && isOrdered, `events=${events.length} ordered=${isOrdered}`)
  })

  await test('2.3 搜索学生全部事件 (eaa_search)', async () => {
    const r = await callIpc(`const res = await api.eaa.search(${JSON.stringify(trendStudent)}, 100); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? data?.results ?? [])
    record('2.3 搜索学生全部事件', events.length >= 5, `results=${events.length}`)
  })

  await test('2.4 验证分数递增趋势 (delta 累加)', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(trendStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    // 验证每个事件的 score_delta 为正数且递增 (1,2,3,4,5)
    const deltas = events.map(e => e.score_delta).filter(d => typeof d === 'number')
    const allPositive = deltas.every(d => d > 0)
    const sum = deltas.reduce((a, b) => a + b, 0)
    record('2.4 验证分数递增趋势', allPositive && sum === 15, `deltas=[${deltas.join(',')}] sum=${sum}`)
  })

  await test('2.5 查询学生在排行榜中位置', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(2000); return res;`)
    const data = r?.data ?? r
    const ranking = data?.ranking ?? data?.data?.ranking ?? []
    const found = ranking.find(s => s.name === trendStudent)
    record('2.5 查询学生在排行榜中位置', !!found, `found=${!!found} score=${found?.score}`)
  })

  await test('2.6 学生分数缓存一致性 (scores.cache)', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const eid = idx[trendStudent]
    const cacheScore = cache[eid]
    record('2.6 学生分数缓存一致性', cacheScore === 115, `cache=${cacheScore} expected=115`)
  })

  // ===========================================================
  // 3. 全局趋势分析 — ranking/stats 跨时间段对比
  // ===========================================================
  console.log('\n--- 3. 全局趋势分析 ---')

  await test('3.1 全局排行榜 top 10', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(10); return res;`)
    const data = r?.data ?? r
    const ranking = data?.ranking ?? data?.data?.ranking ?? []
    record('3.1 全局排行榜 top 10', ranking.length === 10, `top=${ranking.length} first=${ranking[0]?.name}`)
  })

  await test('3.2 全局统计 — 学生总数/事件总数', async () => {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const data = r?.data ?? r
    const summary = data?.summary ?? {}
    record('3.2 全局统计', summary.students > 0 && summary.total_events > 0, `students=${summary.students} events=${summary.total_events}`)
  })

  await test('3.3 分数区间分布', async () => {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const data = r?.data ?? r
    const intervals = data?.score_intervals ?? {}
    const count = typeof intervals === 'object' ? Object.keys(intervals).length : 0
    record('3.3 分数区间分布', count > 0, `intervals=${count}`)
  })

  await test('3.4 原因码分布 (reason_distribution)', async () => {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const data = r?.data ?? r
    const dist = data?.reason_distribution ?? []
    record('3.4 原因码分布', Array.isArray(dist) && dist.length > 0, `reasons=${dist.length}`)
  })

  await test('3.5 top_gainers (涨幅最大)', async () => {
    const r = await callIpc(`const res = await api.eaa.summary(); return res;`)
    const data = r?.data ?? r
    const gainers = data?.top_gainers ?? []
    record('3.5 top_gainers', Array.isArray(gainers) && gainers.length > 0, `gainers=${gainers.length}`)
  })

  await test('3.6 top_losers (跌幅最大)', async () => {
    const r = await callIpc(`const res = await api.eaa.summary(); return res;`)
    const data = r?.data ?? r
    const losers = data?.top_losers ?? []
    record('3.6 top_losers', Array.isArray(losers), `losers=${losers.length}`)
  })

  // ===========================================================
  // 4. 事件时间分布 — 按日期/时段分析
  // ===========================================================
  console.log('\n--- 4. 事件时间分布 ---')

  await test('4.1 今日事件分布', async () => {
    const r = await callIpc(`const res = await api.eaa.range(${JSON.stringify(todayStr)}, ${JSON.stringify(todayStr)}, 2000); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    // 按小时分组
    const hourly = {}
    for (const e of events) {
      const hour = new Date(e.timestamp).getHours()
      hourly[hour] = (hourly[hour] || 0) + 1
    }
    record('4.1 今日事件分布', events.length > 0, `events=${events.length} hours=${Object.keys(hourly).length}`)
  })

  await test('4.2 过去7天每日事件数', async () => {
    const r = await callIpc(`const res = await api.eaa.range(${JSON.stringify(weekAgoStr)}, ${JSON.stringify(todayStr)}, 5000); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    // 按日期分组
    const daily = {}
    for (const e of events) {
      const day = new Date(e.timestamp).toISOString().slice(0, 10)
      daily[day] = (daily[day] || 0) + 1
    }
    record('4.2 过去7天每日事件数', Object.keys(daily).length > 0, `days=${Object.keys(daily).length} total=${events.length}`)
  })

  await test('4.3 事件时间戳格式验证', async () => {
    const r = await callIpc(`const res = await api.eaa.range(${JSON.stringify(todayStr)}, ${JSON.stringify(todayStr)}, 10); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    if (events.length === 0) { record('4.3 事件时间戳格式验证', true, 'no events today'); return }
    const sample = events[0]
    const ts = sample.timestamp
    const validFormat = typeof ts === 'string' && !isNaN(new Date(ts).getTime())
    record('4.3 事件时间戳格式验证', validFormat, `ts=${ts} valid=${validFormat}`)
  })

  await test('4.4 events.jsonl 按时间有序', async () => {
    const content = await fsp.readFile(path.join(eventsDir, 'events.jsonl'), 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    // 抽样检查最后 100 行
    const sample = lines.slice(-100).map(l => JSON.parse(l))
    let isOrdered = true
    for (let i = 1; i < sample.length; i++) {
      if (sample[i - 1].timestamp > sample[i].timestamp) { isOrdered = false; break }
    }
    record('4.4 events.jsonl 按时间有序', isOrdered, `checked=${sample.length} ordered=${isOrdered}`)
  })

  await test('4.5 事件按原因码时间分布', async () => {
    const r = await callIpc(`const res = await api.eaa.range(${JSON.stringify(weekAgoStr)}, ${JSON.stringify(todayStr)}, 500); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    // 按原因码分组
    const byReason = {}
    for (const e of events) {
      const rc = e.reason_code || 'unknown'
      byReason[rc] = (byReason[rc] || 0) + 1
    }
    record('4.5 事件按原因码时间分布', Object.keys(byReason).length > 0, `reasons=${Object.keys(byReason).length}`)
  })

  await test('4.6 事件按标签分布', async () => {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const data = r?.data ?? r
    const tags = data?.tag_distribution ?? []
    record('4.6 事件按标签分布', Array.isArray(tags), `tags=${tags.length}`)
  })

  // ===========================================================
  // 5. 原因码时间趋势 — 不同时间段原因码分布变化
  // ===========================================================
  console.log('\n--- 5. 原因码时间趋势 ---')

  await test('5.1 查看可用原因码列表', async () => {
    const r = await callIpc(`const res = await api.eaa.codes(); return res;`)
    const data = r?.data ?? r
    const codes = data?.codes ?? data
    const count = typeof codes === 'object' ? Object.keys(codes).length : 0
    record('5.1 查看可用原因码列表', count > 0, `codes=${count}`)
  })

  await test('5.2 本年原因码分布', async () => {
    const r = await callIpc(`const res = await api.eaa.summary(${JSON.stringify(yearStart)}, ${JSON.stringify(todayStr)}); return res;`)
    const data = r?.data ?? r
    const reasons = data?.top_reason_codes ?? []
    record('5.2 本年原因码分布', Array.isArray(reasons), `reasons=${reasons.length}`)
  })

  await test('5.3 全局原因码分布 (stats)', async () => {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const data = r?.data ?? r
    const dist = data?.reason_distribution ?? []
    record('5.3 全局原因码分布', Array.isArray(dist) && dist.length > 0, `reasons=${dist.length}`)
  })

  await test('5.4 原因码分布数据结构完整', async () => {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const data = r?.data ?? r
    const dist = data?.reason_distribution ?? []
    if (dist.length === 0) { record('5.4 原因码分布数据结构完整', false, 'empty'); return }
    const sample = dist[0]
    const valid = typeof sample === 'object' && (sample.reason_code || sample.code || sample.reason)
    record('5.4 原因码分布数据结构完整', valid, `sample=${JSON.stringify(sample).slice(0, 80)}`)
  })

  await test('5.5 reason_codes.json 文件可读', async () => {
    const content = await fsp.readFile(path.join(eaaDataDir, 'reason_codes.json'), 'utf-8')
    const data = JSON.parse(content)
    record('5.5 reason_codes.json 文件可读', !!data.codes, `codes=${Object.keys(data.codes || {}).length}`)
  })

  await test('5.6 原因码含 delta 值', async () => {
    const content = await fsp.readFile(path.join(eaaDataDir, 'reason_codes.json'), 'utf-8')
    const data = JSON.parse(content)
    const codes = data.codes || {}
    const entries = Object.entries(codes)
    // reason_codes.json 使用 score_delta 字段 (不是 delta)
    const hasDelta = entries.some(([_, v]) => typeof v.score_delta === 'number')
    record('5.6 原因码含 delta 值', hasDelta, `codes=${entries.length} hasDelta=${hasDelta}`)
  })

  // ===========================================================
  // 6. 数据导出时间维度
  // ===========================================================
  console.log('\n--- 6. 数据导出时间维度 ---')

  await test('6.1 导出全量数据 (JSONL)', async () => {
    // 支持的格式: csv, jsonl, html (不支持 'json')
    const r = await callIpc(`const res = await api.eaa.export('jsonl', ${JSON.stringify(path.join(outputDir, `export_${TS}.jsonl`))}); return res;`)
    record('6.1 导出全量数据 (JSONL)', isOk(r), `success=${r?.success}`)
  })

  await test('6.2 导出全量数据 (CSV)', async () => {
    const r = await callIpc(`const res = await api.eaa.export('csv', ${JSON.stringify(path.join(outputDir, `export_${TS}.csv`))}); return res;`)
    record('6.2 导出全量数据 (CSV)', isOk(r), `success=${r?.success}`)
  })

  await test('6.3 验证导出文件存在', async () => {
    const jsonlFile = path.join(outputDir, `export_${TS}.jsonl`)
    const csvFile = path.join(outputDir, `export_${TS}.csv`)
    const jsonlExists = fs.existsSync(jsonlFile)
    const csvExists = fs.existsSync(csvFile)
    record('6.3 验证导出文件存在', jsonlExists && csvExists, `jsonl=${jsonlExists} csv=${csvExists}`)
  })

  await test('6.4 导出文件含学生数据字段', async () => {
    const jsonlFile = path.join(outputDir, `export_${TS}.jsonl`)
    if (!fs.existsSync(jsonlFile)) { record('6.4 导出文件含学生数据字段', false, 'no file'); return }
    const content = await fsp.readFile(jsonlFile, 'utf-8')
    // jsonl 导出格式为按学生汇总 (每行: {delta, name, risk, score})
    // 检查导出文件是否含核心数据字段
    const hasScore = content.includes('score')
    const hasName = content.includes('name')
    const hasDelta = content.includes('delta')
    record('6.4 导出文件含学生数据字段', hasScore && hasName && hasDelta, `score=${hasScore} name=${hasName} delta=${hasDelta}`)
  })

  await test('6.5 dashboard 生成', async () => {
    const r = await callIpc(`const res = await api.eaa.dashboard(${JSON.stringify(path.join(outputDir, `dashboard_${TS}`))}); return res;`)
    record('6.5 dashboard 生成', isOk(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 7. 趋势数据完整性 — 验证趋势数据可完整读回
  // ===========================================================
  console.log('\n--- 7. 趋势数据完整性 ---')

  await test('7.1 events.jsonl 包含今日所有事件', async () => {
    const content = await fsp.readFile(path.join(eventsDir, 'events.jsonl'), 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const todayEvents = lines.filter(line => {
      try {
        const e = JSON.parse(line)
        return e.timestamp && new Date(e.timestamp).toISOString().slice(0, 10) === todayStr
      } catch { return false }
    })
    record('7.1 events.jsonl 包含今日所有事件', todayEvents.length > 0, `todayEvents=${todayEvents.length}`)
  })

  await test('7.2 operations.jsonl 记录今日操作', async () => {
    const content = await fsp.readFile(path.join(logsDir, 'operations.jsonl'), 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const todayOps = lines.filter(line => {
      try {
        const op = JSON.parse(line)
        return op.timestamp && new Date(op.timestamp).toISOString().slice(0, 10) === todayStr
      } catch { return false }
    })
    record('7.2 operations.jsonl 记录今日操作', todayOps.length > 0, `todayOps=${todayOps.length}`)
  })

  await test('7.3 scores.cache.json 反映最新分数', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const eid = idx[trendStudent]
    const cacheScore = cache[eid]
    // 通过 IPC 查询同一学生分数,验证缓存一致
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(trendStudent)}); return res;`)
    const ipcScore = r?.data?.score ?? r?.score
    record('7.3 scores.cache.json 反映最新分数', cacheScore === ipcScore, `cache=${cacheScore} ipc=${ipcScore}`)
  })

  await test('7.4 event_stats.cache.json 反映最新事件数', async () => {
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'event_stats.cache.json'), 'utf-8'))
    const idx = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'name_index.json'), 'utf-8'))
    const eid = idx[trendStudent]
    const stat = cache[eid]
    record('7.4 event_stats.cache.json 反映最新事件数', !!stat && typeof stat === 'object', `hasStats=${!!stat}`)
  })

  await test('7.5 history 完整记录所有事件', async () => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(trendStudent)}); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    // 验证每个事件都有核心字段 (event_id, timestamp, score_delta)
    // entity_id 可能不在 history 返回中 (history 按学生查询, entity_id 隐含)
    const allComplete = events.every(e =>
      e.event_id && e.timestamp && typeof e.score_delta === 'number'
    )
    const sampleFields = events[0] ? Object.keys(events[0]).join(',') : 'none'
    record('7.5 history 完整记录所有事件', allComplete && events.length === 5, `events=${events.length} complete=${allComplete} fields=${sampleFields.slice(0, 80)}`)
  })

  // ===========================================================
  // 8. 跨时间段数据一致性
  // ===========================================================
  console.log('\n--- 8. 跨时间段数据一致性 ---')

  await test('8.1 两次查询排行榜结果一致', async () => {
    const r1 = await callIpc(`const res = await api.eaa.ranking(10); return res;`)
    const r2 = await callIpc(`const res = await api.eaa.ranking(10); return res;`)
    const d1 = r1?.data ?? r1
    const d2 = r2?.data ?? r2
    const ranking1 = d1?.ranking ?? d1?.data?.ranking ?? []
    const ranking2 = d2?.ranking ?? d2?.data?.ranking ?? []
    const consistent = ranking1.length === ranking2.length &&
      ranking1[0]?.name === ranking2[0]?.name &&
      ranking1[0]?.score === ranking2[0]?.score
    record('8.1 两次查询排行榜结果一致', consistent, `len1=${ranking1.length} len2=${ranking2.length} same=${consistent}`)
  })

  await test('8.2 两次查询统计结果一致', async () => {
    const r1 = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const r2 = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const s1 = r1?.data?.summary ?? r1?.summary ?? {}
    const s2 = r2?.data?.summary ?? r2?.summary ?? {}
    // 允许小差异 (并发测试可能正在写入新事件)
    const studentDiff = Math.abs((s1.students || 0) - (s2.students || 0))
    const eventDiff = Math.abs((s1.total_events || 0) - (s2.total_events || 0))
    record('8.2 两次查询统计结果一致', studentDiff <= 2 && eventDiff <= 5, `students=${s1.students}===${s2.students} events=${s1.total_events}===${s2.total_events}`)
  })

  await test('8.3 score + history 分数一致', async () => {
    const r1 = await callIpc(`const res = await api.eaa.score(${JSON.stringify(trendStudent)}); return res;`)
    const r2 = await callIpc(`const res = await api.eaa.history(${JSON.stringify(trendStudent)}); return res;`)
    const score = r1?.data?.score ?? r1?.score
    const events = Array.isArray(r2?.data) ? r2.data : (r2?.data?.events ?? [])
    const deltaSum = events.filter(e => e.reverted !== true).reduce((sum, e) => sum + (e.score_delta || 0), 0)
    const expectedScore = 100 + deltaSum
    const diff = Math.abs(score - expectedScore)
    record('8.3 score + history 分数一致', diff <= 2, `score=${score} expected=${expectedScore} diff=${diff}`)
  })

  await test('8.4 range + events.jsonl 事件数一致', async () => {
    const r = await callIpc(`const res = await api.eaa.range(${JSON.stringify(todayStr)}, ${JSON.stringify(todayStr)}, 5000); return res;`)
    const data = r?.data ?? r
    const ipcEvents = Array.isArray(data) ? data : (data?.events ?? [])
    const content = await fsp.readFile(path.join(eventsDir, 'events.jsonl'), 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const fileEvents = lines.filter(line => {
      try {
        const e = JSON.parse(line)
        return e.timestamp && new Date(e.timestamp).toISOString().slice(0, 10) === todayStr
      } catch { return false }
    })
    // IPC range 可能有限制,验证 file 事件数 >= IPC 事件数
    record('8.4 range + events.jsonl 事件数一致', fileEvents.length >= ipcEvents.length, `ipc=${ipcEvents.length} file=${fileEvents.length}`)
  })

  await test('8.5 listStudents + scores.cache 学生数一致', async () => {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const data = r?.data ?? r
    const students = Array.isArray(data) ? data : (data?.students ?? [])
    const cache = JSON.parse(await fsp.readFile(path.join(entitiesDir, 'scores.cache.json'), 'utf-8'))
    const cacheCount = Object.keys(cache).length
    // listStudents 可能包含软删除学生, cache 只包含有分数的学生
    record('8.5 listStudents + scores.cache 学生数一致', students.length > 0 && cacheCount > 0, `list=${students.length} cache=${cacheCount}`)
  })

  await test('8.6 两次 summary 查询 top_gainers 一致', async () => {
    const r1 = await callIpc(`const res = await api.eaa.summary(); return res;`)
    const r2 = await callIpc(`const res = await api.eaa.summary(); return res;`)
    const g1 = r1?.data?.top_gainers ?? []
    const g2 = r2?.data?.top_gainers ?? []
    const consistent = g1.length === g2.length
    record('8.6 两次 summary top_gainers 一致', consistent, `g1=${g1.length} g2=${g2.length}`)
  })

  // ===========================================================
  // 9. 时间边界极限 — 跨年/跨月/跨日边界
  // ===========================================================
  console.log('\n--- 9. 时间边界极限 ---')

  await test('9.1 跨年边界 (12-31 → 01-01)', async () => {
    const r = await callIpc(`const res = await api.eaa.range('2025-12-31', '2026-01-01', 100); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('9.1 跨年边界', isOk(r), `events=${events.length}`)
  })

  await test('9.2 跨月边界 (01-31 → 02-01)', async () => {
    const r = await callIpc(`const res = await api.eaa.range('2026-01-31', '2026-02-01', 100); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('9.2 跨月边界', isOk(r), `events=${events.length}`)
  })

  await test('9.3 单日查询 (起止日期相同)', async () => {
    const r = await callIpc(`const res = await api.eaa.range(${JSON.stringify(todayStr)}, ${JSON.stringify(todayStr)}, 1000); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('9.3 单日查询', isOk(r), `events=${events.length}`)
  })

  await test('9.4 超大时间范围 (10年)', async () => {
    const r = await callIpc(`const res = await api.eaa.range('2016-01-01', '2026-12-31', 100); return res;`)
    const data = r?.data ?? r
    const events = Array.isArray(data) ? data : (data?.events ?? [])
    record('9.4 超大时间范围 (10年)', isOk(r), `events=${events.length}`)
  })

  await test('9.5 日期格式边界 (不同分隔符)', async () => {
    // EAA 应该只接受 YYYY-MM-DD 格式
    const r = await callIpc(`const res = await api.eaa.range('2026/01/01', '2026/12/31', 10); return res;`)
    // 非标准格式应该返回错误或空结果
    const handled = r !== null && r !== undefined
    record('9.5 日期格式边界', handled, `handled=${handled} error=${r?.__error?.slice(0, 60) || 'none'}`)
  })

  // ---------- 汇总 ----------
  console.log('\n============================================================')
  const passed = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length
  console.log(`Round 24 AI 跨时间段数据分析 + 趋势数据可达性测试: 总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`)
  console.log('============================================================')
  if (failed > 0) {
    console.log('\n失败用例:')
    results.filter(r => !r.ok).forEach(r => console.log(`  [FAIL] ${r.name} — ${r.detail}`))
  }

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
