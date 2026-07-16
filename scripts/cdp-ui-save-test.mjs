// UI 级成绩保存流程测试 — 在浏览器中操作真实 UI 元素
import http from 'node:http'
import WebSocket from 'ws'

const get = (u) => new Promise((r, j) => {
  http.get(u, (res) => {
    let d = ''
    res.on('data', (c) => (d += c))
    res.on('end', () => r(JSON.parse(d)))
  }).on('error', j)
})

const targets = (await get('http://127.0.0.1:9222/json')).filter((x) => x.type === 'page')
const target = targets[0]
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 1
const p = new Map()
ws.on('message', (r) => {
  const m = JSON.parse(r.toString())
  if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) }
})
const send = (method, params = {}) => new Promise((r) => {
  const i = id++; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params }))
})
const evalInPage = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) {
    const desc = r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'unknown'
    throw new Error(desc.substring(0, 300))
  }
  return r.result?.result?.value
}
await new Promise((r) => ws.on('open', r))

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

// 导航到学业页面 → 成绩录入 tab
await evalInPage(`(async function() { location.hash = '#/academics'; await new Promise(r => setTimeout(r, 1500)); })()`)

await evalInPage(`
  (async function() {
    const btns = Array.from(document.querySelectorAll('button'));
    const entryBtn = btns.find(b => b.textContent.includes('成绩录入'));
    if (entryBtn) { entryBtn.click(); await new Promise(r => setTimeout(r, 800)); }
  })()
`)

// 测试 1: 单科录入模式 — 选择科目后显示成绩表
try {
  // 确保在单科模式
  await evalInPage(`
    (async function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const singleBtn = btns.find(b => b.textContent.includes('单科录入'));
      if (singleBtn) singleBtn.click();
      await new Promise(r => setTimeout(r, 300));
    })()
  `)

  // 选择科目
  await evalInPage(`
    (async function() {
      const selects = Array.from(document.querySelectorAll('select'));
      for (const s of selects) {
        const opts = Array.from(s.options).map(o => o.textContent);
        if (opts.some(t => t.includes('语文') || t.includes('数学') || t.includes('请选择科目'))) {
          if (s.options.length > 1) {
            s.selectedIndex = 1;
            s.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(r => setTimeout(r, 600));
            break;
          }
        }
      }
    })()
  `)

  const hasTable = await evalInPage(`
    (function() {
      const tables = document.querySelectorAll('table');
      return tables.length > 0 && Array.from(tables).some(t => {
        const headers = Array.from(t.querySelectorAll('th')).map(h => h.textContent);
        return headers.some(h => h.includes('成绩') || h.includes('分数'));
      });
    })()
  `)
  record('单科模式: 选科目后显示成绩表', hasTable)
} catch (e) { record('单科模式: 选科目后显示成绩表', false, e.message) }

// 测试 2: 成绩表有学生行
try {
  const rowCount = await evalInPage(`
    (function() {
      const tables = document.querySelectorAll('table');
      for (const t of tables) {
        const rows = t.querySelectorAll('tbody tr');
        if (rows.length > 0) return rows.length;
      }
      return 0;
    })()
  `)
  record('成绩表有学生行', rowCount > 0, `${rowCount} 行`)
} catch (e) { record('成绩表有学生行', false, e.message) }

// 测试 3: 在成绩输入框中输入分数 (每行有2个input: score, rank)
try {
  const inputResult = await evalInPage(`
    (async function() {
      const tables = document.querySelectorAll('table');
      for (const t of tables) {
        const allInputs = t.querySelectorAll('input[type="number"]');
        if (allInputs.length > 0) {
          // React 需要使用原生 setter 才能触发 onChange
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          // 每行有2个input: [score, rank], 所以成绩在 0, 2, 4... 索引
          let entered = 0;
          for (let i = 0; i < Math.min(6, allInputs.length); i += 2) {
            nativeSetter.call(allInputs[i], String(80 + entered * 5));
            allInputs[i].dispatchEvent(new Event('input', { bubbles: true }));
            allInputs[i].dispatchEvent(new Event('change', { bubbles: true }));
            entered++;
          }
          await new Promise(r => setTimeout(r, 500));
          return entered;
        }
      }
      return 0;
    })()
  `)
  record('在成绩输入框中输入分数', inputResult > 0, `输入了 ${inputResult} 个分数`)
} catch (e) { record('在成绩输入框中输入分数', false, e.message) }

