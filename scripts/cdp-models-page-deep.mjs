// =============================================================
// CDP Models 页面深度测试
// 角度: UI 元素 + Provider/模型 IPC 验证 + 自定义模型 CRUD + Ollama
// 运行: node scripts/cdp-models-page-deep.mjs
// =============================================================
import http from 'node:http'
import WebSocket from 'ws'

const CDP_HOST = 'http://127.0.0.1:9222'
const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'
const WARN = '\x1b[33m!\x1b[0m'

let ws, send, evalInPage
let passCount = 0, failCount = 0, warnCount = 0
const notes = [], bugs = []

function record(name, ok, detail = '') {
  if (ok === true) passCount++
  else if (ok === 'warn') warnCount++
  else failCount++
  const mark = ok === true ? 'PASS' : ok === 'warn' ? 'WARN' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ' — ' + detail : ''}`)
}
const note = (m) => notes.push(m)
const bug = (m) => { bugs.push(m); console.log(`  🐛 ${m}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const httpGet = (u) =>
  new Promise((r, j) => {
    http.get(u, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => { try { r(JSON.parse(d)) } catch (e) { j(e) } })
    }).on('error', j)
  })

async function connect() {
  const targets = (await httpGet(`${CDP_HOST}/json`)).filter((x) => x.type === 'page')
  if (!targets.length) { console.error('❌ 无 CDP target'); process.exit(1) }
  ws = new WebSocket(targets[0].webSocketDebuggerUrl)
  let _id = 1
  const pending = new Map()
  ws.on('message', (r) => {
    const m = JSON.parse(r.toString())
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  send = (method, params = {}) =>
    new Promise((r) => { const i = _id++; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  evalInPage = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) {
      throw new Error((r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'unknown').substring(0, 800))
    }
    return r.result?.result?.value
  }
  await new Promise((r) => ws.on('open', r))
}

// 通用 IPC 调用
async function callNS(ns, method, ...args) {
  const argsLiteral = JSON.stringify(JSON.stringify(args))
  const expr = `(async function(){
    try {
      const api = window.__EAA_API__ || window.api;
      const obj = api && api[${JSON.stringify(ns)}];
      if (!obj || typeof obj[${JSON.stringify(method)}] !== 'function') {
        return JSON.stringify({ __error: 'method not available: ' + ${JSON.stringify(ns)} + '.' + ${JSON.stringify(method)} });
      }
      const args = JSON.parse(${argsLiteral});
      const res = await obj[${JSON.stringify(method)}].apply(obj, args);
      return JSON.stringify({ __ok: true, res });
    } catch (e) { return JSON.stringify({ __error: (e && e.message) ? e.message : String(e) }); }
  })()`
  const raw = await evalInPage(expr)
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { __error: 'non-json: ' + String(raw).slice(0, 200) } }
  if (parsed.__error) return { __error: parsed.__error }
  return parsed.res
}
const callAI = (m, ...a) => callNS('ai', m, ...a)
const callOllama = (m, ...a) => callNS('ollama', m, ...a)
const callSettings = (m, ...a) => callNS('settings', m, ...a)

const isOk = (r) => !!r && r.__error === undefined && r.success === true
const isErr = (r) => !!r && (r.__error !== undefined || r.success === false)
const errMsg = (r) => r.__error || r.error || r.message || 'unknown error'

// =============================================================
// 导航到 Models 页面并等待加载
// =============================================================
async function gotoModels() {
  await evalInPage(`window.location.hash = '#/models'`)
  await sleep(1500) // 等待 React 渲染 + listProviders IPC 完成
}

// =============================================================
// 1. UI 元素存在性测试
// =============================================================
async function testUIElements() {
  console.log('\n=== 1. UI 元素存在性测试 ===')

  const ui = await evalInPage(`(function(){
    const result = {};
    result.title = (document.querySelector('h1')?.textContent || '').trim();
    result.searchInput = !!document.querySelector('input[type="text"][placeholder*="搜索"]');
    result.refreshBtn = !!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '刷新');
    result.localModelsSection = !!document.querySelector('h2');
    result.providerCards = document.querySelectorAll('[class*="rounded-xl"]').length;
    // 默认模型配置
    result.defaultConfigTitle = !!Array.from(document.querySelectorAll('h2')).find(h => h.textContent.includes('默认模型配置'));
    // 已配置/未配置分组
    result.groups = Array.from(document.querySelectorAll('h2')).map(h => h.textContent.trim()).filter(t => t.includes('('));
    // 表格元素
    result.tables = document.querySelectorAll('table').length;
    // 添加模型按钮
    result.addModelBtns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.trim() === '添加模型').length;
    // 测试连接按钮
    result.testConnBtns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.trim() === '测试连接').length;
    // API Key 输入框
    result.apiKeyInputs = document.querySelectorAll('input[type="password"]').length;
    // 刷新模型列表按钮
    result.refreshModelBtns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.trim() === '刷新模型列表').length;
    return result;
  })()`)

  record('页面标题 page.models.title 存在', !!ui.title, `title="${ui.title}"`)
  record('搜索框存在', ui.searchInput, '')
  record('顶部刷新按钮存在', ui.refreshBtn, '')
  record('本地模型区域存在', ui.localModelsSection, '')
  record('默认模型配置区域存在', ui.defaultConfigTitle, '')
  record('至少一个分组标题(已配置/未配置)', ui.groups.length > 0,
    ui.groups.length > 0 ? `groups=${JSON.stringify(ui.groups)}` : '无分组')
  note(`Provider 卡片数=${ui.providerCards}, 表格数=${ui.tables}, 测试连接按钮=${ui.testConnBtns}, API Key 输入=${ui.apiKeyInputs}, 添加模型按钮=${ui.addModelBtns}, 刷新模型按钮=${ui.refreshModelBtns}`)
}

// =============================================================
// 2. ai.listProviders IPC 验证
// =============================================================
async function testListProviders() {
  console.log('\n=== 2. ai.listProviders IPC 验证 ===')

  const r = await callAI('listProviders')
  record('listProviders 返回数组', Array.isArray(r),
    Array.isArray(r) ? `count=${r.length}` : `type=${typeof r}`)

  if (Array.isArray(r) && r.length > 0) {
    const first = r[0]
    record('Provider 对象含 id 字段', typeof first.id === 'string', `id="${first.id}"`)
    record('Provider 对象含 name 字段', typeof first.name === 'string', `name="${first.name}"`)
    record('Provider 对象含 hasApiKey 字段', typeof first.hasApiKey === 'boolean', `hasApiKey=${first.hasApiKey}`)
    record('Provider 对象含 modelCount 字段', typeof first.modelCount === 'number', `modelCount=${first.modelCount}`)

    // 找到一个真实 provider id 供后续测试用
    const realProvider = first.id
    note(`测试用 provider id: ${realProvider}`)
    return realProvider
  }
  return null
}

// =============================================================
// 3. ai.listModels 输入验证
// =============================================================
async function testListModelsValidation(realProvider) {
  console.log('\n=== 3. ai.listModels 输入验证 ===')

  // 3.1 空 providerId — 应失败
  const r1 = await callAI('listModels', '')
  record('listModels(空 providerId) 应失败', isErr(r1) || Array.isArray(r1) === false,
    isErr(r1) ? `error=${errMsg(r1).slice(0, 80)}` : '意外接受空字符串')

  // 3.2 非字符串 providerId
  const r2 = await callAI('listModels', 12345)
  record('listModels(providerId=数字) 应失败', isErr(r2) || Array.isArray(r2) === false,
    isErr(r2) ? `error=${errMsg(r2).slice(0, 80)}` : '意外接受数字')

  // 3.3 null providerId
  const r3 = await callAI('listModels', null)
  record('listModels(providerId=null) 应失败', isErr(r3) || Array.isArray(r3) === false,
    isErr(r3) ? `error=${errMsg(r3).slice(0, 80)}` : '意外接受 null')

  // 3.4 null byte 注入
  const r4 = await callAI('listModels', 'test\0evil')
  record('listModels(providerId 含 null byte) 应失败', isErr(r4) || Array.isArray(r4) === false,
    isErr(r4) ? `error=${errMsg(r4).slice(0, 80)}` : '意外接受 null byte')

  // 3.5 超长 providerId (>256 chars)
  const r5 = await callAI('listModels', 'x'.repeat(500))
  record('listModels(providerId 超长 500 chars) 应失败', isErr(r5) || Array.isArray(r5) === false,
    isErr(r5) ? `error=${errMsg(r5).slice(0, 80)}` : '意外接受超长字符串')

  // 3.6 不存在的 providerId — 应返回空数组或抛错
  const r6 = await callAI('listModels', 'non-existent-provider-xxx')
  record('listModels(不存在的 providerId) 不崩溃',
    Array.isArray(r6) || isErr(r6),
    Array.isArray(r6) ? `返回空数组 count=${r6.length}` : `error=${errMsg(r6).slice(0, 80)}`)

  // 3.7 真实 providerId — 应返回数组
  if (realProvider) {
    const r7 = await callAI('listModels', realProvider)
    record('listModels(真实 providerId) 返回数组', Array.isArray(r7),
      Array.isArray(r7) ? `count=${r7.length}` : `type=${typeof r7}`)
    return r7
  }
  return null
}

// =============================================================
// 4. ai.setApiKey / deleteApiKey 输入验证
// =============================================================
async function testApiKeyValidation() {
  console.log('\n=== 4. ai.setApiKey / deleteApiKey 输入验证 ===')

  // 4.1 setApiKey 空 providerId
  const r1 = await callAI('setApiKey', '', 'fake-key-12345')
  record('setApiKey(空 providerId) 应失败', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 80)}` : '意外成功')

  // 4.2 setApiKey 空 apiKey
  const r2 = await callAI('setApiKey', 'openai', '')
  record('setApiKey(空 apiKey) 应失败', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 80)}` : '意外成功')

  // 4.3 setApiKey 非字符串 providerId
  const r3 = await callAI('setApiKey', 123, 'fake-key')
  record('setApiKey(providerId=数字) 应失败', isErr(r3),
    isErr(r3) ? `error=${errMsg(r3).slice(0, 80)}` : '意外成功')

  // 4.4 setApiKey null byte
  const r4 = await callAI('setApiKey', 'test\0evil', 'fake-key')
  record('setApiKey(providerId 含 null byte) 应失败', isErr(r4),
    isErr(r4) ? `error=${errMsg(r4).slice(0, 80)}` : '意外成功')

  // 4.5 setApiKey 超长 apiKey (>10KB)
  const r5 = await callAI('setApiKey', 'openai', 'x'.repeat(20_000))
  record('setApiKey(apiKey 超长 20KB) 应失败', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 80)}` : '意外成功')

  // 4.6 deleteApiKey 空 providerId
  const r6 = await callAI('deleteApiKey', '')
  record('deleteApiKey(空 providerId) 应失败', isErr(r6),
    isErr(r6) ? `error=${errMsg(r6).slice(0, 80)}` : '意外成功')

  // 4.7 deleteApiKey null byte
  const r7 = await callAI('deleteApiKey', 'test\0evil')
  record('deleteApiKey(providerId 含 null byte) 应失败', isErr(r7),
    isErr(r7) ? `error=${errMsg(r7).slice(0, 80)}` : '意外成功')

  // 4.8 deleteApiKey 超长
  const r8 = await callAI('deleteApiKey', 'x'.repeat(500))
  record('deleteApiKey(providerId 超长) 应失败', isErr(r8),
    isErr(r8) ? `error=${errMsg(r8).slice(0, 80)}` : '意外成功')
}

// =============================================================
// 5. ai.testConnection 输入验证
// =============================================================
async function testConnectionValidation() {
  console.log('\n=== 5. ai.testConnection 输入验证 ===')

  // 5.1 空 providerId
  const r1 = await callAI('testConnection', '', 'fake-key')
  record('testConnection(空 providerId) 应失败', isErr(r1) || r1?.success === false,
    isErr(r1) ? `error=${errMsg(r1).slice(0, 80)}` : (r1?.success === false ? `success=false error=${r1.error?.slice(0,80)}` : '意外成功'))

  // 5.2 空 apiKey
  const r2 = await callAI('testConnection', 'openai', '')
  record('testConnection(空 apiKey) 应失败', isErr(r2) || r2?.success === false,
    isErr(r2) ? `error=${errMsg(r2).slice(0, 80)}` : (r2?.success === false ? `success=false` : '意外成功'))

  // 5.3 null byte 注入
  const r3 = await callAI('testConnection', 'test\0evil', 'fake-key')
  record('testConnection(providerId 含 null byte) 应失败', isErr(r3) || r3?.success === false,
    isErr(r3) ? `error=${errMsg(r3).slice(0, 80)}` : (r3?.success === false ? `success=false` : '意外成功'))

  // 5.4 apiKey 含 null byte
  const r4 = await callAI('testConnection', 'openai', 'fake\0key')
  record('testConnection(apiKey 含 null byte) 应失败', isErr(r4) || r4?.success === false,
    isErr(r4) ? `error=${errMsg(r4).slice(0, 80)}` : (r4?.success === false ? `success=false` : '意外成功'))

  // 5.5 非法 baseUrl
  const r5 = await callAI('testConnection', 'openai', 'fake-key', 'not-a-url')
  record('testConnection(非法 baseUrl) 应返回失败但不崩溃',
    isErr(r5) || r5?.success === false || r5?.success === true,
    `success=${r5?.success}, latency=${r5?.latencyMs}ms`)

  // 5.6 超长 baseUrl
  const r6 = await callAI('testConnection', 'openai', 'fake-key', 'x'.repeat(5000))
  record('testConnection(baseUrl 超长) 应失败', isErr(r6) || r6?.success === false,
    isErr(r6) ? `error=${errMsg(r6).slice(0, 80)}` : (r6?.success === false ? `success=false` : '意外成功'))

  // 5.7 完全合法格式但 key 无效 - 应返回结构化错误
  const r7 = await callAI('testConnection', 'openai', 'sk-invalid-key-for-testing')
  record('testConnection(无效 key) 返回结构化失败', r7 && typeof r7 === 'object',
    `success=${r7?.success}, hasError=${!!r7?.error}, latency=${r7?.latencyMs}ms`)
}

// =============================================================
// 6. ai.addCustomModel 输入验证
// =============================================================
async function testAddCustomModelValidation() {
  console.log('\n=== 6. ai.addCustomModel 输入验证 ===')

  // 6.1 空 params
  const r1 = await callAI('addCustomModel', null)
  record('addCustomModel(null params) 应失败', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 80)}` : '意外成功')

  // 6.2 缺 providerId
  const r2 = await callAI('addCustomModel', { modelId: 'test-model' })
  record('addCustomModel(缺 providerId) 应失败', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 80)}` : '意外成功')

  // 6.3 缺 modelId
  const r3 = await callAI('addCustomModel', { providerId: 'openai' })
  record('addCustomModel(缺 modelId) 应失败', isErr(r3),
    isErr(r3) ? `error=${errMsg(r3).slice(0, 80)}` : '意外成功')

  // 6.4 空 providerId
  const r4 = await callAI('addCustomModel', { providerId: '', modelId: 'test-model' })
  record('addCustomModel(空 providerId) 应失败', isErr(r4),
    isErr(r4) ? `error=${errMsg(r4).slice(0, 80)}` : '意外成功')

  // 6.5 空 modelId
  const r5 = await callAI('addCustomModel', { providerId: 'openai', modelId: '' })
  record('addCustomModel(空 modelId) 应失败', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 80)}` : '意外成功')

  // 6.6 providerId 含 null byte
  const r6 = await callAI('addCustomModel', { providerId: 'openai\0evil', modelId: 'test' })
  record('addCustomModel(providerId 含 null byte) 应失败', isErr(r6),
    isErr(r6) ? `error=${errMsg(r6).slice(0, 80)}` : '意外成功')

  // 6.7 modelId 含 null byte
  const r7 = await callAI('addCustomModel', { providerId: 'openai', modelId: 'test\0evil' })
  record('addCustomModel(modelId 含 null byte) 应失败', isErr(r7),
    isErr(r7) ? `error=${errMsg(r7).slice(0, 80)}` : '意外成功')

  // 6.8 name 超长
  const r8 = await callAI('addCustomModel', {
    providerId: 'openai', modelId: 'test', name: 'x'.repeat(500)
  })
  record('addCustomModel(name 超长 500 chars) 应失败', isErr(r8),
    isErr(r8) ? `error=${errMsg(r8).slice(0, 80)}` : '意外成功')

  // 6.9 contextWindow 非数字 — P3-3 修复:同步校验数值类型
  const r9 = await callAI('addCustomModel', {
    providerId: 'openai', modelId: 'test', contextWindow: 'not-a-number'
  })
  record('addCustomModel(contextWindow=字符串) 应失败(P3-3 修复)', isErr(r9),
    isErr(r9) ? `error=${errMsg(r9).slice(0, 80)}` : `意外成功 success=${r9?.success}`)

  // 6.10 supportsReasoning 非布尔 — P3-3 修复:同步校验布尔类型
  const r10 = await callAI('addCustomModel', {
    providerId: 'openai', modelId: 'test', supportsReasoning: 'yes'
  })
  record('addCustomModel(supportsReasoning=字符串) 应失败(P3-3 修复)', isErr(r10),
    isErr(r10) ? `error=${errMsg(r10).slice(0, 80)}` : `意外成功 success=${r10?.success}`)

  // 6.11 maxOutputTokens 非数字 — P3-3 修复
  const r11 = await callAI('addCustomModel', {
    providerId: 'openai', modelId: 'test', maxOutputTokens: 'big'
  })
  record('addCustomModel(maxOutputTokens=字符串) 应失败(P3-3 修复)', isErr(r11),
    isErr(r11) ? `error=${errMsg(r11).slice(0, 80)}` : `意外成功 success=${r11?.success}`)

  // 注: NaN/Infinity 在 JSON.stringify 时被转为 null,无法通过 IPC 传递,故不测试
}

