// =============================================================
// CDP 深度测试 — Agent 系统 (18 个专用智能体)
//
// 连接到运行中的 Tauri 2 应用 (WebView2 CDP 9222),
// 通过 window.__EAA_API__.agent / window.api.agent 调用 IPC,
// 深度覆盖 14 类场景: 配置/灵魂/规则/启停/更新/边界/并发/唯一性/恢复。
// 测试完成后恢复所有修改的 agent 到原始状态。
//
// 运行: node scripts/cdp-agent-deep.mjs
//
// 实测得到的 API 契约 (来自 src/main/ipc/agent-handlers.ts + agent-service.ts):
//   agent.list()              -> AgentListItem[]                (直接返回数组, 异常时返回 [])
//   agent.get(id)             -> AgentDetail | null | {success:false,error}  (不存在返回 null)
//   agent.toggle(id, enabled) -> {success:true} | {success:false, error:'Agent not found'}  (2 个参数)
//   agent.update(id, patch)   -> {success:true} | {success:false, error:'Agent not found'}
//                                patch 仅支持 name/description/modelTier/capabilities (不支持 soul/rules!)
//   agent.getSoul(id)         -> string                         (不存在/无文件返回 ''; 非法 id 返回 {success:false,error})
//   agent.setSoul(id, content)-> {success:true}                 (直接写 agents/<id>/SOUL.md)
//   agent.getRules(id)        -> string                         (同 getSoul, 读 AGENTS.md)
//   agent.setRules(id,content)-> {success:true}                 (直接写 agents/<id>/AGENTS.md)
//   agent.getHistory(id)      -> AgentExecution[] | {success:false,error}
//   agent.runManual(id,prompt)-> {success, message?, id?}       (fire-and-forget)
//   agent.abort(id)           -> {success}
//   agent.onStatusUpdate(cb)  -> unsub 函数
//
// AgentListItem 字段: id, name, role, description, enabled, modelTier,
//                     schedule, capabilities, riskThresholds?, status, lastRunAt?, nextRunAt?
// AgentDetail 扩展:   + soulContent, rulesContent, executionHistory
//
// 系统共 18 个 agent (来自 config/agents.yaml):
//   main, governor, counselor, supervisor, validator, academic, psychology,
//   safety, home_school, research, executor, class-monitor, risk-alert,
//   data-analyst, student-care, discipline-officer, weekly-reporter, bug-hunter
// =============================================================
import http from 'node:http'

const CDP_PORT = 9222
const BASE = `http://127.0.0.1:${CDP_PORT}`
const EXPECTED_AGENT_COUNT = 18

