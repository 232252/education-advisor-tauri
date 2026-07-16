// =============================================================
// 全页面导航 + 渲染健康检查 + 主功能 IPC 烟雾测试
// 覆盖: dashboard/chat/students/classes/academics/agents/scheduler/models/skills/privacy/settings
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

  // 辅助: 导航到 hash 路径
  const navigateTo = async (path) => {
    await evalInPage(`
      (async function() {
        // 先导航到空白路由, 再导航到目标路由, 强制 React Router 重新挂载
        const target = '#${path}';
        if (location.hash === target) {
          location.hash = '#/__nav_reset__';
          await new Promise(r => setTimeout(r, 200));
        }
        location.hash = target;
        // 等待 React Router 处理 + 页面渲染
        await new Promise(r => setTimeout(r, 1500));
        // 验证 hash 已更新, 最多重试 3 次
        for (let i = 0; i < 3 && location.hash !== target; i++) {
          location.hash = '#/__nav_reset__';
          await new Promise(r => setTimeout(r, 200));
          location.hash = target;
          await new Promise(r => setTimeout(r, 1500));
        }
      })()
    `)
  }

  // 辅助: 检查页面是否有 Vite 错误遮罩 / React 错误边界 / 空白
  const checkPageHealth = async (expectedPath) => {
    return await evalInPage(`
      (function() {
        const hash = location.hash;
        const body = document.body;
        const bodyText = (body.textContent || '').trim();
        // Vite error overlay
        const viteErr = document.querySelector('vite-error-overlay');
        if (viteErr) return { ok: false, reason: 'vite-error-overlay', hash, bodyLen: bodyText.length };
        // React error boundary fallback
        if (bodyText.includes('页面渲染出错了') || bodyText.includes('Something went wrong')) {
          return { ok: false, reason: 'react-error-boundary', hash, bodyLen: bodyText.length };
        }
        // 完全空白
        if (bodyText.length < 20) {
          return { ok: false, reason: 'empty-body', hash, bodyLen: bodyText.length };
        }
        // hash 不匹配
        if (!hash.includes('#${expectedPath}')) {
          return { ok: false, reason: 'hash-mismatch', hash, bodyLen: bodyText.length };
        }
        return { ok: true, hash, bodyLen: bodyText.length };
      })()
    `)
  }

  // 辅助: 捕获 console.error
  const errorBuffer = []
  await send('Runtime.enable')
  // 监听 console API 调用
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const args = msg.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')
        errorBuffer.push(args)
      }
    } catch {}
  })

  // ========== 测试 1-11: 逐页导航 ==========
  const pages = [
    { path: '/dashboard', name: '仪表盘', minLen: 100 },
    { path: '/chat', name: 'AI 对话', minLen: 50 },
    { path: '/students', name: '学生列表', minLen: 100 },
    { path: '/classes', name: '班级管理', minLen: 50 },
    { path: '/academics', name: '学业管理', minLen: 100 },
    { path: '/agents', name: '智能体', minLen: 50 },
    { path: '/scheduler', name: '定时任务', minLen: 50 },
    { path: '/models', name: '模型管理', minLen: 50 },
    { path: '/skills', name: '技能管理', minLen: 50 },
    { path: '/privacy', name: '隐私引擎', minLen: 50 },
    { path: '/settings', name: '设置', minLen: 50 },
  ]

  const navErrorsBefore = errorBuffer.length
  for (const p of pages) {
    try {
      await navigateTo(p.path)
      const health = await checkPageHealth(p.path)
      if (health.ok) {
        record(`导航: ${p.name} (${p.path})`, true, `bodyLen=${health.bodyLen}`)
      } else {
        record(`导航: ${p.name} (${p.path})`, false, `reason=${health.reason} hash=${health.hash} bodyLen=${health.bodyLen}`)
      }
    } catch (err) {
      record(`导航: ${p.name} (${p.path})`, false, String(err.message || err))
    }
  }

  // ========== 测试 12: 导航过程中无 console.error 爆发 ==========
  const navErrorsAfter = errorBuffer.length
  const newErrors = errorBuffer.slice(navErrorsBefore)
  // 允许少量非致命错误 (如某些 IPC 失败), 但不应有大量错误
  record(`导航过程 console.error 数量 (${newErrors.length} 条)`, newErrors.length <= 10, newErrors.length > 0 ? newErrors[0].substring(0, 120) : '')

  // ========== 测试 13: 导航栏所有入口存在 ==========
  try {
    const navItems = await evalInPage(`
      (function() {
        const links = Array.from(document.querySelectorAll('a[href^="#"], a[href^="/"], nav a, aside a'));
        const hrefs = links.map(l => l.getAttribute('href')).filter(Boolean);
        const expected = ['/dashboard','/chat','/students','/classes','/academics','/agents','/scheduler','/models','/skills','/privacy','/settings'];
        const missing = expected.filter(e => !hrefs.some(h => h.includes(e)));
        return { total: hrefs.length, missing };
      })()
    `)
    record(`导航栏入口完整性 (${navItems.total} 个链接)`, navItems.missing.length === 0, navItems.missing.length > 0 ? `缺失: ${navItems.missing.join(',')}` : '')
  } catch (err) {
    record(`导航栏入口完整性`, false, String(err.message || err))
  }

  // ========== 测试 14: 学业 ↔ 学生档案 路由切换正常 ==========
  try {
    await navigateTo('/students')
    // 点击第一个学生进入档案
    const clicked = await evalInPage(`
      (async function() {
        const rows = Array.from(document.querySelectorAll('tr, [data-student-name], .student-row'));
        // 找第一个可点击的学生行
        for (const row of rows) {
          if (row.textContent && row.textContent.trim().length > 1 && row.textContent.trim().length < 50) {
            row.click();
            await new Promise(r => setTimeout(r, 800));
            return { clicked: true, hash: location.hash };
          }
        }
        // 尝试点击任何包含学生名的元素
        const cells = Array.from(document.querySelectorAll('td, .cursor-pointer'));
        if (cells.length > 0) {
          cells[0].click();
          await new Promise(r => setTimeout(r, 800));
          return { clicked: true, hash: location.hash, fallback: 'cell' };
        }
        return { clicked: false, hash: location.hash };
      })()
    `)
    record(`学生列表 → 学生档案路由切换`, clicked.clicked, `hash=${clicked.hash}`)
  } catch (err) {
    record(`学生列表 → 学生档案路由切换`, false, String(err.message || err))
  }

  // ========== 测试 15: 回到学业页, 确认数据未丢失 ==========
  try {
    await navigateTo('/academics')
    const health = await checkPageHealth('/academics')
    record(`学业页返回后数据正常`, health.ok, `bodyLen=${health.bodyLen}`)
  } catch (err) {
    record(`学业页返回后数据正常`, false, String(err.message || err))
  }

  // ========== 测试 16: 快速来回切换无崩溃 ==========
  try {
    // 在 3 个页面间快速切换 5 轮
    await evalInPage(`
      (async function() {
        const paths = ['#/students', '#/academics', '#/classes'];
        for (let i = 0; i < 5; i++) {
          for (const p of paths) {
            location.hash = p;
            await new Promise(r => setTimeout(r, 300));
          }
        }
        await new Promise(r => setTimeout(r, 500));
        const bodyLen = (document.body.textContent || '').length;
        const hasErr = !!document.querySelector('vite-error-overlay') || (document.body.textContent || '').includes('页面渲染出错了');
        return { bodyLen, hasErr };
      })()
    `).then((r) => {
      record(`快速来回切换 15 次`, !r.hasErr && r.bodyLen > 100, `bodyLen=${r.bodyLen} hasErr=${r.hasErr}`)
    })
  } catch (err) {
    record(`快速来回切换 15 次`, false, String(err.message || err))
  }

  // ========== 测试 17: 设置页持久化 (通过 IPC) ==========
  // settings.get() 不接受参数,直接返回整个 UnifiedSettings 对象
  // settings.set(path, value) 返回 {success: boolean}
  try {
    const before = await evalInPage(`
      (async function() {
        const api = window.__EAA_API__ || window.api;
        if (!api) return { hasApi: false };
        try {
          const settings = await api.settings.get();
          return { hasApi: true, value: settings?.general?.defaultOperator ?? null };
        } catch (e) {
          return { hasApi: true, error: String(e) };
        }
      })()
    `)
    if (!before.hasApi) {
      record(`设置持久化 (set→get)`, false, 'window.__EAA_API__ 不存在')
    } else if (before.error) {
      record(`设置持久化 (set→get)`, false, `get error: ${before.error}`)
    } else {
      const testValue = `test-op-${Date.now()}`
      const setResult = await evalInPage(`
        (async function() {
          try {
            const api = window.__EAA_API__ || window.api;
            const res = await api.settings.set('general.defaultOperator', ${JSON.stringify(testValue)});
            return res;
          } catch (e) { return { success: false, error: String(e) }; }
        })()
      `)
      const after = await evalInPage(`
        (async function() {
          try {
            const api = window.__EAA_API__ || window.api;
            const settings = await api.settings.get();
            return settings?.general?.defaultOperator ?? null;
          } catch (e) { return 'ERR:' + String(e); }
        })()
      `)
      // 恢复原始值
      await evalInPage(`
        (async function() {
          try {
            const api = window.__EAA_API__ || window.api;
            await api.settings.set('general.defaultOperator', ${JSON.stringify(before.value ?? '')});
          } catch (e) {}
        })()
      `)
      record(`设置持久化 (set→get)`, after === testValue, `set=${setResult?.success} before=${before.value} after=${after}`)
    }
  } catch (err) {
    record(`设置持久化 (set→get)`, false, String(err.message || err))
  }

  // ========== 测试 18: 班级列表 IPC 可读取 ==========
  try {
    const clsList = await evalInPage(`
      (async function() {
        try {
          const api = window.__EAA_API__ || window.api;
          const res = await api.class.list();
          return res;
        } catch (e) { return { success: false, error: String(e) }; }
      })()
    `)
    record(`班级列表 IPC`, clsList?.success === true, `count=${clsList?.data?.length ?? 0}`)
  } catch (err) {
    record(`班级列表 IPC`, false, String(err.message || err))
  }

  // ========== 测试 19: 学生列表 IPC 可读取 ==========
  try {
    const stuList = await evalInPage(`
      (async function() {
        try {
          const api = window.__EAA_API__ || window.api;
          const res = await api.eaa.listStudents();
          return res;
        } catch (e) { return { success: false, error: String(e) }; }
      })()
    `)
    record(`学生列表 IPC`, stuList?.success === true, `total=${stuList?.data?.total ?? 0}`)
  } catch (err) {
    record(`学生列表 IPC`, false, String(err.message || err))
  }

  // ========== 测试 20: 学业配置 IPC ==========
  try {
    const cfg = await evalInPage(`
      (async function() {
        try {
          const api = window.__EAA_API__ || window.api;
          const res = await api.academic.getConfig();
          return res;
        } catch (e) { return { success: false, error: String(e) }; }
      })()
    `)
    record(`学业配置 IPC`, cfg?.success === true, `subjects=${cfg?.data?.subjects?.length ?? 0}`)
  } catch (err) {
    record(`学业配置 IPC`, false, String(err.message || err))
  }

  // ========== 测试 21: 考试列表 IPC ==========
  try {
    const exams = await evalInPage(`
      (async function() {
        try {
          const api = window.__EAA_API__ || window.api;
          const res = await api.academic.listExams();
          return res;
        } catch (e) { return { success: false, error: String(e) }; }
      })()
    `)
    record(`考试列表 IPC`, exams?.success === true, `count=${exams?.data?.length ?? 0}`)
  } catch (err) {
    record(`考试列表 IPC`, false, String(err.message || err))
  }

  // ========== 汇总 ==========
  console.log('\n========== 全页面导航 + IPC 烟雾测试 ==========')
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