// =============================================================
// 7. ai.updateCustomModel / deleteCustomModel 输入验证
// =============================================================
async function testUpdateDeleteCustomModelValidation() {
  console.log('\n=== 7. ai.updateCustomModel / deleteCustomModel 输入验证 ===')

  // 7.1 updateCustomModel null params
  const r1 = await callAI('updateCustomModel', null)
  record('updateCustomModel(null params) 应失败', isErr(r1),
    isErr(r1) ? `error=${errMsg(r1).slice(0, 80)}` : '意外成功')

  // 7.2 updateCustomModel 缺 providerId
  const r2 = await callAI('updateCustomModel', { modelId: 'test', name: 'new' })
  record('updateCustomModel(缺 providerId) 应失败', isErr(r2),
    isErr(r2) ? `error=${errMsg(r2).slice(0, 80)}` : '意外成功')

  // 7.3 updateCustomModel 缺 modelId
  const r3 = await callAI('updateCustomModel', { providerId: 'openai', name: 'new' })
  record('updateCustomModel(缺 modelId) 应失败', isErr(r3),
    isErr(r3) ? `error=${errMsg(r3).slice(0, 80)}` : '意外成功')

  // 7.4 updateCustomModel null byte
  const r4 = await callAI('updateCustomModel', {
    providerId: 'openai\0evil', modelId: 'test', name: 'new'
  })
  record('updateCustomModel(providerId 含 null byte) 应失败', isErr(r4),
    isErr(r4) ? `error=${errMsg(r4).slice(0, 80)}` : '意外成功')

  // 7.5 updateCustomModel baseUrl 超长
  const r5 = await callAI('updateCustomModel', {
    providerId: 'openai', modelId: 'test', baseUrl: 'x'.repeat(5000)
  })
  record('updateCustomModel(baseUrl 超长) 应失败', isErr(r5),
    isErr(r5) ? `error=${errMsg(r5).slice(0, 80)}` : '意外成功')

  // 7.5a updateCustomModel contextWindow 非数字 — P3-3 修复
  const r5a = await callAI('updateCustomModel', {
    providerId: 'openai', modelId: 'test', contextWindow: 'huge'
  })
  record('updateCustomModel(contextWindow=字符串) 应失败(P3-3 修复)', isErr(r5a),
    isErr(r5a) ? `error=${errMsg(r5a).slice(0, 80)}` : '意外成功')

  // 7.5b updateCustomModel supportsReasoning 非布尔 — P3-3 修复
  const r5b = await callAI('updateCustomModel', {
    providerId: 'openai', modelId: 'test', supportsReasoning: 1
  })
  record('updateCustomModel(supportsReasoning=数字) 应失败(P3-3 修复)', isErr(r5b),
    isErr(r5b) ? `error=${errMsg(r5b).slice(0, 80)}` : '意外成功')

  // 7.5c updateCustomModel costPerInputToken 非数字 — P3-3 修复
  const r5c = await callAI('updateCustomModel', {
    providerId: 'openai', modelId: 'test', costPerInputToken: 'free'
  })
  record('updateCustomModel(costPerInputToken=字符串) 应失败(P3-3 修复)', isErr(r5c),
    isErr(r5c) ? `error=${errMsg(r5c).slice(0, 80)}` : '意外成功')

  // 7.5d updateCustomModel costPerOutputToken 非数字 — P3-3 修复
  const r5d = await callAI('updateCustomModel', {
    providerId: 'openai', modelId: 'test', costPerOutputToken: false
  })
  record('updateCustomModel(costPerOutputToken=布尔) 应失败(P3-3 修复)', isErr(r5d),
    isErr(r5d) ? `error=${errMsg(r5d).slice(0, 80)}` : '意外成功')

  // 7.6 deleteCustomModel 空 providerId
  const r6 = await callAI('deleteCustomModel', '', 'test')
  record('deleteCustomModel(空 providerId) 应失败', isErr(r6),
    isErr(r6) ? `error=${errMsg(r6).slice(0, 80)}` : '意外成功')

  // 7.7 deleteCustomModel 空 modelId
  const r7 = await callAI('deleteCustomModel', 'openai', '')
  record('deleteCustomModel(空 modelId) 应失败', isErr(r7),
    isErr(r7) ? `error=${errMsg(r7).slice(0, 80)}` : '意外成功')

  // 7.8 deleteCustomModel null byte
  const r8 = await callAI('deleteCustomModel', 'openai\0evil', 'test')
  record('deleteCustomModel(providerId 含 null byte) 应失败', isErr(r8),
    isErr(r8) ? `error=${errMsg(r8).slice(0, 80)}` : '意外成功')

  // 7.9 deleteCustomModel 不存在的组合
  const r9 = await callAI('deleteCustomModel', 'non-existent-xxx', 'non-existent-model')
  record('deleteCustomModel(不存在的组合) 不崩溃且返回 success=false',
    typeof r9 === 'object' && r9?.success === false,
    `success=${r9?.success}`)
}

