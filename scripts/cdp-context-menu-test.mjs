// =============================================================
// 右键菜单 (ContextMenu) CDP 验证测试 v2
// 修复: 在 contextmenu 事件后等待 React 重渲染再检查 DOM
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
          const page = pages.find((p) => p.type === 'page')
          resolve(page)
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

  console.log('='.repeat(60))
  console.log('右键菜单 (ContextMenu) CDP 验证测试 v2')
  console.log('='.repeat(60))

  // 导航到学生页面
  console.log('\n[1] 导航到学生页面...')
  await evalJS(`window.location.hash = '#/students'`)
  await delay(2000)
  const studentRows = await evalJS(`document.querySelectorAll('tr[data-ctx-menu]').length`)
  console.log(`  学生行(带 data-ctx-menu): ${studentRows} 行`)
  results.push({ name: '学生行有 data-ctx-menu', pass: studentRows > 0 })

  // 测试 2: 在学生行上模拟右键, 等待 React 重渲染, 验证自定义菜单出现
  console.log('\n[2] 在学生行上模拟右键...')
  await evalJS(`
    (function() {
      const row = document.querySelector('tr[data-ctx-menu]');
      if (!row) throw new Error('no row');
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: rect.left + 10, clientY: rect.top + 10, button: 2
      }));
    })()
  `)
  await delay(200) // 等待 React 重渲染
  const rowMenuItems = await evalJS(`
    (function() {
      const menu = document.querySelector('[role="menu"]');
      if (!menu) return null;
      return Array.from(menu.querySelectorAll('[role="menuitem"]')).map(b => b.textContent);
    })()
  `)
  if (rowMenuItems && rowMenuItems.length > 0) {
    console.log(`  PASS: 菜单出现, 项目: ${rowMenuItems.join(', ')}`)
    results.push({ name: '学生行右键菜单', pass: true })
    const hasView = rowMenuItems.some((i) => i.includes('查看'))
    const hasDelete = rowMenuItems.some((i) => i.includes('删'))
    results.push({ name: '菜单包含查看详情', pass: hasView })
    results.push({ name: '菜单包含删除', pass: hasDelete })
  } else {
    console.log(`  FAIL: 菜单未出现`)
    results.push({ name: '学生行右键菜单', pass: false })
    results.push({ name: '菜单包含查看详情', pass: false })
    results.push({ name: '菜单包含删除', pass: false })
  }

  // 关闭菜单
  await evalJS(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1, clientY: 1 }))`)
  await delay(300)

  // 测试 3: 在搜索输入框上模拟右键
  console.log('\n[3] 在搜索输入框上模拟右键...')
  await evalJS(`
    (function() {
      const input = document.querySelector('input[type="text"], input:not([type])');
      if (!input) throw new Error('no input');
      const rect = input.getBoundingClientRect();
      input.focus();
      input.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: rect.left + 5, clientY: rect.top + 5, button: 2
      }));
    })()
  `)
  await delay(200)
  const inputMenuItems = await evalJS(`
    (function() {
      const menu = document.querySelector('[role="menu"]');
      if (!menu) return null;
      return Array.from(menu.querySelectorAll('[role="menuitem"]')).map(b => b.textContent);
    })()
  `)
  if (inputMenuItems && inputMenuItems.length > 0) {
    console.log(`  PASS: 编辑菜单出现, 项目: ${inputMenuItems.join(', ')}`)
    results.push({ name: '输入框右键菜单', pass: true })
    const hasCopy = inputMenuItems.some((i) => i.includes('复制'))
    const hasPaste = inputMenuItems.some((i) => i.includes('粘贴'))
    results.push({ name: '菜单包含复制', pass: hasCopy })
    results.push({ name: '菜单包含粘贴', pass: hasPaste })
  } else {
    console.log(`  FAIL: 编辑菜单未出现`)
    results.push({ name: '输入框右键菜单', pass: false })
    results.push({ name: '菜单包含复制', pass: false })
    results.push({ name: '菜单包含粘贴', pass: false })
  }

  // 关闭菜单
  await evalJS(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1, clientY: 1 }))`)
  await delay(300)

  // 测试 4: 在空白区域右键, 验证无菜单
  console.log('\n[4] 在空白区域右键, 验证无菜单...')
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

  // 测试 5: 验证浏览器默认右键被阻止
  console.log('\n[5] 验证浏览器默认右键被阻止...')
  const defaultPrevented = await evalJS(`
    (function() {
      let prevented = false;
      const handler = (e) => { prevented = e.defaultPrevented; };
      document.addEventListener('contextmenu', handler, false);
      const row = document.querySelector('tr[data-ctx-menu]') || document.body;
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: rect.left + 10, clientY: rect.top + 10, button: 2
      }));
      document.removeEventListener('contextmenu', handler, false);
      return prevented;
    })()
  `)
  console.log(`  ${defaultPrevented ? 'PASS' : 'FAIL'}: preventDefault ${defaultPrevented ? '已调用' : '未调用'}`)
  results.push({ name: '浏览器默认右键被阻止', pass: defaultPrevented })

  // 测试 6: Escape 关闭菜单
  console.log('\n[6] Escape 键关闭菜单...')
  await evalJS(`
    (function() {
      const row = document.querySelector('tr[data-ctx-menu]');
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: rect.left + 10, clientY: rect.top + 10, button: 2
      }));
    })()
  `)
  await delay(200)
  const menuBeforeEscape = await evalJS(`document.querySelector('[role="menu"]') !== null`)
  await evalJS(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await delay(200)
  const menuAfterEscape = await evalJS(`document.querySelector('[role="menu"]') !== null`)
  if (menuBeforeEscape && !menuAfterEscape) {
    console.log('  PASS: Escape 成功关闭菜单')
    results.push({ name: 'Escape 关闭菜单', pass: true })
  } else {
    console.log(`  FAIL: 菜单前=${menuBeforeEscape} 后=${menuAfterEscape}`)
    results.push({ name: 'Escape 关闭菜单', pass: false })
  }

  // 汇总
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
