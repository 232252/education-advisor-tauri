// =============================================================
// 日志系统 深度测试 (CDP) — export / clear / filter / search / forward
// 覆盖: list 结构 / read 边界 / search 深度 / filter 深度 /
//       forward (fire-and-forget) / export (含临时文件验证) /
//       exportWithDialog (不崩溃) / clear (非破坏性, 仅校验签名) /
//       并发 / 幂等
// 注意: log.clear() 实际签名无参且会清空全部日志 — 本脚本绝不调用其执行,
//       仅校验 typeof === 'function'。
// =============================================================
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

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

  // ---------- CDP 连接 ----------
  let targets
  try {
    targets = (await fetchJson(`${BASE}/json`)).filter((t) => t.type === 'page')
  } catch (err) {
    console.log(`FAIL: 无法连接 CDP (${BASE}/json): ${err.message}`)
    process.exit(1)
  }
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

  // callIpc: 包裹 async IIFE, 捕获 throw 并以 {__error} 返回
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

  const tmpExportPath = path.join(os.tmpdir(), `eaa-cdp-log-export-${Date.now()}.log`)

  // =============================================================
  // 1. log.list 结构
  // =============================================================
  console.log('--- 1. log.list 结构 ---')
  let logList = []
  try {
    const r = await callIpc(`const res = await api.log.list(); return res;`)
    logList = Array.isArray(r) ? r : []
    record('log.list 返回数组', Array.isArray(r), `count=${logList.length}`)
  } catch (err) {
    record('log.list 返回数组', false, String(err.message || err))
  }

  // 每项含 name(string) + sizeBytes(number)
  if (logList.length > 0) {
    const allHaveFields = logList.every(
      (l) => typeof l?.name === 'string' && typeof l?.sizeBytes === 'number',
    )
    record('log.list 项含 name+sizeBytes', allHaveFields,
      `sample=${JSON.stringify(logList[0]).substring(0, 80)}`)
  } else {
    record('log.list 项含 name+sizeBytes', true, '无日志文件, 跳过')
  }

  // 有日志文件 (count > 0)
  record('log.list 数量 > 0', logList.length > 0, `count=${logList.length}`)

  // 名称遵循 (main|chat|renderer)-YYYY-MM-DD.log
  if (logList.length > 0) {
    const re = /^(main|chat|renderer)-\d{4}-\d{2}-\d{2}\.log$/
    const allMatch = logList.every((l) => re.test(l.name))
    const samples = logList.slice(0, 3).map((l) => l.name).join(', ')
    record('log.list 名称匹配模式', allMatch, `samples=[${samples}]`)
  } else {
    record('log.list 名称匹配模式', true, '无日志文件, 跳过')
  }

  // 大小合理性 (非负, < 100MB)
  if (logList.length > 0) {
    const sizes = logList.map((l) => l.sizeBytes).filter((n) => typeof n === 'number' && !Number.isNaN(n))
    const maxSize = sizes.length ? Math.max(...sizes) : 0
    const minSize = sizes.length ? Math.min(...sizes) : 0
    const REASONABLE_MAX = 100 * 1024 * 1024
    record('log.list 大小合理', sizes.length === logList.length && maxSize < REASONABLE_MAX,
      `min=${minSize}B max=${maxSize}B`)
  } else {
    record('log.list 大小合理', true, '无日志文件, 跳过')
  }

  const firstLog = logList[0]
  const secondLog = logList[1] || logList[0]
  console.log(`  (首条日志: ${firstLog?.name ?? '无'} size=${firstLog?.sizeBytes ?? '-'}B)`)

  // =============================================================
  // 2. log.read 深度
  // =============================================================
  console.log('\n--- 2. log.read 深度 ---')
  if (firstLog) {
    // 默认行数
    try {
      const r = await callIpc(`const res = await api.log.read(${JSON.stringify(firstLog.name)}); return res;`)
      record('log.read 默认行数', typeof r === 'string',
        `len=${r?.length ?? 0} head="${String(r ?? '').substring(0, 40).replace(/\n/g, '\\n')}"`)
    } catch (err) { record('log.read 默认行数', false, String(err.message || err)) }

    // 显式 10 行
    try {
      const r = await callIpc(`const res = await api.log.read(${JSON.stringify(firstLog.name)}, 10); return res;`)
      record('log.read 10 行', typeof r === 'string', `len=${r?.length ?? 0}`)
    } catch (err) { record('log.read 10 行', false, String(err.message || err)) }

    // 50 行
    try {
      const r = await callIpc(`const res = await api.log.read(${JSON.stringify(firstLog.name)}, 50); return res;`)
      record('log.read 50 行', typeof r === 'string', `len=${r?.length ?? 0}`)
    } catch (err) { record('log.read 50 行', false, String(err.message || err)) }

    // 100 行
    try {
      const r = await callIpc(`const res = await api.log.read(${JSON.stringify(firstLog.name)}, 100); return res;`)
      record('log.read 100 行', typeof r === 'string', `len=${r?.length ?? 0}`)
    } catch (err) { record('log.read 100 行', false, String(err.message || err)) }

    // 行数 = 0 (边界, slice(-0)=slice(0)=全部行)
    try {
      const r = await callIpc(`const res = await api.log.read(${JSON.stringify(firstLog.name)}, 0); return res;`)
      record('log.read 行数=0 (边界)', typeof r === 'string', `len=${r?.length ?? 0}`)
    } catch (err) { record('log.read 行数=0 (边界)', false, String(err.message || err)) }

    // 行数 = 1 (最小)
    try {
      const r = await callIpc(`const res = await api.log.read(${JSON.stringify(firstLog.name)}, 1); return res;`)
      const lines = String(r ?? '').split('\n').filter((x) => x.length > 0)
      record('log.read 行数=1 (最小)', typeof r === 'string' && lines.length <= 1,
        `len=${r?.length ?? 0} lineCount=${lines.length}`)
    } catch (err) { record('log.read 行数=1 (最小)', false, String(err.message || err)) }

    // 超大行数 100000 (应返回全部可用)
    try {
      const r = await callIpc(`const res = await api.log.read(${JSON.stringify(firstLog.name)}, 100000); return res;`)
      record('log.read 超大行数 100000', typeof r === 'string', `len=${r?.length ?? 0}`)
    } catch (err) { record('log.read 超大行数 100000', false, String(err.message || err)) }

    // 返回值是字符串
    try {
      const r = await callIpc(`const res = await api.log.read(${JSON.stringify(firstLog.name)}, 20); return res;`)
      record('log.read 返回 string', typeof r === 'string', `type=${typeof r}`)
    } catch (err) { record('log.read 返回 string', false, String(err.message || err)) }
  } else {
    record('log.read 深度', true, '无日志文件, 跳过')
  }

  // 不存在文件 — 应返回空字符串而非崩溃
  try {
    const r = await callIpc(`const res = await api.log.read('nonexistent-${Date.now()}.log', 20); return res;`)
    record('log.read 不存在文件', typeof r === 'string' && r.length === 0, `len=${r?.length ?? 0}`)
  } catch (err) { record('log.read 不存在文件', false, String(err.message || err)) }

  // 空文件名 — 应 reject (validateLogPath 抛错)
  try {
    const r = await callIpc(`const res = await api.log.read('', 20); return res;`)
    record('log.read 空文件名', r?.__error !== undefined, `err=${r?.__error ?? ''}`)
  } catch (err) { record('log.read 空文件名', false, String(err.message || err)) }

  // 特殊字符文件名 (纯文件名, 不含分隔符, 不存在 -> 空串)
  try {
    const r = await callIpc(`const res = await api.log.read('test-special!@#-chars.log', 20); return res;`)
    record('log.read 特殊字符文件名', typeof r === 'string' && r.length === 0, `len=${r?.length ?? 0}`)
  } catch (err) { record('log.read 特殊字符文件名', false, String(err.message || err)) }

  // =============================================================
  // 3. log.search 深度
  // =============================================================
  console.log('\n--- 3. log.search 深度 ---')
  if (firstLog) {
    // 通用关键词 (INFO 大小写不敏感)
    try {
      const r = await callIpc(`const res = await api.log.search(${JSON.stringify(firstLog.name)}, 'INFO', 50); return res;`)
      record('log.search INFO', typeof r === 'string', `len=${r?.length ?? 0}`)
    } catch (err) { record('log.search INFO', false, String(err.message || err)) }

    // 不存在关键词 — 空串
    try {
      const r = await callIpc(`const res = await api.log.search(${JSON.stringify(firstLog.name)}, '绝对不存在_zzzqqq_xx_${Date.now()}', 50); return res;`)
      record('log.search 不存在关键词', typeof r === 'string' && r.length === 0, `len=${r?.length ?? 0}`)
    } catch (err) { record('log.search 不存在关键词', false, String(err.message || err)) }

    // 空查询 — 返回完整 tail
    try {
      const r = await callIpc(`const res = await api.log.search(${JSON.stringify(firstLog.name)}, '', 20); return res;`)
      record('log.search 空查询', typeof r === 'string', `len=${r?.length ?? 0}`)
    } catch (err) { record('log.search 空查询', false, String(err.message || err)) }

    // 特殊字符 (regex 元字符, 子串匹配不崩溃)
    try {
      const r = await callIpc(`const res = await api.log.search(${JSON.stringify(firstLog.name)}, '.*[]?', 20); return res;`)
      record('log.search regex 元字符', typeof r === 'string', `len=${r?.length ?? 0}`)
    } catch (err) { record('log.search regex 元字符', false, String(err.message || err)) }

    // Unicode / emoji
    try {
      const r = await callIpc(`const res = await api.log.search(${JSON.stringify(firstLog.name)}, '测试😀🎉', 20); return res;`)
      record('log.search Unicode/emoji', typeof r === 'string', `len=${r?.length ?? 0}`)
    } catch (err) { record('log.search Unicode/emoji', false, String(err.message || err)) }

    // 超长查询 (>100 字符) — 不崩溃即可 (日志中可能含长串 x)
    const longQuery = 'x'.repeat(150)
    try {
      const r = await callIpc(`const res = await api.log.search(${JSON.stringify(firstLog.name)}, ${JSON.stringify(longQuery)}, 20); return res;`)
      record('log.search 超长查询', typeof r === 'string', `len=${r?.length ?? 0} queryLen=${longQuery.length}`)
    } catch (err) { record('log.search 超长查询', false, String(err.message || err)) }

    // SQL 注入模式 (字面子串)
    try {
      const r = await callIpc(`const res = await api.log.search(${JSON.stringify(firstLog.name)}, "' OR 1=1 --", 20); return res;`)
      record('log.search SQL 注入模式', typeof r === 'string', `len=${r?.length ?? 0}`)
    } catch (err) { record('log.search SQL 注入模式', false, String(err.message || err)) }

    // 带行数限制
    try {
      const r = await callIpc(`const res = await api.log.search(${JSON.stringify(firstLog.name)}, ']', 5); return res;`)
      record('log.search 行数限制', typeof r === 'string', `len=${r?.length ?? 0}`)
    } catch (err) { record('log.search 行数限制', false, String(err.message || err)) }

    // 大小写不敏感验证 (search 'info' 应与 'INFO' 等价)
    try {
      const lo = await callIpc(`const res = await api.log.search(${JSON.stringify(firstLog.name)}, 'info', 50); return res;`)
      const up = await callIpc(`const res = await api.log.search(${JSON.stringify(firstLog.name)}, 'INFO', 50); return res;`)
      record('log.search 大小写不敏感', typeof lo === 'string' && typeof up === 'string' && lo === up,
        `loLen=${lo?.length ?? 0} upLen=${up?.length ?? 0}`)
    } catch (err) { record('log.search 大小写不敏感', false, String(err.message || err)) }
  } else {
    record('log.search 深度', true, '无日志文件, 跳过')
  }

  // =============================================================
  // 4. log.filter 深度
  // =============================================================
  console.log('\n--- 4. log.filter 深度 ---')
  if (firstLog) {
    // ['error'] — 仅 error 行
    try {
      const r = await callIpc(`const res = await api.log.filter(${JSON.stringify(firstLog.name)}, ['error'], 50); return res;`)
      const lines = String(r ?? '').split('\n').filter((l) => l.length > 0)
      const allError = lines.length === 0 || lines.every((l) => l.toUpperCase().includes('[ERROR]'))
      record('log.filter [error]', typeof r === 'string' && allError,
        `len=${r?.length ?? 0} lineCount=${lines.length}`)
    } catch (err) { record('log.filter [error]', false, String(err.message || err)) }

    // ['warn', 'error'] — 多 level
    try {
      const r = await callIpc(`const res = await api.log.filter(${JSON.stringify(firstLog.name)}, ['warn', 'error'], 50); return res;`)
      const lines = String(r ?? '').split('\n').filter((l) => l.length > 0)
      const allMatch = lines.length === 0 || lines.every((l) => {
        const u = l.toUpperCase()
        return u.includes('[WARN]') || u.includes('[ERROR]')
      })
      record('log.filter [warn,error]', typeof r === 'string' && allMatch,
        `len=${r?.length ?? 0} lineCount=${lines.length}`)
    } catch (err) { record('log.filter [warn,error]', false, String(err.message || err)) }

    // ['info']
    try {
      const r = await callIpc(`const res = await api.log.filter(${JSON.stringify(firstLog.name)}, ['info'], 50); return res;`)
      record('log.filter [info]', typeof r === 'string', `len=${r?.length ?? 0}`)
    } catch (err) { record('log.filter [info]', false, String(err.message || err)) }

    // ['debug']
    try {
      const r = await callIpc(`const res = await api.log.filter(${JSON.stringify(firstLog.name)}, ['debug'], 50); return res;`)
      record('log.filter [debug]', typeof r === 'string', `len=${r?.length ?? 0}`)
    } catch (err) { record('log.filter [debug]', false, String(err.message || err)) }

    // [] 空数组 — 不过滤, 返回完整 tail
    try {
      const r = await callIpc(`const res = await api.log.filter(${JSON.stringify(firstLog.name)}, [], 20); return res;`)
      record('log.filter [] (空数组)', typeof r === 'string', `len=${r?.length ?? 0}`)
    } catch (err) { record('log.filter [] (空数组)', false, String(err.message || err)) }

    // ['nonexistent'] — 无效 level, 空串
    try {
      const r = await callIpc(`const res = await api.log.filter(${JSON.stringify(firstLog.name)}, ['nonexistent'], 50); return res;`)
      record('log.filter [nonexistent]', typeof r === 'string' && r.length === 0, `len=${r?.length ?? 0}`)
    } catch (err) { record('log.filter [nonexistent]', false, String(err.message || err)) }

    // ['ERROR'] 大写 — 与小写等价
    try {
      const r = await callIpc(`const res = await api.log.filter(${JSON.stringify(firstLog.name)}, ['ERROR'], 50); return res;`)
      const r2 = await callIpc(`const res = await api.log.filter(${JSON.stringify(firstLog.name)}, ['error'], 50); return res;`)
      record('log.filter [ERROR] 大写', typeof r === 'string' && r === r2, `len=${r?.length ?? 0} eqLower=${r === r2}`)
    } catch (err) { record('log.filter [ERROR] 大写', false, String(err.message || err)) }

    // 带行数限制
    try {
      const r = await callIpc(`const res = await api.log.filter(${JSON.stringify(firstLog.name)}, ['info'], 5); return res;`)
      record('log.filter 行数限制', typeof r === 'string', `len=${r?.length ?? 0}`)
    } catch (err) { record('log.filter 行数限制', false, String(err.message || err)) }
  } else {
    record('log.filter 深度', true, '无日志文件, 跳过')
  }

  // =============================================================
  // 5. log.forward (fire-and-forget)
  // 注意: Tauri bridge 中 forward 经 call(invoke) 返回 Promise (非 undefined),
  //       但语义仍为 fire-and-forget — 调用方无需 await, 消息会被写入。
  //       因此断言: 不抛同步异常 (callIpc 不返回 __error)。
  // =============================================================
  console.log('\n--- 5. log.forward ---')
  const fwdMarker = 'cdp-log-export-deep-' + Date.now()
  try {
    const r = await callIpc(`const ret = api.log.forward('info', ${JSON.stringify(fwdMarker + '-info')}); return { retType: typeof ret };`)
    record('log.forward info', !r?.__error, `retType=${r?.retType}`)
  } catch (err) { record('log.forward info', false, String(err.message || err)) }

  try {
    const r = await callIpc(`const ret = api.log.forward('warn', ${JSON.stringify(fwdMarker + '-warn')}); return { retType: typeof ret };`)
    record('log.forward warn', !r?.__error, `retType=${r?.retType}`)
  } catch (err) { record('log.forward warn', false, String(err.message || err)) }

  try {
    const r = await callIpc(`const ret = api.log.forward('error', ${JSON.stringify(fwdMarker + '-error')}); return { retType: typeof ret };`)
    record('log.forward error', !r?.__error, `retType=${r?.retType}`)
  } catch (err) { record('log.forward error', false, String(err.message || err)) }

  // 空消息
  try {
    const r = await callIpc(`const ret = api.log.forward('info', ''); return { retType: typeof ret };`)
    record('log.forward 空消息', !r?.__error, `retType=${r?.retType}`)
  } catch (err) { record('log.forward 空消息', false, String(err.message || err)) }

  // 超长消息 (>1000 字符)
  const longMsg = 'x'.repeat(1200)
  try {
    const r = await callIpc(`const ret = api.log.forward('info', ${JSON.stringify(longMsg)}); return { retType: typeof ret };`)
    record('log.forward 超长消息', !r?.__error, `msgLen=${longMsg.length} retType=${r?.retType}`)
  } catch (err) { record('log.forward 超长消息', false, String(err.message || err)) }

  // Unicode/emoji
  try {
    const r = await callIpc(`const ret = api.log.forward('info', ${JSON.stringify('测试emoji😀🎉 ' + fwdMarker)}); return { retType: typeof ret };`)
    record('log.forward Unicode/emoji', !r?.__error, `retType=${r?.retType}`)
  } catch (err) { record('log.forward Unicode/emoji', false, String(err.message || err)) }

  // 特殊字符
  try {
    const r = await callIpc(`const ret = api.log.forward('info', ${JSON.stringify('<script>alert(1)</script> & "quote" ' + fwdMarker)}); return { retType: typeof ret };`)
    record('log.forward 特殊字符', !r?.__error, `retType=${r?.retType}`)
  } catch (err) { record('log.forward 特殊字符', false, String(err.message || err)) }

  // fire-and-forget: 调用不抛异常且返回值无需 await
  try {
    const r = await callIpc(`const ret = api.log.forward('info', 'ret-check-${Date.now()}'); return { retType: typeof ret, isThenable: ret != null && typeof ret.then === 'function' };`)
    record('log.forward fire-and-forget', !r?.__error, `retType=${r?.retType} isThenable=${r?.isThenable}`)
  } catch (err) { record('log.forward fire-and-forget', false, String(err.message || err)) }

  // 验证 forward 后消息出现在 renderer 日志 (用 error 级别保证不被 level 过滤)
  const verifyMarker = 'cdp-verify-fwd-' + Date.now()
  try {
    await callIpc(`api.log.forward('error', ${JSON.stringify(verifyMarker)}); return { done: true };`)
    // 等待主进程异步写入
    await new Promise((res) => setTimeout(res, 600))
    const refreshed = await callIpc(`const res = await api.log.list(); return res;`)
    const rendererLogs = (Array.isArray(refreshed) ? refreshed : [])
      .filter((l) => l?.name?.startsWith('renderer-'))
      .sort((a, b) => b.name.localeCompare(a.name))
    const targetName = rendererLogs[0]?.name
    if (targetName) {
      const tail = await callIpc(`const res = await api.log.search(${JSON.stringify(targetName)}, ${JSON.stringify(verifyMarker)}, 200); return res;`)
      const found = typeof tail === 'string' && tail.includes(verifyMarker)
      record('log.forward 后出现在 read', found,
        `rendererLog=${targetName} found=${found} tailLen=${tail?.length ?? 0}`)
    } else {
      record('log.forward 后出现在 read', false, '未找到 renderer 日志文件')
    }
  } catch (err) { record('log.forward 后出现在 read', false, String(err.message || err)) }

  // =============================================================
  // 6. log.export
  // =============================================================
  console.log('\n--- 6. log.export ---')
  // 导出到临时路径
  if (firstLog) {
    try {
      const r = await callIpc(`const res = await api.log.export(${JSON.stringify(firstLog.name)}, ${JSON.stringify(tmpExportPath)}); return res;`)
      const bytes = typeof r === 'number' ? r : r?.bytes
      record('log.export 到临时路径', typeof bytes === 'number' && bytes > 0,
        `bytes=${bytes} dest=${tmpExportPath}`)
    } catch (err) { record('log.export 到临时路径', false, String(err.message || err)) }

    // 验证导出文件存在 (Node 侧检查)
    try {
      const exists = fs.existsSync(tmpExportPath)
      const stat = exists ? fs.statSync(tmpExportPath) : null
      const content = exists ? fs.readFileSync(tmpExportPath, 'utf-8') : ''
      record('log.export 文件已写入', exists && stat.size > 0,
        `exists=${exists} size=${stat?.size ?? 0} headLen=${content.length}`)
    } catch (err) { record('log.export 文件已写入', false, String(err.message || err)) }

    // 导出不存在文件 — exportLog 内部 catch 返回 0
    const tmpDest2 = path.join(os.tmpdir(), `eaa-cdp-export-none-${Date.now()}.log`)
    try {
      const r = await callIpc(`const res = await api.log.export('nonexistent-${Date.now()}.log', ${JSON.stringify(tmpDest2)}); return res;`)
      record('log.export 不存在文件', typeof r === 'number' && r === 0, `bytes=${r}`)
    } catch (err) { record('log.export 不存在文件', false, String(err.message || err)) }

    // 空文件名 — validateLogPath 抛错
    try {
      const r = await callIpc(`const res = await api.log.export('', ${JSON.stringify(tmpExportPath)}); return res;`)
      record('log.export 空文件名', r?.__error !== undefined, `err=${r?.__error ?? ''}`)
    } catch (err) { record('log.export 空文件名', false, String(err.message || err)) }

    // 无效导出路径 (.exe 扩展名) — validateExportPath 抛错
    const badDest = path.join(os.tmpdir(), `eaa-cdp-bad-${Date.now()}.exe`)
    try {
      const r = await callIpc(`const res = await api.log.export(${JSON.stringify(firstLog.name)}, ${JSON.stringify(badDest)}); return res;`)
      record('log.export 无效路径', r?.__error !== undefined, `err=${r?.__error ?? ''}`)
    } catch (err) { record('log.export 无效路径', false, String(err.message || err)) }
  } else {
    record('log.export', true, '无日志文件, 跳过')
  }

  // =============================================================
  // 7. log.exportWithDialog (不崩溃)
  // =============================================================
  console.log('\n--- 7. log.exportWithDialog ---')
  if (firstLog) {
    // 用 Promise.race 加 3s 超时, 避免原生对话框挂起测试
    try {
      const r = await callIpc(`
        const prom = Promise.resolve(api.log.exportWithDialog(${JSON.stringify(firstLog.name)}));
        const raced = await Promise.race([
          prom.then((v) => ({ ok: true, value: v })).catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) })),
          new Promise((res) => setTimeout(() => res({ ok: true, timeout: true }), 3000)),
        ]);
        return raced;
      `)
      const noCrash = r !== null && r !== undefined && (r.ok === true || r.ok === false || r.timeout === true)
      record('log.exportWithDialog 不崩溃', noCrash,
        `ok=${r?.ok} timeout=${r?.timeout} err=${r?.error ?? ''}`)
    } catch (err) { record('log.exportWithDialog 不崩溃', false, String(err.message || err)) }

    // 空文件名 — 应 reject
    try {
      const r = await callIpc(`const res = await api.log.exportWithDialog(''); return res;`)
      record('log.exportWithDialog 空文件名', r?.__error !== undefined, `err=${r?.__error ?? ''}`)
    } catch (err) { record('log.exportWithDialog 空文件名', false, String(err.message || err)) }
  } else {
    record('log.exportWithDialog', true, '无日志文件, 跳过')
  }

  // =============================================================
  // 8. log.clear — 非破坏性 (仅校验签名, 绝不调用)
  // =============================================================
  console.log('\n--- 8. log.clear (非破坏性) ---')
  try {
    const r = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        return typeof (api && api.log && api.log.clear);
      })()
    `)
    record('log.clear 是 function', r === 'function', `typeof=${r}`)
  } catch (err) { record('log.clear 是 function', false, String(err.message || err)) }

  // 参数数量校验: clear 期望 0 参数 (实际清空全部日志)
  try {
    const r = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        return api && api.log && api.log.clear.length;
      })()
    `)
    record('log.clear 期望 0 参数', typeof r === 'number' && r === 0, `length=${r}`)
  } catch (err) { record('log.clear 期望 0 参数', false, String(err.message || err)) }

  // =============================================================
  // 9. 并发操作
  // =============================================================
  console.log('\n--- 9. 并发操作 ---')
  if (firstLog) {
    // 并发读不同文件
    try {
      const r = await callIpc(`
        const results = await Promise.all([
          api.log.read(${JSON.stringify(firstLog.name)}, 20),
          api.log.read(${JSON.stringify(secondLog.name)}, 20),
        ]);
        return { types: results.map(x => typeof x), lens: results.map(x => x ? x.length : 0) };
      `)
      const ok = Array.isArray(r?.types) && r.types.every((t) => t === 'string')
      record('并发读不同文件', ok, `types=[${r?.types?.join(',')}] lens=[${r?.lens?.join(',')}]`)
    } catch (err) { record('并发读不同文件', false, String(err.message || err)) }

    // 并发搜索同一文件 (不同 query)
    try {
      const r = await callIpc(`
        const results = await Promise.all([
          api.log.search(${JSON.stringify(firstLog.name)}, 'INFO', 20),
          api.log.search(${JSON.stringify(firstLog.name)}, 'ERROR', 20),
          api.log.search(${JSON.stringify(firstLog.name)}, '', 10),
        ]);
        return { types: results.map(x => typeof x), lens: results.map(x => x ? x.length : 0) };
      `)
      const ok = Array.isArray(r?.types) && r.types.every((t) => t === 'string')
      record('并发搜索同一文件', ok, `types=[${r?.types?.join(',')}] lens=[${r?.lens?.join(',')}]`)
    } catch (err) { record('并发搜索同一文件', false, String(err.message || err)) }

    // 并发 read + search + filter 同一文件
    try {
      const r = await callIpc(`
        const results = await Promise.all([
          api.log.read(${JSON.stringify(firstLog.name)}, 30),
          api.log.search(${JSON.stringify(firstLog.name)}, ']', 20),
          api.log.filter(${JSON.stringify(firstLog.name)}, ['info'], 20),
        ]);
        return { types: results.map(x => typeof x) };
      `)
      const ok = Array.isArray(r?.types) && r.types.every((t) => t === 'string')
      record('并发 read+search+filter', ok, `types=[${r?.types?.join(',')}]`)
    } catch (err) { record('并发 read+search+filter', false, String(err.message || err)) }

    // 并发 forward (fire-and-forget, 不抛异常即可)
    try {
      const r = await callIpc(`
        const rets = [0,1,2,3].map((i) => api.log.forward('info', 'cdp-concurrent-fwd-' + i + '-' + Date.now()));
        return { count: rets.length, noThrow: rets.every(x => x !== undefined) };
      `)
      record('并发 forward', r?.count === 4, `count=${r?.count} noThrow=${r?.noThrow}`)
    } catch (err) { record('并发 forward', false, String(err.message || err)) }
  } else {
    record('并发操作', true, '无日志文件, 跳过')
  }

  // =============================================================
  // 10. 幂等性
  // =============================================================
  console.log('\n--- 10. 幂等性 ---')
  if (firstLog) {
    // 读同一文件两次, 结果一致
    try {
      const r1 = await callIpc(`const res = await api.log.read(${JSON.stringify(firstLog.name)}, 50); return res;`)
      const r2 = await callIpc(`const res = await api.log.read(${JSON.stringify(firstLog.name)}, 50); return res;`)
      record('幂等 read 两次', r1 === r2, `eq=${r1 === r2} len1=${r1?.length ?? 0} len2=${r2?.length ?? 0}`)
    } catch (err) { record('幂等 read 两次', false, String(err.message || err)) }

    // 搜索同一 query 两次, 结果一致
    try {
      const r1 = await callIpc(`const res = await api.log.search(${JSON.stringify(firstLog.name)}, 'INFO', 30); return res;`)
      const r2 = await callIpc(`const res = await api.log.search(${JSON.stringify(firstLog.name)}, 'INFO', 30); return res;`)
      record('幂等 search 两次', r1 === r2, `eq=${r1 === r2} len1=${r1?.length ?? 0} len2=${r2?.length ?? 0}`)
    } catch (err) { record('幂等 search 两次', false, String(err.message || err)) }
  } else {
    record('幂等性', true, '无日志文件, 跳过')
  }

  // 清理临时导出文件
  try { if (fs.existsSync(tmpExportPath)) fs.unlinkSync(tmpExportPath) } catch { /* ignore */ }

  // =============================================================
  // 汇总
  // =============================================================
  console.log('\n========== 日志系统 深度测试 ==========')
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