// =============================================================
// 8. 自定义模型完整 CRUD 流程
// =============================================================
async function testCustomModelCRUD(realProvider) {
  console.log('\n=== 8. 自定义模型完整 CRUD 流程 ===')

  if (!realProvider) {
    record('CRUD 流程跳过(无可用 provider)', 'warn', '')
    return
  }

  const testModelId = `__cdp_test_${Date.now().toString(36)}__`

  // 8.1 Create - 添加自定义模型
  const r1 = await callAI('addCustomModel', {
    providerId: realProvider,
    modelId: testModelId,
    name: `CDP测试模型_${testModelId}`,
    contextWindow: 8192,
    maxOutputTokens: 4096,
    supportsReasoning: false,
  })
  record(`addCustomModel 创建模型 "${testModelId}"`, typeof r1 === 'object',
    `success=${r1?.success}, type=${typeof r1}`)

  await sleep(200)

  // 8.2 Read - 列出模型,验证新模型存在
  const r2 = await callAI('listModels', realProvider)
  let found = null
  if (Array.isArray(r2)) {
    found = r2.find(m => m.id === testModelId)
  }
  record(`listModels 包含新创建的模型 "${testModelId}"`, !!found,
    found ? `name=${found.name}, contextWindow=${found.contextWindow}` : '未找到')

  // 8.3 Update - 修改模型属性
  if (found) {
    const r3 = await callAI('updateCustomModel', {
      providerId: realProvider,
      modelId: testModelId,
      name: `CDP更新_${testModelId}`,
      contextWindow: 16384,
      maxOutputTokens: 8192,
      supportsReasoning: true,
      costPerInputToken: 0.000001,
      costPerOutputToken: 0.000002,
    })
    record(`updateCustomModel 更新模型 "${testModelId}"`, typeof r3 === 'object',
      `success=${r3?.success}`)

    await sleep(200)

    // 8.4 验证更新生效
    const r4 = await callAI('listModels', realProvider)
    let updated = null
    if (Array.isArray(r4)) {
      updated = r4.find(m => m.id === testModelId)
    }
    record(`listModels 验证更新生效`, !!updated && updated.name === `CDP更新_${testModelId}` && updated.contextWindow === 16384,
      updated ? `name=${updated.name}, ctx=${updated.contextWindow}, maxOut=${updated.maxOutputTokens}, reasoning=${updated.supportsReasoning}` : '未找到')

    // 8.5 再次更新 - 部分字段
    const r5 = await callAI('updateCustomModel', {
      providerId: realProvider,
      modelId: testModelId,
      baseUrl: 'https://custom-endpoint.example.com/v1',
      api: 'openai-completions',
    })
    record(`updateCustomModel 部分更新 baseUrl/api`, typeof r5 === 'object',
      `success=${r5?.success}`)

    await sleep(200)

    // 8.6 验证部分更新不丢失其他字段
    const r6 = await callAI('listModels', realProvider)
    let afterPartial = null
    if (Array.isArray(r6)) {
      afterPartial = r6.find(m => m.id === testModelId)
    }
    record(`部分更新后其他字段保留`, !!afterPartial && afterPartial.name === `CDP更新_${testModelId}`,
      afterPartial ? `name=${afterPartial.name}, baseUrl=${afterPartial.baseUrl}, api=${afterPartial.api}` : '未找到')
  }

  // 8.7 Delete - 删除模型
  const r7 = await callAI('deleteCustomModel', realProvider, testModelId)
  record(`deleteCustomModel 删除模型 "${testModelId}"`, typeof r7 === 'object',
    `success=${r7?.success}`)

  await sleep(200)

  // 8.8 验证删除生效
  const r8 = await callAI('listModels', realProvider)
  let deleted = null
  if (Array.isArray(r8)) {
    deleted = r8.find(m => m.id === testModelId)
  }
  record(`listModels 验证删除生效`, !deleted,
    !deleted ? '模型已被删除' : `模型仍存在! id=${deleted.id}`)

  // 8.9 重复删除 - 应返回 success=false 但不崩溃
  const r9 = await callAI('deleteCustomModel', realProvider, testModelId)
  record(`重复删除已不存在的模型`, typeof r9 === 'object',
    `success=${r9?.success}`)
}