// 测试 4: 点击保存按钮 (不选考试 → 自动创建)
let savedExamId = null
let savedStudentNames = []
try {
  // 确保考试未选(选择"— 不选,直接录入 —")
  await evalInPage(`
    (async function() {
      const selects = Array.from(document.querySelectorAll('select'));
      for (const s of selects) {
        const opts = Array.from(s.options).map(o => o.textContent);
        if (opts.some(t => t.includes('不选') || t.includes('直接录入'))) {
          s.selectedIndex = 0; // 第一个选项是"不选"
          s.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(r => setTimeout(r, 300));
          break;
        }
      }
    })()
  `)

  // 记录哪些学生被输入了分数 (从 DOM 读取)
  const enteredInfo = await evalInPage(`
    (function() {
      const tables = document.querySelectorAll('table');
      for (const t of tables) {
        const rows = t.querySelectorAll('tbody tr');
        const names = [];
        for (const row of rows) {
          const inputs = row.querySelectorAll('input[type="number"]');
          if (inputs.length > 0 && inputs[0].value && inputs[0].value !== '') {
            const name = row.querySelector('td')?.textContent?.trim() || '';
            if (name) names.push(name);
          }
        }
        return JSON.stringify(names);
      }
      return '[]';
    })()
  `)
  savedStudentNames = JSON.parse(enteredInfo)

  // 点击保存 — 用 MutationObserver 捕获 toast
  const saveResult = await evalInPage(`
    (async function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const saveBtn = btns.find(b => b.textContent.includes('保存成绩'));
      if (!saveBtn) return JSON.stringify({ error: 'no save btn' });
      if (saveBtn.disabled) return JSON.stringify({ error: 'save btn disabled' });

      // 用 MutationObserver 捕获所有新增的 toast 节点文本
      const toastTexts = [];
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) {
              const text = node.textContent || '';
              if (text.length > 0 && text.length < 300) {
                toastTexts.push(text.trim().substring(0, 200));
              }
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      saveBtn.click();
      // 等待保存完成(可能需要自动创建考试 + 保存成绩)
      await new Promise(r => setTimeout(r, 5000));

      observer.disconnect();

      const allToastText = toastTexts.join(' | ');
      const hasSuccess = allToastText.includes('已保存') || allToastText.includes('已自动创建');
      const hasError = allToastText.includes('失败') || allToastText.includes('错误');
      return JSON.stringify({ clicked: true, hasSuccess, hasError, toastTexts: allToastText.substring(0, 300) });
    })()
  `)
  const parsed = JSON.parse(saveResult)
  record('点击保存按钮(自动创建考试)', !parsed.error && parsed.hasSuccess && !parsed.hasError, parsed.error || `success=${parsed.hasSuccess} toast="${parsed.toastTexts}"`)
} catch (e) { record('点击保存按钮(自动创建考试)', false, e.message) }

