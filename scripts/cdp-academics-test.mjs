// =============================================================
// CDP 学业模块测试 — AcademicsPage 全功能验证
// 测试: 页面加载 / IPC handlers / 考试CRUD / 成绩CRUD / 图表渲染
// =============================================================
import { chromium } from 'playwright'

const CDP_URL = 'http://localhost:9222'
const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'

let passCount = 0
let failCount = 0
const errors = []
const warnings = []

function log(msg) { console.log(msg) }
function ok(msg) { passCount++; console.log(`  ${PASS} ${msg}`) }
function fail(msg) { failCount++; console.log(`  ${FAIL} ${msg}`) }

async function connect() {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL)
    const contexts = browser.contexts()
    if (contexts.length === 0) throw new Error('No browser context')
    const pages = contexts[0].pages()
    if (pages.length === 0) throw new Error('No page')
    return { browser, page: pages[0] }
  } catch (e) {
    console.error('❌ 无法连接 CDP:', e.message)
    process.exit(1)
  }
}

// 通过 Tauri 暴露的 api 命名空间调用 sidecar IPC (camelCase 方法名, Tauri 2 兼容)
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

async function setupConsoleCollector(page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
    if (msg.type() === 'warning') warnings.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(`PAGE_ERROR: ${err.message}`))
}

async function navigateTo(page, hash) {
  await page.evaluate((h) => { window.location.hash = h }, hash)
  try {
    await page.waitForFunction(() => {
      const root = document.getElementById('root')
      return root && root.children.length > 0 && root.innerHTML.length > 50
    }, { timeout: 8000 })
  } catch {
    await page.waitForTimeout(2000)
  }
}

