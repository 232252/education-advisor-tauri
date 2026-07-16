// 试卷分析 IPC handler 测试
import http from 'node:http'
import WebSocket from 'ws'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const get = (u) => new Promise((r, j) => {
  http.get(u, (res) => {
    let d = ''
    res.on('data', (c) => (d += c))
    res.on('end', () => r(JSON.parse(d)))
  }).on('error', j)
})

const targets = (await get('http://127.0.0.1:9222/json')).filter((x) => x.type === 'page')
const target = targets[0]
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 1
const p = new Map()
ws.on('message', (r) => {
  const m = JSON.parse(r.toString())
  if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) }
})
const send = (method, params = {}) => new Promise((r) => {
  const i = id++; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params }))
})
const evalInPage = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) {
    const desc = r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'unknown'
    throw new Error(desc.substring(0, 500))
  }
  return r.result?.result?.value
}
await new Promise((r) => ws.on('open', r))

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

// 创建临时测试文件
const tmpDir = os.tmpdir()
const testPng = path.join(tmpDir, 'test-paper.png')
const testPdf = path.join(tmpDir, 'test-paper.pdf')
const testTxt = path.join(tmpDir, 'test-paper.txt')

await fsp.writeFile(testPng, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) // PNG header
await fsp.writeFile(testPdf, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D])) // %PDF-
await fsp.writeFile(testTxt, 'not an image')

// 测试 1: analyzePaper 存在于 API 中
try {
  const exists = await evalInPage(`typeof window.api.academic.analyzePaper === 'function'`)
  record('analyzePaper API 存在', exists)
} catch (e) { record('analyzePaper API 存在', false, e.message) }

// 测试 2: 有效 PNG 文件分析
try {
  const result = await evalInPage(`
    (async function() {
      const res = await window.api.academic.analyzePaper(${JSON.stringify(testPng)}, 'exam-123', 'chinese');
      return JSON.stringify(res);
    })()
  `)
  const parsed = JSON.parse(result)
  record('PNG 文件分析成功', parsed.success, `file=${parsed.data?.fileName} type=${parsed.data?.fileType}`)
} catch (e) { record('PNG 文件分析成功', false, e.message) }

// 测试 3: 有效 PDF 文件分析
try {
  const result = await evalInPage(`
    (async function() {
      const res = await window.api.academic.analyzePaper(${JSON.stringify(testPdf)});
      return JSON.stringify(res);
    })()
  `)
  const parsed = JSON.parse(result)
  record('PDF 文件分析成功', parsed.success, `file=${parsed.data?.fileName} type=${parsed.data?.fileType}`)
} catch (e) { record('PDF 文件分析成功', false, e.message) }

// 测试 4: 不支持的文件类型
try {
  const result = await evalInPage(`
    (async function() {
      const res = await window.api.academic.analyzePaper(${JSON.stringify(testTxt)});
      return JSON.stringify(res);
    })()
  `)
  const parsed = JSON.parse(result)
  record('不支持的文件类型返回错误', !parsed.success && parsed.error.includes('unsupported'), parsed.error)
} catch (e) { record('不支持的文件类型返回错误', false, e.message) }

// 测试 5: 不存在的文件
try {
  const result = await evalInPage(`
    (async function() {
      const res = await window.api.academic.analyzePaper('C:/nonexistent/file.png');
      return JSON.stringify(res);
    })()
  `)
  const parsed = JSON.parse(result)
  record('不存在的文件返回错误', !parsed.success && parsed.error.includes('cannot access'), parsed.error)
} catch (e) { record('不存在的文件返回错误', false, e.message) }

// 测试 6: 空路径
try {
  const result = await evalInPage(`
    (async function() {
      const res = await window.api.academic.analyzePaper('');
      return JSON.stringify(res);
    })()
  `)
  const parsed = JSON.parse(result)
  record('空路径返回错误', !parsed.success && parsed.error.includes('filePath'), parsed.error)
} catch (e) { record('空路径返回错误', false, e.message) }

// 测试 7: 返回结果包含必需字段
try {
  const result = await evalInPage(`
    (async function() {
      const res = await window.api.academic.analyzePaper(${JSON.stringify(testPng)}, 'exam-123', 'math');
      return JSON.stringify(res);
    })()
  `)
  const parsed = JSON.parse(result)
  const d = parsed.data
  const hasAllFields = d && d.filePath && d.fileName && d.fileType && d.examId === 'exam-123' && d.subjectId === 'math' && Array.isArray(d.questionScores) && d.analysis && d.analyzedAt
  record('返回结果包含必需字段', hasAllFields, `fields: filePath=${!!d?.filePath} fileName=${!!d?.fileName} examId=${d?.examId} subjectId=${d?.subjectId} questionScores=${Array.isArray(d?.questionScores)} analysis=${!!d?.analysis} analyzedAt=${!!d?.analyzedAt}`)
} catch (e) { record('返回结果包含必需字段', false, e.message) }

// 测试 8: 可选参数 (examId, subjectId 可省略)
try {
  const result = await evalInPage(`
    (async function() {
      const res = await window.api.academic.analyzePaper(${JSON.stringify(testPng)});
      return JSON.stringify(res);
    })()
  `)
  const parsed = JSON.parse(result)
  record('可选参数可省略', parsed.success && parsed.data.examId === null && parsed.data.subjectId === null, `examId=${parsed.data?.examId} subjectId=${parsed.data?.subjectId}`)
} catch (e) { record('可选参数可省略', false, e.message) }

// 清理
await fsp.unlink(testPng).catch(() => {})
await fsp.unlink(testPdf).catch(() => {})
await fsp.unlink(testTxt).catch(() => {})

// 总结
console.log('\n========== 试卷分析 IPC 测试 ==========')
const pass = results.filter(r => r.ok).length
console.log(`总计: ${results.length}, 通过: ${pass}, 失败: ${results.length - pass}`)
if (pass < results.length) {
  console.log('\n失败项:')
  results.filter(r => !r.ok).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`))
}

ws.close()
process.exit(pass === results.length ? 0 : 1)
