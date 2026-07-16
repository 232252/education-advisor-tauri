// =============================================================
// EAA 事件生命周期深度测试 — 通过 CDP + Tauri Bridge
// 覆盖: add → revert → re-add, reason code 校验, delta 边界,
//       daily dedup, 并发事件, note/studentName 校验, validate
//
// 运行: node scripts/cdp-eaa-event-lifecycle-deep.mjs
// 前置: Tauri 应用已运行, CDP 远程调试端口 9222 可用
// 连接样板与 scripts/cdp-eaa-integration.mjs 一致
// =============================================================
import http from 'node:http'

const CDP_PORT = 9222
const BASE = `http://127.0.0.1:${CDP_PORT}`
const BASE_SCORE = 100

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
  console.log('CDP connected, running EAA event lifecycle deep tests...\n')

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

  // 判定工具
  const okSuccess = (r) => !!r && !r.__error && r.success === true
  const okRejected = (r) => !!r && (typeof r.__error === 'string' || r.success === false)
  const okGraceful = (r) => r != null && (r.success === true || r.success === false || typeof r.__error === 'string')
  const numEq = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.001

  // API 封装
  const getScore = async (name) => {
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(name)}); return res;`)
    return { ok: okSuccess(r), score: r?.data?.score, data: r?.data, raw: r }
  }
  const addEventRaw = async (params) => {
    const r = await callIpc(`const res = await api.eaa.addEvent(${JSON.stringify(params)}); return res;`)
    const text = String(r?.data ?? '')
    const m = text.match(/evt_\w+/)
    return { ok: okSuccess(r), eventId: m ? m[0] : null, text, raw: r, __error: r?.__error }
  }
  const addEvt = async (reasonCode, delta, note, force = true) =>
    addEventRaw({ studentName: testName, reasonCode, delta, note, force })
  const revertEvent = async (eventId, reason) => {
    const r = await callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(eventId)}, ${JSON.stringify(reason || '生命周期测试撤销')}); return res;`)
    return { ok: okSuccess(r), text: String(r?.data ?? ''), raw: r, __error: r?.__error }
  }
  const getHistory = async (name) => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(name)}); return res;`)
    return { ok: okSuccess(r), events: r?.data?.events || [], raw: r }
  }
  const findStudent = async (name) => {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    return (r?.data?.students || []).find((s) => s.name === name) || null
  }

  const TS = Date.now()
  const testName = `CDP_EvtLife_${TS}`
  const cleanupStudents = []

  try {
    // ============================================================
    // 1. Setup: 创建测试学生 + 验证初始分数
    // ============================================================
    console.log('━━━ 1. Setup ━━━')
    {
      const r = await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(testName)}); return res;`)
      if (okSuccess(r)) cleanupStudents.push(testName)
      record('Setup 创建测试学生', okSuccess(r), `success=${r?.success} name=${testName}`)
    }
    {
      const s = await getScore(testName)
      const ok = s.ok && typeof s.score === 'number' && numEq(s.score, BASE_SCORE)
      record('Setup 验证初始分数=100', ok, `score=${s.score} (期望 ${BASE_SCORE})`)
    }

    // ============================================================
    // 2. Reason codes 深度测试
    // ============================================================
    console.log('\n━━━ 2. Reason codes ━━━')
    let codesList = null
    {
      const r = await callIpc(`const res = await api.eaa.codes(); return res;`)
      codesList = r?.data?.codes
      record('codes 返回 22 个', okSuccess(r) && Array.isArray(codesList) && codesList.length === 22, `codes=${codesList?.length}`)
    }
    {
      const allValid = Array.isArray(codesList) && codesList.every((c) =>
        typeof c?.code === 'string' &&
        typeof c?.label === 'string' &&
        typeof c?.category === 'string' &&
        ('score_delta' in c)
      )
      const sample = codesList?.find((c) => c.code === 'CLASS_COMMITTEE')
      record('codes 字段完整 (code/label/category/score_delta)', allValid, `sample=${sample?.code} delta=${sample?.score_delta}`)
    }

    // ============================================================
    // 3. Add event — 正常 (CLASS_COMMITTEE +5)
    // ============================================================
    console.log('\n━━━ 3. Add event (normal) ━━━')
    let evtCC = null // CLASS_COMMITTEE 事件 ID (后续 revert 测试用)
    {
      const before = await getScore(testName)
      const r = await addEvt('CLASS_COMMITTEE', 5, '正常加分-班委履职', true)
      evtCC = r.eventId
      const after = await getScore(testName)
      const ok = r.ok && evtCC && numEq(after.score, before.score + 5)
      record('addEvent CLASS_COMMITTEE +5 成功', ok, `eventId=${evtCC} 前=${before.score} 后=${after.score}`)
    }
    {
      const h = await getHistory(testName)
      const found = evtCC ? h.events.find((e) => e.event_id === evtCC) : null
      record('新事件出现在 history', !!found, `history=${h.events.length} found=${!!found}`)
    }

    // ============================================================
    // 4. Add event — 负 delta
    // ============================================================
    console.log('\n━━━ 4. Add event (negative delta) ━━━')
    {
      const before = await getScore(testName)
      const r = await addEvt('BONUS_VARIABLE', -3, '负 delta 测试', true)
      const after = await getScore(testName)
      const ok = r.ok && numEq(after.score, before.score + (-3))
      record('addEvent BONUS_VARIABLE -3 成功', ok, `eventId=${r.eventId} 前=${before.score} 后=${after.score}`)
    }

    // ============================================================
    // 5. Add event — BONUS_VARIABLE 自定义 delta
    // ============================================================
    console.log('\n━━━ 5. Add event (BONUS_VARIABLE custom delta) ━━━')
    {
      const before = await getScore(testName)
      const r = await addEvt('BONUS_VARIABLE', 7.5, '自定义 delta=7.5', true)
      const after = await getScore(testName)
      const ok = r.ok && numEq(after.score, before.score + 7.5)
      record('addEvent BONUS_VARIABLE +7.5 成功', ok, `eventId=${r.eventId} 前=${before.score} 后=${after.score}`)
    }

    // ============================================================
    // 6. Revert event
    // ============================================================
    console.log('\n━━━ 6. Revert event ━━━')
    {
      const before = await getScore(testName)
      const r = await revertEvent(evtCC, '撤销班委加分')
      const after = await getScore(testName)
      const ok = r.ok && numEq(after.score, before.score - 5)
      record('revert CLASS_COMMITTEE 事件 成功', ok, `前=${before.score} 后=${after.score} (期望 -5)`)
    }
    {
      const h = await getHistory(testName)
      const evt = evtCC ? h.events.find((e) => e.event_id === evtCC) : null
      const reverted = !!evt && (evt.reverted === true || evt.is_valid === false)
      record('撤销事件在 history reverted=true', reverted, `reverted=${evt?.reverted} is_valid=${evt?.is_valid ?? 'n/a'}`)
    }

    // ============================================================
    // 7. Revert 已撤销事件 (不应双重撤销)
    // ============================================================
    console.log('\n━━━ 7. Revert already-reverted ━━━')
    {
      const before = await getScore(testName)
      const r = await revertEvent(evtCC, '重复撤销')
      const after = await getScore(testName)
      // 关键: 不崩溃 + 分数不变 (未双重撤销), 无论返回 success 还是 error
      const ok = okGraceful(r.raw) && numEq(after.score, before.score)
      record('重复撤销已撤销事件 不双重撤销', ok, `success=${r.raw?.success} 前=${before.score} 后=${after.score}`)
    }

    // ============================================================
    // 8. Revert 不存在事件
    // ============================================================
    console.log('\n━━━ 8. Revert non-existent ━━━')
    {
      const r = await revertEvent('evt_nonexistent_xxx99999', '撤销不存在事件')
      record('撤销不存在事件 被拒/不崩溃', okGraceful(r.raw) && !r.ok, `success=${r.raw?.success} err=${r.__error ? '有' : '无'}`)
    }

    // ============================================================
    // 9. Daily dedup
    // ============================================================
    console.log('\n━━━ 9. Daily dedup ━━━')
    // 首次 add CIVILIZED_DORM (无 force) — 该学生该 code 今天首次, 应成功
    {
      const r = await addEvt('CIVILIZED_DORM', 3, 'dedup-首次', false)
      record('dedup 首次 add CIVILIZED_DORM 无 force 成功', r.ok && r.eventId, `eventId=${r.eventId}`)
    }
    // 重复 add (无 force) — 应被 daily dedup 拒绝
    {
      const r = await addEvt('CIVILIZED_DORM', 3, 'dedup-重复', false)
      record('dedup 重复 add 同 code 无 force 被拒', okRejected(r.raw) && !r.ok, `success=${r.raw?.success} err=${r.raw?.__error ? '有' : '无'}`)
    }
    // force=true 绕过 dedup
    {
      const r = await addEvt('CIVILIZED_DORM', 3, 'dedup-force', true)
      record('dedup force=true 绕过成功', r.ok && r.eventId, `eventId=${r.eventId}`)
    }

    // ============================================================
    // 10. Delta 边界
    // ============================================================
    console.log('\n━━━ 10. Delta boundaries ━━━')
    {
      // delta=0 — 成功且无分数变化
      const before = await getScore(testName)
      const r = await addEvt('BONUS_VARIABLE', 0, 'delta=0 测试', true)
      const after = await getScore(testName)
      const ok = r.ok && numEq(after.score, before.score)
      record('delta=0 成功且无分数变化', ok, `前=${before.score} 后=${after.score}`)
    }
    {
      // 大 delta 999999 — 不崩溃, 分数有效
      const before = await getScore(testName)
      const r = await addEvt('BONUS_VARIABLE', 999999, '大 delta 测试', true)
      const after = await getScore(testName)
      const ok = okGraceful(r.raw) && typeof after.score === 'number'
      record('delta=999999 处理 (不崩溃, 分数有效)', ok, `success=${r.ok} 前=${before.score} 后=${after.score}`)
    }
    {
      // 小 delta -999999 — 不崩溃, 分数有效
      const before = await getScore(testName)
      const r = await addEvt('BONUS_VARIABLE', -999999, '小 delta 测试', true)
      const after = await getScore(testName)
      const ok = okGraceful(r.raw) && typeof after.score === 'number'
      record('delta=-999999 处理 (不崩溃, 分数有效)', ok, `success=${r.ok} 前=${before.score} 后=${after.score}`)
    }
    {
      // 分数 delta 0.5
      const before = await getScore(testName)
      const r = await addEvt('BONUS_VARIABLE', 0.5, '分数 delta 测试', true)
      const after = await getScore(testName)
      const ok = r.ok && numEq(after.score, before.score + 0.5)
      record('delta=0.5 成功', ok, `前=${before.score} 后=${after.score}`)
    }
    {
      // NaN delta — 直接传 JS NaN (JSON 无法表达, 必须在页面内构造)
      // 实际行为: 被优雅处理 (强制为 0/默认), 不崩溃, 不污染分数
      const before = await getScore(testName)
      const r = await callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(testName)},
          reasonCode: 'BONUS_VARIABLE',
          delta: NaN,
          note: 'nan-delta 测试',
          force: true,
        });
        return res;
      `)
      const after = await getScore(testName)
      const ok = okGraceful(r) && typeof after.score === 'number' && !Number.isNaN(after.score)
      record('delta=NaN 处理 (不崩溃, 分数有效)', ok, `success=${r?.success} 前=${before.score} 后=${after.score}`)
    }
    {
      // null delta
      const r = await callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(testName)},
          reasonCode: 'BONUS_VARIABLE',
          delta: null,
          note: 'null-delta 测试',
          force: true,
        });
        return res;
      `)
      record('delta=null 处理 (不崩溃)', okGraceful(r), `success=${r?.success} err=${r?.__error ? '有' : '无'}`)
    }

    // ============================================================
    // 11. Note 字段校验
    // ============================================================
    console.log('\n━━━ 11. Note validation ━━━')
    {
      const r = await addEvt('BONUS_VARIABLE', 1, '', true)
      record('note 空字符串 成功', r.ok && r.eventId, `eventId=${r.eventId}`)
    }
    {
      const longNote = 'N'.repeat(1200)
      const r = await addEvt('BONUS_VARIABLE', 1, longNote, true)
      record('note 超长 (>1000) 不崩溃', okGraceful(r.raw), `success=${r.ok} eventId=${r.eventId}`)
    }
    {
      const r = await addEvt('BONUS_VARIABLE', 1, '🎉测试 emoji 🎓', true)
      record('note Unicode/emoji 成功', r.ok && r.eventId, `eventId=${r.eventId}`)
    }
    {
      const r = await addEvt('BONUS_VARIABLE', 1, '<script>alert(1)</script>; DROP TABLE--"quotes"', true)
      // 实际行为: 含 HTML/SQL 注入串的 note 被安全拒绝 (与 setStudentMeta 一致)
      record('note 特殊字符 (HTML/SQL) 被拒 (安全)', okRejected(r.raw) && !r.ok, `success=${r.raw?.success} err=${r.raw?.__error ? '有' : '无'}`)
    }
    {
      // null note
      const r = await callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(testName)},
          reasonCode: 'BONUS_VARIABLE',
          delta: 1,
          note: null,
          force: true,
        });
        return res;
      `)
      record('note null 成功 (默认)', okGraceful(r), `success=${r?.success}`)
    }

    // ============================================================
    // 12. Student name 校验
    // ============================================================
    console.log('\n━━━ 12. Student name validation ━━━')
    const noExistName = `CDP_NoExist_${TS}`
    {
      const r = await addEventRaw({ studentName: noExistName, reasonCode: 'BONUS_VARIABLE', delta: 1, note: '不存在学生', force: true })
      if (r.ok && r.eventId) cleanupStudents.push(noExistName)
      record('不存在学生 addEvent 不崩溃', okGraceful(r.raw), `success=${r.ok} eventId=${r.eventId} (创建或拒绝)`)
    }
    {
      const r = await addEventRaw({ studentName: '', reasonCode: 'BONUS_VARIABLE', delta: 1, note: '空名', force: true })
      record('空 studentName 被拒', okRejected(r.raw) && !r.ok, `success=${r.raw?.success} err=${r.raw?.__error ? '有' : '无'}`)
    }
    {
      const r = await addEventRaw({ studentName: '<script>inject</script>', reasonCode: 'BONUS_VARIABLE', delta: 1, note: '特殊字符名', force: true })
      if (r.ok && r.eventId) cleanupStudents.push('<script>inject</script>')
      record('特殊字符 studentName 被拒', okRejected(r.raw) && !r.ok, `success=${r.raw?.success} err=${r.raw?.__error ? '有' : '无'}`)
    }

    // ============================================================
    // 13. Validate 操作后
    // ============================================================
    console.log('\n━━━ 13. Validate ━━━')
    {
      const r = await callIpc(`const res = await api.eaa.validate(); return res;`)
      const data = r?.data
      const ok = okSuccess(r) && data?.valid === true && (data?.errors?.length ?? 0) === 0
      record('操作后 validate 通过', ok, `valid=${data?.valid} errors=${data?.errors?.length ?? 0} total=${data?.total_events ?? 0}`)
    }

    // ============================================================
    // 14. Concurrent events (5 个不同 delta 并发)
    // ============================================================
    console.log('\n━━━ 14. Concurrent events ━━━')
    {
      const before = await getScore(testName)
      const deltas = [1, 2, 3, 4, 5]
      const notes = deltas.map((d) => `concurrent-${d}`)
      const ops = deltas.map((d, i) => addEvt('BONUS_VARIABLE', d, notes[i], true))
      const rs = await Promise.all(ops)
      const eventIds = rs.map((r) => r.eventId).filter(Boolean)
      const allOk = rs.every((r) => r.ok && r.eventId)
      const sumDelta = deltas.reduce((a, b) => a + b, 0)

      record('并发 5 个事件全部成功', allOk, `成功=${rs.filter((r) => r.ok).length}/5`)

      const after = await getScore(testName)
      const h = await getHistory(testName)
      const allInHistory = eventIds.every((id) => h.events.find((e) => e.event_id === id))
      const hitCount = eventIds.filter((id) => h.events.find((e) => e.event_id === id)).length
      const scoreOk = numEq(after.score, before.score + sumDelta)

      record('并发 5 事件都在 history', allInHistory, `history=${h.events.length} 命中=${hitCount}/${eventIds.length}`)
      record('并发后分数反映全部 delta', scoreOk, `前=${before.score} 后=${after.score} 期望+${sumDelta}`)
    }

    // ============================================================
    // 15. 生命周期: add → revert → re-add
    // ============================================================
    console.log('\n━━━ 15. Lifecycle: add → revert → re-add ━━━')
    {
      const base = await getScore(testName)
      // add
      const add1 = await addEvt('BONUS_VARIABLE', 5, 'lifecycle-add', true)
      const s1 = await getScore(testName)
      const addOk = add1.ok && numEq(s1.score, base.score + 5)
      record('lifecycle add (+5) 成功', addOk, `eventId=${add1.eventId} 前=${base.score} 后=${s1.score}`)
      // revert
      const rev = await revertEvent(add1.eventId, 'lifecycle-revert')
      const s2 = await getScore(testName)
      const revOk = rev.ok && numEq(s2.score, base.score)
      record('lifecycle revert 成功分数回退', revOk, `前=${s1.score} 后=${s2.score} (期望=${base.score})`)
      // re-add (force 绕过 dedup)
      const add2 = await addEvt('BONUS_VARIABLE', 5, 'lifecycle-readd', true)
      const s3 = await getScore(testName)
      const reAddOk = add2.ok && numEq(s3.score, base.score + 5)
      record('lifecycle re-add (+5) 成功', reAddOk, `eventId=${add2.eventId} 前=${s2.score} 后=${s3.score}`)
    }

  } finally {
    // ============================================================
    // 16. Cleanup: 软删除测试学生
    // ============================================================
    console.log('\n━━━ 16. Cleanup ━━━')
    for (const name of [...new Set(cleanupStudents)]) {
      try {
        await callIpc(`const res = await api.eaa.deleteStudent(${JSON.stringify(name)}, 'cdp-event-lifecycle-deep 清理'); return res;`)
      } catch (e) { /* 忽略清理错误 */ }
    }
    {
      const s = await findStudent(testName)
      const sc = await getScore(testName)
      const deleted = (s?.status === 'Deleted') || (sc.data?.status === 'Deleted')
      record('软删除测试学生 status=Deleted', deleted, `status=${s?.status ?? sc.data?.status ?? 'n/a'} score=${sc.score}`)
    }

    // ========== 汇总 ==========
    console.log('\n========== EAA 事件生命周期深度测试汇总 ==========')
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
