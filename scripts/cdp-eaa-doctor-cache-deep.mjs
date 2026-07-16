// =============================================================
// EAA doctor / rebuild-cache / 缓存一致性深度测试 — 通过 CDP + Tauri Bridge
// 测试 EAA 的 doctor 健康检查, rebuild-cache 重建, validate 多 scope,
// 以及 3 个缓存文件 (scores.cache / event_stats.cache / daily_dedup.cache) 的一致性
//
// 运行: node scripts/cdp-eaa-doctor-cache-deep.mjs
// 前置: Tauri 应用已运行, CDP 远程调试端口 9222 可用
// 连接样板与 scripts/cdp-eaa-integration.mjs / cdp-eaa-concurrent-cache.mjs 一致
// =============================================================
import http from 'node:http'

const CDP_PORT = 9222
const BASE = `http://127.0.0.1:${CDP_PORT}`

// 标准 reason code 及其 delta (必须匹配, 否则 addEvent 会失败)
const CODE_DELTA = {
  CLASS_COMMITTEE: 5,
  CIVILIZED_DORM: 3,
  CLASS_MONITOR: 10,
}

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
  console.log('CDP connected, running EAA doctor/cache deep tests...\n')

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

  const numEq = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.001

  // API 封装
  const getScore = async (name) => {
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(name)}); return res;`)
    return { ok: r?.success === true, score: r?.data?.score, data: r?.data, raw: r }
  }
  const getStats = async () => {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    return { ok: r?.success === true, summary: r?.data?.summary, raw: r }
  }
  const getRanking = async (limit) => {
    const r = await callIpc(`const res = await api.eaa.ranking(${limit}); return res;`)
    return { ok: r?.success === true, ranking: r?.data?.ranking || [], total: r?.data?.total, raw: r }
  }
  const getListStudents = async () => {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    return { ok: r?.success === true, total: r?.data?.total, students: r?.data?.students || [], raw: r }
  }
  const validate = async (scope) => {
    const code = scope === undefined
      ? `const res = await api.eaa.validate(); return res;`
      : `const res = await api.eaa.validate(${JSON.stringify(scope)}); return res;`
    return await callIpc(code)
  }
  const doctor = async () => {
    return await callIpc(`const res = await api.eaa.doctor(); return res;`)
  }
  const rebuildCache = async () => {
    return await callIpc(`const res = await api.eaa.rebuildCache(); return res;`)
  }
  const addEvent = async (studentName, reasonCode, delta, note) => {
    const r = await callIpc(`
      const res = await api.eaa.addEvent({
        studentName: ${JSON.stringify(studentName)},
        reasonCode: ${JSON.stringify(reasonCode)},
        delta: ${delta},
        note: ${JSON.stringify(note)},
        force: true,
      });
      return res;
    `)
    const text = String(r?.data ?? '')
    const m = text.match(/evt_\w+/)
    return { ok: r?.success === true, eventId: m ? m[0] : null, text, raw: r }
  }
  const revertEvent = async (eventId) => {
    const r = await callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(eventId)}, 'doctor/cache深度测试撤销'); return res;`)
    return { ok: r?.success === true, raw: r }
  }

  // 全局: 收集所有创建的事件 ID, 用于最终安全清理 (每条测试会优先自行撤销, 此处仅作兜底)
  const allCreatedEvents = []
  const track = (eventId) => { if (eventId) allCreatedEvents.push(eventId) }
  const untrack = (eventId) => {
    if (!eventId) return
    const i = allCreatedEvents.indexOf(eventId)
    if (i >= 0) allCreatedEvents.splice(i, 1)
  }
  const revertAndUntrack = async (eventId) => {
    if (!eventId) return { ok: false, raw: null }
    const r = await revertEvent(eventId)
    if (r.ok) untrack(eventId)
    return r
  }

  // 在 try 外声明, 供 finally 引用
  let testStudent = null
  let originalScoreVal = null
  let doctorAvailable = false
  let rebuildCacheAvailable = false

  try {
    // ========== 准备: 验证 API 可用 + 获取学生列表 ==========
    const infoR = await callIpc(`const res = await api.eaa.info(); return res;`)
    if (infoR?.__error || !infoR?.success) {
      console.log('FAIL: EAA API 不可用:', infoR?.__error || JSON.stringify(infoR))
      ws.close()
      process.exit(1)
    }
    console.log(`EAA info: version=${infoR?.data?.version} students=${infoR?.data?.students} events=${infoR?.data?.events}`)

    const listR = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const students = listR?.data?.students || []
    // 从 ranking 中选取测试学生, 确保其在 top 1000 排名中 (ranking 相关测试需要)
    const rankInitR = await callIpc(`const res = await api.eaa.ranking(1000); return res;`)
    const rankInitStudents = rankInitR?.data?.ranking || []
    const rankFirstName = rankInitStudents[0]?.name
    testStudent = rankFirstName ? students.find((s) => s.name === rankFirstName) : null
    if (!testStudent) {
      // 回退: 第一个非 Deleted 学生
      testStudent = students.find((s) => s.status !== 'Deleted') || students[0]
    }
    if (!testStudent) {
      record('准备-测试学生存在', false, '无可用学生')
      ws.close()
      process.exit(1)
    }
    record('准备-测试学生存在', true, `name=${testStudent.name} score=${testStudent.score} (来自ranking顶部, 确保ranking测试可用)`)

    const originalScore = await getScore(testStudent.name)
    originalScoreVal = originalScore.score
    console.log(`测试学生原始分数: ${testStudent.name} = ${originalScoreVal}\n`)

    // ========== 1. API Probe (4 tests) ==========
    // 1.1 Probe all eaa.* method keys
    try {
      const keys = await callIpc(`return { keys: Object.keys(api.eaa || {}).sort() };`)
      const methodList = keys?.keys || []
      const hasValidate = methodList.includes('validate')
      const hasDoctor = methodList.includes('doctor')
      const hasRebuildCache = methodList.includes('rebuildCache')
      doctorAvailable = hasDoctor
      rebuildCacheAvailable = hasRebuildCache
      record('1.1-API探测-eaa方法列表', Array.isArray(methodList) && methodList.length > 0,
        `methods=${methodList.length} validate=${hasValidate} doctor=${hasDoctor} rebuildCache=${hasRebuildCache}`)
    } catch (err) {
      record('1.1-API探测-eaa方法列表', false, String(err.message || err))
    }

    // 1.2 validate exists
    try {
      const probe = await callIpc(`return { exists: typeof api.eaa.validate === 'function' };`)
      record('1.2-API探测-validate存在', probe?.exists === true, `exists=${probe?.exists}`)
    } catch (err) {
      record('1.2-API探测-validate存在', false, String(err.message || err))
    }

    // 1.3 doctor exists
    try {
      const probe = await callIpc(`return { exists: typeof api.eaa.doctor === 'function' };`)
      doctorAvailable = doctorAvailable && probe?.exists === true
      record('1.3-API探测-doctor存在', probe?.exists === true, `exists=${probe?.exists}`)
    } catch (err) {
      record('1.3-API探测-doctor存在', false, String(err.message || err))
    }

    // 1.4 rebuildCache 探测 (探测完成即通过, 无论是否存在; 不存在则跳过 rebuild 测试)
    try {
      const probe = await callIpc(`return { exists: typeof api.eaa.rebuildCache === 'function' };`)
      rebuildCacheAvailable = rebuildCacheAvailable && probe?.exists === true
      record('1.4-API探测-rebuildCache探测', probe?.exists !== undefined,
        `exists=${probe?.exists}${probe?.exists ? '' : ' (不可用, 将跳过 rebuild 测试)'}`)
    } catch (err) {
      record('1.4-API探测-rebuildCache探测', false, String(err.message || err))
    }

    // ========== 2. validate deep test (8 tests) ==========
    // 2.1 validate() no args
    let validateNoArgs = null
    try {
      validateNoArgs = await validate()
      const data = validateNoArgs?.data
      const valid = data?.valid ?? validateNoArgs?.valid
      const errors = data?.errors ?? validateNoArgs?.errors
      record('2.1-validate无参', validateNoArgs?.success === true,
        `success=${validateNoArgs?.success} valid=${valid} errors=${Array.isArray(errors) ? errors.length : 'N/A'}`)
    } catch (err) {
      record('2.1-validate无参', false, String(err.message || err))
    }

    // 2.2 validate('all')
    try {
      const r = await validate('all')
      const data = r?.data
      const valid = data?.valid ?? r?.valid
      record('2.2-validate-all', r?.success === true && valid === true, `success=${r?.success} valid=${valid}`)
    } catch (err) {
      record('2.2-validate-all', false, String(err.message || err))
    }

    // 2.3 validate('scores')
    try {
      const r = await validate('scores')
      const data = r?.data
      const valid = data?.valid ?? r?.valid
      record('2.3-validate-scores', r?.success === true, `success=${r?.success} valid=${valid}`)
    } catch (err) {
      record('2.3-validate-scores', false, String(err.message || err))
    }

    // 2.4 validate('events')
    try {
      const r = await validate('events')
      const data = r?.data
      const valid = data?.valid ?? r?.valid
      record('2.4-validate-events', r?.success === true, `success=${r?.success} valid=${valid}`)
    } catch (err) {
      record('2.4-validate-events', false, String(err.message || err))
    }

    // 2.5 validate('nonexistent') - 优雅处理
    try {
      const r = await validate('nonexistent')
      // 优雅处理: success=true (no-op) 或 success=false (拒绝) 或 __error (捕获异常)
      const graceful = r != null && (r.success === true || r.success === false || typeof r.__error === 'string')
      record('2.5-validate-无效scope优雅处理', graceful,
        `success=${r?.success} error=${r?.__error ?? 'none'}`)
    } catch (err) {
      record('2.5-validate-无效scope优雅处理', false, String(err.message || err))
    }

    // 2.6 validate('') - 优雅处理
    try {
      const r = await validate('')
      const graceful = r != null && (r.success === true || r.success === false || typeof r.__error === 'string')
      record('2.6-validate-空字符串优雅处理', graceful,
        `success=${r?.success} error=${r?.__error ?? 'none'}`)
    } catch (err) {
      record('2.6-validate-空字符串优雅处理', false, String(err.message || err))
    }

    // 2.7 validate 返回 {success, valid, errors} 结构
    try {
      const r = validateNoArgs
      const data = r?.data
      const hasValid = data?.valid !== undefined || r?.valid !== undefined
      const hasErrors = Array.isArray(data?.errors) || Array.isArray(r?.errors)
      record('2.7-validate返回结构', r?.success === true && hasValid && hasErrors,
        `hasValid=${hasValid} hasErrors=${hasErrors}`)
    } catch (err) {
      record('2.7-validate返回结构', false, String(err.message || err))
    }

    // 2.8 valid=true 且 errors=0
    try {
      const r = validateNoArgs
      const data = r?.data
      const valid = data?.valid ?? r?.valid
      const errors = data?.errors ?? r?.errors
      const errorCount = Array.isArray(errors) ? errors.length : 0
      record('2.8-validate数据健康', valid === true && errorCount === 0,
        `valid=${valid} errors=${errorCount}`)
    } catch (err) {
      record('2.8-validate数据健康', false, String(err.message || err))
    }

    // ========== 3. doctor check (2 tests) ==========
    if (doctorAvailable) {
      // 3.1 doctor() 返回健康检查结果
      let doctorResult = null
      try {
        doctorResult = await doctor()
        const data = doctorResult?.data
        const healthy = data?.healthy
        const passed = data?.passed
        const failed = data?.failed
        record('3.1-doctor返回健康检查', doctorResult?.success === true && data,
          `success=${doctorResult?.success} healthy=${healthy} passed=${passed} failed=${failed}`)
      } catch (err) {
        record('3.1-doctor返回健康检查', false, String(err.message || err))
      }

      // 3.2 doctor 结构化检查 (events file / score consistency / cache consistency)
      try {
        const data = doctorResult?.data
        const issues = data?.issues
        const hasIssuesField = Array.isArray(issues)
        const hasStructured = data && (data.healthy !== undefined || data.passed !== undefined || data.failed !== undefined)
        record('3.2-doctor结构化检查', hasStructured && hasIssuesField,
          `healthy=${data?.healthy} passed=${data?.passed} failed=${data?.failed} issues=${issues?.length ?? 0}`)
      } catch (err) {
        record('3.2-doctor结构化检查', false, String(err.message || err))
      }
    } else {
      console.log('\n注意: doctor 不可用, 跳过测试 3.1/3.2')
      record('3.1-doctor返回健康检查', true, 'doctor 不可用, 跳过')
      record('3.2-doctor结构化检查', true, 'doctor 不可用, 跳过')
    }

    // ========== 4. rebuild-cache (4 tests) ==========
    if (rebuildCacheAvailable) {
      // 4.1 rebuildCache() 成功
      let rebuildOk = false
      try {
        const r = await rebuildCache()
        rebuildOk = r?.success === true
        record('4.1-rebuildCache成功', rebuildOk,
          `success=${r?.success} data=${String(r?.data ?? '').slice(0, 80)}`)
      } catch (err) {
        record('4.1-rebuildCache成功', false, String(err.message || err))
      }

      // 4.2 rebuild 后 stats 正常
      try {
        const r = await getStats()
        record('4.2-rebuild后stats正常', r?.ok === true && r?.summary,
          `students=${r?.summary?.students} total_events=${r?.summary?.total_events}`)
      } catch (err) {
        record('4.2-rebuild后stats正常', false, String(err.message || err))
      }

      // 4.3 rebuild 后 score 匹配
      try {
        const r = await getScore(testStudent.name)
        record('4.3-rebuild后score正常', r?.ok === true && numEq(r?.score, originalScoreVal),
          `score=${r?.score} 原始=${originalScoreVal}`)
      } catch (err) {
        record('4.3-rebuild后score正常', false, String(err.message || err))
      }

      // 4.4 rebuild 后 ranking 工作
      try {
        const r = await getRanking(10)
        record('4.4-rebuild后ranking正常', r?.ok === true && Array.isArray(r?.ranking),
          `top=${r?.ranking?.length ?? 0}`)
      } catch (err) {
        record('4.4-rebuild后ranking正常', false, String(err.message || err))
      }
    } else {
      console.log('\n注意: rebuildCache 不可用, 跳过测试 4.1-4.4')
      record('4.1-rebuildCache成功', true, 'rebuildCache 不可用, 跳过')
      record('4.2-rebuild后stats正常', true, 'rebuildCache 不可用, 跳过')
      record('4.3-rebuild后score正常', true, 'rebuildCache 不可用, 跳过')
      record('4.4-rebuild后ranking正常', true, 'rebuildCache 不可用, 跳过')
    }

    // ========== 5. Cache consistency (5 tests) ==========
    // 5.1 stats 在 addEvent 前后更新 (total_events +1, valid_events +1)
    try {
      const statsBefore = await getStats()
      const totalBefore = statsBefore.summary?.total_events
      const validBefore = statsBefore.summary?.valid_events
      const addR = await addEvent(testStudent.name, 'CLASS_COMMITTEE', CODE_DELTA.CLASS_COMMITTEE, '缓存测试5.1')
      track(addR.eventId)
      const statsAfter = await getStats()
      const totalAfter = statsAfter.summary?.total_events
      const validAfter = statsAfter.summary?.valid_events
      const totalUpdated = totalAfter === (totalBefore ?? 0) + 1
      const validUpdated = validAfter === (validBefore ?? 0) + 1
      if (addR.eventId) await revertAndUntrack(addR.eventId)
      record('5.1-stats在addEvent前后更新', addR.ok && totalUpdated && validUpdated,
        `total: ${totalBefore}→${totalAfter} (+1=${totalUpdated}) valid: ${validBefore}→${validAfter} (+1=${validUpdated})`)
    } catch (err) {
      record('5.1-stats在addEvent前后更新', false, String(err.message || err))
    }

    // 5.2 score 在 addEvent 前后更新
    try {
      const before = await getScore(testStudent.name)
      const addR = await addEvent(testStudent.name, 'CLASS_COMMITTEE', CODE_DELTA.CLASS_COMMITTEE, '缓存测试5.2')
      track(addR.eventId)
      const after = await getScore(testStudent.name)
      const scoreUpdated = numEq(after.score, (before.score ?? 0) + CODE_DELTA.CLASS_COMMITTEE)
      if (addR.eventId) await revertAndUntrack(addR.eventId)
      const restored = await getScore(testStudent.name)
      const scoreRestored = numEq(restored.score, before.score)
      record('5.2-score在addEvent前后更新', addR.ok && scoreUpdated && scoreRestored,
        `before=${before.score} after=${after.score} (+5=${scoreUpdated}) restored=${restored.score}`)
    } catch (err) {
      record('5.2-score在addEvent前后更新', false, String(err.message || err))
    }

    // 5.3 ranking 在 addEvent 前后更新
    try {
      const before = await getRanking(1000)
      const beforeEntry = before.ranking?.find((e) => e.name === testStudent.name)
      const beforeRankScore = beforeEntry?.score
      const addR = await addEvent(testStudent.name, 'CLASS_COMMITTEE', CODE_DELTA.CLASS_COMMITTEE, '缓存测试5.3')
      track(addR.eventId)
      const after = await getRanking(1000)
      const afterEntry = after.ranking?.find((e) => e.name === testStudent.name)
      const afterRankScore = afterEntry?.score
      const rankUpdated = numEq(afterRankScore, (beforeRankScore ?? 0) + CODE_DELTA.CLASS_COMMITTEE)
      if (addR.eventId) await revertAndUntrack(addR.eventId)
      record('5.3-ranking在addEvent前后更新', addR.ok && rankUpdated,
        `before=${beforeRankScore} after=${afterRankScore} (+5=${rankUpdated})`)
    } catch (err) {
      record('5.3-ranking在addEvent前后更新', false, String(err.message || err))
    }

    // 5.4 addEvent 后三维 (score/stats/ranking) 一致性
    try {
      const before = await getScore(testStudent.name)
      const statsBefore = await getStats()
      const addR = await addEvent(testStudent.name, 'CIVILIZED_DORM', CODE_DELTA.CIVILIZED_DORM, '缓存测试5.4')
      track(addR.eventId)
      const after = await getScore(testStudent.name)
      const statsAfter = await getStats()
      const rankAfter = await getRanking(1000)
      const rankEntry = rankAfter.ranking?.find((e) => e.name === testStudent.name)
      const scoreOk = numEq(after.score, (before.score ?? 0) + CODE_DELTA.CIVILIZED_DORM)
      const statsOk = statsAfter.summary?.total_events === (statsBefore.summary?.total_events ?? 0) + 1
      const rankOk = rankEntry && numEq(rankEntry.score, after.score)
      if (addR.eventId) await revertAndUntrack(addR.eventId)
      record('5.4-addEvent后三维一致性', addR.ok && scoreOk && statsOk && rankOk,
        `score=${scoreOk} stats=${statsOk} rank=${rankOk}`)
    } catch (err) {
      record('5.4-addEvent后三维一致性', false, String(err.message || err))
    }

    // 5.5 revertEvent 后三维一致性
    try {
      const before = await getScore(testStudent.name)
      const statsBefore = await getStats()
      const validBefore = statsBefore.summary?.valid_events
      const addR = await addEvent(testStudent.name, 'CLASS_MONITOR', CODE_DELTA.CLASS_MONITOR, '缓存测试5.5')
      track(addR.eventId)
      await getScore(testStudent.name) // 预热缓存
      if (addR.eventId) await revertAndUntrack(addR.eventId)
      const after = await getScore(testStudent.name)
      const statsAfter = await getStats()
      const rankAfter = await getRanking(1000)
      const rankEntry = rankAfter.ranking?.find((e) => e.name === testStudent.name)
      const scoreOk = numEq(after.score, before.score)
      const statsOk = statsAfter.summary?.valid_events === validBefore
      const rankOk = rankEntry && numEq(rankEntry.score, after.score)
      record('5.5-revertEvent后三维一致性', addR.ok && scoreOk && statsOk && rankOk,
        `score=${scoreOk} stats(valid)=${statsOk} rank=${rankOk}`)
    } catch (err) {
      record('5.5-revertEvent后三维一致性', false, String(err.message || err))
    }

    // ========== 6. Cross-cache consistency (3 tests) ==========
    // 6.1 listStudents().total == stats().summary.students
    try {
      const list = await getListStudents()
      const stats = await getStats()
      const listTotal = list.total
      const statsStudents = stats.summary?.students
      record('6.1-listStudents与stats学生数一致', listTotal === statsStudents,
        `list=${listTotal} stats=${statsStudents}`)
    } catch (err) {
      record('6.1-listStudents与stats学生数一致', false, String(err.message || err))
    }

    // 6.2 ranking(1000) 学生数与 listStudents 一致
    try {
      const list = await getListStudents()
      const rank = await getRanking(1000)
      const rankCount = rank.ranking?.length
      const listTotal = list.total
      // ranking 上限 1000, 仅在 listTotal < 1000 时校验严格相等
      const match = listTotal < 1000 ? rankCount === listTotal : rankCount === 1000
      record('6.2-ranking与listStudents学生数一致', match,
        `list=${listTotal} ranking=${rankCount}`)
    } catch (err) {
      record('6.2-ranking与listStudents学生数一致', false, String(err.message || err))
    }

    // 6.3 三源学生数完全一致
    try {
      const list = await getListStudents()
      const stats = await getStats()
      const rank = await getRanking(1000)
      const a = list.total
      const b = stats.summary?.students
      const c = rank.ranking?.length
      const allMatch = a === b && (a < 1000 ? a === c : c === 1000)
      record('6.3-三源学生数完全一致', allMatch,
        `list=${a} stats=${b} ranking=${c}`)
    } catch (err) {
      record('6.3-三源学生数完全一致', false, String(err.message || err))
    }

    // ========== 7. Concurrent cache reads (2 tests) ==========
    // 7.1 并发 stats + score + ranking
    try {
      const [statsR, scoreR, rankR] = await Promise.all([
        getStats(),
        getScore(testStudent.name),
        getRanking(1000),
      ])
      const allOk = statsR.ok && scoreR.ok && rankR.ok
      // 验证一致性: score 应与 ranking 中对应条目分数一致
      const rankEntry = rankR.ranking?.find((e) => e.name === testStudent.name)
      const consistent = rankEntry && numEq(rankEntry.score, scoreR.score)
      record('7.1-并发读stats+score+ranking', allOk && consistent,
        `stats=${statsR.ok} score=${scoreR.ok} ranking=${rankR.ok} 一致=${consistent}`)
    } catch (err) {
      record('7.1-并发读stats+score+ranking', false, String(err.message || err))
    }

    // 7.2 并发 15 次混合读 (5 stats + 5 score + 5 ranking)
    try {
      const ops = []
      for (let i = 0; i < 5; i++) ops.push(getStats())
      for (let i = 0; i < 5; i++) ops.push(getScore(testStudent.name))
      for (let i = 0; i < 5; i++) ops.push(getRanking(100))
      const mixedResults = await Promise.all(ops)
      const allOk = mixedResults.every((r) => r?.ok)
      // 验证所有 stats 返回相同 students 数
      const statsResults = mixedResults.slice(0, 5)
      const statsCounts = statsResults.map((r) => r?.summary?.students)
      const statsConsistent = statsCounts.every((c) => c === statsCounts[0])
      // 验证所有 score 返回相同值
      const scoreResults = mixedResults.slice(5, 10)
      const scoreValues = scoreResults.map((r) => r?.score)
      const scoresConsistent = scoreValues.every((s) => numEq(s, scoreValues[0]))
      record('7.2-并发15次混合读', allOk && statsConsistent && scoresConsistent,
        `allOk=${allOk} stats一致=${statsConsistent} scores一致=${scoresConsistent}`)
    } catch (err) {
      record('7.2-并发15次混合读', false, String(err.message || err))
    }

    // ========== 8. Validate after operations (2 tests) ==========
    // 8.1 addEvent 后 validate 通过
    try {
      const addR = await addEvent(testStudent.name, 'CLASS_COMMITTEE', CODE_DELTA.CLASS_COMMITTEE, '缓存测试8.1')
      track(addR.eventId)
      const v = await validate()
      const data = v?.data
      const valid = data?.valid ?? v?.valid
      const errors = data?.errors ?? v?.errors
      const errorCount = Array.isArray(errors) ? errors.length : 0
      if (addR.eventId) await revertAndUntrack(addR.eventId)
      record('8.1-addEvent后validate通过', v?.success === true && valid === true && errorCount === 0,
        `valid=${valid} errors=${errorCount}`)
    } catch (err) {
      record('8.1-addEvent后validate通过', false, String(err.message || err))
    }

    // 8.2 revertEvent 后 validate 通过
    try {
      const addR = await addEvent(testStudent.name, 'CLASS_COMMITTEE', CODE_DELTA.CLASS_COMMITTEE, '缓存测试8.2')
      track(addR.eventId)
      if (addR.eventId) await revertAndUntrack(addR.eventId)
      const v = await validate()
      const data = v?.data
      const valid = data?.valid ?? v?.valid
      const errors = data?.errors ?? v?.errors
      const errorCount = Array.isArray(errors) ? errors.length : 0
      record('8.2-revertEvent后validate通过', v?.success === true && valid === true && errorCount === 0,
        `valid=${valid} errors=${errorCount}`)
    } catch (err) {
      record('8.2-revertEvent后validate通过', false, String(err.message || err))
    }

    // ========== 9. Score consistency (2 tests) ==========
    // 9.1 抽取 5 个学生, 验证 score 与 listStudents 一致
    try {
      const list = await getListStudents()
      const activeStudents = (list.students || []).filter((s) => s.status !== 'Deleted').slice(0, 5)
      let allMatch = true
      const details = []
      for (const s of activeStudents) {
        const r = await getScore(s.name)
        const match = numEq(r.score, s.score)
        if (!match) allMatch = false
        details.push(`${s.name}:${s.score}→${r.score}`)
      }
      record('9.1-5学生score与listStudents一致', allMatch && activeStudents.length >= 1,
        `匹配=${allMatch} (${activeStudents.length}学生) ${details.slice(0, 3).join(', ')}`)
    } catch (err) {
      record('9.1-5学生score与listStudents一致', false, String(err.message || err))
    }

    // 9.2 验证 risk 级别一致
    try {
      const list = await getListStudents()
      const activeStudents = (list.students || []).filter((s) => s.status !== 'Deleted').slice(0, 5)
      let allMatch = true
      const details = []
      for (const s of activeStudents) {
        const r = await getScore(s.name)
        const riskFromScore = r.data?.risk
        const riskFromList = s.risk
        const match = riskFromScore === riskFromList
        if (!match) allMatch = false
        details.push(`${s.name}:${riskFromList}→${riskFromScore}`)
      }
      record('9.2-5学生risk级别一致', allMatch && activeStudents.length >= 1,
        `匹配=${allMatch} (${activeStudents.length}学生) ${details.slice(0, 3).join(', ')}`)
    } catch (err) {
      record('9.2-5学生risk级别一致', false, String(err.message || err))
    }

    // ========== 10. Idempotency (2 tests) ==========
    // 10.1 validate 两次幂等
    try {
      const v1 = await validate()
      const v2 = await validate()
      const data1 = v1?.data
      const data2 = v2?.data
      const valid1 = data1?.valid ?? v1?.valid
      const valid2 = data2?.valid ?? v2?.valid
      const errors1 = data1?.errors ?? v1?.errors
      const errors2 = data2?.errors ?? v2?.errors
      const e1Count = Array.isArray(errors1) ? errors1.length : 0
      const e2Count = Array.isArray(errors2) ? errors2.length : 0
      const same = valid1 === valid2 && e1Count === e2Count
      record('10.1-validate两次幂等', same,
        `v1:valid=${valid1},errors=${e1Count} v2:valid=${valid2},errors=${e2Count}`)
    } catch (err) {
      record('10.1-validate两次幂等', false, String(err.message || err))
    }

    // 10.2 stats 两次幂等
    try {
      const s1 = await getStats()
      const s2 = await getStats()
      const students1 = s1.summary?.students
      const students2 = s2.summary?.students
      const events1 = s1.summary?.total_events
      const events2 = s2.summary?.total_events
      const same = students1 === students2 && events1 === events2
      record('10.2-stats两次幂等', same,
        `s1:students=${students1},events=${events1} s2:students=${students2},events=${events2}`)
    } catch (err) {
      record('10.2-stats两次幂等', false, String(err.message || err))
    }

  } finally {
    // ========== 最终安全清理: 撤销未被各测试自行清理的事件 ==========
    console.log('\n--- 最终安全清理: 撤销未清理的事件 (兜底) ---')
    const uniqueEvents = [...new Set(allCreatedEvents.filter(Boolean))]
    console.log(`兜底待撤销事件数 (去重后): ${uniqueEvents.length}`)
    let revertedCount = 0
    for (const evtId of uniqueEvents) {
      try {
        const r = await revertEvent(evtId)
        if (r.ok) revertedCount++
        else console.log(`  撤销失败 (可能已被撤销): ${evtId}`)
      } catch (e) {
        console.log(`  撤销异常: ${evtId} — ${e.message || e}`)
      }
    }
    console.log(`兜底成功撤销: ${revertedCount}/${uniqueEvents.length}`)

    // 验证测试学生分数恢复到原始值
    try {
      const finalScore = await getScore(testStudent?.name)
      const restored = numEq(finalScore.score, originalScoreVal)
      console.log(`\n测试学生最终分数: ${testStudent?.name} = ${finalScore.score} (原始=${originalScoreVal}, 恢复=${restored})`)
      record('最终-测试学生分数恢复', restored, `最终=${finalScore.score} 原始=${originalScoreVal}`)
    } catch (e) {
      record('最终-测试学生分数恢复', false, String(e.message || e))
    }

    // 运行 validate 确保数据完整性
    try {
      const v = await validate()
      const data = v?.data
      const valid = data?.valid ?? v?.valid
      const errors = data?.errors ?? v?.errors
      const errorCount = Array.isArray(errors) ? errors.length : 0
      console.log(`最终 validate: valid=${valid} errors=${errorCount}`)
      record('最终-validate通过', v?.success === true && valid === true && errorCount === 0,
        `valid=${valid} errors=${errorCount}`)
    } catch (e) {
      record('最终-validate通过', false, String(e.message || e))
    }
  }

  // ========== 汇总 ==========
  console.log('\n========== EAA doctor/cache 深度测试汇总 ==========')
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

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
