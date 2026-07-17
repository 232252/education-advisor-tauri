// =============================================================
// 存储角度 + 内存角度 + 渲染角度 综合深度测试
// 全新角度: 跨这三个维度验证应用稳定性
// 运行: node scripts/cdp-storage-memory-render.mjs
// =============================================================
import http from 'node:http'
import WebSocket from 'ws'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CDP_HOST = 'http://127.0.0.1:9222'
const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'
const WARN = '\x1b[33m!\x1b[0m'

let ws, send, evalInPage
let passCount = 0, failCount = 0, warnCount = 0
const notes = []

function record(name, ok, detail = '') {
  if (ok === true) passCount++
  else if (ok === 'warn') warnCount++
  else failCount++
  const mark = ok === true ? 'PASS' : ok === 'warn' ? 'WARN' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ' — ' + String(detail).slice(0, 180) : ''}`)
}
const note = (m) => notes.push(m)
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
const callEAA = (m, ...a) => callNS('eaa', m, ...a)
const callProfile = (m, ...a) => callNS('profile', m, ...a)
const callClass = (m, ...a) => callNS('class', m, ...a)

const isOk = (r) => !!r && r.__error === undefined && r.success === true
const errMsg = (r) => r?.__error || r?.error || r?.data || r?.stderr || 'unknown'

// 获取内存快照
async function memSnapshot() {
  return await evalInPage(`(function(){
    if (performance.memory) {
      return {
        used: performance.memory.usedJSHeapSize,
        total: performance.memory.totalJSHeapSize,
        limit: performance.memory.jsHeapSizeLimit
      };
    }
    return null;
  })()`)
}

// =============================================================
// 1. 存储角度 — 文件导出/数据持久化/大数据量
// =============================================================
async function testStorage() {
  console.log('\n=== 1. 存储角度: 文件导出 + 持久化 + 大数据量 ===')

  // 1.1 EAA 导出 csv/jsonl/html — 验证返回值结构
  const formats = ['csv', 'jsonl', 'html']
  for (const fmt of formats) {
    const res = await callEAA('export', fmt)
    record(`eaa.export(${fmt}) 返回结构`, isOk(res),
      isOk(res) ? `data type=${typeof res.data}` : errMsg(res))
  }

  // 1.2 EAA dashboard 生成 — 验证返回
  const dash = await callEAA('dashboard')
  record('eaa.dashboard 生成', isOk(dash),
    isOk(dash) ? String(dash.data).slice(0, 80) : errMsg(dash))

  // 1.3 profile.set + profile.get 往返 — 验证持久化
  const TS = Date.now()
  const testStudent = `_smr_test_${TS}`
  // 创建测试学生
  const addStu = await callEAA('addStudent', testStudent)
  if (!isOk(addStu)) {
    record('存储测试跳过(创建测试学生失败)', 'warn', errMsg(addStu))
    return
  }

  // 写入 profile
  const profileData = {
    basic: { name: testStudent, note: `存储测试 ${TS}` },
    custom: { testField: 'test_value', number: 42, bool: true, array: [1, 2, 3] },
  }
  const setRes = await callProfile('set', testStudent, profileData)
  record('profile.set 写入扩展档案', isOk(setRes),
    isOk(setRes) ? 'ok' : errMsg(setRes))

  // 读回 profile 验证一致性
  if (isOk(setRes)) {
    const getRes = await callProfile('get', testStudent)
    const prof = getRes?.data
    record('profile.get 读回一致性', isOk(getRes) && prof != null,
      isOk(getRes) ? `keys=${Object.keys(prof || {}).slice(0, 5).join(',')}` : errMsg(getRes))

    // 验证嵌套字段
    if (prof) {
      const basicOk = prof.basic?.note === profileData.basic.note
      const customOk = prof.custom?.testField === 'test_value'
      record('profile 嵌套字段一致性', !!(basicOk && customOk),
        `basic.note=${basicOk}, custom.testField=${customOk}`)
    }
  }

  // 1.4 setStudentMeta — 设置学生元数据
  // 注: SetStudentMetaParams 字段为 name/group/role/classId (非 studentName,非数组)
  const metaRes = await callEAA('setStudentMeta', {
    name: testStudent,
    group: '测试组',
    role: '测试角色',
  })
  record('eaa.setStudentMeta 写入元数据', isOk(metaRes),
    isOk(metaRes) ? 'ok' : errMsg(metaRes))

  // 读回验证
  if (isOk(metaRes)) {
    const listRes = await callEAA('listStudents')
    const stu = listRes?.data?.students?.find((s) => s.name === testStudent)
    if (stu) {
      const groupOk = stu.groups?.includes('测试组')
      const roleOk = stu.roles?.includes('测试角色')
      record('setStudentMeta 读回一致性', !!(groupOk && roleOk),
        `group=${groupOk}, role=${roleOk}`)
    } else {
      record('setStudentMeta 读回一致性', false, '学生未找到')
    }
  }

  // 1.5 大数据量测试 — 验证 stats 数据完整性
  const stats = await callEAA('stats')
  if (isOk(stats)) {
    const s = stats.data.summary
    // 验证 summary 字段完整
    const fieldsOk = s.students != null && s.total_events != null && s.valid_events != null
      && s.reverted_events != null && s.total_delta != null
    record('stats.summary 字段完整性', fieldsOk,
      `students=${s.students}, total=${s.total_events}, valid=${s.valid_events}, reverted=${s.reverted_events}`)

    // 验证 reason_distribution 是数组
    const distOk = Array.isArray(stats.data.reason_distribution)
    record('stats.reason_distribution 是数组', distOk,
      distOk ? `len=${stats.data.reason_distribution.length}` : 'not array')

    // 验证 score_intervals 是对象
    const intOk = stats.data.score_intervals != null && typeof stats.data.score_intervals === 'object'
    record('stats.score_intervals 是对象', intOk,
      intOk ? `keys=${Object.keys(stats.data.score_intervals).join(',')}` : 'not object')
  }

  // 1.6 数据一致性 — total_delta 应等于所有学生 delta 之和
  if (isOk(stats)) {
    const listRes = await callEAA('listStudents')
    if (isOk(listRes)) {
      const sumDelta = listRes.data.students.reduce((sum, s) => sum + (s.delta || 0), 0)
      const statsDelta = stats.data.summary.total_delta
      // 浮点误差容忍 0.01
      const consistent = Math.abs(sumDelta - statsDelta) < 0.01
      record('total_delta 与学生 delta 之和一致', consistent,
        `stats=${statsDelta}, sum=${sumDelta.toFixed(2)}, diff=${(sumDelta - statsDelta).toFixed(4)}`)
    }
  }

  // 1.7 history 数据完整性 — 每个事件有 event_id/timestamp/score_delta
  // 注: 实际字段名为 event_id (非 id) 和 score_delta (非 score)
  const listRes = await callEAA('listStudents')
  if (isOk(listRes) && listRes.data.students.length > 0) {
    // 选取有事件的学生(避免选到刚创建的测试学生)
    const sample = listRes.data.students.find((s) => s.events_count > 0) || listRes.data.students[0]
    const hist = await callEAA('history', sample.name)
    if (isOk(hist) && hist.data.events.length > 0) {
      const ev = hist.data.events[0]
      const fieldsOk = ev.event_id != null && ev.timestamp != null && ev.score_delta != null
      record('history 事件字段完整 (event_id/timestamp/score_delta)', fieldsOk,
        fieldsOk ? `sample: event_id=${ev.event_id}, score_delta=${ev.score_delta}` : `fields=${Object.keys(ev).join(',')}`)
    } else {
      record('history 事件字段完整', 'warn', '无历史事件')
    }
  }

  // 清理测试学生
  const delRes = await callEAA('deleteStudent', testStudent, '存储测试清理')
  record('清理: deleteStudent 测试学生', isOk(delRes),
    isOk(delRes) ? `已删除 ${testStudent}` : errMsg(delRes))
}

// =============================================================
// 2. 内存角度 — 长操作泄漏检测
// =============================================================
async function testMemory() {
  console.log('\n=== 2. 内存角度: 长操作泄漏检测 ===')

  const memBefore = await memSnapshot()
  if (!memBefore) {
    record('内存测试跳过(performance.memory 不可用)', 'warn', '非 Chromium 或禁用')
    return
  }
  note(`内存基线: used=${(memBefore.used / 1024 / 1024).toFixed(2)}MB, total=${(memBefore.total / 1024 / 1024).toFixed(2)}MB`)

  // 2.1 连续 200 次 listStudents — 测读缓存是否泄漏
  const t1 = Date.now()
  for (let i = 0; i < 200; i++) {
    await callEAA('listStudents')
  }
  const ms1 = Date.now() - t1
  const memAfter1 = await memSnapshot()
  const delta1 = (memAfter1.used - memBefore.used) / 1024 / 1024
  record('200 次 listStudents 内存增长 < 10MB', Math.abs(delta1) < 10,
    `delta=${delta1 > 0 ? '+' : ''}${delta1.toFixed(2)}MB, 耗时=${ms1}ms (${(ms1 / 200).toFixed(1)}ms/次)`)

  // 2.2 连续 200 次 stats — 测统计缓存
  const t2 = Date.now()
  for (let i = 0; i < 200; i++) {
    await callEAA('stats')
  }
  const ms2 = Date.now() - t2
  const memAfter2 = await memSnapshot()
  const delta2 = (memAfter2.used - memAfter1.used) / 1024 / 1024
  record('200 次 stats 内存增长 < 10MB', Math.abs(delta2) < 10,
    `delta=${delta2 > 0 ? '+' : ''}${delta2.toFixed(2)}MB, 耗时=${ms2}ms`)

  // 2.3 连续 200 次 ranking(50) — 测排行榜
  const t3 = Date.now()
  for (let i = 0; i < 200; i++) {
    await callEAA('ranking', 50)
  }
  const ms3 = Date.now() - t3
  const memAfter3 = await memSnapshot()
  const delta3 = (memAfter3.used - memAfter2.used) / 1024 / 1024
  record('200 次 ranking(50) 内存增长 < 10MB', Math.abs(delta3) < 10,
    `delta=${delta3 > 0 ? '+' : ''}${delta3.toFixed(2)}MB, 耗时=${ms3}ms`)

  // 2.4 连续 200 次 search — 测搜索
  const t4 = Date.now()
  for (let i = 0; i < 200; i++) {
    await callEAA('search', 'a', 20)
  }
  const ms4 = Date.now() - t4
  const memAfter4 = await memSnapshot()
  const delta4 = (memAfter4.used - memAfter3.used) / 1024 / 1024
  record('200 次 search 内存增长 < 10MB', Math.abs(delta4) < 10,
    `delta=${delta4 > 0 ? '+' : ''}${delta4.toFixed(2)}MB, 耗时=${ms4}ms`)

  // 2.5 总内存增长
  const totalDelta = (memAfter4.used - memBefore.used) / 1024 / 1024
  record('800 次 IPC 调用总内存增长 < 20MB', Math.abs(totalDelta) < 20,
    `total delta=${totalDelta > 0 ? '+' : ''}${totalDelta.toFixed(2)}MB`)
  note(`800 次 IPC 调用后内存: used=${(memAfter4.used / 1024 / 1024).toFixed(2)}MB`)

  // 2.6 强制 GC (如果可用) 后内存应回落
  // 注: 内存减少是好事,只有增长超过阈值才视为泄漏
  await evalInPage(`if (typeof gc === 'function') gc();`)
  await sleep(500)
  const memAfterGC = await memSnapshot()
  const gcDelta = (memAfterGC.used - memBefore.used) / 1024 / 1024
  record('GC 后内存接近基线 (< 5MB 增长)', gcDelta < 5,
    `after GC: used=${(memAfterGC.used / 1024 / 1024).toFixed(2)}MB, delta=${gcDelta > 0 ? '+' : ''}${gcDelta.toFixed(2)}MB`)

  // 2.7 内存压力测试 — 快速创建/删除学生循环
  const memBefore2 = await memSnapshot()
  for (let i = 0; i < 20; i++) {
    const s = `_memstress_${Date.now()}_${i}`
    await callEAA('addStudent', s)
    await callEAA('deleteStudent', s, '内存压力测试')
  }
  const memAfterStress = await memSnapshot()
  const stressDelta = (memAfterStress.used - memBefore2.used) / 1024 / 1024
  record('20 次 add+delete 学生循环内存增长 < 5MB', Math.abs(stressDelta) < 5,
    `delta=${stressDelta > 0 ? '+' : ''}${stressDelta.toFixed(2)}MB`)
}

// =============================================================
// 3. 渲染角度 — 路由切换/主题/长列表/模态框
// =============================================================
async function testRendering() {
  console.log('\n=== 3. 渲染角度: 路由切换 + 主题 + 长列表 + 模态框 ===')

  // 3.1 快速路由切换 — 验证不崩溃
  const routes = ['/dashboard', '/students', '/academics', '/classes', '/agents', '/models', '/skills', '/scheduler', '/privacy', '/settings']
  let navOk = true
  const navTimes = []
  for (const route of routes) {
    const t = Date.now()
    try {
      await evalInPage(`(function(){
        const h = window.location.hash;
        window.location.hash = '#${route}';
        return h;
      })()`)
      await sleep(300) // 等待渲染
      const hash = await evalInPage(`window.location.hash`)
      if (!hash.includes(route)) navOk = false
      navTimes.push(Date.now() - t)
    } catch (e) {
      navOk = false
      note(`导航失败 ${route}: ${e.message}`)
    }
  }
  record('10 个路由快速切换不崩溃', navOk,
    `avg=${(navTimes.reduce((a, b) => a + b, 0) / navTimes.length).toFixed(0)}ms, max=${Math.max(...navTimes)}ms`)

  // 3.2 重复路由切换 (同一路由 50 次) — 验证无重复渲染泄漏
  const memBeforeNav = await memSnapshot()
  for (let i = 0; i < 50; i++) {
    await evalInPage(`window.location.hash = '#/students'`)
    await sleep(50)
    await evalInPage(`window.location.hash = '#/dashboard'`)
    await sleep(50)
  }
  const memAfterNav = await memSnapshot()
  const navMemDelta = memBeforeNav && memAfterNav
    ? (memAfterNav.used - memBeforeNav.used) / 1024 / 1024
    : 0
  // 注: 50 次路由切换可能触发组件缓存,阈值放宽至 15MB;内存减少视为通过
  record('50 次路由切换内存增长 < 15MB', navMemDelta < 15,
    `delta=${navMemDelta > 0 ? '+' : ''}${navMemDelta.toFixed(2)}MB`)

  // 3.3 主题切换 — 验证 dark/light toggle
  // 先读取当前主题
  const themeBefore = await evalInPage(`(function(){
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  })()`)
  note(`主题切换前: ${themeBefore}`)

  // 查找主题切换按钮
  const themeBtn = await evalInPage(`(function(){
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      const t = b.textContent || '';
      const title = b.getAttribute('title') || '';
      const ariaLabel = b.getAttribute('aria-label') || '';
      if (t.includes('主题') || t.includes('theme') || title.includes('主题') || title.includes('theme') || ariaLabel.includes('主题') || ariaLabel.includes('theme') || t.includes('🌙') || t.includes('☀') || t.includes('🌞') || t.includes('🌙') || t.includes('Sun') || t.includes('Moon') || t.includes('sun') || t.includes('moon')) {
        return { found: true, text: t.slice(0, 30), title: title, ariaLabel: ariaLabel };
      }
    }
    // 找带 data-theme 或特定 class 的按钮
    const themed = document.querySelector('button[data-theme-toggle], button.theme-toggle, [class*="theme"][class*="toggle"]');
    if (themed) return { found: true, text: themed.textContent.slice(0, 30) };
    return { found: false };
  })()`)

  if (themeBtn?.found) {
    // 点击切换主题
    await evalInPage(`(function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent || '';
        const title = b.getAttribute('title') || '';
        const ariaLabel = b.getAttribute('aria-label') || '';
        if (t.includes('主题') || t.includes('theme') || title.includes('主题') || title.includes('theme') || ariaLabel.includes('主题') || ariaLabel.includes('theme') || t.includes('🌙') || t.includes('☀') || t.includes('🌞') || t.includes('Sun') || t.includes('Moon') || t.includes('sun') || t.includes('moon')) {
          b.click();
          return true;
        }
      }
      const themed = document.querySelector('button[data-theme-toggle], button.theme-toggle, [class*="theme"][class*="toggle"]');
      if (themed) { themed.click(); return true; }
      return false;
    })()`)
    await sleep(300)
    const themeAfter = await evalInPage(`(function(){
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  })()`)
    record('主题切换生效', themeAfter !== themeBefore,
      `${themeBefore} → ${themeAfter}`)

    // 切换回去(还原)
    await evalInPage(`(function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent || '';
        const title = b.getAttribute('title') || '';
        const ariaLabel = b.getAttribute('aria-label') || '';
        if (t.includes('主题') || t.includes('theme') || title.includes('主题') || title.includes('theme') || ariaLabel.includes('主题') || ariaLabel.includes('theme') || t.includes('🌙') || t.includes('☀') || t.includes('🌞') || t.includes('Sun') || t.includes('Moon') || t.includes('sun') || t.includes('moon')) {
          b.click();
          return true;
        }
      }
      return false;
    })()`)
    await sleep(300)
    const themeRestored = await evalInPage(`document.documentElement.classList.contains('dark') ? 'dark' : 'light'`)
    record('主题还原', themeRestored === themeBefore,
      `restored=${themeRestored}, original=${themeBefore}`)
  } else {
    record('主题切换按钮查找', 'warn', '未找到主题切换按钮(可能在 Settings 页)')
  }

  // 3.4 长列表渲染 — 学生列表 DOM 节点数
  await evalInPage(`window.location.hash = '#/students'`)
  await sleep(800)
  const tableInfo = await evalInPage(`(function(){
    const rows = document.querySelectorAll('table tbody tr');
    const allTrs = document.querySelectorAll('tr');
    return { bodyRows: rows.length, allTrs: allTrs.length };
  })()`)
  record('学生列表渲染行数', tableInfo?.bodyRows > 0,
    `tbody rows=${tableInfo?.bodyRows}, all trs=${tableInfo?.allTrs}`)

  // 3.5 DOM 节点总数 — 检查是否有 DOM 泄漏
  const domBefore = await evalInPage(`document.querySelectorAll('*').length`)
  // 切换 10 次
  for (let i = 0; i < 10; i++) {
    await evalInPage(`window.location.hash = '#/dashboard'`)
    await sleep(200)
    await evalInPage(`window.location.hash = '#/students'`)
    await sleep(200)
  }
  const domAfter = await evalInPage(`document.querySelectorAll('*').length`)
  const domDelta = domAfter - domBefore
  record('10 次切换后 DOM 节点数稳定 (Δ < 50)', Math.abs(domDelta) < 50,
    `before=${domBefore}, after=${domAfter}, delta=${domDelta}`)

  // 3.6 事件监听器泄漏检查 (间接 — 通过 listeners 数无法直接获取,用 perf 测)
  // 通过快速 click 测试是否有响应变慢
  const clickTimes = []
  for (let i = 0; i < 20; i++) {
    const t = Date.now()
    await evalInPage(`(function(){
      // 点击学生列表第一行(模拟选中)
      const row = document.querySelector('table tbody tr');
      if (row) row.click();
    })()`)
    clickTimes.push(Date.now() - t)
    await sleep(50)
  }
  const avgClick = clickTimes.reduce((a, b) => a + b, 0) / clickTimes.length
  const maxClick = Math.max(...clickTimes)
  record('20 次连续点击响应稳定 (max < 100ms)', maxClick < 100,
    `avg=${avgClick.toFixed(1)}ms, max=${maxClick}ms`)

  // 3.7 模态框打开/关闭循环 — 验证无 DOM 泄漏
  await evalInPage(`window.location.hash = '#/classes'`)
  await sleep(800)
  const modalDomBefore = await evalInPage(`document.querySelectorAll('*').length`)
  for (let i = 0; i < 5; i++) {
    // 找新建班级按钮并点击
    await evalInPage(`(function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        if ((b.textContent || '').includes('新建班级')) { b.click(); return; }
      }
    })()`)
    await sleep(400)
    // 找取消按钮并点击
    await evalInPage(`(function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        if ((b.textContent || '').trim() === '取消') { b.click(); return; }
      }
      // 按 Escape
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    })()`)
    await sleep(300)
  }
  const modalDomAfter = await evalInPage(`document.querySelectorAll('*').length`)
  const modalDomDelta = modalDomAfter - modalDomBefore
  record('5 次模态框打开/关闭 DOM 稳定 (Δ < 30)', Math.abs(modalDomDelta) < 30,
    `before=${modalDomBefore}, after=${modalDomAfter}, delta=${modalDomDelta}`)

  // 3.8 控制台错误检查 — 渲染过程中不应有未捕获错误
  const consoleErrors = await evalInPage(`(function(){
    if (!window.__testErrors) {
      window.__testErrors = [];
      const origError = console.error;
      console.error = function(...args) {
        window.__testErrors.push(args.map(a => String(a)).join(' ').slice(0, 200));
        origError.apply(console, args);
      };
      window.addEventListener('error', function(e) {
        window.__testErrors.push('uncaught: ' + (e.message || 'unknown'));
      });
    }
    return { count: window.__testErrors.length, sample: window.__testErrors.slice(0, 3) };
  })()`)

  // 等待 2 秒收集可能的错误
  await sleep(2000)
  const errorsAfter = await evalInPage(`(function(){
    return { count: window.__testErrors.length, sample: window.__testErrors.slice(-3) };
  })()`)
  record('渲染过程中无未捕获错误', errorsAfter.count === consoleErrors.count,
    `新增错误=${errorsAfter.count - consoleErrors.count}${errorsAfter.count > consoleErrors.count ? ', sample=' + errorsAfter.sample[0] : ''}`)
}

// =============================================================
// 4. 综合压力 — 多维度交叉
// =============================================================
async function testCrossStress() {
  console.log('\n=== 4. 综合压力: 交叉操作 ===')

  // 4.1 并发 IPC + 路由切换
  const memBefore = await memSnapshot()
  const promises = []
  // 5 个 IPC 调用 + 5 个路由切换 并发
  for (let i = 0; i < 5; i++) {
    promises.push(callEAA('listStudents'))
    promises.push(callEAA('stats'))
    promises.push(callEAA('ranking', 10))
  }
  // 同时切换路由
  const navPromise = (async () => {
    for (const r of ['/dashboard', '/students', '/academics', '/classes', '/agents']) {
      await evalInPage(`window.location.hash = '#${r}'`)
      await sleep(200)
    }
  })()

  const results = await Promise.allSettled(promises)
  await navPromise
  const successCount = results.filter((r) => r.status === 'fulfilled' && isOk(r.value)).length
  record('并发 IPC + 路由切换', successCount === 15,
    `${successCount}/15 IPC 成功`)

  const memAfter = await memSnapshot()
  const delta = memBefore && memAfter ? (memAfter.used - memBefore.used) / 1024 / 1024 : 0
  // 注: 并发操作后内存减少是好事,只有增长超过 5MB 才视为泄漏
  record('并发操作内存增长 < 5MB', delta < 5,
    `delta=${delta > 0 ? '+' : ''}${delta.toFixed(2)}MB`)

  // 4.2 快速连续 add+revert 事件 — 验证一致性
  const testStudent = `_cross_${Date.now()}`
  await callEAA('addStudent', testStudent)
  const before = await callEAA('score', testStudent)
  const scoreBefore = before?.data?.score

  // 查有效原因码
  const codesRes = await callEAA('codes')
  const validCodes = isOk(codesRes) ? (codesRes.data?.codes ?? []) : []
  const reasonCode = validCodes.find((c) => (c.score_delta ?? 0) > 0)?.code
  const expectedDelta = validCodes.find((c) => c.code === reasonCode)?.score_delta ?? 0

  if (reasonCode && scoreBefore != null) {
    // 快速 5 次 add (force=true 绕过去重)
    const addResults = []
    for (let i = 0; i < 5; i++) {
      const r = await callEAA('addEvent', {
        studentName: testStudent,
        reasonCode: reasonCode,
        note: `cross stress ${i}`,
        tags: ['cross'],
        force: true,
      })
      addResults.push(r)
    }
    const addOk = addResults.filter(isOk).length
    record('5 次快速 addEvent (force=true)', addOk === 5,
      `${addOk}/5 成功`)

    // 验证分数 = before + 5 * delta
    const after = await callEAA('score', testStudent)
    const scoreAfter = after?.data?.score
    const expectedScore = scoreBefore + 5 * expectedDelta
    record('5 次 addEvent 后分数一致', Math.abs(scoreAfter - expectedScore) < 0.01,
      `before=${scoreBefore}, after=${scoreAfter}, expected=${expectedScore}`)

    // 提取事件 IDs 并 revert
    const eventIds = addResults
      .map((r) => {
        if (!isOk(r) || typeof r.data !== 'string') return null
        const m = r.data.match(/evt_[a-f0-9]+/i)
        return m ? m[0] : null
      })
      .filter(Boolean)

    // 并发 revert 5 个事件
    const revertPromises = eventIds.map((id) => callEAA('revertEvent', id, 'cross stress revert'))
    const revertResults = await Promise.allSettled(revertPromises)
    const revertOk = revertResults.filter((r) => r.status === 'fulfilled' && isOk(r.value)).length
    record('并发 revert 5 个事件', revertOk === 5,
      `${revertOk}/5 成功`)

    // 验证分数恢复
    const restored = await callEAA('score', testStudent)
    const scoreRestored = restored?.data?.score
    record('revert 后分数恢复', Math.abs(scoreRestored - scoreBefore) < 0.01,
      `before=${scoreBefore}, restored=${scoreRestored}`)
  }

  // 清理
  await callEAA('deleteStudent', testStudent, 'cross stress 清理')
}

// =============================================================
// 主流程
// =============================================================
async function main() {
  console.log('=== 存储角度 + 内存角度 + 渲染角度 综合深度测试 ===')
  console.log(`时间: ${new Date().toISOString()}\n`)

  await connect()

  await testStorage()
  await testMemory()
  await testRendering()
  await testCrossStress()

  console.log('\n=== 总结 ===')
  const total = passCount + failCount + warnCount
  console.log(`总计: ${total}, 通过: ${passCount}, 警告: ${warnCount}, 失败: ${failCount}`)
  if (notes.length) { console.log('\n— 备注:'); for (const n of notes) console.log(`  ℹ ${n}`) }
}

main()
  .catch((e) => { console.error('\n❌ 测试异常:', e); failCount++ })
  .then(async () => { try { ws.close() } catch {}; process.exit(failCount > 0 ? 1 : 0) })
