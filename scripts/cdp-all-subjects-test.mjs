// 全科录入模式测试 — 验证全科模式也能直接录入(不强制选考试)
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
    throw new Error(desc.substring(0, 500))
  }
  return r.result?.result?.value
}
await new Promise((r) => ws.on('open', r))

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

// 导航到学业页面
await evalInPage(`(async function() { location.hash = '#/academics'; await new Promise(r => setTimeout(r, 1500)); })()`)

// 切换到成绩录入 tab
await evalInPage(`
  (async function() {
    const btns = Array.from(document.querySelectorAll('button'));
    const entryBtn = btns.find(b => b.textContent.includes('成绩录入'));
    if (entryBtn) { entryBtn.click(); await new Promise(r => setTimeout(r, 800)); }
  })()
`)

// 测试 1: 切换到全科模式
try {
  await evalInPage(`
    (async function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const allBtn = btns.find(b => b.textContent.includes('全科录入'));
      if (allBtn) allBtn.click();
      await new Promise(r => setTimeout(r, 500));
    })()
  `)
  const hasStudentSelector = await evalInPage(`
    (function() {
      const text = document.body.textContent;
      return text.includes('请先选择学生') || text.includes('全科成绩录入');
    })()
  `)
  record('全科模式切换成功', hasStudentSelector)
} catch (e) { record('全科模式切换成功', false, e.message) }

// 测试 2: 全科模式 — 选择学生
try {
  await evalInPage(`
    (async function() {
      // 在全科模式下,需要先选择一个学生
      // 查找学生选择器(可能是 select 或按钮列表)
      const selects = Array.from(document.querySelectorAll('select'));
      let found = false;
      for (const s of selects) {
        const opts = Array.from(s.options).map(o => o.textContent);
        // 学生选择器: 选项包含学生名(常见学生、Bulk等)
        if (opts.some(t => t.includes('常见学生') || t.includes('Bulk') || t.includes('选择学生'))) {
          if (s.options.length > 1) {
            s.selectedIndex = 1;
            s.dispatchEvent(new Event('change', { bubbles: true }));
            found = true;
            await new Promise(r => setTimeout(r, 800));
            break;
          }
        }
      }
      // 如果没有 select,尝试点击学生列表中的按钮
      if (!found) {
        const btns = Array.from(document.querySelectorAll('button'));
        const stuBtn = btns.find(b => b.textContent.includes('常见学生001') || b.textContent.includes('Bulk_Limit'));
        if (stuBtn) { stuBtn.click(); await new Promise(r => setTimeout(r, 800)); found = true; }
      }
      return found;
    })()
  `)
  const hasTable = await evalInPage(`
    (function() {
      const tables = document.querySelectorAll('table');
      for (const t of tables) {
        const headers = Array.from(t.querySelectorAll('th')).map(h => h.textContent);
        if (headers.some(h => h.includes('科目') || h.includes('成绩'))) return true;
      }
      return false;
    })()
  `)
  record('全科模式选学生后显示科目表', hasTable)
} catch (e) { record('全科模式选学生后显示科目表', false, e.message) }

// 测试 3: 全科模式 — 输入分数
let enteredSubjects = []
try {
  const inputResult = await evalInPage(`
    (async function() {
      const tables = document.querySelectorAll('table');
      for (const t of tables) {
        const rows = t.querySelectorAll('tbody tr');
        if (rows.length === 0) continue;
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        const entered = [];
        for (let i = 0; i < Math.min(3, rows.length); i++) {
          const row = rows[i];
          const subjectCell = row.querySelector('td')?.textContent?.trim() || '';
          const scoreInput = row.querySelectorAll('input[type="number"]')[0];
          if (scoreInput) {
            const val = String(75 + i * 10);
            nativeSetter.call(scoreInput, val);
            scoreInput.dispatchEvent(new Event('input', { bubbles: true }));
            scoreInput.dispatchEvent(new Event('change', { bubbles: true }));
            entered.push({ subject: subjectCell, val });
          }
        }
        await new Promise(r => setTimeout(r, 500));
        return JSON.stringify({ entered: entered.length, subjects: entered });
      }
      return JSON.stringify({ entered: 0 });
    })()
  `)
  const parsed = JSON.parse(inputResult)
  enteredSubjects = parsed.subjects || []
  record('全科模式输入分数', parsed.entered > 0, `输入了 ${parsed.entered} 个科目分数`)
} catch (e) { record('全科模式输入分数', false, e.message) }

