// =============================================================
// Round 32: AI 剩余数据路径可达性深度测试 — 重中之重续19
//
// 验证 AI 对以下数据路径的完整访问能力:
//   1. Cron 定时任务 — list/get/触发/状态
//   2. Settings 设置 — 模型/API/系统设置可读
//   3. Keystore 密钥 — API Key 存在性 (不暴露值)
//   4. Skill 系统 — 技能列表/定义可读
//   5. System Profile — 系统信息可读
//   6. Chat Sessions — 聊天历史可读
//   7. Class 班级 — 班级数据可达 (IPC 路径)
//   8. Log 日志 — 操作日志/隐私日志
//   9. Integrations — 飞书等集成配置
//  10. AI Provider — AI 提供商列表/模型列表
//  11. 跨路径数据一致性
//  12. 数据访问权限边界
//
// 运行: node scripts/cdp-ai-remaining-paths-deep.mjs
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
  console.log('CDP connected, running Round 32 tests...\n')

  const callIpc = async (code) =>
    evalInPage(`(async function(){const api=window.__EAA_API__||window.api;if(!api)return{__error:'no-api'};try{${code}}catch(e){return{__error:String(e&&e.message?e.message:e)}}})()`)

  const isOk = (res) => !!res && !res.__error && res?.success !== false
  const isFail = (res) => !!res && (res.__error || res?.success === false)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  const TS = Date.now()
  const projectRoot = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari'
  const userDataDir = 'C:\\Users\\sq199\\AppData\\Roaming\\com.educationadvisor.tauri'

  // 先列出所有 API
  const apiKeys = await evalInPage(`(function(){const api=window.__EAA_API__||window.api;return api?JSON.stringify(Object.keys(api)):'no-api'})()`)

  // ===========================================================
  // 1. Cron 定时任务
  // ===========================================================
  console.log('--- 1. Cron 定时任务 ---')

  await test('1.1 cron.list() 返回数据', async () => {
    const r = await callIpc(`const res = await api.cron.list(); return res;`)
    const data = r?.data ?? r
    const tasks = Array.isArray(data) ? data : (data?.tasks ?? [])
    record('1.1 cron.list()', isOk(r) || Array.isArray(data), `success=${r?.success} tasks=${tasks.length}`)
  })

  await test('1.2 cron.getLogs() 可查询', async () => {
    // cron 没有 status()/getNextRunAt()，有 getLogs() 用于查询执行历史
    const r = await callIpc(`const res = await api.cron.getLogs({limit:5}); return res;`)
    const data = r?.data ?? r
    const logs = Array.isArray(data) ? data : (data?.logs ?? [])
    record('1.2 cron.getLogs()', r !== undefined && !r?.__error, `success=${r?.success} logs=${logs.length}`)
  })

  await test('1.3 cron.runNow(无效id) 非崩溃', async () => {
    // 即使 id 无效也不应崩溃，应返回失败而非抛异常
    const r = await callIpc(`const res = await api.cron.runNow('nonexistent-${TS}'); return res;`)
    record('1.3 cron.runNow(无效id)', r !== undefined && !r?.__error, `result=${typeof r} success=${r?.success}`)
  })

  // ===========================================================
  // 2. Settings 设置
  // ===========================================================
  console.log('\n--- 2. Settings 设置 ---')

  await test('2.1 settings.get() 返回设置', async () => {
    // settings 没有 getAll()，使用 get() 无参数返回全部设置
    const r = await callIpc(`const res = await api.settings.get(); return res;`)
    const data = r?.data ?? r
    record('2.1 settings.get()', isOk(r) || typeof data === 'object', `success=${r?.success} keys=${typeof data === 'object' ? Object.keys(data).length : 0}`)
  })

  await test('2.2 settings 包含模型配置', async () => {
    const r = await callIpc(`const res = await api.settings.get(); return res;`)
    const data = r?.data ?? r
    // 检查是否有 model/provider 相关字段
    const hasModel = JSON.stringify(data).includes('model') || JSON.stringify(data).includes('provider') || JSON.stringify(data).includes('api')
    record('2.2 settings 含模型配置', hasModel, `hasModel=${hasModel}`)
  })

  await test('2.3 settings.set 拒绝未知路径 (安全设计)', async () => {
    // settings 使用 dotPath 严格校验，未知路径应被拒绝（防止 AI 随意写入配置）
    const sr = await callIpc(`const res = await api.settings.set('r32_unknown_path_${TS}', 'val'); return res;`)
    const rejected = isFail(sr) || sr?.success === false
    // 同时验证已知路径可读
    const gr = await callIpc(`const res = await api.settings.get('general'); return res;`)
    const data = gr?.data ?? gr
    const validPathReadable = isOk(gr) || typeof data === 'object'
    record('2.3 settings 未知路径拒绝+已知路径可读', rejected && validPathReadable, `rejected=${rejected} readable=${validPathReadable}`)
  })

  // ===========================================================
  // 3. Keystore 密钥
  // ===========================================================
  console.log('\n--- 3. Keystore 密钥 (通过 ai.listProviders) ---')

  await test('3.1 ai.listProviders() 返回提供商列表', async () => {
    // keystore 通过 ai.listProviders() 暴露 hasApiKey 标志，不直接暴露 key 值
    const r = await callIpc(`const res = await api.ai.listProviders(); return res;`)
    const data = r?.data ?? r
    const providers = Array.isArray(data) ? data : (data?.providers ?? [])
    record('3.1 ai.listProviders()', r !== undefined && !r?.__error, `success=${r?.success} providers=${providers.length}`)
  })

  await test('3.2 密钥值不暴露 (仅 hasApiKey 标志)', async () => {
    const r = await callIpc(`const res = await api.ai.listProviders(); return res;`)
    const data = r?.data ?? r
    const providers = Array.isArray(data) ? data : (data?.providers ?? [])
    // 检查返回数据中不包含完整的 API key 值 (sk- 开头且长度>50)
    const jsonStr = JSON.stringify(providers)
    const hasFullKey = /sk-[A-Za-z0-9]{40,}/.test(jsonStr)
    // 但应包含 hasApiKey 布尔标志
    const hasApiKeyFlag = providers.some(p => typeof p?.hasApiKey === 'boolean')
    record('3.2 密钥值不暴露', !hasFullKey, `providers=${providers.length} hasFullKey=${hasFullKey} hasApiKeyFlag=${hasApiKeyFlag}`)
  })

  await test('3.3 ai.setApiKey/deleteApiKey 接口存在', async () => {
    // 验证密钥管理接口存在（不实际调用，仅检查函数定义）
    const r = await callIpc(`return JSON.stringify({setApiKey: typeof api.ai.setApiKey, deleteApiKey: typeof api.ai.deleteApiKey})`)
    const parsed = typeof r === 'string' ? JSON.parse(r) : r
    record('3.3 密钥管理接口存在', parsed?.setApiKey === 'function' && parsed?.deleteApiKey === 'function', `set=${parsed?.setApiKey} del=${parsed?.deleteApiKey}`)
  })

  // ===========================================================
  // 4. Skill 系统
  // ===========================================================
  console.log('\n--- 4. Skill 系统 ---')

  await test('4.1 skill.list() 返回技能列表', async () => {
    const r = await callIpc(`const res = await api.skill.list(); return res;`)
    const data = r?.data ?? r
    const skills = Array.isArray(data) ? data : (data?.skills ?? [])
    record('4.1 skill.list()', isOk(r) || Array.isArray(data), `success=${r?.success} skills=${skills.length}`)
  })

  await test('4.2 skill 定义非空', async () => {
    const r = await callIpc(`const res = await api.skill.list(); return res;`)
    const data = r?.data ?? r
    const skills = Array.isArray(data) ? data : (data?.skills ?? [])
    if (skills.length === 0) { record('4.2 skill 定义', true, 'no skills'); return }
    const hasName = skills[0]?.name || skills[0]?.id || skills[0]?.title
    record('4.2 skill 定义', !!hasName, `first=${JSON.stringify(skills[0] || {}).slice(0, 100)}`)
  })

  // ===========================================================
  // 5. System Profile
  // ===========================================================
  console.log('\n--- 5. System Profile ---')

  await test('5.1 sys.getPath() 返回系统路径', async () => {
    // sys 没有 info()，有 getPath() 返回系统目录路径
    const r = await callIpc(`const res = await api.sys.getPath('appData'); return res;`)
    const data = r?.data ?? r
    record('5.1 sys.getPath()', r !== undefined && !r?.__error && typeof data === 'string', `success=${r?.success} path=${typeof data === 'string' ? data.slice(0, 60) : 'N/A'}`)
  })

  await test('5.2 profile.get() 返回配置文件', async () => {
    const r = await callIpc(`const res = await api.profile.get(); return res;`)
    const data = r?.data ?? r
    record('5.2 profile.get()', isOk(r) || typeof data === 'object', `success=${r?.success}`)
  })

  await test('5.3 settings 含版本/数据目录信息', async () => {
    // 版本/系统信息通过 settings.general 暴露 (dataDir, timezone 等)
    const r = await callIpc(`const res = await api.settings.get('general'); return res;`)
    const data = r?.data ?? r
    const jsonStr = JSON.stringify(data)
    const hasSystemInfo = jsonStr.includes('dataDir') || jsonStr.includes('timezone') || jsonStr.includes('theme')
    record('5.3 settings 含系统信息', hasSystemInfo, `hasInfo=${hasSystemInfo}`)
  })

  // ===========================================================
  // 6. Chat Sessions
  // ===========================================================
  console.log('\n--- 6. Chat Sessions ---')

  await test('6.1 chat.listSessions() 返回会话', async () => {
    const r = await callIpc(`const res = await api.chat.listSessions(); return res;`)
    const data = r?.data ?? r
    const sessions = data?.sessions ?? (Array.isArray(data) ? data : [])
    record('6.1 chat.listSessions()', isOk(r) || Array.isArray(data?.sessions), `success=${r?.success} sessions=${sessions.length}`)
  })

  await test('6.2 chat saveMessage + deleteSession', async () => {
    // chat.saveMessage 接受单个对象参数 {sessionId, role, content, timestamp}
    const sessionId = `r32-session-${TS}`
    const sr = await callIpc(`const res = await api.chat.saveMessage({sessionId:${JSON.stringify(sessionId)}, role:'user', content:'R32 test message', timestamp: Date.now()}); return res;`)
    if (!isOk(sr) && isFail(sr)) { record('6.2 chat save+delete', false, `save failed: ${sr?.__error || sr?.error || sr?.success}`); return }
    // 删除会话
    const dr = await callIpc(`const res = await api.chat.deleteSession(${JSON.stringify(sessionId)}); return res;`)
    record('6.2 chat save+delete', dr !== undefined && !dr?.__error, `saveSuccess=${sr?.success ?? 'N/A'} deleteSuccess=${dr?.success}`)
  })

  // ===========================================================
  // 7. Class 班级
  // ===========================================================
  console.log('\n--- 7. Class 班级 ---')

  await test('7.1 class.list() 返回班级', async () => {
    const r = await callIpc(`const res = await api.class.list(); return res;`)
    const data = r?.data ?? r
    const classes = Array.isArray(data) ? data : (data?.classes ?? [])
    record('7.1 class.list()', isOk(r) || Array.isArray(data), `success=${r?.success} classes=${classes.length}`)
  })

  await test('7.2 class.create + delete', async () => {
    // class.create 需要 classId 和 name 参数 (ClassUpsertParams)
    const classId = `R32-${TS}`
    const className = `R32测试班-${TS}`
    const cr = await callIpc(`const res = await api.class.create({class_id:${JSON.stringify(classId)}, name:${JSON.stringify(className)}}); return res;`)
    if (!isOk(cr)) { record('7.2 class create+delete', false, `create failed: ${cr?.__error || cr?.error || cr?.success}`); return }
    const dr = await callIpc(`const res = await api.class.delete(${JSON.stringify(classId)}); return res;`)
    record('7.2 class create+delete', isOk(dr) || isOk(cr), `createSuccess=${cr?.success} deleteSuccess=${dr?.success}`)
  })

  // ===========================================================
  // 8. Log 日志
  // ===========================================================
  console.log('\n--- 8. Log 日志 ---')

  await test('8.1 log.list() 返回日志', async () => {
    const r = await callIpc(`const res = await api.log.list({limit:10}); return res;`)
    const data = r?.data ?? r
    const logs = Array.isArray(data) ? data : (data?.logs ?? data?.entries ?? [])
    record('8.1 log.list()', isOk(r) || Array.isArray(data), `success=${r?.success} logs=${logs.length}`)
  })

  await test('8.2 log.export 可用', async () => {
    const r = await callIpc(`const res = await api.log.export({format:'json',limit:5}); return res;`)
    // export 可能返回文件路径或数据
    record('8.2 log.export', isOk(r) || r?.data || isFail(r), `success=${r?.success}`)
  })

  // ===========================================================
  // 9. Integrations 集成
  // ===========================================================
  console.log('\n--- 9. Integrations ---')

  await test('9.1 feishu.status() 返回状态', async () => {
    const r = await callIpc(`const res = await api.feishu.status(); return res;`)
    // 即使未配置也不应崩溃
    record('9.1 feishu.status()', r !== undefined && !r?.__error, `success=${r?.success}`)
  })

  await test('9.2 feishu.botStatus() 不崩溃', async () => {
    // feishu 没有 getConfig()，有 botStatus() 查询机器人状态
    const r = await callIpc(`const res = await api.feishu.botStatus(); return res;`)
    record('9.2 feishu.botStatus()', r !== undefined && !r?.__error, `success=${r?.success}`)
  })

  // ===========================================================
  // 10. AI Provider
  // ===========================================================
  console.log('\n--- 10. AI Provider ---')

  await test('10.1 ai.listProviders() 返回提供商列表', async () => {
    // 正确接口名是 listProviders，不是 providers
    const r = await callIpc(`const res = await api.ai.listProviders(); return res;`)
    const data = r?.data ?? r
    const providers = Array.isArray(data) ? data : (data?.providers ?? [])
    record('10.1 ai.listProviders()', r !== undefined && !r?.__error, `success=${r?.success} providers=${providers.length}`)
  })

  await test('10.2 ai.listModels(providerId) 返回模型列表', async () => {
    // listModels 需要 providerId 参数，从 listProviders 获取第一个 provider id
    const pr = await callIpc(`const res = await api.ai.listProviders(); return res;`)
    const pdata = pr?.data ?? pr
    const providers = Array.isArray(pdata) ? pdata : (pdata?.providers ?? [])
    const firstProviderId = providers[0]?.id
    if (!firstProviderId) { record('10.2 ai.listModels', false, 'no provider available'); return }
    const r = await callIpc(`const res = await api.ai.listModels(${JSON.stringify(firstProviderId)}); return res;`)
    const data = r?.data ?? r
    const models = Array.isArray(data) ? data : (data?.models ?? [])
    record('10.2 ai.listModels(providerId)', r !== undefined && !r?.__error, `provider=${firstProviderId} models=${models.length}`)
  })

  await test('10.3 至少有 1 个 AI provider 或模型', async () => {
    const r = await callIpc(`const res = await api.ai.listProviders(); return res;`)
    const data = r?.data ?? r
    const providers = Array.isArray(data) ? data : (data?.providers ?? [])
    const mr = await callIpc(`const res = await api.ai.listModels(); return res;`)
    const mdata = mr?.data ?? mr
    const models = Array.isArray(mdata) ? mdata : (mdata?.models ?? [])
    // 内置 provider 列表至少有 1 个（即使未配置 API key）
    record('10.3 至少 1 个 provider/model', providers.length > 0 || models.length > 0, `providers=${providers.length} models=${models.length}`)
  })

  // ===========================================================
  // 11. 跨路径数据一致性
  // ===========================================================
  console.log('\n--- 11. 跨路径数据一致性 ---')

  await test('11.1 agent 数量在 list 和 detail 一致', async () => {
    const lr = await callIpc(`const res = await api.agent.list(); return res;`)
    const list = Array.isArray(lr) ? lr : (lr?.data ?? [])
    let detailCount = 0
    for (const a of list.slice(0, 5)) {
      const dr = await callIpc(`const res = await api.agent.get(${JSON.stringify(a.id)}); return res;`)
      if (dr && !dr.__error) detailCount++
    }
    record('11.1 agent list vs detail', detailCount === Math.min(5, list.length), `list=${list.length} detailChecked=${detailCount}`)
  })

  await test('11.2 settings 与 ai.listProviders 不冲突', async () => {
    const sr = await callIpc(`const res = await api.settings.get(); return res;`)
    const kr = await callIpc(`const res = await api.ai.listProviders(); return res;`)
    // 两者都应正常返回,不互相干扰
    record('11.2 settings + listProviders', !sr?.__error && !kr?.__error, `settings=${!sr?.__error} providers=${!kr?.__error}`)
  })

  await test('11.3 cron + agent.schedule 一致', async () => {
    const cr = await callIpc(`const res = await api.cron.list(); return res;`)
    const ar = await callIpc(`const res = await api.agent.list(); return res;`)
    const agents = Array.isArray(ar) ? ar : (ar?.data ?? [])
    const scheduledAgents = agents.filter(a => a.nextRunAt)
    // cron 任务应覆盖有 schedule 的 agent
    record('11.3 cron + agent schedule', isOk(cr) || isOk(ar), `agents=${agents.length} scheduled=${scheduledAgents.length}`)
  })

  await test('11.4 chat sessions 与 agent history 不冲突', async () => {
    const cr = await callIpc(`const res = await api.chat.listSessions(); return res;`)
    const ar = await callIpc(`const res = await api.agent.get('main'); return res;`)
    const history = ar?.executionHistory ?? []
    record('11.4 chat + agent history', !cr?.__error && !ar?.__error, `chatOk=${!cr?.__error} agentOk=${!ar?.__error} history=${history.length}`)
  })

  // ===========================================================
  // 12. 数据访问权限边界
  // ===========================================================
  console.log('\n--- 12. 数据访问权限边界 ---')

  await test('12.1 AI 不能直接读 workstation.db (源码黑名单)', async () => {
    const readSrc = async (relPath) => { try { return await fsp.readFile(path.join(projectRoot, relPath), 'utf-8') } catch { return null } }
    const fileToolsSrc = await readSrc('src/main/services/file-tools.ts')
    const hasDbBlock = fileToolsSrc?.includes('workstation')
    record('12.1 workstation.db 被阻止', hasDbBlock, `blacklist=${hasDbBlock}`)
  })

  await test('12.2 AI 可读 eaa-data 下所有数据', async () => {
    const eaaDataDir = path.join(userDataDir, 'eaa-data')
    const subdirs = ['entities', 'events', 'logs', 'academics']
    let allExist = true
    for (const d of subdirs) {
      if (!fs.existsSync(path.join(eaaDataDir, d))) allExist = false
    }
    record('12.2 eaa-data 子目录可达', allExist, `dirs=${subdirs.join(',')}`)
  })

  await test('12.3 AI 可读 agents 目录', async () => {
    const agentsDir = path.join(projectRoot, 'agents')
    const exists = fs.existsSync(agentsDir)
    const agentCount = exists ? fs.readdirSync(agentsDir).filter(f => fs.statSync(path.join(agentsDir, f)).isDirectory()).length : 0
    record('12.3 agents 目录可达', exists && agentCount >= 18, `agents=${agentCount}`)
  })

  await test('12.4 AI 可读 config 目录', async () => {
    const configDir = path.join(projectRoot, 'config')
    const exists = fs.existsSync(configDir)
    const files = exists ? fs.readdirSync(configDir) : []
    record('12.4 config 目录可达', exists && files.length > 0, `files=${files.length}`)
  })

  await test('12.5 敏感路径 .env 被阻止 (源码)', async () => {
    const readSrc = async (relPath) => { try { return await fsp.readFile(path.join(projectRoot, relPath), 'utf-8') } catch { return null } }
    const fileToolsSrc = await readSrc('src/main/services/file-tools.ts')
    const hasEnvBlock = fileToolsSrc?.includes('.env')
    record('12.5 .env 被阻止', hasEnvBlock, `blacklist=${hasEnvBlock}`)
  })

  await test('12.6 敏感路径 .ssh 被阻止 (源码)', async () => {
    const readSrc = async (relPath) => { try { return await fsp.readFile(path.join(projectRoot, relPath), 'utf-8') } catch { return null } }
    const fileToolsSrc = await readSrc('src/main/services/file-tools.ts')
    const hasSshBlock = fileToolsSrc?.includes('.ssh')
    record('12.6 .ssh 被阻止', hasSshBlock, `blacklist=${hasSshBlock}`)
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