// 测试 5: 验证保存后成绩存在 — 检查实际被输入分数的学生
try {
  const studentNamesJson = JSON.stringify(savedStudentNames)
  const verifyResult = await evalInPage(`
    (async function() {
      const api = window.api;
      const studentNames = ${studentNamesJson};

      // 获取最近的"快速录入"考试
      const examRes = await api.academic.listExams();
      if (!examRes.success || !examRes.data) return JSON.stringify({ error: 'no exams' });
      const recentExams = examRes.data
        .filter(e => e.name.includes('快速录入'))
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      if (recentExams.length === 0) return JSON.stringify({ error: 'no recent 快速录入 exam' });

      const examId = recentExams[0].id;
      const examName = recentExams[0].name;

      // 检查被输入分数的学生是否有成绩
      let foundGrades = 0;
      const checkedStudents = [];
      for (const name of studentNames) {
        const gRes = await api.academic.getGrades(name);
        if (gRes.success && gRes.data) {
          const grades = gRes.data.filter(g => g.examId === examId);
          foundGrades += grades.length;
          checkedStudents.push({ name, gradeCount: grades.length });
        } else {
          checkedStudents.push({ name, gradeCount: 0, error: true });
        }
      }

      // 清理: 删除测试考试 (级联删除成绩)
      await api.academic.deleteExam(examId);

      return JSON.stringify({ examName, examId, foundGrades, checkedStudents, cleaned: true });
    })()
  `)
  const parsed = JSON.parse(verifyResult)
  if (parsed.error) {
    record('验证保存后成绩存在', false, parsed.error)
  } else {
    record('验证保存后成绩存在', parsed.foundGrades > 0, `exam=${parsed.examName} grades=${parsed.foundGrades} students=${parsed.checkedStudents.length}`)
  }
} catch (e) { record('验证保存后成绩存在', false, e.message) }

// 测试 6: 考试管理 tab — 切换并显示
try {
  await evalInPage(`
    (async function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const examBtn = btns.find(b => b.textContent.includes('考试管理'));
      if (examBtn) { examBtn.click(); await new Promise(r => setTimeout(r, 800)); }
    })()
  `)
  const hasContent = await evalInPage(`
    (function() {
      const main = document.querySelector('main');
      return main && main.textContent.length > 100;
    })()
  `)
  record('考试管理tab可切换显示', hasContent)
} catch (e) { record('考试管理tab可切换显示', false, e.message) }

// 测试 7: 成绩总览 tab — 切换并显示
try {
  await evalInPage(`
    (async function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const overviewBtn = btns.find(b => b.textContent.includes('成绩总览'));
      if (overviewBtn) { overviewBtn.click(); await new Promise(r => setTimeout(r, 800)); }
    })()
  `)
  const hasContent = await evalInPage(`
    (function() {
      const main = document.querySelector('main');
      return main && main.textContent.length > 100;
    })()
  `)
  record('成绩总览tab可切换显示', hasContent)
} catch (e) { record('成绩总览tab可切换显示', false, e.message) }

// 测试 8: 三个 tab 可循环切换
try {
  let allSwitchable = true
  for (const tabName of ['成绩总览', '考试管理', '成绩录入']) {
    await evalInPage(`
      (async function() {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent.includes('${tabName}'));
        if (btn) { btn.click(); await new Promise(r => setTimeout(r, 500)); }
      })()
    `)
    const hasContent = await evalInPage(`
      (function() {
        const main = document.querySelector('main');
        return main && main.textContent.length > 50;
      })()
    `)
    if (!hasContent) allSwitchable = false
  }
  record('三个tab可循环切换', allSwitchable)
} catch (e) { record('三个tab可循环切换', false, e.message) }

// 测试 9: 无控制台错误
try {
  const noErrors = await evalInPage(`
    (function() {
      const errorElements = document.querySelectorAll('[class*="error"], [class*="Error"]');
      const visibleErrors = Array.from(errorElements).filter(e => e.offsetParent !== null && e.textContent.trim().length > 0);
      return visibleErrors.length === 0;
    })()
  `)
  record('无可见错误提示', noErrors)
} catch (e) { record('无可见错误提示', false, e.message) }

// 总结
console.log('\n========== UI 级成绩保存流程测试 ==========')
const pass = results.filter(r => r.ok).length
console.log(`总计: ${results.length}, 通过: ${pass}, 失败: ${results.length - pass}`)
if (pass < results.length) {
  console.log('\n失败项:')
  results.filter(r => !r.ok).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`))
}

ws.close()
process.exit(pass === results.length ? 0 : 1)