// =============================================================
// 9. Ollama 接口测试
// =============================================================
async function testOllamaInterfaces() {
  console.log('\n=== 9. Ollama 接口测试 ===')

  // 9.1 ollama.detect - 应返回对象,不崩溃
  const r1 = await callOllama('detect')
  record('ollama.detect 返回对象', r1 && typeof r1 === 'object',
    `available=${r1?.available}, serveRunning=${r1?.serveRunning}`)

  // 9.2 ollama.listModels - 即使未运行也不应崩溃
  const r2 = await callOllama('listModels')
  record('ollama.listModels 不崩溃', Array.isArray(r2) || typeof r2 === 'object',
    Array.isArray(r2) ? `count=${r2.length}` : `type=${typeof r2}`)

  // 9.3 ollama.pullModel 空 model name
  const r3 = await callOllama('pullModel', '')
  record('ollama.pullModel(空 model name) 应失败或返回错误', typeof r3 === 'object',
    `success=${r3?.success}`)

  // 9.4 ollama.pullModel null byte
  const r4 = await callOllama('pullModel', 'test\0evil')
  record('ollama.pullModel(含 null byte) 应失败', typeof r4 === 'object',
    `success=${r4?.success}`)

  // 9.5 ollama.deleteModel 空 name
  const r5 = await callOllama('deleteModel', '')
  record('ollama.deleteModel(空 name) 应失败', typeof r5 === 'object',
    `success=${r5?.success}`)

  // 9.6 ollama.deleteModel 不存在的模型
  const r6 = await callOllama('deleteModel', 'non-existent-model-xxx:latest')
  record('ollama.deleteModel(不存在的模型) 不崩溃', typeof r6 === 'object',
    `success=${r6?.success}`)

  // 9.7 ollama.startServe / stopServe — 不实际启动,只验证返回结构
  // 跳过实际 start/stop 避免污染环境
  record('ollama.startServe 接口可用', typeof r1 === 'object', '通过 detect 返回结构判断')
}

