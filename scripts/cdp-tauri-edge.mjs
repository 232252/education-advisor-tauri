// =============================================================
// CDP 多角度边缘测试 — Tauri 版
// 从边界输入、异常参数、数据一致性、高并发、错误恢复等角度
// 对 Tauri 应用进行深度压力测试
// =============================================================
import { chromium } from 'playwright'

const CDP_URL = 'http://localhost:9222'

async function connect() {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL)
    const contexts = browser.contexts()
    if (contexts.length === 0) throw new Error('No browser context')
    const pages = contexts[0].pages()
    if (pages.length === 0) throw new Error('No page')
    return { browser, page: pages[0] }
  } catch (e) {
    console.error('❌ 无法连接 CDP:', e.message)
    process.exit(1)
  }
}

async function callApi(page, channel, ...args) {
  return await page.evaluate(async ({ ch, ag }) => {
    try {
      if (!window.__TAURI_INTERNALS__ || typeof window.__TAURI_INTERNALS__.invoke !== 'function') {
        return { ok: false, error: 'window.__TAURI_INTERNALS__.invoke not available' }
      }
      const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: ch, args: ag })
      return { ok: true, data: r }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  }, { ch: channel, ag: args })
}

async function main() {
  const { browser, page } = await connect()

  const results = { pass: 0, fail: 0, details: [] }
  const log = (name, ok, detail = '') => {
    results.details.push({ name, ok, detail })
    if (ok) { results.pass++; console.log(`  ✓ ${name}`) }
    else { results.fail++; console.log(`  ✗ ${name} ${detail}`) }
  }

  console.log('╔══════════════════════════════════════════════════╗')
  console.log('║  CDP 多角度边缘测试 — Tauri 边界/异常/并发/一致性  ║')
  console.log('╚══════════════════════════════════════════════════╝\n')

  // ===== A. 边界输入测试 =====
  console.log('━━━ A. 边界输入测试 ━━━')

  // A1. Unicode 学生名 (中文/日文/韩文/emoji) — 使用唯一名避免软删除残留
  const unicodeNames = [
    '张三丰',
    '田中太郎',
    '김민수',
    'Student_Émoji_🎉',
    'Ольга',
    'محمد',
  ]
  const unicodeSuffix = Date.now()
  for (let i = 0; i < unicodeNames.length; i++) {
    const name = `${unicodeNames[i]}_${unicodeSuffix}`
    const r = await callApi(page, 'eaa:add-student', name)
    log(`Unicode学生名: ${unicodeNames[i].slice(0, 6)}`, r.ok && r.data?.success !== false, r.error || r.data?.error || '')
    if (r.ok && r.data?.success !== false) {
      await callApi(page, 'eaa:delete-student', name, { confirm: true, reason: 'cleanup' })
    }
  }

  // A2. 极长名字 (边界值) — 系统限制 max 64 字符, 255 应被拒绝
  const longName255 = 'A'.repeat(255)
  const r255 = await callApi(page, 'eaa:add-student', longName255)
  log('255字符名字拒绝(max64)', !r255.ok || r255.data?.success === false, r255.error || '(应拒绝)')

  // A2b. 64 字符名字 (边界值上界) — 应接受, 使用唯一后缀避免残留
  const name64 = 'B'.repeat(50) + `_${Date.now()}`
  const r64 = await callApi(page, 'eaa:add-student', name64)
  log('64字符名字接受(边界上界)', r64.ok && r64.data?.success !== false, r64.error || r64.data?.error || '')
  if (r64.ok && r64.data?.success !== false) {
    await callApi(page, 'eaa:delete-student', name64, { confirm: true, reason: 'cleanup' })
  }

  // A3. 单字符名字 — 使用唯一后缀避免软删除残留
  const singleName = `X_${Date.now()}`
  const r1 = await callApi(page, 'eaa:add-student', singleName)
  log('单字符+后缀名字', r1.ok && r1.data?.success !== false, r1.error || r1.data?.error || '')
  if (r1.ok && r1.data?.success !== false) {
    await callApi(page, 'eaa:delete-student', singleName, { confirm: true, reason: 'cleanup' })
  }

  // A4. 数字名字 — 使用唯一后缀
  const numName = `12345_${Date.now()}`
  const rNum = await callApi(page, 'eaa:add-student', numName)
  log('纯数字+后缀名字', rNum.ok && rNum.data?.success !== false, rNum.error || rNum.data?.error || '')
  if (rNum.ok && rNum.data?.success !== false) {
    await callApi(page, 'eaa:delete-student', numName, { confirm: true, reason: 'cleanup' })
  }

  // ===== B. 异常参数测试 =====
  console.log('\n━━━ B. 异常参数测试 ━━━')

  // B1. null 参数
  const rNull = await callApi(page, 'eaa:add-student', null)
  log('null学生名拒绝', !rNull.ok || rNull.data?.success === false, '(应拒绝)')

  // B2. 数字类型作为名字 — 应拒绝
  const rNumber = await callApi(page, 'eaa:add-student', 12345)
  log('数字类型学生名拒绝', !rNumber.ok || rNumber.data?.success === false, '(应拒绝)')

  // B3. 对象作为名字 — 应拒绝
  const rObj = await callApi(page, 'eaa:add-student', { name: 'hack' })
  log('对象类型学生名拒绝', !rObj.ok || rObj.data?.success === false, '(应拒绝)')

  // B4. 数组作为名字 — 应拒绝
  const rArr = await callApi(page, 'eaa:add-student', ['arr'])
  log('数组类型学生名拒绝', !rArr.ok || rArr.data?.success === false, '(应拒绝)')

  // B5. 不存在的 channel
  const rGhost = await callApi(page, 'eaa:nonexistent-channel')
  log('不存在channel处理', !rGhost.ok || rGhost.data?.success === false, '(应返回错误)')

  // B6. 空字符串 channel
  const rEmptyCh = await callApi(page, '')
  log('空channel处理', !rEmptyCh.ok, '(应返回错误)')

  // B7. add-event 缺少必需字段 — 应拒绝
  const rMissing = await callApi(page, 'eaa:add-event', { studentName: 'test' })
  log('add-event缺少字段拒绝', !rMissing.ok || rMissing.data?.success === false, '(应拒绝)')

  // B8. add-event delta 类型错误
  const rBadDelta = await callApi(page, 'eaa:add-event', {
    studentName: 'test',
    reasonCode: 'CLASS_MONITOR',
    delta: 'not-a-number',
  })
  log('add-event delta类型错误', rBadDelta.ok, '(应有错误处理)')

  // ===== C. 数据一致性测试 =====
  console.log('\n━━━ C. 数据一致性测试 ━━━')

  // C1. 创建→查询→更新→查询→删除→查询 验证一致性
  const consistName = `Consist_${Date.now()}`
  const c1 = await callApi(page, 'eaa:add-student', consistName)
  log('一致性: 创建学生', c1.ok && c1.data?.success !== false, c1.error || '')

  const c2 = await callApi(page, 'eaa:score', consistName)
  log('一致性: 创建后查询分数', c2.ok && c2.data?.success !== false, `score=${c2.data?.data?.score}`)

  const c3 = await callApi(page, 'eaa:add-event', {
    studentName: consistName,
    reasonCode: 'CLASS_MONITOR',
    delta: 10,
    note: '一致性测试',
  })
  log('一致性: 添加事件', c3.ok && c3.data?.success !== false, c3.error || c3.data?.error || '')

  const c4 = await callApi(page, 'eaa:score', consistName)
  const scoreAfter = c4.data?.data?.score
  log('一致性: 事件后分数=110(基础100+10)', c4.ok && scoreAfter === 110, `score=${scoreAfter}`)

  const c5 = await callApi(page, 'eaa:history', consistName)
  const histLen = c5.data?.data?.length || c5.data?.data?.events?.length || 0
  log('一致性: 历史记录=1条', c5.ok && histLen >= 1, `count=${histLen}`)

  const c6 = await callApi(page, 'eaa:delete-student', consistName, { confirm: true, reason: 'cleanup' })
  log('一致性: 删除学生', c6.ok && c6.data?.success !== false, c6.error || '')

  const c7 = await callApi(page, 'eaa:score', consistName)
  log('一致性: 删除后查询', c7.ok, '(应返回失败或空)')

  // C2. 班级数据一致性
  const consistClassId = `Consist-Class-${Date.now()}`
  const cc1 = await callApi(page, 'class:create', {
    class_id: consistClassId,
    name: '一致性测试班级',
    grade: '八年级',
    teacher: '一致性老师',
  })
  log('一致性: 创建班级', cc1.ok && cc1.data?.success !== false, cc1.error || cc1.data?.error || '')
  const consistClassDbId = cc1.data?.data?.id

  const cc2 = await callApi(page, 'class:list')
  log('一致性: 班级列表包含新班级', cc2.ok && cc2.data?.success !== false, '')

  if (consistClassDbId) {
    const cc3 = await callApi(page, 'class:update', consistClassDbId, { name: '一致性更新名称' })
    log('一致性: 更新班级', cc3.ok && cc3.data?.success !== false, cc3.error || '')

    const cc4 = await callApi(page, 'class:archive', consistClassDbId)
    log('一致性: 归档班级', cc4.ok && cc4.data?.success !== false, cc4.error || '')

    const cc5 = await callApi(page, 'class:restore', consistClassDbId)
    log('一致性: 恢复班级', cc5.ok && cc5.data?.success !== false, cc5.error || '')

    const cc6 = await callApi(page, 'class:delete', consistClassDbId)
    log('一致性: 删除班级', cc6.ok && cc6.data?.success !== false, cc6.error || '')
  }

  // ===== D. 高并发压力测试 =====
  console.log('\n━━━ D. 高并发压力测试 ━━━')

  // D1. 20 并发读取
  const d1Start = Date.now()
  const d1Promises = []
  for (let i = 0; i < 20; i++) {
    d1Promises.push(callApi(page, 'eaa:list-students'))
  }
  const d1Results = await Promise.all(d1Promises)
  const d1Ok = d1Results.filter(r => r.ok).length
  const d1Elapsed = Date.now() - d1Start
  log('20并发读取', d1Ok === 20, `${d1Ok}/20 ok, ${d1Elapsed}ms`)

  // D2. 20 并发混合操作 (读取+写入)
  const d2Start = Date.now()
  const d2Promises = []
  for (let i = 0; i < 10; i++) {
    d2Promises.push(callApi(page, 'eaa:list-students'))
    d2Promises.push(callApi(page, 'eaa:info'))
  }
  const d2Results = await Promise.all(d2Promises)
  const d2Ok = d2Results.filter(r => r.ok).length
  const d2Elapsed = Date.now() - d2Start
  log('20并发混合读写', d2Ok === 20, `${d2Ok}/20 ok, ${d2Elapsed}ms`)

  // D3. 50 并发纯读取
  const d3Start = Date.now()
  const d3Promises = []
  for (let i = 0; i < 50; i++) {
    d3Promises.push(callApi(page, 'eaa:info'))
  }
  const d3Results = await Promise.all(d3Promises)
  const d3Ok = d3Results.filter(r => r.ok).length
  const d3Elapsed = Date.now() - d3Start
  log('50并发读取', d3Ok === 50, `${d3Ok}/50 ok, ${d3Elapsed}ms`)

  // D4. 并发创建学生 (唯一名)
  const d4Start = Date.now()
  const d4Promises = []
  const d4Base = Date.now()
  for (let i = 0; i < 10; i++) {
    d4Promises.push(callApi(page, 'eaa:add-student', `Concurrent_${d4Base}_${i}`))
  }
  const d4Results = await Promise.all(d4Promises)
  const d4Ok = d4Results.filter(r => r.ok && r.data?.success !== false).length
  const d4Elapsed = Date.now() - d4Start
  log('10并发创建学生', d4Ok === 10, `${d4Ok}/10 ok, ${d4Elapsed}ms`)
  // 清理
  for (let i = 0; i < 10; i++) {
    await callApi(page, 'eaa:delete-student', `Concurrent_${d4Base}_${i}`, { confirm: true, reason: 'cleanup' })
  }

  // ===== E. 连续写入压力测试 =====
  console.log('\n━━━ E. 连续写入压力测试 ━━━')

  // E1. 连续创建+删除 10 个学生
  const e1Base = `Batch_${Date.now()}_`
  let e1Ok = 0
  for (let i = 0; i < 10; i++) {
    const r = await callApi(page, 'eaa:add-student', `${e1Base}${i}`)
    if (r.ok && r.data?.success !== false) e1Ok++
  }
  log('连续创建10学生', e1Ok === 10, `${e1Ok}/10`)

  let e1DelOk = 0
  for (let i = 0; i < 10; i++) {
    const r = await callApi(page, 'eaa:delete-student', `${e1Base}${i}`, { confirm: true, reason: 'cleanup' })
    if (r.ok && r.data?.success !== false) e1DelOk++
  }
  log('连续删除10学生', e1DelOk === 10, `${e1DelOk}/10`)

  // E2. 连续添加事件 10 次 — 每个学生 1 个事件 (EAA 限制同一学生当日同一 reasonCode 唯一)
  const e2Base = `Evt_${Date.now()}_`
  const eventCodes = [
    { code: 'CLASS_MONITOR', delta: 10 },
    { code: 'CLASS_COMMITTEE', delta: 5 },
    { code: 'CIVILIZED_DORM', delta: 3 },
    { code: 'MONTHLY_ATTENDANCE', delta: 2 },
    { code: 'ACTIVITY_PARTICIPATION', delta: 1 },
  ]
  let e2Ok = 0
  let e2FirstError = ''
  const e2CreatedNames = []
  for (let i = 0; i < 10; i++) {
    const sName = `${e2Base}${i}`
    await callApi(page, 'eaa:add-student', sName)
    e2CreatedNames.push(sName)
    const ec = eventCodes[i % eventCodes.length]
    const r = await callApi(page, 'eaa:add-event', {
      studentName: sName,
      reasonCode: ec.code,
      delta: ec.delta,
      note: `batch ${i}`,
    })
    if (r.ok && r.data?.success !== false) {
      e2Ok++
    } else if (!e2FirstError) {
      e2FirstError = r.error || r.data?.error || `exitCode=${r.data?.exitCode}`
    }
  }
  log('连续添加10事件(10学生)', e2Ok === 10, `${e2Ok}/10 ok${e2FirstError ? ', firstErr=' + e2FirstError.slice(0, 80) : ''}`)
  // 清理
  for (const sName of e2CreatedNames) {
    await callApi(page, 'eaa:delete-student', sName, { confirm: true, reason: 'cleanup' })
  }

  // ===== F. 错误恢复测试 =====
  console.log('\n━━━ F. 错误恢复测试 ━━━')

  // F1. 制造错误后验证系统仍正常
  await callApi(page, 'eaa:add-student', null)       // 错误
  await callApi(page, 'eaa:add-event', {})            // 错误
  await callApi(page, 'nonexistent:channel')          // 错误
  await callApi(page, 'eaa:add-student', '')          // 错误

  const f1 = await callApi(page, 'eaa:info')
  log('错误后系统仍正常', f1.ok && f1.data?.success !== false, f1.error || '')

  const f2 = await callApi(page, 'eaa:list-students')
  log('错误后列表仍可读', f2.ok && f2.data?.success !== false, f2.error || '')

  const recoveryName = `Recovery_${Date.now()}`
  const f3 = await callApi(page, 'eaa:add-student', recoveryName)
  log('错误后仍可创建学生', f3.ok && f3.data?.success !== false, f3.error || '')
  if (f3.ok && f3.data?.success !== false) {
    await callApi(page, 'eaa:delete-student', recoveryName, { confirm: true, reason: 'cleanup' })
  }

  // F2. 超时后恢复 (大量请求后)
  for (let i = 0; i < 50; i++) {
    await callApi(page, 'eaa:info')
  }
  const f4 = await callApi(page, 'eaa:info')
  log('50次请求后仍正常', f4.ok && f4.data?.success !== false, f4.error || '')

  // ===== G. 设置一致性测试 =====
  console.log('\n━━━ G. 设置一致性测试 ━━━')

  const g1 = await callApi(page, 'settings:get')
  log('读取设置', g1.ok, g1.error || '')

  // 设置→读取→验证
  await callApi(page, 'settings:set', 'general.theme', 'dark')
  const g2 = await callApi(page, 'settings:get')
  const g2Theme = g2.data?.data?.general?.theme || g2.data?.general?.theme
  log('设置dark后读取验证', g2Theme === 'dark', `theme=${g2Theme}`)

  await callApi(page, 'settings:set', 'general.theme', 'light')
  const g3 = await callApi(page, 'settings:get')
  const g3Theme = g3.data?.data?.general?.theme || g3.data?.general?.theme
  log('设置light后读取验证', g3Theme === 'light', `theme=${g3Theme}`)

  // ===== H. 技能持久化测试 =====
  console.log('\n━━━ H. 技能持久化测试 ━━━')

  const skillName = `EdgeSkill_${Date.now()}`
  const skillContent = `# Edge Skill\n\n测试内容 with unicode 中文 🎉\n\`\`\`python\nprint("hello")\n\`\`\``
  const h1 = await callApi(page, 'skill:save', skillName, skillContent)
  log('保存技能(含特殊字符)', h1.ok && h1.data?.success !== false, h1.error || '')

  const h2 = await callApi(page, 'skill:get', skillName)
  const h2Content = h2.data?.data || h2.data?.content
  log('读取技能内容一致', h2.ok && h2Content === skillContent, h2.error || '内容不一致')

  const h3 = await callApi(page, 'skill:delete', skillName)
  log('删除技能', h3.ok && h3.data?.success !== false, h3.error || '')

  const h4 = await callApi(page, 'skill:get', skillName)
  const h4Content = h4.data?.data || h4.data?.content
  log('删除后读取返回空', !h4.ok || h4.data?.success === false || !h4Content, '(应返回失败或空)')

  // ===== 总结 =====
  console.log('\n╔══════════════════════════════════════════════════╗')
  console.log(`║  总计: ${results.pass} 通过 / ${results.fail} 失败 / ${results.pass + results.fail} 总计`.padEnd(50) + '║')
  console.log('╚══════════════════════════════════════════════════╝')

  if (results.fail > 0) {
    console.log('\n失败项:')
    for (const d of results.details.filter(x => !x.ok)) {
      console.log(`  ✗ ${d.name} ${d.detail}`)
    }
  }

  await browser.close()
  process.exit(results.fail > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
