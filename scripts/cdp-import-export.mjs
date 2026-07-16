// =============================================================
// CDP 导入导出功能测试 — 通过 Tauri/Electron Bridge 测试 EAA 数据导出
// 覆盖: exportFormats / export(csv|jsonl|html) / dashboard / stats
//       / summary / listStudents / 学业 IPC 探测 / 边界与一致性
// 连接方式参考 scripts/cdp-eaa-integration.mjs
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
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error(`JSON parse fail: ${e.message}`))
        }
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

  // ----- 连接 CDP -----
  const targets = (await fetchJson(`${BASE}/json`)).filter((t) => t.type === 'page')
  if (targets.length === 0) {
    console.log('FAIL: No CDP targets')
    process.exit(1)
  }
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
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.result?.exceptionDetails) {
      throw new Error(`Eval error: ${r.result.exceptionDetails.text}`)
    }
    return r.result?.result?.value
  }

  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP connected, running import/export tests...\n')

  // 在页面内执行异步代码,自动捕获异常
  // 返回值结构: 成功时为原始返回, 失败时为 { __error: string }
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

  // ============================================================
  // 预探测: 列出 eaa / academic 命名空间可用方法
  // ============================================================
  let eaaKeys = []
  let academicKeys = []
  try {
    const probe = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api || {};
        return {
          eaaKeys: api.eaa ? Object.keys(api.eaa) : [],
          academicKeys: api.academic ? Object.keys(api.academic) : [],
          hasEAA: !!window.__EAA_API__,
          hasApi: !!window.api,
        };
      })()
    `)
    eaaKeys = probe.eaaKeys || []
    academicKeys = probe.academicKeys || []
    console.log(`Probe: eaa keys = [${eaaKeys.join(', ')}]`)
    console.log(`Probe: academic keys = [${academicKeys.join(', ')}]`)
    console.log(`Probe: window.__EAA_API__=${probe.hasEAA} window.api=${probe.hasApi}\n`)
  } catch (err) {
    record('API 命名空间探测', false, String(err.message || err))
  }

  // ============================================================
  // 测试 1: EAA exportFormats — 返回 csv/jsonl/html
  // ============================================================
  let exportFormats = null
  try {
    const r = await callIpc(`const res = await api.eaa.exportFormats(); return res;`)
    exportFormats = Array.isArray(r) ? r : null
    const hasCsv = Array.isArray(r) && r.includes('csv')
    const hasJsonl = Array.isArray(r) && r.includes('jsonl')
    const hasHtml = Array.isArray(r) && r.includes('html')
    record(
      'EAA exportFormats 返回 csv/jsonl/html',
      hasCsv && hasJsonl && hasHtml,
      `formats=${JSON.stringify(r)} csv=${hasCsv} jsonl=${hasJsonl} html=${hasHtml}`,
    )
  } catch (err) {
    record('EAA exportFormats 返回 csv/jsonl/html', false, String(err.message || err))
  }

  // ============================================================
  // 测试 2: EAA 导出 CSV — 验证表头与学生数据
  // 注意: 实际签名为 export(format, outputFile?), 非对象参数
  // ============================================================
  let csvData = null
  try {
    const r = await callIpc(`const res = await api.eaa.export('csv'); return res;`)
    if (r?.__error) throw new Error(r.__error)
    const data = typeof r?.data === 'string' ? r.data : null
    csvData = data
    const hasHeader = data ? data.split('\n')[0].includes('姓名') || data.split('\n')[0].includes('name') || data.split('\n')[0].includes('分数') : false
    const lineCount = data ? data.split('\n').filter((l) => l.trim()).length : 0
    record(
      'EAA 导出 CSV 含表头与学生数据',
      r?.success === true && hasHeader && lineCount >= 1,
      `success=${r?.success} header="${data ? data.split('\n')[0] : ''}" lines=${lineCount} bytes=${data ? data.length : 0}`,
    )
  } catch (err) {
    record('EAA 导出 CSV 含表头与学生数据', false, String(err.message || err))
  }

  // ============================================================
  // 测试 3: EAA 导出 JSONL — 每行有效 JSON
  // ============================================================
  let jsonlData = null
  try {
    const r = await callIpc(`const res = await api.eaa.export('jsonl'); return res;`)
    if (r?.__error) throw new Error(r.__error)
    const data = typeof r?.data === 'string' ? r.data : null
    jsonlData = data
    let allValid = false
    let lineCount = 0
    let firstLine = ''
    if (data !== null) {
      const lines = data.split('\n').filter((l) => l.trim())
      lineCount = lines.length
      firstLine = lines[0] || ''
      allValid = lines.length > 0
      for (const line of lines) {
        try {
          JSON.parse(line)
        } catch {
          allValid = false
          break
        }
      }
      // 0 学生时 lines.length === 0, 视为合法(空导出)
      if (lines.length === 0) allValid = true
    }
    record(
      'EAA 导出 JSONL 每行有效 JSON',
      r?.success === true && allValid,
      `success=${r?.success} lines=${lineCount} allValid=${allValid} first="${firstLine.slice(0, 80)}" bytes=${data ? data.length : 0}`,
    )
  } catch (err) {
    record('EAA 导出 JSONL 每行有效 JSON', false, String(err.message || err))
  }

  // ============================================================
  // 测试 4: EAA 导出 HTML — 包含 HTML 标签
  // ============================================================
  try {
    const r = await callIpc(`const res = await api.eaa.export('html'); return res;`)
    if (r?.__error) throw new Error(r.__error)
    const data = typeof r?.data === 'string' ? r.data : null
    const hasHtmlTag = data ? /<[a-z!][^>]*>/i.test(data) : false
    const hasDoctypeOrHtml = data ? /<!doctype|<html/i.test(data) : false
    record(
      'EAA 导出 HTML 含 HTML 标签',
      r?.success === true && hasHtmlTag,
      `success=${r?.success} hasHtmlTag=${hasHtmlTag} hasDoctype=${hasDoctypeOrHtml} bytes=${data ? data.length : 0}`,
    )
  } catch (err) {
    record('EAA 导出 HTML 含 HTML 标签', false, String(err.message || err))
  }

  // ============================================================
  // 测试 5: EAA dashboard — 生成仪表盘(返回文本确认)
  // 注意: dashboard 写 HTML 文件到 outputDir(默认 ./eaa-dashboard), 返回文本确认
  // ============================================================
  let dashboardOk = false
  try {
    const r = await callIpc(`const res = await api.eaa.dashboard(); return res;`)
    if (r?.__error) throw new Error(r.__error)
    const data = typeof r?.data === 'string' ? r.data : ''
    dashboardOk = r?.success === true && /仪表盘|index\.html|dashboard/i.test(data)
    record(
      'EAA dashboard 生成仪表盘',
      dashboardOk,
      `success=${r?.success} data="${data.slice(0, 120)}"`,
    )
  } catch (err) {
    record('EAA dashboard 生成仪表盘', false, String(err.message || err))
  }

  // ============================================================
  // 测试 6: EAA stats — 返回 students/total_events/valid 等字段
  // ============================================================
  let statsSummary = null
  try {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    if (r?.__error) throw new Error(r.__error)
    const summary = r?.data?.summary
    statsSummary = summary
    const hasFields =
      summary &&
      typeof summary.students === 'number' &&
      typeof summary.total_events === 'number' &&
      typeof summary.valid_events === 'number'
    record(
      'EAA stats 返回 students/total_events/valid',
      r?.success === true && hasFields,
      `students=${summary?.students} total_events=${summary?.total_events} valid_events=${summary?.valid_events} reverted=${summary?.reverted_events ?? 'n/a'}`,
    )
  } catch (err) {
    record('EAA stats 返回 students/total_events/valid', false, String(err.message || err))
  }

  // ============================================================
  // 测试 7: EAA summary — 返回 total/bonus/deduct 字段
  // ============================================================
  let summaryEvents = null
  try {
    const r = await callIpc(`const res = await api.eaa.summary(); return res;`)
    if (r?.__error) throw new Error(r.__error)
    const events = r?.data?.events
    summaryEvents = events
    const hasFields =
      events &&
      typeof events.total === 'number' &&
      typeof events.bonus_count === 'number' &&
      typeof events.deduct_count === 'number'
    record(
      'EAA summary 返回 total/bonus/deduct',
      r?.success === true && hasFields,
      `total=${events?.total} bonus=${events?.bonus_count} deduct=${events?.deduct_count} bonus_total=${events?.bonus_total ?? 'n/a'} deduct_total=${events?.deduct_total ?? 'n/a'}`,
    )
  } catch (err) {
    record('EAA summary 返回 total/bonus/deduct', false, String(err.message || err))
  }

  // ============================================================
  // 测试 8: 学业成绩导出 — 探测 academic 是否有导出接口
  // ============================================================
  try {
    const exportLike = academicKeys.filter((k) => /export|download|dump|save/i.test(k))
    const hasExport = exportLike.length > 0
    if (hasExport) {
      // 若存在导出接口, 尝试调用(只读探测)
      const r = await callIpc(
        `const res = await api.academic.${exportLike[0]}(); return res;`,
      )
      record(
        '学业 IPC 导出接口探测',
        true,
        `找到方法: ${exportLike.join(', ')} 调用结果 success=${r?.success ?? 'n/a'}`,
      )
    } else {
      record(
        '学业 IPC 导出接口探测',
        true,
        `academic 无导出方法(可用: ${academicKeys.join(', ')})。成绩导出需通过 getGrades/getClassGrades 读取后前端自行序列化`,
      )
    }
  } catch (err) {
    record('学业 IPC 导出接口探测', false, String(err.message || err))
  }

  // ============================================================
  // 测试 9: 导出数据完整性 — CSV 学生数与 listStudents().total 一致
  // ============================================================
  try {
    const listRes = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    if (listRes?.__error) throw new Error(listRes.__error)
    const total = listRes?.data?.total
    const students = listRes?.data?.students
    let csvRows = -1
    if (csvData !== null) {
      const lines = csvData.split('\n').filter((l) => l.trim())
      // 第一行是表头, 其余为数据行
      csvRows = lines.length > 0 ? lines.length - 1 : 0
    }
    const studentsCount = Array.isArray(students) ? students.length : -1
    const consistent =
      csvRows >= 0 && typeof total === 'number' && csvRows === total && studentsCount === total
    record(
      '导出 CSV 学生数与 listStudents total 一致',
      consistent,
      `csvRows=${csvRows} listStudents.total=${total} students.length=${studentsCount}`,
    )
  } catch (err) {
    record('导出 CSV 学生数与 listStudents total 一致', false, String(err.message || err))
  }

  // ============================================================
  // 测试 10: 导出格式边界 — 不支持的 format('xml') 应返回错误
  // ============================================================
  try {
    const r = await callIpc(`const res = await api.eaa.export('xml'); return res;`)
    // handler 层会抛 Error(format must be one of ...), 被 callIpc 捕获为 __error
    const isError = !!r?.__error || r?.success === false
    const errMsg = r?.__error || r?.stderr || ''
    record(
      "导出格式边界 xml 应报错",
      isError,
      `error="${String(errMsg).slice(0, 120)}"`,
    )
  } catch (err) {
    record('导出格式边界 xml 应报错', false, String(err.message || err))
  }

  // ============================================================
  // 测试 11: 导出大文本不截断 — JSONL 完整性(returnByValue 限制)
  // ============================================================
  try {
    if (jsonlData !== null) {
      const byteLen = Buffer.byteLength(jsonlData, 'utf-8')
      const lines = jsonlData.split('\n').filter((l) => l.trim())
      // 验证最后一行也是有效 JSON(若被截断, 最后一行 JSON.parse 会失败)
      let lastLineValid = true
      let lastLinePreview = ''
      if (lines.length > 0) {
        lastLinePreview = lines[lines.length - 1].slice(0, 60)
        try {
          JSON.parse(lines[lines.length - 1])
        } catch {
          lastLineValid = false
        }
      }
      // CDP returnByValue 实际无硬性小限制(V8 字符串上限 ~512MB),
      // 但超大对象可能慢。这里记录字节数与末行有效性。
      const truncatedHint = byteLen > 5 * 1024 * 1024 ? ' (注意: >5MB, returnByValue 可能受影响)' : ''
      record(
        '导出 JSONL 大文本不截断',
        lastLineValid,
        `bytes=${byteLen} lines=${lines.length} lastLineValid=${lastLineValid} last="${lastLinePreview}"${truncatedHint}`,
      )
    } else {
      record('导出 JSONL 大文本不截断', false, 'JSONL 数据未获取(前置测试失败)')
    }
  } catch (err) {
    record('导出 JSONL 大文本不截断', false, String(err.message || err))
  }

  // ============================================================
  // 测试 12: dashboard 数据一致性 — dashboard 与 stats 一致性
  // 注意: dashboard 返回文件生成确认文本(非结构化统计),
  //       无法直接逐字段比对。改为校验 stats / summary / listStudents
  //       三者间的逻辑一致性:
  //   (a) stats.summary.students 应与 listStudents().total 一致;
  //   (b) summary.events.total 与 stats 的语义关系:
  //       - summary.total = valid 非回滚事件 (含 REVERT 类型事件本身)
  //       - stats.valid_events = valid 非回滚 非 REVERT 类型事件
  //       - stats.reverted_events = 已被回滚的事件
  //       - stats.total_events = 全部事件 (含无效/回滚/REVERT 类型)
  //       因此正确关系: stats.valid_events <= summary.total <= stats.total_events
  //       (summary 包含 REVERT 类型但不含已回滚/无效; stats.valid 不含 REVERT 类型)
  // ============================================================
  try {
    const listRes = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    if (listRes?.__error) throw new Error(listRes.__error)
    const listTotal = listRes?.data?.total

    const statsRes = await callIpc(`const res = await api.eaa.stats(); return res;`)
    if (statsRes?.__error) throw new Error(statsRes.__error)
    const statsStudents = statsRes?.data?.summary?.students
    const statsTotalEvents = statsRes?.data?.summary?.total_events
    const statsValid = statsRes?.data?.summary?.valid_events
    const statsReverted = statsRes?.data?.summary?.reverted_events

    const summaryRes = await callIpc(`const res = await api.eaa.summary(); return res;`)
    if (summaryRes?.__error) throw new Error(summaryRes.__error)
    const summaryTotal = summaryRes?.data?.events?.total

    // (a) 学生数一致性
    const studentsConsistent =
      typeof listTotal === 'number' && typeof statsStudents === 'number' && listTotal === statsStudents
    // (b) summary.total 语义范围校验: stats.valid_events <= summary.total <= stats.total_events
    // summary 包含 REVERT 类型事件 (valid 非回滚), stats.valid_events 不含 REVERT 类型
    // 因此 summary.total >= stats.valid_events; summary 不含无效/已回滚事件, 因此 <= total_events
    const eventsRelConsistent =
      typeof summaryTotal === 'number' &&
      typeof statsValid === 'number' &&
      typeof statsTotalEvents === 'number' &&
      summaryTotal >= statsValid &&
      summaryTotal <= statsTotalEvents
    // 附带记录差值 (仅供观察)
    const revertTypeCount =
      typeof summaryTotal === 'number' && typeof statsValid === 'number'
        ? summaryTotal - statsValid
        : null
    const orphanDelta =
      typeof statsTotalEvents === 'number' && typeof summaryTotal === 'number'
        ? statsTotalEvents - summaryTotal
        : null

    // dashboard 返回文本确认, 仅校验其成功执行(已在测试 5 覆盖)
    record(
      'dashboard/stats/summary 数据一致性',
      studentsConsistent && eventsRelConsistent,
      `students: listTotal=${listTotal} statsStudents=${statsStudents} (一致=${studentsConsistent}) | events: summaryTotal=${summaryTotal} statsValid=${statsValid} statsReverted=${statsReverted} statsTotal=${statsTotalEvents} | 关系: valid<=summary<=total (${eventsRelConsistent}) | REVERT类型事件=${revertTypeCount} 无效/已回滚=${orphanDelta}`,
    )
  } catch (err) {
    record('dashboard/stats/summary 数据一致性', false, String(err.message || err))
  }

  // ============================================================
  // 汇总
  // ============================================================
  console.log('\n========== 导入导出功能测试汇总 ==========')
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
