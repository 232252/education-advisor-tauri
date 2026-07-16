// =============================================================
// EAA CLI 集成测试 — 通过 Tauri Bridge 测试所有 EAA 命令
// 覆盖: info/listStudents/score/ranking/addEvent/history/revertEvent
//       search/stats/validate/codes/doctor/summary/setStudentMeta/tag
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
  console.log('CDP connected, running tests...\n')

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

  // ========== 测试 1: info ==========
  let infoData = null
  try {
    const r = await callIpc(`const res = await api.eaa.info(); return res;`)
    infoData = r?.data
    record(`info 命令`, r?.success === true && infoData, `version=${infoData?.version} students=${infoData?.students} events=${infoData?.events}`)
  } catch (err) {
    record(`info 命令`, false, String(err.message || err))
  }

  // ========== 测试 2: listStudents ==========
  let students = null
  try {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    students = r?.data?.students
    record(`listStudents 命令`, r?.success === true && Array.isArray(students), `total=${r?.data?.total ?? 0} students.length=${students?.length ?? 0}`)
  } catch (err) {
    record(`listStudents 命令`, false, String(err.message || err))
  }

  // ========== 测试 3: score ==========
  let testStudent = null
  try {
    if (students && students.length > 0) {
      testStudent = students.find((s) => s.status !== 'Deleted') || students[0]
      const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(testStudent.name)}); return res;`)
      const score = r?.data
      record(`score 命令`, r?.success === true && score, `name=${score?.name} score=${score?.score} delta=${score?.delta} risk=${score?.risk}`)
    } else {
      record(`score 命令`, false, '无学生可用于测试')
    }
  } catch (err) {
    record(`score 命令`, false, String(err.message || err))
  }

  // ========== 测试 4: ranking ==========
  try {
    const r = await callIpc(`const res = await api.eaa.ranking(10); return res;`)
    const ranking = r?.data?.ranking
    record(`ranking 命令`, r?.success === true && Array.isArray(ranking), `top=${ranking?.length ?? 0} first=${ranking?.[0]?.name ?? ''} score=${ranking?.[0]?.score ?? ''}`)
  } catch (err) {
    record(`ranking 命令`, false, String(err.message || err))
  }

  // ========== 测试 5: codes ==========
  try {
    const r = await callIpc(`const res = await api.eaa.codes(); return res;`)
    const codes = r?.data?.codes
    record(`codes 命令`, r?.success === true && Array.isArray(codes), `codes=${codes?.length ?? 0} version=${r?.data?.version ?? ''}`)
  } catch (err) {
    record(`codes 命令`, false, String(err.message || err))
  }

  // ========== 测试 6: addEvent ==========
  let addedEventId = null
  try {
    if (testStudent) {
      const r = await callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(testStudent.name)},
          reasonCode: 'CLASS_COMMITTEE',
          delta: 5,
          note: '自动化测试-加分事件',
          tags: ['测试', '自动化'],
          force: true,
        });
        return res;
      `)
      const addRespText = String(r?.data ?? '')
      const evtMatch = addRespText.match(/evt_\w+/)
      addedEventId = evtMatch ? evtMatch[0] : (r?.success ? addRespText : null)
      record(`addEvent 命令`, r?.success === true && addedEventId, `eventId=${addedEventId}`)
    } else {
      record(`addEvent 命令`, false, '无测试学生')
    }
  } catch (err) {
    record(`addEvent 命令`, false, String(err.message || err))
  }

  // ========== 测试 7: history (验证刚添加的事件) ==========
  try {
    if (testStudent) {
      const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(testStudent.name)}); return res;`)
      const events = r?.data?.events
      const found = events?.find((e) => e.event_id === addedEventId)
      record(`history 命令 + 验证新事件`, r?.success === true && found, `events=${events?.length ?? 0} found=${!!found} note=${found?.note ?? ''}`)
    } else {
      record(`history 命令 + 验证新事件`, false, '无测试学生')
    }
  } catch (err) {
    record(`history 命令 + 验证新事件`, false, String(err.message || err))
  }

  // ========== 测试 8: search (搜索刚添加的事件) ==========
  try {
    const r = await callIpc(`const res = await api.eaa.search('自动化测试', 10); return res;`)
    const events = r?.data?.events
    const found = events?.find((e) => e.event_id === addedEventId)
    record(`search 命令`, r?.success === true, `total=${r?.data?.total ?? 0} showing=${events?.length ?? 0} found=${!!found}`)
  } catch (err) {
    record(`search 命令`, false, String(err.message || err))
  }

  // ========== 测试 9: tag (列表模式) ==========
  try {
    const r = await callIpc(`const res = await api.eaa.tag(); return res;`)
    const tags = r?.data?.tags
    record(`tag 命令 (列表)`, r?.success === true && Array.isArray(tags), `tags=${tags?.length ?? 0}`)
  } catch (err) {
    record(`tag 命令 (列表)`, false, String(err.message || err))
  }

  // ========== 测试 10: tag (指定 tag) ==========
  try {
    const r = await callIpc(`const res = await api.eaa.tag('测试'); return res;`)
    record(`tag 命令 (指定)`, r?.success === true, `tag=${r?.data?.tag ?? ''} total=${r?.data?.total ?? 0}`)
  } catch (err) {
    record(`tag 命令 (指定)`, false, String(err.message || err))
  }

  // ========== 测试 11: stats ==========
  try {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const summary = r?.data?.summary
    record(`stats 命令`, r?.success === true && summary, `students=${summary?.students ?? 0} total_events=${summary?.total_events ?? 0} valid=${summary?.valid_events ?? 0}`)
  } catch (err) {
    record(`stats 命令`, false, String(err.message || err))
  }

  // ========== 测试 12: validate ==========
  try {
    const r = await callIpc(`const res = await api.eaa.validate(); return res;`)
    const data = r?.data
    record(`validate 命令`, r?.success === true && data, `valid=${data?.valid} total_events=${data?.total_events ?? 0} errors=${data?.errors?.length ?? 0} warnings=${data?.warnings?.length ?? 0}`)
  } catch (err) {
    record(`validate 命令`, false, String(err.message || err))
  }

  // ========== 测试 13: doctor ==========
  try {
    const r = await callIpc(`const res = await api.eaa.doctor(); return res;`)
    const data = r?.data
    record(`doctor 命令`, r?.success === true && data, `healthy=${data?.healthy} passed=${data?.passed} failed=${data?.failed} issues=${data?.issues?.length ?? 0}`)
  } catch (err) {
    record(`doctor 命令`, false, String(err.message || err))
  }

  // ========== 测试 14: summary ==========
  try {
    const r = await callIpc(`const res = await api.eaa.summary(); return res;`)
    const data = r?.data
    record(`summary 命令`, r?.success === true && data, `total=${data?.events?.total ?? 0} bonus=${data?.events?.bonus_count ?? 0} deduct=${data?.events?.deduct_count ?? 0}`)
  } catch (err) {
    record(`summary 命令`, false, String(err.message || err))
  }

  // ========== 测试 15: revertEvent (撤销刚添加的事件) ==========
  try {
    if (addedEventId) {
      const r = await callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(addedEventId)}, '自动化测试-撤销'); return res;`)
      record(`revertEvent 命令`, r?.success === true, `result=${r?.data ?? ''}`)
    } else {
      record(`revertEvent 命令`, false, '无事件可撤销')
    }
  } catch (err) {
    record(`revertEvent 命令`, false, String(err.message || err))
  }

  // ========== 测试 16: 验证事件已撤销 ==========
  try {
    if (testStudent && addedEventId) {
      const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(testStudent.name)}); return res;`)
      const evt = r?.data?.events?.find((e) => e.event_id === addedEventId)
      record(`验证事件已撤销`, evt?.reverted === true, `reverted=${evt?.reverted}`)
    } else {
      record(`验证事件已撤销`, false, '无测试数据')
    }
  } catch (err) {
    record(`验证事件已撤销`, false, String(err.message || err))
  }

  // ========== 测试 17: setStudentMeta (设置班级) ==========
  try {
    if (testStudent) {
      const origClassId = testStudent.class_id
      const testClassId = 'TESTMETA'
      const r = await callIpc(`
        const res = await api.eaa.setStudentMeta({
          name: ${JSON.stringify(testStudent.name)},
          classId: '${testClassId}',
        });
        return res;
      `)
      // 验证
      const verify = await callIpc(`const res = await api.eaa.score(${JSON.stringify(testStudent.name)}); return res;`)
      const newClassId = verify?.data?.class_id
      // 恢复
      if (origClassId) {
        await callIpc(`const res = await api.eaa.setStudentMeta({ name: ${JSON.stringify(testStudent.name)}, classId: ${JSON.stringify(origClassId)} }); return res;`)
      } else {
        await callIpc(`const res = await api.eaa.setStudentMeta({ name: ${JSON.stringify(testStudent.name)}, clearClassId: true }); return res;`)
      }
      record(`setStudentMeta (classId)`, r?.success === true && newClassId === testClassId, `set=${r?.success} verified=${newClassId === testClassId} restored=true`)
    } else {
      record(`setStudentMeta (classId)`, false, '无测试学生')
    }
  } catch (err) {
    record(`setStudentMeta (classId)`, false, String(err.message || err))
  }

  // ========== 测试 18: exportFormats ==========
  try {
    const r = await callIpc(`const res = await api.eaa.exportFormats(); return res;`)
    record(`exportFormats 命令`, Array.isArray(r) && r.length > 0, `formats=${r?.length ?? 0} samples=${JSON.stringify(r?.slice(0, 3))}`)
  } catch (err) {
    record(`exportFormats 命令`, false, String(err.message || err))
  }

  // ========== 测试 19: range (日期范围查询) ==========
  try {
    const now = new Date()
    const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())
    const start = yearAgo.toISOString().split('T')[0]
    const end = now.toISOString().split('T')[0]
    const r = await callIpc(`const res = await api.eaa.range('${start}', '${end}', 10); return res;`)
    record(`range 命令`, r?.success === true, `start=${r?.data?.start ?? ''} end=${r?.data?.end ?? ''} total=${r?.data?.total ?? 0} showing=${r?.data?.showing ?? 0}`)
  } catch (err) {
    record(`range 命令`, false, String(err.message || err))
  }

  // ========== 测试 20: addEvent + revert 的分数一致性 ==========
  try {
    if (testStudent) {
      // 获取当前分数
      const before = await callIpc(`const res = await api.eaa.score(${JSON.stringify(testStudent.name)}); return res;`)
      const scoreBefore = before?.data?.score
      // 加 3 分
      const addRes = await callIpc(`
        const res = await api.eaa.addEvent({
          studentName: ${JSON.stringify(testStudent.name)},
          reasonCode: 'CIVILIZED_DORM',
          delta: 3,
          note: '分数一致性测试-加',
          force: true,
        });
        return res;
      `)
      const addText2 = String(addRes?.data ?? '')
      const evtMatch2 = addText2.match(/evt_\w+/)
      const evtId = evtMatch2 ? evtMatch2[0] : null
      // 验证分数增加了 3
      const after = await callIpc(`const res = await api.eaa.score(${JSON.stringify(testStudent.name)}); return res;`)
      const scoreAfter = after?.data?.score
      // 撤销
      if (evtId) {
        await callIpc(`const res = await api.eaa.revertEvent(${JSON.stringify(evtId)}, '分数一致性测试-撤销'); return res;`)
      }
      // 验证分数恢复
      const restored = await callIpc(`const res = await api.eaa.score(${JSON.stringify(testStudent.name)}); return res;`)
      const scoreRestored = restored?.data?.score
      record(`addEvent+revertEvent 分数一致性`, scoreAfter === scoreBefore + 3 && scoreRestored === scoreBefore, `before=${scoreBefore} after=${scoreAfter} (+3) restored=${scoreRestored}`)
    } else {
      record(`addEvent+revertEvent 分数一致性`, false, '无测试学生')
    }
  } catch (err) {
    record(`addEvent+revertEvent 分数一致性`, false, String(err.message || err))
  }

  // ========== 汇总 ==========
  console.log('\n========== EAA CLI 集成测试 ==========')
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
