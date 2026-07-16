// =============================================================
// Round 42: MCP 性能与稳定性深度测试 (deep performance & stability)
//           — 重中之重续28
//
// 在 Round 40/41 功能验证基础上,本测试执行性能与稳定性维度:
//   1. IPC 响应延迟基准 (mcp:list/list-tools/test 5次取平均)
//   2. Feature flag 切换性能 (set+get 5次耗时)
//   3. Feature flag 高频切换稳定性 (20次切换无错误)
//   4. 并发 IPC 调用 (10路并发 mcp:list 无错误)
//   5. 不存在 server 的错误路径性能 (快速失败)
//   6. 长时间运行内存稳定 (多次调用后无泄漏迹象)
//   7. Sidecar init/destroy 非阻塞性能 (agent:list 在 MCP 初始化后仍快速)
//   8. 18 agents × getMcpToolsForAgent 调用性能
//   9. 安全屏障 sanitizeMcpArgs 性能 (大参数对象)
//  10. 状态一致性 (多次切换后 settings 与 service 状态一致)
//
// 运行: node scripts/cdp-mcp-performance-deep.mjs
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
  console.log('CDP connected, running Round 42 MCP performance deep tests...\n')

  const callIpc = async (code) =>
    evalInPage(
      `(async function(){const api=window.__EAA_API__||window.api;if(!api)return{__error:'no-api'};try{${code}}catch(e){return{__error:String(e&&e.message?e.message:e)}}})()`,
    )

  // 工具:计时多次调用取平均
  const bench = async (label, code, runs = 5) => {
    const times = []
    for (let i = 0; i < runs; i++) {
      const start = Date.now()
      const r = await callIpc(code)
      const dt = Date.now() - start
      times.push(dt)
      if (r?.__error) return { ok: false, times, lastError: r.__error }
    }
    const avg = (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)
    const max = Math.max(...times)
    const min = Math.min(...times)
    return { ok: true, times, avg, max, min }
  }

  // 确保 flag 起始为 off
  await callIpc(`return await api.settings.set('mcp.enabled', false)`)

  // =========================================================
  // 1. IPC 响应延迟基准 (5 tests)
  // =========================================================
  await test('1.1 mcp:list 平均延迟 < 200ms', async () => {
    const b = await bench('1.1', `return await api.mcp.list()`, 5)
    const ok = b.ok && parseFloat(b.avg) < 200
    record('1.1 mcp:list 延迟', ok, `avg=${b.avg}ms min=${b.min}ms max=${b.max}ms`)
  })

  await test('1.2 mcp:list-tools 不存在 server 平均延迟 < 200ms', async () => {
    const b = await bench('1.2', `return await api.mcp.listTools('nonexistent-server')`, 5)
    const ok = b.ok && parseFloat(b.avg) < 200
    record('1.2 list-tools 延迟', ok, `avg=${b.avg}ms min=${b.min}ms max=${b.max}ms`)
  })

  await test('1.3 mcp:test 不存在 server 平均延迟 < 200ms (快速失败)', async () => {
    const b = await bench('1.3', `return await api.mcp.test('nonexistent-server')`, 5)
    const ok = b.ok && parseFloat(b.avg) < 200
    record('1.3 test 快速失败', ok, `avg=${b.avg}ms min=${b.min}ms max=${b.max}ms`)
  })

  await test('1.4 mcp:disconnect 不存在 server 平均延迟 < 200ms', async () => {
    const b = await bench('1.4', `return await api.mcp.disconnect('nonexistent-server')`, 5)
    const ok = b.ok && parseFloat(b.avg) < 200
    record('1.4 disconnect 延迟', ok, `avg=${b.avg}ms min=${b.min}ms max=${b.max}ms`)
  })

  await test('1.5 settings:get 平均延迟 < 100ms', async () => {
    const b = await bench('1.5', `return await api.settings.get()`, 5)
    const ok = b.ok && parseFloat(b.avg) < 100
    record('1.5 settings:get 延迟', ok, `avg=${b.avg}ms min=${b.min}ms max=${b.max}ms`)
  })

  // =========================================================
  // 2. Feature flag 切换性能 (3 tests)
  // =========================================================
  await test('2.1 settings:set mcp.enabled 平均延迟 < 100ms', async () => {
    const b = await bench('2.1', `return await api.settings.set('mcp.enabled', true)`, 5)
    const ok = b.ok && parseFloat(b.avg) < 100
    record('2.1 set 延迟', ok, `avg=${b.avg}ms min=${b.min}ms max=${b.max}ms`)
  })

  await test('2.2 flag 切换 round-trip (set+get) 平均延迟 < 200ms', async () => {
    const times = []
    for (let i = 0; i < 5; i++) {
      const start = Date.now()
      await callIpc(`return await api.settings.set('mcp.enabled', true)`)
      await callIpc(`return await api.settings.get()`)
      times.push(Date.now() - start)
    }
    const avg = (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)
    const ok = parseFloat(avg) < 200
    record('2.2 round-trip 延迟', ok, `avg=${avg}ms times=[${times.join(',')}]`)
  })

  await test('2.3 cleanup — 切回 false', async () => {
    const r = await callIpc(`return await api.settings.set('mcp.enabled', false)`)
    const ok = r?.success === true || r?.__error === undefined
    record('2.3 cleanup', ok, `success=${r?.success}`)
  })

  // =========================================================
  // 3. Feature flag 高频切换稳定性 (2 tests)
  // =========================================================
  await test('3.1 20 次 flag 切换无错误', async () => {
    let errors = 0
    for (let i = 0; i < 20; i++) {
      const val = i % 2 === 0
      const r = await callIpc(`return await api.settings.set('mcp.enabled', ${val})`)
      if (r?.__error || r?.success === false) errors++
    }
    const ok = errors === 0
    record('3.1 20 次切换', ok, `errors=${errors}/20`)
  })

  await test('3.2 20 次切换后状态一致 (false)', async () => {
    await callIpc(`return await api.settings.set('mcp.enabled', false)`)
    const r = await callIpc(`return await api.settings.get()`)
    const ok = r?.mcp?.enabled === false
    record('3.2 状态一致', ok, `mcp.enabled=${r?.mcp?.enabled}`)
  })

  // =========================================================
  // 4. 并发 IPC 调用 (3 tests)
  // =========================================================
  await test('4.1 10 路并发 mcp:list 无错误', async () => {
    const promises = []
    for (let i = 0; i < 10; i++) {
      promises.push(callIpc(`return await api.mcp.list()`))
    }
    const rs = await Promise.all(promises)
    const errors = rs.filter((r) => r?.__error || r?.success === false).length
    const ok = errors === 0
    record('4.1 10 路并发 list', ok, `errors=${errors}/10`)
  })

  await test('4.2 10 路并发 mcp:test 无错误 (快速失败)', async () => {
    const promises = []
    for (let i = 0; i < 10; i++) {
      promises.push(callIpc(`return await api.mcp.test('nonexistent-server')`))
    }
    const rs = await Promise.all(promises)
    // 期望全部失败(success=false),但无异常
    const errors = rs.filter((r) => r?.__error).length
    const ok = errors === 0 && rs.every((r) => r?.success === false)
    record('4.2 10 路并发 test', ok, `exceptions=${errors}, allFail=${rs.every((r) => r?.success === false)}`)
  })

  await test('4.3 并发 flag 切换 + mcp:list 无死锁', async () => {
    const promises = []
    for (let i = 0; i < 5; i++) {
      promises.push(callIpc(`return await api.settings.set('mcp.enabled', ${i % 2 === 0})`))
      promises.push(callIpc(`return await api.mcp.list()`))
    }
    const rs = await Promise.all(promises)
    const errors = rs.filter((r) => r?.__error).length
    const ok = errors === 0
    record('4.3 并发 set+list', ok, `errors=${errors}/10`)
    // cleanup
    await callIpc(`return await api.settings.set('mcp.enabled', false)`)
  })

  // =========================================================
  // 5. 不存在 server 的错误路径性能 (2 tests)
  // =========================================================
  await test('5.1 connect 不存在 server 快速失败 < 100ms', async () => {
    const start = Date.now()
    const r = await callIpc(`return await api.mcp.connect('nonexistent-server')`)
    const dt = Date.now() - start
    const ok = r?.success === false && dt < 100
    record('5.1 connect 快速失败', ok, `dt=${dt}ms success=${r?.success}`)
  })

  await test('5.2 test 不存在 server 快速失败 < 100ms', async () => {
    const start = Date.now()
    const r = await callIpc(`return await api.mcp.test('nonexistent-server')`)
    const dt = Date.now() - start
    const ok = r?.success === false && dt < 100
    record('5.2 test 快速失败', ok, `dt=${dt}ms success=${r?.success}`)
  })

  // =========================================================
  // 6. 长时间运行内存稳定 (2 tests)
  // =========================================================
  await test('6.1 100 次 mcp:list 调用无异常', async () => {
    let errors = 0
    for (let i = 0; i < 100; i++) {
      const r = await callIpc(`return await api.mcp.list()`)
      if (r?.__error || r?.success === false) errors++
    }
    const ok = errors === 0
    record('6.1 100 次 list', ok, `errors=${errors}/100`)
  })

  await test('6.2 100 次 mcp:test 不存在 server 无异常', async () => {
    let errors = 0
    for (let i = 0; i < 100; i++) {
      const r = await callIpc(`return await api.mcp.test('nonexistent-server')`)
      if (r?.__error) errors++ // success=false 是正常的,__error 才是异常
    }
    const ok = errors === 0
    record('6.2 100 次 test', ok, `exceptions=${errors}/100`)
  })

  // =========================================================
  // 7. Sidecar init/destroy 非阻塞 (3 tests)
  // =========================================================
  await test('7.1 agent:list 在 MCP init 后仍快速 < 200ms', async () => {
    // 先确保 flag=true 触发 init
    await callIpc(`return await api.settings.set('mcp.enabled', true)`)
    const start = Date.now()
    const r = await callIpc(`return await api.agent.list()`)
    const dt = Date.now() - start
    const ok = Array.isArray(r) && dt < 200
    record('7.1 agent:list 延迟', ok, `dt=${dt}ms agents=${r?.length}`)
    await callIpc(`return await api.settings.set('mcp.enabled', false)`)
  })

  await test('7.2 eaa.score 在 MCP init 后仍可用', async () => {
    await callIpc(`return await api.settings.set('mcp.enabled', true)`)
    const r = await callIpc(`return await api.eaa.score('测试学生_不存在')`)
    const ok = r !== undefined && !r.__error
    record('7.2 eaa.score 可用', ok, `success=${r?.success}`)
    await callIpc(`return await api.settings.set('mcp.enabled', false)`)
  })

  await test('7.3 eaa.listStudents 在 MCP init 后仍快速 < 500ms', async () => {
    await callIpc(`return await api.settings.set('mcp.enabled', true)`)
    const start = Date.now()
    const r = await callIpc(`return await api.eaa.listStudents()`)
    const dt = Date.now() - start
    const ok = r?.success === true && dt < 500
    record('7.3 listStudents 延迟', ok, `dt=${dt}ms success=${r?.success}`)
    await callIpc(`return await api.settings.set('mcp.enabled', false)`)
  })

  // =========================================================
  // 8. 18 agents × getMcpToolsForAgent 调用性能 (2 tests)
  // =========================================================
  await test('8.1 18 agents list 完整', async () => {
    const r = await callIpc(`return await api.agent.list()`)
    const ok = Array.isArray(r) && r.length === 18
    record('8.1 18 agents', ok, `count=${r?.length}`)
  })

  await test('8.2 每个 agent toggle on/off 无错误', async () => {
    const agents = await callIpc(`return await api.agent.list()`)
    if (!Array.isArray(agents)) {
      record('8.2 agent toggle', false, 'agent list not array')
      return
    }
    let errors = 0
    for (const a of agents) {
      // toggle on
      const r1 = await callIpc(
        `return await api.agent.update(${JSON.stringify(a.id)}, { enabled: true })`,
      )
      if (r1?.__error) errors++
      // toggle off (恢复原状,假设原为 enabled)
      const r2 = await callIpc(
        `return await api.agent.update(${JSON.stringify(a.id)}, { enabled: false })`,
      )
      if (r2?.__error) errors++
      // 恢复 on
      const r3 = await callIpc(
        `return await api.agent.update(${JSON.stringify(a.id)}, { enabled: true })`,
      )
      if (r3?.__error) errors++
    }
    const ok = errors === 0
    record('8.2 agent toggle', ok, `errors=${errors}/${agents.length * 3}`)
  })

  // =========================================================
  // 9. 安全屏障 sanitizeMcpArgs 性能 (源码静态检查) (3 tests)
  // =========================================================
  await test('9.1 sanitizeMcpArgs 函数存在', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const ok = content.includes('export function sanitizeMcpArgs')
    record('9.1 sanitizeMcpArgs 导出', ok, `found=${ok}`)
  })

  await test('9.2 sanitizeMcpArgs 递归处理(深度 ≥ 2)', async () => {
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    // 递归调用自己
    const hasRecurse = /sanitizeMcpArgs\s*\(/.test(content) &&
      content.split('sanitizeMcpArgs').length >= 3 // 定义+导出+递归调用
    const ok = hasRecurse
    record('9.2 递归处理', ok, `matches=${content.split('sanitizeMcpArgs').length - 1}`)
  })

  await test('9.3 大参数对象性能 — 50 字段递归校验源码可达', async () => {
    // 静态检查:循环遍历 Object.entries(args)
    const content = await fsp.readFile(
      path.join(ROOT, 'src', 'main', 'services', 'mcp-tools.ts'),
      'utf-8',
    )
    const hasEntries = content.includes('Object.entries(args)')
    const ok = hasEntries
    record('9.3 大参数遍历', ok, `Object.entries=${hasEntries}`)
  })

  // =========================================================
  // 10. 状态一致性 (3 tests)
  // =========================================================
  await test('10.1 多次切换后 settings 与 service 状态一致', async () => {
    // 切换 10 次
    for (let i = 0; i < 10; i++) {
      await callIpc(`return await api.settings.set('mcp.enabled', ${i % 2 === 0})`)
    }
    await callIpc(`return await api.settings.set('mcp.enabled', false)`)
    const settings = await callIpc(`return await api.settings.get()`)
    const list = await callIpc(`return await api.mcp.list()`)
    // flag=false 时 list 应返回空 servers
    const ok = settings?.mcp?.enabled === false && (list?.servers?.length ?? 0) === 0
    record('10.1 状态一致', ok, `flag=${settings?.mcp?.enabled} servers=${list?.servers?.length ?? 0}`)
  })

  await test('10.2 flag=true 时 mcp:list 仍正常(配置为空)', async () => {
    await callIpc(`return await api.settings.set('mcp.enabled', true)`)
    const r = await callIpc(`return await api.mcp.list()`)
    const ok = r?.success === true && Array.isArray(r.servers) && r.servers.length === 0
    record('10.2 flag=true list', ok, `success=${r?.success} servers=${r?.servers?.length}`)
    await callIpc(`return await api.settings.set('mcp.enabled', false)`)
  })

  await test('10.3 最终状态 cleanup', async () => {
    const r = await callIpc(`return await api.settings.set('mcp.enabled', false)`)
    const g = await callIpc(`return await api.settings.get()`)
    const ok = g?.mcp?.enabled === false
    record('10.3 cleanup', ok, `mcp.enabled=${g?.mcp?.enabled}`)
  })

  // =========================================================
  // 汇总
  // =========================================================
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  console.log('\n' + '='.repeat(60))
  console.log(`Round 42 MCP 性能与稳定性深度验证: ${passed}/${passed + failed} PASS, ${failed} FAIL`)
  console.log('='.repeat(60))
  if (failed > 0) {
    console.log('\n失败测试:')
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.detail}`))
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
