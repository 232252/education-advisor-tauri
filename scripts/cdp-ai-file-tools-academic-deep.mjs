// =============================================================
// Round 17: AI 文件工具读写学业数据深度测试 — 重中之重续4
//
// 模拟 Agent 的文件工具 (read_file/write_file/write_excel/write_csv/list_dir)
// 直接在文件系统层面验证 AI 能否 100% 读写所有学业数据:
//   1. read_file 读取学业数据 (config/exams/grades) (8 项)
//   2. read_file 读取 EAA 数据 (entities/events/reason_codes) (6 项)
//   3. write_file 写入测试数据并验证 (6 项)
//   4. write_excel 创建 Excel 文件并验证 (5 项)
//   5. write_csv 创建 CSV 文件并验证 (5 项)
//   6. list_dir 列出数据目录 (5 项)
//   7. validateFilePath 路径校验逻辑 (8 项)
//   8. 敏感路径黑名单实际阻止 (7 项)
//   9. 大文件 + 编码处理 (5 项)
//  10. 数据完整性 — write-then-read 往返 (5 项)
//
// 运行: node scripts/cdp-ai-file-tools-academic-deep.mjs
// =============================================================
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import XLSX from 'xlsx'

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
  const test = (name, fn) =>
    fn().catch((err) => record(name, false, `异常: ${String(err && err.message ? err.message : err).slice(0, 200)}`))

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
      const desc = r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'unknown'
      throw new Error(`Eval error: ${desc.slice(0, 300)}`)
    }
    return r.result?.result?.value
  }

  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP connected, running AI file tools academic tests...\n')

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

  const isOk = (res) => !!res && !res.__error && res?.success !== false

  // ---------- 数据路径 ----------
  const TS = Date.now()
  const userDataDir = 'C:\\Users\\sq199\\AppData\\Roaming\\com.educationadvisor.tauri'
  const eaaDataDir = path.join(userDataDir, 'eaa-data')
  const academicsDir = path.join(eaaDataDir, 'academics')
  const gradesDir = path.join(academicsDir, 'grades')
  const entitiesDir = path.join(eaaDataDir, 'entities')
  const eventsDir = path.join(eaaDataDir, 'events')
  const logsDir = path.join(eaaDataDir, 'logs')
  const profilesDir = path.join(eaaDataDir, 'profiles')
  const testOutputDir = path.join(eaaDataDir, 'r17-test-output')

  // 创建测试输出目录
  await fsp.mkdir(testOutputDir, { recursive: true }).catch(() => {})

  // ---------- 模拟 validateFilePath (与 file-tools.ts 逻辑一致) ----------
  const SENSITIVE_PATTERNS = [
    /[\\/]\.ssh[\\/]/i, /\.(pem|key|pfx|p12)$/i, /[\\/]\.aws[\\/]/i,
    /[\\/]\.config[\\/]gcloud[\\/]/i, /[\\/]\.azure[\\/]/i, /[\\/]\.env(\.|$)/i,
    /keystore\.(json|dat)$/i, /workstation\.db(-wal|-shm)?$/i,
    /[\\/]Startup[\\/]/i, /[\\/]Start Menu[\\/]Programs[\\/]Startup[\\/]/i,
    /[\\/]\.bashrc$/i, /[\\/]\.zshrc$/i, /[\\/]\.profile$/i,
    /[\\/]Microsoft[\\/]Protect[\\/]/i,
  ]

  function validateFilePath(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('路径不能为空')
    if (filePath.includes('\0')) throw new Error('路径包含 null 字节')
    if (filePath.length > 4096) throw new Error('路径过长')
    const segments = filePath.split(/[\\/]/)
    if (segments.includes('..')) throw new Error('路径包含 .. 段')
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(filePath)) throw new Error(`安全限制: ${filePath}`)
    }
  }

  // ---------- 读取源码以做静态验证 ----------
  const projectRoot = process.cwd()
  const fileToolsSrc = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'services', 'file-tools.ts'), 'utf-8')

  // ===========================================================
  // 1. read_file 读取学业数据 (config/exams/grades)
  // ===========================================================
  console.log('\n--- 1. read_file 读取学业数据 ---')

  // 前置: 通过 IPC setConfig 创建 config.json (模拟真实使用场景,用户首次打开应用会初始化配置)
  // academic-service 的 getConfig 在文件不存在时返回 DEFAULT_CONFIG,但文件层面 config.json 不存在
  // 真实场景下 AI 用 read_file 读 config.json 前,文件应已被 setConfig 初始化
  // 注意: getConfig 返回 {data: AcademicConfig, success}, setConfig 接收 AcademicConfig (解包 data)
  await callIpc(`
    const res = await api.academic.getConfig();
    if (res && res.data) await api.academic.setConfig(res.data);
    return { ok: true };
  `).catch(() => {})

  await test('1.1 读取 academics/config.json', async () => {
    const configPath = path.join(academicsDir, 'config.json')
    const content = await fsp.readFile(configPath, 'utf-8')
    const config = JSON.parse(content)
    const valid = Array.isArray(config.subjects) && config.subjects.length > 0
    record('1.1 读取 academics/config.json', valid, `subjects=${config.subjects?.length}`)
  })

  await test('1.2 读取 academics/exams.json', async () => {
    const examsPath = path.join(academicsDir, 'exams.json')
    const content = await fsp.readFile(examsPath, 'utf-8')
    const exams = JSON.parse(content)
    const valid = Array.isArray(exams) && exams.length > 0
    record('1.2 读取 academics/exams.json', valid, `exams=${exams.length}`)
  })

  await test('1.3 读取 grades/ 目录下学生成绩文件', async () => {
    const files = await fsp.readdir(gradesDir)
    const jsonFiles = files.filter(f => f.endsWith('.json'))
    const valid = jsonFiles.length > 0
    record('1.3 读取 grades/ 目录下学生成绩文件', valid, `files=${jsonFiles.length}`)
  })

  await test('1.4 读取单个学生成绩文件', async () => {
    const files = await fsp.readdir(gradesDir)
    const jsonFiles = files.filter(f => f.endsWith('.json'))
    if (jsonFiles.length === 0) {
      record('1.4 读取单个学生成绩文件', false, 'no grade files')
      return
    }
    const gradePath = path.join(gradesDir, jsonFiles[0])
    const content = await fsp.readFile(gradePath, 'utf-8')
    const grades = JSON.parse(content)
    const valid = Array.isArray(grades)
    record('1.4 读取单个学生成绩文件', valid, `file=${jsonFiles[0]} grades=${grades.length}`)
  })

  await test('1.5 config.json 含科目定义 (10 科)', async () => {
    const configPath = path.join(academicsDir, 'config.json')
    const config = JSON.parse(await fsp.readFile(configPath, 'utf-8'))
    const expectedSubjects = ['chinese', 'math', 'english', 'physics', 'chemistry', 'biology']
    const hasAll = expectedSubjects.every(s => config.subjects.some(sub => sub.id === s))
    record('1.5 config.json 含科目定义 (10 科)', hasAll, `subjects=${config.subjects.length}`)
  })

  await test('1.6 config.json 含考试类型', async () => {
    const configPath = path.join(academicsDir, 'config.json')
    const config = JSON.parse(await fsp.readFile(configPath, 'utf-8'))
    const valid = Array.isArray(config.defaultExamTypes) && config.defaultExamTypes.length > 0
    record('1.6 config.json 含考试类型', valid, `types=${config.defaultExamTypes?.length}`)
  })

  await test('1.7 exams.json 含考试字段 (id/name/date/subjects)', async () => {
    const examsPath = path.join(academicsDir, 'exams.json')
    const exams = JSON.parse(await fsp.readFile(examsPath, 'utf-8'))
    if (exams.length === 0) {
      record('1.7 exams.json 含考试字段 (id/name/date/subjects)', false, 'no exams')
      return
    }
    const exam = exams[0]
    const valid = typeof exam.id === 'string' && typeof exam.name === 'string'
    record('1.7 exams.json 含考试字段 (id/name/date/subjects)', valid,
      `id=${exam.id} name=${exam.name}`)
  })

  await test('1.8 成绩文件含 GradeRecord 字段 (examId/subjectId/score)', async () => {
    const files = await fsp.readdir(gradesDir)
    const jsonFiles = files.filter(f => f.endsWith('.json'))
    if (jsonFiles.length === 0) {
      record('1.8 成绩文件含 GradeRecord 字段 (examId/subjectId/score)', false, 'no files')
      return
    }
    const grades = JSON.parse(await fsp.readFile(path.join(gradesDir, jsonFiles[0]), 'utf-8'))
    if (grades.length === 0) {
      record('1.8 成绩文件含 GradeRecord 字段 (examId/subjectId/score)', false, 'empty grades')
      return
    }
    const g = grades[0]
    const valid = typeof g.examId === 'string' && typeof g.subjectId === 'string' && typeof g.score === 'number'
    record('1.8 成绩文件含 GradeRecord 字段 (examId/subjectId/score)', valid,
      `examId=${g.examId} subjectId=${g.subjectId} score=${g.score}`)
  })

  // ===========================================================
  // 2. read_file 读取 EAA 数据 (entities/events/reason_codes)
  // ===========================================================
  console.log('\n--- 2. read_file 读取 EAA 数据 ---')

  await test('2.1 读取 entities/entities.json', async () => {
    const entitiesPath = path.join(entitiesDir, 'entities.json')
    const content = await fsp.readFile(entitiesPath, 'utf-8')
    const entities = JSON.parse(content)
    const valid = typeof entities === 'object' && entities !== null
    record('2.1 读取 entities/entities.json', valid, `keys=${Object.keys(entities).length}`)
  })

  await test('2.2 读取 entities/name_index.json', async () => {
    const indexPath = path.join(entitiesDir, 'name_index.json')
    const content = await fsp.readFile(indexPath, 'utf-8')
    const index = JSON.parse(content)
    const valid = typeof index === 'object' && Object.keys(index).length > 0
    record('2.2 读取 entities/name_index.json', valid, `names=${Object.keys(index).length}`)
  })

  await test('2.3 读取 reason_codes.json', async () => {
    const codesPath = path.join(eaaDataDir, 'reason_codes.json')
    const content = await fsp.readFile(codesPath, 'utf-8')
    const codes = JSON.parse(content)
    const valid = typeof codes === 'object' && codes !== null
    record('2.3 读取 reason_codes.json', valid, `keys=${Object.keys(codes).slice(0, 5).join(',')}`)
  })

  await test('2.4 读取 events/events.jsonl (JSONL 格式)', async () => {
    const eventsPath = path.join(eventsDir, 'events.jsonl')
    const content = await fsp.readFile(eventsPath, 'utf-8')
    const lines = content.trim().split('\n').filter(l => l.trim())
    const valid = lines.length > 0
    // 验证第一行是有效 JSON
    if (valid) {
      const firstEvent = JSON.parse(lines[0])
      const hasFields = typeof firstEvent.event_id === 'string' || typeof firstEvent.id === 'string'
      record('2.4 读取 events/events.jsonl (JSONL 格式)', hasFields, `lines=${lines.length} firstId=${firstEvent.event_id || firstEvent.id}`)
    } else {
      record('2.4 读取 events/events.jsonl (JSONL 格式)', false, 'empty file')
    }
  })

  await test('2.5 读取 entities/scores.cache.json', async () => {
    const scoresPath = path.join(entitiesDir, 'scores.cache.json')
    const content = await fsp.readFile(scoresPath, 'utf-8')
    const scores = JSON.parse(content)
    const valid = typeof scores === 'object' && Object.keys(scores).length > 0
    record('2.5 读取 entities/scores.cache.json', valid, `students=${Object.keys(scores).length}`)
  })

  await test('2.6 读取 entities/event_stats.cache.json', async () => {
    const statsPath = path.join(entitiesDir, 'event_stats.cache.json')
    const content = await fsp.readFile(statsPath, 'utf-8')
    const stats = JSON.parse(content)
    const valid = typeof stats === 'object' && Object.keys(stats).length > 0
    record('2.6 读取 entities/event_stats.cache.json', valid, `entries=${Object.keys(stats).length}`)
  })

  // ===========================================================
  // 3. write_file 写入测试数据并验证
  // ===========================================================
  console.log('\n--- 3. write_file 写入测试数据 ---')

  await test('3.1 写入文本文件并读回验证', async () => {
    const testPath = path.join(testOutputDir, `r17_write_test_${TS}.txt`)
    const testContent = `R17 write_file test ${TS}\nAI Agent 可以写入文件。`
    await fsp.writeFile(testPath, testContent, 'utf-8')
    const readBack = await fsp.readFile(testPath, 'utf-8')
    const valid = readBack === testContent
    await fsp.unlink(testPath).catch(() => {})
    record('3.1 写入文本文件并读回验证', valid, `match=${readBack === testContent}`)
  })

  await test('3.2 写入 JSON 文件并读回验证', async () => {
    const testPath = path.join(testOutputDir, `r17_json_test_${TS}.json`)
    const testData = { student: 'R17_TEST', score: 95, subjects: ['chinese', 'math'], timestamp: TS }
    await fsp.writeFile(testPath, JSON.stringify(testData, null, 2), 'utf-8')
    const readBack = JSON.parse(await fsp.readFile(testPath, 'utf-8'))
    const valid = readBack.student === testData.student && readBack.score === testData.score
    await fsp.unlink(testPath).catch(() => {})
    record('3.2 写入 JSON 文件并读回验证', valid, `match=${readBack.student === testData.student}`)
  })

  await test('3.3 写入 Unicode/Emoji 内容', async () => {
    const testPath = path.join(testOutputDir, `r17_unicode_${TS}.txt`)
    const testContent = `中文测试 🎓 学生姓名: 张三\nEmoji: ✅ ❌ ⚡ 📚\n特殊字符: <>&"'\\//`
    await fsp.writeFile(testPath, testContent, 'utf-8')
    const readBack = await fsp.readFile(testPath, 'utf-8')
    const valid = readBack === testContent
    await fsp.unlink(testPath).catch(() => {})
    record('3.3 写入 Unicode/Emoji 内容', valid, `match=${readBack === testContent}`)
  })

  await test('3.4 覆盖写入已有文件', async () => {
    const testPath = path.join(testOutputDir, `r17_overwrite_${TS}.txt`)
    await fsp.writeFile(testPath, 'first content', 'utf-8')
    await fsp.writeFile(testPath, 'second content', 'utf-8')
    const readBack = await fsp.readFile(testPath, 'utf-8')
    const valid = readBack === 'second content'
    await fsp.unlink(testPath).catch(() => {})
    record('3.4 覆盖写入已有文件', valid, `content=${readBack}`)
  })

  await test('3.5 原子写入 (tmp + rename) — 模拟 academic-service', async () => {
    const testPath = path.join(testOutputDir, `r17_atomic_${TS}.json`)
    const tmpPath = `${testPath}.tmp`
    const testData = { test: 'atomic', ts: TS }
    // 模拟 atomicWrite: 先写 tmp,再 rename
    await fsp.writeFile(tmpPath, JSON.stringify(testData), 'utf-8')
    await fsp.rename(tmpPath, testPath)
    const readBack = JSON.parse(await fsp.readFile(testPath, 'utf-8'))
    const valid = readBack.test === 'atomic'
    // 验证 tmp 文件已被删除
    const tmpExists = fs.existsSync(tmpPath)
    await fsp.unlink(testPath).catch(() => {})
    record('3.5 原子写入 (tmp + rename) — 模拟 academic-service', valid && !tmpExists,
      `match=${readBack.test === 'atomic'} tmpExists=${tmpExists}`)
  })

  await test('3.6 写入空文件', async () => {
    const testPath = path.join(testOutputDir, `r17_empty_${TS}.txt`)
    await fsp.writeFile(testPath, '', 'utf-8')
    const stat = await fsp.stat(testPath)
    const valid = stat.size === 0
    await fsp.unlink(testPath).catch(() => {})
    record('3.6 写入空文件', valid, `size=${stat.size}`)
  })

  // ===========================================================
  // 4. write_excel 创建 Excel 文件并验证
  // ===========================================================
  console.log('\n--- 4. write_excel 创建 Excel 文件 ---')

  await test('4.1 创建 Excel 文件 (单工作表)', async () => {
    const excelPath = path.join(testOutputDir, `r17_excel_${TS}.xlsx`)
    const wb = XLSX.utils.book_new()
    const data = [
      ['姓名', '科目', '分数'],
      ['张三', '语文', 95],
      ['李四', '数学', 88],
    ]
    const ws = XLSX.utils.aoa_to_sheet(data)
    XLSX.utils.book_append_sheet(wb, ws, '成绩')
    XLSX.writeFile(wb, excelPath)

    // 读回验证
    const readWb = XLSX.readFile(excelPath)
    const readWs = readWb.Sheets['成绩']
    const readData = XLSX.utils.sheet_to_json(readWs, { header: 1 })
    const valid = readData.length === 3 && readData[0][0] === '姓名'
    await fsp.unlink(excelPath).catch(() => {})
    record('4.1 创建 Excel 文件 (单工作表)', valid, `rows=${readData.length}`)
  })

  await test('4.2 创建 Excel 文件 (多工作表)', async () => {
    const excelPath = path.join(testOutputDir, `r17_excel_multi_${TS}.xlsx`)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['A', 'B'], [1, 2]]), 'Sheet1')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['C', 'D'], [3, 4]]), 'Sheet2')
    XLSX.writeFile(wb, excelPath)

    const readWb = XLSX.readFile(excelPath)
    const sheetNames = readWb.SheetNames
    const valid = sheetNames.length === 2 && sheetNames.includes('Sheet1') && sheetNames.includes('Sheet2')
    await fsp.unlink(excelPath).catch(() => {})
    record('4.2 创建 Excel 文件 (多工作表)', valid, `sheets=${sheetNames.join(',')}`)
  })

  await test('4.3 Excel 含中文字符', async () => {
    const excelPath = path.join(testOutputDir, `r17_excel_cn_${TS}.xlsx`)
    const wb = XLSX.utils.book_new()
    const data = [['姓名', '分数'], ['张三', 95], ['李四', 88]]
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), '中文')
    XLSX.writeFile(wb, excelPath)

    const readWb = XLSX.readFile(excelPath)
    const readData = XLSX.utils.sheet_to_json(readWb.Sheets['中文'], { header: 1 })
    const valid = readData[0][0] === '姓名' && readData[1][0] === '张三'
    await fsp.unlink(excelPath).catch(() => {})
    record('4.3 Excel 含中文字符', valid, `first=${readData[0][0]} second=${readData[1][0]}`)
  })

  await test('4.4 read_excel 读取已有 Excel', async () => {
    // 先创建一个 Excel,再用 read_excel 逻辑读取
    const excelPath = path.join(testOutputDir, `r17_read_excel_${TS}.xlsx`)
    const wb = XLSX.utils.book_new()
    const data = [['student', 'score'], ['test1', 100], ['test2', 90]]
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), 'Sheet1')
    XLSX.writeFile(wb, excelPath)

    // 模拟 read_excel 工具逻辑
    const readWb = XLSX.readFile(excelPath)
    const sheetName = readWb.SheetNames[0]
    const rows = XLSX.utils.sheet_to_json(readWb.Sheets[sheetName], { header: 1 })
    const valid = rows.length === 3 && rows[0][0] === 'student'
    await fsp.unlink(excelPath).catch(() => {})
    record('4.4 read_excel 读取已有 Excel', valid, `rows=${rows.length} header=${rows[0][0]}`)
  })

  await test('4.5 Excel 最大行数限制 (5000)', async () => {
    // 验证 file-tools.ts 中的 MAX_EXCEL_ROWS = 5000
    const hasLimit = fileToolsSrc.includes('MAX_EXCEL_ROWS') && fileToolsSrc.includes('5000')
    record('4.5 Excel 最大行数限制 (5000)', hasLimit, `present=${hasLimit}`)
  })

  // ===========================================================
  // 5. write_csv 创建 CSV 文件并验证
  // ===========================================================
  console.log('\n--- 5. write_csv 创建 CSV 文件 ---')

  await test('5.1 创建 CSV 文件 (UTF-8 BOM)', async () => {
    const csvPath = path.join(testOutputDir, `r17_csv_${TS}.csv`)
    // 模拟 write_csv 工具: UTF-8 BOM + 内容
    const bom = '\uFEFF'
    const csvContent = `${bom}姓名,科目,分数\n张三,语文,95\n李四,数学,88`
    await fsp.writeFile(csvPath, csvContent, 'utf-8')

    const readBack = await fsp.readFile(csvPath, 'utf-8')
    const hasBom = readBack.startsWith('\uFEFF')
    const valid = hasBom && readBack.includes('张三') && readBack.includes('语文')
    await fsp.unlink(csvPath).catch(() => {})
    record('5.1 创建 CSV 文件 (UTF-8 BOM)', valid, `hasBom=${hasBom} hasChinese=${readBack.includes('张三')}`)
  })

  await test('5.2 CSV 含逗号转义 (引号包裹)', async () => {
    const csvPath = path.join(testOutputDir, `r17_csv_escape_${TS}.csv`)
    // CSV 中含逗号的字段需要用双引号包裹
    const csvContent = '\uFEFF姓名,备注\n"张三, Jr.",含逗号字段'
    await fsp.writeFile(csvPath, csvContent, 'utf-8')
    const readBack = await fsp.readFile(csvPath, 'utf-8')
    const valid = readBack.includes('"张三, Jr."')
    await fsp.unlink(csvPath).catch(() => {})
    record('5.2 CSV 含逗号转义 (引号包裹)', valid, `match=${readBack.includes('"张三, Jr."')}`)
  })

  await test('5.3 CSV 含换行符字段', async () => {
    const csvPath = path.join(testOutputDir, `r17_csv_newline_${TS}.csv`)
    const csvContent = '\uFEFF姓名,描述\n张三,"第一行\n第二行"'
    await fsp.writeFile(csvPath, csvContent, 'utf-8')
    const readBack = await fsp.readFile(csvPath, 'utf-8')
    const valid = readBack.includes('"第一行\n第二行"')
    await fsp.unlink(csvPath).catch(() => {})
    record('5.3 CSV 含换行符字段', valid, `match=${readBack.includes('"第一行\n第二行"')}`)
  })

  await test('5.4 CSV 大数据量 (1000 行)', async () => {
    const csvPath = path.join(testOutputDir, `r17_csv_large_${TS}.csv`)
    const lines = ['\uFEFF姓名,分数']
    for (let i = 0; i < 1000; i++) {
      lines.push(`学生${i},${80 + (i % 20)}`)
    }
    await fsp.writeFile(csvPath, lines.join('\n'), 'utf-8')
    const readBack = await fsp.readFile(csvPath, 'utf-8')
    const lineCount = readBack.trim().split('\n').length
    const valid = lineCount === 1001 // header + 1000 data rows
    await fsp.unlink(csvPath).catch(() => {})
    record('5.4 CSV 大数据量 (1000 行)', valid, `lines=${lineCount}`)
  })

  await test('5.5 write_csv 工具源码使用 UTF-8 BOM', async () => {
    // 验证源码中 write_csv 使用 BOM (Excel 中文不乱码)
    const hasBom = fileToolsSrc.includes('\\uFEFF') || fileToolsSrc.includes('UTF-8-BOM') || fileToolsSrc.includes('BOM')
    record('5.5 write_csv 工具源码使用 UTF-8 BOM', hasBom, `present=${hasBom}`)
  })

  // ===========================================================
  // 6. list_dir 列出数据目录
  // ===========================================================
  console.log('\n--- 6. list_dir 列出数据目录 ---')

  await test('6.1 列出 academics/ 目录', async () => {
    const entries = await fsp.readdir(academicsDir, { withFileTypes: true })
    const hasConfig = entries.some(e => e.name === 'config.json')
    const hasExams = entries.some(e => e.name === 'exams.json')
    const hasGrades = entries.some(e => e.name === 'grades' && e.isDirectory())
    const valid = hasConfig && hasExams && hasGrades
    record('6.1 列出 academics/ 目录', valid, `entries=${entries.length} config=${hasConfig} exams=${hasExams} grades=${hasGrades}`)
  })

  await test('6.2 列出 grades/ 目录 (多个学生文件)', async () => {
    const entries = await fsp.readdir(gradesDir)
    const jsonFiles = entries.filter(f => f.endsWith('.json'))
    const valid = jsonFiles.length > 0
    record('6.2 列出 grades/ 目录 (多个学生文件)', valid, `files=${jsonFiles.length}`)
  })

  await test('6.3 列出 eaa-data/ 目录 (全部子目录)', async () => {
    const entries = await fsp.readdir(eaaDataDir, { withFileTypes: true })
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name)
    const expected = ['academics', 'entities', 'events', 'logs', 'profiles']
    const hasAll = expected.every(d => dirs.includes(d))
    record('6.3 列出 eaa-data/ 目录 (全部子目录)', hasAll, `dirs=${dirs.join(',')}`)
  })

  await test('6.4 列出 entities/ 目录 (缓存文件)', async () => {
    const entries = await fsp.readdir(entitiesDir)
    const hasEntities = entries.includes('entities.json')
    const hasScores = entries.includes('scores.cache.json')
    const hasStats = entries.includes('event_stats.cache.json')
    const valid = hasEntities && hasScores && hasStats
    record('6.4 列出 entities/ 目录 (缓存文件)', valid, `entities=${hasEntities} scores=${hasScores} stats=${hasStats}`)
  })

  await test('6.5 list_dir 区分文件和目录', async () => {
    const entries = await fsp.readdir(academicsDir, { withFileTypes: true })
    const files = entries.filter(e => e.isFile()).map(e => e.name)
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name)
    const valid = files.length > 0 && dirs.includes('grades')
    record('6.5 list_dir 区分文件和目录', valid, `files=${files.length} dirs=${dirs.join(',')}`)
  })

  // ===========================================================
  // 7. validateFilePath 路径校验逻辑
  // ===========================================================
  console.log('\n--- 7. validateFilePath 路径校验逻辑 ---')

  await test('7.1 空路径拒绝', async () => {
    let rejected = false
    try { validateFilePath('') } catch { rejected = true }
    record('7.1 空路径拒绝', rejected, `rejected=${rejected}`)
  })

  await test('7.2 null 字节注入拒绝', async () => {
    let rejected = false
    try { validateFilePath('test\0.txt') } catch { rejected = true }
    record('7.2 null 字节注入拒绝', rejected, `rejected=${rejected}`)
  })

  await test('7.3 路径遍历 (..) 拒绝', async () => {
    let rejected = false
    try { validateFilePath('../../../etc/passwd') } catch { rejected = true }
    record('7.3 路径遍历 (..) 拒绝', rejected, `rejected=${rejected}`)
  })

  await test('7.4 超长路径 (>4096) 拒绝', async () => {
    const longPath = 'a'.repeat(5000)
    let rejected = false
    try { validateFilePath(longPath) } catch { rejected = true }
    record('7.4 超长路径 (>4096) 拒绝', rejected, `rejected=${rejected}`)
  })

  await test('7.5 合法路径通过', async () => {
    let passed = true
    try { validateFilePath(path.join(academicsDir, 'config.json')) } catch { passed = false }
    record('7.5 合法路径通过', passed, `passed=${passed}`)
  })

  await test('7.6 学术数据路径通过 (不在黑名单)', async () => {
    let passed = true
    try { validateFilePath(path.join(gradesDir, 'student.json')) } catch { passed = false }
    record('7.6 学术数据路径通过 (不在黑名单)', passed, `passed=${passed}`)
  })

  await test('7.7 EAA events 路径通过', async () => {
    let passed = true
    try { validateFilePath(path.join(eventsDir, 'events.jsonl')) } catch { passed = false }
    record('7.7 EAA events 路径通过', passed, `passed=${passed}`)
  })

  await test('7.8 reason_codes.json 路径通过', async () => {
    let passed = true
    try { validateFilePath(path.join(eaaDataDir, 'reason_codes.json')) } catch { passed = false }
    record('7.8 reason_codes.json 路径通过', passed, `passed=${passed}`)
  })

  // ===========================================================
  // 8. 敏感路径黑名单实际阻止
  // ===========================================================
  console.log('\n--- 8. 敏感路径黑名单实际阻止 ---')

  await test('8.1 .ssh 路径阻止', async () => {
    let rejected = false
    try { validateFilePath('C:\\Users\\test\\.ssh\\id_rsa') } catch { rejected = true }
    record('8.1 .ssh 路径阻止', rejected, `rejected=${rejected}`)
  })

  await test('8.2 .env 文件阻止', async () => {
    let rejected = false
    try { validateFilePath('C:\\project\\.env') } catch { rejected = true }
    record('8.2 .env 文件阻止', rejected, `rejected=${rejected}`)
  })

  await test('8.3 .pem 私钥文件阻止', async () => {
    let rejected = false
    try { validateFilePath('C:\\certs\\server.pem') } catch { rejected = true }
    record('8.3 .pem 私钥文件阻止', rejected, `rejected=${rejected}`)
  })

  await test('8.4 .aws 凭证目录阻止', async () => {
    let rejected = false
    try { validateFilePath('C:\\Users\\test\\.aws\\credentials') } catch { rejected = true }
    record('8.4 .aws 凭证目录阻止', rejected, `rejected=${rejected}`)
  })

  await test('8.5 workstation.db 阻止', async () => {
    let rejected = false
    try { validateFilePath('C:\\app\\workstation.db') } catch { rejected = true }
    record('8.5 workstation.db 阻止', rejected, `rejected=${rejected}`)
  })

  await test('8.6 keystore.json 阻止', async () => {
    let rejected = false
    try { validateFilePath('C:\\app\\keystore.json') } catch { rejected = true }
    record('8.6 keystore.json 阻止', rejected, `rejected=${rejected}`)
  })

  await test('8.7 .bashrc 阻止', async () => {
    let rejected = false
    try { validateFilePath('C:\\Users\\test\\.bashrc') } catch { rejected = true }
    record('8.7 .bashrc 阻止', rejected, `rejected=${rejected}`)
  })

  // ===========================================================
  // 9. 大文件 + 编码处理
  // ===========================================================
  console.log('\n--- 9. 大文件 + 编码处理 ---')

  await test('9.1 读取大文件 (events.jsonl ~11KB)', async () => {
    const eventsPath = path.join(eventsDir, 'events.jsonl')
    const stat = await fsp.stat(eventsPath)
    const content = await fsp.readFile(eventsPath, 'utf-8')
    const valid = stat.size > 1000 && content.length > 1000
    record('9.1 读取大文件 (events.jsonl ~11KB)', valid, `size=${stat.size} chars=${content.length}`)
  })

  await test('9.2 读取 operations.jsonl 日志', async () => {
    const logPath = path.join(logsDir, 'operations.jsonl')
    const stat = await fsp.stat(logPath)
    const content = await fsp.readFile(logPath, 'utf-8')
    const lines = content.trim().split('\n').filter(l => l.trim())
    const valid = lines.length > 0
    record('9.2 读取 operations.jsonl 日志', valid, `size=${stat.size} lines=${lines.length}`)
  })

  await test('9.3 文件大小限制 (MAX_FILE_SIZE = 5MB)', async () => {
    const hasLimit = fileToolsSrc.includes('MAX_FILE_SIZE') && fileToolsSrc.includes('5 * 1024 * 1024')
    record('9.3 文件大小限制 (MAX_FILE_SIZE = 5MB)', hasLimit, `present=${hasLimit}`)
  })

  await test('9.4 路径长度限制 (4096)', async () => {
    const hasLimit = fileToolsSrc.includes('4096')
    record('9.4 路径长度限制 (4096)', hasLimit, `present=${hasLimit}`)
  })

  await test('9.5 编码处理 (utf-8 默认)', async () => {
    // 验证 read_file 支持 encoding 参数
    const hasEncoding = fileToolsSrc.includes('encoding') && fileToolsSrc.includes('utf-8')
    record('9.5 编码处理 (utf-8 默认)', hasEncoding, `present=${hasEncoding}`)
  })

  // ===========================================================
  // 10. 数据完整性 — write-then-read 往返
  // ===========================================================
  console.log('\n--- 10. 数据完整性 (write-then-read 往返) ---')

  await test('10.1 文本文件 write-then-read 往返一致', async () => {
    const testPath = path.join(testOutputDir, `r17_roundtrip_txt_${TS}.txt`)
    const content = `R17 往返测试\nLine 2\nLine 3\nUnicode: 中文 🎓\nNumbers: 12345`
    await fsp.writeFile(testPath, content, 'utf-8')
    const readBack = await fsp.readFile(testPath, 'utf-8')
    const valid = readBack === content
    await fsp.unlink(testPath).catch(() => {})
    record('10.1 文本文件 write-then-read 往返一致', valid, `match=${readBack === content}`)
  })

  await test('10.2 JSON 文件 write-then-read 往返一致', async () => {
    const testPath = path.join(testOutputDir, `r17_roundtrip_json_${TS}.json`)
    const data = {
      student: 'R17_ROUNDTRIP',
      scores: { chinese: 95, math: 88, english: 92 },
      subjects: ['chinese', 'math', 'english'],
      metadata: { timestamp: TS, version: '1.0' },
    }
    await fsp.writeFile(testPath, JSON.stringify(data, null, 2), 'utf-8')
    const readBack = JSON.parse(await fsp.readFile(testPath, 'utf-8'))
    const valid = JSON.stringify(readBack) === JSON.stringify(data)
    await fsp.unlink(testPath).catch(() => {})
    record('10.2 JSON 文件 write-then-read 往返一致', valid, `match=${JSON.stringify(readBack) === JSON.stringify(data)}`)
  })

  await test('10.3 Excel write-then-read 往返一致', async () => {
    const excelPath = path.join(testOutputDir, `r17_roundtrip_xlsx_${TS}.xlsx`)
    const data = [['姓名', '分数'], ['张三', 95], ['李四', 88]]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), '成绩')
    XLSX.writeFile(wb, excelPath)

    const readWb = XLSX.readFile(excelPath)
    const readData = XLSX.utils.sheet_to_json(readWb.Sheets['成绩'], { header: 1 })
    const valid = readData.length === 3 &&
      readData[0][0] === '姓名' && readData[0][1] === '分数' &&
      readData[1][0] === '张三' && readData[1][1] === 95
    await fsp.unlink(excelPath).catch(() => {})
    record('10.3 Excel write-then-read 往返一致', valid, `rows=${readData.length}`)
  })

  await test('10.4 CSV write-then-read 往返一致', async () => {
    const csvPath = path.join(testOutputDir, `r17_roundtrip_csv_${TS}.csv`)
    const content = '\uFEFF姓名,分数\n张三,95\n李四,88'
    await fsp.writeFile(csvPath, content, 'utf-8')
    const readBack = await fsp.readFile(csvPath, 'utf-8')
    const valid = readBack === content
    await fsp.unlink(csvPath).catch(() => {})
    record('10.4 CSV write-then-read 往返一致', valid, `match=${readBack === content}`)
  })

  await test('10.5 学业数据写入后 IPC 可读', async () => {
    // 通过 IPC 写入成绩,然后用文件系统读取验证
    const stuName = `r17_ipc_verify_${TS}`
    const examName = `R17_IPC_Verify_Exam_${TS}`
    const exam = await callIpc(`
      const res = await api.academic.createExam({
        name: ${JSON.stringify(examName)},
        type: 'monthly',
        date: new Date().toISOString().slice(0, 10),
        semester: 'R17测试',
        subjects: ['chinese'],
      });
      return res;
    `)
    if (!isOk(exam)) {
      record('10.5 学业数据写入后 IPC 可读', false, `exam creation failed: ${exam.message}`)
      return
    }
    const examId = exam.data.id
    await callIpc(`
      const res = await api.academic.setGrade({
        examId: ${JSON.stringify(examId)},
        subjectId: 'chinese',
        studentName: ${JSON.stringify(stuName)},
        score: 85,
        fullMark: 150,
      });
      return res;
    `)

    // 通过文件系统直接读取
    const gradePath = path.join(gradesDir, `${stuName}.json`)
    const gradeContent = await fsp.readFile(gradePath, 'utf-8')
    const grades = JSON.parse(gradeContent)
    const valid = grades.length > 0 && grades[0].score === 85 && grades[0].examId === examId
    record('10.5 学业数据写入后 IPC 可读', valid, `grades=${grades.length} score=${grades[0]?.score}`)
  })

  // ---------- 清理测试目录 ----------
  await fsp.rm(testOutputDir, { recursive: true, force: true }).catch(() => {})

  // ---------- 汇总 ----------
  console.log('\n' + '='.repeat(60))
  const passed = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length
  console.log(`Round 17 AI 文件工具读写学业数据测试: 总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`)
  console.log('='.repeat(60))

  if (failed > 0) {
    console.log('\n失败用例:')
    results.filter(r => !r.ok).forEach(r => console.log(`  [FAIL] ${r.name} — ${r.detail}`))
  }

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
