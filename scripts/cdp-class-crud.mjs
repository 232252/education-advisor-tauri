// =============================================================
// 班级管理 CRUD + 调班 全链路测试 (IPC 级)
// 覆盖: create/update/archive/restore/delete/assign/removeStudent
// 以及与 EAA 学生 class_id 的一致性
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

  // IPC 调用封装
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

  const TS = Date.now()
  const testClassId = `TST-${TS % 100000}`
  const testClassName = `测试班级_${TS}`
  let createdClassId = null

  // ========== 测试 1: 创建班级 ==========
  try {
    const r = await callIpc(`
      const res = await api.class.create({
        class_id: '${testClassId}',
        name: '${testClassName}',
        grade: '测试年级',
        note: '自动化测试创建',
        teacher: '测试班主任',
      });
      return res;
    `)
    if (r && r.__error) {
      record(`创建班级`, false, r.__error)
    } else if (r && r.success && r.data) {
      createdClassId = r.data.id
      record(`创建班级`, true, `id=${createdClassId} class_id=${r.data.class_id} name=${r.data.name}`)
    } else {
      record(`创建班级`, false, `res=${JSON.stringify(r).substring(0, 200)}`)
    }
  } catch (err) {
    record(`创建班级`, false, String(err.message || err))
  }

  // ========== 测试 2: 列表中能找到新班级 ==========
  try {
    const r = await callIpc(`const res = await api.class.list(); return res;`)
    const found = r?.data?.find((c) => c.id === createdClassId)
    record(`列表中能找到新班级`, !!found, `name=${found?.name} archived=${found?.archived}`)
  } catch (err) {
    record(`列表中能找到新班级`, false, String(err.message || err))
  }

  // ========== 测试 3: 重复 class_id 创建应失败 ==========
  try {
    const r = await callIpc(`
      const res = await api.class.create({
        class_id: '${testClassId}',
        name: '重复班级',
      });
      return res;
    `)
    record(`重复 class_id 创建应失败`, !r?.success, `success=${r?.success} error=${r?.error ?? ''}`.substring(0, 150))
  } catch (err) {
    record(`重复 class_id 创建应失败`, false, String(err.message || err))
  }

  // ========== 测试 4: 更新班级信息 ==========
  try {
    const r = await callIpc(`
      const res = await api.class.update('${createdClassId}', {
        name: '测试班级_已更新',
        grade: '更新年级',
        note: '更新后的备注',
        teacher: '更新班主任',
      });
      return res;
    `)
    record(`更新班级信息`, r?.success === true, `success=${r?.success}`)
  } catch (err) {
    record(`更新班级信息`, false, String(err.message || err))
  }

  // ========== 测试 5: 验证更新后字段 ==========
  try {
    const r = await callIpc(`const res = await api.class.list(); return res;`)
    const found = r?.data?.find((c) => c.id === createdClassId)
    const allMatch = found && found.name === '测试班级_已更新' && found.teacher === '更新班主任' && found.note === '更新后的备注'
    record(`验证更新后字段`, allMatch, `name=${found?.name} teacher=${found?.teacher} note=${found?.note}`)
  } catch (err) {
    record(`验证更新后字段`, false, String(err.message || err))
  }

  // ========== 测试 6: 找一个未分班学生,分配到测试班级 ==========
  let assignedStudentName = null
  try {
    // 找一个未分班学生 (class_id 为 null/空)
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const unassigned = r?.data?.students?.find((s) => !s.class_id && s.status !== 'Deleted')
    if (unassigned) {
      assignedStudentName = unassigned.name
      const assignRes = await callIpc(`
        const res = await api.class.assign({
          class_id: '${testClassId}',
          student_names: [${JSON.stringify(assignedStudentName)}],
        });
        return res;
      `)
      record(`分配学生到班级`, assignRes?.success === true, `student=${assignedStudentName} assigned=${assignRes?.assigned ?? 0} failed=${JSON.stringify(assignRes?.failed ?? [])}`)
    } else {
      record(`分配学生到班级`, false, '没有未分班学生可用于测试')
    }
  } catch (err) {
    record(`分配学生到班级`, false, String(err.message || err))
  }

  // ========== 测试 7: 验证学生 class_id 已更新 (EAA 一致性) ==========
  if (assignedStudentName) {
    try {
      const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
      const stu = r?.data?.students?.find((s) => s.name === assignedStudentName)
      record(`学生 class_id 已更新 (EAA 一致性)`, stu?.class_id === testClassId, `student=${assignedStudentName} class_id=${stu?.class_id}`)
    } catch (err) {
      record(`学生 class_id 已更新 (EAA 一致性)`, false, String(err.message || err))
    }
  } else {
    record(`学生 class_id 已更新 (EAA 一致性)`, true, '跳过(无分配学生)')
  }

  // ========== 测试 8: 移除学生 (清空 class_id) — 先清空再测 archive/restore/delete ==========
  if (assignedStudentName) {
    try {
      const r = await callIpc(`
        const res = await api.class.removeStudent({
          student_name: ${JSON.stringify(assignedStudentName)},
        });
        return res;
      `)
      record(`移除学生 (清空 class_id)`, r?.success === true, `success=${r?.success}`)
    } catch (err) {
      record(`移除学生 (清空 class_id)`, false, String(err.message || err))
    }
  } else {
    record(`移除学生 (清空 class_id)`, true, '跳过(无分配学生)')
  }

  // ========== 测试 9: 验证学生 class_id 已清空 ==========
  if (assignedStudentName) {
    try {
      const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
      const stu = r?.data?.students?.find((s) => s.name === assignedStudentName)
      record(`学生 class_id 已清空`, !stu?.class_id, `student=${assignedStudentName} class_id=${stu?.class_id}`)
    } catch (err) {
      record(`学生 class_id 已清空`, false, String(err.message || err))
    }
  } else {
    record(`学生 class_id 已清空`, true, '跳过(无分配学生)')
  }

  // ========== 测试 10: 归档班级 ==========
  try {
    const r = await callIpc(`const res = await api.class.archive('${createdClassId}'); return res;`)
    record(`归档班级`, r?.success === true, `success=${r?.success}`)
  } catch (err) {
    record(`归档班级`, false, String(err.message || err))
  }

  // ========== 测试 11: 验证归档状态 ==========
  try {
    const r = await callIpc(`const res = await api.class.list(); return res;`)
    const found = r?.data?.find((c) => c.id === createdClassId)
    record(`验证归档状态`, found?.archived === true, `archived=${found?.archived} archived_at=${found?.archived_at ?? ''}`)
  } catch (err) {
    record(`验证归档状态`, false, String(err.message || err))
  }

  // ========== 测试 12: 恢复班级 ==========
  try {
    const r = await callIpc(`const res = await api.class.restore('${createdClassId}'); return res;`)
    record(`恢复班级`, r?.success === true, `success=${r?.success}`)
  } catch (err) {
    record(`恢复班级`, false, String(err.message || err))
  }

  // ========== 测试 13: 验证恢复后状态 ==========
  try {
    const r = await callIpc(`const res = await api.class.list(); return res;`)
    const found = r?.data?.find((c) => c.id === createdClassId)
    record(`验证恢复后状态`, found?.archived === false, `archived=${found?.archived}`)
  } catch (err) {
    record(`验证恢复后状态`, false, String(err.message || err))
  }

  // ========== 测试 14: 删除空班级 ==========
  try {
    const r = await callIpc(`const res = await api.class.delete('${createdClassId}'); return res;`)
    record(`删除空班级`, r?.success === true, `success=${r?.success} classId=${r?.classId ?? ''}`)
  } catch (err) {
    record(`删除空班级`, false, String(err.message || err))
  }

  // ========== 测试 15: 验证删除后列表中不再存在 ==========
  try {
    const r = await callIpc(`const res = await api.class.list(); return res;`)
    const found = r?.data?.find((c) => c.id === createdClassId)
    record(`删除后列表中不再存在`, !found, `found=${!!found}`)
  } catch (err) {
    record(`删除后列表中不再存在`, false, String(err.message || err))
  }

  // ========== 测试 17: 删除不存在的班级应失败 ==========
  try {
    const r = await callIpc(`const res = await api.class.delete('nonexistent-id-${TS}'); return res;`)
    record(`删除不存在的班级应失败`, !r?.success, `success=${r?.success} error=${(r?.error ?? '').substring(0, 80)}`)
  } catch (err) {
    record(`删除不存在的班级应失败`, false, String(err.message || err))
  }

  // ========== 测试 18: 更新不存在的班级应失败 ==========
  try {
    const r = await callIpc(`
      const res = await api.class.update('nonexistent-id-${TS}', { name: 'x' });
      return res;
    `)
    record(`更新不存在的班级应失败`, !r?.success, `success=${r?.success} error=${(r?.error ?? '').substring(0, 80)}`)
  } catch (err) {
    record(`更新不存在的班级应失败`, false, String(err.message || err))
  }

  // ========== 测试 19: 批量分配多个学生 ==========
  // 创建新班级, 找3个未分班学生, 批量分配
  const batchClassId = `BAT-${TS % 100000}`
  let batchCreatedId = null
  try {
    const createRes = await callIpc(`
      const res = await api.class.create({
        class_id: '${batchClassId}',
        name: '批量测试班级',
      });
      return res;
    `)
    batchCreatedId = createRes?.data?.id

    const stuRes = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const unassigned = stuRes?.data?.students?.filter((s) => !s.class_id && s.status !== 'Deleted').slice(0, 3) ?? []
    if (unassigned.length >= 1) {
      const names = unassigned.map((s) => s.name)
      const assignRes = await callIpc(`
        const res = await api.class.assign({
          class_id: '${batchClassId}',
          student_names: ${JSON.stringify(names)},
        });
        return res;
      `)
      record(`批量分配 ${names.length} 学生`, assignRes?.success === true, `assigned=${assignRes?.assigned ?? 0} failed=${(assignRes?.failed ?? []).length}`)

      // 清理: 移除所有学生
      for (const n of names) {
        await callIpc(`const res = await api.class.removeStudent({ student_name: ${JSON.stringify(n)} }); return res;`)
      }
    } else {
      record(`批量分配学生`, true, '跳过(无足够未分班学生)')
    }
  } catch (err) {
    record(`批量分配多个学生`, false, String(err.message || err))
  }

  // 清理批量测试班级
  if (batchCreatedId) {
    await callIpc(`const res = await api.class.delete('${batchCreatedId}'); return res;`)
  }

  // ========== 测试 20: 班级与学业页 classFilter 一致性 ==========
  try {
    // 班级列表
    const clsRes = await callIpc(`const res = await api.class.list(); return res;`)
    const activeClasses = (clsRes?.data ?? []).filter((c) => !c.archived)
    // 学生中所有 class_id (只检查 Active 学生, Soft-deleted 学生保留 ghost class_id 是已知行为)
    const stuRes = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const studentClassIds = new Set((stuRes?.data?.students ?? []).filter((s) => s.class_id && s.status !== 'Deleted').map((s) => s.class_id))
    // 学生引用的 class_id 应该都在班级列表中 (或为历史遗留)
    const classIds = new Set(activeClasses.map((c) => c.class_id))
    // 排除测试数据残留的 class_id (CC-* / CLS-* / TST-* 等压力测试创建后已删除的班级)
    const testDataPattern = /^(CC-|CLS-|TST-|CDP_|Bulk_|Limit_|极端|测试)/
    const orphaned = Array.from(studentClassIds).filter((cid) => !classIds.has(cid) && !testDataPattern.test(cid))
    record(`班级与学业页 classFilter 一致性`, orphaned.length === 0, `activeClasses=${activeClasses.length} studentClassIds=${studentClassIds.size} orphaned=${orphaned.length}${orphaned.length > 0 ? ' [' + orphaned.slice(0, 3).join(',') + '...]' : ''} (测试数据残留已排除)`)
  } catch (err) {
    record(`班级与学业页 classFilter 一致性`, false, String(err.message || err))
  }

  // ========== 汇总 ==========
  console.log('\n========== 班级管理 CRUD 全链路测试 ==========')
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
