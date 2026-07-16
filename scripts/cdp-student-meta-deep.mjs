// =============================================================
// 学生元数据 / 软删除 / 恢复 深度测试 (CDP / IPC 级)
// 覆盖: Student CRUD、setStudentMeta/getStudentMeta、软删除行为、
//       deleteStudent reason 参数、字段校验、并发操作
// 连接: CDP http://127.0.0.1:9222, 通过 Runtime.evaluate 调用
//       渲染进程 IPC API (window.__EAA_API__ || window.api)
//
// 注意: 实际暴露的命名空间为 api.eaa.* (本项目无 api.student 命名空间,
//       已通过 CDP 探针确认 hasStudent=false)。本脚本使用真实 API
//       api.eaa.* 以确保测试可运行通过,语义与任务描述一致:
//         - eaa.listStudents()      ≈ student.list()
//         - eaa.score(name).data    ≈ student.get(name) (返回学生详情)
//         - eaa.addStudent(name)     ≈ student.add(name)
//         - eaa.deleteStudent(name, reason?)  == student.deleteStudent(name, reason?)
//         - eaa.setStudentMeta({name, ...meta})  ≈ student.setStudentMeta(name, meta)
//         - 读取元数据: 通过 listStudents()/score() 返回的学生对象字段
//           (groups[]/roles[]/class_id) 验证 round-trip
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
  // 包装每个测试: 捕获未预期异常, 不中断后续测试
  const test = (name, fn) => fn().catch((err) => record(name, false, `异常: ${String(err && err.message ? err.message : err).slice(0, 160)}`))

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
  console.log('CDP connected, running student meta deep tests...\n')

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

  // ---------- 业务 helper ----------
  const listStudents = async () => {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    return r?.data?.students ?? []
  }
  const findStudent = async (name) => {
    const all = await listStudents()
    return all.find((s) => s.name === name) || null
  }
  const addStudent = async (name) =>
    callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(name)}); return res;`)
  const deleteStudent = async (name, reason) =>
    callIpc(`const res = await api.eaa.deleteStudent(${JSON.stringify(name)}, ${JSON.stringify(reason)}); return res;`)
  const setStudentMeta = async (params) =>
    callIpc(`const res = await api.eaa.setStudentMeta(${JSON.stringify(params)}); return res;`)
  const getScore = async (name) => {
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(name)}); return res;`)
    return r?.data ?? null
  }
  const getHistory = async (name) => {
    const r = await callIpc(`const res = await api.eaa.history(${JSON.stringify(name)}); return res;`)
    return r?.data ?? null
  }
  const addEvent = async (params) =>
    callIpc(`const res = await api.eaa.addEvent(${JSON.stringify(params)}); return res;`)

  // 期望判定 helper
  const isSuccess = (r) => !!r && !r.__error && r.success === true
  const isRejected = (r) => !!r && (r.__error || r.success === false)
  const notCrash = (r) => r != null && (r.success === true || r.success === false || !!r.__error)

  const TS = Date.now()
  const mainStudent = `CDP_Meta_Test_${TS}`
  const createdForCleanup = new Set()

  // ============================================================
  // A. Student CRUD
  // ============================================================
  console.log('━━━ A. Student CRUD ━━━')

  await test('A1. 添加测试学生', async () => {
    const r = await addStudent(mainStudent)
    if (isSuccess(r)) createdForCleanup.add(mainStudent)
    record('A1. 添加测试学生', isSuccess(r), `success=${r?.success} data=${String(r?.data ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('A2. get 学生详情 (存在性)', async () => {
    const s = await findStudent(mainStudent)
    record('A2. get 学生详情 (存在性)', !!s && s.name === mainStudent && s.status === 'Active', `status=${s?.status} score=${s?.score}`)
  })

  await test('A3. list 学生列表 (包含新学生)', async () => {
    const all = await listStudents()
    const found = all.find((s) => s.name === mainStudent)
    record('A3. list 学生列表 (包含新学生)', !!found && all.length >= 1, `total=${all.length} found=${!!found}`)
  })

  await test('A4. 软删除学生 (带 reason)', async () => {
    const r = await deleteStudent(mainStudent, 'cdp-meta-deep 软删除测试')
    record('A4. 软删除学生 (带 reason)', isSuccess(r), `success=${r?.success} data=${String(r?.data ?? '').slice(0, 60)}`)
  })

  await test('A5. 验证学生状态变为 Deleted', async () => {
    const s = await findStudent(mainStudent)
    record('A5. 验证学生状态变为 Deleted', !!s && s.status === 'Deleted', `status=${s?.status}`)
  })

  await test('A6. 读取已删除学生元数据 (仍可读)', async () => {
    // 元数据通过学生对象字段读取 (无独立 getStudentMeta)
    const s = await findStudent(mainStudent)
    record('A6. 读取已删除学生元数据 (仍可读)', !!s && s.name === mainStudent && s.status === 'Deleted', `name=${s?.name} status=${s?.status} class_id=${s?.class_id}`)
  })

  // ============================================================
  // B. setStudentMeta / getStudentMeta
  // ============================================================
  console.log('\n━━━ B. setStudentMeta / getStudentMeta ━━━')

  const metaStudent = `CDP_Meta_${TS}`

  await test('B0. 准备: 添加 meta 测试学生', async () => {
    const r = await addStudent(metaStudent)
    if (isSuccess(r)) createdForCleanup.add(metaStudent)
    record('B0. 准备: 添加 meta 测试学生', isSuccess(r), `success=${r?.success}`)
  })

  await test('B7. 设置有效元数据 (group/role/classId)', async () => {
    const r = await setStudentMeta({ name: metaStudent, group: 'G7', role: 'Monitor', classId: 'CLS-7' })
    record('B7. 设置有效元数据 (group/role/classId)', isSuccess(r), `success=${r?.success}`)
  })

  await test('B8. 读取元数据 round-trip 验证', async () => {
    const s = await findStudent(metaStudent)
    const ok = !!s && Array.isArray(s.groups) && s.groups.includes('G7') &&
      Array.isArray(s.roles) && s.roles.includes('Monitor') && s.class_id === 'CLS-7'
    record('B8. 读取元数据 round-trip 验证', ok, `groups=${JSON.stringify(s?.groups)} roles=${JSON.stringify(s?.roles)} class_id=${s?.class_id}`)
  })

  await test('B9. 设置空 meta 对象 (仅 name, 无字段)', async () => {
    const r = await setStudentMeta({ name: metaStudent })
    record('B9. 设置空 meta 对象 (仅 name, 无字段)', isSuccess(r), `success=${r?.success} (应 no-op 成功)`)
  })

  await test('B10. 设置 null/undefined 值 (不崩溃)', async () => {
    const r = await setStudentMeta({ name: metaStudent, group: null, role: undefined, classId: null })
    record('B10. 设置 null/undefined 值 (不崩溃)', isSuccess(r), `success=${r?.success} (falsy 字段应被跳过)`)
  })

  await test('B11. 设置超长 group (>1000 chars, 应拒绝)', async () => {
    const longGroup = 'x'.repeat(1000)
    const r = await setStudentMeta({ name: metaStudent, group: longGroup })
    record('B11. 设置超长 group (>1000 chars, 应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.__error ?? r?.data ?? '').slice(0, 50)}`)
  })

  await test('B12. 设置 Unicode/emoji group', async () => {
    const r = await setStudentMeta({ name: metaStudent, group: '🎉测试组' })
    record('B12. 设置 Unicode/emoji group', isSuccess(r), `success=${r?.success}`)
  })

  await test('B13. 设置特殊字符 group (HTML/SQL, 应拒绝)', async () => {
    const r = await setStudentMeta({ name: metaStudent, group: '<script>alert(1)</script>; DROP' })
    record('B13. 设置特殊字符 group (HTML/SQL, 应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.__error ?? '').slice(0, 50)}`)
  })

  await test('B14. 设置元数据到不存在学生 (不崩溃)', async () => {
    const r = await setStudentMeta({ name: `NonExist_${TS}`, group: 'Ghost' })
    record('B14. 设置元数据到不存在学生 (不崩溃)', notCrash(r), `success=${r?.success} err=${String(r?.__error ?? r?.data ?? '').slice(0, 50)}`)
  })

  await test('B15. 读取不存在学生元数据 (返回 null)', async () => {
    const s = await findStudent(`NonExist_${TS}`)
    record('B15. 读取不存在学生元数据 (返回 null)', s === null, `found=${s === null ? 'no(null)' : 'yes'}`)
  })

  await test('B16. 部分更新元数据 (只设 role, group 不变)', async () => {
    // 先确保 group=G7 存在 (B7 已设), 再只设 role2
    await setStudentMeta({ name: metaStudent, group: 'G7' })
    const before = await findStudent(metaStudent)
    const r = await setStudentMeta({ name: metaStudent, role: 'Role2' })
    const after = await findStudent(metaStudent)
    // setStudentMeta 为部分更新: 只动 role, group 应保留 G7
    const ok = isSuccess(r) && after?.groups?.includes('G7') && after?.roles?.includes('Role2')
    record('B16. 部分更新元数据 (只设 role, group 不变)', ok, `before.groups=${JSON.stringify(before?.groups)} after.groups=${JSON.stringify(after?.groups)} after.roles=${JSON.stringify(after?.roles)}`)
  })

  await test('B17. 并发 setStudentMeta 同一学生 (竞态不崩溃)', async () => {
    const [r1, r2] = await Promise.all([
      setStudentMeta({ name: metaStudent, role: 'Concurrent_A' }),
      setStudentMeta({ name: metaStudent, role: 'Concurrent_B' }),
    ])
    const s = await findStudent(metaStudent)
    // 两次都成功且最终状态一致 (至少包含其中一个 role)
    const ok = isSuccess(r1) && isSuccess(r2) && !!s && (s.roles.includes('Concurrent_A') || s.roles.includes('Concurrent_B'))
    record('B17. 并发 setStudentMeta 同一学生 (竞态不崩溃)', ok, `r1=${r1?.success} r2=${r2?.success} roles=${JSON.stringify(s?.roles)}`)
  })

  // ============================================================
  // C. 软删除行为
  // ============================================================
  console.log('\n━━━ C. 软删除行为 ━━━')

  const softStudent = `CDP_Soft_${TS}`

  await test('C0a. 准备: 添加软删除测试学生', async () => {
    const r = await addStudent(softStudent)
    if (isSuccess(r)) createdForCleanup.add(softStudent)
    record('C0a. 准备: 添加软删除测试学生', isSuccess(r), `success=${r?.success}`)
  })

  await test('C0b. 准备: 为该学生添加 EAA 事件', async () => {
    const r = await addEvent({ studentName: softStudent, reasonCode: 'CLASS_MONITOR', delta: 8, note: 'soft-delete 前事件', force: true })
    record('C0b. 准备: 为该学生添加 EAA 事件', isSuccess(r), `success=${r?.success} data=${String(r?.data ?? '').slice(0, 50)}`)
  })

  await test('C18. 添加学生+事件后软删除', async () => {
    const r = await deleteStudent(softStudent, 'cdp 软删除行为测试')
    record('C18. 添加学生+事件后软删除', isSuccess(r), `success=${r?.success} data=${String(r?.data ?? '').slice(0, 60)}`)
  })

  await test('C19. eaa.score(已删除) 返回 BASE_SCORE + Deleted', async () => {
    const sc = await getScore(softStudent)
    const ok = !!sc && sc.score === BASE_SCORE && sc.status === 'Deleted'
    record('C19. eaa.score(已删除) 返回 BASE_SCORE + Deleted', ok, `score=${sc?.score} status=${sc?.status}`)
  })

  await test('C20. eaa.history(已删除) 仍可用', async () => {
    const h = await getHistory(softStudent)
    // history 仍返回结构化数据 (events 可能因 is_valid=false 而为空, 但 events_count 保留)
    const ok = !!h && h.name === softStudent
    record('C20. eaa.history(已删除) 仍可用', ok, `name=${h?.name} events_count=${h?.events_count}`)
  })

  await test('C21. 已删除学生不在 active 列表但在 full 列表', async () => {
    const all = await listStudents()
    const active = all.filter((s) => s.status !== 'Deleted')
    const inActive = active.some((s) => s.name === softStudent)
    const inFull = all.some((s) => s.name === softStudent)
    const ok = !inActive && inFull
    record('C21. 已删除学生不在 active 列表但在 full 列表', ok, `inActive=${inActive} inFull=${inFull} activeTotal=${active.length}`)
  })

  await test('C22. 删除已删除学生 (幂等)', async () => {
    const r = await deleteStudent(softStudent, 'idempotent re-delete')
    record('C22. 删除已删除学生 (幂等)', isSuccess(r), `success=${r?.success} data=${String(r?.data ?? '').slice(0, 60)}`)
  })

  await test('C23. 删除不存在学生 (不崩溃)', async () => {
    const r = await deleteStudent(`NonExist_${TS}`, 'cleanup ghost')
    record('C23. 删除不存在学生 (不崩溃)', notCrash(r), `success=${r?.success} data=${String(r?.data ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('C24. 恢复操作: 重新 add 已删除学生应失败 (无 restore 路径)', async () => {
    // EAA 软删除为终态: 重新 add 同名返回 "已存在", 即无法通过 add 恢复
    const r = await addStudent(softStudent)
    record('C24. 恢复操作: 重新 add 已删除学生应失败 (无 restore 路径)', isRejected(r), `rejected=${isRejected(r)} data=${String(r?.data ?? r?.__error ?? '').slice(0, 60)}`)
  })

  // ============================================================
  // D. deleteStudent reason 参数
  // ============================================================
  console.log('\n━━━ D. deleteStudent reason 参数 ━━━')

  const reasonBase = `CDP_Rsn_${TS}_`

  await test('D25. 带原因字符串删除', async () => {
    const n = reasonBase + 'str'
    await addStudent(n); createdForCleanup.add(n)
    const r = await deleteStudent(n, 'a normal reason string')
    record('D25. 带原因字符串删除', isSuccess(r), `success=${r?.success}`)
  })

  await test('D26. 不带原因删除 (undefined reason)', async () => {
    const n = reasonBase + 'norsn'
    await addStudent(n); createdForCleanup.add(n)
    const r = await deleteStudent(n) // reason = undefined
    record('D26. 不带原因删除 (undefined reason)', isSuccess(r), `success=${r?.success} (preload 包装为 reason=undefined)`)
  })

  await test('D27. 超长原因 (>1000 chars, 不崩溃)', async () => {
    const n = reasonBase + 'long'
    await addStudent(n); createdForCleanup.add(n)
    const longReason = 'R'.repeat(1000)
    const r = await deleteStudent(n, longReason)
    record('D27. 超长原因 (>1000 chars, 不崩溃)', notCrash(r), `success=${r?.success} data=${String(r?.data ?? r?.__error ?? '').slice(0, 50)}`)
  })

  await test('D28. 特殊字符原因 (不崩溃)', async () => {
    const n = reasonBase + 'spec'
    await addStudent(n); createdForCleanup.add(n)
    const r = await deleteStudent(n, 'reason with < > & ; "quotes" and 中文 🎉')
    record('D28. 特殊字符原因 (不崩溃)', notCrash(r), `success=${r?.success} data=${String(r?.data ?? r?.__error ?? '').slice(0, 50)}`)
  })

  // ============================================================
  // E. 字段校验
  // ============================================================
  console.log('\n━━━ E. 字段校验 ━━━')

  await test('E29. 空名字添加 (应拒绝)', async () => {
    const r = await addStudent('')
    record('E29. 空名字添加 (应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.__error ?? r?.data ?? '').slice(0, 50)}`)
  })

  await test('E30. 重复名字添加 (应拒绝)', async () => {
    // metaStudent 已存在 (B0)
    const r = await addStudent(metaStudent)
    record('E30. 重复名字添加 (应拒绝)', isRejected(r), `rejected=${isRejected(r)} data=${String(r?.data ?? r?.__error ?? '').slice(0, 50)}`)
  })

  await test('E31. 特殊字符名字 (应拒绝)', async () => {
    const r = await addStudent(`Bad<>{}Name_${TS}`)
    record('E31. 特殊字符名字 (应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.__error ?? '').slice(0, 50)}`)
  })

  await test('E32. 超长名字 (>64 chars, 应拒绝)', async () => {
    const r = await addStudent('A'.repeat(100))
    record('E32. 超长名字 (>64 chars, 应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.__error ?? '').slice(0, 50)}`)
  })

  // ============================================================
  // F. 并发操作
  // ============================================================
  console.log('\n━━━ F. 并发操作 ━━━')

  await test('F33. 并发添加不同学生', async () => {
    const base = `CDP_Conc_${TS}_`
    const names = Array.from({ length: 5 }, (_, i) => `${base}${i}`)
    const rs = await Promise.all(names.map((n) => addStudent(n)))
    names.forEach((n) => createdForCleanup.add(n))
    const okCount = rs.filter(isSuccess).length
    record('F33. 并发添加不同学生', okCount === 5, `${okCount}/5 success`)
  })

  await test('F34. 并发 setStudentMeta 不同学生', async () => {
    const base = `CDP_MetaConc_${TS}_`
    const names = []
    for (let i = 0; i < 3; i++) {
      const n = `${base}${i}`
      await addStudent(n); createdForCleanup.add(n); names.push(n)
    }
    const rs = await Promise.all(names.map((n, i) => setStudentMeta({ name: n, group: `GG_${i}`, role: `RR_${i}`, classId: `CC-${i}` })))
    const okCount = rs.filter(isSuccess).length
    // 验证 round-trip
    const verify = await Promise.all(names.map((n) => findStudent(n)))
    const allRoundTrip = verify.every((s) => s && s.groups?.length > 0 && s.roles?.length > 0)
    record('F34. 并发 setStudentMeta 不同学生', okCount === 3 && allRoundTrip, `${okCount}/3 success roundTrip=${allRoundTrip}`)
  })

  await test('F35. 并发 get 同一学生 (一致性)', async () => {
    const reads = await Promise.all(Array.from({ length: 10 }, () => findStudent(metaStudent)))
    const allConsistent = reads.every((s) => s && s.name === metaStudent)
    const firstScore = reads[0]?.score
    const scoreConsistent = reads.every((s) => s?.score === firstScore)
    record('F35. 并发 get 同一学生 (一致性)', allConsistent && scoreConsistent, `allRead=${reads.length} consistent=${allConsistent && scoreConsistent} score=${firstScore}`)
  })

  // ============================================================
  // 清理: 软删除所有测试学生
  // ============================================================
  console.log('\n━━━ 清理测试数据 ━━━')
  for (const name of createdForCleanup) {
    try {
      await deleteStudent(name, 'cdp-meta-deep cleanup')
      console.log(`  软删除: ${name}`)
    } catch (e) {
      console.log(`  清理失败 ${name}: ${String(e && e.message ? e.message : e).slice(0, 80)}`)
    }
  }

  // ============================================================
  // 汇总
  // ============================================================
  console.log('\n========== 学生元数据 / 软删除 / 恢复 深度测试 ==========')
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
