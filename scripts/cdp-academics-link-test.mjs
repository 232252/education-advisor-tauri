// =============================================================
// 学业联动测试 — 验证 StudentProfile 学业 Tab 从 academic IPC 加载数据
// (Tauri 2 兼容: 使用 window.__EAA_API__/window.api 命名空间, 而非 Electron-style __TAURI_INTERNALS__.invoke)
// =============================================================
import { chromium } from 'playwright'

const CDP_URL = 'http://localhost:9222'

// 通过 Tauri 暴露的 api 命名空间调用 sidecar IPC (camelCase 方法名)
async function callApi(page, methodCode) {
  return await page.evaluate(async (code) => {
    try {
      const api = window.__EAA_API__ || window.api
      if (!api) return { ok: false, error: 'window.api 不存在' }
      // eslint-disable-next-line no-eval
      const res = await eval(`(async () => { ${code} })()`)
      return { ok: true, data: res }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  }, methodCode)
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL)
  const ctx = browser.contexts()[0]
  const page = ctx.pages()[0]

  console.log('=== 学业联动测试 ===\n')

  // 1. 获取学生列表
  const stuRes = await callApi(page, `const res = await api.eaa.listStudents(); return res;`)
  const allStudents = (stuRes.data?.students || stuRes.data?.data?.students || []).filter(s => s.status !== 'Deleted')
  console.log(`总学生数: ${allStudents.length}`)

  // 2. 创建考试
  const examRes = await callApi(page, `const res = await api.academic.createExam({ name: '联动测试考试', type: 'monthly', date: '2026-07-15', semester: '2026-2027-1', scope: '', subjects: ['chinese', 'math'] }); return res;`)
  const examId = examRes.data?.data?.id || examRes.data?.id
  console.log(`创建考试: ${examId}`)

  // 3. 导航到学生页面
  await page.evaluate(() => { window.location.hash = '#/students' })
  await page.waitForTimeout(3000)

  // 4. 获取表格中的学生
  const tableStudents = await page.evaluate(() => {
    const rows = document.querySelectorAll('tr[data-ctx-student-name]')
    return Array.from(rows).map(r => r.getAttribute('data-ctx-student-name'))
  })
  console.log(`表格中学生数: ${tableStudents.length}`)

  const targetStudent = tableStudents[0]
  if (!targetStudent) {
    console.log('FAIL: 表格中无学生')
    await browser.close()
    process.exit(1)
  }
  console.log(`目标学生: ${targetStudent}`)

  // 5. 为该学生设置成绩
  await callApi(page, `const res = await api.academic.setGrade({ examId: ${JSON.stringify(examId)}, subjectId: 'chinese', studentName: ${JSON.stringify(targetStudent)}, score: 77, fullMark: 100 }); return res;`)
  await callApi(page, `const res = await api.academic.setGrade({ examId: ${JSON.stringify(examId)}, subjectId: 'math', studentName: ${JSON.stringify(targetStudent)}, score: 82, fullMark: 100 }); return res;`)
  console.log('成绩已设置: 语文77, 数学82')

  // 6. 验证成绩已写入
  const gradesCheck = await callApi(page, `const res = await api.academic.getGrades(${JSON.stringify(targetStudent)}); return res;`)
  console.log(`成绩验证: ${gradesCheck.data?.data?.length || gradesCheck.data?.length || 0} 条`)

  // 7. 点击该学生
  await page.evaluate((name) => {
    const rows = document.querySelectorAll('tr[data-ctx-student-name]')
    for (const row of rows) {
      if (row.getAttribute('data-ctx-student-name') === name) {
        row.click()
        return
      }
    }
  }, targetStudent)
  await page.waitForTimeout(2000)
  console.log('点击学生: OK')

  // 8. 切换到学业Tab
  await page.evaluate(() => {
    const tabs = document.querySelectorAll('button')
    for (const t of tabs) {
      if (t.textContent && t.textContent.includes('学业')) {
        t.click()
        return
      }
    }
  })
  await page.waitForTimeout(3000)
  console.log('切换学业Tab: OK')

  // 9. 检查显示内容
  const bodyText = await page.evaluate(() => document.body.innerText)

  const checks = [
    { name: '显示联动测试考试', pass: bodyText.includes('联动测试考试') },
    { name: '显示77分', pass: bodyText.includes('77') },
    { name: '显示82分', pass: bodyText.includes('82') },
    { name: '显示成绩趋势', pass: bodyText.includes('成绩趋势') },
    { name: '显示偏科分析', pass: bodyText.includes('偏科分析') },
  ]

  let passCount = 0
  for (const c of checks) {
    console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}`)
    if (c.pass) passCount++
  }

  // 10. 清理
  await callApi(page, `const res = await api.academic.deleteExam(${JSON.stringify(examId)}); return res;`)
  console.log('\n清理: OK')

  console.log(`\n=== 结果: ${passCount}/${checks.length} 通过 ===`)

  await browser.close()
  process.exit(passCount === checks.length ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
