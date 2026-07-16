// =============================================================
// Ollama / Feishu / Tray IPC 集成深度测试 (CDP / IPC 级)
// 覆盖:
//   - api.ollama / api.feishu / api.settings(tray 控制) 命名空间与方法存在性
//   - Ollama: detect / listModels / startServe / stopServe 在服务未运行时优雅降级
//   - Ollama: pullModel / deleteModel 参数校验 (空/null/超长/注入/非法格式)
//   - Feishu: status 在未配置时返回 'no cached token' 字符串 (不崩溃)
//   - Feishu: syncNow 在凭证未配置时返回 {success:false, skipped} (优雅降级, 无网络)
//   - Feishu: test / listBitable / send / bot* 输入校验与未配置优雅行为
//   - Tray: general.minimizeToTray 设置读取/写入/往返一致性 + 边界值不崩溃
//   - 错误处理: 所有调用返回结构化响应, 不抛未捕获异常
// 连接: CDP http://127.0.0.1:9222, 通过 Runtime.evaluate 调用
//       渲染进程 IPC API (window.__EAA_API__ || window.api)
//
// 注意: 为保证测试快速且确定性, 仅触发校验拒绝路径与本地降级路径,
//       不发起真实外网请求 (feishu.test 仅测非法 appId; syncNow 走 skipped 分支)。
// 运行: node scripts/cdp-integrations-deep.mjs
// =============================================================
import http from 'node:http'