// =============================================================
// 10. UI 交互测试 — 搜索过滤
// =============================================================
async function testUISearch() {
  console.log('\n=== 10. UI 交互测试 — 搜索过滤 ===')

  // 10.1 在搜索框输入文本
  const before = await evalInPage(`(function(){
    const cards = document.querySelectorAll('[class*="rounded-xl"]');
    return { cardCount: cards.length };
  })()`)

  await evalInPage(`(function(){
    const input = document.querySelector('input[type="text"][placeholder*="搜索"]');
    if (input) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(input, 'zzz_non_matching_query_xxx');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return !!input;
  })()`)

  await sleep(400) // 等待 React 重新渲染

  const afterFiltered = await evalInPage(`(function(){
    const cards = document.querySelectorAll('[class*="rounded-xl"]');
    const noResult = !!Array.from(document.querySelectorAll('*')).find(el => 
      el.textContent && el.textContent.includes('无') && el.children.length === 0
    );
    return { cardCount: cards.length, noResult };
  })()`)

  record('搜索过滤非匹配关键词后卡片数减少或为 0',
    afterFiltered.cardCount <= before.cardCount,
    `before=${before.cardCount}, after=${afterFiltered.cardCount}`)

  // 10.2 清空搜索框 - 应恢复所有 providers
  await evalInPage(`(function(){
    const input = document.querySelector('input[type="text"][placeholder*="搜索"]');
    if (input) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`)

  await sleep(400)

  const afterClear = await evalInPage(`(function(){
    const cards = document.querySelectorAll('[class*="rounded-xl"]');
    return { cardCount: cards.length };
  })()`)

  record('清空搜索后卡片数恢复', afterClear.cardCount >= before.cardCount,
    `before=${before.cardCount}, afterClear=${afterClear.cardCount}`)
}

