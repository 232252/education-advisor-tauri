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
    throw new Error(desc.substring(0, 800))
  }
  return r.result?.result?.value
}
await new Promise((r) => ws.on('open', r))

// Enable console capture
await send('Runtime.enable')
const consoleLogs = []
ws.on('message', (r) => {
  const m = JSON.parse(r.toString())
  if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Runtime.exceptionThrown') {
    consoleLogs.push(m)
  }
})

// Step 1: 直接测试 IPC — batchSetGrades
console.log('=== Step 1: 直接测试 batchSetGrades IPC ===')
const ipcTest = await evalInPage(`
  (async function() {
    const api = window.api;
    // 先创建一个测试考试
    const examRes = await api.academic.createExam({
      name: 'IPC测试_' + Date.now(),
      type: 'other',
      date: '2026-07-15',
      semester: '2025-2026-1',
      scope: '',
      subjects: ['chinese'],
    });
    if (!examRes.success) return JSON.stringify({ error: 'createExam failed: ' + JSON.stringify(examRes) });
    const examId = examRes.data.id;

    // 获取学生列表
    const stuRes = await api.eaa.listStudents();
    if (!stuRes.success) return JSON.stringify({ error: 'listStudents failed' });
    const students = stuRes.data.students.filter(s => s.status !== 'Deleted').slice(0, 3);

    // 构造成绩记录
    const records = students.map((s, i) => ({
      examId: examId,
      subjectId: 'chinese',
      studentName: s.name,
      score: 80 + i * 5,
      fullMark: 150,
      classRank: i + 1,
    }));

    // 调用 batchSetGrades
    const saveRes = await api.academic.batchSetGrades(records);
    if (!saveRes.success) {
      // 清理
      await api.academic.deleteExam(examId);
      return JSON.stringify({ error: 'batchSetGrades failed: ' + JSON.stringify(saveRes), records });
    }

    // 验证成绩已保存
    let foundGrades = 0;
    for (const s of students) {
      const gRes = await api.academic.getGrades(s.name);
      if (gRes.success && gRes.data) {
        const grades = gRes.data.filter(g => g.examId === examId);
        foundGrades += grades.length;
      }
    }

    // 清理
    await api.academic.deleteExam(examId);

    return JSON.stringify({
      success: true,
      examId,
      examName: examRes.data.name,
      recordsCount: records.length,
      foundGrades,
      studentsTested: students.map(s => s.name),
    });
  })()
`)
console.log(ipcTest)

// Step 2: 测试通过 UI 输入并保存
console.log('\n=== Step 2: 通过 UI 输入并保存 ===')

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

// 单科模式
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
          await new Promise(r => setTimeout(r, 800));
          break;
        }
      }
    }
  })()
`)

// 输入分数 (使用原生 setter)
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
        const name = row.querySelector('td')?.textContent?.trim() || '';
        const scoreInput = row.querySelectorAll('input[type="number"]')[0];
        if (scoreInput) {
          const val = String(80 + i * 5);
          nativeSetter.call(scoreInput, val);
          scoreInput.dispatchEvent(new Event('input', { bubbles: true }));
          scoreInput.dispatchEvent(new Event('change', { bubbles: true }));
          entered.push({ name, val });
        }
      }
      await new Promise(r => setTimeout(r, 500));
      return JSON.stringify({ entered: entered.length, names: entered });
    }
    return JSON.stringify({ entered: 0 });
  })()
`)
console.log('输入结果:', inputResult)

// 检查 React state 是否更新 — 通过检查 input 的 value 是否保持
const stateCheck = await evalInPage(`
  (function() {
    const tables = document.querySelectorAll('table');
    for (const t of tables) {
      const inputs = t.querySelectorAll('input[type="number"]');
      if (inputs.length > 0) {
        const vals = [];
        for (let i = 0; i < Math.min(6, inputs.length); i++) {
          vals.push({ idx: i, value: inputs[i].value });
        }
        return JSON.stringify(vals);
      }
    }
    return '[]';
  })()
`)
console.log('输入后 input values:', stateCheck)

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

// 记录保存前的考试数
const beforeExams = await evalInPage(`
  (async function() {
    const res = await window.api.academic.listExams();
    return JSON.stringify({ count: res.success ? res.data.length : -1, names: res.success ? res.data.map(e => e.name).slice(-5) : [] });
  })()
`)
console.log('保存前考试数:', beforeExams)

// 点击保存并捕获所有 console 输出
consoleLogs.length = 0  // 清空之前的日志
const saveResult = await evalInPage(`
  (async function() {
    const btns = Array.from(document.querySelectorAll('button'));
    const saveBtn = btns.find(b => b.textContent.includes('保存成绩'));
    if (!saveBtn) return JSON.stringify({ error: 'no save btn' });
    if (saveBtn.disabled) return JSON.stringify({ error: 'save btn disabled' });

    // 监听 toast
    const toastTexts = [];
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
            const text = node.textContent || '';
            if (text.length > 0 && text.length < 200) {
              toastTexts.push(text.trim().substring(0, 100));
            }
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    saveBtn.click();

    // 等待 5 秒,让保存完成
    await new Promise(r => setTimeout(r, 5000));

    observer.disconnect();

    // 检查结果
    const body = document.body.textContent;
    return JSON.stringify({
      clicked: true,
      toastTexts,
      bodyHasSaved: body.includes('已保存'),
      bodyHasError: body.includes('失败') || body.includes('错误'),
      bodyHasNoGrades: body.includes('没有可保存'),
    });
  })()
`)
console.log('保存结果:', saveResult)
console.log('Console logs during save:', consoleLogs.length)
for (const log of consoleLogs.slice(0, 20)) {
  if (log.method === 'Runtime.consoleAPICalled') {
    const args = log.params.args?.map(a => a.value || a.description || '').join(' ') || ''
    console.log(`  [console.${log.params.type}] ${args.substring(0, 200)}`)
  } else if (log.method === 'Runtime.exceptionThrown') {
    const desc = log.params.exceptionDetails?.exception?.description || log.params.exceptionDetails?.text || ''
    console.log(`  [exception] ${desc.substring(0, 300)}`)
  }
}

// 检查保存后的考试
const afterExams = await evalInPage(`
  (async function() {
    const res = await window.api.academic.listExams();
    if (!res.success) return JSON.stringify({ error: 'listExams failed' });
    const newExams = res.data.filter(e => e.name.includes('快速录入')).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return JSON.stringify({
      count: res.data.length,
      recentQuickExams: newExams.slice(0, 3).map(e => ({ name: e.name, id: e.id, createdAt: e.createdAt })),
    });
  })()
`)
console.log('保存后考试:', afterExams)

ws.close()
