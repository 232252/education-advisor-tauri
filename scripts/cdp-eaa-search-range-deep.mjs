// =============================================================
// EAA 查询类 API 深度测试 — 通过 CDP + Tauri Bridge
// 覆盖: search / range / tag / stats / summary / codes 的正常、边界、
//       非法输入、并发与幂等场景。全部为只读操作, 不修改任何数据。
//
// 运行: node scripts/cdp-eaa-search-range-deep.mjs
// 前置: Tauri 应用已运行, CDP 远程调试端口 9222 可用
// 连接样板与 scripts/cdp-eaa-integration.mjs 一致
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
  console.log('CDP connected, running deep query tests...\n')

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

  // 响应判定工具
  // okSuccess: IPC 成功 (CLI 正常返回)
  const okSuccess = (r) => !!r && r.success === true
  // okError: 处理器主动抛错 (参数校验失败等), 返回结构化 __error
  const okError = (r) => !!r && typeof r.__error === 'string' && r.__error.length > 0
  // okGraceful: 未崩溃应用 — 成功 / 结构化错误 / CLI 失败但带 stderr
  const okGraceful = (r) => okSuccess(r) || okError(r) || (!!r && r.success === false && typeof r.stderr === 'string')

  try {
    // ========== 准备: 验证 API 可用 + 取真实学生名/标签 ==========
    const infoR = await callIpc(`const res = await api.eaa.info(); return res;`)
    if (infoR?.__error || !infoR?.success) {
      console.log('FAIL: EAA API 不可用:', infoR?.__error || JSON.stringify(infoR))
      ws.close()
      process.exit(1)
    }
    console.log(`EAA info: version=${infoR?.data?.version} students=${infoR?.data?.students} events=${infoR?.data?.events}`)

    const listR = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const students = listR?.data?.students || []
    const listTotal = listR?.data?.total
    const realStudent = students.find((s) => s.status !== 'Deleted') || students[0]
    const realName = realStudent?.name || '张三'
    console.log(`学生数: ${students.length}, 测试用学生名: ${realName}\n`)

    const tagListR = await callIpc(`const res = await api.eaa.tag(); return res;`)
    const tagList = tagListR?.data?.tags || []
    const realTag = tagList[0]?.tag || '测试'
    console.log(`标签数: ${tagList.length}, 测试用标签: ${realTag}\n`)

    // ============================================================
    // 1. search 深度测试
    // ============================================================
    // 1.1 正常关键词 (真实学生名)
    try {
      const r = await callIpc(`const res = await api.eaa.search(${JSON.stringify(realName)}, 10); return res;`)
      const evts = r?.data?.events
      record('search 正常关键词', okSuccess(r) && Array.isArray(evts), `total=${r?.data?.total ?? 0} showing=${evts?.length ?? 0}`)
    } catch (err) { record('search 正常关键词', false, String(err.message || err)) }

    // 1.2 空字符串 (边界: 不应崩溃)
    try {
      const r = await callIpc(`const res = await api.eaa.search('', 5); return res;`)
      record('search 空字符串', okGraceful(r), `success=${r?.success} total=${r?.data?.total ?? 'n/a'} err=${r?.__error ? '有' : '无'}`)
    } catch (err) { record('search 空字符串', false, String(err.message || err)) }

    // 1.3 正则元字符
    try {
      const r = await callIpc(`const res = await api.eaa.search('.*[]?', 5); return res;`)
      record('search 正则元字符', okGraceful(r), `success=${r?.success} total=${r?.data?.total ?? 'n/a'} err=${r?.__error ? '有' : '无'}`)
    } catch (err) { record('search 正则元字符', false, String(err.message || err)) }

    // 1.4 HTML 注入串
    try {
      const r = await callIpc(`const res = await api.eaa.search('<script>alert(1)</script>', 5); return res;`)
      record('search HTML 注入串', okGraceful(r), `success=${r?.success} total=${r?.data?.total ?? 'n/a'} err=${r?.__error ? '有' : '无'}`)
    } catch (err) { record('search HTML 注入串', false, String(err.message || err)) }

    // 1.5 SQL 注入串
    try {
      const r = await callIpc(`const res = await api.eaa.search("'; DROP--", 5); return res;`)
      record('search SQL 注入串', okGraceful(r), `success=${r?.success} total=${r?.data?.total ?? 'n/a'} err=${r?.__error ? '有' : '无'}`)
    } catch (err) { record('search SQL 注入串', false, String(err.message || err)) }

    // 1.6 Unicode / emoji
    try {
      const r = await callIpc(`const res = await api.eaa.search('测试🎉🎓', 5); return res;`)
      record('search Unicode/emoji', okGraceful(r), `success=${r?.success} total=${r?.data?.total ?? 'n/a'} err=${r?.__error ? '有' : '无'}`)
    } catch (err) { record('search Unicode/emoji', false, String(err.message || err)) }

    // 1.7 超长关键词 (>100 字符)
    try {
      const longKw = 'A'.repeat(200)
      const r = await callIpc(`const res = await api.eaa.search(${JSON.stringify(longKw)}, 5); return res;`)
      record('search 超长关键词(200字符)', okGraceful(r), `success=${r?.success} total=${r?.data?.total ?? 'n/a'} err=${r?.__error ? '有' : '无'}`)
    } catch (err) { record('search 超长关键词(200字符)', false, String(err.message || err)) }

    // 1.8 不存在关键词 (应返回空, 不崩溃)
    try {
      const r = await callIpc(`const res = await api.eaa.search('ZZZZNOTEXIST99999', 5); return res;`)
      const total = r?.data?.total
      record('search 不存在关键词', okSuccess(r) && total === 0, `success=${r?.success} total=${total}`)
    } catch (err) { record('search 不存在关键词', false, String(err.message || err)) }

    // 1.9 带 limit 选项
    try {
      const r = await callIpc(`const res = await api.eaa.search(${JSON.stringify(realName)}, 3); return res;`)
      const evts = r?.data?.events
      record('search 带 limit=3', okSuccess(r) && Array.isArray(evts) && evts.length <= 3, `showing=${evts?.length ?? 0} (<=3)`)
    } catch (err) { record('search 带 limit=3', false, String(err.message || err)) }

    // ============================================================
    // 2. range 深度测试
    // ============================================================
    // 2.1 有效日期范围
    try {
      const r = await callIpc(`const res = await api.eaa.range('2026-01-01', '2026-12-31', 10); return res;`)
      record('range 有效日期范围', okSuccess(r), `start=${r?.data?.start ?? ''} end=${r?.data?.end ?? ''} total=${r?.data?.total ?? 0}`)
    } catch (err) { record('range 有效日期范围', false, String(err.message || err)) }

    // 2.2 同一天 (start=end)
    try {
      const r = await callIpc(`const res = await api.eaa.range('2026-07-15', '2026-07-15', 10); return res;`)
      record('range 同一天', okSuccess(r), `total=${r?.data?.total ?? 0}`)
    } catch (err) { record('range 同一天', false, String(err.message || err)) }

    // 2.3 反转范围 (start > end) — 处理器应抛错
    try {
      const r = await callIpc(`const res = await api.eaa.range('2026-12-31', '2026-01-01', 10); return res;`)
      record('range 反转范围(start>end)', okError(r), `err=${r?.__error ? '有' : '无'} msg=${r?.__error || (r?.data?.total ?? '')}`)
    } catch (err) { record('range 反转范围(start>end)', false, String(err.message || err)) }

    // 2.4 非法日期格式 (斜杠)
    try {
      const r = await callIpc(`const res = await api.eaa.range('2026/01/01', '2026/12/31', 10); return res;`)
      record('range 非法格式(斜杠)', okError(r), `err=${r?.__error ? '有' : '无'}`)
    } catch (err) { record('range 非法格式(斜杠)', false, String(err.message || err)) }

    // 2.5 非法日期 (非日期字符串)
    try {
      const r = await callIpc(`const res = await api.eaa.range('invalid', '2026-01-01', 10); return res;`)
      record('range 非法日期(invalid)', okError(r), `err=${r?.__error ? '有' : '无'}`)
    } catch (err) { record('range 非法日期(invalid)', false, String(err.message || err)) }

    // 2.6 空字符串日期
    try {
      const r = await callIpc(`const res = await api.eaa.range('', '2026-01-01', 10); return res;`)
      record('range 空字符串日期', okError(r), `err=${r?.__error ? '有' : '无'}`)
    } catch (err) { record('range 空字符串日期', false, String(err.message || err)) }

    // 2.7 未来日期范围 (应返回空)
    try {
      const r = await callIpc(`const res = await api.eaa.range('2099-01-01', '2099-12-31', 10); return res;`)
      const total = r?.data?.total
      record('range 未来日期范围', okSuccess(r) && total === 0, `total=${total}`)
    } catch (err) { record('range 未来日期范围', false, String(err.message || err)) }

    // 2.8 极宽范围
    try {
      const r = await callIpc(`const res = await api.eaa.range('2000-01-01', '2099-12-31', 10); return res;`)
      record('range 极宽范围(2000~2099)', okSuccess(r), `total=${r?.data?.total ?? 0} showing=${r?.data?.showing ?? 0}`)
    } catch (err) { record('range 极宽范围(2000~2099)', false, String(err.message || err)) }

    // 2.9 边界: 非闰年 2 月 29 日 (格式合法但日期不存在, 不应崩溃)
    try {
      const r = await callIpc(`const res = await api.eaa.range('2026-02-29', '2026-02-29', 10); return res;`)
      record('range 非闰年2-29边界', okGraceful(r), `success=${r?.success} err=${r?.__error ? '有' : '无'} total=${r?.data?.total ?? 'n/a'}`)
    } catch (err) { record('range 非闰年2-29边界', false, String(err.message || err)) }

    // ============================================================
    // 3. tag 深度测试
    // ============================================================
    // 3.1 列表模式 (无参)
    try {
      const r = await callIpc(`const res = await api.eaa.tag(); return res;`)
      const tags = r?.data?.tags
      record('tag 列表模式', okSuccess(r) && Array.isArray(tags), `tags=${tags?.length ?? 0}`)
    } catch (err) { record('tag 列表模式', false, String(err.message || err)) }

    // 3.2 正常标签名 (真实标签)
    try {
      const r = await callIpc(`const res = await api.eaa.tag(${JSON.stringify(realTag)}); return res;`)
      record('tag 正常标签名', okSuccess(r), `tag=${r?.data?.tag ?? ''} total=${r?.data?.total ?? 0}`)
    } catch (err) { record('tag 正常标签名', false, String(err.message || err)) }

    // 3.3 空字符串 (等价列表模式, 不应崩溃)
    try {
      const r = await callIpc(`const res = await api.eaa.tag(''); return res;`)
      const tags = r?.data?.tags
      record('tag 空字符串', okSuccess(r) && Array.isArray(tags), `tags=${tags?.length ?? 0}`)
    } catch (err) { record('tag 空字符串', false, String(err.message || err)) }

    // 3.4 特殊字符 (含非法字符 < >, 处理器应拒绝)
    try {
      const r = await callIpc(`const res = await api.eaa.tag('<script>'); return res;`)
      record('tag 特殊字符(非法)', okError(r), `err=${r?.__error ? '有' : '无'}`)
    } catch (err) { record('tag 特殊字符(非法)', false, String(err.message || err)) }

    // 3.5 不存在标签名 (应返回空, 不崩溃)
    try {
      const r = await callIpc(`const res = await api.eaa.tag('ZZZNONEXISTTAG999'); return res;`)
      const total = r?.data?.total
      record('tag 不存在标签名', okSuccess(r) && total === 0, `total=${total}`)
    } catch (err) { record('tag 不存在标签名', false, String(err.message || err)) }

    // ============================================================
    // 4. stats 深度测试
    // ============================================================
    let statsSummary = null
    // 4.1 结构校验
    try {
      const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
      statsSummary = r?.data?.summary
      const hasFields = statsSummary &&
        typeof statsSummary.students === 'number' &&
        typeof statsSummary.total_events === 'number' &&
        typeof statsSummary.valid_events === 'number'
      record('stats 结构校验', okSuccess(r) && hasFields, `students=${statsSummary?.students} total_events=${statsSummary?.total_events} valid_events=${statsSummary?.valid_events}`)
    } catch (err) { record('stats 结构校验', false, String(err.message || err)) }

    // 4.2 与 listStudents 一致性
    try {
      const consistent = typeof statsSummary?.students === 'number' && typeof listTotal === 'number' && statsSummary.students === listTotal
      record('stats 与 listStudents 一致', consistent, `stats.students=${statsSummary?.students} listStudents.total=${listTotal}`)
    } catch (err) { record('stats 与 listStudents 一致', false, String(err.message || err)) }

    // ============================================================
    // 5. summary 深度测试
    // ============================================================
    // 5.1 有效 since/until
    try {
      const r = await callIpc(`const res = await api.eaa.summary('2026-01-01', '2026-12-31'); return res;`)
      const ev = r?.data?.events
      record('summary 有效区间', okSuccess(r) && ev && typeof ev.total === 'number', `total=${ev?.total} bonus=${ev?.bonus_count} deduct=${ev?.deduct_count}`)
    } catch (err) { record('summary 有效区间', false, String(err.message || err)) }

    // 5.2 同一天
    try {
      const r = await callIpc(`const res = await api.eaa.summary('2026-07-15', '2026-07-15'); return res;`)
      record('summary 同一天', okSuccess(r), `total=${r?.data?.events?.total ?? 0}`)
    } catch (err) { record('summary 同一天', false, String(err.message || err)) }

    // 5.3 反转日期 (不应崩溃)
    try {
      const r = await callIpc(`const res = await api.eaa.summary('2026-12-31', '2026-01-01'); return res;`)
      record('summary 反转日期', okGraceful(r), `success=${r?.success} err=${r?.__error ? '有' : '无'} total=${r?.data?.events?.total ?? 'n/a'}`)
    } catch (err) { record('summary 反转日期', false, String(err.message || err)) }

    // 5.4 非法日期格式
    try {
      const r = await callIpc(`const res = await api.eaa.summary('2026/01/01', '2026/12/31'); return res;`)
      record('summary 非法日期格式', okError(r), `err=${r?.__error ? '有' : '无'}`)
    } catch (err) { record('summary 非法日期格式', false, String(err.message || err)) }

    // 5.5 缺省参数 (全量摘要)
    try {
      const r = await callIpc(`const res = await api.eaa.summary(); return res;`)
      const ev = r?.data?.events
      record('summary 缺省参数', okSuccess(r) && ev && typeof ev.total === 'number', `total=${ev?.total} bonus=${ev?.bonus_count} deduct=${ev?.deduct_count}`)
    } catch (err) { record('summary 缺省参数', false, String(err.message || err)) }

    // ============================================================
    // 6. codes 深度测试
    // ============================================================
    let codesList = null
    // 6.1 返回 reason codes 数组
    try {
      const r = await callIpc(`const res = await api.eaa.codes(); return res;`)
      codesList = r?.data?.codes
      record('codes 返回数组', okSuccess(r) && Array.isArray(codesList) && codesList.length > 0, `codes=${codesList?.length} version=${r?.data?.version ?? ''}`)
    } catch (err) { record('codes 返回数组', false, String(err.message || err)) }

    // 6.2 每条 code 字段校验 (code + 分值字段 + 说明字段)
    try {
      const allValid = Array.isArray(codesList) && codesList.every((c) =>
        typeof c?.code === 'string' &&
        (('score_delta' in c) || ('delta' in c)) &&
        (('label' in c) || ('description' in c))
      )
      const sample = codesList?.[0]
      record('codes 字段校验', allValid, `sample.code=${sample?.code} score_delta=${sample?.score_delta ?? sample?.delta ?? 'n/a'} label=${sample?.label ?? sample?.description ?? 'n/a'}`)
    } catch (err) { record('codes 字段校验', false, String(err.message || err)) }

    // ============================================================
    // 7. 并发只读 (search + range + stats + summary + codes 同时)
    // ============================================================
    try {
      const ops = [
        callIpc(`const res = await api.eaa.search(${JSON.stringify(realName)}, 5); return res;`),
        callIpc(`const res = await api.eaa.range('2026-01-01', '2026-12-31', 5); return res;`),
        callIpc(`const res = await api.eaa.stats(); return res;`),
        callIpc(`const res = await api.eaa.summary('2026-01-01', '2026-12-31'); return res;`),
        callIpc(`const res = await api.eaa.codes(); return res;`),
      ]
      const rs = await Promise.all(ops)
      const allOk = rs.every(okSuccess)
      const noCrash = rs.every((r) => r && !r.__error)
      record('并发只读(5路)', allOk && noCrash, `成功=${rs.filter(okSuccess).length}/5 崩溃=${rs.some(r => !r || r.__error) ? '有' : '无'}`)
    } catch (err) { record('并发只读(5路)', false, String(err.message || err)) }

    // ============================================================
    // 8. 幂等性 (只读操作多次调用结果一致)
    // ============================================================
    // 8.1 stats 调用 3 次结果一致
    try {
      const r1 = await callIpc(`const res = await api.eaa.stats(); return JSON.stringify(res?.data?.summary);`)
      const r2 = await callIpc(`const res = await api.eaa.stats(); return JSON.stringify(res?.data?.summary);`)
      const r3 = await callIpc(`const res = await api.eaa.stats(); return JSON.stringify(res?.data?.summary);`)
      const same = r1 === r2 && r2 === r3 && typeof r1 === 'string'
      record('stats 幂等(3次一致)', same, `一致=${same} students=${r1 ? JSON.parse(r1).students : 'n/a'}`)
    } catch (err) { record('stats 幂等(3次一致)', false, String(err.message || err)) }

    // 8.2 codes 调用 3 次结果一致
    try {
      const r1 = await callIpc(`const res = await api.eaa.codes(); return JSON.stringify(res?.data?.codes);`)
      const r2 = await callIpc(`const res = await api.eaa.codes(); return JSON.stringify(res?.data?.codes);`)
      const r3 = await callIpc(`const res = await api.eaa.codes(); return JSON.stringify(res?.data?.codes);`)
      const same = r1 === r2 && r2 === r3 && typeof r1 === 'string'
      record('codes 幂等(3次一致)', same, `一致=${same} count=${r1 ? JSON.parse(r1).length : 'n/a'}`)
    } catch (err) { record('codes 幂等(3次一致)', false, String(err.message || err)) }

    // 8.3 search 幂等 (同一关键词 3 次结果一致)
    try {
      const r1 = await callIpc(`const res = await api.eaa.search(${JSON.stringify(realName)}, 5); return JSON.stringify({total: res?.data?.total, n: res?.data?.events?.length});`)
      const r2 = await callIpc(`const res = await api.eaa.search(${JSON.stringify(realName)}, 5); return JSON.stringify({total: res?.data?.total, n: res?.data?.events?.length});`)
      const same = r1 === r2 && typeof r1 === 'string'
      record('search 幂等(2次一致)', same, `一致=${same} ${r1 || ''}`)
    } catch (err) { record('search 幂等(2次一致)', false, String(err.message || err)) }

  } finally {
    // ========== 汇总 ==========
    console.log('\n========== EAA 查询类 API 深度测试汇总 ==========')
    const passed = results.filter((r) => r.ok).length
    const failed = results.filter((r) => !r.ok).length
    console.log(`总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`)
    if (failed > 0) {
      console.log('\n失败项:')
      for (const r of results.filter((r) => !r.ok)) {
        console.log(`  - ${r.name}: ${r.detail}`)
      }
    }
    console.log('================================================')

    ws.close()
    process.exit(failed > 0 ? 1 : 0)
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
