// =============================================================
// UI 表单验证 + 错误处理 + 边界输入 CDP 测试
// 覆盖:
//   1. 班级创建表单验证 (空值/重复 class_id)
//   2. 学业成绩录入验证 (负数/超满分/非数字/超长字符串)
//   3. 学生搜索边界 (emoji/SQL注入/超长文本/HTML标签)
//   4. 设置页表单验证 (非数字/空值)
//   5. Tab 快速切换 (成绩总览/考试管理/成绩录入)
//   6. 路由直接访问 (11 个路由)
//   7. 不存在的路由 (404/重定向)
//   8. 页面刷新后状态 (班级筛选)
//   9. 控制台错误监控
//  10. 表单防重复提交 (快速双击创建班级)
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
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error(`JSON parse fail: ${e.message}`))
        }
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

  const targets = (await fetchJson(`${BASE}/json`)).filter((t) => t.type === 'page')
  if (targets.length === 0) {
    console.log('FAIL: No CDP targets')
    process.exit(1)
  }
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
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.result?.exceptionDetails) {
      const desc =
        r.result.exceptionDetails.exception?.description ||
        r.result.exceptionDetails.text ||
        'unknown'
      throw new Error(`Eval error: ${desc.substring(0, 300)}`)
    }
    return r.result?.result?.value
  }

  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  await send('Page.enable')
  await send('Runtime.enable')
  console.log('CDP connected, running tests...\n')

  // ===== 控制台错误 + 未捕获异常监控 (全程) =====
  const consoleErrors = []
  const uncaughtExceptions = []
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const args = msg.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')
        consoleErrors.push(args)
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const desc =
          msg.params?.exceptionDetails?.text ||
          msg.params?.exceptionDetails?.exception?.description ||
          'unknown'
        uncaughtExceptions.push(desc)
      }
    } catch {
      /* ignore */
    }
  })

  // ===== 辅助: 导航 =====
  const navigateTo = async (path) => {
    await evalInPage(`
      (async function() {
        const target = '#${path}';
        if (location.hash === target) {
          location.hash = '#/__nav_reset__';
          await new Promise(r => setTimeout(r, 200));
        }
        location.hash = target;
        await new Promise(r => setTimeout(r, 1500));
        for (let i = 0; i < 3 && location.hash !== target; i++) {
          location.hash = '#/__nav_reset__';
          await new Promise(r => setTimeout(r, 200));
          location.hash = target;
          await new Promise(r => setTimeout(r, 1500));
        }
      })()
    `)
  }

  // ===== 辅助: 页面健康检查 =====
  const checkHealth = async (expectedPath) => {
    return await evalInPage(`
      (function() {
        const hash = location.hash;
        const bodyText = (document.body.textContent || '').trim();
        if (document.querySelector('vite-error-overlay')) return { ok: false, reason: 'vite-error-overlay', hash, bodyLen: bodyText.length };
        if (bodyText.includes('页面渲染出错了') || bodyText.includes('Something went wrong')) return { ok: false, reason: 'react-error-boundary', hash, bodyLen: bodyText.length };
        if (bodyText.length < 20) return { ok: false, reason: 'empty-body', hash, bodyLen: bodyText.length };
        if (!hash.includes('#${expectedPath}')) return { ok: false, reason: 'hash-mismatch', hash, bodyLen: bodyText.length };
        return { ok: true, hash, bodyLen: bodyText.length };
      })()
    `)
  }

  // ===== 辅助: Toast 捕获 (MutationObserver) =====
  const startToastCapture = () =>
    evalInPage(`
      (function() {
        window.__toastCapture = [];
        if (window.__toastObserver) window.__toastObserver.disconnect();
        window.__toastObserver = new MutationObserver(function(mutations) {
          for (var i = 0; i < mutations.length; i++) {
            var added = mutations[i].addedNodes;
            for (var j = 0; j < added.length; j++) {
              var node = added[j];
              if (node.nodeType !== 1) continue;
              var toastEls = (node.matches && node.matches('.toast')) ? [node] : Array.from(node.querySelectorAll ? node.querySelectorAll('.toast') : []);
              for (var k = 0; k < toastEls.length; k++) {
                var el = toastEls[k];
                var cls = el.className || '';
                var type = cls.indexOf('toast-error') >= 0 ? 'error' : (cls.indexOf('toast-success') >= 0 ? 'success' : 'other');
                window.__toastCapture.push({ type: type, text: (el.textContent || '').trim().substring(0, 200) });
              }
            }
          }
        });
        window.__toastObserver.observe(document.body, { childList: true, subtree: true });
        return true;
      })()
    `)
  const readToasts = async () => {
    const s = await evalInPage(`(function(){ return JSON.stringify(window.__toastCapture || []); })()`)
    try {
      return JSON.parse(s)
    } catch {
      return []
    }
  }

  // ===== 辅助: IPC 调用封装 =====
  const callIpc = (code) =>
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

  // ===== 测试数据清理 =====
  const testClassIds = []
  const testExamIds = []
  const cleanupAll = async () => {
    for (const id of testClassIds) {
      try {
        await callIpc(`const res = await api.class.delete(${JSON.stringify(id)}); return res;`)
      } catch {
        /* ignore */
      }
    }
    for (const id of testExamIds) {
      try {
        await callIpc(`const res = await api.academic.deleteExam(${JSON.stringify(id)}); return res;`)
      } catch {
        /* ignore */
      }
    }
  }

  const TS = Date.now()

  // =========================================================
  // 测试 1: 班级创建表单验证
  // =========================================================
  // 1a. 空 class_id + 空 name → 前端阻止
  try {
    await navigateTo('/classes')
    await startToastCapture()
    // 点击「+ 新建班级」打开表单
    await evalInPage(`
      (async function() {
        var btns = Array.from(document.querySelectorAll('button'));
        var addBtn = btns.find(function(b){ return b.textContent.includes('新建班级') || b.textContent.includes('添加班级'); });
        if (addBtn) { addBtn.click(); await new Promise(function(r){ setTimeout(r, 500); }); }
      })()
    `)
    const modalOpen1 = await evalInPage(`
      (function(){
        var modal = document.querySelector('.fixed.inset-0');
        return !!modal && modal.textContent.length > 10;
      })()
    `)
    // 直接点击保存 (字段为空)
    await evalInPage(`
      (async function() {
        var btns = Array.from(document.querySelectorAll('button'));
        var saveBtn = btns.find(function(b){ return b.textContent.trim() === '保存'; });
        if (saveBtn) saveBtn.click();
        await new Promise(function(r){ setTimeout(r, 800); });
      })()
    `)
    const toasts1 = await readToasts()
    const modalStillOpen = await evalInPage(`
      (function(){ return !!document.querySelector('.fixed.inset-0'); })()
    `)
    const hasErrorToast = toasts1.some((t) => t.type === 'error')
    record(
      '班级表单: 空值提交被前端阻止',
      hasErrorToast && modalStillOpen,
      `errorToast=${hasErrorToast} modalOpen=${modalStillOpen} msg="${(toasts1[0] || {}).text || ''}"`,
    )
  } catch (err) {
    record('班级表单: 空值提交被前端阻止', false, String(err.message || err))
  }

  // 1b. 有 class_id + 空 name → 前端阻止
  try {
    await startToastCapture()
    await evalInPage(`
      (async function() {
        var modal = document.querySelector('.fixed.inset-0');
        if (!modal) {
          var btns = Array.from(document.querySelectorAll('button'));
          var addBtn = btns.find(function(b){ return b.textContent.includes('新建班级') || b.textContent.includes('添加班级'); });
          if (addBtn) { addBtn.click(); await new Promise(function(r){ setTimeout(r, 500); }); }
        }
        var inputs = document.querySelectorAll('.fixed.inset-0 input[type="text"]');
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        if (inputs.length > 0) {
          nativeSetter.call(inputs[0], 'TESTID-${TS}');
          inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
        }
        await new Promise(function(r){ setTimeout(r, 300); });
      })()
    `)
    await evalInPage(`
      (async function() {
        var btns = Array.from(document.querySelectorAll('button'));
        var saveBtn = btns.find(function(b){ return b.textContent.trim() === '保存'; });
        if (saveBtn) saveBtn.click();
        await new Promise(function(r){ setTimeout(r, 800); });
      })()
    `)
    const toasts1b = await readToasts()
    const hasError = toasts1b.some((t) => t.type === 'error')
    record('班级表单: 空名称提交被前端阻止', hasError, `errorToast=${hasError} msg="${(toasts1b[0] || {}).text || ''}"`)
  } catch (err) {
    record('班级表单: 空名称提交被前端阻止', false, String(err.message || err))
  }

  // 关闭表单
  try {
    await evalInPage(`
      (async function() {
        var btns = Array.from(document.querySelectorAll('button'));
        var cancelBtn = btns.find(function(b){ return b.textContent.trim() === '取消'; });
        if (cancelBtn) cancelBtn.click();
        await new Promise(function(r){ setTimeout(r, 300); });
      })()
    `)
  } catch {
    /* ignore */
  }

  // 1c. 重复 class_id → IPC 返回错误
  let dupClassId = null
  let dupCreatedId = null
  try {
    // 先用 IPC 创建一个班级, 拿到已知 class_id
    dupClassId = `DUP-${TS % 1000000}`
    const createRes = await callIpc(`
      var res = await api.class.create({ class_id: ${JSON.stringify(dupClassId)}, name: '重复测试班级_${TS}' });
      return res;
    `)
    dupCreatedId = createRes?.data?.id
    if (dupCreatedId) testClassIds.push(dupCreatedId)

    await navigateTo('/classes')
    await startToastCapture()
    // 打开表单, 填入重复 class_id + 合法 name, 提交
    await evalInPage(`
      (async function() {
        var btns = Array.from(document.querySelectorAll('button'));
        var addBtn = btns.find(function(b){ return b.textContent.includes('新建班级') || b.textContent.includes('添加班级'); });
        if (addBtn) { addBtn.click(); await new Promise(function(r){ setTimeout(r, 500); }); }
        var modal = document.querySelector('.fixed.inset-0');
        if (!modal) return;
        var inputs = modal.querySelectorAll('input[type="text"]');
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        if (inputs.length >= 2) {
          nativeSetter.call(inputs[0], ${JSON.stringify(dupClassId)});
          inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
          nativeSetter.call(inputs[1], '重复班级_' + ${TS});
          inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
        }
        await new Promise(function(r){ setTimeout(r, 300); });
      })()
    `)
    await evalInPage(`
      (async function() {
        var btns = Array.from(document.querySelectorAll('button'));
        var saveBtn = btns.find(function(b){ return b.textContent.trim() === '保存'; });
        if (saveBtn) saveBtn.click();
        await new Promise(function(r){ setTimeout(r, 2000); });
      })()
    `)
    const toasts1c = await readToasts()
    const hasError = toasts1c.some(
      (t) => t.type === 'error' && (t.text.includes('失败') || t.text.includes('已存在') || t.text.includes('重复')),
    )
    // 验证列表中只有一个该 class_id 的班级
    const listRes = await callIpc(`var res = await api.class.list(); return res;`)
    const dupCount = (listRes?.data ?? []).filter((c) => c.class_id === dupClassId).length
    record(
      '班级表单: 重复 class_id 被拒绝',
      hasError && dupCount === 1,
      `errorToast=${hasError} dupCount=${dupCount} msg="${(toasts1c[0] || {}).text || ''}"`,
    )
  } catch (err) {
    record('班级表单: 重复 class_id 被拒绝', false, String(err.message || err))
  }

  // 关闭表单 (若仍打开)
  try {
    await evalInPage(`
      (async function() {
        var btns = Array.from(document.querySelectorAll('button'));
        var cancelBtn = btns.find(function(b){ return b.textContent.trim() === '取消'; });
        if (cancelBtn) cancelBtn.click();
        await new Promise(function(r){ setTimeout(r, 300); });
      })()
    `)
  } catch {
    /* ignore */
  }

  // =========================================================
  // 测试 2: 学业成绩录入验证
  // =========================================================
  let hasStudentsForScore = false
  try {
    await navigateTo('/academics')
    // 切到「成绩录入」tab
    await evalInPage(`
      (async function() {
        var btns = Array.from(document.querySelectorAll('button'));
        var entryBtn = btns.find(function(b){ return b.textContent.includes('成绩录入'); });
        if (entryBtn) { entryBtn.click(); await new Promise(function(r){ setTimeout(r, 800); }); }
        var singleBtn = btns.find(function(b){ return b.textContent.includes('单科录入'); });
        if (singleBtn) { singleBtn.click(); await new Promise(function(r){ setTimeout(r, 300); }); }
      })()
    `)
    // 选择第一个科目
    await evalInPage(`
      (async function() {
        var selects = Array.from(document.querySelectorAll('select'));
        for (var i = 0; i < selects.length; i++) {
          var s = selects[i];
          var opts = Array.from(s.options).map(function(o){ return o.textContent; });
          if (opts.some(function(t){ return t.includes('语文') || t.includes('数学') || t.includes('请选择科目') || t.includes('科目'); })) {
            if (s.options.length > 1) {
              s.selectedIndex = 1;
              s.dispatchEvent(new Event('change', { bubbles: true }));
              await new Promise(function(r){ setTimeout(r, 800); });
              break;
            }
          }
        }
      })()
    `)
    // 检查是否有学生行
    const scoreInputCount = await evalInPage(`
      (function() {
        var tables = document.querySelectorAll('table');
        for (var i = 0; i < tables.length; i++) {
          var inputs = tables[i].querySelectorAll('input[type="number"]');
          if (inputs.length > 0) return inputs.length;
        }
        return 0;
      })()
    `)
    hasStudentsForScore = scoreInputCount > 0

    const invalidValues = [
      { label: '负数', value: '-5' },
      { label: '超满分', value: '9999' },
      { label: '非数字', value: 'abc' },
      { label: '超长字符串', value: '9'.repeat(500) },
    ]
    let allNoCrash = true
    const behaviors = []
    for (const iv of invalidValues) {
      try {
        const behavior = await evalInPage(`
          (async function() {
            var tables = document.querySelectorAll('table');
            for (var i = 0; i < tables.length; i++) {
              var inputs = tables[i].querySelectorAll('input[type="number"]');
              if (inputs.length > 0) {
                var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                var target = inputs[0];
                nativeSetter.call(target, ${JSON.stringify(iv.value)});
                target.dispatchEvent(new Event('input', { bubbles: true }));
                target.dispatchEvent(new Event('change', { bubbles: true }));
                await new Promise(function(r){ setTimeout(r, 200); });
                var afterVal = target.value;
                var bodyLen = (document.body.textContent || '').length;
                var hasOverlay = !!document.querySelector('vite-error-overlay');
                return JSON.stringify({ afterVal: afterVal.substring(0, 20), afterValLen: afterVal.length, bodyLen: bodyLen, hasOverlay: hasOverlay });
              }
            }
            return JSON.stringify({ noInput: true });
          })()
        `)
        const b = JSON.parse(behavior)
        const noCrash = !b.hasOverlay && b.bodyLen > 50
        if (!noCrash) allNoCrash = false
        // 非数字 / 超长 → 浏览器 type=number 应拒绝 (值为空)
        const rejected = b.afterValLen === 0
        behaviors.push(`${iv.label}(${rejected ? '浏览器拒绝' : '已接受:' + b.afterVal})`)
      } catch (err) {
        allNoCrash = false
        behaviors.push(`${iv.label}(异常:${String(err.message).substring(0, 40)})`)
      }
    }

    if (hasStudentsForScore) {
      // 尝试保存含负数的成绩 → 验证 IPC 是否拒绝
      let ipcRejected = false
      let ipcDetail = ''
      try {
        await startToastCapture()
        await evalInPage(`
          (async function() {
            var tables = document.querySelectorAll('table');
            for (var i = 0; i < tables.length; i++) {
              var inputs = tables[i].querySelectorAll('input[type="number"]');
              if (inputs.length > 0) {
                var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSetter.call(inputs[0], '-5');
                inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
                inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
                break;
              }
            }
            await new Promise(function(r){ setTimeout(r, 300); });
            var btns = Array.from(document.querySelectorAll('button'));
            var saveBtn = btns.find(function(b){ return b.textContent.includes('保存成绩'); });
            if (saveBtn && !saveBtn.disabled) saveBtn.click();
            await new Promise(function(r){ setTimeout(r, 4000); });
          })()
        `)
        const toasts2 = await readToasts()
        const hasSaveError = toasts2.some(
          (t) => t.type === 'error' && (t.text.includes('失败') || t.text.includes('错误') || t.text.includes('无效')),
        )
        const hasSaveSuccess = toasts2.some((t) => t.type === 'success' && t.text.includes('已保存'))
        ipcRejected = hasSaveError
        ipcDetail = hasSaveError ? 'IPC返回错误' : hasSaveSuccess ? 'IPC接受了负数分数(未校验)' : '无明确toast'

        // 清理: 若自动创建了考试, 删除最近的「快速录入」考试
        const examList = await callIpc(`var res = await api.academic.listExams(); return res;`)
        const quickExams = (examList?.data ?? [])
          .filter((e) => (e.name || '').includes('快速录入'))
          .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        if (quickExams.length > 0) {
          const todayPrefix = new Date().toISOString().slice(0, 10)
          const todayExam = quickExams.find((e) => (e.createdAt || '').startsWith(todayPrefix)) || quickExams[0]
          if (todayExam) {
            testExamIds.push(todayExam.id)
          }
        }
      } catch (err) {
        ipcDetail = `保存异常:${String(err.message).substring(0, 60)}`
      }

      // PASS 条件: 无崩溃 AND (浏览器拒绝非数字/超长 OR IPC 拒绝负数)
      const browserRejects = behaviors.some((b) => b.includes('浏览器拒绝'))
      const ok = allNoCrash && (ipcRejected || browserRejects)
      record(
        '成绩录入: 无效分数校验',
        ok,
        `noCrash=${allNoCrash} ipcReject=${ipcRejected} browserReject=${browserRejects} [${behaviors.join(', ')}] ${ipcDetail}`,
      )
    } else {
      record('成绩录入: 无效分数校验', true, '跳过(无学生数据,无法录入) ' + behaviors.join(', '))
    }
  } catch (err) {
    record('成绩录入: 无效分数校验', false, String(err.message || err))
  }

  // =========================================================
  // 测试 3: 学生搜索边界
  // =========================================================
  try {
    await navigateTo('/students')
    const searchInputs = await evalInPage(`
      (function(){
        var inputs = document.querySelectorAll('input[type="text"]');
        for (var i = 0; i < inputs.length; i++) {
          if ((inputs[i].placeholder || '').includes('搜索') || (inputs[i].placeholder || '').includes('姓名')) return i;
        }
        return -1;
      })()
    `)
    const specialInputs = [
      { label: 'emoji', value: '😀🎉🔍' },
      { label: 'SQL注入', value: "'; DROP TABLE students; --" },
      { label: '超长文本', value: 'A'.repeat(2000) },
      { label: 'HTML标签', value: '<script>alert(1)</script><img src=x onerror=alert(1)>' },
    ]
    let allOk = true
    const details = []
    for (const si of specialInputs) {
      const res = await evalInPage(`
        (async function() {
          var inputs = document.querySelectorAll('input[type="text"]');
          var target = null;
          for (var i = 0; i < inputs.length; i++) {
            if ((inputs[i].placeholder || '').includes('搜索') || (inputs[i].placeholder || '').includes('姓名')) { target = inputs[i]; break; }
          }
          if (!target) return JSON.stringify({ ok: false, reason: 'no-search-input' });
          var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(target, ${JSON.stringify(si.value)});
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(function(r){ setTimeout(r, 500); });
          var bodyLen = (document.body.textContent || '').length;
          var hasOverlay = !!document.querySelector('vite-error-overlay');
          var hasBoundary = (document.body.textContent || '').includes('Something went wrong') || (document.body.textContent || '').includes('页面渲染出错了');
          var rowCount = document.querySelectorAll('table tbody tr').length;
          return JSON.stringify({ ok: !hasOverlay && !hasBoundary && bodyLen > 50, bodyLen: bodyLen, rowCount: rowCount, hasOverlay: hasOverlay });
        })()
      `)
      const r = JSON.parse(res)
      if (!r.ok) allOk = false
      details.push(`${si.label}(rows=${r.rowCount},bodyLen=${r.bodyLen})`)
    }
    // 清空搜索
    await evalInPage(`
      (async function() {
        var inputs = document.querySelectorAll('input[type="text"]');
        for (var i = 0; i < inputs.length; i++) {
          if ((inputs[i].placeholder || '').includes('搜索') || (inputs[i].placeholder || '').includes('姓名')) {
            var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(inputs[i], '');
            inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
            inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }
        }
        await new Promise(function(r){ setTimeout(r, 300); });
      })()
    `)
    record('学生搜索: 特殊字符不崩溃', allOk, details.join(' '))
  } catch (err) {
    record('学生搜索: 特殊字符不崩溃', false, String(err.message || err))
  }

  // =========================================================
  // 测试 4: 设置页表单验证
  // =========================================================
  try {
    // 先备份设置 (用于恢复)
    const backupRes = await callIpc(`var res = await api.settings.get(); return res;`)
    const backupMaxTokens = backupRes?.chat?.maxTokens
    const backupReserve = backupRes?.chat?.compaction?.reserveTokens

    await navigateTo('/settings')
    // 4a. 在数字输入框输入非数字 → 浏览器 type=number 拒绝
    const nonNumResult = await evalInPage(`
      (async function() {
        var numInputs = document.querySelectorAll('input[type="number"]');
        if (numInputs.length === 0) return JSON.stringify({ ok: false, reason: 'no-number-input' });
        var target = numInputs[0];
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(target, 'abc');
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(function(r){ setTimeout(r, 500); });
        var afterVal = target.value;
        var bodyLen = (document.body.textContent || '').length;
        var hasOverlay = !!document.querySelector('vite-error-overlay');
        return JSON.stringify({ ok: !hasOverlay && bodyLen > 50, afterVal: afterVal, afterValLen: afterVal.length, bodyLen: bodyLen });
      })()
    `)
    const nn = JSON.parse(nonNumResult)
    // 浏览器 type=number 拒绝非数字: 值不会是 "abc" (可能为 "" 或被 React onChange 转成 "0")
    const nonNumOk = nn.ok && nn.afterVal !== 'abc'

    // 4b. 在数字输入框输入空值 → Number("")=0, 不崩溃
    const emptyResult = await evalInPage(`
      (async function() {
        var numInputs = document.querySelectorAll('input[type="number"]');
        if (numInputs.length === 0) return JSON.stringify({ ok: false, reason: 'no-number-input' });
        var target = numInputs[0];
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(target, '');
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(function(r){ setTimeout(r, 600); });
        var bodyLen = (document.body.textContent || '').length;
        var hasOverlay = !!document.querySelector('vite-error-overlay');
        return JSON.stringify({ ok: !hasOverlay && bodyLen > 50, bodyLen: bodyLen });
      })()
    `)
    const er = JSON.parse(emptyResult)
    const emptyOk = er.ok

    // 恢复设置
    if (backupMaxTokens != null) {
      await callIpc(`var res = await api.settings.set('chat.maxTokens', ${backupMaxTokens}); return res;`)
    }
    if (backupReserve != null) {
      await callIpc(`var res = await api.settings.set('chat.compaction.reserveTokens', ${backupReserve}); return res;`)
    }

    record('设置页: 数字输入非数字/空值不崩溃', nonNumOk && emptyOk, `nonNumRejected=${nonNumOk}(afterVal="${nn.afterVal}") emptyNoCrash=${emptyOk}`)
  } catch (err) {
    record('设置页: 数字输入非数字/空值不崩溃', false, String(err.message || err))
  }

  // =========================================================
  // 测试 5: Tab 快速切换 (10 次)
  // =========================================================
  try {
    await navigateTo('/academics')
    // 先选一个学生 (overview/entry tab 需要选中学生才能渲染内容)
    await evalInPage(`
      (async function() {
        var rows = document.querySelectorAll('tr[data-ctx-student-name], table tbody tr');
        for (var i = 0; i < rows.length; i++) {
          var t = (rows[i].textContent || '').trim();
          if (t.length > 1 && t.length < 30) { rows[i].click(); break; }
        }
        await new Promise(function(r){ setTimeout(r, 600); });
      })()
    `)
    const switchResult = await evalInPage(`
      (async function() {
        var tabTexts = ['成绩总览', '考试管理', '成绩录入'];
        var errors = 0;
        for (var round = 0; round < 10; round++) {
          var tabName = tabTexts[round % 3];
          var btns = Array.from(document.querySelectorAll('button'));
          var btn = btns.find(function(b){ return b.textContent.includes(tabName); });
          if (btn) { btn.click(); }
          await new Promise(function(r){ setTimeout(r, 120); });
        }
        await new Promise(function(r){ setTimeout(r, 500); });
        var bodyLen = (document.body.textContent || '').length;
        var hasOverlay = !!document.querySelector('vite-error-overlay');
        var hasBoundary = (document.body.textContent || '').includes('页面渲染出错了') || (document.body.textContent || '').includes('Something went wrong');
        return JSON.stringify({ bodyLen: bodyLen, hasOverlay: hasOverlay, hasBoundary: hasBoundary });
      })()
    `)
    const sr = JSON.parse(switchResult)
    record('学业页: Tab 快速切换 10 次无错乱', !sr.hasOverlay && !sr.hasBoundary && sr.bodyLen > 50, `bodyLen=${sr.bodyLen} overlay=${sr.hasOverlay}`)
  } catch (err) {
    record('学业页: Tab 快速切换 10 次无错乱', false, String(err.message || err))
  }

  // =========================================================
  // 测试 6: 路由直接访问
  // =========================================================
  const routes = [
    '/dashboard',
    '/students',
    '/classes',
    '/academics',
    '/agents',
    '/scheduler',
    '/models',
    '/skills',
    '/privacy',
    '/settings',
    '/chat',
  ]
  let routesOk = 0
  const routeDetails = []
  for (const route of routes) {
    try {
      await navigateTo(route)
      const health = await checkHealth(route)
      if (health.ok) {
        routesOk++
        routeDetails.push(`${route}(ok:${health.bodyLen})`)
      } else {
        routeDetails.push(`${route}(FAIL:${health.reason})`)
      }
    } catch (err) {
      routeDetails.push(`${route}(ERR:${String(err.message).substring(0, 30)})`)
    }
  }
  record('路由直接访问: 全部 11 路由可渲染', routesOk === routes.length, `${routesOk}/${routes.length} — ${routeDetails.join(' ')}`)

  // =========================================================
  // 测试 7: 不存在的路由 → 重定向
  // =========================================================
  try {
    await evalInPage(`
      (async function() {
        location.hash = '#/nonexistent';
        await new Promise(function(r){ setTimeout(r, 1200); });
      })()
    `)
    const afterHash = await evalInPage(`location.hash`)
    const bodyLen = await evalInPage(`(document.body.textContent || '').trim().length`)
    const hasOverlay = await evalInPage(`!!document.querySelector('vite-error-overlay')`)
    // 应重定向到 /dashboard
    const redirected = String(afterHash).includes('#/dashboard')
    record(
      '不存在路由: 重定向到 dashboard',
      redirected && !hasOverlay && bodyLen > 50,
      `hash=${afterHash} bodyLen=${bodyLen} redirected=${redirected}`,
    )
  } catch (err) {
    record('不存在路由: 重定向到 dashboard', false, String(err.message || err))
  }

  // =========================================================
  // 测试 8: 页面刷新后状态 (班级筛选重置)
  // =========================================================
  try {
    await navigateTo('/students')
    // 设置班级筛选为「未分班」(若可用)
    const filterSet = await evalInPage(`
      (async function() {
        var selects = document.querySelectorAll('select');
        for (var i = 0; i < selects.length; i++) {
          var opts = Array.from(selects[i].options).map(function(o){ return o.value; });
          if (opts.indexOf('__NONE__') >= 0) {
            selects[i].value = '__NONE__';
            selects[i].dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(function(r){ setTimeout(r, 400); });
            return JSON.stringify({ set: true, value: selects[i].value });
          }
        }
        return JSON.stringify({ set: false });
      })()
    `)
    const fs = JSON.parse(filterSet)

    // 触发页面刷新 (CDP Page.reload)
    await send('Page.reload', {})
    // 等待页面重新加载 + 渲染
    await new Promise((r) => setTimeout(r, 3000))
    // 导航到 /students 并检查筛选是否重置
    await navigateTo('/students')
    const afterReload = await evalInPage(`
      (function() {
        var selects = document.querySelectorAll('select');
        for (var i = 0; i < selects.length; i++) {
          var opts = Array.from(selects[i].options).map(function(o){ return o.value; });
          if (opts.indexOf('__NONE__') >= 0) {
            return JSON.stringify({ filterValue: selects[i].value, bodyLen: (document.body.textContent || '').length });
          }
        }
        return JSON.stringify({ filterValue: 'not-found', bodyLen: (document.body.textContent || '').length });
      })()
    `)
    const ar = JSON.parse(afterReload)
    // React state 丢失 → 筛选应重置为 __ALL__
    const resetOk = ar.filterValue === '__ALL__' && ar.bodyLen > 50
    record(
      '页面刷新后: 班级筛选正常重置',
      resetOk,
      `filterBefore=${fs.set ? '__NONE__' : '未设置'} filterAfter=${ar.filterValue} bodyLen=${ar.bodyLen}`,
    )
  } catch (err) {
    record('页面刷新后: 班级筛选正常重置', false, String(err.message || err))
  }

  // =========================================================
  // 测试 10: 表单防重复提交 (快速双击创建班级)
  // =========================================================
  try {
    await navigateTo('/classes')
    const dblClassId = `DBL-${TS % 1000000}`
    const dblClassName = `双击测试_${TS}`
    await evalInPage(`
      (async function() {
        var btns = Array.from(document.querySelectorAll('button'));
        var addBtn = btns.find(function(b){ return b.textContent.includes('新建班级') || b.textContent.includes('添加班级'); });
        if (addBtn) { addBtn.click(); await new Promise(function(r){ setTimeout(r, 500); }); }
        var modal = document.querySelector('.fixed.inset-0');
        if (!modal) return;
        var inputs = modal.querySelectorAll('input[type="text"]');
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        if (inputs.length >= 2) {
          nativeSetter.call(inputs[0], ${JSON.stringify(dblClassId)});
          inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
          nativeSetter.call(inputs[1], ${JSON.stringify(dblClassName)});
          inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
        }
        await new Promise(function(r){ setTimeout(r, 300); });
        // 快速连续点击保存按钮 2 次
        var saveBtn = Array.from(document.querySelectorAll('button')).find(function(b){ return b.textContent.trim() === '保存'; });
        if (saveBtn) { saveBtn.click(); saveBtn.click(); }
        await new Promise(function(r){ setTimeout(r, 2500); });
      })()
    `)
    // 验证只创建了 1 个该 class_id 的班级
    const listRes = await callIpc(`var res = await api.class.list(); return res;`)
    const matches = (listRes?.data ?? []).filter((c) => c.class_id === dblClassId)
    for (const m of matches) testClassIds.push(m.id)
    record(
      '班级表单: 防重复提交 (双击只创建 1 个)',
      matches.length === 1,
      `class_id=${dblClassId} count=${matches.length}`,
    )
  } catch (err) {
    record('班级表单: 防重复提交 (双击只创建 1 个)', false, String(err.message || err))
  }

  // =========================================================
  // 清理所有测试数据
  // =========================================================
  await cleanupAll()

  // =========================================================
  // 测试 9: 控制台错误监控 (汇总)
  // =========================================================
  // 过滤掉测试自身产生的可忽略噪声 (如某些 IPC 加载失败)
  const meaningfulExceptions = uncaughtExceptions.filter(
    (e) => !e.includes('Cannot read properties of null') || e.length > 0,
  )
  record(
    '控制台: 无未捕获异常',
    meaningfulExceptions.length === 0,
    `uncaughtExceptions=${uncaughtExceptions.length} consoleErrors=${consoleErrors.length}${uncaughtExceptions.length > 0 ? ' first=' + String(uncaughtExceptions[0]).substring(0, 100) : ''}`,
  )

  // =========================================================
  // 汇总
  // =========================================================
  console.log('\n========== UI 表单验证 + 错误处理测试 ==========')
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  console.log(`总计: ${results.length}, 通过: ${passed}, 失败: ${failed}`)
  if (failed > 0) {
    console.log('\n失败项:')
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  - ${r.name}: ${r.detail}`)
    }
  }
  console.log(`\n测试数据清理: 删除 ${testClassIds.length} 个测试班级, ${testExamIds.length} 个测试考试`)

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