// 修改测试目标: 选 bug-hunter (无 schedule, 不会干扰 cron 调度, 风险最低)
const MUTATE_TARGET = 'bug-hunter'

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

  // ---------- CDP 连接 ----------
  const targets = (await fetchJson(`${BASE}/json`)).filter((t) => t.type === 'page')
  if (targets.length === 0) {
    console.log('FAIL: No CDP targets (应用是否已运行并开启 --remote-debugging-port=9222?)')
    process.exit(1)
  }
  const cdpTarget = targets[0]
  console.log(`Target: ${cdpTarget.title} (${cdpTarget.url})\n`)

  const { default: WebSocket } = await import('ws')
  const ws = new WebSocket(cdpTarget.webSocketDebuggerUrl)
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
  console.log('CDP 已连接,开始 Agent 深度测试...\n')

  // ---------- IPC 调用封装 ----------
  // 返回 { ok, data, error }: ok=true 表示 IPC 调用未抛出, data 为返回值
  const callAgent = async (code) => {
    return await evalInPage(`
      (async function() {
        const api = window.__EAA_API__ || window.api;
        if (!api) return { __error: 'no-api' };
        if (!api.agent) return { __error: 'no-agent-api' };
        try {
          const res = await ${code};
          return { __ok: true, data: res };
        } catch (e) {
          return { __error: String(e && e.message ? e.message : e) };
        }
      })()
    `)
  }
  // 统一返回 { ok, data, error }
  const agent = async (code) => {
    const r = await callAgent(code)
    if (!r) return { ok: false, data: null, error: 'null-result' }
    if (r.__error) return { ok: false, data: null, error: r.__error }
    return { ok: true, data: r.data ?? null, error: null }
  }

  // ---------- 恢复队列: 即使后续测试失败也能恢复 ----------
  const restoreQueue = []
  const restoreAll = async () => {
    for (const fn of restoreQueue) {
      try {
        await fn()
      } catch (err) {
        console.warn(`[restore] 恢复失败: ${err.message || err}`)
      }
    }
  }

  // 保存修改目标的原始值 (在 step 5 填充, 供 step 14 严格比对)
  const originals = { targetId: null, enabled: null, description: null, modelTier: null, soul: null, rules: null }

  // =============================================================
  // 0. API 探测 — Object.keys(window.api.agent)
  // =============================================================
  console.log('━━━ 0. API 探测 ━━━')
  let apiKeys = []
  try {
    apiKeys = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        if (!api || !api.agent) return [];
        return Object.keys(api.agent).filter(k => typeof api.agent[k] === 'function');
      })()
    `)
    record(`agent API 探测`, Array.isArray(apiKeys) && apiKeys.length > 0, `keys=[${apiKeys.join(',')}]`)
  } catch (err) {
    record(`agent API 探测`, false, String(err.message || err))
  }
  const expectedMethods = [
    'list', 'get', 'toggle', 'update',
    'getSoul', 'setSoul', 'getRules', 'setRules',
    'runManual', 'getHistory', 'abort', 'onStatusUpdate',
  ]
  const missing = expectedMethods.filter((m) => !apiKeys.includes(m))
  record(`agent 方法完整性`, missing.length === 0, missing.length ? `缺失: ${missing.join(',')}` : `全部 ${expectedMethods.length} 个方法存在`)

  // =============================================================
  // 1. agent.list 完整性 — 获取 18 个 agent, 验证每个都有 id/name/enabled
  // =============================================================
  console.log('\n━━━ 1. agent.list 完整性 ━━━')
  let agents = []
  {
    const r = await agent(`api.agent.list()`)
    agents = r.ok ? r.data || [] : []
    const isArr = Array.isArray(agents)
    const countOk = isArr && agents.length === EXPECTED_AGENT_COUNT
    record(`agent.list 返回 ${EXPECTED_AGENT_COUNT} 个 agent`, r.ok && countOk, `ok=${r.ok} count=${agents.length} (期望 ${EXPECTED_AGENT_COUNT})`)
  }
  {
    const hasFields = agents.every(
      (a) => a && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.enabled === 'boolean',
    )
    const missingList = agents
      .filter((a) => !a || typeof a.id !== 'string' || typeof a.name !== 'string' || typeof a.enabled !== 'boolean')
      .map((a) => a?.id ?? '(undefined)')
    record(`每个 agent 都有 id/name/enabled 字段`, agents.length > 0 && hasFields, hasFields ? `全部 ${agents.length} 个字段齐全` : `缺失: ${missingList.join(',')}`)
  }
  // 列出所有 agent 概览
  if (agents.length > 0) {
    console.log(`  Agent 列表: ${agents.map((a) => `${a.id}(${a.enabled ? 'on' : 'off'})`).join(', ')}`)
  }

  // =============================================================
  // 2. 逐个 agent.get — 对所有 18 个 agent 调用 get(id), 验证都返回有效数据
  // =============================================================
  console.log('\n━━━ 2. 逐个 agent.get ━━━')
  let getFailures = []
  let detailMap = new Map()
  if (agents.length > 0) {
    for (const a of agents) {
      const r = await agent(`api.agent.get(${JSON.stringify(a.id)})`)
      const valid = r.ok && r.data && r.data.id === a.id
      if (!valid) getFailures.push(a.id)
      if (valid) detailMap.set(a.id, r.data)
    }
  }
  record(`逐个 agent.get 全部 18 个返回有效数据`, getFailures.length === 0 && agents.length === EXPECTED_AGENT_COUNT, getFailures.length ? `失败: ${getFailures.join(',')}` : `全部 ${agents.length} 个 get 成功`)

  // =============================================================
  // 3. agent.getSoul — 对几个 agent 调用 getSoul, 验证返回非空文本
  // =============================================================
  console.log('\n━━━ 3. agent.getSoul (抽样) ━━━')
  {
    const sampleIds = agents.slice(0, 5).map((a) => a.id) // 取前 5 个抽样
    let nonEmpty = 0
    const lens = {}
    for (const id of sampleIds) {
      const r = await agent(`api.agent.getSoul(${JSON.stringify(id)})`)
      const text = r.ok && typeof r.data === 'string' ? r.data : ''
      lens[id] = text.length
      if (text.length > 0) nonEmpty++
      record(`getSoul(${id})`, r.ok && typeof r.data === 'string' && text.length > 0, `type=${typeof r.data} len=${text.length}`)
    }
    record(`getSoul 抽样非空`, nonEmpty === sampleIds.length, `${nonEmpty}/${sampleIds.length} 非空 (lens=${JSON.stringify(lens)})`)
  }

  // =============================================================
  // 4. agent.getRules — 对几个 agent 调用 getRules, 验证返回非空文本
  // =============================================================
  console.log('\n━━━ 4. agent.getRules (抽样) ━━━')
  {
    const sampleIds = agents.slice(0, 5).map((a) => a.id)
    let nonEmpty = 0
    const lens = {}
    for (const id of sampleIds) {
      const r = await agent(`api.agent.getRules(${JSON.stringify(id)})`)
      const text = r.ok && typeof r.data === 'string' ? r.data : ''
      lens[id] = text.length
      if (text.length > 0) nonEmpty++
      record(`getRules(${id})`, r.ok && typeof r.data === 'string' && text.length > 0, `type=${typeof r.data} len=${text.length}`)
    }
    record(`getRules 抽样非空`, nonEmpty === sampleIds.length, `${nonEmpty}/${sampleIds.length} 非空 (lens=${JSON.stringify(lens)})`)
  }

  // =============================================================
  // 5. agent.update + setSoul/setRules — 更新 agent 配置/soul/rules, 验证读回
  //    注意: agent.update 仅支持 name/description/modelTier/capabilities
  //          soul/rules 通过 setSoul/setRules 单独更新
  // =============================================================
  console.log('\n━━━ 5. agent.update / setSoul / setRules ━━━')
  const target = agents.find((a) => a.id === MUTATE_TARGET) || agents[0]
  if (target) {
    // 5a. 保存原始值用于恢复 (写入 main 作用域的 originals, 供 step 14 严格比对)
    const origDetail = detailMap.get(target.id) || (await agent(`api.agent.get(${JSON.stringify(target.id)})`)).data
    originals.targetId = target.id
    originals.description = origDetail?.description ?? ''
    originals.modelTier = origDetail?.modelTier ?? 'low_cost'
    originals.soul = (await agent(`api.agent.getSoul(${JSON.stringify(target.id)})`)).data || ''
    originals.rules = (await agent(`api.agent.getRules(${JSON.stringify(target.id)})`)).data || ''
    originals.enabled = target.enabled
    console.log(`  修改目标: ${target.id} (orig: enabled=${originals.enabled}, modelTier=${originals.modelTier}, descLen=${originals.description.length}, soulLen=${originals.soul.length}, rulesLen=${originals.rules.length})`)

    // 注册恢复函数 (逆序执行: 后注册先恢复, 保持原序)
    restoreQueue.push(async () => {
      await agent(`api.agent.update(${JSON.stringify(target.id)}, ${JSON.stringify({ description: originals.description, modelTier: originals.modelTier })})`)
    })
    restoreQueue.push(async () => {
      await agent(`api.agent.setSoul(${JSON.stringify(target.id)}, ${JSON.stringify(originals.soul)})`)
    })
    restoreQueue.push(async () => {
      await agent(`api.agent.setRules(${JSON.stringify(target.id)}, ${JSON.stringify(originals.rules)})`)
    })
    restoreQueue.push(async () => {
      await agent(`api.agent.toggle(${JSON.stringify(target.id)}, ${JSON.stringify(originals.enabled)})`)
    })

    // 5b. agent.update — 改 description + modelTier
    const newDesc = `[CDP-DEEP-TEST ${Date.now()}] 临时修改的描述, 测试后自动恢复`
    const newTier = originals.modelTier === 'high_quality' ? 'low_cost' : 'high_quality'
    {
      const r = await agent(`api.agent.update(${JSON.stringify(target.id)}, ${JSON.stringify({ description: newDesc, modelTier: newTier })})`)
      // 读回验证
      const back = await agent(`api.agent.get(${JSON.stringify(target.id)})`)
      const verified = r.ok && r.data?.success === true && back.data?.description === newDesc && back.data?.modelTier === newTier
      record(`agent.update (description+modelTier) 写入并读回`, verified, `success=${r.data?.success} desc匹配=${back.data?.description === newDesc} tier匹配=${back.data?.modelTier === newTier} (新tier=${newTier})`)
    }

    // 5c. agent.setSoul — 改灵魂并读回
    const newSoul = `# [CDP-DEEP-TEST] 临时灵魂 ${Date.now()}\n\n这是自动化测试临时写入的灵魂设定, 测试后自动恢复。\n原始灵魂长度: ${originals.soul.length} 字符。`
    {
      const r = await agent(`api.agent.setSoul(${JSON.stringify(target.id)}, ${JSON.stringify(newSoul)})`)
      const back = await agent(`api.agent.getSoul(${JSON.stringify(target.id)})`)
      const verified = r.ok && r.data?.success === true && back.data === newSoul
      record(`agent.setSoul 写入并读回`, verified, `success=${r.data?.success} 匹配=${back.data === newSoul} len=${back.data?.length ?? 0}`)
    }

    // 5d. agent.setRules — 改规则并读回
    const newRules = `# [CDP-DEEP-TEST] 临时规则 ${Date.now()}\n\n1. 测试规则 A\n2. 测试规则 B\n原始规则长度: ${originals.rules.length} 字符。`
    {
      const r = await agent(`api.agent.setRules(${JSON.stringify(target.id)}, ${JSON.stringify(newRules)})`)
      const back = await agent(`api.agent.getRules(${JSON.stringify(target.id)})`)
      const verified = r.ok && r.data?.success === true && back.data === newRules
      record(`agent.setRules 写入并读回`, verified, `success=${r.data?.success} 匹配=${back.data === newRules} len=${back.data?.length ?? 0}`)
    }

    // 5e. agent.get 应内联返回更新后的 soulContent/rulesContent
    {
      const back = await agent(`api.agent.get(${JSON.stringify(target.id)})`)
      const soulOk = back.data?.soulContent === newSoul
      const rulesOk = back.data?.rulesContent === newRules
      record(`agent.get 内联 soulContent/rulesContent 同步`, soulOk && rulesOk, `soul匹配=${soulOk} rules匹配=${rulesOk}`)
    }
  } else {
    record(`agent.update / setSoul / setRules`, false, '无可用 agent 作为修改目标')
  }

  // =============================================================
  // 6. agent.toggle — 切换 enabled 状态, 验证切换成功, 然后恢复
  // =============================================================
  console.log('\n━━━ 6. agent.toggle ━━━')
  if (target) {
    const before = (await agent(`api.agent.get(${JSON.stringify(target.id)})`)).data
    const beforeEnabled = before?.enabled
    const flipped = !beforeEnabled
    // 切换
    const r = await agent(`api.agent.toggle(${JSON.stringify(target.id)}, ${JSON.stringify(flipped)})`)
    const after = (await agent(`api.agent.get(${JSON.stringify(target.id)})`)).data
    const afterEnabled = after?.enabled
    const toggleOk = r.ok && r.data?.success === true && afterEnabled === flipped
    record(`agent.toggle (${beforeEnabled} -> ${flipped})`, toggleOk, `success=${r.data?.success} before=${beforeEnabled} after=${afterEnabled} 期望=${flipped}`)
    // toggle 恢复由 restoreQueue 处理 (恢复到 originals.enabled), 这里不单独恢复以避免重复
    // 但需确认 restoreQueue 里的恢复值正确: originals.enabled 已在 5a 保存
    // 额外验证: 再次 toggle 回原始值, 确认双向切换
    const r2 = await agent(`api.agent.toggle(${JSON.stringify(target.id)}, ${JSON.stringify(beforeEnabled)})`)
    const after2 = (await agent(`api.agent.get(${JSON.stringify(target.id)})`)).data
    const toggleBackOk = r2.ok && r2.data?.success === true && after2?.enabled === beforeEnabled
    record(`agent.toggle 反向切回 (${flipped} -> ${beforeEnabled})`, toggleBackOk, `success=${r2.data?.success} after=${after2?.enabled} 期望=${beforeEnabled}`)
  } else {
    record(`agent.toggle`, false, '无可用 agent')
  }

  // =============================================================
  // 7. get 不存在的 agent — 验证返回 null 或报错但不崩溃
  // =============================================================
  console.log('\n━━━ 7. agent.get 不存在 ━━━')
  {
    const fakeId = 'nonexistent-agent-' + Date.now()
    const r = await agent(`api.agent.get(${JSON.stringify(fakeId)})`)
    // 实测: 不存在返回 null (getAgent 返回 null), 不崩溃
    const noCrash = r.ok
    const isNull = r.data === null
    record(`get 不存在 agent (返回 null 不崩溃)`, noCrash && isNull, `ok=${r.ok} data=${r.data} error=${r.error ?? '无'}`)

    // getSoul/getRules 不存在: 返回空字符串 (文件不存在)
    const rs = await agent(`api.agent.getSoul(${JSON.stringify(fakeId)})`)
    const rr = await agent(`api.agent.getRules(${JSON.stringify(fakeId)})`)
    record(`getSoul 不存在 agent (返回空字符串不崩溃)`, rs.ok && typeof rs.data === 'string', `ok=${rs.ok} type=${typeof rs.data} len=${rs.data?.length ?? -1}`)
    record(`getRules 不存在 agent (返回空字符串不崩溃)`, rr.ok && typeof rr.data === 'string', `ok=${rr.ok} type=${typeof rr.data} len=${rr.data?.length ?? -1}`)
  }

  // =============================================================
  // 8. update 不存在 — 验证返回错误但不崩溃
  // =============================================================
  console.log('\n━━━ 8. agent.update 不存在 ━━━')
  {
    const fakeId = 'nonexistent-agent-' + Date.now()
    const r = await agent(`api.agent.update(${JSON.stringify(fakeId)}, ${JSON.stringify({ description: 'ghost' })})`)
    // 实测: update 不存在返回 {success:false, error:'Agent not found'}, 不崩溃
    const noCrashAndError = r.ok && r.data?.success === false
    record(`update 不存在 agent (返回错误不崩溃)`, noCrashAndError, `ok=${r.ok} success=${r.data?.success} error=${r.data?.error ?? r.error ?? '无'}`)
  }

  // =============================================================
  // 9. toggle 不存在 — 验证返回错误但不崩溃
  // =============================================================
  console.log('\n━━━ 9. agent.toggle 不存在 ━━━')
  {
    const fakeId = 'nonexistent-agent-' + Date.now()
    const r = await agent(`api.agent.toggle(${JSON.stringify(fakeId)}, true)`)
    // 实测: toggle 不存在返回 {success:false, error:'Agent not found'}, 不崩溃
    const noCrashAndError = r.ok && r.data?.success === false
    record(`toggle 不存在 agent (返回错误不崩溃)`, noCrashAndError, `ok=${r.ok} success=${r.data?.success} error=${r.data?.error ?? r.error ?? '无'}`)
  }

  // =============================================================
  // 10. agent 字段验证 — 检查 agent 对象有哪些字段
  // =============================================================
  console.log('\n━━━ 10. agent 字段验证 ━━━')
  if (agents.length > 0) {
    // ListItem 字段 (来自 list)
    const sample = agents[0]
    const listItemFields = Object.keys(sample).sort()
    const expectedListItem = ['id', 'name', 'enabled', 'modelTier', 'role', 'description', 'schedule', 'capabilities', 'status']
    const hasAllListItem = expectedListItem.every((f) => f in sample)
    record(`AgentListItem 字段 (list 返回)`, hasAllListItem, `fields=[${listItemFields.join(',')}] 缺失=[${expectedListItem.filter((f) => !(f in sample)).join(',')}]`)

    // Detail 字段 (来自 get)
    const detail = detailMap.get(agents[0].id)
    if (detail) {
      const detailFields = Object.keys(detail).sort()
      const expectedDetailExtra = ['soulContent', 'rulesContent', 'executionHistory']
      const hasAllDetail = expectedDetailExtra.every((f) => f in detail)
      record(`AgentDetail 扩展字段 (get 返回)`, hasAllDetail, `fields=[${detailFields.join(',')}] 扩展=[${expectedDetailExtra.map((f) => `${f}:${f in detail ? '✓' : '✗'}`).join(',')}]`)
      // 验证 enabled 类型为 boolean, modelTier 为合法枚举
      const enabledTypes = agents.every((a) => typeof a.enabled === 'boolean')
      const tierValues = agents.every((a) => a.modelTier === 'high_quality' || a.modelTier === 'low_cost')
      record(`字段类型校验 (enabled=boolean, modelTier 枚举)`, enabledTypes && tierValues, `enabled=${enabledTypes} tier合法=${tierValues}`)
      // 验证 executionHistory 是数组
      const histIsArr = Array.isArray(detail.executionHistory)
      record(`executionHistory 为数组`, histIsArr, `isArray=${histIsArr} len=${detail.executionHistory?.length ?? -1}`)
    } else {
      record(`AgentDetail 扩展字段`, false, '无 detail 数据')
    }

    // 是否存在 agentId 字段? (任务提示中提到 agentId)
    // 实测: AgentConfig/ListItem/Detail 中没有独立 agentId 字段 (用 id 标识);
    //       agentId 仅出现在 AgentExecution 内 (执行历史条目)
    const hasAgentIdField = 'agentId' in sample
    record(`agentId 字段说明`, true, `AgentListItem 中 ${hasAgentIdField ? '存在' : '不存在'} agentId 字段 (设计: 用 id 标识; agentId 仅出现在 AgentExecution 执行历史条目内)`)
  } else {
    record(`agent 字段验证`, false, '无 agent 数据')
  }

  // =============================================================
  // 11. 并发读取 — 同时 get 5 个不同 agent, 验证不冲突
  // =============================================================
  console.log('\n━━━ 11. 并发读取 (5 个 agent) ━━━')
  if (agents.length >= 5) {
    const concurrencyIds = agents.slice(0, 5).map((a) => a.id)
    const t0 = Date.now()
    const concurrentResults = await Promise.all(
      concurrencyIds.map((id) => agent(`api.agent.get(${JSON.stringify(id)})`)),
    )
    const elapsed = Date.now() - t0
    const allOk = concurrentResults.every((r) => r.ok && r.data && r.data.id)
    const idsMatch = concurrentResults.every((r, i) => r.data?.id === concurrencyIds[i])
    record(`并发 get 5 个 agent`, allOk && idsMatch, `allOk=${allOk} idsMatch=${idsMatch} 耗时=${elapsed}ms ids=[${concurrentResults.map((r) => r.data?.id).join(',')}]`)

    // 并发 getSoul + getRules 混合
    const mixedResults = await Promise.all([
      agent(`api.agent.getSoul(${JSON.stringify(concurrencyIds[0])})`),
      agent(`api.agent.getRules(${JSON.stringify(concurrencyIds[1])})`),
      agent(`api.agent.get(${JSON.stringify(concurrencyIds[2])})`),
      agent(`api.agent.getSoul(${JSON.stringify(concurrencyIds[3])})`),
      agent(`api.agent.getRules(${JSON.stringify(concurrencyIds[4])})`),
    ])
    const mixedOk = mixedResults.every((r) => r.ok)
    record(`并发混合读取 (getSoul/getRules/get)`, mixedOk, `allOk=${mixedOk} types=[${mixedResults.map((r) => typeof r.data).join(',')}]`)
  } else {
    record(`并发读取`, false, `agent 数量不足 (需要 >=5, 实际 ${agents.length})`)
  }

  // =============================================================
  // 12. soul/rules 内容非空验证 — 所有 agent 的 soul 和 rules 都不为空
  // =============================================================
  console.log('\n━━━ 12. soul/rules 全员非空验证 ━━━')
  {
    let soulEmpty = []
    let rulesEmpty = []
    let soulFail = []
    let rulesFail = []
    const soulLens = {}
    const rulesLens = {}
    for (const a of agents) {
      const rs = await agent(`api.agent.getSoul(${JSON.stringify(a.id)})`)
      const rr = await agent(`api.agent.getRules(${JSON.stringify(a.id)})`)
      const soulText = rs.ok && typeof rs.data === 'string' ? rs.data : ''
      const rulesText = rr.ok && typeof rr.data === 'string' ? rr.data : ''
      soulLens[a.id] = soulText.length
      rulesLens[a.id] = rulesText.length
      if (!rs.ok) soulFail.push(a.id)
      else if (soulText.length === 0) soulEmpty.push(a.id)
      if (!rr.ok) rulesFail.push(a.id)
      else if (rulesText.length === 0) rulesEmpty.push(a.id)
    }
    const soulOk = soulFail.length === 0 && soulEmpty.length === 0
    const rulesOk = rulesFail.length === 0 && rulesEmpty.length === 0
    record(`所有 agent soul 非空`, soulOk, soulOk ? `全部 ${agents.length} 个非空 (最短=${Math.min(...Object.values(soulLens))} 最长=${Math.max(...Object.values(soulLens))})` : `失败=[${soulFail.join(',')}] 空=[${soulEmpty.join(',')}]`)
    record(`所有 agent rules 非空`, rulesOk, rulesOk ? `全部 ${agents.length} 个非空 (最短=${Math.min(...Object.values(rulesLens))} 最长=${Math.max(...Object.values(rulesLens))})` : `失败=[${rulesFail.join(',')}] 空=[${rulesEmpty.join(',')}]`)

    // 额外: get 内联的 soulContent/rulesContent 也应非空且与独立读取一致
    let inlineMismatch = []
    for (const a of agents) {
      const detail = await agent(`api.agent.get(${JSON.stringify(a.id)})`)
      const inlineSoul = detail.data?.soulContent
      const inlineRules = detail.data?.rulesContent
      const standaloneSoul = (await agent(`api.agent.getSoul(${JSON.stringify(a.id)})`)).data
      const standaloneRules = (await agent(`api.agent.getRules(${JSON.stringify(a.id)})`)).data
      if (inlineSoul !== standaloneSoul || inlineRules !== standaloneRules) {
        inlineMismatch.push(a.id)
      }
    }
    record(`get 内联 soulContent/rulesContent 与独立读取一致`, inlineMismatch.length === 0, inlineMismatch.length ? `不一致: ${inlineMismatch.join(',')}` : `全部 ${agents.length} 个一致`)
  }

  // =============================================================
  // 13. agent name 唯一性 — 检查 18 个 agent 的 name 是否唯一
  // =============================================================
  console.log('\n━━━ 13. agent name 唯一性 ━━━')
  {
    const names = agents.map((a) => a.name)
    const nameSet = new Set(names)
    const dupNames = names.filter((n, i) => names.indexOf(n) !== i)
    record(`agent name 唯一性`, nameSet.size === names.length, `唯一=${nameSet.size}/${names.length} 重复=[${[...new Set(dupNames)].join(',')}]`)

    // id 唯一性 (设计上 id 必须唯一)
    const ids = agents.map((a) => a.id)
    const idSet = new Set(ids)
    const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i)
    record(`agent id 唯一性`, idSet.size === ids.length, `唯一=${idSet.size}/${ids.length} 重复=[${[...new Set(dupIds)].join(',')}]`)

    // id 格式校验 (仅小写字母/数字/连字符/下划线, 防 path traversal)
    const idFormatOk = ids.every((id) => /^[a-z0-9_-]+$/.test(id))
    record(`agent id 格式合法 (防 path traversal)`, idFormatOk, `合法=${idFormatOk} ids=[${ids.join(',')}]`)
  }

  // =============================================================
  // 14. 恢复原始状态 — 所有修改的 agent 配置在测试后恢复
  // =============================================================
  console.log('\n━━━ 14. 恢复原始状态 ━━━')
  if (target && originals.targetId) {
    // 恢复前快照: 当前 (被修改后) 的值
    const beforeRestore = await agent(`api.agent.get(${JSON.stringify(target.id)})`)
    const beforeSoul = await agent(`api.agent.getSoul(${JSON.stringify(target.id)})`)
    const beforeRules = await agent(`api.agent.getRules(${JSON.stringify(target.id)})`)
    console.log(`  恢复前: enabled=${beforeRestore.data?.enabled} modelTier=${beforeRestore.data?.modelTier} descLen=${beforeRestore.data?.description?.length} soulLen=${beforeSoul.data?.length} rulesLen=${beforeRules.data?.length}`)

    // 执行恢复队列 (逆序)
    await restoreAll()

    // 恢复后验证: 与 step 5a 保存的原始值严格比对
    const afterRestore = await agent(`api.agent.get(${JSON.stringify(target.id)})`)
    const afterSoul = await agent(`api.agent.getSoul(${JSON.stringify(target.id)})`)
    const afterRules = await agent(`api.agent.getRules(${JSON.stringify(target.id)})`)

    const enabledRestored = afterRestore.data?.enabled === originals.enabled
    const descRestored = afterRestore.data?.description === originals.description
    const tierRestored = afterRestore.data?.modelTier === originals.modelTier
    const soulRestored = afterSoul.data === originals.soul
    const rulesRestored = afterRules.data === originals.rules

    record(`恢复 enabled 到原始值`, enabledRestored, `恢复后=${afterRestore.data?.enabled} 原始=${originals.enabled}`)
    record(`恢复 description 到原始值`, descRestored, `恢复后len=${afterRestore.data?.description?.length} 原始len=${originals.description.length} 匹配=${descRestored}`)
    record(`恢复 modelTier 到原始值`, tierRestored, `恢复后=${afterRestore.data?.modelTier} 原始=${originals.modelTier}`)
    record(`恢复 soul 到原始值`, soulRestored, `恢复后len=${afterSoul.data?.length} 原始len=${originals.soul.length} 匹配=${soulRestored}`)
    record(`恢复 rules 到原始值`, rulesRestored, `恢复后len=${afterRules.data?.length} 原始len=${originals.rules.length} 匹配=${rulesRestored}`)

    // 整体恢复完整性
    const allRestored = enabledRestored && descRestored && tierRestored && soulRestored && rulesRestored
    record(`恢复后整体完整性`, allRestored, `enabled=${enabledRestored} desc=${descRestored} tier=${tierRestored} soul=${soulRestored} rules=${rulesRestored}`)
  } else {
    record(`恢复原始状态`, false, '无修改目标')
  }

  // =============================================================
  // 汇总
  // =============================================================
  console.log('\n========== Agent 深度测试汇总 ==========')
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

main().catch(async (err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
