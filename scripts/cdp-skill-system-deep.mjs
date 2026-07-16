// =============================================================
// 技能系统 深度测试 — Skill IPC handlers 全量覆盖
// 通过 CDP 远程调试 (端口 9222) 调用 Tauri/Electron 渲染进程 IPC API
//
// 覆盖: API 存在性 / list / get / save / delete / 目录结构 (user vs project)
//       / 元数据字段 / 边界 (空/超长/null/路径遍历/特殊字符) /
//       并发 / 错误处理 / 自清理 (创建的测试技能最终全部删除)
// 运行: node scripts/cdp-skill-system-deep.mjs
//
// 真实行为参考:
//   - skill-handlers.ts validateSkillName: 拒绝空/非字符串/>128字符/含 / \ .. \0
//     错误时 IPC 返回 { success:false, error }
//   - skill-service.ts getSkill: 未找到返回 null (非 {success:false})
//   - skill-service.ts saveSkill: 额外拒绝 : * ? " < > | ; content >1MB 拒绝
//   - skill-service.ts deleteSkill: 仅删 user 级; ENOENT 返回
//     { success:false, error:'Skill not found or is project-level (read-only)' }
//   - Skill 字段: name, description, content, source('user'|'project'), filePath
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 测试技能命名前缀 — 所有测试创建的技能都使用此前缀, 最终全部清理
const TEST_PREFIX = '__cdp_skill_test_'
const UNIQUE = `${TEST_PREFIX}${Date.now()}`

