// =============================================================
// System info & Profile management IPC 深度测试 (CDP / IPC 级)
// 覆盖:
//   - api.sys / api.profile 命名空间与方法存在性
//   - sys.getPath 系统路径 (userData/logs/home/temp/documents/downloads)
//   - sys.getPath 非法路径名边界
//   - 系统元数据 (navigator.platform / userAgent / 绝对路径校验)
//   - sys.openExternal 协议白名单 (https / file / javascript / 空 / malformed)
//   - sys.notify 校验
//   - sys.checkUpdate / showUpdateDialog / readFile 边界
//   - profile CRUD (create/read/update, merge 行为)
//   - profile 字段 round-trip (StudentProfileData 全字段)
//   - profile "active" set/get 往返 + 并发一致性
//   - profile 边界 (空名 / 超长 / null data / 控制字符 / 非法字符)
// 连接: CDP http://127.0.0.1:9222, 通过 Runtime.evaluate 调用
//       渲染进程 IPC API (window.__EAA_API__ || window.api)
//
// 注意: profile IPC 仅暴露 get/set, 且 set 走 profileService.update (合并),
//       无独立 delete 接口; 测试通过 set({}) 做 best-effort 清理。
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
  console.log('CDP connected, running System & Profile deep tests...\n')

  // ---------- IPC 封装 ----------
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
  const getPath = (name) => callIpc(`const res = await api.sys.getPath(${JSON.stringify(name)}); return res;`)
  const openExternal = (url) => callIpc(`const res = await api.sys.openExternal(${JSON.stringify(url)}); return res;`)
  const notify = (title, body) => callIpc(`const res = await api.sys.notify(${JSON.stringify(title)}, ${JSON.stringify(body)}); return res;`)
  const checkUpdate = () => callIpc(`const res = await api.sys.checkUpdate(); return res;`)
  const showUpdateDialog = () => callIpc(`const res = await api.sys.showUpdateDialog(); return res;`)
  const readFile = (p) => callIpc(`const res = await api.sys.readFile(${JSON.stringify(p)}); return res;`)
  const profileGet = (name) => callIpc(`const res = await api.profile.get(${JSON.stringify(name)}); return res;`)
  const profileSet = (name, data) => callIpc(`const res = await api.profile.set(${JSON.stringify(name)}, ${JSON.stringify(data)}); return res;`)

  // 期望判定 helper
  const isSuccess = (r) => !!r && !r.__error && r.success === true
  const isRejected = (r) => !!r && (r.__error || r.success === false)
  const notCrash = (r) => r != null && (r.success === true || r.success === false || !!r.__error)
  const isNonEmptyStr = (v) => typeof v === 'string' && v.length > 0

  const TS = Date.now()
  const mainProfile = `CDP_SysProf_${TS}`
  const createdForCleanup = new Set()

  // ============================================================
  // A. API 存在性
  // ============================================================
  console.log('━━━ A. API 存在性 ━━━')

  await test('A1. api 对象存在 (window.__EAA_API__ || window.api)', async () => {
    const r = await callIpc(`return { hasApi: !!api, hasEAA: !!window.__EAA_API__, hasPlain: !!window.api };`)
    record('A1. api 对象存在 (window.__EAA_API__ || window.api)', !!r && (r.hasApi === true), `hasApi=${r?.hasApi}`)
  })

  await test('A2. api.sys 命名空间存在', async () => {
    const r = await callIpc(`return { hasSys: !!api.sys };`)
    record('A2. api.sys 命名空间存在', !!r && r.hasSys === true, `hasSys=${r?.hasSys}`)
  })

  await test('A3. api.profile 命名空间存在', async () => {
    const r = await callIpc(`return { hasProfile: !!api.profile };`)
    record('A3. api.profile 命名空间存在', !!r && r.hasProfile === true, `hasProfile=${r?.hasProfile}`)
  })

  await test('A4. api.sys 拥有全部预期方法', async () => {
    const expected = ['openDialog', 'saveDialog', 'openExternal', 'getPath', 'checkUpdate', 'showUpdateDialog', 'notify', 'readFile']
    const r = await callIpc(`const exp = ${JSON.stringify(expected)}; const out = {}; for (const m of exp) out[m] = typeof api.sys[m]; return out;`)
    const allFn = !!r && expected.every((m) => r[m] === 'function')
    record('A4. api.sys 拥有全部预期方法', allFn, `methods=${JSON.stringify(r ?? {}).slice(0, 120)}`)
  })

  await test('A5. api.profile 拥有预期方法 (get/set)', async () => {
    const r = await callIpc(`return { get: typeof api.profile.get, set: typeof api.profile.set };`)
    const ok = !!r && r.get === 'function' && r.set === 'function'
    record('A5. api.profile 拥有预期方法 (get/set)', ok, `get=${r?.get} set=${r?.set}`)
  })

  // ============================================================
  // B. 系统路径 (合法)
  // ============================================================
  console.log('\n━━━ B. 系统路径 (合法) ━━━')

  await test('B6. getPath("userData") 返回非空字符串 (数据目录)', async () => {
    const r = await getPath('userData')
    record('B6. getPath("userData") 返回非空字符串 (数据目录)', isNonEmptyStr(r), `path=${String(r).slice(0, 80)}`)
  })

  await test('B7. getPath("logs") 返回非空字符串 (日志目录)', async () => {
    const r = await getPath('logs')
    record('B7. getPath("logs") 返回非空字符串 (日志目录)', isNonEmptyStr(r), `path=${String(r).slice(0, 80)}`)
  })

  await test('B8. getPath("home") 返回非空字符串', async () => {
    const r = await getPath('home')
    record('B8. getPath("home") 返回非空字符串', isNonEmptyStr(r), `path=${String(r).slice(0, 80)}`)
  })

  await test('B9. getPath("temp") 返回非空字符串', async () => {
    const r = await getPath('temp')
    record('B9. getPath("temp") 返回非空字符串', isNonEmptyStr(r), `path=${String(r).slice(0, 80)}`)
  })

  await test('B10. getPath("documents") 返回非空字符串', async () => {
    const r = await getPath('documents')
    record('B10. getPath("documents") 返回非空字符串', isNonEmptyStr(r), `path=${String(r).slice(0, 80)}`)
  })

  // ============================================================
  // C. 系统路径边界 (非法名)
  // ============================================================
  console.log('\n━━━ C. 系统路径边界 (非法名) ━━━')

  await test('C12. getPath("") 应拒绝', async () => {
    const r = await getPath('')
    record('C12. getPath("") 应拒绝', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  await test('C13. getPath("invalidPath") 应拒绝', async () => {
    const r = await getPath('invalidPath')
    record('C13. getPath("invalidPath") 应拒绝', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? '').slice(0, 50)}`)
  })

  await test('C14. getPath("../evil") 应拒绝 (路径遍历)', async () => {
    const r = await getPath('../evil')
    record('C14. getPath("../evil") 应拒绝 (路径遍历)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? '').slice(0, 50)}`)
  })

  await test('C15. getPath(null) 应拒绝 (不崩溃)', async () => {
    const r = await getPath(null)
    record('C15. getPath(null) 应拒绝 (不崩溃)', notCrash(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  // ============================================================
  // D. 应用元数据 / 平台信息
  // ============================================================
  console.log('\n━━━ D. 应用元数据 / 平台信息 ━━━')

  await test('D16. navigator.platform 为非空字符串 (platform value)', async () => {
    const r = await callIpc(`return { platform: navigator.platform };`)
    record('D16. navigator.platform 为非空字符串 (platform value)', !!r && isNonEmptyStr(r.platform), `platform=${r?.platform}`)
  })

  await test('D17. navigator.userAgent 为非空字符串 (version string)', async () => {
    const r = await callIpc(`return { userAgent: navigator.userAgent };`)
    record('D17. navigator.userAgent 为非空字符串 (version string)', !!r && isNonEmptyStr(r.userAgent), `ua=${String(r?.userAgent).slice(0, 60)}`)
  })

  await test('D18. userData 路径是绝对路径', async () => {
    const r = await getPath('userData')
    // Windows 绝对路径: 形如 C:\ 或 \\, 或 POSIX /
    const ok = isNonEmptyStr(r) && (/^[A-Za-z]:[\\\/]/.test(r) || r.startsWith('/') || r.startsWith('\\\\'))
    record('D18. userData 路径是绝对路径', ok, `path=${String(r).slice(0, 80)}`)
  })

  await test('D19. userData 与 logs 路径不同 (均为有效目录)', async () => {
    const ud = await getPath('userData')
    const lg = await getPath('logs')
    const ok = isNonEmptyStr(ud) && isNonEmptyStr(lg) && ud !== lg
    record('D19. userData 与 logs 路径不同 (均为有效目录)', ok, `userData=${String(ud).slice(0, 50)} logs=${String(lg).slice(0, 50)}`)
  })

  // ============================================================
  // E. openExternal 协议白名单
  // ============================================================
  console.log('\n━━━ E. openExternal 协议白名单 ━━━')

  await test('E20. openExternal https URL (合法, 应成功或优雅降级)', async () => {
    const r = await openExternal('https://example.com')
    record('E20. openExternal https URL (合法, 应成功或优雅降级)', isSuccess(r) || notCrash(r), `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  await test('E21. openExternal file:// 协议 (应拒绝)', async () => {
    const r = await openExternal('file:///etc/passwd')
    record('E21. openExternal file:// 协议 (应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  await test('E22. openExternal 空字符串 (应拒绝)', async () => {
    const r = await openExternal('')
    record('E22. openExternal 空字符串 (应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? '').slice(0, 50)}`)
  })

  await test('E23. openExternal javascript: 协议 (应拒绝)', async () => {
    const r = await openExternal('javascript:alert(1)')
    record('E23. openExternal javascript: 协议 (应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  await test('E24. openExternal malformed URL (应拒绝)', async () => {
    const r = await openExternal('not-a-url-at-all')
    record('E24. openExternal malformed URL (应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  // ============================================================
  // F. sys.notify 校验
  // ============================================================
  console.log('\n━━━ F. sys.notify 校验 ━━━')

  await test('F25. notify 有效 title/body (应成功)', async () => {
    const r = await notify('CDP 测试标题', '这是一条系统通知正文')
    record('F25. notify 有效 title/body (应成功)', isSuccess(r), `success=${r?.success}`)
  })

  await test('F26. notify 非字符串 title (应拒绝)', async () => {
    const r = await callIpc(`const res = await api.sys.notify(12345, 'body'); return res;`)
    record('F26. notify 非字符串 title (应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  await test('F27. notify 非字符串 body (应拒绝)', async () => {
    const r = await callIpc(`const res = await api.sys.notify('title', null); return res;`)
    record('F27. notify 非字符串 body (应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  // ============================================================
  // G. checkUpdate / showUpdateDialog / readFile 边界
  // ============================================================
  console.log('\n━━━ G. checkUpdate / showUpdateDialog / readFile 边界 ━━━')

  await test('G28. checkUpdate 不崩溃 (返回 available 或 error)', async () => {
    const r = await checkUpdate()
    record('G28. checkUpdate 不崩溃 (返回 available 或 error)', r != null && !r.__error && (r?.available === true || r?.available === false || typeof r?.available === 'undefined'), `available=${r?.available} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  await test('G29. showUpdateDialog 不崩溃', async () => {
    const r = await showUpdateDialog()
    record('G29. showUpdateDialog 不崩溃', notCrash(r), `success=${r?.success} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  await test('G30. readFile 空路径 (应抛错)', async () => {
    const r = await readFile('')
    record('G30. readFile 空路径 (应抛错)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  await test('G31. readFile 非法扩展名 (应抛错)', async () => {
    const r = await readFile('C:/fake/path/secret.bin')
    record('G31. readFile 非法扩展名 (应抛错)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  // ============================================================
  // H. Profile CRUD
  // ============================================================
  console.log('\n━━━ H. Profile CRUD ━━━')

  await test('H32. profile.get 不存在学生返回空对象 (data={})', async () => {
    const r = await profileGet(`NonExist_${TS}`)
    const ok = isSuccess(r) && r.data !== null && typeof r.data === 'object' && Object.keys(r.data).length === 0
    record('H32. profile.get 不存在学生返回空对象 (data={})', ok, `success=${r?.success} dataKeys=${Object.keys(r?.data ?? {}).length}`)
  })

  await test('H33. profile.set 创建新档案 (success)', async () => {
    const r = await profileSet(mainProfile, { gender: '男', phone: '13800000000', comments: 'CDP 创建' })
    if (isSuccess(r)) createdForCleanup.add(mainProfile)
    record('H33. profile.set 创建新档案 (success)', isSuccess(r), `success=${r?.success} err=${String(r?.error ?? '').slice(0, 50)}`)
  })

  await test('H34. profile.get 读回已创建档案 (round-trip)', async () => {
    const r = await profileGet(mainProfile)
    const d = r?.data
    const ok = isSuccess(r) && d?.gender === '男' && d?.phone === '13800000000' && d?.comments === 'CDP 创建'
    record('H34. profile.get 读回已创建档案 (round-trip)', ok, `gender=${d?.gender} phone=${d?.phone} comments=${d?.comments}`)
  })

  await test('H35. profile.set 更新已有档案 (merge 新字段)', async () => {
    const r = await profileSet(mainProfile, { address: '测试地址 123', parentName: '张三' })
    record('H35. profile.set 更新已有档案 (merge 新字段)', isSuccess(r), `success=${r?.success}`)
  })

  await test('H36. profile.get 读回合并后数据 (旧+新字段)', async () => {
    const r = await profileGet(mainProfile)
    const d = r?.data
    const ok = isSuccess(r) && d?.gender === '男' && d?.phone === '13800000000' && d?.address === '测试地址 123' && d?.parentName === '张三'
    record('H36. profile.get 读回合并后数据 (旧+新字段)', ok, `gender=${d?.gender} phone=${d?.phone} address=${d?.address} parentName=${d?.parentName}`)
  })

  await test('H37. profile.set 部分更新 (旧字段应保留, 验证 merge 语义)', async () => {
    // 只更新 phone, gender/parentName 应保留
    const r = await profileSet(mainProfile, { phone: '13900000000' })
    const g = await profileGet(mainProfile)
    const d = g?.data
    const ok = isSuccess(r) && d?.phone === '13900000000' && d?.gender === '男' && d?.parentName === '张三'
    record('H37. profile.set 部分更新 (旧字段应保留, 验证 merge 语义)', ok, `phone=${d?.phone} gender=${d?.gender} parentName=${d?.parentName}`)
  })

  await test('H38. profile.set 覆盖字段值 (同 key 新值)', async () => {
    const r = await profileSet(mainProfile, { comments: '已覆盖的备注' })
    const g = await profileGet(mainProfile)
    const ok = isSuccess(r) && g?.data?.comments === '已覆盖的备注'
    record('H38. profile.set 覆盖字段值 (同 key 新值)', ok, `comments=${g?.data?.comments}`)
  })

  await test('H39. profile.set 创建第二个独立档案', async () => {
    const n = `CDP_SysProf2_${TS}`
    const r = await profileSet(n, { gender: '女', awards: ['三好学生'] })
    if (isSuccess(r)) createdForCleanup.add(n)
    const g = await profileGet(n)
    const ok = isSuccess(r) && g?.data?.gender === '女' && Array.isArray(g?.data?.awards) && g.data.awards.includes('三好学生')
    // 验证主档案不受影响
    const main = await profileGet(mainProfile)
    const isolated = main?.data?.gender === '男'
    record('H39. profile.set 创建第二个独立档案', ok && isolated, `second=${g?.data?.gender} mainUnaffected=${isolated}`)
  })

  // ============================================================
  // I. Profile 字段 round-trip (StudentProfileData)
  // ============================================================
  console.log('\n━━━ I. Profile 字段 round-trip ━━━')

  const fieldProfile = `CDP_Fields_${TS}`
  await profileSet(fieldProfile, {})
  createdForCleanup.add(fieldProfile)

  await test('I40. 字段 round-trip: gender / birthDate / phone / idCard', async () => {
    await profileSet(fieldProfile, { gender: '男', birthDate: '2010-05-12', phone: '13811112222', idCard: '11010120100512001X' })
    const d = (await profileGet(fieldProfile))?.data
    const ok = d?.gender === '男' && d?.birthDate === '2010-05-12' && d?.phone === '13811112222' && d?.idCard === '11010120100512001X'
    record('I40. 字段 round-trip: gender / birthDate / phone / idCard', ok, `gender=${d?.gender} birthDate=${d?.birthDate} phone=${d?.phone} idCard=${d?.idCard}`)
  })

  await test('I41. 字段 round-trip: parentName / parentPhone / address / enrollmentDate', async () => {
    await profileSet(fieldProfile, { parentName: '李四', parentPhone: '13900001111', address: '北京市海淀区', enrollmentDate: '2022-09-01' })
    const d = (await profileGet(fieldProfile))?.data
    const ok = d?.parentName === '李四' && d?.parentPhone === '13900001111' && d?.address === '北京市海淀区' && d?.enrollmentDate === '2022-09-01'
    record('I41. 字段 round-trip: parentName / parentPhone / address / enrollmentDate', ok, `parentName=${d?.parentName} parentPhone=${d?.parentPhone} address=${d?.address} enrollmentDate=${d?.enrollmentDate}`)
  })

  await test('I42. 字段 round-trip: awards 数组 / comments / attendanceRate', async () => {
    await profileSet(fieldProfile, { awards: ['三好学生', '优秀班干部'], comments: '表现优异', attendanceRate: 98.5 })
    const d = (await profileGet(fieldProfile))?.data
    const ok = Array.isArray(d?.awards) && d.awards.length === 2 && d.awards.includes('三好学生') && d?.comments === '表现优异' && d?.attendanceRate === 98.5
    record('I42. 字段 round-trip: awards 数组 / comments / attendanceRate', ok, `awards=${JSON.stringify(d?.awards)} comments=${d?.comments} attendanceRate=${d?.attendanceRate}`)
  })

  await test('I43. 字段 round-trip: midtermGrades / finalGrades + 自定义字段', async () => {
    await profileSet(fieldProfile, { midtermGrades: { math: 90, english: 85 }, finalGrades: { math: 95 }, customTag: '自定义值', hobby: '足球' })
    const d = (await profileGet(fieldProfile))?.data
    const ok = d?.midtermGrades?.math === 90 && d?.midtermGrades?.english === 85 && d?.finalGrades?.math === 95 && d?.customTag === '自定义值' && d?.hobby === '足球'
    record('I43. 字段 round-trip: midtermGrades / finalGrades + 自定义字段', ok, `midterm=${JSON.stringify(d?.midtermGrades)} final=${JSON.stringify(d?.finalGrades)} customTag=${d?.customTag}`)
  })

  // ============================================================
  // J. Active Profile (set/get 往返 + 并发一致性)
  // ============================================================
  console.log('\n━━━ J. Active Profile (set/get 往返 + 一致性) ━━━')

  const activeProfile = `CDP_Active_${TS}`
  await profileSet(activeProfile, { role: 'Student', comments: 'active-v1' })
  createdForCleanup.add(activeProfile)

  await test('J44. set 档案为当前数据后 get 返回该数据', async () => {
    const g = await profileGet(activeProfile)
    const ok = isSuccess(g) && g?.data?.role === 'Student' && g?.data?.comments === 'active-v1'
    record('J44. set 档案为当前数据后 get 返回该数据', ok, `role=${g?.data?.role} comments=${g?.data?.comments}`)
  })

  await test('J45. 重新 set 更新后 get 返回最新数据', async () => {
    await profileSet(activeProfile, { comments: 'active-v2', level: 3 })
    const g = await profileGet(activeProfile)
    // merge: role 保留, comments 覆盖, level 新增
    const ok = g?.data?.role === 'Student' && g?.data?.comments === 'active-v2' && g?.data?.level === 3
    record('J45. 重新 set 更新后 get 返回最新数据', ok, `role=${g?.data?.role} comments=${g?.data?.comments} level=${g?.data?.level}`)
  })

  await test('J46. 并发 get 同一档案一致性', async () => {
    const reads = await Promise.all(Array.from({ length: 8 }, () => profileGet(activeProfile)))
    const allOk = reads.every((r) => isSuccess(r) && r?.data?.comments === 'active-v2')
    const firstLevel = reads[0]?.data?.level
    const consistent = reads.every((r) => r?.data?.level === firstLevel)
    record('J46. 并发 get 同一档案一致性', allOk && consistent, `reads=${reads.length} allOk=${allOk} consistent=${consistent} level=${firstLevel}`)
  })

  // ============================================================
  // K. Profile 边界 (校验)
  // ============================================================
  console.log('\n━━━ K. Profile 边界 (校验) ━━━')

  await test('K47. profile.set 空名字 (应拒绝)', async () => {
    const r = await profileSet('', { gender: '男' })
    record('K47. profile.set 空名字 (应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  await test('K48. profile.set 名字超长 (>64 chars, 应拒绝)', async () => {
    const longName = 'A'.repeat(100)
    const r = await profileSet(longName, { gender: '男' })
    record('K48. profile.set 名字超长 (>64 chars, 应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  await test('K49. profile.set null data (应拒绝)', async () => {
    const r = await callIpc(`const res = await api.profile.set(${JSON.stringify(mainProfile)}, null); return res;`)
    record('K49. profile.set null data (应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  await test('K50. profile.set 含控制字符名字 (应拒绝)', async () => {
    const r = await profileSet('Bad\nName', { gender: '男' })
    record('K50. profile.set 含控制字符名字 (应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  await test('K51. profile.set 含非法字符名字 (分号, 应拒绝)', async () => {
    const r = await profileSet('Bad;Name', { gender: '男' })
    record('K51. profile.set 含非法字符名字 (分号, 应拒绝)', isRejected(r), `rejected=${isRejected(r)} err=${String(r?.error ?? r?.__error ?? '').slice(0, 50)}`)
  })

  // ============================================================
  // 清理: best-effort 清空测试档案
  // ============================================================
  console.log('\n━━━ 清理测试数据 ━━━')
  for (const name of createdForCleanup) {
    try {
      // profile IPC 无 delete; set 走 merge 语义, 用空对象做 best-effort 清理
      await profileSet(name, {})
      console.log(`  best-effort 清空: ${name}`)
    } catch (e) {
      console.log(`  清理失败 ${name}: ${String(e && e.message ? e.message : e).slice(0, 80)}`)
    }
  }

  // ============================================================
  // 汇总
  // ============================================================
  console.log('\n========== System info & Profile management 深度测试 ==========')
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
