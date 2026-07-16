// =============================================================
// EAA CLI 并发缓存一致性测试 — 通过 CDP + Tauri Bridge
// 测试 EAA 在并发操作下 3 个缓存文件 (scores.cache / event_stats.cache / daily_dedup.cache) 的一致性
//
// 运行: node scripts/cdp-eaa-concurrent-cache.mjs
// 前置: Tauri 应用已运行, CDP 远程调试端口 9222 可用
// =============================================================
import http from 'node:http'

const CDP_PORT = 9222
const BASE = `http://127.0.0.1:${CDP_PORT}`
const PRIMARY_STUDENT = 'Bulk_Limit_1783913495642'

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
  console.log('CDP connected, running concurrent cache tests...\n')

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

  // 工具: 添加事件 (force=true 绕过日去重), 返回 { ok, eventId, text, raw }
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

  // 工具: 撤销事件
  const revertEvent = async (eventId) => {
    const r = await callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(eventId)}, '并发缓存测试撤销'); return res;`)
    return { ok: r?.success === true, raw: r }
  }

  // 工具: 查询分数
  const getScore = async (studentName) => {
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(studentName)}); return res;`)
    return { ok: r?.success === true, score: r?.data?.score, raw: r }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const numEq = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.001

  // 全局: 收集所有创建的事件 ID, 用于最终安全清理 (每条测试会优先自行撤销, 此处仅作兜底)
  const allCreatedEvents = []
  const track = (eventId) => { if (eventId) allCreatedEvents.push(eventId) }
  // 撤销成功后从兜底清单移除, 避免最终重复撤销
  const untrack = (eventId) => {
    if (!eventId) return
    const i = allCreatedEvents.indexOf(eventId)
    if (i >= 0) allCreatedEvents.splice(i, 1)
  }
  // 撤销并取消跟踪 (各测试内部清理用), 返回与 revertEvent 一致的 { ok, raw }
  const revertAndUntrack = async (eventId) => {
    if (!eventId) return { ok: false, raw: null }
    const r = await revertEvent(eventId)
    if (r.ok) untrack(eventId)
    return r
  }

  // 主学生原始分数 (在 try 外声明, 供 finally 引用)
  let originalScoreVal = null

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
    const primaryExists = students.find((s) => s.name === PRIMARY_STUDENT)
    if (!primaryExists) {
      record('准备-主测试学生存在', false, `${PRIMARY_STUDENT} 不存在`)
      console.log('无法继续测试, 退出')
      ws.close()
      process.exit(1)
    }
    record('准备-主测试学生存在', true, `name=${PRIMARY_STUDENT}`)

    // 准备 4 个额外学生 (用于测试 1 的并发不同学生)
    const otherStudents = students
      .filter((s) => s.name !== PRIMARY_STUDENT && s.status !== 'Deleted')
      .slice(0, 4)
      .map((s) => s.name)
    const fiveStudents = [PRIMARY_STUDENT, ...otherStudents].slice(0, 5)
    console.log(`并发测试学生池 (${fiveStudents.length}): ${fiveStudents.join(', ')}\n`)
    if (fiveStudents.length < 5) {
      console.log(`警告: 仅 ${fiveStudents.length} 个学生可用, 测试 1/6/8 可能受影响`)
    }

    // 主学生初始分数 (用于最终验证)
    const originalScore = await getScore(PRIMARY_STUDENT)
    originalScoreVal = originalScore.score
    console.log(`主学生原始分数: ${originalScoreVal}\n`)

    // ========== 测试 1: 并发 addEvent 不同学生 ==========
    try {
      const initialScores = {}
      for (const name of fiveStudents) {
        const r = await getScore(name)
        initialScores[name] = r.score
      }

      // 5 个不同学生并发添加 CLASS_COMMITTEE delta=5 force=true
      const addPromises = fiveStudents.map((name, i) =>
        addEvent(name, 'CLASS_COMMITTEE', CODE_DELTA.CLASS_COMMITTEE, `并发测试1-${i}`)
      )
      const addResults = await Promise.all(addPromises)
      addResults.forEach((r) => track(r.eventId))

      const allOk = addResults.every((r) => r.ok)
      const allHaveId = addResults.every((r) => r.eventId)

      // 验证每个学生分数 +5
      const afterScores = {}
      for (const name of fiveStudents) {
        const r = await getScore(name)
        afterScores[name] = r.score
      }
      const scoreCorrect = fiveStudents.every((name) =>
        numEq(afterScores[name], (initialScores[name] || 0) + CODE_DELTA.CLASS_COMMITTEE)
      )

      // 撤销 (恢复状态)
      for (const r of addResults) {
        if (r.eventId) await revertAndUntrack(r.eventId)
      }
      // 验证恢复
      const restoredScores = {}
      for (const name of fiveStudents) {
        const r = await getScore(name)
        restoredScores[name] = r.score
      }
      const allRestored = fiveStudents.every((name) => numEq(restoredScores[name], initialScores[name]))

      record(
        '测试1-并发addEvent不同学生',
        allOk && allHaveId && scoreCorrect && allRestored,
        `成功=${addResults.filter(r=>r.ok).length}/5 分数+5正确=${scoreCorrect} 状态恢复=${allRestored}`
      )
    } catch (err) {
      record('测试1-并发addEvent不同学生', false, String(err.message || err))
    }

    // ========== 测试 2: 并发 addEvent 同一学生 (3 个不同 reason code) ==========
    try {
      const initial = await getScore(PRIMARY_STUDENT)
      const initialScore = initial.score

      // 3 个不同 reason code 同时添加: +5 +3 +10 = +18
      const ops = [
        addEvent(PRIMARY_STUDENT, 'CLASS_COMMITTEE', CODE_DELTA.CLASS_COMMITTEE, '并发测试2-cc'),
        addEvent(PRIMARY_STUDENT, 'CIVILIZED_DORM', CODE_DELTA.CIVILIZED_DORM, '并发测试2-cd'),
        addEvent(PRIMARY_STUDENT, 'CLASS_MONITOR', CODE_DELTA.CLASS_MONITOR, '并发测试2-cm'),
      ]
      const addResults = await Promise.all(ops)
      addResults.forEach((r) => track(r.eventId))

      const allOk = addResults.every((r) => r.ok)
      const allHaveId = addResults.every((r) => r.eventId)

      const after = await getScore(PRIMARY_STUDENT)
      const expectedDelta = CODE_DELTA.CLASS_COMMITTEE + CODE_DELTA.CIVILIZED_DORM + CODE_DELTA.CLASS_MONITOR
      const scoreCorrect = numEq(after.score, (initialScore || 0) + expectedDelta)

      // 撤销 (恢复状态)
      for (const r of addResults) {
        if (r.eventId) await revertAndUntrack(r.eventId)
      }
      const restored = await getScore(PRIMARY_STUDENT)
      const scoreRestored = numEq(restored.score, initialScore)

      record(
        '测试2-并发addEvent同一学生',
        allOk && allHaveId && scoreCorrect && scoreRestored,
        `成功=${addResults.filter(r=>r.ok).length}/3 初始=${initialScore} 后=${after.score} 期望+${expectedDelta} 实际+${((after.score||0)-(initialScore||0)).toFixed(1)} 状态恢复=${scoreRestored}`
      )
    } catch (err) {
      record('测试2-并发addEvent同一学生', false, String(err.message || err))
    }

    // ========== 测试 3: addEvent + score 并发 ==========
    try {
      const initial = await getScore(PRIMARY_STUDENT)
      const initialScore = initial.score

      // 同时发起 1 个 add 和 5 个 score 查询
      const addP = addEvent(PRIMARY_STUDENT, 'CLASS_COMMITTEE', CODE_DELTA.CLASS_COMMITTEE, '并发测试3')
      const scorePromises = []
      for (let i = 0; i < 5; i++) {
        scorePromises.push(getScore(PRIMARY_STUDENT))
      }
      const [addR, ...scoreRs] = await Promise.all([addP, ...scorePromises])
      track(addR.eventId)

      const addOk = addR.ok
      const scoreAllOk = scoreRs.every((r) => r.ok)
      // 不应读到脏数据: 读到的分数应为 initialScore 或 initialScore+5
      const scores = scoreRs.map((r) => r.score).filter((s) => typeof s === 'number')
      const noDirtyData = scores.every((s) =>
        numEq(s, initialScore) || numEq(s, (initialScore || 0) + CODE_DELTA.CLASS_COMMITTEE)
      )

      // 撤销
      if (addR.eventId) await revertAndUntrack(addR.eventId)
      const restored = await getScore(PRIMARY_STUDENT)
      const scoreRestored = numEq(restored.score, initialScore)

      record(
        '测试3-addEvent+score并发',
        addOk && scoreAllOk && noDirtyData && scoreRestored,
        `add成功=${addOk} score查询全成功=${scoreAllOk} 无脏数据=${noDirtyData} 读到=[${scores.join(',')}] 状态恢复=${scoreRestored}`
      )
    } catch (err) {
      record('测试3-addEvent+score并发', false, String(err.message || err))
    }

    // ========== 测试 4: addEvent + revertEvent 并发 (循环 5 次) ==========
    try {
      const initial = await getScore(PRIMARY_STUDENT)
      const initialScore = initial.score
      let cycleOkCount = 0
      const cycleEventIds = []

      for (let i = 0; i < 5; i++) {
        // 添加事件
        const addR = await addEvent(PRIMARY_STUDENT, 'CLASS_COMMITTEE', CODE_DELTA.CLASS_COMMITTEE, `并发测试4-${i}`)
        if (!addR.ok || !addR.eventId) {
          console.log(`  循环 ${i}: add 失败 — ${addR.text}`)
          continue
        }
        track(addR.eventId)
        cycleEventIds.push(addR.eventId)

        // 立即并发: 撤销 + 查询 score (验证撤销不崩溃)
        const [revR, scoreR] = await Promise.all([
          revertAndUntrack(addR.eventId),
          getScore(PRIMARY_STUDENT),
        ])
        if (revR.ok && scoreR.ok) cycleOkCount++
      }

      // 验证最终分数 = 初始分数 (所有循环都已撤销)
      const final = await getScore(PRIMARY_STUDENT)
      const scoreRestored = numEq(final.score, initialScore)

      record(
        '测试4-addEvent+revertEvent并发循环',
        cycleOkCount === 5 && scoreRestored,
        `循环成功=${cycleOkCount}/5 最终分数=${final.score} 初始=${initialScore} 恢复=${scoreRestored}`
      )
    } catch (err) {
      record('测试4-addEvent+revertEvent并发循环', false, String(err.message || err))
    }

    // ========== 测试 5: addEvent + validate 并发 ==========
    try {
      const initial = await getScore(PRIMARY_STUDENT)
      const initialScore = initial.score

      // 并发: 3 个 add + 3 个 validate
      const ops = []
      const addCount = 3
      for (let i = 0; i < addCount; i++) {
        ops.push(addEvent(PRIMARY_STUDENT, 'CLASS_COMMITTEE', CODE_DELTA.CLASS_COMMITTEE, `并发测试5-${i}`))
      }
      for (let i = 0; i < 3; i++) {
        ops.push(callIpc(`const res = await api.eaa.validate(); return res;`))
      }
      const results5 = await Promise.all(ops)
      const addResults5 = results5.slice(0, addCount)
      addResults5.forEach((r) => { if (r && r.eventId) track(r.eventId) })
      const validateResults = results5.slice(addCount)

      const addAllOk = addResults5.every((r) => r && r.ok)
      const validateAllOk = validateResults.every((r) => r && r.success === true)
      const noCrash = validateResults.every((r) => r && !r.__error)

      // 撤销刚加的 3 个事件 (恢复状态)
      for (const r of addResults5) {
        if (r && r.eventId) await revertAndUntrack(r.eventId)
      }
      const after = await getScore(PRIMARY_STUDENT)
      const restored = numEq(after.score, initialScore)

      record(
        '测试5-addEvent+validate并发',
        addAllOk && validateAllOk && noCrash && restored,
        `add成功=${addAllOk} validate成功=${validateAllOk} 无崩溃=${noCrash} 状态恢复=${restored}`
      )
    } catch (err) {
      record('测试5-addEvent+validate并发', false, String(err.message || err))
    }

    // ========== 测试 6: 缓存一致性检查 (10 次并发 add + score 一致性) ==========
    try {
      const initialScores6 = {}
      for (const name of fiveStudents) {
        const r = await getScore(name)
        initialScores6[name] = r.score
      }

      // 并发 10 次 addEvent (循环使用 5 个学生, 3 个 reason code)
      const codes6 = ['CLASS_COMMITTEE', 'CIVILIZED_DORM', 'CLASS_MONITOR']
      const addPromises6 = []
      for (let i = 0; i < 10; i++) {
        const name = fiveStudents[i % fiveStudents.length]
        const code = codes6[i % codes6.length]
        addPromises6.push(addEvent(name, code, CODE_DELTA[code], `并发测试6-${i}`))
      }
      const addResults6 = await Promise.all(addPromises6)
      addResults6.forEach((r) => track(r.eventId))

      const addOkCount = addResults6.filter((r) => r.ok).length

      // 查询所有涉及学生的 score (缓存读)
      const scoreAfter6 = {}
      for (const name of fiveStudents) {
        const r = await getScore(name)
        scoreAfter6[name] = r.score
      }

      // 检查是否有 rebuild-cache 命令 (通过探测 api.eaa.rebuildCache)
      let rebuildSupported = false
      let consistentAfterRebuild = true
      try {
        const probe = await callIpc(`
          if (api.eaa && typeof api.eaa.rebuildCache === 'function') {
            return { supported: true };
          }
          return { supported: false };
        `)
        if (probe?.supported) {
          rebuildSupported = true
          await callIpc(`const res = await api.eaa.rebuildCache(); return res;`)
          // rebuild 后重新查询, 验证一致
          const scoreAfterRebuild = {}
          for (const name of fiveStudents) {
            const r = await getScore(name)
            scoreAfterRebuild[name] = r.score
          }
          consistentAfterRebuild = fiveStudents.every((name) =>
            numEq(scoreAfter6[name], scoreAfterRebuild[name])
          )
        }
      } catch (e) {
        // rebuild-cache 不存在或调用失败, 跳过
        rebuildSupported = false
      }

      // 撤销这 10 个事件 (恢复状态)
      for (const r of addResults6) {
        if (r && r.eventId) await revertAndUntrack(r.eventId)
      }
      const restoredScores6 = {}
      for (const name of fiveStudents) {
        const r = await getScore(name)
        restoredScores6[name] = r.score
      }
      const allRestored = fiveStudents.every((name) => numEq(restoredScores6[name], initialScores6[name]))

      const rebuildNote = rebuildSupported
        ? `rebuild后一致=${consistentAfterRebuild}`
        : '(rebuild-cache 不存在, 跳过)'

      record(
        '测试6-缓存一致性检查',
        addOkCount === 10 && allRestored && (!rebuildSupported || consistentAfterRebuild),
        `add成功=${addOkCount}/10 状态恢复=${allRestored} ${rebuildNote}`
      )
    } catch (err) {
      record('测试6-缓存一致性检查', false, String(err.message || err))
    }

    // ========== 测试 7: history + search 并发 (同一学生) ==========
    try {
      const initial = await getScore(PRIMARY_STUDENT)
      const initialScore = initial.score

      // 先添加一个事件, 让 history 和 search 都有内容
      const addR = await addEvent(PRIMARY_STUDENT, 'CLASS_COMMITTEE', CODE_DELTA.CLASS_COMMITTEE, '并发测试7-可搜索')
      track(addR.eventId)
      await sleep(150) // 等事件落盘

      // 并发: history + search (同一学生)
      const [histR, searchR] = await Promise.all([
        callIpc(`const res = await api.eaa.history(${JSON.stringify(PRIMARY_STUDENT)}); return res;`),
        callIpc(`const res = await api.eaa.search(${JSON.stringify(PRIMARY_STUDENT)}, 10); return res;`),
      ])

      const histOk = histR?.success === true
      const searchOk = searchR?.success === true
      const histEvents = histR?.data?.events || []
      const searchEvents = searchR?.data?.events || []
      const foundInHist = addR.eventId ? histEvents.some((e) => e.event_id === addR.eventId) : false
      const bothArray = Array.isArray(histEvents) && Array.isArray(searchEvents)

      // 撤销
      if (addR.eventId) await revertAndUntrack(addR.eventId)
      const after = await getScore(PRIMARY_STUDENT)
      const restored = numEq(after.score, initialScore)

      record(
        '测试7-history+search并发',
        histOk && searchOk && bothArray && foundInHist && restored,
        `history成功=${histOk}(${histEvents.length}条) search成功=${searchOk}(${searchEvents.length}条) 新事件在history中=${foundInHist} 状态恢复=${restored}`
      )
    } catch (err) {
      record('测试7-history+search并发', false, String(err.message || err))
    }

    // ========== 测试 8: 极端并发 20 ops (混合 add/score/history/search/stats) ==========
    try {
      const initialScores8 = {}
      for (const name of fiveStudents) {
        const r = await getScore(name)
        initialScores8[name] = r.score
      }

      // 20 个混合操作: 5 add + 5 score + 5 history + 3 search + 2 stats
      const ops8 = []
      const addIdxSet = new Set()
      for (let i = 0; i < 5; i++) {
        addIdxSet.add(ops8.length)
        ops8.push(addEvent(fiveStudents[i % fiveStudents.length], 'CLASS_COMMITTEE', CODE_DELTA.CLASS_COMMITTEE, `并发测试8-${i}`))
      }
      for (let i = 0; i < 5; i++) {
        ops8.push(getScore(fiveStudents[i % fiveStudents.length]))
      }
      for (let i = 0; i < 5; i++) {
        ops8.push(callIpc(`const res = await api.eaa.history(${JSON.stringify(fiveStudents[i % fiveStudents.length])}); return res;`))
      }
      for (let i = 0; i < 3; i++) {
        ops8.push(callIpc(`const res = await api.eaa.search(${JSON.stringify(fiveStudents[i % fiveStudents.length])}, 10); return res;`))
      }
      for (let i = 0; i < 2; i++) {
        ops8.push(callIpc(`const res = await api.eaa.stats(); return res;`))
      }

      const results8 = await Promise.all(ops8)

      // 收集 add 结果的 eventId
      const addResults8 = results8.filter((_, i) => addIdxSet.has(i))
      addResults8.forEach((r) => { if (r && r.eventId) track(r.eventId) })

      // 统计错误: add 检查 r.ok, 其他检查 r.success === true 或非 __error
      let errorCount = 0
      const errorDetails = []
      for (let i = 0; i < results8.length; i++) {
        const r = results8[i]
        if (!r) { errorCount++; errorDetails.push(`op${i}:null`); continue }
        if (addIdxSet.has(i)) {
          if (!r.ok) { errorCount++; errorDetails.push(`op${i}:add-fail`) }
        } else if (r.__error) {
          errorCount++; errorDetails.push(`op${i}:${r.__error}`)
        } else if (r.success === false) {
          errorCount++; errorDetails.push(`op${i}:ipc-fail`)
        }
      }

      // 撤销所有 add 的事件 (恢复状态)
      for (const r of addResults8) {
        if (r && r.eventId) await revertAndUntrack(r.eventId)
      }
      const restoredScores8 = {}
      for (const name of fiveStudents) {
        const r = await getScore(name)
        restoredScores8[name] = r.score
      }
      const allRestored = fiveStudents.every((name) => numEq(restoredScores8[name], initialScores8[name]))

      record(
        '测试8-极端并发20ops',
        errorCount === 0 && allRestored,
        `错误=${errorCount}/20 状态恢复=${allRestored} add成功=${addResults8.filter(r=>r&&r.ok).length}/5${errorDetails.length ? ' 详情=[' + errorDetails.slice(0,3).join(';') + ']' : ''}`
      )
    } catch (err) {
      record('测试8-极端并发20ops', false, String(err.message || err))
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

    // 验证主学生分数恢复到原始值
    try {
      const finalScore = await getScore(PRIMARY_STUDENT)
      const restored = numEq(finalScore.score, originalScoreVal)
      console.log(`\n主学生最终分数: ${PRIMARY_STUDENT} = ${finalScore.score} (原始=${originalScoreVal}, 恢复=${restored})`)
      record('最终-主学生分数恢复', restored, `最终=${finalScore.score} 原始=${originalScoreVal}`)
    } catch (e) {
      record('最终-主学生分数恢复', false, String(e.message || e))
    }

    // 运行 validate 确保数据完整性
    try {
      const v = await callIpc(`const res = await api.eaa.validate(); return res;`)
      const valid = v?.data?.valid
      const errCount = v?.data?.errors?.length ?? 0
      console.log(`最终 validate: valid=${valid} errors=${errCount}`)
      record('最终-validate通过', valid === true && errCount === 0, `valid=${valid} errors=${errCount}`)
    } catch (e) {
      record('最终-validate通过', false, String(e.message || e))
    }
  }

  // ========== 汇总 ==========
  console.log('\n========== EAA 并发缓存一致性测试汇总 ==========')
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