async function main() {
  const results = []
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  }
  // 包装每个测试: 捕获未预期异常, 不中断后续测试
  const test = (name, fn) => fn().catch((err) => record(name, false, `异常: ${String(err && err.message ? err.message : err).slice(0, 160)}`))

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
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) {
      throw new Error(`Eval error: ${r.result.exceptionDetails.text}`)
    }
    return r.result?.result?.value
  }

  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP connected, running skill system deep tests...\n')

  // ---------- IPC 封装 (符合框架 try/catch 包装要求) ----------
  const listSkills = async () => {
    return await evalInPage(`
      (async function(){
        const api = window.__EAA_API__||window.api;
        if (!api) return {__error:'no-api'};
        try {
          const r = await api.skill.list();
          return { value: r };
        } catch(e) {
          return {__error: String(e&&e.message?e.message:e)};
        }
      })()
    `)
  }

  const getSkill = async (name) => {
    return await evalInPage(`
      (async function(){
        const api = window.__EAA_API__||window.api;
        if (!api) return {__error:'no-api'};
        try {
          const r = await api.skill.get(${JSON.stringify(name)});
          return { value: r };
        } catch(e) {
          return {__error: String(e&&e.message?e.message:e)};
        }
      })()
    `)
  }

  const saveSkill = async (name, content) => {
    return await evalInPage(`
      (async function(){
        const api = window.__EAA_API__||window.api;
        if (!api) return {__error:'no-api'};
        try {
          const r = await api.skill.save(${JSON.stringify(name)}, ${JSON.stringify(content)});
          return { value: r };
        } catch(e) {
          return {__error: String(e&&e.message?e.message:e)};
        }
      })()
    `)
  }

  const deleteSkill = async (name) => {
    return await evalInPage(`
      (async function(){
        const api = window.__EAA_API__||window.api;
        if (!api) return {__error:'no-api'};
        try {
          const r = await api.skill.delete(${JSON.stringify(name)});
          return { value: r };
        } catch(e) {
          return {__error: String(e&&e.message?e.message:e)};
        }
      })()
    `)
  }

  // 解包辅助: 把 { value } / { __error } 统一成裸值 (错误抛出)
  const unwrap = (r) => {
    if (!r) throw new Error('empty response')
    if (r.__error) throw new Error(`IPC error: ${r.__error}`)
    return r.value
  }

  // 是否被服务拒绝 (返回 { success:false, error })
  const isRejected = (v) => v && typeof v === 'object' && v.success === false && typeof v.error === 'string'
  const isAccepted = (v) => v && typeof v === 'object' && v.success === true

  // 清理函数: 删除所有以 TEST_PREFIX 开头的 user 级技能
  const cleanupAll = async () => {
    try {
      const list = unwrap(await listSkills())
      if (!Array.isArray(list)) return
      for (const s of list) {
        if (s && s.name && typeof s.name === 'string' && s.name.startsWith(TEST_PREFIX)) {
          try { await deleteSkill(s.name) } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* ignore */ }
  }

  // ========== 0. 初始状态捕获 / 备份 ==========
  console.log('━━━ 0. 初始状态捕获 (备份) ━━━')
  let origList = null
  try {
    origList = unwrap(await listSkills())
    if (!Array.isArray(origList)) throw new Error('list 返回非数组')
    record('初始 list 读取', true, `count=${origList.length}`)
  } catch (err) {
    record('初始 list 读取', false, String(err.message || err))
    ws.close(); process.exit(1)
  }

  const origNames = new Set(origList.map((s) => s?.name).filter(Boolean))
  const origUserCount = origList.filter((s) => s?.source === 'user').length
  const origProjectCount = origList.filter((s) => s?.source === 'project').length
  console.log(`  原始: total=${origList.length} user=${origUserCount} project=${origProjectCount}`)

  // ========== 1. API 存在性 ==========
  console.log('\n━━━ 1. API 存在性 ━━━')
  await test('api.skill.list 是函数', async () => {
    const t = await evalInPage(`typeof (window.__EAA_API__||window.api).skill.list`)
    record('api.skill.list 是函数', t === 'function', `type=${t}`)
  })

  await test('api.skill.get 是函数', async () => {
    const t = await evalInPage(`typeof (window.__EAA_API__||window.api).skill.get`)
    record('api.skill.get 是函数', t === 'function', `type=${t}`)
  })

  await test('api.skill.save 是函数', async () => {
    const t = await evalInPage(`typeof (window.__EAA_API__||window.api).skill.save`)
    record('api.skill.save 是函数', t === 'function', `type=${t}`)
  })

  await test('api.skill.delete 是函数', async () => {
    const t = await evalInPage(`typeof (window.__EAA_API__||window.api).skill.delete`)
    record('api.skill.delete 是函数', t === 'function', `type=${t}`)
  })

  // ========== 2. list() 返回数组 ==========
  console.log('\n━━━ 2. list() 返回数组 ━━━')
  await test('list() 返回数组', async () => {
    const list = unwrap(await listSkills())
    record('list() 返回数组', Array.isArray(list), `isArray=${Array.isArray(list)} len=${list?.length}`)
  })

  await test('list() 不抛异常 (即使目录不存在也返回 [])', async () => {
    const r = await listSkills()
    record('list() 不抛异常 (即使目录不存在也返回 [])', !r.__error, `ok=${!r.__error}`)
  })

  // ========== 3. Skill 元数据字段 ==========
  console.log('\n━━━ 3. Skill 元数据字段 ━━━')
  await test('每个 skill 含全部 5 个字段 (name/description/content/source/filePath)', async () => {
    const list = unwrap(await listSkills())
    const expected = ['name', 'description', 'content', 'source', 'filePath']
    const missing = []
    for (const s of list) for (const k of expected) if (!(k in s)) missing.push(`${s?.name || '?'}:${k}`)
    record('每个 skill 含全部 5 个字段 (name/description/content/source/filePath)', missing.length === 0,
      missing.length === 0 ? '字段齐全' : `missing=${missing.slice(0, 5).join(',')}`)
  })

  await test('每个 skill.name 是非空字符串', async () => {
    const list = unwrap(await listSkills())
    const bad = list.filter((s) => typeof s.name !== 'string' || s.name.length === 0)
    record('每个 skill.name 是非空字符串', bad.length === 0, `bad=${bad.length}`)
  })

  await test('每个 skill.source 取值在 user|project', async () => {
    const list = unwrap(await listSkills())
    const bad = list.filter((s) => s.source !== 'user' && s.source !== 'project')
    record('每个 skill.source 取值在 user|project', bad.length === 0,
      `bad=${bad.length} sources=${[...new Set(list.map((s) => s.source))].join(',')}`)
  })

  // ========== 4. get() 读取技能 ==========
  console.log('\n━━━ 4. get() 读取技能 ━━━')
  await test('get() 读取已知存在的技能 → 返回 Skill 对象', async () => {
    const list = unwrap(await listSkills())
    if (list.length === 0) { record('get() 读取已知存在的技能 → 返回 Skill 对象', false, 'no skills'); return }
    const got = unwrap(await getSkill(list[0].name))
    record('get() 读取已知存在的技能 → 返回 Skill 对象',
      got && typeof got === 'object' && got.name === list[0].name,
      `got.name=${got?.name} expected=${list[0].name}`)
  })

  await test('get() 返回的 content 与 list 中 content 一致', async () => {
    const list = unwrap(await listSkills())
    if (list.length === 0) { record('get() 返回的 content 与 list 中 content 一致', false, 'no skills'); return }
    const got = unwrap(await getSkill(list[0].name))
    record('get() 返回的 content 与 list 中 content 一致', got?.content === list[0].content,
      `equal=${got?.content === list[0].content}`)
  })

  // ========== 5. get() 边界: 不存在/空/null/路径遍历 ==========
  console.log('\n━━━ 5. get() 边界: 不存在/空/null/路径遍历 ━━━')
  await test('get("不存在的技能名") 返回 null (非异常)', async () => {
    const got = unwrap(await getSkill(`${UNIQUE}_nonexistent`))
    record('get("不存在的技能名") 返回 null (非异常)', got === null, `got=${JSON.stringify(got)}`)
  })

  await test('get("") 空字符串 → 被 validateSkillName 拒绝', async () => {
    const got = unwrap(await getSkill(''))
    const ok = isRejected(got) && /non-empty/i.test(got.error || '')
    record('get("") 空字符串 → 被 validateSkillName 拒绝', ok, `got=${JSON.stringify(got)?.slice(0, 120)}`)
  })

  await test('get(null) → 被 validateSkillName 拒绝', async () => {
    const got = unwrap(await getSkill(null))
    record('get(null) → 被 validateSkillName 拒绝', isRejected(got), `got=${JSON.stringify(got)?.slice(0, 120)}`)
  })

  await test('get(超长名 >128 字符) → 拒绝', async () => {
    const got = unwrap(await getSkill('a'.repeat(200)))
    const ok = isRejected(got) && /too long|invalid/i.test(got.error || '')
    record('get(超长名 >128 字符) → 拒绝', ok, `got=${JSON.stringify(got)?.slice(0, 120)}`)
  })

  await test('get("../etc/passwd") 路径遍历 → 被拒', async () => {
    const got = unwrap(await getSkill('../../../etc/passwd'))
    record('get("../etc/passwd") 路径遍历 → 被拒', isRejected(got), `got=${JSON.stringify(got)?.slice(0, 120)}`)
  })

  // ========== 6. save() 写入 (happy path) ==========
  console.log('\n━━━ 6. save() 写入 (happy path) ━━━')
  const SK1 = `${UNIQUE}_save1`
  const SK1_CONTENT = `# ${SK1}\n\nThis is a test skill.\nDescription line.\n`

  await test(`save(name, content) 返回 {success:true}`, async () => {
    const r = unwrap(await saveSkill(SK1, SK1_CONTENT))
    record(`save(name, content) 返回 {success:true}`, isAccepted(r), `got=${JSON.stringify(r)}`)
  })

  await test('save 后 list 出现新技能', async () => {
    const list = unwrap(await listSkills())
    record('save 后 list 出现新技能', !!list.find((s) => s.name === SK1), `found=${!!list.find((s) => s.name === SK1)}`)
  })

  await test('save 后 get 返回保存的 content', async () => {
    const got = unwrap(await getSkill(SK1))
    record('save 后 get 返回保存的 content', got?.content === SK1_CONTENT, `equal=${got?.content === SK1_CONTENT}`)
  })

  await test('save 后 skill.source === "user" (写入用户级目录)', async () => {
    const got = unwrap(await getSkill(SK1))
    record('save 后 skill.source === "user" (写入用户级目录)', got?.source === 'user', `source=${got?.source}`)
  })

  await test('save 后 description 自动提取 (首段非标题文字)', async () => {
    const got = unwrap(await getSkill(SK1))
    // 内容首行是 "# __cdp_..._save1" (标题跳过), 第二段 "This is a test skill."
    record('save 后 description 自动提取 (首段非标题文字)', got?.description === 'This is a test skill.',
      `desc=${JSON.stringify(got?.description)}`)
  })

  await test('save 含 YAML frontmatter — description 从 frontmatter 提取', async () => {
    const SK_FM = `${UNIQUE}_frontmatter`
    const fmContent = `---\nname: ${SK_FM}\ndescription: Frontmatter-based skill\n---\n\n# Body\n`
    const r = unwrap(await saveSkill(SK_FM, fmContent))
    const got = unwrap(await getSkill(SK_FM))
    try { await deleteSkill(SK_FM) } catch (_) {}
    record('save 含 YAML frontmatter — description 从 frontmatter 提取',
      isAccepted(r) && got?.description === 'Frontmatter-based skill',
      `desc=${JSON.stringify(got?.description)}`)
  })

  // ========== 7. save() 验证错误 ==========
  console.log('\n━━━ 7. save() 验证错误 ━━━')
  await test('save("") 空名 → 拒绝', async () => {
    const r = unwrap(await saveSkill('', 'content'))
    record('save("") 空名 → 拒绝', isRejected(r), `got=${JSON.stringify(r)?.slice(0, 120)}`)
  })

  await test('save(null, ...) → 拒绝', async () => {
    const r = await evalInPage(`
      (async function(){
        const api = window.__EAA_API__||window.api;
        try { return { value: await api.skill.save(null, 'x') }; }
        catch(e) { return { __error: String(e&&e.message?e.message:e) }; }
      })()
    `)
    const v = unwrap(r)
    record('save(null, ...) → 拒绝', isRejected(v), `got=${JSON.stringify(v)?.slice(0, 120)}`)
  })

  await test('save(name, 123) content 非 string → 拒绝', async () => {
    const r = await evalInPage(`
      (async function(){
        const api = window.__EAA_API__||window.api;
        try { return { value: await api.skill.save(${JSON.stringify(`${UNIQUE}_numc`)}, 123) }; }
        catch(e) { return { __error: String(e&&e.message?e.message:e) }; }
      })()
    `)
    const v = unwrap(r)
    record('save(name, 123) content 非 string → 拒绝', isRejected(v), `got=${JSON.stringify(v)?.slice(0, 120)}`)
  })

  await test('save(超长名 >128 字符) → 拒绝', async () => {
    const r = unwrap(await saveSkill('b'.repeat(200), 'content'))
    const ok = isRejected(r) && /too long|invalid/i.test(r.error || '')
    record('save(超长名 >128 字符) → 拒绝', ok, `got=${JSON.stringify(r)?.slice(0, 120)}`)
  })

  await test('save("a/b") 含正斜杠 → 拒绝', async () => {
    const r = unwrap(await saveSkill('a/b', 'content'))
    record('save("a/b") 含正斜杠 → 拒绝', isRejected(r), `got=${JSON.stringify(r)?.slice(0, 120)}`)
  })

  await test('save content > 1MB → 拒绝', async () => {
    const big = 'x'.repeat(1024 * 1024 + 1)
    const r = unwrap(await saveSkill(`${UNIQUE}_big`, big))
    const ok = isRejected(r) && /too large|1MB|1mb/i.test(r.error || '')
    record('save content > 1MB → 拒绝', ok, `got=${JSON.stringify(r)?.slice(0, 120)}`)
  })

  // ========== 8. delete() 删除 (happy path) ==========
  console.log('\n━━━ 8. delete() 删除 (happy path) ━━━')
  const SK_DEL = `${UNIQUE}_delete_me`
  await saveSkill(SK_DEL, 'temp content') // 前置

  await test(`delete(name) 返回 {success:true}`, async () => {
    const r = unwrap(await deleteSkill(SK_DEL))
    record(`delete(name) 返回 {success:true}`, isAccepted(r), `got=${JSON.stringify(r)}`)
  })

  await test('delete 后 list 不再包含该技能', async () => {
    const list = unwrap(await listSkills())
    record('delete 后 list 不再包含该技能', !list.find((s) => s.name === SK_DEL),
      `stillThere=${!!list.find((s) => s.name === SK_DEL)}`)
  })

  await test('delete 后 get 返回 null', async () => {
    const got = unwrap(await getSkill(SK_DEL))
    record('delete 后 get 返回 null', got === null, `got=${JSON.stringify(got)}`)
  })

  // ========== 9. delete() 边界 ==========
  console.log('\n━━━ 9. delete() 边界 ━━━')
  await test('delete 不存在的技能 → {success:false}', async () => {
    const r = unwrap(await deleteSkill(`${UNIQUE}_ghost`))
    record('delete 不存在的技能 → {success:false}', isRejected(r), `got=${JSON.stringify(r)?.slice(0, 120)}`)
  })

  await test('delete("") 空名 → 拒绝', async () => {
    const r = unwrap(await deleteSkill(''))
    record('delete("") 空名 → 拒绝', isRejected(r), `got=${JSON.stringify(r)?.slice(0, 120)}`)
  })

  await test('delete(null) → 拒绝', async () => {
    const r = await evalInPage(`
      (async function(){
        const api = window.__EAA_API__||window.api;
        try { return { value: await api.skill.delete(null) }; }
        catch(e) { return { __error: String(e&&e.message?e.message:e) }; }
      })()
    `)
    const v = unwrap(r)
    record('delete(null) → 拒绝', isRejected(v), `got=${JSON.stringify(v)?.slice(0, 120)}`)
  })

  await test('delete 项目级只读技能 → {success:false} 含 "project-level"', async () => {
    const list = unwrap(await listSkills())
    const proj = list.find((s) => s.source === 'project')
    if (!proj) { record('delete 项目级只读技能 → {success:false} 含 "project-level"', false, 'no project skill found'); return }
    const r = unwrap(await deleteSkill(proj.name))
    const ok = isRejected(r) && /not found|project-level|read-only/i.test(r.error || '')
    record('delete 项目级只读技能 → {success:false} 含 "project-level"', ok,
      `name=${proj.name} got=${JSON.stringify(r)?.slice(0, 120)}`)
  })

  // ========== 10. 目录结构 (user vs project) ==========
  console.log('\n━━━ 10. 目录结构 (user vs project) ━━━')
  await test('list 同时扫描 user 与 project 目录 (sources 含 user 或 project)', async () => {
    const list = unwrap(await listSkills())
    const sources = new Set(list.map((s) => s?.source))
    record('list 同时扫描 user 与 project 目录 (sources 含 user 或 project)',
      sources.has('user') || sources.has('project'), `sources=${[...sources].join(',')}`)
  })

  await test('user 级技能的 filePath 不在 resources/ 路径下', async () => {
    const list = unwrap(await listSkills())
    const userSkills = list.filter((s) => s.source === 'user')
    const bad = userSkills.filter((s) => /resources[\\/]/.test(s.filePath || ''))
    record('user 级技能的 filePath 不在 resources/ 路径下', bad.length === 0,
      `total=${userSkills.length} bad=${bad.length}`)
  })

  await test('save 写入的技能 source 严格为 "user" 且 filePath 非空', async () => {
    const SK_SRC = `${UNIQUE}_src_check`
    await saveSkill(SK_SRC, 'src check')
    const got = unwrap(await getSkill(SK_SRC))
    const ok = got?.source === 'user' && typeof got?.filePath === 'string' && got.filePath.length > 0
    try { await deleteSkill(SK_SRC) } catch (_) {}
    record('save 写入的技能 source 严格为 "user" 且 filePath 非空', ok,
      `source=${got?.source} filePathLen=${got?.filePath?.length}`)
  })

  // ========== 11. save → get → delete 完整循环 ==========
  console.log('\n━━━ 11. save → get → delete 完整循环 ━━━')
  await test('完整循环: save → get 一致 → delete → get=null', async () => {
    const SK_LOOP = `${UNIQUE}_loop`
    const content = `# Loop test\n\nContent for ${SK_LOOP}\n`
    const sr = unwrap(await saveSkill(SK_LOOP, content))
    if (!isAccepted(sr)) { record('完整循环: save → get 一致 → delete → get=null', false, 'save failed'); return }
    const got = unwrap(await getSkill(SK_LOOP))
    if (got?.content !== content) { record('完整循环: save → get 一致 → delete → get=null', false, 'get mismatch'); return }
    const dr = unwrap(await deleteSkill(SK_LOOP))
    if (!isAccepted(dr)) { record('完整循环: save → get 一致 → delete → get=null', false, 'delete failed'); return }
    const after = unwrap(await getSkill(SK_LOOP))
    record('完整循环: save → get 一致 → delete → get=null', after === null, `after=${JSON.stringify(after)}`)
  })

  await test('多次 save 同名技能 — 仅保留最后一份', async () => {
    const SK_MULTI = `${UNIQUE}_multi`
    await saveSkill(SK_MULTI, 'v1')
    await saveSkill(SK_MULTI, 'v2')
    await saveSkill(SK_MULTI, 'v3')
    const got = unwrap(await getSkill(SK_MULTI))
    try { await deleteSkill(SK_MULTI) } catch (_) {}
    record('多次 save 同名技能 — 仅保留最后一份', got?.content === 'v3', `content=${JSON.stringify(got?.content)}`)
  })

  // ========== 12. 并发操作 ==========
  console.log('\n━━━ 12. 并发操作 ━━━')
  await test('并发 save 3 个不同技能 — 全部 success', async () => {
    const names = [`${UNIQUE}_c1`, `${UNIQUE}_c2`, `${UNIQUE}_c3`]
    const rs = await Promise.all(names.map((n) => saveSkill(n, `content-${n}`)))
    const vals = rs.map((r) => { try { return unwrap(r) } catch (e) { return { __error: 1 } } })
    const allOk = vals.every((v) => isAccepted(v))
    for (const n of names) { try { await deleteSkill(n) } catch (_) {} }
    record('并发 save 3 个不同技能 — 全部 success', allOk, `results=${vals.map((v) => v?.success).join(',')}`)
  })

  await test('并发 delete 同一技能 — 至少 1 success, 至少 1 fail', async () => {
    const SK_CE = `${UNIQUE}_ce`
    await saveSkill(SK_CE, 'seed')
    const rs = await Promise.all([deleteSkill(SK_CE), deleteSkill(SK_CE), deleteSkill(SK_CE)])
    const vals = rs.map((r) => { try { return unwrap(r) } catch (e) { return { __error: 1 } } })
    const succ = vals.filter((v) => isAccepted(v)).length
    const fail = vals.filter((v) => isRejected(v)).length
    record('并发 delete 同一技能 — 至少 1 success, 至少 1 fail', succ >= 1 && succ + fail === 3,
      `success=${succ} fail=${fail}`)
  })

  await test('并发 list + save + delete — 不崩溃', async () => {
    const SK_CD = `${UNIQUE}_cd`
    await saveSkill(SK_CD, 'seed')
    const [l, s, d] = await Promise.all([
      listSkills(),
      saveSkill(`${UNIQUE}_cd2`, 'parallel'),
      deleteSkill(SK_CD),
    ])
    const lOk = !l?.__error
    const sVal = (() => { try { return unwrap(s) } catch (_) { return null } })()
    const dVal = (() => { try { return unwrap(d) } catch (_) { return null } })()
    try { await deleteSkill(`${UNIQUE}_cd2`) } catch (_) {}
    record('并发 list + save + delete — 不崩溃', lOk && !!sVal && !!dVal,
      `lOk=${lOk} sOk=${!!sVal} dOk=${!!dVal}`)
  })

  // ========== 13. 错误处理与回退 ==========
  console.log('\n━━━ 13. 错误处理与回退 ━━━')
  await test('get 错误时返回 {success:false, error} 而非抛异常', async () => {
    const r = await getSkill('')
    const v = (() => { try { return unwrap(r) } catch (e) { return { __caught: String(e) } } })()
    record('get 错误时返回 {success:false, error} 而非抛异常', isRejected(v), `v=${JSON.stringify(v)?.slice(0, 100)}`)
  })

  await test('save 错误时返回 {success:false, error} 而非抛异常', async () => {
    const r = await saveSkill('', 'x')
    const v = (() => { try { return unwrap(r) } catch (e) { return { __caught: String(e) } } })()
    record('save 错误时返回 {success:false, error} 而非抛异常', isRejected(v), `v=${JSON.stringify(v)?.slice(0, 100)}`)
  })

  await test('delete 错误时返回 {success:false, error} 而非抛异常', async () => {
    const r = await deleteSkill('')
    const v = (() => { try { return unwrap(r) } catch (e) { return { __caught: String(e) } } })()
    record('delete 错误时返回 {success:false, error} 而非抛异常', isRejected(v), `v=${JSON.stringify(v)?.slice(0, 100)}`)
  })

  // ========== 14. 最终清理 + 状态恢复验证 ==========
  console.log('\n━━━ 14. 最终清理 + 状态恢复验证 ━━━')
  await test('清理: 删除所有测试创建的技能', async () => {
    await cleanupAll()
    const list = unwrap(await listSkills())
    const leftovers = list.filter((s) => typeof s.name === 'string' && s.name.startsWith(TEST_PREFIX))
    record('清理: 删除所有测试创建的技能', leftovers.length === 0,
      leftovers.length === 0 ? '全部已清理' : `leftovers=${leftovers.map((s) => s.name).join(',')}`)
  })

  await test('最终 list 与初始一致 (无新增/丢失)', async () => {
    const finalList = unwrap(await listSkills())
    const finalNames = new Set(finalList.map((s) => s?.name).filter(Boolean))
    const missing = [...origNames].filter((n) => !finalNames.has(n))
    const added = [...finalNames].filter((n) => !origNames.has(n))
    record('最终 list 与初始一致 (无新增/丢失)', missing.length === 0 && added.length === 0,
      `missing=${missing.length} added=${added.length}`)
  })

  await test('最终 user/project 技能数与初始一致', async () => {
    const finalList = unwrap(await listSkills())
    const u = finalList.filter((s) => s.source === 'user').length
    const p = finalList.filter((s) => s.source === 'project').length
    record('最终 user/project 技能数与初始一致', u === origUserCount && p === origProjectCount,
      `user=${u}/${origUserCount} project=${p}/${origProjectCount}`)
  })

  // ========== 汇总 ==========
  console.log('\n========== Skill System Deep Test ==========')
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