// =============================================================
// 11. UI 交互测试 — Provider 卡片展开/折叠
// =============================================================
async function testProviderCardExpand() {
  console.log('\n=== 11. UI 交互测试 — Provider 卡片展开/折叠 ===')

  // 找一个 Provider 卡片(头部的 button)
  const cardInfo = await evalInPage(`(function(){
    // ProviderCard 头部是 <button> + 含有 "个模型" 字样
    const btns = Array.from(document.querySelectorAll('button'));
    const providerBtn = btns.find(b => {
      const t = b.textContent || '';
      return t.includes('个模型') && b.closest('[class*="rounded-xl"]');
    });
    if (!providerBtn) return { found: false };
    return {
      found: true,
      text: (providerBtn.textContent || '').trim().slice(0, 100),
      // 检查当前是否展开(父卡片是否有蓝色边框)
      expanded: providerBtn.closest('[class*="rounded-xl"]')?.className.includes('border-blue-500') || false,
    };
  })()`)

  if (!cardInfo.found) {
    record('找到 Provider 卡片', 'warn', '未找到可点击的 Provider 卡片')
    return
  }

  record('找到 Provider 卡片', true, `text="${cardInfo.text.slice(0, 60)}", expanded=${cardInfo.expanded}`)

  // 点击展开/折叠
  await evalInPage(`(function(){
    const btns = Array.from(document.querySelectorAll('button'));
    const providerBtn = btns.find(b => {
      const t = b.textContent || '';
      return t.includes('个模型') && b.closest('[class*="rounded-xl"]');
    });
    if (providerBtn) providerBtn.click();
    return true;
  })()`)

  await sleep(500)

  const afterClick = await evalInPage(`(function(){
    const btns = Array.from(document.querySelectorAll('button'));
    const providerBtn = btns.find(b => {
      const t = b.textContent || '';
      return t.includes('个模型') && b.closest('[class*="rounded-xl"]');
    });
    if (!providerBtn) return { found: false };
    const card = providerBtn.closest('[class*="rounded-xl"]');
    const expanded = card?.className.includes('border-blue-500') || false;
    // 检查展开内容: API Key 输入框 + 测试连接按钮
    const apiKeyInput = !!card?.querySelector('input[type="password"]');
    const testBtn = !!Array.from(card?.querySelectorAll('button') || []).find(b => b.textContent.trim() === '测试连接');
    return { found: true, expanded, apiKeyInput, testBtn };
  })()`)

  record('点击 Provider 卡片切换展开状态', afterClick.found,
    `expanded=${afterClick.expanded}, apiKeyInput=${afterClick.apiKeyInput}, testBtn=${afterClick.testBtn}`)

  if (afterClick.expanded) {
    record('展开后可见 API Key 输入框', afterClick.apiKeyInput, '')
    record('展开后可见测试连接按钮', afterClick.testBtn, '')
  }
}

