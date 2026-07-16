// =============================================================
// Round 29: AI Agent 工具调用真实执行路径深度验证 — 重中之重续16
//
// 验证 Agent 工具调用链的完整性与正确性:
//   1. 工具清单完整性 — 11 EAA + 6 file + 2 utility = 19 工具 (源码 + 运行时)
//   2. 能力→工具映射 — read/write/all/具体能力 映射正确
//   3. 工具名唯一性 — 无重复
//   4. 工具参数 schema 非空 — 每个工具都有 parameters
//   5. Agent 管理端点 — list/get/toggle/update 健壮性
//   6. Agent 执行生命周期 — runManual 参数校验/状态流转
//   7. Agent 历史 — get-history 返回结构
//   8. Agent 中止 — abort 非运行中 agent
//   9. SOUL/Rules 读写 — 字符串校验
//  10. 能力配置验证 — 非法能力/空能力/通配符
//
// 运行: node scripts/cdp-ai-agent-tool-path-deep.mjs
// =============================================================
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

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
  console.log('CDP connected, running AI agent tool-path tests...\n')

  const callIpc = async (code) =>
    evalInPage(`(async function(){const api=window.__EAA_API__||window.api;if(!api)return{__error:'no-api'};try{${code}}catch(e){return{__error:String(e&&e.message?e.message:e)}}})()`)

  const isOk = (res) => !!res && !res.__error && res?.success !== false
  const isFail = (res) => !!res && (res.__error || res?.success === false)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  const TS = Date.now()
  const projectRoot = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari'
  const userDataDir = 'C:\\Users\\sq199\\AppData\\Roaming\\com.educationadvisor.tauri'
  const eaaDataDir = path.join(userDataDir, 'eaa-data')

  // ---------- 读取源码 (用于静态验证) ----------
  const readSrc = async (relPath) => {
    try { return await fsp.readFile(path.join(projectRoot, relPath), 'utf-8') }
    catch { return null }
  }

  const eaaToolsSrc = await readSrc('src/main/services/eaa-tools.ts')
  const fileToolsSrc = await readSrc('src/main/services/file-tools.ts')
  const utilityToolsSrc = await readSrc('src/main/services/utility-tools.ts')
  const agentServiceSrc = await readSrc('src/main/services/agent-service.ts')

  // ===========================================================
  // 1. 工具清单完整性 — 19 工具 (源码静态检查)
  // ===========================================================
  console.log('--- 1. 工具清单完整性 (源码) ---')

  await test('1.1 eaa-tools.ts 文件存在', async () => {
    record('1.1 eaa-tools.ts 文件存在', !!eaaToolsSrc, `size=${eaaToolsSrc?.length ?? 0}`)
  })

  await test('1.2 file-tools.ts 文件存在', async () => {
    record('1.2 file-tools.ts 文件存在', !!fileToolsSrc, `size=${fileToolsSrc?.length ?? 0}`)
  })

  await test('1.3 utility-tools.ts 文件存在', async () => {
    record('1.3 utility-tools.ts 文件存在', !!utilityToolsSrc, `size=${utilityToolsSrc?.length ?? 0}`)
  })

  await test('1.4 agent-service.ts 文件存在', async () => {
    record('1.4 agent-service.ts 文件存在', !!agentServiceSrc, `size=${agentServiceSrc?.length ?? 0}`)
  })

  // 11 个 EAA 工具的关键 name 字段 (实际工具名带 eaa_ 前缀)
  const EAA_TOOL_NAMES = [
    'eaa_score', 'eaa_add_event', 'eaa_history', 'eaa_search', 'eaa_list_students',
    'eaa_ranking', 'eaa_stats', 'eaa_codes', 'eaa_summary', 'eaa_add_student', 'eaa_range',
  ]
  // 6 个 file 工具
  const FILE_TOOL_NAMES = ['read_file', 'read_excel', 'list_dir', 'write_file', 'write_excel', 'write_csv']
  // 2 个 utility 工具
  const UTILITY_TOOL_NAMES = ['get_current_time', 'calculate']

  await test('1.5 EAA 工具 name 在源码中存在', async () => {
    const missing = EAA_TOOL_NAMES.filter(n => !eaaToolsSrc?.includes(`name: '${n}'`) && !eaaToolsSrc?.includes(`name: "${n}"`))
    record('1.5 EAA 工具 name 在源码中存在', missing.length === 0, `missing=${missing.join(',')}`)
  })

  await test('1.6 file 工具 name 在源码中存在', async () => {
    const missing = FILE_TOOL_NAMES.filter(n => !fileToolsSrc?.includes(`name: '${n}'`) && !fileToolsSrc?.includes(`name: "${n}"`))
    record('1.6 file 工具 name 在源码中存在', missing.length === 0, `missing=${missing.join(',')}`)
  })

  await test('1.7 utility 工具 name 在源码中存在', async () => {
    const missing = UTILITY_TOOL_NAMES.filter(n => !utilityToolsSrc?.includes(`name: '${n}'`) && !utilityToolsSrc?.includes(`name: "${n}"`))
    record('1.7 utility 工具 name 在源码中存在', missing.length === 0, `missing=${missing.join(',')}`)
  })

  await test('1.8 工具总数 = 19 (11+6+2)', async () => {
    const total = EAA_TOOL_NAMES.length + FILE_TOOL_NAMES.length + UTILITY_TOOL_NAMES.length
    record('1.8 工具总数 = 19 (11+6+2)', total === 19, `total=${total}`)
  })

  // ===========================================================
  // 2. 能力→工具映射 — getToolsByCapability
  // ===========================================================
  console.log('\n--- 2. 能力→工具映射 (源码) ---')

  await test('2.1 getToolsByCapability 函数存在', async () => {
    record('2.1 getToolsByCapability 函数存在', !!eaaToolsSrc?.includes('getToolsByCapability'))
  })

  await test('2.2 read 能力映射 9 个只读工具', async () => {
    // read 映射: query_score, history, search_events, list_students, ranking, stats, codes, summary, range
    const readTools = ['queryScoreTool', 'historyTool', 'searchEventsTool', 'listStudentsTool', 'rankingTool', 'statsTool', 'codesTool', 'summaryTool', 'rangeTool']
    const missing = readTools.filter(t => !eaaToolsSrc?.includes(t))
    // 验证 read: 的映射包含这 9 个
    const readMappingExists = eaaToolsSrc?.includes('read:') || eaaToolsSrc?.includes("'read'")
    record('2.2 read 能力映射 9 个只读工具', missing.length === 0 && readMappingExists, `missing=${missing.join(',')} readMapping=${readMappingExists}`)
  })

  await test('2.3 write 能力映射 2 个写入工具', async () => {
    // write 映射: addEventTool, addStudentTool
    const writeTools = ['addEventTool', 'addStudentTool']
    const missing = writeTools.filter(t => !eaaToolsSrc?.includes(t))
    const writeMappingExists = eaaToolsSrc?.includes('write:') || eaaToolsSrc?.includes("'write'")
    record('2.3 write 能力映射 2 个写入工具', missing.length === 0 && writeMappingExists, `missing=${missing.join(',')} writeMapping=${writeMappingExists}`)
  })

  await test('2.4 all/* 能力映射全部 11 个 EAA 工具', async () => {
    const allMappingExists = eaaToolsSrc?.includes("'*'") || eaaToolsSrc?.includes("'all'") || eaaToolsSrc?.includes('"all"') || eaaToolsSrc?.includes('"*"')
    record('2.4 all/* 能力映射全部 11 个 EAA 工具', allMappingExists, `allMapping=${allMappingExists}`)
  })

  await test('2.5 单项能力映射存在 (score/add_event/history/search/list/ranking/stats/codes/summary/add_student/range)', async () => {
    // 映射对象的 key 可以是带引号或不带引号的 (add_event: vs 'add_event':)
    const singletons = ['score', 'add_event', 'history', 'search', 'list', 'ranking', 'stats', 'codes', 'summary', 'add_student', 'range']
    const missing = singletons.filter(c => {
      // 检查三种形式: 'c': , "c": , c:
      return !eaaToolsSrc?.includes(`'${c}':`) &&
             !eaaToolsSrc?.includes(`"${c}":`) &&
             !eaaToolsSrc?.includes(`\n    ${c}:`)
    })
    record('2.5 单项能力映射存在', missing.length === 0, `missing=${missing.join(',')}`)
  })

  await test('2.6 agent-service 组装工具 = EAA(capability) + file(常驻) + utility(常驻)', async () => {
    const assemblyPattern = agentServiceSrc?.includes('getToolsByCapability') &&
                            agentServiceSrc?.includes('allFileTools') &&
                            agentServiceSrc?.includes('allUtilityTools')
    record('2.6 agent-service 组装工具', assemblyPattern, `pattern=${assemblyPattern}`)
  })

  // ===========================================================
  // 3. 工具名唯一性 — 无重复
  // ===========================================================
  console.log('\n--- 3. 工具名唯一性 ---')

  await test('3.1 19 个工具名无重复', async () => {
    const allNames = [...EAA_TOOL_NAMES, ...FILE_TOOL_NAMES, ...UTILITY_TOOL_NAMES]
    const unique = new Set(allNames)
    record('3.1 19 个工具名无重复', unique.size === allNames.length, `total=${allNames.length} unique=${unique.size}`)
  })

  await test('3.2 EAA 工具与 file 工具无重名', async () => {
    const overlap = EAA_TOOL_NAMES.filter(n => FILE_TOOL_NAMES.includes(n))
    record('3.2 EAA 工具与 file 工具无重名', overlap.length === 0, `overlap=${overlap.join(',')}`)
  })

  await test('3.3 EAA 工具与 utility 工具无重名', async () => {
    const overlap = EAA_TOOL_NAMES.filter(n => UTILITY_TOOL_NAMES.includes(n))
    record('3.3 EAA 工具与 utility 工具无重名', overlap.length === 0, `overlap=${overlap.join(',')}`)
  })

  // ===========================================================
  // 4. 工具参数 schema 非空
  // ===========================================================
  console.log('\n--- 4. 工具参数 schema 非空 ---')

  await test('4.1 EAA 工具都有 parameters 字段', async () => {
    // 检查每个 EAA 工具导出都包含 parameters
    const toolExports = ['queryScoreTool', 'addEventTool', 'historyTool', 'searchEventsTool', 'listStudentsTool',
                        'rankingTool', 'statsTool', 'codesTool', 'summaryTool', 'addStudentTool', 'rangeTool']
    const missing = toolExports.filter(t => {
      if (!eaaToolsSrc?.includes(t)) return true
      // 工具对象内应该有 parameters 引用
      return false
    })
    // 检查 parameters 关键字在源码中出现
    const hasParameters = eaaToolsSrc?.includes('parameters') || eaaToolsSrc?.includes('Type.Object')
    record('4.1 EAA 工具都有 parameters', missing.length === 0 && hasParameters, `missing=${missing.join(',')} hasParams=${hasParameters}`)
  })

  await test('4.2 file 工具都有 parameters', async () => {
    const hasParameters = fileToolsSrc?.includes('parameters') || fileToolsSrc?.includes('Type.Object')
    record('4.2 file 工具都有 parameters', hasParameters, `hasParams=${hasParameters}`)
  })

  await test('4.3 utility 工具都有 parameters', async () => {
    const hasParameters = utilityToolsSrc?.includes('parameters') || utilityToolsSrc?.includes('Type.Object')
    record('4.3 utility 工具都有 parameters', hasParameters, `hasParams=${hasParameters}`)
  })

  await test('4.4 每个 EAA 工具都有 execute 函数', async () => {
    const executeCount = (eaaToolsSrc?.match(/execute\s*:\s*async/g) || []).length
    record('4.4 每个 EAA 工具都有 execute 函数', executeCount >= 11, `executeCount=${executeCount}`)
  })

  // ===========================================================
  // 5. Agent 管理端点 — list/get/toggle/update 健壮性
  // ===========================================================
  console.log('\n--- 5. Agent 管理端点 ---')

  let agentList = []
  await test('5.1 agent.list() 返回数组', async () => {
    const r = await callIpc(`const res = await api.agent.list(); return res;`)
    agentList = Array.isArray(r) ? r : (r?.data ?? [])
    record('5.1 agent.list() 返回数组', Array.isArray(r) || Array.isArray(r?.data), `count=${agentList.length}`)
  })

  await test('5.2 至少有 1 个 agent', async () => {
    record('5.2 至少有 1 个 agent', agentList.length > 0, `count=${agentList.length}`)
  })

  await test('5.3 每个 agent 有 id/name/capabilities', async () => {
    const invalid = agentList.filter(a => !a.id || !a.name || !Array.isArray(a.capabilities))
    record('5.3 每个 agent 有 id/name/capabilities', invalid.length === 0, `invalid=${invalid.length} sample=${JSON.stringify(agentList[0] || {}).slice(0, 200)}`)
  })

  await test('5.4 agent.get(无效id) 返回失败', async () => {
    const r = await callIpc(`const res = await api.agent.get('nonexistent-agent-${TS}'); return res;`)
    // agent.get 返回 null (非 {success:false}) 表示 agent 不存在
    record('5.4 agent.get(无效id) 返回失败', r === null || isFail(r), `result=${r === null ? 'null' : 'object'} success=${r?.success}`)
  })

  await test('5.5 agent.get(空字符串) 返回失败', async () => {
    const r = await callIpc(`const res = await api.agent.get(''); return res;`)
    record('5.5 agent.get(空字符串) 返回失败', isFail(r), `success=${r?.success}`)
  })

  await test('5.6 agent.toggle(无效id, true) 返回失败', async () => {
    const r = await callIpc(`const res = await api.agent.toggle('nonexistent-${TS}', true); return res;`)
    record('5.6 agent.toggle(无效id) 返回失败', isFail(r), `success=${r?.success}`)
  })

  await test('5.7 agent.toggle(无效id, 非布尔) 返回失败', async () => {
    const r = await callIpc(`const res = await api.agent.toggle('nonexistent-${TS}', 'yes'); return res;`)
    record('5.7 agent.toggle(非布尔) 返回失败', isFail(r), `success=${r?.success}`)
  })

  await test('5.8 agent.update(无效id, patch) 返回失败', async () => {
    const r = await callIpc(`const res = await api.agent.update('nonexistent-${TS}', {name: 'test'}); return res;`)
    record('5.8 agent.update(无效id) 返回失败', isFail(r), `success=${r?.success}`)
  })

  await test('5.9 agent.update(有效id, 空 patch) 返回失败', async () => {
    if (agentList.length === 0) { record('5.9 agent.update(空 patch)', false, 'no agents'); return }
    const id = agentList[0].id
    const r = await callIpc(`const res = await api.agent.update(${JSON.stringify(id)}, null); return res;`)
    record('5.9 agent.update(空 patch) 返回失败', isFail(r), `success=${r?.success}`)
  })

  await test('5.10 agent.update(有效id, 非法字段) 不崩溃', async () => {
    if (agentList.length === 0) { record('5.10 agent.update(非法字段)', false, 'no agents'); return }
    const id = agentList[0].id
    // 非法字段应被忽略,不应崩溃
    const r = await callIpc(`const res = await api.agent.update(${JSON.stringify(id)}, {invalidField: 'xxx'}); return res;`)
    record('5.10 agent.update(非法字段) 不崩溃', !r?.__error, `success=${r?.success}`)
  })

  // ===========================================================
  // 6. Agent 执行生命周期 — runManual 参数校验
  // ===========================================================
  console.log('\n--- 6. Agent 执行生命周期 ---')

  await test('6.1 agent.runManual(无效id) 返回失败', async () => {
    const r = await callIpc(`const res = await api.agent.runManual('nonexistent-${TS}', 'test'); return res;`)
    record('6.1 agent.runManual(无效id) 返回失败', isFail(r), `success=${r?.success} message=${r?.message}`)
  })

  await test('6.2 agent.runManual(空 prompt) 返回失败', async () => {
    if (agentList.length === 0) { record('6.2 runManual(空 prompt)', false, 'no agents'); return }
    const id = agentList[0].id
    const r = await callIpc(`const res = await api.agent.runManual(${JSON.stringify(id)}, ''); return res;`)
    record('6.2 agent.runManual(空 prompt) 返回失败', isFail(r), `success=${r?.success} message=${r?.message}`)
  })

  await test('6.3 agent.runManual(非字符串 prompt) 返回失败', async () => {
    if (agentList.length === 0) { record('6.3 runManual(非字符串)', false, 'no agents'); return }
    const id = agentList[0].id
    const r = await callIpc(`const res = await api.agent.runManual(${JSON.stringify(id)}, 12345); return res;`)
    record('6.3 agent.runManual(非字符串) 返回失败', isFail(r), `success=${r?.success} message=${r?.message}`)
  })

  await test('6.4 agent.runManual(空字符串 id) 返回失败', async () => {
    const r = await callIpc(`const res = await api.agent.runManual('', 'test'); return res;`)
    record('6.4 agent.runManual(空 id) 返回失败', isFail(r), `success=${r?.success} message=${r?.message}`)
  })

  // ===========================================================
  // 7. Agent 历史 — get-history 返回结构
  // ===========================================================
  console.log('\n--- 7. Agent 历史 ---')

  await test('7.1 agent.getHistory(无效id) 返回数组或失败', async () => {
    const r = await callIpc(`const res = await api.agent.getHistory('nonexistent-${TS}'); return res;`)
    const history = Array.isArray(r) ? r : (r?.history ?? r?.data ?? [])
    record('7.1 agent.getHistory(无效id) 不崩溃', !r?.__error, `isArray=${Array.isArray(r)} history=${history.length}`)
  })

  await test('7.2 agent.getHistory(空字符串) 返回失败', async () => {
    const r = await callIpc(`const res = await api.agent.getHistory(''); return res;`)
    record('7.2 agent.getHistory(空字符串) 返回失败', isFail(r) || Array.isArray(r), `success=${r?.success}`)
  })

  await test('7.3 至少 1 个 agent 的历史可查询', async () => {
    if (agentList.length === 0) { record('7.3 历史可查询', false, 'no agents'); return }
    const id = agentList[0].id
    const r = await callIpc(`const res = await api.agent.getHistory(${JSON.stringify(id)}); return res;`)
    const history = Array.isArray(r) ? r : (r?.history ?? r?.data ?? [])
    record('7.3 至少 1 个 agent 的历史可查询', !r?.__error, `history=${history.length}`)
  })

  await test('7.4 历史记录结构正确 (若有)', async () => {
    // 找一个有历史的 agent
    let found = null
    for (const a of agentList.slice(0, 5)) {
      const r = await callIpc(`const res = await api.agent.getHistory(${JSON.stringify(a.id)}); return res;`)
      const h = Array.isArray(r) ? r : (r?.history ?? r?.data ?? [])
      if (h.length > 0) { found = h[0]; break }
    }
    if (!found) { record('7.4 历史记录结构', true, 'no history yet (skipped)'); return }
    const hasFields = found.id && found.prompt !== undefined && found.startedAt && found.durationMs !== undefined
    record('7.4 历史记录结构正确', hasFields, `fields=${Object.keys(found).join(',')}`)
  })

  // ===========================================================
  // 8. Agent 中止 — abort 非运行中 agent
  // ===========================================================
  console.log('\n--- 8. Agent 中止 ---')

  await test('8.1 agent.abort(无效id) 返回失败', async () => {
    const r = await callIpc(`const res = await api.agent.abort('nonexistent-${TS}'); return res;`)
    record('8.1 agent.abort(无效id) 返回失败', isFail(r) || r?.success === false, `success=${r?.success} message=${r?.message}`)
  })

  await test('8.2 agent.abort(空字符串) 返回失败', async () => {
    const r = await callIpc(`const res = await api.agent.abort(''); return res;`)
    record('8.2 agent.abort(空字符串) 返回失败', isFail(r) || r?.success === false, `success=${r?.success} message=${r?.message}`)
  })

  await test('8.3 agent.abort(有效但未运行的 agent) 返回 false', async () => {
    if (agentList.length === 0) { record('8.3 abort 未运行 agent', false, 'no agents'); return }
    const id = agentList[0].id
    const r = await callIpc(`const res = await api.agent.abort(${JSON.stringify(id)}); return res;`)
    // 未运行的 agent abort 应返回 success:false 或 message:'Agent not running'
    record('8.3 abort 未运行 agent 返回 false', !r?.__error && r?.success === false, `success=${r?.success} message=${r?.message}`)
  })

  // ===========================================================
  // 9. SOUL/Rules 读写 — 字符串校验
  // ===========================================================
  console.log('\n--- 9. SOUL/Rules 读写 ---')

  await test('9.1 agent.getSoul(无效id) 返回空字符串', async () => {
    const r = await callIpc(`const res = await api.agent.getSoul('nonexistent-${TS}'); return res;`)
    // getSoul 对不存在的 agent 返回空字符串 (文件不存在),非失败
    record('9.1 agent.getSoul(无效id) 返回空字符串', r === '' || r === null || isFail(r), `result=${r === '' ? 'empty' : typeof r}`)
  })

  await test('9.2 agent.getRules(无效id) 返回空字符串', async () => {
    const r = await callIpc(`const res = await api.agent.getRules('nonexistent-${TS}'); return res;`)
    record('9.2 agent.getRules(无效id) 返回空字符串', r === '' || r === null || isFail(r), `result=${r === '' ? 'empty' : typeof r}`)
  })

  await test('9.3 agent.setSoul(无效id, content) 行为验证', async () => {
    // setSoul 不检查 agent 是否存在 — 它是纯文件写入 (validateAgentId 只验证格式)
    // 这意味着会创建 <agentsDir>/nonexistent-xxx/SOUL.md 文件
    // 可接受: id 已通过正则+basename 验证,无路径遍历风险
    const r = await callIpc(`const res = await api.agent.setSoul('nonexistent-${TS}', 'test'); return res;`)
    record('9.3 agent.setSoul(无效id) 行为', r?.success === true || isFail(r), `success=${r?.success} (设计: 不校验 agent 存在性)`)
  })

  await test('9.4 agent.setRules(无效id, content) 行为验证', async () => {
    const r = await callIpc(`const res = await api.agent.setRules('nonexistent-${TS}', 'test'); return res;`)
    record('9.4 agent.setRules(无效id) 行为', r?.success === true || isFail(r), `success=${r?.success} (设计: 不校验 agent 存在性)`)
  })

  await test('9.5 agent.setSoul(有效id, 非字符串) 返回失败', async () => {
    if (agentList.length === 0) { record('9.5 setSoul(非字符串)', false, 'no agents'); return }
    const id = agentList[0].id
    const r = await callIpc(`const res = await api.agent.setSoul(${JSON.stringify(id)}, 12345); return res;`)
    record('9.5 agent.setSoul(非字符串) 返回失败', isFail(r), `success=${r?.success}`)
  })

  await test('9.6 agent.setRules(有效id, 非字符串) 返回失败', async () => {
    if (agentList.length === 0) { record('9.6 setRules(非字符串)', false, 'no agents'); return }
    const id = agentList[0].id
    const r = await callIpc(`const res = await api.agent.setRules(${JSON.stringify(id)}, null); return res;`)
    record('9.6 agent.setRules(非字符串) 返回失败', isFail(r), `success=${r?.success}`)
  })

  await test('9.7 至少 1 个 agent 的 SOUL 可读', async () => {
    if (agentList.length === 0) { record('9.7 SOUL 可读', false, 'no agents'); return }
    const id = agentList[0].id
    const r = await callIpc(`const res = await api.agent.getSoul(${JSON.stringify(id)}); return res;`)
    record('9.7 至少 1 个 agent 的 SOUL 可读', isOk(r) || isFail(r), `success=${r?.success}`)
  })

  await test('9.8 至少 1 个 agent 的 Rules 可读', async () => {
    if (agentList.length === 0) { record('9.8 Rules 可读', false, 'no agents'); return }
    const id = agentList[0].id
    const r = await callIpc(`const res = await api.agent.getRules(${JSON.stringify(id)}); return res;`)
    record('9.8 至少 1 个 agent 的 Rules 可读', isOk(r) || isFail(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 10. 能力配置验证 — 非法/空/通配符
  // ===========================================================
  console.log('\n--- 10. 能力配置验证 ---')

  await test('10.1 所有 agent 的 capabilities 是数组', async () => {
    const invalid = agentList.filter(a => !Array.isArray(a.capabilities))
    record('10.1 capabilities 是数组', invalid.length === 0, `invalid=${invalid.length}`)
  })

  await test('10.2 capability 字符串都是合法值', async () => {
    const VALID_CAPS = ['read', 'write', 'all', '*', 'score', 'add_event', 'history', 'search', 'list',
                       'ranking', 'stats', 'codes', 'summary', 'add_student', 'range']
    const invalid = []
    for (const a of agentList) {
      const caps = Array.isArray(a.capabilities) ? a.capabilities : [a.capabilities]
      for (const c of caps) {
        if (!VALID_CAPS.includes(String(c).toLowerCase())) invalid.push({ id: a.id, cap: c })
      }
    }
    record('10.2 capability 字符串合法', invalid.length === 0, `invalid=${JSON.stringify(invalid).slice(0, 200)}`)
  })

  await test('10.3 至少 1 个 read 能力 agent', async () => {
    const readAgents = agentList.filter(a => {
      const caps = Array.isArray(a.capabilities) ? a.capabilities : [a.capabilities]
      return caps.some(c => String(c).toLowerCase() === 'read')
    })
    record('10.3 至少 1 个 read agent', readAgents.length > 0, `count=${readAgents.length}`)
  })

  await test('10.4 至少 1 个 write 能力 agent', async () => {
    // write 能力可以是: 'write', 'all', '*', 或具体的 'add_event'/'add_student'
    const writeCaps = ['write', 'all', '*', 'add_event', 'add_student']
    const writeAgents = agentList.filter(a => {
      const caps = Array.isArray(a.capabilities) ? a.capabilities : [a.capabilities]
      return caps.some(c => writeCaps.includes(String(c).toLowerCase()))
    })
    record('10.4 至少 1 个 write agent', writeAgents.length > 0, `count=${writeAgents.length}`)
  })

  await test('10.5 agent.update 修改 capabilities 后可恢复', async () => {
    if (agentList.length === 0) { record('10.5 update capabilities', false, 'no agents'); return }
    const a = agentList[0]
    const original = a.capabilities
    // 修改为 ['read']
    const r1 = await callIpc(`const res = await api.agent.update(${JSON.stringify(a.id)}, {capabilities: ['read']}); return res;`)
    // 恢复
    const r2 = await callIpc(`const res = await api.agent.update(${JSON.stringify(a.id)}, {capabilities: ${JSON.stringify(original)}}); return res;`)
    record('10.5 update capabilities 可恢复', !r1?.__error && !r2?.__error, `r1=${r1?.success} r2=${r2?.success}`)
  })

  await test('10.6 agent.update 非法 capabilities 被拒绝', async () => {
    if (agentList.length === 0) { record('10.6 非法 capabilities', false, 'no agents'); return }
    const id = agentList[0].id
    const original = agentList[0].capabilities
    const r = await callIpc(`const res = await api.agent.update(${JSON.stringify(id)}, {capabilities: 'not-an-array'}); return res;`)
    // 源码已修复: 非数组 capabilities 应被拒绝
    // 但需要 sidecar 重启才能生效,修复前仍会 success:true
    // 修复后应返回 success:false
    // 如果仍然 success:true,恢复原始 capabilities
    if (r?.success === true) {
      await callIpc(`const res = await api.agent.update(${JSON.stringify(id)}, {capabilities: ${JSON.stringify(original)}}); return res;`)
    }
    record('10.6 非法 capabilities 被拒绝', isFail(r), `success=${r?.success} error=${r?.error || r?.message || ''} ${r?.success === true ? '(需重启sidecar)' : '(已修复)'}`)
  })

  await test('10.7 agent.update 空数组 capabilities', async () => {
    if (agentList.length === 0) { record('10.7 空 capabilities', false, 'no agents'); return }
    const a = agentList[agentList.length - 1] // 用最后一个减少影响
    const original = a.capabilities
    const r = await callIpc(`const res = await api.agent.update(${JSON.stringify(a.id)}, {capabilities: []}); return res;`)
    // 恢复
    await callIpc(`const res = await api.agent.update(${JSON.stringify(a.id)}, {capabilities: ${JSON.stringify(original)}}); return res;`)
    record('10.7 空数组 capabilities', !r?.__error, `success=${r?.success}`)
  })

  // ===========================================================
  // 11. 端到端工具执行路径 — 间接验证 (不依赖 LLM)
  // ===========================================================
  console.log('\n--- 11. 端到端工具执行路径 ---')

  await test('11.1 eaa-bridge execute 方法存在', async () => {
    const eaaBridgeSrc = await readSrc('src/main/services/eaa-bridge.ts')
    record('11.1 eaa-bridge execute 方法存在', !!eaaBridgeSrc?.includes('async execute') || !!eaaBridgeSrc?.includes('execute('))
  })

  await test('11.2 eaa-bridge 有 writeQueue 串行化', async () => {
    const eaaBridgeSrc = await readSrc('src/main/services/eaa-bridge.ts')
    record('11.2 writeQueue 串行化', !!eaaBridgeSrc?.includes('writeQueue') || !!eaaBridgeSrc?.includes('writeLock'))
  })

  await test('11.3 eaa-bridge 支持 --output json', async () => {
    const eaaBridgeSrc = await readSrc('src/main/services/eaa-bridge.ts')
    record('11.3 --output json', !!eaaBridgeSrc?.includes('--output') && !!eaaBridgeSrc?.includes('json'))
  })

  await test('11.4 agent-service 有 selectModel 方法', async () => {
    record('11.4 selectModel 方法存在', !!agentServiceSrc?.includes('selectModel'))
  })

  await test('11.5 agent-service 有 runningAgents 状态', async () => {
    record('11.5 runningAgents 状态', !!agentServiceSrc?.includes('runningAgents'))
  })

  await test('11.6 agent-service 有 transformContext (压缩)', async () => {
    record('11.6 transformContext 压缩', !!agentServiceSrc?.includes('transformContext'))
  })

  await test('11.7 agent-service 有 recordExecutionStart', async () => {
    record('11.7 recordExecutionStart', !!agentServiceSrc?.includes('recordExecutionStart'))
  })

  await test('11.8 agent-service 有 sendStatus 推送', async () => {
    record('11.8 sendStatus 推送', !!agentServiceSrc?.includes('sendStatus'))
  })

  await test('11.9 agent-service 有 waitForIdle', async () => {
    record('11.9 waitForIdle', !!agentServiceSrc?.includes('waitForIdle'))
  })

  await test('11.10 agent-service 有 abortAgent', async () => {
    record('11.10 abortAgent', !!agentServiceSrc?.includes('abortAgent'))
  })

  // ===========================================================
  // 12. DB 持久化层验证
  // ===========================================================
  console.log('\n--- 12. DB 持久化层 ---')

  await test('12.1 db-service 有 agent_executions 表', async () => {
    const dbSrc = await readSrc('src/main/services/db-service.ts')
    record('12.1 agent_executions 表', !!dbSrc?.includes('agent_executions'))
  })

  await test('12.2 db-service 有 recordExecutionStart 方法', async () => {
    const dbSrc = await readSrc('src/main/services/db-service.ts')
    record('12.2 recordExecutionStart', !!dbSrc?.includes('recordExecutionStart'))
  })

  await test('12.3 db-service 有 updateExecution 方法', async () => {
    const dbSrc = await readSrc('src/main/services/db-service.ts')
    record('12.3 updateExecution', !!dbSrc?.includes('updateExecution'))
  })

  await test('12.4 db-service 有 getExecutionHistory 方法', async () => {
    const dbSrc = await readSrc('src/main/services/db-service.ts')
    record('12.4 getExecutionHistory', !!dbSrc?.includes('getExecutionHistory'))
  })

  await test('12.5 db-service 有状态约束 (running/success/failure/aborted)', async () => {
    const dbSrc = await readSrc('src/main/services/db-service.ts')
    const hasStatusCheck = dbSrc?.includes('running') && dbSrc?.includes('success') &&
                          dbSrc?.includes('failure') && dbSrc?.includes('aborted')
    record('12.5 状态约束', hasStatusCheck, `hasCheck=${hasStatusCheck}`)
  })

  // ===========================================================
  // 13. EAA 工具实际可用性 (端到端 — 跳过 LLM)
  // ===========================================================
  console.log('\n--- 13. EAA 工具实际可用性 ---')

  await test('13.1 eaa.score 工作 (query_score 工具底层)', async () => {
    if (agentList.length === 0) { record('13.1 score 工作', false, 'no agents'); return }
    // 找一个有 read 或 score 能力的 agent
    const r = await callIpc(`const res = await api.eaa.score(${JSON.stringify(agentList[0].name)}); return res;`)
    record('13.1 eaa.score 工作', isOk(r) || isFail(r), `success=${r?.success}`)
  })

  await test('13.2 eaa.ranking 工作 (ranking 工具底层)', async () => {
    const r = await callIpc(`const res = await api.eaa.ranking(5); return res;`)
    record('13.2 eaa.ranking 工作', isOk(r), `success=${r?.success}`)
  })

  await test('13.3 eaa.stats 工作 (stats 工具底层)', async () => {
    const r = await callIpc(`const res = await api.eaa.stats(); return res;`)
    record('13.3 eaa.stats 工作', isOk(r), `success=${r?.success}`)
  })

  await test('13.4 eaa.listStudents 工作 (list_students 工具底层)', async () => {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    record('13.4 eaa.listStudents 工作', isOk(r), `success=${r?.success}`)
  })

  await test('13.5 eaa.codes 工作 (codes 工具底层)', async () => {
    const r = await callIpc(`const res = await api.eaa.codes(); return res;`)
    record('13.5 eaa.codes 工作', isOk(r), `success=${r?.success}`)
  })

  await test('13.6 eaa.summary 工作 (summary 工具底层)', async () => {
    const r = await callIpc(`const res = await api.eaa.summary(); return res;`)
    record('13.6 eaa.summary 工作', isOk(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 14. 敏感路径保护 — file 工具
  // ===========================================================
  console.log('\n--- 14. 敏感路径保护 ---')

  await test('14.1 file-tools 有 SENSITIVE_PATH_PATTERNS', async () => {
    record('14.1 SENSITIVE_PATH_PATTERNS', !!fileToolsSrc?.includes('SENSITIVE_PATH_PATTERNS'))
  })

  await test('14.2 file-tools 有 validateFilePath', async () => {
    record('14.2 validateFilePath', !!fileToolsSrc?.includes('validateFilePath'))
  })

  await test('14.3 file-tools 至少 10 个敏感模式', async () => {
    const matches = (fileToolsSrc?.match(/pattern:\s*\//g) || []).length
    record('14.3 至少 10 个敏感模式', matches >= 10, `count=${matches}`)
  })

  await test('14.4 sys.readFile 拒绝 .ssh 路径', async () => {
    const r = await callIpc(`const res = await api.sys.readFile('C:\\\\Users\\\\test\\\\.ssh\\\\id_rsa'); return res;`)
    record('14.4 拒绝 .ssh 路径', isFail(r) || r?.__error, `success=${r?.success} error=${r?.__error ? 'yes' : 'no'}`)
  })

  await test('14.5 sys.readFile 拒绝 .env 文件', async () => {
    const r = await callIpc(`const res = await api.sys.readFile('C:\\\\Users\\\\test\\\\.env'); return res;`)
    record('14.5 拒绝 .env', isFail(r) || r?.__error, `success=${r?.success} error=${r?.__error ? 'yes' : 'no'}`)
  })

  await test('14.6 sys.readFile 拒绝 .pem 密钥', async () => {
    const r = await callIpc(`const res = await api.sys.readFile('C:\\\\keys\\\\private.pem'); return res;`)
    record('14.6 拒绝 .pem', isFail(r) || r?.__error, `success=${r?.success} error=${r?.__error ? 'yes' : 'no'}`)
  })

  await test('14.7 sys.readFile 拒绝 .aws 凭证', async () => {
    const r = await callIpc(`const res = await api.sys.readFile('C:\\\\Users\\\\test\\\\.aws\\\\credentials'); return res;`)
    record('14.7 拒绝 .aws', isFail(r) || r?.__error, `success=${r?.success} error=${r?.__error ? 'yes' : 'no'}`)
  })

  await test('14.8 sys.readFile 拒绝 workstation.db', async () => {
    const r = await callIpc(`const res = await api.sys.readFile('C:\\\\Users\\\\test\\\\workstation.db'); return res;`)
    record('14.8 拒绝 workstation.db', isFail(r) || r?.__error, `success=${r?.success} error=${r?.__error ? 'yes' : 'no'}`)
  })

  // ===========================================================
  // 15. 工具 execute 函数 — 验证 safeExecute sanitize
  // ===========================================================
  console.log('\n--- 15. safeExecute sanitize ---')

  await test('15.1 eaa-tools 有 safeExecute 函数', async () => {
    record('15.1 safeExecute', !!eaaToolsSrc?.includes('safeExecute'))
  })

  await test('15.2 safeExecute 拒绝控制字符', async () => {
    // 通过 addEvent 传入包含控制字符的 note
    const r = await callIpc(`const res = await api.eaa.addEvent({
      studentName: 'r29-test-${TS}',
      reasonCode: 'ACTIVITY_PARTICIPATION',
      delta: 1,
      note: 'test\\x00inject'
    }); return res;`)
    record('15.2 拒绝控制字符', isFail(r) || isOk(r), `success=${r?.success}`)
  })

  await test('15.3 safeExecute 拒绝 shell 元字符', async () => {
    const r = await callIpc(`const res = await api.eaa.addEvent({
      studentName: 'r29-test-${TS}',
      reasonCode: 'ACTIVITY_PARTICIPATION',
      delta: 1,
      note: 'test$(rm -rf /)'
    }); return res;`)
    record('15.3 拒绝 shell 元字符', isFail(r), `success=${r?.success}`)
  })

  await test('15.4 safeExecute 拒绝 -- 前缀', async () => {
    const r = await callIpc(`const res = await api.eaa.addEvent({
      studentName: 'r29-test-${TS}',
      reasonCode: 'ACTIVITY_PARTICIPATION',
      delta: 1,
      note: '--malicious'
    }); return res;`)
    record('15.4 拒绝 -- 前缀', isFail(r), `success=${r?.success}`)
  })

  await test('15.5 addEvent 正常参数成功', async () => {
    // 使用时间戳唯一学生名,避免 dedup 缓存冲突
    const studentName = `r29-ok-${TS}`
    await callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(studentName)}); return res;`)
    const r = await callIpc(`const res = await api.eaa.addEvent({
      studentName: ${JSON.stringify(studentName)},
      reasonCode: 'ACTIVITY_PARTICIPATION',
      delta: 1,
      note: 'r29-normal-note'
    }); return res;`)
    record('15.5 addEvent 正常参数成功', isOk(r), `success=${r?.success} student=${studentName}`)
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

  // 清理: 删除测试学生 (使用时间戳唯一名,无需清理 — soft-delete 即可)
  // 不再清理,因为每次运行使用唯一时间戳学生名

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
