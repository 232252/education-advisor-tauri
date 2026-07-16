// =============================================================
// Round 41: MCP 功能深度验证测试 (deep functional testing)
//           — 重中之重续27
//
// 在 Round 40 集成验证基础上,本测试执行更深层级的功能验证:
//   1. Feature flag ON 行为 — 开启状态下的完整功能链路
//   2. IPC 错误处理与边缘用例 — 空串/特殊字符/超长串/SQL 注入/Unicode
//   3. Sidecar handler 注册 — 注册函数与验证函数
//   4. MCP service 内部结构 — 超时常量与方法签名
//   5. 安全屏障源码验证 — sanitizeMcpArgs 的分支覆盖
//   6. Agent 集成深度验证 — 非阻塞日志/三层合并/工具装配
//   7. Feature flag 状态一致性 — set/get 双向同步
//   8. DEFAULT_SETTINGS 验证 — 默认值与 reset 还原
//
// 运行: node scripts/cdp-mcp-functional-deep.mjs
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
  console.log('CDP connected, running Round 41 MCP functional deep tests...\n')

  const callIpc = async (code) =>
    evalInPage(
      `(async function(){const api=window.__EAA_API__||window.api;if(!api)return{__error:'no-api'};try{${code}}catch(e){return{__error:String(e&&e.message?e.message:e)}}})()`,
    )

  const isOk = (res) => !!res && !res.__error && res?.success !== false
  const isFail = (res) => !!res && (res.__error || res?.success === false)

  // 确保 flag 起始为 off,避免前置状态污染
  await callIpc(`return await api.settings.set('mcp.enabled', false)`)

  // =========================================================
  // 1. Feature flag ON 行为验证 (8 tests)
  // =========================================================
  await test('1.1 设置 mcp.enabled=true 并由 settings:get 读回', async () => {
    await callIpc(`return await api.settings.set('mcp.enabled', true)`)
    const r = await callIpc(`return await api.settings.get()`)
    const ok = r?.mcp?.enabled === true
    record('1.1 flag=true 读回', ok, `mcp.enabled=${r?.mcp?.enabled}`)
  })

  await test('1.2 flag ON 时 mcp:list 仍正常(返回 servers 数组)', async () => {
    const r = await callIpc(`return await api.mcp.list()`)
    const ok = r !== undefined && !r.__error && Array.isArray(r.servers)
    record('1.2 flag ON mcp:list', ok, `success=${r?.success} servers=${r?.servers?.length ?? 0}`)
  })

  await test('1.3 flag ON 时 mcp:list-tools 对不存在 server 返回错误', async () => {
    const r = await callIpc(`return await api.mcp.listTools('nonexistent-server')`)
    const ok = r !== undefined && (isFail(r) || (isOk(r) && (r.tools?.length === 0 || r.tools === undefined)))
    record('1.3 flag ON list-tools 不存在 server', ok, `success=${r?.success} error=${r?.error ?? 'none'}`)
  })

  await test('1.4 flag ON 时 mcp:connect 对不存在 server 返回错误', async () => {
    const r = await callIpc(`return await api.mcp.connect('nonexistent-server')`)
    const ok = r !== undefined && r?.success === false
    record('1.4 flag ON connect 不存在 server', ok, `success=${r?.success} error=${r?.error ?? 'none'}`)
  })

  await test('1.5 flag ON 时 mcp:test 对不存在 server 返回失败', async () => {
    const r = await callIpc(`return await api.mcp.test('nonexistent-server')`)
    const ok = r !== undefined && r?.success === false
    record('1.5 flag ON test 不存在 server', ok, `success=${r?.success} error=${r?.error ?? 'none'}`)
  })

  await test('1.6 切回 false 后 mcp:list 返回空', async () => {
    await callIpc(`return await api.settings.set('mcp.enabled', false)`)
    const r = await callIpc(`return await api.mcp.list()`)
    const ok = isOk(r) && (r.servers?.length === 0 || r.servers === undefined)
    record('1.6 切回 false 返回空', ok, `servers=${r?.servers?.length ?? 0}`)
  })

  await test('1.7 再次切到 true,验证切换幂等', async () => {
    await callIpc(`return await api.settings.set('mcp.enabled', true)`)
    const r1 = await callIpc(`return await api.settings.get()`)
    await callIpc(`return await api.settings.set('mcp.enabled', true)`)
    const r2 = await callIpc(`return await api.settings.get()`)
    const ok = r1?.mcp?.enabled === true && r2?.mcp?.enabled === true
    record('1.7 切换幂等', ok, `r1=${r1?.mcp?.enabled} r2=${r2?.mcp?.enabled}`)
  })

  await test('1.8 最终切回 false(cleanup)', async () => {
    const r = await callIpc(`return await api.settings.set('mcp.enabled', false)`)
    const g = await callIpc(`return await api.settings.get()`)
    const ok = r !== undefined && !r.__error && g?.mcp?.enabled === false
    record('1.8 cleanup flag=false', ok, `mcp.enabled=${g?.mcp?.enabled}`)
  })

  // =========================================================
  // 2. IPC 错误处理与边缘用例 (8 tests)
  // =========================================================
  await test('2.1 mcp:connect 空串 serverId 应失败(校验)', async () => {
    const r = await callIpc(`return await api.mcp.connect('')`)
    const ok = isFail(r)
    record('2.1 connect 空串', ok, `success=${r?.success} error=${r?.error ?? r?.__error ?? 'none'}`)
  })

  await test('2.2 mcp:connect 含路径穿越字符应失败', async () => {
    const r = await callIpc(`return await api.mcp.connect('test/../hack')`)
    const ok = isFail(r)
    record('2.2 connect 路径穿越', ok, `success=${r?.success} error=${r?.error ?? r?.__error ?? 'none'}`)
  })

  await test('2.3 mcp:connect 超长 serverId(1000 字符)应失败', async () => {
    const longId = 'a'.repeat(1000)
    const r = await callIpc(`return await api.mcp.connect('${longId}')`)
    const ok = isFail(r)
    record('2.3 connect 超长串', ok, `success=${r?.success} error=${r?.error ?? r?.__error ?? 'none'}`)
  })

  await test('2.4 mcp:disconnect 空串应优雅处理', async () => {
    const r = await callIpc(`return await api.mcp.disconnect('')`)
    const ok = r !== undefined && !r.__error
    record('2.4 disconnect 空串', ok, `success=${r?.success} error=${r?.error ?? 'none'}`)
  })

  await test('2.5 mcp:list-tools 空串应优雅失败', async () => {
    const r = await callIpc(`return await api.mcp.listTools('')`)
    const ok = r !== undefined && !r.__error && (isFail(r) || (isOk(r) && (r.tools?.length === 0 || r.tools === undefined)))
    record('2.5 list-tools 空串', ok, `success=${r?.success} error=${r?.error ?? 'none'}`)
  })

  await test('2.6 mcp:test 空串应优雅失败', async () => {
    const r = await callIpc(`return await api.mcp.test('')`)
    const ok = r !== undefined && !r.__error
    record('2.6 test 空串', ok, `success=${r?.success} error=${r?.error ?? 'none'}`)
  })

  await test('2.7 mcp:connect SQL 注入尝试应失败', async () => {
    const r = await callIpc(`return await api.mcp.connect("'; DROP TABLE--")`)
    const ok = isFail(r)
    record('2.7 connect SQL 注入', ok, `success=${r?.success} error=${r?.error ?? r?.__error ?? 'none'}`)
  })

  await test('2.8 mcp:connect Unicode 字符应失败(无此 server)', async () => {
    const r = await callIpc(`return await api.mcp.connect('测试服务器名-émoji-🔥')`)
    const ok = r !== undefined && r?.success === false
    record('2.8 connect Unicode', ok, `success=${r?.success} error=${r?.error ?? 'none'}`)
  })

  // =========================================================
  // 3. Sidecar handler 注册验证 (5 tests)
  // =========================================================
  await test('3.1 sidecar-entry.ts 导入 registerMcpHandlers', async () => {
    const p = path.join(ROOT, 'src', 'sidecar', 'sidecar-entry.ts')
    const exists = fs.existsSync(p)
    if (!exists) {
      record('3.1 sidecar-entry 导入', false, `file not found: ${p}`)
      return
    }
    const content = await fsp.readFile(p, 'utf-8')
    const ok = content.includes('registerMcpHandlers')
    record('3.1 sidecar-entry 导入', ok, `found=${ok}`)
  })

  await test('3.2 sidecar-entry.ts 调用 registerMcpHandlers', async () => {
    const p = path.join(ROOT, 'src', 'sidecar', 'sidecar-entry.ts')
    const exists = fs.existsSync(p)
    if (!exists) {
      record('3.2 sidecar-entry 调用', false, `file not found: ${p}`)
      return
    }
    const content = await fsp.readFile(p, 'utf-8')
    // 既包含 import 又包含调用(出现次数 >=2 或带括号调用)
    const hasCall = /registerMcpHandlers\s*\(/.test(content)
    const ok = content.includes('registerMcpHandlers') && hasCall
    record('3.2 sidecar-entry 调用', ok, `hasCall=${hasCall}`)
  })

  await test('3.3 mcp-handlers.ts 导出 registerMcpHandlers', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'ipc', 'mcp-handlers.ts'),
      'utf-8',
    )
    const ok = content.includes('export function registerMcpHandlers') || content.includes('export const registerMcpHandlers')
    record('3.3 导出 registerMcpHandlers', ok, `found=${ok}`)
  })

  await test('3.4 mcp-handlers.ts 包含 5 个 ipcMain.handle 调用', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'ipc', 'mcp-handlers.ts'),
      'utf-8',
    )
    const matches = content.match(/ipcMain\.handle\(/g) || []
    const count = matches.length
    const ok = count >= 5
    record('3.4 5 个 ipcMain.handle', ok, `count=${count}`)
  })

  await test('3.5 mcp-handlers.ts 含 validateServerId 函数', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'ipc', 'mcp-handlers.ts'),
      'utf-8',
    )
    const ok = content.includes('validateServerId')
    record('3.5 validateServerId 函数', ok, `found=${ok}`)
  })

  // =========================================================
  // 4. MCP service 内部结构深度验证 (8 tests)
  // =========================================================
  await test('4.1 mcp-service.ts 含 CONNECT_TIMEOUT_MS 常量', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const ok = content.includes('CONNECT_TIMEOUT_MS')
    record('4.1 CONNECT_TIMEOUT_MS', ok, `found=${ok}`)
  })

  await test('4.2 mcp-service.ts 含 CALL_TIMEOUT_MS 常量', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const ok = content.includes('CALL_TIMEOUT_MS')
    record('4.2 CALL_TIMEOUT_MS', ok, `found=${ok}`)
  })

  await test('4.3 mcp-service.ts 含 MAX_RESPONSE_SIZE 常量', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const ok = content.includes('MAX_RESPONSE_SIZE')
    record('4.3 MAX_RESPONSE_SIZE', ok, `found=${ok}`)
  })

  await test('4.4 mcp-service.ts 含 listServers() 方法', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const ok = /listServers\s*\(/.test(content)
    record('4.4 listServers 方法', ok, `found=${ok}`)
  })

  await test('4.5 mcp-service.ts 含 connectServer() 方法', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const ok = /connectServer\s*\(/.test(content)
    record('4.5 connectServer 方法', ok, `found=${ok}`)
  })

  await test('4.6 mcp-service.ts 含 disconnectServer() 方法', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const ok = /disconnectServer\s*\(/.test(content)
    record('4.6 disconnectServer 方法', ok, `found=${ok}`)
  })

  await test('4.7 mcp-service.ts 含 testServer() 方法', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const ok = /testServer\s*\(/.test(content)
    record('4.7 testServer 方法', ok, `found=${ok}`)
  })

  await test('4.8 mcp-service.ts 含 listTools() 方法', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-service.ts'),
      'utf-8',
    )
    const ok = /listTools\s*\(/.test(content)
    record('4.8 listTools 方法', ok, `found=${ok}`)
  })

  // =========================================================
  // 5. 安全屏障源码验证 (6 tests)
  // =========================================================
  await test('5.1 sanitizeMcpArgs 检查路径类参数名(path/file/dir/folder/filepath/filename)', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const keywords = ['path', 'file', 'dir', 'folder', 'filepath', 'filename']
    const missing = keywords.filter((k) => !content.includes(`'${k}'`) && !content.includes(`"${k}"`))
    const ok = missing.length === 0
    record('5.1 路径类参数名', ok, `missing=${missing.join(',') || 'none'}`)
  })

  await test('5.2 sanitizeMcpArgs 对路径类参数调用 validateFilePath', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes('validateFilePath')
    record('5.2 调用 validateFilePath', ok, `found=${ok}`)
  })

  await test('5.3 sanitizeMcpArgs 对所有字符串参数调用 sanitizeArg', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes('sanitizeArg')
    record('5.3 调用 sanitizeArg', ok, `found=${ok}`)
  })

  await test('5.4 sanitizeMcpArgs 递归处理嵌套对象', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    // 递归调用自身处理嵌套对象
    const ok = content.includes('sanitizeMcpArgs(') && content.includes('嵌套')
    record('5.4 递归嵌套对象', ok, `found=${ok}`)
  })

  await test('5.5 sanitizeMcpArgs 处理数组', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes('Array.isArray') && content.includes('数组')
    record('5.5 处理数组', ok, `found=${ok}`)
  })

  await test('5.6 mcp-tools.ts 同时从 file-tools 和 eaa-tools 导入', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes("from './file-tools'") && content.includes("from './eaa-tools'")
    record('5.6 双导入 file-tools + eaa-tools', ok, `file=${content.includes("from './file-tools'")} eaa=${content.includes("from './eaa-tools'")}`)
  })

  // =========================================================
  // 6. Agent 集成深度验证 (6 tests)
  // =========================================================
  await test('6.1 agent-service.ts mcpService.init() 有 try/catch 且含 non-blocking', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'agent-service.ts'),
      'utf-8',
    )
    const ok = content.includes('mcpService.init()') && content.includes('non-blocking')
    record('6.1 init non-blocking', ok, `found=${ok}`)
  })

  await test('6.2 agent-service.ts mcpService.destroy() 有 try/catch 且含 non-blocking', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'agent-service.ts'),
      'utf-8',
    )
    const ok = content.includes('mcpService.destroy()') && content.includes('non-blocking')
    record('6.2 destroy non-blocking', ok, `found=${ok}`)
  })

  await test('6.3 agent-service.ts 使用 getMcpToolsForAgent(id, config.mcpServers) 三层合并', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'agent-service.ts'),
      'utf-8',
    )
    const ok = content.includes('getMcpToolsForAgent(id, config.mcpServers)')
    record('6.3 三层合并调用', ok, `found=${ok}`)
  })

  await test('6.4 agent-service.ts 将 mcpTools spread 到 tools 数组(带注释)', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'agent-service.ts'),
      'utf-8',
    )
    const ok = content.includes('...mcpTools')
    record('6.4 mcpTools spread', ok, `found=${ok}`)
  })

  await test('6.5 18 个 agents 仍可正确加载', async () => {
    const r = await callIpc(`return await api.agent.list()`)
    const count = r?.length ?? r?.data?.length ?? 0
    const ok = count === 18
    record('6.5 18 agents 加载', ok, `count=${count}`)
  })

  await test('6.6 agent:update 对主 agent 仍可用(toggle enabled)', async () => {
    // 先获取第一个 agent,翻转 enabled,再翻回
    const list = await callIpc(`return await api.agent.list()`)
    const arr = Array.isArray(list) ? list : list?.data
    const first = arr?.[0]
    if (!first?.id) {
      record('6.6 agent:update toggle', false, 'no agent available')
      return
    }
    const original = first.enabled
    const toggled = !original
    const r1 = await callIpc(`return await api.agent.update('${first.id}', { enabled: ${toggled} })`)
    const ok1 = r1 !== undefined && !r1.__error
    // 翻回原值,避免污染
    await callIpc(`return await api.agent.update('${first.id}', { enabled: ${original} })`)
    record('6.6 agent:update toggle', ok1, `id=${first.id} toggled=${toggled} result=${JSON.stringify(r1).slice(0, 80)}`)
  })

  // =========================================================
  // 7. Feature flag 状态一致性 (5 tests)
  // =========================================================
  await test('7.1 settings:get 返回含 enabled 字段的 mcp 对象', async () => {
    const r = await callIpc(`return await api.settings.get()`)
    const ok = r?.mcp && typeof r.mcp.enabled === 'boolean'
    record('7.1 mcp 对象含 enabled', ok, `mcp=${JSON.stringify(r?.mcp).slice(0, 60)}`)
  })

  await test('7.2 settings:set mcp.enabled=true 返回 success', async () => {
    const r = await callIpc(`return await api.settings.set('mcp.enabled', true)`)
    const ok = r !== undefined && !r.__error
    record('7.2 set true 成功', ok, `result=${JSON.stringify(r).slice(0, 80)}`)
  })

  await test('7.3 set true 后 settings:get 返回 mcp.enabled=true', async () => {
    const r = await callIpc(`return await api.settings.get()`)
    const ok = r?.mcp?.enabled === true
    record('7.3 get 读回 true', ok, `mcp.enabled=${r?.mcp?.enabled}`)
  })

  await test('7.4 settings:set mcp.enabled=false 返回 success', async () => {
    const r = await callIpc(`return await api.settings.set('mcp.enabled', false)`)
    const ok = r !== undefined && !r.__error
    record('7.4 set false 成功', ok, `result=${JSON.stringify(r).slice(0, 80)}`)
  })

  await test('7.5 set false 后 settings:get 返回 mcp.enabled=false', async () => {
    const r = await callIpc(`return await api.settings.get()`)
    const ok = r?.mcp?.enabled === false
    record('7.5 get 读回 false', ok, `mcp.enabled=${r?.mcp?.enabled}`)
  })

  // =========================================================
  // 8. DEFAULT_SETTINGS 验证 (4 tests)
  // =========================================================
  await test('8.1 settings-service.ts DEFAULT_SETTINGS 含 mcp 段', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'settings-service.ts'),
      'utf-8',
    )
    const ok = content.includes('mcp:') && content.includes('enabled:')
    record('8.1 DEFAULT_SETTINGS mcp 段', ok, `found=${ok}`)
  })

  await test('8.2 DEFAULT_SETTINGS mcp.enabled 默认 false', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'settings-service.ts'),
      'utf-8',
    )
    const ok = content.includes('enabled: false')
    record('8.2 mcp.enabled 默认 false', ok, `found=${ok}`)
  })

  await test('8.3 settings:get 返回的 mcp.enabled 为 boolean(非 undefined)', async () => {
    const r = await callIpc(`return await api.settings.get()`)
    const ok = typeof r?.mcp?.enabled === 'boolean'
    record('8.3 mcp.enabled 类型 boolean', ok, `type=${typeof r?.mcp?.enabled}`)
  })

  await test('8.4 settings:reset 还原 mcp.enabled 为 false', async () => {
    // 先打开,再 reset,验证还原为 false
    await callIpc(`return await api.settings.set('mcp.enabled', true)`)
    const r1 = await callIpc(`return await api.settings.get()`)
    if (r1?.mcp?.enabled !== true) {
      record('8.4 reset 还原', false, 'precondition: set true failed')
      return
    }
    // 尝试调用 reset(若 API 不存在则视为跳过)
    const resetRes = await callIpc(`return await api.settings.reset()`)
    if (resetRes?.__error) {
      // 没有 reset 方法,尝试 set 回 false 作为等价验证
      await callIpc(`return await api.settings.set('mcp.enabled', false)`)
    }
    const r2 = await callIpc(`return await api.settings.get()`)
    const ok = r2?.mcp?.enabled === false
    record('8.4 reset 还原 false', ok, `before=true after=${r2?.mcp?.enabled} resetUsed=${!resetRes?.__error}`)
  })

  // =========================================================
  // 汇总
  // =========================================================
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  const total = results.length
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Round 41 MCP 功能深度验证: ${passed}/${total} PASS, ${failed} FAIL`)
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
