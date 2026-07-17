// =============================================================
// CDP 全页面深度测试 — Dashboard / Students / Classes / Academics
// 测试每个页面的关键按钮、选择器、表格、图表渲染
// 运行: node scripts/cdp-all-pages-deep.mjs
// =============================================================
import http from 'node:http'
import WebSocket from 'ws'

const CDP_HOST = 'http://127.0.0.1:9222'

let ws, send, evalInPage
let passCount = 0, failCount = 0, warnCount = 0
const notes = [], bugs = []
const TS = Date.now()
const createdExamIds = new Set()
const createdStudents = new Set()

function record(name, ok, detail = '') {
  if (ok === true) passCount++
  else if (ok === 'warn') warnCount++
  else failCount++
  const mark = ok === true ? 'PASS' : ok === 'warn' ? 'WARN' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ' — ' + detail : ''}`)
}
const note = (m) => notes.push(m)
const bug = (m) => bugs.push(m)
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

async function callNS(ns, method, ...args) {
  const argsLiteral = JSON.stringify(JSON.stringify(args))
  const expr = `(async function(){
    try {
      const api = window.__EAA_API__ || window.api;
      const obj = api && api[${JSON.stringify(ns)}];
      const res = await obj[${JSON.stringify(method)}].apply(obj, JSON.parse(${argsLiteral}));
      return JSON.stringify({ __ok: true, res });
    } catch (e) { return JSON.stringify({ __error: (e && e.message) ? e.message : String(e) }); }
  })()`
  const raw = await evalInPage(expr)
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { __error: 'non-json' } }
  if (parsed.__error) return { __error: parsed.__error }
  return parsed.res
}
const callEAA = (m, ...a) => callNS('eaa', m, ...a)
const callAcademic = (m, ...a) => callNS('academic', m, ...a)
const callClass = (m, ...a) => callNS('class', m, ...a)
const isOk = (r) => !!r && r.__error === undefined && r.success === true

async function navigateTo(hash) {
  await evalInPage(`window.location.hash = ${JSON.stringify(hash)}`)
  await sleep(2000)
}

async function clickButton(textContains) {
  return evalInPage(`(function(){
    const btns = Array.from(document.querySelectorAll('button'));
    const target = btns.find(b => b.textContent && b.textContent.includes(${JSON.stringify(textContains)}));
    if (!target) return { ok: false, error: 'button not found: ' + ${JSON.stringify(textContains)} };
    target.click();
    return { ok: true, text: target.textContent.trim().slice(0, 60) };
  })()`)
}

async function setSelect(selector, value) {
  return evalInPage(`(function(){
    const sel = document.querySelector(${JSON.stringify(selector)});
    if (!sel) return { ok: false, error: 'select not found' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, ${JSON.stringify(value)});
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: sel.value };
  })()`)
}

// 按 option 文本设置 select (用于无唯一 CSS selector 的场景)
async function setSelectByFirstOption(optionTextContains, value) {
  return evalInPage(`(function(){
    const sels = Array.from(document.querySelectorAll('select'));
    const target = sels.find(s => s.options[0] && s.options[0].textContent.includes(${JSON.stringify(optionTextContains)}));
    if (!target) return { ok: false, error: 'select with option "' + ${JSON.stringify(optionTextContains)} + '" not found' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(target, ${JSON.stringify(value)});
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: target.value };
  })()`)
}

async function getDOMInfo() {
  return evalInPage(`(function(){
    return {
      title: document.title,
      h1: document.querySelector('h1')?.textContent?.trim() || '',
      h2: document.querySelector('h2')?.textContent?.trim() || '',
      bodyText: document.body.innerText.slice(0, 500),
      tableRows: document.querySelectorAll('table tbody tr').length,
      selectCount: document.querySelectorAll('select').length,
      buttonCount: document.querySelectorAll('button').length,
      inputCount: document.querySelectorAll('input').length,
      canvasCount: document.querySelectorAll('canvas').length,
      echartsCount: document.querySelectorAll('div[_echarts_instance_]').length,
      hash: window.location.hash,
    };
  })()`)
}

// =============================================================
// 1. Dashboard 测试
// =============================================================
async function testDashboard() {
  console.log('\n=== 1. Dashboard 测试 ===')
  await navigateTo('#/dashboard')
  await sleep(3000)

  const dom = await getDOMInfo()
  record('Dashboard 页面加载', dom.hash === '#/dashboard', `hash=${dom.hash}`)
  record('Dashboard 有表格或卡片', dom.tableRows > 0 || dom.bodyText.length > 100, `text=${dom.bodyText.slice(0, 80)}`)
  record('Dashboard 图表渲染', dom.canvasCount > 0 || dom.echartsCount > 0, `canvas=${dom.canvasCount}, echarts=${dom.echartsCount}`)

  // 班级筛选
  const classFilter = await setSelectByFirstOption('全部班级', '__ALL__')
  record('Dashboard 班级筛选 (全部)', classFilter.ok, classFilter.ok ? 'ok' : classFilter.error)
  await sleep(1500)

  // 刷新按钮
  const refresh = await clickButton('刷新')
  record('Dashboard 刷新按钮', refresh.ok, refresh.ok ? refresh.text : refresh.error)
  await sleep(2000)

  // 健康检查按钮 (h3 标题为"健康检查",按钮文案为"运行检查")
  // clickButton 找 button,所以应用按钮文案
  const doctor = await clickButton('运行检查')
  if (doctor.ok) {
    record('Dashboard 健康检查按钮', true, doctor.text)
    await sleep(3000) // 等待 doctor 完成
  } else {
    record('Dashboard 健康检查按钮', 'warn', '按钮未找到(可能文案不同)')
  }

  // 数据验证按钮 (h3 标题为"数据验证",按钮文案为"验证数据")
  const validate = await clickButton('验证数据')
  if (validate.ok) {
    record('Dashboard 数据验证按钮', true, validate.text)
    await sleep(3000)
  } else {
    record('Dashboard 数据验证按钮', 'warn', '按钮未找到(可能文案不同)')
  }

  // Top10 排行榜
  const hasRanking = await evalInPage(`document.body.innerText.includes('排行') || document.body.innerText.includes('Top')`)
  record('Dashboard Top10 排行榜区域', hasRanking, hasRanking ? 'ok' : '未找到')

  // 班级对比模式
  const compareMode = await clickButton('对比')
  if (compareMode.ok) {
    record('Dashboard 班级对比模式按钮', true, compareMode.text)
    await sleep(1500)
  } else {
    record('Dashboard 班级对比模式按钮', 'warn', '按钮未找到')
  }
}

// =============================================================
// 2. Students 测试
// =============================================================
async function testStudents() {
  console.log('\n=== 2. Students 测试 ===')
  await navigateTo('#/dashboard')
  await sleep(800)
  await navigateTo('#/students')
  await sleep(3000)

  const dom = await getDOMInfo()
  record('Students 页面加载', dom.hash === '#/students', `hash=${dom.hash}`)
  record('Students 学生表渲染', dom.tableRows > 0, `rows=${dom.tableRows}`)

  // 班级筛选
  const classFilter = await setSelectByFirstOption('全部班级', '__ALL__')
  record('Students 班级筛选 (全部)', classFilter.ok, classFilter.ok ? 'ok' : classFilter.error)
  await sleep(1000)

  // 搜索
  const searchOk = await evalInPage(`(function(){
    const input = document.querySelector('input[type="text"]');
    if (!input) return { ok: false };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '测试');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  })()`)
  record('Students 搜索输入', searchOk.ok, searchOk.ok ? 'ok' : 'input not found')
  await sleep(800)
  // 清空搜索
  await evalInPage(`(function(){
    const input = document.querySelector('input[type="text"]');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`)
  await sleep(800)

  // 添加学生 (inline 表单: 姓名输入框 + 班级 select + 确认按钮)
  // 班级必填,确认按钮 disabled=!newStudentClassId
  const testStuName = `DeepTest_${TS}`
  const addBtn = await clickButton('添加')
  if (addBtn.ok) {
    record('Students 添加学生按钮', true, addBtn.text)
    await sleep(1000)
    // 输入姓名 — 排除搜索框(placeholder 含"搜索"),精确匹配 placeholder 含"姓名"但不含"搜索"
    const nameInputResult = await evalInPage(`(function(){
      const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
      // inline 表单的姓名输入框: placeholder 是 "姓名..." (i18n: page.students.col.name + "...")
      // 搜索框 placeholder 是 "搜索姓名/分组/角色..." 也含"姓名" — 必须用 !includes('搜索') 排除
      const target = inputs.find(i => i.placeholder && i.placeholder.includes('姓名') && !i.placeholder.includes('搜索'));
      if (!target) return { ok: false, error: 'name input not found', placeholders: inputs.map(i => i.placeholder) };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(target, ${JSON.stringify(testStuName)});
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, placeholder: target.placeholder };
    })()`)
    record('Students 输入姓名', nameInputResult.ok, nameInputResult.ok ? `placeholder=${nameInputResult.placeholder}` : nameInputResult.error)
    await sleep(300)

    // 选择班级 — inline 表单的班级 select 第一个 option 是 "选择班级 *"
    // 取一个非空 option 值
    const classSelectResult = await evalInPage(`(function(){
      const sels = Array.from(document.querySelectorAll('select'));
      // inline 表单的班级 select: 第一个 option 文本含 "选择班级"
      const target = sels.find(s => s.options[0] && s.options[0].textContent.includes('选择班级'));
      if (!target) return { ok: false, error: 'class select not found', optionCount: 0 };
      if (target.options.length < 2) return { ok: false, error: 'no class options', optionCount: target.options.length };
      // 选第二个 option (第一个是占位)
      const val = target.options[1].value;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(target, val);
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: val, optionCount: target.options.length, selectedName: target.options[1].textContent };
    })()`)
    record('Students 选择班级', classSelectResult.ok, classSelectResult.ok ? `class=${classSelectResult.selectedName}` : classSelectResult.error)
    await sleep(300)

    // 点击确认 (此时按钮应启用)
    const confirmBtn = await clickButton('确认')
    if (confirmBtn.ok) {
      record('Students 确认添加学生', true, confirmBtn.text)
      createdStudents.add(testStuName)
      await sleep(2000)
      // 验证学生出现在列表中
      const inList = await evalInPage(`document.body.innerText.includes(${JSON.stringify(testStuName)})`)
      record('Students 新学生出现在列表', inList, inList ? 'ok' : '未找到')
    } else {
      record('Students 确认添加学生', false, '确认按钮未找到')
    }
  } else {
    record('Students 添加学生按钮', 'warn', '按钮未找到')
  }

  // 点击第一行学生打开档案
  const clickFirst = await evalInPage(`(function(){
    const rows = document.querySelectorAll('table tbody tr');
    if (rows.length === 0) return { ok: false, error: 'no rows' };
    rows[0].click();
    return { ok: true };
  })()`)
  record('Students 点击学生行打开档案', clickFirst.ok, clickFirst.ok ? 'ok' : clickFirst.error)
  await sleep(2000)

  // 验证 StudentProfile 打开 (检查 tab 按钮存在)
  const profileOpen = await evalInPage(`(function(){
    const btns = Array.from(document.querySelectorAll('button'));
    const hasOverview = btns.some(b => b.textContent.includes('概览'));
    const hasAcademics = btns.some(b => b.textContent.includes('学业'));
    return { hasOverview, hasAcademics };
  })()`)
  record('Students StudentProfile 打开 (tab 按钮存在)', profileOpen.hasOverview || profileOpen.hasAcademics,
    `overview=${profileOpen.hasOverview}, academics=${profileOpen.hasAcademics}`)

  // 关闭档案
  await evalInPage(`(function(){
    const btns = Array.from(document.querySelectorAll('button'));
    const close = btns.find(b => b.textContent.includes('×') || b.textContent.includes('关闭') || b.textContent.includes('返回'));
    if (close) close.click();
  })()`)
  await sleep(1000)

  // 选择模式
  const selectMode = await clickButton('选择')
  if (selectMode.ok) {
    record('Students 进入选择模式', true, selectMode.text)
    await sleep(1000)
    // 退出选择模式
    const exitMode = await clickButton('取消')
    if (exitMode.ok) record('Students 退出选择模式', true)
  } else {
    record('Students 选择模式按钮', 'warn', '按钮未找到')
  }

  // 导入/导出按钮
  const importBtn = await clickButton('导入')
  record('Students 导入按钮存在', importBtn.ok || await evalInPage(`document.body.innerText.includes('导入')`), '')
  const exportBtn = await clickButton('导出')
  record('Students 导出按钮存在', exportBtn.ok || await evalInPage(`document.body.innerText.includes('导出')`), '')
}

// =============================================================
// 3. Classes 测试
// =============================================================
async function testClasses() {
  console.log('\n=== 3. Classes 测试 ===')
  await navigateTo('#/dashboard')
  await sleep(800)
  await navigateTo('#/classes')
  await sleep(3000)

  const dom = await getDOMInfo()
  record('Classes 页面加载', dom.hash === '#/classes', `hash=${dom.hash}`)
  record('Classes 班级表渲染', dom.tableRows > 0, `rows=${dom.tableRows}`)

  // 添加班级 — 按钮文案是 "+ 新建班级" (i18n: page.classes.add)
  const testClassName = `深度测试班_${TS}`
  const addBtn = await clickButton('新建班级')
  if (addBtn.ok) {
    record('Classes 添加班级按钮', true, addBtn.text)
    await sleep(1500) // 等模态打开

    // 模态结构: class_id input (placeholder="G7-3") + name ComboBox + grade ComboBox + teacher input + note input
    // ComboBox 渲染为 input + 下拉,所以也是 input[type="text"]
    // 先填 class_id (第一个 input, placeholder="G7-3")
    const classIdResult = await evalInPage(`(function(){
      const modal = document.querySelector('div.fixed.inset-0');
      if (!modal) return { ok: false, error: 'modal not found' };
      const inputs = modal.querySelectorAll('input[type="text"]');
      // 找 placeholder="G7-3" 的 class_id input
      let classIdInput = null;
      for (const i of inputs) {
        if (i.placeholder && i.placeholder.includes('G7')) { classIdInput = i; break; }
      }
      if (!classIdInput) return { ok: false, error: 'class_id input not found', count: inputs.length, placeholders: Array.from(inputs).map(i=>i.placeholder) };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const classId = ${JSON.stringify(testClassName)} .replace('深度测试班_', 'DT');
      setter.call(classIdInput, classId);
      classIdInput.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, value: classId };
    })()`)
    record('Classes 输入 class_id', classIdResult.ok, classIdResult.ok ? `id=${classIdResult.value}` : classIdResult.error || JSON.stringify(classIdResult.placeholders))
    await sleep(300)

    // 填班级名称 — ComboBox (找模态内 placeholder 含"名称"或第 2 个 input)
    const nameResult = await evalInPage(`(function(){
      const modal = document.querySelector('div.fixed.inset-0');
      if (!modal) return { ok: false, error: 'modal not found' };
      const inputs = Array.from(modal.querySelectorAll('input[type="text"]'));
      // 班级名称 ComboBox 的 input: placeholder 含 "名称" 或 "班" (i18n)
      let target = inputs.find(i => i.placeholder && (i.placeholder.includes('名称') || i.placeholder.includes('班级')));
      // fallback: 第 2 个 input (第 1 个是 class_id)
      if (!target && inputs.length >= 2) target = inputs[1];
      if (!target) return { ok: false, error: 'name input not found' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(target, ${JSON.stringify(testClassName)});
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, placeholder: target.placeholder };
    })()`)
    record('Classes 输入班级名称', nameResult.ok, nameResult.ok ? `placeholder=${nameResult.placeholder}` : nameResult.error)
    await sleep(300)

    // 点击保存
    const saveBtn = await clickButton('保存')
    if (saveBtn.ok) {
      record('Classes 保存班级', true, saveBtn.text)
      await sleep(2000)
      // 验证班级出现
      const inList = await evalInPage(`document.body.innerText.includes(${JSON.stringify(testClassName)})`)
      record('Classes 新班级出现在列表', inList, inList ? 'ok' : '未找到')
    } else {
      record('Classes 保存班级', false, '保存按钮未找到')
      // 取消
      await clickButton('取消')
      await sleep(500)
    }
  } else {
    record('Classes 添加班级按钮', 'warn', '按钮未找到(可能文案不同)')
  }

  // 点击第一行班级打开 ClassProfile
  const clickFirst = await evalInPage(`(function(){
    const rows = document.querySelectorAll('table tbody tr');
    if (rows.length === 0) return { ok: false, error: 'no rows' };
    rows[0].click();
    return { ok: true };
  })()`)
  record('Classes 点击班级行打开 ClassProfile', clickFirst.ok, clickFirst.ok ? 'ok' : clickFirst.error)
  await sleep(2000)

  // 验证 ClassProfile 打开 (检查 tab 按钮)
  const profileOpen = await evalInPage(`(function(){
    const btns = Array.from(document.querySelectorAll('button'));
    const hasOverview = btns.some(b => b.textContent.includes('概览'));
    const hasStudents = btns.some(b => b.textContent.includes('学生'));
    const hasAssign = btns.some(b => b.textContent.includes('分配') || b.textContent.includes('分入'));
    return { hasOverview, hasStudents, hasAssign };
  })()`)
  record('Classes ClassProfile 打开 (tab 存在)',
    profileOpen.hasOverview || profileOpen.hasStudents || profileOpen.hasAssign,
    `overview=${profileOpen.hasOverview}, students=${profileOpen.hasStudents}, assign=${profileOpen.hasAssign}`)

  // 切换 tab
  if (profileOpen.hasStudents) {
    const stuTab = await clickButton('学生')
    if (stuTab.ok) { record('Classes ClassProfile 学生 tab', true); await sleep(1500) }
  }
  if (profileOpen.hasAssign) {
    const assignTab = await clickButton('分配')
    if (assignTab.ok) { record('Classes ClassProfile 分配 tab', true); await sleep(1500) }
  }

  // 关闭 ClassProfile
  await evalInPage(`(function(){
    const btns = Array.from(document.querySelectorAll('button'));
    const close = btns.find(b => b.textContent.includes('×') || b.textContent.includes('关闭') || b.textContent.includes('返回'));
    if (close) close.click();
  })()`)
  await sleep(1000)

  // 显示已存档复选框 — 仅当 archivedClasses.length > 0 时才渲染
  // 先检查是否有已存档班级,再决定测试预期
  const archiveInfo = await evalInPage(`(function(){
    // 检查页面上是否有"显示已存档"复选框
    const cbs = document.querySelectorAll('input[type="checkbox"]');
    for (const cb of cbs) {
      if (cb.parentElement && cb.parentElement.textContent.includes('存档')) {
        cb.click();
        return { ok: true, found: true };
      }
    }
    return { ok: false, found: false };
  })()`)
  if (archiveInfo.found) {
    record('Classes 显示已存档复选框', true, '已切换显示')
    await sleep(1000)
  } else {
    // 没有已存档班级时,复选框不渲染 — 这是预期行为,不是 bug
    record('Classes 显示已存档复选框', 'warn', '当前无已存档班级,复选框条件渲染不显示(预期行为)')
  }
}

// =============================================================
// 4. Academics — Overview / Exams / Entry tabs
// =============================================================
async function testAcademics() {
  console.log('\n=== 4. Academics 测试 (overview/exams/entry) ===')
  await navigateTo('#/dashboard')
  await sleep(800)
  await navigateTo('#/academics')
  await sleep(3000)

  const dom = await getDOMInfo()
  record('Academics 页面加载', dom.hash === '#/academics', `hash=${dom.hash}`)

  // --- 4a. Overview tab ---
  console.log('\n--- 4a. Overview tab ---')
  // 确保有学生选中 (loadInitialData 自动选第一个)
  const hasStudent = await evalInPage(`(function(){
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.some(b => b.textContent.includes('成绩总览'));
  })()`)
  record('Academics overview tab 按钮存在', hasStudent)

  const overviewClick = await clickButton('成绩总览')
  if (overviewClick.ok) {
    record('Academics 点击 overview tab', true)
    await sleep(2000)
    const overviewDom = await getDOMInfo()
    record('Academics overview 图表渲染', overviewDom.canvasCount > 0 || overviewDom.echartsCount > 0,
      `canvas=${overviewDom.canvasCount}, echarts=${overviewDom.echartsCount}`)
    record('Academics overview 表格渲染', overviewDom.tableRows > 0, `rows=${overviewDom.tableRows}`)
  }

  // --- 4b. Exams tab ---
  console.log('\n--- 4b. Exams tab ---')
  const examsClick = await clickButton('考试管理')
  if (examsClick.ok) {
    record('Academics 点击 exams tab', true, examsClick.text)
    await sleep(2000)
    const examsDom = await getDOMInfo()
    // 检查考试列表或"创建考试"按钮
    const hasCreateBtn = await evalInPage(`document.body.innerText.includes('创建考试')`)
    record('Academics exams 有创建按钮或考试列表', hasCreateBtn || examsDom.tableRows > 0,
      `createBtn=${hasCreateBtn}, rows=${examsDom.tableRows}`)

    // 测试创建考试表单展开
    const createBtn = await clickButton('创建考试')
    if (createBtn.ok) {
      record('Academics exams 创建考试按钮', true)
      await sleep(1000)
      // 检查表单字段
      const hasForm = await evalInPage(`(function(){
        const inputs = document.querySelectorAll('input[type="text"], input[type="date"]');
        const selects = document.querySelectorAll('select');
        return { inputs: inputs.length, selects: selects.length };
      })()`)
      record('Academics exams 创建表单字段', hasForm.inputs > 0 || hasForm.selects > 0,
        `inputs=${hasForm.inputs}, selects=${hasForm.selects}`)
      // 取消
      await clickButton('取消')
      await sleep(500)
    }
  } else {
    record('Academics exams tab', false, 'tab 按钮未找到')
  }

  // --- 4c. Entry tab ---
  console.log('\n--- 4c. Entry tab ---')
  const entryClick = await clickButton('成绩录入')
  if (entryClick.ok) {
    record('Academics 点击 entry tab', true, entryClick.text)
    await sleep(2000)
    const entryDom = await getDOMInfo()
    record('Academics entry 有 select 或 input', entryDom.selectCount > 0 || entryDom.inputCount > 0,
      `selects=${entryDom.selectCount}, inputs=${entryDom.inputCount}`)

    // 检查录入模式切换 (单科/全科)
    const hasSingleMode = await evalInPage(`document.body.innerText.includes('单科')`)
    const hasAllMode = await evalInPage(`document.body.innerText.includes('全科')`)
    record('Academics entry 录入模式 (单科/全科)', hasSingleMode || hasAllMode,
      `single=${hasSingleMode}, all=${hasAllMode}`)

    // 检查 AI 智能录入
    const hasAI = await evalInPage(`document.body.innerText.includes('AI') || document.body.innerText.includes('智能')`)
    record('Academics entry AI 智能录入', hasAI, hasAI ? 'ok' : '未找到')

    // 切换到全科模式
    if (hasAllMode) {
      const allModeBtn = await clickButton('全科')
      if (allModeBtn.ok) {
        record('Academics entry 切换全科模式', true)
        await sleep(1000)
      }
    }

    // 切换到单科模式
    if (hasSingleMode) {
      const singleModeBtn = await clickButton('单科')
      if (singleModeBtn.ok) {
        record('Academics entry 切换单科模式', true)
        await sleep(1000)
      }
    }
  } else {
    record('Academics entry tab', false, 'tab 按钮未找到')
  }

  // --- 4d. 学期筛选 ---
  console.log('\n--- 4d. 学期筛选 ---')
  // 先回到 overview
  await clickButton('成绩总览')
  await sleep(1500)
  const semesterFilter = await setSelectByFirstOption('全部学期', '__ALL__')
  if (semesterFilter.ok) {
    record('Academics 学期筛选', true, 'ok')
    await sleep(1000)
  } else {
    record('Academics 学期筛选', 'warn', 'select 未找到(可能无考试数据)')
  }
}

// =============================================================
// 5. 导航完整性测试
// =============================================================
async function testNavigation() {
  console.log('\n=== 5. 导航完整性测试 ===')
  const routes = [
    { hash: '#/dashboard', name: 'Dashboard' },
    { hash: '#/students', name: 'Students' },
    { hash: '#/classes', name: 'Classes' },
    { hash: '#/academics', name: 'Academics' },
    { hash: '#/chat', name: 'Chat' },
    { hash: '#/agents', name: 'Agents' },
    { hash: '#/settings', name: 'Settings' },
    { hash: '#/privacy', name: 'Privacy' },
  ]

  for (const route of routes) {
    await navigateTo(route.hash)
    await sleep(2500)
    const dom = await getDOMInfo()
    // 验证页面加载 (非空白)
    const loaded = dom.bodyText.length > 50 || dom.buttonCount > 0 || dom.tableRows > 0
    record(`导航 ${route.name} (${route.hash})`, loaded && dom.hash === route.hash,
      `hash=${dom.hash}, buttons=${dom.buttonCount}, text=${dom.bodyText.slice(0, 40)}`)
  }
}

// =============================================================
// 主流程
// =============================================================
async function main() {
  console.log('=== 全页面深度测试 ===')
  console.log(`时间: ${new Date().toISOString()}\n`)

  await connect()

  await testDashboard()
  await testStudents()
  await testClasses()
  await testAcademics()
  await testNavigation()

  console.log('\n=== 总结 ===')
  const total = passCount + failCount + warnCount
  console.log(`总计: ${total}, 通过: ${passCount}, 警告: ${warnCount}, 失败: ${failCount}`)
  if (notes.length) { console.log('\n— 备注:'); for (const n of notes) console.log(`  ℹ ${n}`) }
  if (bugs.length) { console.log('\n— Bug:'); for (const b of bugs) console.log(`  🐛 ${b}`) }
}

async function cleanup() {
  // 清理创建的考试
  for (const id of [...createdExamIds]) {
    try { await callAcademic('deleteExam', id) } catch { /* ignore */ }
  }
  console.log(`\n清理: ${createdExamIds.size} 个考试`)
}

main()
  .catch((e) => { console.error('\n❌ 测试异常:', e); failCount++ })
  .then(async () => { await cleanup(); try { ws.close() } catch {}; process.exit(failCount > 0 ? 1 : 0) })
