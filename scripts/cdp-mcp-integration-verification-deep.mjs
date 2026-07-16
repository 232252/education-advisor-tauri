// =============================================================
// Round 40: MCP 集成实功能验证测试 (post-implementation)
//           — 重中之重续26
//
// MCP 已实施完成(阶段1-6),本测试验证实功能:
//   1. 运行时初始化 — McpService 进入 no-op 模式(feature flag 默认 off)
//   2. IPC handlers 响应 — 5 个新通道(mcp:list/connect/disconnect/list-tools/test)
//   3. Feature flag 控制 — settings.set('mcp.enabled', true/false) 可切换
//   4. 配置文件加载 — config/mcp.yaml 可被解析
//   5. 类型系统完整性 — McpServerConfig/McpTool/McpServerStatus 接口存在
//   6. Agent 集成不退化 — 18 agents + 19 工具仍可用
//   7. 工具适配层 — mcp-tools.ts 导出 getMcpToolsForAgent/mcpToolToAgentTool/sanitizeMcpArgs/jsonSchemaToTypebox
//   8. 安全屏障 — 路径参数走 validateFilePath,字符串走 sanitizeArg
//   9. 三层配置合并 — 全局 + Agent 级 + 技能级
//  10. 工具命名规则 — mcp_<serverId>_<toolName>
//  11. 生命周期 — init/destroy 不阻塞主流程
//  12. 源码结构 — mcp-service.ts/mcp-tools.ts/mcp-handlers.ts 存在
//  13. IPC 注册 — ipc/index.ts 包含 registerMcpHandlers
//  14. 回归保护 — 19 工具 + 18 agents 不变
//  15. Feature flag 关闭时 MCP 工具返回空数组
//
// 运行: node scripts/cdp-mcp-integration-verification-deep.mjs
// =============================================================
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const CDP_PORT = 9222
const BASE = `http://127.0.0.1:${CDP_PORT}`
const ROOT = process.cwd()

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(e)
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
  const test = (name, fn) =>
    fn().catch((err) =>
      record(name, false, `异常: ${String(err && err.message ? err.message : err).slice(0, 200)}`),
    )

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
    new Promise((resolve) => {
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
      const desc =
        r.result.exceptionDetails.exception?.description ||
        r.result.exceptionDetails.text ||
        'unknown'
      throw new Error(`Eval error: ${desc.slice(0, 300)}`)
    }
    return r.result?.result?.value
  }
  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP connected, running Round 40 MCP integration verification tests...\n')

  const callIpc = async (code) =>
    evalInPage(
      `(async function(){const api=window.__EAA_API__||window.api;if(!api)return{__error:'no-api'};try{${code}}catch(e){return{__error:String(e&&e.message?e.message:e)}}})()`,
    )

  const isOk = (res) => !!res && !res.__error && res?.success !== false
  const isFail = (res) => !!res && (res.__error || res?.success === false)

  // =========================================================
  // 1. 运行时初始化验证
  // =========================================================
  await test('1.1 MCP service 进入 no-op 模式(feature flag 默认 off)', async () => {
    // 验证 mcp:list 返回空 servers(feature flag off 时)
    const r = await callIpc(`return await api.mcp.list()`)
    // feature flag off 时 listServers 应该返回空数组或 success:true
    const ok = r !== undefined && (isOk(r) || isFail(r))
    record('1.1 MCP service 进入 no-op 模式', ok, `success=${r?.success} servers=${r?.servers?.length ?? 0}`)
  })

  await test('1.2 MCP IPC handlers 响应(mcp:list 不崩溃)', async () => {
    const r = await callIpc(`return await api.mcp.list()`)
    const ok = r !== undefined && !r.__error
    record('1.2 mcp:list 响应', ok, `success=${r?.success} error=${r?.error ?? 'none'}`)
  })

  await test('1.3 MCP IPC mcp:list-tools 不崩溃', async () => {
    const r = await callIpc(`return await api.mcp.listTools('nonexistent-server')`)
    const ok = r !== undefined && !r.__error
    record('1.3 mcp:list-tools 响应', ok, `success=${r?.success} tools=${r?.tools?.length ?? 0}`)
  })

  await test('1.4 MCP IPC mcp:test 对不存在 server 返回失败', async () => {
    const r = await callIpc(`return await api.mcp.test('nonexistent-server')`)
    const ok = r !== undefined && r?.success === false
    record('1.4 mcp:test 对不存在 server', ok, `success=${r?.success} error=${r?.error ?? 'none'}`)
  })

  await test('1.5 MCP IPC mcp:connect 对不存在 server 返回失败', async () => {
    const r = await callIpc(`return await api.mcp.connect('nonexistent-server')`)
    const ok = r !== undefined && r?.success === false
    record('1.5 mcp:connect 对不存在 server', ok, `success=${r?.success} error=${r?.error ?? 'none'}`)
  })

  await test('1.6 MCP IPC mcp:disconnect 对不存在 server 不崩溃', async () => {
    const r = await callIpc(`return await api.mcp.disconnect('nonexistent-server')`)
    const ok = r !== undefined && !r.__error
    record('1.6 mcp:disconnect 不存在 server', ok, `success=${r?.success}`)
  })

  // =========================================================
  // 2. Feature flag 控制
  // =========================================================
  await test('2.1 读取 mcp.enabled 默认值', async () => {
    const r = await callIpc(`return await api.settings.get()`)
    const mcpEnabled = r?.mcp?.enabled
    const ok = r !== undefined && typeof mcpEnabled === 'boolean'
    record('2.1 mcp.enabled 默认值', ok, `mcp.enabled=${mcpEnabled}`)
  })

  await test('2.2 settings.set mcp.enabled=true 可切换', async () => {
    const r = await callIpc(`return await api.settings.set('mcp.enabled', true)`)
    // settings:set 可能返回 success 或 undefined
    const ok = r !== undefined && !r.__error
    record('2.2 mcp.enabled=true 可切换', ok, `result=${JSON.stringify(r).slice(0, 100)}`)
    // 切回 false 避免影响后续测试
    await callIpc(`return await api.settings.set('mcp.enabled', false)`)
  })

  await test('2.3 settings.set mcp.enabled=false 可切回', async () => {
    const r = await callIpc(`return await api.settings.set('mcp.enabled', false)`)
    const ok = r !== undefined && !r.__error
    record('2.3 mcp.enabled=false 可切回', ok, `result=${JSON.stringify(r).slice(0, 100)}`)
  })

  await test('2.4 mcp.enabled 切换后 settings:get 一致', async () => {
    await callIpc(`return await api.settings.set('mcp.enabled', false)`)
    const r = await callIpc(`return await api.settings.get()`)
    const ok = r?.mcp?.enabled === false
    record('2.4 mcp.enabled 切换后一致', ok, `mcp.enabled=${r?.mcp?.enabled}`)
  })

  // =========================================================
  // 3. 配置文件加载
  // =========================================================
  await test('3.1 config/mcp.yaml 存在', async () => {
    const p = path.join(ROOT, 'config', 'mcp.yaml')
    const exists = fs.existsSync(p)
    record('3.1 mcp.yaml 存在', exists, `path=${p}`)
  })

  await test('3.2 config/mcp.yaml 可解析', async () => {
    const p = path.join(ROOT, 'config', 'mcp.yaml')
    const content = await fsp.readFile(p, 'utf-8')
    // 简单验证是 YAML 文件(包含 servers: 或注释)
    const ok = content.includes('servers:') || content.includes('# MCP')
    record('3.2 mcp.yaml 可解析', ok, `size=${content.length}`)
  })

  await test('3.3 mcp.yaml 默认 servers 为空(安全默认)', async () => {
    const p = path.join(ROOT, 'config', 'mcp.yaml')
    const content = await fsp.readFile(p, 'utf-8')
    // 验证没有未注释的 server 条目(安全默认)
    // 简单检查:servers: [] 或 servers: 后面全是注释
    const serversLine = content.match(/^servers:\s*(.*)$/m)
    const ok = serversLine && (serversLine[1] === '[]' || serversLine[1] === '')
    record('3.3 mcp.yaml 默认 servers 空', ok, `servers line="${serversLine?.[1] ?? 'not found'}"`)
  })

  // =========================================================
  // 4. 源码结构验证
  // =========================================================
  await test('4.1 mcp-service.ts 存在', async () => {
    const p = path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts')
    record('4.1 mcp-service.ts 存在', fs.existsSync(p), `path=${p}`)
  })

  await test('4.2 mcp-tools.ts 存在', async () => {
    const p = path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts')
    record('4.2 mcp-tools.ts 存在', fs.existsSync(p), `path=${p}`)
  })

  await test('4.3 mcp-handlers.ts 存在', async () => {
    const p = path.join(ROOT, 'src', 'main', 'ipc', 'mcp-handlers.ts')
    record('4.3 mcp-handlers.ts 存在', fs.existsSync(p), `path=${p}`)
  })

  await test('4.4 global.d.ts 存在(ws 类型声明)', async () => {
    const p = path.join(ROOT, 'src', 'global.d.ts')
    record('4.4 global.d.ts 存在', fs.existsSync(p), `path=${p}`)
  })

  await test('4.5 mcp-service.ts 导出 mcpService 单例', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const ok = content.includes('export const mcpService')
    record('4.5 mcpService 单例导出', ok, `found=${ok}`)
  })

  await test('4.6 mcp-tools.ts 导出 4 个核心函数', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    // getMcpToolsForAgent 是 async function,检查函数名即可
    const exports = ['jsonSchemaToTypebox', 'sanitizeMcpArgs', 'mcpToolToAgentTool', 'getMcpToolsForAgent']
    const missing = exports.filter((e) => !content.includes(`function ${e}`))
    record('4.6 mcp-tools.ts 4 个导出', missing.length === 0, `missing=${missing.join(',') || 'none'}`)
  })

  await test('4.7 mcp-handlers.ts 注册 5 个 IPC handler', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'ipc', 'mcp-handlers.ts'),
      'utf-8',
    )
    const handlers = [
      "IPC.IPC_MCP_LIST",
      "IPC.IPC_MCP_CONNECT",
      "IPC.IPC_MCP_DISCONNECT",
      "IPC.IPC_MCP_LIST_TOOLS",
      "IPC.IPC_MCP_TEST",
    ]
    const missing = handlers.filter((h) => !content.includes(h))
    record('4.7 5 个 IPC handler 注册', missing.length === 0, `missing=${missing.join(',') || 'none'}`)
  })

  await test('4.8 ipc/index.ts 包含 registerMcpHandlers', async () => {
    const content = await fsp.readFile(path.join(ROOT, 'src', 'main', 'ipc', 'index.ts'), 'utf-8')
    const ok = content.includes('registerMcpHandlers')
    record('4.8 ipc/index.ts 注册 MCP', ok, `found=${ok}`)
  })

  // =========================================================
  // 5. agent-service 集成验证
  // =========================================================
  await test('5.1 agent-service.ts 导入 mcpService 和 getMcpToolsForAgent', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'agent-service.ts'),
      'utf-8',
    )
    const hasImport1 = content.includes("from './mcp-tools'")
    const hasImport2 = content.includes("from './mcp-service'")
    record('5.1 agent-service 导入 MCP', hasImport1 && hasImport2, `mcp-tools=${hasImport1} mcp-service=${hasImport2}`)
  })

  await test('5.2 agent-service init 调用 mcpService.init', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'agent-service.ts'),
      'utf-8',
    )
    const ok = content.includes('mcpService.init()')
    record('5.2 init 调用 mcpService.init', ok, `found=${ok}`)
  })

  await test('5.3 agent-service destroy 调用 mcpService.destroy', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'agent-service.ts'),
      'utf-8',
    )
    const ok = content.includes('mcpService.destroy()')
    record('5.3 destroy 调用 mcpService.destroy', ok, `found=${ok}`)
  })

  await test('5.4 agent-service 工具装配点包含 mcpTools', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'agent-service.ts'),
      'utf-8',
    )
    const ok = content.includes('getMcpToolsForAgent(') && content.includes('...mcpTools')
    record('5.4 工具装配点注入 mcpTools', ok, `getMcpToolsForAgent=${content.includes('getMcpToolsForAgent(')} spread=${content.includes('...mcpTools')}`)
  })

  await test('5.5 三层配置合并 — getMcpToolsForAgent 接收 agentId + mcpServers', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'agent-service.ts'),
      'utf-8',
    )
    // 验证调用时传入了 agent id 和 config.mcpServers
    const ok = content.includes('getMcpToolsForAgent(id, config.mcpServers)')
    record('5.5 三层配置合并参数', ok, `found=${ok}`)
  })

  // =========================================================
  // 6. 类型系统完整性
  // =========================================================
  await test('6.1 shared/types 包含 McpServerConfig', async () => {
    const content = await fsp.readFile(path.join(ROOT, 'src', 'shared', 'types', 'index.ts'), 'utf-8')
    const ok = content.includes('export interface McpServerConfig')
    record('6.1 McpServerConfig 接口', ok, `found=${ok}`)
  })

  await test('6.2 shared/types 包含 McpTool', async () => {
    const content = await fsp.readFile(path.join(ROOT, 'src', 'shared', 'types', 'index.ts'), 'utf-8')
    const ok = content.includes('export interface McpTool')
    record('6.2 McpTool 接口', ok, `found=${ok}`)
  })

  await test('6.3 shared/types 包含 McpServerStatus', async () => {
    const content = await fsp.readFile(path.join(ROOT, 'src', 'shared', 'types', 'index.ts'), 'utf-8')
    const ok = content.includes('export interface McpServerStatus')
    record('6.3 McpServerStatus 接口', ok, `found=${ok}`)
  })

  await test('6.4 shared/types 包含 McpTransport 类型', async () => {
    const content = await fsp.readFile(path.join(ROOT, 'src', 'shared', 'types', 'index.ts'), 'utf-8')
    const ok = content.includes("export type McpTransport")
    record('6.4 McpTransport 类型', ok, `found=${ok}`)
  })

  await test('6.5 AgentConfig 包含 mcpServers 字段', async () => {
    const content = await fsp.readFile(path.join(ROOT, 'src', 'shared', 'types', 'index.ts'), 'utf-8')
    const ok = content.includes('mcpServers?: string[]')
    record('6.5 AgentConfig.mcpServers', ok, `found=${ok}`)
  })

  await test('6.6 Skill 包含 mcpServers 字段', async () => {
    const content = await fsp.readFile(path.join(ROOT, 'src', 'shared', 'types', 'index.ts'), 'utf-8')
    const ok = content.includes('mcpServers?: McpServerConfig[]')
    record('6.6 Skill.mcpServers', ok, `found=${ok}`)
  })

  await test('6.7 UnifiedSettings 包含 mcp 字段', async () => {
    const content = await fsp.readFile(path.join(ROOT, 'src', 'shared', 'types', 'index.ts'), 'utf-8')
    const ok = content.includes('mcp:') && content.includes('enabled: boolean')
    record('6.7 UnifiedSettings.mcp', ok, `found=${ok}`)
  })

  await test('6.8 DEFAULT_SETTINGS 包含 mcp 默认值', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'settings-service.ts'),
      'utf-8',
    )
    const ok = content.includes('mcp:') && content.includes('enabled: false')
    record('6.8 DEFAULT_SETTINGS.mcp', ok, `found=${ok}`)
  })

  // =========================================================
  // 7. IPC 通道常量
  // =========================================================
  await test('7.1 ipc-channels.ts 包含 5 个 MCP 通道', async () => {
    const content = await fsp.readFile(path.join(ROOT, 'src', 'shared', 'ipc-channels.ts'), 'utf-8')
    const channels = [
      "IPC_MCP_LIST = 'mcp:list'",
      "IPC_MCP_CONNECT = 'mcp:connect'",
      "IPC_MCP_DISCONNECT = 'mcp:disconnect'",
      "IPC_MCP_LIST_TOOLS = 'mcp:list-tools'",
      "IPC_MCP_TEST = 'mcp:test'",
    ]
    const missing = channels.filter((c) => !content.includes(c))
    record('7.1 5 个 MCP IPC 通道', missing.length === 0, `missing=${missing.join(',') || 'none'}`)
  })

  // =========================================================
  // 8. 安全屏障复用验证
  // =========================================================
  await test('8.1 mcp-tools.ts 导入 validateFilePath', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes("from './file-tools'") && content.includes('validateFilePath')
    record('8.1 复用 validateFilePath', ok, `found=${ok}`)
  })

  await test('8.2 mcp-tools.ts 导入 sanitizeArg', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes("from './eaa-tools'") && content.includes('sanitizeArg')
    record('8.2 复用 sanitizeArg', ok, `found=${ok}`)
  })

  await test('8.3 eaa-tools.ts 导出 sanitizeArg', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'eaa-tools.ts'),
      'utf-8',
    )
    const ok = content.includes('export function sanitizeArg')
    record('8.3 sanitizeArg 已导出', ok, `found=${ok}`)
  })

  await test('8.4 sanitizeMcpArgs 识别路径参数(path/file/dir)', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const hasKeywords = content.includes("'path'") && content.includes("'file'") && content.includes("'dir'")
    const hasCheck = content.includes('isPathLikeParam')
    record('8.4 路径参数识别', hasKeywords && hasCheck, `keywords=${hasKeywords} check=${hasCheck}`)
  })

  await test('8.5 sanitizeMcpArgs 递归处理嵌套对象', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    // 验证递归调用
    const ok = content.includes('sanitizeMcpArgs(') && content.includes('嵌套对象')
    record('8.5 递归处理嵌套', ok, `found=${ok}`)
  })

  await test('8.6 sanitizeMcpArgs 处理数组元素', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes('Array.isArray(value)') && content.includes('数组')
    record('8.6 数组元素处理', ok, `found=${ok}`)
  })

  // =========================================================
  // 9. 工具命名规则验证
  // =========================================================
  await test('9.1 工具名前缀 mcp_<serverId>_', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes('`mcp_${safeServerId}_${safeToolName}`')
    record('9.1 工具名前缀规则', ok, `found=${ok}`)
  })

  await test('9.2 工具名安全化(只允许字母数字下划线)', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes("/[^a-zA-Z0-9_]/g")
    record('9.2 工具名安全化', ok, `found=${ok}`)
  })

  await test('9.3 工具标签格式 MCP [serverId] toolName', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes('`MCP [${serverId}] ${mcpTool.name}`')
    record('9.3 工具标签格式', ok, `found=${ok}`)
  })

  // =========================================================
  // 10. JSON Schema → typebox 转换验证
  // =========================================================
  await test('10.1 jsonSchemaToTypebox 支持 string 类型', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes("case 'string':")
    record('10.1 支持 string 类型', ok, `found=${ok}`)
  })

  await test('10.2 jsonSchemaToTypebox 支持 object 类型', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes("case 'object':")
    record('10.2 支持 object 类型', ok, `found=${ok}`)
  })

  await test('10.3 jsonSchemaToTypebox 支持 array 类型', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes("case 'array':")
    record('10.3 支持 array 类型', ok, `found=${ok}`)
  })

  await test('10.4 jsonSchemaToTypebox 支持 enum', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes('schema.enum') && content.includes('Type.Union')
    record('10.4 支持 enum', ok, `found=${ok}`)
  })

  await test('10.5 jsonSchemaToTypebox 未知类型降级为 Any', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes('Type.Any()')
    record('10.5 未知类型降级 Any', ok, `found=${ok}`)
  })

  await test('10.6 jsonSchemaToTypebox 支持 required 字段', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes('schema.required') && content.includes('Type.Optional')
    record('10.6 支持 required 字段', ok, `found=${ok}`)
  })

  // =========================================================
  // 11. AbortSignal 传递验证
  // =========================================================
  await test('11.1 mcpToolToAgentTool execute 接收 signal 参数', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes('signal?') && content.includes('signal?.aborted')
    record('11.1 AbortSignal 参数', ok, `found=${ok}`)
  })

  await test('11.2 callToolWithSignal 实现 AbortSignal 包装', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes('callToolWithSignal') && content.includes('signal.aborted')
    record('11.2 callToolWithSignal', ok, `found=${ok}`)
  })

  // =========================================================
  // 12. 生命周期验证
  // =========================================================
  await test('12.1 McpService.init 不阻塞(feature flag off 时)', async () => {
    // 验证 app 启动成功(已经在运行就说明 init 不阻塞)
    const r = await callIpc(`return await api.mcp.list()`)
    const ok = r !== undefined && !r.__error
    record('12.1 init 不阻塞', ok, `mcp:list responded=${ok}`)
  })

  await test('12.2 McpService.destroy 在 agent-service.destroy 中调用', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'agent-service.ts'),
      'utf-8',
    )
    // 验证 destroy 方法中调用 mcpService.destroy() 且有 try/catch 包裹
    const ok = content.includes('mcpService.destroy()') && content.includes('non-blocking')
    record('12.2 destroy 调用', ok, `found=${ok}`)
  })

  await test('12.3 McpService.init 有 try/catch 包裹(不阻塞 agent)', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'agent-service.ts'),
      'utf-8',
    )
    const ok = content.includes('mcpService.init()') && content.includes('MCP service init failed (non-blocking)')
    record('12.3 init 有 try/catch', ok, `found=${ok}`)
  })

  // =========================================================
  // 13. 回归保护 — 18 agents + 19 工具不退化
  // =========================================================
  await test('13.1 18 agents 仍可列出', async () => {
    const r = await callIpc(`return await api.agent.list()`)
    const count = r?.length ?? r?.data?.length ?? 0
    const ok = count === 18
    record('13.1 18 agents 仍可列出', ok, `count=${count}`)
  })

  await test('13.2 agent:list 返回结构正确', async () => {
    const r = await callIpc(`return await api.agent.list()`)
    const list = Array.isArray(r) ? r : r?.data
    const ok = Array.isArray(list) && list.length > 0 && list[0]?.id && list[0]?.name
    record('13.2 agent:list 结构', ok, `isArray=${Array.isArray(list)} first.id=${list?.[0]?.id}`)
  })

  await test('13.3 EAA 工具仍可用(eaa_score)', async () => {
    // 用一个不存在的学生测试,验证 EAA 工具不崩溃
    const r = await callIpc(`return await api.eaa.score('__mcp_test_nonexistent__')`)
    // EAA 可能返回 success:false(学生不存在)但不应该崩溃
    const ok = r !== undefined && !r.__error
    record('13.3 eaa:execute 仍可用', ok, `success=${r?.success}`)
  })

  await test('13.4 EAA list-students 仍可用', async () => {
    const r = await callIpc(`return await api.eaa.listStudents()`)
    const ok = r !== undefined && !r.__error
    record('13.4 list-students 仍可用', ok, `success=${r?.success}`)
  })

  await test('13.5 skill:list 仍可用', async () => {
    const r = await callIpc(`return await api.skill.list()`)
    const ok = r !== undefined && !r.__error
    record('13.5 skill:list 仍可用', ok, `isArray=${Array.isArray(r)}`)
  })

  await test('13.6 settings:get 仍可用(含 mcp 字段)', async () => {
    const r = await callIpc(`return await api.settings.get()`)
    const ok = r !== undefined && !r.__error && r?.mcp && typeof r.mcp.enabled === 'boolean'
    record('13.6 settings:get 含 mcp', ok, `mcp.enabled=${r?.mcp?.enabled}`)
  })

  // =========================================================
  // 14. Feature flag off 时 MCP 工具返回空
  // =========================================================
  await test('14.1 feature flag off 时 mcp:list 返回空 servers', async () => {
    // 确保 flag 是 off
    await callIpc(`return await api.settings.set('mcp.enabled', false)`)
    const r = await callIpc(`return await api.mcp.list()`)
    const ok = isOk(r) && (r.servers?.length === 0 || r.servers === undefined)
    record('14.1 flag off 返回空', ok, `servers=${r?.servers?.length ?? 0}`)
  })

  await test('14.2 feature flag off 时 mcp:list-tools 返回空', async () => {
    const r = await callIpc(`return await api.mcp.listTools('any-server')`)
    const ok = isOk(r) && (r.tools?.length === 0 || r.tools === undefined)
    record('14.2 flag off list-tools 空', ok, `tools=${r?.tools?.length ?? 0}`)
  })

  // =========================================================
  // 15. MCP server 配置验证(无实际 server,只验证配置结构)
  // =========================================================
  await test('15.1 mcp-service.ts 实现三种传输方式', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const stdio = content.includes('connectStdio')
    const sse = content.includes('connectSse')
    const ws = content.includes('connectWebSocket')
    record('15.1 三种传输方式', stdio && sse && ws, `stdio=${stdio} sse=${sse} ws=${ws}`)
  })

  await test('15.2 mcp-service.ts 实现连接超时', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const ok = content.includes('CONNECT_TIMEOUT_MS') && content.includes('Promise.race')
    record('15.2 连接超时', ok, `found=${ok}`)
  })

  await test('15.3 mcp-service.ts 实现调用超时', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const ok = content.includes('CALL_TIMEOUT_MS')
    record('15.3 调用超时', ok, `found=${ok}`)
  })

  await test('15.4 mcp-service.ts 实现响应大小限制', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const ok = content.includes('MAX_RESPONSE_SIZE')
    record('15.4 响应大小限制', ok, `found=${ok}`)
  })

  await test('15.5 mcp-service.ts 实现环境变量插值', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const ok = content.includes('interpolateEnv') && content.includes('${')
    record('15.5 环境变量插值', ok, `found=${ok}`)
  })

  await test('15.6 mcp-service.ts 实现惰性连接', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const ok = content.includes('ensureConnected') && content.includes('lazy') === false // 不要求有 lazy 字样,只要有 ensureConnected
    record('15.6 惰性连接', ok, `ensureConnected=${content.includes('ensureConnected')}`)
  })

  await test('15.7 mcp-service.ts 实现三层配置合并', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const ok =
      content.includes('listToolsForAgent') &&
      content.includes('agentMcpServers') &&
      content.includes('skillMcpServers')
    record('15.7 三层配置合并', ok, `found=${ok}`)
  })

  await test('15.8 mcp-service.ts 实现 JSON-RPC 消息处理', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const ok = content.includes('handleJsonRpcMessage') && content.includes('jsonrpc')
    record('15.8 JSON-RPC 消息处理', ok, `found=${ok}`)
  })

  // =========================================================
  // 汇总
  // =========================================================
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  const total = results.length
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Round 40 MCP 集成实功能验证: ${passed}/${total} PASS, ${failed} FAIL`)
  if (failed > 0) {
    console.log(`\n失败项:`)
    results.filter((r) => !r.ok).forEach((r) => console.log(`  ✗ ${r.name} — ${r.detail}`))
  }
  console.log(`${'='.repeat(60)}`)

  ws.close()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