const CDP_PORT = 9222
const BASE = `http://127.0.0.1:${CDP_PORT}`

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error(`JSON parse fail: ${e.message}`))
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
  // 包装每个测试: 捕获未预期异常, 不中断后续测试
  const test = (name, fn) =>
    fn().catch((err) =>
      record(name, false, `异常: ${String(err && err.message ? err.message : err).slice(0, 200)}`),
    )

  // ---------- CDP 连接 ----------
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
    new Promise((resolve, reject) => {
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
      throw new Error(`Eval error: ${r.result.exceptionDetails.text}`)
    }
    return r.result?.result?.value
  }

  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP connected, running Ollama / Feishu / Tray integration deep tests...\n')

  // ---------- IPC 封装 (统一 try/catch, 返回 {__error} 而非抛出) ----------
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

  // ---------- 业务 helper ----------
  const ollamaDetect = () => callIpc(`return await api.ollama.detect();`)
  const ollamaStartServe = () => callIpc(`return await api.ollama.startServe();`)
  const ollamaStopServe = () => callIpc(`return await api.ollama.stopServe();`)
  const ollamaListModels = () => callIpc(`return await api.ollama.listModels();`)
  const ollamaPullModel = (name) =>
    callIpc(`return await api.ollama.pullModel(${JSON.stringify(name)});`)
  const ollamaPullModelRaw = (expr) => callIpc(`return await api.ollama.pullModel(${expr});`)
  const ollamaDeleteModel = (name) =>
    callIpc(`return await api.ollama.deleteModel(${JSON.stringify(name)});`)
  const ollamaDeleteModelRaw = (expr) => callIpc(`return await api.ollama.deleteModel(${expr});`)

  const feishuStatus = () => callIpc(`return await api.feishu.status();`)
  const feishuSyncNow = (appId, appToken, tableId, fields) =>
    callIpc(
      `return await api.feishu.syncNow(${JSON.stringify(appId)}, ${JSON.stringify(appToken)}, ${JSON.stringify(tableId)}, ${JSON.stringify(fields)});`,
    )
  const feishuSyncNowRaw = (appIdExpr, appTokenExpr, tableIdExpr, fieldsExpr) =>
    callIpc(
      `return await api.feishu.syncNow(${appIdExpr}, ${appTokenExpr}, ${tableIdExpr}, ${fieldsExpr});`,
    )
  const feishuTest = (appId) => callIpc(`return await api.feishu.test(${JSON.stringify(appId)});`)
  const feishuTestRaw = (expr) => callIpc(`return await api.feishu.test(${expr});`)
  const feishuListBitable = (appId, appToken) =>
    callIpc(
      `return await api.feishu.listBitable(${JSON.stringify(appId)}, ${JSON.stringify(appToken)});`,
    )
  const feishuSend = (appId, openId, text) =>
    callIpc(
      `return await api.feishu.send(${JSON.stringify(appId)}, ${JSON.stringify(openId)}, ${JSON.stringify(text)});`,
    )
  const feishuSendRaw = (appIdExpr, openIdExpr, textExpr) =>
    callIpc(`return await api.feishu.send(${appIdExpr}, ${openIdExpr}, ${textExpr});`)
  const feishuBotStatus = () => callIpc(`return await api.feishu.botStatus();`)
  const feishuBotStart = () => callIpc(`return await api.feishu.botStart();`)
  const feishuBotStop = () => callIpc(`return await api.feishu.botStop();`)

  const getSettings = () => callIpc(`return await api.settings.get();`)
  const setSetting = (path, value) =>
    callIpc(`return await api.settings.set(${JSON.stringify(path)}, ${JSON.stringify(value)});`)
  const setSettingRaw = (pathExpr, valueExpr) =>
    callIpc(`return await api.settings.set(${pathExpr}, ${valueExpr});`)

  // ---------- 期望判定 helper ----------
  // 结构化响应: 非空且为 array/string/含 success|error|available|status|skipped|exists 字段的对象
  const isStructured = (r) =>
    r != null &&
    r.__error === undefined &&
    (Array.isArray(r) ||
      typeof r === 'string' ||
      (typeof r === 'object' &&
        ('success' in r ||
          'error' in r ||
          'available' in r ||
          'status' in r ||
          'skipped' in r ||
          'exists' in r ||
          'general' in r)))
  const isSuccess = (r) => !!r && !r.__error && r.success === true
  const isRejected = (r) => !!r && (r.__error || r.success === false)
  const notCrash = (r) =>
    r != null && (r.__error || r.success === true || r.success === false || typeof r === 'string' || Array.isArray(r))
  const isBool = (v) => v === true || v === false

  // 跟踪需要还原的设置
  let initialMinimizeToTray = null

  // ============================================================
  // A. API 存在性
  // ============================================================
  console.log('━━━ A. API 存在性 ━━━')

  await test('A1. window.api 对象存在 (window.__EAA_API__ || window.api)', async () => {
    const r = await evalInPage(
      `(function(){ const api = window.__EAA_API__ || window.api; return !!api; })()`,
    )
    record('A1. window.api 对象存在 (window.__EAA_API__ || window.api)', r === true, `api=${r}`)
  })

  await test('A2. api.ollama 命名空间存在', async () => {
    const r = await callIpc(`return { hasOllama: !!api.ollama };`)
    record('A2. api.ollama 命名空间存在', !!r && r.hasOllama === true, `hasOllama=${r?.hasOllama}`)
  })

  await test('A3. api.feishu 命名空间存在', async () => {
    const r = await callIpc(`return { hasFeishu: !!api.feishu };`)
    record('A3. api.feishu 命名空间存在', !!r && r.hasFeishu === true, `hasFeishu=${r?.hasFeishu}`)
  })

  await test('A4. api.settings 命名空间存在 (Tray 通过 minimizeToTray 设置控制)', async () => {
    const r = await callIpc(`return { hasSettings: !!api.settings };`)
    record(
      'A4. api.settings 命名空间存在 (Tray 通过 minimizeToTray 设置控制)',
      !!r && r.hasSettings === true,
      `hasSettings=${r?.hasSettings}`,
    )
  })

  await test('A5. api.ollama 拥有全部预期方法', async () => {
    const expected = ['detect', 'startServe', 'stopServe', 'listModels', 'pullModel', 'deleteModel']
    const r = await callIpc(
      `const exp = ${JSON.stringify(expected)}; const out = {}; for (const m of exp) out[m] = typeof api.ollama[m]; return out;`,
    )
    const allFn = !!r && expected.every((m) => r[m] === 'function')
    record('A5. api.ollama 拥有全部预期方法', allFn, `methods=${JSON.stringify(r ?? {}).slice(0, 160)}`)
  })

  await test('A6. api.feishu 拥有全部预期方法', async () => {
    const expected = [
      'test',
      'listBitable',
      'send',
      'status',
      'syncNow',
      'botStart',
      'botStop',
      'botStatus',
    ]
    const r = await callIpc(
      `const exp = ${JSON.stringify(expected)}; const out = {}; for (const m of exp) out[m] = typeof api.feishu[m]; return out;`,
    )
    const allFn = !!r && expected.every((m) => r[m] === 'function')
    record('A6. api.feishu 拥有全部预期方法', allFn, `methods=${JSON.stringify(r ?? {}).slice(0, 160)}`)
  })

  await test('A7. api.settings 拥有预期方法 (get/set/reset)', async () => {
    const r = await callIpc(
      `return { get: typeof api.settings.get, set: typeof api.settings.set, reset: typeof api.settings.reset };`,
    )
    const ok = !!r && r.get === 'function' && r.set === 'function' && r.reset === 'function'
    record('A7. api.settings 拥有预期方法 (get/set/reset)', ok, `get=${r?.get} set=${r?.set} reset=${r?.reset}`)
  })

  await test('A8. 事件订阅方法为函数 (onPullProgress / onBotStatusUpdate)', async () => {
    const r = await callIpc(
      `return { onPullProgress: typeof api.ollama.onPullProgress, onBotStatusUpdate: typeof api.feishu.onBotStatusUpdate };`,
    )
    const ok = !!r && r.onPullProgress === 'function' && r.onBotStatusUpdate === 'function'
    record(
      'A8. 事件订阅方法为函数 (onPullProgress / onBotStatusUpdate)',
      ok,
      `onPullProgress=${r?.onPullProgress} onBotStatusUpdate=${r?.onBotStatusUpdate}`,
    )
  })

  // ============================================================
  // B. Ollama 状态 — 服务未运行时优雅降级
  // ============================================================
  console.log('\n━━━ B. Ollama 状态 (服务未运行时优雅降级) ━━━')

  let detectResult = null
  await test('B9. ollama.detect 返回结构化对象 (不崩溃)', async () => {
    const r = await ollamaDetect()
    detectResult = r
    record(
      'B9. ollama.detect 返回结构化对象 (不崩溃)',
      isStructured(r),
      `available=${r?.available} serveRunning=${r?.serveRunning}`,
    )
  })

  await test('B10. ollama.detect.serveRunning 为布尔值 (未运行时为 false)', async () => {
    const r = detectResult ?? (await ollamaDetect())
    const ok = isStructured(r) && isBool(r.serveRunning)
    record(
      'B10. ollama.detect.serveRunning 为布尔值 (未运行时为 false)',
      ok && r.serveRunning === false,
      `serveRunning=${r?.serveRunning}`,
    )
  })

  await test('B11. ollama.detect.available 为布尔值', async () => {
    const r = detectResult ?? (await ollamaDetect())
    const ok = isStructured(r) && isBool(r.available)
    record('B11. ollama.detect.available 为布尔值', ok, `available=${r?.available}`)
  })

  await test('B12. ollama.detect.binaryPath 为 string|undefined', async () => {
    const r = detectResult ?? (await ollamaDetect())
    const ok = isStructured(r) && (typeof r.binaryPath === 'string' || r.binaryPath === undefined)
    record(
      'B12. ollama.detect.binaryPath 为 string|undefined',
      ok,
      `binaryPath=${r?.binaryPath ? String(r.binaryPath).slice(0, 60) : r?.binaryPath}`,
    )
  })

  await test('B13. ollama.startServe 返回结构化 {success:boolean} (无二进制时不崩溃)', async () => {
    const r = await ollamaStartServe()
    record(
      'B13. ollama.startServe 返回结构化 {success:boolean} (无二进制时不崩溃)',
      isStructured(r) && isBool(r.success),
      `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`,
    )
  })

  // ============================================================
  // C. Ollama listModels — 未运行时返回空数组
  // ============================================================
  console.log('\n━━━ C. Ollama listModels (未运行时返回空数组) ━━━')

  await test('C14. ollama.listModels 返回数组 (不崩溃)', async () => {
    const r = await ollamaListModels()
    record('C14. ollama.listModels 返回数组 (不崩溃)', Array.isArray(r), `type=${Array.isArray(r) ? 'array' : typeof r}`)
  })

  await test('C15. ollama.listModels 服务未运行时返回空数组 (非 null/undefined)', async () => {
    const r = await ollamaListModels()
    const ok = Array.isArray(r) && r.length === 0
    record(
      'C15. ollama.listModels 服务未运行时返回空数组 (非 null/undefined)',
      ok,
      `len=${Array.isArray(r) ? r.length : 'N/A'}`,
    )
  })

  await test('C16. ollama.stopServe 返回结构化 {success:true} (无运行进程也不崩溃)', async () => {
    const r = await ollamaStopServe()
    record(
      'C16. ollama.stopServe 返回结构化 {success:true} (无运行进程也不崩溃)',
      isStructured(r) && r.success === true,
      `success=${r?.success}`,
    )
  })

  // ============================================================
  // D. Ollama pullModel / deleteModel 参数校验 (拒绝路径, 无网络)
  // ============================================================
  console.log('\n━━━ D. Ollama pullModel / deleteModel 参数校验 ━━━')

  await test('D17. pullModel("") 被拒绝 (空模型名)', async () => {
    const r = await ollamaPullModel('')
    record('D17. pullModel("") 被拒绝 (空模型名)', isRejected(r), `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('D18. pullModel(null) 被拒绝 (非字符串)', async () => {
    const r = await ollamaPullModelRaw('null')
    record('D18. pullModel(null) 被拒绝 (非字符串)', isRejected(r), `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('D19. pullModel(undefined) 被拒绝', async () => {
    const r = await ollamaPullModelRaw('undefined')
    record('D19. pullModel(undefined) 被拒绝', isRejected(r), `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('D20. pullModel("invalid name") 被拒绝 (含空格非法格式)', async () => {
    const r = await ollamaPullModel('invalid name')
    record('D20. pullModel("invalid name") 被拒绝 (含空格非法格式)', isRejected(r), `success=${r?.success} err=${String(r?.error ?? '').slice(0, 60)}`)
  })

  await test('D21. pullModel("; rm -rf /") 被拒绝 (命令注入尝试)', async () => {
    const r = await ollamaPullModel('; rm -rf /')
    record('D21. pullModel("; rm -rf /") 被拒绝 (命令注入尝试)', isRejected(r), `success=${r?.success} err=${String(r?.error ?? '').slice(0, 60)}`)
  })

  await test('D22. pullModel(超长 129 字符) 被拒绝', async () => {
    const r = await ollamaPullModel('a'.repeat(129))
    record('D22. pullModel(超长 129 字符) 被拒绝', isRejected(r), `success=${r?.success} err=${String(r?.error ?? '').slice(0, 60)}`)
  })

  await test('D23. deleteModel("") 被拒绝 (空模型名)', async () => {
    const r = await ollamaDeleteModel('')
    record('D23. deleteModel("") 被拒绝 (空模型名)', isRejected(r), `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('D24. deleteModel(null) 被拒绝 (非字符串)', async () => {
    const r = await ollamaDeleteModelRaw('null')
    record('D24. deleteModel(null) 被拒绝 (非字符串)', isRejected(r), `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('D25. pullModel 合法格式名 + serve 未运行 → 优雅返回 {success:false} (连接拒绝快速失败)', async () => {
    const r = await ollamaPullModel('qwen3:1.7b')
    // serve 未运行时 fetch 到 127.0.0.1:11434 连接被拒, 返回 {success:false, error}
    record(
      'D25. pullModel 合法格式名 + serve 未运行 → 优雅返回 {success:false} (连接拒绝快速失败)',
      notCrash(r) && r?.success === false,
      `success=${r?.success} err=${String(r?.error ?? '').slice(0, 60)}`,
    )
  })

  // ============================================================
  // E. Feishu status — 未配置时优雅
  // ============================================================
  console.log('\n━━━ E. Feishu status (未配置时优雅) ━━━')

  await test('E26. feishu.status 返回结构化值 (字符串或对象, 不崩溃)', async () => {
    const r = await feishuStatus()
    record(
      'E26. feishu.status 返回结构化值 (字符串或对象, 不崩溃)',
      isStructured(r) || typeof r === 'string',
      `type=${typeof r} value=${String(r).slice(0, 60)}`,
    )
  })

  await test('E27. feishu.status 未配置时返回字符串 (如 "no cached token")', async () => {
    const r = await feishuStatus()
    const ok = typeof r === 'string' && r.length > 0
    record(
      'E27. feishu.status 未配置时返回字符串 (如 "no cached token")',
      ok,
      `value=${typeof r === 'string' ? r : JSON.stringify(r)?.slice(0, 60)}`,
    )
  })

  await test('E28. feishu.status 不抛未捕获异常 (无 __error)', async () => {
    const r = await feishuStatus()
    record('E28. feishu.status 不抛未捕获异常 (无 __error)', r != null && !r.__error, `__error=${r?.__error ?? 'none'}`)
  })

  // ============================================================
  // F. Feishu syncNow — 凭证未配置时优雅降级 (无网络)
  // ============================================================
  console.log('\n━━━ F. Feishu syncNow (凭证未配置时优雅降级) ━━━')

  await test('F29. syncNow 空 appId 被拒绝 (输入校验, 不崩溃)', async () => {
    const r = await feishuSyncNow('', 'appToken123', 'tbl123', { field: 'val' })
    record(
      'F29. syncNow 空 appId 被拒绝 (输入校验, 不崩溃)',
      isRejected(r),
      `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`,
    )
  })

  await test('F30. syncNow null appId 被拒绝', async () => {
    const r = await feishuSyncNowRaw('null', '"appToken123"', '"tbl123"', '{field:"val"}')
    record('F30. syncNow null appId 被拒绝', isRejected(r), `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('F31. syncNow 合法格式 + 凭证未配置 → {success:false, skipped} (优雅降级, 无网络)', async () => {
    // appSecret 从 keystore 读取, 未配置时为空串 → syncBitableNow 返回 skipped 分支, 不发网络请求
    const r = await feishuSyncNow('cli_test_app_id', 'appTokenABC123', 'tblABC123', { name: 'test' })
    const ok = isStructured(r) && r.success === false && typeof r.skipped === 'string' && r.skipped.length > 0
    record(
      'F31. syncNow 合法格式 + 凭证未配置 → {success:false, skipped} (优雅降级, 无网络)',
      ok,
      `success=${r?.success} skipped=${r?.skipped ?? ''}`,
    )
  })

  await test('F32. syncNow fields 为数组被拒绝 (fields 必须为对象)', async () => {
    const r = await feishuSyncNowRaw('"cli_test"', '"appToken123"', '"tbl123"', '["not","object"]')
    record(
      'F32. syncNow fields 为数组被拒绝 (fields 必须为对象)',
      isRejected(r),
      `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`,
    )
  })

  await test('F33. syncNow fields 为 null 被拒绝', async () => {
    const r = await feishuSyncNowRaw('"cli_test"', '"appToken123"', '"tbl123"', 'null')
    record(
      'F33. syncNow fields 为 null 被拒绝',
      isRejected(r),
      `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`,
    )
  })

  // ============================================================
  // G. Feishu test / listBitable / send 输入校验 (拒绝路径, 无网络)
  // ============================================================
  console.log('\n━━━ G. Feishu test / listBitable / send 输入校验 ━━━')

  await test('G34. feishu.test("") 被拒绝 (空 appId, 校验先于网络)', async () => {
    const r = await feishuTest('')
    record('G34. feishu.test("") 被拒绝 (空 appId, 校验先于网络)', isRejected(r), `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('G35. feishu.test(null) 被拒绝', async () => {
    const r = await feishuTestRaw('null')
    record('G35. feishu.test(null) 被拒绝', isRejected(r), `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('G36. feishu.listBitable("", token) 被拒绝 (空 appId)', async () => {
    const r = await feishuListBitable('', 'appToken123')
    record('G36. feishu.listBitable("", token) 被拒绝 (空 appId)', isRejected(r), `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('G37. feishu.send("", openId, text) 被拒绝 (空 appId)', async () => {
    const r = await feishuSend('', 'ou_openid', 'hello')
    record('G37. feishu.send("", openId, text) 被拒绝 (空 appId)', isRejected(r), `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  await test('G38. feishu.send null text 被拒绝', async () => {
    const r = await feishuSendRaw('"cli_test"', '"ou_openid"', 'null')
    record('G38. feishu.send null text 被拒绝', isRejected(r), `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`)
  })

  // ============================================================
  // H. Feishu 长连接机器人 — 未配置时优雅
  // ============================================================
  console.log('\n━━━ H. Feishu 长连接机器人 (未配置时优雅) ━━━')

  await test('H39. feishu.botStatus 返回结构化对象 (含 status, 不崩溃)', async () => {
    const r = await feishuBotStatus()
    const ok = isStructured(r) && ('status' in r || typeof r === 'object')
    record(
      'H39. feishu.botStatus 返回结构化对象 (含 status, 不崩溃)',
      ok,
      `status=${r?.status} err=${String(r?.error ?? '').slice(0, 50)}`,
    )
  })

  await test('H40. feishu.botStatus.status 为字符串 (如 disconnected)', async () => {
    const r = await feishuBotStatus()
    const ok = !!r && typeof r.status === 'string'
    record('H40. feishu.botStatus.status 为字符串 (如 disconnected)', ok, `status=${r?.status}`)
  })

  await test('H41. feishu.botStart 未配置凭证 → {success:false, error} (优雅, 提示先配置)', async () => {
    const r = await feishuBotStart()
    const ok = isStructured(r) && r.success === false && (typeof r.error === 'string' || typeof r.error === 'undefined')
    record(
      'H41. feishu.botStart 未配置凭证 → {success:false, error} (优雅, 提示先配置)',
      ok,
      `success=${r?.success} err=${String(r?.error ?? '').slice(0, 60)}`,
    )
  })

  await test('H42. feishu.botStop 返回结构化 (无运行中机器人也不崩溃)', async () => {
    const r = await feishuBotStop()
    record(
      'H42. feishu.botStop 返回结构化 (无运行中机器人也不崩溃)',
      isStructured(r) && isBool(r.success),
      `success=${r?.success} err=${String(r?.error ?? '').slice(0, 50)}`,
    )
  })

  // ============================================================
  // I. Tray 设置 — general.minimizeToTray 读取/写入/往返
  // ============================================================
  console.log('\n━━━ I. Tray 设置 (general.minimizeToTray 读写往返) ━━━')

  await test('I43. settings.get 返回对象含 general.minimizeToTray 为布尔值', async () => {
    const s = await getSettings()
    const mt = s && s.general && s.general.minimizeToTray
    initialMinimizeToTray = isBool(mt) ? mt : null
    record(
      'I43. settings.get 返回对象含 general.minimizeToTray 为布尔值',
      s != null && !s.__error && isBool(mt),
      `minimizeToTray=${mt}`,
    )
  })

  await test('I44. settings.set("general.minimizeToTray", false) → success', async () => {
    const r = await setSetting('general.minimizeToTray', false)
    record(
      'I44. settings.set("general.minimizeToTray", false) → success',
      isSuccess(r),
      `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`,
    )
  })

  await test('I45. 往返: 设置 false 后 settings.get 显示 minimizeToTray=false', async () => {
    const s = await getSettings()
    const ok = s && s.general && s.general.minimizeToTray === false
    record(
      'I45. 往返: 设置 false 后 settings.get 显示 minimizeToTray=false',
      !!ok,
      `minimizeToTray=${s?.general?.minimizeToTray}`,
    )
  })

  await test('I46. settings.set("general.minimizeToTray", true) → success (恢复)', async () => {
    const r = await setSetting('general.minimizeToTray', true)
    record(
      'I46. settings.set("general.minimizeToTray", true) → success (恢复)',
      isSuccess(r),
      `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`,
    )
  })

  await test('I47. 往返: 设置 true 后 settings.get 显示 minimizeToTray=true', async () => {
    const s = await getSettings()
    const ok = s && s.general && s.general.minimizeToTray === true
    record(
      'I47. 往返: 设置 true 后 settings.get 显示 minimizeToTray=true',
      !!ok,
      `minimizeToTray=${s?.general?.minimizeToTray}`,
    )
  })

  // ============================================================
  // J. Tray/Settings 边界值 (不崩溃)
  // ============================================================
  console.log('\n━━━ J. Tray/Settings 边界值 (不崩溃) ━━━')

  await test('J48. settings.set minimizeToTray 非布尔值 (字符串) → 结构化响应不崩溃', async () => {
    const r = await setSettingRaw('"general.minimizeToTray"', '"not-a-bool"')
    // 不论是被拒绝还是被强制类型转换, 关键是不抛未捕获异常, 返回结构化响应
    record(
      'J48. settings.set minimizeToTray 非布尔值 (字符串) → 结构化响应不崩溃',
      notCrash(r),
      `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`,
    )
  })

  await test('J49. settings.set minimizeToTray null → 结构化响应不崩溃', async () => {
    const r = await setSettingRaw('"general.minimizeToTray"', 'null')
    record(
      'J49. settings.set minimizeToTray null → 结构化响应不崩溃',
      notCrash(r),
      `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`,
    )
  })

  await test('J50. settings.set 空路径 → 结构化响应不崩溃', async () => {
    const r = await setSetting('', true)
    record(
      'J50. settings.set 空路径 → 结构化响应不崩溃',
      notCrash(r),
      `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`,
    )
  })

  // ============================================================
  // K. 错误处理 — 所有调用返回结构化错误, 不抛未捕获异常
  // ============================================================
  console.log('\n━━━ K. 错误处理 (结构化错误, 不抛未捕获异常) ━━━')

  await test('K51. Ollama 全部命名空间方法返回结构化响应 (无 __error 包装异常)', async () => {
    const calls = await Promise.all([
      ollamaDetect(),
      ollamaListModels(),
      ollamaStopServe(),
      ollamaPullModel(''),
      ollamaDeleteModel(''),
    ])
    const allStructured = calls.every((r) => r != null && !r.__error)
    record(
      'K51. Ollama 全部命名空间方法返回结构化响应 (无 __error 包装异常)',
      allStructured,
      `checks=${calls.length} bad=${calls.filter((r) => !r || r.__error).length}`,
    )
  })

  await test('K52. Feishu 全部命名空间方法返回结构化响应 (无 __error 包装异常)', async () => {
    const calls = await Promise.all([
      feishuStatus(),
      feishuBotStatus(),
      feishuBotStop(),
      feishuTest(''),
      feishuSyncNow('', 't', 't', { a: 1 }),
    ])
    const allStructured = calls.every((r) => r != null && !r.__error)
    record(
      'K52. Feishu 全部命名空间方法返回结构化响应 (无 __error 包装异常)',
      allStructured,
      `checks=${calls.length} bad=${calls.filter((r) => !r || r.__error).length}`,
    )
  })

  await test('K53. syncNow 缺参返回结构化 {success:false} (不抛 TypeError)', async () => {
    // 缺少参数时 preload 传入 undefined, handler validateString 应捕获并返回结构化错误
    const r = await callIpc(`return await api.feishu.syncNow();`)
    record(
      'K53. syncNow 缺参返回结构化 {success:false} (不抛 TypeError)',
      isStructured(r) && r.success === false,
      `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 60)}`,
    )
  })

  // ============================================================
  // 清理: 还原 minimizeToTray 初始值
  // ============================================================
  console.log('\n━━━ 清理: 还原 minimizeToTray 设置 ━━━')
  if (initialMinimizeToTray !== null) {
    try {
      await setSetting('general.minimizeToTray', initialMinimizeToTray)
      console.log(`  已还原 minimizeToTray = ${initialMinimizeToTray}`)
    } catch (e) {
      console.log(`  还原失败: ${String(e && e.message ? e.message : e).slice(0, 80)}`)
    }
  } else {
    // 未取到初始值时, 默认恢复为 true (DEFAULT_SETTINGS 中的默认值)
    try {
      await setSetting('general.minimizeToTray', true)
      console.log('  已恢复 minimizeToTray = true (默认值)')
    } catch (e) {
      console.log(`  恢复默认失败: ${String(e && e.message ? e.message : e).slice(0, 80)}`)
    }
  }

  // ============================================================
  // 汇总
  // ============================================================
  console.log('\n========== Ollama / Feishu / Tray 集成深度测试 ==========')
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
