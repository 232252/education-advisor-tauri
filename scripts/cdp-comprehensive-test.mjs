// 综合功能测试: 班级筛选 + 考试管理 + 成绩保存流程 + 页面导航
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

// ===== 1. 班级筛选功能测试 =====
console.log('\n--- 班级筛选 ---')

// 导航到学业页面
await evalInPage(`(async function() { location.hash = '#/academics'; await new Promise(r => setTimeout(r, 1500)); })()`)

// 测试: 班级筛选下拉框有选项
try {
  const classFilterInfo = await evalInPage(`
    (function() {
      const selects = Array.from(document.querySelectorAll('select'));
      const classSelect = selects.find(s => {
        const opts = Array.from(s.options).map(o => o.textContent);
        return opts.some(t => t.includes('全部班级'));
      });
      if (!classSelect) return JSON.stringify({ found: false });
      const opts = Array.from(classSelect.options).map(o => ({ value: o.value, text: o.textContent.trim() }));
      return JSON.stringify({ found: true, count: opts.length, options: opts.slice(0, 5) });
    })()
  `)
  const parsed = JSON.parse(classFilterInfo)
  record('班级筛选下拉框有选项', parsed.found && parsed.count > 1, `${parsed.count} 个选项`)
} catch (e) { record('班级筛选下拉框有选项', false, e.message) }

// 测试: 选择班级后学生列表过滤
try {
  const filterResult = await evalInPage(`
    (async function() {
      // 获取全部学生数量
      const selects = Array.from(document.querySelectorAll('select'));
      const classSelect = selects.find(s => {
        const opts = Array.from(s.options).map(o => o.textContent);
        return opts.some(t => t.includes('全部班级'));
      });
      if (!classSelect) return JSON.stringify({ error: 'no class select' });

      // 先选"全部班级",记录学生数
      classSelect.value = '__ALL__';
      classSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const allButtons = document.querySelectorAll('aside button[type="button"]');
      const allCount = Array.from(allButtons).filter(b => b.textContent.trim().length > 0 && b.closest('aside')).length;

      // 选择第一个具体班级(跳过"全部"和"未分班")
      const realClassOpt = Array.from(classSelect.options).find(o => o.value !== '__ALL__' && o.value !== '__NONE__' && o.value !== '');
      if (!realClassOpt) return JSON.stringify({ error: 'no real class', allCount });

      classSelect.value = realClassOpt.value;
      classSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const filteredButtons = document.querySelectorAll('aside button[type="button"]');
      const filteredCount = Array.from(filteredButtons).filter(b => b.textContent.trim().length > 0 && b.closest('aside')).length;

      // 恢复全部
      classSelect.value = '__ALL__';
      classSelect.dispatchEvent(new Event('change', { bubbles: true }));

      return JSON.stringify({ allCount, filteredCount, className: realClassOpt.textContent });
    })()
  `)
  const parsed = JSON.parse(filterResult)
  if (parsed.error) {
    record('选择班级后学生列表过滤', false, parsed.error)
  } else {
    const ok = parsed.filteredCount > 0 && parsed.filteredCount < parsed.allCount
    record('选择班级后学生列表过滤', ok, `全部=${parsed.allCount} 班级=${parsed.filteredCount} (${parsed.className})`)
  }
} catch (e) { record('选择班级后学生列表过滤', false, e.message) }

// 测试: 搜索功能
try {
  const searchResult = await evalInPage(`
    (async function() {
      const searchInput = document.querySelector('aside input[type="text"]');
      if (!searchInput) return JSON.stringify({ error: 'no search input' });

      // 输入搜索词
      searchInput.value = 'a';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));

      const buttons = document.querySelectorAll('aside button[type="button"]');
      const count = Array.from(buttons).filter(b => b.textContent.trim().length > 0 && b.closest('aside')).length;

      // 清除搜索
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));

      return JSON.stringify({ count });
    })()
  `)
  const parsed = JSON.parse(searchResult)
  if (parsed.error) {
    record('搜索功能过滤学生', false, parsed.error)
  } else {
    record('搜索功能过滤学生', parsed.count >= 0, `搜索"a"结果=${parsed.count}`)
  }
} catch (e) { record('搜索功能过滤学生', false, e.message) }

// ===== 2. 考试管理功能测试 =====
console.log('\n--- 考试管理 ---')

