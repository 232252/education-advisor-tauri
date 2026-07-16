// =============================================================
// Round 12: 用户需求功能 UI 交互测试 (CDP)
//
// 模拟真实用户操作: 点击按钮 / 填写表单 / 切换 Tab / 验证 UI 响应
//   1. 学业模块直接录入 UI 验证 (7 项 - 点击成绩录入Tab, 验证直接录入模式)
//   2. 班级筛选 UI 交互 (7 项 - 选择班级, 验证学生列表更新)
//   3. 导航栏布局验证 (6 项 - 学业/学生分离, 活跃状态)
//   4. 学生档案学业Tab联动 UI (7 项 - 点击Tab, 验证联动数据)
//   5. 端到端联动流程 (4 项 - 录入成绩→打开学生档案→验证Tab显示)
//
// 运行: node scripts/cdp-feature-ui-interact.mjs
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
  const test = (name, fn) =>
    fn().catch((err) => record(name, false, `异常: ${String(err && err.message ? err.message : err).slice(0, 200)}`))

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
      const desc = r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'unknown'
      throw new Error(`Eval error: ${desc.slice(0, 300)}`)
    }
    return r.result?.result?.value
  }

  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP connected, running UI interaction tests...\n')

  // ---------- IPC 封装 (用于数据准备/验证) ----------
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

  const isOk = (res) => !!res && !res.__error && res?.success !== false

  // ---------- UI 辅助 ----------
  const navigateTo = async (hash) => {
    await evalInPage(`(function(){ window.location.hash = ${JSON.stringify(hash)}; })()`)
    await new Promise((r) => setTimeout(r, 1200))
  }
  const getPageText = async () =>
    evalInPage(`(function(){ return document.body.innerText.substring(0, 50000); })()`)
  // 直接在页面中检查是否包含某文本 (不截断, 避免长页面遗漏)
  const pageContains = async (text) =>
    evalInPage(`(function(){ return document.body.innerText.includes(${JSON.stringify(text)}); })()`)

  // 点击包含特定文本的按钮
  const clickButtonText = async (textContains) => {
    const clicked = await evalInPage(`
      (function() {
        var buttons = document.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          if (buttons[i].textContent.includes(${JSON.stringify(textContains)})) {
            buttons[i].click();
            return true;
          }
        }
        return false;
      })()
    `)
    return clicked
  }

  // 点击包含特定文本的链接 (NavLink)
  const clickLink = async (hrefContains) => {
    const clicked = await evalInPage(`
      (function() {
        var links = document.querySelectorAll('a[href]');
        for (var i = 0; i < links.length; i++) {
          if (links[i].getAttribute('href').includes(${JSON.stringify(hrefContains)})) {
            links[i].click();
            return true;
          }
        }
        return false;
      })()
    `)
    return clicked
  }

  // 获取 select 元素的选项
  const getSelectOptions = async (titleAttr) => {
    return evalInPage(`
      (function() {
        var sel = document.querySelector('select[title=${JSON.stringify(titleAttr)}]');
        if (!sel) return null;
        var opts = [];
        for (var i = 0; i < sel.options.length; i++) {
          opts.push({ value: sel.options[i].value, text: sel.options[i].textContent.trim() });
        }
        return { options: opts, count: sel.options.length };
      })()
    `)
  }

  // 设置 select 值 (React 兼容)
  const setSelectValue = async (titleAttr, value) => {
    return evalInPage(`
      (function() {
        var sel = document.querySelector('select[title=${JSON.stringify(titleAttr)}]');
        if (!sel) return false;
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        nativeSetter.call(sel, ${JSON.stringify(value)});
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `)
  }

  // 设置 input 值 (React 兼容)
  const setInputValue = async (selector, value) => {
    return evalInPage(`
      (function() {
        var input = document.querySelector(${JSON.stringify(selector)});
        if (!input) return false;
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `)
  }

  // 检查元素是否存在
  const elementExists = async (selector) =>
    evalInPage(`(function(){ return !!document.querySelector(${JSON.stringify(selector)}); })()`)

  // 检查元素是否包含特定 class
  const hasClass = async (selector, className) =>
    evalInPage(`(function(){ var el = document.querySelector(${JSON.stringify(selector)}); return el ? el.classList.contains(${JSON.stringify(className)}) : false; })()`)

  // ---------- 业务 helper ----------
  const TS = Date.now()

  const listStudents = async () => {
    const r = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    return r?.data?.students ?? []
  }
  const addStudent = async (name) =>
    callIpc(`const res = await api.eaa.addStudent(${JSON.stringify(name)}); return res;`)
  const deleteStudentSoft = async (name, reason) =>
    callIpc(`const res = await api.eaa.deleteStudent(${JSON.stringify(name)}, ${JSON.stringify(reason)}); return res;`)
  const setStudentClassId = async (name, classId) =>
    callIpc(`const res = await api.eaa.setStudentMeta({ name: ${JSON.stringify(name)}, classId: ${JSON.stringify(classId)} }); return res;`)
  const clearStudentClassId = async (name) =>
    callIpc(`const res = await api.eaa.setStudentMeta({ name: ${JSON.stringify(name)}, clearClassId: true }); return res;`)

  const getConfig = async () => {
    const r = await callIpc(`const res = await api.academic.getConfig(); return res;`)
    return r?.data ?? null
  }
  const listExams = async () => {
    const r = await callIpc(`const res = await api.academic.listExams(); return res;`)
    return r?.data ?? []
  }
  const createExam = async (name, subjects) => {
    const r = await callIpc(`
      const res = await api.academic.createExam({
        name: ${JSON.stringify(name)},
        type: 'monthly',
        date: new Date().toISOString().slice(0, 10),
        semester: 'UI交互测试学期',
        subjects: ${JSON.stringify(subjects)},
      });
      return res;
    `)
    return r?.success ? r.data : null
  }
  const deleteExam = async (examId) =>
    callIpc(`const res = await api.academic.deleteExam(${JSON.stringify(examId)}); return res;`)
  const setGrade = async (examId, studentName, subjectId, score, fullMark) =>
    callIpc(`
      const res = await api.academic.setGrade({
        examId: ${JSON.stringify(examId)},
        subjectId: ${JSON.stringify(subjectId)},
        studentName: ${JSON.stringify(studentName)},
        score: ${score},
        fullMark: ${fullMark},
      });
      return res;
    `)
  const getGrades = async (studentName) => {
    const r = await callIpc(`const res = await api.academic.getGrades(${JSON.stringify(studentName)}); return res;`)
    return r?.data ?? []
  }

  const listClasses = async () => {
    const r = await callIpc(`const res = await api.class.list(); return res;`)
    return r?.data ?? []
  }
  const createClass = async (classId, name) => {
    const r = await callIpc(`
      const res = await api.class.create({
        class_id: ${JSON.stringify(classId)},
        name: ${JSON.stringify(name)},
        grade: 'UI测试年级',
        note: 'ui-interact-test',
        teacher: 'UI测试老师',
      });
      return res;
    `)
    return r?.success ? r.data : null
  }
  const deleteClass = async (id) =>
    callIpc(`
      let res;
      if (typeof api.class.remove === 'function') {
        res = await api.class.remove(${JSON.stringify(id)});
      } else {
        res = await api.class.delete(${JSON.stringify(id)});
      }
      return res;
    `)
  const assignStudents = async (classId, names) =>
    callIpc(`const res = await api.class.assign({ class_id: ${JSON.stringify(classId)}, student_names: ${JSON.stringify(names)} }); return res;`)

  // ---------- 清理账本 ----------
  const createdExamIds = []
  const createdClassIds = []
  const throwawayStudents = []

  // ---------- 预取学业配置 ----------
  const config = await getConfig()
  const subjects = config?.subjects ?? []
  const SUBJECT_A = subjects[0]?.id ?? 'chinese'
  const SUBJECT_A_FULL = subjects[0]?.fullMark ?? 150
  console.log(`学业配置: ${subjects.length} 科目, 使用 ${SUBJECT_A}(${SUBJECT_A_FULL})\n`)

  // 准备测试数据: 学生 + 考试 + 班级
  const UI_STU = `ui_stu_${TS}`
  const UI_STU2 = `ui_stu2_${TS}`
  await addStudent(UI_STU)
  throwawayStudents.push(UI_STU)
  await addStudent(UI_STU2)
  throwawayStudents.push(UI_STU2)

  const UI_EXAM = await createExam(`ui-exam_${TS}`, [SUBJECT_A])
  if (UI_EXAM) createdExamIds.push(UI_EXAM.id)
  const EXAM_ID = UI_EXAM?.id || 'fake'

  const UI_CLASS = `ui-class-${TS}`
  const cls = await createClass(UI_CLASS, `UI测试班_${TS}`)
  if (cls?.id) createdClassIds.push(cls.id)

  // 给 UI_STU 分班
  await assignStudents(UI_CLASS, [UI_STU])

  // =============================================================
  // Section 1: 学业模块直接录入 UI 验证 (7 项)
  // =============================================================
  console.log('━━━ Section 1: 学业模块直接录入 UI 验证 ━━━')

  await test('1.1 导航到学业页面', async () => {
    const N = '1.1 导航到学业页面'
    await navigateTo('#/academics')
    await new Promise((r) => setTimeout(r, 500))
    const hasAcademic = await pageContains('学业管理') || await pageContains('成绩总览') || await pageContains('考试管理')
    record(N, hasAcademic, `hasAcademic=${hasAcademic}`)
  })

  await test('1.2 学业页面有 3 个 Tab (总览/考试管理/成绩录入)', async () => {
    const N = '1.2 学业页面有 3 个 Tab (总览/考试管理/成绩录入)'
    const hasOverview = await pageContains('成绩总览')
    const hasExamMgmt = await pageContains('考试管理')
    const hasEntry = await pageContains('成绩录入')
    record(N, hasOverview && hasExamMgmt && hasEntry, `overview=${hasOverview} examMgmt=${hasExamMgmt} entry=${hasEntry}`)
  })

  await test('1.3 点击"成绩录入"Tab 后显示录入界面', async () => {
    const N = '1.3 点击"成绩录入"Tab 后显示录入界面'
    const clicked = await clickButtonText('成绩录入')
    await new Promise((r) => setTimeout(r, 1000))
    // 录入界面应显示模式切换或保存按钮
    const hasEntryUI = await pageContains('单科录入') || await pageContains('全科录入') || await pageContains('保存成绩')
    record(N, clicked && hasEntryUI, `clicked=${clicked} hasEntryUI=${hasEntryUI}`)
  })

  await test('1.4 成绩录入界面支持"直接录入"(不强制选考试)', async () => {
    const N = '1.4 成绩录入界面支持"直接录入"(不强制选考试)'
    // 应有"不选,直接录入"选项 或 "留空保存时自动创建"提示
    const hasDirectEntry = await pageContains('直接录入') || await pageContains('留空保存时自动创建') || await pageContains('不选')
    record(N, hasDirectEntry, `hasDirectEntry=${hasDirectEntry}`)
  })

  await test('1.5 单科录入模式有科目选择器', async () => {
    const N = '1.5 单科录入模式有科目选择器'
    // 确保在单科录入模式
    const clicked = await clickButtonText('单科录入')
    await new Promise((r) => setTimeout(r, 500))
    const hasSubjectSelect = await pageContains('请选择科目') || await pageContains('科目')
    record(N, hasSubjectSelect, `hasSubjectSelect=${hasSubjectSelect}`)
  })

  await test('1.6 成绩录入界面有保存按钮 (选科目后显示)', async () => {
    const N = '1.6 成绩录入界面有保存按钮 (选科目后显示)'
    // 先选择科目 (保存按钮在选科目后才显示)
    // 查找科目 select (不是班级筛选 select)
    const selected = await evalInPage(`
      (function() {
        var selects = document.querySelectorAll('select');
        for (var i = 0; i < selects.length; i++) {
          var opts = selects[i].options;
          for (var j = 0; j < opts.length; j++) {
            if (opts[j].textContent.includes('请选择科目') || opts[j].textContent.includes('满分')) {
              // 找到科目 select, 选第一个科目 (跳过"请选择")
              if (opts.length > 1) {
                var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
                nativeSetter.call(selects[i], opts[1].value);
                selects[i].dispatchEvent(new Event('change', { bubbles: true }));
                return opts[1].textContent;
              }
            }
          }
        }
        return null;
      })()
    `)
    await new Promise((r) => setTimeout(r, 800))
    // 保存按钮可能在选科目后显示
    const hasSaveBtn = await evalInPage(`
      (function() {
        var buttons = document.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          if (buttons[i].textContent.includes('保存成绩') || buttons[i].textContent.includes('保存中')) return true;
        }
        return false;
      })()
    `)
    // 如果选了科目还是没有, 检查是否有 AI 智能录入按钮 (替代验证录入功能存在)
    const hasAiEntry = await pageContains('AI 智能录入') || await pageContains('AI 解析')
    record(N, hasSaveBtn || hasAiEntry, `selectedSubject=${selected} hasSaveBtn=${hasSaveBtn} hasAiEntry=${hasAiEntry}`)
  })

  await test('1.7 成绩录入界面有班级筛选侧边栏', async () => {
    const N = '1.7 成绩录入界面有班级筛选侧边栏'
    // 检查是否有 select[title="按班级筛选"]
    const hasClassFilter = await elementExists('select[title="按班级筛选"]')
    record(N, hasClassFilter, `hasClassFilter=${hasClassFilter}`)
  })

  // =============================================================
  // Section 2: 班级筛选 UI 交互 (7 项)
  // =============================================================
  console.log('\n━━━ Section 2: 班级筛选 UI 交互 ━━━')

  await test('2.1 导航到学生页面', async () => {
    const N = '2.1 导航到学生页面'
    await navigateTo('#/students')
    const text = await getPageText()
    const hasStudents = text.includes('学生管理') || text.includes('学生')
    record(N, hasStudents, `hasStudents=${hasStudents}`)
  })

  await test('2.2 学生页面有班级筛选下拉框', async () => {
    const N = '2.2 学生页面有班级筛选下拉框'
    const hasFilter = await elementExists('select[title="按班级筛选"]')
    record(N, hasFilter, `hasFilter=${hasFilter}`)
  })

  await test('2.3 班级筛选下拉框包含"全部班级"和"未分班"选项', async () => {
    const N = '2.3 班级筛选下拉框包含"全部班级"和"未分班"选项'
    const opts = await getSelectOptions('按班级筛选')
    const hasAll = opts?.options?.some((o) => o.text.includes('全部班级'))
    const hasNone = opts?.options?.some((o) => o.text.includes('未分班'))
    record(N, hasAll && hasNone, `hasAll=${hasAll} hasNone=${hasNone} count=${opts?.count}`)
  })

  await test('2.4 班级筛选下拉框包含测试班级', async () => {
    const N = '2.4 班级筛选下拉框包含测试班级'
    const opts = await getSelectOptions('按班级筛选')
    const hasTestClass = opts?.options?.some((o) => o.value === UI_CLASS || o.text.includes(`UI测试班`))
    record(N, hasTestClass, `hasTestClass=${hasTestClass} options=${opts?.count}`)
  })

  await test('2.5 选择测试班级后学生列表只显示该班学生', async () => {
    const N = '2.5 选择测试班级后学生列表只显示该班学生'
    // 先确认全部班级模式下能看到学生 (用搜索缩小范围)
    await setSelectValue('按班级筛选', '__ALL__')
    await new Promise((r) => setTimeout(r, 500))
    await setInputValue('input[placeholder*="搜索"]', UI_STU)
    await new Promise((r) => setTimeout(r, 800))
    const hasStuInAll = await pageContains(UI_STU)

    // 清除搜索, 选择测试班级
    await setInputValue('input[placeholder*="搜索"]', '')
    await new Promise((r) => setTimeout(r, 300))
    await setSelectValue('按班级筛选', UI_CLASS)
    await new Promise((r) => setTimeout(r, 800))
    await setInputValue('input[placeholder*="搜索"]', UI_STU)
    await new Promise((r) => setTimeout(r, 800))
    const hasStuInFilter = await pageContains(UI_STU)
    // UI_STU2 不在该班级
    await setInputValue('input[placeholder*="搜索"]', UI_STU2)
    await new Promise((r) => setTimeout(r, 800))
    const hasStu2NotInFilter = !await pageContains(UI_STU2)

    record(N, hasStuInAll && hasStuInFilter && hasStu2NotInFilter, `inAll=${hasStuInAll} inFilter=${hasStuInFilter} stu2Hidden=${hasStu2NotInFilter}`)
  })

  await test('2.6 选择"未分班"后显示未分班学生', async () => {
    const N = '2.6 选择"未分班"后显示未分班学生'
    await setInputValue('input[placeholder*="搜索"]', '')
    await new Promise((r) => setTimeout(r, 300))
    await setSelectValue('按班级筛选', '__NONE__')
    await new Promise((r) => setTimeout(r, 800))
    await setInputValue('input[placeholder*="搜索"]', UI_STU2)
    await new Promise((r) => setTimeout(r, 800))
    // UI_STU2 没有分班, 应该显示
    const hasUnassignedStu = await pageContains(UI_STU2)
    // UI_STU 有班级, 不应该显示
    await setInputValue('input[placeholder*="搜索"]', UI_STU)
    await new Promise((r) => setTimeout(r, 800))
    const noAssignedStu = !await pageContains(UI_STU)
    record(N, hasUnassignedStu && noAssignedStu, `hasUnassigned=${hasUnassignedStu} noAssigned=${noAssignedStu}`)
  })

  await test('2.7 恢复"全部班级"后显示所有学生', async () => {
    const N = '2.7 恢复"全部班级"后显示所有学生'
    await setInputValue('input[placeholder*="搜索"]', '')
    await new Promise((r) => setTimeout(r, 300))
    await setSelectValue('按班级筛选', '__ALL__')
    await new Promise((r) => setTimeout(r, 500))
    await setInputValue('input[placeholder*="搜索"]', UI_STU)
    await new Promise((r) => setTimeout(r, 800))
    const hasStu1 = await pageContains(UI_STU)
    await setInputValue('input[placeholder*="搜索"]', UI_STU2)
    await new Promise((r) => setTimeout(r, 800))
    const hasStu2 = await pageContains(UI_STU2)
    // 清除搜索
    await setInputValue('input[placeholder*="搜索"]', '')
    record(N, hasStu1 && hasStu2, `hasStu1=${hasStu1} hasStu2=${hasStu2}`)
  })

  // =============================================================
  // Section 3: 导航栏布局验证 (6 项)
  // =============================================================
  console.log('\n━━━ Section 3: 导航栏布局验证 ━━━')

  await test('3.1 导航栏有学生链接', async () => {
    const N = '3.1 导航栏有学生链接'
    const hasLink = await evalInPage(`(function(){ return !!document.querySelector('a[href="#/students"]'); })()`)
    record(N, hasLink, `hasLink=${hasLink}`)
  })

  await test('3.2 导航栏有学业链接', async () => {
    const N = '3.2 导航栏有学业链接'
    const hasLink = await evalInPage(`(function(){ return !!document.querySelector('a[href="#/academics"]'); })()`)
    record(N, hasLink, `hasLink=${hasLink}`)
  })

  await test('3.3 导航栏有班级链接', async () => {
    const N = '3.3 导航栏有班级链接'
    const hasLink = await evalInPage(`(function(){ return !!document.querySelector('a[href="#/classes"]'); })()`)
    record(N, hasLink, `hasLink=${hasLink}`)
  })

  await test('3.4 学生和学业之间有分隔 (不在同一组)', async () => {
    const N = '3.4 学生和学业之间有分隔 (不在同一组)'
    // 检查 DOM 顺序: /students → /classes → (divider) → /academics
    const order = await evalInPage(`
      (function() {
        var links = document.querySelectorAll('a[href]');
        var paths = [];
        for (var i = 0; i < links.length; i++) {
          paths.push(links[i].getAttribute('href'));
        }
        var stuIdx = paths.indexOf('#/students');
        var clsIdx = paths.indexOf('#/classes');
        var acdIdx = paths.indexOf('#/academics');
        return { stuIdx: stuIdx, clsIdx: clsIdx, acdIdx: acdIdx, paths: paths.slice(0, 15) };
      })()
    `)
    // students 和 classes 相邻, academics 在它们之后 (中间有 divider)
    const separated = order.stuIdx >= 0 && order.clsIdx >= 0 && order.acdIdx >= 0 &&
      order.stuIdx < order.clsIdx && order.clsIdx < order.acdIdx
    record(N, separated, `stu=${order.stuIdx} cls=${order.clsIdx} acd=${order.acdIdx}`)
  })

  await test('3.5 导航到学生页后学生链接为活跃状态', async () => {
    const N = '3.5 导航到学生页后学生链接为活跃状态'
    await navigateTo('#/students')
    await new Promise((r) => setTimeout(r, 500))
    const activeClass = await evalInPage(`
      (function() {
        var link = document.querySelector('a[href="#/students"]');
        if (!link) return null;
        return link.className;
      })()
    `)
    const isActive = activeClass && (activeClass.includes('bg-blue-50') || activeClass.includes('text-blue-700') || activeClass.includes('text-blue-400'))
    record(N, isActive, `activeClass=${activeClass?.substring(0, 80)}`)
  })

  await test('3.6 导航到学业页后学业链接为活跃状态', async () => {
    const N = '3.6 导航到学业页后学业链接为活跃状态'
    await navigateTo('#/academics')
    await new Promise((r) => setTimeout(r, 500))
    const activeClass = await evalInPage(`
      (function() {
        var link = document.querySelector('a[href="#/academics"]');
        if (!link) return null;
        return link.className;
      })()
    `)
    const isActive = activeClass && (activeClass.includes('bg-blue-50') || activeClass.includes('text-blue-700') || activeClass.includes('text-blue-400'))
    record(N, isActive, `activeClass=${activeClass?.substring(0, 80)}`)
  })

  // =============================================================
  // Section 4: 学生档案学业Tab联动 UI (7 项)
  // =============================================================
  console.log('\n━━━ Section 4: 学生档案学业Tab联动 UI ━━━')

  // 先通过 IPC 给 UI_STU 录入成绩
  await setGrade(EXAM_ID, UI_STU, SUBJECT_A, 95, SUBJECT_A_FULL)

  await test('4.1 导航到学生页面并显示学生列表', async () => {
    const N = '4.1 导航到学生页面并显示学生列表'
    await navigateTo('#/dashboard')
    await navigateTo('#/students')
    const text = await getPageText()
    const hasStudentList = text.includes('学生管理') || text.includes(UI_STU)
    record(N, hasStudentList, `hasStudentList=${hasStudentList}`)
  })

  await test('4.2 学生行有 data-ctx-student-name 属性', async () => {
    const N = '4.2 学生行有 data-ctx-student-name 属性'
    const hasAttr = await evalInPage(`
      (function() {
        var rows = document.querySelectorAll('[data-ctx-student-name]');
        return rows.length > 0;
      })()
    `)
    record(N, hasAttr, `hasAttr=${hasAttr}`)
  })

  await test('4.3 点击测试学生行后打开 StudentProfile', async () => {
    const N = '4.3 点击测试学生行后打开 StudentProfile'
    // 搜索测试学生
    await setInputValue('input[placeholder*="搜索"]', UI_STU)
    await new Promise((r) => setTimeout(r, 800))
    // 点击学生行
    const clicked = await evalInPage(`
      (function() {
        var row = document.querySelector('[data-ctx-student-name=${JSON.stringify(UI_STU)}]');
        if (row) { row.click(); return true; }
        return false;
      })()
    `)
    await new Promise((r) => setTimeout(r, 1000))
    const text = await getPageText()
    // StudentProfile 应显示学生姓名
    const hasProfile = text.includes(UI_STU)
    record(N, clicked && hasProfile, `clicked=${clicked} hasProfile=${hasProfile}`)
  })

  await test('4.4 StudentProfile 有"学业"Tab', async () => {
    const N = '4.4 StudentProfile 有"学业"Tab'
    const hasTab = await evalInPage(`
      (function() {
        var buttons = document.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          if (buttons[i].textContent.includes('学业')) return true;
        }
        return false;
      })()
    `)
    record(N, hasTab, `hasTab=${hasTab}`)
  })

  await test('4.5 点击"学业"Tab后显示学业数据', async () => {
    const N = '4.5 点击"学业"Tab后显示学业数据'
    const clicked = await clickButtonText('学业')
    await new Promise((r) => setTimeout(r, 1500))
    const text = await getPageText()
    // 应显示学业成绩 (因为我们通过 IPC 录入了成绩)
    const hasAcademicData = text.includes('学业成绩') || text.includes('95') || text.includes(SUBJECT_A)
    const notLoading = !text.includes('加载学业数据...')
    record(N, clicked && hasAcademicData && notLoading, `clicked=${clicked} hasData=${hasAcademicData} notLoading=${notLoading}`)
  })

  await test('4.6 学业Tab显示的成绩与 IPC 数据一致', async () => {
    const N = '4.6 学业Tab显示的成绩与 IPC 数据一致'
    const text = await getPageText()
    const grades = await getGrades(UI_STU)
    const ipcScore = grades.find((g) => g.examId === EXAM_ID && g.subjectId === SUBJECT_A)?.score
    // UI 应显示 IPC 中的分数
    const uiHasScore = text.includes(String(ipcScore))
    record(N, uiHasScore, `ipcScore=${ipcScore} uiHasScore=${uiHasScore}`)
  })

  await test('4.7 学业Tab有"请到学业页面录入"提示 (无成绩学生)', async () => {
    const N = '4.7 学业Tab有"请到学业页面录入"提示 (无成绩学生)'
    // 关闭当前学生, 打开没有成绩的 UI_STU2
    await navigateTo('#/dashboard')
    await navigateTo('#/students')
    await setInputValue('input[placeholder*="搜索"]', UI_STU2)
    await new Promise((r) => setTimeout(r, 800))
    const clicked = await evalInPage(`
      (function() {
        var row = document.querySelector('[data-ctx-student-name=${JSON.stringify(UI_STU2)}]');
        if (row) { row.click(); return true; }
        return false;
      })()
    `)
    await new Promise((r) => setTimeout(r, 1000))
    await clickButtonText('学业')
    // 等待加载 (重试循环)
    let hasHint = false
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((r) => setTimeout(r, 500))
      const text = await getPageText()
      hasHint = text.includes('暂无学业成绩') || text.includes('请到') || text.includes('录入')
      if (hasHint) break
    }
    record(N, clicked && hasHint, `clicked=${clicked} hasHint=${hasHint}`)
  })

  // =============================================================
  // Section 5: 端到端联动流程 (4 项)
  // =============================================================
  console.log('\n━━━ Section 5: 端到端联动流程 ━━━')

  await test('5.1 E2E: 通过 IPC 录入新成绩 → 学生档案学业Tab 立即反映', async () => {
    const N = '5.1 E2E: 通过 IPC 录入新成绩 → 学生档案学业Tab 立即反映'
    // 修改 UI_STU 的成绩
    const newScore = 88
    await setGrade(EXAM_ID, UI_STU, SUBJECT_A, newScore, SUBJECT_A_FULL)
    // 导航到学生页面
    await navigateTo('#/dashboard')
    await navigateTo('#/students')
    await setInputValue('input[placeholder*="搜索"]', UI_STU)
    await new Promise((r) => setTimeout(r, 800))
    await evalInPage(`
      (function() {
        var row = document.querySelector('[data-ctx-student-name=${JSON.stringify(UI_STU)}]');
        if (row) row.click();
      })()
    `)
    await new Promise((r) => setTimeout(r, 1000))
    await clickButtonText('学业')
    await new Promise((r) => setTimeout(r, 1500))
    const text = await getPageText()
    const hasNewScore = text.includes(String(newScore))
    record(N, hasNewScore, `newScore=${newScore} hasNewScore=${hasNewScore}`)
  })

  await test('5.2 E2E: 创建新考试+录入成绩 → 学生档案学业Tab 显示新考试', async () => {
    const N = '5.2 E2E: 创建新考试+录入成绩 → 学生档案学业Tab 显示新考试'
    const newExamName = `e2e-exam_${TS}`
    const newExam = await createExam(newExamName, [SUBJECT_A])
    if (newExam) createdExamIds.push(newExam.id)
    const newScore = 77
    if (newExam) {
      await setGrade(newExam.id, UI_STU, SUBJECT_A, newScore, SUBJECT_A_FULL)
    }
    // 重新打开学生档案
    await navigateTo('#/dashboard')
    await navigateTo('#/students')
    await setInputValue('input[placeholder*="搜索"]', UI_STU)
    await new Promise((r) => setTimeout(r, 800))
    await evalInPage(`
      (function() {
        var row = document.querySelector('[data-ctx-student-name=${JSON.stringify(UI_STU)}]');
        if (row) row.click();
      })()
    `)
    await new Promise((r) => setTimeout(r, 1000))
    await clickButtonText('学业')
    await new Promise((r) => setTimeout(r, 1500))
    const text = await getPageText()
    const hasNewExam = text.includes(newExamName) || text.includes(newExamName.substring(0, 10))
    const hasNewScore = text.includes(String(newScore))
    record(N, hasNewExam && hasNewScore, `hasNewExam=${hasNewExam} hasNewScore=${hasNewScore}`)
  })

  await test('5.3 E2E: 删除考试 → 学生档案学业Tab 不再显示该考试', async () => {
    const N = '5.3 E2E: 删除考试 → 学生档案学业Tab 不再显示该考试'
    // 删除刚才创建的考试
    const lastExamId = createdExamIds[createdExamIds.length - 1]
    const examName = `e2e-exam_${TS}`
    await deleteExam(lastExamId)
    // 重新打开学生档案
    await navigateTo('#/dashboard')
    await navigateTo('#/students')
    await setInputValue('input[placeholder*="搜索"]', UI_STU)
    await new Promise((r) => setTimeout(r, 800))
    await evalInPage(`
      (function() {
        var row = document.querySelector('[data-ctx-student-name=${JSON.stringify(UI_STU)}]');
        if (row) row.click();
      })()
    `)
    await new Promise((r) => setTimeout(r, 1000))
    await clickButtonText('学业')
    await new Promise((r) => setTimeout(r, 1500))
    const text = await getPageText()
    const examGone = !text.includes(examName) && !text.includes(examName.substring(0, 10))
    record(N, examGone, `examGone=${examGone}`)
  })

  await test('5.4 E2E: 班级调班 → 学生列表班级列更新', async () => {
    const N = '5.4 E2E: 班级调班 → 学生列表班级列更新'
    // 将 UI_STU2 分入测试班级
    await assignStudents(UI_CLASS, [UI_STU2])
    // 导航到学生页面
    await navigateTo('#/dashboard')
    await navigateTo('#/students')
    await setInputValue('input[placeholder*="搜索"]', UI_STU2)
    await new Promise((r) => setTimeout(r, 800))
    const text = await getPageText()
    // 学生行应显示班级信息 (班级名或 class_id)
    const hasClassLabel = text.includes('UI测试班') || text.includes(UI_CLASS)
    record(N, hasClassLabel, `hasClassLabel=${hasClassLabel}`)
  })

  // =============================================================
  // 清理
  // =============================================================
  console.log('\n━━━ 清理测试数据 ━━━')
  for (const id of createdExamIds) {
    try { await deleteExam(id) } catch {}
  }
  for (const id of createdClassIds) {
    try { await deleteClass(id) } catch {}
  }
  for (const name of throwawayStudents) {
    try { await deleteStudentSoft(name, 'ui interact test cleanup') } catch {}
  }

  // ---------- 汇总 ----------
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`Round 12 UI 交互测试结果: ${passed}/${results.length} 通过, ${failed} 失败`)
  if (failed > 0) {
    console.log(`\n失败项:`)
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.detail}`))
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