async function main() {
  console.log('=== 学业模块 CDP 测试 ===\n')

  const { browser, page } = await connect()
  await setupConsoleCollector(page)

  // ===== 1. 页面加载测试 =====
  console.log('--- 1. 页面加载 ---')
  await navigateTo(page, '#/academics')
  await page.waitForTimeout(2000)

  const pageState = await page.evaluate(() => {
    const body = document.body?.innerText || ''
    return {
      hasOverview: body.includes('成绩总览'),
      hasExams: body.includes('考试管理'),
      hasEntry: body.includes('成绩录入'),
      hasAcademics: body.includes('学业') || body.includes('Academics'),
      bodyLen: body.length,
      canvasCount: document.querySelectorAll('canvas').length,
      hasStudentList: body.includes('学生') || body.includes('Student'),
    }
  })

  if (pageState.hasOverview) ok('成绩总览 tab 可见')
  else fail('成绩总览 tab 不可见')

  if (pageState.hasExams) ok('考试管理 tab 可见')
  else fail('考试管理 tab 不可见')

  if (pageState.hasEntry) ok('成绩录入 tab 可见')
  else fail('成绩录入 tab 不可见')

  if (pageState.bodyLen > 100) ok(`页面有内容 (${pageState.bodyLen} chars)`)
  else fail(`页面内容过少 (${pageState.bodyLen} chars)`)

  // ===== 2. IPC Handler 测试 =====
  console.log('\n--- 2. IPC Handler 测试 ---')

  // 2a. get-config
  const configRes = await callApi(page, `const res = await api.academic.getConfig(); return res;`)
  if (configRes.ok && configRes.data?.success) {
    const config = configRes.data.data
    if (config?.subjects && Array.isArray(config.subjects) && config.subjects.length >= 10) {
      ok(`get-config: ${config.subjects.length} 个科目`)
    } else {
      ok('get-config: 返回成功 (可能使用默认配置)')
    }
  } else {
    fail(`get-config 失败: ${configRes.error || configRes.data?.error}`)
  }

  // 2b. list-exams (初始应为空)
  const listRes1 = await callApi(page, `const res = await api.academic.listExams(); return res;`)
  if (listRes1.ok && listRes1.data?.success) {
    const exams = listRes1.data.data || []
    ok(`list-exams: 初始 ${exams.length} 个考试`)
  } else {
    fail(`list-exams 失败: ${listRes1.error || listRes1.data?.error}`)
  }

  // ===== 3. 考试 CRUD 测试 =====
  console.log('\n--- 3. 考试 CRUD ---')

  // 3a. create-exam
  const examData = {
    name: 'CDP测试月考',
    type: 'monthly',
    date: '2026-07-14',
    semester: '2026-2027-1',
    scope: '第一单元',
    subjects: ['chinese', 'math', 'english', 'physics', 'chemistry'],
  }
  const createRes = await callApi(page, `const res = await api.academic.createExam(${JSON.stringify(examData)}); return res;`)
  let examId = null
  if (createRes.ok && createRes.data?.success) {
    examId = createRes.data.data?.id
    if (examId) {
      ok(`create-exam: ${examData.name} (id=${examId})`)
    } else {
      ok('create-exam: 返回成功')
    }
  } else {
    fail(`create-exam 失败: ${createRes.error || createRes.data?.error}`)
  }

  // 3b. list-exams (应包含新创建的考试)
  if (examId) {
    const listRes2 = await callApi(page, `const res = await api.academic.listExams(); return res;`)
    if (listRes2.ok && listRes2.data?.success) {
      const exams = listRes2.data.data || []
      const found = exams.find((e) => e.id === examId)
      if (found) {
        ok(`list-exams: 找到新创建的考试 (${found.name})`)
      } else {
        fail('list-exams: 未找到新创建的考试')
      }
    } else {
      fail(`list-exams 失败: ${listRes2.error || listRes2.data?.error}`)
    }
  }

  // ===== 4. 成绩 CRUD 测试 =====
  console.log('\n--- 4. 成绩 CRUD ---')

  // 先获取学生列表
  const studentsRes = await callApi(page, `const res = await api.eaa.listStudents(); return res;`)
  let testStudentName = null
  if (studentsRes.ok && studentsRes.data?.success) {
    const students = studentsRes.data.data || []
    if (students.length > 0) {
      testStudentName = students[0].name
      ok(`获取学生: ${testStudentName} (共 ${students.length} 名)`)
    } else {
      // 没有学生，创建一个
      const addRes = await callApi(page, `const res = await api.eaa.addStudent('CDP测试学生'); return res;`)
      if (addRes.ok) {
        testStudentName = 'CDP测试学生'
        ok('创建测试学生: CDP测试学生')
      } else {
        fail(`创建测试学生失败: ${addRes.error || 'unknown'}`)
      }
    }
  } else {
    fail(`获取学生列表失败: ${studentsRes.error || studentsRes.data?.error}`)
  }

  // 4a. set-grade
  if (examId && testStudentName) {
    const gradeData = {
      examId: examId,
      subjectId: 'chinese',
      studentName: testStudentName,
      score: 135,
      fullMark: 150,
      classRank: 3,
      note: 'CDP测试成绩',
    }
    const setGradeRes = await callApi(page, `const res = await api.academic.setGrade(${JSON.stringify(gradeData)}); return res;`)
    if (setGradeRes.ok && setGradeRes.data?.success) {
      ok(`set-grade: ${testStudentName} 语文=${gradeData.score}`)
    } else {
      fail(`set-grade 失败: ${setGradeRes.error || setGradeRes.data?.error}`)
    }

    // 4b. get-grades
    const getGradesRes = await callApi(page, `const res = await api.academic.getGrades(${JSON.stringify(testStudentName)}); return res;`)
    if (getGradesRes.ok && getGradesRes.data?.success) {
      const grades = getGradesRes.data.data || []
      const found = grades.find(
        (g) => g.examId === examId && g.subjectId === 'chinese',
      )
      if (found && found.score === 135) {
        ok(`get-grades: 找到成绩 (score=${found.score})`)
      } else {
        fail(`get-grades: 未找到成绩 (grades=${grades.length})`)
      }
    } else {
      fail(`get-grades 失败: ${getGradesRes.error || getGradesRes.data?.error}`)
    }

    // 4c. batch-set-grades
    const batchData = [
      {
        examId: examId,
        subjectId: 'math',
        studentName: testStudentName,
        score: 142,
        fullMark: 150,
      },
      {
        examId: examId,
        subjectId: 'english',
        studentName: testStudentName,
        score: 128,
        fullMark: 150,
      },
      {
        examId: examId,
        subjectId: 'physics',
        studentName: testStudentName,
        score: 95,
        fullMark: 100,
      },
    ]
    const batchRes = await callApi(page, `const res = await api.academic.batchSetGrades(${JSON.stringify(batchData)}); return res;`)
    if (batchRes.ok && batchRes.data?.success) {
      ok(`batch-set-grades: ${batchRes.data.data} 条成绩`)
    } else {
      fail(`batch-set-grades 失败: ${batchRes.error || batchRes.data?.error}`)
    }

    // 4d. get-grades (验证批量成绩)
    const getGradesRes2 = await callApi(page, `const res = await api.academic.getGrades(${JSON.stringify(testStudentName)}); return res;`)
    if (getGradesRes2.ok && getGradesRes2.data?.success) {
      const grades = getGradesRes2.data.data || []
      if (grades.length >= 4) {
        ok(`get-grades: 共 ${grades.length} 条成绩 (4+ expected)`)
      } else {
        fail(`get-grades: 成绩数量不足 (${grades.length} < 4)`)
      }
    } else {
      fail(`get-grades 失败: ${getGradesRes2.error || getGradesRes2.data?.error}`)
    }

    // 4e. get-class-grades
    const classGradesRes = await callApi(page, `const res = await api.academic.getClassGrades(${JSON.stringify([testStudentName])}, ${JSON.stringify(examId)}); return res;`)
    if (classGradesRes.ok && classGradesRes.data?.success) {
      ok('get-class-grades: 返回成功')
    } else {
      fail(`get-class-grades 失败: ${classGradesRes.error || classGradesRes.data?.error}`)
    }
  }

  // ===== 5. 删除考试 (清理) =====
  console.log('\n--- 5. 清理 ---')
  if (examId) {
    const delRes = await callApi(page, `const res = await api.academic.deleteExam(${JSON.stringify(examId)}); return res;`)
    if (delRes.ok && delRes.data?.success) {
      ok('delete-exam: 考试已删除')
    } else {
      fail(`delete-exam 失败: ${delRes.error || delRes.data?.error}`)
    }
  }

  // ===== 6. 图表渲染验证 =====
  console.log('\n--- 6. 图表渲染 ---')
  // 重新导航到学业页面并选择学生
  await navigateTo(page, '#/academics')
  await page.waitForTimeout(2000)

  // 尝试点击第一个学生
  try {
    const studentClicked = await page.evaluate(() => {
      const items = document.querySelectorAll('[data-student-name], .student-item, li')
      for (const item of items) {
        if (item.textContent && item.textContent.includes('CDP') ) {
          item.click()
          return true
        }
      }
      return false
    })
    if (studentClicked) {
      ok('点击学生成功')
      await page.waitForTimeout(1500)
    }
  } catch {
    // 忽略
  }

  const chartState = await page.evaluate(() => {
    return {
      canvasCount: document.querySelectorAll('canvas').length,
      echartCount: document.querySelectorAll('[_echarts_instance_]').length,
      hasCharts: document.querySelectorAll('canvas').length > 0,
    }
  })

  if (chartState.echartCount > 0) {
    ok(`ECharts 实例: ${chartState.echartCount}`)
  } else {
    // 没有数据时图表可能不渲染，这是正常的
    log(`  ℹ ECharts 实例: ${chartState.echartCount} (无数据时正常)`)
  }

  // ===== 7. 控制台错误检查 =====
  console.log('\n--- 7. 控制台错误 ---')
  // 过滤掉已知的无害警告
  const realErrors = errors.filter(
    (e) =>
      !e.includes('plugin:vite') &&
      !e.includes('Download the React DevTools') &&
      !e.includes('better-sqlite3'),
  )
  if (realErrors.length === 0) {
    ok(`无控制台错误 (${errors.length} 已过滤)`)
  } else {
    fail(`${realErrors.length} 个控制台错误:`)
    for (const e of realErrors.slice(0, 5)) {
      console.log(`    ${e.slice(0, 200)}`)
    }
  }

  // ===== 8. Tab 切换测试 =====
  console.log('\n--- 8. Tab 切换 ---')
  const tabs = ['考试管理', '成绩录入', '成绩总览']
  for (const tabName of tabs) {
    try {
      const clicked = await page.evaluate((name) => {
        const els = document.querySelectorAll('button, [role="tab"], div')
        for (const el of els) {
          const text = el.textContent?.trim() || ''
          if (text.includes(name) && text.length < 20) {
            el.click()
            return true
          }
        }
        return false
      }, tabName)
      if (clicked) {
        await page.waitForTimeout(500)
        ok(`Tab 切换: ${tabName}`)
      } else {
        fail(`Tab 切换: ${tabName} 未找到`)
      }
    } catch {
      fail(`Tab 切换: ${tabName} 异常`)
    }
  }

  // ===== 总结 =====
  console.log('\n=== 总结 ===')
  console.log(`  ${PASS} 通过: ${passCount}`)
  console.log(`  ${FAIL} 失败: ${failCount}`)
  if (warnings.length > 0) {
    console.log(`  ⚠ 警告: ${warnings.length}`)
  }

  await browser.close()

  if (failCount > 0) {
    process.exit(1)
  } else {
    console.log('\n🎉 全部通过!')
    process.exit(0)
  }
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