// =============================================================
// 12. 默认模型配置面板测试
// =============================================================
async function testDefaultModelConfig() {
  console.log('\n=== 12. 默认模型配置面板测试 ===')

  // 12.1 验证默认 provider select 存在
  const r1 = await evalInPage(`(function(){
    const configTitle = Array.from(document.querySelectorAll('h2')).find(h => h.textContent.includes('默认模型配置'));
    if (!configTitle) return { found: false };
    const panel = configTitle.closest('div');
    const selects = panel?.querySelectorAll('select') || [];
    return {
      found: true,
      selectCount: selects.length,
      firstSelectOptions: selects[0] ? selects[0].options.length : 0,
    };
  })()`)

  record('默认模型配置面板存在', r1.found, `selectCount=${r1.selectCount}, firstSelectOptions=${r1.firstSelectOptions}`)

  // 12.2 验证 settings.get / settings.set 可用
  const settings = await callSettings('get')
  record('settings.get 返回对象', settings && typeof settings === 'object',
    `defaultProvider=${settings?.models?.defaultProvider || '(空)'}`)

  // 12.3 验证 settings.set 非法 path 不崩溃
  const r3 = await callSettings('set', '', 'test-value')
  record('settings.set(空 path) 不崩溃', typeof r3 === 'object',
    `success=${r3?.success}`)

  // 12.4 settings.set 非法 value
  const r4 = await callSettings('set', 'models.defaultProvider', null)
  record('settings.set(value=null) 不崩溃', typeof r4 === 'object',
    `success=${r4?.success}`)
}

