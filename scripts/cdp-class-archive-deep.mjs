// =============================================================
// 班级归档/恢复 + 批量分班 + 班级-学生关系 深度测试 (CDP / IPC 级)
// 覆盖: archive/restore 生命周期、归档带学生、批量分班、单分/移出、
//       学生调班、删除班级(级联)、列表过滤、并发操作、字段校验
// 连接: CDP http://127.0.0.1:9222, 通过 Runtime.evaluate 调用
//       渲染进程 IPC API (window.__EAA_API__ || window.api)
//
// 实际 API (本项目):
//   api.class.list()                          -> {success, data: ClassEntity[]}
//   api.class.create({class_id,name,grade?,note?,teacher?}) -> {success, data?, error?}
//   api.class.update(id, {name?,grade?,note?,teacher?})     -> {success, error?}
//   api.class.archive(id)                     -> {success, error?}   (id=内部 id)
//   api.class.restore(id)                     -> {success, error?}
//   api.class.delete(id)                      -> {success, classId?, error?} (级联清 EAA class_id)
//   api.class.assign({class_id, student_names:[]}) -> {success, assigned, failed[]}
//   api.class.removeStudent({student_name})   -> {success, error?} (清空 class_id)
//   api.eaa.listStudents()                    -> {data: {students: [...]}}
//   api.eaa.addStudent(name) / deleteStudent(name, reason)
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
  console.log('CDP connected, running class archive deep tests...\n')

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
  const listClasses = async () => {
    const r = await callIpc(`const res = await api.class.list(); return res;`)
    return r?.data ?? []
  }
  const findClassByClassId = async (classId) => {
    const all = await listClasses()
    return all.find((c) => c.class_id === classId) || null
  }
  const findClassById = async (id) => {
    const all = await listClasses()
    return all.find((c) => c.id === id) || null
  }
  const createClass = async (params) =>
    callIpc(`const res = await api.class.create(${JSON.stringify(params)}); return res;`)
  const updateClass = async (id, fields) =>
    callIpc(`const res = await api.class.update(${JSON.stringify(id)}, ${JSON.stringify(fields)}); return res;`)
  const archiveClass = async (id) =>
    callIpc(`const res = await api.class.archive(${JSON.stringify(id)}); return res;`)
  const restoreClass = async (id) =>
    callIpc(`const res = await api.class.restore(${JSON.stringify(id)}); return res;`)
  const deleteClass = async (id) =>
    callIpc(`const res = await api.class.delete(${JSON.stringify(id)}); return res;`)
  const assignStudents = async (classId, names) =>
    callIpc(`const res = await api.class.assign({ class_id: ${JSON.stringify(classId)}, student_names: ${JSON.stringify(names)} }); return res;`)
  const removeStudent = async (studentName) =>
    callIpc(`const res = await api.class.removeStudent({ student_name: ${JSON.stringify(studentName)} }); return res;`)

  const listStudents = async () => {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    return r?.data?.students ?? r?.students ?? []
  }
  const findStudent = async (name) => {
    const all = await listStudents()
    return all.find((s) => s.name === name) || null
  }
  const addStudent = async (name) =>
    callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(name)}); return res;`)
  const deleteStudent = async (name, reason) =>
    callIpc(`const res = await api.eaa.deleteStudent(${JSON.stringify(name)}, ${JSON.stringify(reason)}); return res;`)

  // 期望判定 helper
  const isSuccess = (r) => !!r && !r.__error && r.success === true
  const isRejected = (r) => !!r && (r.__error || r.success === false)
  const notCrash = (r) => r != null && (r.success === true || r.success === false || !!r.__error)

  const TS = Date.now()
  // 测试班级编号 (class_id 必须为字母数字/./-, ≤32 字符)
  const CID_A = `ARC-A-${TS % 100000000}`
  const CID_B = `ARC-B-${TS % 100000000}`
  const CID_C = `ARC-C-${TS % 100000000}`
  let idA = null, idB = null, idC = null
  // 测试学生
  const stuNames = Array.from({ length: 5 }, (_, i) => `CDP_Arc_${TS}_${i}`)

  // 清理追踪
  const createdClassIds = new Set()   // 内部 id
  const createdStudents = new Set()   // name

  const cleanupClass = async (id) => {
    if (!id) return
    try { await deleteClass(id) } catch (e) {}
  }
  const cleanupStudent = async (name) => {
    try { await deleteStudent(name, 'cdp-class-archive-deep cleanup') } catch (e) {}
  }

  // ============================================================
  // 1. Setup: 创建测试班级 + 添加测试学生
  // ============================================================
  console.log('━━━ 1. Setup: 创建测试班级 + 添加测试学生 ━━━')

  await test('1.1 创建测试班级 A', async () => {
    const r = await createClass({ class_id: CID_A, name: `归档测试A_${TS}`, teacher: 'T_A', note: 'A 班' })
    if (isSuccess(r)) { idA = r.data.id; createdClassIds.add(idA) }
    record('1.1 创建测试班级 A', isSuccess(r) && !!idA, `success=${r?.success} id=${idA} class_id=${r?.data?.class_id}`)
  })

  await test('1.2 创建测试班级 B', async () => {
    const r = await createClass({ class_id: CID_B, name: `归档测试B_${TS}`, teacher: 'T_B' })
    if (isSuccess(r)) { idB = r.data.id; createdClassIds.add(idB) }
    record('1.2 创建测试班级 B', isSuccess(r) && !!idB, `success=${r?.success} id=${idB}`)
  })

  await test('1.3 创建测试班级 C', async () => {
    const r = await createClass({ class_id: CID_C, name: `归档测试C_${TS}` })
    if (isSuccess(r)) { idC = r.data.id; createdClassIds.add(idC) }
    record('1.3 创建测试班级 C', isSuccess(r) && !!idC, `success=${r?.success} id=${idC}`)
  })

  await test('1.4 添加 5 个测试学生', async () => {
    const rs = await Promise.all(stuNames.map((n) => addStudent(n)))
    stuNames.forEach((n) => createdStudents.add(n))
    const okCount = rs.filter(isSuccess).length
    record('1.4 添加 5 个测试学生', okCount === 5, `${okCount}/5 success`)
  })

  await test('1.5 验证 3 个班级均在列表中', async () => {
    const all = await listClasses()
    const foundA = all.find((c) => c.class_id === CID_A)
    const foundB = all.find((c) => c.class_id === CID_B)
    const foundC = all.find((c) => c.class_id === CID_C)
    const ok = foundA && foundB && foundC && foundA.archived === false
    record('1.5 验证 3 个班级均在列表中', !!ok, `A=${!!foundA} B=${!!foundB} C=${!!foundC} A.archived=${foundA?.archived}`)
  })

  // ============================================================
  // 2. Archive/Restore 生命周期
  // ============================================================
  console.log('\n━━━ 2. Archive/Restore 生命周期 ━━━')

  await test('2.1 归档班级 A', async () => {
    const r = await archiveClass(idA)
    record('2.1 归档班级 A', isSuccess(r), `success=${r?.success} err=${r?.error ?? r?.__error ?? ''}`)
  })

  await test('2.2 验证 A archived=true 且 archived_at 已设置', async () => {
    const c = await findClassById(idA)
    const ok = !!c && c.archived === true && typeof c.archived_at === 'number' && c.archived_at > 0
    record('2.2 验证 A archived=true 且 archived_at 已设置', ok, `archived=${c?.archived} archived_at=${c?.archived_at}`)
  })

  await test('2.3 恢复班级 A', async () => {
    const r = await restoreClass(idA)
    record('2.3 恢复班级 A', isSuccess(r), `success=${r?.success}`)
  })

  await test('2.4 验证 A restored (archived=false, archived_at 清空)', async () => {
    const c = await findClassById(idA)
    const ok = !!c && c.archived === false && (c.archived_at === undefined || c.archived_at === null)
    record('2.4 验证 A restored (archived=false, archived_at 清空)', ok, `archived=${c?.archived} archived_at=${c?.archived_at ?? 'null'}`)
  })

  await test('2.5 重复归档 A (re-archive 不崩溃)', async () => {
    const r = await archiveClass(idA)
    const c = await findClassById(idA)
    const ok = isSuccess(r) && c?.archived === true
    record('2.5 重复归档 A (re-archive 不崩溃)', ok, `success=${r?.success} archived=${c?.archived}`)
  })

  await test('2.6 重复恢复 A (re-restore 不崩溃)', async () => {
    const r = await restoreClass(idA)
    const c = await findClassById(idA)
    const ok = isSuccess(r) && c?.archived === false
    record('2.6 重复恢复 A (re-restore 不崩溃)', ok, `success=${r?.success} archived=${c?.archived}`)
  })

  await test('2.7 归档班级 B', async () => {
    const r = await archiveClass(idB)
    record('2.7 归档班级 B', isSuccess(r), `success=${r?.success}`)
  })

  await test('2.8 验证归档班级 B 仍可经 list 检索', async () => {
    const c = await findClassByClassId(CID_B)
    const ok = !!c && c.archived === true
    record('2.8 验证归档班级 B 仍可经 list 检索', ok, `found=${!!c} archived=${c?.archived} archived_at=${c?.archived_at ?? 'null'}`)
  })

  // ============================================================
  // 3. Archive with students (归档不解绑学生)
  // ============================================================
  console.log('\n━━━ 3. Archive with students (归档不解绑学生) ━━━')

  await test('3.1 分配学生 0,1 到班级 C', async () => {
    const r = await assignStudents(CID_C, [stuNames[0], stuNames[1]])
    record('3.1 分配学生 0,1 到班级 C', isSuccess(r), `success=${r?.success} assigned=${r?.assigned} failed=${(r?.failed ?? []).length}`)
  })

  await test('3.2 归档班级 C (带学生)', async () => {
    const r = await archiveClass(idC)
    record('3.2 归档班级 C (带学生)', isSuccess(r), `success=${r?.success}`)
  })

  await test('3.3 验证归档后学生 class_id 仍为 C (不解绑)', async () => {
    const s0 = await findStudent(stuNames[0])
    const s1 = await findStudent(stuNames[1])
    const ok = s0?.class_id === CID_C && s1?.class_id === CID_C
    record('3.3 验证归档后学生 class_id 仍为 C (不解绑)', ok, `s0.class_id=${s0?.class_id} s1.class_id=${s1?.class_id}`)
  })

  await test('3.4 恢复班级 C, 验证学生仍绑定', async () => {
    const r = await restoreClass(idC)
    const s0 = await findStudent(stuNames[0])
    const ok = isSuccess(r) && s0?.class_id === CID_C
    record('3.4 恢复班级 C, 验证学生仍绑定', ok, `restore=${r?.success} s0.class_id=${s0?.class_id}`)
  })

  // ============================================================
  // 4. 批量分班
  // ============================================================
  console.log('\n━━━ 4. 批量分班 ━━━')

  await test('4.1 批量分配 3 学生到班级 A', async () => {
    const r = await assignStudents(CID_A, [stuNames[2], stuNames[3], stuNames[4]])
    const ok = isSuccess(r) && r.assigned === 3 && (r.failed ?? []).length === 0
    record('4.1 批量分配 3 学生到班级 A', ok, `success=${r?.success} assigned=${r?.assigned} failed=${(r?.failed ?? []).length}`)
  })

  await test('4.2 验证 3 学生 class_id 均为 A', async () => {
    const s2 = await findStudent(stuNames[2])
    const s3 = await findStudent(stuNames[3])
    const s4 = await findStudent(stuNames[4])
    const ok = s2?.class_id === CID_A && s3?.class_id === CID_A && s4?.class_id === CID_A
    record('4.2 验证 3 学生 class_id 均为 A', ok, `s2=${s2?.class_id} s3=${s3?.class_id} s4=${s4?.class_id}`)
  })

  await test('4.3 批量分配空数组 (应拒绝, 不崩溃)', async () => {
    const r = await assignStudents(CID_A, [])
    record('4.3 批量分配空数组 (应拒绝, 不崩溃)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('4.4 批量分配不存在学生 (应报告失败)', async () => {
    const ghost = `CDP_Ghost_${TS}`
    const r = await assignStudents(CID_A, [ghost])
    // 不存在学生应进入 failed[], 整体 success 仍可能为 true
    const ok = !!r && !r.__error && Array.isArray(r.failed) && r.failed.length > 0
    record('4.4 批量分配不存在学生 (应报告失败)', ok, `success=${r?.success} assigned=${r?.assigned} failed=${(r?.failed ?? []).length}`)
  })

  await test('4.5 批量分配含特殊字符名字 (应拒绝 sanitize)', async () => {
    const r = await assignStudents(CID_A, ['Bad<>Name'])
    record('4.5 批量分配含特殊字符名字 (应拒绝 sanitize)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('4.6 批量分配重复学生 (不崩溃, 行为检查)', async () => {
    const r = await assignStudents(CID_A, [stuNames[2], stuNames[2]])
    // 重复分配: 两次 set-student-meta 同一学生, 均成功, assigned=2 (幂等)
    const ok = notCrash(r) && (r.success === true || r.success === false)
    record('4.6 批量分配重复学生 (不崩溃, 行为检查)', ok, `success=${r?.success} assigned=${r?.assigned} failed=${(r?.failed ?? []).length}`)
  })

  // ============================================================
  // 5. 单个分配 / 移除
  // ============================================================
  console.log('\n━━━ 5. 单个分配 / 移除 ━━━')

  await test('5.1 单个分配学生 0 到班级 A (批量1)', async () => {
    // 先移出 C
    await removeStudent(stuNames[0])
    const r = await assignStudents(CID_A, [stuNames[0]])
    const s = await findStudent(stuNames[0])
    const ok = isSuccess(r) && s?.class_id === CID_A
    record('5.1 单个分配学生 0 到班级 A (批量1)', ok, `success=${r?.success} s0.class_id=${s?.class_id}`)
  })

  await test('5.2 移除学生 0 (清空 class_id)', async () => {
    const r = await removeStudent(stuNames[0])
    const s = await findStudent(stuNames[0])
    const ok = isSuccess(r) && !s?.class_id
    record('5.2 移除学生 0 (清空 class_id)', ok, `success=${r?.success} s0.class_id=${s?.class_id ?? 'null'}`)
  })

  await test('5.3 分配到非法格式 class_id (应拒绝 sanitize)', async () => {
    const r = await assignStudents('BAD CLASS ID!', [stuNames[0]])
    record('5.3 分配到非法格式 class_id (应拒绝 sanitize)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('5.4 移除不存在学生 (应拒绝/不崩溃)', async () => {
    const ghost = `CDP_GhostRm_${TS}`
    const r = await removeStudent(ghost)
    record('5.4 移除不存在学生 (应拒绝/不崩溃)', notCrash(r), `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('5.5 移除未分班学生 (幂等, 不崩溃)', async () => {
    // 学生 0 已在 5.2 被移除, 现在无 class_id, 再次移除应不崩溃
    const r = await removeStudent(stuNames[0])
    record('5.5 移除未分班学生 (幂等, 不崩溃)', notCrash(r), `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  // ============================================================
  // 6. 学生调班 (reassignment)
  // ============================================================
  console.log('\n━━━ 6. 学生调班 (reassignment) ━━━')

  await test('6.1 分配学生 4 到班级 A', async () => {
    const r = await assignStudents(CID_A, [stuNames[4]])
    const s = await findStudent(stuNames[4])
    const ok = isSuccess(r) && s?.class_id === CID_A
    record('6.1 分配学生 4 到班级 A', ok, `success=${r?.success} s4.class_id=${s?.class_id}`)
  })

  await test('6.2 把学生 4 调到班级 B (reassign)', async () => {
    const r = await assignStudents(CID_B, [stuNames[4]])
    const s = await findStudent(stuNames[4])
    const ok = isSuccess(r) && s?.class_id === CID_B
    record('6.2 把学生 4 调到班级 B (reassign)', ok, `success=${r?.success} s4.class_id=${s?.class_id}`)
  })

  await test('6.3 验证学生 4 class_id 已从 A 变为 B', async () => {
    const s = await findStudent(stuNames[4])
    const ok = s?.class_id === CID_B && s?.class_id !== CID_A
    record('6.3 验证学生 4 class_id 已从 A 变为 B', ok, `s4.class_id=${s?.class_id} (A=${CID_A} B=${CID_B})`)
  })

  // ============================================================
  // 7. 删除班级 (含级联清理)
  // ============================================================
  console.log('\n━━━ 7. 删除班级 (含级联清理) ━━━')

  // 准备一个空班级用于删除
  let idEmpty = null
  const CID_EMPTY = `ARC-E-${TS % 100000000}`
  await test('7.1 准备: 创建空班级 E', async () => {
    const r = await createClass({ class_id: CID_EMPTY, name: `空班E_${TS}` })
    if (isSuccess(r)) { idEmpty = r.data.id; createdClassIds.add(idEmpty) }
    record('7.1 准备: 创建空班级 E', isSuccess(r) && !!idEmpty, `success=${r?.success} id=${idEmpty}`)
  })

  await test('7.2 删除空班级 E (应成功)', async () => {
    const r = await deleteClass(idEmpty)
    const gone = !(await findClassByClassId(CID_EMPTY))
    const ok = isSuccess(r) && gone
    record('7.2 删除空班级 E (应成功)', ok, `success=${r?.success} classId=${r?.classId ?? ''} gone=${gone}`)
    if (ok) createdClassIds.delete(idEmpty)
  })

  // 准备一个带学生的班级用于删除 (级联清理测试)
  let idWithStu = null
  const CID_DEL = `ARC-D-${TS % 100000000}`
  const delStu = `CDP_Del_${TS}`
  await test('7.3 准备: 创建带学生班级 D + 分配', async () => {
    const cr = await createClass({ class_id: CID_DEL, name: `删班D_${TS}` })
    if (isSuccess(cr)) { idWithStu = cr.data.id; createdClassIds.add(idWithStu) }
    await addStudent(delStu); createdStudents.add(delStu)
    const ar = await assignStudents(CID_DEL, [delStu])
    const s = await findStudent(delStu)
    const ok = isSuccess(cr) && isSuccess(ar) && s?.class_id === CID_DEL
    record('7.3 准备: 创建带学生班级 D + 分配', ok, `class=${isSuccess(cr)} assign=${isSuccess(ar)} s.class_id=${s?.class_id}`)
  })

  await test('7.4 删除带学生班级 D (应成功 + 级联清空学生 class_id)', async () => {
    const r = await deleteClass(idWithStu)
    // 级联清理: 学生 class_id 应被清空
    const s = await findStudent(delStu)
    const ok = isSuccess(r) && !s?.class_id
    record('7.4 删除带学生班级 D (应成功 + 级联清空学生 class_id)', ok, `success=${r?.success} s.class_id=${s?.class_id ?? 'null'} (级联清理)`)
    if (isSuccess(r)) createdClassIds.delete(idWithStu)
  })

  await test('7.5 删除已归档班级 (应成功)', async () => {
    // 先归档 B, 再删除
    await archiveClass(idB)
    const r = await deleteClass(idB)
    const gone = !(await findClassByClassId(CID_B))
    const ok = isSuccess(r) && gone
    record('7.5 删除已归档班级 (应成功)', ok, `success=${r?.success} gone=${gone}`)
    if (ok) createdClassIds.delete(idB)
  })

  await test('7.6 删除不存在班级 (应失败)', async () => {
    const r = await deleteClass(`nonexistent-id-${TS}`)
    record('7.6 删除不存在班级 (应失败)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  // ============================================================
  // 8. 班级列表过滤
  // ============================================================
  console.log('\n━━━ 8. 班级列表过滤 ━━━')

  await test('8.1 list 返回含活跃与归档班级', async () => {
    // 先归档 C, A 保持活跃
    await archiveClass(idC)
    const all = await listClasses()
    const hasActive = all.some((c) => c.class_id === CID_A && !c.archived)
    const hasArchived = all.some((c) => c.class_id === CID_C && c.archived)
    record('8.1 list 返回含活跃与归档班级', hasActive && hasArchived, `total=${all.length} hasActive=${hasActive} hasArchived=${hasArchived}`)
  })

  await test('8.2 过滤活跃班级 (排除归档)', async () => {
    const all = await listClasses()
    const active = all.filter((c) => !c.archived)
    const aInActive = active.some((c) => c.class_id === CID_A)
    const cNotInActive = !active.some((c) => c.class_id === CID_C)
    record('8.2 过滤活跃班级 (排除归档)', aInActive && cNotInActive, `activeCount=${active.length} A_in=${aInActive} C_excluded=${cNotInActive}`)
  })

  await test('8.3 过滤归档班级 (仅归档)', async () => {
    const all = await listClasses()
    const archived = all.filter((c) => c.archived)
    const cInArchived = archived.some((c) => c.class_id === CID_C)
    const aNotInArchived = !archived.some((c) => c.class_id === CID_A)
    record('8.3 过滤归档班级 (仅归档)', cInArchived && aNotInArchived, `archivedCount=${archived.length} C_in=${cInArchived} A_excluded=${aNotInArchived}`)
  })

  // ============================================================
  // 9. 并发操作
  // ============================================================
  console.log('\n━━━ 9. 并发操作 ━━━')

  await test('9.1 并发分配不同学生到同一班级', async () => {
    // 学生 0,1,2 当前未分班或分散, 并发分配到 A
    await removeStudent(stuNames[0])
    await removeStudent(stuNames[1])
    await removeStudent(stuNames[2])
    const rs = await Promise.all([
      assignStudents(CID_A, [stuNames[0]]),
      assignStudents(CID_A, [stuNames[1]]),
      assignStudents(CID_A, [stuNames[2]]),
    ])
    const okCount = rs.filter(isSuccess).length
    const s0 = await findStudent(stuNames[0])
    const s1 = await findStudent(stuNames[1])
    const s2 = await findStudent(stuNames[2])
    const allAssigned = s0?.class_id === CID_A && s1?.class_id === CID_A && s2?.class_id === CID_A
    record('9.1 并发分配不同学生到同一班级', okCount === 3 && allAssigned, `${okCount}/3 success, allAssigned=${allAssigned}`)
  })

  await test('9.2 并发归档/恢复不同班级', async () => {
    // A 恢复, C 归档(已是归档, 先恢复再并发归档)
    await restoreClass(idC)
    const [rA, rC] = await Promise.all([
      archiveClass(idA),
      archiveClass(idC),
    ])
    const cA = await findClassById(idA)
    const cC = await findClassById(idC)
    const ok = isSuccess(rA) && isSuccess(rC) && cA?.archived === true && cC?.archived === true
    record('9.2 并发归档/恢复不同班级', ok, `rA=${rA?.success} rC=${rC?.success} A.archived=${cA?.archived} C.archived=${cC?.archived}`)
  })

  await test('9.3 并发创建不同班级', async () => {
    const base = `ARC-CC-${TS % 10000000}-`
    const ids = [`${base}0`, `${base}1`, `${base}2`]
    const rs = await Promise.all(ids.map((cid) => createClass({ class_id: cid, name: `并发${cid}` })))
    rs.forEach((r) => { if (isSuccess(r)) createdClassIds.add(r.data.id) })
    const okCount = rs.filter(isSuccess).length
    record('9.3 并发创建不同班级', okCount === 3, `${okCount}/3 success`)
  })

  // ============================================================
  // 10. 字段校验
  // ============================================================
  console.log('\n━━━ 10. 字段校验 ━━━')

  await test('10.1 创建空 class_id (应拒绝)', async () => {
    const r = await createClass({ class_id: '', name: '空编号' })
    record('10.1 创建空 class_id (应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('10.2 创建空 name (应拒绝)', async () => {
    const r = await createClass({ class_id: `ARC-EMPTY-N-${TS % 100000}`, name: '' })
    record('10.2 创建空 name (应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('10.3 创建含特殊字符 class_id (应拒绝 sanitize)', async () => {
    const r = await createClass({ class_id: `ARC BAD@${TS}`, name: '特殊编号' })
    record('10.3 创建含特殊字符 class_id (应拒绝 sanitize)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('10.4 创建超长 name (>64 字符, 应拒绝)', async () => {
    const r = await createClass({ class_id: `ARC-LONG-${TS % 100000}`, name: 'X'.repeat(100) })
    record('10.4 创建超长 name (>64 字符, 应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('10.5 创建重复 class_id (应拒绝)', async () => {
    const r = await createClass({ class_id: CID_A, name: '重复编号班' })
    record('10.5 创建重复 class_id (应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('10.6 更新班级字段 (name/teacher/note)', async () => {
    const r = await updateClass(idA, { name: `A_更新_${TS}`, teacher: 'T_A_new', note: '更新备注' })
    const c = await findClassById(idA)
    const ok = isSuccess(r) && c?.name === `A_更新_${TS}` && c?.teacher === 'T_A_new' && c?.note === '更新备注'
    record('10.6 更新班级字段 (name/teacher/note)', ok, `success=${r?.success} name=${c?.name} teacher=${c?.teacher} note=${c?.note}`)
  })

  await test('10.7 更新不存在班级 (应失败)', async () => {
    const r = await updateClass(`nonexistent-id-${TS}`, { name: 'x' })
    record('10.7 更新不存在班级 (应失败)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('10.8 归档不存在班级 (应失败)', async () => {
    const r = await archiveClass(`nonexistent-id-${TS}`)
    record('10.8 归档不存在班级 (应失败)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  // ============================================================
  // 11. 清理: 删除所有测试班级 + 软删除所有测试学生
  // ============================================================
  console.log('\n━━━ 11. 清理测试数据 ━━━')

  await test('11.1 删除所有测试班级', async () => {
    let okCount = 0
    let total = 0
    for (const id of Array.from(createdClassIds)) {
      total++
      try {
        const r = await deleteClass(id)
        if (isSuccess(r)) okCount++
      } catch (e) {}
    }
    record('11.1 删除所有测试班级', okCount === total, `${okCount}/${total} 已删除`)
  })

  await test('11.2 软删除所有测试学生', async () => {
    let okCount = 0
    let total = 0
    for (const name of Array.from(createdStudents)) {
      total++
      try {
        const r = await deleteStudent(name, 'cdp-class-archive-deep cleanup')
        if (isSuccess(r)) okCount++
      } catch (e) {}
    }
    record('11.2 软删除所有测试学生', okCount === total, `${okCount}/${total} 已软删除`)
  })

  // ============================================================
  // 汇总
  // ============================================================
  console.log('\n========== 班级归档/恢复 + 批量分班 + 班级-学生关系 深度测试 ==========')
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
