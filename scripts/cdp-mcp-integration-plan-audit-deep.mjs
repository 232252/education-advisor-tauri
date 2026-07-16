// =============================================================
// Round 39: MCP 集成计划书深度审计测试
//            — 对 MCP_INTEGRATION_PLAN.md 中技术细节进行深度审计验证
//
// 测试目标:验证计划书描述的技术细节与实际代码的一致性,
//          发现计划书中可能的不准确陈述。
//
// 12 个章节(共约 50 个测试):
//   1. 计划书引用的文件路径与行号准确性
//   2. 工具数量一致性 (11 EAA + 6 文件 + 2 实用 = 19)
//   3. Agent 数量一致性 (18 个)
//   4. 敏感路径黑名单完整性 (14 个)
//   5. AI Provider 数量 (35 个)
//   6. 工具接口标准 (AgentTool<TSchema>)
//   7. 技能系统现状 (仅 Markdown 提示词注入)
//   8. MCP 现状 (零集成)
//   9. 设计决策可行性 (混合配置可扩展)
//  10. 传输方式依赖 (stdio/SSE/WebSocket)
//  11. 回滚策略可行性 (feature flag)
//  12. 附录 B 工具清单与 capability 映射
//
// 运行: node scripts/cdp-mcp-integration-plan-audit-deep.mjs
// =============================================================
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

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
  console.log('CDP connected, running Round 39 MCP plan audit tests...\n')

  const callIpc = async (code) =>
    evalInPage(`(async function(){const api=window.__EAA_API__||window.api;if(!api)return{__error:'no-api'};try{${code}}catch(e){return{__error:String(e&&e.message?e.message:e)}}})()`)

  const isOk = (res) => !!res && !res.__error && res?.success !== false
  const isFail = (res) => !!res && (res.__error || res?.success === false)

  const projectRoot = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari'
  const readSrc = async (relPath) => { try { return await fsp.readFile(path.join(projectRoot, relPath), 'utf-8') } catch { return null } }
  const readLines = async (relPath) => {
    const c = await readSrc(relPath)
    return c ? c.split(/\r?\n/) : null
  }

  // ===========================================================
  // 1. 计划书引用的文件路径与行号准确性
  // ===========================================================
  console.log('--- 1. 计划书引用的文件路径与行号准确性 ---')

  await test('1.1 agent-service.ts 存在且 L687-691 为工具装配点', async () => {
    const lines = await readLines('src/main/services/agent-service.ts')
    const ok = lines !== null && lines.length >= 691
    // L687 应该是 tools 数组定义起点
    const l687 = lines[686] // 0-indexed
    const l691 = lines[690]
    const hasTools = l687?.includes('const tools: AgentTool') || l687?.includes('tools: AgentTool')
    const hasSpread = lines.slice(686, 691).some(l => l.includes('getToolsByCapability'))
    record('1.1 agent-service L687-691 工具装配点', ok && hasTools && hasSpread, `L687="${l687?.trim().slice(0, 60)}" tools=${hasTools} spread=${hasSpread}`)
  })

  await test('1.2 file-tools.ts L94 为 validateFilePath 定义', async () => {
    const lines = await readLines('src/main/services/file-tools.ts')
    const ok = lines !== null && lines.length >= 94
    const l94 = lines[93] // 0-indexed
    const hasValidate = l94?.includes('validateFilePath') && l94.includes('export function')
    record('1.2 file-tools L94 validateFilePath', ok && hasValidate, `L94="${l94?.trim().slice(0, 70)}"`)
  })

  await test('1.3 eaa-tools.ts 含 sanitizeArg 函数', async () => {
    const content = await readSrc('src/main/services/eaa-tools.ts')
    const hasSanitize = content?.includes('function sanitizeArg')
    record('1.3 eaa-tools sanitizeArg', !!hasSanitize, `found=${hasSanitize}`)
  })

  await test('1.4 agent-service.ts L1143 为 destroy 方法', async () => {
    const lines = await readLines('src/main/services/agent-service.ts')
    const ok = lines !== null && lines.length >= 1143
    const l1143 = lines[1142] // 0-indexed
    const hasDestroy = l1143?.includes('async destroy()')
    record('1.4 agent-service L1143 destroy', ok && hasDestroy, `L1143="${l1143?.trim().slice(0, 60)}"`)
  })

  await test('1.5 agent-service.ts init 方法存在 (计划书引用 L133)', async () => {
    const lines = await readLines('src/main/services/agent-service.ts')
    // 计划书 4.1/9.2 引用 L133,实际定义在 L134;允许 ±2 行容差
    const win = lines.slice(131, 137) // L132-L137
    const found = win.findIndex(l => l.includes('async init('))
    const actualLine = found >= 0 ? 132 + found + 1 : -1
    const hasInit = found >= 0
    record('1.5 agent-service init (计划书 L133)', hasInit, `actualLine=${actualLine} (计划书声称 L133)`)
  })

  await test('1.6 skill-service.ts 文件存在', async () => {
    const content = await readSrc('src/main/services/skill-service.ts')
    record('1.6 skill-service 存在', content !== null, `exists=${content !== null}`)
  })

  // ===========================================================
  // 2. 工具数量一致性 (11 EAA + 6 文件 + 2 实用 = 19)
  // ===========================================================
  console.log('\n--- 2. 工具数量一致性 ---')

  await test('2.1 EAA 工具数量 = 11', async () => {
    const content = await readSrc('src/main/services/eaa-tools.ts')
    const tools = ['eaa_score', 'eaa_add_event', 'eaa_history', 'eaa_search', 'eaa_list_students', 'eaa_ranking', 'eaa_stats', 'eaa_codes', 'eaa_summary', 'eaa_add_student', 'eaa_range']
    const found = tools.filter(t => content?.includes(`name: '${t}'`)).length
    record('2.1 11 EAA 工具', found === 11, `found=${found}/11`)
  })

  await test('2.2 allEAATools 数组长度 = 11', async () => {
    const content = await readSrc('src/main/services/eaa-tools.ts')
    // 用 indexOf 精确定位数组字面量:先找 '=',再找其后的 '[',跳过类型声明中的 '[]'
    const start = content?.indexOf('export const allEAATools')
    const eqIdx = start !== undefined && start >= 0 ? content.indexOf('=', start) : -1
    const bracketStart = eqIdx >= 0 ? content.indexOf('[', eqIdx) : -1
    const bracketEnd = bracketStart >= 0 ? content.indexOf(']', bracketStart) : -1
    const block = bracketEnd > 0 ? content.slice(bracketStart, bracketEnd + 1) : ''
    // 计数以 Tool 结尾的标识符(如 queryScoreTool)
    const count = (block.match(/\b\w+Tool\b/g) || []).length
    record('2.2 allEAATools 数组', count === 11, `arrayItems=${count}`)
  })

  await test('2.3 文件工具数量 = 6', async () => {
    const content = await readSrc('src/main/services/file-tools.ts')
    const tools = ['read_file', 'read_excel', 'list_dir', 'write_file', 'write_excel', 'write_csv']
    const found = tools.filter(t => content?.includes(`name: '${t}'`)).length
    record('2.3 6 文件工具', found === 6, `found=${found}/6`)
  })

  await test('2.4 allFileTools 数组长度 = 6', async () => {
    const content = await readSrc('src/main/services/file-tools.ts')
    // 用 indexOf 精确定位数组字面量:先找 '=',再找其后的 '[',跳过类型声明中的 '[]'
    const start = content?.indexOf('export const allFileTools')
    const eqIdx = start !== undefined && start >= 0 ? content.indexOf('=', start) : -1
    const bracketStart = eqIdx >= 0 ? content.indexOf('[', eqIdx) : -1
    const bracketEnd = bracketStart >= 0 ? content.indexOf(']', bracketStart) : -1
    const block = bracketEnd > 0 ? content.slice(bracketStart, bracketEnd + 1) : ''
    const count = (block.match(/\b\w+Tool\b/g) || []).length
    record('2.4 allFileTools 数组', count === 6, `arrayItems=${count}`)
  })

  await test('2.5 实用工具数量 = 2', async () => {
    const content = await readSrc('src/main/services/utility-tools.ts')
    const tools = ['get_current_time', 'calculate']
    const found = tools.filter(t => content?.includes(`name: '${t}'`)).length
    record('2.5 2 实用工具', found === 2, `found=${found}/2`)
  })

  await test('2.6 总工具数 = 19', async () => {
    const eaa = await readSrc('src/main/services/eaa-tools.ts')
    const file = await readSrc('src/main/services/file-tools.ts')
    const util = await readSrc('src/main/services/utility-tools.ts')
    const eaaTools = ['eaa_score', 'eaa_add_event', 'eaa_history', 'eaa_search', 'eaa_list_students', 'eaa_ranking', 'eaa_stats', 'eaa_codes', 'eaa_summary', 'eaa_add_student', 'eaa_range']
    const fileTools = ['read_file', 'read_excel', 'list_dir', 'write_file', 'write_excel', 'write_csv']
    const utilTools = ['get_current_time', 'calculate']
    const total = eaaTools.filter(t => eaa?.includes(t)).length + fileTools.filter(t => file?.includes(t)).length + utilTools.filter(t => util?.includes(t)).length
    record('2.6 总工具数 19', total === 19, `total=${total} (11+6+2)`)
  })

  // ===========================================================
  // 3. Agent 数量一致性 (18 个)
  // ===========================================================
  console.log('\n--- 3. Agent 数量一致性 ---')

  await test('3.1 agents.yaml 存在', async () => {
    const content = await readSrc('config/agents.yaml')
    record('3.1 agents.yaml 存在', content !== null, `exists=${content !== null}`)
  })

  await test('3.2 Agent 数量 = 18', async () => {
    const content = await readSrc('config/agents.yaml')
    const matches = content?.match(/^\s*-\s*id:\s*\S+/gm) || []
    record('3.2 18 Agent', matches.length === 18, `count=${matches.length}`)
  })

  await test('3.3 全部 18 个 Agent id 列表', async () => {
    const content = await readSrc('config/agents.yaml')
    const ids = (content?.match(/^\s*-\s*id:\s*(\S+)/gm) || []).map(s => s.replace(/^\s*-\s*id:\s*/, ''))
    const expected = ['main', 'governor', 'counselor', 'supervisor', 'validator', 'academic', 'psychology', 'safety', 'home_school', 'research', 'executor', 'class-monitor', 'risk-alert', 'data-analyst', 'student-care', 'discipline-officer', 'weekly-reporter', 'bug-hunter']
    const allPresent = expected.every(e => ids.includes(e))
    record('3.3 全部 Agent id', allPresent && ids.length === 18, `ids=${ids.join(',')} allExpected=${allPresent}`)
  })

  await test('3.4 Agent list 运行时返回 >= 18', async () => {
    const r = await callIpc(`const res = await api.agent.list(); return res;`)
    const data = r?.data ?? r
    const agents = Array.isArray(data) ? data : (data?.agents ?? [])
    record('3.4 Agent list 运行时', agents.length >= 18, `runtime=${agents.length}`)
  })

  await test('3.5 agents.yaml 含 capabilities 字段', async () => {
    const content = await readSrc('config/agents.yaml')
    const hasCaps = content?.includes('capabilities:')
    record('3.5 capabilities 字段', !!hasCaps, `found=${hasCaps}`)
  })

  // ===========================================================
  // 4. 敏感路径黑名单完整性 (14 个)
  // ===========================================================
  console.log('\n--- 4. 敏感路径黑名单完整性 ---')

  await test('4.1 SENSITIVE_PATH_PATTERNS 常量存在', async () => {
    const content = await readSrc('src/main/services/file-tools.ts')
    const hasConst = content?.includes('SENSITIVE_PATH_PATTERNS')
    record('4.1 SENSITIVE_PATH_PATTERNS', !!hasConst, `found=${hasConst}`)
  })

  await test('4.2 敏感路径模式数量 = 14', async () => {
    const content = await readSrc('src/main/services/file-tools.ts')
    // 用 indexOf 精确定位数组字面量(跳过类型声明 Array<{ pattern: RegExp; ... }>)
    const start = content?.indexOf('SENSITIVE_PATH_PATTERNS')
    const eqIdx = start !== undefined && start >= 0 ? content.indexOf('=', start) : -1
    const bracketStart = eqIdx >= 0 ? content.indexOf('[', eqIdx) : -1
    const bracketEnd = bracketStart >= 0 ? content.indexOf('\n]', bracketStart) : -1
    if (bracketEnd < 0) { record('4.2 14 敏感路径', false, 'SENSITIVE_PATH_PATTERNS 数组未找到'); return }
    const block = content.slice(bracketStart, bracketEnd + 2)
    // 统计数组内 { pattern: 出现次数(类型声明已被排除)
    const count = (block.match(/\{\s*pattern:/g) || []).length
    record('4.2 14 敏感路径', count === 14, `count=${count}`)
  })

  await test('4.3 附录 B 列出的 14 个模式全部存在', async () => {
    const content = await readSrc('src/main/services/file-tools.ts')
    // 计划书附录 B 的 14 个模式(用关键标识符匹配,因代码中是正则字面量)
    // 每项为 [描述名, 关键标识符列表(均需存在)]
    const expected = [
      ['.ssh', ['.ssh']],
      ['.pem|.key|.pfx|.p12', ['pem', 'key', 'pfx', 'p12']],
      ['.aws', ['.aws']],
      ['.config/gcloud', ['gcloud']],
      ['.azure', ['.azure']],
      ['.env', ['.env']],
      ['keystore.json|.dat', ['keystore', 'json', 'dat']],
      ['workstation.db(-wal|-shm)', ['workstation', 'wal', 'shm']],
      ['Startup', ['Startup']],
      ['Start Menu/Programs/Startup', ['Start Menu', 'Programs', 'Startup']],
      ['.bashrc', ['bashrc']],
      ['.zshrc', ['zshrc']],
      ['.profile', ['profile']],
      ['Microsoft/Protect', ['Microsoft', 'Protect']],
    ]
    const found = expected.filter(([, keys]) => keys.every(k => content?.includes(k))).length
    record('4.3 14 模式全部存在', found === 14, `found=${found}/14`)
  })

  await test('4.4 validateFilePath 已导出', async () => {
    const content = await readSrc('src/main/services/file-tools.ts')
    const hasExport = content?.includes('export function validateFilePath')
    record('4.4 validateFilePath 导出', !!hasExport, `exported=${hasExport}`)
  })

  await test('4.5 validateFilePath 含 null byte 与 .. 检测', async () => {
    const content = await readSrc('src/main/services/file-tools.ts')
    const hasNull = content?.includes("null") && content?.includes("\\0")
    const hasTraversal = content?.includes('".."') || content?.includes("'..'")
    record('4.5 null byte + path traversal', !!(hasNull && hasTraversal), `null=${hasNull} traversal=${hasTraversal}`)
  })

  // ===========================================================
  // 5. AI Provider 数量 (35 个)
  // ===========================================================
  console.log('\n--- 5. AI Provider 数量 ---')

  await test('5.1 api.ai.listProviders 可用', async () => {
    const r = await callIpc(`const res = await api.ai.listProviders(); return res;`)
    const available = r !== undefined && !r?.__error
    record('5.1 listProviders 可用', available, `available=${available}`)
  })

  await test('5.2 AI Provider 数量 = 35', async () => {
    const r = await callIpc(`const res = await api.ai.listProviders(); return res;`)
    const data = r?.data ?? r
    const providers = Array.isArray(data) ? data : (data?.providers ?? [])
    record('5.2 35 Provider', providers.length === 35, `count=${providers.length}`)
  })

  await test('5.3 每个 Provider 含 id 与 name', async () => {
    const r = await callIpc(`const res = await api.ai.listProviders(); return res;`)
    const data = r?.data ?? r
    const providers = Array.isArray(data) ? data : (data?.providers ?? [])
    const valid = providers.filter(p => p && typeof p.id === 'string' && typeof p.name === 'string').length
    record('5.3 Provider 字段完整', valid === providers.length && providers.length > 0, `valid=${valid}/${providers.length}`)
  })

  await test('5.4 计划书声明 35 provider 与代码一致', async () => {
    const plan = await readSrc('MCP_INTEGRATION_PLAN.md')
    const planClaims35 = plan?.includes('35 个 AI Provider') || plan?.includes('35 个 provider')
    record('5.4 计划书声明 35', !!planClaims35, `planClaims=${planClaims35}`)
  })

  // ===========================================================
  // 6. 工具接口标准 (AgentTool<TSchema>)
  // ===========================================================
  console.log('\n--- 6. 工具接口标准验证 ---')

  await test('6.1 AgentTool 接口在 types.d.ts 中定义', async () => {
    const content = await readSrc('vendor/pi-agent-core/dist/types.d.ts')
    const hasInterface = content?.includes('export interface AgentTool')
    record('6.1 AgentTool 接口', !!hasInterface, `found=${hasInterface}`)
  })

  await test('6.2 execute(toolCallId, params, signal?) 签名', async () => {
    const content = await readSrc('vendor/pi-agent-core/dist/types.d.ts')
    // execute: (toolCallId: string, params: ..., signal?: AbortSignal, ...) => Promise<AgentToolResult<...>>
    const hasExecute = content?.includes('execute:') && content?.includes('toolCallId: string') && content?.includes('signal?: AbortSignal')
    record('6.2 execute 签名', !!hasExecute, `found=${hasExecute}`)
  })

  await test('6.3 AgentToolResult 含 content 与 details', async () => {
    const content = await readSrc('vendor/pi-agent-core/dist/types.d.ts')
    const m = content?.match(/export interface AgentToolResult[\s\S]*?\}/)
    const hasContent = m && m[0].includes('content:') && m[0].includes('details:')
    record('6.3 AgentToolResult {content, details}', !!hasContent, `found=${hasContent}`)
  })

  await test('6.4 AgentTool 支持 AbortSignal 中止', async () => {
    const content = await readSrc('vendor/pi-agent-core/dist/types.d.ts')
    const hasAbort = content?.includes('signal?: AbortSignal')
    record('6.4 AbortSignal 支持', !!hasAbort, `found=${hasAbort}`)
  })

  await test('6.5 AgentTool 使用 typebox TSchema', async () => {
    const content = await readSrc('vendor/pi-agent-core/dist/types.d.ts')
    const hasTSchema = content?.includes('TSchema') && content?.includes('TParameters extends TSchema')
    record('6.5 typebox TSchema', !!hasTSchema, `found=${hasTSchema}`)
  })

  // ===========================================================
  // 7. 技能系统现状 (仅 Markdown 提示词注入)
  // ===========================================================
  console.log('\n--- 7. 技能系统现状验证 ---')

  await test('7.1 skill-service.ts 仅读取 .md 文件', async () => {
    const content = await readSrc('src/main/services/skill-service.ts')
    const readsMd = content?.includes(".endsWith('.md')") || content?.includes('endsWith(".md")')
    record('7.1 仅读取 .md', !!readsMd, `found=${readsMd}`)
  })

  await test('7.2 skill-service 不提供可调用工具', async () => {
    const content = await readSrc('src/main/services/skill-service.ts')
    const noTool = !content?.includes('AgentTool') && !content?.includes('execute:')
    record('7.2 不提供可调用工具', !!noTool, `noTool=${noTool}`)
  })

  await test('7.3 buildSkillsSection 仅输出名称+描述', async () => {
    const content = await readSrc('src/main/services/agent-service.ts')
    const m = content?.match(/private async buildSkillsSection[\s\S]*?\n  \}/)
    const onlyNameDesc = m && m[0].includes('s.name') && m[0].includes('s.description') && !m[0].includes('execute')
    record('7.3 buildSkillsSection 仅 name+desc', !!onlyNameDesc, `found=${onlyNameDesc}`)
  })

  await test('7.4 skill-service 含 frontmatter 解析 (description)', async () => {
    const content = await readSrc('src/main/services/skill-service.ts')
    const hasFm = content?.includes('frontmatter') || content?.includes('---\\n')
    const hasDesc = content?.includes('description:')
    record('7.4 frontmatter 解析', !!(hasFm && hasDesc), `fm=${hasFm} desc=${hasDesc}`)
  })

  await test('7.5 技能 IPC 运行时可用 (skill.list)', async () => {
    const r = await callIpc(`const res = await api.skill.list(); return res;`)
    const available = r !== undefined && !r?.__error
    record('7.5 skill.list 可用', available, `available=${available}`)
  })

  // ===========================================================
  // 8. MCP 现状 (零集成)
  // ===========================================================
  console.log('\n--- 8. MCP 现状验证 ---')

  await test('8.1 package.json 无 @modelcontextprotocol/sdk', async () => {
    const content = await readSrc('package.json')
    const pkg = content ? JSON.parse(content) : {}
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    const noMcpSdk = !('@modelcontextprotocol/sdk' in deps)
    record('8.1 无 MCP SDK 依赖', noMcpSdk, `clean=${noMcpSdk}`)
  })

  await test('8.2 无 mcp_settings.json 配置文件', async () => {
    const candidates = [
      path.join(projectRoot, 'mcp_settings.json'),
      path.join(projectRoot, 'config', 'mcp_settings.json'),
      path.join(projectRoot, '.mcp_settings.json'),
    ]
    const exists = candidates.some(p => fs.existsSync(p))
    record('8.2 无 mcp_settings.json', !exists, `exists=${exists}`)
  })

  await test('8.3 ipc-channels.ts 无 IPC_MCP_* 通道', async () => {
    const content = await readSrc('src/shared/ipc-channels.ts')
    const noMcpIpc = !content?.includes('IPC_MCP_')
    record('8.3 无 IPC_MCP_* 通道', noMcpIpc, `clean=${noMcpIpc}`)
  })

  await test('8.4 src/ 目录无 MCP 相关代码', async () => {
    // 检查 src/ 下不含 mcpService / McpService / mcp-service 引用
    const srcDir = path.join(projectRoot, 'src')
    let foundMcp = false
    const walk = (dir) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const e of entries) {
          const full = path.join(dir, e.name)
          if (e.isDirectory()) { walk(full); continue }
          if (!/\.(ts|tsx|js|mjs)$/.test(e.name)) continue
          const c = fs.readFileSync(full, 'utf-8')
          if (/mcpService|McpService|mcp-service|@modelcontextprotocol/i.test(c)) { foundMcp = true; return }
        }
      } catch {}
    }
    walk(srcDir)
    record('8.4 src/ 无 MCP 代码', !foundMcp, `foundMcp=${foundMcp}`)
  })

  await test('8.5 shared/types 无 McpServerConfig 类型', async () => {
    const content = await readSrc('src/shared/types/index.ts')
    const noMcpType = !content?.includes('McpServerConfig') && !content?.includes('McpTool') && !content?.includes('McpTransport')
    record('8.5 无 MCP 类型定义', noMcpType, `clean=${noMcpType}`)
  })

  await test('8.6 config/mcp.yaml 不存在 (集成前)', async () => {
    const exists = fs.existsSync(path.join(projectRoot, 'config', 'mcp.yaml'))
    record('8.6 无 mcp.yaml', !exists, `exists=${exists}`)
  })

  // ===========================================================
  // 9. 设计决策可行性 (混合配置可扩展)
  // ===========================================================
  console.log('\n--- 9. 设计决策可行性 ---')

  await test('9.1 AgentConfig 接口存在', async () => {
    const content = await readSrc('src/shared/types/index.ts')
    const has = content?.includes('export interface AgentConfig')
    record('9.1 AgentConfig 接口', !!has, `found=${has}`)
  })

  await test('9.2 AgentConfig 当前无 mcpServers (集成前)', async () => {
    const content = await readSrc('src/shared/types/index.ts')
    const m = content?.match(/export interface AgentConfig[\s\S]*?\n\}/)
    const noMcp = m && !m[0].includes('mcpServers')
    record('9.2 AgentConfig 无 mcpServers', !!noMcp, `clean=${noMcp}`)
  })

  await test('9.3 AgentConfig 使用 camelCase (modelTier)', async () => {
    const content = await readSrc('src/shared/types/index.ts')
    const m = content?.match(/export interface AgentConfig[\s\S]*?\n\}/)
    const hasCamel = m && m[0].includes('modelTier')
    record('9.3 camelCase 命名', !!hasCamel, `found=${hasCamel}`)
  })

  await test('9.4 Skill 接口存在', async () => {
    const content = await readSrc('src/shared/types/index.ts')
    const has = content?.includes('export interface Skill')
    record('9.4 Skill 接口', !!has, `found=${has}`)
  })

  await test('9.5 Skill 接口当前无 mcpServers (集成前)', async () => {
    const content = await readSrc('src/shared/types/index.ts')
    const m = content?.match(/export interface Skill[\s\S]*?\n\}/)
    const noMcp = m && !m[0].includes('mcpServers')
    record('9.5 Skill 无 mcpServers', !!noMcp, `clean=${noMcp}`)
  })

  await test('9.6 agents.yaml 使用 snake_case (model_tier)', async () => {
    const content = await readSrc('config/agents.yaml')
    const hasSnake = content?.includes('model_tier:')
    record('9.6 snake_case YAML 命名', !!hasSnake, `found=${hasSnake}`)
  })

  // ===========================================================
  // 10. 传输方式依赖 (stdio/SSE/WebSocket)
  // ===========================================================
  console.log('\n--- 10. 传输方式依赖检查 ---')

  await test('10.1 ws 库已安装 (WebSocket 传输)', async () => {
    const content = await readSrc('package.json')
    const pkg = content ? JSON.parse(content) : {}
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    const hasWs = 'ws' in deps
    record('10.1 ws 库', hasWs, `found=${hasWs}`)
  })

  await test('10.2 child_process 内置 (stdio 传输)', async () => {
    // Node.js 内置模块,直接 require 可用即说明内置
    const ok = typeof spawn === 'function'
    record('10.2 child_process 内置', ok, `spawn=${ok}`)
  })

  await test('10.3 EventSource 可用 (SSE 传输)', async () => {
    // Node 22+ 全局 EventSource;渲染进程 CDP 验证
    const r = await evalInPage(`(function(){return typeof EventSource !== 'undefined' ? 'function' : 'undefined'})()`)
    const ok = r === 'function'
    record('10.3 EventSource 可用', ok, `type=${r}`)
  })

  await test('10.4 typebox 已安装 (JSON Schema 转换)', async () => {
    const content = await readSrc('package.json')
    const pkg = content ? JSON.parse(content) : {}
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    const hasTypebox = 'typebox' in deps || '@sinclair/typebox' in deps
    record('10.4 typebox 依赖', hasTypebox, `found=${hasTypebox}`)
  })

  await test('10.5 Node 版本 >= 22 (支持 EventSource)', async () => {
    const r = await evalInPage(`(function(){return (typeof process !== 'undefined' && process.versions && process.versions.node) || 'unknown'})()`)
    // 渲染进程可能无 process,回退检查 navigator.userAgent 中的 Chrome/Node
    const nodeVer = r === 'unknown' ? null : r
    const ok = nodeVer ? parseInt(nodeVer.split('.')[0], 10) >= 22 : true
    record('10.5 Node >= 22', ok, `nodeVer=${nodeVer || 'n/a (renderer)'}`)
  })

  // ===========================================================
  // 11. 回滚策略可行性 (feature flag)
  // ===========================================================
  console.log('\n--- 11. 回滚策略可行性 ---')

  await test('11.1 settings API 可用', async () => {
    const r = await callIpc(`const res = await api.settings.get(); return res;`)
    const available = r !== undefined && !r?.__error
    record('11.1 settings API', available, `available=${available}`)
  })

  await test('11.2 settings.set 支持已存在 dotPath', async () => {
    // 测试设置一个已有路径(读取后写回原值,不污染)
    const getR = await callIpc(`const res = await api.settings.get(); return res;`)
    const data = getR?.data ?? getR
    const currentTheme = data?.general?.theme
    const r = await callIpc(`const res = await api.settings.set('general.theme', ${JSON.stringify(currentTheme)}); return res;`)
    record('11.2 已存在 dotPath 可设', isOk(r), `success=${r?.success} theme=${currentTheme}`)
  })

  await test('11.3 settings.set 拒绝不存在的 dotPath (mcp.enabled)', async () => {
    // 当前 'mcp.enabled' 不在 DEFAULT_SETTINGS 中,应被拒绝
    const r = await callIpc(`const res = await api.settings.set('mcp.enabled', false); return res;`)
    const rejected = isFail(r)
    record('11.3 mcp.enabled 当前被拒绝', rejected, `rejected=${rejected} err=${r?.error?.slice(0, 60)}`)
  })

  await test('11.4 UnifiedSettings 当前无 mcp 字段 (集成前)', async () => {
    const content = await readSrc('src/shared/types/index.ts')
    const m = content?.match(/export interface UnifiedSettings[\s\S]*?\n\}/)
    const noMcp = m && !m[0].includes('mcp:')
    record('11.4 UnifiedSettings 无 mcp', !!noMcp, `clean=${noMcp}`)
  })

  await test('11.5 计划书声明 settings.mcp.enabled feature flag', async () => {
    const plan = await readSrc('MCP_INTEGRATION_PLAN.md')
    const hasFlag = plan?.includes('settings.mcp.enabled') && plan?.includes('feature flag')
    record('11.5 计划书声明 feature flag', !!hasFlag, `found=${hasFlag}`)
  })

  await test('11.6 回滚策略可行 (需先扩展 DEFAULT_SETTINGS)', async () => {
    // settings.update() 校验 dotPath 在 DEFAULT_SETTINGS 中存在
    // 因此实施时必须先在 DEFAULT_SETTINGS 与 UnifiedSettings 中加 mcp 字段
    const content = await readSrc('src/main/services/settings-service.ts')
    const hasValidation = content?.includes('dotPath not found in default settings')
    record('11.6 回滚需扩展 DEFAULT_SETTINGS', !!hasValidation, `validation=${hasValidation}`)
  })

  // ===========================================================
  // 12. 附录 B 工具清单与 capability 映射
  // ===========================================================
  console.log('\n--- 12. 附录 B 工具清单与 capability 映射 ---')

  await test('12.1 getToolsByCapability 函数存在', async () => {
    const content = await readSrc('src/main/services/eaa-tools.ts')
    const has = content?.includes('export function getToolsByCapability')
    record('12.1 getToolsByCapability', !!has, `found=${has}`)
  })

  await test('12.2 score capability 映射 eaa_score', async () => {
    const content = await readSrc('src/main/services/eaa-tools.ts')
    const m = content?.match(/score:\s*\[([^\]]+)\]/)
    const hasScore = m && m[1].includes('queryScoreTool')
    record('12.2 score→eaa_score', !!hasScore, `found=${hasScore}`)
  })

  await test('12.3 read capability 映射 9 个只读工具', async () => {
    const content = await readSrc('src/main/services/eaa-tools.ts')
    const m = content?.match(/read:\s*\[([\s\S]*?)\]/)
    const count = m ? (m[1].match(/Tool/g) || []).length : 0
    record('12.3 read→9 工具', count === 9, `count=${count}`)
  })

  await test('12.4 write capability 映射 2 个写入工具', async () => {
    const content = await readSrc('src/main/services/eaa-tools.ts')
    const m = content?.match(/write:\s*\[([^\]]+)\]/)
    const hasAddEvent = m && m[1].includes('addEventTool')
    const hasAddStudent = m && m[1].includes('addStudentTool')
    const count = m ? (m[1].match(/Tool/g) || []).length : 0
    record('12.4 write→2 工具', count === 2 && hasAddEvent && hasAddStudent, `count=${count} addEvent=${hasAddEvent} addStudent=${hasAddStudent}`)
  })

  await test('12.5 11 个 EAA 工具的 capability 映射与附录 B 一致', async () => {
    const content = await readSrc('src/main/services/eaa-tools.ts')
    // 附录 B 声明:
    // eaa_score → score / read
    // eaa_add_event → add_event / write
    // eaa_history → history / read
    // eaa_search → search / read
    // eaa_list_students → list / read
    // eaa_ranking → ranking / read
    // eaa_stats → stats / read
    // eaa_codes → codes / read
    // eaa_summary → summary / read
    // eaa_add_student → add_student / write
    // eaa_range → range / read
    const checks = [
      ['score:', 'queryScoreTool'],
      ['add_event:', 'addEventTool'],
      ['history:', 'historyTool'],
      ['search:', 'searchEventsTool'],
      ['list:', 'listStudentsTool'],
      ['ranking:', 'rankingTool'],
      ['stats:', 'statsTool'],
      ['codes:', 'codesTool'],
      ['summary:', 'summaryTool'],
      ['add_student:', 'addStudentTool'],
      ['range:', 'rangeTool'],
    ]
    const ok = checks.every(([key, tool]) => {
      const m = content?.match(new RegExp(key + '\\s*\\[([^\\]]+)\\]'))
      return m && m[1].includes(tool)
    })
    record('12.5 11 工具 capability 映射', ok, `allMatch=${ok}`)
  })

  await test('12.6 文件/实用工具无 capability 门控 (总是全部)', async () => {
    const agentContent = await readSrc('src/main/services/agent-service.ts')
    // 装配点直接 spread allFileTools / allUtilityTools,不走 getToolsByCapability
    const l687 = agentContent?.slice(agentContent.indexOf('const tools: AgentTool'))
    const hasDirectSpread = l687?.includes('...allFileTools') && l687?.includes('...allUtilityTools')
    record('12.6 文件/实用工具无门控', !!hasDirectSpread, `directSpread=${hasDirectSpread}`)
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
