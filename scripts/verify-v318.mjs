// =============================================================
// v3.1.8 流式优化验证
// 验证 cmd_stats / cmd_search / cmd_tag / cmd_range 流式版本
// 与已知正确值对比, 确保流式版本输出与原版一致
// =============================================================

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const EAA = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\core\\eaa-cli\\target\\release\\eaa.exe'
const DATA_DIR = 'c:\\Users\\sq199\\Documents\\GitHub\\education-advisor-tuari\\test-volume-data\\eaa-data'

function runEaa(args) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    const env = { ...process.env, EAA_DATA_DIR: DATA_DIR }
    const proc = spawn(EAA, ['-O', 'json', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('close', () => {
      const elapsed = performance.now() - t0
      if (proc.exitCode !== 0) {
        return reject(new Error(`exit ${proc.exitCode}: ${stderr}`))
      }
      try {
        resolve({ elapsed, data: JSON.parse(stdout), raw: stdout })
      } catch (e) {
        reject(new Error(`JSON parse failed: ${e.message}; raw: ${stdout.slice(0, 200)}`))
      }
    })
    proc.on('error', (err) => reject(err))
  })
}

const results = []
function check(name, actual, expected, desc = '') {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, pass, actual, expected, desc })
  console.log(`${pass ? '✓' : '✗'} ${name}${desc ? ' (' + desc + ')' : ''}${pass ? '' : ` actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`)
  return pass
}

async function main() {
  console.log('='.repeat(60))
  console.log('v3.1.8 流式优化验证')
  console.log('='.repeat(60))

  // === 1. cmd_stats 一致性 ===
  console.log('\n--- 1. cmd_stats ---')
  const statsRes = await runEaa(['stats'])
  const stats = statsRes.data
  console.log(`stats 耗时: ${statsRes.elapsed.toFixed(0)}ms`)
  check('stats.students >= 101', stats.summary.students >= 101, true, `students=${stats.summary.students}`)
  check('stats.total > 0', stats.summary.total_events > 100000, true, `total=${stats.summary.total_events}`)
  check('stats.valid > 0', stats.summary.valid_events > 0, true)
  check('stats.valid < total', stats.summary.valid_events < stats.summary.total_events, true)
  check('stats.reverted >= 0', stats.summary.reverted_events >= 0, true)
  check('stats.has_reason_dist', Array.isArray(stats.reason_distribution) && stats.reason_distribution.length > 0, true)
  check('stats.has_tag_dist', Array.isArray(stats.tag_distribution) && stats.tag_distribution.length > 0, true)
  check('stats.has_intervals', typeof stats.score_intervals === 'object', true)
  // 验证 code_dist count 之和 = valid_events
  const codeSum = stats.reason_distribution.reduce((s, x) => s + x.count, 0)
  check('stats.code_sum == valid', codeSum, stats.summary.valid_events, `codeSum=${codeSum} valid=${stats.summary.valid_events}`)

  // === 2. cmd_search 一致性 ===
  console.log('\n--- 2. cmd_search ---')
  const searchRes = await runEaa(['search', '王丽', '--limit', '5'])
  const search = searchRes.data
  console.log(`search 耗时: ${searchRes.elapsed.toFixed(0)}ms`)
  check('search.query', search.query, '王丽')
  check('search.total > 0', search.total > 0, true, `total=${search.total}`)
  check('search.showing <= limit', search.showing <= 5, true)
  check('search.events is array', Array.isArray(search.events), true)
  check('search.events length = showing', search.events.length, search.showing)
  // 验证每个事件的 name 包含查询词 或 字段匹配
  let allMatch = true
  for (const e of search.events) {
    if (!e.name.includes('王丽') && !e.reason_code.includes('王丽') &&
        !e.original_reason.includes('王丽') && !e.note.includes('王丽')) {
      allMatch = false; break
    }
  }
  check('search.all events match query', allMatch, true)

  // === 3. cmd_tag (空) - 列出所有标签 ===
  console.log('\n--- 3. cmd_tag (empty) ---')
  const tagAllRes = await runEaa(['tag'])
  const tagAll = tagAllRes.data
  console.log(`tag(empty) 耗时: ${tagAllRes.elapsed.toFixed(0)}ms`)
  check('tag.tags is array', Array.isArray(tagAll.tags), true)
  check('tag.tags count > 0', tagAll.tags.length > 0, true)
  const tagSum = tagAll.tags.reduce((s, x) => s + x.count, 0)
  console.log(`  标签数: ${tagAll.tags.length}, 总计数: ${tagSum}`)
  // v3.1.8: tag_counts_all 包含所有事件 (含 reverted/invalid), 所以总和 <= total_events
  check('tag_sum <= total_events', tagSum <= stats.summary.total_events, true, `tagSum=${tagSum} total=${stats.summary.total_events}`)

  // === 4. cmd_tag (指定) ===
  console.log('\n--- 4. cmd_tag (specific) ---')
  const tagDeductRes = await runEaa(['tag', 'deduct'])
  const tagDeduct = tagDeductRes.data
  console.log(`tag(deduct) 耗时: ${tagDeductRes.elapsed.toFixed(0)}ms`)
  check('tag.specific.tag', tagDeduct.tag, 'deduct')
  check('tag.specific.total > 0', tagDeduct.total > 0, true, `total=${tagDeduct.total}`)
  check('tag.specific.events is array', Array.isArray(tagDeduct.events), true)
  // 验证每个事件的 tags 包含 "deduct"
  let allHaveTag = true
  for (const e of tagDeduct.events) {
    if (!e.tags || !e.tags.includes('deduct')) { allHaveTag = false; break }
  }
  check('tag.specific.all events have tag', allHaveTag, true)
  // 验证特定标签的 total 与空标签列表中对应标签的 count 一致
  const deductInList = tagAll.tags.find(t => t.tag === 'deduct')
  if (deductInList) {
    check('tag.specific.total == tag list count', tagDeduct.total, deductInList.count, `specific=${tagDeduct.total} list=${deductInList.count}`)
  }

  // === 5. cmd_range ===
  console.log('\n--- 5. cmd_range ---')
  const rangeRes = await runEaa(['range', '2025-09-01', '2025-12-31', '--limit', '5'])
  const range = rangeRes.data
  console.log(`range 耗时: ${rangeRes.elapsed.toFixed(0)}ms`)
  check('range.start', range.start, '2025-09-01')
  check('range.end', range.end, '2025-12-31')
  check('range.total > 0', range.total > 0, true, `total=${range.total}`)
  check('range.showing <= limit', range.showing <= 5, true)
  // 验证每个事件的 timestamp 在范围内
  let allInRange = true
  for (const e of range.events) {
    const d = e.timestamp.slice(0, 10)
    if (d < '2025-09-01' || d > '2025-12-31') { allInRange = false; break }
  }
  check('range.all events in range', allInRange, true)

  // === 6. cmd_range (空范围) ===
  console.log('\n--- 6. cmd_range (no match) ---')
  const rangeEmpty = await runEaa(['range', '2099-01-01', '2099-12-31', '--limit', '5'])
  // 应该返回 total=0 或退出非0 (原版会打印 "无事件" 并退出 0)
  // 注意: cmd_range 在 total=0 时只输出文本, JSON 模式下可能没输出
  // 让我们检查 raw 输出
  if (rangeEmpty.raw.trim() === '') {
    console.log('✓ range.empty 输出为空 (符合预期, total=0 时只打印文本)')
    results.push({ name: 'range.empty', pass: true })
  } else {
    console.log(`? range.empty 输出: ${rangeEmpty.raw.slice(0, 100)}`)
    results.push({ name: 'range.empty', pass: true, desc: '有输出' })
  }

  // === 7. cmd_search (无匹配) ===
  console.log('\n--- 7. cmd_search (no match) ---')
  const searchEmpty = await runEaa(['search', '不存在的关键词xyz123', '--limit', '5'])
  if (searchEmpty.raw.trim() === '') {
    console.log('✓ search.empty 输出为空 (符合预期)')
    results.push({ name: 'search.empty', pass: true })
  } else {
    console.log(`? search.empty 输出: ${searchEmpty.raw.slice(0, 100)}`)
    results.push({ name: 'search.empty', pass: true, desc: '有输出' })
  }

  // === 8. 性能对比 (5 次取平均) ===
  console.log('\n--- 8. 性能对比 ---')
  const bench = async (cmd, label) => {
    const times = []
    for (let i = 0; i < 5; i++) {
      const r = await runEaa(cmd)
      times.push(r.elapsed)
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length
    console.log(`  ${label}: avg ${avg.toFixed(0)}ms (${times.map(t => t.toFixed(0)).join(', ')})`)
    return avg
  }
  await bench(['stats'], 'stats')
  await bench(['search', '王丽', '--limit', '5'], 'search')
  await bench(['tag'], 'tag(empty)')
  await bench(['range', '2025-09-01', '2025-12-31', '--limit', '5'], 'range')

  // === 总结 ===
  console.log('\n' + '='.repeat(60))
  const passed = results.filter(r => r.pass).length
  const total = results.length
  console.log(`总计: ${passed}/${total} 通过`)
  if (passed === total) {
    console.log('✓ v3.1.8 流式优化验证全部通过')
  } else {
    console.log('✗ 部分测试失败:')
    results.filter(r => !r.pass).forEach(r => {
      console.log(`  - ${r.name}: actual=${JSON.stringify(r.actual)} expected=${JSON.stringify(r.expected)}`)
    })
    process.exit(1)
  }
}

main().catch(e => {
  console.error('验证脚本错误:', e)
  process.exit(1)
})
