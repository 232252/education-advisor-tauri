// =============================================================
// 学业模块压力测试 — 大量成绩数据 + 并发写入
// =============================================================
import { chromium } from 'playwright'

const CDP_URL = 'http://localhost:9222'

async function callApi(page, channel, ...args) {
  return await page.evaluate(async ({ ch, ag }) => {
    try {
      const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: ch, args: ag })
      return { ok: true, data: r }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  }, { ch: channel, ag: args })
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL)
  const ctx = browser.contexts()[0]
  const page = ctx.pages()[0]

  console.log('=== 学业模块压力测试 ===\n')

  // 1. 创建多场考试
  const examIds = []
  const examTypes = ['monthly', 'midterm', 'final', 'quiz', 'test', 'mock']
  for (let i = 0; i < 10; i++) {
    const res = await callApi(page, 'academic:create-exam', {
      name: `压力测试考试${i + 1}`, type: examTypes[i % examTypes.length],
      date: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`,
      semester: '2026-2027-1', scope: '', subjects: ['chinese', 'math', 'english'],
    })
    const id = res.data?.data?.id
    if (id) examIds.push(id)
  }
  console.log(`创建考试: ${examIds.length}/10`)

  // 2. 获取学生列表
  const stuRes = await callApi(page, 'eaa:list-students')
  const allStudents = (stuRes.data?.data?.students || []).filter(s => s.status !== 'Deleted')
  // 取前50个学生
  const testStudents = allStudents.slice(0, 50).map(s => s.name)
  console.log(`测试学生: ${testStudents.length} 名`)

  if (testStudents.length === 0) {
    console.log('无学生可用,跳过')
    await browser.close()
    process.exit(0)
  }

  // 3. 批量写入成绩 (50学生 × 10考试 × 3科目 = 1500条)
  const subjects = ['chinese', 'math', 'english']
  let totalWritten = 0
  const writeStart = Date.now()

  for (const examId of examIds) {
    const records = []
    for (const studentName of testStudents) {
      for (const subjectId of subjects) {
        records.push({
          examId, subjectId, studentName,
          score: Math.floor(Math.random() * 60) + 40, // 40-100
          fullMark: 100,
          classRank: Math.floor(Math.random() * testStudents.length) + 1,
        })
      }
    }
    const res = await callApi(page, 'academic:batch-set-grades', records)
    // res.data = { success: true, data: <count> } — count is a number
    const count = typeof res.data?.data === 'number' ? res.data.data : (res.data?.data?.data ?? 0)
    totalWritten += count
  }

  const writeTime = Date.now() - writeStart
  console.log(`写入成绩: ${totalWritten} 条, 耗时 ${writeTime}ms (${(totalWritten / writeTime * 1000).toFixed(0)} ops/s)`)

  // 4. 验证读取性能
  const readStart = Date.now()
  let totalRead = 0
  for (const studentName of testStudents.slice(0, 10)) {
    const res = await callApi(page, 'academic:get-grades', studentName)
    totalRead += res.data?.data?.data?.length ?? res.data?.data?.length ?? 0
  }
  const readTime = Date.now() - readStart
  console.log(`读取成绩: ${totalRead} 条 (10学生), 耗时 ${readTime}ms (${(readTime / 10).toFixed(0)}ms/学生)`)

  // 5. 验证班级成绩查询
  const classStart = Date.now()
  const classRes = await callApi(page, 'academic:get-class-grades', testStudents.slice(0, 20), examIds[0])
  const classTime = Date.now() - classStart
  const classCount = Object.keys(classRes.data?.data?.data || classRes.data?.data || {}).length
  console.log(`班级成绩查询: ${classCount} 学生, 耗时 ${classTime}ms`)

  // 6. 并发写入测试
  console.log('\n--- 并发写入测试 ---')
  const concurrentStart = Date.now()
  const concurrentPromises = []
  for (let i = 0; i < 20; i++) {
    const studentName = testStudents[i % testStudents.length]
    const examId = examIds[i % examIds.length]
    const subjectId = subjects[i % subjects.length]
    concurrentPromises.push(
      callApi(page, 'academic:set-grade', {
        examId, subjectId, studentName,
        score: Math.floor(Math.random() * 100), fullMark: 100,
      })
    )
  }
  const concurrentResults = await Promise.all(concurrentPromises)
  const concurrentTime = Date.now() - concurrentStart
  const concurrentOk = concurrentResults.filter(r => r.data?.success).length
  console.log(`并发写入: ${concurrentOk}/20 成功, 耗时 ${concurrentTime}ms`)

  // 7. 清理
  console.log('\n--- 清理 ---')
  let deleted = 0
  for (const examId of examIds) {
    const res = await callApi(page, 'academic:delete-exam', examId)
    if (res.data?.success) deleted++
  }
  console.log(`删除考试: ${deleted}/${examIds.length}`)

  // 8. 总结
  console.log('\n=== 压力测试总结 ===')
  console.log(`  考试: ${examIds.length}`)
  console.log(`  学生: ${testStudents.length}`)
  console.log(`  成绩: ${totalWritten} 条写入, ${totalRead} 条读取`)
  console.log(`  写入性能: ${(totalWritten / writeTime * 1000).toFixed(0)} ops/s`)
  console.log(`  读取性能: ${(readTime / 10).toFixed(0)} ms/学生`)
  console.log(`  并发: ${concurrentOk}/20 成功`)
  console.log(`  清理: ${deleted}/${examIds.length} 删除`)

  const allPass = totalWritten > 0 && concurrentOk === 20 && deleted === examIds.length
  console.log(`\n${allPass ? '🎉 全部通过!' : '⚠ 存在失败项'}`)

  await browser.close()
  process.exit(allPass ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
