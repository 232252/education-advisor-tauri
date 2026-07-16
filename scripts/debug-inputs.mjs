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

// 检查输入情况
const debug = await evalInPage(`
  (function() {
    const tables = document.querySelectorAll('table');
    const info = [];
    for (let ti = 0; ti < tables.length; ti++) {
      const t = tables[ti];
      const allInputs = t.querySelectorAll('input[type="number"]');
      if (allInputs.length === 0) continue;
      const rows = t.querySelectorAll('tbody tr');
      info.push({
        tableIndex: ti,
        inputCount: allInputs.length,
        rowCount: rows.length,
        firstRowName: rows[0]?.querySelector('td')?.textContent || '',
        firstInputType: allInputs[0]?.type,
        firstInputValue: allInputs[0]?.value,
      });
      // 取前 3 个 input 的详情
      for (let i = 0; i < Math.min(6, allInputs.length); i++) {
        info.push({
          inputIdx: i,
          type: allInputs[i].type,
          value: allInputs[i].value,
          placeholder: allInputs[i].placeholder,
          parent: allInputs[i].parentElement?.tagName,
        });
      }
      break;
    }
    return JSON.stringify(info, null, 2);
  })()
`)
console.log('Before input:')
console.log(debug)

// 尝试输入分数
const inputResult = await evalInPage(`
  (async function() {
    const tables = document.querySelectorAll('table');
    for (const t of tables) {
      const allInputs = t.querySelectorAll('input[type="number"]');
      if (allInputs.length > 0) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        let entered = 0;
        const enteredNames = [];
        const rows = t.querySelectorAll('tbody tr');
        for (let i = 0; i < Math.min(3, rows.length); i++) {
          const row = rows[i];
          const name = row.querySelector('td')?.textContent || '';
          const scoreInput = row.querySelectorAll('input[type="number"]')[0];
          if (scoreInput) {
            const val = String(80 + i * 5);
            nativeSetter.call(scoreInput, val);
            scoreInput.dispatchEvent(new Event('input', { bubbles: true }));
            scoreInput.dispatchEvent(new Event('change', { bubbles: true }));
            entered++;
            enteredNames.push({ name, val, afterValue: scoreInput.value });
          }
        }
        await new Promise(r => setTimeout(r, 800));
        return JSON.stringify({ entered, enteredNames, finalFirstValue: allInputs[0].value });
      }
    }
    return JSON.stringify({ entered: 0 });
  })()
`)
console.log('\nDuring input:')
console.log(inputResult)

// 检查输入后状态
const after = await evalInPage(`
  (function() {
    const tables = document.querySelectorAll('table');
    for (const t of tables) {
      const allInputs = t.querySelectorAll('input[type="number"]');
      if (allInputs.length > 0) {
        const vals = [];
        for (let i = 0; i < Math.min(6, allInputs.length); i++) {
          vals.push({ idx: i, value: allInputs[i].value });
        }
        return JSON.stringify(vals);
      }
    }
    return '[]';
  })()
`)
console.log('\nAfter input (first 6 inputs):')
console.log(after)

// 检查保存按钮状态
const saveBtnInfo = await evalInPage(`
  (function() {
    const btns = Array.from(document.querySelectorAll('button'));
    const saveBtn = btns.find(b => b.textContent.includes('保存成绩'));
    if (!saveBtn) return JSON.stringify({ found: false });
    return JSON.stringify({
      found: true,
      text: saveBtn.textContent.trim(),
      disabled: saveBtn.disabled,
      className: saveBtn.className.substring(0, 100),
    });
  })()
`)
console.log('\nSave button:')
console.log(saveBtnInfo)

ws.close()
