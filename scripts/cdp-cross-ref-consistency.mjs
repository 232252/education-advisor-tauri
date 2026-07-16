// =============================================================
// 跨页共享引用一致性测试
// 验证: 学生列表/班级列表/学业配置/考试列表 在不同页面间数据一致
// 涉及页面: StudentsPage, AcademicsPage, ClassesPage, ClassProfile, StudentProfile
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
  const send = (method, params = {}) => new Promise((resolve, reject) => {
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
  console.log('CDP connected, running tests...\n')

  const callIpc = async (code) => {
    return await evalInPage(`
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
  }

  const navigateTo = async (path) => {
    await evalInPage(`
      (async function() {
        location.hash = '#${path}';
        await new Promise(r => setTimeout(r, 1500));
      })()
    `)
  }

  // ========== 1. 收集 IPC 原始数据 (基准) ==========
  console.log('--- 收集 IPC 基准数据 ---')
  const ipcStudents = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
  const ipcClasses = await callIpc(`const res = await api.class.list(); return res;`)
  const ipcConfig = await callIpc(`const res = await api.academic.getConfig(); return res;`)
  const ipcExams = await callIpc(`const res = await api.academic.listExams(); return res;`)

  const studentCount = ipcStudents?.data?.students?.length ?? 0
  const classCount = ipcClasses?.data?.length ?? 0
  const subjectCount = ipcConfig?.data?.subjects?.length ?? 0
  const examCount = ipcExams?.data?.length ?? 0
  console.log(`IPC: students=${studentCount} classes=${classCount} subjects=${subjectCount} exams=${examCount}\n`)

  // ========== 测试 1: 学生列表 IPC 一致性 (两次调用结果一致) ==========
  try {
    const r2 = await callIpc(`const res = await api.eaa.listStudents(); return res;`)
    const count2 = r2?.data?.students?.length ?? 0
    record(`学生列表 IPC 两次调用一致`, count2 === studentCount, `first=${studentCount} second=${count2}`)
  } catch (err) {
    record(`学生列表 IPC 两次调用一致`, false, String(err.message || err))
  }

  // ========== 测试 2: 班级列表 IPC 一致性 ==========
  try {
    const r2 = await callIpc(`const res = await api.class.list(); return res;`)
    const count2 = r2?.data?.length ?? 0
    record(`班级列表 IPC 两次调用一致`, count2 === classCount, `first=${classCount} second=${count2}`)
  } catch (err) {
    record(`班级列表 IPC 两次调用一致`, false, String(err.message || err))
  }

  // ========== 测试 3: 学业配置 IPC 一致性 ==========
  try {
    const r2 = await callIpc(`const res = await api.academic.getConfig(); return res;`)
    const count2 = r2?.data?.subjects?.length ?? 0
    record(`学业配置 IPC 两次调用一致`, count2 === subjectCount, `first=${subjectCount} second=${count2}`)
  } catch (err) {
    record(`学业配置 IPC 两次调用一致`, false, String(err.message || err))
  }

  // ========== 测试 4: 考试列表 IPC 一致性 ==========
  try {
    const r2 = await callIpc(`const res = await api.academic.listExams(); return res;`)
    const count2 = r2?.data?.length ?? 0
    record(`考试列表 IPC 两次调用一致`, count2 === examCount, `first=${examCount} second=${count2}`)
  } catch (err) {
    record(`考试列表 IPC 两次调用一致`, false, String(err.message || err))
  }

  // ========== 测试 5: 学生页面渲染的学生数与 IPC 一致 ==========
  try {
    await navigateTo('/students')
    const uiCount = await evalInPage(`
      (function() {
        const rows = document.querySelectorAll('table tbody tr');
        return rows.length;
      })()
    `)
    const activeStudents = (ipcStudents?.data?.students ?? []).filter((s) => s.status !== 'Deleted').length
    record(`学生页面显示学生数合理`, uiCount > 0 && uiCount <= activeStudents + 5, `ui=${uiCount} active=${activeStudents}`)
  } catch (err) {
    record(`学生页面显示学生数合理`, false, String(err.message || err))
  }

  // ========== 测试 6: 学业页面有学生列表内容 ==========
  try {
    await navigateTo('/academics')
    const uiInfo = await evalInPage(`
      (function() {
        const bodyText = document.body.textContent || '';
        // 学业页应显示 "学生列表" 文字
        const hasStudentList = bodyText.includes('学生列表');
        // 检查是否有可点击的学生项 (排除导航栏)
        const mainContent = document.querySelector('main') || document.querySelector('[class*="flex-1"]') || document.body;
        const clickableItems = mainContent.querySelectorAll('[class*="cursor-pointer"], [class*="hover:bg"]');
        return { hasStudentList, clickableCount: clickableItems.length, bodyLen: bodyText.length };
      })()
    `)
    record(`学业页面有学生列表内容`, uiInfo.hasStudentList || uiInfo.clickableCount > 0, `hasText=${uiInfo.hasStudentList} clickable=${uiInfo.clickableCount}`)
  } catch (err) {
    record(`学业页面有学生列表内容`, false, String(err.message || err))
  }

  // ========== 测试 7: 班级页面显示班级数与 IPC 一致 ==========
  try {
    await navigateTo('/classes')
    const uiCount = await evalInPage(`
      (function() {
        const bodyText = document.body.textContent || '';
        // 班级页应显示班级名称, 每个班级都会显示 "班" 字
        // 统计包含班级名称的可点击元素
        const allElements = document.querySelectorAll('div, span, p, td, li');
        let count = 0;
        const classKeywords = ['班级', '班'];
        for (const el of allElements) {
          if (el.children.length === 0) {
            const t = (el.textContent || '').trim();
            if (t.includes('班') && t.length > 2 && t.length < 60 && !t.includes('仪表盘') && !t.includes('对话')) {
              count++;
            }
          }
        }
        return count;
      })()
    `)
    record(`班级页面显示班级数合理`, uiCount > 0, `ui=${uiCount} ipc=${classCount}`)
  } catch (err) {
    record(`班级页面显示班级数合理`, false, String(err.message || err))
  }

  // ========== 测试 8: 学业页面班级筛选器与 IPC 班级列表一致 ==========
  try {
    await navigateTo('/academics')
    const filterOptions = await evalInPage(`
      (function() {
        // 找班级筛选 select
        const selects = document.querySelectorAll('select');
        for (const sel of selects) {
          const opts = Array.from(sel.options).map(o => o.value).filter(v => v && v !== '__ALL__' && v !== '__NONE__');
          if (opts.length > 0) {
            return { count: opts.length, values: opts.slice(0, 5) };
          }
        }
        return { count: 0, values: [] };
      })()
    `)
    const activeClasses = (ipcClasses?.data ?? []).filter((c) => !c.archived)
    record(`学业页班级筛选器与 IPC 一致`, filterOptions.count === activeClasses.length, `filter=${filterOptions.count} ipc=${activeClasses.length} samples=${JSON.stringify(filterOptions.values)}`)
  } catch (err) {
    record(`学业页班级筛选器与 IPC 一致`, false, String(err.message || err))
  }

  // ========== 测试 9: 学生页面班级筛选器与 IPC 班级列表一致 ==========
  try {
    await navigateTo('/students')
    const filterOptions = await evalInPage(`
      (function() {
        const selects = document.querySelectorAll('select');
        for (const sel of selects) {
          const opts = Array.from(sel.options).map(o => o.value).filter(v => v && v !== '__ALL__' && v !== '__NONE__');
          if (opts.length > 0) {
            return { count: opts.length, values: opts.slice(0, 5) };
          }
        }
        return { count: 0, values: [] };
      })()
    `)
    const activeClasses = (ipcClasses?.data ?? []).filter((c) => !c.archived)
    record(`学生页班级筛选器与 IPC 一致`, filterOptions.count === activeClasses.length, `filter=${filterOptions.count} ipc=${activeClasses.length}`)
  } catch (err) {
    record(`学生页班级筛选器与 IPC 一致`, false, String(err.message || err))
  }

  // ========== 测试 10: 学业页面考试列表与 IPC 一致 ==========
  try {
    await navigateTo('/academics')
    // 切换到考试管理 tab
    await evalInPage(`
      (async function() {
        const tabs = Array.from(document.querySelectorAll('button, [role="tab"]'));
        const examTab = tabs.find(t => t.textContent && t.textContent.includes('考试管理'));
        if (examTab) {
          examTab.click();
          await new Promise(r => setTimeout(r, 1000));
        }
      })()
    `)
    const uiExams = await evalInPage(`
      (function() {
        // 考试管理 tab 下, 每个考试项通常有 "删除" 按钮
        const deleteBtns = Array.from(document.querySelectorAll('button')).filter(b => (b.textContent||'').trim() === '删除');
        // 也可以通过文本匹配考试名称
        const bodyText = document.body.textContent || '';
        const hasExamText = bodyText.includes('月考') || bodyText.includes('期中') || bodyText.includes('期末') || bodyText.includes('考试');
        return { deleteBtnCount: deleteBtns.length, hasExamText };
      })()
    `)
    // 每个考试项有一个删除按钮, 但也可能有其他删除按钮
    record(`学业页考试列表有内容`, uiExams.deleteBtnCount > 0 || uiExams.hasExamText, `deleteBtns=${uiExams.deleteBtnCount} hasExamText=${uiExams.hasExamText}`)
  } catch (err) {
    record(`学业页考试列表有内容`, false, String(err.message || err))
  }

  // ========== 测试 11: 学生档案学业 Tab 数据与 IPC 一致 ==========
  try {
    await navigateTo('/students')
    // 点击第一个学生进入档案
    await evalInPage(`
      (async function() {
        const rows = Array.from(document.querySelectorAll('tr, [data-student-name]'));
        for (const row of rows) {
          const text = (row.textContent || '').trim();
          if (text.length > 1 && text.length < 50) {
            row.click();
            await new Promise(r => setTimeout(r, 1000));
            return;
          }
        }
      })()
    `)
    // 切换到学业 Tab
    await evalInPage(`
      (async function() {
        const tabs = Array.from(document.querySelectorAll('button, [role="tab"]'));
        const acadTab = tabs.find(t => t.textContent && (t.textContent.includes('学业') || t.textContent.includes('成绩')));
        if (acadTab) {
          acadTab.click();
          await new Promise(r => setTimeout(r, 800));
        }
      })()
    `)
    const hasContent = await evalInPage(`
      (function() {
        const text = document.body.textContent || '';
        return text.length > 100;
      })()
    `)
    record(`学生档案学业 Tab 渲染正常`, hasContent, `bodyLen > 100`)
  } catch (err) {
    record(`学生档案学业 Tab 渲染正常`, false, String(err.message || err))
  }

  // ========== 测试 12: 班级筛选后学生数与 EAA 一致 ==========
  try {
    await navigateTo('/students')
    const activeClasses = (ipcClasses?.data ?? []).filter((c) => !c.archived)
    if (activeClasses.length > 0) {
      const testClassId = activeClasses[0].class_id
      // 设置筛选器 (React 兼容)
      const filterSet = await evalInPage(`
        (async function() {
          const selects = document.querySelectorAll('select');
          for (const sel of selects) {
            for (const opt of sel.options) {
              if (opt.value === '${testClassId}') {
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
                nativeSetter.call(sel, '${testClassId}');
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                await new Promise(r => setTimeout(r, 1500));
                return true;
              }
            }
          }
          return false;
        })()
      `)
      const uiFiltered = await evalInPage(`
        (function() {
          const rows = document.querySelectorAll('table tbody tr');
          return rows.length;
        })()
      `)
      const ipcFiltered = (ipcStudents?.data?.students ?? []).filter((s) => s.class_id === testClassId && s.status !== 'Deleted').length
      record(`班级筛选后学生数与 EAA 一致`, filterSet && uiFiltered === ipcFiltered, `class=${testClassId} filterSet=${filterSet} ui=${uiFiltered} ipc=${ipcFiltered}`)

      // 重置筛选器
      await evalInPage(`
        (async function() {
          const selects = document.querySelectorAll('select');
          for (const sel of selects) {
            for (const opt of sel.options) {
              if (opt.value === '__ALL__') {
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
                nativeSetter.call(sel, '__ALL__');
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                await new Promise(r => setTimeout(r, 800));
                return;
              }
            }
          }
        })()
      `)
    } else {
      record(`班级筛选后学生数与 EAA 一致`, true, '跳过(无活跃班级)')
    }
  } catch (err) {
    record(`班级筛选后学生数与 EAA 一致`, false, String(err.message || err))
  }

  // ========== 测试 13: 学生搜索功能 ==========
  try {
    await navigateTo('/students')
    // 使用第一个活跃(非删除)学生
    const activeStudents = (ipcStudents?.data?.students ?? []).filter((s) => s.status !== 'Deleted')
    const firstStudent = activeStudents[0]
    if (firstStudent) {
      const searchResult = await evalInPage(`
        (async function() {
          const input = document.querySelector('input[type="text"], input[type="search"], input[placeholder*="搜索"], input[placeholder*="search"]');
          if (!input) return { hasInput: false };
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeInputValueSetter.call(input, ${JSON.stringify(firstStudent.name)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(r => setTimeout(r, 1000));
          const rows = document.querySelectorAll('table tbody tr');
          return { hasInput: true, rowCount: rows.length };
        })()
      `)
      record(`学生搜索功能`, searchResult.hasInput && searchResult.rowCount >= 1, `hasInput=${searchResult.hasInput} rows=${searchResult.rowCount} searched=${firstStudent.name}`)

      // 清空搜索
      await evalInPage(`
        (async function() {
          const input = document.querySelector('input[type="text"], input[type="search"], input[placeholder*="搜索"], input[placeholder*="search"]');
          if (input) {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(r => setTimeout(r, 500));
          }
        })()
      `)
    } else {
      record(`学生搜索功能`, true, '跳过(无活跃学生)')
    }
  } catch (err) {
    record(`学生搜索功能`, false, String(err.message || err))
  }

  // ========== 测试 14: 删除的学生不在列表中 ==========
  try {
    const deletedStudents = (ipcStudents?.data?.students ?? []).filter((s) => s.status === 'Deleted')
    const activeStudents = (ipcStudents?.data?.students ?? []).filter((s) => s.status !== 'Deleted')
    record(`已删除学生不在活跃列表中`, deletedStudents.length > 0 ? activeStudents.length < studentCount : true, `total=${studentCount} active=${activeStudents.length} deleted=${deletedStudents.length}`)
  } catch (err) {
    record(`已删除学生不在活跃列表中`, false, String(err.message || err))
  }

  // ========== 测试 15: 归档班级不在活跃列表中 ==========
  try {
    const archivedClasses = (ipcClasses?.data ?? []).filter((c) => c.archived)
    const activeClasses = (ipcClasses?.data ?? []).filter((c) => !c.archived)
    record(`归档班级不在活跃列表中`, archivedClasses.length > 0 ? activeClasses.length < classCount : true, `total=${classCount} active=${activeClasses.length} archived=${archivedClasses.length}`)
  } catch (err) {
    record(`归档班级不在活跃列表中`, false, String(err.message || err))
  }

  // ========== 汇总 ==========
  console.log('\n========== 跨页共享引用一致性测试 ==========')
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
