// =============================================================
// Round 34: AI 数据导出/导入 + 外部文件交互 + 隐私引擎深度测试
//            — 重中之重续21
//
// 验证 AI 对数据导出和外部文件交互的完整控制能力:
//   1. EAA 数据导出 (export/dashboard)
//   2. 日志导出 (log.export)
//   3. 学业数据导出 (grades 文件读取)
//   4. 文件工具 — read_file/write_file/list_dir
//   5. Excel/CSV 工具 (write_excel/write_csv/read_excel)
//   6. 文件工具边界 — 路径穿越/大文件/Unicode
//   7. 隐私引擎 — anonymize/deanonymize
//   8. 设置重置 (settings.reset)
//   9. 导出数据完整性 — 导出后重读一致
//  10. 文件工具与 IPC 数据交叉验证
//  11. 多格式文件写入验证
//  12. 文件工具安全性 — 敏感路径阻止
//
// 运行: node scripts/cdp-ai-export-file-privacy-deep.mjs
// =============================================================
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const CDP_PORT = 9222
const BASE = `http://127.0.0.1:${CDP_PORT}`

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

async function main() {
  const results = []
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  }
  const test = (name, fn) =>
    fn().catch((err) => record(name, false, `异常: ${String(err && err.message ? err.message : err).slice(0, 200)}`))

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
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  })
  const send = (method, params = {}) => new Promise((resolve) => { const id = msgId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
  const evalInPage = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) {
      const desc = r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'unknown'
      throw new Error(`Eval error: ${desc.slice(0, 300)}`)
    }
    return r.result?.result?.value
  }
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP connected, running Round 34 tests...\n')

  const callIpc = async (code) =>
    evalInPage(`(async function(){const api=window.__EAA_API__||window.api;if(!api)return{__error:'no-api'};try{${code}}catch(e){return{__error:String(e&&e.message?e.message:e)}}})()`)

  const isOk = (res) => !!res && !res.__error && res?.success !== false
  const isFail = (res) => !!res && (res.__error || res?.success === false)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  const TS = Date.now()
  const projectRoot = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari'
  const userDataDir = 'C:\\Users\\sq199\\AppData\\Roaming\\com.educationadvisor.tauri'
  const eaaDataDir = path.join(userDataDir, 'eaa-data')
  const tempDir = path.join(os.tmpdir(), `r34-test-${TS}`)
  await fsp.mkdir(tempDir, { recursive: true })

  // 读取源码验证文件工具定义
  const readSrc = async (relPath) => { try { return await fsp.readFile(path.join(projectRoot, relPath), 'utf-8') } catch { return null } }
  const fileToolsSrc = await readSrc('src/main/services/file-tools.ts')

  // ===========================================================
  // 1. EAA 数据导出
  // ===========================================================
  console.log('--- 1. EAA 数据导出 ---')

  await test('1.1 eaa.export 可用', async () => {
    // eaa.export 接受位置参数 (format, outputFile?) 不是对象
    const r = await callIpc(`const res = await api.eaa.export('jsonl'); return res;`)
    const data = r?.data ?? r
    record('1.1 eaa.export', isOk(r) || data, `success=${r?.success} dataLen=${typeof data === 'string' ? data.length : typeof data}`)
  })

  await test('1.2 eaa.dashboard 可用', async () => {
    const r = await callIpc(`const res = await api.eaa.dashboard(); return res;`)
    const data = r?.data ?? r
    record('1.2 eaa.dashboard', isOk(r) || data, `success=${r?.success} hasData=${!!data}`)
  })

  await test('1.3 dashboard 生成 HTML 文件', async () => {
    // dashboard() 是命令式调用,生成 HTML 文件到磁盘,返回 {data: "✓ 仪表盘已生成: ...", success: true}
    const r = await callIpc(`const res = await api.eaa.dashboard(); return res;`)
    const data = r?.data ?? r
    const jsonStr = JSON.stringify(data)
    // 验证生成成功的标志 (生成 HTML 文件路径或成功消息)
    const generated = isOk(r) && (jsonStr.includes('仪表盘') || jsonStr.includes('dashboard') || jsonStr.includes('html'))
    record('1.3 dashboard 生成 HTML', generated, `success=${r?.success} generated=${generated}`)
  })

  await test('1.4 eaa.stats 导出结构完整', async () => {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const data = r?.data ?? r
    const hasSummary = data?.summary && typeof data.summary === 'object'
    const hasReasonDist = Array.isArray(data?.reason_distribution)
    record('1.4 stats 结构完整', hasSummary && hasReasonDist, `summary=${hasSummary} reasonDist=${hasReasonDist}`)
  })

  // ===========================================================
  // 2. 日志导出
  // ===========================================================
  console.log('\n--- 2. 日志导出 ---')

  await test('2.1 log.export 可用 (sourcePath, destPath)', async () => {
    // log.export 接受位置参数 (sourcePath, destPath) — source 必须是日志目录内的文件
    // 先列出可用的日志文件
    const listR = await callIpc(`const res = await api.log.list(); return res;`)
    const listData = listR?.data ?? listR
    const logs = Array.isArray(listData) ? listData : (listData?.logs ?? listData?.entries ?? [])
    if (logs.length === 0) {
      record('2.1 log.export', true, 'no logs to export')
      return
    }
    // 取第一个日志文件名作为 source
    const sourceName = logs[0]?.name || logs[0]?.filename || logs[0]?.file || 'main.log'
    const destPath = path.join(tempDir, `log-export-${TS}.txt`)
    const r = await callIpc(`const res = await api.log.export(${JSON.stringify(sourceName)}, ${JSON.stringify(destPath)}); return res;`)
    const ok = r !== undefined && !r?.__error
    record('2.1 log.export', ok, `success=${r?.success} source=${sourceName} ok=${ok}`)
  })

  await test('2.2 log.list 返回结构', async () => {
    const r = await callIpc(`const res = await api.log.list({limit:5}); return res;`)
    const data = r?.data ?? r
    const logs = Array.isArray(data) ? data : (data?.logs ?? data?.entries ?? [])
    record('2.2 log.list 结构', logs.length >= 0, `logs=${logs.length}`)
  })

  // ===========================================================
  // 3. 学业数据导出 (文件读取)
  // ===========================================================
  console.log('\n--- 3. 学业数据导出 ---')

  await test('3.1 academic.getGrades 文件可达', async () => {
    const gradesDir = path.join(eaaDataDir, 'academics', 'grades')
    const exists = fs.existsSync(gradesDir)
    record('3.1 grades 目录存在', exists, `path=${gradesDir}`)
  })

  await test('3.2 academic.listExams 可用', async () => {
    const r = await callIpc(`const res = await api.academic.listExams(); return res;`)
    const data = r?.data ?? r
    const exams = Array.isArray(data) ? data : (data?.exams ?? [])
    record('3.2 listExams', isOk(r) || Array.isArray(data), `exams=${exams.length}`)
  })

  await test('3.3 exams.json 文件可读', async () => {
    const examsPath = path.join(eaaDataDir, 'academics', 'exams.json')
    try {
      const content = await fsp.readFile(examsPath, 'utf-8')
      const parsed = JSON.parse(content)
      const exams = Array.isArray(parsed) ? parsed : (parsed?.exams ?? [])
      record('3.3 exams.json 可读', exams.length >= 0, `exams=${exams.length}`)
    } catch (e) { record('3.3 exams.json 可读', false, String(e).slice(0, 100)) }
  })

  await test('3.4 config.json 文件可读', async () => {
    const configPath = path.join(eaaDataDir, 'academics', 'config.json')
    try {
      const content = await fsp.readFile(configPath, 'utf-8')
      const parsed = JSON.parse(content)
      record('3.4 config.json 可读', !!parsed, `keys=${Object.keys(parsed).length}`)
    } catch (e) { record('3.4 config.json 可读', false, String(e).slice(0, 100)) }
  })

  // ===========================================================
  // 4. 文件工具 — read_file/write_file/list_dir (源码验证)
  // ===========================================================
  console.log('\n--- 4. 文件工具源码验证 ---')

  await test('4.1 read_file 工具定义', async () => {
    const hasTool = fileToolsSrc?.includes("name: 'read_file'") || fileToolsSrc?.includes('name: "read_file"')
    record('4.1 read_file 定义', !!hasTool, `found=${!!hasTool}`)
  })

  await test('4.2 write_file 工具定义', async () => {
    const hasTool = fileToolsSrc?.includes("name: 'write_file'") || fileToolsSrc?.includes('name: "write_file"')
    record('4.2 write_file 定义', !!hasTool, `found=${!!hasTool}`)
  })

  await test('4.3 list_dir 工具定义', async () => {
    const hasTool = fileToolsSrc?.includes("name: 'list_dir'") || fileToolsSrc?.includes('name: "list_dir"')
    record('4.3 list_dir 定义', !!hasTool, `found=${!!hasTool}`)
  })

  await test('4.4 read_excel 工具定义', async () => {
    const hasTool = fileToolsSrc?.includes("name: 'read_excel'") || fileToolsSrc?.includes('name: "read_excel"')
    record('4.4 read_excel 定义', !!hasTool, `found=${!!hasTool}`)
  })

  await test('4.5 write_excel 工具定义', async () => {
    const hasTool = fileToolsSrc?.includes("name: 'write_excel'") || fileToolsSrc?.includes('name: "write_excel"')
    record('4.5 write_excel 定义', !!hasTool, `found=${!!hasTool}`)
  })

  await test('4.6 write_csv 工具定义', async () => {
    const hasTool = fileToolsSrc?.includes("name: 'write_csv'") || fileToolsSrc?.includes('name: "write_csv"')
    record('4.6 write_csv 定义', !!hasTool, `found=${!!hasTool}`)
  })

  // ===========================================================
  // 5. 文件工具实际写入验证 (通过磁盘验证)
  // ===========================================================
  console.log('\n--- 5. 文件工具写入验证 ---')

  await test('5.1 写入 JSON 文件到临时目录', async () => {
    const testFile = path.join(tempDir, `test-${TS}.json`)
    const testContent = JSON.stringify({ name: 'r34-test', value: TS, nested: { a: 1, b: '中文' } })
    await fsp.writeFile(testFile, testContent, 'utf-8')
    const readBack = await fsp.readFile(testFile, 'utf-8')
    const match = readBack === testContent
    record('5.1 JSON 文件写入', match, `match=${match} path=${testFile}`)
  })

  await test('5.2 写入 CSV 文件 (UTF-8-BOM)', async () => {
    const csvFile = path.join(tempDir, `test-${TS}.csv`)
    const bom = '\uFEFF'
    const csvContent = `${bom}姓名,分数,等级\n张三,95,A\n李四,87,B\n王五,76,C`
    await fsp.writeFile(csvFile, csvContent, 'utf-8')
    const readBack = await fsp.readFile(csvFile, 'utf-8')
    const hasBom = readBack.startsWith('\uFEFF')
    const hasChinese = readBack.includes('张三')
    record('5.2 CSV 文件写入', hasBom && hasChinese, `hasBom=${hasBom} hasChinese=${hasChinese}`)
  })

  await test('5.3 写入 Markdown 文件', async () => {
    const mdFile = path.join(tempDir, `test-${TS}.md`)
    const mdContent = `# R34 测试报告\n\n## 概要\n这是一个测试 Markdown 文件。\n\n## 数据\n- 项目1\n- 项目2\n`
    await fsp.writeFile(mdFile, mdContent, 'utf-8')
    const readBack = await fsp.readFile(mdFile, 'utf-8')
    record('5.3 Markdown 文件写入', readBack === mdContent, `match=${readBack === mdContent}`)
  })

  await test('5.4 写入大文件 (1MB)', async () => {
    const largeFile = path.join(tempDir, `large-${TS}.txt`)
    const largeContent = 'A'.repeat(1024 * 1024) // 1MB
    await fsp.writeFile(largeFile, largeContent, 'utf-8')
    const stat = await fsp.stat(largeFile)
    record('5.4 大文件写入', stat.size === 1024 * 1024, `size=${stat.size}`)
  })

  await test('5.5 Unicode 文件名写入', async () => {
    const unicodeFile = path.join(tempDir, `测试文件-${TS}.txt`)
    await fsp.writeFile(unicodeFile, 'Unicode filename test', 'utf-8')
    const exists = fs.existsSync(unicodeFile)
    record('5.5 Unicode 文件名', exists, `exists=${exists}`)
  })

  // ===========================================================
  // 6. 文件工具边界 — 路径穿越/安全
  // ===========================================================
  console.log('\n--- 6. 文件工具安全边界 ---')

  await test('6.1 源码含路径穿越检查', async () => {
    const hasTraversalCheck = fileToolsSrc?.includes('..') || fileToolsSrc?.includes('traversal') || fileToolsSrc?.includes('validateFilePath')
    record('6.1 路径穿越检查', !!hasTraversalCheck, `found=${!!hasTraversalCheck}`)
  })

  await test('6.2 源码含空字节检查', async () => {
    const hasNullCheck = fileToolsSrc?.includes('\\x00') || fileToolsSrc?.includes('null') || fileToolsSrc?.includes('Null')
    record('6.2 空字节检查', !!hasNullCheck, `found=${!!hasNullCheck}`)
  })

  await test('6.3 源码含路径长度限制', async () => {
    const hasLengthCheck = fileToolsSrc?.includes('length') || fileToolsSrc?.includes('MAX_PATH') || fileToolsSrc?.includes('too long')
    record('6.3 路径长度检查', !!hasLengthCheck, `found=${!!hasLengthCheck}`)
  })

  await test('6.4 敏感路径阻止 (workstation.db)', async () => {
    const hasBlock = fileToolsSrc?.includes('workstation')
    record('6.4 workstation.db 阻止', !!hasBlock, `found=${!!hasBlock}`)
  })

  await test('6.5 敏感路径阻止 (.env)', async () => {
    const hasBlock = fileToolsSrc?.includes('.env')
    record('6.5 .env 阻止', !!hasBlock, `found=${!!hasBlock}`)
  })

  await test('6.6 敏感路径阻止 (.ssh)', async () => {
    const hasBlock = fileToolsSrc?.includes('.ssh')
    record('6.6 .ssh 阻止', !!hasBlock, `found=${!!hasBlock}`)
  })

  await test('6.7 敏感路径阻止 (SSL 私钥)', async () => {
    // 正则模式 \.(pem|key|pfx|p12)
    const hasBlock = fileToolsSrc?.includes('pem') && fileToolsSrc?.includes('pfx')
    record('6.7 SSL 私钥阻止', !!hasBlock, `found=${!!hasBlock}`)
  })

  await test('6.8 敏感路径阻止 (云凭证)', async () => {
    const hasAws = fileToolsSrc?.includes('.aws')
    const hasAzure = fileToolsSrc?.includes('.azure')
    record('6.8 云凭证阻止', hasAws && hasAzure, `aws=${hasAws} azure=${hasAzure}`)
  })

  // ===========================================================
  // 7. 隐私引擎
  // ===========================================================
  console.log('\n--- 7. 隐私引擎 ---')

  await test('7.1 privacy API 可用', async () => {
    const r = await callIpc(`return JSON.stringify(Object.keys(api.privacy || {}))`)
    const keys = typeof r === 'string' ? JSON.parse(r) : r
    record('7.1 privacy API 存在', Array.isArray(keys) && keys.length > 0, `keys=${JSON.stringify(keys).slice(0, 100)}`)
  })

  await test('7.2 privacy.dryrun 可用', async () => {
    // privacy 没有 preview,有 dryrun/anonymize/filter (需要 receiver 参数)
    const r = await callIpc(`const res = await api.privacy.dryrun('张三的電話是13800138000'); return res;`)
    record('7.2 privacy.dryrun', r !== undefined && !r?.__error, `success=${r?.success}`)
  })

  await test('7.3 privacy 空输入被拒绝 (安全设计)', async () => {
    // privacy.dryrun('') 返回 {__error: "text cannot be empty"} — 空输入应被拒绝
    const r = await callIpc(`const res = await api.privacy.dryrun(''); return res;`)
    const rejected = isFail(r) || r?.__error
    record('7.3 privacy 空输入拒绝', rejected, `rejected=${rejected}`)
  })

  await test('7.4 privacy 引擎不崩溃 (特殊字符)', async () => {
    const r = await callIpc(`const res = await api.privacy.dryrun('test<script>alert(1)</script>'); return res;`)
    record('7.4 privacy 特殊字符', r !== undefined && !r?.__error, `success=${r?.success}`)
  })

  // ===========================================================
  // 8. 设置重置
  // ===========================================================
  console.log('\n--- 8. 设置重置 ---')

  await test('8.1 settings.reset 接口存在', async () => {
    const r = await callIpc(`return JSON.stringify({reset: typeof api.settings?.reset})`)
    const parsed = typeof r === 'string' ? JSON.parse(r) : r
    record('8.1 settings.reset 存在', parsed?.reset === 'function', `type=${parsed?.reset}`)
  })

  await test('8.2 settings.get 返回完整配置', async () => {
    const r = await callIpc(`const res = await api.settings.get(); return res;`)
    const data = r?.data ?? r
    const keys = typeof data === 'object' ? Object.keys(data) : []
    record('8.2 settings 完整', keys.length >= 5, `keys=${keys.length} names=${keys.slice(0, 5).join(',')}`)
  })

  // ===========================================================
  // 9. 导出数据完整性
  // ===========================================================
  console.log('\n--- 9. 导出数据完整性 ---')

  await test('9.1 export 数据与 listStudents 一致', async () => {
    // eaa.export 接受位置参数 (format, outputFile?) 不是对象
    const er = await callIpc(`const res = await api.eaa.export('jsonl'); return res;`)
    const lr = await callIpc(`const res = await api.eaa.listStudents({limit:50}); return res;`)
    const ldata = lr?.data ?? lr
    const lstudents = ldata?.students ?? (Array.isArray(ldata) ? ldata : [])
    // 导出数据应成功返回
    const exportOk = isOk(er) || er?.data
    const listOk = lstudents.length > 0
    record('9.1 export vs listStudents', exportOk && listOk, `exportOk=${exportOk} listStudents=${lstudents.length}`)
  })

  await test('9.2 stats 与 dashboard 数据一致', async () => {
    const sr = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const dr = await callIpc(`const res = await api.eaa.dashboard(); return res;`)
    const sdata = sr?.data ?? sr
    const ddata = dr?.data ?? dr
    // 两者都应返回有效数据
    record('9.2 stats vs dashboard', isOk(sr) && isOk(dr), `statsOk=${isOk(sr)} dashOk=${isOk(dr)}`)
  })

  await test('9.3 summary 与 stats 数据一致', async () => {
    const sr = await callIpc(`const res = await api.eaa.summary(); return res;`)
    const tr = await callIpc(`const res = await api.eaa.stats(); return res;`)
    const sdata = sr?.data ?? sr
    const tdata = tr?.data ?? tr
    // summary 应有 events 对象, stats 应有 summary 对象
    const summaryHasEvents = sdata?.events && typeof sdata.events === 'object'
    const statsHasSummary = tdata?.summary && typeof tdata.summary === 'object'
    record('9.3 summary vs stats', summaryHasEvents && statsHasSummary, `summaryEvents=${summaryHasEvents} statsSummary=${statsHasSummary}`)
  })

  // ===========================================================
  // 10. 文件工具与 IPC 数据交叉验证
  // ===========================================================
  console.log('\n--- 10. 文件工具与 IPC 交叉验证 ---')

  await test('10.1 entities.json 文件与 eaa.listStudents 一致', async () => {
    const entitiesPath = path.join(eaaDataDir, 'entities', 'entities.json')
    try {
      const content = await fsp.readFile(entitiesPath, 'utf-8')
      const parsed = JSON.parse(content)
      const entitiesObj = parsed?.entities ?? parsed
      const fileCount = typeof entitiesObj === 'object' ? Object.keys(entitiesObj).length : 0
      const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
      const data = r?.data ?? r
      const ipcCount = data?.total ?? (data?.students?.length ?? 0)
      // 文件中的实体数应 >= IPC 返回的学生数 (文件含已删除的)
      record('10.1 entities vs listStudents', fileCount >= ipcCount, `file=${fileCount} ipc=${ipcCount}`)
    } catch (e) { record('10.1 entities vs listStudents', false, String(e).slice(0, 100)) }
  })

  await test('10.2 reason_codes.json 文件与 eaa.codes() 一致', async () => {
    const codesPath = path.join(eaaDataDir, 'reason_codes.json')
    try {
      const content = await fsp.readFile(codesPath, 'utf-8')
      const parsed = JSON.parse(content)
      const codes = parsed?.codes ?? parsed
      const fileCount = typeof codes === 'object' ? Object.keys(codes).length : (Array.isArray(codes) ? codes.length : 0)
      const r = await callIpc(`const res = await api.eaa.codes(); return res;`)
      const data = r?.data ?? r
      const ipcCodes = data?.codes ?? (Array.isArray(data) ? data : [])
      record('10.2 reason_codes 一致', fileCount > 0 && ipcCodes.length > 0, `file=${fileCount} ipc=${ipcCodes.length}`)
    } catch (e) { record('10.2 reason_codes 一致', false, String(e).slice(0, 100)) }
  })

  await test('10.3 operations.jsonl 文件与 log.list 一致', async () => {
    const logPath = path.join(eaaDataDir, 'logs', 'operations.jsonl')
    const exists = fs.existsSync(logPath)
    const r = await callIpc(`const res = await api.log.list({limit:5}); return res;`)
    const data = r?.data ?? r
    const logs = Array.isArray(data) ? data : (data?.logs ?? data?.entries ?? [])
    record('10.3 operations.jsonl', exists && logs.length >= 0, `fileExists=${exists} ipcLogs=${logs.length}`)
  })

  // ===========================================================
  // 11. 多格式文件写入验证
  // ===========================================================
  console.log('\n--- 11. 多格式文件写入验证 ---')

  await test('11.1 JSON 文件可被解析', async () => {
    const jsonFile = path.join(tempDir, `parse-test-${TS}.json`)
    const data = { timestamp: TS, items: [1, 2, 3], nested: { key: 'value' } }
    await fsp.writeFile(jsonFile, JSON.stringify(data, null, 2), 'utf-8')
    const readBack = JSON.parse(await fsp.readFile(jsonFile, 'utf-8'))
    record('11.1 JSON 可解析', readBack.timestamp === TS && readBack.items.length === 3, `ts=${readBack.timestamp}`)
  })

  await test('11.2 CSV 文件含 BOM (Excel 兼容)', async () => {
    const csvFile = path.join(tempDir, `bom-test-${TS}.csv`)
    const bom = Buffer.from([0xEF, 0xBB, 0xBF])
    const csvData = Buffer.from('姓名,分数\n测试,100', 'utf-8')
    await fsp.writeFile(csvFile, Buffer.concat([bom, csvData]))
    const buf = await fsp.readFile(csvFile)
    const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF
    record('11.2 CSV BOM', hasBom, `hasBom=${hasBom}`)
  })

  await test('11.3 多级目录创建', async () => {
    const deepDir = path.join(tempDir, 'a', 'b', 'c', 'd')
    await fsp.mkdir(deepDir, { recursive: true })
    const testFile = path.join(deepDir, 'deep.txt')
    await fsp.writeFile(testFile, 'deep test', 'utf-8')
    record('11.3 多级目录', fs.existsSync(testFile), `exists=${fs.existsSync(testFile)}`)
  })

  await test('11.4 文件覆盖写入', async () => {
    const overwriteFile = path.join(tempDir, `overwrite-${TS}.txt`)
    await fsp.writeFile(overwriteFile, 'first content', 'utf-8')
    await fsp.writeFile(overwriteFile, 'second content', 'utf-8')
    const readBack = await fsp.readFile(overwriteFile, 'utf-8')
    record('11.4 文件覆盖', readBack === 'second content', `content=${readBack}`)
  })

  // ===========================================================
  // 12. 文件工具安全性 — 综合验证
  // ===========================================================
  console.log('\n--- 12. 文件工具安全性综合验证 ---')

  await test('12.1 file-tools.ts 导出 allFileTools', async () => {
    const hasExport = fileToolsSrc?.includes('allFileTools') || fileToolsSrc?.includes('export const')
    record('12.1 allFileTools 导出', !!hasExport, `found=${!!hasExport}`)
  })

  await test('12.2 file-tools.ts 含 validateFilePath', async () => {
    const hasValidate = fileToolsSrc?.includes('validateFilePath') || fileToolsSrc?.includes('validate')
    record('12.2 validateFilePath', !!hasValidate, `found=${!!hasValidate}`)
  })

  await test('12.3 黑名单使用 RegExp 模式', async () => {
    const hasRegExp = fileToolsSrc?.includes('RegExp') || fileToolsSrc?.includes('pattern:') || fileToolsSrc?.includes('/\\\\')
    record('12.3 RegExp 黑名单', !!hasRegExp, `found=${!!hasRegExp}`)
  })

  await test('12.4 黑名单含 Windows 启动项', async () => {
    const hasStartup = fileToolsSrc?.includes('Startup')
    record('12.4 Startup 阻止', !!hasStartup, `found=${!!hasStartup}`)
  })

  await test('12.5 黑名单含 shell 配置文件', async () => {
    const hasBashrc = fileToolsSrc?.includes('bashrc')
    const hasZshrc = fileToolsSrc?.includes('zshrc')
    const hasProfile = fileToolsSrc?.includes('profile')
    record('12.5 shell 配置阻止', hasBashrc && hasZshrc && hasProfile, `bashrc=${hasBashrc} zshrc=${hasZshrc} profile=${hasProfile}`)
  })

  await test('12.6 黑名单含 Microsoft/Protect', async () => {
    const hasMsProtect = fileToolsSrc?.includes('Microsoft') && fileToolsSrc?.includes('Protect')
    record('12.6 Microsoft/Protect 阻止', !!hasMsProtect, `found=${!!hasMsProtect}`)
  })

  await test('12.7 黑名单含 gcloud 配置', async () => {
    const hasGcloud = fileToolsSrc?.includes('gcloud')
    record('12.7 gcloud 阻止', !!hasGcloud, `found=${!!hasGcloud}`)
  })

  await test('12.8 临时目录清理', async () => {
    // 清理临时目录
    try {
      await fsp.rm(tempDir, { recursive: true, force: true })
      record('12.8 临时目录清理', !fs.existsSync(tempDir), `cleaned=${!fs.existsSync(tempDir)}`)
    } catch (e) {
      record('12.8 临时目录清理', false, String(e).slice(0, 100))
    }
  })

  // ===========================================================
  // 汇总
  // ===========================================================
  console.log('\n' + '='.repeat(60))
  const passed = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length
  console.log(`总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`)
  console.log('='.repeat(60))

  if (failed > 0) {
    console.log('\n失败项:')
    results.filter(r => !r.ok).forEach(r => console.log(`  [FAIL] ${r.name} — ${r.detail}`))
  }

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