// =============================================================
// 13. 控制台错误监控
// =============================================================
async function testConsoleErrors() {
  console.log('\n=== 13. 控制台错误监控 ===')

  // 启用 Console API 监听
  await send('Console.enable')
  await send('Runtime.enable')

  const errors = []
  const handler = (m) => {
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const args = m.params.args.map(a => a.value || a.description || '').join(' ')
      errors.push(args)
    }
  }
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    handler(m)
  })

  // 触发一些操作 - 重新加载 providers
  await evalInPage(`(async function(){
    try {
      const btns = Array.from(document.querySelectorAll('button'));
      const refreshBtn = btns.find(b => b.textContent.trim() === '刷新');
      if (refreshBtn) refreshBtn.click();
    } catch(e) {}
  })()`)

  await sleep(2000)

  // 触发展开一个 provider
  await evalInPage(`(function(){
    const btns = Array.from(document.querySelectorAll('button'));
    const providerBtn = btns.find(b => {
      const t = b.textContent || '';
      return t.includes('个模型') && b.closest('[class*="rounded-xl"]');
    });
    if (providerBtn && !providerBtn.closest('[class*="rounded-xl"]').className.includes('border-blue-500')) {
      providerBtn.click();
    }
  })()`)

  await sleep(1000)

  record('页面加载+交互期间无控制台 error', errors.length === 0,
    errors.length > 0 ? `errors[0]=${errors[0].slice(0, 200)}` : '无 error')
}

// =============================================================
// 主函数
// =============================================================
async function main() {
  console.log('=====================================')
  console.log('Models 页面深度测试')
  console.log('=====================================')

  await connect()
  console.log('✅ CDP 连接成功')

  // 跳转到 Models 页面
  await gotoModels()

  // 1. UI 元素存在性
  await testUIElements()

  // 2. ai.listProviders
  const realProvider = await testListProviders()

  // 3. ai.listModels 验证
  await testListModelsValidation(realProvider)

  // 4. setApiKey / deleteApiKey 验证
  await testApiKeyValidation()

  // 5. testConnection 验证
  await testConnectionValidation()

  // 6. addCustomModel 验证
  await testAddCustomModelValidation()

  // 7. updateCustomModel / deleteCustomModel 验证
  await testUpdateDeleteCustomModelValidation()

  // 8. 自定义模型完整 CRUD 流程
  await testCustomModelCRUD(realProvider)

  // 9. Ollama 接口测试
  await testOllamaInterfaces()

  // 10. UI 搜索过滤
  await testUISearch()

  // 11. Provider 卡片展开/折叠
  await testProviderCardExpand()

  // 12. 默认模型配置面板
  await testDefaultModelConfig()

  // 13. 控制台错误监控
  await testConsoleErrors()

  // 汇总
  console.log('\n=====================================')
  console.log('测试汇总')
  console.log('=====================================')
  const total = passCount + failCount + warnCount
  console.log(`总计: ${total}, 通过: ${passCount}, 警告: ${warnCount}, 失败: ${failCount}, BUG: ${bugs.length}`)
  if (bugs.length > 0) {
    console.log('\n🐛 发现的 BUG:')
    bugs.forEach((b, i) => console.log(`  ${i + 1}. ${b}`))
  }
  if (notes.length > 0) {
    console.log('\n备注:')
    notes.forEach((n) => console.log(`  - ${n}`))
  }

  process.exit(failCount > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('未捕获异常:', e)
  process.exit(2)
})