// 测试 4: 全科模式 — 不选考试直接保存
try {
  // 确保考试未选
  await evalInPage(`
    (async function() {
      const selects = Array.from(document.querySelectorAll('select'));
      for (const s of selects) {
        const opts = Array.from(s.options).map(o => o.textContent);
        if (opts.some(t => t.includes('不选') || t.includes('直接录入'))) {
          s.selectedIndex = 0;
          s.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(r => setTimeout(r, 300));
          break;
        }
      }
    })()
  `)

  // 点击保存
  const saveResult = await evalInPage(`
    (async function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const saveBtn = btns.find(b => b.textContent.includes('保存成绩'));
      if (!saveBtn) return JSON.stringify({ error: 'no save btn' });
      if (saveBtn.disabled) return JSON.stringify({ error: 'save btn disabled' });

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
      await new Promise(r => setTimeout(r, 5000));
      observer.disconnect();

      const allToastText = toastTexts.join(' | ');
      const hasSuccess = allToastText.includes('已保存') || allToastText.includes('已自动创建');
      const hasError = allToastText.includes('失败') || allToastText.includes('错误') || allToastText.includes('没有可保存');
      return JSON.stringify({ clicked: true, hasSuccess, hasError, toastTexts: allToastText.substring(0, 300) });
    })()
  `)
  const parsed = JSON.parse(saveResult)
  record('全科模式保存(自动创建考试)', !parsed.error && parsed.hasSuccess && !parsed.hasError, parsed.error || `success=${parsed.hasSuccess} toast="${parsed.toastTexts}"`)
} catch (e) { record('全科模式保存(自动创建考试)', false, e.message) }

// 测试 5: 验证全科成绩已保存
try {
  const verifyResult = await evalInPage(`
    (async function() {
      const api = window.api;
      // 获取最近的快速录入考试
      const examRes = await api.academic.listExams();
      if (!examRes.success || !examRes.data) return JSON.stringify({ error: 'no exams' });
      const recentExams = examRes.data
        .filter(e => e.name.includes('快速录入'))
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      if (recentExams.length === 0) return JSON.stringify({ error: 'no recent 快速录入 exam' });

      const examId = recentExams[0].id;
      const examName = recentExams[0].name;

      // 获取学生列表,检查前5个学生是否有该考试的成绩
      const stuRes = await api.eaa.listStudents();
      if (!stuRes.success || !stuRes.data?.students) return JSON.stringify({ error: 'no students' });
      const students = stuRes.data.students.filter(s => s.status !== 'Deleted').slice(0, 10);

      let foundGrades = 0;
      let studentWithGrades = null;
      for (const s of students) {
        const gRes = await api.academic.getGrades(s.name);
        if (gRes.success && gRes.data) {
          const grades = gRes.data.filter(g => g.examId === examId);
          if (grades.length > 0) {
            foundGrades += grades.length;
            if (!studentWithGrades) studentWithGrades = s.name;
          }
        }
      }

      // 清理
      await api.academic.deleteExam(examId);

      return JSON.stringify({ examName, foundGrades, studentWithGrades, cleaned: true });
    })()
  `)
  const parsed = JSON.parse(verifyResult)
  if (parsed.error) {
    record('验证全科成绩已保存', false, parsed.error)
  } else {
    record('验证全科成绩已保存', parsed.foundGrades > 0, `exam=${parsed.examName} grades=${parsed.foundGrades} student=${parsed.studentWithGrades}`)
  }
} catch (e) { record('验证全科成绩已保存', false, e.message) }

// 测试 6: 切换回单科模式正常
try {
  await evalInPage(`
    (async function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const singleBtn = btns.find(b => b.textContent.includes('单科录入'));
      if (singleBtn) singleBtn.click();
      await new Promise(r => setTimeout(r, 500));
    })()
  `)
  const hasSubjectSelect = await evalInPage(`
    (function() {
      const selects = Array.from(document.querySelectorAll('select'));
      return selects.some(s => {
        const opts = Array.from(s.options).map(o => o.textContent);
        return opts.some(t => t.includes('语文') || t.includes('数学') || t.includes('请选择科目'));
      });
    })()
  `)
  record('切换回单科模式正常', hasSubjectSelect)
} catch (e) { record('切换回单科模式正常', false, e.message) }

// 测试 7: 无错误
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
console.log('\n========== 全科录入模式测试 ==========')
const pass = results.filter(r => r.ok).length
console.log(`总计: ${results.length}, 通过: ${pass}, 失败: ${results.length - pass}`)
if (pass < results.length) {
  console.log('\n失败项:')
  results.filter(r => !r.ok).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`))
}

ws.close()
process.exit(pass === results.length ? 0 : 1)
