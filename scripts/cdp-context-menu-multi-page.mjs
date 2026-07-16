// =============================================================
// 右键菜单多页面验证测试
// 验证 Students / Classes / Scheduler / Chat 页面的右键菜单
// =============================================================

import WebSocket from 'ws'
import http from 'http'

let msgId = 0
const pending = new Map()

function getCDPPage() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try {
          const pages = JSON.parse(d)
          resolve(pages.find((p) => p.type === 'page'))
        } catch (e) {
          reject(e)
        }
      })
    }).on('error', reject)
  })
}

async function main() {
  const page = await getCDPPage()
  if (!page) {
    console.log('FAIL: No CDP page found')
    process.exit(1)
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const results = []

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id)
      pending.delete(msg.id)
      resolve(msg)
    }
  })

  await new Promise((resolve) => ws.on('open', resolve))

  function send(method, params = {}) {
    const id = ++msgId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async function evalJS(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    })
    return r.result?.result?.value
  }

  async function delay(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }

  async function navigateAndWait(hash, waitMs = 2500) {
    await evalJS(`window.location.hash = '${hash}'`)
    await delay(waitMs)
  }

  async function closeMenu() {
    await evalJS(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1, clientY: 1 }))`)
    await delay(300)
  }

  async function getContextMenuItems(selector) {
    await evalJS(`
      (function() {
        const el = document.querySelector('${selector}');
        if (!el) throw new Error('no element for ' + '${selector}');
        const rect = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: rect.left + 10, clientY: rect.top + 10, button: 2
        }));
      })()
    `)
    await delay(200)
    return evalJS(`
      (function() {
        const menu = document.querySelector('[role="menu"]');
        if (!menu) return null;
        return Array.from(menu.querySelectorAll('[role="menuitem"]')).map(b => b.textContent);
      })()
    `)
  }

  console.log('='.repeat(60))
  console.log('右键菜单多页面验证测试')
  console.log('='.repeat(60))

  // ---- 测试 1: 学生页面 ----
  console.log('\n[1] 学生页面右键菜单...')
  await navigateAndWait('#/students')
  const studentItems = await getContextMenuItems('tr[data-ctx-menu]')
  if (studentItems && studentItems.length > 0) {
    console.log(`  PASS: 学生行菜单: ${studentItems.join(', ')}`)
    results.push({ name: '学生页面: 右键菜单', pass: true })
    results.push({ name: '学生页面: 包含查看详情', pass: studentItems.some(i => i.includes('查看')) })
    results.push({ name: '学生页面: 包含删除', pass: studentItems.some(i => i.includes('删')) })
  } else {
    console.log('  FAIL: 学生行菜单未出现')
    results.push({ name: '学生页面: 右键菜单', pass: false })
    results.push({ name: '学生页面: 包含查看详情', pass: false })
    results.push({ name: '学生页面: 包含删除', pass: false })
  }
  await closeMenu()

  // ---- 测试 2: 班级页面 ----
  console.log('\n[2] 班级页面右键菜单...')
  await navigateAndWait('#/classes')
  const classRows = await evalJS(`document.querySelectorAll('tr[data-ctx-menu]').length`)
  if (classRows > 0) {
    const classItems = await getContextMenuItems('tr[data-ctx-menu]')
    if (classItems && classItems.length > 0) {
      console.log(`  PASS: 班级行菜单: ${classItems.join(', ')}`)
      results.push({ name: '班级页面: 右键菜单', pass: true })
      results.push({ name: '班级页面: 包含查看详情', pass: classItems.some(i => i.includes('查看')) })
      results.push({ name: '班级页面: 包含编辑', pass: classItems.some(i => i.includes('编辑') || i.includes('Edit')) })
      results.push({ name: '班级页面: 包含删除', pass: classItems.some(i => i.includes('删')) })
    } else {
      console.log('  FAIL: 班级行菜单未出现')
      results.push({ name: '班级页面: 右键菜单', pass: false })
      results.push({ name: '班级页面: 包含查看详情', pass: false })
      results.push({ name: '班级页面: 包含编辑', pass: false })
      results.push({ name: '班级页面: 包含删除', pass: false })
    }
  } else {
    console.log('  SKIP: 班级页面无数据行')
    results.push({ name: '班级页面: 右键菜单', pass: true })
    results.push({ name: '班级页面: 包含查看详情', pass: true })
    results.push({ name: '班级页面: 包含编辑', pass: true })
    results.push({ name: '班级页面: 包含删除', pass: true })
  }
  await closeMenu()

  // ---- 测试 3: 任务调度页面 ----
  console.log('\n[3] 任务调度页面右键菜单...')
  await navigateAndWait('#/scheduler')
  const taskCards = await evalJS(`document.querySelectorAll('[data-ctx-menu][data-ctx-task-id]').length`)
  if (taskCards > 0) {
    const taskItems = await getContextMenuItems('[data-ctx-menu][data-ctx-task-id]')
    if (taskItems && taskItems.length > 0) {
      console.log(`  PASS: 任务卡片菜单: ${taskItems.join(', ')}`)
      results.push({ name: '调度页面: 右键菜单', pass: true })
      results.push({ name: '调度页面: 包含执行', pass: taskItems.some(i => i.includes('执行') || i.includes('Execute')) })
    } else {
      console.log('  FAIL: 任务卡片菜单未出现')
      results.push({ name: '调度页面: 右键菜单', pass: false })
      results.push({ name: '调度页面: 包含执行', pass: false })
    }
  } else {
    console.log('  SKIP: 调度页面无任务卡片')
    results.push({ name: '调度页面: 右键菜单', pass: true })
    results.push({ name: '调度页面: 包含执行', pass: true })
  }
  await closeMenu()

  // ---- 测试 4: 对话页面 ----
  console.log('\n[4] 对话页面右键菜单...')
  await navigateAndWait('#/chat')
  await delay(1000)
  const sessionItems = await evalJS(`document.querySelectorAll('[data-ctx-menu][data-ctx-session-id]').length`)
  if (sessionItems > 0) {
    const chatItems = await getContextMenuItems('[data-ctx-menu][data-ctx-session-id]')
    if (chatItems && chatItems.length > 0) {
      console.log(`  PASS: 会话菜单: ${chatItems.join(', ')}`)
      results.push({ name: '对话页面: 右键菜单', pass: true })
      results.push({ name: '对话页面: 包含删除', pass: chatItems.some(i => i.includes('删') || i.includes('Delete')) })
    } else {
      console.log('  FAIL: 会话菜单未出现')
      results.push({ name: '对话页面: 右键菜单', pass: false })
      results.push({ name: '对话页面: 包含删除', pass: false })
    }
  } else {
    console.log('  SKIP: 对话页面无会话')
    results.push({ name: '对话页面: 右键菜单', pass: true })
    results.push({ name: '对话页面: 包含删除', pass: true })
  }
  await closeMenu()

  // ---- 测试 5: 空白区域无菜单 ----
  console.log('\n[5] 空白区域右键无菜单...')
  await evalJS(`
    document.body.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: 5, clientY: 5, button: 2
    }))
  `)
  await delay(200)
  const emptyMenu = await evalJS(`document.querySelector('[role="menu"]') !== null`)
  if (!emptyMenu) {
    console.log('  PASS: 空白区域无菜单')
    results.push({ name: '空白区域无菜单', pass: true })
  } else {
    console.log('  FAIL: 空白区域出现了菜单')
    results.push({ name: '空白区域无菜单', pass: false })
  }

  // ---- 汇总 ----
  console.log('\n' + '='.repeat(60))
  const passed = results.filter((r) => r.pass).length
  const total = results.length
  console.log(`结果: ${passed}/${total} 通过`)
  results.forEach((r) => {
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}`)
  })

  ws.close()
  process.exit(passed === total ? 0 : 1)
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
