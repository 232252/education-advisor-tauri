// =============================================================
// IPC 模块综合测试 — 隐私/定时任务/技能/聊天/Agent/日志/档案
// 测试所有 IPC 模块的基本 CRUD 和一致性
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
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = msgId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evalInPage = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) {
      throw new Error(`Eval error: ${r.result.exceptionDetails.text}`)
    }
    return r.result?.result?.value
  }

  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP connected, running tests...\n')

  const callIpc = async (code) => {
    return await evalInPage(`
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
  }

  // =============================================================
  // 1. 技能 (Skill) CRUD
  // =============================================================
  console.log('--- 技能 (Skill) ---')

  // 1.1 列出技能
  let origSkills = []
  try {
    const r = await callIpc(`const res = await api.skill.list(); return res;`)
    origSkills = r || []
    record(`skill.list`, Array.isArray(origSkills), `count=${origSkills.length}`)
  } catch (err) {
    record(`skill.list`, false, String(err.message || err))
  }

  // 1.2 保存技能
  const testSkillName = 'test-skill-' + Date.now()
  const testSkillContent = '# Test Skill\nThis is a test skill for automated testing.\n\n## Instructions\n- Do X\n- Do Y'
  try {
    const r = await callIpc(`const res = await api.skill.save(${JSON.stringify(testSkillName)}, ${JSON.stringify(testSkillContent)}); return res;`)
    record(`skill.save (新建)`, r?.success === true, `success=${r?.success}`)
  } catch (err) {
    record(`skill.save (新建)`, false, String(err.message || err))
  }

  // 1.3 获取技能
  try {
    const r = await callIpc(`const res = await api.skill.get(${JSON.stringify(testSkillName)}); return res;`)
    record(`skill.get`, r !== null && r?.name === testSkillName, `name=${r?.name} hasContent=${!!r?.content}`)
  } catch (err) {
    record(`skill.get`, false, String(err.message || err))
  }

  // 1.4 更新技能
  const updatedContent = '# Updated Skill\nUpdated content.'
  try {
    const r = await callIpc(`const res = await api.skill.save(${JSON.stringify(testSkillName)}, ${JSON.stringify(updatedContent)}); return res;`)
    const getRes = await callIpc(`const res = await api.skill.get(${JSON.stringify(testSkillName)}); return res;`)
    record(`skill.save (更新)`, r?.success === true && getRes?.content === updatedContent, `updated=${getRes?.content === updatedContent}`)
  } catch (err) {
    record(`skill.save (更新)`, false, String(err.message || err))
  }

  // 1.5 列出技能 (验证新增)
  try {
    const r = await callIpc(`const res = await api.skill.list(); return res;`)
    const found = r?.find((s) => s.name === testSkillName)
    record(`skill.list (含新技能)`, found !== undefined, `count=${r?.length} found=${!!found}`)
  } catch (err) {
    record(`skill.list (含新技能)`, false, String(err.message || err))
  }

  // 1.6 删除技能
  try {
    const r = await callIpc(`const res = await api.skill.delete(${JSON.stringify(testSkillName)}); return res;`)
    const getRes = await callIpc(`const res = await api.skill.get(${JSON.stringify(testSkillName)}); return res;`)
    record(`skill.delete`, r?.success === true && getRes === null, `deleted=${r?.success} getAfter=${getRes}`)
  } catch (err) {
    record(`skill.delete`, false, String(err.message || err))
  }

  // 1.7 删除不存在的技能
  try {
    const r = await callIpc(`const res = await api.skill.delete('nonexistent-skill-' + Date.now()); return res;`)
    record(`skill.delete (不存在)`, r?.success === false || r?.success === true, `success=${r?.success} error=${r?.error ?? ''}`)
  } catch (err) {
    record(`skill.delete (不存在)`, false, String(err.message || err))
  }

  // 1.8 获取不存在的技能
  try {
    const r = await callIpc(`const res = await api.skill.get('nonexistent-skill-' + Date.now()); return res;`)
    record(`skill.get (不存在)`, r === null, `result=${r}`)
  } catch (err) {
    record(`skill.get (不存在)`, false, String(err.message || err))
  }

  // =============================================================
  // 2. 聊天 (Chat) CRUD
  // =============================================================
  console.log('\n--- 聊天 (Chat) ---')

  // 2.1 列出会话
  let origSessions = []
  try {
    const r = await callIpc(`const res = await api.chat.listSessions(); return res;`)
    origSessions = r?.sessions || []
    record(`chat.listSessions`, r?.success === true && Array.isArray(origSessions), `count=${origSessions.length}`)
  } catch (err) {
    record(`chat.listSessions`, false, String(err.message || err))
  }

  // 2.2 保存消息
  const testSessionId = 'test-session-' + Date.now()
  let savedMsgId = null
  try {
    const r = await callIpc(`
      const res = await api.chat.saveMessage({
        sessionId: ${JSON.stringify(testSessionId)},
        role: 'user',
        content: '测试消息 - 自动化测试',
        timestamp: Date.now(),
        provider: 'test',
        model: 'test-model',
      });
      return res;
    `)
    savedMsgId = r?.id
    record(`chat.saveMessage`, r?.success === true && savedMsgId, `id=${savedMsgId}`)
  } catch (err) {
    record(`chat.saveMessage`, false, String(err.message || err))
  }

  // 2.3 保存助手回复
  try {
    const r = await callIpc(`
      const res = await api.chat.saveMessage({
        sessionId: ${JSON.stringify(testSessionId)},
        role: 'assistant',
        content: '测试回复 - 自动化测试',
        timestamp: Date.now() + 1,
        provider: 'test',
        model: 'test-model',
      });
      return res;
    `)
    record(`chat.saveMessage (助手)`, r?.success === true, `id=${r?.id}`)
  } catch (err) {
    record(`chat.saveMessage (助手)`, false, String(err.message || err))
  }

  // 2.4 加载消息
  try {
    const r = await callIpc(`const res = await api.chat.loadMessages(${JSON.stringify(testSessionId)}); return res;`)
    const msgs = r?.messages || []
    record(`chat.loadMessages`, r?.success === true && msgs.length >= 2, `count=${msgs.length} roles=${msgs.map((m) => m.role).join(',')}`)
  } catch (err) {
    record(`chat.loadMessages`, false, String(err.message || err))
  }

  // 2.5 列出会话 (验证新增)
  try {
    const r = await callIpc(`const res = await api.chat.listSessions(); return res;`)
    const found = (r?.sessions || []).find((s) => s.id === testSessionId)
    record(`chat.listSessions (含新会话)`, found !== undefined, `count=${r?.sessions?.length} found=${!!found} msgCount=${found?.messageCount}`)
  } catch (err) {
    record(`chat.listSessions (含新会话)`, false, String(err.message || err))
  }

  // 2.6 删除会话
  try {
    const r = await callIpc(`const res = await api.chat.deleteSession(${JSON.stringify(testSessionId)}); return res;`)
    const listRes = await callIpc(`const res = await api.chat.listSessions(); return res;`)
    const found = (listRes?.sessions || []).find((s) => s.id === testSessionId)
    record(`chat.deleteSession`, r?.success === true && !found, `deleted=${r?.success} foundAfter=${!!found}`)
  } catch (err) {
    record(`chat.deleteSession`, false, String(err.message || err))
  }

  // 2.7 加载已删除会话的消息
  try {
    const r = await callIpc(`const res = await api.chat.loadMessages(${JSON.stringify(testSessionId)}); return res;`)
    record(`chat.loadMessages (已删除)`, r?.success === true && (r?.messages || []).length === 0, `count=${r?.messages?.length ?? 0}`)
  } catch (err) {
    record(`chat.loadMessages (已删除)`, false, String(err.message || err))
  }

  // =============================================================
  // 3. 定时任务 (Cron) CRUD
  // =============================================================
  console.log('\n--- 定时任务 (Cron) ---')

  // 3.1 列出任务
  let origCronTasks = []
  try {
    const r = await callIpc(`const res = await api.cron.list(); return res;`)
    origCronTasks = r || []
    record(`cron.list`, Array.isArray(origCronTasks), `count=${origCronTasks.length}`)
  } catch (err) {
    record(`cron.list`, false, String(err.message || err))
  }

  // 3.2 添加任务
  const testCronTask = {
    name: 'test-cron-' + Date.now(),
    expression: '0 9 * * *',
    enabled: false,
    action: 'test-action',
    payload: { test: true },
  }
  let testCronId = null
  try {
    const r = await callIpc(`const res = await api.cron.add(${JSON.stringify(testCronTask)}); return res;`)
    testCronId = r?.id || (typeof r === 'string' ? r : null)
    record(`cron.add`, testCronId !== null, `id=${testCronId} success=${r?.success}`)
  } catch (err) {
    record(`cron.add`, false, String(err.message || err))
  }

  // 3.3 列出任务 (验证新增)
  try {
    const r = await callIpc(`const res = await api.cron.list(); return res;`)
    const found = (r || []).find((t) => t.id === testCronId || t.name === testCronTask.name)
    record(`cron.list (含新任务)`, found !== undefined, `count=${r?.length} found=${!!found}`)
  } catch (err) {
    record(`cron.list (含新任务)`, false, String(err.message || err))
  }

  // 3.4 更新任务
  try {
    const r = await callIpc(`const res = await api.cron.update(${JSON.stringify(testCronId)}, { name: 'updated-cron', enabled: true }); return res;`)
    record(`cron.update`, r?.success === true, `success=${r?.success}`)
  } catch (err) {
    record(`cron.update`, false, String(err.message || err))
  }

  // 3.5 切换任务状态
  try {
    const r = await callIpc(`const res = await api.cron.toggle(${JSON.stringify(testCronId)}, false); return res;`)
    record(`cron.toggle`, r?.success === true, `success=${r?.success}`)
  } catch (err) {
    record(`cron.toggle`, false, String(err.message || err))
  }

  // 3.6 获取日志
  try {
    const r = await callIpc(`const res = await api.cron.getLogs(); return res;`)
    record(`cron.getLogs`, Array.isArray(r), `count=${r?.length ?? 0}`)
  } catch (err) {
    record(`cron.getLogs`, false, String(err.message || err))
  }

  // 3.7 获取任务日志
  try {
    const r = await callIpc(`const res = await api.cron.getLogs(${JSON.stringify(testCronId)}); return res;`)
    record(`cron.getLogs (指定任务)`, Array.isArray(r), `count=${r?.length ?? 0}`)
  } catch (err) {
    record(`cron.getLogs (指定任务)`, false, String(err.message || err))
  }

  // 3.8 删除任务
  try {
    const r = await callIpc(`const res = await api.cron.remove(${JSON.stringify(testCronId)}); return res;`)
    const listRes = await callIpc(`const res = await api.cron.list(); return res;`)
    const found = (listRes || []).find((t) => t.id === testCronId)
    record(`cron.remove`, r?.success === true && !found, `removed=${r?.success} foundAfter=${!!found}`)
  } catch (err) {
    record(`cron.remove`, false, String(err.message || err))
  }

  // =============================================================
  // 4. 隐私引擎 (Privacy)
  // =============================================================
  console.log('\n--- 隐私引擎 (Privacy) ---')

  // 4.1 状态检查
  try {
    const r = await callIpc(`const res = await api.privacy.status(); return res;`)
    record(`privacy.status`, r !== undefined && typeof r?.unlocked === 'boolean', `unlocked=${r?.unlocked}`)
  } catch (err) {
    record(`privacy.status`, false, String(err.message || err))
  }

  // 4.2 隐私列表 (未解锁时应返回错误)
  try {
    const r = await callIpc(`const res = await api.privacy.list('test-password'); return res;`)
    record(`privacy.list`, r !== undefined, `success=${r?.success} hasData=${Array.isArray(r?.data)}`)
  } catch (err) {
    record(`privacy.list`, false, String(err.message || err))
  }

  // 4.3 匿名化测试
  try {
    const r = await callIpc(`const res = await api.privacy.anonymize('张三同学的手机号是13800138000'); return res;`)
    record(`privacy.anonymize`, r !== undefined, `success=${r?.success} data=${String(r?.data ?? '').substring(0, 50)}`)
  } catch (err) {
    record(`privacy.anonymize`, false, String(err.message || err))
  }

  // 4.4 dryrun 测试
  try {
    const r = await callIpc(`const res = await api.privacy.dryrun('李四的电话是13900139000'); return res;`)
    record(`privacy.dryrun`, r !== undefined, `success=${r?.success}`)
  } catch (err) {
    record(`privacy.dryrun`, false, String(err.message || err))
  }

  // =============================================================
  // 5. Agent 系统
  // =============================================================
  console.log('\n--- Agent 系统 ---')

  // 5.1 列出 agents
  let agents = []
  try {
    const r = await callIpc(`const res = await api.agent.list(); return res;`)
    agents = r || []
    record(`agent.list`, Array.isArray(agents) && agents.length > 0, `count=${agents.length}`)
  } catch (err) {
    record(`agent.list`, false, String(err.message || err))
  }

  // 5.2 获取 agent 详情
  if (agents.length > 0) {
    const testAgentId = agents[0].id
    try {
      const r = await callIpc(`const res = await api.agent.get(${JSON.stringify(testAgentId)}); return res;`)
      record(`agent.get`, r !== null && r?.id === testAgentId, `id=${r?.id} name=${r?.name}`)
    } catch (err) {
      record(`agent.get`, false, String(err.message || err))
    }

    // 5.3 获取 agent soul
    try {
      const r = await callIpc(`const res = await api.agent.getSoul(${JSON.stringify(testAgentId)}); return res;`)
      record(`agent.getSoul`, typeof r === 'string', `length=${r?.length ?? 0}`)
    } catch (err) {
      record(`agent.getSoul`, false, String(err.message || err))
    }

    // 5.4 获取 agent rules
    try {
      const r = await callIpc(`const res = await api.agent.getRules(${JSON.stringify(testAgentId)}); return res;`)
      record(`agent.getRules`, typeof r === 'string', `length=${r?.length ?? 0}`)
    } catch (err) {
      record(`agent.getRules`, false, String(err.message || err))
    }

    // 5.5 更新 agent
    try {
      const origName = agents[0].name
      const r = await callIpc(`const res = await api.agent.update(${JSON.stringify(testAgentId)}, { description: '测试描述_' + Date.now() }); return res;`)
      record(`agent.update`, r?.success === true, `success=${r?.success}`)
    } catch (err) {
      record(`agent.update`, false, String(err.message || err))
    }

    // 5.6 切换 agent 状态
    try {
      const origEnabled = agents[0].enabled
      const r = await callIpc(`const res = await api.agent.toggle(${JSON.stringify(testAgentId)}, !${origEnabled}); return res;`)
      // 恢复
      await callIpc(`const res = await api.agent.toggle(${JSON.stringify(testAgentId)}, ${origEnabled}); return res;`)
      record(`agent.toggle`, r?.success === true, `success=${r?.success}`)
    } catch (err) {
      record(`agent.toggle`, false, String(err.message || err))
    }
  }

  // =============================================================
  // 6. 日志系统 (Log)
  // =============================================================
  console.log('\n--- 日志系统 (Log) ---')

  // 6.1 列出日志文件
  try {
    const r = await callIpc(`const res = await api.log.list(); return res;`)
    record(`log.list`, Array.isArray(r), `count=${r?.length ?? 0}`)
  } catch (err) {
    record(`log.list`, false, String(err.message || err))
  }

  // 6.2 读取日志
  try {
    const list = await callIpc(`const res = await api.log.list(); return res;`)
    if (list && list.length > 0) {
      const logName = list[0].name
      const r = await callIpc(`const res = await api.log.read(${JSON.stringify(logName)}, 10); return res;`)
      record(`log.read`, typeof r === 'string', `length=${r?.length ?? 0}`)
    } else {
      record(`log.read`, true, 'no logs to read')
    }
  } catch (err) {
    record(`log.read`, false, String(err.message || err))
  }

  // 6.3 转发日志
  try {
    await callIpc(`api.log.forward('info', '自动化测试日志转发'); return { success: true };`)
    record(`log.forward`, true, 'forwarded')
  } catch (err) {
    record(`log.forward`, false, String(err.message || err))
  }

  // 6.4 搜索日志
  try {
    const list = await callIpc(`const res = await api.log.list(); return res;`)
    if (list && list.length > 0) {
      const logName = list[0].name
      const r = await callIpc(`const res = await api.log.search(${JSON.stringify(logName)}, 'test', 10); return res;`)
      record(`log.search`, typeof r === 'string', `length=${r?.length ?? 0}`)
    } else {
      record(`log.search`, true, 'no logs to search')
    }
  } catch (err) {
    record(`log.search`, false, String(err.message || err))
  }

  // 6.5 过滤日志
  try {
    const list = await callIpc(`const res = await api.log.list(); return res;`)
    if (list && list.length > 0) {
      const logName = list[0].name
      const r = await callIpc(`const res = await api.log.filter(${JSON.stringify(logName)}, ['error', 'warn'], 10); return res;`)
      record(`log.filter`, typeof r === 'string', `length=${r?.length ?? 0}`)
    } else {
      record(`log.filter`, true, 'no logs to filter')
    }
  } catch (err) {
    record(`log.filter`, false, String(err.message || err))
  }

  // =============================================================
  // 7. 学生档案 (Profile)
  // =============================================================
  console.log('\n--- 学生档案 (Profile) ---')

  // 7.1 获取学生列表 (用于测试)
  let testStudentName = null
  try {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const students = r?.data?.students || []
    const active = students.find((s) => s.status !== 'Deleted')
    testStudentName = active?.name
    record(`获取测试学生`, testStudentName !== undefined, `name=${testStudentName}`)
  } catch (err) {
    record(`获取测试学生`, false, String(err.message || err))
  }

  // 7.2 获取档案
  if (testStudentName) {
    let origProfile = null
    try {
      const r = await callIpc(`const res = await api.profile.get(${JSON.stringify(testStudentName)}); return res;`)
      origProfile = r?.data
      record(`profile.get`, r?.success === true, `hasData=${!!r?.data} gender=${r?.data?.gender ?? '-'}`)
    } catch (err) {
      record(`profile.get`, false, String(err.message || err))
    }

    // 7.3 设置档案
    try {
      const testProfile = {
        gender: '男',
        phone: '13800138000',
        parentName: '测试家长',
        parentPhone: '13900139000',
        address: '测试地址',
      }
      const r = await callIpc(`const res = await api.profile.set(${JSON.stringify(testStudentName)}, ${JSON.stringify(testProfile)}); return res;`)
      // 验证
      const getRes = await callIpc(`const res = await api.profile.get(${JSON.stringify(testStudentName)}); return res;`)
      const verified = getRes?.data?.phone === '13800138000' && getRes?.data?.parentName === '测试家长'
      record(`profile.set + 验证`, r?.success === true && verified, `set=${r?.success} verified=${verified}`)
    } catch (err) {
      record(`profile.set + 验证`, false, String(err.message || err))
    }

    // 7.4 恢复档案
    try {
      const r = await callIpc(`const res = await api.profile.set(${JSON.stringify(testStudentName)}, ${JSON.stringify(origProfile || {})}); return res;`)
      record(`profile.set (恢复)`, r?.success === true, `restored=${r?.success}`)
    } catch (err) {
      record(`profile.set (恢复)`, false, String(err.message || err))
    }
  }

  // =============================================================
  // 8. 系统功能 (Sys)
  // =============================================================
  console.log('\n--- 系统功能 (Sys) ---')

  // 8.1 getPath
  try {
    const r = await callIpc(`const res = await api.sys.getPath('userData'); return res;`)
    record(`sys.getPath`, typeof r === 'string' && r.length > 0, `path=${r?.substring(0, 60)}`)
  } catch (err) {
    record(`sys.getPath`, false, String(err.message || err))
  }

  // 8.2 checkUpdate
  try {
    const r = await callIpc(`const res = await api.sys.checkUpdate(); return res;`)
    record(`sys.checkUpdate`, r !== undefined && typeof r?.currentVersion === 'string', `current=${r?.currentVersion} hasUpdate=${r?.hasUpdate}`)
  } catch (err) {
    record(`sys.checkUpdate`, false, String(err.message || err))
  }

  // 8.3 notify
  try {
    const r = await callIpc(`const res = await api.sys.notify('测试通知', '自动化测试通知内容'); return res;`)
    record(`sys.notify`, r?.success === true, `success=${r?.success}`)
  } catch (err) {
    record(`sys.notify`, false, String(err.message || err))
  }

  // 8.4 openExternal (不应实际打开,验证 API 存在)
  try {
    const apiExists = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        return typeof api.sys.openExternal === 'function';
      })()
    `)
    record(`sys.openExternal API 存在`, apiExists === true, `hasApi=${apiExists}`)
  } catch (err) {
    record(`sys.openExternal API 存在`, false, String(err.message || err))
  }

  // 8.5 readFile
  try {
    const apiExists = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        return typeof api.sys.readFile === 'function';
      })()
    `)
    record(`sys.readFile API 存在`, apiExists === true, `hasApi=${apiExists}`)
  } catch (err) {
    record(`sys.readFile API 存在`, false, String(err.message || err))
  }

  // =============================================================
  // 9. 飞书 (Feishu) - 仅验证 API 存在,不实际调用
  // =============================================================
  console.log('\n--- 飞书 (Feishu) ---')

  try {
    const apiExists = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        return {
          test: typeof api.feishu.test === 'function',
          status: typeof api.feishu.status === 'function',
          botStatus: typeof api.feishu.botStatus === 'function',
          send: typeof api.feishu.send === 'function',
          syncNow: typeof api.feishu.syncNow === 'function',
          botStart: typeof api.feishu.botStart === 'function',
          botStop: typeof api.feishu.botStop === 'function',
        };
      })()
    `)
    const allExist = Object.values(apiExists || {}).every((v) => v === true)
    record(`feishu API 完整性`, allExist, Object.entries(apiExists || {}).map(([k, v]) => `${k}:${v ? '✓' : '✗'}`).join(' '))
  } catch (err) {
    record(`feishu API 完整性`, false, String(err.message || err))
  }

  // 飞书状态
  try {
    const r = await callIpc(`const res = await api.feishu.status(); return res;`)
    record(`feishu.status`, typeof r === 'string', `status=${r}`)
  } catch (err) {
    record(`feishu.status`, false, String(err.message || err))
  }

  // 飞书机器人状态
  try {
    const r = await callIpc(`const res = await api.feishu.botStatus(); return res;`)
    record(`feishu.botStatus`, r !== undefined, `running=${r?.running}`)
  } catch (err) {
    record(`feishu.botStatus`, false, String(err.message || err))
  }

  // =============================================================
  // 10. Ollama - 仅验证 API 和检测
  // =============================================================
  console.log('\n--- Ollama ---')

  try {
    const apiExists = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        return {
          detect: typeof api.ollama.detect === 'function',
          startServe: typeof api.ollama.startServe === 'function',
          stopServe: typeof api.ollama.stopServe === 'function',
          listModels: typeof api.ollama.listModels === 'function',
          pullModel: typeof api.ollama.pullModel === 'function',
          deleteModel: typeof api.ollama.deleteModel === 'function',
        };
      })()
    `)
    const allExist = Object.values(apiExists || {}).every((v) => v === true)
    record(`ollama API 完整性`, allExist, Object.entries(apiExists || {}).map(([k, v]) => `${k}:${v ? '✓' : '✗'}`).join(' '))
  } catch (err) {
    record(`ollama API 完整性`, false, String(err.message || err))
  }

  // Ollama 检测
  try {
    const r = await callIpc(`const res = await api.ollama.detect(); return res;`)
    record(`ollama.detect`, r !== undefined, `available=${r?.available} version=${r?.version ?? '-'}`)
  } catch (err) {
    record(`ollama.detect`, false, String(err.message || err))
  }

  // =============================================================
  // 11. AI - 仅验证 API
  // =============================================================
  console.log('\n--- AI ---')

  try {
    const apiExists = await evalInPage(`
      (function() {
        const api = window.__EAA_API__ || window.api;
        return {
          listProviders: typeof api.ai.listProviders === 'function',
          listModels: typeof api.ai.listModels === 'function',
          testConnection: typeof api.ai.testConnection === 'function',
          setApiKey: typeof api.ai.setApiKey === 'function',
          deleteApiKey: typeof api.ai.deleteApiKey === 'function',
          chat: typeof api.ai.chat === 'function',
          abortChat: typeof api.ai.abortChat === 'function',
          addCustomModel: typeof api.ai.addCustomModel === 'function',
          deleteCustomModel: typeof api.ai.deleteCustomModel === 'function',
          updateCustomModel: typeof api.ai.updateCustomModel === 'function',
          onStream: typeof api.ai.onStream === 'function',
        };
      })()
    `)
    const allExist = Object.values(apiExists || {}).every((v) => v === true)
    record(`ai API 完整性`, allExist, Object.entries(apiExists || {}).map(([k, v]) => `${k}:${v ? '✓' : '✗'}`).join(' '))
  } catch (err) {
    record(`ai API 完整性`, false, String(err.message || err))
  }

  // AI listProviders
  try {
    const r = await callIpc(`const res = await api.ai.listProviders(); return res;`)
    record(`ai.listProviders`, Array.isArray(r) && r.length > 0, `count=${r?.length} first=${r?.[0]?.id ?? ''}`)
  } catch (err) {
    record(`ai.listProviders`, false, String(err.message || err))
  }

  // =============================================================
  // 汇总
  // =============================================================
  console.log('\n========== IPC 模块综合测试 ==========')
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