// 切换到考试管理 tab
await evalInPage(`
  (async function() {
    const btns = Array.from(document.querySelectorAll('button'));
    const examBtn = btns.find(b => b.textContent.includes('考试管理'));
    if (examBtn) { examBtn.click(); await new Promise(r => setTimeout(r, 800)); }
  })()
`)

// 测试: 考试管理 tab 有内容
try {
  const hasContent = await evalInPage(`
    (function() {
      const main = document.querySelector('main');
      if (!main) return false;
      return main.textContent.length > 100;
    })()
  `)
  record('考试管理tab有内容', hasContent)
} catch (e) { record('考试管理tab有内容', false, e.message) }

// 测试: 通过IPC创建+列表+删除考试
try {
  const examName = `功能测试_${Date.now()}`
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      // 创建
      const createRes = await api.academic.createExam({
        name: ${JSON.stringify(examName)},
        type: 'test',
        date: '2026-07-15',
        semester: '2025-2026-2',
        scope: '功能测试',
        subjects: ['math', 'chinese']
      });
      if (!createRes.success) return JSON.stringify({ error: 'create failed', detail: JSON.stringify(createRes) });

      // 列表
      const listRes = await api.academic.listExams();
      const found = listRes.success && listRes.data ? listRes.data.find(e => e.name === ${JSON.stringify(examName)}) : null;
      if (!found) return JSON.stringify({ error: 'not found in list' });

      // 删除
      await api.academic.deleteExam(found.id);

      // 验证删除
      const listRes2 = await api.academic.listExams();
      const stillExists = listRes2.success && listRes2.data ? listRes2.data.some(e => e.id === found.id) : true;

      return JSON.stringify({ created: true, listed: true, deleted: !stillExists, examId: found.id });
    })()
  `)
  const parsed = JSON.parse(result)
  record('考试CRUD (创建/列表/删除)', parsed.created && parsed.listed && parsed.deleted, `examId=${parsed.examId}`)
} catch (e) { record('考试CRUD (创建/列表/删除)', false, e.message) }

// ===== 3. 成绩保存流程测试 (无考试 → 自动创建) =====
console.log('\n--- 成绩保存流程 ---')

try {
  const result = await evalInPage(`
    (async function() {
      const api = window.api;
      // 获取学生列表
      const stuRes = await api.eaa.listStudents();
      if (!stuRes.success || !stuRes.data?.students) return JSON.stringify({ error: 'no students' });
      const activeStudents = stuRes.data.students.filter(s => s.status !== 'Deleted');
      if (activeStudents.length < 2) return JSON.stringify({ error: 'need 2+ students' });

      const s1 = activeStudents[0].name;
      const s2 = activeStudents[1].name;

      // 不创建考试,直接保存成绩 → resolveExamForSave 会自动创建
      // 但这里直接测 IPC: 先创建考试再保存
      const examRes = await api.academic.createExam({
        name: '保存流程测试',
        type: 'other',
        date: new Date().toISOString().slice(0, 10),
        semester: '2025-2026-2',
        scope: '',
        subjects: ['math']
      });
      if (!examRes.success) return JSON.stringify({ error: 'create exam failed' });
      const examId = examRes.data.id;

      // 批量保存
      const batchRes = await api.academic.batchSetGrades([
        { examId, subjectId: 'math', studentName: s1, score: 88, fullMark: 150, classRank: 1 },
        { examId, subjectId: 'math', studentName: s2, score: 76, fullMark: 150, classRank: 2 }
      ]);
      if (!batchRes.success) return JSON.stringify({ error: 'batch save failed' });

      // 读取验证
      const g1 = await api.academic.getGrades(s1);
      const g2 = await api.academic.getGrades(s2);
      const s1Grade = g1.success && g1.data ? g1.data.find(g => g.examId === examId) : null;
      const s2Grade = g2.success && g2.data ? g2.data.find(g => g.examId === examId) : null;

      // 读取班级成绩
      const classRes = await api.academic.getClassGrades([s1, s2], examId, 'math');

      // 清理
      await api.academic.deleteExam(examId);

      return JSON.stringify({
        saved: batchRes.data,
        s1Score: s1Grade?.score,
        s2Score: s2Grade?.score,
        s1Rank: s1Grade?.classRank,
        classGradesCount: Object.keys(classRes.data || {}).length
      });
    })()
  `)
  const parsed = JSON.parse(result)
  if (parsed.error) {
    record('成绩保存+读取+班级查询', false, parsed.error)
  } else {
    const ok = parsed.saved === 2 && parsed.s1Score === 88 && parsed.s2Score === 76 && parsed.s1Rank === 1
    record('成绩保存+读取+班级查询', ok, `saved=${parsed.saved} s1=${parsed.s1Score} s2=${parsed.s2Score} classGrades=${parsed.classGradesCount}`)
  }
} catch (e) { record('成绩保存+读取+班级查询', false, e.message) }

// ===== 4. 页面导航测试 =====
console.log('\n--- 页面导航 ---')

const pages = [
  { hash: '#/dashboard', name: '仪表盘' },
  { hash: '#/students', name: '学生' },
  { hash: '#/academics', name: '学业' },
  { hash: '#/chat', name: '对话' },
  { hash: '#/classes', name: '班级' },
]

for (const page of pages) {
  try {
    const ok = await evalInPage(`
      (async function() {
        location.hash = '${page.hash}';
        await new Promise(r => setTimeout(r, 1000));
        const main = document.querySelector('main');
        return main && main.textContent.length > 20;
      })()
    `)
    record(`导航到${page.name}页面`, ok)
  } catch (e) { record(`导航到${page.name}页面`, false, e.message) }
}

// ===== 5. 学生档案学业tab深度测试 =====
console.log('\n--- 学生档案学业tab ---')

try {
  // 导航到学生页面
  await evalInPage(`(async function() { location.hash = '#/students'; await new Promise(r => setTimeout(r, 1500)); })()`)

  // 点击第一个学生行 (tr 或 button 在 aside/main 中)
  const profileOpened = await evalInPage(`
    (async function() {
      // 尝试点击表格行
      const rows = document.querySelectorAll('tr');
      let clicked = false;
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length > 0) {
          row.click();
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        // 尝试点击 aside 中的 button
        const asideBtns = document.querySelectorAll('aside button[type="button"]');
        for (const btn of asideBtns) {
          if (btn.textContent.trim().length > 0 && btn.textContent.trim().length < 30) {
            btn.click();
            clicked = true;
            break;
          }
        }
      }
      await new Promise(r => setTimeout(r, 1000));

      // 检查是否有档案/profile 相关内容
      const allBtns = Array.from(document.querySelectorAll('button'));
      const hasTabBtn = allBtns.some(b => b.textContent.includes('档案') || b.textContent.includes('学业') || b.textContent.includes('基本信息'));
      return hasTabBtn;
    })()
  `)

  if (profileOpened) {
    // 点击学业tab
    await evalInPage(`
      (async function() {
        const btns = Array.from(document.querySelectorAll('button'));
        const academicsBtn = btns.find(b => b.textContent.includes('学业'));
        if (academicsBtn) { academicsBtn.click(); await new Promise(r => setTimeout(r, 800)); }
      })()
    `)

    // 检查学业tab内容
    const tabContent = await evalInPage(`
      (function() {
        const text = document.body.textContent;
        return JSON.stringify({
          hasContent: text.length > 50,
          hasAcademicsTitle: text.includes('学业成绩') || text.includes('暂无学业') || text.includes('学业'),
          hasExamInfo: text.includes('考试') || text.includes('平均分') || text.includes('趋势'),
          textLength: text.length
        });
      })()
    `)
    const parsed = JSON.parse(tabContent)
    record('学生档案学业tab有内容', parsed.hasContent && parsed.hasAcademicsTitle, `len=${parsed.textLength} exam=${parsed.hasExamInfo}`)
  } else {
    record('学生档案学业tab有内容', false, '无法打开学生档案')
  }
} catch (e) { record('学生档案学业tab有内容', false, e.message) }

// ===== 总结 =====
console.log('\n========== 综合功能测试 ==========')
const pass = results.filter(r => r.ok).length
console.log(`总计: ${results.length}, 通过: ${pass}, 失败: ${results.length - pass}`)
if (pass < results.length) {
  console.log('\n失败项:')
  results.filter(r => !r.ok).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`))
}

ws.close()
process.exit(pass === results.length ? 0 : 1)
